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

export interface PairDebugBundle {
  kind: 'ui-acceptance-pair-debug';
  version: 2;
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
    version: 2,
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
