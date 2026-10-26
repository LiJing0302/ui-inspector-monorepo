import React, { useId, useState } from 'react';

import type { AppSnapshotMeta, DesignAssetMeta, MatchPairMeta, PairDraft } from '@shared/verify';

import { appSnapshotUrl, designAssetUrl } from '../lib/assets';

interface PairListProps {
  requirementId: string;
  pairs: MatchPairMeta[];
  designById: Map<string, DesignAssetMeta>;
  appById: Map<string, AppSnapshotMeta>;
  /** 已建立的配对中当前选中的那个（草稿态下为 null） */
  activeId: string | null;
  /** pairId -> 本页未关闭的问题数 */
  issueCountByPair: Map<string, number>;
  /** 新建配对草稿；非 null 时列表顶部有一条待补全的卡片 */
  draft: PairDraft | null;
  /** 有素材可配（至少一份设计稿 + 一张截图）才允许新建 */
  canCreate: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onCancelDraft: () => void;
  /**
   * 导出该配对的调试包。
   *
   * 落点是「每个配对」而不是「整个需求」：验收是按配对跑的，出问题也总是某一页
   * 出问题（同一页的两侧素材、同一套坐标校准）。整需求导出会把无关页面一起带上，
   * 反而看不出是哪一页断的。
   */
  onExport: (pairId: string) => void;
  /** 正在导出的配对 id（只禁用自己那一颗按钮，便于连着导几页） */
  exportingId: string | null;
}

const Thumb: React.FC<{ kind: 'design' | 'app'; url?: string; label: string }> = ({
  kind,
  url,
  label,
}) => (
  <div className={`pair-thumb ${kind}`} title={label}>
    {url ? (
      <img src={url} alt={label} draggable={false} />
    ) : (
      <span className="pair-thumb-empty">{kind === 'design' ? '设计稿' : '截图'}</span>
    )}
  </div>
);

/**
 * 左侧配对列表：验收工作台的导航主轴。
 *
 * 每个配对 = 一次验收的基本单元（设计稿 ↔ 截图），列表项直接给出两侧真实缩略图，
 * 免得点进去才发现配错了。选中项就是右侧「页面匹配」里被替换的对象。
 */
const PairList: React.FC<PairListProps> = ({
  requirementId,
  pairs,
  designById,
  appById,
  activeId,
  issueCountByPair,
  draft,
  canCreate,
  onSelect,
  onDelete,
  onCreate,
  onCancelDraft,
  onExport,
  exportingId,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const contentId = useId();
  const draftDesign = draft?.designAssetId ? designById.get(draft.designAssetId) : undefined;
  const draftApp = draft?.appSnapshotId ? appById.get(draft.appSnapshotId) : undefined;

  return (
    <aside className={`pairs${collapsed ? ' collapsed' : ''}`} aria-label="配对列表">
      <div className="pairs-head">
        <div className="pairs-head-content" aria-hidden={collapsed} {...(collapsed ? { inert: '' } : {})}>
          <span className="pairs-title">
            配对 <b>{pairs.length}</b>
          </span>
          <button
            type="button"
            className="btn tiny"
            disabled={!canCreate || draft !== null}
            title={canCreate ? '选择一个设计稿 + 一张截图，建立新配对' : '需要至少一份设计稿和一张截图'}
            onClick={onCreate}
          >
            ＋ 新建配对
          </button>
        </div>
        <button type="button" className="pairs-toggle"
          aria-label={collapsed ? '展开配对列表' : '折叠配对列表'}
          title={collapsed ? '展开配对列表' : '折叠配对列表'}
          aria-expanded={!collapsed} aria-controls={contentId}
          onClick={() => setCollapsed(value => !value)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
            <path d="M6 2.5v11" />
            <path className="pairs-toggle-chevron" d="m11 6-2 2 2 2" />
          </svg>
        </button>
      </div>

      <div className="pairs-scroll" id={contentId} aria-hidden={collapsed} {...(collapsed ? { inert: '' } : {})}>
        {draft && (
          <div className="pair-card draft active">
            <div className="pair-title">
              <span className="pair-index">＊</span>
              <span className="pair-name">新建配对</span>
            </div>
            <div className="pair-sub">在右侧分别点选设计稿与截图</div>
            <div className="pair-thumbs">
              <Thumb
                kind="design"
                label={draftDesign ? draftDesign.name : '待选择设计稿'}
                url={
                  draftDesign
                    ? designAssetUrl(requirementId, draftDesign.id, draftDesign.thumbnailFile)
                    : undefined
                }
              />
              <Thumb
                kind="app"
                label={draftApp ? draftApp.label : '待选择截图'}
                url={
                  draftApp
                    ? appSnapshotUrl(requirementId, draftApp.id, draftApp.thumbnailFile)
                    : undefined
                }
              />
            </div>
            <div className="pair-meta">
              {draft.designAssetId ? '设计稿 ✓' : '设计稿 待选'} ·{' '}
              {draft.appSnapshotId ? '截图 ✓' : '截图 待选'}
            </div>
            <button
              type="button"
              className="pair-del"
              title="取消新建"
              onClick={(event) => {
                event.stopPropagation();
                onCancelDraft();
              }}
            >
              ×
            </button>
          </div>
        )}

        {pairs.length === 0 && !draft && (
          <div className="empty small">
            还没有配对。
            <br />
            先通过顶部「插件直传」发送设计稿、采集截图，再点「＋ 新建配对」。
          </div>
        )}

        {pairs.map((pair, index) => {
          const design = designById.get(pair.designAssetId);
          const app = appById.get(pair.appSnapshotId);
          const issueCount = issueCountByPair.get(pair.id) ?? 0;

          return (
            <div
              key={pair.id}
              className={`pair-card${pair.id === activeId ? ' active' : ''}`}
              onClick={() => onSelect(pair.id)}
            >
              <div className="pair-title">
                <span className="pair-index">{index + 1}.</span>
                <span className="pair-name" title={design?.name ?? '未命名设计稿'}>
                  {design?.name ?? '未知设计稿'}
                </span>
              </div>
              <div className="pair-sub" title={app?.label ?? '未知截图'}>
                ↔ {app?.label ?? '未知截图'}
              </div>
              <div className="pair-thumbs">
                <Thumb
                  kind="design"
                  label={design?.name ?? '设计稿'}
                  url={
                    design
                      ? designAssetUrl(requirementId, design.id, design.thumbnailFile)
                      : undefined
                  }
                />
                <Thumb
                  kind="app"
                  label={app?.label ?? '截图'}
                  url={
                    app ? appSnapshotUrl(requirementId, app.id, app.thumbnailFile) : undefined
                  }
                />
              </div>
              <div className="pair-foot">
                <span className={`pair-meta${issueCount > 0 ? ' warn' : ''}`}>
                  本页问题 {issueCount}
                </span>
                {/*
                  导出按钮**常驻**而不是跟删除一样 hover 才出现：它是排查期的连续动作
                  （逐页导），而 hover 显隐会让人在「鼠标移到按钮上」时把它弄丢。
                  导出本身也不危险，不像删除需要一层克制。
                */}
                <button
                  type="button"
                  className="pair-export"
                  disabled={exportingId === pair.id}
                  title="导出这一页的调试包：两侧原始节点 + 归一化结果 + 匹配打分与诊断"
                  onClick={(event) => {
                    event.stopPropagation();
                    onExport(pair.id);
                  }}
                >
                  {exportingId === pair.id ? '导出中…' : '导出数据'}
                </button>
              </div>
              <button
                type="button"
                className="pair-del"
                title="删除这个配对（同时删除其下问题记录）"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(pair.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
};

export default PairList;
