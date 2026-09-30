/**
 * 配对调试包：把「一次配对两侧到底喂了什么给验收引擎」整体导出成一个 JSON。
 *
 * 为什么要做这个：验收跑出「匹配 0」时，报告里只有结论、没有输入。而匹配失败
 * 的原因几乎全在输入侧 —— 设计稿 schema 没解析出节点、App 快照的坐标无法校准、
 * 两侧根节点数量对不上、参与度全被判成 `context`。这些字段在 UI 上都没有出口，
 * 只能对着数据看。
 *
 * 三条约定：
 *   1. **导出的是原始数据，不是结论**。原始节点（`schema.json` / `nodes.json` 读出来的
 *      全量）与归一化结果（`CanonicalDocument`）都在，这样「引擎算错」与「数据本身就不对」
 *      能区分开 —— 只导出其中一个，这两种情况长得一模一样。
 *   2. **诊断与引擎同源**。打分复用 `core.diagnoseMatching`，不在这里另算一套。
 *   3. **落盘到固定目录**，不走保存对话框：排查往往要连导好几页，每次都弹窗会打断节奏；
 *      固定目录也让人（和后续的自动分析）能按路径直接找到文件。
 */

import { readMapping } from './store';
import {
  canonicalizeApp,
  canonicalizeDesign,
  countMatchStatuses,
  diagnoseMatching,
  matchDocuments,
} from './core';
import {
  buildPageDocument,
  evaluateRegions,
  matchNodesWithinRegions,
  matchRegions,
  regionPageScore,
} from './regions';
import type { MatchTrace } from './core';
import {
  createPixelTransformContract,
  designToAppPixelScale,
  projectDesignEdgesByProfile,
  toPixelHostProfile,
} from './pixelTransform';
import { evaluateReadiness } from './service';
import type {
  AcceptanceReadiness,
  CanonicalDocument,
  NodeMapping,
  NodeMatch,
  PageDocument,
  RegionAcceptanceResult,
  RegionMatch,
} from '../../types/aiAcceptance';
import type { AppNode, AppSnapshotMeta, DesignAssetMeta, DesignNode } from '../../types/verify';
import type { PixelTransformContract } from '../../types/acceptance';
import type { ExportPairDebugInput, ExportPairDebugResult } from '../../types/ipc';

import { writeFileAtomic } from '../store/atomic';
import {
  appScreenshotPath,
  designScreenshotPath,
  loadAppNodes,
  loadDesignNodes,
} from '../store/assets';
import { debugExportsDir } from '../store/paths';
import { getRequirement } from '../store/workspace';
import { exportStamp, safeSegment } from './exportNaming';

/** 单个节点的可读摘要（只为让人在诊断里认出是哪一层断的） */
interface NodeSummary {
  id: string;
  label: string;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * 这份调试包里的几何是按什么算出来的。
 *
 * 为什么值得单独一块：调试包会被拿去**离线重放**（`replay:gt`）和二次分析，
 * 而在另一个时间点重算时，「期望值按什么规则算」这件事无法从节点数据本身看出来 ——
 * 基准宽、viewport、截图物理宽、snap 档位任何一个不同，同一条几何会得出不同结论。
 * 把契约（含版本与哈希）原样存下来，重放端才能校验「我手里的规则和当初那份是不是同一套」
 * 并在不一致时报**不可判定**，而不是照着另一套规则算出一堆看着合理的红。
 */
export interface DebugPixelTransform {
  /** 缺任意一个构造输入（基准宽 / viewport / 截图物理宽）就是 false —— 此时几何不可判定 */
  available: boolean;
  version: string | null;
  hash: string | null;
  snapProfile: string | null;
  coordinateOrigin: string | null;
  viewportSource: string | null;
  /**
   * 宿主取整档位（2026-09-29 加）：这份几何的宽高是按属性投影还是按边界相减算出来的。
   *
   * 与 `snapProfile` 并列放在顶层，理由相同 —— 重放端要看得出「当初是按哪一档算的」，
   * 否则拿一份 `presnap` 时期导出的包在默认档变化后重放，会得到一批无法解释的红。
   */
  hostProfile: string | null;
  basisWidth: number;
  viewportWidth: number;
  pixelWidth: number | null;
  pixelRatio: number | null;
  /** 设计 px → App 物理 px 的总倍率，**仅供人眼估算**，判定不它用 */
  scale: number | null;
  /** 设计帧整体投影到 App 物理像素后的目标尺寸（宽高由两条边界相减得到） */
  targetPixelSize: { width: number; height: number } | null;
  /** 原样的契约，重放端校验 / 汇报用 */
  contract: PixelTransformContract | null;
}

export interface PairDebugBundle {
  kind: 'ui-acceptance-pair-debug';
  /**
   * 3 → 4（2026-09-29）：像素变换契约新增 `hostProfile`（宿主取整档位），`DebugPixelTransform`
   * 顶层同步暴露该字段。**旧包（v3）读进来不会报错**（新字段是增量的），但它里面的契约是
   * `-v1`，重放时会被 `pixelTransformRejectionReasons` 判成 `PIXEL_TRANSFORM_VERSION` 不匹配 ——
   * 那是刻意的：v1 的几何是「一律按边界投影」算出来的，与 v2 的期望值差可达 1px。
   */
  version: 4;
  exportedAt: string;
  requirement: { id: string; name: string };
  pair: { id: string };
  design: {
    asset: DesignAssetMeta;
    rawNodeCount: number;
    canonicalNodeCount: number;
    rootIds: string[];
    roots: NodeSummary[];
  };
  app: {
    snapshot: AppSnapshotMeta;
    rawNodeCount: number;
    canonicalNodeCount: number;
    rootIds: string[];
    roots: NodeSummary[];
  };
  readiness: AcceptanceReadiness;
  /** 本次几何计算使用的变换契约与目标像素尺寸（见 `DebugPixelTransform`） */
  pixelTransform: DebugPixelTransform;
  mapping: NodeMapping | null;
  /** 根级打分矩阵 + 参与度 / 类型分布 + 阈值（见 core.diagnoseMatching） */
  diagnosis: ReturnType<typeof diagnoseMatching>;
  /**
   * 规则匹配的分档计数，与验收报告里的 `summary` **同口径**（都数 `status === 'matched'`）。
   *
   * ⚠️ 不含 AI 仲裁：AI 只把 `ambiguous` 提升为 `matched`，所以开了 AI 的那次运行，
   * 报告里的 matchedCount 可能大于这里的 matched。两者对不上时先看这个差异。
   */
  statusCounts: Record<string, number>;
  documents: { design: CanonicalDocument; app: CanonicalDocument };
  matches: NodeMatch[];
  regionAnalysis: {
    design: PageDocument;
    app: PageDocument;
    matches: RegionMatch[];
    results: RegionAcceptanceResult[];
    score: number;
  };
  /** 两侧原始节点全量，保留字段原样，便于核对归一化是否丢信息 */
  rawNodes: { design: DesignNode[]; app: AppNode[] };
}

/**
 * 从两侧归一化文档推出这份调试包的变换元数据。
 *
 * 契约的构造输入只有三个（设计基准宽 / App 逻辑宽 / 截图物理宽），全部从文档上取 ——
 * 这样导出的元数据与验收引擎里那次计算**必然同源**，不存在「导出算了一套、报告算了另一套」。
 *
 * 缺 `pixelWidth`（老快照没有物理像素通道）时如实给 `available: false`，不去用
 * 逻辑宽 × 密度反算一个「看起来能用」的物理宽：那会把「这版数据没有物理像素事实」
 * 伪装成「有」，而方案明确禁止这种往返。
 */
export function buildDebugPixelTransform(
  design: CanonicalDocument,
  app: CanonicalDocument,
): DebugPixelTransform {
  const hostProfile = toPixelHostProfile(app.hostProfile);
  const contract = app.pixelWidth
    ? createPixelTransformContract({
      basisWidth: design.width,
      viewportWidth: app.width,
      pixelWidth: app.pixelWidth,
      hostProfile,
    })
    : null;
  let targetPixelSize: { width: number; height: number } | null = null;
  if (contract) {
    const edges = projectDesignEdgesByProfile(
      { x: 0, y: 0, width: design.width, height: design.height },
      contract,
      hostProfile,
    );
    targetPixelSize = { width: edges.right - edges.left, height: edges.bottom - edges.top };
  }
  return {
    available: contract !== null,
    version: contract?.version ?? null,
    hash: contract?.hash ?? null,
    snapProfile: contract?.snapProfile ?? null,
    coordinateOrigin: contract?.coordinateOrigin ?? null,
    viewportSource: contract?.viewportSource ?? null,
    hostProfile: contract?.hostProfile ?? null,
    basisWidth: design.width,
    viewportWidth: app.width,
    pixelWidth: app.pixelWidth ?? null,
    pixelRatio: contract?.pixelRatio ?? null,
    scale: contract ? designToAppPixelScale(contract) : null,
    targetPixelSize,
    contract,
  };
}

function designSummary(node: DesignNode): NodeSummary {
  return {
    id: `design:${node.id}`,
    label: node.name?.trim() || node.type || node.id,
    rect: node.rect ?? { x: 0, y: 0, width: 0, height: 0 },
  };
}

function appSummary(node: AppNode): NodeSummary {
  const text = node.text?.trim();
  const label = [node.className, text ? `“${text.slice(0, 20)}”` : null].filter(Boolean).join(' ');
  return {
    id: `app:${node.nodeId}`,
    label: label || node.nodeId,
    rect: { x: node.x, y: node.y, width: node.width, height: node.height },
  };
}

/**
 * 组装并落盘一份配对调试包。
 *
 * 素材缺失（索引不一致）时**抛错而不是导出半份数据** —— 半份数据会被读成
 * 「设计稿那边就是空的」，从而把排查引到完全错误的方向。
 */
export async function exportPairDebug(
  input: ExportPairDebugInput,
): Promise<ExportPairDebugResult> {
  const requirement = await getRequirement(input.requirementId);
  if (!requirement) throw new Error(`需求不存在：${input.requirementId}`);

  const pair = requirement.pairs.find((item) => item.id === input.pairId);
  if (!pair) throw new Error(`配对不存在：${input.pairId}`);

  const design = requirement.designAssets.find((asset) => asset.id === pair.designAssetId);
  const snapshot = requirement.appSnapshots.find((item) => item.id === pair.appSnapshotId);
  if (!design || !snapshot) throw new Error('配对引用的设计稿或截图已不存在，无法导出');

  const [designNodes, appNodes, mapping] = await Promise.all([
    loadDesignNodes(requirement.id, design),
    loadAppNodes(requirement.id, snapshot),
    readMapping(requirement.id, pair.id),
  ]);

  const designDocument = canonicalizeDesign(designNodes, design.width, design.height);
  const appDocument = canonicalizeApp(
    appNodes,
    snapshot.width,
    snapshot.height,
    snapshot.pixelWidth,
    snapshot.pixelHeight,
  );
  // trace 要一路带到 diagnoseMatching：归宿表靠它区分「比过了但没配上」与
  // 「压根没被考虑过」（父容器没锁定）。这两种病因的修法完全不同。
  const trace: MatchTrace = { scopedDesign: new Set(), scopedApp: new Set() };
  const matches = matchDocuments(designDocument, appDocument, mapping ?? undefined, trace);
  const designPage = buildPageDocument(
    designDocument,
    {
      file: designScreenshotPath(requirement.id, design),
      pixelWidth: design.pixelWidth,
      pixelHeight: design.pixelHeight,
    },
    appDocument,
  );
  const appPage = buildPageDocument(
    appDocument,
    {
      file: appScreenshotPath(requirement.id, snapshot),
      pixelWidth: snapshot.pixelWidth,
      pixelHeight: snapshot.pixelHeight,
    },
    designDocument,
  );
  const regionMatches = matchRegions(designPage, appPage);
  const regionNodeMatches = matchNodesWithinRegions({
    design: designPage,
    app: appPage,
    regionMatches,
    baseMatches: matches,
    mapping: mapping ?? undefined,
  });
  const regionResults = evaluateRegions(designPage, appPage, regionMatches, regionNodeMatches);

  const designRootSet = new Set(designDocument.rootIds);
  const appRootSet = new Set(appDocument.rootIds);

  const bundle: PairDebugBundle = {
    kind: 'ui-acceptance-pair-debug',
    version: 4,
    exportedAt: new Date().toISOString(),
    requirement: { id: requirement.id, name: requirement.name },
    pair: { id: pair.id },
    design: {
      asset: design,
      rawNodeCount: designNodes.length,
      canonicalNodeCount: designDocument.nodes.length,
      rootIds: [...designDocument.rootIds],
      roots: designNodes.filter((node) => designRootSet.has(`design:${node.id}`)).map(designSummary),
    },
    app: {
      snapshot,
      rawNodeCount: appNodes.length,
      canonicalNodeCount: appDocument.nodes.length,
      rootIds: [...appDocument.rootIds],
      roots: appNodes.filter((node) => appRootSet.has(`app:${node.nodeId}`)).map(appSummary),
    },
    readiness: evaluateReadiness({
      pairId: pair.id,
      design,
      app: snapshot,
      designNodeCount: designNodes.length,
      appNodeCount: appNodes.length,
    }),
    pixelTransform: buildDebugPixelTransform(designDocument, appDocument),
    mapping: mapping ?? null,
    diagnosis: diagnoseMatching(designDocument, appDocument, matches, trace),
    statusCounts: countMatchStatuses(regionNodeMatches),
    documents: { design: designDocument, app: appDocument },
    matches: regionNodeMatches,
    regionAnalysis: {
      design: designPage,
      app: appPage,
      matches: regionMatches,
      results: regionResults,
      score: regionPageScore(regionResults, designPage.regions),
    },
    rawNodes: { design: designNodes, app: appNodes },
  };

  const file = `${debugExportsDir()}/${safeSegment(requirement.name, 'requirement')}-${safeSegment(
    design.name,
    'pair',
  )}-${exportStamp()}.json`;
  const payload = `${JSON.stringify(bundle, null, 2)}\n`;
  await writeFileAtomic(file, payload);

  return {
    file,
    bytes: Buffer.byteLength(payload, 'utf8'),
    statusCounts: bundle.statusCounts,
  };
}
