/**
 * 设计侧「视觉单元归并」。
 *
 * ## 要解决的问题
 *
 * Figma 的 `GROUP` 本身**不绘制任何像素**（实测 99 个 GROUP 的 `hasFill` 恒为 0），
 * 视觉效果由它的子节点画出来。一个「背景组合」在数据上是：
 *
 * ```
 * □ Group 2085664319  351×64   hasFill=false   ← 自身不画
 *   ■ Rectangle 1312321453 351×64               ← 底板
 *   □ ※※ 349×62                                ← 中间层
 *     ■ Rectangle / 亮紫(fx=BLUR) / 亮蓝(fx=BLUR)
 *   ■ Group 2085664522 183×62                    ← 右侧图标组
 * ```
 *
 * 这些子树在画布上散成十几个小框，人工核对时看不清「这是一张卡片」。
 * 本模块把它们收成**按视觉分组的**少数几个节点。
 *
 * ## ⭐ 判据（四档，全部由实测标定，不是拍脑袋）
 *
 * 实测设计侧 227 个有子节点的容器，按「子树叶子数 × 子单元重叠率」分档：
 *
 * | 档 | 判据 | 实测命中 | 归并方式 |
 * |---|---|---|---|
 * | **L0 不合** | 子树 > **8** 个叶子 | 32 | 保持展开（合了等于把整页变成一个框） |
 * | **L1 单子** | 只有 1 个可参与子单元 | 61 | 合成 1 个（合了就是它自己） |
 * | **L2 分离** | 子单元**完全不重叠** | 72 | **每个子单元各自成一个**节点 |
 * | **L3 部分重叠** | 重叠 0 < r ≤ 70% | 48 | 按**重叠连通分量**拆成若干个 |
 * | **L4 高度重叠** | 重叠 > 70% | 14 | ⚠️ **本模块不拆**，原样保留（留给 AI 模块划分） |
 *
 * L4 之所以不拆：`Group 37415`（21×18）= 2 个矢量 + 2 个 3×3 圆点，
 * `编组 17`（172×172）= 矩形 + 149×149 图 —— 这些是**矢量绘制细节**
 * （图标 / 二维码 / 蒙版），类名已说明一切，拆开只会得到一堆无意义的碎片。
 *
 * ## 为什么不用 AI
 *
 * 实测这 14 个 L4 候选里 11 个的类名已经给出答案（`编组17`=二维码、
 * `默认头像`=图标、`Mask group`=矢量蒙版）。真正需要语义的只有 3 个
 * （`券 满1000减60` 76×14），而它们的判据仍是规则
 * （「矩形底框 + 文字 ⇒ 业务元素」）⇒ **AI 在这一层没有增量价值**。
 *
 * AI 真正该用在这里：**判断哪几个视觉单元属于同一个业务模块**
 * （你的流程第 3 步「AI 模块划分」）。本模块只做「看起来是不是一坨」。
 */

import type { MergeInput, MergedNode, MergeKind } from './merge-view.ts';
import { mergeBoxOf } from './merge-view.ts';

/** 子树叶子数上限：超过就不合（合了信息损失太大） */
export const VISUAL_MAX_LEAVES = 8;
/** 子单元重叠率超过它就算「高度重叠」（L4，本模块不拆） */
export const VISUAL_HEAVY_OVERLAP = 0.7;

/** 两矩形的重叠面积占「较小者」面积的比例 */
function overlapRatio(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const area = ox * oy;
  if (area <= 0) return 0;
  const small = Math.min(a.width * a.height, b.width * b.height);
  return small > 0 ? area / small : 0;
}

/** 节点是否「参与视觉输出」（有填充 / 是文本） */
function paints(n: MergeInput): boolean {
  const b = n.boxStyle;
  if (n.nodeKind === 'text') return true;
  if (n.nodeKind === 'visual') return true;
  return !!(b?.backgroundColor || b?.cornerRadius || b?.borderWidth);
}

/**
 * 一簇成员该用什么当**身份标识**（`id`）。
 *
 * ⚠️⚠️ **不是「优先取可绘制的」**（2026-10-05 修正，两轮都踩在这里）。
 *
 * `mergeCoincident` 那条规则在这里**会出错**：它的场景是父子/兄弟**几何逐位相同**，
 * 代表选谁都行；而视觉单元的成员**大小差一个数量级**
 * （实测簇 `12360`：成员含 `32×32` 的容器与 `3×6` 的小矩形）⇒
 * 按「可绘制优先」会选中那个 `3×6` 的小矩形。
 *
 * 正确判据：取**面积最大**的成员（能代表整簇的体量）。
 * 若全都不绘制（容器）则仍取面积最大的。
 */
function pickRepresentative(members: MergeInput[]): MergeInput {
  const area = (m: MergeInput): number => m.rect.width * m.rect.height;
  return members.reduce((best, m) => (area(m) > area(best) ? m : best), members[0]);
}

/** 一簇成员的矩形**并集** —— 这才是「这一簇在屏幕上占多大」 */
function unionRect(members: MergeInput[]): { x: number; y: number; width: number; height: number } {
  const minX = Math.min(...members.map((m) => m.rect.x));
  const minY = Math.min(...members.map((m) => m.rect.y));
  const maxX = Math.max(...members.map((m) => m.rect.x + m.rect.width));
  const maxY = Math.max(...members.map((m) => m.rect.y + m.rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function toViewNode(
  kind: MergeKind,
  members: MergeInput[],
  side: 'design' | 'app',
  childCounts: ReadonlyMap<string, number>,
): MergedNode {
  const top = pickRepresentative(members);
  const box = mergeBoxOf(members);
  return {
    id: top.id,
    side,
    kind,
    // ⚠️ rect 取**成员并集**，不是代表的盒子。
    // 视觉单元的成员大小差很多（`32×32` 的容器 + `3×6` 的小矩形），
    // 取任一成员都会明显偏小 —— 实测取代表时只有并集的 3%。
    rect: unionRect(members),
    memberIds: members.map((m) => m.id),
    // nodeKind / text 跟着**代表**走（代表已取面积最大者）
    nodeKind: top.nodeKind ?? 'container',
    text: top.text ?? members.find((m) => m.text)?.text ?? null,
    boxStyle: box,
    hasChildren: (childCounts.get(top.id) ?? 0) > 0,
    hasBoxPaint: !!(box.backgroundColor || box.cornerRadius || box.borderWidth),
  };
}

/**
 * 视觉单元归并 —— **只对设计侧生效**。
 *
 * ⚠️ App 侧**不适用**，两侧不可混用同一条判据：
 * App 的 `ReactViewGroup` 是真实布局节点（RN 里没有 Figma 那种「不画的分组」），
 * 且它与子节点同尺寸的情况已由 `coincident-parent` 归并处理
 * （实测 54 个同尺寸壳，且代表节点已修成优先取可绘制的那个）。
 */
export function mergeVisualUnits(
  nodes: MergeInput[],
  side: 'design' | 'app',
  childCounts: ReadonlyMap<string, number>,
  consumed: Set<string>,
): MergedNode[] {
  // ⭐ 只有设计侧做这件事
  if (side !== 'design') return [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kidsOf = (id: string): MergeInput[] => nodes.filter((n) => n.parentId === id);

  const out: MergedNode[] = [];

  /** 收集 id 的全部后代（含自身由调用方决定） */
  const subtree = (id: string, acc: MergeInput[] = []): MergeInput[] => {
    acc.push(byId.get(id)!);
    for (const c of kidsOf(id)) subtree(c.id, acc);
    return acc;
  };

  /**
   * ⚠️⚠️ **必须按深度倒序遍历**（2026-10-05 修正，实测踩过）。
   *
   * 症状：用户报的 `1755:13002`（3 段式背景卡）没被收，
   * 而它的祖先 `13001`（7 个直接子、19 个叶子）被 `coincident-parent` 收了。
   *
   * 原因：文档序遍历时 `13001`（depth 1）**排在** `13002`（depth 2）之前。
   * 而 `coincident-parent` 判据是「父子几何逐位相同」——
   * `13001` 与它的父 `13002` 同为 `351×64`（实测 dx=dy=0）⇒ 被合成一簇。
   * `13002` 因此进了 `consumed`，视觉单元归并再也碰不到它。
   *
   * ⇒ **先深后浅**：深处的 `13002`（叶子 6，符合归并条件）先被收成视觉单元，
   * `13001` 随后因 `consumed` 命中而跳过 ⇒ 祖先不会抢走孙子的机会。
   *
   * 深度从 `byParent` 链算（不依赖外部字段），并用「稳定」保证同深度按文档序。
   */
  const depthOf = (id: string): number => {
    let d = 0;
    let cur = byId.get(id);
    for (let hops = 0; cur && hops < 64; hops += 1) {
      const pid = cur.parentId;
      if (!pid || !byId.has(pid)) break;
      d += 1;
      cur = byId.get(pid);
    }
    return d;
  };
  const ordered = nodes
    .map((n, i) => ({ n, d: depthOf(n.id), i }))
    .sort((a, b) => (b.d - a.d) || (a.i - b.i))  // 深度倒序，同深度保持文档序
    .map((x) => x.n);

  for (const root of ordered) {
    if (consumed.has(root.id)) continue;
    const directKids = kidsOf(root.id).filter((k) => !consumed.has(k.id));
    if (directKids.length === 0) continue;

    // 只处理「自身不绘制」的分组（GROUP / FRAME）；自身有填充的走原有重合逻辑
    if (root.nodeKind !== 'container') continue;

    const all = subtree(root.id);
    const leaves = all.filter((n) => kidsOf(n.id).filter((k) => !consumed.has(k.id)).length === 0);

    // ── L0：子树太大，保持展开 ──
    if (leaves.length > VISUAL_MAX_LEAVES) continue;

    // 「参与视觉输出」的子单元（自身是子节点，或自身有后代在画）
    const units = directKids.filter((k) => paints(k) || kidsOf(k.id).length > 0);

    // ── L1：只有一个单元 ⇒ 合成 1 个 ──
    if (units.length <= 1) {
      for (const m of all) consumed.add(m.id);
      out.push(toViewNode('visual-group', all, side, childCounts));
      continue;
    }

    /**
     * 某单元的**叶子**（真正画出来的那一块）。
     *
     * ⚠️ 判据只能基于叶子：子树根与它自己的后代是**包含关系**、必然重叠，
     * 拿根算重叠会把所有单元串成一个连通分量（第一版的 bug：28/53 个簇是错的，
     * 症状是「代表 3×6 但成员并集 32×32」）。
     */
    const leavesOf = (id: string): MergeInput[] => {
      const acc: MergeInput[] = [];
      const walk = (nid: string): void => {
        const kids = kidsOf(nid);
        if (kids.length === 0) {
          acc.push(byId.get(nid)!);
          return;
        }
        for (const c of kids) walk(c.id);
      };
      walk(id);
      return acc;
    };
    const unitLeaves = new Map<string, MergeInput[]>();
    for (const u of units) unitLeaves.set(u.id, leavesOf(u.id));

    /** 两个单元「视觉上叠在一起」= 它们的**叶子**有交集 */
    const unitsOverlap = (a: MergeInput, b: MergeInput): boolean => {
      const la = unitLeaves.get(a.id) ?? [a];
      const lb = unitLeaves.get(b.id) ?? [b];
      for (const x of la) {
        for (const y of lb) {
          if (overlapRatio(x.rect, y.rect) > 0 || sameBox(x.rect, y.rect)) return true;
        }
      }
      return false;
    };

    /** 最大叶子重叠率（L4 判据用） */
    let maxOverlap = 0;
    for (let i = 0; i < units.length; i += 1) {
      for (let j = i + 1; j < units.length; j += 1) {
        const la = unitLeaves.get(units[i].id) ?? [units[i]];
        const lb = unitLeaves.get(units[j].id) ?? [units[j]];
        for (const x of la) {
          for (const y of lb) {
            const r = overlapRatio(x.rect, y.rect);
            if (r > maxOverlap) maxOverlap = r;
          }
        }
      }
    }

    // ── L4：高度重叠 ⇒ 不拆（矢量绘制细节，拆开只是碎片）──
    if (maxOverlap > VISUAL_HEAVY_OVERLAP) {
      for (const m of all) consumed.add(m.id);
      out.push(toViewNode('visual-group', all, side, childCounts));
      continue;
    }

    // ── L2 / L3：按「叶子重叠连通分量」拆簇 ──
    //
    // ⚠️⚠️ **必须只用叶子算重叠，不能用「子树根」**（2026-10-05 修正）。
    //
    // 我第一版用 `units`（含子树根）算重叠，结果 **28/53 个簇是错的**：
    // 根与它自己的后代是**包含关系**、必然重叠 ⇒ 每一对「根 vs 别的单元」都 >0
    // ⇒ 所有单元被串成**一个连通分量** ⇒ 一个都不拆，整棵树塞进一个框。
    //
    // 实测症状：`代表 3×6 但成员并集 32×32`（8 个成员）、
    // `代表 48×18 但并集 103×43`（6 个成员）—— 框住了一小片却声称收了一大片。
    //
    // 正确判据：**叶子之间是否重叠**。叶子才是真正「画出来的那一块」，
    // 包含关系不该算作「视觉上叠在一起」。

    const clusters: MergeInput[][] = [];
    for (const u of units) {
      const hit = clusters.find((c) => c.some((m) => unitsOverlap(m, u)));
      if (hit) hit.push(u);
      else clusters.push([u]);
    }

    for (const cluster of clusters) {
      const members = cluster.flatMap((u) => subtree(u.id));
      // 同一簇里若还有嵌套容器（units 已过滤，但保险起见去重）
      const uniq = [...new Map(members.map((m) => [m.id, m])).values()];
      for (const m of uniq) consumed.add(m.id);
      out.push(toViewNode('visual-group', uniq, side, childCounts));
    }
  }

  return out;
}

const sameBox = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  tol = 0.5,
): boolean =>
  Math.abs(a.x - b.x) <= tol &&
  Math.abs(a.y - b.y) <= tol &&
  Math.abs(a.width - b.width) <= tol &&
  Math.abs(a.height - b.height) <= tol;

/** 统计（并入 `MergeStats` 用） */
export function countVisualUnits(view: MergedNode[]): number {
  return view.filter((v) => v.kind === 'visual-group').length;
}
