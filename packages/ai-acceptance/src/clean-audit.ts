/**
 * 清洗审计 —— 「节点清洗人工检测」卡点的产物（2026-10-04）
 *
 * ## 为什么单独一个模块
 *
 * 清洗是整条链路的地基：AI 模块划分吃的是清洗后的节点集，清洗错了，
 * 后面 AI 只是把错的切分包装得更像真的。而「清洗对不对」这个问题，
 * `stats.kept / stats.dropped` 两个数字**回答不了** —— 227 个里哪 227 个、
 * 剔的理由分别是什么、每条理由的判据是什么，全都不在数字里。
 *
 * 这份审计就是补这个洞：逐层给出「剔了什么 / 为什么 / 剩什么」，
 * 并对每层标注**风险等级**，让人工核验知道该重点看哪一层。
 *
 * ## 风险分级（人工核验的优先级）
 *
 * - `safe`     ：判据是逻辑蕴含的（零尺寸不可能被看到），核验只需扫一眼计数
 * - `review`   ：判据依赖采集器如实报告（hidden / clipped），值得抽查证据字段
 * - ⚠️ `risky` ：**L4 语义噪声层**。判据是「多个独立信号同时成立」的推断，
 *              而非必然 —— 10-04 上午 `clipped-out` 判据试错 4 次才收敛，
 *              每次都差点误伤真内容。这层必须逐条看。
 */

import type { CleanTier, DropRecord, ShapedSide } from './types.ts';
import { CLEAN_TIER_LABEL } from './types.ts';

export type CleanRisk = 'safe' | 'review' | 'risky';

export const TIER_RISK: Record<CleanTier, CleanRisk> = {
  'L1-geometry': 'safe',
  'L2-collector': 'safe',
  'L3-invisible': 'review',
  'L4-semantic': 'risky',
  // ⚠️ 判据是纯几何（完全无交集），本身不含推断 ⇒ `review` 而非 `risky`；
  // 但因为剔的是「真实存在但不参与验收」的内容，核验时要确认数量符合预期
  'L5-viewport': 'review',
  // ⚠️ L6 与 L4 同为 risky：SVG 内部元素与分组容器都曾被它误判过
  'L6-layout': 'risky',
};

export interface TierAudit {
  tier: CleanTier;
  label: string;
  risk: CleanRisk;
  /** 该层剔除数 */
  dropped: number;
  /** 占该侧总节点的比例（0~1） */
  ratio: number;
  /** 按 reason 分组 */
  reasons: Array<{ reason: string; count: number }>;
  /** 抽样证据（每层最多 5 条，供肉眼核验判据是否成立） */
  samples: Array<{ id: string; reason: string; evidence: string }>;
}

export interface SideAudit {
  side: 'design' | 'app';
  total: number;
  kept: number;
  dropped: number;
  tiers: TierAudit[];
  /**
   * ⚠️ 清洗后仍带 `clippedOut` 且 `participation='required'` 的节点数。
   *
   * 这批**不该**被当成缺陷源，但它们也不该被剔除（多数是「还没滚到」的真实内容）。
   * 数量大到离谱时说明这页是长页面、截图只覆盖了一部分 ——
   * 而这正是 L2 报「无像素证据 P0」的同一件事，在清洗阶段就该看见。
   */
  keptClippedOutRequired: number;
}

export interface CleanAudit {
  design: SideAudit;
  app: SideAudit;
  /** 需要人工重点核验的层（有 risky 判据且剔了东西） */
  attention: Array<{ side: 'design' | 'app'; tier: CleanTier; risk: CleanRisk; count: number }>;
  /** 清洗层面的告警（不阻断，但必须让人看见） */
  warnings: string[];
}

const MAX_SAMPLES = 5;

/** 单侧审计。纯函数，可直接断言 */
export function auditSide(side: 'design' | 'app', shaped: ShapedSide): SideAudit {
  const tiers: TierAudit[] = (
    ['L1-geometry', 'L2-collector', 'L3-invisible', 'L4-semantic', 'L5-viewport', 'L6-layout'] as CleanTier[]
  ).map((tier) => {
    const records: DropRecord[] = shaped.dropped.filter((d) => d.tier === tier);
    const byReason = new Map<string, number>();
    for (const r of records) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    return {
      tier,
      label: CLEAN_TIER_LABEL[tier],
      risk: TIER_RISK[tier],
      dropped: records.length,
      ratio: shaped.stats.total > 0 ? records.length / shaped.stats.total : 0,
      reasons: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      // ⚠️ 抽样必须**跨 reason 取**而不是从头切：L1 可能有 79 条 zero-size，
      // 从头切 5 条会全是它，看不出这一层到底还剔了什么。
      samples: sampleAcrossReasons(records),
    };
  });

  return {
    side,
    total: shaped.stats.total,
    kept: shaped.stats.kept,
    dropped: shaped.stats.dropped,
    tiers,
    keptClippedOutRequired: shaped.stats.clippedOutRequired,
  };
}

export function auditClean(design: ShapedSide, app: ShapedSide): CleanAudit {
  const d = auditSide('design', design);
  const a = auditSide('app', app);
  const attention: CleanAudit['attention'] = [];
  const warnings: string[] = [];

  for (const s of [d, a]) {
    for (const t of s.tiers) {
      if (t.dropped > 0 && t.risk !== 'safe') {
        attention.push({ side: s.side, tier: t.tier, risk: t.risk, count: t.dropped });
      }
    }
    const l5 = s.tiers.find((t) => t.tier === 'L5-viewport');
    if (l5 && l5.dropped > 0) {
      warnings.push(
        `${s.side} 侧有 ${l5.dropped} 个节点完全在视口外，**未参与本次验收**。` +
          `它们是真实存在的内容（不是「App 没有」），所以：` +
          `若该页是长页面，需要滚动分段截图 + 拼接后才能覆盖它们。`,
      );
    }
    if (s.keptClippedOutRequired > 20) {
      warnings.push(
        `${s.side} 侧有 ${s.keptClippedOutRequired} 个「被裁 + 必需」节点仍保留在节点集里：` +
          `它们多半是**还没滚到**的下半屏内容（不该剔除），但也意味着该页长于截图覆盖范围 —— ` +
          `L2 会据此报「无像素证据」。若这个数异常大，先确认截图是否只拍了一屏。`,
      );
    }
  }

  const risky = attention.filter((x) => x.risk === 'risky');
  if (risky.length) {
    warnings.push(
      `⚠️ L4 语义噪声层剔了 ${risky.reduce((s, x) => s + x.count, 0)} 个节点。` +
        `该层判据是「多个独立信号同时成立」的推断而非逻辑必然 —— ` +
        `新增或调整 L4 判据时，必须用其它真实素材交叉验证「在别的素材上剔 0 个」。`,
    );
  }

  return { design: d, app: a, attention, warnings };
}

/** 跨 reason 抽样：每个 reason 最多 1 条，直到凑满 MAX_SAMPLES */
function sampleAcrossReasons(records: DropRecord[]): TierAudit['samples'] {
  const seen = new Set<string>();
  const out: TierAudit['samples'] = [];
  for (const r of records) {
    if (seen.has(r.reason)) continue;
    seen.add(r.reason);
    out.push({ id: r.id, reason: r.reason, evidence: r.evidence });
    if (out.length >= MAX_SAMPLES) break;
  }
  return out;
}

/** 渲染成 Markdown —— 直接贴进 PR / 交接文档，人工核验就按它逐层看 */
export function renderCleanAudit(audit: CleanAudit): string {
  const L: string[] = [];
  L.push('# 节点清洗审计');
  L.push('');
  L.push('> 人工核验卡点①：确认每一层「剔了什么 / 为什么 / 剩什么」。');
  L.push('> ⚠️ `risky` 层必须逐条看 —— 那是推断而非必然（见 L4 说明）。');
  L.push('');

  for (const s of [audit.design, audit.app]) {
    L.push(`## ${s.side} 侧（总 ${s.total} → 保留 ${s.kept}，剔 ${s.dropped}）`);
    L.push('');
    L.push('| 清洗层 | 风险 | 剔除 | 占比 | 按 reason |');
    L.push('|---|---|---|---|---|');
    for (const t of s.tiers) {
      const reasons = t.reasons.map((r) => `${r.reason} ${r.count}`).join(' / ') || '—';
      L.push(
        `| ${t.label} | ${t.risk === 'risky' ? '⚠️ risky' : t.risk} | ${t.dropped} | ` +
          `${(t.ratio * 100).toFixed(1)}% | ${reasons} |`,
      );
    }
    L.push('');
    const withSamples = s.tiers.filter((t) => t.samples.length > 0);
    if (withSamples.length) {
      L.push('<details><summary>判据抽样（点开核对）</summary>');
      L.push('');
      for (const t of withSamples) {
        L.push(`**${t.label}**`);
        for (const smp of t.samples) {
          L.push(`- \`${smp.id.slice(0, 40)}\` — ${smp.reason}：${smp.evidence}`);
        }
        L.push('');
      }
      L.push('</details>');
      L.push('');
    }
    L.push(`> 保留节点中「被裁 + 必需」还有 **${s.keptClippedOutRequired}** 个。`);
    L.push('');
  }

  if (audit.attention.length) {
    L.push('## 需重点核验');
    L.push('');
    L.push('| 侧 | 层 | 风险 | 剔除数 |');
    L.push('|---|---|---|---|');
    for (const at of audit.attention) {
      L.push(`| ${at.side} | ${CLEAN_TIER_LABEL[at.tier]} | ${at.risk} | ${at.count} |`);
    }
    L.push('');
  }
  if (audit.warnings.length) {
    L.push('## 告警');
    L.push('');
    for (const w of audit.warnings) L.push(`- ${w}`);
    L.push('');
  }
  return L.join('\n');
}
