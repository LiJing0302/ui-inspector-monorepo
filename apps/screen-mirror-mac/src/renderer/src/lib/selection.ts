/**
 * 画布选中的规则（纯函数，冒烟测试直接喂数组断言，不用起 DOM）。
 *
 * ## 方向：**点哪选哪**
 *
 * 命中测试是浏览器做的：光标落在**最上面的、且 `hittable` 为真的那个节点盒**上
 * （`RenderNode.hittable` —— 隐藏图层与「填充被显式隐藏」的图层不参与，其余一律按盒命中，
 * **包括画不出像素的 Frame / Group**）。而节点层是**嵌套 DOM**（父盒包着子盒、子盒画在
 * 父盒之上），于是**被后代盖住的那部分仍然只能点到后代**：父级只剩「子级没盖住的空隙」
 * 可点。在真实样本上逐像素量过（375×867 的一帧、310 个节点）：最外层 Frame 只有
 * **6%** 的像素能直接点到，其余全被后代占着。
 *
 * ⚠️ 别把「父级点不到」再归因到 pointer-events 上。无填充容器曾经完全不参与命中
 * （照抄 Figma「只对有像素的区域命中」），2026-09-16 用户明确要求「无填充的 frame 元素
 * 也要能 hover 和点击选中」之后已改为**按盒命中**（细则与实测数据见 `RenderNode.hittable`）。
 * 现在点不到的只剩「被子级盖住的那一块」—— 那是「点哪选哪」的应有之义，不是缺陷。
 *
 * 上一版照抄了 Figma 的「当前上下文层」模型：**单击选当前上下文层的最外层**
 * （官方原话 "we'll select the parent by default"），默认上下文是顶层 —— 于是
 * **单击永远落在最外层的帧根上**，想进内部只能「原地重复点击逐级进入」（链长 N 就点 N 次）
 * 或 ⌘ 直选。规则本身没错（Figma 确实如此），**但这个工具里它错了两次**：
 * 用户先后两次报「某些节点 hover 和点击都选不中」，第一次是 Union 节点、这次是
 * 「都只能选中最外层的根节点」。两次的归因都一样：**不是 pointer-events，是方向**。
 *
 * 差别在使用场景：Figma 是**设计**工具，操作对象通常是容器（移动 / 改尺寸 / 换布局），
 * 「先选父级」是省事；而这里是**验收**工具，动作永远是「我指着这个元素，看它的字段、
 * 跟对侧比」—— 指针底下那个就是想要的那个。
 *
 * 所以参照物换成 **Chrome DevTools 的元素检查器**：单击 = 指针底下那个元素；
 * **在原地再点一次 = 选它的父级**（就是 DevTools 的 "click again to select the parent"）。
 * 验收时最该被反复看的是叶子（一行文字、一个图标），而「往上退一步」必须是不用瞄准的。
 *
 * ## 四个手势
 *
 *   - **单击** → 选中**命中本身**（最深可命中节点）。
 *   - **原地再点**（同一个命中 + 落点几乎没动）→ **上移一层**（选中父级）；最外层再点一次
 *     就**回绕到命中本身**。这条「原地循环」把整条链变得可点 —— 不管父级有没有像素。
 *   - **⌘/Ctrl + 单击** → 一步跳到**最外层容器**（整帧）。「看整页」这个动作需要一次点击。
 *   - **Esc / Enter** → 上一层 / 下一层，见 `parentContextOf` / `descendInto`。
 *
 * 中间容器不靠单击（单击只给最深的那个）：图层列表、信息面板面包屑、原地再点、Esc
 * 都能到，且都不需要像素级精确。
 *
 * ## hover 走**同一个判定**（`planCanvasHover`）
 *
 * hover 环画的**不是**「光标底下那个」。那只是命中最深的一个，而父级恰恰永远不是它：
 * 嵌套 DOM 里父盒在子盒下面，被后代盖住的部分永远轮不到父级。用户的原话是
 * 「**13531 / 13533 / 13532 无法通过 hover 选中，只能选到子节点 13534 / 13535**」——
 * 他随后用「原地再点」爬到了父级，但爬的过程里环一直停在子节点上，等于闭着眼睛点：
 * **点得到的层级和 hover 得到的层级不是同一个集合**。
 *
 * 所以 hover 与单击**共用同一个函数**：环 = **下一击会选中的那个**。原地再点把档位上移
 * 一层之后，环跟着上移到父级。于是「能点到的层级」与「能 hover 到的层级」恒等 ——
 * 这不是约定，是同一个函数的两处调用。
 *
 * 代价是「环会自己动」：单击之后环跳到父级，鼠标再动超过 `CLICK_REPEAT_RADIUS` 就落回
 * 最深那个。这是**如实的预告**（下一击确实会选它），不是抖动。反过来说，任何「hover
 * 自己一套规则」的写法迟早会长成「环画在 A、点下去选中 B」，或者长成「这个图层 hover
 * 不到、却能点到」—— 上一版正是后者。
 *
 * ## 「当前上下文层」是**算出来的**，不是存下来的
 *
 * 上下文 = 选中项的父级（`parentContextOf`）。这不是巧合，而是上面每个手势的共同结果：
 * 每个手势都只是「选中某个节点」，上下文是选中项的函数。
 *
 * 于是组件里**不存上下文**，只存选中项 —— 两份状态迟早有一天会互相矛盾
 * （上一版就出现过「环画在 A、点下去选中 B」）。这条不变量在这里是**结构性**成立的，
 * 不依赖任何一处记得去维护它。
 */

/** 点击落点（屏幕坐标，用 clientX / clientY —— 与缩放平移无关，天然可比） */
export interface PickPoint {
  x: number;
  y: number;
}

/** 规则只需要知道「谁是父级」；RenderNode / DesignNode / AppNode 都满足这个形状 */
export interface ParentLink {
  parentId: string | null;
}

export type NodeIndex = ReadonlyMap<string, ParentLink>;

/**
 * 一次点击留下的痕迹，供下一次判断「是不是在原地重复点同一个东西」。
 *
 * `hitId` 与 `selectedId` 必须分开存：命中永远是**最深**的那个（浏览器的结论），
 * 而选中的是**当前这一击的结果**。原地再点时两者会分叉（第一击两者相同，第二击
 * 命中不变而选中上移了一层），所以判「还是不是原地」要用 hitId，
 * 判「上一击选中的是谁、还在不在链上」要用 selectedId。
 */
export interface ClickCycle {
  /** 本次点击**光标下最深**的节点 id */
  hitId: string;
  /** 本次点击**实际选中**的节点 id */
  selectedId: string;
  x: number;
  y: number;
}

/**
 * 一次画布判定的输入。**单击与 hover 用的是同一个结构** —— hover 只是不消费结果里的
 * cycle（见 `planCanvasHover`）。两者共用它，是「环 = 下一击会选中的那个」的实现方式。
 */
export interface CanvasClick {
  /** 命中点往上走到根的 id 数组，**最深 → 最外层**（含命中点自身） */
  chain: readonly string[];
  /** 判定**之前**该帧选中的节点 id（null = 没选中 / 选中项在另一侧）。用来判断「选中项被别处改过没有」 */
  selectedId: string | null;
  /** 落点（屏幕坐标）：单击是 `event.clientX/Y`，hover 是当前光标位置 —— 判「原地」要用它 */
  point: PickPoint;
  prev: ClickCycle | null;
  /** 按住了 ⌘/Ctrl = 跳到最外层容器 */
  outermost: boolean;
}

/** 一次点击的判定结果：选中谁 + 留下什么痕迹给下一次 */
export interface ClickOutcome {
  selectedId: string;
  cycle: ClickCycle;
}

/**
 * 两次点击落在这个半径内就算「原地」。
 * 手抖 2~3px 不该被当成「换了目标重新开始」，取 4 够宽容；再大就会把
 * 「点在同一个图标的不同部位」误判成重复点击。
 */
export const CLICK_REPEAT_RADIUS = 4;

const parentOf = (index: NodeIndex, id: string): string | null => index.get(id)?.parentId ?? null;

/**
 * 从某个节点往上走到根，返回 **最深 → 最外层** 的 id 数组（含自身）。
 *
 * 只收录**真实存在**的节点：`parentId` 指向一个不存在的 id 时就地截断
 * （与 `buildNodeTree` 的「视为根」一致）。不截断的话那个幽灵 id 会留在链上，
 * 表现成「点了半天选不中」—— 上下文落到幽灵 id 上时，谁都匹配不上。
 *
 * 另外带 seen 集合防环：脏导出（a 的父是 b、b 的父是 a）在这里只该少走几步，
 * 不该把渲染线程挂死。
 */
export function ancestorChain(index: NodeIndex, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;

  while (current && !seen.has(current)) {
    const node = index.get(current);
    if (!node) break;
    seen.add(current);
    chain.push(current);
    current = node.parentId;
  }

  return chain;
}

/**
 * 选中某个节点之后，「当前上下文层」是它的**父级**。
 *
 * 两个地方要用同一个答案：信息面板的面包屑（标出「你在这一层」）、Esc（往上一层）。
 * 它是从选中项**算出来**的 —— 组件里不存上下文，见文件顶部。
 *
 * ⚠️ 只认**真实存在**的父级：`parentId` 指向缺失 id 时给 null（与 `ancestorChain`
 * 的就地截断一致）。否则「点了半天选不中」会以另一种形式长回来 —— 上下文指向一个
 * 不存在的节点，面包屑里没有任何一格能对上。
 */
export function parentContextOf(index: NodeIndex, id: string): string | null {
  const parent = parentOf(index, id);
  return parent !== null && index.has(parent) ? parent : null;
}

/**
 * 一次画布单击的完整判定：普通单击 / 原地再点 / ⌘ 直选三条分支都在这里。
 *
 * 普通单击**不看上下文**（按「点哪选哪」）—— 这正是上一版那个「单击永远落到帧根」
 * 的病根：上一版的解析器只回答「当前上下文层的最外层是谁」，而默认上下文就是顶层。
 *
 * 也不需要节点索引：层级关系全在 `chain` 里（调用方用 `ancestorChain` 构造），
 * 这个函数只做「在链上取哪一个」这一件事。
 *
 * 返回 `null` 只在链为空时发生（调用方保持现状即可）—— 返回一个兜底 id 更危险，
 * 会把选中态指到一个不存在的节点上。
 */
export function planCanvasClick(input: CanvasClick): ClickOutcome | null {
  const { chain, selectedId, point, prev, outermost } = input;
  if (chain.length === 0) return null;

  const hitId = chain[0];
  const snap = (next: string): ClickOutcome => ({
    selectedId: next,
    cycle: { hitId, selectedId: next, x: point.x, y: point.y },
  });

  // ① ⌘/Ctrl + 单击 → 一步跳到最外层容器（整帧）。
  //    「点哪选哪」之后这是唯一需要「反着来」的动作：从某个深节点出发看整页。
  //    最外层 = 链的最后一个；父级已被 ancestorChain 截掉，所以它通常就是帧根。
  if (outermost) return snap(chain[chain.length - 1]);

  // ② 原地重复点击 = 上移一层（Chrome DevTools 的 "click again to select the parent"）。
  //    判据是「命中元素不变 + 落点没怎么动 + 选中项没被别处（图层列表 / Esc）改过」，
  //    而不是 `event.detail`（浏览器按双击间隔计数：双击会给 2，本该是「手快点了两下」
  //    却被当成「想进入」）。
  const repeat =
    prev !== null &&
    prev.hitId === hitId &&
    prev.selectedId === selectedId &&
    Math.hypot(point.x - prev.x, point.y - prev.y) <= CLICK_REPEAT_RADIUS;

  if (repeat) {
    const at = chain.indexOf(prev.selectedId);
    // 上一击选中的节点必须还在**这一条**链上才谈得上「再上一层」：
    // 它可能已经被别的入口换成链外的节点 —— 这时落到 ③，按普通一击处理。
    //
    // 已在最外层就**回绕到命中本身**（继续下一圈）。不回绕的话，刚 ⌘ 跳到整帧的人
    // 在原地再点时什么都看不到，只会以为点击失灵 —— 每一击都必须有可见的变化。
    if (at >= 0) return snap(chain[(at + 1) % chain.length]);
  }

  // ③ 普通单击 → 选中**命中本身**（最深可命中节点）。
  return snap(hitId);
}

/**
 * 一次 **hover** 的判定：环该画在谁身上 = **下一击会选中的那个**。
 *
 * 它不自己算，而是**直接复用** `planCanvasClick` —— 这是全文件唯一一条关于 hover 的
 * 规则。所以「能 hover 到的层级」与「能点到的层级」是同一个集合，且「环画在 A、点下去
 * 选中 B」在实现上不可能发生（同一个函数、同一份输入，不可能给出两个答案）。
 *
 * 为什么需要它（用户报的第二个 bug）：「13531 / 13533 / 13532 无法通过 hover 选中，
 * 只能选到子节点 13534 / 13535」。原因是 hover 当时直接拿**原始命中**当目标，而原始
 * 命中永远是命中最深的那一个 —— 父级恰恰永远不是它（被后代盖住的部分轮不到父级）。
 * 于是「原地再点」爬到父级的过程中，环始终停在子节点上：点得到、却看不见。
 *
 * 返回 `null` 只在链为空（没命中任何节点）时发生 —— 调用方清空 hover 即可。
 */
export function planCanvasHover(input: CanvasClick): string | null {
  return planCanvasClick(input)?.selectedId ?? null;
}

/**
 * Enter：进入某个节点，选中它的第一个子节点。
 *
 * 候选顺序由**调用方**给定（`childIds` 已经是排好序的）—— 纯函数只负责
 * 「取第一个真实存在的」，不猜画布上的可见性。
 * 没有子节点时返回 `null`（无可进入）。
 */
export function descendInto(
  index: NodeIndex,
  childIds: readonly string[],
): string | null {
  return childIds.find((id) => index.has(id)) ?? null;
}
