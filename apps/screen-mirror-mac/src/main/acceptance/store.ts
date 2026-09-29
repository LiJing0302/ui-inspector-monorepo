/**
 * 验收产物的持久化：节点映射（人工锚点 + 忽略规则）与验收运行报告。
 *
 * 为什么不放进 `index.json`：
 *   - 映射与报告是**按配对**增长的大对象（一次 300 节点匹配就是几百条 match），
 *     塞进唯一权威索引会让每次改名/建配对都重写一份巨大的 JSON。
 *   - 它们是**可重建**的派生物：丢了顶多重跑一次验收，不像素材那样不可逆。
 *   - 与 `docs/PRD-UI验收工具.md` 的设计一致：素材进索引，报告留在 reports/ 下。
 *
 * 因此这里的失败语义是「返回 null」，绝不抛错把调用方带崩 ——
 * 与 `readJsonSafe` 的既定策略一致。
 */

import type { AcceptanceRunMeta, NodeMapping } from '../../types/aiAcceptance';
import type { AcceptanceRunHistoryItem } from '../../types/aiAcceptance';
import type { GroundTruth, GroundTruthPair, GroundTruthVerdict } from '../../types/groundTruth';
import { readdir } from 'node:fs/promises';
import { readJsonSafe, writeJsonAtomic } from '../store/atomic';
import {
  acceptanceGroundTruthPath,
  acceptanceMappingPath,
  acceptanceReportPath,
  reportsDir,
} from '../store/paths';

const MAPPING_VERSION = '1.0.0';
const GROUND_TRUTH_VERSION = '1.0.0';

/**
 * 校验从磁盘读回的映射。形态不对就当作「没有映射」——
 * 继续用一份半坏的映射去匹配，比重新手工映射更糟。
 */
export function parseMapping(value: unknown, pairId: string): NodeMapping | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<NodeMapping>;
  if (raw.version !== MAPPING_VERSION) return null;
  if (raw.pairId !== pairId) return null;
  if (!Array.isArray(raw.matches)) return null;
  return {
    version: MAPPING_VERSION,
    pairId,
    anchors: Array.isArray(raw.anchors) ? raw.anchors : [],
    ignoredDesignNodeIds: Array.isArray(raw.ignoredDesignNodeIds) ? raw.ignoredDesignNodeIds : [],
    ignoredAppNodeIds: Array.isArray(raw.ignoredAppNodeIds) ? raw.ignoredAppNodeIds : [],
    matches: raw.matches,
    regionOverrides: Array.isArray(raw.regionOverrides) ? raw.regionOverrides.filter((item) =>
      !!item && typeof item === 'object'
      && typeof item.id === 'string'
      && (item.action === 'confirm' || item.action === 'ignore')
      && Array.isArray(item.designRegionIds)
      && Array.isArray(item.appRegionIds)) : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export async function readMapping(requirementId: string, pairId: string): Promise<NodeMapping | null> {
  const raw = await readJsonSafe<unknown>(acceptanceMappingPath(requirementId, pairId));
  return parseMapping(raw, pairId);
}

export async function writeMapping(requirementId: string, mapping: NodeMapping): Promise<void> {
  await writeJsonAtomic(acceptanceMappingPath(requirementId, mapping.pairId), {
    ...mapping,
    version: MAPPING_VERSION,
  });
}

export async function readReport(requirementId: string, runId: string): Promise<AcceptanceRunMeta | null> {
  const raw = await readJsonSafe<AcceptanceRunMeta>(acceptanceReportPath(requirementId, runId));
  if (!raw || typeof raw !== 'object' || raw.id !== runId) return null;
  return raw;
}

export async function writeReport(requirementId: string, run: AcceptanceRunMeta): Promise<void> {
  await writeJsonAtomic(acceptanceReportPath(requirementId, run.id), run);
}

export async function readRunHistory(
  requirementId: string,
  pairId: string,
  limit = 50,
): Promise<AcceptanceRunHistoryItem[]> {
  const entries = await readdir(reportsDir(requirementId), { withFileTypes: true }).catch(() => []);
  const runIds = entries
    .filter((entry) => entry.isFile())
    .map((entry) => /^acceptance-(.+)\.json$/.exec(entry.name)?.[1] ?? null)
    .filter((runId): runId is string => !!runId);
  const reports = await Promise.all(runIds.map((runId) => readReport(requirementId, runId)));

  return reports
    .filter((run): run is AcceptanceRunMeta => !!run && run.pairId === pairId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, limit))
    .map((run): AcceptanceRunHistoryItem => ({
      id: run.id,
      pairId: run.pairId,
      status: run.status,
      createdAt: run.createdAt,
      useAi: run.useAi ?? run.result?.ai?.requested ?? false,
      ...(run.result?.phase ? { phase: run.result.phase } : {}),
      ...(run.result?.verdict ? { verdict: run.result.verdict } : {}),
      ...(run.result?.ai ? { aiApplied: run.result.ai.applied } : {}),
      ...(run.result?.regionAnalysis && run.result.phase !== 'segmentation' && run.result.phase !== 'alignment'
        ? { score: run.result.regionAnalysis.score }
        : {}),
      ...(run.result?.summary ? { summary: run.result.summary } : {}),
      ...(run.error ? { error: run.error } : {}),
    }));
}

// ---------- 人工标注（ground truth） ----------

const VERDICTS: readonly GroundTruthVerdict[] = ['matched', 'no-counterpart', 'ignore'];

function isVerdict(value: unknown): value is GroundTruthVerdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

/** 只留非空字符串，顺带去重 —— 一个 id 在一组里出现两次没有语义 */
function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) seen.add(item);
  }
  return [...seen];
}

/**
 * 校验一条标注。**不合法就丢掉这一条，不让整份文件作废**。
 *
 * 与 `parseMapping`（形态不对整份不要）相反，理由是两种数据的修复成本差着数量级：
 * mapping 丢了重跑一次验收就回来了；标注丢了是几十次手点。所以这里逐条丢弃 ——
 * 一条手改坏的记录不该把旁边 199 条好的一起带走。
 */
export function parseGroundTruthPair(value: unknown): GroundTruthPair | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<GroundTruthPair>;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (!isVerdict(raw.verdict)) return null;
  const designNodeIds = cleanIds(raw.designNodeIds);
  const appNodeIds = cleanIds(raw.appNodeIds);
  // 两侧都空 = 什么都没指，统计里只会占一行看不出问题
  if (designNodeIds.length === 0 && appNodeIds.length === 0) return null;
  // 只有一侧的 `matched` 是无意义判定（「匹配」到空气），按丢弃处理
  if (raw.verdict === 'matched' && (designNodeIds.length === 0 || appNodeIds.length === 0)) {
    return null;
  }
  return {
    id: raw.id,
    designNodeIds,
    appNodeIds,
    verdict: raw.verdict,
    // 只认两个已知取值：写坏的一个值若原样带出去，导出里就会出现一种谁也解释不了的来源
    ...(raw.origin === 'human' || raw.origin === 'engine-prefill' ? { origin: raw.origin } : {}),
    ...(typeof raw.note === 'string' && raw.note.length > 0 ? { note: raw.note } : {}),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
  };
}

/**
 * 校验从磁盘读回的标注。
 *
 * 版本不对 / 不是本配对的文件 → 整份不要（那说明读错了文件，不是文件里有坏行）；
 * 版本对了 → 逐条过滤（见 `parseGroundTruthPair`）。
 */
export function parseGroundTruth(value: unknown, pairId: string): GroundTruth | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<GroundTruth>;
  if (raw.version !== GROUND_TRUTH_VERSION) return null;
  if (raw.pairId !== pairId) return null;
  if (!Array.isArray(raw.pairs)) return null;
  const pairs: GroundTruthPair[] = [];
  const seen = new Set<string>();
  for (const item of raw.pairs) {
    const pair = parseGroundTruthPair(item);
    // 同 id 后写覆盖先写：id 由节点集合派生，同集合重复出现时以最后一条为准
    if (pair && !seen.has(pair.id)) {
      seen.add(pair.id);
      pairs.push(pair);
    }
  }
  return {
    version: GROUND_TRUTH_VERSION,
    pairId,
    pairs,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export async function readGroundTruth(
  requirementId: string,
  pairId: string,
): Promise<GroundTruth | null> {
  const raw = await readJsonSafe<unknown>(acceptanceGroundTruthPath(requirementId, pairId));
  return parseGroundTruth(raw, pairId);
}

export async function writeGroundTruth(
  requirementId: string,
  groundTruth: GroundTruth,
): Promise<void> {
  await writeJsonAtomic(acceptanceGroundTruthPath(requirementId, groundTruth.pairId), {
    ...groundTruth,
    version: GROUND_TRUTH_VERSION,
  });
}
