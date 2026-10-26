import { mergeVisualUnits } from './visual-unit.ts';
/**
 * 节点归并视图（2026-10-04）—— 「人工核验卡点：清洗之后，剩的东西怎么组织」
 *
 * ## 为什么是「视图」而不是继续清洗
 *
 * 归并（把 SVG 内部元素、重合父子收成一个）与剔除（把不该看的剔掉）是**两件事**：
 * 剔掉的节点本来就不该进验收，而归并的节点**每一个都是真实存在的**，
 * 只是「UI 同学看的是整个图标，不是图标里的 6 个 path」。
 *
 * ⭐ 更关键的理由：**归并绝不能进数据层**。
 * `nodeId = sdk:<treePath>` 是回源码的**唯一坐标**（见 `REF-canvas-rules.md`），
 * 合并节点必丢 treePath；而引擎 L3a 投票与 L3b 容器内分配都吃**兄弟集合** ——
 * 只有 App 侧会合并 ⇒ 两侧树形不对称 ⇒ 匹配率崩。
 *
 * ⇒ 本模块**零改动数据层**：每个视图节点都带完整的 `memberIds`，
 * 一个不少地指向真实节点。画布点开可以逐个跳回源码。
 *
 * ## 判据与 `lib/stack.ts` 同口径
 *
 * 渲染层已有 `stackOf` / `mergeAppNodes` 做「重合兄弟 + 样式聚合」，
 * 但它在 `renderer/src/lib/` 下、依赖 `RenderNode`，**引擎不能 import**。
 * 所以这里按**同一套判据**重新实现一遍纯函数（几何计算，O(n²) 但 n ≤ 千级）。
 *
 * ⚠️ 两处必须与 `stack.ts` 严格一致，否则「画布看到的」与「引擎算出的」会分叉：
 *  - 不允许位置或尺寸容差（四个原始输入数值严格相同才算重合）
 *  - 资格：可见 + 未裁剪 + 有面积（**对目标自身同样成立**）
 *  - 样式聚合：并集、**冲突取上层**（几何重合时看得见的是上层）、三态逐条保留
 */

/** 与 `lib/stack.ts` 的 `STACK_TOLERANCE` 一致 —— 改一处必须改另一处 */
export const STACK_TOLERANCE = 0;

/** 归并类型 */
export type MergeKind =
  /** SVG 内部元素收拢为 `SvgView` 整体 */
  | 'svg-root'
  /** 子与父几何逐位相同 → 父子合一 */
  | 'coincident-parent'
  /** 同父 + 几何逐位相同 → 兄弟合一 */
  | 'coincident-sibling'
  /**
   * 设计侧「视觉单元」：一组**看起来是一坨**的子树收成一个节点
   * （`src/visual-unit.ts`，按子树叶子数 × 子单元重叠率分四档）。
   *
   * 与 `coincident-*` 的区别：那两个判据是「几何**逐位相同**」，
   * 这个是「几何**不同但视觉上属于同一元素**」——
   * 典型是 Figma 的背景卡（`GROUP` 自身 `hasFill=false`，
   * 底板/光斑/图标都是它的子节点）。
   */
  | 'visual-group'
  /**
   * 未参与任何归并的**直通节点**（`memberIds.length === 1`）。
   *
   * ⚠️ 2026-10-04 补：此前单节点被硬编码成 `coincident-sibling`
   * （注释写「语义上无重合」），后果是 `stats.byKind` 里
   * `coincident-sibling` 把 317 个直通节点算成了兄弟重合 ——
   * **统计数字完全不可信**，而面板与画布正是靠它分类上色的。
   * 「没被归并」和「被归并成兄弟簇」是两件必须能分开的事。
   */
  | 'passthrough';

/** 一个视图节点：几何 + 聚合样式，`memberIds` 指回全部真实节点 */
export interface MergedNode {
  /** 代表节点（取「上层」那个：重合时看得见的那个；SVG 取根） */
  id: string;
  side: 'design' | 'app';
  kind: MergeKind;
  rect: { x: number; y: number; width: number; height: number };
  /** ⚠️ 恒含全部真实成员 id，**一个不少** —— 这是「不丢 treePath」的保证 */
  memberIds: string[];
  /** 视图节点自己的 kind（多数情况下沿用代表节点） */
  nodeKind: string;
  text: string | null;
  /**
   * 聚合后的盒样式（三态）。
   * `undefined` = 该键**没读过**（区别于「读过且为空」= `null`）。
   */
  boxStyle: {
    backgroundColor?: string | null;
    cornerRadius?: number | null;
    borderWidth?: number | null;
    borderColor?: string | null;
  };
  /**
   * 该视图节点**在原始树里是否还有子节点**（2026-10-04 加）。
   *
   * 由 `parentId` 反算得出，**调用方不需要多传字段** ——
   * 这样 `MergeInput` 保持最小（它刻意不依赖引擎的 `NormNode`）。
   *
   * ⚠️⚠️ **实测证明它不适合当画布过滤依据**（写这份注释时我判断错了）：
   * 10年管家 198 个 container 里 **197 个有子节点、只有 1 个叶子**，
   * 而**带背景色的 110 个可见盒子全都落在「有子节点」那 197 个里**。
   * 根因很直白：一个「带背景的分组」本来就同时是容器**和**有子节点
   * （页面根 `10年管家开通前` = `bg:#f5f5f5` + 7 个子节点）。
   * ⇒ 「隐藏有子节点的容器」会丢掉全部 110 个可见盒子，**与不区分更糟**。
   *
   * 画布要的真过滤依据是 `hasBoxPaint`。本字段保留是因为它是**客观树事实**，
   * 人工核验时需要它判断「这个框是分组还是叶子」。
   */
  hasChildren: boolean;
  /**
   * 成员里是否有人画了背景 / 边框 / 圆角。
   *
   * ⭐ **这才是画布过滤该用的字段**：容器分两种 ——
   *  - `hasBoxPaint: true` ⇒ **真实可见盒子**（卡片底、输入框、分隔条），必须画；
   *  - `hasBoxPaint: false` ⇒ **纯结构框**，不画任何像素，只给子节点定位 ⇒ 可隐藏。
   *
   * 实测（10年管家）：198 个 container = 有盒样式 110 / 无 88。
   * 按本字段过滤 ⇒ 藏掉 88 个纯结构框、**可见盒子零损失**（断言已锁）。
   */
  hasBoxPaint: boolean;
}

export interface MergeStats {
  /** 原始节点数 */
  total: number;
  /** 视图节点数 */
  merged: number;
  byKind: Record<MergeKind, number>;
  /** ⭐ 归并**只影响视图**，这些数字必须保持不变（回归守卫） */
  idsPreserved: boolean;
}

const sameRect = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean =>
  (['x', 'y', 'width', 'height'] as const).every((key) =>
    Number.isFinite(a[key]) && Number.isFinite(b[key]) && a[key] === b[key]);

/** 最小节点形状（避免依赖引擎的 `NormNode` / 渲染层的 `RenderNode`） */
export interface MergeInput {
  id: string;
  parentId: string | null;
  index: number;
  rect: { x: number; y: number; width: number; height: number };
  visible?: boolean;
  clipped?: boolean;
  className?: string;
  nodeKind?: string;
  text?: string | null;
  boxStyle?: {
    backgroundColor?: string | null;
    cornerRadius?: number | null;
    borderWidth?: number | null;
    borderColor?: string | null;
  } | null;
  /**
   * 该节点所属 SVG 图标的**根 id**（`SvgView`），不属于任何 SVG 则 `undefined`。
   *
   * ## ⭐ 为什么必须由调用方预先算好，而不是在归并时沿 `parentId` 走
   *
   * 实测（10年管家 App 侧）：`SvgView` 的**直接子是 `GroupView 0×0`** ——
   * SVG 的绘制树有一层零尺寸中间层。而清洗的 `zero-size` 判据会把它剔掉，
   * 于是 `byParent` 在第一层就断了，`walk` 只收得到根自己：
   *
   * ```
   * 30 个 SvgView 根 → 后代共 162 个
   *   处置：kept 54 / zero-size 38（GroupView 0×0 25 + DefsView/GradientView 高 0 13）
   *        / hidden-by-ancestor 若干 / outside-viewport 若干
   * 归并结果：19 个 svg-root 视图，**成员数全为 1**（收拢了 0 个内部元素）
   * ```
   *
   * ⇒ 归并看到的树是**清洗后的残树**，靠它自己走不出完整子树。
   * 而调用方手里有**原始节点表**（含被剔的中间层），能在清洗前算出
   * 「这个 `PathView` 的 SVG 祖先根是谁」。
   *
   * ## 契约形状
   * 只传一个 id（不传成员数组），归并侧据此聚合：
   * **同一个 `svgGroup` 的所有节点合成一个 `svg-root` 视图节点**，
   * `memberIds` 含组内**全部**节点（含被清洗剔掉的）。
   */
  svgGroup?: string;
}

/** 资格判据 —— 与 `stack.ts#participates` 逐条一致（目标自身也要过） */
const participates = (n: MergeInput): boolean =>
  n.visible !== false && !n.clipped && n.rect.width > 0 && n.rect.height > 0;

/** 从上层往下取第一个有值的；决定某键「没读过」时要不要写 */
const pick = <V>(
  members: MergeInput[],
  read: (m: MergeInput) => V | null | undefined,
): { set: boolean; value: V | null } => {
  for (let i = members.length - 1; i >= 0; i -= 1) {
    const v = read(members[i]);
    if (v !== null && v !== undefined) return { set: true, value: v };
  }
  return { set: false, value: null };
};

/** 盒样式三态聚合（从上层往下取，每键独立判「读过没有」） */
export const mergeBoxOf = (members: MergeInput[]): MergedNode['boxStyle'] => {
  const st: MergedNode['boxStyle'] = {};
  // 逐键独立判「这层集合有没有读过」—— 不能整对象一刀切，
  // 否则「背景读过但圆角没读」会退化成「都没读」。
  const anyBox = members.some((m) => m.boxStyle);
  if (!anyBox) return st;
  for (const key of ['backgroundColor', 'cornerRadius', 'borderWidth', 'borderColor'] as const) {
    // ⚠️ 显式给类型参数：`pick` 返回的 `V` 必须与该键的实际类型对齐，
    // 否则 TS 会把它推成 `null`（`V` 只在两个分支里以 `null` 出现过）。
    const r = pick<string | number | null>(members, (m) => m.boxStyle?.[key] ?? null);
    if (r.set) (st as Record<string, string | number | null>)[key] = r.value;
  }
  return st;
};

/**
 * SVG 归并：horcrux 组件族的**内部元素**收拢为 `SvgView` 根。
 *
 * ## 判据
 * `className` 是 `SvgView`（短名，由 `l0` 写进 `tags` 的 `cn:` 前缀项回传）⇒ 是根；
 * 它的**全部后代**收成一个视图节点。
 *
 * ## 为什么不是「所有 SVG 类都算根」
 * 实测（盲盒 729 节点）：horcrux 族共 218 个（`PathView` 71 / `GroupView` 65 /
 * `SvgView` 46 / `DefsView` 11 / `MaskView` 5 …），而 `SvgView` 只有 **46** 个 ——
 * 平均每根带 4.7 个内部元素。这些 `PathView` / `DefsView` 是**矢量绘制细节**
 * （路径、渐变定义、遮罩），对「这个图标对不对」这个问题毫无意义，
 * 却会让节点表膨胀 4.7 倍、让匹配引擎多看 4.7 倍的噪声。
 *
 * ⚠️ 实测确认 `SvgView` 的直接子**全是** horcrux 类、没有混入非 SVG 节点，
 * 所以「收拢全部后代」不会误吞真实内容。
 *
 * ⚠️ 归并后**保留** `SvgView` 根作为代表节点 —— 它的矩形就是整个图标的盒子。
 */
function mergeSvgRoots(
  nodes: MergeInput[],
  side: 'design' | 'app',
  /** 见 `buildMergedView` 的注释：算 `hasChildren` 用 */
  childCounts: ReadonlyMap<string, number>,
): { merged: MergedNode[]; consumed: Set<string> } {
  const consumed = new Set<string>();
  const merged: MergedNode[] = [];

  /**
   * ⭐ 按 `svgGroup` 分组，**不再沿 `parentId` 走**。
   *
   * 为什么：实测 SVG 的绘制树有一层零尺寸中间层（`GroupView 0×0`），
   * 清洗的 `zero-size` 判据会剔掉它，`byParent` 在第一层就断了 ——
   * 沿树走的结果是 19 个 svg-root 视图**成员数全为 1**（收拢了 0 个内部元素）。
   * `svgGroup` 由调用方从**原始节点表**算出，能跨过被剔的中间层。
   *
   * 兼容：不传 `svgGroup` 时回退到「沿 `parentId` 走」的老行为
   * （这样引擎自测里手写的夹具仍能工作 —— 它们没有原始表可依）。
   */
  const byGroup = new Map<string, MergeInput[]>();
  for (const n of nodes) {
    const g = n.svgGroup;
    if (!g) continue;
    const arr = byGroup.get(g);
    if (arr) arr.push(n);
    else byGroup.set(g, [n]);
  }

  // 回退索引：只在「有节点没 svgGroup」时用
  const needWalk = byGroup.size === 0;
  const byParent = new Map<string, MergeInput[]>();
  if (needWalk) {
    for (const n of nodes) {
      const p = n.parentId;
      if (p === null) continue;
      const arr = byParent.get(p);
      if (arr) arr.push(n);
      else byParent.set(p, [n]);
    }
  }

  const isSvgRoot = (n: MergeInput): boolean => /SvgView/i.test(n.className ?? '');

  // ---- 主路径：按 svgGroup 聚合 ----
  if (byGroup.size > 0) {
    for (const [rootId, members] of byGroup) {
      // ⭐⭐ **组内必须真的有那个 `SvgView` 根**，否则不产出视图节点。
      //
      // 实测（10年管家）：30 个 SvgView 根里 **19 kept / 6 outside-viewport / 5 hidden**
      // —— 被清洗剔掉的那 11 个，它们的内部元素可能因 `participation='context'`
      // 而留在保留集里，成了**没有根的孤儿**（实测 16 个：
      // PathView 8 / CircleView 5 / RectView 3）。
      //
      // 若此时仍强行产出视图节点，代表 id 会退化成 `members[0]`（某个 PathView），
      // 画布上就出现「一个 2×3.67 的小方框被标成 svg-root」——
      // 那不是图标整体，是碎片。
      //
      // ⇒ 这类组**整体跳过**：成员不进 `consumed`，
      // 它们会走后面的 `mergeCoincident` / `passthrough`，
      // 至少还有个正确的 `kind`，而不是被谎报成图标。
      const root = members.find((m) => m.id === rootId);
      if (!root) continue;
      for (const m of members) consumed.add(m.id);
      const sorted = [...members].sort((a, b) => a.index - b.index);
      const box = mergeBoxOf(sorted);
      merged.push({
        id: root.id,
        side,
        kind: 'svg-root',
        // ⚠️ rect 取**根**的盒子：它就是整个图标的边界（实测根能框住绝大多数后代中心）。
        rect: { ...root.rect },
        memberIds: sorted.map((m) => m.id),
        nodeKind: root.nodeKind ?? 'visual',
        text: root.text ?? null,
        boxStyle: box,
        // 图标内部元素已被收进 memberIds ⇒ 画布上它是「叶子」，不该被当结构分组隐藏。
        hasChildren: false,
        hasBoxPaint: !!(box.backgroundColor || box.cornerRadius || box.borderWidth),
      });
    }
    return { merged, consumed };
  }

  // ---- 回退路径：沿 parentId 走（无 svgGroup 信息的输入）----
  for (const root of nodes) {
    if (!isSvgRoot(root) || consumed.has(root.id)) continue;
    const memberIds: string[] = [root.id];
    const walk = (pid: string): void => {
      for (const c of byParent.get(pid) ?? []) {
        if (consumed.has(c.id)) continue;
        consumed.add(c.id);
        memberIds.push(c.id);
        walk(c.id);
      }
    };
    walk(root.id);
    consumed.add(root.id);
    merged.push({
      id: root.id,
      side,
      kind: 'svg-root',
      rect: { ...root.rect },
      memberIds,
      nodeKind: root.nodeKind ?? 'visual',
      text: root.text ?? null,
      boxStyle: root.boxStyle ?? {},
      hasChildren: (childCounts.get(root.id) ?? 0) > 0,
      hasBoxPaint: !!(
        root.boxStyle?.backgroundColor || root.boxStyle?.cornerRadius || root.boxStyle?.borderWidth
      ),
    });
  }

  return { merged, consumed };
}

/**
 * 重合归并：父子 + 同父兄弟。
 *
 * ## 为什么父子也要合（而 `stack.ts` 明确只认同父）
 * `stack.ts` 排除父子是**为命中链服务的**（父子在命中链上本来就相邻，
 * Esc / 原地再点已经能上移一层）。但「节点表里父子重复占一行」是**另一个问题**：
 * 实测盲盒那份 71 个父子几何逐位相同（`LinearLayout 360×792 ← DecorView 360×792`、
 * `FrameLayout ← LinearLayout`…），它们在匹配引擎眼里是 71 个独立的「App 多出容器」。
 *
 * ⇒ 视图层合并它们（少 71 行、画布更干净），但**数据层与命中链一律不动**。
 *
 * ## 样式聚合规则（与 `stack.ts` 一致）
 * - **并集**：每个键取「从上到下第一个有值的」
 * - **冲突取上层**：几何完全重合时**看得见的是上层**，取下层会报出屏幕上不存在的数字
 * - **三态保留**：`undefined` = 没读过（键不设），`null` = 读过且为空。
 *   混为一谈会让「这版快照没采集圆角」被读成「确定没有圆角」。
 */
function mergeCoincident(
  nodes: MergeInput[],
  side: 'design' | 'app',
  consumed: Set<string>,
  /** 原始树里「父 id → 子节点数」索引；画布靠 `hasChildren` 区分「结构分组」与「可见盒子」 */
  childCounts: ReadonlyMap<string, number>,
): MergedNode[] {
  const out: MergedNode[] = [];

  const push = (kind: MergeKind, members: MergeInput[]): void => {
    const sorted = [...members].sort((a, b) => a.index - b.index);
    /**
     * 代表节点的选择 —— **不是单纯取上层**。
     *
     * ## 为什么必须优先取「可绘制」的那个
     *
     * 实测（盲盒 729 节点）：横向滚动图标行里，每个图标都有一个
     * **与它几何逐位相同的 `ReactViewGroup` 壳**（dx=dy=0，54 个这种壳）。
     * 壳 `index` 更大（后创建）⇒ 旧的「取上层」规则会把壳选成代表，
     * 而 `nodeKind` 跟着代表走 ⇒ 整簇变成 `container` + 无盒样式
     * ⇒ 画布的 `structured` 档**把整个图标连同壳一起藏掉**。
     *
     * 实测被吞掉的可绘制成员：盲盒 3 个 `FastImageViewWithUrl`、
     * 另两份 3 个 `LinearGradientView` / `DecorView`。
     * 用户看到的现象正是「某些图标有框、某些没有」——
     * 差别不在图标本身，而在**它有没有被包在一个同尺寸的壳里**。
     *
     * ## 规则
     * 1. 先取**可绘制**成员（`nodeKind !== 'container'`）中 index 最大的；
     * 2. 一个都没有 → 退回「上层」（纯容器重合，保持原行为）。
     *
     * ⚠️ 这**不是**「伪装成可绘制」—— 成员一个不少（`memberIds` 仍含壳与图标），
     * 只是让代表节点选得对，这样画布的 kind 过滤才能分清「图标」与「壳」。
     */
    const drawable = sorted.filter((m) => (m.nodeKind ?? 'container') !== 'container');
    const top = drawable.length > 0 ? drawable[drawable.length - 1] : sorted[sorted.length - 1];
    for (const m of sorted) consumed.add(m.id);
    const box = mergeBoxOf(sorted);
    out.push({
      id: top.id,
      side,
      kind,
      rect: { ...top.rect },
      memberIds: sorted.map((m) => m.id),
      nodeKind: top.nodeKind ?? 'container',
      text: top.text ?? sorted.find((m) => m.text)?.text ?? null,
      boxStyle: box,
      // ⚠️ 取**代表节点**的 hasChildren 而不是「成员里任一个有子」——
      // 后者对 SVG 收拢会误判（根 `SvgView` 收了全部内部元素，但自己是叶子）。
      hasChildren: (childCounts.get(top.id) ?? 0) > 0,
      hasBoxPaint: !!(box.backgroundColor || box.cornerRadius || box.borderWidth),
    });
  };

  // ---- 父子重合 ----
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (consumed.has(n.id) || !participates(n)) continue;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    // ⚠️ 父也要过资格 —— 隐藏父下的可见子不该被合进「不可见的父」
    if (parent && participates(parent) && sameRect(parent.rect, n.rect)) {
      push('coincident-parent', [parent, n]);
    }
  }

  // ---- 同父兄弟重合 ----
  // ⚠️⚠️ 这里**不能**把 `parentId === null` 排除掉 —— 根节点（`parentId: null`）
  // 同样有兄弟，而根层恰恰是重合最密集的地方（实测 App 侧 `360×774` 下同时有
  // `RNGestureHandlerRootView` / `ReactViewGroup` 两个同尺寸节点）。
  // 最初写成 `n.parentId === null → continue`，结果整段兄弟归并在测试里完全没生效
  // （sib1/sib2 都拿到单节点簇）—— 而真实数据里它静默少合了几十个。
  //
  // ⇒ 用哨兵键把「null 父」当成一个合法的分组键。
  const ROOT_KEY = '__uii_root__';
  const groups = new Map<string, MergeInput[]>();
  for (const n of nodes) {
    if (consumed.has(n.id) || !participates(n)) continue;
    const key = n.parentId ?? ROOT_KEY;
    const arr = groups.get(key);
    if (arr) arr.push(n);
    else groups.set(key, [n]);
  }
  for (const members of groups.values()) {
    /**
     * 分组直接比较原始输入数值，不用 toFixed 或容差掩盖真实的位置、尺寸差异。
     */
    const byRect: MergeInput[][] = [];
    for (const m of members) {
      const hit = byRect.find((c) => sameRect(c[0].rect, m.rect));
      if (hit) hit.push(m);
      else byRect.push([m]);
    }
    for (const cluster of byRect) {
      if (cluster.length >= 2) push('coincident-sibling', cluster);
    }
  }

  return out;
}

/**
 * 归并主入口 —— 产出视图节点，**数据层不动**。
 *
 * 顺序有讲究：**先 SVG 后重合**。SVG 根与它的内部元素几何逐位相同
 * （`PathView` 常常正好等于父 `SvgView` 的盒子），先做 SVG 归并可以避免
 * 它们再被「父子重合」当成一簇 —— 那会把 `PathView` 单独拉成一个视图节点，
 * 而它本该消失在图标整体里。
 */
export function buildMergedView(
  nodes: MergeInput[],
  side: 'design' | 'app',
): { view: MergedNode[]; stats: MergeStats } {
  /**
   * 「父 id → 子节点数」索引。
   *
   * 画布的「隐藏树中间层」口径需要区分两种容器：纯结构分组（有子节点）
   * 与**真实可见盒子**（叶子，但有背景/边框）。这个信息只在原始树上算得出来 ——
   * 归并之后成员已经被收拢，看不出「谁原来有孩子」。
   *
   * ⚠️ 必须用**全部** nodes 算（不是过滤后的），否则父节点被 SVG 收拢后
   * 它的孩子会被算成孤儿，`hasChildren` 就错了。
   */
  const childCounts = new Map<string, number>();
  for (const n of nodes) {
    if (n.parentId) childCounts.set(n.parentId, (childCounts.get(n.parentId) ?? 0) + 1);
  }

  const svg = mergeSvgRoots(nodes, side, childCounts);
  const consumed = new Set(svg.consumed);
  // 设计侧「视觉单元」归并（2026-10-05）。
  //
  // ⚠️⚠️ 顺序：**必须在 SVG 之后、`mergeCoincident` 之前**。
  //
  // 我第一版放在最后 —— 结果用户报的 `1755:13002`（3 段式背景卡）永远轮不到：
  // 它与父 `13001` **几何逐位相同**（都是 351×64，dx=dy=0），
  // `mergeCoincident` 的 `coincident-parent` 判据先把父子收成一簇，
  // `13002` 进 `consumed` ⇒ 视觉单元归并再看不到它。
  //
  // 放在 `mergeSvgRoots` 之后是为了**不抢** SVG 的成员
  // （设计侧 `svg-root` 恒为 0，但 App 侧有 —— 抢了会破坏那套归并）。
  const visual = mergeVisualUnits(nodes, side, childCounts, consumed);

  const coincident = mergeCoincident(
    nodes.filter((n) => !consumed.has(n.id)),
    side,
    consumed,
    childCounts,
  );

  // 未被归并的节点原样进视图
  const passthrough: MergedNode[] = nodes
    .filter((n) => !consumed.has(n.id))
    .map((n) => ({
      id: n.id,
      side,
      // ⚠️ 必须标 `passthrough` 而不是 `coincident-sibling` ——
      // 「没被归并」与「被归并成兄弟簇」在画布上要画不同的框（见 FrameRaster），
      // 在 byKind 统计里更是两个完全不同的数字。
      kind: 'passthrough' as MergeKind,
      rect: { ...n.rect },
      memberIds: [n.id],
      nodeKind: n.nodeKind ?? 'container',
      text: n.text ?? null,
      boxStyle: n.boxStyle ?? {},
      hasChildren: (childCounts.get(n.id) ?? 0) > 0,
      hasBoxPaint: !!(
        n.boxStyle?.backgroundColor || n.boxStyle?.cornerRadius || n.boxStyle?.borderWidth
      ),
    }));

  const view = [...svg.merged, ...coincident, ...visual, ...passthrough];

  const byKind: Record<MergeKind, number> = {
    'svg-root': svg.merged.length,
    'coincident-parent': coincident.filter((m) => m.kind === 'coincident-parent').length,
    'coincident-sibling': coincident.filter((m) => m.kind === 'coincident-sibling').length,
    passthrough: passthrough.length,
    'visual-group': view.filter((v) => v.kind === 'visual-group').length,
  };

  return {
    view,
    stats: {
      total: nodes.length,
      merged: view.length,
      byKind,
      // ⭐ 归并不许丢 id：所有 memberIds 并起来必须与原始 id 集合完全相等
      idsPreserved: (() => {
        const a = new Set(nodes.map((n) => n.id));
        const b = new Set(view.flatMap((m) => m.memberIds));
        return a.size === b.size && [...a].every((id) => b.has(id));
      })(),
    },
  };
}
