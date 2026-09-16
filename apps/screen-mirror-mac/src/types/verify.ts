/**
 * 验收数据契约（主进程 ↔ 渲染层共享）。
 *
 * 两条数据来源在**存储层就归一化成同一形态**：扁平节点表 + `parentId`。
 *   - 设计稿侧：Figma 嵌套 `children` 树 → `flattenFigmaTree()` 拍平（补 `parentId`）
 *   - App 侧  ：端上 dump 本来就是扁平表（已有 `parentId`）
 * 画布只依赖 `RenderNode`，两侧原始 schema 的差异在 `toRenderNode()` 转换层消化完。
 *
 * AppNode 字段与端上递归 dump 出的原生节点结构严格对齐，不做简化。
 */

import type { FigmaNode, FigmaRect, FigmaText, FigmaLayout, FigmaPaint, FigmaEffect } from './figma';
import type { CollectionQuality } from './acceptance';

export type VerifySource = 'design' | 'app';
export type NodeKind = 'text' | 'image' | 'container';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------- App 侧：原生节点（与端上 dump 结构一致） ----------

export interface AppNode {
  nodeId: string;
  treePath?: string;
  parentId: string | null;
  className: string;
  depth: number;
  index: number;
  siblingCount?: number;

  x: number;
  y: number;
  width: number;
  height: number;

  /** 可见矩形：已被父级 clip 与滚动裁剪后的实际可见区域 */
  visibleX: number;
  visibleY: number;
  visibleWidth: number;
  visibleHeight: number;

  scrollX: number;
  scrollY: number;

  visible: boolean;
  enabled: boolean;
  clickable: boolean;

  alpha: number;
  z: number;
  elevation: number;
  clipsToBounds: boolean;

  isImage: boolean;
  isSvg: boolean;
  isGradient: boolean;
  hasVisualContent: boolean;

  resourceName: string | null;
  contentDescription: string | null;
  text: string | null;

  zeroSize?: boolean;
  hiddenByAncestor?: boolean;
  outsideVisibleRect?: boolean;
  clipped?: boolean;
  layoutOnly?: boolean;
  textRedacted?: boolean;
  /**
   * **透明盾牌**：不参与画布命中。由 `markAppHitShields()` 标注（主进程 loader 调用），
   * 判据与实测数据见那个函数。
   *
   * ⚠️ 缺失（老快照）时按 `false` 处理，即维持改动前的行为 —— 宁可多放行一个，
   * 也不要让已经存量的快照在新版本里突然点不动。
   */
  hitShield?: boolean;
  participation?: 'required' | 'optional' | 'context' | 'ignored' | 'unavailable';

  fontSize?: number;
  fontWeight?: string | number;
  color?: string;
}

// ---------- 设计稿侧：Figma 节点（扁平化后存盘） ----------

/**
 * Figma 节点扁平化后的形态。
 * 保留 FigmaNode 的全部字段（fills/text/layout/effects 供右侧信息面板展示），
 * 只是把 `children` 拆成扁平数组 + `parentId`。
 */
export type DesignNode = Omit<FigmaNode, 'children'> & {
  parentId: string | null;
  /** 扁平化后不再保留嵌套；层级关系由 parentId + depth 表达 */
  children?: never;
  /**
   * 直接子节点个数。**命中判定要用**（见 `designNodeHittable`）。
   *
   * 为什么拍平了还得留这一个数：扁平表里看不出「这个 Frame 是不是空壳」，而
   * 「填充被隐藏 + 空壳」恰恰是最危险的一类 —— 它看不见，又常常正好盖满父节点，
   * 一放行就成盾牌。「个人中心优化」里的「返回」是 12×12 的空 FRAME、隐藏填充、
   * 恰好盖满父级「跳转箭头」：FRAME 一律放行时，父级与同级的 VECTOR 命中面积
   * **双双归零**（可命中节点 51 → 50）；按「空壳不放行」则是 51 → 52 且零归零。
   *
   * ⚠️ 老导出没有这个字段（`undefined`）——按 0 处理，即维持改动前的行为。
   */
  childCount?: number;
};

/**
 * 把 Figma 嵌套树拍平成扁平数组（深度优先，**保持原数组顺序**）。
 *
 * 顺序很重要：Figma 的 children 是 back-to-front（0 = 最底层），
 * 拍平后同一父节点下的兄弟仍按原序排列，渲染时按序 append 即可复刻叠放，
 * **不要额外排序**。
 *
 * `rect` 原样保留（相对导出单元根节点），不做坐标换算。
 */
export function flattenFigmaTree(tree: FigmaNode): DesignNode[] {
  const out: DesignNode[] = [];

  const walk = (node: FigmaNode, parentId: string | null): void => {
    const { children, ...rest } = node;
    // childCount 是命中判定的输入（空壳 FRAME 不能参与），必须在这一步记下来 ——
    // 拍平之后就再没有第二个地方知道「它原来有没有孩子」。
    out.push({ ...rest, parentId, childCount: children?.length ?? 0 });
    // 保持原数组顺序，不要排序
    for (const child of children ?? []) walk(child, node.id);
  };

  walk(tree, null);
  return out;
}

/** 从扁平后的设计稿节点取出要展示的文本内容 */
export function designNodeText(node: DesignNode): string | null {
  return node.text?.characters ?? null;
}

/**
 * 设计稿节点的字体粗细。
 * ⚠️ Figma 导出**没有 fontWeight 数值字段**，粗细是 `text.fontStyle` 字符串（如 `"Medium"`）。
 */
export function designNodeFontStyle(node: DesignNode): string | null {
  const style = node.text?.fontStyle;
  return typeof style === 'string' && style.length > 0 ? style : null;
}

/** 设计稿节点是否裁剪子节点（对应 DOM 的 overflow: hidden） */
export function designClipsContent(node: DesignNode): boolean {
  return node.layout?.clipsContent === true;
}

/** App 节点是否裁剪子节点 */
export function appClipsContent(node: AppNode): boolean {
  return node.clipsToBounds === true;
}

/**
 * R4 分辨率对齐策略：**按宽对齐**。
 *
 * 设计稿与真机的逻辑尺寸往往不同（如设计 375×867 vs 截图 390×844），
 * 直接 1:1 并排时「同一个元素落不到同一个位置」——通栏按钮左边缘都在 x=24，
 * 但右边缘差 390−375=15pt，越靠右错位越大，人就无法判断某个偏移是 bug 还是
 * 分辨率差异。所以必须选一条基准边做等比缩放。
 *
 * 为什么选宽度而不是高度：移动端布局是**宽度驱动**的（屏幕宽=设备宽，
 * 横向栅格/边距都按宽度定），纵向由内容与机型差异（状态栏、安全区、灵动岛）
 * 决定，本来就不该期望严格对齐。
 *
 * 返回作用在**截图帧**上的等比缩放系数；设计稿帧恒为 1（它是基准）。
 * 按宽对齐后两帧等宽，纵向则让出残差：867 − 844×(375/390) ≈ 55pt 落在底部。
 *
 * 非法输入（0 / 负数 / NaN）一律回退 1，宁可不缩放也不要把画布算崩。
 */
export function widthAlignScale(designWidth: number, appWidth: number): number {
  if (!Number.isFinite(designWidth) || !Number.isFinite(appWidth)) return 1;
  if (designWidth <= 0 || appWidth <= 0) return 1;
  return designWidth / appWidth;
}

/** 文本指纹上限：匹配只需要大致重合度，没必要存全量 */
const TEXT_SAMPLE_LIMIT = 400;

/** 归一化单条文本：去空白、转小写、掐头去尾 */
function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 生成文本指纹，供页面匹配算 Jaccard 相似度用。
 *
 * 刻意在**导入/采集时**落盘而不是匹配时现算：
 * 匹配是 N×M 的两两比较，若每次都去读 schema/nodes 文件，代价会随页面数平方增长。
 */
export function normalizeTextSamples(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const text = normalizeText(value);
    if (text.length === 0) continue;
    seen.add(text);
    if (seen.size >= TEXT_SAMPLE_LIMIT) break;
  }
  return [...seen];
}

// ---------- 需求 / 资产 / 配对 / 问题（存储模型） ----------

export type DesignAssetSource = 'local-import' | 'plugin-upload';
export type AppSnapshotSource = 'uiautomator' | 'sdk' | 'manual';

/** 设计稿资产元数据（一帧 = 一页设计稿） */
export interface DesignAssetMeta {
  id: string;
  requirementId: string;
  /** Figma 帧 id；与 pageId 组合成唯一键（fileKey 为 null 不可依赖） */
  frameId: string;
  /** 唯一键：`pageId + frameId` */
  frameKey: string;
  name: string;
  /** 根节点类型；元素级导出时不是容器 */
  type: string;
  /** 页面级全路径，展示与匹配用 */
  path: string;
  pageId?: string;
  pageName?: string;

  /** 逻辑尺寸（设计稿 px） */
  width: number;
  height: number;
  /** 位图倍数：截图物理尺寸 = 逻辑尺寸 × exportScale */
  exportScale: number;

  /** 该节点对应的截图物理尺寸（仅用于调试/展示） */
  pixelWidth?: number;
  pixelHeight?: number;

  /** 是否帧级导出；只有帧级才作为整页设计稿参与匹配 */
  isFrameLevel: boolean;

  schemaFile: string;
  screenshotFile: string;
  thumbnailFile: string;
  nodeCount: number;

  /** 归一化后的文本指纹（TEXT 节点的 characters），供页面匹配算文本重合度 */
  textSamples: string[];

  source: DesignAssetSource;
  importedAt: string;
  /** 包名（manifest.fileName），便于溯源 */
  packageName?: string;
}

/** App 快照元数据（一次抓屏） */
export interface AppSnapshotMeta {
  id: string;
  requirementId: string;
  platform: 'ios' | 'android';
  device?: string;
  osVersion?: string;
  serial?: string;

  /**
   * 可读名称。采集时给个默认值（前台包名/机型），UI 同学可改成页面名。
   * 页面匹配的「名称相似度」维度依赖它 —— 名字不对，推荐排序就没意义。
   */
  label: string;

  /** 逻辑尺寸（dp / pt），与设计稿逻辑 px 同量纲 */
  width: number;
  height: number;
  /** 截图物理像素尺寸 */
  pixelWidth: number;
  pixelHeight: number;
  /** Android 的 densityDpi（如 420），换算用：logical = px × 160 / densityDpi */
  densityDpi?: number;

  nodesFile: string;
  screenshotFile: string;
  thumbnailFile: string;
  nodeCount: number;

  /** 归一化后的文本指纹，供页面匹配算文本重合度 */
  textSamples: string[];

  /**
   * 节点来源。`uiautomator` 表示字段有退化（没有 scrollX、visible 矩形、isImage 等），
   * UI 侧应据此提示「部分字段不可用」。
   */
  source: AppSnapshotSource;
  /** SDK capture id used to pair the node snapshot and screenshot. */
  captureId?: string;
  /** SDK collection quality; absent for legacy/manual snapshots. */
  collectionQuality?: CollectionQuality;
  /**
   * SDK 上报的窗口尺寸与截图实际尺寸不一致时的差值。
   *
   * 最常见的成因是**系统栏**：SDK 遍历的是 App 的 window（不含状态栏 / 导航栏），
   * 而 `screencap -p` 抓的是整个 display，于是两者天然差一条状态栏的高度 ——
   * 这属于**可校准的平移**，所以不阻断验收（PLAN 也要求保留「系统安全区 / 页面平移」）。
   *
   * 但差值多少决定了几何结论还值不值得信，因此它必须**留下痕迹**：
   * 验收裁决据此降级为「待复核」，而不是不声不响地拿整屏去比。
   * 缺省 = 两侧尺寸一致（老快照没有这个字段，同样按「一致」处理）。
   */
  coordinateInset?: {
    sdkWidth: number;
    sdkHeight: number;
    screenshotWidth: number;
    screenshotHeight: number;
  };
  capturedAt: string;
  /** 采集时的前台包名，用于核对采的是不是目标 App */
  foregroundPackage?: string;
}

/**
 * 「配对进行中」的草稿。
 *
 * 用户点「新建配对」后进入草稿态，在素材卡片上分别点选两侧；
 * **两侧都选定才落库**（`verify:pair-save`）—— 系统只做推荐排序，不自动建配对。
 * 纯前端状态，不持久化。
 */
export interface PairDraft {
  designAssetId?: string;
  appSnapshotId?: string;
}

export type PairStatus = 'pending' | 'verified';

/** 配对（验收的基本单元） */
export interface MatchPairMeta {
  id: string;
  requirementId: string;
  designAssetId: string;
  appSnapshotId: string;
  /** 系统推荐分（仅排序用，不自动建配对） */
  matchScore?: number;
  status: PairStatus;
  createdAt: string;
}

export type IssueCategory = 'layout' | 'text' | 'color' | 'asset' | 'missing' | 'other';
export type IssueSeverity = 'P0' | 'P1' | 'P2';
export type IssueStatus = 'open' | 'resolved' | 'ignored';

/** 问题标记 */
export interface Issue {
  id: string;
  requirementId: string;
  pairId: string;
  source: 'design' | 'app' | 'both';
  /** 逻辑坐标；null 表示整页问题 */
  position: { x: number; y: number } | null;
  nodeId: string | null;
  category: IssueCategory;
  severity: IssueSeverity;
  description: string;
  status: IssueStatus;
  createdAt: string;
}

/** 需求（一次验收的容器） */
export interface RequirementMeta {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  designAssets: DesignAssetMeta[];
  appSnapshots: AppSnapshotMeta[];
  pairs: MatchPairMeta[];
  issues: Issue[];
}

// ---------- 画布视图模型 ----------

export interface SideData<TNode> {
  width: number;
  height: number;
  /** 截图 URL（LocalImage 接入后为 sm-asset:// 地址） */
  imageUrl?: string;
  imageLabel: string;
  nodes: TNode[];
}

export interface VerifyPair {
  id: string;
  name: string;
  pageNumber: number;
  issueCount: number;
  design: SideData<DesignNode>;
  app: SideData<AppNode>;
}

/**
 * 画布节点层的统一视图。组件只依赖这个结构。
 *
 * `rect` 与所属 `SideData` 的坐标系一致（设计稿 = 相对导出单元根节点；App = 屏幕坐标），
 * 且**统一为逻辑单位**，与背景截图按逻辑宽高显示相吻合。
 */
export interface RenderNode {
  id: string;
  parentId: string | null;
  source: VerifySource;
  rect: Rect;
  kind: NodeKind;
  /** 悬浮提示 / 默认展示名 */
  label: string;
  depth: number;
  /** siblings 内的叠放序号（back-to-front，越小越靠下） */
  index: number;
  /** 层级路径 */
  path: string;
  visible: boolean;
  /**
   * 画不画得出像素（Figma 侧由插件算好：fills / strokes 里有可见 paint）。
   *
   * ⚠️ 它**不再**决定画布命中 —— 命中看 `hittable`。保留它是因为验收引擎拿它判
   * `layoutOnly`、信息面板要展示「有填充」、`.no-fill` 类名也在用。
   */
  hasFill: boolean;
  /**
   * 是否参与画布命中。**画布 `pointer-events` 的唯一判据。**
   *
   * ⚠️ 不要改用 `hasFill` 自己判：两者在「零像素容器」上结论相反，而那正是
   * 2026-09-16 用户点名要的（「无填充的 frame 元素也要能 hover 和点击选中」）。
   *
   * 规则（唯一实现在 `designNodeHittable` / `appNodeHittable`，纯函数，冒烟直接喂数组）。
   * **顺序即语义**，尤其是第 2 条必须压在第 3 条之前 —— 判反了会让一块隐形靶子吃掉整帧：
   *  1. 隐藏节点（`visible: false`）永不参与；
 *  2. **填充被显式隐藏**（有 fills 条目而全部 `visible: false`）→ **分两种**，
 *     哪怕它还有可见描边也不改判：
 *       · **FRAME 且装了东西**（`childCount > 0`）→ **参与**。它只吃「盒内没被任何
 *         后代盖住的空隙」—— 那些点原本归最外层帧，归它更准（「消息」24×24 带 3 个子，
 *         放行后可命中节点 +1，无人受损）；
 *       · **空壳 FRAME / GROUP / 图形类** → **不参与**。空壳 FRAME 看不见、又常正好
 *         盖满父节点，放行即盾牌：「个人中心优化」里的「返回」是 12×12 空 FRAME，恰好
 *         盖满父级「跳转箭头」—— 若 FRAME 一律放行，父级与同级 VECTOR 的命中面积
 *         **双双归零**（可命中节点 51 → 50，比不改更差）。选它走图层面板 / 搜索。
 *         图形类同理：Group 1000005719（351×94）的末位子节点 Rectangle 34626668 是
 *         349×93.9 的整帧矩形、填充 `visible:false`、只带 1.5px 白描边 → 插件
 *         `hasFill` 为 true（= 可见填充 **或** 可见描边），按整盒命中会吃掉 **99.1%**
 *         的采样点，30 个节点只剩 4 个选得中 —— 用户报「只能 hover / 选中 699:11614」。
   *  3. 有**可见填充** → 参与（填充铺满盒子，盒内每一点都算它）；
   *  4. 从没设过填充（`fills` 为空）但 `hasFill` 为真 ⇒ 像素来自**可见描边**
   *     （图标 / 线 / 描边字）→ 参与。这类在「个人中心优化」样本里有 22 个，
   *     一律关掉会让图标在画布上彻底选不中（实测可命中节点 49 → 39）；
   *  5. **画不出像素的「容器」也参与** —— Frame / Group / 组件实例的盒本身就是结构，
   *     指针落进去就该选中它，而不是被最外层帧吞掉；
 *  6. 其余（图形类 RECTANGLE / VECTOR / ELLIPSE / LINE / 布尔运算… 且零像素）不参与 ——
 *     它们的盒只是包围盒，盒内空白不是「这个图形」。
 *
 * **App 侧只有两条**（`appNodeHittable`）：隐藏节点不参与、**透明盾牌**不参与，
 * 其余一律参与 —— App 树里没有「填充被隐藏」这种状态，不画内容的 View 就是布局容器
 * （ViewGroup / 占位 View / 透明遮罩）。盾牌是框架塞进来的**全屏透明层**
 * （RN 的 `DebuggingOverlay` 360×774，铺满整帧、什么都不画 → 吃掉整帧所有点击），
 * 由 `markAppHitShields` 在 loader 里标注成 `AppNode.hitShield`。
 */
  hittable: boolean;
  /** 已被最近的 clipsContent 祖先裁掉（看不见也点不中） */
  clipped: boolean;
  /** 是否裁剪子节点（DOM 用 overflow: hidden） */
  clipsContent: boolean;
  /** 文本内容，供信息面板展示 */
  text?: string | null;
  /** 设计稿专有的原生字段，供信息面板展示 */
  detail?: DesignNodeDetail;
}

/** 设计稿节点在信息面板里要展示的富信息 */
export interface DesignNodeDetail {
  type: string;
  fills?: FigmaPaint[];
  effects?: FigmaEffect[];
  layout?: FigmaLayout;
  text?: FigmaText;
  opacity?: number;
  cornerRadius?: number | number[];
  component?: FigmaNode['component'];
  absoluteRect?: FigmaRect;
}

function designKind(node: DesignNode): NodeKind {
  if (node.type === 'TEXT') return 'text';
  if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'BOOLEAN_OPERATION') {
    return 'image';
  }
  // ⚠️ Figma 没有 IMAGE 节点类型：图片是 RECTANGLE/VECTOR 上的 fills[].type === 'IMAGE'
  if (node.fills?.some((fill) => fill.type === 'IMAGE' && fill.visible !== false)) return 'image';
  return 'container';
}

/**
 * 「容器」类节点：**不画像素时，它的盒本身仍是结构**（布局 Frame、编组、组件实例）。
 *
 * 图形类（RECTANGLE / VECTOR / ELLIPSE / LINE / BOOLEAN_OPERATION …）刻意不在此列：
 * 它们不画像素的时候，盒只是包围盒 —— 盒内空白处并不属于「这个图形」，
 * 放它进来只会凭空多出一块谁也看不见的命中区。
 *
 * ⚠️ 只列**已知**容器，未列出的类型一律不参与命中。多放一个未知类型进来，代价是
 * 画布上多一块隐形靶子（用户点哪儿都点不到真元素）；少放一个的代价只是那个新类型
 * 点不到 —— 两害相权，取后者。
 */
const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'FRAME',
  'GROUP',
  'INSTANCE',
  'COMPONENT',
  'COMPONENT_SET',
  'SECTION',
]);

/** 有没有 fills 条目（空数组与缺字段同义）——用来区分「从没设过填充」与「填充被隐藏」 */
const hasAnyFill = (fills: readonly FigmaPaint[] | undefined): boolean =>
  (fills?.length ?? 0) > 0;

/** fills 里有没有**可见**的条目（缺 `visible` 视为可见，与 Figma 默认值一致） */
const hasVisibleFill = (fills: readonly FigmaPaint[] | undefined): boolean =>
  (fills ?? []).some((fill) => fill.visible !== false);

/**
 * 设计稿节点是否参与画布命中。判据见 `RenderNode.hittable` 的注释（五条规则）。
 *
 * 与 `designKind` 分开写是**故意的**：后者把没有图片填充的 RECTANGLE 也归为
 * `container`（那是「怎么渲染」的归类），而命中的「容器」是「盒即结构」的意思。
 * 混用会让「矩形备份」这类隐藏填充的备份图形变成隐形靶子。
 *
 * ⚠️ 判定顺序是**被真实数据逼出来的**，不要按「读起来顺」重排：
 *  `hasFill` 由插件算成「可见填充 **或** 可见描边」（`figma-plugin/src/plugin/serialize.ts`
 *  `out.hasFill = hasVisiblePaint(fills) || hasVisiblePaint(strokes)`）。于是
 *  「填充被隐藏 + 有一条 1.5px 描边」的节点 `hasFill === true` —— 若先按 hasFill 放行，
 *  它就会以**整盒**参与命中，而描边其实只画在边缘那一圈。
 */
export function designNodeHittable(node: DesignNode): boolean {
  if (node.visible === false) return false;

  // fills 缺字段 = 老导出，那时还没有「描边也算像素」，退回插件结论即可
  if (node.fills == null) {
    return node.hasFill !== false ? true : CONTAINER_TYPES.has(node.type);
  }
  // ① 设过填充：可见 → 命中；**全部隐藏 → 分两种**（判据在分支里）
  if (hasAnyFill(node.fills)) {
    if (hasVisibleFill(node.fills)) return true;
    // 填充被隐藏：**只有「FRAME 且装了东西」放行**。
    //   · 装了东西 → 它只吃「盒内没被任何后代盖住的空隙」，那些点原本会落到最外层帧上，
    //     归它更准（「消息」24×24 带 3 个子 → 可命中节点 +1，无人受损）；
    //   · **空壳 FRAME** → 不放行。它看不见，又常常正好盖满父节点，一放行就是盾牌：
    //     「返回」是 12×12 的空 FRAME，恰好盖满父级「跳转箭头」—— FRAME 一律放行时，
    //     父级与同级的 VECTOR 命中面积**双双归零**（可命中节点 51 → 50，反而更差）。
    //     空壳在画布上等于不存在，选它走图层面板 / 搜索更合适；
    //   · 非 FRAME 一律不放行（GROUP 与图形类的盒不是「结构」，见 `CONTAINER_TYPES` 注）。
    return node.type === 'FRAME' && (node.childCount ?? 0) > 0;
  }
  // ② 从没设过填充却 hasFill=true ⇒ 像素来自**可见描边**（图标 / 线 / 描边字），
  //    它们是「点它就是要选它」，保留命中（「个人中心优化」样本里这类有 22 个，
  //    一律关掉会让图标在画布上选不中 —— 实测可命中节点 49 → 39）
  if (node.hasFill !== false) return true;
  // ③ 零像素：只有「盒即结构」的容器参与
  return CONTAINER_TYPES.has(node.type);
}

/** 自己画不画得出任何像素（文本 / 图片 / 渐变 / SDK 判定的可见内容） */
const appDrawsSomething = (node: AppNode): boolean =>
  node.hasVisualContent || node.isImage || node.isGradient || node.text != null;

/**
 * 已知的**框架层覆盖类名片段**（小写包含匹配）。
 *
 * 这些视图在真机上被 RN 设成 `pointerEvents="none"`（不接收触摸），但端上 dump 拿不到
 * 这个属性（它是 RN 在 JS 侧设的，原生 `ViewGroup` 上没有对应的系统字段），于是 Mac 端
 * 只能按类名认。它们共同的特征是：**铺满整个 RN 内容区、什么都不画**，一旦参与命中
 * 就是一块盖住全屏的隐形靶子。
 */
const NON_INTERACTIVE_CLASS_MARKERS: readonly string[] = [
  // React Native 的元素检查器 / 调试高亮层（com.facebook.react.views.debuggingoverlay.DebuggingOverlay）
  'debuggingoverlay',
];

/**
 * 判定「透明盾牌」的覆盖比例阈值：盒子面积 ≥ 父盒面积的 90%。
 *
 * 0.9 是实测出来的：0.8 / 0.9 / 0.99 在 6 份快照上结论一致（见下方函数注释的数据表），
 * 取 0.9 是为了让「比父盒略小一圈」的盾牌（状态栏 / 圆角裁掉几 pt）也能被认出来，
 * 同时不至于误伤卡片里那种只占父盒两三成的空白 View —— 那是真实的布局元素。
 */
const SHIELD_COVER_RATIO = 0.9;

/**
 * 标出 App 树里的**透明盾牌**：不参与画布命中的节点（`hitShield: true`）。
 *
 * 为什么需要它（2026-09-16 用户报「截图那侧只能选中根节点」）：
 * 端上 dump 的视图树里有大量**框架塞进去的透明层**，它们不是页面的一部分：
 *   · `DebuggingOverlay`（360×774）是 RN 元素检查器的调试层，铺满整个 ReactSurfaceView，
 *     且是父节点的唯一子节点 → DOM 里它盖住全部内容：全屏 3160 点采样里 **98.3%**
 *     命中它，可命中的不同节点只有 **2 个**（它 + 底部导航栏）。用户看到的就是
 *     「怎么点都是整屏一个框」，即所谓的「只能选中根节点」。
 *   · 它的父 `ReactViewGroup`（同样 360×774、同样什么都不画）是第二层盾牌 —— 只关掉
 *     DebuggingOverlay 的话，命中会退到它身上，症状一模一样。所以判定必须**自底向上**：
 *     子节点全被判成盾牌的父节点，自己若是透明且铺满父盒，同样算盾牌。
 *
 * 判据（四条全满足才算盾牌，`visible: false` / 根节点 / 可点击节点一律不是）：
 *   1. 自己画不出任何像素（无可见内容 / 图片 / 渐变 / 文本）；
 *   2. **不可点击**（`clickable` 的空 View 是真实的触摸热区，必须能选）；
 *   3. 盒子面积 ≥ 父盒的 90%（只盖住父盒一小块的空白 View 是真布局，不是盾牌）；
 *   4. 所有子节点都是盾牌或不可见（整棵子树都不画像素 ⇒ 这一支在屏幕上完全不存在）。
 * 另外类名命中 `NON_INTERACTIVE_CLASS_MARKERS` 的一律直接判盾牌 —— 不依赖上面四条，
 * 因为调试层在高亮元素时会临时挂上红框子节点，那时第 4 条反而不成立。
 *
 * 实测（6 份 app 快照，30×60 网格采样，指标=「能命中的不同节点数 / 整屏级命中占比」）：
 *   · 规则前：2 / 0.983、2 / 0.983、13 / 0.662、20 / 0.653、66 / 0.417、19 / 0.677
 *   · 规则后：109 / 0.053、98 / 0.124、13 / 0.662、20 / 0.653、66 / 0.417、19 / 0.677
 *   —— 两份被盾牌吃掉的快照恢复（2 → 109 / 2 → 98），**其余四份一个节点都没少**。
 *   （曾试过更激进的「空壳即关」：那四份会掉到 5 / 17 / 40 / 16 —— 空白占位 View
 *     也是验收对象，不能一刀切。）
 *
 * ⚠️ 只标 App 侧。Figma 树是人搭出来的，没有这种框架层透明壳；设计稿侧对等的规则是
 * `designNodeHittable` 里的「填充被隐藏 + 空壳 FRAME」。两条规则各管一侧，别互相套用。
 *
 * @returns 新的节点数组（不改动入参；只有被标成盾牌的节点是新对象）
 */
export function markAppHitShields(nodes: readonly AppNode[]): AppNode[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenOf = new Map<string, AppNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const bucket = childrenOf.get(node.parentId);
    if (bucket) bucket.push(node);
    else childrenOf.set(node.parentId, [node]);
  }

  const shielded = new Set<string>();
  // 自底向上：子节点的 depth 一定大于父节点（端上 dump 的保证），降序遍历即可保证
  // 「算父节点时它的所有子节点都已经有结论」。
  const ordered = [...nodes].sort((a, b) => b.depth - a.depth);

  for (const node of ordered) {
    if (node.visible === false) continue;
    if (appDrawsSomething(node) || node.clickable) continue;
    const className = (node.className ?? '').toLowerCase();
    if (NON_INTERACTIVE_CLASS_MARKERS.some((marker) => className.includes(marker))) {
      shielded.add(node.nodeId);
      continue;
    }
    // 根节点没有父盒可比，永远不当盾牌（否则整帧会点不动）
    if (!node.parentId) continue;
    const parent = byId.get(node.parentId);
    const parentArea = parent ? parent.width * parent.height : 0;
    if (parentArea <= 0) continue;
    if (node.width * node.height < SHIELD_COVER_RATIO * parentArea) continue;

    const children = childrenOf.get(node.nodeId) ?? [];
    const allTransparent = children.every(
      (child) => child.visible === false || shielded.has(child.nodeId),
    );
    if (allTransparent) shielded.add(node.nodeId);
  }

  if (shielded.size === 0) return [...nodes];
  return nodes.map((node) =>
    shielded.has(node.nodeId) ? { ...node, hitShield: true } : node,
  );
}

/**
 * App 侧节点是否参与画布命中。
 *
 * App 树里没有「填充被隐藏」这种状态：不画内容的 View 就是布局容器（ViewGroup、
 * 占位 View、透明遮罩），**一律参与命中** —— 与设计稿侧同一套手感，两侧画布的行为
 * 才不会在同一次比对里分叉。
 *
 * 唯一的例外是**透明盾牌** `hitShield`（判据见 `markAppHitShields`）：框架塞进来的
 * 全屏透明层（RN 的 DebuggingOverlay 等）。它铺满整屏、什么都不画，一旦参与命中就
 * 吃掉整帧的所有点击 —— 用户报的「截图那侧只能选中根节点」就是它。
 */
export function appNodeHittable(node: AppNode): boolean {
  if (node.visible === false) return false;
  if (node.hitShield === true) return false;
  return true;
}

export function toRenderNode(node: DesignNode, source: 'design'): RenderNode;
export function toRenderNode(node: AppNode, source: 'app'): RenderNode;
export function toRenderNode(node: DesignNode | AppNode, source: VerifySource): RenderNode {
  if (source === 'design') {
    const d = node as DesignNode;
    return {
      id: d.id,
      parentId: d.parentId,
      source: 'design',
      rect: d.rect,
      kind: designKind(d),
      label: d.text?.characters || d.name,
      depth: d.depth,
      index: d.index ?? 0,
      path: d.path,
      visible: d.visible,
      // hasFill 缺失时保守视为可命中，避免整层点不动
      hasFill: d.hasFill !== false,
      hittable: designNodeHittable(d),
      clipped: d.clipped === true,
      clipsContent: designClipsContent(d),
      text: d.text?.characters ?? null,
      detail: {
        type: d.type,
        fills: d.fills,
        effects: d.effects,
        layout: d.layout,
        text: d.text,
        opacity: d.opacity,
        cornerRadius: d.cornerRadius,
        component: d.component,
        absoluteRect: d.absRect,
      },
    };
  }

  const a = node as AppNode;
  return {
    id: a.nodeId,
    parentId: a.parentId,
    source: 'app',
    rect: { x: a.x, y: a.y, width: a.width, height: a.height },
    kind: a.isImage ? 'image' : a.text != null ? 'text' : 'container',
    label: a.text || a.contentDescription || a.resourceName || a.className,
    depth: a.depth,
    index: a.index,
    path: a.className,
    visible: a.visible,
    hasFill: a.hasVisualContent || a.isImage || a.isGradient,
    hittable: appNodeHittable(a),
    clipped: false,
    clipsContent: appClipsContent(a),
    text: a.text,
  };
}

/**
 * 把扁平节点表还原成父子树，供画布用嵌套 DOM 渲染（裁剪与叠放才能天然对齐）。
 * 返回根节点数组（`parentId` 为 null 或指向不存在的节点时视为根）。
 */
export function buildNodeTree(nodes: RenderNode[]): RenderTree {
  const childrenOf = new Map<string | null, RenderNode[]>();
  const ids = new Set(nodes.map((node) => node.id));

  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(node);
    else childrenOf.set(parent, [node]);
  }

  return { roots: childrenOf.get(null) ?? [], childrenOf };
}

export interface RenderTree {
  roots: RenderNode[];
  childrenOf: Map<string | null, RenderNode[]>;
}

/** 图层列表里的一行：节点 + 缩进深度 + 展开状态 */
export interface FlatLayerRow {
  node: RenderNode;
  depth: number;
  /** 有子节点（决定要不要画折叠箭头） */
  hasChildren: boolean;
  /** 是否正在展开（仅 hasChildren 时有意义） */
  open: boolean;
}

/**
 * 把节点树按**当前展开状态**拉平成一维行列表，供图层列表渲染（对齐 Figma 的 Layers）。
 *
 * 为什么先拉平、而不是写递归组件：递归组件的 children 每次渲染都是新对象，
 * `React.memo` 会因此完全失效 —— 而 300+ 行的列表里，选中态一变就要重建全部行
 * （每行还带内联图标），那正是最需要 memo 的场景。
 *
 * 折叠判定用回调而不是键集合：键的构造规则（来源前缀之类）属于 UI 侧，
 * 这里只回答「这一行折了吗」。
 *
 * ⚠️ 同一父节点下的兄弟按**数组原序**输出 —— 这是刻意对齐 Figma：导出的 children
 * 是 back-to-front（0 = 最底层），而 **Figma 的 Layers 面板就是按数组原序排的**
 * （index 0 在面板最上面；用户拿真实样本的截图钉死过：卡片组里与父同尺寸的背景板
 * 排在面板第一行 —— 此前一度按「面板顶部 = 最上层」做了逆序，是误读，已改回）。
 * 于是「列表从上到下」＝「画布上从下到上」：面板首行是背景板，越往下越靠前；
 * 画布 DOM 同样按数组原序 append（背景先画、内容后画）—— 两边共用同一份顺序，
 * 谁都不许再翻。
 */
export function flattenVisibleTree(
  tree: RenderTree,
  isCollapsed: (node: RenderNode) => boolean,
): FlatLayerRow[] {
  const out: FlatLayerRow[] = [];

  const walk = (list: RenderNode[], depth: number): void => {
    for (let index = 0; index < list.length; index += 1) {
      const node = list[index];
      const children = tree.childrenOf.get(node.id) ?? [];
      const hasChildren = children.length > 0;
      const open = hasChildren && !isCollapsed(node);
      out.push({ node, depth, hasChildren, open });
      if (open) walk(children, depth + 1);
    }
  };

  walk(tree.roots, 0);
  return out;
}
