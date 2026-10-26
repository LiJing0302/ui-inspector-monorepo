/**
 * Legacy design-basis comparison and projection helpers, retained for replay compatibility.
 * Manual acceptance now uses manualAcceptance.ts: original design → declared device target → runtime facts.
 * The legacy 0.5 tolerance and whole-page width conversion below must not be used for manual verdicts.
 */
import type { AppNode, AppNodeCorners, AppNodeSides, AppNodeGradient, DesignNode } from '@shared/verify';
import {
  appBorderChannel,
  appColorToCss,
  appCornerChannel,
  designNodeFontStyle,
  formatAppCorners,
  formatAppEdgeColors,
  formatAppSides,
} from '@shared/verify';
import type { FigmaPaint } from '@shared/figma';
import type { PixelHostProfile } from '@shared/pixelTransform';
import type { AcceptanceContext } from '@ui-inspector/protocol';

// 像素口径（「设计稿对齐 App」）下对比表的**显示**换算。判定仍走设计单位，见 `buildCompareFields`。
// ⚠️ 与 `pixelProjection.ts` 是单向依赖（那边只 `import type` 本文件的 `AppAlignContext`），
// 不存在运行时循环。
import {
  appCornersToPixels,
  appLengthToPixels,
  appPixelOrigin,
  appSidesToPixels,
  designLengthToAppPixels,
  designPixelEdges,
  designPixelOrigin,
  pixelTargetTitle,
  type PixelProjection,
} from './pixelProjection';

/**
 * 设计稿 vs App 的**字段对齐表**：把两侧的值整理成可逐行对照的字段清单。
 *
 * 这里全是纯函数（无 React、无 DOM），所以能直接被冒烟脚本 import 测行为 ——
 * 与 `lib/stack.ts` 同一个理由。组件 `NodeInfoPanel` 只负责把它渲染出来。
 *
 * ⚠️ **本模块最重要的约束是「口径」**：App 侧的长度读数必须先用
 * `scale = design.width / app.width` 换算进设计稿基准，再与设计稿比。这个系数与
 * 画布上截图的对齐缩放（`CanvasBoard#appAlignScale`）、匹配引擎的
 * （`main/acceptance/core.ts#transformAppRect`）是**同一个数**。
 *
 * 2026-09-28 之前这里漏了这一步：面板拿设备原值裸比，iPhone 402pt 配 375 设计稿时
 * 尺寸类字段平均差 3.92pt（换算后 0.50pt）—— 画布明明是对齐的，面板却一片「不同」。
 * 判定同时从「key 字符串严格相等」改成「长度类走 ±0.5 容差、其余仍严格」，
 * 因为像素吸附（3x 屏 `w(8)` = 26/3 = 8.67）永远消不干净。
 */

/** 填充类型的显示名。组件（`PaintRow`）与对比表共用，别各写一份。 */
export const paintLabel = (paint: FigmaPaint): string => {
  if (paint.type === 'SOLID') return '纯色';
  if (paint.type === 'IMAGE') return '图片填充';
  if (paint.type === 'GRADIENT_LINEAR') return '线性渐变';
  if (paint.type === 'GRADIENT_RADIAL') return '径向渐变';
  return paint.type;
};

/**
 * 面向验收同学的数值一律折到 2 位小数。
 *
 * 起因（2026-09-28）：App 侧原生值经 RN 的 **float32** 传上来，3x 屏下 `26 / 3` 的圆角
 * 读成 `8.666666984558105`；设计稿侧同一条圆角若也跟着带小数尾巴，两边字符串一比就是
 * 「不一致」—— 一个纯由浮点精度造出来的假红。与 `@shared/verify` 的 `foldUniformSides`
 * 用同一个口径（面板正文与对比表本来就是同一批值）。
 */
const round2 = (value: number): number => Number(value.toFixed(2));
const round3 = (value: number): number => Number(value.toFixed(3));

/** 系数本身留 4 位：`0.9328` 折成 2 位会变 `0.93`，读者拿它反算对不回原值 */
const round4 = (value: number): number => Number(value.toFixed(4));

/** Figma 的圆角可以是四角数组（左上/右上/右下/左下）或单值。面板正文与对比表共用。 */
export const cornerRadiusLabel = (value: DesignNode['cornerRadius']): string | number | null =>
  Array.isArray(value)
    ? value.map(round2).join(' / ')
    : value === undefined || value === null
      ? null
      : round2(value);

export type CompareValue = {
  text: string;
  key: string;
  color?: string;
  state: 'value' | 'empty' | 'unavailable';
  /**
   * 可比较的数值序列（**长度类字段专用**，2026-09-28 加）。
   *
   * 为什么不能只靠 `key`：Key 是字符串严格相等，而 App 侧的「同一份设计值」会被宿主的
   * `w()` 吸附到物理像素网格（3x 屏下 `w(8)` = `26/3` = 8.67，缩回设计稿基准是 8.09），
   * 与设计稿的 `8` 永远差一点点。有 `numbers` 时判定走容差（见 `sameCompareValue`），
   * 没有时（颜色、文本、字体名这类）仍走 `key` 严格相等。
   *
   * 槽位约定：尺寸类字段 1 个（宽度 / 高度 / 字号 / 行高 / 字距），四边类字段 4 个
   * （圆角按 左上/右上/右下/左下，描边宽度按 上/右/下/左），与 `AppNodeSides` /
   * `AppNodeCorners` 的顺序一致。
   */
  numbers?: number[];
  /**
   * 这个 App 读数**是怎么来的**（多行文本，供面板做 `title`；2026-09-28 加）。
   *
   * 存在的理由：面板显示的是换算值（8.08），而它和设计稿的 8 之间隔着「等比缩放 + 物理像素
   * 吸附」两步 —— 不写出来，验收同学只会把它读成「开发把圆角做错了」。生成逻辑只有
   * `appLengthOrigin` 一份，单侧视图与对比表都用它，免得同一行 hover 出两套说法。
   */
  origin?: string;
};

export interface CompareField {
  group: string;
  label: string;
  design: CompareValue;
  app: CompareValue;
  comparable?: boolean;
  statusLabel?: string;
}

/**
 * 长度类字段的判定容差（pt / dp）。
 *
 * 取 0.5：像素吸附在 3x 屏上是 ±1/3 ≈ 0.33pt，`sp()` 里还多一层 `Math.round`（±0.5），
 * 两者叠加后正常误差落在 0.5 以内；而真实的尺寸改动（设计 8 → 实现 12）远大于这个量级，
 * 不会被吞掉。**单样本调参禁止**，改这里必须先跑 `replay:gt` 看有没有把真差异放过。
 */
const LENGTH_TOLERANCE = 0.5;

const compareValue = (value: unknown, color?: string, numbers?: number[]): CompareValue => {
  if (value === undefined) return { text: '未采集', key: '', state: 'unavailable' };
  if (value === null || value === '') return { text: '—', key: '', state: 'empty' };
  const text = String(value);
  return { text, key: text.trim().toLowerCase(), color, state: 'value', numbers };
};

/**
 * App 侧颜色字段的对比值：**判定前先归一化字节序**。
 *
 * ⚠️ 不归一化会**恒判红**：`sameCompareValue` 走 `key` 严格相等，而 App 侧 8 位 hex 是
 * ARGB（`#8a000000` = 黑 54%）、设计侧是 Figma 的 RGBA（`#0000008a` 才是同一个色）。
 * 同一个颜色两侧字面量永不相等 ⇒ 对比表把一致报成「不同」，且**无法用容差糊过去**
 * （这是字符串比对，不是数值）。
 *
 * 文本与色块都用归一化后的值：色块要能被 CSS 正确渲染（见 `ColorRow` 的注释），
 * 文本要让两列读起来是同一个色。**原值仍在 `nodes.json` 里**，这里只影响呈现与判定。
 */
const appColorValue = (value: string | null | undefined): CompareValue => {
  const css = appColorToCss(value);
  if (css === undefined) return compareValue(undefined);
  if (css === null || css === '') return compareValue(null);
  return compareValue(css, css);
};

const appGradientValue = (gradient: AppNodeGradient | null | undefined, expectedAngle?: number): CompareValue => {
  if (gradient === undefined) return compareValue(undefined);
  if (!gradient || !Array.isArray(gradient.colors) || gradient.colors.length < 2) return compareValue(null);
  const colors = gradient.colors.map((color) => appColorToCss(color) ?? color);
  const rawAngle = gradient.useAngle && typeof gradient.angle === 'number'
    ? gradient.angle
    : gradient.startPoint && gradient.endPoint
      ? (Math.atan2(gradient.endPoint.y - gradient.startPoint.y, gradient.endPoint.x - gradient.startPoint.x) * 180 / Math.PI + 360) % 360
      : undefined;
  const effectiveAngle = typeof rawAngle === 'number' ? (Math.round(rawAngle) === 360 ? 0 : rawAngle) : undefined;
  const angle = typeof effectiveAngle === 'number' ? ` · ${Math.round(effectiveAngle)}°` : '';
  const text = `线性渐变 ${colors.join(' → ')}${angle}`;
  const locations = gradient.locations && gradient.locations.length === colors.length
    ? gradient.locations
    : colors.map((_, index) => colors.length === 1 ? 0 : index / (colors.length - 1));
  const key = JSON.stringify({
    // Match paintValue's design-side key shape. Figma currently exposes stops + angle;
    // native start/end metadata remains available for inspection but must not create a
    // false diff merely because one side has a richer representation.
    type: 'GRADIENT_LINEAR',
    stops: colors.map((color, index) => ({ color: color.toLowerCase(), position: Number(locations[index]!.toFixed(3)) })),
    angle: expectedAngle === undefined || effectiveAngle === undefined ? undefined : Math.round(effectiveAngle),
  });
  return { text, key, color: colors[0], state: 'value' };
};

/**
 * 描边色四边的归一化：`formatAppEdgeColors` 把四边拼成 `a / b / c / d`，而归一化的
 * 判据是「整串就是一个 8 位 hex」⇒ **整串丢给 `appColorToCss` 等于没转**。
 * 这里按 ` / ` 拆开逐边转再拼回去；缺值那档是 `—`（`formatAppEdgeColors` 的约定），
 * 不是 hex，拆分后原样带走。
 *
 * ⚠️ 分隔符必须与 `formatAppEdgeColors` 一致（它就是用 `' / '` 拼的）。改那边就得改这边 ——
 * 这是同一份约定的两个引用点，不是一处写死一处跟随。
 */
function normalizeEdgeLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  return label.split(' / ').map((part) => appColorToCss(part) ?? part).join(' / ');
}

/**
 * 两个值是否算「一致」：有数值序列的走容差逐位比，否则退回 `key` 严格相等。
 *
 * 序列长度不等直接判不同（说明两侧槽位对不上，属实现问题，宁可报出来）。
 */
export const sameCompareValue = (design: CompareValue, app: CompareValue): boolean => {
  if (design.numbers && app.numbers) {
    if (design.numbers.length !== app.numbers.length) return false;
    return design.numbers.every((value, index) => Math.abs(value - app.numbers![index]) <= LENGTH_TOLERANCE);
  }
  return design.key === app.key;
};

const paintValue = (paints?: FigmaPaint[]): CompareValue => {
  if (!paints) return compareValue(undefined);
  const visible = paints.filter((paint) => paint.visible !== false);
  if (visible.length === 0) return compareValue(null);
  const text = visible.map((paint) => {
    const value = paint.color ?? paint.gradientStops?.map((stop) => stop.color).join(' → ') ?? paint.type;
    const angle = paint.gradientAngle === undefined ? '' : ` · ${Math.round(paint.gradientAngle)}°`;
    return `${paintLabel(paint)} ${value}${angle}`;
  }).join(' / ');
  const key = visible.length === 1 && visible[0]?.type === 'SOLID' && visible[0].color && (visible[0].opacity === undefined || visible[0].opacity === 1)
    ? visible[0].color.toLowerCase()
    : visible.map((paint) => JSON.stringify({
    type: paint.type,
    color: paint.color?.toLowerCase(),
    stops: paint.gradientStops?.map((stop) => ({ color: stop.color.toLowerCase(), position: round3(stop.position) })),
    angle: paint.gradientAngle === undefined ? undefined : Math.round(paint.gradientAngle),
    })).join('|');
  return { text, key, color: visible.length === 1 ? visible[0]?.color ?? visible[0]?.gradientStops?.[0]?.color : undefined, state: 'value' };
};

/**
 * 把 App 侧长度值换算进**设计稿基准**（× `design.width / app.width`）。
 *
 * 与 `main/acceptance/core.ts#transformAppRect`、`CanvasBoard#appAlignScale` 是同一个换算式 ——
 * 画布上截图被缩到与设计稿同宽，面板里的长度读数就必须用同一把尺子，否则「看到的」和
 * 「读到的」会打架。2026-09-28 修：面板此前拿设备原值裸比，iOS 402pt 配 375 设计稿时
 * 尺寸类字段平均差 **3.92pt**（换算后 0.50pt），几乎全判「不同」—— 一片系统性假红。
 *
 * ⚠️ **三态原样保留**：`undefined` = 没采集、`null` = 读了且确定没有，都不参与换算，
 * 别把它们卷进 `value * scale` 变成 `NaN`。
 */
const scaleLength = <T extends number | null | undefined>(value: T, scale: number): T =>
  (typeof value === 'number' ? value * scale : value) as T;

/** 四边同款换算（描边宽度）。`undefined` = 整组没读，保持 `undefined`。 */
const scaleSides = (
  sides: AppNodeSides<number | null> | undefined,
  scale: number,
): AppNodeSides<number | null> | undefined =>
  sides === undefined
    ? undefined
    : {
        top: scaleLength(sides.top, scale),
        right: scaleLength(sides.right, scale),
        bottom: scaleLength(sides.bottom, scale),
        left: scaleLength(sides.left, scale),
      };

/** 四角同款换算（圆角）。顺序与 SDK 一致：左上 / 右上 / 右下 / 左下。 */
const scaleCorners = (
  corners: AppNodeCorners<number | null> | undefined,
  scale: number,
): AppNodeCorners<number | null> | undefined =>
  corners === undefined
    ? undefined
    : {
        topLeft: scaleLength(corners.topLeft, scale),
        topRight: scaleLength(corners.topRight, scale),
        bottomRight: scaleLength(corners.bottomRight, scale),
        bottomLeft: scaleLength(corners.bottomLeft, scale),
      };

/**
 * 下面三个是**给 App 侧单节点视图用的出口**（面板正文 / 单侧视图、重合层小字）。
 * （原先还有右键图层菜单，那个菜单 2026-09-28 已移除。）
 *
 * 单侧视图（只选了一侧、没有对照节点）与对比表必须给出**同一个数**：同一个元素点开两次，
 * 一个说 `51.67`、一个说 `48.2`，两个都「对」却互相打架，用户无从判断该信哪个。
 * 所以换算算术只留上面这一份实现，别处一律从这里取，不许再自己乘一遍。
 *
 * ⚠️ 与 `scaleSides` / `scaleCorners` 一样，**三态原样透传**：`undefined` = 这版快照没这个
 * 通道、`null` = 采了且确定没有。它们不是 0，卷进乘法会变成 `NaN` / 假结论。
 */
export const scaleAppLength = (
  value: number | null | undefined,
  scale: number,
): number | null | undefined => (typeof value === 'number' ? round2(value * scale) : value);

/** 四边描边宽度 → 换算后的四槽，交给 `formatAppSides` 折叠成一行。 */
export const scaleAppSides = scaleSides;

/** 四角圆角 → 换算后的四槽，交给 `formatAppCorners` 折叠成一行。 */
export const scaleAppCorners = scaleCorners;

/**
 * 一个 App 长度值能否写成 `k / pixelRatio` —— 也就是**它是不是物理像素吸附的产物**。
 *
 * 这是「面板上那些小数到底哪来的」的判据。宿主 `w()` 的实现是
 * `PixelRatio.roundToNearestPixel(v × scaleWidth)`，而 `roundToNearestPixel(x)` 就是
 * `Math.round(x × pr) / pr` —— 所以 3x 屏上凡走过 `w()` 的尺寸，**乘回 pr 必然落在整数物理像素**：
 * `8.67 = 26/3`、`43 = 129/3`。反过来，布局算式的产物（胶囊圆角 `height / 2` 那种）不保证落格。
 *
 * 容差 0.01 个物理像素：iOS 的值经原生 float32 截断（`8.666666984558105`），乘回 pr 与整数差
 * ~1e-6；要求严格相等会把它们全判成「不在网格上」，这段说明就永远不显示了。
 */
export function pixelGridOf(
  value: number | null | undefined,
  pixelRatio: number | undefined,
): { px: number; ratio: number } | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !pixelRatio || pixelRatio <= 0) {
    return null;
  }
  const px = value * pixelRatio;
  const rounded = Math.round(px);
  if (rounded <= 0 || Math.abs(px - rounded) >= 0.01) return null;
  return { px: rounded, ratio: pixelRatio };
}

/**
 * 换算的上下文。
 *
 * `scale` 是换算的**必需品**；`designWidth` / `appWidth` / `pixelRatio` 是给「这个读数怎么来的」
 * 那段说明用的 —— `× 375 / 402` 比 `× 0.9328` 好读，像素比则让 `8.67 = 26 / 3` 这种来历
 * 写得出来。五个数都来自快照元数据（`pair.design.width` / `pair.app.width` /
 * `pair.app.pixelWidth`），没有一个是新引入的。
 */
export interface AppAlignContext {
  sdkVersion?: string;
  platform?: 'android' | 'ios';
  acceptanceContext?: AcceptanceContext;
  designHeight?: number;
  /** design.width / app.width */
  scale: number;
  designWidth: number;
  appWidth: number;
  /** Captured native page width for manual targets; appWidth remains the screenshot canvas width. */
  devicePageWidth?: number;
  /** 设备物理像素比 = pixelWidth / width（iOS 3、安卓 2.625）。缺省时略过 `k / pr` 那一步 */
  pixelRatio?: number;
  /**
   * 截图物理像素宽（2026-09-29 加）。
   *
   * 与上面四个不同，它**不服务于换算**（换算只需 `scale`），而是给
   * `lib/pixelProjection.ts` 构造投影契约用的：设计节点 → App 物理像素要求
   * 基准宽 / viewport 宽 / 物理像素宽**三个确切整数**，缺一个就只能判「不可判定」。
   * 老快照没有它（`SideData.pixelWidth` 为 undefined）→ 面板不画「像素」那两块。
   */
  pixelWidth?: number;
  /**
   * 宿主取整档位（2026-09-29 加）：面板的「目标物理像素」与验收报告的几何期望值
   * 必须是同一套算式。`presnap` 下宽走 `S(w·k)`，`raw` 下走 `S((x+w)·k) − S(x·k)`，
   * 同一个矩形两档能差 1px —— 面板按一种、报告按另一种，就会出现「两个都叫工具说的」读数。
   *
   * 由快照元数据透传；缺省时由 `toPixelHostProfile` 落默认档（只有一处默认值）。
   */
  hostProfile?: PixelHostProfile;
}

/**
 * 面板读数的**对齐方向**（2026-09-29 加）。
 *
 * - `'design'`（默认）：**App 对齐设计稿** —— 设计稿是基准，App 侧的长度读数换算回设计单位
 *   （× `design.width / app.width`）再与设计稿比。画布上的截图也被缩到设计稿同宽，两者同源。
 * - `'pixel'`：**设计稿对齐 App** —— 截图物理像素是基准，设计侧的长度读数投影成物理 px
 *   （`lib/pixelProjection.ts`，与验收判定链同一份实现），UI 同学可以拿它**直接对着截图量**。
 *
 * 为什么要有第二个方向：设计稿写的是 375 基准的数，而 UI 同学手上那张截图是 1080 px 宽的。
 * 默认方向要让验收同学自己在脑子里乘一个 `2.88`，这一步既容易错、也没法复核 ——「面板说 16，
 * 截图上是 46 还是 48」正是这个功能要消灭的问题。
 *
 * ⚠️ **只改读数口径，不改画布的空间对齐**：`CanvasBoard#appAlignScale` 把截图缩到设计稿同宽，
 * 那一条服务的是「两张图叠起来能不能对上」，与「这个数该怎么念」是两件事。画布不随这个开关变。
 *
 * 覆盖范围（2026-09-29 第二次收敛）：
 *  - 面板**单侧视图**的全部长度读数；
 *  - 面板**对比表**的显示值（`buildCompareFields` 的 `pixel` 参数）—— 但**判定不换尺子**；
 *  - 画布上的**间距读数**（`CanvasBoard` → `lib/pixelProjection#measureLinesInPixels`）。
 * 一句话：凡是「给人看的长度读数」都跟着换，凡是「判定」都不换。
 */
export type AlignBasis = 'design' | 'pixel';

/**
 * 把「这个 App 读数是怎么来的」写成多行说明，供面板做 `title`。
 *
 * 面板显示的是**换算到设计稿基准**的值（8.08），开发改代码要的是真机值（8.67），中间还夹着
 * 一层谁也看不见的物理像素吸附 —— 验收同学看到 8.08、设计稿写 8，会直接判「圆角不对」。
 * 这段说明回答的就是那一句「为什么不是整数」。
 *
 * ⚠️ `value` 必须是**设备原值**（没有乘过 `scale`）：换算过的值反推不出物理像素。
 */
export function appLengthOrigin(
  value: number | null | undefined,
  align: AppAlignContext | undefined,
  designValue?: number | null,
): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !align) return undefined;
  const design = typeof designValue === 'number' && Number.isFinite(designValue) ? designValue : undefined;
  const grid = pixelGridOf(value, align.pixelRatio);
  const lines: string[] = [
    grid
      ? `设备值 ${round2(value)} pt = ${grid.px} / ${grid.ratio}（${grid.px} 个物理像素 @${grid.ratio}x）`
      : `设备值 ${round2(value)} pt`,
  ];
  if (design !== undefined && grid) {
    // ⚠️ 设计基准 → 设备走的是 `scale` 的**倒数**：`scale` 干的是「把设备值缩回设计稿」。
    // 这里用两侧宽度直接算，别拿 `1 / scale` 反推（多一次浮点除法，算式也对不上宿主源码）。
    const grow = align.appWidth / align.designWidth;
    const idealPx = design * grow * grid.ratio;
    /**
     * ⚠️ **只有「设备值确实像是从设计值经 `w()` 来的」才写这一步。**
     *
     * 反例是文本类字段：宽度由字号决定，而字号在宿主走的是 `sp()`
     * （`Math.round(fontSize × scaleText)`，比 `w()` 多一层取整）。硬套 `w()` 的算式，
     * 设计 50 会算出「160.8 px → 165 px」—— 读起来像「吸附偏了 4px」，而真相是字号被
     * 多抬了一档。吸附本身的理论上限是 0.5px（`round` 最多偏半格），给一倍余量到 1px：
     * 差值超过它，就说明这个值根本不走 `w()`，不该拿这条算式去解释。
     */
    if (Math.abs(idealPx - grid.px) <= 1) {
      lines.push(
        `吸附：设计 ${round2(design)} × ${round4(grow)} × ${grid.ratio} = ${round2(idealPx)} px → ${grid.px} px`,
      );
    }
  }
  if (align.scale !== 1) {
    const tail =
      design === undefined
        ? ''
        : `（设计稿 ${round2(design)} · 差 ${round2(Math.abs(value * align.scale - design))}）`;
    lines.push(
      `换算到设计稿基准：${round2(value)} × ${align.designWidth} / ${align.appWidth} = ${round2(value * align.scale)}${tail}`,
    );
  }
  // 只剩「设备值 8.67 pt」一行、又推不出物理像素时，这段 title 与显示值一模一样，是废话
  if (lines.length === 1 && !grid) return undefined;
  return lines.join('\n');
}

/**
 * 面板常驻的口径说明（**不 hover 也看得见**）。
 *
 * 为什么必须常驻：`appLengthOrigin` 那段只在鼠标停上去才出现，而「面板怎么全是小数」是
 * **看第一眼就会冒出来的疑问**。不给答案，验收同学的第一反应是「这工具算不准」，而不是
 * 「这是等比缩放的必然结果」—— 那她也就不会信后面那些真正该处理的差异了。
 *
 * 两侧同宽时不返回（没有换算，就没有需要解释的小数）。
 *
 * ⚠️ 两个口径讲的是**相反**的事（默认：App 值缩回设计基准；像素口径：设计值投影成截图 px），
 * 所以不能共用一段文案 —— 把「× 375 / 402」挂在 px 读数上，方向正好反了（2026-09-29 加 `basis`）。
 */
export function alignNotes(align: AppAlignContext | undefined, basis: AlignBasis = 'design'): string[] {
  if (!align) return [];
  if (basis === 'pixel') {
    // 投影拿不到（老快照没有截图物理像素宽）时给空：组件那边另有一行说明讲原因，
    // 这里再写「已按 px 读」会与事实矛盾。
    if (!align.pixelWidth || align.pixelWidth <= 0) return [];
    const total = align.pixelWidth / align.designWidth;
    // 矩形那条说明**按宿主档位**分叉（2026-09-29）。原先一律写「四条边各自取整」，而目标宿主
    // 是 `w()` 型预吸附 —— 实际走的是「左 / 宽各自取整」。文案与算式不一致时，验收同学会照着
    // 文案手算一遍，然后发现跟工具对不上，把时间花在怀疑工具上。
    const rectLine = align.hostProfile === 'raw'
      ? '设计侧矩形走边界投影：四条边各自取整、宽高由边相减（宿主把裸值交给布局，布局按绝对边界吸附）；圆角 / 字号这类标量没有两条边，只能单值投影'
      : '设计侧矩形按**属性**投影：左 / 宽各自取整（宿主预吸附型，如 screenUtils.w() 对每个属性各调一次 roundToNearestPixel），右边界 = 左 + 宽；圆角 / 字号这类标量同样是单值投影';
    return [
      `读数口径：设计稿对齐 App —— 长度按截图物理像素读（设计值 × ${align.pixelWidth} / ${align.designWidth} = ${round4(total)} 后取整）`,
      rectLine,
      // ⚠️ 这一行**必须把两条 App 通道分开讲**：单侧视图的矩形取实测 `pixelRect`（缺则留空），
      // 而对比表两侧都走换算链（它比的是「开发有没有做对」，不是「截图上量到多少」）——
      // 合成一句「App 侧矩形取 pixelRect」在对比表里就是假话。
      'App 侧：矩形在**单侧视图**取 SDK 实测的 pixelRect；对比表与其他长度一律由设备逻辑值乘密度换算（换算，非实测）',
      // 判定那半句也必须在：对比表里同时躺着「px 读数」与「一致 / 不同」，不说明就会被读成
      //「差 1px 怎么还说一致」。判定没换尺子 —— 换的只是显示单位（见 `buildCompareFields`）。
      `⚠️ 判定仍按设计基准（±${round2(LENGTH_TOLERANCE)} pt ≈ ±${round2(LENGTH_TOLERANCE * total)} px）：换口径只换显示单位，不改「一致 / 不同」`,
    ];
  }
  if (align.scale === 1) return [];
  const lines = [
    `App 长度读数已换算到设计稿基准：× ${align.designWidth} / ${align.appWidth} = ${round4(align.scale)}`,
  ];
  lines.push(
    align.pixelRatio && align.pixelRatio > 0
      ? `小数来自物理像素吸附：${round4(align.pixelRatio)}x 屏上 1 px = ${round4(1 / align.pixelRatio)} pt，读数落成 k / ${round4(align.pixelRatio)}`
      : '小数来自设备侧的物理像素吸附，不是采集误差',
  );
  return lines;
}

/** 四槽展开：设计稿侧是单值 / 数组两种形态，统一成 4 槽才能与 App 侧逐位比。 */
const cornerSlots = (value: DesignNode['cornerRadius']): number[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0].map(round2);
  }
  return [round2(value), round2(value), round2(value), round2(value)];
};

/** 四槽展开（描边宽度）：Figma 的 `strokeWeight` 是四边同值。 */
const sideSlots = (value: number | undefined): number[] | undefined =>
  value === undefined ? undefined : [value, value, value, value];

/**
 * 长度类字段的统一构造：换算 → 折到 2 位小数（与 `round2` 同口径）→ 带上数值序列供容差判定。
 *
 * 非数值原样退回字符串比较（设计稿的行高可能是 `"auto"`），别让 `toFixed` 崩在这里。
 *
 * `shown` 是**像素口径下的显示串**（2026-09-29 加）：给了就替换 `text`，而 `numbers`
 * 仍然是 `scale` 那一套 —— 换口径只换读数，不改判定（见 `buildCompareFields`）。
 */
const numericValue = (
  value: number | string | null | undefined,
  scale = 1,
  origin?: string,
  shown?: string,
): CompareValue => {
  if (value === undefined) return compareValue(undefined);
  if (typeof value !== 'number') return compareValue(value === '' ? null : value);
  const scaled = Number((value * scale).toFixed(2));
  const base = compareValue(scaled, undefined, [scaled]);
  if (shown === undefined) return { ...base, origin };
  return { ...base, text: shown, key: shown.trim().toLowerCase(), origin };
};

/**
 * 四槽里**唯一**的非空值；四槽不全等时返回 `undefined`。
 *
 * 「来历」说明是挂在**整行**上的（行显示的是折叠串 `8.67 / 2`），所以只在四值全等时才敢写 ——
 * 四角不同却只解释左上角，读者会把那套算法套到整行上。导出是为了让单侧视图（面板正文）
 * 与对比表用**同一份**判定，不各写一遍「四值是否全等」。
 */
export const soleValue = (values: Array<number | null | undefined>): number | undefined => {
  const present = values.filter((value): value is number => typeof value === 'number');
  if (present.length === 0) return undefined;
  return present.every((value) => value === present[0]) ? present[0] : undefined;
};

/**
 * 四边（描边宽度）/ 四角（圆角）的比较值：**展示用折叠字符串**（`8.67` 或 `8.67 / 2`），
 * **判定用 4 槽数值序列**。
 *
 * 折叠后的字符串没法做容差比（`8.09` 与 `8` 不是同一个串，会被判成「不同」），
 * 所以槽位数组必须一起带上。通道没读（`undefined`）给「未采集」；读了但四边全 0 给 `—` ——
 * 这两种都不带槽位，判定仍走 `key` 严格相等。
 */
const sidesValue = (
  sides: AppNodeSides<number | null> | undefined,
  scale: number,
  origin?: string,
  shown?: string,
): CompareValue => {
  if (sides === undefined) return compareValue(undefined);
  const scaled = scaleSides(sides, scale)!;
  const label = formatAppSides(scaled);
  if (label === null) return compareValue(null);
  const base = compareValue(
    label,
    undefined,
    [scaled.top, scaled.right, scaled.bottom, scaled.left].map((value) => round2(value ?? 0)),
  );
  if (shown === undefined) return { ...base, origin };
  return { ...base, text: shown, key: shown.trim().toLowerCase(), origin };
};

const cornersValue = (
  corners: AppNodeCorners<number | null> | undefined,
  scale: number,
  origin?: string,
  shown?: string,
): CompareValue => {
  if (corners === undefined) return compareValue(undefined);
  const scaled = scaleCorners(corners, scale)!;
  const label = formatAppCorners(scaled);
  if (label === null) return compareValue(null);
  const base = compareValue(
    label,
    undefined,
    [scaled.topLeft, scaled.topRight, scaled.bottomRight, scaled.bottomLeft].map((value) =>
      round2(value ?? 0),
    ),
  );
  if (shown === undefined) return { ...base, origin };
  return { ...base, text: shown, key: shown.trim().toLowerCase(), origin };
};

/**
 * 构造对比字段。
 *
 * `scale` = **App 侧长度值换算进设计稿基准的系数**（`design.width / app.width`，即
 * `CanvasBoard#appAlignScale`）。设计稿侧是基准，恒为 1；只有 App 侧的长度读数被换算，
 * 且只换长度（颜色 / 文本 / 字体名 / 字重不受影响）。
 *
 * `align` 是同一个上下文的完整形态（两侧宽度 + 像素比），**不参与换算**，只用来给每个 App 侧
 * 长度值写一句「这个数是怎么来的」（`appLengthOrigin`）—— 面板把 8.08 摆在设计稿的 8 旁边，
 * 中间那两步（等比缩放、物理像素吸附）不写出来就等于让读者自己猜。缺省时不带说明。
 *
 * `pixel` 是「设计稿对齐 App」口径下的投影（2026-09-29 加，见 `AlignBasis`）：非空时
 * **长度字段的显示值换成截图物理像素**（设计侧投影、App 侧乘密度），来历说明也换成像素那一套。
 *
 * ⚠️ **它只改显示，不改判定**：每个字段的 `numbers`（`sameCompareValue` 比的就是它）仍然是
 * `scale` 那一套设计单位，`LENGTH_TOLERANCE` 也仍是 0.5 pt。理由有两条：
 *  ① 判定是冒烟与 `replay:gt` 验过的那条结论，换单位就换阈值，等于顺手改掉验收结论；
 *  ② 这个功能的诉求是「读数能直接对着截图量」（展示），不是「用另一把尺子重判一次」。
 * 于是口径切换**不可能**让某一行从「一致」翻成「不同」—— 面板底部那句常驻说明写明了这一点。
 *
 * 矩形在这里走**边界投影**（`designPixelEdges`：四条边各自取整、宽高由边相减），标量走
 * 单值投影（`designLengthToAppPixels`）—— 与面板单侧视图同一条纪律（共享层明令两者不可互换）。
 * App 侧的矩形**不用** `pixelRect`：这张表比的是「开发有没有做对」，两侧都该是同一条换算链；
 * `pixelRect` 是**实测**，归面板顶部那块「App 物理像素」（一处混两种来历＝同一行两个都「对」的数）。
 */
export function buildCompareFields(
  design: DesignNode,
  app: AppNode,
  scale = 1,
  align?: AppAlignContext,
  pixel?: PixelProjection | null,
): CompareField[] {
  const style = app.style;
  const textStyle = app.textStyle;
  // 边框三行与面板正文共用同一个通道判据（`appBorderChannel`）：这版没读边框时给「未采集」，
  // 而不是给一个 `—` —— 后者会被读成「App 侧确定没有边框」，一个假结论。iOS 就是这一类。
  const borderChannel = appBorderChannel(style);
  const cornerChannel = appCornerChannel(style);

  // ---- 像素口径的显示换算（`pixel` 为空时全部退化成 undefined，即保持设计单位读数）----
  /** 设计侧标量 → px 显示串（非数值原样不给：`"auto"` 这类没有坐标系） */
  const pxShown = (value: number | string | null | undefined): string | undefined =>
    pixel && typeof value === 'number' ? String(designLengthToAppPixels(value, pixel)) : undefined;
  /** 设计侧标量的「来历」（设计 12 × 360 / 375 = … → 取整 35 px） */
  const pxOrigin = (value: number | string | null | undefined): string | undefined =>
    pixel && typeof value === 'number' ? designPixelOrigin(value, pixel) : undefined;
  /** App 侧标量 → px 显示串（乘密度后吸附） */
  const pxApp = (value: number | null | undefined): string | undefined =>
    pixel && typeof value === 'number' ? String(appLengthToPixels(value, pixel)) : undefined;
  /**
   * 设计侧矩形（宽 / 高）的 px 显示串：**两条边相减**，不是对宽度单独取整。
   * 这也是「设计 50 → 144 px」与「宽度按 ×2.88 取整」可能差 1px 的唯一原因。
   */
  const designEdges = pixel ? designPixelEdges(design, pixel) : null;
  const pxWidth = designEdges ? String(designEdges.right - designEdges.left) : undefined;
  const pxHeight = designEdges ? String(designEdges.bottom - designEdges.top) : undefined;
  /** 矩形字段的「来历」：与面板顶部那块同一段（`pixelTargetTitle` 把四条边都列了出来） */
  const rectOrigin = pixel ? pixelTargetTitle(design.rect, pixel) : undefined;
  /**
   * 设计侧圆角可以是单值或四角数组：逐值投影后再折叠成一行（与面板单侧视图同一套折叠）。
   */
  const pxCornersShown = ((): string | undefined => {
    if (!pixel) return undefined;
    const value = design.cornerRadius;
    if (value === undefined || value === null) return undefined;
    const projected = Array.isArray(value)
      ? value.map((radius) => designLengthToAppPixels(radius, pixel))
      : designLengthToAppPixels(value, pixel);
    const label = cornerRadiusLabel(projected);
    return label === null ? undefined : String(label);
  })();
  /** App 侧四槽 / 四角 → 折叠串（先逐槽换算再折叠，顺序反过来读到的是设备原值） */
  const pxAppSides = (sides?: AppNodeSides<number | null>): string | undefined => {
    if (!pixel || sides === undefined) return undefined;
    const label = formatAppSides(appSidesToPixels(sides, pixel));
    return label === null ? undefined : label;
  };
  const pxAppCorners = (corners?: AppNodeCorners<number | null>): string | undefined => {
    if (!pixel || corners === undefined) return undefined;
    const label = formatAppCorners(appCornersToPixels(corners, pixel));
    return label === null ? undefined : label;
  };

  /**
   * App 侧长度读数的「来历」。两个口径讲的是**相反**的两步，不能共用一段文案：
   *  - 默认口径：× `design.width / app.width` 缩回设计基准（`appLengthOrigin`）；
   *  - 像素口径：× 像素密度吸附到整数（`appPixelOrigin`），并注明「是换算、不是实测」。
   */
  const lengthOrigin = (
    raw: number | null | undefined,
    designValue?: number | null,
  ): string | undefined =>
    pixel
      ? typeof raw === 'number'
        ? appPixelOrigin(raw, pixel)
        : undefined
      : appLengthOrigin(raw, align, designValue ?? undefined);
  /**
   * App 侧长度读数：换算 + 附上「这个数是怎么来的」。
   * `designValue` 只用来把对照写进说明，**不参与换算**（换算只用 `scale`）。
   */
  const appLen = (
    raw: number | null | undefined,
    designValue?: number | string | null,
    shown = pxApp(raw),
  ): CompareValue =>
    numericValue(
      raw,
      scale,
      lengthOrigin(raw, typeof designValue === 'number' ? designValue : undefined),
      shown,
    );
  // 四槽全等才给「来历」说明（见 `soleValue`）：折叠成一行后，说明是对整行负责的。
  const rawBorder = soleValue([
    style?.borderWidth?.top,
    style?.borderWidth?.right,
    style?.borderWidth?.bottom,
    style?.borderWidth?.left,
  ]);
  const rawCorner = soleValue([
    style?.borderRadius?.topLeft,
    style?.borderRadius?.topRight,
    style?.borderRadius?.bottomRight,
    style?.borderRadius?.bottomLeft,
  ]);
  const appWidth = borderChannel
    ? sidesValue(
        style?.borderWidth,
        scale,
        lengthOrigin(rawBorder, design.strokeWeight),
        pxAppSides(style?.borderWidth),
      )
    : compareValue(undefined);
  const appCorners = cornerChannel
    ? cornersValue(
        style?.borderRadius,
        scale,
        lengthOrigin(
          rawCorner,
          typeof design.cornerRadius === 'number' ? design.cornerRadius : undefined,
        ),
        pxAppCorners(style?.borderRadius),
      )
    : compareValue(undefined);
  const appBorderColors = borderChannel
    ? compareValue(normalizeEdgeLabel(formatAppEdgeColors(style?.borderColor)?.label))
    : compareValue(undefined);
  const designText = design.text;

  const designWeight = designNodeFontStyle(design);
  const weightAliases: Record<string, string> = {
    thin: '100', hairline: '100', 'extra light': '200', ultralight: '200', light: '300',
    regular: '400', normal: '400', book: '400', medium: '500', 'semi bold': '600', semibold: '600',
    bold: '700', 'extra bold': '800', extrabold: '800', black: '900', heavy: '900',
  };
  const designWeightValue = compareValue(designWeight);
  if (designWeightValue.state === 'value') {
    designWeightValue.key = weightAliases[designWeightValue.key] ?? designWeightValue.key;
  }
  // 比较键必须与 App 侧的键**同口径**（那边是 `formatAppCorners` 折出来的 2 位小数字符串），
  // 否则 `8.666666984558105` 与 `8.67` 会被判成「不一致」（见 `round2` 的说明）。
  const cornerKey = (value: DesignNode['cornerRadius']): string => {
    // ⚠️ `null` 必须和 `undefined` 一样挡掉（2026-09-29）：类型上这个字段是
    // `number | number[] | undefined`，**没有任何生产者会写 null**（Figma 侧
    // `serialize.ts` 只在 `!== undefined` 时落键）。但这里曾是全文件唯一漏挡 null 的
    // 一个 —— 同位字段的 `cornerSlots`(339) 与 `cornerRadiusLabel`(56) 都挡了。
    // 漏挡的代价不是「显示不准」而是**整块面板崩掉**：`null.toFixed` 抛在 render 期，
    // React 18 会把整棵树卸载，症状是节点信息面板整个消失。属于防御一致性，非已知线上问题。
    if (!Array.isArray(value)) return value === undefined || value === null ? '' : String(round2(value));
    const rounded = value.map(round2);
    if (rounded.every((radius) => radius === rounded[0])) return String(rounded[0]);
    return rounded.join(' / ');
  };
  /**
   * 设计侧圆角这一格：显示串 / 比较键 / 判定槽位**分别**构造。
   *
   * 判定槽位（`numbers`）与比较键必须是**设计单位**口径 —— App 侧那个键是 `formatAppCorners`
   * 折出来的设计单位串，键口径一错，`8.67` 与 `9` 这种就会被判成「一致」。而显示串可能已被投影
   * 成像素（`pxCornersShown`），那是给人看的，不参与判定。
   */
  const designCorners: CompareValue = {
    ...compareValue(cornerRadiusLabel(design.cornerRadius)),
    key: cornerKey(design.cornerRadius).toLowerCase(),
    numbers: cornerSlots(design.cornerRadius),
  };
  if (pxCornersShown) {
    designCorners.text = pxCornersShown;
    designCorners.key = pxCornersShown.trim().toLowerCase();
  }
  // 圆角是**四角数组**时不给「来历」：那张说明写的是单个值的算式，挂在整行上会把读者带偏
  //（`soleValue` 那条纪律的同一件事）。
  if (typeof design.cornerRadius === 'number') designCorners.origin = pxOrigin(design.cornerRadius);
  const fields: CompareField[] = [
    // ⚠️ 设计侧矩形的 px 显示串来自 **`designPixelEdges`**（四条边各自取整、宽高由边相减），
    // 不是 `pxShown(design.rect.width)`（那是对宽度单独乘倍率取整，实测两成样本差 ±1px）。
    { group: '尺寸', label: '宽度', design: numericValue(design.rect.width, 1, rectOrigin, pxWidth), app: appLen(app.width, design.rect.width) },
    { group: '尺寸', label: '高度', design: numericValue(design.rect.height, 1, rectOrigin, pxHeight), app: appLen(app.height, design.rect.height) },
    { group: '文本', label: '内容', design: compareValue(designText?.characters ?? null), app: compareValue(app.text ?? null) },
    { group: '文本', label: '字体', design: compareValue(designText?.fontFamily ?? null), app: compareValue(textStyle === undefined ? undefined : textStyle?.fontFamily ?? null) },
    { group: '文本', label: '字号', design: numericValue(designText?.fontSize, 1, pxOrigin(designText?.fontSize), pxShown(designText?.fontSize)), app: appLen(textStyle === undefined ? undefined : textStyle?.fontSize, designText?.fontSize) },
    { group: '文本', label: '字重', design: designWeightValue, app: compareValue(textStyle === undefined ? undefined : textStyle?.fontWeight) },
    { group: '文本', label: '行高', design: numericValue(designText?.lineHeight ?? null, 1, pxOrigin(designText?.lineHeight), pxShown(designText?.lineHeight)), app: appLen(textStyle === undefined ? undefined : textStyle?.lineHeight, designText?.lineHeight) },
    { group: '文本', label: '字距', design: numericValue(designText?.letterSpacing ?? null, 1, pxOrigin(designText?.letterSpacing), pxShown(designText?.letterSpacing)), app: appLen(textStyle === undefined ? undefined : textStyle?.letterSpacing, designText?.letterSpacing) },
    { group: '文本', label: '颜色', design: compareValue(designText?.color ?? null, designText?.color), app: textStyle === undefined ? compareValue(undefined) : appColorValue(textStyle?.color) },
    { group: '背景', label: '填充', design: paintValue(design.fills), app: style === undefined ? compareValue(undefined) : style?.gradient ? appGradientValue(style.gradient, design.fills?.find((paint) => paint.visible !== false && paint.type === 'GRADIENT_LINEAR')?.gradientAngle) : appColorValue(style?.backgroundColor) },
    { group: '边框', label: '描边色', design: paintValue(design.strokes), app: appBorderColors },
    // ⚠️ `numbers`（判定）**始终**是设计单位那一套，`text` 才随口径变 —— 见函数头注释。
    { group: '边框', label: '描边宽度', design: { ...numericValue(design.strokeWeight, 1, undefined, pxShown(design.strokeWeight)), numbers: sideSlots(design.strokeWeight) }, app: appWidth },
    { group: '边框', label: '圆角', design: designCorners, app: appCorners },
  ];
  if (app.contentDescription) {
    fields.push({
      group: '文本',
      label: '辅助描述',
      design: { ...compareValue(null), text: '不适用' },
      app: compareValue(app.contentDescription),
      comparable: false,
      statusLabel: '仅 App',
    });
  }
  const hasText = Boolean(designText || app.text || app.contentDescription || app.textStyle);
  return fields.filter((field) => field.group !== '文本' || hasText);
}
