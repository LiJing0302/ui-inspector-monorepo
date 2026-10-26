import React from 'react';
import { designAlignedScale, displayLengthValue, formatManualNumbers, isManualLength, targetBasis, logicalUnit, manualStatusLabel, hasExplicitValue, hasPropertyValue, visibleManualFields, type ManualField, type PropertySources } from '../lib/manualAcceptance';
import type { AppAlignContext } from '../lib/comparison';
import type { CompareValue } from '../lib/comparison';

const rawNumberText = (value: CompareValue): string | undefined => {
  if (!hasExplicitValue(value) || !value.numbers?.length) return undefined;
  return formatManualNumbers(value.numbers, value.text.match(/\s(px|dp|pt|逻辑单位)$/)?.[1]);
};

export const PropertyValue: React.FC<{ value: CompareValue; sources?: PropertySources; scale?: number }> = ({ value, sources, scale }) => <>
  <span>{value.color && <span className="swatch" style={{ background: value.color }} />}{displayLengthValue(value, scale).text}</span>
  {sources?.state === 'ambiguous' && <details className="property-sources">
    <summary>查看各层数值</summary>
    {sources.reason && <p>{sources.reason}</p>}
    {sources.candidates.map(c => <p key={c.id} title={`${c.id}${rawNumberText(c.value) ? ` · 原始数值 ${rawNumberText(c.value)}` : ''}`}>
      {c.name}：{displayLengthValue(c.value, scale).text}{c.ignored ? '（不参与此属性汇总）' : ''}
      {sources.state === 'ambiguous' && !c.ignored && rawNumberText(c.value) && <><br />原始读数：{rawNumberText(c.value)}</>}
    </p>)}
  </details>}
</>;

export const ManualAcceptanceTable: React.FC<{ fields: ManualField[]; align?: AppAlignContext }> = ({ fields, align }) => {
  const visibleFields = visibleManualFields(fields);
  const scale = designAlignedScale(align);
  const count = (status: ManualField['status']): number => visibleFields.filter((f) => f.status === status).length;
  return <>
    <div className="manual-unit-note">{scale === undefined ? `设计长度原值：px · App 实测值：${logicalUnit(align)}` : '长度单位：px（统一对齐设计稿）'}</div>
    <div className="manual-unit-note" title={targetBasis(align)}>{scale === undefined
      ? 'App 实测值保留设备采集单位'
      : 'App 对齐值 = 原始逻辑值 × 设计稿宽 ÷ 截图逻辑宽'}</div>
    <div className="compare-summary" role="status">
      {count('consistent')} 项数值一致 · {count('discrepancy')} 项偏差 · {count('insufficient')} 项信息不足
      {count('not-applicable') > 0 && ` · ${count('not-applicable')} 项无需比较`}
    </div>
    <div className="compare-table manual-table" role="table" aria-label="人工验收属性对照">
      <div className="compare-row compare-head" role="row">
        {['属性', '设计原值', scale === undefined ? 'App 实测值' : 'App 对齐值'].map((label) => <div key={label} role="columnheader">{label}</div>)}
      </div>
      {visibleFields.map((field) => <div key={field.label} className={`compare-row manual-${field.status}`} role="row" title={field.reason}>
        <div className="compare-key manual-key" role="rowheader"><span>{field.label}</span>{field.status !== 'reference' && <small>{Object.values(field.sources ?? {}).some(s => s?.state === 'ambiguous') ? '多层待确认' : manualStatusLabel[field.status]}</small>}</div>
        {[field.design, field.actual].map((value, index) => <div className={`compare-cell${value.state !== 'value' ? ' is-unavailable' : ''}`} role="cell" key={index}>
          {hasPropertyValue(value, index === 0 ? field.sources?.design : field.sources?.app) && <PropertyValue value={value} sources={index === 0 ? field.sources?.design : field.sources?.app}
            scale={index > 0 && isManualLength(field.label) ? scale : undefined} />}
        </div>)}
      </div>)}
    </div>
    <div className="manual-unit-note">数值提示供人工判断，外观、裁切和换行仍需检查。</div>
  </>;
};
