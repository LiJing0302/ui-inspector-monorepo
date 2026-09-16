import React from 'react';

import type { BridgeStatus } from '@shared/ipc';

interface BridgeChipProps {
  /** null = 还没取到状态（首帧） */
  status: BridgeStatus | null;
  /** 启停过程中禁用按钮，避免连点出竞态 */
  pending: boolean;
  onToggle: (enabled: boolean) => void;
}

/**
 * 顶栏上的直传状态条。
 *
 * 不做配对码，所以用户的感知成本必须压到零 —— 默认打开就绪、插件连上就直接能推，
 * 这里只负责把「现在什么状态、刚才收到了什么」说清楚。
 * 详细说明（监听地址、被拒连接数、上一次的整包错误）全放进 title，不挤占顶栏。
 */
function summarize(last: NonNullable<BridgeStatus['lastImport']>): string {
  if (last.fatal) return '接收失败';
  const parts: string[] = [];
  if (last.imported) parts.push(`新增 ${last.imported}`);
  if (last.replaced) parts.push(`覆盖 ${last.replaced}`);
  if (last.skipped) parts.push(`跳过 ${last.skipped}`);
  if (last.failed) parts.push(`失败 ${last.failed}`);
  return parts.length ? parts.join(' · ') : '无变化';
}

const BridgeChip: React.FC<BridgeChipProps> = ({ status, pending, onToggle }) => {
  const running = status?.running ?? false;
  const last = status?.lastImport;

  const detail =
    status === null
      ? '读取中…'
      : !running
        ? '已关闭'
        : status.busy
          ? '正在接收…'
          : status.clients > 0
            ? `插件已连接 :${status.port}`
            : `就绪 :${status.port}`;

  const title = [
    'Figma 插件可以把导出的 zip 直接发到本应用，省掉「下载 → 再拖进来」。',
    `仅监听 ${status?.host ?? '127.0.0.1'}:${status ? status.port : '—'}，只接受本机连接。`,
    last
      ? `最近接收：${last.packageName} → 「${last.requirementName}」${last.fatal ? `（整包被拒：${last.fatal}）` : ''}`
      : '还没有接收过。',
    status && status.rejected > 0
      ? `已拒绝 ${status.rejected} 次来自网页的连接（只放行插件，安全策略）。`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className={`bridge-chip${running ? ' on' : ''}`} title={title}>
      <span className={`bridge-dot${running ? ' on' : ''}`} />
      <span className="bridge-name">插件直传</span>
      <span className="bridge-detail">{detail}</span>
      {last && <span className={`bridge-last${last.fatal ? ' bad' : ''}`}>{summarize(last)}</span>}
      {status && status.rejected > 0 && <span className="tag warn-tag">拒 {status.rejected}</span>}
      <button
        type="button"
        className="btn tiny ghost"
        disabled={pending || status === null}
        title={running ? '停止接收插件推送（回环端口会关闭）' : '开始接收插件推送'}
        onClick={() => onToggle(!running)}
      >
        {running ? '暂停' : '启用'}
      </button>
    </div>
  );
};

export default BridgeChip;
