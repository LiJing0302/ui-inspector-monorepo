import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toRenderNode, widthAlignScale, type RenderNode, type VerifySource } from '@shared/verify';
import {
  fromCanonicalId,
  toCanonicalId,
  type AcceptanceReadiness,
  type AcceptanceRunMeta,
  type NodeMapping,
  type NodeMatch,
} from '@shared/aiAcceptance';
import type { VerifyPairView } from '@shared/ipc';

import AcceptancePanel from './AcceptancePanel';
import CanvasViewport, { type CanvasViewportHandle } from './CanvasViewport';
import type { RasterFrameSource, RasterSelection } from './FrameRaster';
import LayersPanel, { type LayerSelection } from './LayersPanel';
import NodeCanvas from './NodeCanvas';
import NodeInfoPanel, { type SelectedNode } from './NodeInfoPanel';
import VerifyToolbar from './VerifyToolbar';
import {
  canOverlay,
  clampOverlayOpacity,
  clampWipeRatio,
  DEFAULT_OVERLAY_OPACITY,
  DEFAULT_WIPE_RATIO,
  type OverlayCompare,
  type VerifyMode,
} from '../lib/compare';
import {
  ancestorChain,
  descendInto,
  parentContextOf,
  planCanvasClick,
  planCanvasHover,
  type ClickCycle,
  type PickPoint,
} from '../lib/selection';

interface HoverTarget {
  source: VerifySource;
  id: string;
}

/** 光标下的一次原始命中 + 判定 hover 所必需的上下文（落点、修饰键） */
interface HoverHit {
  node: RenderNode;
  point: PickPoint;
  outermost: boolean;
}

interface CanvasBoardProps {
  pair: VerifyPairView;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** 工具栏左侧文案，例如「页面名（2/5）」 */
  subtitle: string;
}

/**
 * 「画布验收」tab：图层列表 + 工具栏 + 双画布（DOM 节点层）+ 右侧节点信息。
 *
 * 选中规则是 **点哪选哪**（规则本体与依据见 lib/selection）：单击选中**命中本身**
 * （指针底下最深的那个），**在原地再点一次**上移一层，⌘/Ctrl 单击跳到整帧，Esc 上一层。
 *
 * ⚠️ **hover 走的是同一个判定**：环 = 「下一击会选中的那个」，不是「光标底下那个」。
 * 被子树盖住的那部分永远命中最深的后代（父盒在子盒下面），所以只按原始命中画环，
 * 就会出现「点得到的层级 ≠ hover 得到的层级」—— 用户报的
 * 「13531 / 13533 / 13532 无法通过 hover 选中」正是这个。原地再点上移一层之后，
 * `applySelection` 会用同一个落点立刻重算一次环，让它跟着上移。
 * （另：2026-09-16 起无填充的容器**本身也参与命中**了，所以点不到父级只剩「被后代
 * 盖住」这一种情形 —— 详见 `RenderNode.hittable`。）
 *
 * 上一版是 Figma 的「当前上下文层」模型（单击选上下文层的最外层）—— 它让单击**永远**
 * 落在帧根上，用户两次报「hover 和点击都选不中内部节点」。差别在场景：Figma 是设计
 * 工具（操作对象多为容器），这里是验收工具（指着哪个就看哪个）。
 *
 * 「当前上下文层」（面包屑里高亮的那一格）**不存**，它是 `parentContextOf(选中项)`
 * 算出来的 —— 存两份状态迟早会自相矛盾，见 lib/selection 顶部。
 *
 * 切换左侧配对时**必须由父级用 `key` 重建本组件**（父级以 pair id 作 key）：
 * 否则 `selected` 会停留在上一页的节点上，右侧面板显示的是别的页面的节点；
 * 顺带也让画布回到居中，而不是沿用上一页的平移量。
 */
const CanvasBoard: React.FC<CanvasBoardProps> = ({ pair, zoom, onZoomChange, subtitle }) => {
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  const viewportRef = useRef<CanvasViewportHandle>(null);

  /**
   * 右栏两个 tab：节点信息 / 验收结果。
   *
   * 放在同一个栏里而不是再开一列：这两个面板是**互斥的视野**（要么在端详某个节点，
   * 要么在看待办清单），并排只会让画布更窄，而画布宽度正是这个工具最缺的资源。
   */
  const [sideTab, setSideTab] = useState<'node' | 'acceptance'>('node');
  const [useAi, setUseAi] = useState(false);
  const [run, setRun] = useState<AcceptanceRunMeta | null>(null);
  const [readiness, setReadiness] = useState<AcceptanceReadiness | null>(null);
  const [mapping, setMapping] = useState<NodeMapping | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  /**
   * 当前工具。工具按钮的选中态与画布布局必须来自**同一个状态**：
   * 放在 VerifyToolbar 里时，「叠图验收」只能点亮自己那一格，画布无从得知。
   */
  const [activeTool, setActiveTool] = useState<string>('full');
  /** 叠图子模式。与 activeTool 分开：它是正交的一层，切比对方式不该退出叠图 */
  const [compare, setCompare] = useState<OverlayCompare>('opacity');
  const [overlayOpacity, setOverlayOpacity] = useState<number>(DEFAULT_OVERLAY_OPACITY);
  const [wipeRatio, setWipeRatio] = useState<number>(DEFAULT_WIPE_RATIO);

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
  }, []);

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
   * 上一次画布点击留下的痕迹（命中 + 选中 + 落点）。它**不参与渲染**（没有任何 UI
   * 直接读它），所以进 ref 而不是 state —— 进 state 只会让每次点击多一轮重渲染。
   * 它是「原地再点 = 上移一层」的唯一判据。
   */
  const clickCycleRef = useRef<ClickCycle | null>(null);
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
   * 当前选中项的**即时镜像**（`selected` state 要到本轮 render 之后才更新）。
   *
   * hover 的解析（`planCanvasHover`）要回答「这一帧现在选中了谁」—— 落地选中的同一轮里
   * 若再收到一次 mousemove，读 state 就是旧值，会把「刚点过」判成「没点过」，环掉回子节点。
   * ref 与 state 同源，但立刻生效。
   */
  const selectedIdRef = useRef<{ source: VerifySource; id: string } | null>(null);

  const designNodes = useMemo<RenderNode[]>(
    () => pair.design.nodes.map((node) => toRenderNode(node, 'design' as const)),
    [pair],
  );
  const appNodes = useMemo<RenderNode[]>(
    () => pair.app.nodes.map((node) => toRenderNode(node, 'app' as const)),
    [pair],
  );

  /** 视图节点按 id 索引：祖先链、上下文推导、选中框、面包屑全靠它 O(1) 上下走 */
  const designById = useMemo(
    () => new Map(designNodes.map((node) => [node.id, node])),
    [designNodes],
  );
  const appById = useMemo(() => new Map(appNodes.map((node) => [node.id, node])), [appNodes]);

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

  // R4：以设计稿宽度为基准等比缩放截图。设计稿是基准，恒为 1。
  const appAlignScale = useMemo(
    () => widthAlignScale(pair.design.width, pair.app.width),
    [pair],
  );

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

  /** 选中节点在各自扁平表里的 id：设计稿用 `id`、截图用 `nodeId`。 */
  const selectedNodeId = selected
    ? selected.source === 'design'
      ? selected.node.id
      : selected.node.nodeId
    : null;

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
        prev: clickCycleRef.current,
        outermost: hit.outermost,
      });
      return at ? { source: hit.node.source, id: at } : null;
    },
    [appById, designById],
  );

  /** 光标移到了哪里：记下原始命中（落地选中时要拿它重算），再解析成「该高亮谁」 */
  const applyHover = useCallback(
    (hit: HoverHit | null): void => {
      lastHoverRef.current = hit;
      // 「这一帧当前选中了谁」取**即时镜像**（不读 state，理由见 selectedIdRef）
      const own = selectedIdRef.current;
      commitHover(resolveHover(hit, own && hit && own.source === hit.node.source ? own.id : null));
    },
    [commitHover, resolveHover],
  );

  /**
   * 落地一次「选中谁」。**所有改选中态的入口都走这里** —— 画布单击、图层列表、
   * 面包屑、Esc、Enter、⌘ 直选。
   *
   * 集中在一处是刻意的：选中项是**唯一**的状态，上下文只是它的函数
   * （`parentContextOf`）—— 于是「选中项 = 上下文的直接子节点」不存在对不上的可能，
   * 前提是没有人绕过这里去 `setSelected`。
   *
   * `cycle` 只有画布单击传得进来 —— 它是「原地再点」的判据；
   * 其余入口（列表 / 面包屑 / 键盘）都没点画布，必须传 null 清掉。
   */
  const applySelection = useCallback(
    (source: VerifySource, nodeId: string, cycle: ClickCycle | null): void => {
      clickCycleRef.current = cycle;
      const picked = selectById(source, nodeId);
      if (!picked) return;
      setSelected(picked);
      selectedIdRef.current = { source, id: nodeId };
      // 选中项 / 档位变了 → hover 的目标跟着变。拿**同一个落点**立刻重算一次，
      // 环才会停在「下一击会选中的那个」上（原地再点之后就是刚刚选中的父级）。
      // ⚠️ 只重算**同一帧**的：光标在另一侧时那次 hover 与这次选中无关，别误清掉。
      const hit = lastHoverRef.current;
      if (hit && hit.node.source === source) commitHover(resolveHover(hit, nodeId));
    },
    [commitHover, resolveHover, selectById],
  );

  /**
   * 画布内点击。选中谁不取命中结果，而是交给 `planCanvasClick`：命中的永远是**最深**
   * 那个（浏览器的结论），而规则还要看「是不是在原地又点了一次」。
   *
   * 一条点击同时能做三件事：普通单击（选命中本身）、原地再点（上移一层）、
   * ⌘/Ctrl 单击（跳到整帧）。三者都在纯函数里，这里只转发结果。
   */
  const handleCanvasPick = useCallback(
    (node: RenderNode, point: PickPoint, outermost: boolean): void => {
      const byId = node.source === 'design' ? designById : appById;
      const outcome = planCanvasClick({
        chain: ancestorChain(byId, node.id),
        // 只认**同一帧**的选中项：选中项在另一侧画布上时，本帧等于没选中，
        // 那一击自然谈不上「原地再点」。
        selectedId: selected && selected.source === node.source ? selectedNodeId : null,
        point,
        prev: clickCycleRef.current,
        outermost,
      });
      if (!outcome) return;
      applySelection(node.source, outcome.selectedId, outcome.cycle);
      // 在画布上主动点一个节点 = 「我要看这个」，右栏就该显示节点信息。
      // ⚠️ 只有**画布 / 图层列表**的直接点击会切 tab：从验收面板点问题项也会走
      //    handleSelect（→ applySelection），但那时用户正在**逐条过清单**，把 tab 抢过去
      //    会让他每看一条都要手动切回来。所以切换只加在「人主动定位」的两个入口上。
      setSideTab('node');
    },
    [appById, applySelection, designById, selected, selectedNodeId],
  );

  /**
   * 从**外部**指定选中谁：图层列表、层级面包屑、验收面板的问题项都走这里。
   *
   * 不做任何层级解析 —— 「选中谁就是谁」。上下文随之由 `parentContextOf` 算出来，
   * 所以「跳到某一层」这件事不需要单独一步。
   */
  const handleSelect = useCallback(
    (node: RenderNode): void => {
      applySelection(node.source, node.id, null);
    },
    [applySelection],
  );

  const handleClearSelection = useCallback((): void => {
    clickCycleRef.current = null;
    hoverKeyRef.current = null;
    lastHoverRef.current = null;
    selectedIdRef.current = null;
    setHovered(null);
    setSelected(null);
  }, []);

  /**
   * 光标移动：只上报**原始命中**；「该高亮谁」由 `applyHover` 按与单击相同的规则推出来。
   * 落点与 ⌘/Ctrl 必须一起带过来 —— 缺一个，hover 与单击就会各自算出不同答案。
   */
  const handleHover = useCallback(
    (node: RenderNode | null, point?: PickPoint, outermost?: boolean): void => {
      applyHover(node && point ? { node, point, outermost: outermost === true } : null);
    },
    [applyHover],
  );

  /**
   * 「当前上下文层」= 选中项在它所在帧里的**父级**。**算出来的，不存** ——
   * 见 lib/selection 顶部：存两份状态迟早会互相矛盾。
   */
  const selectedContextId = useMemo<string | null>(() => {
    if (!selected || !selectedNodeId) return null;
    const byId = selected.source === 'design' ? designById : appById;
    return parentContextOf(byId, selectedNodeId);
  }, [appById, designById, selected, selectedNodeId]);

  /**
   * 进画布就拉一次门禁与历史映射。
   *
   * 先拉门禁而不是等「运行验收」再说：用户需要先知道「这页有没有资格被验收」
   * （SDK 节点是否上传过、有没有被截断）。等点下去才报缺数据，等于白等一次等待。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextReadiness, nextMapping] = await Promise.all([
          window.api.verify.getAcceptanceReadiness(pair.meta.id),
          window.api.verify.getNodeMapping(pair.meta.id),
        ]);
        if (cancelled) return;
        setReadiness(nextReadiness);
        setMapping(nextMapping);
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
   * 点问题 / 待确认匹配时把两侧节点一起选中并聚焦。
   *
   * 优先选**设计稿**那侧：右侧信息面板对设计稿能展示 fills / text / layout 这些
   * 判断所需的字段；App 侧只有 class 名与矩形，先选它等于让人多点一下。
   * 只有 App 节点（多余节点）时才退回选 App 侧。
   */
  const handleFocusMatch = useCallback(
    (designIds: string[], appIds: string[]): void => {
      const firstOf = (ids: string[], source: VerifySource): string | null => {
        const byId = source === 'design' ? designById : appById;
        for (const canonical of ids) {
          const parsed = fromCanonicalId(canonical);
          if (parsed && parsed.source === source && byId.has(parsed.id)) return parsed.id;
        }
        return null;
      };

      const designId = firstOf(designIds, 'design');
      const appId = firstOf(appIds, 'app');
      const primaryId = designId ?? appId;
      if (!primaryId) return;

      const source: VerifySource = designId ? 'design' : 'app';
      const node = (source === 'design' ? designById : appById).get(primaryId);
      if (!node) return;

      handleSelect(node);
      viewportRef.current?.focusRect({ source: node.source, rect: node.rect });
    },
    [appById, designById, handleSelect],
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

  /**
   * 键盘：Esc 上一层、Enter 下一层。
   *
   * Esc 走的是**和「原地再点」同一条通道**（选中父级）—— 区别只是不用瞄准：
   * 一个在光标底下点两下，一个按一下键。到最外层容器之后再按一次 Esc 才清空选中。
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

      if (event.key === 'Enter') {
        // 候选顺序：按图层叠放顺序（导出数组即 back-to-front），取第一个真实存在的
        const children = (source === 'design' ? designNodes : appNodes)
          .filter((node) => node.parentId === selectedNodeId)
          .map((node) => node.id);
        const child = descendInto(byId, children);
        if (!child) return;
        event.preventDefault();
        applySelection(source, child, null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appById, appNodes, applySelection, designById, designNodes, handleClearSelection, selected, selectedNodeId]);

  /**
   * 传给屏幕空间层的选中框。这里只给**帧内逻辑矩形**，屏幕位置由 FrameRaster 换算 ——
   * `alignScale`（R4 按宽对齐）与帧的世界坐标都在那边，调用方再算一遍等于把同一套
   * 几何实现两遍，迟早分叉。
   */
  const rasterSelection = useMemo<RasterSelection | null>(() => {
    if (!selected || !selectedNodeId) return null;
    const node = (selected.source === 'design' ? designById : appById).get(selectedNodeId);
    return node ? { source: node.source, rect: node.rect, clipped: node.clipped } : null;
  }, [selected, selectedNodeId, designById, appById]);

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
  }, [appById, designById, peerIndex, selected, selectedNodeId]);

  /** 图层列表的选中态：列表只需要 id + 来源，不重复持有一份原始节点 */  const layerSelection = useMemo<LayerSelection | null>(() => {
    if (!selected || !selectedNodeId) return null;
    return { source: selected.source, id: selectedNodeId };
  }, [selected, selectedNodeId]);

  /**
   * 当前选中项的层级链（最外层 → 当前），给右侧信息面板画面包屑。
   * 命中不到节点（数据被删）时退化成空数组，面板侧不画这一组即可。
   */
  const selectionChain = useMemo<RenderNode[]>(() => {
    if (!selected || !selectedNodeId) return [];
    const byId = selected.source === 'design' ? designById : appById;
    return ancestorChain(byId, selectedNodeId)
      .flatMap((id) => {
        const node = byId.get(id);
        return node ? [node] : [];
      })
      .reverse();
  }, [appById, designById, selected, selectedNodeId]);

  /**
   * 图层列表点击 = 选中 + 聚焦。
   *
   * 刻意与画布内点击分开：画布上点的节点本来就在眼前，再「聚焦」一次会让视口
   * 无谓地跳一下（还会清掉用户刚拖好的位置）；而列表里的节点在纸上只是一个名字，
   * 不给视口动作就等于「点了没反应」。两种意图，两条路径。
   */
  const handleFocus = useCallback(
    (node: RenderNode): void => {
      handleSelect(node);
      viewportRef.current?.focusRect({ source: node.source, rect: node.rect });
      setSideTab('node');
    },
    [handleSelect],
  );

  return (
    <div className="canvas-board">
      <section className="canvas-area">
        <VerifyToolbar
          zoom={zoom}
          onZoomChange={onZoomChange}
          subtitle={subtitle}
          activeTool={activeTool}
          onActiveToolChange={handleActiveToolChange}
          compare={compare}
          onCompareChange={setCompare}
          overlayOpacity={overlayOpacity}
          onOverlayOpacityChange={handleOverlayOpacityChange}
          wipeRatio={wipeRatio}
          onWipeRatioChange={handleWipeRatioChange}
          overlayEnabled={overlayEnabled}
        />

        {/*
          画布区：图层**悬浮**在画布之上，而不是并排占一格。
          `.canvas-stack` 只提供定位上下文（它是工具条下面那一层，所以悬浮层不会盖住
          工具条左边的按钮）。图层脱离 flex 流之后，展开 / 收起都不再改变画布宽度 ——
          画布不会跟着抖，缩放锚点与居中算法也不用再去扣「左侧被占了多少」。
        */}
        <div className="canvas-stack">
          <LayersPanel
            designNodes={designNodes}
            appNodes={appNodes}
            selection={layerSelection}
            onPick={handleFocus}
          />

          <CanvasViewport
            ref={viewportRef}
            zoom={zoom}
            onZoomChange={onZoomChange}
            frames={rasterFrames}
            selection={rasterSelection}
            hover={rasterHover}
            peers={rasterPeers}
            overlay={
              overlayOn
                ? {
                    compare,
                    opacity: overlayOpacity,
                    wipeRatio,
                    onWipeRatioChange: handleWipeRatioChange,
                  }
                : null
            }
          >
            <NodeCanvas
              source="design"
              width={pair.design.width}
              height={pair.design.height}
              hasImage={Boolean(pair.design.imageUrl)}
              imageLabel={pair.design.imageLabel}
              nodes={designNodes}
              selectedId={selected?.source === 'design' ? selectedNodeId : null}
              hoveredId={hovered?.source === 'design' ? hovered.id : null}
              onSelect={handleCanvasPick}
              onHover={handleHover}
              onClearSelection={handleClearSelection}
            />
            <NodeCanvas
              source="app"
              width={pair.app.width}
              height={pair.app.height}
              alignScale={appAlignScale}
              hasImage={Boolean(pair.app.imageUrl)}
              imageLabel={pair.app.imageLabel}
              nodes={appNodes}
              selectedId={selected?.source === 'app' ? selectedNodeId : null}
              hoveredId={hovered?.source === 'app' ? hovered.id : null}
              onSelect={handleCanvasPick}
              onHover={handleHover}
              onClearSelection={handleClearSelection}
            />
          </CanvasViewport>
        </div>
      </section>

      {/*
        右栏：**一个外壳 + 两个 tab**，而不是并排两块面板。
        外壳（宽 / 边框 / 头部）属于「栏」，不属于某个 tab —— 这里统一持有，
        NodeInfoPanel 与 AcceptancePanel 都只画内容区。

        tab 上的小圆点：验收**跑过之后**才出现，颜色即结论（红=不通过 / 橙=待复核 /
        绿=通过）。用户切回「节点信息」看字段时，仍需要一眼知道「这页还有几条没过」，
        否则只能靠记忆 —— 而记忆在多页面比对里是最先失效的东西。
      */}
      <aside className="info-panel">
        <div className="info-header">
          <div className="panel-tabs">
            <button
              type="button"
              className={`panel-tab${sideTab === 'node' ? ' active' : ''}`}
              onClick={() => setSideTab('node')}
            >
              节点信息
              {selected && (
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
          </div>
          {sideTab === 'node' && selected && (
            <button className="info-close" onClick={handleClearSelection} title="清除选中">
              ×
            </button>
          )}
        </div>

        {sideTab === 'node' ? (
          <NodeInfoPanel
            selected={selected}
            chain={selectionChain}
            contextId={selectedContextId}
            onPickAncestor={handleSelect}
          />
        ) : (
          <AcceptancePanel
            result={result}
            readiness={readiness}
            runError={runError}
            busy={runBusy}
            useAi={useAi}
            stale={resultStale}
            onUseAiChange={setUseAi}
            onRun={handleRun}
            onFocusMatch={handleFocusMatch}
            onConfirmMatch={handleConfirmMatch}
            onIgnoreMatch={handleIgnoreMatch}
          />
        )}
      </aside>
    </div>
  );
};

export default CanvasBoard;
