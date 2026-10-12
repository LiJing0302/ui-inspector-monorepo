import React from 'react';

import type { CleanTierId, SamaCleanSuccess, SamaEngine, SamaRunResult, SamaTemplate } from '@shared/ipc';
import type { AcceptanceReport } from '@ui-inspector/ai-acceptance';
import {
  CLEAN_KIND_FILTER_HINT,
  CLEAN_KIND_FILTER_LABEL,
  isVisibleInKindFilter,
  type CleanKindFilter,
} from '../lib/cleanKindFilter';

/**
 * SAMA 引擎面板 —— 与「运行验收」**并列**的第二条验收通道。
 *
 * ## 为什么不做成同一套结论
 *
 * 现有面板的 verdict / 匹配明细 / 人工确认忽略，全部围绕规则引擎的 `AcceptanceResult`
 * 组织。SAMA 的产物是另一套模型（分区 + 分级 issues + 像素通道），硬塞进同一块 UI，
 * 会出现「同一屏里两个 verdict、却看不出各自说的是什么」。所以这里**独立呈现**：
 * 两块结论并排摆着，用户自己对照，反而更容易看出哪一套的判断更贴合实际情况。
 *
 * ## 两条最容易误读的结论，都在 UI 里显式说明
 *
 * 1. **无像素证据区间（P0）**：App 截图只覆盖设计稿的一部分，没覆盖到的区间
 *    「不可判定 ≠ 通过」。这条必须显眼 —— 否则用户看到「没有 issue」会以为没问题。
 * 2. **verdict 只能加重**：AI 可以把 pass 改成 fail，但不能把 fail 改成 pass。
 *    所以 AI 开没开，只影响「发现得更多」还是「发现得更少」。
 */

const VERDICT_LABEL: Record<string, string> = {
  pass: '通过',
  fail: '不通过',
  review: '待复核',
};

const ENGINE_LABEL: Record<SamaEngine, string> = {
  rules: '确定性规则',
  mock: '演练（mock）',
  ai: 'AI 评审',
};

/**
 * 分区口径 —— **必须让用户能选，不能写死**（2026-10-03 实测发现）。
 *
 * 同一个配对、同一份素材，两套口径的结论差一个量级：
 *
 * | 口径     | 分区                      | P0/P1/P2    | 覆盖 P0        |
 * |----------|---------------------------|-------------|----------------|
 * | default  | 1 个「自动分区 1」[0,1261] | 0 / 20 / 14 | **无**         |
 * | bundle   | 9 个 R1–R9（手工）         | 1 / 5 / 13  | [900, 2205]    |
 *
 * 差异的根因是**粒度**：`default` 把整页归成一个区，而 App 截图只覆盖到设计
 * y≈900，于是「52% 覆盖」> 0 阈值，整区不算「无像素证据」——下半页不可判定这件事
 * 被摊薄掉了，恰是引擎号称「严禁默认通过」要拦的那一类。切成手工分区后，
 * R7/R8 各自完全落在折线以下 ⇒ 覆盖 0 ⇒ 报 P0。
 * （`default` 另有 14 条 P1 是登录态/测试数据造成的假阳性，手工分区里的
 * 区域级豁免把它压掉了。）
 *
 * ⚠️ 但不能反过来把 `bundle` 设成默认：它是**为「10年管家开通前」这一稿手写的
 * y 区间**（R1 0–120 / R2 120–265 …），换一张设计稿就是拿别人的分区线去切，
 * 会切出看似合理实则错位的结论。所以默认仍是 `default`，把选择权和后果说明摆出来。
 */
const TEMPLATE_LABEL: Record<SamaTemplate, string> = {
  default: '自动分区（通用）',
  bundle: '手工分区 R1–R9（2026-09-30 稿）',
};

const CATEGORY_LABEL: Record<string, string> = {
  existence: '存在性',
  text: '文案',
  geometry: '几何',
  color: '颜色',
  corner: '圆角',
  stroke: '描边',
  style: '风格',
  hierarchy: '层级',
  coverage: '证据覆盖',
};

const SEVERITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

/**
 * 清洗层的展示元数据 —— **顺序即风险从高到低**。
 *
 * ⚠️ `id` 必须覆盖 `CleanTierId` 的**全部**成员，所以用 `satisfies`
 * + 下面那条「集合相等」断言把它钉住。此前这里是手写 5 条，
 * 引擎加 L6 时它不会报错，只是**静默不显示**那一层 ——
 * 「漏一层」比「报个错」难发现得多。
 *
 * `hint` 是 tooltip：让人在点之前就知道这一层「凭什么剔」。
 */
const CLEAN_TIERS = [
  { id: 'L4-semantic', label: 'L4 语义', hint: '多信号推断的语义噪声（数字轮重复行）—— 最需要逐条核对' },
  { id: 'L6-layout', label: 'L6 布局壳', hint: '叶子布局容器：无子节点、无背景/边框/圆角 —— 不绘制任何像素（SVG 矢量元素与结构分组容器都不在内）' },
  { id: 'L5-viewport', label: 'L5 视口外', hint: '完全在视口外、未参与本次验收（截图没拍到，不是「App 没有」）' },
  { id: 'L3-invisible', label: 'L3 不可见', hint: '采集器报告的隐藏 / 被祖先藏 / 被裁' },
  { id: 'L1-geometry', label: 'L1 几何', hint: '零尺寸 / 哨兵脏值 —— 逻辑上不可能被看到' },
  { id: 'L2-collector', label: 'L2 采集', hint: '工具浮层 / 平台 chrome —— 不是被验收对象的内容' },
] as const satisfies ReadonlyArray<{ id: CleanTierId; label: string; hint: string }>;

/** `CleanTierId` 的全集（用作「集合相等」断言的另一侧） */
const ALL_CLEAN_TIER_IDS: readonly CleanTierId[] = [
  'L1-geometry', 'L2-collector', 'L3-invisible', 'L4-semantic', 'L5-viewport', 'L6-layout',
];

/**
 * ⭐ 防漂移守卫：`CLEAN_TIERS` 必须**恰好**覆盖全部清洗层。
 *
 * 引擎侧 `CleanTier` 加了新层而这里没加 ⇒ 面板上会「少一层按钮」，
 * 那层剔除的节点在 UI 上完全不可见 —— 而 `tsc` 不会报任何错。
 * 这就是为什么这里要比类型检查更严：类型只能保证「每条 id 都合法」，
 * 保证不了「没有漏掉任何一层」。
 */
const ALL_TIERS_COVERED: boolean =
  ALL_CLEAN_TIER_IDS.every((id) => CLEAN_TIERS.some((t) => t.id === id))
  && ALL_CLEAN_TIER_IDS.length === CLEAN_TIERS.length;
if (!ALL_TIERS_COVERED) {
  // 运行期立刻炸，比「面板少一层按钮」显眼得多
  throw new Error(
    `[SamaPanel] CLEAN_TIERS 与 CleanTierId 不同步：缺 ${ALL_CLEAN_TIER_IDS.filter(
      (id) => !CLEAN_TIERS.some((t) => t.id === id),
    ).join(', ') || '（数量对不上，可能有重复项）'}`,
  );
}

/** 三档的展示顺序（判据与文案在 `lib/cleanKindFilter`，这里只定「按什么顺序摆」） */
const CLEAN_KIND_FILTER_ORDER: CleanKindFilter[] = ['structured', 'drawable', 'all'];

const MERGE_KIND_LABEL: Record<string, string> = {
  'svg-root': 'SVG 整体',
  'visual-group': '视觉单元',
  'coincident-parent': '父子重合',
  'coincident-sibling': '兄弟重合',
};

const categoryLabel = (value: string): string => CATEGORY_LABEL[value] ?? value;

function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface SamaPanelProps {
  pairId: string;
  /**
   * 跑完后把报告回灌给 `CanvasBoard` —— 画布据此出第七档（分片横带 + issue 节点框）。
   *
   * 为什么要回灌而不是各跑各的：两份报告在同一个配对上必然一致，
   * 让面板和画布各跑一次才会出现「面板说 P0、画布没标」这种对不上的状态。
   */
  onSamaReport?: (report: SamaReport | null) => void;
  /** 当前在画布上高亮的那条 issue（受控，双向联动的另一半） */
  focusedIssue?: string | null;
  /** 点某条 issue → 画布选中对应节点。传 null 表示收起高亮 */
  onFocusIssue?: (issueId: string | null) => void;

  /* ---- 清洗核验（人工核验卡点①）---- */
  /**
   * 清洗数据与画布侧的过滤/高亮状态。
   *
   * ⚠️ **数据存在 `CanvasBoard` 而不是这里**：画布要拿它算第九、十档的框，
   * 而「点面板某条 → 画布高亮」又要求面板能改画布状态 —— 双向都跨着同一份数据。
   * 面板这里只做「取数 + 渲染 + 触发回调」。
   */
  clean?: {
    data: SamaCleanSuccess | null;
    focus: string | null;
    tierFilter: Set<string>;
    /** 画布当前用的 kind 过滤档（面板显示它并提供切换） */
    kindFilter: 'all' | 'structured' | 'drawable';
    /** 过滤后画布上实际画了几个框 —— ⭐ 与画布同源（`filterByKind`），面板不自算 */
    visibleCount: number;
    /** 被 kind 过滤藏掉了几个 */
    hiddenCount: number;
    /** ⚠️ 其中几个是**真实可见盒子**（有背景/边框/圆角）；>0 = 当前档丢了可见元素 */
    hiddenVisibleBoxes: number;
  };
  onCleanData?: (data: SamaCleanSuccess | null) => void;
  onFocusCleanMerged?: (id: string | null) => void;
  onToggleCleanTier?: (tier: string) => void;
  /** 切画布的 kind 过滤档（纯视图开关，不影响验收结论） */
  onCleanKindFilter?: (mode: 'all' | 'structured' | 'drawable') => void;
}

/** SAMA 报告 —— 直接用引擎包的类型，与 `types/sama.ts` 的 IPC 契约同源 */
type SamaReport = AcceptanceReport;

const SamaPanel: React.FC<SamaPanelProps> = ({
  pairId,
  onSamaReport,
  focusedIssue,
  onFocusIssue,
  clean,
  onCleanData,
  onFocusCleanMerged,
  onToggleCleanTier,
  onCleanKindFilter,
}) => {
  const [engine, setEngine] = React.useState<SamaEngine>('rules');
  const [template, setTemplate] = React.useState<SamaTemplate>('default');
  const [result, setResult] = React.useState<SamaRunResult | null>(null);
  const [running, setRunning] = React.useState(false);
  const [openIssue, setOpenIssue] = React.useState<string | null>(null);
  /**
   * 记住**本次结果是用哪套口径跑的**。
   * 直接读 `template` 状态会串味：跑完再改下拉框，屏幕上就会出现「结果来自 A 口径、
   * 下拉框指着 B 口径」的错配，而这种错配恰好会让人把口径差异误读成引擎不稳定。
   */
  const [ranTemplate, setRanTemplate] = React.useState<SamaTemplate | null>(null);
  /** 清洗核验：取数中 / 错误 / 是否展开明细 */
  const [cleanBusy, setCleanBusy] = React.useState(false);
  const [cleanError, setCleanError] = React.useState<string | null>(null);
  const [showCleanDetail, setShowCleanDetail] = React.useState<'dropped' | 'merged' | null>(null);

  /**
   * 取清洗明细 + 归并视图。
   *
   * ⚠️ 与「运行 SAMA」**分开触发**：核验清洗是开发阶段的例行动作，
   * 不该为了看一眼节点表就跑整条验收链路（那会连带 L1 拟合与像素采样）。
   */
  const loadClean = (): void => {
    setCleanBusy(true);
    setCleanError(null);
    void window.api.verify
      .loadSamaClean({ pairId })
      .then((r) => {
        if (r.ok) onCleanData?.(r);
        else {
          setCleanError(r.error);
          onCleanData?.(null);
        }
      })
      .catch((error: unknown) => {
        setCleanError((error as Error).message);
        onCleanData?.(null);
      })
      .finally(() => setCleanBusy(false));
  };

  const run = (): void => {
    setRunning(true);
    setOpenIssue(null);
    setRanTemplate(template);
    void window.api.verify
      .runSamaAcceptance({ pairId, engine, template })
      .then(setResult)
      .catch((error: unknown) => {
        setResult({ ok: false, kind: 'internal', error: (error as Error).message });
      })
      .finally(() => setRunning(false));
  };

  const report = result?.ok ? result.report : null;
  const issues = React.useMemo(
    () => (report ? [...report.issues].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)) : []),
    [report],
  );

  /**
   * 把报告回灌给画布。
   *
   * ⚠️ 挂在 `report` 上而不是 `run` 的 then/catch 里：失败也要回灌 `null` ——
   * 否则引擎报错后画布上会留着**上一次**的报告，看起来像这次跑出来的结论。
   * 换口径重跑同理（`report` 是新对象，回灌自然跟上）。
   */
  React.useEffect(() => {
    onSamaReport?.(report);
  }, [onSamaReport, report]);

  /** 展开详情的同时让画布高亮 —— 两者是同一个动作，不该分开点 */
  const toggleIssue = (issueId: string): void => {
    const next = openIssue === issueId ? null : issueId;
    setOpenIssue(next);
    onFocusIssue?.(next);
  };

  return (
    <section className="sama-panel" aria-label="SAMA 引擎验收">
      <div className="acceptance-section-title">SAMA 引擎</div>
      <div className="sama-hint">
        结构锚定 + 分区评审：先按锚点保序拟合对齐（不是常量平移），再逐区做编号回引的语义复核。
        与上面的「运行验收」是两条独立通道，结论不互相覆盖。
      </div>

      <div className="acceptance-run">
        <label className="sama-engine-pick">
          <span>引擎</span>
          <select value={engine} onChange={(event) => setEngine(event.target.value as SamaEngine)} disabled={running}>
            <option value="rules">确定性规则（不调 AI）</option>
            <option value="mock">演练（mock，仅验链路）</option>
            <option value="ai">AI 评审（用 App 里配好的 AI）</option>
          </select>
        </label>
        <label className="sama-engine-pick">
          <span>分区口径</span>
          <select
            value={template}
            onChange={(event) => setTemplate(event.target.value as SamaTemplate)}
            disabled={running}
            title="决定设计稿怎么切片。粒度越细，'下半页没有像素证据'越容易被识别出来；手工分区是为特定设计稿手写的 y 区间，换稿不要用。"
          >
            <option value="default">{TEMPLATE_LABEL.default}</option>
            <option value="bundle">{TEMPLATE_LABEL.bundle}</option>
          </select>
        </label>
        <div className="acceptance-run-actions">
          <button type="button" className="btn" disabled={cleanBusy} onClick={loadClean}>
            {cleanBusy ? '读取中…' : '检查清洗'}
          </button>
          <button type="button" className="btn primary" disabled={running} onClick={run}>
            {running ? '分析中…' : '运行 SAMA'}
          </button>
        </div>
      </div>

      {/* ---- 清洗核验（人工核验卡点①）----
          设计意图：让人在画布上直接看到「哪些节点被剔了、按哪一层剔的、
          哪些被归并了」，而不是只读一张数字表。 */}
      {cleanError && (
        <div className="alert error flush">清洗读取失败：{cleanError}</div>
      )}

      {clean?.data && (
        <div className="sama-clean">
          <div className="sama-subsection-title">节点清洗</div>
          {/*
            ⚠️ 这段说明必须显眼：画布上**只画归并后的节点**，剔除框一律不画
            （实测 544 个剔除框里 298 个在视口外，600 框同屏会糊）。
            用户点完「检查清洗」看到画布上只有几十个框时，得知道去哪看「剔了什么」。
          */}
          <div className="sama-clean-canvas-note">
            画布上显示的是<b>清洗 + 归并后的节点</b>：共 {clean.data.merged.length} 个，
            当前档画出 <b>{clean.visibleCount}</b> 个
            {clean.hiddenCount > 0 && <>（藏了 {clean.hiddenCount} 个纯结构框）</>}。
            带角标的是<b>被归并过</b>的（角标 = 收拢了几个真实节点）。
            <b>被剔除的 {clean.data.dropped.length} 个节点不画在画布上</b>，逐条判据见下方明细。
          </div>

          {/* kind 过滤三档 —— 纯视图开关，不影响验收结论 */}
          <div className="sama-clean-kindfilter" role="group" aria-label="画布框过滤">
            {CLEAN_KIND_FILTER_ORDER.map((f) => (
              <button
                key={f}
                type="button"
                className={`sama-clean-tab${clean.kindFilter === f ? ' on' : ''}`}
                onClick={() => onCleanKindFilter?.(f)}
                title={CLEAN_KIND_FILTER_HINT[f]}
              >
                {CLEAN_KIND_FILTER_LABEL[f]}
              </button>
            ))}
          </div>
          {clean.hiddenVisibleBoxes > 0 && (
            <div className="sama-clean-kindwarn">
              ⚠️ 当前档藏掉了 <b>{clean.hiddenVisibleBoxes}</b> 个<b>真实可见盒子</b>
              （有背景色 / 边框 / 圆角）。切到「隐藏结构框」或「全画」可看到它们。
            </div>
          )}
          <div className="sama-clean-stats">
            {(['app', 'design'] as const).map((side) => {
              const st = clean.data!.stats[side];
              const ms = clean.data!.mergeStats[side];
              return (
                <div key={side} className="sama-clean-side">
                  <span className="sama-clean-side-label">{side === 'app' ? 'App' : '设计稿'}</span>
                  <span>
                    {st.kept} / {st.total} 保留
                    {ms.merged < ms.total ? `，归并成 ${ms.merged}` : ''}
                  </span>
                </div>
              );
            })}
          </div>

          {/* 按层过滤：空 = 全显示。点一下只看某一层，再点取消 */}
          <div className="sama-clean-tiers">
            {CLEAN_TIERS.map((t) => {
              const count =
                clean.data!.stats.app.byTier[t.id] + clean.data!.stats.design.byTier[t.id];
              const on = clean.tierFilter.size === 0 || clean.tierFilter.has(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`sama-clean-tier tier-${t.id}${on ? ' on' : ''}`}
                  onClick={() => onToggleCleanTier?.(t.id)}
                  title={t.hint}
                >
                  {t.label} {count}
                </button>
              );
            })}
          </div>
          {clean.tierFilter.size > 0 && (
            <div className="sama-clean-hint">
              已按选中层过滤（画布上只显示这些层）。再点一次该层可取消。
            </div>
          )}

          <div className="sama-clean-actions">
            <button
              type="button"
              className={`sama-clean-tab${showCleanDetail === 'dropped' ? ' on' : ''}`}
              onClick={() => setShowCleanDetail(showCleanDetail === 'dropped' ? null : 'dropped')}
            >
              剔除明细（{clean.data.dropped.length}）
            </button>
            <button
              type="button"
              className={`sama-clean-tab${showCleanDetail === 'merged' ? ' on' : ''}`}
              onClick={() => setShowCleanDetail(showCleanDetail === 'merged' ? null : 'merged')}
            >
              归并明细（{clean.data.merged.filter((m) => m.memberCount > 1).length}）· 与画布同档
            </button>
          </div>

          {showCleanDetail === 'dropped' && (
            <div className="sama-clean-list">
              {clean.data.dropped
                .filter((d) => clean.tierFilter.size === 0 || clean.tierFilter.has(d.tier))
                .slice(0, 200)
                .map((d) => (
                  // ⚠️ 用 div 而不是 button：画布已不画剔除框（2026-10-04 定案），
                  // 「点这行 → 画布高亮」已无对应的框可高亮。
                  // evidence 改挂 title —— 逐条核对判据靠的正是它。
                  <div
                    key={`${d.side}:${d.id}`}
                    className={`sama-clean-row tier-${d.tier}`}
                    title={d.evidence}
                  >
                    <span className={`sama-clean-tier-dot tier-${d.tier}`} />
                    <span className="sama-clean-reason">{d.reason}</span>
                    <small>{d.side === 'app' ? 'App' : '设计稿'}</small>
                  </div>
                ))}
              {clean.data.dropped.length > 200 && (
                <div className="sama-clean-more">仅列前 200 条（共 {clean.data.dropped.length} 条）</div>
              )}
            </div>
          )}

          {showCleanDetail === 'merged' && (
            <div className="sama-clean-list">
              {clean.data.merged
                // ⭐ 列表跟着画布**同一档**过滤（`sameKindAsCanvas`），否则会出现
                // 「列表里有这条、画布上没这个框」——点进去毫无反应，
                // 用户会以为是点击坏了。
                .filter((m) => isVisibleInKindFilter(m, clean.kindFilter))
                .filter((m) => m.memberCount > 1)
                .map((m) => (
                  <button
                    key={`${m.side}:${m.id}`}
                    type="button"
                    className={`sama-clean-row ${m.kind}${clean.focus === `merged:${m.id}` ? ' active' : ''}`}
                    onClick={() =>
                      onFocusCleanMerged?.(clean.focus === `merged:${m.id}` ? null : m.id)
                    }
                  >
                    <span className="sama-clean-count">{m.memberCount}</span>
                    <span className="sama-clean-reason">
                      {MERGE_KIND_LABEL[m.kind] ?? m.kind}
                      {m.text ? ` · ${m.text}` : ''}
                    </span>
                    <small>{m.side === 'app' ? 'App' : '设计稿'}</small>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {result && !result.ok && (
        <div className="alert error flush">
          {result.kind === 'input' ? '素材问题：' : '引擎异常：'}
          {result.error}
        </div>
      )}

      {report && result?.ok && (
        <>
          <div className="acceptance-verdict-row">
            <span className={`verdict-badge ${report.verdict}`}>{VERDICT_LABEL[report.verdict] ?? report.verdict}</span>
            <span className="acceptance-source">
              {ENGINE_LABEL[result.engineUsed]} · {result.durationMs}ms · {report.regions.length} 个分区
              {ranTemplate ? ` · 口径 ${TEMPLATE_LABEL[ranTemplate]}` : ''}
            </span>
          </div>

          {result.engineNote && <div className="acceptance-ai-config-warning">{result.engineNote}</div>}

          <div className="acceptance-counts">
            <span className={report.counts.p0 > 0 ? 'warn' : ''}>P0 {report.counts.p0}</span>
            <span className={report.counts.p1 > 0 ? 'warn' : ''}>P1 {report.counts.p1}</span>
            <span>P2 {report.counts.p2}</span>
            <span>强证据 {report.counts.byAuthority.strong}</span>
            <span>弱证据 {report.counts.byAuthority.weak}</span>
          </div>

          <div className="sama-reason">{report.verdictReason}</div>

          {report.noPixelEvidence.length > 0 && (
            <div className="sama-coverage">
              <strong>以下区间没有像素证据，不可判定（不等于通过）</strong>
              <ul>
                {report.noPixelEvidence.map((gap) => (
                  <li key={`${gap.designY0}-${gap.designY1}`}>
                    设计 y {Math.round(gap.designY0)}–{Math.round(gap.designY1)} · {gap.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="sama-subsection-title">分区（{report.regions.length}）</div>
          <div className="sama-region-list">
            {report.regions.map((region) => (
              <div className="sama-region-row" key={region.regionId}>
                <span className="sama-region-id">{region.regionId}</span>
                <span className="sama-region-label">{region.label}</span>
                <span className="sama-region-meta">
                  y {Math.round(region.designY[0])}–{Math.round(region.designY[1])} · {region.items} 项
                </span>
                {region.noPixelEvidence ? (
                  <span className="sama-region-flag warn">无像素证据</span>
                ) : (
                  <span className="sama-region-meta">覆盖 {Math.round(region.pixelCoverage * 100)}%</span>
                )}
                {region.reviewerUsed && <span className="sama-region-flag">AI 已复核</span>}
                {region.rejectedDefects > 0 && (
                  <span className="sama-region-flag" title="被编号回引门禁挡下的 AI 结论">
                    挡下 {region.rejectedDefects}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="sama-subsection-title">问题（{issues.length}）</div>
          {issues.length === 0 ? (
            <div className="ai-flow-empty">
              没有发现缺陷项 —— 但请先确认上面的「无像素证据」区间，未覆盖的区域不算通过。
            </div>
          ) : (
            <div className="sama-issue-list">
              {issues.map((issue) => {
                /**
                 * 能不能在画布上定位：**必须两侧 id 都没有才不行**。
                 *
                 * 结构性 issue（对齐漂移 / 无像素证据）与像素通道 issue 本来就没有
                 * 单一对应节点 —— 它们讲的是一整段区间。给它们画「定位」入口会让用户
                 * 点进去发现画布没反应，反倒以为功能坏了。
                 */
                const locatable = Boolean(issue.evidence.designId || issue.evidence.appId);
                return (
                <React.Fragment key={issue.issueId}>
                  <button
                    type="button"
                    className={`sama-issue-row ${issue.severity.toLowerCase()}${openIssue === issue.issueId ? ' active' : ''}`}
                    onClick={() => toggleIssue(issue.issueId)}
                  >
                    <span className={`sama-severity ${issue.severity.toLowerCase()}`}>{issue.severity}</span>
                    <span className="sama-issue-category">{categoryLabel(issue.category)}</span>
                    <span className="sama-issue-title">{issue.title}</span>
                    <small>
                      {issue.source === 'ai' ? 'AI' : issue.source === 'mixed' ? '规则+AI' : '规则'}
                      {' · '}
                      {issue.authority === 'strong' ? '强判定' : '弱判定'}
                      {locatable ? ' · 可定位' : ''}
                    </small>
                  </button>
                  {openIssue === issue.issueId && (
                    <div className="sama-issue-detail">
                      <div>{issue.detail}</div>
                      <div className="sama-issue-evidence">
                        <span>标记 {issue.evidence.markId ?? '—'}</span>
                        <span>分区 {issue.evidence.regionId ?? '—'}</span>
                        {issue.evidence.designText && <span>设计「{issue.evidence.designText}」</span>}
                        {issue.evidence.appText && <span>App「{issue.evidence.appText}」</span>}
                        {issue.evidence.designBox && (
                          <span>
                            设计框 {issue.evidence.designBox.map((v) => Math.round(v)).join(', ')}
                          </span>
                        )}
                        {issue.evidence.appBox && (
                          <span>App 框 {issue.evidence.appBox.map((v) => Math.round(v)).join(', ')}</span>
                        )}
                      </div>
                      {issue.evidence.normBox && (
                        <div className="sama-issue-evidence">
                          <span>归一化 {issue.evidence.normBox.map((v) => Math.round(v)).join(', ')}</span>
                        </div>
                      )}
                      {issue.evidence.aiReason && <div className="sama-issue-ai">AI：{issue.evidence.aiReason}</div>}
                      {issue.needsHumanReview && <div className="sama-issue-flag">需人工确认</div>}
                      {locatable && (
                        <button
                          type="button"
                          className="sama-issue-locate"
                          onClick={() => onFocusIssue?.(focusedIssue === issue.issueId ? null : issue.issueId)}
                          title="在画布上定位并选中该节点"
                        >
                          {focusedIssue === issue.issueId ? '画布已定位' : '在画布上定位'}
                        </button>
                      )}
                    </div>
                  )}
                </React.Fragment>
                );
              })}
            </div>
          )}

          {report.pixel && (
            <>
              <div className="sama-subsection-title">像素通道</div>
              {!report.pixel.available ? (
                <div className="ai-flow-empty">
                  不可用{report.pixel.reason ? `：${report.pixel.reason}` : ''}
                </div>
              ) : (
                <div className="sama-pixel-summary">
                  <span>检查 {report.pixel.summary.checked} 项</span>
                  <span className={report.pixel.summary.failed > 0 ? 'warn' : ''}>
                    失败 {report.pixel.summary.failed}
                  </span>
                  <span>颜色 ΔE 阈值 {report.pixel.thresholds.deltaE}</span>
                  <span>圆角容差 {report.pixel.thresholds.cornerTolerancePx}px</span>
                </div>
              )}
            </>
          )}

          <div className="sama-actions">
            <button
              type="button"
              className="btn"
              onClick={() => downloadText(`sama-${pairId}.md`, result.markdown)}
            >
              导出 Markdown 报告
            </button>
          </div>
        </>
      )}

      {!result && (
        <div className="acceptance-empty">
          还没跑过 SAMA。它会像「运行验收」一样直接读本地素材，不需要导出任何文件。
        </div>
      )}
    </section>
  );
};

export default SamaPanel;
