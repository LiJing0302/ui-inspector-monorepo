/**
 * §7.4 门禁：VLM 终裁（adjudication）硬约束验证 —— 全部用 mock reviewer。
 *
 * 验收项（docs/AI-ACCEPTANCE-PLAN.md §7.4）：
 *  1. 正常降级：P2 误报被 ignored → review→pass，overriddenIssueIds 可审计
 *  2. 伪造 issueId 的 override 被拒绝并记 error
 *  3. fail→pass 的 verdict 建议被拒绝，verdict 保持 fail
 *  4. P0→ignored 的 override 被拒绝（最多降到 P1）；P0→P1 被允许但 verdict 仍 fail
 *  5. 未配置 reviewer 时保持规则结果（applied=false），verdict/issue 不动
 *  6. severity 升级（P2→P1）被拒绝
 *  7. reviewer 抛错 → applied=false，verdict 不变，decision 记 error
 *  8. reviewer 加重 verdict（review→fail）被采纳，verdictSource='ai'
 */
import { adjudicateResult } from '../src/main/acceptance/core';
import type {
  AcceptanceIssue,
  AcceptanceResult,
  AiAdjudicationReviewer,
  AiAdjudicationResponse,
} from '../src/types/aiAcceptance';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function makeIssue(id: string, severity: 'P0' | 'P1' | 'P2', status: 'open' | 'ignored' = 'open'): AcceptanceIssue {
  return {
    id,
    category: 'text',
    severity,
    matchId: null,
    designNodeIds: ['d1'],
    appNodeIds: ['a1'],
    check: 'text-match',
    expected: '12:00',
    actual: '12:05',
    confidence: 0.9,
    reasonCodes: ['TEXT_MISMATCH'],
    status,
  };
}

function makeResult(issues: AcceptanceIssue[], verdict: AcceptanceResult['verdict']): AcceptanceResult {
  return {
    verdict,
    source: 'sdk',
    coordinateValid: true,
    matches: [],
    issues,
    summary: {
      designNodeCount: 1,
      appNodeCount: 1,
      matchedCount: 0,
      missingCount: 0,
      extraCount: 0,
      ambiguousCount: 0,
      unknownCount: 0,
    },
    readinessReasons: [],
  };
}

function mockReviewer(outcome: AiAdjudicationResponse | Error, model = 'mock-vlm-1'): AiAdjudicationReviewer {
  return {
    model,
    review: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

async function main(): Promise<void> {
  console.log('门禁 1：P2 误报被 ignored → review→pass');
  {
    const result = await adjudicateResult({
      result: makeResult([makeIssue('ISSUE-1', 'P2')], 'review'),
      reviewer: mockReviewer({
        overrides: [{ issueId: 'ISSUE-1', status: 'ignored', reasonCodes: ['AI_FALSE_POSITIVE'] }],
        observations: ['裁切图显示两端都是占位符，无实质差异'],
      }),
      runId: 'run-1',
    });
    check('verdict 变为 pass', result.verdict === 'pass', `got ${result.verdict}`);
    check('overriddenIssueIds 含 ISSUE-1', result.adjudication?.overriddenIssueIds.includes('ISSUE-1') === true);
    check('applied=true', result.adjudication?.applied === true);
    check('verdictSource=mixed', result.adjudication?.verdictSource === 'mixed', `got ${result.adjudication?.verdictSource}`);
    check('decision.stage=visual-review', result.adjudication?.decision?.stage === 'visual-review');
    check('原 issue 状态变为 ignored', result.issues[0].status === 'ignored');
    check('reasonCodes 追加了 AI_FALSE_POSITIVE', result.issues[0].reasonCodes.includes('AI_FALSE_POSITIVE'));
  }

  console.log('门禁 2：伪造 issueId 被拒绝并记 error');
  {
    const result = await adjudicateResult({
      result: makeResult([makeIssue('ISSUE-1', 'P2')], 'review'),
      reviewer: mockReviewer({
        overrides: [{ issueId: 'FAKE-999', status: 'ignored', reasonCodes: ['HALLUCINATED'] }],
        observations: [],
      }),
      runId: 'run-2',
    });
    check('verdict 保持 review', result.verdict === 'review', `got ${result.verdict}`);
    check('overriddenIssueIds 为空', (result.adjudication?.overriddenIssueIds.length ?? -1) === 0);
    check('errors 记录了未知 issueId', (result.adjudication?.errors ?? []).some((e) => e.includes('FAKE-999')));
    check('issue 未被改写', result.issues[0].status === 'open' && result.issues[0].severity === 'P2');
    check('decision.status=rejected', result.adjudication?.decision?.status === 'rejected');
  }

  console.log('门禁 3：fail→pass 的 verdict 建议被拒绝');
  {
    const result = await adjudicateResult({
      result: makeResult([makeIssue('ISSUE-1', 'P1')], 'fail'),
      reviewer: mockReviewer({ overrides: [], verdict: 'pass', observations: ['看着没问题'] }),
      runId: 'run-3',
    });
    check('verdict 保持 fail', result.verdict === 'fail', `got ${result.verdict}`);
    check('verdictSource=rule', result.adjudication?.verdictSource === 'rule', `got ${result.adjudication?.verdictSource}`);
    check('errors 记录了 verdict 建议被忽略', (result.adjudication?.errors ?? []).some((e) => e.includes('verdict')));
  }

  console.log('门禁 4：P0→ignored 被拒绝；P0→P1 允许但仍 fail');
  {
    const direct = await adjudicateResult({
      result: makeResult([makeIssue('ISSUE-P0', 'P0')], 'fail'),
      reviewer: mockReviewer({
        overrides: [{ issueId: 'ISSUE-P0', status: 'ignored', reasonCodes: ['AI_SAYS_OK'] }],
        observations: [],
      }),
      runId: 'run-4a',
    });
    check('P0→ignored 被拒绝，verdict 保持 fail', direct.verdict === 'fail');
    check('errors 说明 P0 不能直接 ignored', (direct.adjudication?.errors ?? []).some((e) => e.includes('P0')));
    check('overriddenIssueIds 为空', (direct.adjudication?.overriddenIssueIds.length ?? -1) === 0);

    const downgrade = await adjudicateResult({
      result: makeResult([makeIssue('ISSUE-P0', 'P0')], 'fail'),
      reviewer: mockReviewer({
        overrides: [{ issueId: 'ISSUE-P0', severity: 'P1', reasonCodes: ['AI_DOWNGRADE'] }],
        observations: [],
      }),
      runId: 'run-4b',
    });
    check('P0→P1 降级被允许', downgrade.adjudication?.overriddenIssueIds.includes('ISSUE-P0') === true);
    check('severity 变为 P1', downgrade.issues[0].severity === 'P1');
    check('verdict 仍为 fail（P1 照样 fail）', downgrade.verdict === 'fail');
  }

  console.log('门禁 5：未配置 reviewer → 规则结果照常');
  {
    const input = makeResult([makeIssue('ISSUE-1', 'P2')], 'review');
    const result = await adjudicateResult({ result: input, runId: 'run-5' });
    check('applied=false', result.adjudication?.applied === false);
    check('verdictSource=rule', result.adjudication?.verdictSource === 'rule');
    check('verdict 不变', result.verdict === 'review');
    check('issues 原样返回', result.issues.length === 1 && result.issues[0].status === 'open');
    check('原 result 对象未被 mutate', input.adjudication === undefined);
  }

  console.log('门禁 6：severity 升级被拒绝');
  {
    const result = await adjudicateResult({
      result: makeResult([makeIssue('ISSUE-1', 'P2')], 'review'),
      reviewer: mockReviewer({
        overrides: [{ issueId: 'ISSUE-1', severity: 'P0', reasonCodes: ['AI_ESCALATE'] }],
        observations: [],
      }),
      runId: 'run-6',
    });
    check('verdict 保持 review', result.verdict === 'review', `got ${result.verdict}`);
    check('severity 保持 P2', result.issues[0].severity === 'P2');
    check('errors 记录了只能降级', (result.adjudication?.errors ?? []).some((e) => e.includes('降级')));
  }

  console.log('门禁 7：reviewer 抛错 → applied=false，verdict 不变');
  {
    const result = await adjudicateResult({
      result: makeResult([makeIssue('ISSUE-1', 'P1')], 'fail'),
      reviewer: mockReviewer(new Error('model timeout')),
      runId: 'run-7',
    });
    check('applied=false', result.adjudication?.applied === false);
    check('verdict 保持 fail', result.verdict === 'fail');
    check('decision.status=error', result.adjudication?.decision?.status === 'error');
    check('errors 记录了调用失败', (result.adjudication?.errors ?? []).some((e) => e.includes('调用失败')));
  }

  console.log('门禁 8：reviewer 加重 verdict（review→fail）被采纳');
  {
    const result = await adjudicateResult({
      result: makeResult([makeIssue('ISSUE-1', 'P2')], 'review'),
      reviewer: mockReviewer({ overrides: [], verdict: 'fail', observations: ['裁切图显示关键按钮缺失'] }),
      runId: 'run-8',
    });
    check('verdict 变为 fail', result.verdict === 'fail', `got ${result.verdict}`);
    check("verdictSource='ai'", result.adjudication?.verdictSource === 'ai', `got ${result.adjudication?.verdictSource}`);
  }

  console.log(failures === 0 ? '\n✅ 全部 8 项门禁通过' : `\n❌ ${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exit(1);
});
