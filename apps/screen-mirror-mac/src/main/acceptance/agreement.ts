/**
 * 「引擎结论 vs 人工答案」的判定 —— **唯一实现**。
 *
 * ## 为什么单独一个文件
 *
 * 这段判定有三个使用者：
 *   1. 标注包导出（`groundTruthExport`），给人看的 `metrics.agreement`
 *   2. 离线重放（`scripts/replay-ground-truth.ts`），改引擎规则后立刻看 P/R
 *   3. 冒烟断言
 *
 * 三者必须用**同一份**判定。一旦各写一份，就会出现「导出说 agrees 42、
 * 重放说 agrees 39」这种局面 —— 而这两个数字看起来都像权威，
 * 于是接下来所有关于「引擎到底行不行」的讨论都失去基准。
 * 抽成纯模块的另一个好处：它只依赖类型，不碰 electron，脚本里能直接 import。
 *
 * ## 判定顺序是刻意的
 *
 * **先看有没有配错，再看有没有漏，最后才看「找到了但没敢确认」**。
 * 反过来（先看漏了多少）会把「设计 A 被配到了 App Z」这种明确的方向性错误，
 * 混进「没配上」那一档里 —— 而这两者的修法完全相反（前者要收紧、后者要放宽）。
 */

import type { NodeMatch } from '../../types/aiAcceptance';
import type {
  EngineAgreement,
  GroundTruthEngineNodeStatus,
  GroundTruthPair,
} from '../../types/groundTruth';

/** 度量统一保留 4 位小数：够解释「差 0.3px」与「差 300px」，又不至于让文件被浮点尾数塞满 */
export const METRIC_DIGITS = 4;

export function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** METRIC_DIGITS;
  return Math.round(value * factor) / factor;
}

/**
 * 同一节点可能同时出现在多条 match 里（一条 `matched`、一条 `missing` 的残留等）。
 * 取值时按 `matched > ambiguous > missing/extra > ignored` 取最强的那条 ——
 * 因为这里要回答的是「引擎认为它配上了没有」，`matched` 才是答案。
 * 反过来取最弱的一条会把「配上了但置信度低」显示成「完全没配上」。
 */
const STATUS_PRIORITY: Record<string, number> = {
  matched: 4,
  ambiguous: 3,
  missing: 2,
  extra: 2,
  ignored: 1,
};

export function buildEngineIndex(
  matches: readonly NodeMatch[],
): Map<string, GroundTruthEngineNodeStatus> {
  const index = new Map<string, GroundTruthEngineNodeStatus>();
  const put = (id: string, match: NodeMatch, partners: readonly string[]): void => {
    const rank = STATUS_PRIORITY[match.status] ?? 0;
    const existing = index.get(id);
    if (existing && (STATUS_PRIORITY[existing.status] ?? 0) >= rank) return;
    index.set(id, {
      canonicalId: id,
      status: match.status,
      ...(match.origin ? { origin: match.origin } : {}),
      confidence: round(match.confidence),
      partners: [...partners],
    });
  };
  for (const match of matches) {
    // 设计节点的 partner 是这条 match 的 App 侧，反之亦然。missing 的那一侧天然是空数组。
    for (const id of match.designNodeIds) put(id, match, match.appNodeIds);
    for (const id of match.appNodeIds) put(id, match, match.designNodeIds);
  }
  return index;
}

export function statusOf(
  index: ReadonlyMap<string, GroundTruthEngineNodeStatus>,
  id: string,
): GroundTruthEngineNodeStatus {
  // 落进 `unknown` 而不是 `missing`：`missing` 是引擎的**结论**（它判了这个节点没对应），
  // `unknown` 是引擎**压根没提到它**。两者修法不同，混起来会把「引擎漏判」当成「引擎判错」。
  return index.get(id) ?? { canonicalId: id, status: 'unknown', partners: [] };
}

export function agreementOf(
  pair: GroundTruthPair,
  design: readonly GroundTruthEngineNodeStatus[],
  app: readonly GroundTruthEngineNodeStatus[],
): EngineAgreement {
  // `ignore` 是对引擎不提要求的标注（动态文案 / 骨架屏），谈不上对错
  if (pair.verdict === 'ignore') return 'unknown';

  const all = [...design, ...app];
  const matched = all.filter((status) => status.status === 'matched');
  const expected = new Set([...pair.designNodeIds, ...pair.appNodeIds]);

  if (pair.verdict === 'no-counterpart') {
    // 人说「另一侧不该有这个」。引擎一个字都没配 = 它也认为不存在 = 一致；
    // 只要引擎配上了任何一条，就是**明确相反**（不是「部分一致」）
    return matched.length === 0 ? 'agrees' : 'contradicts';
  }

  // 配到了**标注之外**的节点 → 明确相反。必须先于一切「漏没漏」的判断。
  const strayed = matched.some((status) =>
    status.partners.some((partner) => !expected.has(partner)),
  );
  if (strayed) return 'contradicts';

  if (matched.length === 0) {
    // 引擎给出过指向对侧的 `ambiguous` 候选 = 它找到了，只是没敢自动确认。
    // 这与「一个字都没提」在工具里是完全不同的两种状态（前者会出现在待复核列表里）。
    const weakLinked = all.some((status) =>
      status.status === 'ambiguous' && status.partners.some((partner) => expected.has(partner)),
    );
    return weakLinked ? 'weak' : 'missed';
  }

  return all.every((status) => status.status === 'matched') ? 'agrees' : 'partial';
}

/** 全零的一致性计数（导出与重放共用的初值，避免新增档位时漏改某一处） */
export function emptyAgreementCounts(): Record<EngineAgreement, number> {
  return { agrees: 0, weak: 0, partial: 0, contradicts: 0, missed: 0, unknown: 0 };
}
