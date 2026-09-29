import React from 'react';

import {
  type AcceptanceReadiness,
  type AcceptanceResult,
  type AcceptanceRunHistoryItem,
  type AcceptanceRunMeta,
  type AcceptanceInputAnalysis,
  type AiDecisionRecord,
  type AiConfigStatus,
  type AiConnectionTestResult,
  type NodeMatch,
  type RegionMatch,
  type UiRegion,
} from '@shared/aiAcceptance';

import MatchDetailList from './MatchDetailList';

/** 结论徽标的文案与色调 */
const VERDICT_LABEL: Record<AcceptanceResult['verdict'], string> = {
  pass: '通过',
  fail: '不通过',
  review: '待复核',
  blocked: '已阻断',
};

const REGION_STATUS_LABEL = {
  pass: '通过',
  warning: '警告',
  fail: '失败',
  unknown: '待复核',
} as const;

const REGION_ROLE_LABEL: Record<string, string> = {
  page: '页面', system: '系统区', header: '顶部', banner: '横幅', card: '卡片', grid: '宫格',
  list: '列表', product: '商品', store: '门店', navigation: '导航', overlay: '浮层', unknown: '内容块',
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

const formatHistoryTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
};

const AI_STAGE_LABEL: Record<AiDecisionRecord['stage'], string> = {
  input: '输入与门禁',
  segmentation: 'AI 页面分区',
  alignment: 'AI 区域对齐',
  'node-matching': '区域内节点匹配',
  'visual-review': '局部视觉复核',
};

const DECISION_STATUS_LABEL: Record<AiDecisionRecord['status'], string> = {
  accepted: '完成', rejected: '已拒绝', timeout: '超时', error: '失败', 'not-submitted': '未提交 AI',
};

const relationLabel = (relation: string): string => ({
  one_to_one: '1:1', one_to_many: '1:N', many_to_one: 'N:1',
  missing: '缺失', extra: '多余', ambiguous: '歧义',
}[relation] ?? relation);

const FILTER_REASON_LABEL: Record<string, string> = {
  invisible: '节点不可见',
  'hidden-by-ancestor': '祖先节点不可见',
  transparent: '透明度为 0',
  clipped: '没有有效可见区域',
  'zero-size': '尺寸无效',
  'outside-viewport': '位于视口外',
  'layout-only': '纯布局节点',
  'pass-through': '透明透传包装',
  'no-rendered-content': '没有实际渲染内容',
  ignored: '被忽略',
  unavailable: '节点不可用',
};

function outputObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function outputArray(value: unknown, key: string): Array<Record<string, unknown>> {
  const entries = outputObject(value)?.[key];
  return Array.isArray(entries)
    ? entries.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function renderSegmentationRegions(
  title: string,
  regions: UiRegion[],
  nodeLabel: (canonicalId: string) => string,
): React.ReactNode {
  const formatRect = (rect: { x: number; y: number; width: number; height: number }): string =>
    `x${Math.round(rect.x)} y${Math.round(rect.y)} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  return (
    <div>
      <strong>{title}</strong>
      {regions.length === 0 && <span className="ai-flow-empty">没有保留可用视觉区域</span>}
      {regions.map((region) => {
        const resolution = region.aiResolution;
        const candidates = region.support?.moduleNodeCandidates ?? [];
        return (
          <details className="acceptance-segmentation-region" key={region.id}>
            <summary>
              <span>{REGION_ROLE_LABEL[region.role] ?? region.role} · {region.id}</span>
              <small>{resolution?.status === 'matched' ? '节点已匹配' : resolution ? '节点未找到' : '未解析'} · {resolution?.attempt ?? 1} 次</small>
            </summary>
            <div className="acceptance-segmentation-region-detail">
              <span>AI 边界：{formatRect(region.rect)}</span>
              <span>节点锚点：{resolution?.nodeId ? nodeLabel(resolution.nodeId) : '无'}</span>
              {candidates.length > 0 && (
                <div className="acceptance-segmentation-candidates">
                  <span>反查候选：</span>
                  {candidates.map((candidate) => (
                    <span key={candidate.nodeId}>
                      {nodeLabel(candidate.nodeId)} · {Math.round(candidate.score * 100)}%
                      {candidate.nested ? ' · 内层' : ' · 外层'}
                    </span>
                  ))}
                </div>
              )}
              {resolution?.retryHistory && resolution.retryHistory.length > 0 && (
                <div className="acceptance-segmentation-retries">
                  <span>重划分过程：</span>
                  {resolution.retryHistory.map((history) => (
                    <span key={`${region.id}:${history.attempt}`}>
                      第 {history.attempt} 次 · {history.status === 'matched' ? '命中' : '未找到'} · {formatRect(history.rect)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

interface AiFlowProps {
  result: AcceptanceResult;
  readiness: AcceptanceReadiness | null;
  nodeLabel: (canonicalId: string) => string;
  onFocusMatch: (designNodeIds: string[], appNodeIds: string[], matchId?: string | null) => void;
  onFocusRegion: (matchId: string) => void;
  onPreviewImage: (url: string, title: string) => void;
}

const AiAcceptanceFlow: React.FC<AiFlowProps> = ({
  result,
  readiness,
  nodeLabel,
  onFocusMatch,
  onFocusRegion,
  onPreviewImage,
}) => {
  const analysis = result.regionAnalysis;
  const decisions = analysis?.decisions ?? [];
  const decisionGroups = new Map<AiDecisionRecord['stage'], AiDecisionRecord[]>();
  for (const decision of decisions) {
    const group = decisionGroups.get(decision.stage) ?? [];
    group.push(decision);
    decisionGroups.set(decision.stage, group);
  }
  const stageStatus = (stage: AiDecisionRecord['stage']): 'accepted' | 'failed' | 'skipped' => {
    const records = decisionGroups.get(stage) ?? [];
    if (result.phase === 'segmentation' && stage !== 'segmentation') return 'skipped';
    if (result.phase === 'alignment' && (stage === 'node-matching' || stage === 'visual-review')) return 'skipped';
    if (records.length > 0 && records.every((record) => record.status === 'not-submitted')) return 'skipped';
    if (result.phase === 'segmentation' && stage === 'segmentation' && records.length === 0) {
      return result.phaseStatus === 'failed' ? 'failed' : 'skipped';
    }
    if (records.length === 0) return 'skipped';
    return records.every((record) => record.status === 'accepted') ? 'accepted' : 'failed';
  };
  const canonicalIds = (decision: AiDecisionRecord, shortIds: string[]): string[] => shortIds
    .map((shortId) => decision.scope?.shortIdMap?.[shortId])
    .filter((id): id is string => !!id);
  const focusRegionDecision = (entry: Record<string, unknown>): void => {
    const designIds = stringArray(entry.designRegionIds);
    const appIds = stringArray(entry.appRegionIds);
    const match = analysis?.matches.find((candidate) =>
      candidate.designRegionIds.join('|') === designIds.join('|')
      && candidate.appRegionIds.join('|') === appIds.join('|'));
    if (match) onFocusRegion(match.id);
  };
  const decisionAnnotations = (decision: AiDecisionRecord) => {
    if (decision.stage === 'segmentation') {
      if (decision.promptVersion === 'design-region-search-v1' || decision.promptVersion === 'design-region-search-v2') {
        return (analysis?.annotations ?? []).filter((annotation) =>
          annotation.url && annotation.kind === 'original'
          && (annotation.regionId === 'app-segmentation-page' || annotation.regionId === 'design-search-tile'));
      }
      return (analysis?.annotations ?? []).filter((annotation) =>
        annotation.url && annotation.kind === 'original'
        && (annotation.regionId.endsWith('-segmentation-page') || annotation.regionId.includes('-visual-retry-')));
    }
    if (decision.stage !== 'node-matching') return [];
    const scopeIds = new Set([
      ...(decision.scope?.designRegionIds ?? []),
      ...(decision.scope?.appRegionIds ?? []),
    ]);
    return (analysis?.annotations ?? []).filter((annotation) => {
      if (!annotation.url) return false;
      // A merged region uses an id such as "region-a+region-b" while the
      // decision scope keeps the original ids. Match either representation.
      return annotation.regionId.split('+').some((id) => scopeIds.has(id));
    });
  };
  const renderDecisionOutput = (decision: AiDecisionRecord): React.ReactNode => {
    if (decision.stage === 'segmentation') {
      if (outputObject(decision.output)?.submitted === false) {
        return <div className="ai-flow-output">本次未提交 AI，仅生成并保存页面分区输入图、布局块节点摘要和短 ID 映射。</div>;
      }
      const searchMatches = outputArray(decision.output, 'matches');
      if (decision.promptVersion === 'design-region-search-v1' || decision.promptVersion === 'design-region-search-v2' || searchMatches.length > 0) {
        const observations = outputObject(decision.output)?.observations;
        return (
          <div className="ai-flow-output-list">
            {searchMatches.map((entry, index) => (
              <div className="ai-flow-output-row" key={index}>
                <span>{String(entry.appRegionId ?? '未知 App 区域')}</span>
                <strong>{String(entry.status ?? 'unknown')}</strong>
                <span>{entry.designNormalizedRect ? `设计稿坐标 ${JSON.stringify(entry.designNormalizedRect)}` : '未定位到设计稿区域'}</span>
                <small>{percent(Number(entry.probability) || 0)}</small>
                {entry.tileId ? <em>{String(entry.tileId)}</em> : null}
              </div>
            ))}
            {searchMatches.length === 0 && <div className="ai-flow-empty">模型没有返回长设计稿定位结果</div>}
            {Array.isArray(observations) && observations.length > 0 && (
              <div className="ai-flow-observations">{observations.map(String).join('；')}</div>
            )}
          </div>
        );
      }
      const designRegions = outputArray(decision.output, 'designRegions');
      const appRegions = outputArray(decision.output, 'appRegions');
      const visualRegions = outputArray(decision.output, 'regions');
      const observations = outputObject(decision.output)?.observations;
      return (
        <div className="ai-flow-output">
          {visualRegions.length > 0 ? (
            <div className="ai-flow-output-list">
              <div>视觉区域 {visualRegions.length} 个</div>
              {visualRegions.map((entry, index) => (
                <div className="ai-flow-output-row" key={index}>
                  <span>{String(entry.proposalId ?? `region-${index + 1}`)}</span>
                  <span>{entry.leftTop && entry.rightBottom
                    ? `${JSON.stringify(entry.leftTop)} → ${JSON.stringify(entry.rightBottom)}`
                    : '坐标缺失'}</span>
                  {entry.confidence !== undefined && <small>{percent(Number(entry.confidence) || 0)}</small>}
                  {stringArray(entry.reasonCodes).length > 0 && <em>{stringArray(entry.reasonCodes).join(' · ')}</em>}
                </div>
              ))}
            </div>
          ) : (
            <div>结果：设计稿 {designRegions.length} 个区域，App {appRegions.length} 个区域</div>
          )}
          {Array.isArray(observations) && observations.length > 0 && <div>观察：{observations.map(String).join('；')}</div>}
        </div>
      );
    }
    if (decision.stage === 'alignment') {
      const regionMatches = outputArray(decision.output, 'regionMatches');
      return (
        <div className="ai-flow-output-list">
          {regionMatches.map((entry, index) => (
            <button type="button" key={index} onClick={() => focusRegionDecision(entry)}>
              <span>{stringArray(entry.designRegionIds).join(' + ') || '无'}</span>
              <strong>{relationLabel(String(entry.relation ?? 'unknown'))}</strong>
              <span>{stringArray(entry.appRegionIds).join(' + ') || '无'}</span>
              <small>{percent(Number(entry.probability) || 0)}</small>
            </button>
          ))}
          {regionMatches.length === 0 && <div className="ai-flow-empty">模型没有返回区域关系</div>}
        </div>
      );
    }
    if (decision.stage === 'node-matching') {
      const nodeMatches = outputArray(decision.output, 'matches');
      const observations = outputArray(decision.output, 'observations');
      return (
        <>
          <div className="ai-flow-output-list nodes">
            {nodeMatches.map((entry, index) => {
              const designShortIds = stringArray(entry.designShortIds);
              const appShortIds = stringArray(entry.appShortIds);
              const designIds = canonicalIds(decision, designShortIds);
              const appIds = canonicalIds(decision, appShortIds);
              return (
                <button type="button" key={index} disabled={designIds.length + appIds.length === 0}
                  onClick={() => onFocusMatch(designIds, appIds, null)}>
                  <span title={designIds.map(nodeLabel).join('\n')}>
                    {designShortIds.join(' + ') || '无'}<small>{designIds.map(nodeLabel).join(' + ')}</small>
                  </span>
                  <strong>{relationLabel(String(entry.relation ?? 'unknown'))}</strong>
                  <span title={appIds.map(nodeLabel).join('\n')}>
                    {appShortIds.join(' + ') || '无'}<small>{appIds.map(nodeLabel).join(' + ')}</small>
                  </span>
                  <small>{percent(Number(entry.probability) || 0)}</small>
                  {stringArray(entry.reasonCodes).length > 0 && (
                    <em>{stringArray(entry.reasonCodes).join(' · ')}</em>
                  )}
                </button>
              );
            })}
            {nodeMatches.length === 0 && <div className="ai-flow-empty">本次调用没有新增节点匹配</div>}
          </div>
          {observations.length > 0 && (
            <div className="ai-flow-observations">
              {observations.map((entry, index) => <div key={index}>{String(entry.type ?? 'unknown')}：{stringArray(entry.evidence).join('；')}</div>)}
            </div>
          )}
        </>
      );
    }
    const observations = Array.isArray(decision.output) ? decision.output : [];
    return (
      <div className="ai-flow-observations">
        {observations.map((entry, index) => {
          const item = outputObject(entry);
          return <div key={index}>{String(item?.type ?? 'unknown')}：{stringArray(item?.evidence).join('；')}</div>;
        })}
        {observations.length === 0 && <div>没有触发额外视觉复核问题</div>}
      </div>
    );
  };
  const renderDecision = (decision: AiDecisionRecord, index: number): React.ReactNode => {
    const summary = decision.inputSummary;
    const images = decisionAnnotations(decision);
    return (
      <details className={`ai-flow-call ${decision.status}`} key={`${decision.stage}:${decision.inputHash}:${index}`} open={decision.status !== 'accepted'}>
        <summary>
          <span>{decision.scope?.label ?? `${AI_STAGE_LABEL[decision.stage]} ${index + 1}`}</span>
          <small>{DECISION_STATUS_LABEL[decision.status]} · {decision.cacheHit ? '缓存' : `${decision.latencyMs}ms`}</small>
        </summary>
        <div className="ai-flow-call-body">
          <div className="ai-flow-meta">
            <span>模型 {decision.model}</span>
            {summary?.designNodeCount !== undefined && <span>{summary.nodePolicy === 'layout-blocks' ? '设计布局块' : '设计节点'} {summary.designNodeCount}</span>}
            {summary?.appNodeCount !== undefined && <span>{summary.nodePolicy === 'layout-blocks' ? 'App 布局块' : 'App 节点'} {summary.appNodeCount}</span>}
            {summary?.designRegionCount !== undefined && <span>设计区域 {summary.designRegionCount}</span>}
            {summary?.appRegionCount !== undefined && <span>App 区域 {summary.appRegionCount}</span>}
            {summary?.candidateCount !== undefined && <span>候选 {summary.candidateCount}</span>}
            {summary?.imageCount !== undefined && <span>图片 {summary.imageCount}</span>}
            {summary?.originalImageWidth !== undefined && summary.originalImageHeight !== undefined && (
              <span>
                图像 {summary.originalImageWidth}×{summary.originalImageHeight}
                {summary.imageWidth !== undefined && summary.imageHeight !== undefined
                  ? ` → ${summary.imageWidth}×${summary.imageHeight}` : ''}
                {summary.imageScale !== undefined && summary.imageScale < 1
                  ? ` · 缩放 ${Math.round(summary.imageScale * 100)}%` : ''}
              </span>
            )}
          </div>
          {(decision.requestSummary || decision.responseSummary) && (
            <div className="ai-flow-structure">
              {decision.requestSummary && (
                <div>
                  <strong>请求结构</strong>
                  <span>协议 {decision.requestSummary.protocol ?? '-'}</span>
                  <span>消息 {decision.requestSummary.messageCount ?? 0}</span>
                  <span>内容 {decision.requestSummary.contentPartTypes?.join(' + ') || '-'}</span>
                  <span>字段 {decision.requestSummary.payloadKeys?.join('、') || '-'}</span>
                  {decision.requestSummary.imageLabels && decision.requestSummary.imageLabels.length > 0 && (
                    <span>图片 {decision.requestSummary.imageLabels.join('、')}</span>
                  )}
                </div>
              )}
              {decision.responseSummary && (
                <div>
                  <strong>响应结构</strong>
                  <span>状态 {decision.responseSummary.status === 'parsed' ? '已解析' : decision.responseSummary.status === 'invalid-json' ? 'JSON 无效' : '结构校验失败'}</span>
                  {decision.responseSummary.contentLength !== undefined && <span>长度 {decision.responseSummary.contentLength}</span>}
                  <span>根字段 {decision.responseSummary.rootKeys?.join('、') || '-'}</span>
                  {decision.responseSummary.arrayLengths && Object.keys(decision.responseSummary.arrayLengths).length > 0 && (
                    <span>数组 {Object.entries(decision.responseSummary.arrayLengths).map(([key, length]) => `${key}:${length}`).join('、')}</span>
                  )}
                  {decision.responseSummary.finishReason && <span>结束原因 {decision.responseSummary.finishReason}</span>}
                  {decision.responseSummary.actualOutput && (
                    <details className="ai-flow-actual-output">
                      <summary>查看 AI 实际输出{decision.responseSummary.actualOutputTruncated ? '（已截断）' : ''}</summary>
                      <pre>{decision.responseSummary.actualOutput}</pre>
                    </details>
                  )}
                  {decision.responseSummary.error && !decision.error?.includes(decision.responseSummary.error) && (
                    <span className="error">错误 {decision.responseSummary.error}</span>
                  )}
                </div>
              )}
            </div>
          )}
          {decision.error && <div className="ai-flow-error">{decision.error}</div>}
          {images.length > 0 && (
            <div className="ai-flow-images" aria-label={`本次${AI_STAGE_LABEL[decision.stage]}发送给 AI 的图片`}>
              {images.map((annotation) => {
                if (!annotation.url) return null;
                const url = annotation.url;
                const title = `${annotation.source === 'design' ? '设计稿' : 'App'} · ${annotation.kind === 'original' ? '原图' : `节点标注 ${annotation.page}`}`;
                return (
                  <figure key={`${annotation.source}:${annotation.kind}:${annotation.page}`}>
                    <button
                      type="button"
                      className="acceptance-image-trigger"
                      aria-label={`放大查看 ${title}`}
                      onClick={() => onPreviewImage(url, title)}
                    >
                      <img src={url} alt={title} />
                    </button>
                  <figcaption>
                    {title}
                    {annotation.nodeShortIds && annotation.nodeShortIds.length > 0 ? ` · ${annotation.nodeShortIds.join(' ')}` : ''}
                  </figcaption>
                  </figure>
                );
              })}
            </div>
          )}
          {decision.output !== undefined && renderDecisionOutput(decision)}
          <div className="ai-flow-hash" title={decision.inputHash}>输入 {decision.inputHash.slice(0, 12)} · {decision.promptVersion}</div>
        </div>
      </details>
    );
  };
  const aiStages: AiDecisionRecord['stage'][] = ['segmentation', 'alignment', 'node-matching', 'visual-review'];
  const localStatus = result.verdict === 'pass' ? 'accepted' : result.verdict === 'fail' || result.verdict === 'blocked' ? 'failed' : 'review';
  const inputAnalysis = result.inputAnalysis;
  const renderInputSide = (title: string, input: AcceptanceInputAnalysis['design']): React.ReactNode => (
    <div className="acceptance-input-side">
      <strong>{title}</strong>
      <div className="acceptance-input-stats">
        <span>总节点 {input.totalNodeCount}</span>
        <span>保留 {input.retainedNodeCount}</span>
        <span>过滤 {input.filteredNodeCount}</span>
      </div>
      <details>
        <summary>保留节点 {input.retainedNodeCount} 个</summary>
        <div className="acceptance-input-node-list">
          {input.retainedNodes.map((node) => (
            <div key={node.canonicalId}>
              <span>{node.canonicalId}</span>
              <span>{node.kind}</span>
              <span>{node.text?.slice(0, 24) || '无文本'}</span>
              <small>
                坐标 {Math.round(node.rect.x)},{Math.round(node.rect.y)} · {Math.round(node.rect.width)}×{Math.round(node.rect.height)}
              </small>
              <small>透明度 {Math.round(node.effectiveOpacity * 100)}%</small>
            </div>
          ))}
          {input.retainedNodes.length === 0 && <span className="ai-flow-empty">没有保留节点</span>}
        </div>
      </details>
      <details>
        <summary>过滤节点 {input.filteredNodeCount} 个</summary>
        <div className="acceptance-input-node-list filtered">
          {input.filteredNodes.map((node) => (
            <div key={node.canonicalId}>
              <span>{node.canonicalId}</span>
              <small>{node.reasons.map((reason) => FILTER_REASON_LABEL[reason] ?? reason).join('、')}</small>
            </div>
          ))}
          {input.filteredNodes.length === 0 && <span className="ai-flow-empty">没有过滤节点</span>}
        </div>
      </details>
    </div>
  );
  return (
    <section className="ai-flow" aria-label="AI 验收流程">
      <div className="acceptance-section-title">AI 验收流程</div>
      <div className={`ai-flow-step ${result.phase === 'input'
        ? result.phaseStatus === 'completed' ? 'accepted' : 'failed'
        : readiness?.ready ? 'accepted' : 'failed'}`}>
        <span className="ai-flow-marker">1</span>
        <div className="ai-flow-step-content">
          <div className="ai-flow-step-title"><strong>输入与门禁</strong><span>{result.phase === 'input'
            ? result.phaseStatus === 'completed' ? '完成' : '未通过'
            : readiness?.ready ? '完成' : '未通过'}</span></div>
        <div className="ai-flow-step-summary">
          {inputAnalysis
            ? `设计稿保留 ${inputAnalysis.design.retainedNodeCount}/${inputAnalysis.design.totalNodeCount} · App 保留 ${inputAnalysis.app.retainedNodeCount}/${inputAnalysis.app.totalNodeCount} · 坐标${result.coordinateValid ? '有效' : '无效'}`
            : `设计节点 ${result.summary.designNodeCount} · App 节点 ${result.summary.appNodeCount} · 坐标${result.coordinateValid ? '有效' : '无效'}`}
        </div>
      </div>
      </div>
      {inputAnalysis && (
        <div className="acceptance-input-analysis">
          <div className="acceptance-section-title">筛选后的节点与标注图</div>
          <div className="acceptance-input-columns">
            {renderInputSide('设计稿节点', inputAnalysis.design)}
            {renderInputSide('App 节点', inputAnalysis.app)}
          </div>
          <div className="acceptance-input-images">
            {inputAnalysis.annotations.map((annotation) => {
              if (!annotation.url) return null;
              const title = `${annotation.source === 'design' ? '设计稿' : 'App'} · ${annotation.kind === 'original' ? '原图' : '筛选节点标注图'}`;
              return (
                <figure key={`${annotation.source}:${annotation.kind}`}>
                  <button type="button" className="acceptance-image-trigger" onClick={() => onPreviewImage(annotation.url!, title)}>
                    <img src={annotation.url} alt={title} />
                  </button>
                  <figcaption>{title} · {Object.keys(annotation.shortIdMap).length} 个短 ID</figcaption>
                </figure>
              );
            })}
            {inputAnalysis.annotations.length === 0 && <div className="ai-flow-empty">截图不可用，未生成标注图</div>}
          </div>
        </div>
      )}
      {aiStages.map((stage, index) => {
        const records = decisionGroups.get(stage) ?? [];
        const status = stageStatus(stage);
        return (
          <div className={`ai-flow-step ${status}`} key={stage}>
            <span className="ai-flow-marker">{index + 2}</span>
            <div className="ai-flow-step-content">
              <div className="ai-flow-step-title">
                <strong>{AI_STAGE_LABEL[stage]}</strong>
                <span>
                  {status === 'accepted'
                    ? `完成 ${records.length} 次`
                    : status === 'failed'
                      ? '存在失败'
                      : result.phase === 'segmentation' && stage === 'segmentation'
                        ? '仅生成标注图，未提交 AI'
            : result.phase === 'input' || result.phase === 'segmentation' || result.phase === 'alignment' ? '未执行（当前阶段暂停）' : '未执行'}
                </span>
              </div>
              {records.map(renderDecision)}
            </div>
          </div>
        );
      })}
      <div className={`ai-flow-step ${localStatus}`}>
        <span className="ai-flow-marker">6</span>
        <div className="ai-flow-step-content">
          <div className="ai-flow-step-title">
            <strong>{result.phase === 'input' || result.phase === 'segmentation' || result.phase === 'alignment' ? '阶段结果' : '本地指标与页面汇总'}</strong>
            <span>{result.phase === 'input'
              ? result.phaseStatus === 'completed' ? '输入与门禁完成' : '输入与门禁未通过'
              : result.phase === 'segmentation' ? '页面分区完成' : result.phase === 'alignment' ? '区域匹配完成' : VERDICT_LABEL[result.verdict]}</span>
          </div>
          <div className="ai-flow-step-summary">
            {result.phase === 'input'
              ? `当前仅完成两侧节点筛选和标注图生成（${result.phaseStatus === 'completed' ? '已完成' : '失败'}），未提交 AI，页面分区及后续阶段未执行`
              : result.phase === 'segmentation'
              ? `当前完成两侧 AI 页面分区（${result.phaseStatus === 'input-only' ? '未提交 AI' : result.phaseStatus === 'completed' ? '已完成' : '失败'}），区域匹配、节点匹配和视觉复核未执行`
              : result.phase === 'alignment'
                ? `当前完成两侧 AI 页面分区和区域模块匹配（${result.phaseStatus === 'completed' ? '已完成' : '失败'}），节点匹配和视觉复核未执行`
                : `区域 ${analysis?.results.length ?? 0} · 页面得分 ${percent(analysis?.score ?? 0)} · 缺失 ${result.summary.missingCount} · 多余 ${result.summary.extraCount} · 未知 ${result.summary.unknownCount}`}
          </div>
            {result.phase !== 'input' && result.phase !== 'segmentation' && result.phase !== 'alignment' && (analysis?.results ?? []).filter((item) => item.status === 'fail' || item.status === 'unknown').map((item) => (
            <button type="button" className="ai-flow-problem" key={item.matchId} onClick={() => onFocusRegion(item.matchId)}>
              {item.regionId} · {REGION_STATUS_LABEL[item.status]} · 覆盖 {percent(item.coverage)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
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

interface AcceptancePanelProps {
  result: AcceptanceResult | null;
  pairId: string;
  requirementId: string;
  runId: string | null;
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
  /**
   * `design:12` / `app:34` → 人能读的名字，由 `CanvasBoard` 注入。
   *
   * 这里**必须**用可读名而不是 canonicalId：SDK 节点的 id 就是一串数字
   * （`App 4821`），而匹配明细是用户唯一能拿来定位的线索 ——
   * 一串数字等于没有线索，最后还是得回画布上一个个点着找。
   */
  nodeLabel: (canonicalId: string) => string;
  /**
   * 当前在画布上高亮着的那一条匹配（`NodeMatch.id`）。
   *
   * 由 `CanvasBoard` 持有并回灌：高亮的真正状态在画布那边（它要靠这个 id 决定画哪些框），
   * 面板只是把它显示出来 —— 列表行得有选中态，用户才知道自己刚才点的是哪一行、
   * 再去点一次能取消。
   */
  activeMatchKey: string | null;
  activeRegionMatchId: string | null;
  onUseAiChange: (value: boolean) => void;
  onRun: () => void;
  onLoadRun: (run: AcceptanceRunMeta) => void;
  /**
   * 点一条匹配 = 把两侧节点在画布上**整组高亮**（不移动视口，理由见
   * `CanvasBoard.handleFocusMatch`）。
   */
  onFocusMatch: (designNodeIds: string[], appNodeIds: string[], matchId?: string | null) => void;
  onFocusRegion: (matchId: string) => void;
  onConfirmRegion: (match: RegionMatch) => void;
  onCorrectRegion: (match: RegionMatch, appRegionId: string) => void;
  onIgnoreRegion: (match: RegionMatch) => void;
  onConfirmMatch: (match: NodeMatch) => void;
  onIgnoreMatch: (match: NodeMatch) => void;
}

/**
 * 验收结果面板（右栏第二个 tab）。
 *
 * 排布顺序刻意是「结论 → 不能通过的原因 → 逐条依据」：verdict 与计数在最上面
 * （一眼看到要不要管），门禁原因紧随其后（说明为什么连跑都不该跑），
 * 匹配明细放在可滚动区。
 *
 * 只有**待复核**的匹配才提供「确认 / 忽略」：已自动确认的条目再给按钮，等于鼓励
 * 用户去覆盖规则引擎已经算对的结论。
 *
 * ⚠️ 这里**不再列「问题（P0/P1/P2）」**（2026-09-17 按用户要求去掉）。那一段与下面的
 * 匹配明细讲的是同一件事的两面：缺失 / 多余 / 歧义在明细里本来就是一行（还带六特征分
 * 与候选榜），摊成两处只会让同一批节点出现两次、让面板长到扫不完。汇总计数仍留在上面
 * —— 「有没有问题」这个问题仍在第一屏就有答案。
 * `result.issues` 本身照旧由引擎产出（冒烟与真实结论都依赖它），只是不再单独铺开。
 */
const AcceptancePanel: React.FC<AcceptancePanelProps> = ({
  result,
  pairId,
  requirementId,
  runId,
  readiness,
  runError,
  busy,
  useAi,
  stale,
  nodeLabel,
  activeMatchKey,
  activeRegionMatchId,
  onUseAiChange,
  onRun,
  onLoadRun,
  onFocusMatch,
  onFocusRegion,
  onConfirmRegion,
  onCorrectRegion,
  onIgnoreRegion,
  onConfirmMatch,
  onIgnoreMatch,
}) => {
  const [aiConfig, setAiConfig] = React.useState<AiConfigStatus | null>(null);
  const [showAiConfig, setShowAiConfig] = React.useState(false);
  const [aiEndpoint, setAiEndpoint] = React.useState('https://api.openai.com/v1');
  const [aiModel, setAiModel] = React.useState('gpt-4o-mini');
  const [aiKey, setAiKey] = React.useState('');
  const [aiTimeoutSeconds, setAiTimeoutSeconds] = React.useState(90);
  const [aiConfigError, setAiConfigError] = React.useState<string | null>(null);
  const [aiConfigBusy, setAiConfigBusy] = React.useState(false);
  const [aiTestBusy, setAiTestBusy] = React.useState(false);
  const [aiTestResult, setAiTestResult] = React.useState<AiConnectionTestResult | null>(null);
  const [previewImage, setPreviewImage] = React.useState<{ url: string; title: string } | null>(null);
  const [previewScale, setPreviewScale] = React.useState(1);
  const [previewOffset, setPreviewOffset] = React.useState({ x: 0, y: 0 });
  const [previewDragging, setPreviewDragging] = React.useState(false);
  const [previewDownloadBusy, setPreviewDownloadBusy] = React.useState(false);
  const [previewDownloadError, setPreviewDownloadError] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<AcceptanceRunHistoryItem[]>([]);
  const [historyBusy, setHistoryBusy] = React.useState(false);
  const [historyLoadingId, setHistoryLoadingId] = React.useState<string | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const previewDrag = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const matches = result?.matches ?? [];
  const regionAnalysis = result?.regionAnalysis;
  const inputPhaseOnly = result?.phase === 'input';
  const regionPhaseOnly = result?.phase === 'segmentation' || result?.phase === 'alignment';
  const designRegions = new Map(regionAnalysis?.design.regions.map((region) => [region.id, region]) ?? []);
  const appRegions = regionAnalysis?.app.regions ?? [];
  const aiHistory = history.filter((item) => item.useAi);

  React.useEffect(() => {
    void window.api.verify.getAiConfigStatus().then((status) => {
      setAiConfig(status);
      if (status.endpoint) setAiEndpoint(status.endpoint);
      if (status.model) setAiModel(status.model);
      setAiTimeoutSeconds(Math.max(1, Math.round(status.timeoutMs / 1000)));
    }).catch((error: unknown) => setAiConfigError((error as Error).message));
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setHistoryBusy(true);
    setHistoryError(null);
    void window.api.verify.getAcceptanceRunHistory(pairId)
      .then((items) => {
        if (!cancelled) setHistory(items);
      })
      .catch((error: unknown) => {
        if (!cancelled) setHistoryError((error as Error).message);
      })
      .finally(() => {
        if (!cancelled) setHistoryBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pairId, runId]);

  React.useEffect(() => {
    if (!previewImage) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewImage]);

  const openPreviewImage = (url: string, title: string): void => {
    setPreviewImage({ url, title });
    setPreviewScale(1);
    setPreviewOffset({ x: 0, y: 0 });
    setPreviewDownloadError(null);
  };

  const handlePreviewWheel = (event: React.WheelEvent<HTMLImageElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const nextScale = Math.min(4, Math.max(0.5, previewScale * (event.deltaY < 0 ? 1.1 : 0.9)));
    setPreviewScale(nextScale);
    if (nextScale <= 1) setPreviewOffset({ x: 0, y: 0 });
  };

  const handlePreviewPointerDown = (event: React.PointerEvent<HTMLImageElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    previewDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: previewOffset.x,
      originY: previewOffset.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreviewDragging(true);
  };

  const handlePreviewPointerMove = (event: React.PointerEvent<HTMLImageElement>): void => {
    const drag = previewDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPreviewOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
  };

  const finishPreviewDrag = (event: React.PointerEvent<HTMLImageElement>): void => {
    if (previewDrag.current?.pointerId !== event.pointerId) return;
    previewDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPreviewDragging(false);
  };

  const downloadPreviewImage = async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (!previewImage || previewDownloadBusy) return;

    setPreviewDownloadBusy(true);
    setPreviewDownloadError(null);
    try {
      // sm-asset:// 不能直接作为 Electron 下载链接，否则会被当成页面导航打开。
      // 先读成 Blob，再使用临时 blob URL 触发下载，避免跳转到旧图片预览页。
      const response = await fetch(previewImage.url);
      if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`);
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = 'ai-acceptance-image.png';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (error) {
      setPreviewDownloadError(error instanceof Error ? error.message : '图片下载失败');
    } finally {
      setPreviewDownloadBusy(false);
    }
  };

  const loadHistoryRun = (item: AcceptanceRunHistoryItem): void => {
    if (historyLoadingId) return;
    setHistoryLoadingId(item.id);
    setHistoryError(null);
    void window.api.verify.getAcceptanceRun({ requirementId, runId: item.id })
      .then((loaded) => {
        if (!loaded) {
          setHistoryError('验收报告不存在或已损坏');
          return;
        }
        onLoadRun(loaded);
      })
      .catch((error: unknown) => setHistoryError((error as Error).message))
      .finally(() => setHistoryLoadingId(null));
  };

  const saveConfig = (event: React.FormEvent): void => {
    event.preventDefault();
    setAiConfigBusy(true);
    setAiConfigError(null);
    void window.api.verify.saveAiConfig({
      endpoint: aiEndpoint, model: aiModel, apiKey: aiKey, timeoutMs: aiTimeoutSeconds * 1000,
    })
      .then((status) => {
        setAiConfig(status);
        setAiKey('');
        setShowAiConfig(false);
      })
      .catch((error: unknown) => setAiConfigError((error as Error).message))
      .finally(() => setAiConfigBusy(false));
  };

  const testConnection = (): void => {
    setAiTestBusy(true);
    setAiConfigError(null);
    setAiTestResult(null);
    void window.api.verify.testAiConnection({
      endpoint: aiEndpoint, model: aiModel, apiKey: aiKey || undefined, timeoutMs: aiTimeoutSeconds * 1000,
    }).then(setAiTestResult)
      .catch((error: unknown) => setAiConfigError((error as Error).message))
      .finally(() => setAiTestBusy(false));
  };

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
          <span>AI 内容块验收</span>
        </label>
        <div className="acceptance-run-actions">
          <button type="button" className="btn" onClick={() => setShowAiConfig((value) => !value)}>
            AI 设置
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={onRun}>
            {busy ? '验收中…' : '运行验收'}
          </button>
        </div>
      </div>

      {useAi && aiConfig && !aiConfig.configured && (
        <div className="acceptance-ai-config-warning">AI 尚未配置，本次运行只会得到规则候选区域。</div>
      )}

      {showAiConfig && (
        <form className="acceptance-ai-config" onSubmit={saveConfig}>
          <label>
            <span>Endpoint</span>
            <input value={aiEndpoint} onChange={(event) => setAiEndpoint(event.target.value)} placeholder="https://api.openai.com/v1" />
          </label>
          <label>
            <span>Model</span>
            <input value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder="gpt-4o-mini" />
          </label>
          <label>
            <span>API key</span>
            <input type="password" value={aiKey} onChange={(event) => setAiKey(event.target.value)} autoComplete="off" placeholder="sk-..." />
          </label>
          <label>
            <span>超时</span>
            <input
              type="number"
              min="10"
              max="300"
              value={aiTimeoutSeconds}
              onChange={(event) => setAiTimeoutSeconds(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
          {aiConfigError && <div className="alert error flush">{aiConfigError}</div>}
          {aiTestResult && (
            <div className={`acceptance-ai-test-result ${aiTestResult.ok ? 'ok' : 'failed'}`}>
              {aiTestResult.ok
                ? `连接成功 · ${aiTestResult.model} · ${aiTestResult.latencyMs}ms`
                : `连接失败 · ${aiTestResult.error ?? '未知错误'} · ${aiTestResult.latencyMs}ms`}
            </div>
          )}
          <div className="acceptance-ai-config-footer">
            <span>{aiConfig?.configured ? `已配置 · ${aiConfig.model}` : '未配置'}</span>
            <div className="acceptance-ai-config-buttons">
              <button type="button" className="btn" disabled={aiTestBusy || aiConfigBusy} onClick={testConnection}>
                {aiTestBusy ? '测试中…' : '测试连接'}
              </button>
              <button type="submit" className="btn primary" disabled={aiConfigBusy || aiTestBusy}>
                {aiConfigBusy ? '保存中…' : '保存配置'}
              </button>
            </div>
          </div>
        </form>
      )}

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

          {inputPhaseOnly ? (
            <div className="acceptance-ai-state">当前仅完成节点筛选和标注图生成，未提交 AI 页面分区。</div>
          ) : regionPhaseOnly ? (
            <div className="acceptance-ai-state">当前仅完成 AI 页面分区，匹配、缺失和视觉结论将在后续阶段执行。</div>
          ) : (
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
          )}

          {result.ai && (
            <div className="acceptance-ai-state">
              {result.phase === 'input'
                ? '本次仅完成输入与门禁，未提交 AI'
                : result.phase === 'segmentation' && !result.ai.requested
                ? '本次仅生成页面分区标注图，未提交 AI'
                : result.ai.requested
                ? result.ai.applied
                  ? result.phase === 'segmentation' ? 'AI 页面分区已执行' : result.phase === 'alignment' ? 'AI 页面分区与区域匹配已执行' : 'AI 仲裁已执行'
                  : `AI 未生效：${result.ai.error ?? '未知原因'}`
                : 'AI 仲裁未启用'}
            </div>
          )}

          <div className="acceptance-scroll">
            {(result.ai?.requested || regionPhaseOnly) && (
              <AiAcceptanceFlow
                result={result}
                readiness={readiness}
                nodeLabel={nodeLabel}
                onFocusMatch={onFocusMatch}
                onFocusRegion={onFocusRegion}
                onPreviewImage={openPreviewImage}
              />
            )}
            {regionAnalysis && (
              <section className="acceptance-regions" aria-label="内容块验收">
                <div className="acceptance-section-title">
                  {regionPhaseOnly
                    ? `AI 页面分区与区域匹配 · 设计稿 ${regionAnalysis.design.regions.length} · App ${regionAnalysis.app.regions.length}`
                    : `内容块（${regionAnalysis.results.length}） · 页面得分 ${percent(regionAnalysis.score)}`}
                </div>
                {regionAnalysis.ai && (
                  <div className={`acceptance-region-ai ${regionAnalysis.ai.applied ? 'applied' : 'review'}`}>
                    {regionPhaseOnly && !regionAnalysis.ai.requested
                      ? `页面分区仅生成标注图，未提交 AI${regionAnalysis.ai.model ? ` · 配置模型 ${regionAnalysis.ai.model}` : ''}`
                      : regionAnalysis.ai.applied
                      ? `${regionPhaseOnly ? '页面分区与区域匹配 AI 已执行' : '区域 AI 已执行'}${regionAnalysis.ai.model ? ` · ${regionAnalysis.ai.model}` : ''}`
                      : `${regionPhaseOnly ? '页面分区或区域匹配 AI 失败' : '区域 AI 待复核'}：${regionAnalysis.ai.error ?? '未应用结论'}`}
                  </div>
                )}
                {regionPhaseOnly && (
                  <div className="acceptance-segmentation-region-summary">
                    {renderSegmentationRegions('设计稿区域', regionAnalysis.design.regions, nodeLabel)}
                    {renderSegmentationRegions('App 区域', regionAnalysis.app.regions, nodeLabel)}
                  </div>
                )}
                {!regionPhaseOnly && <div className="acceptance-region-list">
                  {regionAnalysis.results.map((regionResult, index) => {
                    const region = designRegions.get(regionResult.regionId);
                    const regionMatch = regionAnalysis.matches.find((match) => match.id === regionResult.matchId);
                    const designRegionKey = regionMatch?.designRegionIds.join('+');
                    const appRegionKey = regionMatch?.appRegionIds.join('+');
                    const appRegion = regionMatch?.appRegionIds[0]
                      ? appRegions.find((item) => item.id === regionMatch.appRegionIds[0])
                      : undefined;
                    const annotations = regionAnalysis.annotations?.filter((annotation) =>
                      annotation.regionId === designRegionKey || annotation.regionId === appRegionKey) ?? [];
                    const active = activeRegionMatchId === regionResult.matchId;
                    return (
                      <React.Fragment key={regionResult.matchId}>
                        <button
                          type="button"
                          className={`acceptance-region-row ${regionResult.status}${active ? ' active' : ''}`}
                          onClick={() => onFocusRegion(regionResult.matchId)}
                        >
                          <span className="acceptance-region-index">{index + 1}</span>
                          <span className="acceptance-region-name">
                            {REGION_ROLE_LABEL[region?.role ?? 'unknown'] ?? region?.role ?? '内容块'}
                            <small>{region?.origin === 'ai' ? 'AI' : region?.origin === 'manual' ? '人工' : '规则'}</small>
                            {region?.support?.moduleNodeStatus && (
                              <small title={region.support.moduleNodeId ?? '没有可用节点锚点'}>
                                {region.support.moduleNodeStatus === 'matched'
                                  ? `锚点 ${region.support.moduleNodeId ? nodeLabel(region.support.moduleNodeId) : '已解析'}`
                                  : region.support.moduleNodeStatus === 'ambiguous' ? '节点锚点歧义' : '视觉模块无节点'}
                              </small>
                            )}
                          </span>
                          <span className="acceptance-region-metric">覆盖 {percent(regionResult.coverage)}</span>
                          <span className="acceptance-region-metric">位置 {percent(regionResult.geometryScore)}</span>
                          <span className="acceptance-region-metric">视觉 {percent(regionResult.visualScore)}</span>
                          <span className="acceptance-region-status">{REGION_STATUS_LABEL[regionResult.status]}</span>
                        </button>
                        {active && regionMatch && (
                          <div className="acceptance-region-evidence">
                            <div className="acceptance-region-anchor-evidence">
                              <span>模块矩形按 AI 视觉边界保留</span>
                              <span>
                                设计稿节点锚点：{region?.support?.moduleNodeId
                                  ? nodeLabel(region.support.moduleNodeId)
                                  : region?.support?.moduleNodeStatus === 'ambiguous' ? '歧义' : '未找到'}
                              </span>
                              <span>
                                App 节点锚点：{appRegion?.support?.moduleNodeId
                                  ? nodeLabel(appRegion.support.moduleNodeId)
                                  : appRegion?.support?.moduleNodeStatus === 'ambiguous' ? '歧义' : '未找到'}
                              </span>
                              <span>
                                候选：设计稿 {region?.support?.moduleNodeCandidates?.length ?? 0} · App {appRegion?.support?.moduleNodeCandidates?.length ?? 0}
                              </span>
                            </div>
                            <div className="acceptance-region-actions">
                              <button type="button" className="btn" onClick={() => onConfirmRegion(regionMatch)}>确认区域</button>
                              <select
                                aria-label="改配 App 区域"
                                defaultValue=""
                                onChange={(event) => {
                                  if (event.target.value) onCorrectRegion(regionMatch, event.target.value);
                                  event.target.value = '';
                                }}
                              >
                                <option value="" disabled>改配到…</option>
                                {appRegions.map((appRegion) => (
                                  <option value={appRegion.id} key={appRegion.id}>
                                    {REGION_ROLE_LABEL[appRegion.role] ?? appRegion.role} · {appRegion.id}
                                  </option>
                                ))}
                              </select>
                              <button type="button" className="btn" onClick={() => onIgnoreRegion(regionMatch)}>忽略区域</button>
                              <button type="button" className="btn" disabled={busy} onClick={onRun}>重新分析</button>
                            </div>
                            {annotations.map((annotation) => {
                              if (!annotation.url) return null;
                              const url = annotation.url;
                              const title = `${annotation.source === 'design' ? '设计稿' : 'App'} · ${annotation.kind === 'original' ? '原图' : `节点标注 ${annotation.page}`}`;
                              return (
                                <figure key={`${annotation.source}:${annotation.kind}:${annotation.page}`}>
                                  <button
                                    type="button"
                                    className="acceptance-image-trigger"
                                    aria-label={`放大查看 ${title}`}
                                    onClick={() => openPreviewImage(url, title)}
                                  >
                                    <img src={url} alt={title} />
                                  </button>
                                  <figcaption>{title}</figcaption>
                                </figure>
                              );
                            })}
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>}
              </section>
            )}
            {!regionPhaseOnly && (
              <>
                <div className="acceptance-section-title">匹配明细（{matches.length}）</div>
                <MatchDetailList
                  matches={matches}
                  nodeLabel={nodeLabel}
                  activeKey={activeMatchKey}
                  onFocusMatch={onFocusMatch}
                  onConfirmMatch={onConfirmMatch}
                  onIgnoreMatch={onIgnoreMatch}
                />
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

      <section className="acceptance-history" aria-label="AI 验收历史">
        <div className="acceptance-history-title">
          <span>AI 验收历史</span>
          <small>{aiHistory.length} 次</small>
        </div>
        {historyError && <div className="acceptance-history-error">{historyError}</div>}
        {historyBusy ? (
          <div className="acceptance-history-empty">正在加载历史记录…</div>
        ) : aiHistory.length === 0 ? (
          <div className="acceptance-history-empty">暂无 AI 验收记录</div>
        ) : (
          <div className="acceptance-history-list">
            {aiHistory.map((item) => {
              const statusLabel = item.status === 'completed'
                ? VERDICT_LABEL[item.verdict ?? 'review']
                : item.status === 'failed' ? '执行失败' : '执行中';
              const summary = item.summary;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`acceptance-history-item${item.id === runId ? ' active' : ''}`}
                  disabled={historyLoadingId !== null}
                  onClick={() => loadHistoryRun(item)}
                >
                  <span className={`acceptance-history-verdict ${item.verdict ?? item.status}`}>
                    {historyLoadingId === item.id ? '加载中…' : statusLabel}
                  </span>
                  <span className="acceptance-history-main">
                    <strong>{formatHistoryTime(item.createdAt)}</strong>
                    <small>
                      {item.phase === 'input'
                        ? '完成输入与门禁节点筛选'
                        : item.phase === 'segmentation'
                        ? '完成两侧 AI 页面分区'
                        : item.phase === 'alignment'
                          ? '完成 AI 页面分区与区域匹配'
                          : summary
                        ? `匹配 ${summary.matchedCount} · 缺失 ${summary.missingCount} · 多余 ${summary.extraCount}`
                        : item.error ?? '没有结果摘要'}
                    </small>
                  </span>
                  <span className="acceptance-history-meta">
                    {item.phase === 'input' ? '输入与门禁阶段' : item.phase === 'segmentation' ? '页面分区阶段' : item.phase === 'alignment' ? '区域匹配阶段' : item.aiApplied === true ? 'AI 已执行' : 'AI 未生效'}
                    {item.score !== undefined ? ` · ${percent(item.score)}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {previewImage && (
        <div
          className="acceptance-image-preview"
          role="dialog"
          aria-modal="true"
          aria-label={`${previewImage.title}预览`}
          onClick={() => setPreviewImage(null)}
        >
          <div className="acceptance-image-preview-panel" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="acceptance-image-preview-close"
              aria-label="关闭图片预览"
              onClick={() => setPreviewImage(null)}
            >
              ×
            </button>
            <div className="acceptance-image-preview-viewport">
              <img
                src={previewImage.url}
                alt={previewImage.title}
                className={previewDragging ? 'dragging' : undefined}
                onWheel={handlePreviewWheel}
                onPointerDown={handlePreviewPointerDown}
                onPointerMove={handlePreviewPointerMove}
                onPointerUp={finishPreviewDrag}
                onPointerCancel={finishPreviewDrag}
                style={{ transform: `translate3d(${previewOffset.x}px, ${previewOffset.y}px, 0) scale(${previewScale})` }}
              />
            </div>
            <div className="acceptance-image-preview-toolbar">
              <span>{previewImage.title} · {Math.round(previewScale * 100)}%</span>
              <button
                type="button"
                className="acceptance-image-preview-download"
                disabled={previewDownloadBusy}
                onClick={downloadPreviewImage}
              >
                {previewDownloadBusy ? '下载中…' : '下载图片'}
              </button>
              {previewDownloadError && <span className="acceptance-image-preview-download-error">{previewDownloadError}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AcceptancePanel;
