import React, { useCallback, useMemo, useState } from 'react';

import type { PairDraft, RequirementMeta } from '@shared/verify';

import { appSnapshotUrl, designAssetUrl } from '../lib/assets';
import { BUCKET_LABEL, rankCandidates } from '../lib/matching';
import CaptureButton from './CaptureButton';
import ImportDropZone from './ImportDropZone';

interface MatchBoardProps {
  requirementId: string;
  requirement: RequirementMeta;
  /** 当前要替换的一侧：草稿态取草稿，否则取左列表选中的配对 */
  targetDesignId: string | null;
  targetAppId: string | null;
  draft: PairDraft | null;
  /** 目标设计稿已配过对的截图 id（同一设计稿可对多张截图） */
  pairedAppIds: Set<string>;
  /** 目标配对已有的问题数：替换素材后这些记录仍挂在原处，需要人复核 */
  targetIssueCount: number;
  onPickDesign: (designAssetId: string) => void;
  onPickApp: (appSnapshotId: string) => void;
  /** 删除一份设计稿（引用它的配对会被一并删除；确认框与级联提示由调用方负责） */
  onDeleteDesign: (designAssetId: string) => void;
  /** 删除一张 App 截图（同上） */
  onDeleteApp: (appSnapshotId: string) => void;
  onCancelDraft: () => void;
  /** 导入 / 采集 / 改名后重新拉取需求 */
  onChanged: () => void;
}

/**
 * 「页面匹配」tab：左边设计稿、右边 App 截图，都按卡片铺开。
 *
 * **点卡片 = 把当前配对的对应一侧换成它**（草稿态则是在补全两侧）。
 * 之所以不做「勾选两张再点确认」：替换是一个高频单向动作，直接点最省事；
 * 新建才需要两步骤，那条路径由草稿卡片显式表达。
 *
 * 每张卡片还带一个**删除**按钮（hover 时出现在缩略图右下角）。放在缩略图上
 * 而不是卡片右上角，是因为右上角被「当前」角标占着、左上角被「已配对」占着 ——
 * 只有缩略图底部是空的，且缩略图有固定宽高比，按钮位置不会随文字换行抖动。
 */
const MatchBoard: React.FC<MatchBoardProps> = ({
  requirementId,
  requirement,
  targetDesignId,
  targetAppId,
  draft,
  pairedAppIds,
  targetIssueCount,
  onPickDesign,
  onPickApp,
  onDeleteDesign,
  onDeleteApp,
  onCancelDraft,
  onChanged,
}) => {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const designById = useMemo(
    () => new Map(requirement.designAssets.map((asset) => [asset.id, asset])),
    [requirement.designAssets],
  );

  const targetDesign = targetDesignId ? designById.get(targetDesignId) : undefined;

  /** 已知设计稿时，给截图卡片打推荐分（只影响排序与标注，不自动建配对） */
  const scoreByApp = useMemo(() => {
    if (!targetDesign) return new Map<string, { bucket: 'recommended' | 'possible' | 'low'; score: number }>();
    const map = new Map<string, { bucket: 'recommended' | 'possible' | 'low'; score: number }>();
    for (const { app, match } of rankCandidates(targetDesign, requirement.appSnapshots)) {
      map.set(app.id, { bucket: match.bucket, score: match.score });
    }
    return map;
  }, [requirement.appSnapshots, targetDesign]);

  const commitRename = useCallback(
    async (snapshotId: string) => {
      const label = draftLabel.trim();
      setRenaming(null);
      if (!label) return;
      try {
        await window.api.verify.renameSnapshot({ requirementId, snapshotId, label });
        onChanged();
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [draftLabel, onChanged, requirementId],
  );

  const hint = draft ? (
    <div className="board-hint draft">
      <span>
        正在新建配对：请在下方分别点选<b>一张设计稿</b>和<b>一张截图</b>，两侧选定后自动建立。
      </span>
      <span className="spacer" />
      <button type="button" className="btn tiny" onClick={onCancelDraft}>
        取消
      </button>
    </div>
  ) : !targetDesignId || !targetAppId ? (
    <div className="board-hint warn">
      还没有配对：点下方任意设计稿 / 截图卡片即可开始建立（先点哪个都行），
      或点左上角「＋ 新建配对」。
    </div>
  ) : (
    <div className="board-hint">
      <span>
        当前配对：<b>{designById.get(targetDesignId)?.name ?? '?'}</b> ↔ <b>{appByIdName(requirement, targetAppId)}</b>
        。点下方任意设计稿 / 截图卡片即可<b>替换</b>对应的一侧。
      </span>
      {targetIssueCount > 0 && (
        <span className="hint-warn">该配对已有 {targetIssueCount} 条问题记录，替换素材后请复核。</span>
      )}
    </div>
  );

  return (
    <div className="match-board">
      {hint}

      {error && <div className="alert error">{error}</div>}

      <div className="board-columns">
        <section className="board-column">
          <div className="column-head">
            <span className="column-title">
              <span className="dot design-dot" />
              设计稿
            </span>
            <span className="column-count">{requirement.designAssets.length} 帧</span>
          </div>

          <ImportDropZone requirementId={requirementId} onImported={onChanged} />

          {requirement.designAssets.length === 0 ? (
            <div className="empty small">还没有设计稿，拖入 Figma 导出包开始</div>
          ) : (
            <ul className="card-grid">
              {requirement.designAssets.map((asset) => (
                <li
                  key={asset.id}
                  className={`asset-card${asset.id === targetDesignId ? ' active' : ''}`}
                  title="点击设为当前配对的设计稿"
                  onClick={() => onPickDesign(asset.id)}
                >
                  <div className="card-thumb">
                    <img
                      src={designAssetUrl(requirementId, asset.id, asset.thumbnailFile)}
                      alt={asset.name}
                      draggable={false}
                    />
                    <button
                      type="button"
                      className="card-del"
                      aria-label={`删除设计稿 ${asset.name}`}
                      title="删除这份设计稿（引用它的配对会一并删除）"
                      onClick={(event) => {
                        // 卡片本身点了就是「换成这一侧」，不拦的话点删除会顺带把它选上
                        event.stopPropagation();
                        onDeleteDesign(asset.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <div className="card-body">
                    <div className="asset-name" title={asset.path}>
                      {asset.name}
                    </div>
                    <div className="asset-meta">
                      {asset.width}×{asset.height} · {asset.nodeCount} 节点
                    </div>
                    {!asset.isFrameLevel && (
                      <div className="card-score">
                        <span className="tag warn-tag">元素级导出</span>
                      </div>
                    )}
                  </div>
                  {asset.id === targetDesignId && (
                    <span className="tag active-tag corner">当前</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="board-column">
          <div className="column-head">
            <span className="column-title">
              <span className="dot app-dot" />
              App 截图
            </span>
            <span className="column-count">
              {requirement.appSnapshots.length} 张
              {targetDesign ? ' · 已按当前设计稿打分' : ''}
            </span>
          </div>

          <CaptureButton requirementId={requirementId} onCaptured={onChanged} />

          {requirement.appSnapshots.length === 0 ? (
            <div className="empty small">还没有截图，连上 USB 点「采集截图 + 节点」</div>
          ) : (
            <ul className="card-grid">
              {requirement.appSnapshots.map((app) => {
                const score = scoreByApp.get(app.id);
                const paired = pairedAppIds.has(app.id);
                const percent = score ? Math.round(score.score * 100) : null;
                return (
                  <li
                    key={app.id}
                    className={[
                      'asset-card',
                      app.id === targetAppId ? 'active' : '',
                      paired ? 'paired' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    title="点击设为当前配对的截图"
                    onClick={() => onPickApp(app.id)}
                  >
                    <div className="card-thumb">
                      <img
                        src={appSnapshotUrl(requirementId, app.id, app.thumbnailFile)}
                        alt={app.label}
                        draggable={false}
                      />
                      <button
                        type="button"
                        className="card-del"
                        aria-label={`删除截图 ${app.label}`}
                        title="删除这张截图（引用它的配对会一并删除）"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteApp(app.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div className="card-body">
                      {renaming === app.id ? (
                        <input
                          className="input inline"
                          value={draftLabel}
                          autoFocus
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setDraftLabel(event.target.value)}
                          onBlur={() => void commitRename(app.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void commitRename(app.id);
                            if (event.key === 'Escape') setRenaming(null);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="asset-name editable"
                          title="点击改名（页面匹配的名称相似度会用到它）"
                          onClick={(event) => {
                            event.stopPropagation();
                            setRenaming(app.id);
                            setDraftLabel(app.label);
                          }}
                        >
                          {app.label}
                        </button>
                      )}
                      <div className="asset-meta">
                        {app.width}×{app.height} dp · {app.nodeCount} 节点
                      </div>
                      {percent !== null && (
                        <div className="card-score">
                          <span className={`bucket ${score?.bucket ?? 'low'}`}>
                            {BUCKET_LABEL[score?.bucket ?? 'low']}
                          </span>
                          <span className="score-num">{percent}</span>
                        </div>
                      )}
                    </div>
                    {app.id === targetAppId && (
                      <span className="tag active-tag corner">当前</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

function appByIdName(requirement: RequirementMeta, snapshotId: string): string {
  return requirement.appSnapshots.find((item) => item.id === snapshotId)?.label ?? '?';
}

export default MatchBoard;
