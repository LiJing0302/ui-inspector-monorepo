/**
 * 画布「间距读数」的几何（纯函数，冒烟直接喂矩形断言，不用起 DOM）。
 *
 * ## 它回答哪个问题
 *
 * **选中一个元素之后，光标移到另一个元素上** —— 这两个之间差多少：横向差多少、纵向差多少。
 * 验收里最高频的动作就是「这两块到底对齐了没有 / 隔了多远」，而画布上肉眼量不出来
 * （一帧 375 逻辑 px 铺在屏幕上，1px 的差在缩放后不足 1 个屏幕像素）。
 *
 * 触发条件刻意是**「有选中 + 另外 hover 一个」**，不是单纯 hover：
 * 光标划过整屏时每一步都弹读数会把画布糊死；而「我已经选中了这个，现在看它和那个的关系」
 * 是一个明确的提问动作 —— 与 Figma 的 measure 同一套心智（那边是按住 ⌥，这里省掉修饰键，
 * 因为本工具里「选中」本身就是个持久状态）。
 *
 * ## 为什么两条轴各出各的，不做成一个「距离」
 *
 * 用户要的是 **x / y 两个方向上的差**，不是欧氏距离：「右下角偏了 3px」这种结论只有
 * 分轴才读得出来（一个 3.6 的对角距离既可能是「x 差 3、y 差 0」，也可能是「x 差 0、y 差 3」，
 * 而这两种的修法完全不同）。所以每个轴独立判定、独立出数。
 *
 * ## 三种情形（判定顺序即语义）
 *
 *  1. **一个完全套在另一个里**（B ⊆ A 或 A ⊆ B）→ 四条**内边距**读数：左右两条量
 *     「外盒的边 → 内盒的边」，上下两条同理。这正是「选中容器、hover 里面的元素」时
 *     唯一想知道的东西（padding / 内边距对不对）。
 *     ⚠️ 这一支必须**排在②之前**：包含关系在两条轴上都算「重叠」，落到②会一条线都画不出来，
 *     用户看到的是「这个功能在某些元素上没反应」。
 *  2. **分离**（该轴的区间不相交）→ 该轴一条**间隙**读数，量两个相向边之间的距离。
 *     这是最常见的一支：上下两块（纵向间隙）、左右两块（横向间隙）。
 *  3. 其余（两轴都重叠、又互不包含 —— 交叉 / 部分重叠）→ **不画**。
 *     「间距 0」与「没有线」是两回事：画一条零长度的线，用户只会去猜那是 0 还是没生效。
 *
 * ## 端点与落位
 *
 * - 间隙线落在**另一条轴的重叠带中线**上 —— 线就摆在两个元素「之间」，一眼看出量的是谁和谁。
 *   两条轴都不重叠时（斜着排）退化成**选中项的边**：两条线在选中项的那个角上相接，
 *   成为 Figma 里那个 L 形。
 * - 内边距线落在**被套住那个元素的中线**上（左右两条用它的竖向中线、上下两条用横向中线），
 *   与 Figma 的 padding 标注同款。
 *
 * ## 端点接不上元素的那一头：虚线延长段
 *
 * 斜着排的时候，间隙线的两端**只有一头贴着元素** —— 落在选中项那个角上的是贴着的那头，
 * 另一头悬在空中：它沿垂直轴的落位取自选中项，而那个坐标在对面元素的区间之外。
 * 悬空的端点读不出「量到哪儿为止」，所以那一头要用一条**垂直于读数线**的虚线接回元素
 * 最近的边（`MeasureExtension`，与 Figma / CAD 的 extension line 同款）：
 * 端点在沿轴方向的坐标就是元素**朝向对方的**那条边，所以虚线必然落在元素的边上（多数时候是角）。
 *
 * 两头都贴住时（垂直轴上两块有重叠 → 落位取的是重叠带中线）**不出**虚线：
 * 「本来就接上了」与「用虚线接上的」必须一眼分得开，否则每条读数都拖两根尾巴。
 *
 * 坐标全部是**帧内逻辑坐标**（与节点 `rect` 同一空间，**未乘** alignScale）：
 * 屏幕换算只有 `FrameRaster` 一处实现，这里再算一遍等于把那套几何实现两遍。
 * 逻辑坐标还有个好处 —— 读数直接就是设计稿 px / App 逻辑 px，不随缩放变。
 *
 * ⚠️ `value` 与几何**可以来自不同单位**（2026-09-29）：读数口径切到「设计稿对齐 App」时，
 * `lib/pixelProjection#measureLinesInPixels` 会把 `value` 换成截图物理像素，而 `from` / `to` /
 * `at` 仍是帧内逻辑坐标（线得画在元素边上）。所以**别把 `value` 反推回坐标**，两者只是恰好
 * 同轴。本文件只出逻辑单位的那一份，单位换算在 `pixelProjection` 一处。
 *
 * 它换算的做法是**把投影后的矩形再喂给本函数调一次**（2026-09-30 起；此前是「两端各当标量
 * 投影一次再相减」）—— 因为 `presnap` 宿主的右边界是「左 + 宽」算出来的，把落单的坐标当标量
 * 投影会得到「同一屏都加不齐」的读数（案例见 `pixelProjection` 那份注释）。所以本函数必须
 * 保持**纯几何**：给了什么矩形就量什么，不做任何单位 / 档位假设。
 *
 * @param selected **当前选中项**（两个入参里唯一有角色之分的地方：上面的落位锚点取自它，
 *   即「读数是从选中项量出去的」）
 * @param hovered 光标当前指向的那个（判「下一击会选中的那个」的结论，见 lib/selection）
 */
import type { Rect } from '@shared/verify';

export type MeasureAxis = 'x' | 'y';

/**
 * 虚线延长段：把读数线**悬空的那一端**接回元素的边上（Figma / CAD 的 extension line）。
 *
 * 它**垂直于**所属的读数线 —— 读数线量横向间隙时，延长段是竖向的一小段，把端点连到
 * 元素的上边或下边；量纵向间隙时反过来。`at` 直接取所属读数线那一端的坐标，
 * 所以两者在端点处严格成直角，不会因为各算一次而错开半个像素。
 *
 * 没有它的时候，斜着排的两个元素会得到「一头挂在元素角上、另一头不知量到哪儿」的线：
 * 悬空那头到底对着元素的哪条边，只能靠猜 —— 而验收里要修的恰好就是那条边。
 */
export interface MeasureExtension {
  /** 线段自身的走向（**垂直于**所属读数线） */
  axis: MeasureAxis;
  /** 沿 axis 的两个端点，**已排序**（from ≤ to）：一端在读数线上、一端落在元素边上 */
  from: number;
  to: number;
  /** 另一轴上的落位：就是所属读数线那一端的坐标 */
  at: number;
}

/** 一条读数线：轴线的一段 + 一个数字 */
export interface MeasureLine {
  /** 量的是哪条轴 */
  axis: MeasureAxis;
  /** 沿轴方向的两个端点，**已排序**（from ≤ to）*/
  from: number;
  to: number;
  /** 垂直于轴的落位（线画在这个坐标上） */
  at: number;
  /** 读数（逻辑 px，恒为正） */
  value: number;
  /**
   * 间隙 / 内边距。只影响样式与排查：内边距**总是四条一起出现**（缺的那条是被
   * `MIN_MEASURE_GAP` 滤掉的零距离边），间隙则最多两条。
   */
  kind: 'gap' | 'inset';
  /**
   * 端点接不回元素时的虚线延长段（0 ~ 2 条，见 `MeasureExtension`）。
   *
   * 内边距**恒为空数组**：它的两端本来就分别落在内盒与外盒的边上，没有悬空的一头。
   * 恒有值（而不是可选）是刻意的 —— 调用方少一层 `?.`，冒烟也能直接数长度。
   */
  extensions: MeasureExtension[];
}

/**
 * 小于它就不出读数。
 *
 * 取 0.5 逻辑 px 的两个理由：① 1× 缩放下它不足 1 个屏幕像素，画出来是一条与相邻描边
 * 重叠的线，看的人分不清那是「间距」还是「边框」；② 这个量级的差在四舍五入后就是 0，
 * 而「0」与「没有线」必须区分开（见文件顶部第③条）。
 */
export const MIN_MEASURE_GAP = 0.5;

/** 一维区间。用命名对象而不是元组：下面每个函数都要读 .lo / .hi，元组下标读不出语义 */
interface Band {
  lo: number;
  hi: number;
}

const bandOf = (start: number, size: number): Band => ({ lo: start, hi: start + size });
const midpointOf = (band: Band): number => (band.lo + band.hi) / 2;
/** 重叠长度（不相交时 ≤ 0，其绝对值没有意义 —— 要「隔多远」用 separationOf） */
const overlapOf = (a: Band, b: Band): number => Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
/** 分离距离（相交时 ≤ 0）。> 0 才是「这两块之间有空隙」 */
const separationOf = (a: Band, b: Band): number => Math.max(a.lo, b.lo) - Math.min(a.hi, b.hi);
const containsBand = (outer: Band, inner: Band): boolean =>
  inner.lo >= outer.lo && inner.hi <= outer.hi;
/** 把值夹进区间。lo > hi 时不返回 NaN —— 退化区间（宽/高为 0 的节点）也要能出数 */
const clampTo = (value: number, band: Band): number =>
  band.lo > band.hi ? band.lo : Math.min(Math.max(value, band.lo), band.hi);

/** 上面那道边界比较的容差（逻辑 px）。取 1e-6：远小于 0.1px 的量级差异 */
const EDGE_EPS = 1e-6;

/**
 * 这个坐标是不是落在元素的区间上（含边界）。
 *
 * 必须**含边界**：选中项那头的端点正好落在它的上边 / 下边（角上），浮点减法之后
 * 可能是 99.99999999999999 —— 用严格不等号就会给一条本来就接上了的端点再补一根
 * 零长度的虚线。
 */
const touchesBand = (value: number, band: Band): boolean =>
  value >= band.lo - EDGE_EPS && value <= band.hi + EDGE_EPS;

/**
 * 端点没贴到元素边上时，补一条虚线延长段；贴上了就返回 null。
 *
 * @param axis 读数线的方向（延长段与它垂直）
 * @param edge 端点沿读数线方向的坐标 —— 元素**朝向对方**的那条边
 * @param perp 元素在垂直轴上的区间（延长段接到它最近的一条边）
 * @param at   读数线在垂直轴上的落位
 */
function extensionAt(
  axis: MeasureAxis,
  edge: number,
  perp: Band,
  at: number,
): MeasureExtension | null {
  if (touchesBand(at, perp)) return null;
  const landing = clampTo(at, perp);
  // 落点与端点贴得比读数阈值还近时不画：那种量级的虚线只是一颗灰点，看着像渲染坏了
  if (Math.abs(landing - at) < MIN_MEASURE_GAP) return null;
  return {
    axis: axis === 'x' ? 'y' : 'x',
    from: Math.min(at, landing),
    to: Math.max(at, landing),
    at: edge,
  };
}

/** 造一条读数线；不足 `MIN_MEASURE_GAP` 时给 null（由调用方滤掉） */
function lineOf(
  axis: MeasureAxis,
  kind: MeasureLine['kind'],
  from: number,
  to: number,
  at: number,
): MeasureLine | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const value = hi - lo;
  return value >= MIN_MEASURE_GAP
    ? { axis, kind, from: lo, to: hi, at, value, extensions: [] }
    : null;
}

/**
 * 一条**间隙**读数：只在两个区间**真的分离**时才出。
 *
 * ⚠️ 闸门必须开在「分离」上，不能只靠 `lineOf` 里的长度检查：两个相向边取
 * `min(hi) / max(lo)` 在**重叠**时会缩成一个正的「并集跨度」（区间相同时甚至等于自身宽度），
 * 长度检查照样通过 —— 于是「上下两块」会凭空多出一条写着宽度的横向读数。
 * 实测踩过：横排两块（0..100 × 0..40 与 108..168 × 0..40）的 y 轴读数会变成 40。
 *
 * 两端各自按「端点有没有贴住元素」决定要不要补虚线延长段，见 `extensionAt`。
 */
function gapLineOf(
  axis: MeasureAxis,
  a: Band,
  b: Band,
  aPerp: Band,
  bPerp: Band,
  at: number,
): MeasureLine | null {
  if (separationOf(a, b) < MIN_MEASURE_GAP) return null;
  const base = lineOf(axis, 'gap', Math.min(a.hi, b.hi), Math.max(a.lo, b.lo), at);
  if (!base) return null;
  // 各自的「朝向对方的那条边」。上面那道闸门保证了两个区间不相交，所以谁在左 / 谁在上
  // 无歧义，比较 lo 就够了。
  const aEdge = a.lo > b.lo ? a.lo : a.hi;
  const bEdge = b.lo > a.lo ? b.lo : b.hi;
  return {
    ...base,
    extensions: compact([
      extensionAt(axis, aEdge, aPerp, at),
      extensionAt(axis, bEdge, bPerp, at),
    ]),
  };
}

/**
 * 滤掉 null。**必须是泛型**：它同时服务两种元素 —— 读数线（`insetsOf`）与
 * 虚线延长段（`gapLineOf` 的 `extensions`）。写死成 `MeasureLine` 时，后者的
 * `MeasureExtension | null` 传不进来，`extensions` 那两行会报 TS2322。
 */
const compact = <T>(lines: Array<T | null>): T[] =>
  lines.filter((line): line is T => line !== null);

/** 四条内边距：外盒的每条边 → 内盒的对应边 */
function insetsOf(outer: { x: Band; y: Band }, inner: { x: Band; y: Band }): MeasureLine[] {
  return compact([
    // 左右两条摆在**内盒的竖向中线**上，上下两条摆在横向中线上 ——
    // 摆在正中而不是贴边，是为了让四条读数各自清楚（贴边会两两挤在角上）。
    lineOf('x', 'inset', outer.x.lo, inner.x.lo, midpointOf(inner.y)),
    lineOf('x', 'inset', inner.x.hi, outer.x.hi, midpointOf(inner.y)),
    lineOf('y', 'inset', outer.y.lo, inner.y.lo, midpointOf(inner.x)),
    lineOf('y', 'inset', inner.y.hi, outer.y.hi, midpointOf(inner.x)),
  ]);
}

export function measureBetween(selected: Rect, hovered: Rect): MeasureLine[] {
  const ax = bandOf(selected.x, selected.width);
  const ay = bandOf(selected.y, selected.height);
  const bx = bandOf(hovered.x, hovered.width);
  const by = bandOf(hovered.y, hovered.height);

  // ① 包含关系。谁套住谁不影响算法，里外互换即可 —— 于是不必区分「选中是容器还是子元素」。
  if (containsBand(ax, bx) && containsBand(ay, by)) {
    return insetsOf({ x: ax, y: ay }, { x: bx, y: by });
  }
  if (containsBand(bx, ax) && containsBand(by, ay)) {
    return insetsOf({ x: bx, y: by }, { x: ax, y: ay });
  }

  // ② 分离：两条轴各自独立（只重叠一条轴时，另一条照旧出数 —— 上下排列的两块
  //    在竖向必有空隙、横向多半重叠，那是「纵向间距 12」而不是「什么都没有」）。
  const overlapY = overlapOf(ay, by);
  const overlapX = overlapOf(ax, bx);

  return compact([
    gapLineOf(
      'x',
      ax,
      bx,
      ay,
      by,
      // 竖向有重叠 → 线落在重叠带中线（两块之间）；没有重叠 → 落在选中项的边上，
      // 与竖线在选中项的那个角相接（斜着排时的 L 形），另一端由虚线延长段接回对面元素。
      overlapY > 0
        ? midpointOf({ lo: Math.max(ay.lo, by.lo), hi: Math.min(ay.hi, by.hi) })
        : clampTo(midpointOf(by), ay),
    ),
    gapLineOf(
      'y',
      ay,
      by,
      ax,
      bx,
      overlapX > 0
        ? midpointOf({ lo: Math.max(ax.lo, bx.lo), hi: Math.min(ax.hi, bx.hi) })
        : clampTo(midpointOf(bx), ax),
    ),
  ]);
}

/**
 * 读数 → 文本。
 *
 * 整数就写整数（逻辑 px 是实数，`12.000000000000002` 这种浮点尾巴必须收掉）；
 * 否则保留 1 位小数 —— 亚像素对齐确实存在，把它四舍五入掉会让「差 0.5」看起来像「已经对齐」。
 */
export function formatMeasure(value: number): string {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 0.05 ? String(rounded) : value.toFixed(1);
}
