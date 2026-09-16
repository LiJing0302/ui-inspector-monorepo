import React, { useCallback, useEffect, useState } from 'react';

import type { RequirementMeta } from '@shared/verify';

interface RequirementsPageProps {
  /** 打开需求 = 直达验收工作台（素材、配对、画布都在那一个页面里） */
  onOpen: (requirement: RequirementMeta) => void;
  /** 插件直传导入后由 App 递增，用来触发静默重新拉取 */
  reloadToken?: number;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const RequirementsPage: React.FC<RequirementsPageProps> = ({ onOpen, reloadToken = 0 }) => {
  const [requirements, setRequirements] = useState<RequirementMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  /**
   * 刻意**不在这里 setLoading(true)**：`loading` 的初始值已经是 true，
   * 只在首次拉取结束时落回 false。这样插件直传触发的静默刷新（以及新建/删除后的刷新）
   * 不会让列表闪一下「加载中…」，只有真正的首屏才显示。
   */
  const refresh = useCallback(async () => {
    setError(null);
    try {
      setRequirements(await window.api.verify.listRequirements());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadToken]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await window.api.verify.createRequirement({
        name,
        description: newDescription.trim() || undefined,
      });
      setNewName('');
      setNewDescription('');
      setCreating(false);
      await refresh();
      onOpen(created);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [newDescription, newName, onOpen, refresh]);

  const handleDelete = useCallback(
    async (requirement: RequirementMeta) => {
      const confirmed = window.confirm(
        `删除需求「${requirement.name}」？\n\n该需求下的设计稿、截图与问题记录都会被一并删除，且不可恢复。`,
      );
      if (!confirmed) return;
      try {
        await window.api.verify.deleteRequirement(requirement.id);
        await refresh();
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [refresh],
  );

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">需求列表</h1>
          <p className="page-sub">
            一次 UI 验收 = 一个需求。在里面导入 Figma 设计稿、采集真机截图，然后配对进入验收。
          </p>
        </div>
        <button type="button" className="btn primary" onClick={() => setCreating((value) => !value)}>
          {creating ? '取消' : '新建需求'}
        </button>
      </div>

      {creating && (
        <div className="card create-card">
          <div className="field">
            <label className="field-label" htmlFor="req-name">
              需求名称
            </label>
            <input
              id="req-name"
              className="input"
              value={newName}
              placeholder="例如：盲盒抽奖活动"
              autoFocus
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate();
                if (event.key === 'Escape') setCreating(false);
              }}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="req-desc">
              描述（可选）
            </label>
            <input
              id="req-desc"
              className="input"
              value={newDescription}
              placeholder="版本、负责人等"
              onChange={(event) => setNewDescription(event.target.value)}
            />
          </div>
          <div className="create-actions">
            <button type="button" className="btn primary" disabled={!newName.trim()} onClick={() => void handleCreate()}>
              创建
            </button>
          </div>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="empty">加载中…</div>
      ) : requirements.length === 0 ? (
        <div className="empty">
          还没有需求。点右上角「新建需求」开始，然后把 Figma 插件导出的 zip 拖进去。
        </div>
      ) : (
        <div className="req-grid">
          {requirements.map((requirement) => {
            const frameLevel = requirement.designAssets.filter((asset) => asset.isFrameLevel).length;
            const openIssues = requirement.issues.filter((issue) => issue.status === 'open').length;
            return (
              // 整卡可点：点需求直接进验收工作台，少一次「打开 → 再选入口」
              <div
                className="card req-card clickable"
                key={requirement.id}
                role="button"
                tabIndex={0}
                title="打开验收工作台"
                onClick={() => onOpen(requirement)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(requirement);
                  }
                }}
              >
                <div className="req-card-head">
                  <span className="req-name">{requirement.name}</span>
                  <span className="req-time">{formatTime(requirement.updatedAt)}</span>
                </div>
                {requirement.description && <div className="req-desc">{requirement.description}</div>}
                <div className="req-stats">
                  <span className="stat">
                    设计稿 <b>{requirement.designAssets.length}</b>
                    {frameLevel !== requirement.designAssets.length && (
                      <em title="元素级导出不参与整页匹配">帧级 {frameLevel}</em>
                    )}
                  </span>
                  <span className="stat">
                    截图 <b>{requirement.appSnapshots.length}</b>
                  </span>
                  <span className="stat">
                    配对 <b>{requirement.pairs.length}</b>
                  </span>
                  <span className={`stat${openIssues > 0 ? ' warn' : ''}`}>
                    待修复 <b>{openIssues}</b>
                  </span>
                </div>
                <div className="req-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(requirement);
                    }}
                  >
                    进入验收
                  </button>
                  <button
                    type="button"
                    className="btn ghost danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleDelete(requirement);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
};

export default RequirementsPage;
