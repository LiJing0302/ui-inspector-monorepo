import React from 'react';

import {
  fromCanonicalId,
  type AcceptanceIssue,
  type AcceptanceReadiness,
  type AcceptanceResult,
  type NodeMatch,
} from '@shared/aiAcceptance';

/** 结论徽标的文案与色调 */
const VERDICT_LABEL: Record<AcceptanceResult['verdict'], string> = {
  pass: '通过',
  fail: '不通过',
  review: '待复核',
  blocked: '已阻断',
};

/**
 * 门禁原因码 → 人话。
 *
 * 这些码来自 `acceptance/service.evaluateReadiness` 与 `core.evaluateAcceptance`，
 * **两边共用一张表**：未命中就原样显示码本身（新加的码不会静默变成空白）。
 */
const REASON_LABEL: Record<string, string> = {
  PAIR_NOT_FOUND: '配对不存在',
  PAIR_INCOMPLETE: '配对缺一侧素材',
  DESIGN_SIZE_INVALID: '设计稿尺寸无效',
  APP_SIZE_INVALID: '截图尺寸无效',
  APP_NODE_SOURCE_NOT_SDK: '节点不是来自 react-native-ui-acceptance',
  COLLECTION_QUALITY_MISSING: '快照缺少采集质量信息（旧格式）',
  COLLECTION_PROFILE_NOT_FULL: '采集档位不是 acceptance-full',
  COLLECTION_TRUNCATED: '节点树被采集上限截断',
  DESIGN_NODE_TREE_EMPTY: '设计稿节点树为空',
  APP_NODE_TREE_EMPTY: 'App 节点树为空',
  COORDINATE_INVALID: '坐标无法校准',
};

/** 问题项的检查名 → 人话 */
const CHECK_LABEL: Record<string, string> = {
  presence: '节点缺失',
  'extra-node': '多余节点',
  geometry: '位置/尺寸',
  text: '文案',
  color: '颜色',
  'visual-differs': '视觉差异',
  'asset-differs': '图片差异',
  mapping: '匹配歧义',
  readiness: '数据门禁',
  'window-size': '窗口尺寸对齐',
  'ai-arbitration': 'AI 仲裁',
};

const describeNode = (canonicalId: string): string => {
  const parsed = fromCanonicalId(canonicalId);
  if (!parsed) return canonicalId;
  return `${parsed.source === 'design' ? '设计稿' : 'App'} ${parsed.id}`;
};

const SEVERITY_ORDER: Array<AcceptanceIssue['severity']> = ['P0', 'P1', 'P2'];

interface AcceptancePanelProps {
  result: AcceptanceResult | null;
  readiness: AcceptanceReadiness | null;
  runError: string | null;
  busy: boolean;
  useAi: boolean;
  /**
   * 面板里的结论是否**已经过时**（人工映射在上次运行之后又被改过）。
   *
   * 必须显式告诉用户，而不是让旧结论继续挂着：确认 / 忽略一条匹配之后，屏幕上的
   * 「待确认匹配」和 verdict 都还是上一轮的产物。不提示的话，用户会以为「点了确认
   * 但没生效」，然后重复点、反复点 —— 真正的问题是它需要重跑一次。
   */
  stale: boolean;
  onUseAiChange: (value: boolean) => void;
  onRun: () => void;
  /** 点问题时把两侧节点一起选中并聚焦 */
  onFocusMatch: (designNodeIds: string[], appNodeIds: string[]) => void;
  onConfirmMatch: (match: NodeMatch) => void;
  onIgnoreMatch: (match: NodeMatch) => void;
}

/**
 * 验收结果面板（右栏第二个 tab）。
 *
 * 排布顺序刻意是「结论 → 为什么 → 细节」：verdict 与计数在最上面（一眼看到要不要管），
 * 门禁原因紧随其后（说明为什么不能给通过），问题明细与待确认映射放在可滚动区。
 *
 * 只有**待复核**的匹配才提供「确认 / 忽略」：已自动确认的条目再给按钮，等于鼓励
 * 用户去覆盖规则引擎已经算对的结论。
 */
const AcceptancePanel: React.FC<AcceptancePanelProps> = ({
  result,
  readiness,
  runError,
  busy,
  useAi,
  stale,
  onUseAiChange,
  onRun,
  onFocusMatch,
  onConfirmMatch,
  onIgnoreMatch,
}) => {
  const issues = result?.issues ?? [];
  const grouped = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: issues.filter((issue) => issue.severity === severity),
  })).filter((group) => group.items.length > 0);

  const pendingMatches = (result?.matches ?? []).filter(
    (match) => match.status === 'ambiguous' && (match.alternatives?.length ?? 0) > 0,
  );

  return (
    <div className="acceptance-panel">
      <div className="acceptance-run">
        <label className="acceptance-ai-toggle">
          <input
            type="checkbox"
            checked={useAi}
            disabled={busy}
            onChange={(event) => onUseAiChange(event.target.checked)}
          />
          <span>用 AI 仲裁歧义匹配</span>
        </label>
        <button type="button" className="btn primary" disabled={busy} onClick={onRun}>
          {busy ? '验收中…' : '运行验收'}
        </button>
      </div>

      {readiness && !readiness.ready && (
        <div className="acceptance-blocked">
          <div className="acceptance-blocked-title">当前数据不满足验收门禁</div>
          <ul>
            {readiness.reasons.map((reason) => (
              <li key={reason}>{REASON_LABEL[reason] ?? reason}</li>
            ))}
          </ul>
        </div>
      )}

      {runError && <div className="alert error flush">{runError}</div>}

      {stale && (
        <div className="acceptance-stale">
          人工映射在上次运行之后已改动，下面的结论还是旧的 —— 需要重新运行一次验收才会生效。
        </div>
      )}

      {result && (
        <>
          <div className="acceptance-verdict-row">
            <span className={`verdict-badge ${result.verdict}`}>{VERDICT_LABEL[result.verdict]}</span>
            <span className="acceptance-source">
              {result.source === 'sdk' ? 'SDK 节点' : result.source === 'legacy' ? '旧格式节点' : '来源未知'}
            </span>
          </div>

          <div className="acceptance-counts">
            <span>匹配 {result.summary.matchedCount}</span>
            <span className={result.summary.missingCount > 0 ? 'warn' : ''}>
              缺失 {result.summary.missingCount}
            </span>
            <span className={result.summary.extraCount > 0 ? 'warn' : ''}>
              多余 {result.summary.extraCount}
            </span>
            <span className={result.summary.ambiguousCount > 0 ? 'warn' : ''}>
              歧义 {result.summary.ambiguousCount}
            </span>
            <span className={result.summary.unknownCount > 0 ? 'warn' : ''}>
              未知 {result.summary.unknownCount}
            </span>
          </div>

          {result.ai && (
            <div className="acceptance-ai-state">
              {result.ai.requested
                ? result.ai.applied
                  ? 'AI 仲裁已执行'
                  : `AI 未生效：${result.ai.error ?? '未知原因'}`
                : 'AI 仲裁未启用'}
            </div>
          )}

          <div className="acceptance-scroll">
            <div className="acceptance-section-title">
              问题 {issues.length > 0 ? `（${issues.length}）` : '（无）'}
            </div>
            {issues.length === 0 && <div className="acceptance-empty">没有发现问题</div>}
            {grouped.map((group) => (
              <div key={group.severity} className={`acceptance-issue-group ${group.severity}`}>
                <div className="acceptance-group-title">{group.severity}</div>
                {group.items.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    className="acceptance-issue"
                    onClick={() => onFocusMatch(issue.designNodeIds, issue.appNodeIds)}
                  >
                    <span className="acceptance-issue-check">
                      {CHECK_LABEL[issue.check] ?? issue.check}
                    </span>
                    <span className="acceptance-issue-nodes">
                      {issue.designNodeIds.map(describeNode).join(' / ') || '—'}
                      {issue.appNodeIds.length > 0 && (
                        <>
                          {' ↔ '}
                          {issue.appNodeIds.map(describeNode).join(' / ')}
                        </>
                      )}
                    </span>
                    {issue.reasonCodes.length > 0 && (
                      <span className="acceptance-issue-reasons">{issue.reasonCodes.join(', ')}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}

            {pendingMatches.length > 0 && (
              <>
                <div className="acceptance-section-title">待确认匹配（{pendingMatches.length}）</div>
                {pendingMatches.map((match) => (
                  <div key={match.id} className="acceptance-match">
                    <button
                      type="button"
                      className="acceptance-match-main"
                      onClick={() => onFocusMatch(match.designNodeIds, match.appNodeIds)}
                    >
                      <span className="acceptance-match-ids">
                        {match.designNodeIds.map(describeNode).join(' / ')}
                        {' ↔ '}
                        {match.appNodeIds.map(describeNode).join(' / ')}
                      </span>
                      <span className="acceptance-match-score">
                        规则分 {match.ruleScore.toFixed(2)}
                        {typeof match.aiScore === 'number' && ` · AI ${match.aiScore.toFixed(2)}`}
                      </span>
                    </button>
                    <div className="acceptance-match-actions">
                      <button type="button" className="btn tiny" onClick={() => onConfirmMatch(match)}>
                        确认
                      </button>
                      <button type="button" className="btn tiny" onClick={() => onIgnoreMatch(match)}>
                        忽略
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}

      {!result && !readiness?.ready && (
        <div className="acceptance-empty">
          还没跑过验收。点「运行验收」按节点级规则比对设计稿与 SDK 节点树。
        </div>
      )}
    </div>
  );
};

export default AcceptancePanel;
