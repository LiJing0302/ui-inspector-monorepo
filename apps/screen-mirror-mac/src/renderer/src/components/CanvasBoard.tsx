import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  toRenderNode,
  widthAlignScale,
  type AppNode,
  type DesignNode,
  type RenderNode,
  type VerifySource,
} from '@shared/verify';
import {
  fromCanonicalId,
  toCanonicalId,
  type AcceptanceReadiness,
  type AcceptanceRunMeta,
  type NodeMapping,
  type NodeMatch,
  type RegionMatch,
} from '@shared/aiAcceptance';
import type { VerifyPairView } from '@shared/ipc';
import type { AcceptanceReport } from '@ui-inspector/ai-acceptance';
import type { SamaCleanSuccess } from '@shared/sama';
import { filterByKindFilter, type CleanKindFilter } from '../lib/cleanKindFilter';
import type {
  ExportGroundTruthResult,
  GroundTruth,
  GroundTruthPair,
  GroundTruthVerdict,
} from '@shared/groundTruth';

import AcceptancePanel from './AcceptancePanel';
import CalibrationPanel from './CalibrationPanel';
import CanvasHintBar from './CanvasHintBar';
import CanvasViewport, { type CanvasView, type CanvasViewportHandle } from './CanvasViewport';
import type {
  RasterFrameSource,
  RasterMeasure,
  RasterCleanMerged,
  RasterRegion,
  RasterSamaBand,
  RasterSamaIssue,
  RasterSelection,
  SamaSeverity,
} from './FrameRaster';

/** SAMA 报告的本地别名：这个文件里只关心报告本身，不关心它怎么来 */
type SamaReport = AcceptanceReport;
import {
  annotationSeq,
  type AnnotationTool,
  type ColorSample,
  type RasterAnnotation,
} from '../lib/annotation';
import LayersPanel, { type LayerSelection, type LayerSelectionMap } from './LayersPanel';
import NodeCanvas from './NodeCanvas';
import NodeInfoPanel, { shortClassName, type SelectedNode, type StackView } from './NodeInfoPanel';
import VerifyToolbar from './VerifyToolbar';
import {
  canvasScopeOf,
  readCanvasField,
  useCanvasField,
  writeCanvasField,
  type CanvasScope,
} from '../hooks/useCanvasSession';
import {
  canOverlay,
  clampOverlayOpacity,
  clampWipeRatio,
  DEFAULT_OVERLAY_OFFSET,
  DEFAULT_OVERLAY_OPACITY,
  DEFAULT_WIPE_RATIO,
  type OverlayCompare,
  type OverlayOffset,
  type VerifyMode,
} from '../lib/compare';
import {
  ancestorChain,
  parentContextOf,
  planCanvasClick,
  planCanvasHover,
  resolveActiveSide,
  selectionIdOf,
  type ClickCycle,
  type ClickMods,
  type PickPoint,
} from '../lib/selection';
import { measureBetween } from '../lib/measure';
// 读数口径：间距读数也要换尺子（与面板同一份投影实现，见 `lib/pixelProjection`）。
import { measureLinesInPixels, pixelProjectionOf } from '../lib/pixelProjection';
// 读数口径的类型（`lib/comparison.ts`）：面板长度读数用哪把尺子 —— 设计单位还是截图物理像素
import type { AlignBasis } from '../lib/comparison';
import { appLayerHint, designLayerHint, mergeAppNodes, mergeDesignNodes, stackOf } from '../lib/stack';
import {
  annotatedIds,
  buildPair,
  pendingCounts,
  prefillFromMatches,
  removePair,
  sideIdsOf,
  submitBlocker,
  summarize,
  togglePending,
  upsertPair,
} from '../lib/calibration';
import { planMatchFocus, type MatchFocus, type MatchFocusNode } from '../lib/matchFocus';

interface HoverTarget {
  source: VerifySource;
  id: string;
}

/**
 * 一条匹配的稳定标识。
 *
 * 优先用引擎给的 `match.id`（`NodeMatch.id`，也是高亮态回灌给列表的 `activeMatchKey`），
 * 让「哪一行是当前高亮的」这件事有个稳定主键，而不是靠数组顺序去猜。
 *
 * 没有 id 时（手工映射、或引擎还没给 id 的旧结论）退化成一侧 id 的拼接。
 * 排序是必要的：同一对在两次运行里的数组顺序未必相同，不排序会出现
 * 「点了同一条却被当成另一条」，表现为高亮闪烁而无法取消。
 */
function matchKeyOf(
  id: string | null | undefined,
  designIds: readonly string[],
  appIds: readonly string[],
): string {
  if (id) return id;
  return `${[...designIds].sort().join(',')}|${[...appIds].sort().join(',')}`;
}

/**
 * 从 canonicalId 列表里找出第一个**当前帧里确实存在**的视图节点。
 *
 * 存在性检查不可省：匹配结论是**上一次运行**的产物，而画布上的节点表来自当前配对的
 * 素材 —— 用户换过截图、或刚重跑过验收时，结论里完全可能引用一个已经没有的节点。
 * 不检查就会 `undefined.get` 或选中到一个空壳。
 */
function firstResolvedNode(
  ids: readonly string[],
  source: VerifySource,
  byId: ReadonlyMap<string, RenderNode>,
): RenderNode | null {
  for (const canonical of ids) {
    const parsed = fromCanonicalId(canonical);
    if (!parsed || parsed.source !== source) continue;
    const node = byId.get(parsed.id);
    if (node) return node;
  }
  return null;
}

/**
 * 两侧各自的选中槽（**键就是来源**）。两个槽互相独立 —— 在设计稿上选一个、
 * 再到截图侧选一个，两个选中框同时在，谁也不顶掉谁（见 lib/selection 顶部）。
 *
 * ⚠️ 它不违反「选中态只有一份」那条老约定：那两个槽描述的是两件独立的事
 * （设计稿侧选了谁 / 截图侧选了谁），谁也推不出谁。唯一推得出来的是「主动侧」，
 * 而那个是算的（`resolveActiveSide`）。
 */
type SelectionSlots = Record<VerifySource, SelectedNode | null>;

/**
 * 某一侧的选中 id（`null` = 该侧没选中）。
 *
 * 「设计稿取 `node.id` / 截图取 `node.nodeId`」这处差异收敛在 lib/selection 的
 * `selectionIdOf`；这里只是把「先取槽、再取 id」两步并成一步 —— 调用点想问的全都是
 * 「这一侧的选中 id 是多少」，分开写会让每一处都得先处理一遍空槽。
 */
const slotIdOf = (slots: SelectionSlots, source: VerifySource): string | null =>
  selectionIdOf(slots[source]);

/** 光标下的一次原始命中 + 判定 hover 所必需的上下文（落点、修饰键） */
interface HoverHit {
  node: RenderNode;
  point: PickPoint;
}

interface CanvasBoardProps {
  pair: VerifyPairView;
  /**
   * 两侧素材的**内容指纹**（`canvasMaterialSignature`），由父级算好传进来。
   *
   * 为什么不在本组件里算：它需要素材的**写入时间**（`importedAt` / `capturedAt`），
   * 而那两份元数据只有父级手里有（需求里的 designAssets / appSnapshots）。
   * 父级同时用同一个签名拼 React key —— key 与会话签名必须完全同源，
   * 少一维就会出现「换了素材却保留了旧状态」。
   */
  signature: string;
  onIssuesChanged: () => void;
}

/**
 * 「画布验收」tab：图层列表 + 工具栏 + 双画布（DOM 节点层）+ 右侧节点信息。
 *
 * 选中规则是 **点哪选哪**（规则本体与依据见 lib/selection）：单击选中**命中本身**
 * （指针底下最深的那个），**在原地再点一次**上移一层，Esc 往上一层。
 *
 * ⚠️ **hover 走的是同一个判定**：环 = 「下一击会选中的那个」，不是「光标底下那个」。
 * 被子树盖住的那部分永远命中最深的后代（父盒在子盒下面），所以只按原始命中画环，
 * 就会出现「点得到的层级 ≠ hover 得到的层级」—— 用户报的
 * 「13531 / 13533 / 13532 无法通过 hover 选中」正是这个。原地再点上移一层之后，
 * `applySelection` 会用同一个落点立刻重算一次环，让它跟着上移。
 * （另：2026-09-16 起无填充的容器**本身也参与命中**了，所以点不到父级只剩「被后代
 * 盖住」这一种情形 —— 详见 `RenderNode.hittable`。）
 *
 * ⚠️ 选中态是**两侧各一个槽**（`SelectionSlots`），不是全局唯一的一个：在设计稿上选一个、
 * 再到截图侧选一个，两个选中框同时在。右栏 / Esc / 对侧框看**主动侧**
 * （最近一次选中的那一侧，由 `resolveActiveSide` 从两个槽 + `preferredSide` 推出来）。
 *
 * 上一版是 Figma 的「当前上下文层」模型（单击选上下文层的最外层）—— 它让单击**永远**
 * 落在帧根上，用户两次报「hover 和点击都选不中内部节点」。差别在场景：Figma 是设计
 * 工具（操作对象多为容器），这里是验收工具（指着哪个就看哪个）。
 *
 * 「上一层」（按 Esc 会落到哪）**不存**，是 `parentContextOf(主动侧选中项)` 现算的 ——
 * 存两份状态迟早会自相矛盾，见 lib/selection 顶部。
 *
 * 切换左侧配对时**必须由父级用 `key` 重建本组件**（父级以 pair id + 两侧素材 id 作 key）：
 * 否则两个槽会停留在上一页的节点上，右侧面板显示的是别的页面的节点。
 * 重建不再等于「什么都从头来」—— 本组件里的人工操作都存在**配对会话**里
 * （见 hooks/useCanvasSession），重建时按同一个配对读回来；只有两侧素材被换过
 * （key 里的素材 id 变了）时那条会话才作废。
 */
const DEFAULT_CANVAS_ZOOM = 0.75;
/** 两侧都没选中 / 都没设锚点。⚠️ 必须是稳定引用：它们是会话的兜底值，每次渲染新建就等于「默认值也在变」 */
const EMPTY_SELECTION: SelectionSlots = { design: null, app: null };
const EMPTY_MEASURE_ANCHORS: Record<VerifySource, LayerSelection | null> = { design: null, app: null };
/** 同上：空待配对组 / 空标注表。各处都换新数组，不会被就地改写 */
const EMPTY_PENDING: string[] = [];

const EMPTY_ANNOTATIONS: RasterAnnotation[] = [];

const CanvasBoard: React.FC<CanvasBoardProps> = ({ pair, signature, onIssuesChanged }) => {
  /**
   * 配对会话的键：**配对 id + 两侧素材的内容指纹**（见 hooks/useCanvasSession）。
   *
   * 签名变了 → 父级的 key 也变了 → 本组件重建 → 会话发现签名对不上 → 就地作废 →
   * 下面所有字段回到初始值。只换配对、素材没动的路径不重建，状态自然留着。
   */
  const scope = useMemo<CanvasScope>(
    () => canvasScopeOf(pair.meta.id, signature),
    [pair.meta.id, signature],
  );

  /**
   * 缩放也归这一页：不同配对的取景需求差得远（长页面要看整体、图标要放大到像素格），
   * 从 A 页放大到 8 倍再看 B 页会以为 B 页坏了。原先它挂在父级、跨配对共用。
   */
  const [zoom, setZoom] = useCanvasField(scope, 'zoom', DEFAULT_CANVAS_ZOOM);

  /**
   * 两侧各自的选中项（键就是来源，见 `SelectionSlots`）。
   * 写槽只写**自己那一侧** —— 所有改选中的入口都走 `applySelection`。
   */
  const [selection, setSelection] = useCanvasField<SelectionSlots>(
    scope,
    'selection',
    EMPTY_SELECTION,
  );
  /**
   * 最近一次选中的那一侧。**只记「谁说最后一句」，不记「那一侧选了谁」** ——
   * 后者在两个槽里。于是这里不可能与槽矛盾：它指向的槽空了，`resolveActiveSide`
   * 当场改指另一侧，不需要任何一处记得去维护它。
   */
  const [preferredSide, setPreferredSide] = useCanvasField<VerifySource | null>(
    scope,
    'preferredSide',
    null,
  );
  const activeSide = resolveActiveSide(selection, preferredSide);
  /**
   * 主动侧的选中项：右栏节点信息、Esc 和对侧框都只看它；间距读数按两侧分别计算。
   *
   * 两侧都选中时画布上会有两个框，但「现在在讲谁」必须唯一 —— 否则面板显示的节点
   * 与画布上被量的那一对可以是两回事，而用户没有任何线索能分辨。
   */
  const selected = activeSide ? selection[activeSide] : null;
  const selectedDesignNode = selection.design?.source === 'design' ? selection.design.node : null;
  const selectedAppNode = selection.app?.source === 'app' ? selection.app.node : null;
  const comparison = selectedDesignNode && selectedAppNode
    ? { design: selectedDesignNode, app: selectedAppNode }
    : null;
  /**
   * hover **刻意不进会话**：它描述的是「指针在哪儿」，而不是用户做过的操作。
   * 恢复一个早就移开的指针位置没有任何意义，环还会挂在用户没指着的地方。
   */
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  /**
   * **固定的**间距另一端（⌘/Ctrl 单击设的锚点）。
   *
   * 与 hover 那一路的区别只有「谁说了算」：hover 的读数随光标走、光标一移就没；
   * 锚点是**钉住**的，移开光标、去点别处看一眼再回来，读数还在 —— 核对间距时
   * 常常要盯着数字改稿子，读数跟着鼠标跑就没法用。
   *
   * ⚠️ 它不是第二个选中项：两侧的选中槽仍然一处一个（见选区不变量），锚点只喂给读数。
   *    每侧独立保存一个锚点；锚点所在侧的选中项变了 / 点空白或按 Esc 才会清除该侧锚点。
   */
  const [measureAnchors, setMeasureAnchors] =
    useCanvasField<Record<VerifySource, LayerSelection | null>>(
      scope,
      'measureAnchors',
      EMPTY_MEASURE_ANCHORS,
    );
  const spacingActive = Boolean(measureAnchors.design || measureAnchors.app);
  const viewportRef = useRef<CanvasViewportHandle>(null);

  /**
   * 上一轮的取景（平移量）：交给视口当初始值，之后由视口在每次平移时回报。
   *
   * 「聚焦到某个节点」这类动作的可见结果**就是画布动了**；会话里不记这一条，
   * 切回来时选中框还在、画布却回到了正中央，等于刚才那一下白按。
   */
  const [initialView] = useState<CanvasView | null>(() =>
    readCanvasField<CanvasView | null>(scope, 'view', null),
  );
  const handleViewChange = useCallback(
    (view: CanvasView): void => {
      // 一次性写入（不做防抖）：拖拽时每秒几十次 Map 写入，比一个 rAF 还便宜，
      // 而防抖会带来「拖到一半就切走 → 最后一帧没存上」的窗口。
      writeCanvasField(scope, 'view', view);
    },
    [scope],
  );

  /**
   * 在「匹配明细」里点中的那一条匹配 —— 画布据此把它的**全部节点**持续高亮。
   *
   * 为什么不复用选中态（两个槽加起来也才两个节点）：
   *  - 一条匹配常见是一对，成组匹配（文本聚合后的 N:M）是好几个 ——
   *    两个槽表达不了「这一组都在核对中」。
   *  - 选中态会被画布点击改掉。匹配高亮若挂在它身上，用户在画布上顺手点一下
   *    想看细节，刚框出来的一整组就散了 —— 而「一边看列表一边在画布上找」正是
   *    这个功能的用法，散掉等于每看一条都要重新点一次。
   *
   * 存 canonicalId 而不是解析好的节点：节点表（`designById` / `appById`）是画布的
   * 派生状态，存解析结果等于把同一份数据存两遍，pair 一变就对不上了。
   */
  const [focusedMatch, setFocusedMatch] = useCanvasField<{
    id: string | null;
    designIds: string[];
    appIds: string[];
  } | null>(scope, 'focusedMatch', null);
  const [focusedRegionMatchId, setFocusedRegionMatchId] = useCanvasField<string | null>(
    scope,
    'focusedRegionMatchId',
    null,
  );

  /**
   * SAMA 引擎的报告（由右栏 `SamaPanel` 跑出来后回灌）。
   *
   * 为什么要提升到画布这一层：SamaPanel 在右栏、画布在中间，两者是兄弟节点，
   * 而「点面板某条 issue → 画布亮出对应节点」是**跨越这两个子树**的动作。
   * 报告本身没有兄弟能持有它 —— 只能挂在共同的祖先（`CanvasBoard`）上。
   *
   * 归类：**该持久化**。它是「当前这一对素材的验收结论」，跟 `run` 同性质；
   * 切 tab 回来（`CanvasBoard` 是条件渲染）不该把结论丢光。
   * 换素材时由 `canvasSessionKey` 的签名不匹配整条重建，不用逐字段清。
   */
  const [samaReport, setSamaReport] = useCanvasField<SamaReport | null>(scope, 'samaReport', null);
  /**
   * 面板上当前展开的那条 issue。**只影响画布高亮，不进持久化** ——
   * 跟 `hovered` 同类：它是「用户此刻在看哪一条」的瞬时状态，
   * 存下来会在下次进画布时莫名高亮一条不相干的 issue。
   */
  const [samaFocusedIssue, setSamaFocusedIssue] = useState<string | null>(null);
  /**
   * 清洗核验数据（由右栏 `SamaPanel` 调 `verify:sama-clean` 取）。
   *
   * 归类：**不持久化**。它是「当前这一对素材的清洗结果快照」，
   * 而素材会被重新导入/截图 —— 存着会让下次进来看到**旧素材**的剔除框，
   * 而那些框在新素材上位置全错（比不显示更糟）。
   * 换素材时下面的 `useEffect` 会主动清空。
   */
  const [cleanData, setCleanData] = useState<SamaCleanSuccess | null>(null);
  /** 画布上当前高亮的清洗条目（`drop:<id>` / `merged:<id>`），受控 */
  const [cleanFocus, setCleanFocus] = useState<string | null>(null);
  /** 只看这几层（L1–L6）。空 = 全看。⚠️ 用 Set 因为「多层同显」是常态 */
  const [cleanTierFilter, setCleanTierFilter] = useState<Set<string>>(() => new Set());
  /**
   * 画布上画哪些「非可绘制」框 —— **纯视图开关，零影响结论**。
   *
   * ⭐ 三档的差别是实测来的，不是设计出来的（10年管家 606 框 / 198 container）：
   *
   * | 档 | 画什么 | 实测框数 | 代价 |
   * |---|---|---|---|
   * | `all` | 全部视图节点 | 606 | 密，但信息完整 |
   * | **`structured`（默认）** | 隐藏「容器里**无**背景/边框/圆角」的纯结构框 | **518** | **可见盒子零损失**（藏 88 个） |
   * | `drawable` | 只画 text + visual | 408 | 多藏 110 个**真实可见盒子**（卡片底、输入框） |
   *
   * ⚠️⚠️ **中间那档不能按「有子节点」判** —— 我第一版就是这么写的，实测被打脸：
   * 198 个 container 里 **197 个有子节点、只有 1 个叶子**，
   * 而 110 个带背景的可见盒子**全都落在「有子节点」那 197 个里**
   * （页面根 `10年管家开通前` 就是 `bg:#f5f5f5` + 7 个子节点）。
   * ⇒ 一个「带背景的分组」本来既是容器又有孩子，按有无子节点判会把可见盒子全藏掉。
   * **正确依据是 `hasBoxPaint`**（有没有画背景/边框/圆角）。
   */
  const [cleanKindFilter, setCleanKindFilter] = useState<CleanKindFilter>('structured');
  /** 换素材即作废：素材 id 空间全变，旧报告的 designId/appId 不再有意义 */
  useEffect(() => {
    setSamaFocusedIssue(null);
    // 清洗快照同理：那些剔除框是**旧素材的坐标**，留到新素材上会全错位
    setCleanData(null);
    setCleanFocus(null);
  }, [scope]);

  /**
   * 右栏两个 tab：节点信息 / 验收结果。
   *
   * 放在同一个栏里而不是再开一列：这两个面板是**互斥的视野**（要么在端详某个节点，
   * 要么在看待办清单），并排只会让画布更窄，而画布宽度正是这个工具最缺的资源。
   */
  const [sideTab, setSideTab] = useCanvasField<'node' | 'acceptance' | 'calibrate'>(
    scope,
    'sideTab',
    'node',
  );
  const [useAi, setUseAi] = useCanvasField(scope, 'useAi', false);
  /**
   * 面板读数口径（2026-09-29 加）：`'design'` = App 对齐设计稿（默认，现状），
   * `'pixel'` = 设计稿对齐 App（设计侧长度读数换成截图物理像素，供 UI 同学直接对着截图量）。
   *
   * 与 `sideTab` 同层（会话级）：换页面、切 tab 都该记住它 —— 验收同学一旦决定「我要用截图
   * 的尺子读数」，这个决定在整个需求里都成立，不该每点一个节点就被重置一次。
   *
   * ⚠️ 它**不参与画布的空间对齐**：截图照旧被 `appAlignScale` 缩到设计稿同宽
   * （见 `AlignBasis` 的注释）。画布那一条服务「两张图叠起来对不对得上」，是另一回事。
   */
  const [alignBasis, setAlignBasis] = useCanvasField<AlignBasis>(scope, 'alignBasis', 'design');
  /**
   * 下面这一组是**服务端数据与在途标志**，刻意的本地 state：
   * 运行结论、门禁、人工映射、标注答案都是从主进程读回来的（进画布就重拉一次），
   * `runBusy` / `gtError` 这类描述的是「这一次请求」，跨挂载恢复它们没有意义
   * （恢复一个「正在运行」的转圈，而请求早就断了）。
   */
  const [run, setRun] = useState<AcceptanceRunMeta | null>(null);
  const [readiness, setReadiness] = useState<AcceptanceReadiness | null>(null);
  const [mapping, setMapping] = useState<NodeMapping | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  /**
   * 标注模式（ground truth）。
   *
   * 一个开关 + 一个待配对组，**不改动 `selected`**：两者回答的是不同问题 ——
   * 「我在看哪个节点」与「我要把哪几个标在一起」。合成一个状态就会出现
   * 「标注途中顺手想看一眼某个节点的字段，待配对组被清空」。
   *
   * 开关与待配对组**都进会话**：标注是「逐元素点几十下」的长动作，标到一半去
   * 「页面匹配」核一眼素材、回来发现待配对组清空了，等于这一轮白点。
   */
  const [annotating, setAnnotating] = useCanvasField(scope, 'annotating', false);
  const [pending, setPending] = useCanvasField<string[]>(scope, 'pending', EMPTY_PENDING);
  const [groundTruth, setGroundTruth] = useState<GroundTruth | null>(null);
  const [gtBusy, setGtBusy] = useState(false);
  const [gtError, setGtError] = useState<string | null>(null);
  /** 最近一次导出的落盘结果。只用于把路径亮出来，重进画布即清空 */
  const [gtExported, setGtExported] = useState<ExportGroundTruthResult | null>(null);

  /**
   * 当前工具。工具按钮的选中态与画布布局必须来自**同一个状态**：
   * 放在 VerifyToolbar 里时，「叠图验收」只能点亮自己那一格，画布无从得知。
   */
  const [activeTool, setActiveTool] = useCanvasField(scope, 'activeTool', 'full');
  const [annotations, setAnnotations] = useCanvasField<RasterAnnotation[]>(
    scope,
    'annotations',
    EMPTY_ANNOTATIONS,
  );
  const [colorSample, setColorSample] = useCanvasField<ColorSample | null>(
    scope,
    'colorSample',
    null,
  );
  /**
   * 画布标注的序号计数器。
   *
   * ⚠️ 起点是**恢复回来的标注里用过的最大号**，不是 0：标注现在会跨挂载恢复，
   * 从 0 起会让新画的 `annotation-1` 与恢复回来的撞 id（React key 重复 → 列表错位）。
   */
  const annotationIdRef = useRef(annotationSeq(annotations));
  /** 叠图子模式。与 activeTool 分开：它是正交的一层，切比对方式不该退出叠图 */
  const [compare, setCompare] = useCanvasField<OverlayCompare>(scope, 'compare', 'opacity');
  const [overlayOpacity, setOverlayOpacity] = useCanvasField<number>(
    scope,
    'overlayOpacity',
    DEFAULT_OVERLAY_OPACITY,
  );
  const [wipeRatio, setWipeRatio] = useCanvasField<number>(scope, 'wipeRatio', DEFAULT_WIPE_RATIO);
  const [overlayOffset, setOverlayOffset] = useCanvasField<OverlayOffset>(
    scope,
    'overlayOffset',
    DEFAULT_OVERLAY_OFFSET,
  );

  /**
   * 布局模式**从 activeTool 推导**，不单独存一份。
   *
   * 存两份就会出现「工具栏显示全页、画布已经叠上」这类不一致 —— 而它们恰好是
   * 从两个方向被写坏的（点按钮一处、快捷键一处），且没有任何断言能覆盖。
   * 非模式类工具（取色等）选中时退回全页：它们不改变布局。
   */
  const mode: VerifyMode =
    activeTool === 'overlay' ? 'overlay' : activeTool === 'region' ? 'region' : 'full';

  /** 叠图要求两张底图都在；缺图时按钮置灰（判据见 lib/compare） */
  const overlayEnabled = useMemo(() => canOverlay(pair), [pair]);
  const overlayOn = mode === 'overlay' && overlayEnabled;

  const handleActiveToolChange = useCallback((tool: string): void => {
    setActiveTool(tool);
    if (tool !== 'picker') setColorSample(null);
  }, []);

  const handleCreateAnnotation = useCallback(
    (
      kind: Exclude<AnnotationTool, 'picker'>,
      source: VerifySource,
      start: { x: number; y: number },
      end: { x: number; y: number },
    ): void => {
      annotationIdRef.current += 1;
      setAnnotations((current) => [
        ...current,
        {
          id: `annotation-${annotationIdRef.current}`,
          kind,
          source,
          start,
          end,
        },
      ]);
    },
    [],
  );

  const handlePickColor = useCallback((sample: ColorSample): void => {
    setColorSample(sample);
  }, []);

  const handleUndoAnnotation = useCallback((): void => {
    setAnnotations((current) => current.slice(0, -1));
  }, []);

  const handleClearAnnotations = useCallback((): void => {
    setAnnotations([]);
    setColorSample(null);
  }, []);

  const annotationActive = activeTool === 'picker' || activeTool === 'rect' || activeTool === 'arrow';
  const annotationToolLabel =
    activeTool === 'picker' ? '取色中' : activeTool === 'rect' ? '画框中' : activeTool === 'arrow' ? '箭头中' : '标注';

  useEffect(() => {
    if (!['picker', 'rect', 'arrow'].includes(activeTool)) return;
    const handleAnnotationKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveTool('full');
        setColorSample(null);
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && annotations.length > 0) {
        event.preventDefault();
        setAnnotations((current) => current.slice(0, -1));
      }
    };
    window.addEventListener('keydown', handleAnnotationKeyDown);
    return () => window.removeEventListener('keydown', handleAnnotationKeyDown);
  }, [activeTool, annotations.length]);

  /** 叠图模式的取值本身就是「要画成什么样」，所以这里一并收敛掉非法值 */
  const handleOverlayOpacityChange = useCallback((value: number): void => {
    setOverlayOpacity(clampOverlayOpacity(value));
  }, []);
  const handleWipeRatioChange = useCallback((value: number): void => {
    setWipeRatio(clampWipeRatio(value));
  }, []);

  const result = run?.result ?? null;

  /**
   * 结论是否过时：人工映射 `updatedAt` 晚于本次运行的 `createdAt`。
   *
   * 两者都是 ISO 8601 字符串，**字典序即时序**，所以直接比字符串即可，不必解析成 Date
   * （解析要处理非法值，反而更容易写错）。缺任一侧就当作「不过时」——
   * 还没跑过、或还没存过映射时，没有「旧结论」可言。
   */
  const resultStale = Boolean(result && mapping && run && mapping.updatedAt > run.createdAt);

  /**
   * 上一次画布点击留下的痕迹（命中 + 选中 + 落点），**按侧各存一份**。
   * 它**不参与渲染**（没有任何 UI 直接读它），所以进 ref 而不是 state ——
   * 进 state 只会让每次点击多一轮重渲染。它是「原地再点 = 上移一层」的唯一判据。
   *
   * ⚠️ 必须分侧：判据里的「原地」是**同一帧的同一个落点**。共用一份时，
   * 「设计稿点两下 → App 侧点一下 → 回设计稿再点」这条链里，中间那一击会把痕迹冲掉；
   * 结果是「设计稿原地再点」失效（多数情况碰巧还能判对，因为两侧的 id 空间不同、
   * 命中的节点对不上 —— 但那是巧合，两套 id 空间理论上会撞）。
   */
  const clickCycleRef = useRef<Record<VerifySource, ClickCycle | null>>({ design: null, app: null });
  /** 上一次真正生效的 hover key。⚠️ mousemove 每秒几十次，靠它挡住多余的 setState */
  const hoverKeyRef = useRef<string | null>(null);
  /**
   * 光标下**最近一次**的原始命中（节点 + 落点 + ⌘）。
   *
   * 必须记住它：一次点击会改变「档位」，而档位一变 hover 的目标就变 —— 落地选中后要拿
   * **同一个落点**立刻重算，否则环会停在子节点上、直到鼠标再动一下才跳到父级。
   * 「原地再点上移一层」这条手势唯一需要被看见的就是这一刻。
   */
  const lastHoverRef = useRef<HoverHit | null>(null);
  /**
   * 两侧选中项的**即时镜像**（`selection` state 要到本轮 render 之后才更新）。
   *
   * hover 的解析（`planCanvasHover`）要回答「这一帧现在选中了谁」—— 落地选中的同一轮里
   * 若再收到一次 mousemove，读 state 就是旧值，会把「刚点过」判成「没点过」，环掉回子节点。
   * ref 与 state 同源，但立刻生效。
   *
   * 按侧存：光标在哪一侧，就问那一侧的槽（另一侧的选中项与这一击无关）。
   */
  const selectedIdRef = useRef<Record<VerifySource, string | null>>({ design: null, app: null });

  const designNodes = useMemo<RenderNode[]>(
    () => pair.design.nodes.map((node) => toRenderNode(node, 'design' as const)),
    [pair],
  );
  const appNodes = useMemo<RenderNode[]>(
    () => pair.app.nodes.map((node) => toRenderNode(node, 'app' as const)),
    [pair],
  );

  const inputAnalysis = run?.result?.inputAnalysis;
  const canvasDesignNodes = useMemo<RenderNode[]>(() => {
    if (!inputAnalysis || run?.result?.phase !== 'input') return designNodes;
    const shortIds = new Map(
      inputAnalysis.annotations
        .filter((annotation) => annotation.source === 'design' && annotation.kind === 'annotated')
        .flatMap((annotation) => Object.entries(annotation.shortIdMap).map(([shortId, canonicalId]) => [canonicalId, shortId] as const)),
    );
    const retainedById = new Map(inputAnalysis.design.retainedNodes.map((node) => [fromCanonicalId(node.canonicalId)?.id, node] as const));
    return designNodes
      .filter((node) => retainedById.has(node.id))
      .map((node) => {
        const retained = retainedById.get(node.id);
        return {
          ...node,
          rect: retained?.visibleRect ?? retained?.rect ?? node.rect,
          shortId: shortIds.get(`design:${node.id}`),
        };
      });
  }, [designNodes, inputAnalysis, run?.result?.phase]);

  const canvasAppNodes = useMemo<RenderNode[]>(() => {
    if (!inputAnalysis || run?.result?.phase !== 'input') return appNodes;
    const shortIds = new Map(
      inputAnalysis.annotations
        .filter((annotation) => annotation.source === 'app' && annotation.kind === 'annotated')
        .flatMap((annotation) => Object.entries(annotation.shortIdMap).map(([shortId, canonicalId]) => [canonicalId, shortId] as const)),
    );
    const retainedById = new Map(inputAnalysis.app.retainedNodes.map((node) => [fromCanonicalId(node.canonicalId)?.id, node] as const));
    return appNodes
      .filter((node) => retainedById.has(node.id))
      .map((node) => {
        const retained = retainedById.get(node.id);
        return {
          ...node,
          rect: retained?.visibleRect ?? retained?.rect ?? node.rect,
          shortId: shortIds.get(`app:${node.id}`),
        };
      });
  }, [appNodes, inputAnalysis, run?.result?.phase]);

  /** 视图节点按 id 索引：命中链、Esc 的上一层、选中框全靠它 O(1) 上下走 */
  const designById = useMemo(
    () => new Map(canvasDesignNodes.map((node) => [node.id, node])),
    [canvasDesignNodes],
  );
  const appById = useMemo(() => new Map(canvasAppNodes.map((node) => [node.id, node])), [canvasAppNodes]);

  /**
   * 原始节点按 id 索引（与视图节点分开：`selected` 里放的是**原始节点**，
   * 右侧信息面板要展示 fills/text/layout 这些视图层已经丢掉的字段）。
   * 原先这里是 `nodes.find(...)` 线性查找 —— 一次点击最多找两次、
   * 一帧 300+ 节点，索引化后顺手改成 O(1)。
   */
  const designRawById = useMemo(
    () => new Map(pair.design.nodes.map((node) => [node.id, node])),
    [pair],
  );
  const appRawById = useMemo(
    () => new Map(pair.app.nodes.map((node) => [node.nodeId, node])),
    [pair],
  );

  /**
   * R4：以设计稿宽度为基准等比缩放截图。设计稿是基准，恒为 1。
   *
   * 这里产出的是**完整上下文**（不只那个比值），因为面板还要回答「这个小数的哪来的」：
   * `designWidth` / `appWidth` 让说明能写 `× 375 / 402`（比 `× 0.9328` 好读），`pixelRatio`
   * 让 `8.67 = 26 / 3` 这种物理像素的来历写得出来。三个数全部来自快照元数据
   * （像素比由 `pixelWidth / width` 现算），没有一个是新引入的 —— 见 `AppAlignContext`。
   */
  const appAlign = useMemo(
    () => ({
      scale: widthAlignScale(pair.design.width, pair.app.width),
      designWidth: pair.design.width,
      appWidth: pair.app.width,
      // 像素比由主进程随配对视图带过来（`buildPairViews`），**不在渲染层现推** ——
      // 那需要 `pixelWidth`，而它只存在于快照元数据里；老快照没有这个字段时是 undefined，
      // 说明那段就少一行，不会编（见 `SideData.pixelRatio`）。
      pixelRatio: pair.app.pixelRatio,
      // 物理像素宽：面板的「像素」块用它构造投影契约（`lib/pixelProjection.ts`）。
      // 同样是快照元数据透传，老快照为 undefined → 那两块整块不画。
      pixelWidth: pair.app.pixelWidth,
      // 宿主取整档位：面板的目标像素与验收报告的几何期望值必须同一条算式
      // （`presnap` 下宽 = S(w·k)，`raw` 下宽 = S((x+w)·k) − S(x·k)，同一矩形差 1px）。
      // 缺省由 `toPixelHostProfile` 落默认档 —— 渲染层不自己 `?? 'presnap'`。
      hostProfile: pair.app.hostProfile,
    }),
    [pair.design.width, pair.app.width, pair.app.pixelRatio, pair.app.pixelWidth, pair.app.hostProfile],
  );
  const appAlignScale = appAlign.scale;

  /**
   * 底图来源。底图不在 NodeCanvas 里渲染，而是交给屏幕空间的 `FrameRaster` ——
   * 挂在 `transform: scale()` 层内会被合成器拉伸，放大后必然发糊。
   * 这里只提供「哪一帧、哪张图、逻辑多宽」，世界坐标由 FrameRaster 自己测量。
   */
  const rasterFrames = useMemo<RasterFrameSource[]>(
    () => [
      {
        source: 'design',
        imageUrl: pair.design.imageUrl,
        imageLabel: pair.design.imageLabel,
        logicalWidth: pair.design.width,
      },
      {
        source: 'app',
        imageUrl: pair.app.imageUrl,
        imageLabel: pair.app.imageLabel,
        logicalWidth: pair.app.width,
      },
    ],
    [pair],
  );

  /**
   * 主动侧选中项在各自扁平表里的 id：设计稿用 `id`、截图用 `nodeId`。
   * `selected` 已经是「主动侧」的（见上面的推导），所以这里不需要再过一遍来源。
   */
  const selectedNodeId = selectionIdOf(selected);

  /**
   * 与选中项**几何完全重合**的兄弟层（含自身，**从下到上**）。判据、实测数据，以及
   * 「为什么只识别不合并」的三条理由，全在 `lib/stack.ts` 的文件头。
   *
   * 绝大多数节点没有重合兄弟（实测 523 个节点里只有 16 组、其中带样式的 3 组），
   * 这时它返回长度 1 —— 下面的展示派生据此整块跳过，所以这个功能对普通节点**零影响**。
   */
  const stackMembers = useMemo(() => {
    if (!selectedNodeId) return [];
    const pool = selected?.source === 'design' ? canvasDesignNodes : canvasAppNodes;
    return stackOf(pool, selectedNodeId);
  }, [canvasAppNodes, canvasDesignNodes, selected, selectedNodeId]);

  /**
   * 重合组额外给面板两样东西：**列表**（这一处有哪几层、每层有什么）与**聚合节点**
   * （样式并集，冲突取上层）。
   *
   * ⚠️ 聚合结果**只喂面板渲染**：id、`SelectedNode`、配对、标注、「记录问题」的目标节点
   * 全都还是那个真实节点（见 `selectedDesignNode` / `selectedAppNode`，它们没被聚合）。
   * 这就是「展示层聚合」与「数据合并」的分界线 —— 前者不动任何一个字节的数据，
   * 后者要动 id 与树形（代价见 `lib/stack.ts` 的三条理由）。
   */
  const { stackView, mergedSelected } = useMemo((): {
    stackView: StackView | null;
    mergedSelected: SelectedNode | null;
  } => {
    const plain = { stackView: null, mergedSelected: null };
    if (!selected || !selectedNodeId || stackMembers.length <= 1) return plain;

    if (selected.source === 'design') {
      const members = stackMembers
        .map((node) => designRawById.get(node.id))
        .filter((node): node is DesignNode => node !== undefined);
      if (members.length <= 1) return plain;
      return {
        stackView: {
          selectedId: selectedNodeId,
          members: members.map((node) => ({
            id: node.id,
            name: node.name || node.type,
            hint: designLayerHint(node),
          })),
        },
        mergedSelected: { source: 'design', node: mergeDesignNodes(members) },
      };
    }

    const members = stackMembers
      .map((node) => appRawById.get(node.id))
      .filter((node): node is AppNode => node !== undefined);
    if (members.length <= 1) return plain;
    return {
      stackView: {
        selectedId: selectedNodeId,
        members: members.map((node) => ({
          id: node.nodeId,
          name: shortClassName(node.className),
          // 小字里的圆角与面板正文、对比表写的是同一个值 → 必须同一把尺子（见 appLayerHint）
          hint: appLayerHint(node, appAlignScale),
        })),
      },
      mergedSelected: { source: 'app', node: mergeAppNodes(members) },
    };
  }, [appAlignScale, appRawById, designRawById, selected, selectedNodeId, stackMembers]);

  /** 按「哪一帧的哪个节点」找回原始节点；找不到返回 null（宁可不动，也别选中到一个空壳） */
  const selectById = useCallback(
    (source: VerifySource, id: string): SelectedNode | null => {
      if (source === 'design') {
        const raw = designRawById.get(id);
        return raw ? { source: 'design', node: raw } : null;
      }
      const raw = appRawById.get(id);
      return raw ? { source: 'app', node: raw } : null;
    },
    [appRawById, designRawById],
  );

  /** canonicalId → 画框要用的三个字段。设计稿用 `id`、App 用 `nodeId`，差异收敛在这一处 */
  const matchFocusLookup = useCallback(
    (source: VerifySource, id: string): MatchFocusNode | null => {
      const node = (source === 'design' ? designById : appById).get(id);
      return node ? { source: node.source, rect: node.rect, clipped: node.clipped } : null;
    },
    [appById, designById],
  );

  /** 当前该在画布上高亮的那一组（哪些节点出框 + 两侧各命中几个） */
  const matchFocus = useMemo<MatchFocus | null>(
    () =>
      focusedMatch
        ? planMatchFocus({
            designIds: focusedMatch.designIds,
            appIds: focusedMatch.appIds,
            lookup: matchFocusLookup,
          })
        : null,
    [focusedMatch, matchFocusLookup],
  );

  /**
   * 传给 `CanvasViewport` 的匹配高亮框。
   *
   * 包一层 memo 是为了**引用稳定**：直接传 `matchFocus?.boxes ?? []` 每次渲染都是
   * 新数组，`FrameRaster` 里那个「屏幕矩形」的 memo 就会每帧重算一遍坐标 ——
   * 而它的依赖里还有实测的帧盒，本来就敏感，不适合再被无谓地戳。
   */
  const rasterMatch = useMemo<RasterSelection[]>(() => matchFocus?.boxes ?? [], [matchFocus]);

  /**
   * 待配对组的框（标注模式）。
   *
   * 节点已经不在当前配对里时**跳过**而不是报错：换过截图 / 重新导入设计稿之后，
   * 待配对组里可能还留着上一份数据的 id。跳过它，其余照常显示 ——
   * 整组不画等于「点了没反应」，而用户此刻正需要看到自己点过的那几个。
   */
  const rasterPending = useMemo<RasterSelection[]>(() => {
    if (!annotating) return [];
    const out: RasterSelection[] = [];
    for (const canonical of pending) {
      const parsed = fromCanonicalId(canonical);
      if (!parsed) continue;
      const node = (parsed.source === 'design' ? designById : appById).get(parsed.id);
      if (node) out.push({ source: node.source, rect: node.rect, clipped: node.clipped });
    }
    return out;
  }, [annotating, appById, designById, pending]);

  const rasterRegions = useMemo<RasterRegion[]>(() => {
    const analysis = run?.result?.regionAnalysis;
    if (!analysis) return [];
    const resultByRegion = new Map(analysis.results.map((item) => [item.regionId, item]));
    const matchByAppRegion = new Map<string, (typeof analysis.matches)[number]>();
    const matchByDesignRegion = new Map<string, (typeof analysis.matches)[number]>();
    for (const match of analysis.matches) {
      for (const designRegionId of match.designRegionIds) matchByDesignRegion.set(designRegionId, match);
      for (const appRegionId of match.appRegionIds) matchByAppRegion.set(appRegionId, match);
    }
    const design = analysis.design.regions.map((region, index) => {
      const result = resultByRegion.get(region.id);
      return {
        source: 'design' as const,
        rect: region.visibleRect ?? region.rect,
        label: `${index + 1} ${region.role}`,
        status: result?.status ?? 'unknown',
        active: matchByDesignRegion.get(region.id)?.id === focusedRegionMatchId,
      };
    });
    const app = analysis.app.regions.map((region, index) => {
      const match = matchByAppRegion.get(region.id);
      const designRegionId = match?.designRegionIds[0];
      const result = designRegionId ? resultByRegion.get(designRegionId) : undefined;
      return {
        source: 'app' as const,
        rect: region.visibleRect ?? region.rect,
        label: `${index + 1} ${region.role}`,
        status: result?.status ?? (match?.status === 'extra' ? 'warning' : 'unknown'),
        active: match?.id === focusedRegionMatchId,
      };
    });
    return [...design, ...app];
  }, [focusedRegionMatchId, run]);

  /* ------------------------------------------------------------------ *
   * SAMA 引擎结论 → 画布第七档
   *
   * ⚠️ 这里的 rect **一律从 `designById` / `appById` 取 `node.rect`**，
   * 绝不用 `issue.evidence.appBox` —— 那个坐标已被 `toDesignBox` 投影到
   * *设计坐标系*，画到 App 帧上会错位（引擎侧回填 designId/appId 就是为了这个）。
   *
   * 分区横带同理：`regions[].designY` 是设计逻辑 y 区间，只能画在设计帧上；
   * App 帧画不了分区横带 —— SAMA 的分区是**按设计稿**切的，App 侧没有对应切法。
   * 所以下面只给 design 侧出带子，App 侧只出 issue 框。
   * ------------------------------------------------------------------ */
  const rasterSamaBands = useMemo<RasterSamaBand[]>(() => {
    const report = samaReport;
    if (!report) return [];
    // 横带跨越整个帧宽，而画布节点索引里没有「帧」这个东西（都是矩形）。
    // 取设计侧所有节点的最右边界当帧宽 —— 与 `measureFrameBoxes` 量的世界宽度同源，
    // 不用某个节点的宽度（那会随分区位置变化而伸缩）。
    let frameWidth = 0;
    for (const node of designRawById.values()) {
      frameWidth = Math.max(frameWidth, node.rect.x + node.rect.width);
    }
    if (frameWidth <= 0) return [];

    return report.regions
      .filter((region) => region.designY[1] > region.designY[0])
      .map((region) => {
        const inRegion = report.issues.filter((issue) => issue.evidence.regionId === region.regionId);
        const worst = (['P0', 'P1', 'P2'] as const)
          .find((severity) => inRegion.some((issue) => issue.severity === severity)) ?? 'P2';
        return {
          source: 'design' as const,
          rect: { x: 0, y: region.designY[0], width: frameWidth, height: region.designY[1] - region.designY[0] },
          label: `${region.regionId} ${region.label}`,
          issueCount: inRegion.length,
          worst,
          noPixelEvidence: region.noPixelEvidence,
          active: samaFocusedIssue !== null
            && inRegion.some((issue) => issue.issueId === samaFocusedIssue),
        };
      });
  }, [samaReport, samaFocusedIssue, designRawById]);

  const rasterSamaIssues = useMemo<RasterSamaIssue[]>(() => {
    const report = samaReport;
    if (!report) return [];
    const out: RasterSamaIssue[] = [];
    for (const issue of report.issues) {
      const evidence = issue.evidence;
      // 单条 issue 在两侧各画一个框。哪侧没有就**不画** —— 不补推测框：
      // 「App 侧根本没有这个元素」本身就是结论，画个空位反而把它说成「有个东西偏了」。
      if (evidence.designId) {
        const node = designById.get(evidence.designId);
        if (node) {
          out.push({
            source: 'design',
            rect: node.rect,
            clipped: node.clipped,
            issueId: issue.issueId,
            severity: issue.severity as SamaSeverity,
            missingOnApp: !evidence.appId,
            active: issue.issueId === samaFocusedIssue,
          });
        }
      }
      if (evidence.appId) {
        const node = appById.get(evidence.appId);
        if (node) {
          out.push({
            source: 'app',
            rect: node.rect,
            clipped: node.clipped,
            issueId: issue.issueId,
            severity: issue.severity as SamaSeverity,
            active: issue.issueId === samaFocusedIssue,
          });
        }
      }
    }
    return out;
  }, [samaReport, samaFocusedIssue, designById, appById]);

  /* ------------------------------------------------------------------ *
   * 清洗核验 → 画布第九档（**只画归并后的节点**）
   *
   * ⭐ 2026-10-04 定案：画布上呈现的是「清洗 + 归并之后的最终节点视图」——
   * 一个框就是一个真实存在的元素。被剔除的节点**不画**。
   *
   * 为什么不画剔除框（实测数据支撑，不是拍脑袋）：
   * 盲盒那份 544 个剔除框里，**L5 视口外 298 个（55%）全部落在视口外** ——
   * 判据本身就是「完全在视口外」，所以它们画出来必然在截图之外，
   * 贡献 0 信息却吃掉一半绘制量。剩下 246 个又有约 150 个挤在价格区等少数区域，
   * 600 个框同屏等于糊成一片，反而看不出「这个元素是归并后的样子」。
   *
   * ⇒ 「剔了什么」改由**面板**承担（按层过滤 + 剔除明细 + evidence）——
   *   那才是适合逐条核对的地方；画布负责展示「剩下的长什么样」。
   *
   * ⚠️ rect 直接用 IPC 带过来的值，不查 `designById`/`appById`：
   * 归并框罩住的是**多个**真实节点，取任一个的 rect 都只是其中一层。
   * ------------------------------------------------------------------ */
  const rasterCleanMerged = useMemo<RasterCleanMerged[]>(() => {
    if (!cleanData) return [];
    const visible = filterByKindFilter(cleanData.merged, cleanKindFilter);
    // ⭐ **默认画全部视图节点**（含 `memberCount === 1` 的直通节点）。
    //
    // 2026-10-04 修正：此前按 `memberCount > 1` 过滤，实测设计侧 444 个节点里
    // 只有 74 个真被归并 —— **315 个直通节点全被滤掉**，其中包含全部 68 个
    // 文本节点。用户看到的现象就是「文字没有框」「很多元素缺框」。
    //
    // ⚠️ 下面 `cleanKindFilter` 是**额外的**显式开关（默认 `structured`），
    // 它只藏「不画任何像素的纯结构框」，不会藏可见盒子 —— 见该 state 的注释。
    // `structured` 档只藏「容器里没有背景/边框/圆角」的纯结构框。
    // ⚠️ 判据是 `hasBoxPaint` 而**不是** `hasChildren`（实测后者会误藏
    // 全部 110 个可见盒子，详见该 state 的注释）。
    return visible.map((m) => ({
      source: m.side,
      id: m.id,
      rect: { x: m.rect[0], y: m.rect[1], width: m.rect[2], height: m.rect[3] },
      kind: m.kind,
      memberCount: m.memberCount,
      active: cleanFocus === `merged:${m.id}`,
    }));
  }, [cleanData, cleanFocus, cleanKindFilter]);

  /** 清洗视图的数据与高亮：交给面板驱动 */
  const cleanIn = useMemo(() => {
    // ⭐ 过滤后的统计在**这里**算一次，而不是让面板自己再 filter 一遍 ——
    // 两处各 filter 一次必然漂（面板报「归并明细 500 条」而画布只有 518 个框，
    // 用户会以为画布漏画了）。
    const visible = cleanData ? filterByKindFilter(cleanData.merged, cleanKindFilter) : [];
    const hidden = cleanData ? cleanData.merged.length - visible.length : 0;
    const hiddenVisibleBoxes = cleanData
      ? cleanData.merged.filter(
          (m) => m.nodeKind === 'container' && m.hasBoxPaint
            && !visible.includes(m),
        ).length
      : 0;
    return {
      data: cleanData,
      focus: cleanFocus,
      tierFilter: cleanTierFilter,
      kindFilter: cleanKindFilter,
      visibleCount: visible.length,
      hiddenCount: hidden,
      hiddenVisibleBoxes,
    };
  }, [cleanData, cleanFocus, cleanTierFilter, cleanKindFilter]);

  /** 面板按层过滤：空集合 = 全显示（只影响面板里的剔除明细，画布已不画剔除框） */
  const toggleCleanTier = useCallback((tier: string): void => {
    setCleanTierFilter((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  }, []);

  /** 面板点某个归并视图 → 画布高亮它 */
  const focusCleanMerged = useCallback((id: string | null): void => {
    setCleanFocus(id === null ? null : `merged:${id}`);
  }, []);

  /** 点面板上的 issue → 画布选中对应节点（右栏随之出节点详情） */  const focusSamaIssue = useCallback((issueId: string | null): void => {
    setSamaFocusedIssue((current) => (current === issueId ? null : issueId));
    if (!issueId || !samaReport) return;
    const evidence = samaReport.issues.find((item) => item.issueId === issueId)?.evidence;
    if (!evidence) return;
    // 写**两侧各自的槽**（`selection` 是 Record<VerifySource, …>），不能合成一次写入。
    // 用现成的 `selectById` 而不是自己拼 SelectedNode —— 它是「id → 选中项」的唯一实现，
    // 另写一份就会在节点类型上分叉。
    const design = evidence.designId ? selectById('design', evidence.designId) : null;
    const app = evidence.appId ? selectById('app', evidence.appId) : null;
    if (design || app) {
      setSelection((prev) => ({
        ...prev,
        ...(design ? { design } : {}),
        ...(app ? { app } : {}),
      }));
    }
  }, [samaReport, selectById, setSelection]);

  const handleFocusRegion = useCallback((matchId: string): void => {
    setFocusedRegionMatchId((current) => current === matchId ? null : matchId);
  }, []);

  /**
   * 给匹配列表明示「现在高亮的是哪一条」。
   *
   * 回灌给面板的是 **id 而不是布尔**：列表据此给那一行加选中态 ——
   * 没有它，用户点完只看到画布上亮了几个框，却不知道对应列表里哪一行，
   * 想再点一次取消都找不着目标。
   */
  const activeMatchKey = useMemo(
    () =>
      focusedMatch ? matchKeyOf(focusedMatch.id, focusedMatch.designIds, focusedMatch.appIds) : null,
    [focusedMatch],
  );

  /**
   * 把 hover 结果落进 state。
   *
   * ⚠️ 必须先用 ref 挡一道：mousemove 每秒几十次，每次都 setState 会让 300+ 节点的
   * 节点层跟着重渲染。key 没变就直接返回。
   */
  const commitHover = useCallback((next: HoverTarget | null): void => {
    const key = next ? `${next.source}:${next.id}` : null;
    if (hoverKeyRef.current === key) return;
    hoverKeyRef.current = key;
    setHovered(next);
  }, []);

  /**
   * hover 该高亮谁 —— 交给**与单击完全相同的纯函数**（`planCanvasHover`）。
   *
   * 于是「环所在的层级」= 「下一击会选中的层级」是个恒等式，而不是一条要靠人维护的约定：
   * 单击选命中本身、原地再点上移一层，环就跟着停在父级上。用户报的
   * 「13531 / 13533 / 13532 无法通过 hover 选中，只能选到子节点」正是这条缺失导致的
   * ——那时 hover 直接拿原始命中当目标，而原始命中永远是命中最深的那一个。
   *
   * `selectionId` 必须**传进来**而不是现读 state：落地选中的同一轮里 state 还没更新，
   * 读到旧值就会把「刚点过」判成「没点过」，环落在错的一层。
   */
  const resolveHover = useCallback(
    (hit: HoverHit | null, selectionId: string | null): HoverTarget | null => {
      if (!hit) return null;
      const byId = hit.node.source === 'design' ? designById : appById;
      const at = planCanvasHover({
        chain: ancestorChain(byId, hit.node.id),
        selectedId: selectionId,
        point: hit.point,
        // 分侧取痕迹：光标在哪一帧，「原地」就按那一帧上一次点击算
        prev: clickCycleRef.current[hit.node.source],
      });
      return at ? { source: hit.node.source, id: at } : null;
    },
    [appById, designById],
  );

  /** 光标移到了哪里：记下原始命中（落地选中时要拿它重算），再解析成「该高亮谁」 */
  const applyHover = useCallback(
    (hit: HoverHit | null): void => {
      lastHoverRef.current = hit;
      // 「这一帧当前选中了谁」取**即时镜像**（不读 state，理由见 selectedIdRef），
      // 而且取的是**命中所在那一侧**的槽：另一侧选着谁与这一击无关。
      const source = hit?.node.source;
      commitHover(resolveHover(hit, source ? selectedIdRef.current[source] : null));
    },
    [commitHover, resolveHover],
  );

  /**
   * 落地一次「选中谁」。**所有改选中态的入口都走这里** —— 画布单击、图层列表、
   * Esc。
   *
   * 集中在一处是刻意的：上一层的父级只是选中项的函数
   * （`parentContextOf`，只有 Esc 用得上）—— 不存在两份状态对不上的可能，
   * 前提是没有人绕过这里去 `setSelection`。
   *
   * ⚠️ 它只写**这一侧**的槽：另一侧的选中项与它无关（这正是「两侧互相独立」）。
   *    用户报的「选了设计稿节点、再选 App 节点，设计稿的选中态消失」就是原先把
   *    唯一的那个槽覆盖掉了。
   *
   * `cycle` 只有画布单击传得进来 —— 它是「原地再点」的判据；
   * 其余入口（列表 / 键盘）都没点画布，必须传 null 清掉。
   */
  const applySelection = useCallback(
    (source: VerifySource, nodeId: string, cycle: ClickCycle | null, exclusive = false): void => {
      clickCycleRef.current[source] = cycle;
      const picked = selectById(source, nodeId);
      if (!picked) return;
      const other: VerifySource = source === 'design' ? 'app' : 'design';
      setSelection((prev) => {
        if (!exclusive || measureAnchors[other]) return { ...prev, [source]: picked };
        clickCycleRef.current[other] = null;
        selectedIdRef.current[other] = null;
        return { ...prev, [source]: picked, [other]: null };
      });
      // 最近一次选中的是这一侧 → 右栏 / Esc / 读数从此认它
      setPreferredSide(source);
      // 只有换了锚点所在侧的选中项，原来的间距对才失效。
      // 另一侧的选择是独立状态，不能顺手清掉当前侧留下的锚点。
      setMeasureAnchors((prev) => (prev[source] === null ? prev : { ...prev, [source]: null }));
      selectedIdRef.current[source] = nodeId;
      // 选中项 / 档位变了 → hover 的目标跟着变。拿**同一个落点**立刻重算一次，
      // 环才会停在「下一击会选中的那个」上（原地再点之后就是刚刚选中的父级）。
      // ⚠️ 只重算**同一帧**的：光标在另一侧时那次 hover 与这次选中无关，别误清掉。
      const hit = lastHoverRef.current;
      if (hit && hit.node.source === source) commitHover(resolveHover(hit, nodeId));
    },
    [commitHover, measureAnchors, resolveHover, selectById],
  );

  /**
   * 点到的节点落在匹配组**之外** → 收掉高亮。
   *
   * 为什么要有这一条：匹配高亮会抑制「对侧框」（同一批节点上两条描边叠着没法读），
   * 所以用户一点到别处，画布就既没有匹配框、也没有对侧框 —— 等于比平时还少一层信息。
   * 收掉高亮之后对侧框立刻回来，两种模式自然切换。
   *
   * **组内不清**：在一条匹配的几个节点之间来回点着看（成组匹配常有的事），
   * 正是核对时的常态，那时把高亮收掉反而是帮倒忙。
   */
  const dropFocusIfOutside = useCallback(
    (source: VerifySource, rawId: string): void => {
      if (!focusedMatch) return;
      const canonical = toCanonicalId(source, rawId);
      if (
        focusedMatch.designIds.includes(canonical) ||
        focusedMatch.appIds.includes(canonical)
      ) {
        return;
      }
      setFocusedMatch(null);
    },
    [focusedMatch],
  );

  /**
   * 画布内点击。选中谁不取命中结果，而是交给 `planCanvasClick`：命中的永远是**最深**
   * 那个（浏览器的结论），而规则还要看「是不是在原地又点了一次」。
   *
   * 一条点击同时能做两件事：普通单击（选命中本身）、原地再点（上移一层）。
   * 两者都在纯函数里，这里只转发结果。
   *
   * 另两条**不走纯函数**的分支（它们要的是「我指着这一个」，不做层级解析）：
   * 标注模式下把节点加进待配对组、⌘/Ctrl 单击把节点设成间距锚点。
   * 两条都只改**本侧**的东西 —— 另一侧的选中与它们无关（两侧互相独立）。
   */
  const handleCanvasPick = useCallback(
    (node: RenderNode, point: PickPoint, mods: ClickMods): void => {
      // 标注模式下这一击的含义完全不同：不是「选中一层」，而是「把这一层加进待配对组」。
      //
      // ⚠️ 刻意**不走 `planCanvasClick`**（不做祖先链解析、不做原地再点上移）：
      //    那条规则解决的是「容器被后代盖住、点不到」——一个**浏览**问题。
      //    而标注要的是「我指着这一个」，级联上移会让人在连点几下之后
      //    把一个父容器也标进去，而那正是标注里最不该有的噪声（父容器与元素不是一回事）。
      //    代价是「想标容器就得先点进去再往上退」——但标注天然是逐元素的动作，
      //    容器本来就不该被标成 `matched`（引擎自己也不让 layout 参与 missing / extra）。
      if (annotating) {
        setPending((current) => togglePending(current, toCanonicalId(node.source, node.id)));
        setSideTab('calibrate');
        return;
      }

      // ⌘/Ctrl + 单击 → **把这一击设成间距锚点**：选中项不动，读数固定在
      // 「选中 ↔ 锚点」之间（hover 不再顶掉它）。
      //
      // 与标注模式同理：**不做层级解析**（不走 planCanvasClick）—— 锚点要的是
      // 「我指着这一个」，级联上移会让人连点几下之后把某个父容器也量进来。
      // 同理 hover 环在 ⌘ 按下时画的也是命中本身，两者同源。
      if (mods.meta) {
        // ⚠️ 看的是**同一侧**的槽，不是「主动侧」：点哪一侧，量的就是那一侧的两个元素。
      //    用主动侧的话，设计稿选着一个、App 侧点一下变主动，再回设计稿 ⌘ 点
      //    就会被判成「没有选中项」而退化成普通选中 —— 用户看到的是一按 ⌘ 就丢选中。
      const own = selection[node.source];
        const otherSource: VerifySource = node.source === 'design' ? 'app' : 'design';
        // 对侧已有选中项、当前侧还没有时，⌘ 点击用于补选第二侧节点并开启 diff。
        if (!own) {
          if (selection[otherSource]) dropFocusIfOutside(node.source, node.id);
          applySelection(node.source, node.id, null);
          setSideTab('node');
          return;
        }
        // ⌘ 再点一次当前锚点 = 取消固定（也覆盖「⌘ 点选中项自己」：那等于没得量）。
        const ownAnchor = measureAnchors[node.source];
        const sameAsAnchor = ownAnchor?.id === node.id;
        if (sameAsAnchor || selectionIdOf(own) === node.id) {
          setMeasureAnchors((prev) => ({ ...prev, [node.source]: null }));
          return;
        }
        setMeasureAnchors((prev) => ({
          ...prev,
          [node.source]: { source: node.source, id: node.id },
        }));
        return;
      }

      const byId = node.source === 'design' ? designById : appById;
      const outcome = planCanvasClick({
        chain: ancestorChain(byId, node.id),
        // 只认**本侧**的槽：这一侧没选中时，那一击自然谈不上「原地再点」。
        // （从前两侧共用一份选中，所以这里得额外判「选中项是不是在另一侧」——
        //  两侧各有槽之后，那个判断连同它的边界情形一起消失了。）
        selectedId: slotIdOf(selection, node.source),
        point,
        prev: clickCycleRef.current[node.source],
      });
      if (!outcome) return;
      dropFocusIfOutside(node.source, outcome.selectedId);
      applySelection(node.source, outcome.selectedId, outcome.cycle, true);
      // 在画布上主动点一个节点 = 「我要看这个」，右栏就该显示节点信息。
      // ⚠️ 只有**画布 / 图层列表**的直接点击会切 tab：从验收面板点问题项也会走
      //    handleSelect（→ applySelection），但那时用户正在**逐条过清单**，把 tab 抢过去
      //    会让他每看一条都要手动切回来。所以切换只加在「人主动定位」的两个入口上。
      setSideTab('node');
    },
    [
      annotating,
      appById,
      applySelection,
      designById,
      dropFocusIfOutside,
      measureAnchors,
      selection,
    ],
  );

  /**
   * 从**外部**指定选中谁：图层列表、验收面板的问题项都走这里。
   *
   * 不做任何层级解析 —— 「选中谁就是谁」。只选中，不动视口（与画布内点击同一语义）。
   */
  const handleSelect = useCallback(
    (node: RenderNode): void => {
      applySelection(node.source, node.id, null);
    },
    [applySelection],
  );

  /**
   * 切到重合组里的另一层（面板「此处有 N 个元素」列表点一下）。
   *
   * 走 `applySelection`（画布单击 / 图层列表 / Esc 的同一条路径）而不是直接 `setSelection`：
   * 两侧的槽、`preferredSide`、间距锚点失效判断都在那里，绕过去就会长出第二份规则。
   * `cycle` 传 null —— 这一击没落在画布上，谈不上「原地再点」；`exclusive` 保持默认 false，
   * 于是**另一侧的槽原样保留**（用户在两侧各选一个对照着看时，切层不该把对面清掉）。
   */
  const pickStackLayer = useCallback(
    (id: string): void => {
      if (!selected) return;
      applySelection(selected.source, id, null);
    },
    [applySelection, selected],
  );

  /**
   * 清掉**某一侧**的选中：点该侧帧内的空白 / 在那一侧按 Esc 退无可退 / 右栏的 ×
   * （× 清的是主动侧）。
   *
   * ⚠️ **另一侧的选中不受影响** —— 这正是「两侧互相独立」落地的地方。用户在两侧
   *    各选一个元素对照着看时，在任一侧点空白只该收掉那一侧。
   *
   * ⚠️ 主动侧不用在这里维护：`resolveActiveSide` 会发现那个槽空了，当场改指另一侧。
   *    在这里再写一遍「把主动侧换成另一个」就是第二份状态，迟早对不上。
   */
  const clearSide = useCallback((source: VerifySource): void => {
    clickCycleRef.current[source] = null;
    selectedIdRef.current[source] = null;
    hoverKeyRef.current = null;
    lastHoverRef.current = null;
    setHovered(null);
    setSelection((prev) => (prev[source] === null ? prev : { ...prev, [source]: null }));
    setMeasureAnchors((prev) => (prev[source] === null ? prev : { ...prev, [source]: null }));
    // 「清空」是一条明确的收工信号（Esc 退到最外层再按一次 / 点右栏的 ×），
    // 匹配高亮跟着一起收掉：否则屏幕上还留着几个框，而选中框已经没了，
    // 看起来像「有东西没关掉」。画布内的普通单击**不清** —— 那只是换个节点看，
    // 属于「还在核对这一条」的正常动作。
    setFocusedMatch(null);
  }, []);

  /** 清掉**主动侧**（右栏的 × 与 Esc 退无可退走这里）。两侧都没选中时什么都不做 */
  const handleClearSelection = useCallback((): void => {
    if (activeSide) clearSide(activeSide);
  }, [activeSide, clearSide]);

  /**
   * 光标移动：只上报**原始命中**；「该高亮谁」由 `applyHover` 按与单击相同的规则推出来。
   * 落点必须一起带过来 —— 判「原地再点」要用它，缺一个 hover 与单击就会各算各的。
   *
   * ⚠️ 修饰键**不再需要**（2026-09-28）：原先要它是因为 ⌥ 会改变层级解析（跳整帧），
   *    那个键已删；⌘ 只影响「设成间距锚点」，而那条压根不走层级解析（见 handleCanvasPick）。
   */
  const handleHover = useCallback(
    (node: RenderNode | null, point?: PickPoint): void => {
      applyHover(node && point ? { node, point } : null);
    },
    [applyHover],
  );

  /**
   * 进画布就拉一次门禁、历史映射与已有标注。
   *
   * 先拉门禁而不是等「运行验收」再说：用户需要先知道「这页有没有资格被验收」
   * （SDK 节点是否上传过、有没有被截断）。等点下去才报缺数据，等于白等一次等待。
   *
   * 标注也在这里一起拉：它是**人工劳动**，上次标到一半关掉窗口，再打开时必须原样回来。
   * 与 mapping 并行发（两条互不依赖的读），不串行等。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextReadiness, nextMapping, nextGroundTruth] = await Promise.all([
          window.api.verify.getAcceptanceReadiness(pair.meta.id),
          window.api.verify.getNodeMapping(pair.meta.id),
          window.api.verify.getGroundTruth(pair.meta.id),
        ]);
        if (cancelled) return;
        setReadiness(nextReadiness);
        setMapping(nextMapping);
        setGroundTruth(nextGroundTruth);
      } catch (cause) {
        if (!cancelled) setRunError((cause as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pair.meta.id]);

  const handleRun = useCallback((): void => {
    setRunBusy(true);
    setRunError(null);
    void (async () => {
      try {
        const meta = await window.api.verify.runAcceptance({ pairId: pair.meta.id, useAi });
        setRun(meta);
        if (meta.status === 'failed') setRunError(meta.error ?? '验收失败');
      } catch (cause) {
        setRunError((cause as Error).message);
      } finally {
        setRunBusy(false);
      }
    })();
  }, [pair.meta.id, useAi]);

  /**
   * 点匹配明细 / 问题项 → 在画布上把**这条匹配涉及的全部节点**高亮出来。
   *
   * 与「选中」是两件事，刻意分开：
   *  - 选中（`selection` 的两个槽）一次总共只标出两个节点、会被画布点击改掉，
   *    回答「右栏现在看哪个节点」；
   *  - 高亮（`focusedMatch`）是**一组**、只在列表里再点一次才消失，回答
   *    「我在这条清单上核对着哪一条」。
   *
   * 早期版本只有选中：点一条 1:1 匹配时，画布上亮的是设计稿那一个，对侧的靠
   * `peerIndex` 推导出来 —— 看起来能用。但成组匹配（N:M，文本聚合后 3 个设计文本
   * ↔ 1 个 App 文本）只亮得出**两侧各第一个**，同组另外两个节点根本不出现；
   * 而「这一组是不是都对上了」恰恰是成组匹配唯一要看的。
   *
   * `matchId` 可选：匹配明细与问题项都带引擎给的 id，能互相对上同一条；
   * 手工映射没有 id，退化成一侧 id 拼接。
   *
   * 高亮**不移动视口**（理由见函数尾的注释）：画布上只多出青色的框，取景仍是用户
   * 自己摆好的那一个。所以「点了没反应」的正确判读是「看画布上有没有青色框」，
   * 而不是「视口有没有动」。
   */
  const handleFocusMatch = useCallback(
    (designIds: string[], appIds: string[], matchId?: string | null): void => {
      const nextKey = matchKeyOf(matchId, designIds, appIds);

      // 再点同一条 = 取消高亮。列表里没有「清除」按钮，收回去只能靠这一下 ——
      // 否则用户框出一组之后，除了去点别的条目就再也去不掉它。
      if (
        focusedMatch &&
        matchKeyOf(focusedMatch.id, focusedMatch.designIds, focusedMatch.appIds) === nextKey
      ) {
        setFocusedMatch(null);
        return;
      }

      setFocusedMatch({ id: matchId ?? null, designIds, appIds });

      // 右栏仍要挑一个节点显示。优先设计稿 —— 它的 fills / text / layout 是判断依据，
      // App 侧只有 class 名与矩形（原来的取舍，理由不变）。
      // ⚠️ 选中 ≠ 高亮：这里只决定「右栏看谁」，画布上亮哪些由 `focusedMatch` 决定。
      const primary =
        firstResolvedNode(designIds, 'design', designById) ??
        firstResolvedNode(appIds, 'app', appById);
      if (primary) handleSelect(primary);

      // ⚠️ **刻意不动视口**。这里曾经有一条 effect，把视口移并缩放到这一组的并集矩形上
      //    （节点更多的那一侧，常常就是设计稿）。但点清单的诉求是「这一对在哪」——
      //    两帧并排摆着，用户多半已经调好了取景，一点就跳走等于把刚才的位置丢掉。
      //    所以高亮只画框，视口留给用户；要「过去」就走图层列表那条显式路径
      //    （`handleFocus`，那一击的意图本来就是聚焦）。
    },
    [appById, designById, focusedMatch, handleSelect],
  );

  /**
   * `design:12` / `app:34` → 人能读的名字，供验收面板（问题项 + 匹配明细）显示。
   *
   * 用 `RenderNode.label`：设计稿侧是文本内容或图层名，App 侧是文本 / contentDescription /
   * resourceName / className。**不能直接把 canonicalId 显示出去** —— SDK 节点的 id 就是
   * 采集时的数字 nodeId（`app:4821`），而验收面板是用户唯一能拿来定位的线索，
   * 一串数字等于没有线索。
   *
   * 查不到节点时回退成带来源的 id（`App 4821`）而不是空串：匹配结果引用到已被删除的
   * 节点是可能的，此时条目仍要能看出「是 App 侧还是设计稿侧的那个节点」。
   */
  const nodeLabel = useCallback(
    (canonicalId: string): string => {
      const parsed = fromCanonicalId(canonicalId);
      if (!parsed) return canonicalId;
      const node = parsed.source === 'design' ? designById.get(parsed.id) : appById.get(parsed.id);
      return node?.label || `${parsed.source === 'design' ? '设计稿' : 'App'} ${parsed.id}`;
    },
    [appById, designById],
  );

  /**
   * 人工映射的唯一写入口（确认 / 忽略都走它）。
   *
   * 每次写都把整份 mapping 读出来改再写回去，而不是在组件里增量拼 ——
   * 锚点与忽略规则是**同一次匹配的输入**，分两次写会出现「锚点生效了、忽略还没生效」
   * 的中间态，那期间跑出来的结论没人能解释。
   */
  const persistMapping = useCallback(
    (mutate: (current: NodeMapping) => NodeMapping): void => {
      const base: NodeMapping = mapping ?? {
        version: '1.0.0',
        pairId: pair.meta.id,
        anchors: [],
        ignoredDesignNodeIds: [],
        ignoredAppNodeIds: [],
        matches: [],
        regionOverrides: [],
        updatedAt: new Date().toISOString(),
      };
      const next = mutate(base);
      void (async () => {
        try {
          const saved = await window.api.verify.saveNodeMapping({
            pairId: pair.meta.id,
            mapping: {
              version: next.version,
              anchors: next.anchors,
              ignoredDesignNodeIds: next.ignoredDesignNodeIds,
              ignoredAppNodeIds: next.ignoredAppNodeIds,
              matches: next.matches,
              regionOverrides: next.regionOverrides,
            },
          });
          setMapping(saved);
          setRunError(null);
        } catch (cause) {
          setRunError((cause as Error).message);
        }
      })();
    },
    [mapping, pair.meta.id],
  );

  const handleConfirmMatch = useCallback(
    (match: NodeMatch): void => {
      persistMapping((current) => {
        const key = match.designNodeIds.join(',');
        return {
          ...current,
          matches: [
            ...current.matches.filter((item) => item.designNodeIds.join(',') !== key),
            { ...match, source: 'manual', status: 'matched', confidence: 1, margin: 1 },
          ],
        };
      });
    },
    [persistMapping],
  );

  const handleIgnoreMatch = useCallback(
    (match: NodeMatch): void => {
      persistMapping((current) => {
        const key = match.designNodeIds.join(',');
        return {
          ...current,
          ignoredDesignNodeIds: [...new Set([...current.ignoredDesignNodeIds, ...match.designNodeIds])],
          ignoredAppNodeIds: [...new Set([...current.ignoredAppNodeIds, ...match.appNodeIds])],
          matches: current.matches.filter((item) => item.designNodeIds.join(',') !== key),
        };
      });
    },
    [persistMapping],
  );

  const persistRegionOverride = useCallback(
    (match: RegionMatch, action: 'confirm' | 'ignore', appRegionIds = match.appRegionIds): void => {
      persistMapping((current) => {
        const designIds = new Set(match.designRegionIds);
        return {
          ...current,
          regionOverrides: [
            ...current.regionOverrides.filter((item) => !item.designRegionIds.some((id) => designIds.has(id))),
            {
              id: `${match.designRegionIds.join('+')}=>${appRegionIds.join('+') || 'ignored'}`,
              designRegionIds: [...match.designRegionIds],
              appRegionIds: [...appRegionIds],
              action,
              updatedAt: new Date().toISOString(),
            },
          ],
        };
      });
    },
    [persistMapping],
  );

  const handleConfirmRegion = useCallback((match: RegionMatch): void => {
    persistRegionOverride(match, 'confirm');
  }, [persistRegionOverride]);

  const handleIgnoreRegion = useCallback((match: RegionMatch): void => {
    persistRegionOverride(match, 'ignore');
  }, [persistRegionOverride]);

  const handleCorrectRegion = useCallback((match: RegionMatch, appRegionId: string): void => {
    persistRegionOverride(match, 'confirm', [appRegionId]);
  }, [persistRegionOverride]);

  // ---------- 人工标注（ground truth） ----------
  // 与上面的 mapping 完全分家：mapping 会被引擎读、会改变匹配结果；标注只被导出。
  // 混用会让「引擎算得对不对」这个问题的答案被它自己的输入污染（见 types/groundTruth.ts）。

  const handleTogglePending = useCallback((canonicalId: string): void => {
    setPending((current) => togglePending(current, canonicalId));
  }, []);

  const handleClearPending = useCallback((): void => {
    setPending([]);
  }, []);

  /** 新建 / 修改标注时**每次都把整份写回去**，与 `persistMapping` 同一理由：分次写会留下中间态 */
  const persistGroundTruth = useCallback(
    (mutate: (current: GroundTruthPair[]) => GroundTruthPair[]): void => {
      const pairs = mutate(groundTruth?.pairs ?? []);
      void (async () => {
        setGtBusy(true);
        try {
          const saved = await window.api.verify.saveGroundTruth({
            pairId: pair.meta.id,
            groundTruth: { version: '1.0.0', pairs },
          });
          setGroundTruth(saved);
          setGtError(null);
        } catch (cause) {
          setGtError((cause as Error).message);
        } finally {
          setGtBusy(false);
        }
      })();
    },
    [groundTruth, pair.meta.id],
  );

  /**
   * 提交待配对组。
   *
   * 提交后**立刻清空待配对组**，而不是留着让人再点一次「配对」：
   * 留着的话，下一组节点是从一个已有的组上继续加 —— 那会把两组并成一组，
   * 而画布上看不出这件事（框的颜色一样），只有导出时才暴露成一条 N:M 的怪记录。
   */
  const commitPending = useCallback(
    (verdict: GroundTruthVerdict): void => {
      if (submitBlocker(pending, verdict) !== null) return;
      const built = buildPair(pending, verdict);
      if (!built) return;
      persistGroundTruth((current) => upsertPair(current, built));
      setPending([]);
    },
    [pending, persistGroundTruth],
  );

  const handleDeletePair = useCallback(
    (id: string): void => {
      persistGroundTruth((current) => removePair(current, id));
    },
    [persistGroundTruth],
  );

  /**
   * 写备注。
   *
   * 空串 → **把字段删掉**而不是留一个 `note: ''`：导出时判「有没有备注」是
   * `note && note.length > 0`，两种写法结果一样，但文件里多出一堆 `"note": ""`
   * 会让我在读完导出后分不清「他特意写了空」还是「他清空了内容」。
   */
  const handleSetNote = useCallback(
    (id: string, note: string): void => {
      const trimmed = note.trim();
      persistGroundTruth((current) =>
        current.map((item) => {
          if (item.id !== id) return item;
          const next = { ...item };
          if (trimmed.length > 0) next.note = trimmed;
          else delete next.note;
          return next;
        }),
      );
    },
    [persistGroundTruth],
  );

  /**
   * 从引擎结论预填 `matched` 项。
   *
   * ⚠️ 预填项带 `engine-prefill` 标记：它们不是独立证据，导出时会按来源分开统计
   * （见 lib/calibration 的 `prefillFromMatches`）。这里不拦着用户预填 ——
   * 「先铺一份草稿、只改错的」是最省力的标注方式，前提是**这件事必须被记录下来**。
   */
  const handlePrefillFromEngine = useCallback((): void => {
    const matches = result?.matches ?? mapping?.matches ?? [];
    if (matches.length === 0) {
      setGtError('还没有引擎结论可预填 —— 先跑一次「运行验收」');
      return;
    }
    const { pairs, skipped } = prefillFromMatches(matches, groundTruth?.pairs ?? []);
    if (pairs.length === 0) {
      setGtError(
        skipped > 0
          ? `${skipped} 条已匹配结论都已在标注里，没有新增`
          : '这次引擎没有给出可用于预填的「已匹配」结论',
      );
      return;
    }
    persistGroundTruth((current) => [...pairs, ...current]);
  }, [groundTruth, mapping, persistGroundTruth, result]);

  const handleExportGroundTruth = useCallback((): void => {
    void (async () => {
      setGtBusy(true);
      try {
        const exported = await window.api.verify.exportGroundTruth({
          requirementId: pair.meta.requirementId,
          pairId: pair.meta.id,
        });
        setGtExported(exported);
        setGtError(null);
      } catch (cause) {
        setGtExported(null);
        setGtError((cause as Error).message);
      } finally {
        setGtBusy(false);
      }
    })();
  }, [pair.meta.id, pair.meta.requirementId]);

  /**
   * 面板里点某一条标注 → 用**既有的匹配高亮通道**框出它两侧的节点。
   *
   * 不新开一条通道：这里要表达的就是「这一组这几个节点」，与匹配高亮完全同一件事，
   * 只是来源从引擎结论换成了人工标注。再开一种颜色只会让人多记一条规则。
   */
  const handleFocusAnnotation = useCallback(
    (target: GroundTruthPair): void => {
      handleFocusMatch(target.designNodeIds, target.appNodeIds, target.id);
    },
    [handleFocusMatch],
  );

  const pendingPreview = useMemo(
    () => ({ design: sideIdsOf(pending, 'design'), app: sideIdsOf(pending, 'app') }),
    [pending],
  );
  const pendingStat = useMemo(() => pendingCounts(pending), [pending]);
  const pendingBlocker = useMemo(() => submitBlocker(pending, 'matched'), [pending]);
  /** 已经在别的标注里的节点。同一个节点被标进两条会静默地让两条都不成立 */
  const annotatedSet = useMemo(() => annotatedIds(groundTruth?.pairs ?? []), [groundTruth]);
  const annotationDigest = useMemo(() => summarize(groundTruth?.pairs ?? []), [groundTruth]);
  const pendingDuplicates = useMemo(
    () => pending.filter((id) => annotatedSet.has(id)).length,
    [annotatedSet, pending],
  );

  /**
   * 键盘：**Esc 上一层**。
   *
   * Esc 走的是**和「原地再点」同一条通道**（选中父级）—— 区别只是不用瞄准：
   * 一个在光标底下点两下，一个按一下键。到最外层容器之后再按一次 Esc 才清空选中。
   *
   * ⚠️ 浏览态的 **Enter 下一层**（`descendInto`）2026-09-28 已按用户要求删除。
   *    别把「上移 / 下钻」当一对来补 —— 下钻本来就有 `单击`（它选的就是最深那个），
   *    Enter 只是给同一件事加了个键。
   *
   * 标注模式下这两个键换成「清空待配对组 / 提交为配对」—— Enter 在那里**保留**，
   * 它提交的是标注，与「进入子节点」是两回事。⚠️ 那两条判断必须在
   * 「有没有选中节点」那道闸**之前** —— 标注时选中项与待配对组是两回事
   * （选中回答「我在看哪个」，待配对回答「我要标哪几个」），
   * 拿选中项去挡键盘会让「刚点完三个节点想按 Esc 撤销」按不动。
   *
   * 不放在画布元素的 onKeyDown 上：画布容器不可聚焦（`div` 没有 tabindex），
   * 事件根本到不了它那儿。挂在 window 上，但要挡掉输入框里的按键。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }

      if (annotating) {
        if (event.key === 'Escape') {
          if (pending.length === 0) return;
          event.preventDefault();
          handleClearPending();
          return;
        }
        if (event.key === 'Enter') {
          if (submitBlocker(pending, 'matched') !== null) return;
          event.preventDefault();
          commitPending('matched');
        }
        return;
      }

      if (!selected || !selectedNodeId) return;

      const source = selected.source;
      const byId = source === 'design' ? designById : appById;

      if (event.key === 'Escape') {
        const parent = parentContextOf(byId, selectedNodeId);
        // 已经是最外层容器 → 退无可退，这时才该清除选中
        if (!parent) {
          handleClearSelection();
          return;
        }
        event.preventDefault();
        applySelection(source, parent, null);
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    annotating,
    appById,
    applySelection,
    commitPending,
    designById,
    handleClearPending,
    handleClearSelection,
    pending,
    selected,
    selectedNodeId,
  ]);

  /**
   * 传给屏幕空间层的选中框：**两侧各一个**（各自独立，点一侧不清另一侧）。
   *
   * 这里只给**帧内逻辑矩形**，屏幕位置由 FrameRaster 换算 —— `alignScale`（R4 按宽对齐）
   * 与帧的世界坐标都在那边，调用方再算一遍等于把同一套几何实现两遍，迟早分叉。
   */
  const rasterSelections = useMemo<RasterSelection[]>(() => {
    const out: RasterSelection[] = [];
    for (const source of ['design', 'app'] as const) {
      const id = slotIdOf(selection, source);
      if (!id) continue;
      const node = (source === 'design' ? designById : appById).get(id);
      if (node) out.push({ source: node.source, rect: node.rect, clipped: node.clipped });
    }
    return out;
  }, [selection, designById, appById]);

  /**
   * hover 环：与选中框同一套换算、同一层。
   * 指向的是**「下一击会选中的那个」**（由 `planCanvasHover` 与单击同源推出）——
   * 不是「光标底下最深的那个」，否则那些点不到的父级永远 hover 不到。
   */
  const rasterHover = useMemo<RasterSelection | null>(() => {
    if (!hovered) return null;
    const node = (hovered.source === 'design' ? designById : appById).get(hovered.id);
    return node ? { source: node.source, rect: node.rect, clipped: node.clipped } : null;
  }, [hovered, designById, appById]);

  /**
   * 间距锚点的框：读数固定时，另一端是谁必须看得见 —— 否则屏幕上孤零零一条线，
   * 用户只能靠猜。与选中框同一套换算（同一个 `projectionOf`）。
   */
  const rasterAnchors = useMemo<RasterSelection[]>(() => {
    return (['design', 'app'] as const).flatMap((source) => {
      const anchor = measureAnchors[source];
      if (!anchor) return [];
      const node = (source === 'design' ? designById : appById).get(anchor.id);
      return node ? [{ source: node.source, rect: node.rect, clipped: node.clipped }] : [];
    });
  }, [measureAnchors, designById, appById]);

  /**
   * 读数口径的投影（2026-09-29 加）：切到「设计稿对齐 App」时非空，间距读数据此换成物理 px。
   *
   * ⚠️ 与面板**共用同一个入口**（`pixelProjectionOf` ← `appAlign`）：画布上的读数与面板里的读数
   * 是同一个元素的同一把尺子，各算一次迟早出现「画布说 24、面板说 23」。
   * 投影拿不到（老快照没有截图物理像素宽）时为 null → 读数保持帧内逻辑单位，
   * 面板那边另有一行说明讲原因（这里不重复造提示）。
   */
  const measureBasisProjection = useMemo(
    () => (alignBasis === 'pixel' ? pixelProjectionOf(appAlign) : null),
    [alignBasis, appAlign],
  );

  /**
   * 每侧各自计算选中项 ↔ 锚点 / hover 的间距；两侧读数并存，便于直接对比。
   *
   * 几何在 `lib/measure`（纯函数，只认两个矩形），这里只负责「该不该量」：
   *
   *  - **两侧都要有**：只 hover 不选中时满屏都是读数，画布会被糊死；而「我已经选中了这个、
   *    现在看它和那个的关系」是一个明确的提问动作（见 lib/measure 顶部）。
   *  - **锚点优先于 hover**：⌘ 点出来的那一对是「固定住」的，光标划过别的元素
   *    **不顶掉它**（否则固定就没意义了）。取消靠 ⌘ 再点一次锚点 / 点空白 / Esc。
   *  - ⚠️ **必须同帧**。线段坐标是帧内逻辑坐标，跨帧没有共同的坐标空间 ——
   *    设计稿选中的元素与 App 侧 hover 的元素之间量出来的数字是**没有意义**的，
   *    画出来还会让人以为「这两侧差这么多」。
   *  - 读数按来源分别计算；设计稿侧交互不会覆盖 App 侧的读数，反之亦然。
   *  - 两条轴都重叠且互不包含（交叉、或就是同一个节点）时 `measureBetween` 返回空数组，
   *    这里顺手收成 null —— 下游少一个空数组分支。
   *
   * 设计稿与截图**走的是同一条通道**：两个 frame 各自 NodeCanvas → 同一个 `hovered` →
   * 这里算完交给屏幕空间层。所以「选中一个再看另一个差多少」在两侧的行为天然一致，
   * 不需要分侧实现。（唯一差别在叠图模式：截图帧整块不参与点选，见 verify.css 末尾 ——
   * 那是「同一块画布不能按位置分裂出两种点击含义」这条既有契约，与读数无关。）
   *
   * ⚠️ **读数口径切到「设计稿对齐 App」时读数换成截图物理像素**（2026-09-29 加；
   * 2026-09-30 收紧口径）：几何仍出帧内逻辑坐标（线必须画在元素边上），只把 `value`
   * 换成物理 px。换算在 `lib/pixelProjection#measureLinesInPixels` —— 它**先按宿主档位投影
   * 两侧矩形、再跑同一份 `measureBetween`**，与面板那份是**同一个**实现。
   * 所以这里传的是那**一对矩形**而不是逻辑读数线：几何由它内部那份逻辑结果给出，
   * 免得「外面量一次、里面再量一次」出现两条不同的几何。
   * `unit: 'px'` 一起带上，画在数字旁边。
   */
  const rasterMeasures = useMemo<RasterMeasure[]>(() => {
    return rasterSelections.flatMap((selection) => {
      const anchor = rasterAnchors.find((item) => item.source === selection.source);
      const other = anchor ?? (rasterHover?.source === selection.source ? rasterHover : null);
      if (!other) return [];
      const lines = measureBasisProjection
        ? measureLinesInPixels(selection.source, selection.rect, other.rect, measureBasisProjection)
        : measureBetween(selection.rect, other.rect);
      if (lines.length === 0) return [];
      return [{
        source: selection.source,
        lines,
        unit: measureBasisProjection ? 'px' : undefined,
      }];
    });
  }, [rasterAnchors, rasterHover, rasterSelections, measureBasisProjection]);

  /**
   * 「本节点 ↔ 对侧哪些节点」的邻接表（key 用 canonicalId，即 `design:xxx` / `app:xxx`）。
   *
   * 两个来源都要读，且**都要**：
   *  - `mapping.matches` 是人工确认 / 忽略后落盘的（用户意志，必须优先可见）；
   *  - `result.matches` 是最近一次跑出来的（机器结论，还没人工过一遍）。
   * 只读其中一个会出现「刚点过确认，对侧框却没了」这种自相矛盾的现象 ——
   * 因为确认写的 mapping，而渲染读的 result。
   *
   * 重复项（同一对在两处都出现）交给下游 Set 去重，这里不做判断：
   * 邻接表只回答「谁和谁有对应关系」，判断「哪份更权威」是匹配引擎的事。
   */
  const peerIndex = useMemo(() => {
    const index = new Map<string, string[]>();
    const link = (from: string, to: readonly string[]): void => {
      const list = index.get(from);
      if (list) list.push(...to);
      else index.set(from, [...to]);
    };
    const add = (match: NodeMatch): void => {
      for (const designId of match.designNodeIds) link(designId, match.appNodeIds);
      for (const appId of match.appNodeIds) link(appId, match.designNodeIds);
    };

    for (const match of result?.matches ?? []) add(match);
    for (const match of mapping?.matches ?? []) add(match);
    return index;
  }, [mapping, result]);

  /**
   * 对侧同配对节点（选中设计稿 → 给 App 侧那一个，反之亦然）。
   *
   * 这是验收动作的核心辅助：同一个元素在两侧是否一致，靠肉眼在**两块画布**之间
   * 来回找是很容易找错行的 —— 尤其列表类页面。把对侧对应节点同时框出来，
   * 「对比」这件事才从「找 + 比」降成「只看」。
   *
   * 只画**直接对应**的一对，不递归展开子节点：父子关系在两侧本来就不同构
   * （设计稿有 GROUP / INSTANCE，App 侧是扁平 View），递归展开出来的框反而会互相覆盖。
   */
  const rasterPeers = useMemo<RasterSelection[]>(() => {
    // 匹配高亮已经把这条匹配两侧的**全部**节点画出来了，它是对侧框的超集。
    // 此时再叠一层「由选中项推导的对侧框」，同一批节点上会同时出现紫色点线与
    // 匹配实线两条描边，用户分不出哪条在说什么 —— 而两条说的是同一件事。
    if (focusedMatch) return [];
    if (!selected || !selectedNodeId) return [];
    const targets = peerIndex.get(toCanonicalId(selected.source, selectedNodeId));
    if (!targets || targets.length === 0) return [];

    const opposite: VerifySource = selected.source === 'design' ? 'app' : 'design';
    const byId = opposite === 'design' ? designById : appById;
    const seen = new Set<string>();
    const out: RasterSelection[] = [];

    for (const canonical of targets) {
      const parsed = fromCanonicalId(canonical);
      // 邻接表两侧都建了索引，所以要挡掉与选中项同一侧的那些（去一一半）
      if (!parsed || parsed.source !== opposite || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      const node = byId.get(parsed.id);
      if (node) out.push({ source: node.source, rect: node.rect, clipped: node.clipped });
    }
    return out;
  }, [appById, designById, focusedMatch, peerIndex, selected, selectedNodeId]);

  /** 图层列表的选中态：**两侧各一个 id**（列表按行所属来源取用，两侧互不顶掉）。
   *  ⚠️ 与 `focus` 分开：这个是「哪些行高亮」，那个是「该显示哪一侧 / 滚到哪一行」。 */
  const layerSelections = useMemo<LayerSelectionMap>(
    () => ({ design: slotIdOf(selection, 'design'), app: slotIdOf(selection, 'app') }),
    [selection],
  );

  /**
   * 图层列表的聚焦目标：**主动侧**那一个。
   *
   * 列表据此切 tab、展开折叠的祖先、把行滚进视野。挂在「两侧」上是没意义的
   * —— 两个节点分属两棵树，视口一次只显示一棵。
   */
  const layerFocus = useMemo<LayerSelection | null>(
    () => (selected && selectedNodeId ? { source: selected.source, id: selectedNodeId } : null),
    [selected, selectedNodeId],
  );

  /**
   * 图层列表点击 = 选中 + 聚焦。
   *
   * 刻意与画布内点击分开：画布上点的节点本来就在眼前，再「聚焦」一次会让视口
   * 无谓地跳一下（还会清掉用户刚拖好的位置）；而列表里的节点在纸上只是一个名字，
   * 不给视口动作就等于「点了没反应」。两种意图，两条路径。
   */
  const handleFocus = useCallback(
    (node: RenderNode): void => {
      // 标注模式下从图层列表点一个节点，含义同样是「加进待配对组」——
      // 列表是标注时**唯一能点到被后代盖住的容器 / 零尺寸节点**的入口，
      // 让它走另一套（选中 + 聚焦）会让「画布上点的」与「列表里点的」结果不一样。
      if (annotating) {
        setPending((current) => togglePending(current, toCanonicalId(node.source, node.id)));
        setSideTab('calibrate');
        return;
      }
      // 与画布点击同一套规则：点到匹配组之外就收掉高亮（理由见 dropFocusIfOutside）
      dropFocusIfOutside(node.source, node.id);
      handleSelect(node);
      viewportRef.current?.focusRect({ source: node.source, rect: node.rect });
      setSideTab('node');
    },
    [annotating, dropFocusIfOutside, handleSelect],
  );

  return (
    <div className="canvas-board">
      <section className="canvas-area">
        <VerifyToolbar
          zoom={zoom}
          onZoomChange={setZoom}
          activeTool={activeTool}
          onActiveToolChange={handleActiveToolChange}
          compare={compare}
          onCompareChange={setCompare}
          overlayOpacity={overlayOpacity}
          onOverlayOpacityChange={handleOverlayOpacityChange}
          wipeRatio={wipeRatio}
          onWipeRatioChange={handleWipeRatioChange}
          overlayOffset={overlayOffset}
          onOverlayOffsetReset={() => setOverlayOffset(DEFAULT_OVERLAY_OFFSET)}
          overlayEnabled={overlayEnabled}
        />

        {/*
          画布区：图层**悬浮**在画布之上，而不是并排占一格。
          `.canvas-stack` 只提供定位上下文（它是工具条下面那一层，所以悬浮层不会盖住
          工具条左边的按钮）。图层脱离 flex 流之后，展开 / 收起都不再改变画布宽度 ——
          画布不会跟着抖，缩放锚点与居中算法也不用再去扣「左侧被占了多少」。
        */}
        <div className={`canvas-stack${annotationActive ? ' annotation-mode' : ''}`}>
          <LayersPanel
            scope={scope}
            designNodes={canvasDesignNodes}
            appNodes={canvasAppNodes}
            selections={layerSelections}
            focus={layerFocus}
            onPick={handleFocus}
          />

          {/*
            标注操作条：**悬浮在画布底部**，而不是塞进右栏。
            标注是一个「左手点画布、右手确认」的连续动作，操作条离指针越近越好 ——
            放进右栏的话，每标一组都要横跨半个屏幕去点按钮，几十组下来就是纯粹的疲劳。
            它只在标注模式下出现：常驻会让人以为画布上一直有个没关掉的东西。
          */}
          {annotating && (
            <div className="calib-bar">
              <div className="calib-bar-counts">
                <span className={`calib-chip design${pendingStat.design > 0 ? ' on' : ''}`}>
                  设计 {pendingStat.design}
                </span>
                <span className={`calib-chip app${pendingStat.app > 0 ? ' on' : ''}`}>
                  App {pendingStat.app}
                </span>
                {pendingDuplicates > 0 && (
                  <span className="calib-chip warn" title="这些节点已经属于另一条标注">
                    已在别处 {pendingDuplicates}
                  </span>
                )}
              </div>

              <div className="calib-bar-actions">
                <button
                  type="button"
                  className="calib-btn primary"
                  disabled={pendingBlocker !== null}
                  title={pendingBlocker ?? '把这几个节点标成同一个元素（Enter）'}
                  onClick={() => commitPending('matched')}
                >
                  配对
                </button>
                <button
                  type="button"
                  className="calib-btn"
                  disabled={pendingStat.design + pendingStat.app === 0}
                  title="这几个节点在另一侧不该存在（漏实现 / 多出来）"
                  onClick={() => commitPending('no-counterpart')}
                >
                  另一侧不存在
                </button>
                <button
                  type="button"
                  className="calib-btn"
                  disabled={pendingStat.design + pendingStat.app === 0}
                  title="这几个节点不参与验收（动态文案 / 骨架屏 / 调试浮层）"
                  onClick={() => commitPending('ignore')}
                >
                  忽略
                </button>
                <button
                  type="button"
                  className="calib-btn ghost"
                  disabled={pending.length === 0}
                  title="清空待配对组（Esc）"
                  onClick={handleClearPending}
                >
                  清空
                </button>
              </div>

              {/* 待配对组的明细：按两列分组显示节点名。
                  为什么不用一行逗号串起来：标注时最容易犯的错是「少点了对侧那一个」，
                  两列并排能让「设计 2 / App 0」这种失衡一眼看出来，而一串名字看不出来。 */}
              {pending.length > 0 && (
                <div className="calib-bar-list">
                  <div className="calib-bar-col">
                    <span className="calib-bar-col-title">设计稿</span>
                    {pendingPreview.design.length === 0 ? (
                      <span className="calib-bar-empty">未选</span>
                    ) : (
                      pendingPreview.design.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className="calib-chip removable"
                          title="移出待配对组"
                          onClick={() => handleTogglePending(id)}
                        >
                          {nodeLabel(id)} ×
                        </button>
                      ))
                    )}
                  </div>
                  <div className="calib-bar-col">
                    <span className="calib-bar-col-title">App</span>
                    {pendingPreview.app.length === 0 ? (
                      <span className="calib-bar-empty">未选</span>
                    ) : (
                      pendingPreview.app.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className="calib-chip removable"
                          title="移出待配对组"
                          onClick={() => handleTogglePending(id)}
                        >
                          {nodeLabel(id)} ×
                        </button>
                      ))
                    )}
                  </div>
                  {pendingBlocker && <span className="calib-bar-hint">{pendingBlocker}</span>}
                  {/* 叠图模式下截图帧整块 `pointer-events: none`（见 verify.css 末尾），
                      所以 App 节点点不到。这**不是 bug 而是刻意的契约**（否则同一块画布
                      会按位置分裂出两种点击含义）。但标注恰恰需要两侧都点得到 ——
                      不说这一句，用户只会觉得「App 侧标不上，坏了」。 */}
                  {overlayOn && (
                    <span className="calib-bar-hint">
                      叠图模式下截图侧不参与点选，要标 App 节点请切回「全页验收」
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {(annotationActive || annotations.length > 0 || colorSample) && (
            <div className="annotation-tray" role="status">
              <div className="annotation-tray-main">
                <span className="annotation-tray-mark" aria-hidden="true">
                  {activeTool === 'picker' ? '◆' : activeTool === 'arrow' ? '↗' : '▭'}
                </span>
                <div className="annotation-tray-copy">
                  <strong>{annotationToolLabel}</strong>
                  <span>
                    {activeTool === 'picker'
                      ? '点击设计稿或截图读取像素颜色'
                      : activeTool === 'rect'
                        ? '拖拽创建矩形，可连续标注'
                        : activeTool === 'arrow'
                          ? '拖拽创建箭头，可连续标注'
                          : `${annotations.length} 个画布标注`}
                  </span>
                </div>
                {colorSample && (
                  <span className="annotation-color-chip" title={`${colorSample.color} · ${colorSample.source === 'design' ? '设计稿' : '截图'}`}>
                    <i style={{ background: colorSample.color }} />
                    <code>{colorSample.color}</code>
                  </span>
                )}
              </div>
              <div className="annotation-tray-actions">
                <span className="annotation-count">{annotations.length} 个标注</span>
                <button
                  type="button"
                  className="annotation-tray-btn"
                  disabled={annotations.length === 0}
                  onClick={handleUndoAnnotation}
                  title="撤销最后一个标注"
                >
                  撤销
                </button>
                <button
                  type="button"
                  className="annotation-tray-btn"
                  disabled={annotations.length === 0 && !colorSample}
                  onClick={handleClearAnnotations}
                >
                  清空
                </button>
                {annotationActive && (
                  <button
                    type="button"
                    className="annotation-tray-btn primary"
                    onClick={() => handleActiveToolChange('full')}
                  >
                    完成
                  </button>
                )}
              </div>
            </div>
          )}

          <CanvasViewport
            ref={viewportRef}
            zoom={zoom}
            onZoomChange={setZoom}
            initialView={initialView}
            onViewChange={handleViewChange}
            frames={rasterFrames}
            selections={rasterSelections}
            hover={rasterHover}
            anchors={rasterAnchors}
            peers={rasterPeers}
            matchHighlight={rasterMatch}
            pendingHighlight={rasterPending}
            regions={rasterRegions}
            samaBands={rasterSamaBands}
            samaIssues={rasterSamaIssues}
            cleanMerged={rasterCleanMerged}
            measures={rasterMeasures}
            annotationTool={annotationActive ? (activeTool as AnnotationTool) : null}
            annotations={annotations}
            onCreateAnnotation={handleCreateAnnotation}
            onPickColor={handlePickColor}
            overlay={
              overlayOn
                ? {
                    compare,
                    opacity: overlayOpacity,
                    wipeRatio,
                    onWipeRatioChange: handleWipeRatioChange,
                    offset: overlayOffset,
                    onOffsetChange: setOverlayOffset,
                  }
                : null
            }
          >
            {/* 设计稿帧。⚠️ `selectedId` 取的是**本帧的槽**，不是「主动侧」：
                两侧各有一个选中框，点 App 侧不该把设计稿那一个的选中态抹掉
                （用户报的正是这个）。`onClearSelection` 同理 —— 点本帧空白
                只清本侧的选中。 */}
            <NodeCanvas
              source="design"
              width={pair.design.width}
              height={pair.design.height}
              hasImage={Boolean(pair.design.imageUrl)}
              imageLabel={pair.design.imageLabel}
              nodes={canvasDesignNodes}
              selectedId={slotIdOf(selection, 'design')}
              hoveredId={hovered?.source === 'design' ? hovered.id : null}
              onSelect={handleCanvasPick}
              onHover={handleHover}
              onClearSelection={() => clearSide('design')}
            />
            <NodeCanvas
              source="app"
              width={pair.app.width}
              height={pair.app.height}
              alignScale={appAlignScale}
              hasImage={Boolean(pair.app.imageUrl)}
              imageLabel={pair.app.imageLabel}
              nodes={canvasAppNodes}
              selectedId={slotIdOf(selection, 'app')}
              hoveredId={hovered?.source === 'app' ? hovered.id : null}
              onSelect={handleCanvasPick}
              onHover={handleHover}
              onClearSelection={() => clearSide('app')}
            />
          </CanvasViewport>

        </div>

        {/*
          键位提示条：**常驻在画布底下**，是「⌘ 能干什么」的唯一书面入口。
          文案在 `lib/shortcuts.ts`（与右栏那条手势提示同一份来源）——
          组件只负责排版，改键位不用动这里。

          挂在 `.canvas-area` 里而不是浮在画布上：画布区的职责是让像素被看清，
          浮层都在吃它的面积；这条提示没有时效性，占固定高度更划算。
          标注态下整条会换成另一套键位（那一击的含义完全不同），见 `hintsFor`。
        */}
        <CanvasHintBar mode={annotating ? 'annotate' : 'browse'} />
      </section>

      {/*
        右栏：**一个外壳 + 两个 tab**，而不是并排两块面板。
        外壳（宽 / 边框 / 头部）属于「栏」，不属于某个 tab —— 这里统一持有，
        NodeInfoPanel 与 AcceptancePanel 都只画内容区。

        tab 上的小圆点：验收**跑过之后**才出现，颜色即结论（红=不通过 / 橙=待复核 /
        绿=通过）。用户切回「节点信息」看字段时，仍需要一眼知道「这页还有几条没过」，
        否则只能靠记忆 —— 而记忆在多页面比对里是最先失效的东西。
      */}
      <aside className={`info-panel${sideTab === 'node' && comparison && !spacingActive ? ' compare-mode' : ''}`}>
        <div className="info-header">
          <div className="panel-tabs">
            <button
              type="button"
              className={`panel-tab${sideTab === 'node' ? ' active' : ''}`}
              onClick={() => setSideTab('node')}
            >
              节点信息
              {comparison && !spacingActive ? (
                <>
                  <span className="src-tag design">设计稿</span>
                  <span className="src-tag app">App</span>
                </>
              ) : selected && (
                <span className={`src-tag ${selected.source}`}>
                  {selected.source === 'design' ? '设计稿' : 'App'}
                </span>
              )}
            </button>
            <button
              type="button"
              className={`panel-tab${sideTab === 'acceptance' ? ' active' : ''}`}
              onClick={() => setSideTab('acceptance')}
            >
              验收结果
              {result && (
                <span className={`tab-dot ${result.verdict}`}>
                  {result.verdict === 'pass'
                    ? '✓'
                    : result.issues.length > 0
                      ? String(result.issues.length)
                      : result.verdict === 'review'
                        ? '?'
                        : '!'}
                </span>
              )}
            </button>
            <button
              type="button"
              className={`panel-tab${sideTab === 'calibrate' ? ' active' : ''}`}
              onClick={() => setSideTab('calibrate')}
            >
              标注
              {annotationDigest.total > 0 && (
                <span className="tab-dot calibrate">{annotationDigest.total}</span>
              )}
            </button>
          </div>
          {sideTab === 'node' && selected && (
            /* 清的是**主动侧**（面板正在显示的那一侧）——两侧独立之后，「全部清掉」
               没有对应的用户动作了：想清哪一侧就在哪一侧点空白 */
            <button
              className="info-close"
              onClick={handleClearSelection}
              title="清除这一侧的选中"
            >
              ×
            </button>
          )}
        </div>

        {sideTab === 'acceptance' ? (
          <AcceptancePanel
            result={result}
            pairId={pair.meta.id}
            requirementId={pair.meta.requirementId}
            runId={run?.id ?? null}
            readiness={readiness}
            runError={runError}
            busy={runBusy}
            useAi={useAi}
            stale={resultStale}
            nodeLabel={nodeLabel}
            activeMatchKey={activeMatchKey}
            activeRegionMatchId={focusedRegionMatchId}
            onSamaReport={setSamaReport}
            samaFocusedIssue={samaFocusedIssue}
            onFocusSamaIssue={focusSamaIssue}
            clean={cleanIn}
            onCleanData={setCleanData}
            onFocusCleanMerged={focusCleanMerged}
            onToggleCleanTier={toggleCleanTier}
            onCleanKindFilter={setCleanKindFilter}
            onUseAiChange={setUseAi}
            onRun={handleRun}
            onLoadRun={setRun}
            onFocusMatch={handleFocusMatch}
            onFocusRegion={handleFocusRegion}
            onConfirmRegion={handleConfirmRegion}
            onCorrectRegion={handleCorrectRegion}
            onIgnoreRegion={handleIgnoreRegion}
            onConfirmMatch={handleConfirmMatch}
            onIgnoreMatch={handleIgnoreMatch}
          />
        ) : sideTab === 'calibrate' ? (
          <CalibrationPanel
            annotating={annotating}
            pairs={groundTruth?.pairs ?? []}
            digest={annotationDigest}
            pending={pending}
            busy={gtBusy}
            error={gtError}
            exported={gtExported}
            hasEngineResult={(result?.matches.length ?? mapping?.matches.length ?? 0) > 0}
            nodeLabel={nodeLabel}
            onAnnotatingChange={setAnnotating}
            onTogglePending={handleTogglePending}
            onClearPending={handleClearPending}
            onCommit={commitPending}
            onDeletePair={handleDeletePair}
            onFocusPair={handleFocusAnnotation}
            onSetNote={handleSetNote}
            onPrefill={handlePrefillFromEngine}
            onExport={handleExportGroundTruth}
          />
        ) : null}

        {/* 常驻挂载以保留快速记录问题表单状态；记录入口作为右栏最后一个 flex 子项，
            在节点信息、验收结果与标注 tab 下都固定在底部。 */}
        <NodeInfoPanel
          visible={sideTab === 'node'}
          selected={mergedSelected ?? selected}
          comparison={spacingActive ? null : comparison}
          // 对比表与单侧视图里的 App 侧长度读数都要换算进设计稿基准 —— **必须与画布的对齐缩放
          // 同源**（同一个 `widthAlignScale(design.width, app.width)`），否则「画布看起来对齐、
          // 面板说不同」。传整个上下文（还带两侧宽度与像素比）而不只是比值，是为了让面板能
          // 写出「8.67 = 26 / 3」这一层来历，见 `NodeInfoPanelProps.appAlign`。
          appAlign={appAlign}
          // 读数口径（2026-09-29）：面板长度读数与**画布间距读数**都跟着换尺子 —— 不参与画布的
          // 空间对齐（那一条服务「两张图叠起来对不对得上」，是另一回事）。对比表的**显示值**
          // 也换成 px，但**判定仍是设计单位**（那张表回答的仍是「一样宽吗」，见 `AlignBasis`）。
          alignBasis={alignBasis}
          onAlignBasisChange={setAlignBasis}
          spacingActive={spacingActive}
          requirementId={pair.meta.requirementId}
          pairId={pair.meta.id}
          designNodeId={selectedDesignNode?.id ?? null}
          appNodeId={selectedAppNode?.nodeId ?? null}
          onIssueSaved={onIssuesChanged}
          onCaptureCanvas={() => viewportRef.current?.capture() ?? Promise.reject(new Error('画布尚未就绪'))}
          // 重合组：`stackView` 只在**真的有两层以上**时非空（见上面那个 useMemo），
          // 绝大多数节点传进来的是 null，面板整块不画。注意 `selected` 换成的是
          // **聚合视图节点**，而上面的 `designNodeId` / `appNodeId` 仍然是真实节点 ——
          // 「记录问题」必须记到真节点上，聚合视图只是给人看的。
          stack={stackView}
          onPickStackLayer={pickStackLayer}
        />
      </aside>
    </div>
  );
};

export default CanvasBoard;
