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

import { readFile } from 'node:fs/promises';

import { nativeImage } from 'electron';

import type {
  AcceptanceReadiness,
  AcceptanceResult,
  AcceptanceRunMeta,
  AiAcceptanceRequest,
  AiAcceptanceResponse,
  CanonicalDocument,
  MatchVisualMetrics,
  NodeMapping,
  NodeMatch,
  RunAcceptanceInput,
  SaveNodeMappingInput,
} from '../../types/aiAcceptance';
import type { AppSnapshotMeta, DesignAssetMeta, MatchPairMeta } from '../../types/verify';

import { applyAiCandidates, canonicalizeApp, canonicalizeDesign, evaluateAcceptance, matchDocuments } from './core';
import { arbitrate, loadAiConfig, type AiConfig } from './ai';
import { decodePng, type RasterImage } from './png';
import { readMapping, readReport, writeMapping, writeReport } from './store';
import {
  averageColor,
  cropRaster,
  deltaE00,
  hammingDistance,
  MIN_VISUAL_CROP_PX,
  pHash,
  rgbToLab,
  ssim,
  toComparableGray,
} from './visuals';
import { appScreenshotPath, designScreenshotPath, loadAppNodes, loadDesignNodes } from '../store/assets';
import { createId, listRequirements, timestamp } from '../store/workspace';

/** 视觉比较的统一尺度：两张裁切都缩到它再比，规避像素密度差异 */
const VISUAL_COMPARE_SIZE = 32;

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
  getMapping(pairId: string): Promise<NodeMapping | null>;
  saveMapping(input: SaveNodeMappingInput): Promise<NodeMapping>;
}

export interface AcceptanceServiceDeps {
  loadConfig?: () => Promise<AiConfig | null>;
  arbitrate?: typeof arbitrate;
  decodeImage?: (file: string) => Promise<RasterImage | null>;
  /** 是否把裁切图一并送给 AI（默认读环境变量） */
  sendCrops?: boolean;
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
function rasterToDataUrl(raster: RasterImage): string | null {
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
    return image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}

export function createAcceptanceService(deps: AcceptanceServiceDeps = {}): AcceptanceService {
  const loadConfig = deps.loadConfig ?? (() => loadAiConfig());
  const runArbitration = deps.arbitrate ?? arbitrate;
  const decodeImage = deps.decodeImage ?? (async (file: string) => {
    try {
      return decodePng(await readFile(file));
    } catch {
      return null;
    }
  });
  const sendCrops = deps.sendCrops ?? process.env.SM_ACCEPTANCE_AI_SEND_CROPS === '1';

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

  async function buildCrops(params: {
    requirementId: string;
    design: DesignAssetMeta;
    app: AppSnapshotMeta;
    designDocument: CanonicalDocument;
    appDocument: CanonicalDocument;
    matches: NodeMatch[];
  }): Promise<NonNullable<AiAcceptanceRequest['crops']>> {
    const crops: NonNullable<AiAcceptanceRequest['crops']> = [];
    const [designImage, appImage] = await Promise.all([
      decodeCached(designScreenshotPath(params.requirementId, params.design)),
      decodeCached(appScreenshotPath(params.requirementId, params.app)),
    ]);
    if (!designImage || !appImage) return crops;

    const designScale = params.design.width > 0 ? designImage.width / params.design.width : 0;
    const appScale = params.app.width > 0 ? appImage.width / params.app.width : 0;
    const designById = new Map(params.designDocument.nodes.map((node) => [node.canonicalId, node]));
    const appById = new Map(params.appDocument.nodes.map((node) => [node.canonicalId, node]));

    for (const match of params.matches) {
      for (const nodeId of match.designNodeIds) {
        const node = designById.get(nodeId);
        if (!node) continue;
        const crop = cropRaster(designImage, node.rect, designScale);
        const dataUrl = crop ? rasterToDataUrl(crop) : null;
        if (dataUrl) crops.push({ nodeId, source: 'design', dataUrl });
      }
      for (const nodeId of match.appNodeIds) {
        const node = appById.get(nodeId);
        if (!node) continue;
        const crop = cropRaster(appImage, node.rect, appScale);
        const dataUrl = crop ? rasterToDataUrl(crop) : null;
        if (dataUrl) crops.push({ nodeId, source: 'app', dataUrl });
      }
    }
    return crops;
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
      appDocument: canonicalizeApp(appNodes, located.app.width, located.app.height),
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

        let matches = matchDocuments(context.designDocument, context.appDocument, context.mapping ?? undefined);

        const visual = await computeVisuals({
          requirementId: located.requirementId,
          design: located.design,
          app: located.app,
          designDocument: context.designDocument,
          appDocument: context.appDocument,
          matches,
        });

        let ai: AcceptanceResult['ai'];
        if (input.useAi) {
          ai = { requested: true, applied: false };
          const ambiguous = matches.filter((match) => match.status === 'ambiguous' && (match.alternatives?.length ?? 0) > 0);
          if (ambiguous.length === 0) {
            ai = { requested: true, applied: true };
          } else {
            const config = await loadConfig();
            if (!config) {
              ai.error = 'AI 未配置：请设置 SM_ACCEPTANCE_AI_ENDPOINT / SM_ACCEPTANCE_AI_KEY，或写入 workspace/acceptance-ai.json';
            } else {
              // 允许集**只取候选里出现过的 id**，比「全体节点」更严：
              // 这样 AI 连「另一个没被考虑的节点」都引用不了，彻底堵死「AI 造匹配」。
              const candidateSets = new Map<string, string[]>();
              const allowedDesignIds = new Set<string>();
              const allowedAppIds = new Set<string>();
              for (const match of ambiguous) {
                const ids = (match.alternatives ?? []).map((entry) => entry.appNodeId);
                candidateSets.set(match.id, ids);
                match.designNodeIds.forEach((id) => allowedDesignIds.add(id));
                ids.forEach((id) => allowedAppIds.add(id));
              }

              const request: AiAcceptanceRequest = {
                protocol: 'ui-acceptance-ai-v1',
                runId,
                model: config.model,
                design: context.designDocument.nodes
                  .filter((node) => allowedDesignIds.has(node.canonicalId))
                  .map((node) => ({ canonicalId: node.canonicalId, kind: node.kind, rect: node.rect, geometry: node.geometry, structure: node.structure, content: node.content, visual: node.visual })),
                app: context.appDocument.nodes
                  .filter((node) => allowedAppIds.has(node.canonicalId))
                  .map((node) => ({ canonicalId: node.canonicalId, kind: node.kind, rect: node.rect, geometry: node.geometry, structure: node.structure, content: node.content, visual: node.visual })),
                candidates: ambiguous,
              };

              if (sendCrops) {
                const crops = await buildCrops({
                  requirementId: located.requirementId,
                  design: located.design,
                  app: located.app,
                  designDocument: context.designDocument,
                  appDocument: context.appDocument,
                  matches: ambiguous,
                });
                if (crops.length > 0) request.crops = crops;
              }

              try {
                const response: AiAcceptanceResponse = await runArbitration(
                  config,
                  request,
                  allowedDesignIds,
                  allowedAppIds,
                );
                applyAiCandidates(
                  matches,
                  response,
                  candidateSets,
                  new Set(context.mapping?.ignoredDesignNodeIds ?? []),
                  new Set(context.mapping?.ignoredAppNodeIds ?? []),
                );
                ai = { requested: true, applied: true };
              } catch (error) {
                ai.error = (error as Error).message;
              }
            }
          }
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

        meta.result = result;
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
          updatedAt: timestamp(),
        };
        await writeMapping(located.requirementId, mapping);
        return mapping;
      })();
    },
  };
}
