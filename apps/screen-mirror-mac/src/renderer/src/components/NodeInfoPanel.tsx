import React, { useState } from 'react';

import type { AppNode, DesignNode, IssueSeverity, VerifySource } from '@shared/verify';
import type { CanvasCapture, SaveIssueInput } from '@shared/ipc';
import type { AppAlignContext } from '../lib/comparison';
import { designAlignedScale, isManualLength, hasPropertyValue, manualEvidence, type ManualField, type SpacingSample } from '../lib/manualAcceptance';
import { ManualAcceptanceTable, PropertyValue } from './ManualAcceptanceTable';
import { buildInspectionFields, inspectionEvidence, inspectionKey, resolveProperties, type InspectionGroups, type InspectionScope } from '../lib/elementInspection';
import { appLayerHint, designLayerHint } from '../lib/stack';
import { NodeOverlayPreview } from './NodeOverlayPreview';
import type { OverlayImage } from '../lib/nodeOverlay';

export type SelectedNode =
  | { source: 'design'; node: DesignNode }
  | { source: 'app'; node: AppNode };

export interface StackMemberView {
  id: string;

  name: string;

  hint: string;
}

export interface StackView {

  selectedId: string;
  members: StackMemberView[];
}

interface NodeInfoPanelProps {
  visible: boolean;
  selected: SelectedNode | null;
  comparison?: { design: DesignNode; app: AppNode } | null;
  spacingActive: boolean;
  spacingFields?: ManualField[];
  spacingSamples?: { design?: SpacingSample; app?: SpacingSample };
  requirementId: string;
  pairId: string;
  designNodeId: string | null;
  appNodeId: string | null;
  onIssueSaved: () => void;
  onCaptureCanvas: () => Promise<CanvasCapture>;

  inspectionGroups?: InspectionGroups;

  onPickStackLayer?: (source: VerifySource, id: string) => void;

  appAlign?: AppAlignContext;
  previewImages?: { design: OverlayImage; app: OverlayImage };
  overlayMode?: boolean;

}

interface IssueContext {
  source: SaveIssueInput['source'];
  designNodeId: string | null;
  appNodeId: string | null;
  evidence: string;
}

export const shortClassName = (className: string): string => className.split('.').pop() || className;

const StackList: React.FC<{ stack: StackView; onPick?: (id: string) => void }> = ({
  stack,
  onPick,
}) => (
  <div className="stack-rows">
    {[...stack.members].reverse().map(member => <button key={member.id} type="button"
      className={`stack-row${member.id === stack.selectedId ? ' on' : ''}`}
      title={member.id} onClick={() => onPick?.(member.id)}>
      <span className="stack-name">{member.name}</span><span className="stack-hint">{member.hint}</span>
    </button>)}
  </div>
);

const NodeInfoPanel: React.FC<NodeInfoPanelProps> = ({
  visible,
  selected,
  comparison,
  spacingActive,
  spacingFields = [],
  spacingSamples,
  requirementId,
  pairId,
  designNodeId,
  appNodeId,
  onIssueSaved,
  onCaptureCanvas,
  inspectionGroups,
  onPickStackLayer,
  appAlign,
  previewImages,
  overlayMode = false,
}) => {
  const displayScale = designAlignedScale(appAlign);
  const groups: InspectionGroups = {
    design: inspectionGroups?.design ?? (comparison?.design ? { anchor: comparison.design, members: [comparison.design] }
      : selected?.source === 'design' ? { anchor: selected.node, members: [selected.node] } : undefined),
    app: inspectionGroups?.app ?? (comparison?.app ? { anchor: comparison.app, members: [comparison.app] }
      : selected?.source === 'app' ? { anchor: selected.node, members: [selected.node] } : undefined),
  };
  const [scopeChoices, setScopeChoices] = useState<Partial<Record<VerifySource, { key: string; scope: InspectionScope }>>>({});
  const scopeKey = (source: VerifySource): string => {
    const group = groups[source];
    return pairId + (group ? inspectionKey<DesignNode | AppNode>(source, group) : source);
  };
  const scopes: Record<VerifySource, InspectionScope> = {
    design: scopeChoices.design?.key === scopeKey('design') ? scopeChoices.design.scope : 'element',
    app: scopeChoices.app?.key === scopeKey('app') ? scopeChoices.app.scope : 'element',
  };
  const chooseScope = (source: VerifySource, scope: InspectionScope): void => {
    const key = scopeKey(source);
    setScopeChoices(prev => ({ ...prev, [source]: { key, scope } }));
  };
  const singleProperties = selected?.source === 'design' && groups.design
    ? resolveProperties('design', groups.design, appAlign, scopes.design)
    : selected?.source === 'app' && groups.app ? resolveProperties('app', groups.app, appAlign, scopes.app) : [];
  const fields = spacingActive ? spacingFields : comparison ? buildInspectionFields(groups, appAlign, scopes) : [];
  const evidenceValues = fields.length ? manualEvidence(fields, appAlign)
    : selected ? JSON.stringify({ source: selected.source, node: selected.node, properties: singleProperties.map(({ owner: _owner, ...property }) => property), context: appAlign?.acceptanceContext }) : '';
  const evidence = evidenceValues + (spacingActive && spacingSamples ? `\n测距元素与矩形：${JSON.stringify(spacingSamples)}` : `\n${inspectionEvidence(groups, scopes)}`);
  const renderInspectionLayers = (source: VerifySource): React.ReactNode => {
    const group = groups[source];
    if (!group || group.members.length <= 1) return null;
    // 始终检查元素汇总，切换到单层后也能保留冲突模块与返回汇总的入口。
    if (!resolveProperties<DesignNode | AppNode>(source, group, appAlign, 'element')
      .some(property => property.sources.state === 'ambiguous' && hasPropertyValue(property.value, property.sources))) return null;
    const title = source === 'app' ? 'App' : '设计稿';
    const stack: StackView = { selectedId: source === 'design' ? (group.anchor as DesignNode).id : (group.anchor as AppNode).nodeId,
      members: group.members.map(node => source === 'design'
        ? { id: (node as DesignNode).id, name: (node as DesignNode).name, hint: designLayerHint(node as DesignNode) }
        : { id: (node as AppNode).nodeId, name: shortClassName((node as AppNode).className), hint: appLayerHint(node as AppNode) }) };
    return <div className="info-stack" key={source}>
      <div className="stack-head"><span>{title} · 由 {group.members.length} 层组成</span><span className="stack-badge">位置重合</span></div>
      <div className="inspection-scope" role="group" aria-label={`${title}检查范围`}>
        <button type="button" aria-pressed={scopes[source] === 'element'} onClick={() => chooseScope(source, 'element')}>元素汇总</button>
        <button type="button" aria-pressed={scopes[source] === 'layer'} onClick={() => chooseScope(source, 'layer')}>单层属性</button>
      </div>
      <div className="stack-foot">{scopes[source] === 'element' ? '按属性来源汇总，冲突值需逐层确认。' : `仅检查当前层：${stack.members.find(m => m.id === stack.selectedId)?.name}`}</div>
      <details><summary>查看 {group.members.length} 个原始图层</summary>
        <StackList stack={stack} onPick={id => { chooseScope(source, 'layer'); onPickStackLayer?.(source, id); }} />
      </details>
    </div>;
  };
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueSeverity, setIssueSeverity] = useState<IssueSeverity>('P2');
  const [issueDescription, setIssueDescription] = useState('');
  const [issueImage, setIssueImage] = useState<CanvasCapture | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [issueContext, setIssueContext] = useState<IssueContext | null>(null);
  const hasIssueTarget = Boolean(designNodeId || appNodeId);

  const showDevNodeId = import.meta.env.DEV && Boolean(designNodeId || appNodeId);

  const openIssueForm = (): void => {
    const source: SaveIssueInput['source'] = designNodeId && appNodeId
      ? 'both'
      : designNodeId
        ? 'design'
        : 'app';
    setIssueContext({ source, designNodeId, appNodeId, evidence });
    setIssueSeverity('P2');
    setIssueDescription('');
    setIssueImage(null);
    setIssueError(null);
    setIssueOpen(true);
  };

  const saveIssue = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!issueContext || !issueDescription.trim()) return;
    setIssueBusy(true);
    setIssueError(null);
    try {
      await window.api.verify.saveIssue({
        requirementId,
        pairId,
        source: issueContext.source,
        position: null,
        nodeId: issueContext.designNodeId ?? issueContext.appNodeId,
        designNodeId: issueContext.designNodeId,
        appNodeId: issueContext.appNodeId,
        severity: issueSeverity,
        description: issueDescription.trim(),
        acceptanceEvidence: issueContext.evidence,
        image: issueImage
          ? { dataUrl: issueImage.dataUrl, width: issueImage.width, height: issueImage.height }
          : null,
      });
      setIssueOpen(false);
      setIssueDescription('');
      setIssueContext(null);
      onIssueSaved();
    } catch (cause) {
      setIssueError((cause as Error).message || '保存问题失败');
    } finally {
      setIssueBusy(false);
    }
  };

  const captureCanvas = async (): Promise<void> => {
    setCaptureBusy(true);
    setIssueError(null);
    try {
      setIssueImage(await onCaptureCanvas());
    } catch (cause) {
      setIssueError((cause as Error).message || '截取画布失败');
    } finally {
      setCaptureBusy(false);
    }
  };

  let content: React.ReactNode;
  if (overlayMode) {
    content = <div className="info-empty">叠图验收<br />截图内拖动截图，截图外平移画布；点选节点请切回「全页验收」。</div>;
  } else if (spacingActive) {
    content = <div className="info-content compare-content">
      <div className="info-hint">量的是两个元素布局框的边界距离，不等同于源码 margin / padding。两侧分别固定对应元素后可对照。</div>
      {spacingFields.length ? <ManualAcceptanceTable fields={spacingFields} align={appAlign} /> : <div className="info-empty">当前两个框没有可显示的间距</div>}
    </div>;
  } else if (comparison) {
    content = <div className="info-content compare-content">
      {renderInspectionLayers('design')}{renderInspectionLayers('app')}
      <ManualAcceptanceTable fields={fields} align={appAlign} />
    </div>;
  } else if (!selected) {
    content = <div className="info-empty">单击画布选中元素</div>;
  } else {
    content = <div className="info-content">
      {renderInspectionLayers(selected.source)}
      {((groups[selected.source]?.members.length ?? 0) > 1 && scopes[selected.source] === 'element')
        ? <div className="inspection-properties" role="table" aria-label="元素汇总属性">{singleProperties.filter(property => hasPropertyValue(property.value, property.sources)).map(property => <div className="inspection-property" role="row" key={property.label}>
          <span role="rowheader">{property.label}</span><div role="cell"><PropertyValue value={property.value} sources={property.sources}
            scale={selected.source === 'app' && isManualLength(property.label) ? displayScale : undefined} /></div>
        </div>)}</div>
        : <div className="info-fields">{singleProperties.filter(property => hasPropertyValue(property.value, property.sources)).map(property => <div className="info-row" key={property.label}>
          <div className="row-key">{property.label}</div>
          <div className="row-val"><PropertyValue value={property.value}
            scale={selected.source === 'app' && isManualLength(property.label) ? displayScale : undefined} /></div>
        </div>)}</div>}
    </div>;
  }

  return (
    <>
      {visible && (
        <>
          {}
          {!overlayMode && showDevNodeId && (
            <div className="info-dev-nodeid">
              <span className="dev-nodeid-title">DEV · 选中节点 id</span>
              {designNodeId && (
                <div className="dev-nodeid-item">
                  <span className="src-tag design">设计稿</span>
                  <code>{designNodeId}</code>
                </div>
              )}
              {appNodeId && (
                <div className="dev-nodeid-item">
                  <span className="src-tag app">App</span>
                  <code>{appNodeId}</code>
                </div>
              )}
            </div>
          )}
          {content}
          {!overlayMode && comparison && !spacingActive && previewImages && <NodeOverlayPreview
            key={JSON.stringify([pairId, comparison.design.id, comparison.app.nodeId, previewImages.design.imageUrl, previewImages.app.imageUrl])}
            design={{ ...previewImages.design, rect: comparison.design.rect }}
            app={{ ...previewImages.app, rect: { x: comparison.app.x, y: comparison.app.y, width: comparison.app.width, height: comparison.app.height } }}
          />}

        </>
      )}
      <div className="issue-create-area">
        {!issueOpen ? (
          <button type="button" className="btn issue-create-trigger" disabled={!hasIssueTarget} onClick={openIssueForm}>
            ＋ 记录问题
          </button>
        ) : (
          <form className="issue-create-form" onSubmit={(event) => void saveIssue(event)}>
            <div className="issue-create-title">记录问题</div>
            <div className="issue-target-tags">
              {issueContext?.designNodeId && <span className="src-tag design">设计稿节点</span>}
              {issueContext?.appNodeId && <span className="src-tag app">App 节点</span>}
            </div>
            <div className="issue-form-fields">
              <label>
                级别
                <select value={issueSeverity} onChange={(event) => setIssueSeverity(event.target.value as IssueSeverity)}>
                  <option value="P0">P0 · 阻断</option>
                  <option value="P1">P1 · 严重</option>
                  <option value="P2">P2 · 一般</option>
                </select>
              </label>
            </div>
            <div className="issue-image-field">
              <div className="issue-image-actions">
                <span className="issue-image-label">问题图片</span>
                <button type="button" className="btn tiny" disabled={issueBusy || captureBusy} onClick={() => void captureCanvas()}>
                  {captureBusy ? '请拖拽选择…' : issueImage ? '重新截取画布' : '拖拽截取画布'}
                </button>
                {issueImage && (
                  <button type="button" className="btn tiny" disabled={issueBusy || captureBusy} onClick={() => setIssueImage(null)}>
                    移除
                  </button>
                )}
              </div>
              {issueImage ? (
                <img className="issue-image-preview" src={issueImage.dataUrl} alt="问题截图预览" />
              ) : (
                <span className="issue-image-hint">点击后在画布上拖拽选择图片区域</span>
              )}
            </div>
            {issueContext?.evidence && <details className="manual-diagnostics"><summary>随问题保存的验收读数</summary><pre>{issueContext.evidence}</pre></details>}
            <label className="issue-description-label">
              问题描述
              <textarea
                value={issueDescription}
                onChange={(event) => setIssueDescription(event.target.value)}
                placeholder="描述实际表现与预期差异"
                rows={3}
                required
              />
            </label>
            {issueError && <div className="issue-form-error" role="alert">{issueError}</div>}
            <div className="issue-form-actions">
              <button type="button" className="btn tiny" disabled={issueBusy || captureBusy} onClick={() => setIssueOpen(false)}>取消</button>
              <button type="submit" className="btn primary tiny" disabled={issueBusy || captureBusy || !issueDescription.trim()}>
                {issueBusy ? '保存中…' : '保存问题'}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
};

export default NodeInfoPanel;
