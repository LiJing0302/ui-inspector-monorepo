/**
 * 「设计值 → App 截图物理像素」在**渲染层**的唯一入口：面板的读数与画布的间距读数都从这里取。
 *
 * 用途单一 —— **手动验收时肉眼对照**：UI 同学在 Figma 上写的 16，落到 3x 屏上到底该占
 * 几个物理像素（46 还是 48），以及 App 实际占了多少。以前面板只给「换算回设计基准」的
 * 读数（16.08 这种），那不是真机上存在的数，验收同学要拿它去比对截图只能靠脑补。
 *
 * 出口按「值的形状」分三类，**不可互换**：
 *  - 矩形（节点四边）→ `designPixelEdges` / `appPixelRect`：按**宿主档位**投影
 *    （`presnap`：左 / 宽各自取整；`raw`：四条边各自取整、宽高由边相减。2026-09-29 加）；
 *  - 标量长度（圆角 / 字号 / 描边…）→ `designLengthToAppPixels` / `appLengthToPixels`：单值投影；
 *  - 画布间距读数 → `measureLinesInPixels`：**两侧矩形先按档位投影，再跑同一份 `measureBetween`**
 *    （与矩形同一条纪律。2026-09-30 收紧：此前是「两端各当标量投影一次」，那是 `raw` 档的纪律，
 *    在 `presnap` 宿主上会给出同一屏都加不齐的读数）。
 *
 * ⚠️ **本文件不实现任何缩放公式**：投影走 `@shared/pixelTransform`，与验收判定链
 * （`src/main/acceptance/core.ts`）是同一份实现。这里只做三件事：凑契约的三个输入、
 * 把设计节点喂给投影、把「目标 / 实测 / 差」排成表。自己写一份 `Math.round(x * k)` 就会
 * 出现「面板说 46、报告说 45」这种没人能裁决的分歧。
 *
 * ⚠️ 与 `lib/comparison.ts` 的分工：那边的**判定**走设计单位（App 值已换算回设计基准，
 * 用于判断「一样宽吗」）；这边给的是**物理像素**读数。两套单位不能塞进同一张表的同一列
 * —— 混在一起正是之前 `GroundTruthPairGeometry` 踩过的坑（同一个字段里躺着两种单位）。
 * （2026-09-29 加：像素口径下对比表也换成 px 读数，但**判定仍是那一套**，见
 * `buildCompareFields` 的 `pixel` 参数。）
 */
import type { PixelTransformGeometry } from '@shared/acceptance';
import {
  designToAppPixelScale,
  pixelTransformGeometry,
  projectDesignEdgesByProfile,
  projectDesignValueToAppPixels,
  projectDesignValueToLogical,
  snapPhysical,
  toPixelHostProfile,
  type PixelEdges,
  type PixelHostProfile,
} from '@shared/pixelTransform';
import type {
  AppNode,
  AppNodeCorners,
  AppNodeSides,
  DesignNode,
  PixelRect,
  Rect,
  VerifySource,
} from '@shared/verify';

import type { AppAlignContext } from './comparison';
import { measureBetween, type MeasureAxis, type MeasureLine } from './measure';

/**
 * 本次配对的投影上下文。构造不出来（老快照没有物理像素宽 / 宽度非正）时为 `null`，
 * 面板据此**整块不画** —— 不是画成「—」：那一行会读成「这个节点的物理像素是空的」，
 * 而真相是「这份快照根本没有物理像素这个通道」。
 */
export interface PixelProjection {
  geometry: PixelTransformGeometry;
  /** 设计 px → 物理 px 的总倍率。**只用于写算式**，判定必须走分档投影 */
  scale: number;
  /**
   * 宿主取整档位（2026-09-29 加）。与主进程 `core.ts#transformContext` 同源 ——
   * 面板的「目标像素」与验收报告的几何期望值必须由**同一条算式**得出，否则会出现
   * 「面板说 1010、报告说 1011」这种没法裁决的分歧。
   *
   * 从快照元数据解析（`toPixelHostProfile`），缺省落 `PIXEL_HOST_PROFILE_DEFAULT`。
   */
  hostProfile: PixelHostProfile;
  basisWidth: number;
  viewportWidth: number;
  pixelWidth: number;
  pixelRatio: number;
}

export function pixelProjectionOf(align?: AppAlignContext): PixelProjection | null {
  if (!align) return null;
  const hostProfile = toPixelHostProfile(align.hostProfile);
  // 三个输入与主进程 `core.ts#transformContext` 完全同源：帧宽 / 会话窗口逻辑宽 / 截图物理宽。
  // 会不会算得出来由共享层判（非正数 / 缺项一律 null），这里不另设门槛。
  const geometry = pixelTransformGeometry({
    basisWidth: align.designWidth,
    viewportWidth: align.appWidth,
    pixelWidth: align.pixelWidth ?? NaN,
    hostProfile,
  });
  if (!geometry) return null;
  return {
    geometry,
    scale: designToAppPixelScale(geometry),
    hostProfile,
    basisWidth: geometry.basisWidth,
    viewportWidth: geometry.viewportWidth,
    pixelWidth: geometry.pixelWidth,
    pixelRatio: geometry.pixelRatio,
  };
}

/**
 * 设计节点 → 目标物理像素四边（按 `projection.hostProfile` 分档投影）。
 *
 * `presnap`（默认）：左 / 宽各投影一次，右 = 左 + 宽 —— 与 `screenUtils.w()` 对每个属性
 * 各调一次 `roundToNearestPixel` 的行为逐位一致。`raw`：四条边各自投影、宽高由边相减。
 *
 * 入参只要 `rect`（不是整个 `DesignNode`）：决定结果的只有那个矩形，收窄之后
 * 冒烟可以用 `{ rect }` 直接喂算例，不必造一个假节点（假节点一旦与真类型漂移，
 * 断言验的就成了夹具自己）。
 */
export function designPixelEdges(node: Pick<DesignNode, 'rect'>, projection: PixelProjection): PixelEdges {
  return projectDesignEdgesByProfile(node.rect, projection.geometry, projection.hostProfile);
}

/**
 * 设计**标量长度** → 物理像素（单值投影，**不是**边界投影）。
 *
 * 服务于圆角 / 描边宽度 / 字号 / 行高 / 字距 —— 这些值在几何上没有「两条边」可减，
 * 所以只能走 `projectDesignValueToAppPixels`（乘倍率后吸附）。
 *
 * ⚠️ **两类读数的精度天生不同**，别拿这里的结果去校验矩形：矩形宽高由边界相减推出
 * （`round((x+w)·k) − round(x·k)`），相邻元素的边因此能对齐；标量只能单位值吸附。共享层
 * `designToAppPixelScale` 的警告说的就是这件事（`round(x·k) + round(w·k) ≠ round((x+w)·k)`）。
 * 两者都是共享层的正式出口，面板**不自己乘倍率**。
 */
export function designLengthToAppPixels(value: number, projection: PixelProjection): number {
  return projectDesignValueToAppPixels(value, projection.geometry);
}

/**
 * App 节点实测的物理像素矩形。
 *
 * ⚠️ **只认 SDK 上报的 `pixelRect`**，缺了就返回 `null`。绝不拿逻辑值乘像素比反算：
 * 逻辑值在采集侧已经除过密度（`x / density`），反乘只是把取整误差重新包装成一个
 * 「看起来像实测值」的数 —— 方案 §03 明令禁止，且老快照会因此被伪造成「量到了」。
 */
export function appPixelRect(node: AppNode): PixelRect | null {
  const rect = node.pixelRect;
  if (!rect) return null;
  return rect;
}

/**
 * App **逻辑长度** → 物理像素（× 像素密度后吸附）。
 *
 * 服务于 App 侧的圆角 / 描边宽度 / 字号 / 行高 / 字距 —— 这些在快照里**没有物理像素通道**
 * （`pixelRect` 只覆盖矩形），只能把逻辑值乘回密度。
 *
 * ⚠️ **这是换算，不是实测**，别和 `appPixelRect` 混为一谈：逻辑值在采集侧已经除过密度，
 * 乘回去只是把取整误差重新包装成一个「看起来像量到的」数。所以**矩形一律走 `appPixelRect`**
 * —— 那份缺了就是「未采集」，绝不在这里反算（方案 §03）。
 */
export function appLengthToPixels(value: number, projection: PixelProjection): number {
  return snapPhysical(value * projection.pixelRatio);
}

/**
 * App 侧**四槽 / 四角**（描边宽度、圆角）逐槽乘密度。
 *
 * 存在理由与 `appLengthToPixels` 相同：折叠成一行之前必须先逐槽换算（顺序反过来，折叠串
 * 读出来就是设备原值了）。面板单侧视图与对比表都要它 —— 收在这里一处，组件里不再写 `map`。
 *
 * 三态逐槽透传（`undefined` = 这版快照没这个通道、`null` = 采了且确定没有），别卷进乘法。
 */
export function appSidesToPixels(
  sides: AppNodeSides<number | null> | undefined,
  projection: PixelProjection,
): AppNodeSides<number | null> | undefined {
  if (sides === undefined) return undefined;
  const one = (value: number | null): number | null =>
    typeof value === 'number' ? appLengthToPixels(value, projection) : value;
  return { top: one(sides.top), right: one(sides.right), bottom: one(sides.bottom), left: one(sides.left) };
}

export function appCornersToPixels(
  corners: AppNodeCorners<number | null> | undefined,
  projection: PixelProjection,
): AppNodeCorners<number | null> | undefined {
  if (corners === undefined) return undefined;
  const one = (value: number | null): number | null =>
    typeof value === 'number' ? appLengthToPixels(value, projection) : value;
  return {
    topLeft: one(corners.topLeft),
    topRight: one(corners.topRight),
    bottomRight: one(corners.bottomRight),
    bottomLeft: one(corners.bottomLeft),
  };
}

/**
 * 画布**间距读数** → 截图物理像素（2026-09-29 加；2026-09-30 收紧口径）。
 *
 * 间距是「两条边之间差多少」，所以它跟矩形**必须同一条纪律**：
 * **两侧矩形先按档位投影，再跑同一份 `measureBetween`**，最后只取那个数字。
 *
 * ⚠️ 此前实现是把 `line.from` / `line.to` 当**标量**各投影一次再相减 —— 那是 `raw` 档的纪律。
 * 在 `presnap` 宿主上它会立刻自相矛盾：矩形的右边界是「左 + 宽」算出来的（宿主对每个属性
 * 各调一次 `roundToNearestPixel`），根本没有「右边界」这个量可以去投影 ——
 * 于是同一屏上出现 `A 左 65 + A 宽 467 + 读数 21 = 553 ≠ B 左 552` 这种加不齐的组合。
 * 真实案例（09-30 盲盒抽奖「10年管家开通前」）：设计间距 7，旧口径给 **21**、SDK 实测 **20**，
 * 差的那 1px 全是工具自己的口径差。
 *
 * 分档落点只有一处：设计侧 `projectDesignEdgesByProfile` + App 侧「逻辑值乘密度」。
 * 所以 **`raw` 档与 App 侧与旧实现逐位一致**（旧实现本来就是这个口径），只有
 * 「设计 + `presnap`」会变 —— 正是要修的那一类。
 *
 * 只换 `value`（那个数字），`from` / `to` / `at` / `extensions` **一律原样**：它们是帧内逻辑
 * 坐标，屏幕上画在哪由 `FrameRaster` 的投影决定 —— 在这里按像素改坐标，读数线就会从元素边上
 * 跑开。于是「线还在原地、数字换了尺子」。
 *
 * ⚠️ **两侧都不算实测**：设计侧是投影（这份几何本该落成多少 px），App 侧由设备逻辑值乘密度
 * 换算（间距在快照里没有物理像素通道 —— `pixelRect` 只覆盖矩形）。所以两边都不带
 * 「实测」字样，与 `appPixelRect` 那条路刻意分开。
 */
export function measureLinesInPixels(
  source: VerifySource,
  selected: Rect,
  hovered: Rect,
  projection: PixelProjection,
): MeasureLine[] {
  // 几何（`from` / `to` / `at` / `extensions`）以**帧内逻辑坐标**那一份为权威：线得画在元素边上。
  const lines = measureBetween(selected, hovered);
  if (lines.length === 0) return lines;
  const refs = [...edgeRefsOf(selected, source, projection), ...edgeRefsOf(hovered, source, projection)];
  return lines.map((line) => ({
    ...line,
    // 兜底见 `scalarPixelValue`：像素空间里次序翻转 / 端点对不上边时退回旧口径。
    value: resolveEdgePair(line, refs) ?? scalarPixelValue(source, line, projection),
  }));
}

/** 一条边在**像素空间**里的位置。`side`：`lo` = 左 / 上边，`hi` = 右 / 下边。 */
interface EdgeRef {
  axis: MeasureAxis;
  /** 帧内逻辑坐标 —— 就是 `measureBetween` 出的 `from` / `to` 那个值 */
  value: number;
  /** 该边界在本次截图里占的物理像素位置 */
  px: number;
  side: 'lo' | 'hi';
}

/**
 * 一个矩形在**本次截图的物理像素空间**里的四条边。
 *
 * 设计侧走分档入口 `projectDesignEdgesByProfile` —— 与面板宽 / 高、验收报告的期望值同源；
 * App 侧是逻辑值乘密度：**App 侧没有「档位」**，采集回来的逻辑值本身就是设备吸附后的结果，
 * 「预吸附 / 边界吸附」在那里已不可区分（`pixelRect` 是唯一的实测通道，但间距的两端不一定都采到）。
 */
function projectedEdgesOf(rect: Rect, source: VerifySource, projection: PixelProjection): PixelEdges {
  if (source === 'design') {
    return projectDesignEdgesByProfile(rect, projection.geometry, projection.hostProfile);
  }
  return {
    left: appLengthToPixels(rect.x, projection),
    top: appLengthToPixels(rect.y, projection),
    right: appLengthToPixels(rect.x + rect.width, projection),
    bottom: appLengthToPixels(rect.y + rect.height, projection),
  };
}

function edgeRefsOf(rect: Rect, source: VerifySource, projection: PixelProjection): EdgeRef[] {
  const edges = projectedEdgesOf(rect, source, projection);
  return [
    { axis: 'x', value: rect.x, px: edges.left, side: 'lo' },
    { axis: 'x', value: rect.x + rect.width, px: edges.right, side: 'hi' },
    { axis: 'y', value: rect.y, px: edges.top, side: 'lo' },
    { axis: 'y', value: rect.y + rect.height, px: edges.bottom, side: 'hi' },
  ];
}

/** 逻辑坐标的比较容差。与 `lib/measure#EDGE_EPS` 同量级：远小于任何有意义的长度 */
const EDGE_REF_EPS = 1e-6;

function pickEdge(refs: EdgeRef[], axis: MeasureAxis, value: number, side: EdgeRef['side']): EdgeRef | null {
  return refs.find((ref) => ref.axis === axis && ref.side === side && Math.abs(ref.value - value) <= EDGE_REF_EPS) ?? null;
}

/**
 * 把一条逻辑读数线的两端映射到像素空间的两个投影边，给出像素读数。
 *
 * 端点与边的对应关系由 `measureBetween` 的形状**唯一确定**（见 `lib/measure` 顶部三种情形）：
 *  - **间隙**：`from` 是某一侧的 `hi` 边、`to` 是另一侧的 `lo` 边（源于 `min(hi)` / `max(lo)`）；
 *  - **内边距**：两端**同侧**（外 lo → 内 lo，或 内 hi → 外 hi）。
 *
 * 任一端对不上、或投影后次序翻转（`to.px < from.px`）→ `null`，由调用方退回单值口径。
 * 零距离的边（贴边）不会制造歧义：那种线在 `measureBetween` 里已被 `MIN_MEASURE_GAP` 滤掉。
 */
function resolveEdgePair(line: MeasureLine, refs: EdgeRef[]): number | null {
  const pair = (fromSide: EdgeRef['side'], toSide: EdgeRef['side']): number | null => {
    const from = pickEdge(refs, line.axis, line.from, fromSide);
    const to = pickEdge(refs, line.axis, line.to, toSide);
    if (!from || !to) return null;
    const delta = to.px - from.px;
    return delta >= -EDGE_REF_EPS ? Math.abs(delta) : null;
  };
  return line.kind === 'gap' ? pair('hi', 'lo') : (pair('lo', 'lo') ?? pair('hi', 'hi'));
}

/**
 * 旧的单值口径：两端各投影一次再相减。**只作兜底**，正常路径不再走它。
 *
 * 留着它是为了「宁可差 1px，也不给一个方向都反了的数」：像素空间里包含 / 分离关系偶尔会因
 * 取整翻转（最多 1px 级），那时读数线仍按逻辑几何画在元素边上，数字退回旧口径至少不会自相矛盾。
 */
function scalarPixelValue(source: VerifySource, line: MeasureLine, projection: PixelProjection): number {
  const project =
    source === 'design'
      ? (value: number): number => designLengthToAppPixels(value, projection)
      : (value: number): number => appLengthToPixels(value, projection);
  return Math.abs(project(line.to) - project(line.from));
}

export interface PixelDelta {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `实测 − 目标`，逐项。只给四条能直接对上截图的量（右/下由左+宽推出） */
export function pixelDeltaOf(target: PixelEdges, actual: PixelRect): PixelDelta {
  return {
    left: actual.x - target.left,
    top: actual.y - target.top,
    width: actual.width - (target.right - target.left),
    height: actual.height - (target.bottom - target.top),
  };
}

/** 表格一行：两侧可能只有一侧有值（单侧选中时） */
export interface PixelRow {
  label: string;
  target: number | null;
  actual: number | null;
  /** `实测 − 目标`；两侧缺一时为 null */
  delta: number | null;
}

/**
 * 四行：宽 / 高 / 左 / 上。
 *
 * 为什么就这四个、不出右 / 下：屏幕上「占了多大、从哪开始」由这四个数决定，
 * 右下角是它们的和；验收报告里四条边都在，面板不必再抄一遍（首屏很贵）。
 */
export function pixelRows(target: PixelEdges | null, actual: PixelRect | null): PixelRow[] {
  const t = target
    ? { width: target.right - target.left, height: target.bottom - target.top, left: target.left, top: target.top }
    : null;
  const a = actual ? { width: actual.width, height: actual.height, left: actual.x, top: actual.y } : null;
  const row = (label: string, pick: (v: { width: number; height: number; left: number; top: number }) => number): PixelRow => {
    const tv = t ? pick(t) : null;
    const av = a ? pick(a) : null;
    return { label, target: tv, actual: av, delta: tv !== null && av !== null ? av - tv : null };
  };
  return [
    row('宽', (v) => v.width),
    row('高', (v) => v.height),
    row('左', (v) => v.left),
    row('上', (v) => v.top),
  ];
}

const round2 = (value: number): number => Number(value.toFixed(2));
const round4 = (value: number): number => Number(value.toFixed(4));

/**
 * 「目标像素是怎么来的」—— 面板的 title。
 *
 * 必须把**两步**（先变逻辑、再乘密度吸附）和**总倍率**都写出来：前者是契约的语义
 * （`L = T(d)` → `P = S(L × k)`），后者是 UI 同学在别处见过的那一个数（`w()` 的总倍率）。
 * 只写总倍率会让人以为一次乘法就能得到，而吸附恰恰发生在边界上而不是尺寸上。
 */
export function pixelTargetTitle(rect: Rect, projection: PixelProjection): string {
  const logical = projectDesignValueToLogical(rect.width, projection.geometry);
  const physical = logical * projection.pixelRatio;
  const snapped = snapPhysical(physical);
  const edges = designPixelEdges({ rect }, projection);
  // 第 3 行必须按档位写：`presnap` 下宽是**独立取整**的（宿主对每个属性各调一次
  // `roundToNearestPixel`，属性之间不相互参照），`raw` 下才是「四边各自取整、宽由边相减」。
  // 写成同一句会让读者按另一种口径去反推，而两档能差 1px —— 那正是这轮要消除的困惑。
  const snapLine = projection.hostProfile === 'presnap'
    ? `· 物理 ${round2(logical)} × ${round4(projection.pixelRatio)} = ${round2(physical)} px → 取最近整数 ${snapped} px`
      + '（宿主预吸附：左 / 宽等属性各自吸附，右边界是「左 + 宽」算出来的，不是独立量）'
    : `· 物理 ${round2(logical)} × ${round4(projection.pixelRatio)} = ${round2(physical)} px`
      + '（宿主把裸比例值交给布局，由布局按绝对边界吸附：宽 = 右 − 左）';
  return [
    `目标是「设计值投影到本次截图」的结果（基准宽 ${projection.basisWidth}，物理宽 ${projection.pixelWidth}）`,
    `· 逻辑 ${round2(rect.width)} × ${projection.viewportWidth} / ${projection.basisWidth} = ${round2(logical)} pt`,
    snapLine,
    `· 总倍率 × ${round4(projection.scale)}（= ${projection.pixelWidth} / ${projection.basisWidth}）`,
    `· 宿主档位 ${projection.hostProfile} · 四边 左 ${edges.left} 上 ${edges.top} 右 ${edges.right} 下 ${edges.bottom}`,
  ].join('\n');
}

/** App 侧「实测像素」的来历 */
export const PIXEL_ACTUAL_TITLE =
  '取自快照节点的 pixelRect —— SDK 上报的截图物理像素原值，未除密度，也不做任何舍入。\n'
  + '老快照没有这个字段，那时整块不显示（不会拿逻辑值反算）。';

/**
 * 「设计稿对齐 App」口径下，App 侧矩形**没有** `pixelRect` 时的说明（挂在那些 `—` 上）。
 *
 * 必须解释而不是留白：用户看到四个 `—` 的第一反应是「工具坏了」，而真相是「这份快照没这个
 * 通道」。同理也不能拿逻辑值乘密度顶上 —— 那是方案 §03 明令禁止的反算。
 */
export const PIXEL_RECT_MISSING_TITLE =
  '这个节点没有 pixelRect —— 采集时 SDK 没有上报截图物理像素原值。\n'
  + '逻辑值乘密度反算被明令禁止（会包装出一个「看起来像量到的」数），所以这里留空。\n'
  + '2026-09-29 之前采集的快照都属于这一类，重新采一次即可。';

/**
 * 「设计稿对齐 App」口径下，**设计侧标量长度**的来历（圆角 / 描边宽度 / 字号 / 行高 / 字距）。
 *
 * 与矩形区分开写：矩形是四条边各自投影后相减，标量是单值投影 —— 把两套算式混成一段说明，
 * 读者会以为圆角也是「两条边相减」来的。这里只讲单值那一条。
 */
export function designPixelOrigin(value: number, projection: PixelProjection): string {
  const logical = projectDesignValueToLogical(value, projection.geometry);
  const physical = logical * projection.pixelRatio;
  const snapped = snapPhysical(physical);
  return [
    `设计 ${value} × ${projection.viewportWidth} / ${projection.basisWidth} = ${round2(logical)} pt`,
    `→ × ${round4(projection.pixelRatio)} = ${round2(physical)} px → 取最近整数 ${snapped} px`,
    `· 总倍率 × ${round4(projection.scale)}（= ${projection.pixelWidth} / ${projection.basisWidth}）`,
    '⚠️ 标量没有「两条边」，只能单值投影 —— 与矩形宽高的边界相减差一个取整口径',
  ].join('\n');
}

/**
 * 「设计稿对齐 App」口径下，**App 侧标量长度**的来历。
 *
 * ⚠️ 与 `pixelRect` 区分：那是 SDK 实测原值，这里是逻辑值乘回密度。设备的逻辑值在采集侧
 * 已经除过密度，乘回来只是把取整误差重新包装 —— 所以矩形一律走 `appPixelRect`，不给反算。
 */
export function appPixelOrigin(value: number, projection: PixelProjection): string {
  const raw = value * projection.pixelRatio;
  const snapped = snapPhysical(raw);
  const lines = [`设备值 ${round2(value)} dp × ${round4(projection.pixelRatio)} = ${round2(raw)} px`];
  if (Math.abs(raw - snapped) >= 0.01) lines.push(`→ 取最近整数 ${snapped} px`);
  lines.push('⚠️ 由逻辑值换算得到，不是 SDK 实测 —— 矩形看 pixelRect，不看这里');
  return lines.join('\n');
}

const PIXEL_DELTA_LABEL: Record<keyof PixelDelta, string> = {
  width: '宽',
  height: '高',
  left: '左',
  top: '上',
};

/** 小结里的排列顺序 —— 与表格四行**逐字一致**：小结说「宽 +6」时，表里那一行就在最上面 */
const PIXEL_DELTA_ORDER: Array<keyof PixelDelta> = ['width', 'height', 'left', 'top'];

/**
 * 一句话结论（对照块顶部）：只在两侧都有值时给。
 *
 * 用「哪几项差多少」而不是「IOU / 百分比」：验收同学要的是「差 2px 要不要提工单」，
 * 不是相似度分数。完全一致时给一句明确的「四项一致」，避免读者在表里自己找零。
 *
 * ⚠️ 顺序按 `PIXEL_DELTA_ORDER` 走，**不能**用 `Object.entries(delta)`：那取决于
 * `pixelDeltaOf` 里字面量的书写顺序，往对象里插一个字段就可能换序，小结与表格就对不上了。
 */
export function pixelSummary(target: PixelEdges | null, actual: PixelRect | null): string {
  if (!target || !actual) return '';
  const delta = pixelDeltaOf(target, actual);
  const parts = PIXEL_DELTA_ORDER.filter((key) => delta[key] !== 0)
    .map((key) => `${PIXEL_DELTA_LABEL[key]} ${delta[key] > 0 ? '+' : ''}${delta[key]}`);
  return parts.length === 0 ? '四项一致' : parts.join(' · ');
}
