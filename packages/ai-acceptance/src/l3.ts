/**
 * L3 证据合成与分权裁决
 *
 * 对应报告 §3.4。与"AI 只允许降级"的保守做法**不同**之处在于**按 category 分权**：
 *
 *   | category            | 规则侧 | AI 权限        | 理由 |
 *   |---------------------|--------|----------------|------|
 *   | 存在性/文本/几何     | 强     | 只能降级       | 规则有精确结构化值，AI 只用于剔误报 |
 *   | 颜色/圆角/描边       | 弱     | 可独立新增     | App 树盒样式覆盖率仅 9%，规则根本看不到 |
 *   | 风格/层次/观感       | 无     | 可独立新增     | 同上 |
 *   | verdict             | 唯一   | 只能加重       | fail 不可被 AI 一句话改 pass |
 */

import type {
  AcceptanceProfile,
  AiDefect,
  ColorCheck,
  CornerCheck,
  DefectCategory,
  EvidenceChain,
  Issue,
  MarkItem,
  PixelReport,
  RegionSlice,
  ReviewValidation,
  Severity,
  Verdict,
} from './types.ts';
import type { AlignOutput } from './l1.ts';
import { CORNER_MIN_CONFIDENCE } from './pixel.ts';

/**
 * 规则侧弱的类目：AI 可以新增。
 *
 * 其余（`existence` / `text` / `geometry` / `coverage`）是**强**类目 —— AI 只能降级。
 * 之所以按「弱表」正查、而不是按「强表」反查，是为了让**新增类目**的缺省方向偏保守：
 * 忘了登记时判强（AI 不能新增），而不是判弱（AI 能凭空造缺陷进结论）。
 */
const WEAK_CATEGORIES: DefectCategory[] = ['color', 'corner', 'stroke', 'style', 'hierarchy'];

export function authorityOf(category: DefectCategory): 'strong' | 'weak' {
  return WEAK_CATEGORIES.includes(category) ? 'weak' : 'strong';
}

const SEVERITY_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

/** 降级：P1→P2→忽略；P0 不可被降级（防止 AI 放行阻断项） */
function downgrade(s: Severity): Severity | 'ignored' {
  if (s === 'P1') return 'P2';
  if (s === 'P2') return 'ignored';
  return s;
}

export interface AdjudicateArgs {
  slices: RegionSlice[];
  validations: Map<string, ReviewValidation>;
  align: AlignOutput;
  profile: AcceptanceProfile;
  noPixelEvidence: Array<{ designY0: number; designY1: number; reason: string }>;
  pixel?: PixelReport;
  /** 是否启用 AI 通道（影响 evidence.aiReason 与 source 标注） */
  aiEnabled: boolean;
}

export interface AdjudicationResult {
  issues: Issue[];
  verdict: Verdict;
  verdictReason: string;
  counts: {
    p0: number;
    p1: number;
    p2: number;
    byCategory: Record<string, number>;
    bySource: Record<'rule' | 'ai' | 'mixed', number>;
    byAuthority: { strong: number; weak: number };
  };
}

export function adjudicate(args: AdjudicateArgs): AdjudicationResult {
  const { slices, validations, align, profile, noPixelEvidence, pixel, aiEnabled } = args;
  const tol = profile.thresholds?.geometryTolerance ?? 4;

  const issues: Issue[] = [];
  let seq = 0;
  const nextId = () => `ISSUE-${String(++seq).padStart(3, '0')}`;

  /* ------------------------------------------------------------------ *
   * 1. 规则侧基线
   * ------------------------------------------------------------------ */

  for (const slice of slices) {
    for (const item of slice.items) {
      const base = ruleIssueOf(item, slice, tol);
      if (!base) continue;
      issues.push({
        issueId: nextId(),
        ...base,
        source: 'rule',
        evidence: evidenceOf(item, slice),
        authority: authorityOf(base.category),
        needsHumanReview: !item.hasPixelEvidence && base.category !== 'coverage',
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * 2. 对齐断裂 / 累积漂移（结构性发现，不是单节点问题）
   * ------------------------------------------------------------------ */

  const deltas = align.strongAnchors.map((a) => a.deltaY);
  if (deltas.length >= 4) {
    const minD = Math.min(...deltas);
    const maxD = Math.max(...deltas);
    const drift = maxD - minD;
    if (drift > 20) {
      const worst = align.strongAnchors.reduce((acc, a) => (a.deltaY < acc.deltaY ? a : acc), align.strongAnchors[0]);
      issues.push({
        issueId: nextId(),
        category: 'geometry',
        severity: drift > 60 ? 'P0' : 'P1',
        source: 'rule',
        title: `垂直布局累积漂移：Δy 从 ${minD.toFixed(1)}px 漂到 ${maxD.toFixed(1)}px`,
        detail:
          `锚点区间 [${align.usableRange.designY0.toFixed(0)}, ${align.usableRange.designY1.toFixed(0)}] 内，` +
          `Δy 不是常量平移而是单调累积（极差 ${drift.toFixed(1)}px）。任何全局平移对齐都会产生成片假差异，` +
          `必须使用锚点保序拟合（本报告已采用）。最差锚点：设计 y=${worst.designY.toFixed(0)} → App y=${worst.appY.toFixed(0)}。`,
        evidence: {
          markId: null,
          regionId: null,
          // 结构性 issue 不对应单个节点：它讲的是「整段 y 区间内的漂移」，
          // 归因到一个节点反而会误导。消费侧按 null 画区间而不是画节点框。
          designId: null,
          appId: null,
          designText: worst.text,
          appText: worst.text,
          designBox: null,
          appBox: null,
          ruleVerdict: null,
          aiReason: null,
          normBox: null,
        },
        needsHumanReview: false,
        authority: 'strong',
      });
    }
  }

  for (const gap of align.gaps) {
    if (gap.note.includes('锚点区间之外') || gap.note.includes('锚点区间之前')) continue;
    issues.push({
      issueId: nextId(),
      category: 'geometry',
      severity: 'P1',
      source: 'rule',
      title: `对齐断裂：设计 y∈[${gap.designY0.toFixed(0)}, ${gap.designY1.toFixed(0)}]`,
      detail:
        `${gap.note}。该区间无法用单调映射解释，需人工确认是「设计稿多了一段」还是「App 少了一段」，` +
        `**不直接判为 UI 缺陷**。`,
      evidence: {
        markId: null,
        regionId: null,
        // 同上：断裂是区间结论。归因到单节点会让人去改一个没问题的元素。
        designId: null,
        appId: null,
        designText: null,
        appText: null,
        designBox: null,
        appBox: null,
        ruleVerdict: null,
        aiReason: null,
        normBox: null,
      },
      needsHumanReview: true,
      authority: 'strong',
    });
  }

  /* ------------------------------------------------------------------ *
   * 3. 覆盖不足（P0：严禁默认通过）
   * ------------------------------------------------------------------ */

  for (const n of noPixelEvidence) {
    issues.push({
      issueId: nextId(),
      category: 'coverage',
      severity: 'P0',
      source: 'rule',
      title: `无像素证据：设计 y∈[${n.designY0}, ${n.designY1}]`,
      detail: `${n.reason}。该区间**不得判为通过**，只能标注为待人工确认；中期需补滚动分段截图 + 拼接对齐。`,
      evidence: {
        markId: null,
        regionId: null,
        designId: null,
        appId: null,
        designText: null,
        appText: null,
        designBox: null,
        appBox: null,
        ruleVerdict: null,
        aiReason: null,
        normBox: null,
      },
      needsHumanReview: true,
      authority: 'strong',
    });
  }

  /* ------------------------------------------------------------------ *
   * 4. AI 通道：按 category 分权
   * ------------------------------------------------------------------ */

  const aiByMark = new Map<string, AiDefect>();
  for (const slice of slices) {
    const v = validations.get(slice.region.regionId);
    if (!v) continue;
    for (const d of v.accepted) {
      // 只保留第一条（重复编号已在校验阶段拒绝）
      if (!aiByMark.has(d.markId)) aiByMark.set(d.markId, d);
    }
    // AI 新增：仅允许 weak category
    for (const d of v.accepted) {
      if (aiByMark.get(d.markId) !== d) continue;
      const auth = authorityOf(d.category);
      if (auth !== 'weak') continue;
      const item = slice.items.find((i) => i.markId === d.markId);
      issues.push({
        issueId: nextId(),
        category: d.category,
        severity: d.severity,
        source: 'ai',
        title: `[AI] ${d.category}：${d.expected || item?.designText || d.markId}`,
        detail: d.reason,
        evidence: {
          ...evidenceOf(item ?? null, slice),
          aiReason: d.reason,
        },
        needsHumanReview: !(item?.hasPixelEvidence ?? true),
        authority: 'weak',
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * 5. 合成：AI 对 strong category 只能降级
   * ------------------------------------------------------------------ */

  const merged: Issue[] = [];
  for (const issue of issues) {
    const markId = issue.evidence.markId;
    const ai = markId ? aiByMark.get(markId) : undefined;
    if (!ai || issue.source !== 'rule' || issue.authority !== 'strong') {
      merged.push(issue);
      continue;
    }
    if (authorityOf(ai.category) !== 'strong') {
      merged.push(issue);
      continue;
    }
    // AI 与规则同类目 → 允许降级 / 维持；不允许加重
    const next = ai.action === 'downgrade' ? downgrade(issue.severity) : issue.severity;
    if (next === 'ignored') {
      // 被降级为忽略 → 只留审计痕迹，不作为 issue
      continue;
    }
    if (SEVERITY_ORDER[next] < SEVERITY_ORDER[issue.severity] && ai.severity !== next) {
      // AI 试图加重：忽略其 severity，保留规则值
    }
    merged.push({
      ...issue,
      severity: next,
      source: 'mixed',
      detail: `${issue.detail}\n[AI 复核] ${ai.reason}`,
      evidence: { ...issue.evidence, aiReason: ai.reason },
    });
  }

  /* ------------------------------------------------------------------ *
   * 6. 像素通道结果（M4）
   *
   * ⚠️ 必须 push 进 `merged`（而不是 `issues`）：`merged` 在上面已经构建完毕，
   * 往 `issues` 里追加的条目不会进入 counts / issues / verdict（实测踩过：
   * 像素通道跑出了结果，报告里却一条 corner/color issue 都没有）。
   * 像素项是 weak category，不需要参与"AI 只能降级"的合并，直接落 `merged`。
   * ------------------------------------------------------------------ */

  if (pixel?.available) {
    for (const c of pixel.colorChecks.filter((x) => !x.pass)) {
      merged.push(pixelIssue(nextId(), 'color', c));
    }
    for (const c of pixel.cornerChecks.filter((x) => !x.pass)) {
      // 低置信的圆角拟合（背景对比度低 / 弧被遮挡）不进入 issue 列表 —— 实测这类测量
      // 会把 34.6px 的圆角测成 3px，作为"缺陷"报出去会直接摧毁报告可信度。
      // 原始测量值仍保留在 report.pixel.cornerChecks 里，供人工复核。
      if (c.confidence < CORNER_MIN_CONFIDENCE) continue;
      merged.push(pixelIssue(nextId(), 'corner', c));
    }
  }

  /* ------------------------------------------------------------------ *
   * 7. verdict 重算（只能加重）
   * ------------------------------------------------------------------ */

  const counts = {
    p0: merged.filter((i) => i.severity === 'P0').length,
    p1: merged.filter((i) => i.severity === 'P1').length,
    p2: merged.filter((i) => i.severity === 'P2').length,
    byCategory: countBy(merged.map((i) => i.category)),
    bySource: {
      rule: merged.filter((i) => i.source === 'rule').length,
      ai: merged.filter((i) => i.source === 'ai').length,
      mixed: merged.filter((i) => i.source === 'mixed').length,
    },
    byAuthority: {
      strong: merged.filter((i) => i.authority === 'strong').length,
      weak: merged.filter((i) => i.authority === 'weak').length,
    },
  };

  let verdict: Verdict;
  let verdictReason: string;
  const blocking = merged.filter((i) => i.severity === 'P0' || i.severity === 'P1');
  const needHuman = merged.filter((i) => i.needsHumanReview);

  if (blocking.length > 0) {
    verdict = 'fail';
    verdictReason = `存在 ${blocking.length} 条 P0/P1 问题（P0=${counts.p0}，P1=${counts.p1}）。${
      counts.p0 > 0 ? '其中包含证据覆盖不足等阻断项。' : ''
    }`;
  } else if (needHuman.length > 0 || merged.length > 0) {
    verdict = 'review';
    verdictReason =
      needHuman.length > 0
        ? `无 P0/P1，但有 ${needHuman.length} 条需要人工确认（含无像素证据区间）。`
        : `仅 ${counts.p2} 条 P2 细节问题。`;
  } else {
    verdict = 'pass';
    verdictReason = '所有分区均有像素证据、且无任何差异。';
  }

  if (aiEnabled) verdictReason += '（已启用 AI 分区评审通道）';

  return { issues: merged, verdict, verdictReason, counts };
}

/* --------------------------------------------------------------------------- */

function ruleIssueOf(
  item: MarkItem,
  slice: RegionSlice,
  tol: number,
): { category: DefectCategory; severity: Severity; title: string; detail: string } | null {
  const px = item.hasPixelEvidence;
  const ctx = `区域 ${slice.region.regionId} ${slice.region.label}（markId ${item.markId}）`;
  switch (item.ruleVerdict) {
    case 'text-mismatch':
      return {
        category: 'text',
        severity: px ? 'P1' : 'P2',
        title: `文案不一致：设计「${item.designText}」↔ App「${item.appText}」`,
        detail: `${ctx}。${item.ruleReason}`,
      };
    case 'missing':
      return {
        category: 'existence',
        severity: px ? 'P1' : 'P2',
        title: item.designText ? `App 缺失文本「${item.designText}」` : `App 多出文本「${item.appText}」`,
        detail: `${ctx}。${item.ruleReason}${
          item.participation === 'required' && !px ? '（该节点在 App 侧被祖先裁出可视区，需确认是否为滚动内容）' : ''
        }`,
      };
    case 'dynamic':
      // 成对动态位 = 正常（格式一致、取值不同）；**未配对**的动态位要留痕（P2 待确认），
      // 但绝不作为 P0/P1 阻断项 —— 报告 §3.3 P2 阶段的既定口径。
      if (item.designText !== null && item.appText !== null) return null;
      return {
        category: 'existence',
        severity: 'P2',
        title: `动态位未配对：${item.designText ?? item.appText}`,
        detail: `${ctx}。${item.ruleReason}。需人工确认该元素是「整体未渲染」还是「仅取值不同」。`,
      };
    case 'geometry-off':
      return {
        category: 'geometry',
        severity: 'P2',
        title: `几何偏差：${item.ruleReason}`,
        detail: `${ctx}。设计框 ${JSON.stringify(item.designBox)} ↔ App 投影框 ${JSON.stringify(item.appBox)}（容差 ${tol}px）`,
      };
    case 'unjudgeable':
      return px
        ? null // 有像素证据 → 交给像素通道，不在规则层出结论
        : {
            category: 'coverage',
            severity: 'P2',
            title: `盒样式不可判定：${item.designText ?? item.markId}`,
            detail: `${ctx}。${item.ruleReason}`,
          };
    default:
      return null;
  }
}

function evidenceOf(item: MarkItem | null, slice: RegionSlice): EvidenceChain {
  return {
    markId: item?.markId ?? null,
    regionId: slice.region.regionId,
    designId: item?.designId ?? null,
    appId: item?.appId ?? null,
    designText: item?.designText ?? null,
    appText: item?.appText ?? null,
    designBox: item?.designBox ?? null,
    appBox: item?.appBox ?? null,
    ruleVerdict: item?.ruleVerdict ?? null,
    aiReason: null,
    normBox: item?.designBox ?? null,
  };
}

function pixelIssue(id: string, category: 'color' | 'corner', c: ColorCheck | CornerCheck): Issue {
  const isColor = category === 'color';
  const cc = c as ColorCheck;
  const kc = c as CornerCheck;
  return {
    issueId: id,
    category,
    severity: 'P2',
    source: 'rule',
    title: isColor
      ? `颜色偏差 ΔE00=${cc.deltaE.toFixed(1)}：期望 ${cc.expectedHex} 实测 ${cc.measuredHex}`
      : `圆角偏差：期望 ${kc.expectedRadius}px 实测 ${kc.measuredRadius.toFixed(1)}px`,
    detail: `${isColor ? cc.note : kc.note}（像素通道，规则侧节点树无盒样式能力）`,
    evidence: {
      markId: c.id,
      regionId: null,
      // ⚠️ 像素通道给不出节点 id：`c.id` 是采样点标识（形如 `PX-…`），
      // 不是节点 id。消费侧只能按 region 画覆盖区，**不许**拿它去查节点索引。
      designId: null,
      appId: null,
      designText: null,
      appText: null,
      designBox: null,
      appBox: null,
      ruleVerdict: null,
      aiReason: null,
      normBox: null,
    },
    needsHumanReview: isColor ? false : kc.confidence < 0.5,
    authority: 'weak',
  };
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}
