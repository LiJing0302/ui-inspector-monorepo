import type { AppNode, DesignNode, PixelRect, Rect } from './verify';
import type { PixelTransformContract } from './acceptance';
import type { CollectionQuality } from './acceptance';

export type CanonicalSource = 'design' | 'app';
export type CanonicalKind = 'text' | 'image' | 'icon' | 'control' | 'container' | 'unknown';
export type Participation = 'required' | 'optional' | 'context' | 'ignored' | 'unavailable';

/**
 * 意义类别（L1）。回答的是「这个节点在匹配里算什么」，与 `kind`（渲染成什么）是两个轴：
 * 一个 `container` 既可能是承载结构、分发内容的**盒子**，也可能只是一个把像素原样透传的**壳**。
 *
 * | 类 | 判据 | 匹配里的价值 |
 * |---|---|---|
 * | `text` | 有非空文本 | 最强锚点 |
 * | `graphic` | 叶子且能画像素（图片 / 矢量 / 底色） | 视觉锚点 |
 * | `box` | 有有效子节点且不是透传 | 结构锚点 |
 * | `layout` | 透传包装，或没有任何有效子节点 | **不参与 missing / extra** |
 *
 * ⚠️ `layout` 的判据是「**分不分发内容**」，不是「画不画像素」。用后者会把 360×792 的全屏透明
 * 容器与 40px 的图标容器混成一类，实测会让 App 侧 319/527 个节点被判成布局 ——
 * 于是「找最近的盒子祖先」一步就跳到树根，整棵树一个都配不上。
 */
export type Salience = 'text' | 'graphic' | 'box' | 'layout';

/**
 * 规范 id 的前缀。
 *
 * 设计稿侧与 App 侧的原始 id 空间互不相干（前者是 Figma 图层 id，后者是 `view:xxxx`），
 * 一旦放进同一个 matches 数组就会撞。加前缀是**唯一**的消歧手段 —— 而且它必须由两侧
 * 共享（主进程造、渲染层解），否则「点了问题跳不到节点」这类问题会变成字符串魔法。
 */
export const DESIGN_ID_PREFIX = 'design:';
export const APP_ID_PREFIX = 'app:';

export function toCanonicalId(source: CanonicalSource, id: string): string {
  return `${source}:${id}`;
}

export function fromCanonicalId(canonicalId: string): { source: CanonicalSource; id: string } | null {
  if (canonicalId.startsWith(DESIGN_ID_PREFIX)) {
    return { source: 'design', id: canonicalId.slice(DESIGN_ID_PREFIX.length) };
  }
  if (canonicalId.startsWith(APP_ID_PREFIX)) {
    return { source: 'app', id: canonicalId.slice(APP_ID_PREFIX.length) };
  }
  return null;
}

export interface GeometryFeatures {
  normalizedX: number;
  normalizedY: number;
  normalizedWidth: number;
  normalizedHeight: number;
  centerX: number;
  centerY: number;
  aspectRatio: number;
  parentOffset: { left: number; top: number; right: number; bottom: number };
}

export interface StructureFeatures {
  childCount: number;
  visibleChildCount: number;
  visualChildCount: number;
  textChildCount: number;
  imageChildCount: number;
  siblingCount: number;
  siblingIndex: number;
  subtreeNodeCount: number;
  layoutDirection: 'horizontal' | 'vertical' | 'freeform' | 'unknown';
}

export interface ContentFeatures {
  rawText: string | null;
  normalizedText: string | null;
  textRedacted: boolean;
  resourceName: string | null;
  contentDescription: string | null;
}

export interface VisualFeatures {
  hasVisualContent: boolean;
  isImage: boolean;
  isSvg: boolean;
  isGradient: boolean;
  alpha: number;
  screenshotCropRef?: string;
}

export interface FeatureQuality {
  geometry: 'available' | 'partial' | 'unavailable';
  structure: 'available' | 'partial' | 'unavailable';
  content: 'available' | 'partial' | 'unavailable';
  visual: 'available' | 'partial' | 'unavailable';
}

export interface CanonicalNode {
  canonicalId: string;
  source: CanonicalSource;
  rawIds: string[];
  parentId: string | null;
  childIds: string[];
  depth: number;
  siblingIndex: number;
  rect: Rect;
  pixelRect?: PixelRect;
  visibleRect: Rect | null;
  kind: CanonicalKind;
  /** L1 意义类别；缺失视为 `layout`（不参与 missing / extra 的保守侧） */
  salience: Salience;
  /** 是不是透传包装（自身不绘制 + 恰好一个铺满自身的有效子节点） */
  passThrough: boolean;
  participation: Participation;
  visible: boolean;
  /** App SDK supplied or locally derived ancestor visibility state. */
  hiddenByAncestor?: boolean;
  clipped: boolean;
  layoutOnly: boolean;
  virtual: boolean;
  geometry: GeometryFeatures;
  structure: StructureFeatures;
  content: ContentFeatures;
  visual: VisualFeatures;
  quality: FeatureQuality;
}

export interface CanonicalDocument {
  source: CanonicalSource;
  width: number;
  height: number;
  nodes: CanonicalNode[];
  rootIds: string[];
  pixelWidth?: number;
  pixelHeight?: number;
  pixelTransform?: PixelTransformContract;
}

export interface ImageRef {
  file: string;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface ViewportInfo {
  rect: Rect;
  /** Design-space interval that is represented by the current app capture. */
  comparableRect: Rect;
  systemInsets: { top: number; right: number; bottom: number; left: number };
  fixedNodeIds: string[];
  excludedNodeIds: string[];
}

export interface RegionVisualFeatures {
  hasVisualContent: boolean;
  imageCount: number;
  iconCount: number;
  textCount: number;
  dominantColor?: { r: number; g: number; b: number };
  pHash?: string;
  edgeDensity?: number;
}

export type UiRegionRole =
  | 'page'
  | 'system'
  | 'header'
  | 'banner'
  | 'card'
  | 'grid'
  | 'list'
  | 'product'
  | 'store'
  | 'navigation'
  | 'overlay'
  | 'unknown';

export interface UiRegion {
  id: string;
  source: CanonicalSource;
  origin?: 'ai' | 'rule' | 'manual';
  role: UiRegionRole;
  rect: Rect;
  visibleRect: Rect | null;
  nodeIds: string[];
  childRegionIds: string[];
  text: string[];
  visualFeatures: RegionVisualFeatures;
  layout: StructureFeatures['layoutDirection'];
  fixed: boolean;
  scrollable: boolean;
  confidence: number;
  order: number;
  reasonCodes?: string[];
  support?: {
    mode: 'nodes' | 'visual-only' | 'mixed';
    anchorNodeIds: string[];
    candidateRegionIds: string[];
    /** The native node nearest to the AI-proposed module corners. */
    moduleNodeId?: string;
    moduleNodeConfidence?: number;
    moduleNodeStatus?: 'matched' | 'ambiguous' | 'not-found';
    moduleNodeCandidates?: Array<{
      nodeId: string;
      score: number;
      cornerScore: number;
      iouScore: number;
      sizeScore: number;
      nested: boolean;
    }>;
  };
  aiResolution?: AiRegionResolution;
}

export interface AiRegionResolutionHistory {
  attempt: number;
  rect: Rect;
  status: 'matched' | 'not-found';
  reason?: string;
}

export interface AiRegionResolution {
  proposalId: string;
  attempt: number;
  status: 'matched' | 'unknown';
  nodeId: string | null;
  retryHistory: AiRegionResolutionHistory[];
}

export interface ModuleNodeCandidate {
  nodeId: string;
  score: number;
  depth: number;
  cornerScore: number;
  iouScore: number;
  sizeScore: number;
  nested: boolean;
}

export interface ModuleNodeResolution {
  nodeId: string | null;
  confidence: number;
  status: 'matched' | 'ambiguous' | 'not-found';
  candidates: ModuleNodeCandidate[];
}

export interface PageDocument {
  source: CanonicalSource;
  width: number;
  height: number;
  screenshot: ImageRef;
  nodes: CanonicalNode[];
  viewport: ViewportInfo;
  regions: UiRegion[];
}

export type FilteredNodeReason =
  | 'invisible'
  | 'hidden-by-ancestor'
  | 'transparent'
  | 'clipped'
  | 'zero-size'
  | 'outside-viewport'
  | 'layout-only'
  | 'pass-through'
  | 'no-rendered-content'
  | 'ignored'
  | 'unavailable';

export interface FilteredNode {
  canonicalId: string;
  rect: Rect;
  visibleRect: Rect | null;
  kind: CanonicalKind;
  depth: number;
  text: string | null;
  effectiveOpacity: number;
  reasons: string[];
}

export interface FilteredNodeDiagnostic {
  canonicalId: string;
  reasons: FilteredNodeReason[];
}

export interface FilteredNodeSet {
  source: CanonicalSource;
  totalNodeCount: number;
  retainedNodeCount: number;
  filteredNodeCount: number;
  retainedNodes: FilteredNode[];
  filteredNodes: FilteredNodeDiagnostic[];
}

export interface AcceptanceInputAnalysis {
  design: FilteredNodeSet;
  app: FilteredNodeSet;
  annotations: Array<{
    source: CanonicalSource;
    kind: 'original' | 'annotated';
    file?: string;
    url?: string;
    nodeIds: string[];
    shortIdMap: Record<string, string>;
  }>;
}

export type RegionRelation = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'missing' | 'extra' | 'ambiguous';

export interface RegionMatchEvidence {
  role: number;
  geometry: number;
  text: number;
  visual: number;
  structure: number;
  order: number;
}

export interface RegionMatch {
  id: string;
  origin?: 'ai' | 'rule' | 'manual';
  designRegionIds: string[];
  appRegionIds: string[];
  relation: RegionRelation;
  confidence: number;
  evidence: RegionMatchEvidence;
  status: 'matched' | 'ambiguous' | 'missing' | 'extra';
  alternatives?: Array<{ appRegionId: string; score: number }>;
}

export interface RegionOverride {
  id: string;
  designRegionIds: string[];
  appRegionIds: string[];
  action: 'confirm' | 'ignore';
  updatedAt: string;
}

export interface RegionObservation {
  type: 'missing' | 'extra' | 'layout-difference' | 'visual-difference' | 'content-difference' | 'unknown';
  designRegionIds: string[];
  appRegionIds: string[];
  evidence: string[];
}

export interface RegionAcceptanceResult {
  regionId: string;
  matchId: string;
  status: 'pass' | 'warning' | 'fail' | 'unknown';
  coverage: number;
  geometryScore: number;
  visualScore: number;
  contentScore: number;
  structureScore: number;
  missingNodeIds: string[];
  extraNodeIds: string[];
  nodeMatches?: NodeMatch[];
  observations: RegionObservation[];
}

export interface AiNodeSummary {
  id: string;
  /** Short id printed on the corresponding sparse annotation image. */
  shortId?: string;
  kind: CanonicalKind;
  rect: Rect;
  visibleRect: Rect | null;
  text: string | null;
  depth: number;
  childCount: number;
  participation: Participation;
}

export interface AiVisualPoint {
  x: number;
  y: number;
}

export interface AiVisualRegionProposal {
  proposalId: string;
  leftTop: AiVisualPoint;
  rightBottom: AiVisualPoint;
  confidence?: number;
  reasonCodes?: string[];
}

export interface AiVisualSegmentationRequest {
  protocol: 'ui-acceptance-visual-segmentation-v1';
  runId: string;
  model: string;
  source: CanonicalSource;
  image: {
    width: number;
    height: number;
    dataUrl: string;
  };
}

export interface AiVisualSegmentationResponse {
  regions: AiVisualRegionProposal[];
  observations: string[];
  rawOutput?: string;
  finishReason?: string;
}

export interface AiVisualRegionRetryRequest {
  protocol: 'ui-acceptance-visual-region-retry-v1';
  runId: string;
  model: string;
  source: CanonicalSource;
  image: {
    width: number;
    height: number;
    dataUrl: string;
  };
  /** The crop bounds in source-page normalized coordinates. */
  imageRect: Rect;
  /** The previous region in the retry-image normalized coordinate space. */
  previousRegion: {
    leftTop: AiVisualPoint;
    rightBottom: AiVisualPoint;
  };
  failureReason: 'node-not-found';
}

export interface AiRegionProposal {
  proposalId: string;
  source: CanonicalSource;
  role: UiRegionRole;
  /** x/y/width/height are fractions of the source page dimensions. */
  normalizedRect: Rect;
  layout: StructureFeatures['layoutDirection'];
  fixed: boolean;
  scrollable: boolean;
  confidence: number;
  reasonCodes: string[];
}

export interface AiRegionSegmentationRequest {
  protocol: 'ui-acceptance-segmentation-ai-v1';
  runId: string;
  model: string;
  /** Both screenshots are segmented independently before the alignment call. */
  baseline?: 'app';
  design: {
    width: number;
    height: number;
    viewport: ViewportInfo;
    nodes: AiNodeSummary[];
    candidates: UiRegion[];
  };
  app: {
    width: number;
    height: number;
    viewport: ViewportInfo;
    nodes: AiNodeSummary[];
    candidates: UiRegion[];
  };
  pageImages: Array<{
    source: CanonicalSource;
    kind?: 'original' | 'annotated';
    page?: number;
    dataUrl: string;
  }>;
}

export interface AiRegionSegmentationResponse {
  designRegions: AiRegionProposal[];
  appRegions: AiRegionProposal[];
  observations: string[];
  /** The model's text before JSON parsing, retained for diagnostics only. */
  rawOutput?: string;
  finishReason?: string;
}

/** App-first segmentation: the model only sees the current App viewport. */
export interface AiAppSegmentationRequest {
  protocol: 'ui-acceptance-app-segmentation-ai-v1';
  runId: string;
  model: string;
  app: {
    width: number;
    height: number;
    viewport: ViewportInfo;
    nodes: AiNodeSummary[];
    candidates: UiRegion[];
  };
  pageImages: Array<{
    source: 'app';
    kind?: 'original' | 'annotated';
    page?: number;
    dataUrl: string;
  }>;
}

export interface AiAppSegmentationResponse {
  appRegions: AiRegionProposal[];
  observations: string[];
  rawOutput?: string;
  finishReason?: string;
}

/** Design-only segmentation: the design screenshot must not influence App segmentation. */
export interface AiDesignSegmentationRequest {
  protocol: 'ui-acceptance-design-segmentation-ai-v1';
  runId: string;
  model: string;
  design: {
    width: number;
    height: number;
    viewport: ViewportInfo;
    nodes: AiNodeSummary[];
    candidates: UiRegion[];
  };
  pageImages: Array<{
    source: 'design';
    kind?: 'original' | 'annotated';
    page?: number;
    dataUrl: string;
  }>;
}

export interface AiDesignSegmentationResponse {
  designRegions: AiRegionProposal[];
  observations: string[];
  rawOutput?: string;
  finishReason?: string;
}

export interface DesignSearchTile {
  tileId: string;
  /** Tile bounds in design logical coordinates, not image pixels. */
  rect: Rect;
}

/** Locate already-segmented App modules in a long design screenshot. */
export interface AiDesignRegionSearchRequest {
  protocol: 'ui-acceptance-design-region-search-ai-v1';
  runId: string;
  model: string;
  baseline: 'app';
  app: {
    width: number;
    height: number;
    regions: UiRegion[];
  };
  design: {
    width: number;
    height: number;
    viewport: ViewportInfo;
    tiles: DesignSearchTile[];
  };
  pageImages: Array<{
    source: CanonicalSource;
    kind?: 'original' | 'region' | 'tile';
    page?: number;
    regionId?: string;
    tileId?: string;
    dataUrl: string;
  }>;
}

export type DesignRegionSearchStatus = 'matched' | 'ambiguous' | 'not-found';

export interface AiDesignRegionSearchMatch {
  appRegionId: string;
  status: DesignRegionSearchStatus;
  /** Global normalized coordinates relative to the complete design page. */
  designNormalizedRect?: Rect;
  tileId?: string;
  probability: number;
  reasonCodes: string[];
}

export interface AiDesignRegionSearchResponse {
  matches: AiDesignRegionSearchMatch[];
  observations: string[];
  rawOutput?: string;
  finishReason?: string;
}

export interface AiVisualNodeMatch {
  designShortIds: string[];
  appShortIds: string[];
  relation: RegionRelation;
  probability: number;
  reasonCodes: string[];
}

export interface AiAnnotatedNode {
  shortId: string;
  canonicalId: string;
  kind: CanonicalKind;
  rect: Rect;
  text: string | null;
  childCount: number;
}

export interface AiAnnotationPage {
  source: CanonicalSource;
  regionId: string;
  page: number;
  dataUrl: string;
  nodeShortIds: string[];
}

export interface AiRegionNodeMatchRequest {
  protocol: 'ui-acceptance-region-node-ai-v1';
  runId: string;
  model: string;
  designRegionId: string;
  appRegionId: string;
  designNodes: AiAnnotatedNode[];
  appNodes: AiAnnotatedNode[];
  candidates: Array<{
    designShortId: string;
    appShortIds: string[];
    scores: number[];
  }>;
  images: Array<{
    source: CanonicalSource;
    kind: 'original' | 'annotated';
    page?: number;
    dataUrl: string;
  }>;
}

export interface AiRegionNodeMatchResponse {
  matches: AiVisualNodeMatch[];
  observations: Array<{
    type: RegionObservation['type'];
    severity: 'warning' | 'fail' | 'unknown';
    evidence: string[];
    probability: number;
  }>;
  /** The model's text before JSON parsing, retained for diagnostics only. */
  rawOutput?: string;
  finishReason?: string;
}

export interface AiDecisionRecord {
  stage: 'input' | 'segmentation' | 'alignment' | 'node-matching' | 'visual-review';
  model: string;
  promptVersion: string;
  inputHash: string;
  status: 'accepted' | 'rejected' | 'timeout' | 'error' | 'not-submitted';
  latencyMs: number;
  cacheHit?: boolean;
  output?: unknown;
  error?: string;
  /** Identifies the exact regions/nodes involved in this model call. */
  scope?: {
    label?: string;
    designRegionIds?: string[];
    appRegionIds?: string[];
    designNodeIds?: string[];
    appNodeIds?: string[];
    /** AI-visible short id -> canonical node id. */
    shortIdMap?: Record<string, string>;
  };
  /** Small, non-image input inventory for diagnostics and replay UI. */
  inputSummary?: {
    designRegionCount?: number;
    appRegionCount?: number;
    designNodeCount?: number;
    appNodeCount?: number;
    nodePolicy?: 'content' | 'layout-blocks';
    candidateCount?: number;
    imageCount?: number;
    imageWidth?: number;
    imageHeight?: number;
    originalImageWidth?: number;
    originalImageHeight?: number;
    imageScale?: number;
    retainedNodeCount?: number;
    filteredNodeCount?: number;
  };
  /** Request shape only; image data and secrets are intentionally excluded. */
  requestSummary?: {
    protocol?: string;
    model?: string;
    messageCount?: number;
    contentPartTypes?: string[];
    payloadKeys?: string[];
    imageLabels?: string[];
  };
  /** Parsed response shape; the raw model response is not persisted here. */
  responseSummary?: {
    status: 'parsed' | 'invalid-json' | 'schema-rejected';
    contentLength?: number;
    rootKeys?: string[];
    arrayLengths?: Record<string, number>;
    finishReason?: string;
    actualOutput?: string;
    actualOutputTruncated?: boolean;
    error?: string;
  };
}

export interface AiConfigStatus {
  configured: boolean;
  endpoint: string;
  model: string;
  timeoutMs: number;
  source: 'file' | 'environment' | 'none';
}

export interface SaveAiConfigInput {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface TestAiConfigInput extends Omit<SaveAiConfigInput, 'apiKey'> {
  apiKey?: string;
}

export interface AiConnectionTestResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  error?: string;
}

export interface NodeMatchEvidence {
  geometry: number;
  structure: number;
  relation: number;
  visual: number;
  content: number;
  kind: number;
}

export interface NodeMatch {
  id: string;
  designNodeIds: string[];
  appNodeIds: string[];
  relation: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'missing' | 'extra' | 'ambiguous';
  source: 'rule' | 'manual' | 'ai' | 'mixed';
  /**
   * 这条匹配是**怎么来的**。只影响可读性与可信度叙事，不参与裁决。
   *
   * 必须留下的理由：v2 引擎里一条 `matched` 可能是「文本完全相等」（既成事实），
   * 也可能只是「兄弟分配里分数最高」（合理推断）。两者在 `status` 上已经不同，
   * 但排查时第一个要问的就是「这条凭什么」—— 没有这个字段就只能去读引擎代码。
   */
  origin?:
    | 'manual'
    | 'text-anchor'
    | 'text-aggregate'
    | 'text-disambiguated'
    | 'ancestor-vote'
    | 'sibling'
    | 'region'
    /**
     * L3c · 锚点校准定位。
     *
     * 凭什么算一条证据：用**已锁定的文本锚点对**拟合出 `设计稿 y → App y` 的映射
     * （App 截图是视口，滚动会让两侧绝对 y 差出一个页面高度，纯缩放换算必然对不上），
     * 再在「校准后的横向位置 + 纵向位置」上找最近邻。
     *
     * ⚠️ 与 `ancestor-vote` / `sibling` 的关键区别：那两层的证据来自**树结构**，
     * 一旦父容器没被锁定就完全空转（实测 42 个漏配对里「父已被配成一对」= 0）；
     * 本层的证据来自**几何标定**，不依赖任何父容器，所以正好补上那个缺口。
     */
    | 'calibrated-position'
    | 'ai';
  ruleScore: number;
  aiScore?: number;
  confidence: number;
  margin: number;
  evidence: NodeMatchEvidence;
  status: 'matched' | 'ambiguous' | 'missing' | 'extra' | 'ignored';
  /**
   * 仅 `ambiguous` 时存在：同一设计节点的 Top-K App 候选（按分数降序）。
   *
   * 为什么由匹配引擎给出而不是让 AI 客户端自己算：候选集必须与**打分矩阵同源**。
   * 若 AI 侧另算一套「近似候选」，它看到的 Top-K 与规则引擎的分数就会不一致，
   * 于是「AI 推翻规则」这件事到底是发现还是噪声，没人说得清。
   */
  alternatives?: Array<{ appNodeId: string; score: number }>;
}

export interface NodeAnchor {
  id: string;
  designNodeIds: string[];
  appNodeIds: string[];
  relation: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'group';
  scope: 'pair' | 'template';
  confirmed: boolean;
}

export interface NodeMapping {
  version: '1.0.0';
  pairId: string;
  anchors: NodeAnchor[];
  /**
   * ⚠️ 节点 id 一律用**归一化 id**（`design:xxx` / `app:xxx`），不是画布上的原始图层 id
   *    （设计稿是 Figma 图层 id、App 是 `nodeId`）。
   *
   * 匹配引擎与裁决器全程只认归一化 id（`CanonicalNode.canonicalId`），所以把原始 id
   * 写进来是**一条永不生效的规则** —— 而且它不报错、不告警，只在「用户点了忽略、
   * 问题还在」的时候才暴露出来。写入口（`CanvasBoard.persistMapping`）必须用
   * `NodeMatch.designNodeIds` / `appNodeIds`，它们本身就是归一化 id。
   */
  ignoredDesignNodeIds: string[];
  ignoredAppNodeIds: string[];
  matches: NodeMatch[];
  regionOverrides: RegionOverride[];
  updatedAt: string;
}

/**
 * 一对匹配的视觉度量。
 *
 * 三项都可缺省：**缺省表示「这项特征不可用」，不是「差」**。
 * 例如截图为 JPG（解不了 PNG）、节点太小（抗锯齿主导）、或节点是纯布局容器，
 * 都会产出缺省值 —— 调用方据此把该必检项计入 unknown，而不是判它为缺陷。
 */
export interface MatchVisualMetrics {
  /** CIEDE2000 色差（0 = 完全同色） */
  colorDeltaE?: number;
  /** pHash 汉明距离（64 位，越小越像） */
  pHashDistance?: number;
  /** 结构相似度，−1..1 */
  ssim?: number;
  /** 参与比较的裁切边长（像素），用于解释「为什么没判」 */
  sampleSize?: number;
  /** 不可用原因（不可用时不产出任何度量） */
  unavailable?: string;
}

export interface AcceptanceProfile {
  version: '1.0.0';
  geometry: {
    positionTolerance: number;
    sizeTolerance: number;
    gapTolerance: number;
    cornerRadiusTolerance: number;
  };
  text: {
    exact: boolean;
    normalizeWhitespace: boolean;
    caseSensitive: boolean;
    dynamicPatterns: string[];
  };
  requiredChecks: Array<'presence' | 'geometry' | 'text' | 'visual'>;
  failOnCollectionTruncation: boolean;
  /**
   * 匹配策略（§7.1）。
   *
   * - `structure-first`（默认）：L2 → L3a → L3b → L3c，与历史行为完全一致。
   * - `geometry-first`：L2 之后若满足校准门槛，L3c 先行锁定几何高置信对，
   *   L3a/L3b 只处理剩余节点；跨层冲突（同一设计节点被两层锁到不同 App 节点）
   *   置为 `ambiguous` 并保留双方候选，不允许后层静默覆盖。
   */
  match: {
    strategy: 'structure-first' | 'geometry-first';
    calibration: MatchCalibrationConfig;
  };
}

/** L3c 锚点校准定位的可配置门槛（§7.1）。数值含义见 core.ts 里 CALIBRATION_* 常量的注释。 */
export interface MatchCalibrationConfig {
  /** 开启 L3c 的最少文本锚点数（默认 4） */
  minAnchors: number;
  /** 锚点在纵向上最少铺开 px（默认 64） */
  minSpreadPx: number;
  /** 中心曼哈顿距离上限，设计稿 px（默认 28） */
  maxDistance: number;
  /** 次优候选必须比最优远这么多倍才敢锁定（默认 1.6） */
  distanceMargin: number;
  /** 「同一个盒子」判定容差 px（默认 3） */
  twinTolerance: number;
}

export interface AcceptanceIssue {
  id: string;
  category: 'structure' | 'layout' | 'text' | 'color' | 'asset' | 'visual' | 'process';
  severity: 'P0' | 'P1' | 'P2';
  matchId: string | null;
  designNodeIds: string[];
  appNodeIds: string[];
  check: string;
  expected?: unknown;
  actual?: unknown;
  delta?: unknown;
  confidence: number;
  reasonCodes: string[];
  status: 'open' | 'ignored';
}

export interface AcceptanceResult {
  verdict: 'pass' | 'fail' | 'review' | 'blocked';
  /** AI 验收当前停留的阶段；未设置表示传统完整验收结果。 */
  phase?: 'input' | 'segmentation' | 'alignment' | 'complete';
  phaseStatus?: 'completed' | 'failed' | 'input-only';
  source: 'sdk' | 'legacy' | 'unknown';
  coordinateValid: boolean;
  collectionQuality?: CollectionQuality;
  matches: NodeMatch[];
  inputAnalysis?: AcceptanceInputAnalysis;
  regionAnalysis?: {
    engineVersion?: 'ai-region-v1';
    design: PageDocument;
    app: PageDocument;
    candidates?: { design: UiRegion[]; app: UiRegion[] };
    matches: RegionMatch[];
    results: RegionAcceptanceResult[];
    score: number;
    decisions?: AiDecisionRecord[];
    annotations?: Array<Omit<AiAnnotationPage, 'dataUrl'> & {
      kind?: 'original' | 'annotated';
      file?: string;
      url?: string;
      shortIdMap?: Record<string, string>;
    }>;
    ai?: {
      requested: boolean;
      applied: boolean;
      model?: string;
      inputHash?: string;
      decision?: AiRegionDecision;
      error?: string;
    };
  };
  issues: AcceptanceIssue[];
  summary: {
    designNodeCount: number;
    appNodeCount: number;
    matchedCount: number;
    missingCount: number;
    extraCount: number;
    ambiguousCount: number;
    unknownCount: number;
  };
  pixelTransform?: PixelTransformContract;
  readinessReasons?: string[];
  ai?: {
    requested: boolean;
    applied: boolean;
    error?: string;
  };
}

export interface AiRegionDecision {
  regionMatches: Array<{
    designRegionIds: string[];
    appRegionIds: string[];
    relation: RegionRelation;
    probability: number;
    reasonCodes: string[];
  }>;
  observations: RegionObservation[];
  /** The model's text before JSON parsing, retained for diagnostics only. */
  rawOutput?: string;
  finishReason?: string;
}

export interface AiRegionRequest {
  protocol: 'ui-acceptance-region-ai-v1';
  runId: string;
  model: string;
  design: Pick<PageDocument, 'source' | 'width' | 'height' | 'viewport' | 'regions'>;
  app: Pick<PageDocument, 'source' | 'width' | 'height' | 'viewport' | 'regions'>;
  candidates: RegionMatch[];
  crops?: Array<{ regionId: string; source: CanonicalSource; dataUrl: string }>;
  pageImages?: Array<{
    source: CanonicalSource;
    kind?: 'original' | 'annotated';
    page?: number;
    dataUrl: string;
  }>;
}

export interface AcceptanceReadiness {
  ready: boolean;
  reasons: string[];
  source: 'sdk' | 'legacy' | 'unknown';
  nodeCount: number;
  collectionTruncated: boolean;
  coordinateValid: boolean;
  pairId?: string;
}

export interface RunAcceptanceInput {
  pairId: string;
  profile?: Partial<AcceptanceProfile>;
  useAi?: boolean;
}

export interface SaveNodeMappingInput {
  pairId: string;
  mapping: Omit<NodeMapping, 'pairId' | 'updatedAt'>;
}

export interface AcceptanceRunMeta {
  id: string;
  pairId: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  /** Whether this run was started from the AI acceptance flow. */
  useAi?: boolean;
  result?: AcceptanceResult;
  error?: string;
}

/** Lightweight history item; the full report is loaded only after the user selects it. */
export interface AcceptanceRunHistoryItem {
  id: string;
  pairId: string;
  status: AcceptanceRunMeta['status'];
  createdAt: string;
  useAi: boolean;
  phase?: AcceptanceResult['phase'];
  verdict?: AcceptanceResult['verdict'];
  aiApplied?: boolean;
  score?: number;
  summary?: AcceptanceResult['summary'];
  error?: string;
}

export type AcceptanceNodeInput = DesignNode | AppNode;
