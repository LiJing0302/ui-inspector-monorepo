/**
 * Reviewer 通道 —— 三段式 Prompt + 编号协议 + mock 实现 + 输出校验
 *
 * 对应报告 §3.3。两条防幻觉的硬约束（**由代码 enforce，不靠 prompt**）：
 *   1. 输出里的 markId 必须存在于输入清单，否则整条丢弃并记 error；
 *   2. 不允许新增编号。
 * Prompt 里也明确要求回引 markId，但真正的门禁在上面两条。
 */

import type {
  AiDefect,
  DefectCategory,
  MarkItem,
  RegionReviewRequest,
  RegionReviewResponse,
  RegionReviewer,
  ReviewValidation,
  Severity,
} from './types.ts';

/* ---------------------------------------------------------------------------
 * Prompt 构建（三段式：P1 环境态 → P2 动态位 → P3 缺陷判定）
 * -------------------------------------------------------------------------*/

export interface RegionPrompt {
  system: string;
  user: string;
}

export function buildRegionPrompt(req: RegionReviewRequest): RegionPrompt {
  const items = req.items.map((it) => ({
    markId: it.markId,
    kind: it.kind,
    designText: it.designText,
    appText: it.appText,
    designBox: it.designBox,
    appBox: it.appBox,
    delta: it.delta,
    ruleVerdict: it.ruleVerdict,
    hasPixelEvidence: it.hasPixelEvidence,
  }));

  const system = [
    '你是一名 UI 验收评审员。你的任务不是"找不同"，而是在给定编号清单的前提下，',
    '判断每一条差异属于【环境态】【动态位】还是【真实缺陷】。',
    '',
    '硬性规则：',
    '1. 你只能引用清单里已存在的 markId，禁止发明新编号；引用不存在的 markId 会被程序整条丢弃。',
    '2. 若你认为规则给出的 ruleVerdict 可以忽略，必须说明理由（否则视为无效判定）。',
    '3. 分级只有 P0 / P1 / P2：P0 = 阻断（缺失关键功能/内容）、P1 = 明显偏差、P2 = 细节。',
    '4. 在 App 截图未覆盖的区域（hasPixelEvidence=false），禁止判定"通过"，只能标注为待人工确认。',
    '5. 不要因为文案取值不同就判缺陷 —— 先看它是不是动态位（时间/价格/数量/距离/店铺名/角标）。',
    '',
    '输出 JSON：',
    '{ "regionId": string,',
    '  "environmental": [{ "markId"?: string, "reason": string }],',
    '  "dynamic": [{ "markId"?: string, "reason": string }],',
    '  "defects": [{ "markId": string, "category": "existence|text|geometry|color|corner|stroke|style|hierarchy",',
    '                "severity": "P0|P1|P2", "expected": string, "actual": string, "reason": string,',
    '                "action": "keep|downgrade|override" }],',
    '  "confidence": number }',
  ].join('\n');

  const user = [
    `【区域】${req.region.regionId} ${req.region.label}（设计 y ∈ [${req.region.designY0}, ${req.region.designY1}]）`,
    req.region.hints?.length ? `【本区高发差异类型】${req.region.hints.join(' / ')}` : '',
    req.noPixelEvidence
      ? '【重要】本区在 App 截图中**没有像素证据**（App 截图未覆盖到此高度）。禁止判 pass，只能标注待人工确认。'
      : `【像素覆盖】本区 App 截图像素覆盖完整（尺度比 ${req.cropScaleRatio ?? 'n/a'}）`,
    '',
    'P1 环境态候选（登录态/数据态/平台态，不进入缺陷列表）：',
    req.envHints.length ? `  ${req.envHints.join(' / ')}` : '  （无显式声明）',
    '',
    'P2 动态位候选（时间/价格/数量/距离/角标，只允许"格式一致但值不同"）：',
    req.dynamicHints.length ? `  ${req.dynamicHints.join(' / ')}` : '  （无）',
    '',
    'P3 待判定清单（只能引用这里的 markId）：',
    JSON.stringify(items, null, 1),
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

/* ---------------------------------------------------------------------------
 * 输出校验（防幻觉门禁）
 * -------------------------------------------------------------------------*/

const VALID_SEVERITY: Severity[] = ['P0', 'P1', 'P2'];
const VALID_CATEGORY: DefectCategory[] = [
  'existence',
  'text',
  'geometry',
  'color',
  'corner',
  'stroke',
  'style',
  'hierarchy',
  'coverage',
];

export function validateReview(resp: RegionReviewResponse, req: RegionReviewRequest): ReviewValidation {
  const allowed = new Set(req.items.map((i) => i.markId));
  const errors: string[] = [];
  const accepted: AiDefect[] = [];
  const rejected: ReviewValidation['rejected'] = [];

  if (resp.regionId !== req.region.regionId) {
    errors.push(`regionId 不匹配：期望 ${req.region.regionId}，收到 ${resp.regionId}`);
  }

  const seen = new Set<string>();
  for (const d of resp.defects ?? []) {
    if (!d || typeof d !== 'object') {
      rejected.push({ defect: d, reason: '非法条目' });
      continue;
    }
    if (!d.markId || !allowed.has(d.markId)) {
      rejected.push({ defect: d, reason: `markId 不在输入清单内：${String(d.markId)}` });
      continue;
    }
    if (seen.has(d.markId)) {
      rejected.push({ defect: d, reason: `markId 重复：${d.markId}` });
      continue;
    }
    if (!VALID_SEVERITY.includes(d.severity)) {
      rejected.push({ defect: d, reason: `非法 severity：${String(d.severity)}` });
      continue;
    }
    if (!VALID_CATEGORY.includes(d.category)) {
      rejected.push({ defect: d, reason: `非法 category：${String(d.category)}` });
      continue;
    }
    if (!d.reason || String(d.reason).trim().length < 2) {
      rejected.push({ defect: d, reason: '缺少可审计的 reason' });
      continue;
    }
    // 覆盖规则初判为 ok 时，必须给出理由说明为什么可以忽略（这里已要求 reason 非空）
    const item = req.items.find((i) => i.markId === d.markId) as MarkItem;
    if (item && (item.ruleVerdict === 'ok' || item.ruleVerdict === 'dynamic') && d.action === 'override') {
      errors.push(`${d.markId}：override 规则初判（${item.ruleVerdict}）需要更强证据，已记录但降级为 keep`);
      accepted.push({ ...d, action: 'keep' });
      seen.add(d.markId);
      continue;
    }
    seen.add(d.markId);
    accepted.push(d);
  }

  const cleanRefs = (
    xs: Array<{ markId?: string; reason: string }> | undefined,
    kind: string,
  ): Array<{ markId?: string; reason: string }> => {
    const out: Array<{ markId?: string; reason: string }> = [];
    for (const x of xs ?? []) {
      if (!x || typeof x.reason !== 'string') continue;
      if (x.markId && !allowed.has(x.markId)) {
        errors.push(`${kind} 引用了不存在的 markId：${x.markId}`);
        continue;
      }
      out.push(x);
    }
    return out;
  };

  return {
    accepted,
    rejected,
    environmental: cleanRefs(resp.environmental, 'environmental'),
    dynamic: cleanRefs(resp.dynamic, 'dynamic'),
    errors,
  };
}

/* ---------------------------------------------------------------------------
 * Mock reviewer（离线可跑；语义等价于"保守的规则跟随者"）
 * -------------------------------------------------------------------------*/

export interface MockReviewerOptions {
  /** 是否对 weak-category（颜色/圆角/风格）新增 issue —— 用来演练"AI 可新增"通道 */
  addWeakCategoryIssues?: boolean;
  /** 是否故意注入一条非法 markId（用于验证门禁 100% 拒绝） */
  injectHallucination?: boolean;
}

export class MockRegionReviewer implements RegionReviewer {
  readonly name = 'mock';
  private readonly opts: MockReviewerOptions;

  constructor(opts: MockReviewerOptions = {}) {
    this.opts = opts;
  }

  async review(req: RegionReviewRequest): Promise<RegionReviewResponse> {
    const environmental: RegionReviewResponse['environmental'] = [];
    const dynamic: RegionReviewResponse['dynamic'] = [];
    const defects: AiDefect[] = [];

    for (const it of req.items) {
      switch (it.ruleVerdict) {
        case 'environmental':
          environmental.push({ markId: it.markId, reason: '文本命中显式声明的环境态规则' });
          break;
        case 'dynamic':
          dynamic.push({ markId: it.markId, reason: '格式一致、取值不同 → 动态位' });
          break;
        case 'text-mismatch':
          defects.push({
            markId: it.markId,
            category: 'text',
            severity: it.hasPixelEvidence ? 'P1' : 'P2',
            expected: it.designText ?? '',
            actual: it.appText ?? '',
            reason: `同排槽位文案不一致：设计「${it.designText}」↔ App「${it.appText}」`,
            action: 'keep',
          });
          break;
        case 'missing':
          defects.push({
            markId: it.markId,
            category: 'existence',
            severity: it.hasPixelEvidence ? 'P1' : 'P2',
            expected: it.designText ?? '(App 侧多出)',
            actual: it.appText ?? '(缺失)',
            reason: it.designText ? 'App 侧无对应文本' : 'App 侧多出文本，设计稿无对应',
            action: 'keep',
          });
          break;
        case 'unjudgeable':
          if (this.opts.addWeakCategoryIssues) {
            defects.push({
              markId: it.markId,
              category: 'corner',
              severity: 'P2',
              expected: it.designText ?? '见 designBox',
              actual: 'App 节点树无盒样式声明',
              reason: '规则侧对盒样式无能力（App 覆盖率仅 9%），依据截图像素测量给出待确认项',
              action: 'keep',
            });
          }
          break;
        case 'geometry-off':
          defects.push({
            markId: it.markId,
            category: 'geometry',
            severity: 'P2',
            expected: JSON.stringify(it.designBox),
            actual: JSON.stringify(it.appBox),
            reason: it.ruleReason,
            action: 'keep',
          });
          break;
        default:
          break;
      }
    }

    if (this.opts.injectHallucination && req.items.length > 0) {
      defects.push({
        markId: `${req.region.regionId}-99`, // 不存在 → 必须被门禁拒掉
        category: 'text',
        severity: 'P0',
        expected: 'hallucinated',
        actual: 'hallucinated',
        reason: '这是一条故意注入的幻觉编号，用于验证门禁',
        action: 'keep',
      });
    }

    return {
      regionId: req.region.regionId,
      environmental,
      dynamic,
      defects,
      confidence: 0.8,
      raw: { reviewer: 'mock' },
    };
  }
}
