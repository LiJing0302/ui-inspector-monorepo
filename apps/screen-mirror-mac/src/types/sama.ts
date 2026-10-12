/**
 * SAMA 引擎（`packages/ai-acceptance`）的 IPC 契约。
 *
 * 与 `aiAcceptance.ts` 是**两套并列的东西**，别混淆：
 *   `aiAcceptance.ts` —— 现有规则引擎（`main/acceptance/service.ts`）的产物模型
 *                        （phase / verdict / regionAnalysis / matches）
 *   本文件           —— SAMA 引擎的产物模型（`AcceptanceReport`：regions / issues / counts / pixel）
 *
 * 两者读同一份 workspace 素材，但方法论不同、结论独立，所以**各留一套类型**，
 * 不做字段映射 —— 硬凑成一个模型会让两边的语义都被稀释（缺字段的地方只能填 null，
 * 而显式 null 与「真的没有」在类型上分不开）。
 *
 * `AcceptanceReport` 直接从引擎包引入：它是纯数据类型（不含 `node:*` / Electron），
 * 渲染层可以安全消费。**不要**在这里 import 引擎包的 `./node` 子入口 ——
 * 那个入口带 `fs` / `pngjs`，会把平台依赖拖进渲染层。
 */

import type { AcceptanceReport } from '@ui-inspector/ai-acceptance';

/** `rules` = 只跑确定性通道；`mock` = 演练链路与门禁；`ai` = 真 VLM（用 App 里配好的那一份） */
export type SamaEngine = 'rules' | 'mock' | 'ai';

/**
 * 分区模板。
 *
 * `default` 是按设计稿结构自动分区（通用）；
 * `bundle` 是 2026-09-30 那个样本的 9 分区 + 环境态声明 —— **只在复现该样本时用**，
 * 换一页设计稿就是错的（分区边界、线下店/测试数据这些声明都是那一页特有的）。
 */
export type SamaTemplate = 'default' | 'bundle';

export interface SamaRunInput {
  pairId: string;
  engine?: SamaEngine;
  template?: SamaTemplate;
  /** M4 像素通道（颜色 / 圆角），默认开 */
  pixel?: boolean;
}

export interface SamaRunSuccess {
  ok: true;
  /** 实际生效的引擎 —— 请求 `ai` 但 App 里没配 AI 时会降级成 `rules` */
  engineUsed: SamaEngine;
  /** 降级原因等需要告知用户的前提；没有则为 null */
  engineNote: string | null;
  durationMs: number;
  report: AcceptanceReport;
  /** 与报告同源的 Markdown 全文，供「导出 / 复制」直接用 */
  markdown: string;
}

export interface SamaRunFailure {
  ok: false;
  /** `input` = 选错配对 / 素材缺失（可自纠）；`internal` = 引擎异常 */
  kind: 'input' | 'internal';
  error: string;
}

export type SamaRunResult = SamaRunSuccess | SamaRunFailure;

/* ============================================================================
   清洗明细（人工核验卡点①的画布可视图）
   ==========================================================================*/

/**
 * 清洗层的**镜像枚举** —— 必须与引擎包的 `CleanTier` 逐字一致。
 *
 * ⚠️ 为什么在宿主侧重声明而不是直接 import：
 * `types/sama.ts` 已经是「宿主 ⇄ 引擎」的契约边界（`AcceptanceReport` 就是这么引进来的），
 * 而 IPC 类型会跨进程、进渲染层 —— 那种场景下**值**（枚举成员）不该跨进程传，
 * 一旦引擎改了字面量而宿主没跟上，画布就会静默画不出东西。
 * 收敛办法：这里声明 + 下面 `assertCleanTier` 断言 + 冒烟守卫三道。
 */
export type CleanTierId =
  | 'L1-geometry'
  | 'L2-collector'
  | 'L3-invisible'
  | 'L4-semantic'
  | 'L5-viewport'
  /** 纯布局容器（无子 + 无背景/边框/圆角 + 非 SVG 族）—— 判据见引擎 `l0` 的 L6 注释 */
  | 'L6-layout';

/** 归并类型 —— 与引擎包 `merge-view.ts#MergeKind` 逐字一致 */
/**
 * 归并视图节点的种类。
 *
 * ⚠️ `passthrough` = **未参与任何归并的直通节点**（`memberIds.length === 1`）。
 * 它必须与两个 `coincident-*` 分开：前者是「什么都没发生」，
 * 后两者是「几何重合被收拢了」—— 画布要画不同的框，`byKind` 更是不同的数字。
 * 此前引擎把直通节点硬编码成 `coincident-sibling`，导致统计把
 * 317 个直通节点算成了兄弟重合（实测设计侧 444 → 389 的那次）。
 */
/**
 * 归并视图节点的种类 —— 与引擎 `merge-view.ts#MergeKind` 逐字一致。
 *
 * ⭐ `visual-group` = 设计侧「视觉单元」（引擎 `src/visual-unit.ts`）：
 * 一组**看起来是一坨**的子树收成一个节点。与 `coincident-*` 的区别在于
 * 那两个判据是「几何**逐位相同**」，这个是「几何**不同但视觉上属于同一元素**」
 * —— 典型是 Figma 背景卡（`GROUP` 自身 `hasFill=false`，底板/光斑/图标都是它的子节点）。
 *
 * ⚠️ `visual-group` **只有设计侧会有**；App 侧的 `ReactViewGroup` 是真实布局节点
 * （RN 没有 Figma 那种「不画的分组」），由 `coincident-parent` 处理。
 */
export type MergeKindId =
  | 'svg-root'
  | 'coincident-parent'
  | 'coincident-sibling'
  | 'passthrough'
  | 'visual-group';

/** 一个归并后的视图节点（画布画聚合框，面板列成员） */
export interface MergedViewNode {
  /** 代表节点（重合时取上层；SVG 取根） */
  id: string;
  side: 'design' | 'app';
  kind: MergeKindId;
  rect: [number, number, number, number];
  /** ⚠️ 全部真实成员 id，一个不少 —— 这是「不丢 treePath」的保证 */
  memberIds: string[];
  text: string | null;
  /** 成员数（>1 才是真正被归并的；=1 是直通节点） */
  memberCount: number;
  /**
   * 视图节点的节点类型（引擎 `NormNode.kind`）。
   *
   * ⭐ 必须由**引擎带过来**，画布侧不能自己推导 ——
   * 归并后的 `memberIds` 可能有多个成员，各成员的 `kind` 可能不同
   * （`PathView` 是 visual、其 `SvgView` 父是 container），
   * 画布侧无从知道「这个框原本是什么」。
   */
  nodeKind: string;
  /**
   * 该视图节点**是否有子节点**（树结构上不是叶子）。
   *
   * ⭐ 这是「隐藏树中间层」口径的关键依据：带子节点的容器是**分组**，
   * 画个框盖住整块区域会与内部的元素框重叠、读不出层次；
   * 而叶子容器常常**有背景色**（卡片底、输入框），是真实可见盒子，必须保留。
   */
  hasChildren: boolean;
  /**
   * 成员里**是否有人画了背景 / 边框 / 圆角**（三态聚合，见引擎 `mergeBox`）。
   *
   * ⚠️ 用 `boolean` 而非逐键值：画布只需要「有没有画盒子」这一个判断，
   * 而逐键值会把 `boxStyle` 的三态语义（没读过 vs 读过为空）泄漏到 IPC 契约里。
   */
  hasBoxPaint: boolean;
}

export interface CleanDroppedNode {
  id: string;
  side: 'design' | 'app';
  tier: CleanTierId;
  reason: string;
  /** 判据快照，如「父容器高度=0 + clippedOut + required + 文本『6』」 */
  evidence: string;
  /** 该节点的原始几何（帧内逻辑坐标）—— ⚠️ 被剔除的节点不在 `node.rect` 索引里，
   *  所以这个矩形必须**由引擎带过来**，不能指望画布侧再查一次 */
  rect: [number, number, number, number];
}

/** 一个保留节点（画布画淡框用） */
export interface CleanKeptNode {
  id: string;
  side: 'design' | 'app';
  rect: [number, number, number, number];
  kind: 'text' | 'visual' | 'container' | 'chrome';
  text: string | null;
}

export interface SamaCleanSuccess {
  ok: true;
  durationMs: number;
  /** 各侧统计（与报告的 shaping 同源，但带 byTier） */
  stats: {
    design: { total: number; kept: number; dropped: number; byTier: Record<CleanTierId, number> };
    app: { total: number; kept: number; dropped: number; byTier: Record<CleanTierId, number> };
  };
  kept: CleanKeptNode[];
  dropped: CleanDroppedNode[];
  /**
   * 归并后的视图节点（画布画聚合框）。
   *
   * ⭐ 与 `kept` 的关系：`kept` 是**清洗后**的真实节点（一个不少），
   * `merged` 是它们的**视图组织**（SVG 收拢 / 重合合一）。
   * 两个都要传 —— 前者回答「还剩什么」，后者回答「怎么组织」。
   */
  merged: MergedViewNode[];
  /** 归并统计（给面板显示「省了多少」） */
  mergeStats: {
    app: { total: number; merged: number };
    design: { total: number; merged: number };
  };
}

export interface SamaCleanFailure {
  ok: false;
  kind: 'input' | 'internal';
  error: string;
}

export type SamaCleanResult = SamaCleanSuccess | SamaCleanFailure;
