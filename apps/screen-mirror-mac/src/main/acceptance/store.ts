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
import { readJsonSafe, writeJsonAtomic } from '../store/atomic';
import { acceptanceMappingPath, acceptanceReportPath } from '../store/paths';

const MAPPING_VERSION = '1.0.0';

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
