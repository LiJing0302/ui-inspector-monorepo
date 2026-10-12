/**
 * 画布「kind 过滤」档位的**唯一判据来源**。
 *
 * ## 为什么必须共用
 *
 * 画布（`CanvasBoard`）与面板的归并明细（`SamaPanel`）都要按同一档位筛。
 * 两处各写一份必然漂 —— 症状是「列表里点一条 → 画布上没那个框」，
 * 用户会以为是点击坏了，而实际上两边筛的集合不同。
 *
 * ## 三档的语义与实测代价
 *
 * | 档 | 判据 | 10年管家实测框数 | 代价 |
 * |---|---|---|---|
 * | `structured`（默认） | 隐藏「容器里**无**背景/边框/圆角」的纯结构框 | 606 → **518** | **可见盒子零损失**（藏 88 个） |
 * | `drawable` | 只画 `nodeKind !== 'container'` | 606 → **408** | 多藏 110 个**真实可见盒子**（卡片底、输入框边框） |
 * | `all` | 全画 | 606 | 框最密，信息完整 |
 *
 * ## ⚠️⚠️ `structured` 的判据是「有没有画盒子」，**不是**「有没有子节点」
 *
 * 实测（10年管家）：198 个 container 里 **197 个有子节点、只有 1 个叶子**，
 * 而**带背景色的 110 个可见盒子全都落在「有子节点」那 197 个里**。
 *
 * 根因很直白：一个「带背景的分组」本来**既是容器又是有孩子** ——
 * 页面根 `10年管家开通前` = `bg:#f5f5f5` + 7 个子节点。
 * ⇒ 按「有子节点」判会把 110 个可见盒子**全部藏掉**，比不过滤更糟。
 *
 * 这条判据试错过一次（先按 `hasChildren` 写），断言与实测数据把它打回来了。
 */

export type CleanKindFilter = 'all' | 'structured' | 'drawable';

/** 一个视图节点里，本过滤用得到的最小信息 */
export interface KindFilterable {
  /** 引擎 `NormNode.kind`：`text` / `visual` / `container` / `chrome` */
  nodeKind: string;
  /** 成员里是否有人画了背景 / 边框 / 圆角（**真正的可见盒子判据**） */
  hasBoxPaint: boolean;
}

/** 展示名（面板按钮与 tooltip 共用，避免两处措辞漂移） */
export const CLEAN_KIND_FILTER_LABEL: Record<CleanKindFilter, string> = {
  structured: '隐藏结构框',
  drawable: '只看可绘制',
  all: '全画',
};

export const CLEAN_KIND_FILTER_HINT: Record<CleanKindFilter, string> = {
  structured:
    '默认。隐藏「容器里没有背景/边框/圆角」的纯结构框 —— 它们不画任何像素，可见盒子一个都不丢',
  drawable: '只画文本 + 图形。会一并藏掉带背景色的可见盒子（卡片底、输入框边框）',
  all: '所有视图节点都画（含纯结构框）—— 框最密，但信息完整',
};

/** 该节点在给定档位下**是否画在画布上**。画布与面板列表都调它 */
export function isVisibleInKindFilter(node: KindFilterable, mode: CleanKindFilter): boolean {
  if (mode === 'all') return true;
  if (mode === 'drawable') return node.nodeKind !== 'container';
  return !(node.nodeKind === 'container' && !node.hasBoxPaint);
}

/** 按档位过滤（画布用它出框，面板用它出列表与统计） */
export function filterByKindFilter<T extends KindFilterable>(
  nodes: readonly T[],
  mode: CleanKindFilter,
): T[] {
  return nodes.filter((n) => isVisibleInKindFilter(n, mode));
}
