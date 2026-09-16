import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MatchPairMeta, PairDraft, RequirementMeta } from '@shared/verify';
import type { VerifyPairView } from '@shared/ipc';

import CanvasBoard from '../components/CanvasBoard';
import MatchBoard from '../components/MatchBoard';
import PairList from '../components/PairList';

interface VerifyWorkspacePageProps {
  requirementId: string;
  onBack: () => void;
  onNameChange: (name: string) => void;
  /** 插件直传导入后由 App 递增，用来触发静默重新拉取（素材与配对会变） */
  reloadToken?: number;
}

type WorkspaceTab = 'match' | 'canvas';

/**
 * 验收工作台：一次验收的全部动作都在这一个页面里完成。
 *
 * 外层左右分栏 —— 左侧配对列表是导航主轴，右侧内容区用顶部两个 tab 切换
 * 「页面匹配」（组织素材、替换配对两侧）与「画布验收」（逐页比对）。
 *
 * 之所以不再拆「需求详情 / 匹配 / 画布」三张页面：素材、配对、验收是同一件事的
 * 三个阶段，来回跳页会让「我现在在改哪个配对」这个核心上下文丢失。
 */
const VerifyWorkspacePage: React.FC<VerifyWorkspacePageProps> = ({
  requirementId,
  onBack,
  onNameChange,
  reloadToken = 0,
}) => {
  const [requirement, setRequirement] = useState<RequirementMeta | null>(null);
  const [pairs, setPairs] = useState<VerifyPairView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<WorkspaceTab>('canvas');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PairDraft | null>(null);
  const [zoom, setZoom] = useState(0.75);

  // 首次载入按「有没有配对」决定落哪个 tab；之后不再覆盖用户的手动切换
  const initedForRef = useRef<string>('');

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [req, views] = await Promise.all([
        window.api.verify.getRequirement(requirementId),
        window.api.verify.getPairs(requirementId),
      ]);
      setRequirement(req);
      setPairs(views);
      if (req) onNameChange(req.name);

      setActiveId((current) =>
        views.some((view) => view.meta.id === current) ? current : (views[0]?.meta.id ?? null),
      );

      if (initedForRef.current !== requirementId) {
        initedForRef.current = requirementId;
        // 没有配对时画布是空的，直接落到「页面匹配」才有事可做
        setTab(views.length > 0 ? 'canvas' : 'match');
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [onNameChange, requirementId]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const pairMetas: MatchPairMeta[] = useMemo(() => pairs.map((view) => view.meta), [pairs]);

  const activePair = useMemo(
    () => pairMetas.find((pair) => pair.id === activeId) ?? null,
    [activeId, pairMetas],
  );

  /** 画布 tab 当前展示的配对：选中项，或退回第一个 */
  const canvasPair = useMemo(
    () => pairs.find((view) => view.meta.id === activeId) ?? pairs[0] ?? null,
    [activeId, pairs],
  );

  const designById = useMemo(
    () => new Map((requirement?.designAssets ?? []).map((asset) => [asset.id, asset])),
    [requirement],
  );
  const appById = useMemo(
    () => new Map((requirement?.appSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot])),
    [requirement],
  );
  const issueCountByPair = useMemo(
    () => new Map(pairs.map((view) => [view.meta.id, view.issueCount])),
    [pairs],
  );

  /** 替换的目标：草稿优先（正在新建），否则是左列表选中的配对 */
  const targetDesignId = draft ? (draft.designAssetId ?? null) : (activePair?.designAssetId ?? null);
  const targetAppId = draft ? (draft.appSnapshotId ?? null) : (activePair?.appSnapshotId ?? null);

  /** 目标设计稿已配过对的截图（同一设计稿可以对多张截图） */
  const pairedAppIds = useMemo(() => {
    if (!targetDesignId) return new Set<string>();
    return new Set(
      pairMetas
        .filter((pair) => pair.designAssetId === targetDesignId)
        .map((pair) => pair.appSnapshotId),
    );
  }, [pairMetas, targetDesignId]);

  /** 草稿两侧都齐了 → 落库，并选中新建出来的配对 */
  const commitDraft = useCallback(
    async (completed: Required<PairDraft>): Promise<void> => {
      try {
        const created = await window.api.verify.savePair({
          requirementId,
          designAssetId: completed.designAssetId,
          appSnapshotId: completed.appSnapshotId,
        });
        setDraft(null);
        setActiveId(created.id);
        await load();
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [load, requirementId],
  );

  const handlePickDesign = useCallback(
    (designAssetId: string): void => {
      if (draft) {
        const next: PairDraft = { ...draft, designAssetId };
        if (next.appSnapshotId) {
          void commitDraft({ designAssetId, appSnapshotId: next.appSnapshotId });
        } else {
          setDraft(next);
        }
        return;
      }
      // 一个配对都没有时，点素材本身就是「我要开始配对」的意图，
      // 直接开草稿比让人去找那个按钮更顺 —— 否则这一下点击是静默无反应的。
      if (!activePair) {
        setDraft({ designAssetId });
        return;
      }
      void (async () => {
        try {
          await window.api.verify.savePair({
            requirementId,
            pairId: activePair.id,
            designAssetId,
            appSnapshotId: activePair.appSnapshotId,
          });
          await load();
        } catch (cause) {
          setError((cause as Error).message);
        }
      })();
    },
    [activePair, commitDraft, draft, load, requirementId],
  );

  const handlePickApp = useCallback(
    (appSnapshotId: string): void => {
      if (draft) {
        const next: PairDraft = { ...draft, appSnapshotId };
        if (next.designAssetId) {
          void commitDraft({ designAssetId: next.designAssetId, appSnapshotId });
        } else {
          setDraft(next);
        }
        return;
      }
      if (!activePair) {
        setDraft({ appSnapshotId });
        return;
      }
      void (async () => {
        try {
          await window.api.verify.savePair({
            requirementId,
            pairId: activePair.id,
            designAssetId: activePair.designAssetId,
            appSnapshotId,
          });
          await load();
        } catch (cause) {
          setError((cause as Error).message);
        }
      })();
    },
    [activePair, commitDraft, draft, load, requirementId],
  );

  const handleDeletePair = useCallback(
    (pairId: string): void => {
      const confirmed = window.confirm('删除这个配对？\n\n该配对下已记录的问题也会被一并删除，且不可恢复。');
      if (!confirmed) return;
      void (async () => {
        try {
          await window.api.verify.deletePair(pairId);
          if (activeId === pairId) setActiveId(null);
          await load();
        } catch (cause) {
          setError((cause as Error).message);
        }
      })();
    },
    [activeId, load],
  );

  /**
   * 删除一份素材（设计稿 / 截图）。两侧语义完全一致，只有数组与提示文案不同。
   *
   * 确认框里报出**会被连带删除的配对数量**：一份设计稿可以对多张截图、一张截图
   * 也可以对多份设计稿，「删掉一张卡片」听起来只影响一个格子，实际可能是整页的
   * 配对一起消失 —— 代价先摆出来，再让用户决定。
   */
  const handleDeleteAsset = useCallback(
    (kind: 'design' | 'app', assetId: string): void => {
      const label =
        kind === 'design'
          ? (designById.get(assetId)?.name ?? '')
          : (appById.get(assetId)?.label ?? '');
      if (!label) return;

      const cascaded = pairMetas.filter((pair) =>
        kind === 'design' ? pair.designAssetId === assetId : pair.appSnapshotId === assetId,
      ).length;
      const detail =
        cascaded > 0
          ? `引用它的 ${cascaded} 个配对及其下的问题记录会一并删除，不可恢复。`
          : '当前没有任何配对它，删除后不影响已有验收内容。';

      const confirmed = window.confirm(
        `删除${kind === 'design' ? '设计稿' : '截图'}「${label}」？\n\n${detail}`,
      );
      if (!confirmed) return;

      void (async () => {
        try {
          const input = { requirementId, assetId };
          if (kind === 'design') await window.api.verify.deleteDesignAsset(input);
          else await window.api.verify.deleteSnapshot(input);

          // 草稿若正引用着刚删掉的素材，退回「未选」——
          // 否则它会卡在一个指向已不存在 id 的空引用上，两侧永远凑不齐。
          setDraft((current) => {
            if (!current) return current;
            const referenced = kind === 'design' ? current.designAssetId : current.appSnapshotId;
            return referenced === assetId ? null : current;
          });
          await load();
        } catch (cause) {
          setError((cause as Error).message);
        }
      })();
    },
    [appById, designById, load, pairMetas, requirementId],
  );

  if (loading && !requirement) {
    return (
      <main className="workspace">
        <div className="empty">加载需求…</div>
      </main>
    );
  }

  if (!requirement) {
    return (
      <main className="workspace">
        <div className="workspace-main">
          <div className="alert error">{error ?? '需求不存在或已被删除'}</div>
          <div className="head-actions">
            <button type="button" className="btn" onClick={onBack}>
              返回需求列表
            </button>
          </div>
        </div>
      </main>
    );
  }

  const canCreate = requirement.designAssets.length > 0 && requirement.appSnapshots.length > 0;

  return (
    <main className="workspace">
      <PairList
        requirementId={requirementId}
        pairs={pairMetas}
        designById={designById}
        appById={appById}
        activeId={draft ? null : activeId}
        issueCountByPair={issueCountByPair}
        draft={draft}
        canCreate={canCreate}
        onSelect={(id) => {
          setDraft(null);
          setActiveId(id);
        }}
        onDelete={handleDeletePair}
        onCreate={() => setDraft({})}
        onCancelDraft={() => setDraft(null)}
      />

      <section className="workspace-main">
        <div className="workspace-tabs">
          <button
            type="button"
            className={`workspace-tab${tab === 'match' ? ' active' : ''}`}
            onClick={() => setTab('match')}
          >
            页面匹配
          </button>
          <button
            type="button"
            className={`workspace-tab${tab === 'canvas' ? ' active' : ''}`}
            onClick={() => setTab('canvas')}
          >
            画布验收
            {pairs.length > 0 && <span className="tab-count">{pairs.length}</span>}
          </button>
        </div>

        <div className="workspace-body">
          {error && <div className="alert error flush">{error}</div>}

          {tab === 'match' ? (
            <MatchBoard
              requirementId={requirementId}
              requirement={requirement}
              targetDesignId={targetDesignId}
              targetAppId={targetAppId}
              draft={draft}
              pairedAppIds={pairedAppIds}
              targetIssueCount={activePair ? (issueCountByPair.get(activePair.id) ?? 0) : 0}
              onPickDesign={handlePickDesign}
              onPickApp={handlePickApp}
              onDeleteDesign={(id) => handleDeleteAsset('design', id)}
              onDeleteApp={(id) => handleDeleteAsset('app', id)}
              onCancelDraft={() => setDraft(null)}
              onChanged={() => void load()}
            />
          ) : canvasPair ? (
            <CanvasBoard
              // 换配对即重建：清掉上一页的节点选中态，并让画布重新居中
              key={canvasPair.meta.id}
              pair={canvasPair}
              zoom={zoom}
              onZoomChange={setZoom}
              subtitle={`${canvasPair.name}（${canvasPair.pageNumber}/${pairs.length}）`}
            />
          ) : (
            <div className="empty">
              这个需求还没有配对。
              <br />
              切到「页面匹配」导入设计稿与截图，再点左上角「＋ 新建配对」。
            </div>
          )}
        </div>
      </section>
    </main>
  );
};

export default VerifyWorkspacePage;
