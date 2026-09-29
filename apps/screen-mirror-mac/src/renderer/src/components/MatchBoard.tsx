import React, { useCallback, useState } from 'react';

import { platformLabel, type PairDraft, type RequirementMeta } from '@shared/verify';

import { appSnapshotUrl, designAssetUrl } from '../lib/assets';
import CaptureButton from './CaptureButton';

interface MatchBoardProps {
  requirementId: string;
  requirement: RequirementMeta;
  /** 当前要替换的一侧：草稿态取草稿，否则取左列表选中的配对 */
  targetDesignId: string | null;
  targetAppId: string | null;
  draft: PairDraft | null;
  /** 目标设计稿已配过对的截图 id（同一设计稿可对多张截图） */
  pairedAppIds: Set<string>;
  onPickDesign: (designAssetId: string) => void;
  onPickApp: (appSnapshotId: string) => void;
  /** 删除一份设计稿（引用它的配对会被一并删除；确认框与级联提示由调用方负责） */
  onDeleteDesign: (designAssetId: string) => void;
  /** 删除一张 App 截图（同上） */
  onDeleteApp: (appSnapshotId: string) => void;
  onCancelDraft: () => void;
  /** 插件直传、采集或改名后重新拉取需求 */
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
 *
 * ## 顶部不再有「当前配对：X ↔ Y」那一行（2026-09-24 移除）
 *
 * 那一行原本背着三件事，删掉之后三件事各自都还有更好的落点：
 * ① 「哪一页是当前的」—— 两侧卡片自己带「**当前**」角标，把名字再抄一遍是冗余；
 * ② 「该配对已有 N 条问题记录」—— 左侧配对列表上本来就有一份（`本页问题 N`，且会变 warn 色），
 *    同一句话在两处出现，只会有两处不一致的一天；
 * ③ 「导出本页数据」—— 调试包入口始终在**左侧配对列表**上（每页一颗、常驻，见 `PairList`），
 *    能力没有丢，这里那颗只是同一动作的第二个按钮。
 * 一行字背三件事，且都不影响下一步操作；删掉之后信息回到卡片自身 ——
 * 点卡片会发生什么，点一下就知道了。
 */
const MatchBoard: React.FC<MatchBoardProps> = ({
  requirementId,
  requirement,
  targetDesignId,
  targetAppId,
  draft,
  pairedAppIds,
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
  ) : null;

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
            <span className="column-count">{requirement.designAssets.length} 帧 · 插件直传</span>
          </div>

          {requirement.designAssets.length === 0 ? (
            <div className="empty small">
              还没有设计稿，请在顶部开启「插件直传」，再从 Figma 插件发送设计稿
            </div>
          ) : (
            <ul className="card-grid">
              {requirement.designAssets.map((asset) => (
                <li
                  key={asset.id}
                  className={`asset-card${asset.id === targetDesignId ? ' active' : ''}`}
                  title="点击设为当前配对的设计稿"
                  onClick={() => onPickDesign(asset.id)}
                >
                  {/* 缩略图盒子比例**固定**（不跟素材走）：比例由 .card-thumb 的
                      aspect-ratio 给定，图片在盒子里等比缩放 + 居中 ——
                      宽比盒子宽 ⇒ 宽度撑满、上下居中；高比盒子高 ⇒ 高度撑满、左右居中。 */}
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
                      {asset.width}×{asset.height}
                    </div>
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
            </span>
          </div>

          <CaptureButton requirementId={requirementId} onCaptured={onChanged} />

          {requirement.appSnapshots.length === 0 ? (
            <div className="empty small">还没有截图，连上 USB 点「采集截图 + 节点」</div>
          ) : (
            <ul className="card-grid">
              {requirement.appSnapshots.map((app) => {
                const paired = pairedAppIds.has(app.id);
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
                        {app.width}×{app.height} dp
                      </div>
                      {/*
                        平台标签（2026-09-28 加）：一份需求里常同时躺着 iOS 与安卓的截图
                        （`AppSnapshotMeta.platform` 是必填字段），卡片上不写就只能靠名字猜。
                        平台名函数对缺该字段的**老快照**返回 null ⇒ 这里**不画**，
                        与盒样式三态同一条哲学：没读到就不编。
                      */}
                      {platformLabel(app.platform) && (
                        <div className="card-score">
                          <span className="tag platform-tag">{platformLabel(app.platform)}</span>
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

export default MatchBoard;
