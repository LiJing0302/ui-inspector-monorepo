/**
 * SAMA — 类型契约层
 *
 * 本文件只放类型，不放逻辑。分三段：
 *   A. 原始输入（debug bundle / SDK 导出，逐字段与实测样本对齐）
 *   B. 规范化模型（L0 产物，全链路内部流通的数据形态）
 *   C. 输出报告（issue / verdict / 证据链）
 */

/* ============================================================================
 * A. 原始输入
 * ==========================================================================*/

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Figma 侧文本 run（实测字段，注意 name ≠ characters，见报告约束 9） */
export interface DesignTextRun {
  characters: string;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  lineHeight?: number | string;
  letterSpacing?: string | number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textDecoration?: string;
  textCase?: string;
  textAutoResize?: string;
  lineCount?: number;
  color?: string;
  [k: string]: unknown;
}

export interface DesignFill {
  type: string; // SOLID | LINEAR_GRADIENT | RADIAL_GRADIENT | IMAGE ...
  visible?: boolean;
  opacity?: number;
  color?: string;
  blendMode?: string;
  gradientStops?: unknown[];
  scaleMode?: string;
  [k: string]: unknown;
}

export interface DesignLayout {
  mode?: string; // NONE | VERTICAL | HORIZONTAL
  gap?: number;
  counterAxisGap?: number;
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  alignItems?: string;
  justifyContent?: string;
  wrap?: string;
  clipsContent?: boolean;
  [k: string]: unknown;
}

export interface DesignNode {
  id: string;
  name: string;
  type: string; // FRAME | GROUP | TEXT | INSTANCE | RECTANGLE | VECTOR ...
  path?: string;
  depth: number;
  index: number;
  visible?: boolean;
  rect: Rect;
  absRect?: Rect;
  locked?: boolean;
  blendMode?: string;
  cornerRadius?: number | number[];
  fills?: DesignFill[];
  hasFill?: boolean;
  strokeWeight?: number;
  strokeAlign?: string;
  strokes?: unknown[];
  layout?: DesignLayout;
  constraints?: Record<string, unknown>;
  parentId?: string | null;
  childCount?: number;
  opacity?: number;
  effects?: unknown[];
  text?: DesignTextRun | null;
  [k: string]: unknown;
}

export interface AppBorderSides<T> {
  top?: T;
  right?: T;
  bottom?: T;
  left?: T;
}

export interface AppStyle {
  backgroundColor?: string | null;
  borderRadius?: number | AppBorderSides<number> | null;
  borderWidth?: number | AppBorderSides<number | null> | null;
  borderColor?: string | AppBorderSides<string | null> | null;
  opacity?: number | null;
  [k: string]: unknown;
}

export interface AppTextStyle {
  fontSize?: number | null;
  fontWeight?: number | string | null;
  fontStyle?: string | null;
  fontFamily?: string | null;
  lineHeight?: number | null;
  letterSpacing?: number | null;
  color?: string | null;
  [k: string]: unknown;
}

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
  visibleX: number;
  visibleY: number;
  visibleWidth: number;
  visibleHeight: number;
  effectiveVisibleX: number;
  effectiveVisibleY: number;
  effectiveVisibleWidth: number;
  effectiveVisibleHeight: number;
  scrollX: number;
  scrollY: number;
  visible?: boolean;
  enabled?: boolean;
  clickable?: boolean;
  alpha?: number;
  z?: number;
  elevation?: number;
  clipsToBounds?: boolean;
  isImage?: boolean;
  isSvg?: boolean;
  isGradient?: boolean;
  hasVisualContent?: boolean;
  resourceName?: string | null;
  contentDescription?: string | null;
  text?: string | null;
  participation?: string; // required | optional | context ...
  zeroSize?: boolean;
  hiddenByAncestor?: boolean;
  outsideVisibleRect?: boolean;
  clipped?: boolean;
  clippedByAncestor?: boolean;
  clippedOut?: boolean;
  layoutOnly?: boolean;
  passThrough?: boolean;
  textRedacted?: boolean;
  hitShield?: boolean;
  style?: AppStyle | null;
  textStyle?: AppTextStyle | null;
  [k: string]: unknown;
}

export interface BundleSideMeta {
  width: number;
  height: number;
  pixelWidth?: number;
  pixelHeight?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  exportScale?: number;
  densityDpi?: number;
  platform?: string;
  device?: string;
  nodeCount?: number;
  [k: string]: unknown;
}

export interface BundleMeta {
  kind?: string;
  version?: number;
  exportedAt?: string;
  requirement?: { id?: string; name?: string };
  pair?: { id?: string };
  design: BundleSideMeta;
  app: BundleSideMeta;
  files?: string[];
  missing?: string[];
  [k: string]: unknown;
}

/** 图像引用：可以是 base64 data URL，也可以交给 Node 层惰性加载 */
export interface ImageRef {
  /** 物理像素宽高 */
  width: number;
  height: number;
  /** 像素数据加载器（Node 侧实现；纯核心里可以为空） */
  load?: () => Promise<PixelImage>;
}

export interface PixelImage {
  width: number;
  height: number;
  /** RGBA，长度 = width*height*4 */
  data: Uint8Array;
}

export interface AcceptanceInput {
  meta: BundleMeta;
  designNodes: DesignNode[];
  appNodes: AppNode[];
  designImage?: ImageRef;
  appImage?: ImageRef;
}

/* ============================================================================
 * B. 规范化模型（L0 产物）
 * ==========================================================================*/

export type Side = 'design' | 'app';
export type NodeKind = 'text' | 'visual' | 'container' | 'chrome';
export type LayerKind = 'flow' | 'fixed';

/**
 * 清洗层。
 *
 * ⭐ 分层的意义不是「好看」，而是**可核验**：每层对应一个独立的失败原因，
 * 人工核验时可以逐层看剔了什么、还剩什么。判据平铺在一起时，
 * 「总共剔了 227 个」这个数字无法回答「剔对了吗」——
 * 而 10-04 上午那次 `clipped-out` 判据试错 4 次，正是因为没有这层归因。
 *
 * 四层的判据强度递减，可信度也递减：
 *   L1 几何不可能   —— 不可能是用户看到的东西（零尺寸 / 哨兵）
 *   L2 采集脏值     —— 采集器写坏的（工具浮层 / 平台 chrome）
 *   L3 视觉不可见   —— 采集器如实报告的（隐藏 / 被祖先藏 / 被裁）
 *   L4 语义噪声     —— 需要「结构信号」才能判（数字轮的重复文本行）
 *   L5 视口外       —— 完全滚到屏幕上方的节点（**只上方，下方是未滚动到的真内容**）
 *
 * ⚠️ **L4 / L5 是唯一带误伤风险的层**，它们必须同时满足多个独立信号才动手
 * （见 l0 的 `inZeroHeightWindow` / `aboveViewport`）。新增这两层判据时，
 * 务必用其它真实素材交叉验证「在别的素材上剔 0 个」。
 */
export type CleanTier =
  | 'L1-geometry'
  | 'L2-collector'
  | 'L3-invisible'
  | 'L4-semantic'
  | 'L5-viewport'
  /**
   * 纯布局容器（2026-10-04 加，L6 层）。
   *
   * 判据：**叶子 + 无盒样式 + 非 SVG 族**。三个条件缺一不可 ——
   * 「有子节点的分组容器」承载树结构（子节点的 `parentId` 指向它，
   * 而 L3a 祖先投票 / L3b 容器内分配都吃祖先链），
   * 剔了会断链导致匹配崩；SVG 内部元素本身是可绘制图形，
   * SDK 只在 `SvgView` 根上打 `isSvg`，只看 `kind` 会把它们误当容器剔掉。
   */
  | 'L6-layout';

export type DropReason =
  | 'sentinel'
  | 'hidden'
  | 'hidden-by-ancestor'
  | 'zero-size'
  | 'negative-coord'
  | 'tool-overlay'
  | 'platform-chrome'
  | 'pass-through'
  /**
   * 被祖先的 `clipsToBounds` 裁掉的**重复文本行**（2026-10-04 加，L4 层）。
   *
   * ⭐ 这是数字滚动组件（number-flow / `numberFlow-react-native`）噪声的根因：
   * 那种组件把 `0`–`9` 全部实例化在一个 13×0 的零高裁剪窗里，靠 `translateY`
   * 露出当前位，其余 9 个滚出窗外。SDK 侧的 `visible` 对这些子节点**失效**
   * （子比父更「可见」，几何上不可能），所以它们一路带着
   * `visible=true / participation=required / hasVisualContent=true` 进入引擎
   * —— 实测 116 个候选数字行，能贡献上百条「设计『黑科技』↔ App『6』」这类假阳性。
   *
   * ⚠️ 判据必须同时满足四个条件（见 l0）：`clippedOut` + 有文本 +
   * `participation='required'` + **父容器高度 = 0**。
   * 少一个都会误伤 —— 逐个放宽的实测代价见 2026-10-04 日志：
   * 只看 `clippedOut` 会命中 457/729（含 PathView 50 / SvgView 32）；
   * 加上「有文本」仍会误伤另一份素材里 42 个「还没滚到」的真实内容。
   */
  | 'clipped-out'
  /**
   * 完全落在 App 视口**外**（`y + height ≤ 0` 或 `y ≥ viewportHeight`）的节点
   * （2026-10-04 加，L5 层）。
   *
   * ⭐ **上下两侧都剔**，理由是「**不参与验收**」而不是「判定为不存在」：
   * 验收的证据来自 App 截图 —— 截图没覆盖到的地方，引擎根本无从判定。
   * 把这些节点留在节点集里只会制造假阳性：盲盒那份实测，保留下方 312 个时
   * 因为 y 映射在无锚点区退化，App 每一行文本都被判成「App 多出文本」。
   *
   * 真实规模（盲盒，729 节点 / 视口 792）：
   *   视口外且有面积 = **317** 个 → **上 5 / 下 312**，全部剔除。
   *   上方 5 个是数字轮往上滚出去的数字（`y = -149 … -37`，13×28）；
   *   下方 312 个是「还没滚到的下半屏」（"官配防买错"「1.13km」「没有更多数据了」）。
   * ⚠️ 这 312 个是**真实存在**的内容，只是不该参与这次验收 ——
   * 所以剔除**必须**在报告里显式声明（`notes` 写明「视口外 N 个节点未参与验收」），
   * 不能让人以为「App 没有这些内容」。
   *
   * 设计侧实测视口外 **0** 个（稿高 812 正好装进视口 812），故该层只影响 App 侧。
   */
  | 'outside-viewport'
  /**
   * 纯布局容器（2026-10-04 加，L6 层）：**不画任何像素、也不承载结构**。
   *
   * = `kind === 'container'` + **无子节点** + 无背景/边框/圆角 + 非 SVG 族。
   *
   * ## 为什么只剔「叶子」容器
   *
   * 容器本身不可绘制，但**有子节点的容器必须留着** —— 它的子节点 `parentId`
   * 指向它，剔掉父容器子节点就成孤儿，而 L3a 祖先投票 / L3b 容器内分配
   * 都吃祖先链，断链会让匹配崩。布局容器是「树结构」，不是「像素」。
   *
   * ## 为什么加「非 SVG 族」
   *
   * SDK 只在 `SvgView` **根**上打 `isSvg`，内部 `PathView`/`CircleView`/
   * `RectView` 既无 `isSvg` 也无 `hasVisualContent` ⇒ `appKind` 曾把它们
   * 判成 container（实测 10年管家 App 侧 135 个 container 里 **54 个**是这类）。
   * 「看 kind 就剔」会把矢量路径一起删掉。
   */
  | 'layout-only';

export interface NormNode {
  side: Side;
  id: string;
  parentId: string | null;
  depth: number;
  index: number;
  /** 逻辑坐标（文档坐标，已剔除脏值） */
  rect: Rect;
  /** 与所属侧可视窗口求交后的矩形（可能为空 → 无像素证据） */
  visibleRect: Rect;
  kind: NodeKind;
  /** 归一化文本（已去零宽 / 折叠空白 / 全角转半角）；非文本节点为 null */
  text: string | null;
  /** 原始文本，仅用于证据展示 */
  textRaw: string | null;
  hasVisualContent: boolean;
  isImage: boolean;
  isSvg: boolean;
  isGradient: boolean;
  /** 节点树声明的盒样式（App 侧覆盖率极低，这是必须走像素通道的原因） */
  boxStyle: BoxStyle | null;
  textStyle: TextStyleDecl | null;
  layer: LayerKind;
  /** 祖先链归一化签名，用于文本去歧义 */
  pathSignature: string;
  /** 父节点下的相对序号 */
  orderInParent: number;
  /** 该节点在所属侧的可点击性（App 有；design 由 INSTANCE/FRAME 推断） */
  clickable: boolean;
  /** 参与度（App 有：required/optional/context） */
  participation: string | null;
  /** 是否被裁出可视区（App 有；design 由 rect 与文档边界推断） */
  clippedOut: boolean;
  /** 是否落在截图覆盖范围内（决定有无像素证据） */
  inPixels: boolean;
  tags: string[];
}

export interface BoxStyle {
  /** 声明填充色（design: fills[0].color；app: style.backgroundColor） */
  backgroundColor: string | null;
  cornerRadius: number | null;
  borderWidth: number | null;
  borderColor: string | null;
  /** 填充类型（design 才有：SOLID/LINEAR_GRADIENT/IMAGE） */
  fillType: string | null;
}

export interface TextStyleDecl {
  fontSize: number | null;
  fontWeight: string | number | null;
  fontFamily: string | null;
  color: string | null;
  lineHeight: number | null;
  letterSpacing: number | null;
}

/**
 * `DropReason` → 清洗层。**唯一的归因来源**。
 *
 * ⚠️ 为什么必须是这张表而不是在 l0 里顺手标层：
 * 判据在 l0、统计在 harness、渲染在 report —— 三处各写一份映射必然会漂。
 * 人工核验时看到「L4 剔了 116 个」要能立刻回溯到是哪个 reason。
 */
export const DROP_TIER: Record<DropReason, CleanTier> = {
  // L1 几何不可能：屏幕上不可能有这个东西
  'zero-size': 'L1-geometry',
  'negative-coord': 'L1-geometry',
  sentinel: 'L1-geometry',
  // L2 采集脏值：采集器 / 设计稿里写坏的东西，不是被验收对象的真实内容
  'tool-overlay': 'L2-collector',
  'platform-chrome': 'L2-collector',
  'pass-through': 'L2-collector',
  // L3 视觉不可见：采集器如实报告的隐藏态
  hidden: 'L3-invisible',
  'hidden-by-ancestor': 'L3-invisible',
  // ⚠️ L4 语义噪声：带误伤风险的层
  'clipped-out': 'L4-semantic',
  // L5 视口外：理由是「不参与验收」（非「判定为不存在」），见 DropReason 注释
  'outside-viewport': 'L5-viewport',
  // ⚠️ L6 纯布局容器：带误伤风险的层（SVG 内部元素 / 分组容器都曾被它误判）
  'layout-only': 'L6-layout',
};

export const CLEAN_TIER_LABEL: Record<CleanTier, string> = {
  'L1-geometry': 'L1 几何不可能',
  'L2-collector': 'L2 采集脏值',
  'L3-invisible': 'L3 视觉不可见',
  'L4-semantic': 'L4 语义噪声',
  'L5-viewport': 'L5 视口外（不参与验收）',
  'L6-layout': 'L6 纯布局容器（不绘制）',
};

/** 一条剔除记录。`evidence` 让人工核验时不必回头查素材 */
export interface DropRecord {
  id: string;
  reason: DropReason;
  tier: CleanTier;
  /** 判据快照：为什么这条被剔了（文本 / 尺寸 / 关键标志） */
  evidence: string;
}

export interface ShapedSide {
  nodes: NormNode[];
  dropped: DropRecord[];
  /** 文档真实高度（含截图外的节点） */
  docHeight: number;
  /** 可视窗口 / 截图覆盖高度（逻辑像素） */
  viewportHeight: number;
  /** 可视窗口宽度（逻辑像素） */
  viewportWidth: number;
  stats: {
    total: number;
    kept: number;
    dropped: number;
    text: number;
    visual: number;
    container: number;
    chrome: number;
    flow: number;
    fixed: number;
    inPixels: number;
    /** 被裁出可视区且必需的节点数（报告实测：105） */
    clippedOutRequired: number;
    /**
     * 按清洗层归因的剔除数（人工核验的第一入口）。
     * 键是 `CleanTier`，恒含全部 4 层（没剔的层计数为 0）——
     * 「恒含」是刻意的：看表的人要能确认「这层我检查过了，剔了 0 个」，
     * 而不是「这层没出现所以不知道有没有跑」。
     */
    byTier: Record<CleanTier, number>;
  };
}

/* ============================================================================
 * C. L1 对齐
 * ==========================================================================*/

export interface AnchorPair {
  text: string;
  designId: string;
  appId: string;
  designY: number;
  appY: number;
  deltaY: number;
  /** 三重去歧义是否全部命中（同名唯一 / 父链签名一致 / 相对序号一致） */
  disambiguation: { uniqueText: boolean; signature: boolean; order: boolean };
  strong: boolean;
  reason?: string;
}

export interface FitSegment {
  designY0: number;
  designY1: number;
  appY0: number;
  appY1: number;
  /** 该段锚点数 */
  anchors: number;
  /** 局部残差中位数 */
  residualMedian: number;
  /** 段间 Δy 跳变过大 → 视为对齐断裂 */
  gap: boolean;
}

export interface AlignmentResult {
  anchors: AnchorPair[];
  strongAnchors: AnchorPair[];
  weakAnchors: AnchorPair[];
  segments: FitSegment[];
  /** 强锚点 Δy 中位数（报告实测约 −23 ~ −26） */
  residualMedian: number;
  residualP90: number;
  within3: number;
  /** design.y → app.y（单调保序拟合后的分段线性插值） */
  projectY: (designY: number) => { appY: number; confidence: number; extrapolated: boolean };
  /** 低置信 / 断裂区间 */
  gaps: Array<{ designY0: number; designY1: number; note: string }>;
  fixedLayer: AnchorPair[];
}

/* ============================================================================
 * D. L2 分区评审
 * ==========================================================================*/

export interface RegionDef {
  regionId: string;
  label: string;
  /** 设计侧 y 区间（文档坐标） */
  designY0: number;
  designY1: number;
  /** 该区域是否被显式声明为动态/环境态高发区 */
  hints?: string[];
}

export interface MarkItem {
  markId: string;
  regionId: string;
  kind: 'text' | 'visual' | 'box';
  /**
   * 两侧**原始节点 id**（design = Figma `id`，app = SDK `nodeId`）。
   *
   * ⚠️ 这两个字段是「报告落到画布上」的唯一凭据 —— 消费侧的节点索引
   * （`CanvasBoard` 的 `designById` / `appById`）只按 id 查，而框坐标在这里
   * 已经被 `toDesignBox` 投影成了设计坐标系、不能直接拿去画 App 帧。
   * 所以**画布侧拿到 id 后必须向画布要 `node.rect`**（帧内逻辑坐标），
   * 而不是拿 `appBox` 反解投影。
   */
  designId: string | null;
  appId: string | null;
  designText: string | null;
  appText: string | null;
  /** [x, y, w, h]，设计侧为逻辑坐标，App 侧为**投影到设计坐标**后的值 */
  designBox: [number, number, number, number] | null;
  appBox: [number, number, number, number] | null;
  delta: { dx: number; dy: number; dw: number; dh: number } | null;
  /** 确定性规则给出的初判 */
  ruleVerdict: RuleVerdict;
  ruleReason: string;
  /** 该 mark 是否有像素证据 */
  hasPixelEvidence: boolean;
  /** App 侧参与度（required 被裁出 → 单独提示，不等同于设计缺失） */
  participation: string | null;
}

export type RuleVerdict =
  | 'ok'
  | 'missing'
  | 'text-mismatch'
  | 'geometry-off'
  | 'dynamic'
  | 'environmental'
  | 'unjudgeable';

export interface RegionSlice {
  region: RegionDef;
  /** 设计侧裁切框（物理像素），交给图像层裁图 */
  designCropPx: [number, number, number, number];
  /** App 侧裁切框（物理像素） */
  appCropPx: [number, number, number, number] | null;
  items: MarkItem[];
  dynamicHints: string[];
  envHints: string[];
  /** 该区域在 App 截图中完全没有像素证据 */
  noPixelEvidence: boolean;
  /** 覆盖率（该区域被 App 截图覆盖的比例 0~1） */
  pixelCoverage: number;
}

/* ============================================================================
 * E. Reviewer 协议（VLM 通道）
 * ==========================================================================*/

export interface RegionReviewRequest {
  region: RegionDef;
  /** 设计侧裁切图（可选；无图时退化为纯文本清单评审） */
  designCrop?: PixelImage;
  /** App 侧裁切图 */
  appCrop?: PixelImage;
  /** App 侧裁切图与设计侧裁切图的像素尺度比（用于提示模型，不做换算） */
  cropScaleRatio: number | null;
  items: MarkItem[];
  dynamicHints: string[];
  envHints: string[];
  noPixelEvidence: boolean;
}

export type DefectCategory =
  | 'existence' // 缺失 / 多余
  | 'text' // 文案
  | 'geometry' // 位置 / 尺寸 / 间距
  | 'color' // 颜色
  | 'corner' // 圆角
  | 'stroke' // 描边
  | 'style' // 风格 / 层次 / 观感
  | 'hierarchy' // 信息层级
  | 'coverage'; // 证据覆盖不足（截图未覆盖 → 不可判定，严禁 pass）

export type Severity = 'P0' | 'P1' | 'P2';

export interface AiDefect {
  markId: string;
  category: DefectCategory;
  severity: Severity;
  expected: string;
  actual: string;
  reason: string;
  /** 对规则初判的处置：keep(维持) / downgrade(降级) / override(改判为无问题) */
  action?: 'keep' | 'downgrade' | 'override';
}

export interface RegionReviewResponse {
  regionId: string;
  /** 环境态差异（登录态 / 数据态 / 平台态），不进入缺陷列表 */
  environmental: Array<{ markId?: string; reason: string }>;
  /** 动态位差异（值不同但格式一致） */
  dynamic: Array<{ markId?: string; reason: string }>;
  /** 缺陷 */
  defects: AiDefect[];
  /** 模型自述的置信度 0~1 */
  confidence?: number;
  raw?: unknown;
}

export interface RegionReviewer {
  readonly name: string;
  review(req: RegionReviewRequest): Promise<RegionReviewResponse>;
}

export interface ReviewValidation {
  accepted: AiDefect[];
  rejected: Array<{ defect: AiDefect | undefined; reason: string }>;
  environmental: Array<{ markId?: string; reason: string }>;
  dynamic: Array<{ markId?: string; reason: string }>;
  errors: string[];
}

/* ============================================================================
 * F. 输出报告
 * ==========================================================================*/

export type IssueSource = 'rule' | 'ai' | 'mixed';

export interface EvidenceChain {
  markId: string | null;
  regionId: string | null;
  /**
   * 两侧原始节点 id（design = Figma `id`，app = SDK `nodeId`）。
   *
   * ⭐ 这是**消费侧把 issue 画回节点**的唯一凭据，也是「点面板某条 issue →
   * 画布选中对应节点」能成立的前提。坐标系不可替代它：`appBox` 是
   * `toDesignBox` 投影到**设计坐标系**的结果，画到 App 帧上会错位。
   *
   * 结构性 issue（对齐漂移、无像素证据）与像素通道 issue 天然没有单节点，
   * 这里是 null —— 消费侧必须按 null 走「画区域/画斜纹带」而不是画节点框。
   */
  designId: string | null;
  appId: string | null;
  designText: string | null;
  appText: string | null;
  designBox: [number, number, number, number] | null;
  appBox: [number, number, number, number] | null;
  /** 规则初判 */
  ruleVerdict: RuleVerdict | null;
  /** AI 判断（若参与） */
  aiReason: string | null;
  /** 投影后的归一化坐标（design 逻辑坐标） */
  normBox: [number, number, number, number] | null;
}

export interface Issue {
  issueId: string;
  category: DefectCategory;
  severity: Severity;
  source: IssueSource;
  title: string;
  detail: string;
  evidence: EvidenceChain;
  /** 是否因无像素证据而降级为待人工确认 */
  needsHumanReview: boolean;
  /** 该 issue 的判定权限：strong = 规则侧强，AI 只能降级；weak = 规则侧弱，AI 可新增 */
  authority: 'strong' | 'weak';
}

export type Verdict = 'pass' | 'fail' | 'review';

export interface AcceptanceReport {
  schemaVersion: 1;
  generatedAt: string;
  requirement: { id: string | null; name: string | null };
  /** 输入侧摘要（含两侧尺寸、scale、口径，便于复现） */
  input: {
    design: { width: number; height: number; pixelWidth: number; pixelHeight: number; scale: number; nodes: number };
    app: { width: number; height: number; pixelWidth: number; pixelHeight: number; scale: number; nodes: number };
    /** 物理比 k = appPixelWidth / designPixelWidth（实测 1.44） */
    pixelRatio: number;
    /** 逻辑比 = appWidth / designWidth（实测 0.96） */
    logicalRatio: number;
  };
  shaping: { design: ShapedSide['stats']; app: ShapedSide['stats'] };
  alignment: {
    anchors: number;
    strongAnchors: number;
    weakAnchors: number;
    fixedLayerAnchors: number;
    residualMedian: number;
    residualP90: number;
    within3: number;
    gaps: AlignmentResult['gaps'];
    segments: FitSegment[];
    /** 用哪套算法（可审计） */
    method: string;
  };
  regions: Array<{
    regionId: string;
    label: string;
    designY: [number, number];
    items: number;
    ruleVerdicts: Partial<Record<RuleVerdict, number>>;
    noPixelEvidence: boolean;
    pixelCoverage: number;
    reviewerUsed: boolean;
    rejectedDefects: number;
  }>;
  /** 无像素证据区间（P0 风险，严禁判 pass） */
  noPixelEvidence: Array<{ designY0: number; designY1: number; reason: string }>;
  issues: Issue[];
  verdict: Verdict;
  verdictReason: string;
  counts: {
    p0: number;
    p1: number;
    p2: number;
    byCategory: Record<string, number>;
    bySource: Record<IssueSource, number>;
    byAuthority: { strong: number; weak: number };
  };
  /** 像素通道结果（M4） */
  pixel?: PixelReport;
  notes: string[];
}

export interface PixelReport {
  available: boolean;
  reason?: string;
  thresholds: { deltaE: number; cornerTolerancePx: number };
  colorChecks: ColorCheck[];
  cornerChecks: CornerCheck[];
  summary: { checked: number; failed: number };
}

export interface ColorCheck {
  id: string;
  side: 'design' | 'app';
  region: string | null;
  expectedHex: string;
  measuredHex: string;
  deltaE: number;
  pass: boolean;
  sampleCount: number;
  note: string;
}

export interface CornerCheck {
  id: string;
  expectedRadius: number;
  measuredRadius: number;
  tolerancePx: number;
  pass: boolean;
  confidence: number;
  note: string;
}

/* ============================================================================
 * G. Profile（验收前提声明）
 * ==========================================================================*/

export interface AcceptanceProfile {
  name: string;
  /** 噪声剔除名单：工具自身浮层的 className / 文本 */
  noiseClassNames?: string[];
  noiseTexts?: string[];
  /** 平台 chrome 匹配规则 */
  chromeClassNames?: string[];
  chromeNamePatterns?: string[];
  /** 动态位模式（值可变、格式一致） */
  dynamicPatterns?: DynamicPattern[];
  /** 显式声明的环境态差异（登录态 / 数据态 / 运营可配）；`pattern` 是作用于文本的正则 */
  declaredEnvironmental?: EnvironmentalRule[];
  /** 分区定义；缺省则自动推导 */
  regions?: RegionDef[];
  /** 文本匹配阈值 */
  thresholds?: {
    /** 几何容差（设计逻辑像素） */
    geometryTolerance: number;
    /** 颜色 CIEDE2000 阈值 */
    deltaE: number;
    /** 圆角容差（物理像素） */
    cornerTolerancePx: number;
    /** 判定为对齐断裂的相邻段 Δy 跳变阈值 */
    gapJump: number;
  };
  /** 验收前提声明（输出到 report.notes，人类可读） */
  preconditions?: string[];
}

export interface DynamicPattern {
  name: string;
  /** 该模式是否命中（作用于归一化文本） */
  test: (text: string) => boolean;
}

/** 环境态声明：文本命中的正则 → 归入环境态而非缺陷 */
export interface EnvironmentalRule {
  /**
   * 作用于归一化文本的正则（字符串）。
   * **缺省** 表示"整个区域"级豁免 —— 必须同时给出 `regions`，否则不生效。
   */
  pattern?: string;
  /** 命中原因（写入证据链） */
  reason: string;
  /**
   * 作用域：只对这些区域生效；缺省表示全局（配合 pattern 使用）。
   * 例：`{ regions: ['R8'], reason: '联调测试数据，不做文案比对' }` → R8 整区豁免。
   */
  regions?: string[];
}
