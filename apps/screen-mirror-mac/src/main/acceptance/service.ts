/**
 * 验收服务：把「配对」变成「结论」的那一段编排。
 *
 * 链路（严格按 PLAN 的顺序，不跳步）：
 *   定位配对 → 归一化两侧节点 → 规则匹配（含人工锚点/忽略）
 *   → 视觉度量 → AI 仲裁歧义 → 门禁裁决 → 落盘报告
 *
 * 三条工程约束：
 *   1. **两侧几何必须来自同一个 loader**（`store/assets`），否则画布与结论会分叉。
 *   2. **裁决只在 `core.evaluateAcceptance` 里做一次**。本模块只负责「喂证据」，
 *      不自己拼 verdict —— 两处判定迟早给出互相矛盾的结论。
 *   3. **任何失败都要能解释**。AI 挂了、截图解不了、节点被截断，都进 reasons / error，
 *      绝不用「默认通过」把问题盖住。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { nativeImage } from 'electron';

import type {
  AcceptanceReadiness,
  AcceptanceInputAnalysis,
  AcceptanceResult,
  AcceptanceRunMeta,
  AcceptanceRunHistoryItem,
  AiDecisionRecord,
  AiNodeSummary,
  AiVisualSegmentationRequest,
  AiVisualRegionRetryRequest,
  AiAppSegmentationRequest,
  AiDesignSegmentationRequest,
  AiDesignRegionSearchRequest,
  AiRegionNodeMatchRequest,
  AiRegionNodeMatchResponse,
  AiRegionRequest,
  AiAdjudicationReviewer,
  CanonicalDocument,
  MatchVisualMetrics,
  NodeMapping,
  NodeMatch,
  RegionAcceptanceResult,
  RunAcceptanceInput,
  SaveNodeMappingInput,
  UiRegion,
  RegionMatch,
} from '../../types/aiAcceptance';
import type { AppSnapshotMeta, DesignAssetMeta, MatchPairMeta, Rect } from '../../types/verify';
import type { GroundTruth, SaveGroundTruthInput } from '../../types/groundTruth';

import { canonicalizeApp, canonicalizeDesign, evaluateAcceptance, filterMeaningfulNodes, matchDocuments, adjudicateResult } from './core';
import {
  arbitrateRegions,
  locateDesignRegions,
  loadAiConfig,
  matchRegionNodesWithAi,
  PAGE_AI_MIN_TIMEOUT_MS,
  REGION_NODE_AI_MIN_TIMEOUT_MS,
  segmentRegions,
  segmentAppRegions,
  segmentDesignRegions,
  validateAiRegionDecision,
  validateAiRegionNodeMatches,
  validateAiAppSegmentation,
  validateAiDesignSegmentation,
  validateAiDesignRegionSearch,
  validateAiVisualSegmentation,
  segmentVisualRegions,
  retryVisualRegion,
  type AiConfig,
} from './ai';
import { buildPageAnnotations, buildRegionAnnotations, type RegionAnnotationSet } from './annotation';
import { decodePng, type RasterImage } from './png';
import {
  buildRegionNodeCandidates,
  buildPageDocument,
  applyRegionOverrides,
  evaluateRegions,
  matchNodesWithinRegions,
  matchRegions,
  mergeAiRegionAlignment,
  regionPageScore,
  validateRegionProposals,
  resolveRegionNode,
} from './regions';
import {
  readGroundTruth,
  readMapping,
  readReport,
  readRunHistory,
  writeGroundTruth,
  writeMapping,
  writeReport,
} from './store';
import {
  averageColor,
  cropRaster,
  deltaE00,
  dominantColor,
  hammingDistance,
  MIN_VISUAL_CROP_PX,
  pHash,
  rgbToLab,
  ssim,
  toGray,
  toComparableGray,
} from './visuals';
import { appScreenshotPath, designScreenshotPath, loadAppNodes, loadDesignNodes } from '../store/assets';
import { acceptanceArtifactsDir } from '../store/paths';
import { assetUrl } from '../protocol';
import { createId, listRequirements, timestamp } from '../store/workspace';

/** 视觉比较的统一尺度：两张裁切都缩到它再比，规避像素密度差异 */
const VISUAL_COMPARE_SIZE = 32;
/**
 * Keep a complete long screenshot while staying below common multimodal image
 * dimension limits. Coordinates remain normalized, so this resize does not
 * change the page-space region returned to the resolver.
 */
const VISUAL_SEGMENTATION_MAX_DIMENSION = 4096;

function transportImageSize(image: RasterImage): { width: number; height: number; scale: number } {
  const longest = Math.max(image.width, image.height);
  const scale = longest > VISUAL_SEGMENTATION_MAX_DIMENSION
    ? VISUAL_SEGMENTATION_MAX_DIMENSION / longest
    : 1;
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
    scale,
  };
}

function visualImageSummary(image: RasterImage): NonNullable<AiDecisionRecord['inputSummary']> {
  const size = transportImageSize(image);
  return {
    imageCount: 1,
    imageWidth: size.width,
    imageHeight: size.height,
    originalImageWidth: image.width,
    originalImageHeight: image.height,
    imageScale: size.scale,
  };
}

// ---------- 就绪判定（纯函数，可直接断言） ----------

/**
 * 判定一次配对「能不能进 AI 验收」。
 *
 * PLAN 的门禁要求「SDK 节点来源不是 react-native-ui-acceptance / 采集被截断 /
 * 坐标无法校准 → 不能 PASS」，这三条在这里统一变成 `ready: false` + 原因码。
 * 之所以要单独做一次，是因为被截断的节点树会被误读成「App 没有这个节点」，
 * 那是**假阴性**，比漏报更危险。
 */
export function evaluateReadiness(input: {
  pairId: string;
  design: DesignAssetMeta | null;
  app: AppSnapshotMeta | null;
  designNodeCount: number;
  appNodeCount: number;
}): AcceptanceReadiness {
  const reasons: string[] = [];
  const { design, app } = input;

  if (!design || !app) reasons.push('PAIR_INCOMPLETE');
  if (design && (design.width <= 0 || design.height <= 0)) reasons.push('DESIGN_SIZE_INVALID');
  if (app && (app.width <= 0 || app.height <= 0)) reasons.push('APP_SIZE_INVALID');

  const source: AcceptanceReadiness['source'] = app ? (app.source === 'sdk' ? 'sdk' : 'legacy') : 'unknown';
  if (app && app.source !== 'sdk') reasons.push('APP_NODE_SOURCE_NOT_SDK');

  const collectionTruncated = !!app?.collectionQuality
    && (app.collectionQuality.depthLimitReached || app.collectionQuality.nodeLimitReached);
  if (app && !app.collectionQuality) reasons.push('COLLECTION_QUALITY_MISSING');
  if (app?.collectionQuality && app.collectionQuality.profile !== 'acceptance-full') {
    // 旧快照可能带着 legacy / uiautomator 档位进来；它们的字段是退化的，
    // 拿来做节点级验收只会得到假阴性。
    reasons.push('COLLECTION_PROFILE_NOT_FULL');
  }
  if (collectionTruncated) reasons.push('COLLECTION_TRUNCATED');

  if (design && input.designNodeCount === 0) reasons.push('DESIGN_NODE_TREE_EMPTY');
  if (app && input.appNodeCount === 0) reasons.push('APP_NODE_TREE_EMPTY');

  const coordinateValid = !!design && !!app
    && design.width > 0 && design.height > 0 && app.width > 0 && app.height > 0;

  return {
    ready: reasons.length === 0,
    reasons,
    source,
    nodeCount: input.appNodeCount,
    collectionTruncated,
    coordinateValid,
    pairId: input.pairId,
  };
}

// ---------- 服务 ----------

interface LocatedPair {
  requirementId: string;
  pair: MatchPairMeta;
  design: DesignAssetMeta;
  app: AppSnapshotMeta;
}

export interface AcceptanceService {
  getReadiness(pairId: string): Promise<AcceptanceReadiness>;
  runAcceptance(input: RunAcceptanceInput): Promise<AcceptanceRunMeta>;
  getRun(input: { requirementId: string; runId: string }): Promise<AcceptanceRunMeta | null>;
  getHistory(pairId: string): Promise<AcceptanceRunHistoryItem[]>;
  getMapping(pairId: string): Promise<NodeMapping | null>;
  saveMapping(input: SaveNodeMappingInput): Promise<NodeMapping>;
  /**
   * 人工标注的读写。
   *
   * 与 mapping **刻意分家**：mapping 是喂给引擎的输入，标注是引擎算得对不对的答案。
   * 唯一共用的是「按 pairId 反查需求」这一步（`locatePair`）——
   * 两套数据住在同一个需求目录下，定位逻辑再写一遍只会多一个出错的地方。
   *
   * 导出（`exportGroundTruth`）不在这里，与 `exportPairDebug` 同理：
   * 它是一次性的旁路产物，不参与验收链路，也就不需要进服务对象。
   */
  getGroundTruth(pairId: string): Promise<GroundTruth | null>;
  saveGroundTruth(input: SaveGroundTruthInput): Promise<GroundTruth>;
}

export interface AcceptanceServiceDeps {
  loadConfig?: () => Promise<AiConfig | null>;
  arbitrateRegions?: typeof arbitrateRegions;
  segmentRegions?: typeof segmentRegions;
  segmentAppRegions?: typeof segmentAppRegions;
  segmentDesignRegions?: typeof segmentDesignRegions;
  segmentVisualRegions?: typeof segmentVisualRegions;
  retryVisualRegion?: typeof retryVisualRegion;
  locateDesignRegions?: typeof locateDesignRegions;
  matchRegionNodes?: typeof matchRegionNodesWithAi;
  decodeImage?: (file: string) => Promise<RasterImage | null>;
  /**
   * §7.4 VLM 终裁 reviewer（main 侧注入，不走 IPC）。
   * 缺省 = 不做终裁，保持纯规则语义（`adjudication.applied=false`）。
   */
  adjudicationReviewer?: AiAdjudicationReviewer;
}

async function locatePair(pairId: string): Promise<LocatedPair | null> {
  const all = await listRequirements();
  for (const requirement of all) {
    const pair = requirement.pairs.find((item) => item.id === pairId);
    if (!pair) continue;
    const design = requirement.designAssets.find((asset) => asset.id === pair.designAssetId);
    const app = requirement.appSnapshots.find((snapshot) => snapshot.id === pair.appSnapshotId);
    // 素材缺失说明索引已经不一致；宁可报错也不要拿半份数据去验收
    if (!design || !app) return null;
    return { requirementId: requirement.id, pair, design, app };
  }
  return null;
}

/** 把 RGBA 光栅转成 data URL（走 Electron 的 PNG 编码，避免自己写编码器） */
function rasterToDataUrl(raster: RasterImage, maxDimension?: number): string | null {
  try {
    const bgra = Buffer.alloc(raster.width * raster.height * 4);
    for (let index = 0; index < raster.width * raster.height; index += 1) {
      const source = index * 4;
      bgra[source] = raster.data[source + 2]!;
      bgra[source + 1] = raster.data[source + 1]!;
      bgra[source + 2] = raster.data[source]!;
      bgra[source + 3] = raster.data[source + 3]!;
    }
    const image = nativeImage.createFromBitmap(bgra, { width: raster.width, height: raster.height });
    if (image.isEmpty()) return null;
    if (!maxDimension || Math.max(raster.width, raster.height) <= maxDimension) return image.toDataURL();
    const ratio = maxDimension / Math.max(raster.width, raster.height);
    return image.resize({
      width: Math.max(1, Math.round(raster.width * ratio)),
      height: Math.max(1, Math.round(raster.height * ratio)),
      quality: 'good',
    }).toDataURL();
  } catch {
    return null;
  }
}

function rasterToPng(raster: RasterImage): Buffer | null {
  try {
    const bgra = Buffer.alloc(raster.width * raster.height * 4);
    for (let index = 0; index < raster.width * raster.height; index += 1) {
      const source = index * 4;
      bgra[source] = raster.data[source + 2]!;
      bgra[source + 1] = raster.data[source + 1]!;
      bgra[source + 2] = raster.data[source]!;
      bgra[source + 3] = raster.data[source + 3]!;
    }
    const image = nativeImage.createFromBitmap(bgra, { width: raster.width, height: raster.height });
    return image.isEmpty() ? null : image.toPNG();
  } catch {
    return null;
  }
}

interface DesignSearchRasterTile {
  tileId: string;
  rect: { x: number; y: number; width: number; height: number };
  raster: RasterImage;
  dataUrl: string;
}

/**
 * Split a long design image into viewport-sized overlapping tiles. The model
 * receives the tile image, while the tile's logical rect remains in the
 * request so a returned match can be converted back to full-page coordinates.
 */
function buildDesignSearchTiles(
  image: RasterImage,
  designWidth: number,
  designHeight: number,
  appWidth: number,
  appHeight: number,
): DesignSearchRasterTile[] {
  if (designWidth <= 0 || designHeight <= 0 || appWidth <= 0 || appHeight <= 0) return [];
  const scale = image.width / designWidth;
  if (!Number.isFinite(scale) || scale <= 0) return [];
  const viewportHeight = Math.min(designHeight, appHeight * designWidth / appWidth);
  const tileHeight = Math.max(320, viewportHeight);
  const overlap = Math.min(tileHeight * 0.2, Math.max(48, tileHeight * 0.12));
  const step = Math.max(1, tileHeight - overlap);
  const tiles: DesignSearchRasterTile[] = [];
  let y = 0;
  let index = 0;
  while (y < designHeight - 0.5 && index < 64) {
    const height = Math.min(tileHeight, designHeight - y);
    const raster = cropRaster(image, { x: 0, y, width: designWidth, height }, scale);
    const dataUrl = raster ? rasterToDataUrl(raster, 1536) : null;
    if (raster && dataUrl) {
      tiles.push({
        tileId: `design-tile-${String(index + 1).padStart(3, '0')}`,
        rect: { x: 0, y, width: designWidth, height },
        raster,
        dataUrl,
      });
    }
    if (y + height >= designHeight - 0.5) break;
    y = Math.min(designHeight - tileHeight, y + step);
    index += 1;
  }
  return tiles;
}

function inputHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function aiRequestSummary(input: {
  protocol: string;
  model: string;
  payloadKeys: string[];
  imageLabels: string[];
}): NonNullable<AiDecisionRecord['requestSummary']> {
  return {
    protocol: input.protocol,
    model: input.model,
    messageCount: 2,
    contentPartTypes: ['text', ...input.imageLabels.flatMap(() => ['text', 'image_url'])],
    payloadKeys: input.payloadKeys,
    imageLabels: input.imageLabels,
  };
}

function aiResponseSummary(
  value: unknown,
  status: NonNullable<AiDecisionRecord['responseSummary']>['status'] = 'parsed',
  error?: string,
  rawOutput?: string,
): NonNullable<AiDecisionRecord['responseSummary']> {
  const root = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const arrayLengths = root
    ? Object.fromEntries(Object.entries(root).filter(([key, item]) => key !== 'rawOutput' && Array.isArray(item)).map(([key, item]) => [key, (item as unknown[]).length]))
    : {};
  const modelOutput = rawOutput ?? (root && typeof root.rawOutput === 'string' ? root.rawOutput : undefined);
  const finishReason = root && typeof root.finishReason === 'string' ? root.finishReason : undefined;
  const maxOutputLength = 24000;
  return {
    status,
    contentLength: modelOutput?.length ?? (value === undefined ? undefined : JSON.stringify(value).length),
    rootKeys: root ? Object.keys(root).filter((key) => key !== 'rawOutput') : [],
    arrayLengths,
    ...(finishReason ? { finishReason } : {}),
    ...(modelOutput ? {
      actualOutput: modelOutput.slice(0, maxOutputLength),
      actualOutputTruncated: modelOutput.length > maxOutputLength,
    } : {}),
    ...(error ? { error } : {}),
  };
}

function aiErrorMessage(error: unknown, stage: string, timeoutMs: number): string {
  const message = (error as Error).message || String(error);
  return (error as Error).name === 'AbortError' || /operation was aborted|\babort(?:ed)?\b|timeout/i.test(message)
    ? `${stage}超时（${Math.round(timeoutMs / 1000)} 秒）`
    : message;
}

function aiRawOutput(error: unknown): string | undefined {
  const value = error && typeof error === 'object' ? (error as { rawOutput?: unknown }).rawOutput : undefined;
  return typeof value === 'string' ? value : undefined;
}

function aiFinishReason(error: unknown): string | undefined {
  const value = error && typeof error === 'object' ? (error as { finishReason?: unknown }).finishReason : undefined;
  return typeof value === 'string' ? value : undefined;
}

async function resolveAiDecision<T>(input: {
  stage: AiDecisionRecord['stage'];
  model: string;
  promptVersion: string;
  inputHash: string;
  validate: (value: unknown) => T;
  invoke: () => Promise<T>;
}): Promise<{ output: T; cacheHit: boolean }> {
  const output = input.validate(await input.invoke());
  return { output, cacheHit: false };
}

function validateVisualSegmentationResponse(
  value: unknown,
): Awaited<ReturnType<typeof segmentVisualRegions>> {
  const validated = validateAiVisualSegmentation(value);
  const raw = value && typeof value === 'object' ? value as {
    rawOutput?: unknown;
    finishReason?: unknown;
  } : {};
  return {
    ...validated,
    ...(typeof raw.rawOutput === 'string' ? { rawOutput: raw.rawOutput } : {}),
    ...(typeof raw.finishReason === 'string' ? { finishReason: raw.finishReason } : {}),
  };
}

function aiNodeSummaries(
  nodes: CanonicalDocument['nodes'],
  allowedIds?: ReadonlySet<string>,
  shortIds?: ReadonlyMap<string, string>,
): AiNodeSummary[] {
  return nodes.filter((node) => node.visible && node.participation !== 'ignored')
    .filter((node) => !allowedIds || allowedIds.has(node.canonicalId))
    .sort((first, second) => {
      const firstPriority = first.participation === 'required' ? 0 : 1;
      const secondPriority = second.participation === 'required' ? 0 : 1;
      return firstPriority - secondPriority || first.rect.y - second.rect.y || first.rect.x - second.rect.x;
    })
    .slice(0, 120)
    .map((node) => ({
      id: node.canonicalId,
      ...(shortIds?.get(node.canonicalId) ? { shortId: shortIds.get(node.canonicalId) } : {}),
      kind: node.kind,
      rect: node.rect,
      visibleRect: node.visibleRect,
      text: node.content.rawText,
      depth: node.depth,
      childCount: node.structure.childCount,
      participation: node.participation,
    }));
}

function aiNodeSummariesFromAnnotations(
  nodes: CanonicalDocument['nodes'],
  annotations: RegionAnnotationSet | null,
): AiNodeSummary[] {
  if (!annotations) return aiNodeSummaries(nodes);
  const byId = new Map(nodes.map((node) => [node.canonicalId, node]));
  return annotations.nodes.flatMap((annotated) => {
    const node = byId.get(annotated.canonicalId);
    return node ? [{
      id: node.canonicalId,
      shortId: annotated.shortId,
      kind: node.kind,
      rect: node.rect,
      visibleRect: node.visibleRect,
      text: node.content.rawText,
      depth: node.depth,
      childCount: node.structure.childCount,
      participation: node.participation,
    } satisfies AiNodeSummary] : [];
  });
}

function mergeRegions(regions: readonly UiRegion[]): UiRegion | null {
  if (regions.length === 0) return null;
  const x = Math.min(...regions.map((region) => region.rect.x));
  const y = Math.min(...regions.map((region) => region.rect.y));
  const right = Math.max(...regions.map((region) => region.rect.x + region.rect.width));
  const bottom = Math.max(...regions.map((region) => region.rect.y + region.rect.height));
  const visibleRects = regions.map((region) => region.visibleRect).filter((rect): rect is NonNullable<typeof rect> => !!rect);
  const visibleX = visibleRects.length > 0 ? Math.min(...visibleRects.map((rect) => rect.x)) : x;
  const visibleY = visibleRects.length > 0 ? Math.min(...visibleRects.map((rect) => rect.y)) : y;
  const visibleRight = visibleRects.length > 0 ? Math.max(...visibleRects.map((rect) => rect.x + rect.width)) : right;
  const visibleBottom = visibleRects.length > 0 ? Math.max(...visibleRects.map((rect) => rect.y + rect.height)) : bottom;
  const first = regions[0]!;
  return {
    ...first,
    id: regions.map((region) => region.id).join('+'),
    rect: { x, y, width: right - x, height: bottom - y },
    visibleRect: { x: visibleX, y: visibleY, width: visibleRight - visibleX, height: visibleBottom - visibleY },
    nodeIds: [...new Set(regions.flatMap((region) => region.nodeIds))],
    childRegionIds: [...new Set(regions.flatMap((region) => region.childRegionIds))],
    text: [...new Set(regions.flatMap((region) => region.text))],
    confidence: Math.min(...regions.map((region) => region.confidence)),
    reasonCodes: [...new Set(regions.flatMap((region) => region.reasonCodes ?? []))],
  };
}

function applyRegionNodeResponse(input: {
  matches: NodeMatch[];
  response: AiRegionNodeMatchResponse;
  designAnnotations: RegionAnnotationSet;
  appAnnotations: RegionAnnotationSet;
  candidates: Array<{ designNodeId: string; appNodeIds: string[]; scores: number[] }>;
}): { matches: NodeMatch[]; applied: number } {
  const lockedDesign = new Set(input.matches.filter((match) => match.status === 'matched')
    .flatMap((match) => match.designNodeIds));
  const lockedApp = new Set(input.matches.filter((match) => match.status === 'matched')
    .flatMap((match) => match.appNodeIds));
  const candidateByDesign = new Map(input.candidates.map((candidate) => [candidate.designNodeId, candidate]));
  const additions: NodeMatch[] = [];
  const replacedDesign = new Set<string>();
  const replacedApp = new Set<string>();

  for (const item of input.response.matches) {
    if (item.designShortIds.length === 0 || item.appShortIds.length === 0 || item.probability < 0.7) continue;
    const designNodeIds = item.designShortIds.map((id) => input.designAnnotations.shortToCanonical.get(id)!).filter(Boolean);
    const appNodeIds = item.appShortIds.map((id) => input.appAnnotations.shortToCanonical.get(id)!).filter(Boolean);
    if (designNodeIds.length !== item.designShortIds.length || appNodeIds.length !== item.appShortIds.length) continue;
    if (designNodeIds.some((id) => lockedDesign.has(id) || replacedDesign.has(id))) continue;
    if (appNodeIds.some((id) => lockedApp.has(id) || replacedApp.has(id))) continue;
    const scores = designNodeIds.flatMap((designId) => {
      const candidate = candidateByDesign.get(designId);
      if (!candidate) return [];
      return appNodeIds.map((appId) => {
        const index = candidate.appNodeIds.indexOf(appId);
        return index >= 0 ? candidate.scores[index]! : 0;
      });
    });
    const geometryGate = scores.length > 0 ? Math.max(...scores) : 0;
    const auto = item.probability >= 0.9 && geometryGate >= 0.5 && item.relation !== 'ambiguous';
    additions.push({
      id: `ai-region-node:${designNodeIds.join('+')}:${appNodeIds.join('+')}`,
      designNodeIds,
      appNodeIds,
      relation: item.relation,
      source: 'ai',
      origin: 'ai',
      ruleScore: geometryGate,
      aiScore: item.probability,
      confidence: auto ? item.probability : Math.min(item.probability, 0.89),
      margin: 0,
      evidence: {
        geometry: geometryGate,
        visual: item.reasonCodes.some((code) => /visual|image|icon/i.test(code)) ? item.probability : geometryGate,
        relation: item.probability,
        content: item.reasonCodes.some((code) => /text|semantic|content/i.test(code)) ? item.probability : 0.5,
        structure: geometryGate,
        kind: 0.7,
      },
      status: auto ? 'matched' : 'ambiguous',
    });
    designNodeIds.forEach((id) => replacedDesign.add(id));
    appNodeIds.forEach((id) => replacedApp.add(id));
  }
  const retained = input.matches.filter((match) => match.status === 'matched'
    || (!match.designNodeIds.some((id) => replacedDesign.has(id)) && !match.appNodeIds.some((id) => replacedApp.has(id))));
  return { matches: [...retained, ...additions], applied: additions.length };
}

export function createAcceptanceService(deps: AcceptanceServiceDeps = {}): AcceptanceService {
  const loadConfig = deps.loadConfig ?? (() => loadAiConfig());
  const runRegionArbitration = deps.arbitrateRegions ?? arbitrateRegions;
  const runAppSegmentation = deps.segmentAppRegions ?? segmentAppRegions;
  const runDesignSegmentation = deps.segmentDesignRegions ?? segmentDesignRegions;
  const runVisualSegmentation = deps.segmentVisualRegions ?? segmentVisualRegions;
  const runVisualRegionRetry = deps.retryVisualRegion ?? retryVisualRegion;
  const runDesignRegionSearch = deps.locateDesignRegions ?? locateDesignRegions;
  const runRegionNodeMatching = deps.matchRegionNodes ?? matchRegionNodesWithAi;
  const decodeImage = deps.decodeImage ?? (async (file: string) => {
    try {
      return decodePng(await readFile(file));
    } catch {
      return null;
    }
  });

  /** 截图解码很贵（1080×2340 的 PNG 解一次约 10MB），按路径缓存 */
  const imageCache = new Map<string, RasterImage | null>();

  async function decodeCached(file: string): Promise<RasterImage | null> {
    if (imageCache.has(file)) return imageCache.get(file) ?? null;
    const image = await decodeImage(file);
    imageCache.set(file, image);
    return image;
  }

  async function computeVisuals(params: {
    requirementId: string;
    design: DesignAssetMeta;
    app: AppSnapshotMeta;
    designDocument: CanonicalDocument;
    appDocument: CanonicalDocument;
    matches: NodeMatch[];
  }): Promise<Map<string, MatchVisualMetrics>> {
    const metrics = new Map<string, MatchVisualMetrics>();
    const [designImage, appImage] = await Promise.all([
      decodeCached(designScreenshotPath(params.requirementId, params.design)),
      decodeCached(appScreenshotPath(params.requirementId, params.app)),
    ]);
    if (!designImage || !appImage) return metrics;

    // 缩放系数从**实际位图宽 / 逻辑宽**反推，而不是信 exportScale 元数据：
    // 元数据与真实文件不一致时，反推仍然能得到正确的裁切区域。
    const designScale = params.design.width > 0 ? designImage.width / params.design.width : 0;
    const appScale = params.app.width > 0 ? appImage.width / params.app.width : 0;
    if (designScale <= 0 || appScale <= 0) return metrics;

    const designById = new Map(params.designDocument.nodes.map((node) => [node.canonicalId, node]));
    const appById = new Map(params.appDocument.nodes.map((node) => [node.canonicalId, node]));

    for (const match of params.matches) {
      if (match.status === 'missing' || match.status === 'extra') continue;
      const designNode = match.designNodeIds[0] ? designById.get(match.designNodeIds[0]) : undefined;
      const appNode = match.appNodeIds[0] ? appById.get(match.appNodeIds[0]) : undefined;
      if (!designNode || !appNode) continue;
      // 纯布局容器没有「自己的像素」可比
      if (designNode.participation === 'context') continue;

      const designCrop = cropRaster(designImage, designNode.rect, designScale);
      const appCrop = cropRaster(appImage, appNode.rect, appScale);
      if (!designCrop || !appCrop) {
        metrics.set(match.id, { unavailable: 'crop-failed' });
        continue;
      }
      if (
        Math.min(designCrop.width, designCrop.height) < MIN_VISUAL_CROP_PX ||
        Math.min(appCrop.width, appCrop.height) < MIN_VISUAL_CROP_PX
      ) {
        // 太小的裁切里抗锯齿和压缩噪声占主导，判了也是噪声
        metrics.set(match.id, { unavailable: 'crop-too-small' });
        continue;
      }

      const record: MatchVisualMetrics = { sampleSize: Math.min(designCrop.width, appCrop.width) };

      const designColor = averageColor(designCrop);
      const appColor = averageColor(appCrop);
      if (designColor && appColor) {
        record.colorDeltaE = deltaE00(rgbToLab(designColor), rgbToLab(appColor));
      }

      const designHash = pHash(designCrop);
      const appHash = pHash(appCrop);
      if (designHash && appHash) record.pHashDistance = hammingDistance(designHash, appHash);

      const designGray = toComparableGray(designCrop, VISUAL_COMPARE_SIZE);
      const appGray = toComparableGray(appCrop, VISUAL_COMPARE_SIZE);
      if (designGray && appGray) {
        const score = ssim(designGray, appGray, VISUAL_COMPARE_SIZE);
        if (score !== null) record.ssim = score;
      }

      if (record.colorDeltaE === undefined && record.pHashDistance === undefined && record.ssim === undefined) {
        metrics.set(match.id, { unavailable: 'no-metric' });
      } else {
        metrics.set(match.id, record);
      }
    }

    return metrics;
  }

  function edgeDensity(raster: RasterImage): number {
    const gray = toGray(raster);
    let edges = 0;
    let samples = 0;
    const step = Math.max(1, Math.floor(Math.max(raster.width, raster.height) / 256));
    for (let y = step; y < raster.height; y += step) {
      for (let x = step; x < raster.width; x += step) {
        const value = gray[y * raster.width + x]!;
        const left = gray[y * raster.width + x - step]!;
        const top = gray[(y - step) * raster.width + x]!;
        if (Math.abs(value - left) + Math.abs(value - top) >= 48) edges += 1;
        samples += 1;
      }
    }
    return samples === 0 ? 0 : edges / samples;
  }

  async function enrichRegionVisuals(page: ReturnType<typeof buildPageDocument>): Promise<RasterImage | null> {
    const image = await decodeCached(page.screenshot.file);
    if (!image) return null;
    const scale = page.width > 0 ? image.width / page.width : 0;
    for (const region of page.regions) {
      const crop = cropRaster(image, region.visibleRect ?? region.rect, scale);
      if (!crop) continue;
      const color = dominantColor(crop);
      const hash = pHash(crop);
      region.visualFeatures = {
        ...region.visualFeatures,
        ...(color ? { dominantColor: color } : {}),
        ...(hash ? { pHash: hash } : {}),
        edgeDensity: edgeDensity(crop),
      };
    }
    return image;
  }

  async function buildRegionCrops(
    page: ReturnType<typeof buildPageDocument>,
    regionIds: ReadonlySet<string>,
    image: RasterImage | null,
  ): Promise<NonNullable<AiRegionRequest['crops']>> {
    if (!image) return [];
    const scale = page.width > 0 ? image.width / page.width : 0;
    const crops: NonNullable<AiRegionRequest['crops']> = [];
    for (const region of page.regions) {
      if (!regionIds.has(region.id)) continue;
      const crop = cropRaster(image, region.visibleRect ?? region.rect, scale);
      const dataUrl = crop ? rasterToDataUrl(crop) : null;
      if (dataUrl) crops.push({ regionId: region.id, source: page.source, dataUrl });
    }
    return crops;
  }

  const MAX_VISUAL_REGION_RETRIES = 3;

  function proposalRect(proposal: { leftTop: { x: number; y: number }; rightBottom: { x: number; y: number } }): Rect {
    return {
      x: proposal.leftTop.x,
      y: proposal.leftTop.y,
      width: proposal.rightBottom.x - proposal.leftTop.x,
      height: proposal.rightBottom.y - proposal.leftTop.y,
    };
  }

  function pageProposal(source: 'design' | 'app', proposal: {
    proposalId: string;
    leftTop: { x: number; y: number };
    rightBottom: { x: number; y: number };
    confidence?: number;
    reasonCodes?: string[];
  }) {
    const rect = proposalRect(proposal);
    return {
      proposalId: proposal.proposalId,
      source,
      role: 'unknown' as const,
      normalizedRect: rect,
      layout: 'unknown' as const,
      fixed: false,
      scrollable: false,
      confidence: proposal.confidence ?? 1,
      reasonCodes: proposal.reasonCodes ?? [],
    };
  }

  function paddedRetryRect(rect: Rect, page: ReturnType<typeof buildPageDocument>): Rect {
    const horizontal = Math.max(rect.width * 0.5, 16 / Math.max(1, page.width));
    const vertical = Math.max(rect.height * 0.5, 16 / Math.max(1, page.height));
    const x = Math.max(0, rect.x - horizontal);
    const y = Math.max(0, rect.y - vertical);
    const right = Math.min(1, rect.x + rect.width + horizontal);
    const bottom = Math.min(1, rect.y + rect.height + vertical);
    return { x, y, width: right - x, height: bottom - y };
  }

  function relativeRect(rect: Rect, imageRect: Rect): Rect {
    return {
      x: (rect.x - imageRect.x) / Math.max(1e-9, imageRect.width),
      y: (rect.y - imageRect.y) / Math.max(1e-9, imageRect.height),
      width: rect.width / Math.max(1e-9, imageRect.width),
      height: rect.height / Math.max(1e-9, imageRect.height),
    };
  }

  function proposalInPage(proposal: {
    leftTop: { x: number; y: number };
    rightBottom: { x: number; y: number };
  }, imageRect: Rect) {
    return {
      leftTop: {
        x: imageRect.x + proposal.leftTop.x * imageRect.width,
        y: imageRect.y + proposal.leftTop.y * imageRect.height,
      },
      rightBottom: {
        x: imageRect.x + proposal.rightBottom.x * imageRect.width,
        y: imageRect.y + proposal.rightBottom.y * imageRect.height,
      },
    };
  }

  async function resolveVisualRegions(
    page: ReturnType<typeof buildPageDocument>,
    image: RasterImage | null,
    source: 'design' | 'app',
    dataUrl: string | null,
    config: AiConfig | null,
    runId: string,
    decisions: AiDecisionRecord[],
    aiErrors: string[],
    saveRetryArtifact: (input: {
      source: 'design' | 'app';
      regionId: string;
      page: number;
      raster: RasterImage;
    }) => Promise<void>,
  ): Promise<{ applied: boolean; regions: UiRegion[] }> {
    page.regions = [];
    if (!config || !image || !dataUrl) {
      const reason = !config ? 'Endpoint 或 API key 未配置' : '页面截图不可用';
      aiErrors.push(`AI ${source === 'app' ? 'App' : '设计稿'}页面分区未执行：${reason}`);
      decisions.push({
        stage: 'segmentation', model: config?.model ?? 'not-configured',
        promptVersion: 'visual-segmentation-v1', inputHash: inputHash({ runId, source, reason }),
        status: 'not-submitted', latencyMs: 0, error: reason,
        inputSummary: { imageCount: 0 },
        requestSummary: {
          protocol: 'ui-acceptance-visual-segmentation-v1', model: config?.model ?? 'not-configured',
          payloadKeys: ['protocol', 'runId', 'model', 'source', 'image'],
          imageLabels: [],
        },
        responseSummary: aiResponseSummary(undefined, 'schema-rejected', '未发起请求'),
      });
      return { applied: false, regions: [] };
    }

    const baseRequest: AiVisualSegmentationRequest = {
      protocol: 'ui-acceptance-visual-segmentation-v1', runId, model: config.model, source,
      image: (() => {
        const { width, height } = transportImageSize(image);
        return { width, height, dataUrl };
      })(),
    };
    const baseHash = inputHash({
      protocol: baseRequest.protocol, runId, model: config.model, source,
      width: image.width, height: image.height, image: inputHash(dataUrl),
    });
    const started = Date.now();
    try {
      const initial = await resolveAiDecision({
        stage: 'segmentation', model: config.model, promptVersion: 'visual-segmentation-v1',
        inputHash: baseHash,
        validate: (value) => {
          // The real client validates before returning, but injected clients and
          // replayed decisions must pass through the same coordinate gate too.
          return validateVisualSegmentationResponse(value);
        },
        invoke: () => runVisualSegmentation(config, baseRequest),
      });
      decisions.push({
        stage: 'segmentation', model: config.model, promptVersion: 'visual-segmentation-v1',
        inputHash: baseHash, status: 'accepted', latencyMs: Date.now() - started,
        cacheHit: false, output: initial.output,
        inputSummary: visualImageSummary(image),
        requestSummary: {
          protocol: baseRequest.protocol, model: config.model,
          payloadKeys: ['protocol', 'runId', 'model', 'source', 'image'],
          imageLabels: [`${source}:original`],
        },
        responseSummary: aiResponseSummary(initial.output),
      });

      const accepted: UiRegion[] = [];
      for (const visualProposal of initial.output.regions) {
        let current = visualProposal;
        let currentRect = proposalRect(current);
        const retryHistory: NonNullable<UiRegion['aiResolution']>['retryHistory'] = [];
        let resolvedRegion: UiRegion | null = null;
        let resolvedNode = resolveRegionNode(page, current);
        let attempt = 1;

        while (!resolvedNode.nodeId && attempt <= MAX_VISUAL_REGION_RETRIES) {
          retryHistory.push({ attempt, rect: currentRect, status: 'not-found', reason: 'node-not-found' });
          const imageRect = paddedRetryRect(currentRect, page);
          const logicalCrop = {
            x: imageRect.x * page.width,
            y: imageRect.y * page.height,
            width: imageRect.width * page.width,
            height: imageRect.height * page.height,
          };
          const crop = cropRaster(image, logicalCrop, image.width / Math.max(1, page.width));
          const cropDataUrl = crop ? rasterToDataUrl(crop, VISUAL_SEGMENTATION_MAX_DIMENSION) : null;
          if (!crop || !cropDataUrl) break;
          const retryImageSize = transportImageSize(crop);
          await saveRetryArtifact({
            source,
            regionId: `${source}-visual-retry-${current.proposalId}`,
            page: attempt,
            raster: crop,
          });
          const retryRequest: AiVisualRegionRetryRequest = {
            protocol: 'ui-acceptance-visual-region-retry-v1', runId, model: config.model, source,
            image: { width: retryImageSize.width, height: retryImageSize.height, dataUrl: cropDataUrl },
            imageRect,
            previousRegion: {
              leftTop: { x: relativeRect(currentRect, imageRect).x, y: relativeRect(currentRect, imageRect).y },
              rightBottom: {
                x: relativeRect(currentRect, imageRect).x + relativeRect(currentRect, imageRect).width,
                y: relativeRect(currentRect, imageRect).y + relativeRect(currentRect, imageRect).height,
              },
            },
            failureReason: 'node-not-found',
          };
          const retryHash = inputHash({
            protocol: retryRequest.protocol, runId, source, attempt, imageRect,
            previousRegion: retryRequest.previousRegion, image: inputHash(cropDataUrl),
          });
          const retryStarted = Date.now();
          try {
            const retried = validateVisualSegmentationResponse(await runVisualRegionRetry(config, retryRequest));
            const next = retried.regions[0];
            if (!next) throw new Error('AI 区域重划分未返回模块');
            const mapped = proposalInPage(next, imageRect);
            current = { ...next, proposalId: current.proposalId, leftTop: mapped.leftTop, rightBottom: mapped.rightBottom };
            currentRect = proposalRect(current);
            resolvedNode = resolveRegionNode(page, current);
            retryHistory[retryHistory.length - 1]!.status = resolvedNode.nodeId ? 'matched' : 'not-found';
            decisions.push({
              stage: 'segmentation', model: config.model, promptVersion: 'visual-region-retry-v1',
              inputHash: retryHash, status: 'accepted', latencyMs: Date.now() - retryStarted,
              cacheHit: false, output: retried,
              inputSummary: visualImageSummary(crop),
              requestSummary: {
                protocol: retryRequest.protocol, model: config.model,
                payloadKeys: ['protocol', 'runId', 'model', 'source', 'image', 'imageRect', 'previousRegion', 'failureReason'],
                imageLabels: [`${source}:retry:${attempt}`],
              },
              responseSummary: aiResponseSummary(retried),
            });
            attempt += 1;
          } catch (error) {
            const message = aiErrorMessage(error, `AI ${source === 'app' ? 'App' : '设计稿'}区域重划分`, Math.max(config.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
            aiErrors.push(message);
            decisions.push({
              stage: 'segmentation', model: config.model, promptVersion: 'visual-region-retry-v1',
              inputHash: retryHash, status: /abort|timeout|超时/i.test(message) ? 'timeout' : 'error',
              latencyMs: Date.now() - retryStarted, error: message,
              inputSummary: visualImageSummary(crop),
              requestSummary: {
                protocol: retryRequest.protocol, model: config.model,
                payloadKeys: ['protocol', 'runId', 'model', 'source', 'image', 'imageRect', 'previousRegion', 'failureReason'],
                imageLabels: [`${source}:retry:${attempt}`],
              },
              responseSummary: {
                ...aiResponseSummary(undefined, /JSON|解析|property/i.test(message) ? 'invalid-json' : 'schema-rejected', message, aiRawOutput(error)),
                ...(aiFinishReason(error) ? { finishReason: aiFinishReason(error) } : {}),
              },
            });
            break;
          }
        }

        const proposal = pageProposal(source, current);
        const regions = validateRegionProposals(page, [proposal], []);
        resolvedRegion = regions[0] ?? null;
        if (!resolvedRegion) continue;
        // `validateRegionProposals` is intentionally reusable for one proposal,
        // so it starts numbering at 001 each time. Reassign the stable page
        // sequence here after the complete visual-resolution loop.
        resolvedRegion.id = `${source}-region-${String(accepted.length + 1).padStart(3, '0')}`;
        resolvedRegion.order = accepted.length;
        const matched = !!resolvedNode.nodeId;
        resolvedRegion.aiResolution = {
          proposalId: visualProposal.proposalId,
          attempt,
          status: matched ? 'matched' : 'unknown',
          nodeId: resolvedNode.nodeId,
          retryHistory,
        };
        accepted.push(resolvedRegion);
      }
      page.regions = accepted;
      return { applied: accepted.length > 0, regions: accepted };
    } catch (error) {
      const message = aiErrorMessage(error, `AI ${source === 'app' ? 'App' : '设计稿'}页面分区`, Math.max(config.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
      aiErrors.push(message);
      decisions.push({
        stage: 'segmentation', model: config.model, promptVersion: 'visual-segmentation-v1',
        inputHash: baseHash, status: /abort|timeout|超时/i.test(message) ? 'timeout' : 'error',
        latencyMs: Date.now() - started, error: message,
        inputSummary: visualImageSummary(image),
        requestSummary: {
          protocol: baseRequest.protocol, model: config.model,
          payloadKeys: ['protocol', 'runId', 'model', 'source', 'image'],
          imageLabels: [`${source}:original`],
        },
        responseSummary: {
          ...aiResponseSummary(undefined, /JSON|解析|property/i.test(message) ? 'invalid-json' : 'schema-rejected', message, aiRawOutput(error)),
          ...(aiFinishReason(error) ? { finishReason: aiFinishReason(error) } : {}),
        },
      });
      return { applied: false, regions: [] };
    }
  }

  async function loadPairContext(located: LocatedPair) {
    const [designNodes, appNodes, mapping] = await Promise.all([
      loadDesignNodes(located.requirementId, located.design),
      loadAppNodes(located.requirementId, located.app),
      readMapping(located.requirementId, located.pair.id),
    ]);
    return {
      designNodes,
      appNodes,
      mapping,
      designDocument: canonicalizeDesign(designNodes, located.design.width, located.design.height),
      appDocument: canonicalizeApp(
        appNodes,
        located.app.width,
        located.app.height,
        located.app.pixelWidth,
        located.app.pixelHeight,
      ),
    };
  }

  return {
    async getReadiness(pairId: string): Promise<AcceptanceReadiness> {
      const located = await locatePair(pairId);
      if (!located) {
        return {
          ready: false,
          reasons: ['PAIR_NOT_FOUND'],
          source: 'unknown',
          nodeCount: 0,
          collectionTruncated: false,
          coordinateValid: false,
          pairId,
        };
      }
      const [designNodes, appNodes] = await Promise.all([
        loadDesignNodes(located.requirementId, located.design),
        loadAppNodes(located.requirementId, located.app),
      ]);
      return evaluateReadiness({
        pairId,
        design: located.design,
        app: located.app,
        designNodeCount: designNodes.length,
        appNodeCount: appNodes.length,
      });
    },

    async runAcceptance(input: RunAcceptanceInput): Promise<AcceptanceRunMeta> {
      const runId = createId();
      const meta: AcceptanceRunMeta = {
        id: runId,
        pairId: input.pairId,
        status: 'running',
        createdAt: timestamp(),
        useAi: input.useAi === true,
      };

      const located = await locatePair(input.pairId);
      if (!located) {
        return { ...meta, status: 'failed', error: `配对不存在或素材缺失：${input.pairId}` };
      }

      try {
        const context = await loadPairContext(located);
        const readiness = evaluateReadiness({
          pairId: input.pairId,
          design: located.design,
          app: located.app,
          designNodeCount: context.designNodes.length,
          appNodeCount: context.appNodes.length,
        });

        const designPage = buildPageDocument(
          context.designDocument,
          { file: designScreenshotPath(located.requirementId, located.design), pixelWidth: located.design.pixelWidth, pixelHeight: located.design.pixelHeight },
          context.appDocument,
          { includeRegions: !input.useAi },
        );
        const appPage = buildPageDocument(
          context.appDocument,
          { file: appScreenshotPath(located.requirementId, located.app), pixelWidth: located.app.pixelWidth, pixelHeight: located.app.pixelHeight },
          context.designDocument,
          { includeRegions: !input.useAi },
        );
        const [designImage, appImage] = await Promise.all([
          input.useAi ? decodeCached(designPage.screenshot.file) : enrichRegionVisuals(designPage),
          input.useAi ? decodeCached(appPage.screenshot.file) : enrichRegionVisuals(appPage),
        ]);
        const ruleCandidates = {
          design: designPage.regions.map((region) => ({ ...region })),
          app: appPage.regions.map((region) => ({ ...region })),
        };
        const decisions: AiDecisionRecord[] = [];
        const annotationMeta: NonNullable<NonNullable<AcceptanceResult['regionAnalysis']>['annotations']> = [];
        const artifactDir = acceptanceArtifactsDir(located.requirementId, runId);
        let artifactDirReady = false;
        const saveAnnotationArtifact = async (input: {
          source: 'design' | 'app';
          regionId: string;
          page: number;
          kind: 'original' | 'annotated';
          raster: RasterImage;
          nodeShortIds: string[];
          shortIdMap?: Record<string, string>;
        }): Promise<string | null> => {
          const png = rasterToPng(input.raster);
          if (!png) return null;
          try {
            if (!artifactDirReady) {
              await mkdir(artifactDir, { recursive: true });
              artifactDirReady = true;
            }
            const safeRegion = input.regionId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const suffix = input.kind === 'original'
              ? (input.page > 0 ? `page-${input.page}-original` : 'original')
              : `page-${input.page}`;
            const fileName = `${input.source}-${safeRegion}-${suffix}.png`;
            const file = path.join(artifactDir, fileName);
            await writeFile(file, png);
            const url = assetUrl(located.requirementId, 'report', runId, fileName);
            annotationMeta.push({
              source: input.source,
              regionId: input.regionId,
              page: input.page,
              nodeShortIds: input.nodeShortIds,
              kind: input.kind,
              file,
              url,
              ...(input.shortIdMap ? { shortIdMap: input.shortIdMap } : {}),
            });
            return url;
          } catch (error) {
            console.warn('[acceptance] AI 标注图保存失败（本次验收仍然继续）：', error);
            return null;
          }
        };
        const saveRetryArtifact = async (input: {
          source: 'design' | 'app';
          regionId: string;
          page: number;
          raster: RasterImage;
        }): Promise<void> => {
          await saveAnnotationArtifact({
            ...input,
            kind: 'original',
            nodeShortIds: [],
          });
        };

        // Current milestone: generate only the filtered input evidence. Keep
        // this branch before AI config loading and all region work so this
        // phase cannot accidentally submit a segmentation request.
        if (input.useAi) {
          const designFiltered = filterMeaningfulNodes(context.designDocument);
          const appFiltered = filterMeaningfulNodes(context.appDocument);
          const inputAnnotations: AcceptanceInputAnalysis['annotations'] = [];

          const saveInputAnnotation = async (
            source: 'design' | 'app',
            image: RasterImage | null,
            page: ReturnType<typeof buildPageDocument>,
            filtered: ReturnType<typeof filterMeaningfulNodes>,
          ): Promise<void> => {
            if (!image) return;
            const annotations = buildPageAnnotations(image, { ...page, regions: [] }, {
              nodePolicy: 'meaningful',
              nodeIds: new Set(filtered.retainedNodes.map((node) => node.canonicalId)),
              maxNodes: Number.POSITIVE_INFINITY,
              maxDimension: null,
            });
            const shortIdMap = Object.fromEntries(annotations.nodes.map((node) => [node.shortId, node.canonicalId]));
            const nodeIds = annotations.nodes.map((node) => node.canonicalId);
            const originalUrl = await saveAnnotationArtifact({
              source,
              regionId: `${source}-input-page`,
              page: 0,
              kind: 'original',
              raster: image,
              nodeShortIds: [],
            });
            if (originalUrl) {
              const artifact = annotationMeta.find((item) => item.source === source
                && item.regionId === `${source}-input-page` && item.page === 0 && item.kind === 'original');
              inputAnnotations.push({ source, kind: 'original', url: originalUrl, file: artifact?.file, nodeIds, shortIdMap });
            }

            const annotated = annotations.pages[0];
            if (!annotated) return;
            const annotatedUrl = await saveAnnotationArtifact({
              source,
              regionId: `${source}-input-page`,
              page: 1,
              kind: 'annotated',
              raster: annotated.raster,
              nodeShortIds: annotated.nodeShortIds,
              shortIdMap,
            });
            if (annotatedUrl) {
              const artifact = annotationMeta.find((item) => item.source === source
                && item.regionId === `${source}-input-page` && item.page === 1 && item.kind === 'annotated');
              inputAnnotations.push({ source, kind: 'annotated', url: annotatedUrl, file: artifact?.file, nodeIds, shortIdMap });
            }
          };

          await Promise.all([
            saveInputAnnotation('design', designImage, designPage, designFiltered),
            saveInputAnnotation('app', appImage, appPage, appFiltered),
          ]);

          const inputAnalysis: AcceptanceInputAnalysis = {
            design: designFiltered,
            app: appFiltered,
            annotations: inputAnnotations,
          };
          const annotationsReady = (['design', 'app'] as const).every((source) =>
            inputAnnotations.some((annotation) => annotation.source === source && annotation.kind === 'original')
            && inputAnnotations.some((annotation) => annotation.source === source && annotation.kind === 'annotated'),
          );
          const inputStageReady = readiness.ready
            && readiness.coordinateValid
            && designFiltered.retainedNodeCount > 0
            && appFiltered.retainedNodeCount > 0
            && !!designImage
            && !!appImage
            && annotationsReady;
          const stageResult = evaluateAcceptance({
            design: context.designDocument,
            app: context.appDocument,
            matches: [],
            source: readiness.source,
            coordinateValid: readiness.coordinateValid,
            collectionQuality: located.app.collectionQuality,
            profile: input.profile,
            // This milestone intentionally does not submit an AI request. Do
            // not pass "requested but unavailable" into the generic verdict
            // evaluator, otherwise it would report an AI outage for an
            // intentionally unsubmitted phase.
            ai: { requested: false, applied: false },
          });
          stageResult.verdict = 'review';
          stageResult.phase = 'input';
          stageResult.phaseStatus = inputStageReady ? 'completed' : 'failed';
          stageResult.inputAnalysis = inputAnalysis;
          stageResult.summary = {
            ...stageResult.summary,
            designNodeCount: designFiltered.retainedNodeCount,
            appNodeCount: appFiltered.retainedNodeCount,
          };
          stageResult.ai = {
            requested: true,
            applied: false,
            error: inputStageReady ? '当前仅完成输入与门禁，未提交 AI' : '输入与门禁阶段失败，未提交 AI',
          };
          stageResult.issues.push({
            id: 'acceptance:input-phase',
            category: 'process',
            severity: inputStageReady ? 'P2' : 'P1',
            matchId: null,
            designNodeIds: [],
            appNodeIds: [],
            check: 'ai-acceptance-input-phase',
            expected: 'filtered-nodes-and-annotations-ready',
            actual: inputStageReady ? 'input-stage-completed' : 'input-stage-failed',
            confidence: inputStageReady ? 1 : 0,
            reasonCodes: [inputStageReady ? 'AI_PHASE_INPUT_ONLY' : 'AI_INPUT_PHASE_FAILED'],
            status: 'open',
          });
          meta.result = stageResult;
          meta.status = 'completed';
          await writeReport(located.requirementId, meta).catch((error: unknown) => {
            console.warn('[acceptance] 输入阶段报告落盘失败（内存结果仍然可用）：', error);
          });
          return meta;
        }
        const regionObservationMap = new Map<string, RegionAcceptanceResult['observations']>();
        const regionObservationStatus = new Map<string, RegionAcceptanceResult['status']>();
        const aiConfig = input.useAi ? await loadConfig() : null;
        const aiErrors: string[] = [];
        let segmentationApplied = false;
        let alignmentApplied = false;
        let alignmentDecision: NonNullable<NonNullable<AcceptanceResult['regionAnalysis']>['ai']>['decision'];
        let regionAi: NonNullable<NonNullable<AcceptanceResult['regionAnalysis']>['ai']> | undefined;
        const pageImages: NonNullable<AiRegionRequest['pageImages']> = [];
        // Build sparse layout evidence for the request metadata and for the
        // post-segmentation debug artifacts. The segmentation model itself only
        // receives clean screenshots, so labels cannot bias its module bounds.
        const appPageAnnotations = appImage
          ? buildPageAnnotations(appImage, appPage, { nodePolicy: 'layout-blocks', maxDimension: null })
          : null;
        const designPageAnnotations = designImage
          ? buildPageAnnotations(designImage, designPage, { nodePolicy: 'layout-blocks', maxDimension: null })
          : null;
        const designPageImage = designImage ? rasterToDataUrl(designImage, VISUAL_SEGMENTATION_MAX_DIMENSION) : null;
        const appPageImage = appImage ? rasterToDataUrl(appImage, VISUAL_SEGMENTATION_MAX_DIMENSION) : null;
        if (input.useAi) {
          if (designImage) await saveAnnotationArtifact({
            source: 'design', regionId: 'design-segmentation-page', page: 0, kind: 'original',
            raster: designImage, nodeShortIds: [],
          });
          if (appImage) await saveAnnotationArtifact({
            source: 'app', regionId: 'app-segmentation-page', page: 0, kind: 'original',
            raster: appImage, nodeShortIds: [],
          });
          if (designPageAnnotations?.pages[0]) await saveAnnotationArtifact({
            source: 'design', regionId: 'design-segmentation-page', page: 1, kind: 'annotated',
            raster: designPageAnnotations.pages[0].raster,
            nodeShortIds: designPageAnnotations.pages[0].nodeShortIds,
            shortIdMap: Object.fromEntries(designPageAnnotations.nodes.map((node) => [node.shortId, node.canonicalId])),
          });
          if (appPageAnnotations?.pages[0]) await saveAnnotationArtifact({
            source: 'app', regionId: 'app-segmentation-page', page: 1, kind: 'annotated',
            raster: appPageAnnotations.pages[0].raster,
            nodeShortIds: appPageAnnotations.pages[0].nodeShortIds,
            shortIdMap: Object.fromEntries(appPageAnnotations.nodes.map((node) => [node.shortId, node.canonicalId])),
          });
        }
        // Full-page images remain available for later phases. The first AI call
        // deliberately receives only the App viewport; a long design image is
        // never allowed to bias the App module boundaries.
        if (appPageImage) pageImages.push({ source: 'app', kind: 'original', dataUrl: appPageImage });
        if (designPageImage) pageImages.push({ source: 'design', kind: 'original', dataUrl: designPageImage });

        let regionMatches: RegionMatch[] = [];
        let appSegmentationApplied = false;
        let designSegmentationApplied = false;
        const useIndependentRegionSegmentation = true;
        const usePureVisualSegmentation = true;
        if (input.useAi) {
          if (usePureVisualSegmentation) {
            designPage.regions = [];
            appPage.regions = [];
            regionAi = { requested: true, applied: false, ...(aiConfig ? { model: aiConfig.model } : {}) };
            const [appVisual, designVisual] = await Promise.all([
              resolveVisualRegions(appPage, appImage, 'app', appPageImage, aiConfig, runId, decisions, aiErrors, saveRetryArtifact),
              resolveVisualRegions(designPage, designImage, 'design', designPageImage, aiConfig, runId, decisions, aiErrors, saveRetryArtifact),
            ]);
            appSegmentationApplied = appVisual.applied;
            designSegmentationApplied = designVisual.applied;
            segmentationApplied = appSegmentationApplied && designSegmentationApplied;
            regionAi.applied = segmentationApplied;
          } else if (useIndependentRegionSegmentation) {
            designPage.regions = [];
            appPage.regions = [];
            // Keep the historical App request isolated. The design screenshot is
            // intentionally absent so its layout cannot change App granularity.
            const appSegmentationRequest: AiAppSegmentationRequest = {
              protocol: 'ui-acceptance-app-segmentation-ai-v1',
              runId,
              model: aiConfig?.model ?? 'not-submitted',
              app: {
                width: appPage.width,
                height: appPage.height,
                viewport: appPage.viewport,
                nodes: aiNodeSummariesFromAnnotations(appPage.nodes, appPageAnnotations),
                candidates: ruleCandidates.app.map((region) => ({
                  ...region, nodeIds: region.nodeIds.slice(0, 40), text: region.text.slice(0, 20),
                })),
              },
              pageImages: appPageImage ? [{ source: 'app', kind: 'original', dataUrl: appPageImage }] : [],
            };
            const designSegmentationRequest: AiDesignSegmentationRequest = {
              protocol: 'ui-acceptance-design-segmentation-ai-v1',
              runId,
              model: aiConfig?.model ?? 'not-submitted',
              design: {
                width: designPage.width,
                height: designPage.height,
                viewport: designPage.viewport,
                nodes: aiNodeSummariesFromAnnotations(designPage.nodes, designPageAnnotations),
                candidates: ruleCandidates.design.map((region) => ({
                  ...region, nodeIds: region.nodeIds.slice(0, 40), text: region.text.slice(0, 20),
                })),
              },
              pageImages: designPageImage ? [{ source: 'design', kind: 'original', dataUrl: designPageImage }] : [],
            };
            const appHash = inputHash({
              protocol: appSegmentationRequest.protocol,
              app: appSegmentationRequest.app,
              images: appSegmentationRequest.pageImages.map((image) => inputHash(image.dataUrl)),
            });
            const designHash = inputHash({
              protocol: designSegmentationRequest.protocol,
              design: designSegmentationRequest.design,
              images: designSegmentationRequest.pageImages.map((image) => inputHash(image.dataUrl)),
            });
            const appInputSummary = {
              appRegionCount: appSegmentationRequest.app.candidates.length,
              appNodeCount: appSegmentationRequest.app.nodes.length,
              nodePolicy: 'layout-blocks' as const,
              candidateCount: appSegmentationRequest.app.candidates.length,
              imageCount: appSegmentationRequest.pageImages.length,
            };
            const designInputSummary = {
              designRegionCount: designSegmentationRequest.design.candidates.length,
              designNodeCount: designSegmentationRequest.design.nodes.length,
              nodePolicy: 'layout-blocks' as const,
              candidateCount: designSegmentationRequest.design.candidates.length,
              imageCount: designSegmentationRequest.pageImages.length,
            };
            regionAi = { requested: true, applied: false, ...(aiConfig ? { model: aiConfig.model } : {}) };
            if (!aiConfig) {
              aiErrors.push('AI 页面分区未执行：未配置 AI');
              decisions.push({
                stage: 'segmentation', model: 'not-configured', promptVersion: 'app-segmentation-v1',
                inputHash: appHash, status: 'error', latencyMs: 0,
                error: 'Endpoint 或 API key 未配置', inputSummary: appInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: appSegmentationRequest.protocol, model: 'not-configured',
                  payloadKeys: Object.keys(appSegmentationRequest),
                  imageLabels: appSegmentationRequest.pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                }),
                responseSummary: aiResponseSummary(undefined, 'schema-rejected', '未发起请求'),
              });
              decisions.push({
                stage: 'segmentation', model: 'not-configured', promptVersion: 'design-segmentation-v1',
                inputHash: designHash, status: 'error', latencyMs: 0,
                error: 'Endpoint 或 API key 未配置', inputSummary: designInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: designSegmentationRequest.protocol, model: 'not-configured',
                  payloadKeys: Object.keys(designSegmentationRequest),
                  imageLabels: designSegmentationRequest.pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                }),
                responseSummary: aiResponseSummary(undefined, 'schema-rejected', '未发起请求'),
              });
            } else {
              const appStarted = Date.now();
              try {
                const resolved = await resolveAiDecision({
                  stage: 'segmentation', model: aiConfig.model, promptVersion: 'app-segmentation-v1',
                  inputHash: appHash,
                  validate: (value) => {
                    const response = validateAiAppSegmentation(value);
                    if (response.appRegions.length === 0) throw new Error('AI App 页面分区未返回模块');
                    return response;
                  },
                  invoke: () => runAppSegmentation(aiConfig, appSegmentationRequest),
                });
                const appRegions = validateRegionProposals(appPage, resolved.output.appRegions, ruleCandidates.app);
                if (appRegions.length === 0) throw new Error('AI App 分区坐标校验后没有可用模块');
                appPage.regions = appRegions;
                appSegmentationApplied = true;
                decisions.push({
                  stage: 'segmentation', model: aiConfig.model, promptVersion: 'app-segmentation-v1',
                  inputHash: appHash, status: 'accepted', latencyMs: Date.now() - appStarted,
                  cacheHit: resolved.cacheHit, output: resolved.output,
                  inputSummary: appInputSummary,
                  requestSummary: aiRequestSummary({
                    protocol: appSegmentationRequest.protocol, model: aiConfig.model,
                    payloadKeys: Object.keys(appSegmentationRequest),
                    imageLabels: appSegmentationRequest.pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                  }),
                  responseSummary: aiResponseSummary(resolved.output),
                });
              } catch (error) {
                const message = aiErrorMessage(error, 'AI App 页面分区', Math.max(aiConfig.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
                aiErrors.push(`AI App 页面分区失败：${message}`);
                decisions.push({
                  stage: 'segmentation', model: aiConfig.model, promptVersion: 'app-segmentation-v1',
                  inputHash: appHash, status: /abort|timeout|超时/i.test(message) ? 'timeout' : 'error',
                  latencyMs: Date.now() - appStarted, error: message,
                  inputSummary: appInputSummary,
                  requestSummary: aiRequestSummary({
                    protocol: appSegmentationRequest.protocol, model: aiConfig.model,
                    payloadKeys: Object.keys(appSegmentationRequest),
                    imageLabels: appSegmentationRequest.pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                  }),
                  responseSummary: {
                    ...aiResponseSummary(undefined, /JSON|解析|property/i.test(message) ? 'invalid-json' : 'schema-rejected', message, aiRawOutput(error)),
                    ...(aiFinishReason(error) ? { finishReason: aiFinishReason(error) } : {}),
                  },
                });
              }

              const designStarted = Date.now();
              try {
                const resolved = await resolveAiDecision({
                  stage: 'segmentation', model: aiConfig.model, promptVersion: 'design-segmentation-v1',
                  inputHash: designHash,
                  validate: (value) => {
                    const response = validateAiDesignSegmentation(value);
                    if (response.designRegions.length === 0) throw new Error('AI 设计稿页面分区未返回模块');
                    return response;
                  },
                  invoke: () => runDesignSegmentation(aiConfig, designSegmentationRequest),
                });
                const designRegions = validateRegionProposals(designPage, resolved.output.designRegions, ruleCandidates.design);
                if (designRegions.length === 0) throw new Error('AI 设计稿分区坐标校验后没有可用模块');
                designPage.regions = designRegions;
                designSegmentationApplied = true;
                decisions.push({
                  stage: 'segmentation', model: aiConfig.model, promptVersion: 'design-segmentation-v1',
                  inputHash: designHash, status: 'accepted', latencyMs: Date.now() - designStarted,
                  cacheHit: resolved.cacheHit, output: resolved.output,
                  inputSummary: designInputSummary,
                  requestSummary: aiRequestSummary({
                    protocol: designSegmentationRequest.protocol, model: aiConfig.model,
                    payloadKeys: Object.keys(designSegmentationRequest),
                    imageLabels: designSegmentationRequest.pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                  }),
                  responseSummary: aiResponseSummary(resolved.output),
                });
              } catch (error) {
                const message = aiErrorMessage(error, 'AI 设计稿页面分区', Math.max(aiConfig.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
                aiErrors.push(`AI 设计稿页面分区失败：${message}`);
                decisions.push({
                  stage: 'segmentation', model: aiConfig.model, promptVersion: 'design-segmentation-v1',
                  inputHash: designHash, status: /abort|timeout|超时/i.test(message) ? 'timeout' : 'error',
                  latencyMs: Date.now() - designStarted, error: message,
                  inputSummary: designInputSummary,
                  requestSummary: aiRequestSummary({
                    protocol: designSegmentationRequest.protocol, model: aiConfig.model,
                    payloadKeys: Object.keys(designSegmentationRequest),
                    imageLabels: designSegmentationRequest.pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                  }),
                  responseSummary: {
                    ...aiResponseSummary(undefined, /JSON|解析|property/i.test(message) ? 'invalid-json' : 'schema-rejected', message, aiRawOutput(error)),
                    ...(aiFinishReason(error) ? { finishReason: aiFinishReason(error) } : {}),
                  },
                });
              }
              segmentationApplied = appSegmentationApplied && designSegmentationApplied;
            }
          } else {
          // AI regions are the only regions shown as active in this staged
          // flow. Rule candidates remain available in `candidates` for review.
          designPage.regions = [];
          const appSegmentationRequest: AiAppSegmentationRequest = {
            protocol: 'ui-acceptance-app-segmentation-ai-v1',
            runId,
            model: aiConfig?.model ?? 'not-submitted',
            app: {
              width: appPage.width,
              height: appPage.height,
              viewport: appPage.viewport,
              nodes: aiNodeSummariesFromAnnotations(appPage.nodes, appPageAnnotations),
              candidates: ruleCandidates.app.map((region) => ({
                ...region, nodeIds: region.nodeIds.slice(0, 40), text: region.text.slice(0, 20),
              })),
            },
            pageImages: appPageImage ? [{ source: 'app', kind: 'original', dataUrl: appPageImage }] : [],
          };
          const appHash = inputHash({
            protocol: appSegmentationRequest.protocol,
            app: appSegmentationRequest.app,
            pageImages: appSegmentationRequest.pageImages.map((image) => inputHash(image.dataUrl)),
          });
          const appInputSummary = {
            appRegionCount: appSegmentationRequest.app.candidates.length,
            appNodeCount: appSegmentationRequest.app.nodes.length,
            nodePolicy: 'layout-blocks' as const,
            candidateCount: appSegmentationRequest.app.candidates.length,
            imageCount: appSegmentationRequest.pageImages.length,
          };
          regionAi = { requested: true, applied: false, ...(aiConfig ? { model: aiConfig.model } : {}) };
          if (!aiConfig) {
            aiErrors.push('AI 页面分区未执行：未配置 AI');
            decisions.push({
              stage: 'segmentation', model: 'not-configured', promptVersion: 'app-segmentation-v1',
              inputHash: appHash, status: 'error', latencyMs: 0,
              error: 'Endpoint 或 API key 未配置', inputSummary: appInputSummary,
              requestSummary: aiRequestSummary({
                protocol: appSegmentationRequest.protocol, model: 'not-configured',
                payloadKeys: Object.keys(appSegmentationRequest),
                imageLabels: appSegmentationRequest.pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
              }),
              responseSummary: aiResponseSummary(undefined, 'schema-rejected', '未发起请求'),
            });
          } else {
            const appStarted = Date.now();
            try {
              const appResolved = await resolveAiDecision({
                stage: 'segmentation', model: aiConfig.model, promptVersion: 'app-segmentation-v1',
                inputHash: appHash,
                validate: (value) => {
                  const response = validateAiAppSegmentation(value);
                  if (response.appRegions.length === 0) throw new Error('AI App 页面分区未返回模块');
                  return response;
                },
                invoke: () => runAppSegmentation(aiConfig, appSegmentationRequest),
              });
              const appRegions = validateRegionProposals(appPage, appResolved.output.appRegions, ruleCandidates.app);
              if (appRegions.length === 0) throw new Error('AI App 分区坐标校验后没有可用模块');
              appPage.regions = appRegions;
              appSegmentationApplied = true;
              decisions.push({
                stage: 'segmentation', model: aiConfig.model, promptVersion: 'app-segmentation-v1',
                inputHash: appHash, status: 'accepted', latencyMs: Date.now() - appStarted,
                cacheHit: appResolved.cacheHit, output: appResolved.output,
                inputSummary: appInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: appSegmentationRequest.protocol, model: aiConfig.model,
                  payloadKeys: Object.keys(appSegmentationRequest),
                  imageLabels: appSegmentationRequest.pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                }),
                responseSummary: aiResponseSummary(appResolved.output),
              });
            } catch (error) {
              const message = aiErrorMessage(error, 'AI App 页面分区', Math.max(aiConfig.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
              aiErrors.push(`AI App 页面分区失败：${message}`);
              decisions.push({
                stage: 'segmentation', model: aiConfig.model, promptVersion: 'app-segmentation-v1',
                inputHash: appHash, status: /abort|timeout|超时/i.test(message) ? 'timeout' : 'error',
                latencyMs: Date.now() - appStarted, error: message,
                inputSummary: appInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: appSegmentationRequest.protocol, model: aiConfig.model,
                  payloadKeys: Object.keys(appSegmentationRequest),
                  imageLabels: appSegmentationRequest.pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                }),
                responseSummary: {
                  ...aiResponseSummary(undefined, /JSON|解析|property/i.test(message) ? 'invalid-json' : 'schema-rejected', message, aiRawOutput(error)),
                  ...(aiFinishReason(error) ? { finishReason: aiFinishReason(error) } : {}),
                },
              });
            }
          }

          // Use the App modules as visual queries against overlapping viewport-sized
          // design tiles. A global design y coordinate is returned by the model.
          if (aiConfig && appSegmentationApplied && appPage.regions.length > 0 && designImage && appPageImage) {
            const designTiles = buildDesignSearchTiles(
              designImage, designPage.width, designPage.height, appPage.width, appPage.height,
            );
            for (const [index, tile] of designTiles.entries()) {
              await saveAnnotationArtifact({
                source: 'design', regionId: 'design-search-tile', page: index, kind: 'original',
                raster: tile.raster, nodeShortIds: [],
              });
            }
            const appRegionCrops = await buildRegionCrops(appPage, new Set(appPage.regions.map((region) => region.id)), appImage);
            const searchPageImages: AiDesignRegionSearchRequest['pageImages'] = [
              { source: 'app', kind: 'original', dataUrl: appPageImage },
              ...appRegionCrops.map((item) => ({ ...item, kind: 'region' as const })),
              ...designTiles.map((tile, index) => ({
                source: 'design' as const,
                kind: 'tile' as const,
                page: index,
                tileId: tile.tileId,
                dataUrl: tile.dataUrl,
              })),
            ];
            const searchRequest: AiDesignRegionSearchRequest = {
              protocol: 'ui-acceptance-design-region-search-ai-v1',
              runId,
              model: aiConfig.model,
              baseline: 'app',
              app: { width: appPage.width, height: appPage.height, regions: appPage.regions },
              design: {
                width: designPage.width,
                height: designPage.height,
                viewport: designPage.viewport,
                tiles: designTiles.map((tile) => ({ tileId: tile.tileId, rect: tile.rect })),
              },
              pageImages: searchPageImages,
            };
            const searchHash = inputHash({
              protocol: searchRequest.protocol,
              app: searchRequest.app,
              design: searchRequest.design,
              images: searchPageImages.map((image) => ({
                source: image.source, kind: image.kind, regionId: image.regionId, tileId: image.tileId, hash: inputHash(image.dataUrl),
              })),
            });
            const searchInputSummary = {
              appRegionCount: searchRequest.app.regions.length,
              appNodeCount: searchRequest.app.regions.reduce((sum, region) => sum + region.nodeIds.length, 0),
              designRegionCount: designTiles.length,
              candidateCount: searchRequest.app.regions.length,
              imageCount: searchPageImages.length,
            };
            const searchStarted = Date.now();
            try {
              const searchResolved = await resolveAiDecision({
                stage: 'segmentation', model: aiConfig.model, promptVersion: 'design-region-search-v2',
                inputHash: searchHash,
                validate: (value) => {
                  const response = validateAiDesignRegionSearch(value, new Set(appPage.regions.map((region) => region.id)));
                  if (response.matches.length === 0) throw new Error('AI 长设计稿定位未返回模块匹配');
                  return response;
                },
                invoke: () => runDesignRegionSearch(aiConfig, searchRequest),
              });
              const designProposals = searchResolved.output.matches
                .filter((match) => match.designNormalizedRect && match.status !== 'not-found')
                .map((match) => {
                  const appRegion = appPage.regions.find((region) => region.id === match.appRegionId);
                  return {
                    appRegionId: match.appRegionId,
                    appOrder: appRegion?.order ?? Number.MAX_SAFE_INTEGER,
                    proposal: {
                      proposalId: `design-for-${match.appRegionId}`,
                      source: 'design' as const,
                      role: appRegion?.role ?? 'unknown',
                      normalizedRect: match.designNormalizedRect!,
                      layout: appRegion?.layout ?? 'unknown',
                      fixed: appRegion?.fixed ?? false,
                      scrollable: appRegion?.scrollable ?? false,
                      confidence: match.probability,
                      reasonCodes: match.reasonCodes,
                    },
                  };
                });
              const validatedDesignRegions = validateRegionProposals(
                designPage,
                designProposals.map((item) => item.proposal),
                ruleCandidates.design,
              );
              const usedDesignIds = new Set<string>();
              const designByAppId = new Map<string, UiRegion>();
              for (const binding of designProposals) {
                const rect = binding.proposal.normalizedRect;
                const candidate = validatedDesignRegions.find((region) => !usedDesignIds.has(region.id)
                  && Math.abs(region.rect.x - rect.x * designPage.width) < 1
                  && Math.abs(region.rect.y - rect.y * designPage.height) < 1
                  && Math.abs(region.rect.width - rect.width * designPage.width) < 1
                  && Math.abs(region.rect.height - rect.height * designPage.height) < 1);
                if (candidate) {
                  usedDesignIds.add(candidate.id);
                  designByAppId.set(binding.appRegionId, candidate);
                }
              }
              designPage.regions = validatedDesignRegions;
              const appById = new Map(appPage.regions.map((region) => [region.id, region]));
              regionMatches = searchResolved.output.matches.map((match, index): RegionMatch => {
                const designRegion = designByAppId.get(match.appRegionId);
                const appRegion = appById.get(match.appRegionId);
                const status: RegionMatch['status'] = match.status === 'not-found'
                  ? 'missing'
                  : match.status === 'matched' && match.probability >= 0.85 && designRegion ? 'matched' : 'ambiguous';
                return {
                  id: `ai-design-search-match:${index + 1}`,
                  origin: 'ai',
                  designRegionIds: designRegion ? [designRegion.id] : [],
                  appRegionIds: appRegion ? [appRegion.id] : [],
                  relation: match.status === 'not-found' ? 'missing' : 'one_to_one',
                  confidence: match.probability,
                  evidence: {
                    role: designRegion && appRegion && designRegion.role === appRegion.role ? 1 : 0.5,
                    geometry: designRegion ? 1 : 0,
                    text: 0.5,
                    visual: match.probability,
                    structure: designRegion ? 1 : 0,
                    order: 0.5,
                  },
                  status,
                };
              });
              segmentationApplied = validatedDesignRegions.length > 0 && regionMatches.some((match) => match.status === 'matched' || match.status === 'ambiguous');
              regionAi.applied = segmentationApplied;
              decisions.push({
                stage: 'segmentation', model: aiConfig.model, promptVersion: 'design-region-search-v2',
                inputHash: searchHash, status: 'accepted', latencyMs: Date.now() - searchStarted,
                cacheHit: searchResolved.cacheHit, output: searchResolved.output,
                inputSummary: searchInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: searchRequest.protocol, model: aiConfig.model,
                  payloadKeys: Object.keys(searchRequest),
                  imageLabels: searchPageImages.map((image) => `${image.source}:${image.kind ?? 'original'}${image.tileId ? `:${image.tileId}` : ''}`),
                }),
                responseSummary: aiResponseSummary(searchResolved.output),
              });
            } catch (error) {
              const message = aiErrorMessage(error, 'AI 长设计稿定位', Math.max(aiConfig.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
              aiErrors.push(`AI 长设计稿定位失败：${message}`);
              decisions.push({
                stage: 'segmentation', model: aiConfig.model, promptVersion: 'design-region-search-v2',
                inputHash: searchHash, status: /abort|timeout|超时/i.test(message) ? 'timeout' : 'error',
                latencyMs: Date.now() - searchStarted, error: message,
                inputSummary: searchInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: searchRequest.protocol, model: aiConfig.model,
                  payloadKeys: Object.keys(searchRequest),
                  imageLabels: searchPageImages.map((image) => `${image.source}:${image.kind ?? 'original'}${image.tileId ? `:${image.tileId}` : ''}`),
                }),
                responseSummary: {
                  ...aiResponseSummary(undefined, /JSON|解析|property/i.test(message) ? 'invalid-json' : 'schema-rejected', message, aiRawOutput(error)),
                  ...(aiFinishReason(error) ? { finishReason: aiFinishReason(error) } : {}),
                },
              });
            }
          } else if (aiConfig && appPage.regions.length === 0) {
            aiErrors.push('AI 长设计稿定位未执行：App 没有可用模块');
          }
        }
        }

        regionMatches = matchRegions(designPage, appPage);
        if (input.useAi && aiConfig && segmentationApplied) {
          const allDesignIds = new Set(designPage.regions.map((region) => region.id));
          const allAppIds = new Set(appPage.regions.map((region) => region.id));
          const alignmentRequest: AiRegionRequest = {
            protocol: 'ui-acceptance-region-ai-v1',
            runId,
            model: aiConfig.model,
            design: { source: 'design', width: designPage.width, height: designPage.height, viewport: designPage.viewport, regions: designPage.regions },
            app: { source: 'app', width: appPage.width, height: appPage.height, viewport: appPage.viewport, regions: appPage.regions },
            candidates: regionMatches,
            pageImages,
            crops: [
              ...await buildRegionCrops(designPage, allDesignIds, designImage),
              ...await buildRegionCrops(appPage, allAppIds, appImage),
            ],
          };
          const alignmentHash = inputHash({
            design: alignmentRequest.design,
            app: alignmentRequest.app,
            candidates: alignmentRequest.candidates,
            imageHashes: [...pageImages, ...(alignmentRequest.crops ?? [])].map((image) => inputHash(image.dataUrl)),
          });
          const alignmentScope = {
            label: '全页面区域',
            designRegionIds: designPage.regions.map((region) => region.id),
            appRegionIds: appPage.regions.map((region) => region.id),
          };
          const alignmentInputSummary = {
            designRegionCount: designPage.regions.length,
            appRegionCount: appPage.regions.length,
            candidateCount: alignmentRequest.candidates.length,
            imageCount: pageImages.length + (alignmentRequest.crops?.length ?? 0),
          };
          const started = Date.now();
          try {
            const resolved = await resolveAiDecision({
              stage: 'alignment', model: aiConfig.model, promptVersion: 'alignment-v1',
              inputHash: alignmentHash,
              validate: (value) => {
                const candidate = validateAiRegionDecision(value, allDesignIds, allAppIds);
                const coveredDesign = new Set(candidate.regionMatches.flatMap((match) => match.designRegionIds));
                const coveredApp = new Set(candidate.regionMatches.flatMap((match) => match.appRegionIds));
                if (coveredDesign.size !== allDesignIds.size || coveredApp.size !== allAppIds.size) {
                  throw new Error(`AI 区域对齐不完整：design ${coveredDesign.size}/${allDesignIds.size}，app ${coveredApp.size}/${allAppIds.size}`);
                }
                return candidate;
              },
              invoke: () => runRegionArbitration(aiConfig, alignmentRequest),
            });
            alignmentDecision = resolved.output;
            regionMatches = mergeAiRegionAlignment(designPage, appPage, regionMatches, alignmentDecision);
            alignmentApplied = alignmentDecision.regionMatches.length > 0;
            if (!alignmentApplied) throw new Error('AI 未返回区域对齐关系');
            decisions.push({
              stage: 'alignment', model: aiConfig.model, promptVersion: 'alignment-v1',
                inputHash: alignmentHash, status: 'accepted', latencyMs: Date.now() - started,
                cacheHit: resolved.cacheHit, output: alignmentDecision,
                scope: alignmentScope, inputSummary: alignmentInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: alignmentRequest.protocol, model: aiConfig.model,
                  payloadKeys: Object.keys(alignmentRequest),
                  imageLabels: [
                    ...pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                    ...(alignmentRequest.crops ?? []).map((image) => `${image.source}:region:${image.regionId}`),
                  ],
                }),
                responseSummary: aiResponseSummary(alignmentDecision),
            });
          } catch (error) {
            const message = aiErrorMessage(error, 'AI 区域对齐', Math.max(aiConfig.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
            aiErrors.push(`AI 区域对齐失败：${message}`);
            decisions.push({
              stage: 'alignment', model: aiConfig.model, promptVersion: 'alignment-v1',
                inputHash: alignmentHash, status: /abort|timeout|超时/i.test(message) ? 'timeout' : 'error',
                latencyMs: Date.now() - started, error: message,
                scope: alignmentScope, inputSummary: alignmentInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: alignmentRequest.protocol, model: aiConfig.model,
                  payloadKeys: Object.keys(alignmentRequest),
                  imageLabels: [
                    ...pageImages.map((image) => `${image.source}:${image.kind ?? 'original'}`),
                    ...(alignmentRequest.crops ?? []).map((image) => `${image.source}:region:${image.regionId}`),
                  ],
                }),
                responseSummary: {
                  ...aiResponseSummary(undefined, /JSON|解析|property/i.test(message) ? 'invalid-json' : 'schema-rejected', message, aiRawOutput(error)),
                  ...(aiFinishReason(error) ? { finishReason: aiFinishReason(error) } : {}),
                },
            });
          }
        }

        // The staged AI workflow currently stops after both-side segmentation
        // and region alignment. Node matching and visual review remain for the
        // next phase, but the alignment result is already persisted and shown.
        if (input.useAi && useIndependentRegionSegmentation) {
          const regionStageCompleted = segmentationApplied && alignmentApplied;
          const phase = alignmentApplied ? 'alignment' : 'segmentation';
          const stageResult = evaluateAcceptance({
            design: context.designDocument,
            app: context.appDocument,
            matches: [],
            source: readiness.source,
            coordinateValid: readiness.coordinateValid,
            collectionQuality: located.app.collectionQuality,
            profile: input.profile,
            windowSizeMismatch: !!located.app.coordinateInset,
            ai: { requested: true, applied: regionStageCompleted },
          });
          stageResult.phase = phase;
          stageResult.phaseStatus = regionStageCompleted ? 'completed' : 'failed';
          if (stageResult.verdict !== 'blocked') stageResult.verdict = 'review';
          stageResult.issues.push({
            id: 'acceptance:region-phase',
            category: 'process',
            severity: regionStageCompleted ? 'P2' : 'P1',
            matchId: null,
            designNodeIds: [],
            appNodeIds: [],
            check: 'ai-acceptance-phase',
            expected: 'segmentation-and-region-alignment',
            actual: regionStageCompleted ? 'region-alignment-completed' : 'region-phase-failed',
            confidence: regionStageCompleted ? 1 : 0,
            reasonCodes: [regionStageCompleted ? 'AI_PHASE_REGION_ALIGNMENT_ONLY' : 'AI_REGION_PHASE_FAILED'],
            status: 'open',
          });
          stageResult.regionAnalysis = {
            engineVersion: 'ai-region-v1',
            design: designPage,
            app: appPage,
            candidates: ruleCandidates,
            matches: regionMatches,
            results: [],
            score: 0,
            decisions,
            annotations: annotationMeta,
            ai: {
              requested: true,
              applied: regionStageCompleted,
              ...(aiConfig ? { model: aiConfig.model } : {}),
              ...(decisions.find((decision) => decision.stage === 'segmentation')?.inputHash
                ? { inputHash: decisions.find((decision) => decision.stage === 'segmentation')!.inputHash }
                : {}),
              ...(alignmentDecision ? { decision: alignmentDecision } : {}),
              ...(!regionStageCompleted ? { error: aiErrors.join('；') || 'AI 页面区域流程未完整执行' } : {}),
            },
          };
          meta.result = stageResult;
          meta.status = 'completed';
          await writeReport(located.requirementId, meta).catch((error: unknown) => {
            console.warn('[acceptance] 阶段报告落盘失败（内存结果仍然可用）：', error);
          });
          return meta;
        }

        const manualRegions = applyRegionOverrides(
          designPage,
          appPage,
          regionMatches,
          context.mapping?.regionOverrides ?? [],
        );
        regionMatches = manualRegions.matches;
        const effectiveMapping = context.mapping ? {
          ...context.mapping,
          ignoredDesignNodeIds: [...new Set([...context.mapping.ignoredDesignNodeIds, ...manualRegions.ignoredDesignNodeIds])],
          ignoredAppNodeIds: [...new Set([...context.mapping.ignoredAppNodeIds, ...manualRegions.ignoredAppNodeIds])],
        } : undefined;
        const legacyMatches = matchDocuments(context.designDocument, context.appDocument, effectiveMapping, undefined, input.profile);
        let matches = matchNodesWithinRegions({
          design: designPage,
          app: appPage,
          regionMatches,
          baseMatches: legacyMatches,
          mapping: effectiveMapping,
        });

        if (input.useAi && aiConfig && segmentationApplied && alignmentApplied && designImage && appImage) {
          const designRegions = new Map(designPage.regions.map((region) => [region.id, region]));
          const appRegions = new Map(appPage.regions.map((region) => [region.id, region]));
          for (const regionMatch of regionMatches.filter((match) => match.status === 'matched')) {
            const designRegion = mergeRegions(regionMatch.designRegionIds.map((id) => designRegions.get(id)).filter((region): region is UiRegion => !!region));
            const appRegion = mergeRegions(regionMatch.appRegionIds.map((id) => appRegions.get(id)).filter((region): region is UiRegion => !!region));
            if (!designRegion || !appRegion) continue;
            const lockedDesign = new Set(matches.filter((match) => match.status === 'matched').flatMap((match) => match.designNodeIds));
            const lockedApp = new Set(matches.filter((match) => match.status === 'matched').flatMap((match) => match.appNodeIds));
            const candidates = buildRegionNodeCandidates({
              design: designPage, app: appPage, designRegion, appRegion,
              excludedDesignIds: lockedDesign, excludedAppIds: lockedApp,
            });
            if (candidates.length === 0) continue;
            const designAnnotations = buildRegionAnnotations(designImage, designPage, designRegion, lockedDesign);
            const appAnnotations = buildRegionAnnotations(appImage, appPage, appRegion, lockedApp);
            const shortCandidates = candidates.map((candidate) => ({
              designShortId: designAnnotations.canonicalToShort.get(candidate.designNodeId) ?? '',
              appShortIds: candidate.appNodeIds.map((id) => appAnnotations.canonicalToShort.get(id) ?? '').filter(Boolean),
              scores: candidate.appNodeIds.map((id, index) => appAnnotations.canonicalToShort.has(id) ? candidate.scores[index]! : null)
                .filter((score): score is number => score !== null),
            })).filter((candidate) => candidate.designShortId && candidate.appShortIds.length > 0);
            if (shortCandidates.length === 0 || designAnnotations.pages.length === 0 || appAnnotations.pages.length === 0) continue;
            const images: AiRegionNodeMatchRequest['images'] = [];
            const designOriginal = designAnnotations.original ? rasterToDataUrl(designAnnotations.original, 1536) : null;
            const appOriginal = appAnnotations.original ? rasterToDataUrl(appAnnotations.original, 1536) : null;
            if (designOriginal) images.push({ source: 'design', kind: 'original', dataUrl: designOriginal });
            if (appOriginal) images.push({ source: 'app', kind: 'original', dataUrl: appOriginal });
            for (const [source, annotations] of [['design', designAnnotations], ['app', appAnnotations]] as const) {
              const png = annotations.original ? rasterToPng(annotations.original) : null;
              if (!png) continue;
              if (!artifactDirReady) {
                await mkdir(artifactDir, { recursive: true });
                artifactDirReady = true;
              }
              const safeRegion = (source === 'design' ? designRegion.id : appRegion.id).replace(/[^a-zA-Z0-9_-]/g, '_');
              const fileName = `${source}-${safeRegion}-original.png`;
              const file = path.join(artifactDir, fileName);
              await writeFile(file, png);
              annotationMeta.push({
                source,
                regionId: source === 'design' ? designRegion.id : appRegion.id,
                page: 0,
                nodeShortIds: [],
                kind: 'original',
                file,
                url: assetUrl(located.requirementId, 'report', runId, fileName),
              });
            }
            for (const annotation of [...designAnnotations.pages, ...appAnnotations.pages]) {
              const dataUrl = rasterToDataUrl(annotation.raster);
              if (dataUrl) images.push({ source: annotation.source, kind: 'annotated', page: annotation.page, dataUrl });
              const png = rasterToPng(annotation.raster);
              if (png) {
                if (!artifactDirReady) {
                  await mkdir(artifactDir, { recursive: true });
                  artifactDirReady = true;
                }
                const safeRegion = annotation.regionId.replace(/[^a-zA-Z0-9_-]/g, '_');
                const fileName = `${annotation.source}-${safeRegion}-page-${annotation.page}.png`;
                const file = path.join(artifactDir, fileName);
                await writeFile(file, png);
                annotationMeta.push({
                  source: annotation.source, regionId: annotation.regionId, page: annotation.page,
                  nodeShortIds: annotation.nodeShortIds,
                  kind: 'annotated',
                  file,
                  url: assetUrl(located.requirementId, 'report', runId, fileName),
                  shortIdMap: Object.fromEntries(annotation.nodeShortIds.map((shortId) => [
                    shortId,
                    (annotation.source === 'design' ? designAnnotations : appAnnotations).shortToCanonical.get(shortId) ?? '',
                  ])),
                });
              }
            }
            const request: AiRegionNodeMatchRequest = {
              protocol: 'ui-acceptance-region-node-ai-v1', runId, model: aiConfig.model,
              designRegionId: designRegion.id, appRegionId: appRegion.id,
              designNodes: designAnnotations.nodes, appNodes: appAnnotations.nodes,
              candidates: shortCandidates, images,
            };
            const requestHash = inputHash({
              protocol: request.protocol,
              designRegionId: request.designRegionId,
              appRegionId: request.appRegionId,
              designNodes: request.designNodes,
              appNodes: request.appNodes,
              candidates: request.candidates,
              images: images.map((image) => ({ ...image, dataUrl: inputHash(image.dataUrl) })),
            });
            const nodeDecisionScope = {
              label: `${designRegion.id} -> ${appRegion.id}`,
              designRegionIds: regionMatch.designRegionIds,
              appRegionIds: regionMatch.appRegionIds,
              designNodeIds: request.designNodes.map((node) => node.canonicalId),
              appNodeIds: request.appNodes.map((node) => node.canonicalId),
              shortIdMap: Object.fromEntries([
                ...request.designNodes.map((node) => [node.shortId, node.canonicalId] as const),
                ...request.appNodes.map((node) => [node.shortId, node.canonicalId] as const),
              ]),
            };
            const nodeInputSummary = {
              designRegionCount: regionMatch.designRegionIds.length,
              appRegionCount: regionMatch.appRegionIds.length,
              designNodeCount: request.designNodes.length,
              appNodeCount: request.appNodes.length,
              candidateCount: request.candidates.length,
              imageCount: request.images.length,
            };
            const started = Date.now();
            try {
              const allowedDesignShortIds = new Set(designAnnotations.nodes.map((node) => node.shortId));
              const allowedAppShortIds = new Set(appAnnotations.nodes.map((node) => node.shortId));
              const candidateAppIds = new Map(shortCandidates.map((candidate) => [
                candidate.designShortId,
                new Set(candidate.appShortIds),
              ]));
              const resolved = await resolveAiDecision({
                stage: 'node-matching', model: aiConfig.model, promptVersion: 'region-node-v1',
                inputHash: requestHash,
                validate: (value) => validateAiRegionNodeMatches(
                  value, allowedDesignShortIds, allowedAppShortIds, candidateAppIds,
                ),
                invoke: () => runRegionNodeMatching(aiConfig, request),
              });
              const response = resolved.output;
              const applied = applyRegionNodeResponse({ matches, response, designAnnotations, appAnnotations, candidates });
              matches = applied.matches;
              if (response.observations.length > 0) {
                regionObservationMap.set(regionMatch.id, response.observations.map((observation) => ({
                  type: observation.type,
                  designRegionIds: regionMatch.designRegionIds,
                  appRegionIds: regionMatch.appRegionIds,
                  evidence: [...observation.evidence, `severity=${observation.severity}`, `probability=${observation.probability.toFixed(3)}`],
                })));
                const severity = response.observations.some((observation) => observation.severity === 'fail') ? 'fail'
                  : response.observations.some((observation) => observation.severity === 'unknown') ? 'unknown'
                    : 'warning';
                regionObservationStatus.set(regionMatch.id, severity);
              }
              decisions.push({
                stage: 'node-matching', model: aiConfig.model, promptVersion: 'region-node-v1',
                inputHash: requestHash, status: 'accepted', latencyMs: Date.now() - started,
                cacheHit: resolved.cacheHit, output: response,
                scope: nodeDecisionScope, inputSummary: nodeInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: request.protocol, model: aiConfig.model,
                  payloadKeys: Object.keys(request),
                  imageLabels: images.map((image) => `${image.source}:${image.kind}${image.page ? `:${image.page}` : ''}`),
                }),
                responseSummary: aiResponseSummary(response),
              });
              if (response.observations.length > 0) {
                decisions.push({
                  stage: 'visual-review', model: aiConfig.model, promptVersion: 'region-node-v1',
                  inputHash: requestHash, status: 'accepted', latencyMs: 0,
                  cacheHit: resolved.cacheHit, output: response.observations,
                  scope: nodeDecisionScope, inputSummary: nodeInputSummary,
                });
              }
            } catch (error) {
              const message = aiErrorMessage(error, 'AI 区域节点匹配', Math.max(aiConfig.timeoutMs, REGION_NODE_AI_MIN_TIMEOUT_MS));
              aiErrors.push(`区域 ${designRegion.id} 节点 AI 失败：${message}`);
              decisions.push({
                stage: 'node-matching', model: aiConfig.model, promptVersion: 'region-node-v1',
                inputHash: requestHash, status: /abort|timeout|超时/i.test(message) ? 'timeout' : 'error',
                latencyMs: Date.now() - started, error: message,
                scope: nodeDecisionScope, inputSummary: nodeInputSummary,
                requestSummary: aiRequestSummary({
                  protocol: request.protocol, model: aiConfig.model,
                  payloadKeys: Object.keys(request),
                  imageLabels: images.map((image) => `${image.source}:${image.kind}${image.page ? `:${image.page}` : ''}`),
                }),
                responseSummary: {
                  ...aiResponseSummary(undefined, /JSON|解析|property/i.test(message) ? 'invalid-json' : 'schema-rejected', message, aiRawOutput(error)),
                  ...(aiFinishReason(error) ? { finishReason: aiFinishReason(error) } : {}),
                },
              });
            }
          }
        }

        const visual = await computeVisuals({
          requirementId: located.requirementId,
          design: located.design,
          app: located.app,
          designDocument: context.designDocument,
          appDocument: context.appDocument,
          matches,
        });

        let ai: AcceptanceResult['ai'] = input.useAi
          ? { requested: true, applied: segmentationApplied && alignmentApplied && aiErrors.length === 0 }
          : undefined;

        if (input.useAi && ai && !ai.applied) {
          ai.error = [...new Set([...aiErrors, ai.error].filter((item): item is string => !!item))].join('；') || 'AI 验收未完整执行';
        }
        if (regionAi) {
          regionAi.applied = segmentationApplied && alignmentApplied;
          regionAi.inputHash = decisions.find((decision) => decision.stage === 'segmentation')?.inputHash;
          regionAi.decision = alignmentDecision;
          if (!regionAi.applied) regionAi.error = aiErrors.join('；') || 'AI 区域流程未完整执行';
        }

        const result = evaluateAcceptance({
          design: context.designDocument,
          app: context.appDocument,
          matches,
          source: readiness.source,
          coordinateValid: readiness.coordinateValid,
          collectionQuality: located.app.collectionQuality,
          profile: input.profile,
          visual,
          windowSizeMismatch: !!located.app.coordinateInset,
          ai,
        });
        const regionResults = evaluateRegions(designPage, appPage, regionMatches, matches).map((regionResult) => {
          const observedStatus = regionObservationStatus.get(regionResult.matchId);
          const status = observedStatus === 'fail' ? 'fail'
            : observedStatus === 'unknown' && regionResult.status !== 'fail' ? 'unknown'
              : observedStatus === 'warning' && regionResult.status === 'pass' ? 'warning'
                : regionResult.status;
          return {
            ...regionResult,
            status,
            observations: [...regionResult.observations, ...(regionObservationMap.get(regionResult.matchId) ?? [])],
            nodeMatches: matches.filter((match) => {
            const region = designPage.regions.find((item) => item.id === regionResult.regionId);
            const ids = new Set(region?.nodeIds ?? []);
            return match.designNodeIds.some((id) => ids.has(id));
          }),
          };
        });
        const designRegionById = new Map(designPage.regions.map((region) => [region.id, region]));
        const criticalRoles = new Set<UiRegion['role']>(['header', 'card', 'grid', 'product', 'navigation']);
        const criticalFailure = regionResults.find((regionResult) => regionResult.status === 'fail'
          && criticalRoles.has(designRegionById.get(regionResult.regionId)?.role ?? 'unknown'));
        const unresolvedRegion = regionResults.find((regionResult) => regionResult.status === 'unknown'
          && criticalRoles.has(designRegionById.get(regionResult.regionId)?.role ?? 'unknown'));
        const nonCriticalFailure = regionResults.find((regionResult) => regionResult.status === 'fail');
        if (result.verdict !== 'blocked' && criticalFailure) result.verdict = 'fail';
        else if (result.verdict === 'pass' && unresolvedRegion) result.verdict = 'review';
        else if (result.verdict === 'pass' && nonCriticalFailure) result.verdict = 'review';
        if (criticalFailure || unresolvedRegion) {
          const affected = criticalFailure ?? unresolvedRegion!;
          const affectedMatch = regionMatches.find((match) => match.id === affected.matchId);
          result.issues.push({
            id: `region-gate:${affected.matchId}`,
            category: 'structure',
            severity: criticalFailure ? 'P1' : 'P2',
            matchId: null,
            designNodeIds: affected.missingNodeIds,
            appNodeIds: affected.extraNodeIds,
            check: 'region-acceptance',
            expected: 'critical region resolved',
            actual: affected.status,
            confidence: affectedMatch?.confidence ?? 0,
            reasonCodes: [criticalFailure ? 'CRITICAL_REGION_FAILED' : 'CRITICAL_REGION_UNKNOWN'],
            status: 'open',
          });
        }
        result.regionAnalysis = {
          engineVersion: 'ai-region-v1',
          design: designPage,
          app: appPage,
          candidates: ruleCandidates,
          matches: regionMatches,
          results: regionResults,
          score: regionPageScore(regionResults, designPage.regions),
          decisions,
          annotations: annotationMeta,
          ...(regionAi ? { ai: regionAi } : {}),
        };

        meta.result = await adjudicateResult({
          result,
          reviewer: deps.adjudicationReviewer,
          runId: meta.id,
        });
        meta.status = 'completed';
      } catch (error) {
        meta.status = 'failed';
        meta.error = (error as Error).message;
      }

      await writeReport(located.requirementId, meta).catch((error: unknown) => {
        console.warn('[acceptance] 报告落盘失败（内存结果仍然可用）：', error);
      });
      return meta;
    },

    getRun(input: { requirementId: string; runId: string }): Promise<AcceptanceRunMeta | null> {
      return readReport(input.requirementId, input.runId);
    },

    getHistory(pairId: string): Promise<AcceptanceRunHistoryItem[]> {
      return (async () => {
        const located = await locatePair(pairId);
        if (!located) return [];
        return readRunHistory(located.requirementId, pairId);
      })();
    },

    getMapping(pairId: string): Promise<NodeMapping | null> {
      return (async () => {
        const located = await locatePair(pairId);
        if (!located) return null;
        return readMapping(located.requirementId, pairId);
      })();
    },

    saveMapping(input: SaveNodeMappingInput): Promise<NodeMapping> {
      return (async () => {
        const located = await locatePair(input.pairId);
        if (!located) throw new Error(`配对不存在：${input.pairId}`);
        const mapping: NodeMapping = {
          version: '1.0.0',
          pairId: input.pairId,
          anchors: input.mapping.anchors ?? [],
          ignoredDesignNodeIds: input.mapping.ignoredDesignNodeIds ?? [],
          ignoredAppNodeIds: input.mapping.ignoredAppNodeIds ?? [],
          matches: input.mapping.matches ?? [],
          regionOverrides: input.mapping.regionOverrides ?? [],
          updatedAt: timestamp(),
        };
        await writeMapping(located.requirementId, mapping);
        return mapping;
      })();
    },

    getGroundTruth(pairId: string): Promise<GroundTruth | null> {
      return (async () => {
        const located = await locatePair(pairId);
        if (!located) return null;
        return readGroundTruth(located.requirementId, pairId);
      })();
    },

    saveGroundTruth(input: SaveGroundTruthInput): Promise<GroundTruth> {
      return (async () => {
        const located = await locatePair(input.pairId);
        if (!located) throw new Error(`配对不存在：${input.pairId}`);
        // 逐条过滤而不是照单全收：`pairs` 是渲染层攒出来的，一条 `matched` 只有一侧、
        // 或两侧全空，都会在导出时变成一行无法解释的统计。写入侧是最后一道闸。
        const pairs = (input.groundTruth.pairs ?? []).filter(
          (pair) =>
            (pair.designNodeIds?.length ?? 0) + (pair.appNodeIds?.length ?? 0) > 0 &&
            (pair.verdict !== 'matched' ||
              ((pair.designNodeIds?.length ?? 0) > 0 && (pair.appNodeIds?.length ?? 0) > 0)),
        );
        const groundTruth: GroundTruth = {
          version: '1.0.0',
          pairId: input.pairId,
          pairs,
          updatedAt: timestamp(),
        };
        await writeGroundTruth(located.requirementId, groundTruth);
        return groundTruth;
      })();
    },
  };
}
