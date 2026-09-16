import type { AppNode, DesignNode, Rect } from './verify';
import type { CollectionQuality } from './acceptance';

export type CanonicalSource = 'design' | 'app';
export type CanonicalKind = 'text' | 'image' | 'icon' | 'control' | 'container' | 'unknown';
export type Participation = 'required' | 'optional' | 'context' | 'ignored' | 'unavailable';

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
  visibleRect: Rect | null;
  kind: CanonicalKind;
  participation: Participation;
  visible: boolean;
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
  source: 'sdk' | 'legacy' | 'unknown';
  coordinateValid: boolean;
  collectionQuality?: CollectionQuality;
  matches: NodeMatch[];
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
  readinessReasons?: string[];
  ai?: {
    requested: boolean;
    applied: boolean;
    error?: string;
  };
}

export interface AiMatchCandidate {
  designNodeId: string;
  appNodeIds: string[];
  relation: string;
  probability: number;
  reasonCodes: string[];
}

export interface AiAcceptanceRequest {
  protocol: 'ui-acceptance-ai-v1';
  runId: string;
  model: string;
  design: Array<Pick<CanonicalNode, 'canonicalId' | 'kind' | 'rect' | 'geometry' | 'structure' | 'content' | 'visual'>>;
  app: Array<Pick<CanonicalNode, 'canonicalId' | 'kind' | 'rect' | 'geometry' | 'structure' | 'content' | 'visual'>>;
  candidates: NodeMatch[];
  /**
   * 候选节点的截图裁切（data URL）。
   * 只在配置开启且确实裁出来时才有；缺失不影响仲裁，AI 退回纯特征判断。
   */
  crops?: Array<{ nodeId: string; source: CanonicalSource; dataUrl: string }>;
}

export interface AiAcceptanceResponse {
  candidates: AiMatchCandidate[];
  observations: Array<{
    type: 'missing' | 'extra' | 'layout-difference' | 'visual-difference' | 'unknown';
    designNodeIds: string[];
    appNodeIds: string[];
    evidence: string[];
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
  result?: AcceptanceResult;
  error?: string;
}

export type AcceptanceNodeInput = DesignNode | AppNode;
