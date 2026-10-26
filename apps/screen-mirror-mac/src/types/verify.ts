/**
 * 验收数据契约（主进程 ↔ 渲染层共享）。
 *
 * 两条数据来源在**存储层就归一化成同一形态**：扁平节点表 + `parentId`。
 *   - 设计稿侧：Figma 嵌套 `children` 树 → `flattenFigmaTree()` 拍平（补 `parentId`）
 *   - App 侧  ：端上 dump 本来就是扁平表（已有 `parentId`）
 * 画布只依赖 `RenderNode`，两侧原始 schema 的差异在 `toRenderNode()` 转换层消化完。
 *
 * AppNode 字段与端上递归 dump 出的原生节点结构严格对齐，不做简化。
 */

import type { FigmaNode, FigmaRect, FigmaText, FigmaLayout, FigmaPaint, FigmaEffect } from './figma';
import type { AcceptanceContext, AcceptanceRules } from '@ui-inspector/protocol';
import type { CollectionQuality } from './acceptance';
import type { PixelHostProfile } from './pixelTransform';

export type VerifySource = 'design' | 'app';
export type NodeKind = 'text' | 'image' | 'container';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelRect extends Rect {}

// ---------- App 侧：原生节点（与端上 dump 结构一致） ----------

export interface AppNode {
  acceptanceRules?: AcceptanceRules;
  nodeId: string;
  treePath?: string;
  parentId: string | null;
  className: string;
  depth: number;
  index: number;
  siblingCount?: number;

  x: number;
  y: number;
  width: number;
  height: number;

  /** 原生 SDK 采集时的最终物理像素矩形；老快照没有该字段。 */
  pixelRect?: PixelRect;

  /** 可见矩形：已被父级 clip 与滚动裁剪后的实际可见区域 */
  visibleX: number;
  visibleY: number;
  visibleWidth: number;
  visibleHeight: number;

  /**
   * **有效可见矩形**：沿祖先裁剪链求交后的结果（SDK 侧算好，与 x/y/width/height 同口径）。
   *
   * 与上面那组不是同一件事：`visible*` 是平台口径（Android `getGlobalVisibleRect`），对 RN 的
   * `overflow:hidden` 这类**绘制期裁剪**完全无感；这一组才回答「屏幕上还有没有它的像素」。
   *
   * ⚠️ **缺失（老 SDK 快照）时按 undefined 处理**，含义是「这版没这个通道」，
   * 消费方按「没被裁」走 —— 宁可多放行一个，也不要让存量快照突然点不动。
   */
  effectiveVisibleX?: number;
  effectiveVisibleY?: number;
  effectiveVisibleWidth?: number;
  effectiveVisibleHeight?: number;
  /** 自身矩形被祖先裁剪链裁小（含裁没）。与平台口径的 `clipped` 不同源。 */
  clippedByAncestor?: boolean;
  /** 自身有面积、有效可见矩形却为空：屏幕上没有它的任何像素。缺字段按 false 处理。 */
  clippedOut?: boolean;

  scrollX: number;
  scrollY: number;

  visible: boolean;
  enabled: boolean;
  clickable: boolean;

  alpha: number;
  z: number;
  elevation: number;
  clipsToBounds: boolean;

  isImage: boolean;
  isSvg: boolean;
  isGradient: boolean;
  hasVisualContent: boolean;

  resourceName: string | null;
  contentDescription: string | null;
  text: string | null;

  zeroSize?: boolean;
  hiddenByAncestor?: boolean;
  outsideVisibleRect?: boolean;
  clipped?: boolean;
  layoutOnly?: boolean;
  /**
   * **透传包装**：自身不绘制像素、且恰好装着一个占满自身的有效子节点（判据与实测见
   * `CollectPolicy.isPassThrough`）。
   *
   * 它和 `layoutOnly` 的关系是「因」与「果」：`layoutOnly = !hasVisualContent && (passThrough || 无有效子节点)`。
   * SDK 直接带出来是为了让调试导出可读 —— 「为什么这个节点没被匹配」在导出里就是一行
   * `passThrough: true`，不必再去猜它的子节点矩形。
   *
   * ⚠️ 缺失（老快照）时按 `undefined` 处理，匹配引擎会自己按矩形重算，不依赖它。
   */
  passThrough?: boolean;
  textRedacted?: boolean;
  /**
   * **透明盾牌**：不参与画布命中。由 `markAppHitShields()` 标注（主进程 loader 调用），
   * 判据与实测数据见那个函数。
   *
   * ⚠️ 缺失（老快照）时按 `false` 处理，即维持改动前的行为 —— 宁可多放行一个，
   * 也不要让已经存量的快照在新版本里突然点不动。
   */
  hitShield?: boolean;
  participation?: 'required' | 'optional' | 'context' | 'ignored' | 'unavailable';

  /**
   * 盒样式：背景色 / 边框 / 圆角。
   *
   * **三态，不是两态**（这是它唯一需要留神的地方）：
   *  - `undefined` —— 这版快照**根本没有这个通道**（老 SDK 的导出 / 磁盘上的存量快照）；
   *  - `null` —— 采集了，明确「这个节点没有盒样式」（一个透明容器就是如此）；
   *  - 对象 —— 有样式，缺值的字段表示「这一项没设」。
   *
   * 面板据此决定「整组不画」还是「画成 `—`」：「采不到」与「就是没有」在验收里是两个结论，
   * 混成一个会让老数据被读成「这个元素没有背景色」。
   *
   * 与上面的几何字段**不是同一个单位口径**：几何在 SDK 侧是 px、到这里才除以密度变成逻辑值，
   * 而样式在 SDK 侧就已经换算成 **dp** 了（那边拿得到 `density` 与 `fontScale`，
   * 而 `scaledDensity` 在 Mac 侧只够算字号）。所以这里不要再除一次密度。
   */
  style?: AppNodeBoxStyle | null;
  /** 文本样式：字号 / 字重 / 字体 / 行高 / 字距 / 颜色。**非文本节点是 `null`**；老快照是 `undefined`。 */
  textStyle?: AppNodeTextStyle | null;
}

/** 四边的具名值。顺序与 SDK 一致：top / right / bottom / left（物理边，RTL 下也对得上画面）。 */
export interface AppNodeSides<T> {
  top: T;
  right: T;
  bottom: T;
  left: T;
}

/** 四角的具名值。顺序与 SDK 一致：左上 / 右上 / 右下 / 左下。 */
export interface AppNodeCorners<T> {
  topLeft: T;
  topRight: T;
  bottomRight: T;
  bottomLeft: T;
}

/**
 * 盒样式。长度单位统一是 **dp**，`null` 元素表示「这一边/这一角没有值」——
 * 与 0 不是一回事，但展示时按 0 处理（RN 里没设就是没有）。
 */
export interface AppNodeBoxStyle {
  /** `#rrggbb` 或 `#aarrggbb`；`null` = 没设背景色（含完全透明）。 */
  backgroundColor?: string | null;
  /** `solid` / `dashed` / `dotted`；`null` = 没有边框（样式无意义时不报）。 */
  borderStyle?: string | null;
  /** 四边边框宽度（dp）；`null` = 这一边没有边框。 */
  borderWidth?: AppNodeSides<number | null>;
  /** 四边边框颜色。 */
  borderColor?: AppNodeSides<string | null>;
  /** 四角半径（dp）。 */
  borderRadius?: AppNodeCorners<number | null>;
  /** SDK supplied incomplete/invalid corners; do not interpret the discarded sample as unset. */
  borderRadiusIncomplete?: boolean;
  gradient?: AppNodeGradient | null;
}

export interface AppNodeGradientPoint { x: number; y: number; }
export interface AppNodeGradient {
  type: 'linear';
  colors: string[];
  locations?: number[] | null;
  startPoint?: AppNodeGradientPoint | null;
  endPoint?: AppNodeGradientPoint | null;
  useAngle?: boolean;
  angle?: number | null;
  angleCenter?: AppNodeGradientPoint | null;
}

/**
 * 文本样式。三个长度值都是 **dp / sp 归一化后**的「开发写在 style 里的那个数字」——
 * SDK 侧已经除掉了 `density × fontScale`（见 `NativeNode.TextStyle`），所以系统字体被
 * 调大过也不会让这里的字号跟着变大。
 */
export interface AppNodeTextStyle {
  /** 字号（dp）。 */
  fontSize?: number;
  /** 字重 100–900，数值化（设计稿侧只有 `"Medium"` 这类字符串，见 `designNodeFontStyle`）。 */
  fontWeight?: number;
  /** `normal` / `italic`；`null` = 没读到。 */
  fontStyle?: string | null;
  /** RN 的 fontFamily 字符串；`null` = 没设。 */
  fontFamily?: string | null;
  /** 行高（dp）；`null` = RN 没设行高（TextView 用字体自带行距）。 */
  lineHeight?: number | null;
  /** 字距（dp）；`null` = 没设。 */
  letterSpacing?: number | null;
  /** 文字颜色。 */
  color?: string | null;
}

/**
 * Whether an App node can actually be seen in the captured frame.
 *
 * Android reports a View's own visibility independently from its ancestors. In particular, an
 * opacity-0 ReactViewGroup may leave descendants with `visible: true`; those descendants are not
 * valid canvas targets or acceptance participants when `hiddenByAncestor` is set by the SDK.
 * Missing the field keeps old snapshots backward compatible.
 */
export function isAppNodeEffectivelyVisible(node: Pick<AppNode, 'visible' | 'hiddenByAncestor'>): boolean {
  return node.visible !== false && node.hiddenByAncestor !== true;
}

// ---------- 设计稿侧：Figma 节点（扁平化后存盘） ----------

/**
 * Figma 节点扁平化后的形态。
 * 保留 FigmaNode 的全部字段（fills/text/layout/effects 供右侧信息面板展示），
 * 只是把 `children` 拆成扁平数组 + `parentId`。
 */
export type DesignNode = Omit<FigmaNode, 'children'> & {
  parentId: string | null;
  /** 扁平化后不再保留嵌套；层级关系由 parentId + depth 表达 */
  children?: never;
  /**
   * 直接子节点个数。拍平后**保留它是为了别的判据**（导出 / 排查时一眼看出「这个 Frame
   * 是不是空壳」），**画布命中不读它** —— 2026-09-22 晚 `designNodeHittable` 定稿为
   * 「容器一律按盒命中」，有没有子节点都一样（此前曾用它放行「装了东西的隐藏填充
   * FRAME」、又撤销过一次，来回的实测数字见 `designNodeHittable`）。
   *
   * ⚠️ 老导出没有这个字段（`undefined`）——按 0 处理。
   */
  childCount?: number;
};

/**
 * 把 Figma 嵌套树拍平成扁平数组（深度优先，**保持原数组顺序**）。
 *
 * 顺序很重要：Figma 的 children 是 back-to-front（0 = 最底层），
 * 拍平后同一父节点下的兄弟仍按原序排列，渲染时按序 append 即可复刻叠放，
 * **不要额外排序**。
 *
 * `rect` 原样保留（相对导出单元根节点），不做坐标换算。
 */
export function flattenFigmaTree(tree: FigmaNode): DesignNode[] {
  const out: DesignNode[] = [];

  const walk = (node: FigmaNode, parentId: string | null): void => {
    const { children, ...rest } = node;
    // childCount 在这里记下来：拆掉 children 之后就再没有第二个地方知道「它原来有没有孩子」
    out.push({ ...rest, parentId, childCount: children?.length ?? 0 });
    // 保持原数组顺序，不要排序
    for (const child of children ?? []) walk(child, node.id);
  };

  walk(tree, null);
  return out;
}

/** 从扁平后的设计稿节点取出要展示的文本内容 */
export function designNodeText(node: DesignNode): string | null {
  return node.text?.characters ?? null;
}

/**
 * 设计稿节点的字体粗细。
 * ⚠️ Figma 导出**没有 fontWeight 数值字段**，粗细是 `text.fontStyle` 字符串（如 `"Medium"`）。
 */
export function designNodeFontStyle(node: DesignNode): string | null {
  const style = node.text?.fontStyle;
  return typeof style === 'string' && style.length > 0 ? style : null;
}

/** 设计稿节点是否裁剪子节点（对应 DOM 的 overflow: hidden） */
export function designClipsContent(node: DesignNode): boolean {
  return node.layout?.clipsContent === true;
}

/** App 节点是否裁剪子节点 */
export function appClipsContent(node: AppNode): boolean {
  return node.clipsToBounds === true;
}

/**
 * 「描边」通道：这版快照**到底有没有读这一组**？—— 面板画不画「描边」行由它回答。
 *
 * 为什么不能只看 `style !== undefined`：那个判据在**只有一类采集端**时是对的，现在不是了。
 * 三态在这里要再分一层，因为「读了、确定没有」与「这版没读」在面板上画出来一模一样（`—`），
 * 但结论相反：
 *
 *  - `undefined` → 老快照，整份样式都没采 → **没读**；
 *  - `null` → 采过了、这个节点确实没有盒样式（安卓的透明容器） → **读了**，
 *    `—` 是一句真话：它确实没有描边；
 *  - 对象且含任一描边键（`borderStyle` / `borderWidth` / `borderColor`）→ **读了**。安卓只要
 *    `style != null` 就无条件写全部键（`NativeNode.toWritableMap`），所以键存在性就是「读过」
 *    的证据 —— 键存在性由 `normalizeNumberSides` 等保住，不会被「有没有非空值」推断掉；
 *  - 对象但一个描边键都没有 → **没读**。iOS 目前就是这一类：它采得到 `backgroundColor` 与
 *    圆角，但描边被 RN 画在轮廓图片层里、`layer.borderWidth` 被显式置 0，读不到
 *    （`RCTViewComponentView.mm:944`）。对着它画「描边色 / 描边宽度」两行 `—`，验收同学会读成
 *    「这个元素确定没有描边」—— 而事实是这版根本没采。
 *
 * ⚠️ **不含 `borderRadius`**：圆角与描边是两回事，且 iOS 只读得到圆角、读不到描边（见上）。
 * 若把圆角并进这个判据，iOS 节点（有 `borderRadius`、无 `borderWidth`/`borderColor`）会点亮
 * 「边框」组，而组内两行描边只能画 `—`，又回到上面那个假结论。圆角走独立的 `appCornerChannel`。
 *
 * 面板正文与对比表**必须共用这一个判据**：两处各写一遍，迟早会分叉成
 * 「面板不画、对比表还说有值」。
 */
export function appBorderChannel(style?: AppNodeBoxStyle | null): boolean {
  if (style === undefined) return false;
  if (style === null) return true;
  return (
    style.borderStyle !== undefined ||
    style.borderWidth !== undefined ||
    style.borderColor !== undefined
  );
}

/**
 * 「圆角」通道：与 `appBorderChannel` 互补，三态语义**逐条对齐**（`undefined` 没读 /
 * `null` 读了且确定没有 / 含 `borderRadius` 键才算读了）。
 *
 * 为什么 `null` 也要算「读了」：它与描边是同一份 `style` 的两个切面 —— `style === null`
 * 说的是「这个节点整份盒样式都没有」，那么「没有圆角」与「没有描边」同为真话。若这里对
 * `null` 返回 false，同一批安卓透明容器的「圆角」行会**整行消失**，而同组的描边行还写着
 * `—`，两个切面自相矛盾（相对拆分前更是静默丢信息：那时圆角行跟着描边通道一起画）。
 *
 * iOS 这版采得到圆角（等半径档）、采不到描边；安卓四角都采得到。两者只要 `style` 里有
 * `borderRadius` 键就点亮「圆角」行，不牵连描边。
 */
export function appCornerChannel(style?: AppNodeBoxStyle | null): boolean {
  if (style === undefined) return false;
  if (style === null) return true;
  return style.borderRadius !== undefined;
}

/**
 * 四边的数值折成一行：**四边一样就只报一个数，不一样才逐边列出**。
 *
 * 为什么需要它：设计稿侧一个描边就是一个数，而 App 侧的四边在数据上永远各占一格。
 * 无条件画成 `1 / 1 / 1 / 1`，验收同学第一反应是「这里四边不一样吗」—— 逐边渲染
 * 只在这四边**真的不同**时才是信息，否则就是四个数字的噪音（面板首屏很贵）。
 *
 * `null` 按 0 处理（RN 里没设就是没有这一边），四边全 0 返回 `null`（面板显示 `—`）。
 */
export function formatAppSides(sides?: AppNodeSides<number | null> | null): string | null {
  if (!sides) return null;
  const values = [sides.top ?? 0, sides.right ?? 0, sides.bottom ?? 0, sides.left ?? 0];
  return foldUniformSides(values);
}

/** 四角半径的同款折叠，顺序 左上 / 右上 / 右下 / 左下。 */
export function formatAppCorners(corners?: AppNodeCorners<number | null> | null): string | null {
  if (!corners) return null;
  const values = [
    corners.topLeft ?? 0,
    corners.topRight ?? 0,
    corners.bottomRight ?? 0,
    corners.bottomLeft ?? 0,
  ];
  return foldUniformSides(values);
}

/**
 * ⚠️ **先归一到 2 位小数、再折**（2026-09-28 修）。原生值经 RN 的 **float32** 一路传上来，
 * 「整数像素 ÷ 密度」这类写法（如 3x 屏下 `26 / 3`）读回来是 `8.666666984558105`，
 * 直接 `String()` 会在面板两行和对比表里铺一长串尾巴；更糟的是对比表拿这个字符串与设计稿
 * 的 `8.67` 比 ⇒ 判成「不一致」，一个纯粹由浮点精度造出来的假红。
 *
 * 2 位是刻意的：与设计稿（Figma 数值 + `numericValue()` 的 `toFixed(2)`）同口径，
 * 验收同学据此能下结论；**原始精度仍在数据里**（`nodes.json` / 导出包一个字节都没动）。
 */
const round2 = (value: number): number => Number(value.toFixed(2));

function foldUniformSides(values: number[]): string | null {
  const rounded = values.map(round2);
  if (rounded.every((value) => value === 0)) return null;
  return rounded.every((value) => value === rounded[0]) ? String(rounded[0]) : rounded.join(' / ');
}

/** `#aarrggbb` / `#aarrggbbaa` 判定：8 位 hex 一律是 App 侧 ARGB 口径。 */
const APP_HEX8 = /^#[0-9a-f]{8}$/i;

/**
 * App 侧 8 位 hex（`#aarrggbb`，alpha 在**首**字节）→ CSS 口径（`#rrggbbaa`，alpha 在**末**位）。
 *
 * ⚠️ **为什么必须转**：App 侧 SDK 的两个实现都写 ARGB ——
 * Android `CollectPolicy.formatColor`（`out[at++] = HEX_DIGITS[(alpha >> 4) & 0xF]` 打头）
 * 与 iOS `HMFormatColor`（`#%02x%02x%02x%02x` 传 `a, r, g, b`）。而**设计侧是
 * Figma 口径 `#rrggbbaa`**（`figma-plugin/src/plugin/serialize.ts`）。同一个 `#rrggbbaa`
 * 字面量在两侧含义不同，直接拿去比或拿去渲染必然错。
 *
 *   真实值 `#8a000000` = alpha 0.8A + 纯黑 ⇒ **黑色 54% 透明**
 *   原样丢给 CSS ⇒ `rgba(138,0,0,0)` = 全透明深红（既错色又错透明度）
 *
 * 6 位 hex 两侧同口径（无alpha 位），原样透传；非 hex（`rgb()` / `rgba()` / 渐变串）
 * 也透传 —— 那些格式自带语序，不存在字节序歧义。
 *
 * **只用于「显示与字符串比对」，不用于改写数据**：`nodes.json` 里的原值是端上上报的
 * 事实（导出包、ground truth、像素通道都按它算），改写会让快照与真机对不上。
 */
export function appColorToCss(color: string | null | undefined): string | null | undefined {
  if (!color || !APP_HEX8.test(color)) return color;
  const h = color.slice(1);
  return `#${h.slice(2, 8)}${h.slice(0, 2)}`;
}

/**
 * 四边颜色的折叠。
 *
 * 返回 `uniform` 是有意义的，不只是排版：**只有四边同色时才该画色块** ——
 * 一个色块旁边跟着 `#ff0000 / #00ff00 / …` 四个 hex，读者会把那个色块当成边框色，
 * 而它其实只代表第一条边。
 *
 * 全都没有值时返回 `null`（面板显示 `—`）。
 */
export function formatAppEdgeColors(
  colors?: AppNodeSides<string | null> | null,
): { label: string; uniform: boolean } | null {
  if (!colors) return null;
  const values = [colors.top, colors.right, colors.bottom, colors.left];
  const present = values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (present.length === 0) return null;
  const uniform = present.length === values.length && values.every((value) => value === values[0]);
  return uniform
    ? { label: values[0] as string, uniform: true }
    : { label: values.map((value) => value ?? '—').join(' / '), uniform: false };
}

/**
 * R4 分辨率对齐策略：**按宽对齐**。
 *
 * 设计稿与真机的逻辑尺寸往往不同（如设计 375×867 vs 截图 390×844），
 * 直接 1:1 并排时「同一个元素落不到同一个位置」——通栏按钮左边缘都在 x=24，
 * 但右边缘差 390−375=15pt，越靠右错位越大，人就无法判断某个偏移是 bug 还是
 * 分辨率差异。所以必须选一条基准边做等比缩放。
 *
 * 为什么选宽度而不是高度：移动端布局是**宽度驱动**的（屏幕宽=设备宽，
 * 横向栅格/边距都按宽度定），纵向由内容与机型差异（状态栏、安全区、灵动岛）
 * 决定，本来就不该期望严格对齐。
 *
 * 返回作用在**截图帧**上的等比缩放系数；设计稿帧恒为 1（它是基准）。
 * 按宽对齐后两帧等宽，纵向则让出残差：867 − 844×(375/390) ≈ 55pt 落在底部。
 *
 * 非法输入（0 / 负数 / NaN）一律回退 1，宁可不缩放也不要把画布算崩。
 */
export function widthAlignScale(designWidth: number, appWidth: number): number {
  if (!Number.isFinite(designWidth) || !Number.isFinite(appWidth)) return 1;
  if (designWidth <= 0 || appWidth <= 0) return 1;
  return designWidth / appWidth;
}

/**
 * 平台展示名。**主进程与渲染层共用这一份** —— `ios → "iOS"` 这个映射
 * 写死两处，迟早一边漏改（页面匹配卡片、配对默认名、截图默认名都要用）。
 *
 * 返回 `null` 表示元数据里**没有**平台字段（老快照）：调用方不要猜一个默认值，
 * 与盒样式三态同一条哲学 —— 没读到就不画、就不编。
 */
export function platformLabel(
  platform: 'ios' | 'android' | undefined | null,
): 'iOS' | 'Android' | null {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  return null;
}

/** 文本指纹上限：匹配只需要大致重合度，没必要存全量 */
const TEXT_SAMPLE_LIMIT = 400;

/** 归一化单条文本：去空白、转小写、掐头去尾 */
function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 生成文本指纹，供页面匹配算 Jaccard 相似度用。
 *
 * 刻意在**导入/采集时**落盘而不是匹配时现算：
 * 匹配是 N×M 的两两比较，若每次都去读 schema/nodes 文件，代价会随页面数平方增长。
 */
export function normalizeTextSamples(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const text = normalizeText(value);
    if (text.length === 0) continue;
    seen.add(text);
    if (seen.size >= TEXT_SAMPLE_LIMIT) break;
  }
  return [...seen];
}

// ---------- 需求 / 资产 / 配对 / 问题（存储模型） ----------

export type DesignAssetSource = 'local-import' | 'plugin-upload';
export type AppSnapshotSource = 'uiautomator' | 'sdk' | 'manual';

/** 设计稿资产元数据（一帧 = 一页设计稿） */
export interface DesignAssetMeta {
  id: string;
  requirementId: string;
  /** Figma 帧 id；与 pageId 组合成唯一键（fileKey 为 null 不可依赖） */
  frameId: string;
  /** 唯一键：`pageId + frameId` */
  frameKey: string;
  name: string;
  /** 根节点类型；元素级导出时不是容器 */
  type: string;
  /** 页面级全路径，展示与匹配用 */
  path: string;
  pageId?: string;
  pageName?: string;

  /** 逻辑尺寸（设计稿 px） */
  width: number;
  height: number;
  /** 位图倍数：截图物理尺寸 = 逻辑尺寸 × exportScale */
  exportScale: number;

  /** 该节点对应的截图物理尺寸（仅用于调试/展示） */
  pixelWidth?: number;
  pixelHeight?: number;

  /** 是否帧级导出；只有帧级才作为整页设计稿参与匹配 */
  isFrameLevel: boolean;

  schemaFile: string;
  screenshotFile: string;
  thumbnailFile: string;
  nodeCount: number;

  /** 归一化后的文本指纹（TEXT 节点的 characters），供页面匹配算文本重合度 */
  textSamples: string[];

  source: DesignAssetSource;
  importedAt: string;
  /** 包名（manifest.fileName），便于溯源 */
  packageName?: string;
}

/** App 快照元数据（一次抓屏） */
export interface AppSnapshotMeta {
  sdkVersion?: string;
  acceptanceContext?: AcceptanceContext;
  /** Native page/window logical width; screenshot width remains the canvas frame width. */
  devicePageWidth?: number;
  id: string;
  requirementId: string;
  platform: 'ios' | 'android';
  device?: string;
  osVersion?: string;
  serial?: string;

  /**
   * 可读名称。采集时给个默认值（前台包名/机型），UI 同学可改成页面名。
   * 页面匹配的「名称相似度」维度依赖它 —— 名字不对，推荐排序就没意义。
   */
  label: string;

  /** 逻辑尺寸（dp / pt），与设计稿逻辑 px 同量纲 */
  width: number;
  height: number;
  /** 截图物理像素尺寸 */
  pixelWidth: number;
  pixelHeight: number;
  /** Android 的 densityDpi（如 420），换算用：logical = px × 160 / densityDpi */
  densityDpi?: number;

  /**
   * 宿主取整档位（2026-09-29 加）：这个 App 把设计值交给布局时，取整发生在哪一步。
   *
   * 它决定「设计矩形 → 截图物理像素」按属性还是按边界投影（见 `@shared/pixelTransform`
   * 的 `PixelHostProfile`），进而决定几何判据的期望值 —— 同一个矩形两档能差 1px。
   *
   * 缺省时不在这里补默认值：解析统一走 `toPixelHostProfile()`，默认值只有一份
   * （`PIXEL_HOST_PROFILE_DEFAULT`，当前 `'presnap'`）。旧快照（本字段还不存在时采的）
   * 就是缺省路径 —— 拿默认档去比，与「引擎不声明档位」的表现一致。
   */
  hostProfile?: PixelHostProfile;

  nodesFile: string;
  screenshotFile: string;
  thumbnailFile: string;
  nodeCount: number;

  /** 归一化后的文本指纹，供页面匹配算文本重合度 */
  textSamples: string[];

  /**
   * 节点来源。`uiautomator` 表示字段有退化（没有 scrollX、visible 矩形、isImage 等），
   * UI 侧应据此提示「部分字段不可用」。
   */
  source: AppSnapshotSource;
  /** SDK capture id used to pair the node snapshot and screenshot. */
  captureId?: string;
  /** SDK collection quality; absent for legacy/manual snapshots. */
  collectionQuality?: CollectionQuality;
  /**
   * SDK 上报的窗口尺寸与截图实际尺寸不一致时的差值。
   *
   * 最常见的成因是**系统栏**：SDK 遍历的是 App 的 window（不含状态栏 / 导航栏），
   * 而 `screencap -p` 抓的是整个 display，于是两者天然差一条状态栏的高度 ——
   * 这属于**可校准的平移**，所以不阻断验收（PLAN 也要求保留「系统安全区 / 页面平移」）。
   *
   * 但差值多少决定了几何结论还值不值得信，因此它必须**留下痕迹**：
   * 验收裁决据此降级为「待复核」，而不是不声不响地拿整屏去比。
   * 缺省 = 两侧尺寸一致（老快照没有这个字段，同样按「一致」处理）。
   */
  coordinateInset?: {
    sdkWidth: number;
    sdkHeight: number;
    screenshotWidth: number;
    screenshotHeight: number;
  };
  capturedAt: string;
  /** 采集时的前台包名，用于核对采的是不是目标 App */
  foregroundPackage?: string;
}

/**
 * 「配对进行中」的草稿。
 *
 * 用户点「新建配对」后进入草稿态，在素材卡片上分别点选两侧；
 * **两侧都选定才落库**（`verify:pair-save`）—— 系统只做推荐排序，不自动建配对。
 * 纯前端状态，不持久化。
 */
export interface PairDraft {
  designAssetId?: string;
  appSnapshotId?: string;
}

export type PairStatus = 'pending' | 'verified';

/** 配对（验收的基本单元） */
export interface MatchPairMeta {
  id: string;
  requirementId: string;
  designAssetId: string;
  appSnapshotId: string;
  /** 系统推荐分（仅排序用，不自动建配对） */
  matchScore?: number;
  status: PairStatus;
  createdAt: string;
}

export type IssueSeverity = 'P0' | 'P1' | 'P2';
export type IssueStatus = 'open' | 'resolved' | 'ignored';

export interface IssueImage {
  fileName: string;
  width: number;
  height: number;
}

/** 问题标记 */
export interface Issue {
  /** Frozen manual measurement values and capture contract at issue creation. */
  acceptanceEvidence?: string;
  id: string;
  requirementId: string;
  pairId: string;
  source: 'design' | 'app' | 'both';
  /** 逻辑坐标；null 表示整页问题 */
  position: { x: number; y: number } | null;
  nodeId: string | null;
  designNodeId?: string | null;
  appNodeId?: string | null;
  severity: IssueSeverity;
  description: string;
  image?: IssueImage;
  status: IssueStatus;
  createdAt: string;
}

/** 需求（一次验收的容器） */
export interface RequirementMeta {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  designAssets: DesignAssetMeta[];
  appSnapshots: AppSnapshotMeta[];
  pairs: MatchPairMeta[];
  issues: Issue[];
}

// ---------- 画布视图模型 ----------

export interface SideData<TNode> {
  sdkVersion?: string;
  platform?: 'ios' | 'android';
  acceptanceContext?: AcceptanceContext;
  /** Native page/window logical width; screenshot width remains the canvas frame width. */
  devicePageWidth?: number;
  width: number;
  height: number;
  /** 截图 URL（LocalImage 接入后为 sm-asset:// 地址） */
  imageUrl?: string;
  imageLabel: string;
  /**
   * 设备物理像素比 = `pixelWidth / width`（iOS 3、安卓 2.625）。只有 App 侧有，2026-09-28 加。
   *
   * 带过来只为一件事：让渲染层能回答「这个小数哪来的」。宿主把设计值吸附到物理像素网格后，
   * 读数总可以写成 `k / pixelRatio`（`w(8)` 在 3x 屏上是 `26/3` = 8.67）—— 不给像素比，
   * 面板只能干说「设备值 8.67」，答不上验收同学真正在问的那句「为什么不是 8」。
   *
   * ⚠️ 它不是换算系数（那是 `CanvasBoard#appAlignScale` 现算的），只用于把算式写全。
   * 设计稿侧没有这个概念：Figma 的值本身就是逻辑值。
   */
  pixelRatio?: number;
  /**
   * 截图的**物理像素宽度**（PNG IHDR 真实值）。只有 App 侧有，2026-09-29 加。
   *
   * 与 `pixelRatio` 分开传、而不是让渲染层拿 `pixelRatio × width` 反乘：反乘要经过一次
   * 浮点除法再乘回来，末位可能差 1 —— 而它的唯一用途是给
   * `pixelTransformGeometry` 当第三个输入，那是个**逐位相等**才会通过的判据
   * （见 `pixelTransformRejectionReasons`）。有确切整数就传确切的。
   *
   * 它是节点信息面板「目标像素 / 实测像素」两块的计算前提：缺了它，
   * 面板认不出「这份快照能不能算物理像素」，于是一律不画（老快照就是这种）。
   */
  pixelWidth?: number;
  /**
   * 宿主取整档位（2026-09-29 加）。只有 App 侧有。
   *
   * 渲染层需要它**不是为了显示**，而是因为面板的「目标物理像素」与验收报告的几何期望值
   * 必须是**同一套算式**：预设宿主下 `S(351·k) = 1011`，按边界投影却得 1010 ——
   * 面板说 1010、报告说 1011，两处都是「工具说的」，评审时无法裁决。
   *
   * 由快照元数据透传（`AppSnapshotMeta.hostProfile`），缺省时渲染层落 `..._DEFAULT`。
   */
  hostProfile?: PixelHostProfile;
  nodes: TNode[];
}

export interface VerifyPair {
  id: string;
  name: string;
  pageNumber: number;
  issueCount: number;
  design: SideData<DesignNode>;
  app: SideData<AppNode>;
}

/**
 * 画布节点层的统一视图。组件只依赖这个结构。
 *
 * `rect` 与所属 `SideData` 的坐标系一致（设计稿 = 相对导出单元根节点；App = 屏幕坐标），
 * 且**统一为逻辑单位**，与背景截图按逻辑宽高显示相吻合。
 */
export interface RenderNode {
  id: string;
  parentId: string | null;
  source: VerifySource;
  rect: Rect;
  /** Original native bounds for strict coincident-node checks; never inferred from rounded logical geometry. */
  pixelRect?: PixelRect;
  kind: NodeKind;
  /** 悬浮提示 / 默认展示名 */
  label: string;
  /** Short id used by the AI input-stage annotation overlay, when available. */
  shortId?: string;
  depth: number;
  /** siblings 内的叠放序号（back-to-front，越小越靠下） */
  index: number;
  /** 层级路径 */
  path: string;
  visible: boolean;
  /**
   * 画不画得出像素（Figma 侧由插件算好：fills / strokes 里有可见 paint）。
   *
   * ⚠️ 它**不再**决定画布命中 —— 命中看 `hittable`。保留它是因为验收引擎拿它判
   * `layoutOnly`、信息面板要展示「有填充」、`.no-fill` 类名也在用。
   */
  hasFill: boolean;
  /**
   * 是否参与画布命中。**画布 `pointer-events` 的唯一判据。**
   *
   * ⚠️ 不要改用 `hasFill` 自己判：两者在「零像素容器」上结论相反，而那正是
   * 2026-09-16 用户点名要的（「无填充的 frame 元素也要能 hover 和点击选中」）。
   *
   * 规则（唯一实现在 `designNodeHittable` / `appNodeHittable`，纯函数，冒烟直接喂数组）。
   * **设计稿侧只有三条**，顺序即语义：
   *  1. 隐藏节点（`visible: false`）永不参与；
   *  2. **容器（FRAME / GROUP / INSTANCE / COMPONENT / COMPONENT_SET / SECTION）一律参与**，
   *     填充状态完全无关 —— 盒本身就是结构，指针落进去就该选中它。
   *     （2026-09-22 晚定稿。旧的第 2 条是「填充被显式隐藏 → 一律出局」，它只挡
   *     `fills:[{visible:false}]`、不挡 `fills` 缺字段，而 Figma 对两种写法一视同仁
   *     —— 于是同排 tab 里只有「消息」点不到。用户报的正是这个。）
   *  3. 图形类（RECTANGLE / VECTOR / ELLIPSE / LINE / 布尔运算 …）：
   *       · 填充被**显式隐藏** → 出局 —— 哪怕还有一条可见描边也不改判（描边只画在
   *         边缘那一圈，按整盒放行会吃掉底下所有东西：实测 `Rectangle 34626668`
   *         349×93.9 带 1.5px 白描边，整盒命中吃掉 **99.1%** 采样点）；
   *       · 画得出像素（可见填充 / 可见描边）→ 参与。「个人中心优化」样本里靠描边
   *         画出像素的有 22 个，一律关掉会让图标彻底选不中（可命中 49 → 39）；
   *       · 零像素 → 出局（它们的盒只是包围盒，盒内空白不是「这个图形」）。
   *
   * ⚠️ 2026-09-22 晚**试过**按 Figma Dev Mode 的「任何父级/子级图层都可选」把第 3 条也
   * 撤掉（改成「`visible` 即命中」）。**实测否决** —— 数字见 `designNodeHittable` 尾注。
   *
   * **App 侧四条**（`appNodeHittable`，2026-09-24 起与手机浮层逐条对齐）：
   *  1. 隐藏节点（`visible: false` / 祖先隐藏）不参与；
   *  2. **零尺寸**与**被祖先裁没**（`clippedOut`）不参与 —— 屏幕上没有它的任何像素；
   *  3. **自己画不出像素的节点不参与**：判据是 SDK 的
   *     `hasVisualContent || isSvg || isImage || isGradient`，也就是手机浮层
   *     `getUiAcceptanceDrawableNodes` 那一条。⚠️ 这一条是本侧与**设计稿侧刻意分叉**的地方：
   *     设计稿侧容器一律按盒参与（Figma Dev Mode 口径），App 侧则照**手机浮层的真相**
   *     ——「手机上点得到什么，Mac 上就点什么」。
   *  4. **透明盾牌**不参与（框架塞进来的全屏透明层，见 `markAppHitShields`）。
   *     第 3 条已经覆盖它（盾牌都不画像素），留着是因为它还会挡住「有背景色却仍是框架覆盖物」
   *     那类异常数据。
   *
   * ⚠️ 第 3 条的依据是 2026-09-24 的实测（iOS 快照 959 节点 / 2409 点采样）：放行不画像素的
   * 容器时，iOS 上有 **34%** 的落点被那些透明壳接走 —— 它们常常画在真实内容**之上**且与
   * 真实元素是**兄弟叠放**（不是父子，所以嵌套 DOM 的裁剪救不了）：手机上点中
   * `FFFastImageView`，Mac 画布上选中外面那层 `RCTViewComponentView`。
   * 逐点归属一致率 iOS 66.1% → 对齐后 ~100%（安卓 90.8% → ~100%）。
   * 被这一条挡掉的层走**图层面板**选（右键「选择图层」菜单已于 2026-09-28 移除）。
   */
  hittable: boolean;
  /** 已被最近的 clipsContent 祖先裁掉（看不见也点不中） */
  clipped: boolean;
  /** App node has no visible pixels after ancestor clipping. */
  clippedOut?: boolean;
  /** 是否裁剪子节点（DOM 用 overflow: hidden） */
  clipsContent: boolean;
  /** 文本内容，供信息面板展示 */
  text?: string | null;
  /** 设计稿专有的原生字段，供信息面板展示 */
  detail?: DesignNodeDetail;
}

/** 设计稿节点在信息面板里要展示的富信息 */
export interface DesignNodeDetail {
  type: string;
  fills?: FigmaPaint[];
  effects?: FigmaEffect[];
  layout?: FigmaLayout;
  text?: FigmaText;
  opacity?: number;
  cornerRadius?: number | number[];
  component?: FigmaNode['component'];
  absoluteRect?: FigmaRect;
}

function designKind(node: DesignNode): NodeKind {
  if (node.type === 'TEXT') return 'text';
  if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'BOOLEAN_OPERATION') {
    return 'image';
  }
  // ⚠️ Figma 没有 IMAGE 节点类型：图片是 RECTANGLE/VECTOR 上的 fills[].type === 'IMAGE'
  if (node.fills?.some((fill) => fill.type === 'IMAGE' && fill.visible !== false)) return 'image';
  return 'container';
}

/**
 * 「容器」类节点：**不画像素时，它的盒本身仍是结构**（布局 Frame、编组、组件实例）。
 *
 * 图形类（RECTANGLE / VECTOR / ELLIPSE / LINE / BOOLEAN_OPERATION …）刻意不在此列：
 * 它们不画像素的时候，盒只是包围盒 —— 盒内空白处并不属于「这个图形」，
 * 放它进来只会凭空多出一块谁也看不见的命中区。
 *
 * ⚠️ 只列**已知**容器，未列出的类型一律不参与命中。多放一个未知类型进来，代价是
 * 画布上多一块隐形靶子（用户点哪儿都点不到真元素）；少放一个的代价只是那个新类型
 * 点不到 —— 两害相权，取后者。
 */
const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'FRAME',
  'GROUP',
  'INSTANCE',
  'COMPONENT',
  'COMPONENT_SET',
  'SECTION',
]);

/** 有没有 fills 条目（空数组与缺字段同义）——用来区分「从没设过填充」与「填充被隐藏」 */
const hasAnyFill = (fills: readonly FigmaPaint[] | undefined): boolean =>
  (fills?.length ?? 0) > 0;

/** fills 里有没有**可见**的条目（缺 `visible` 视为可见，与 Figma 默认值一致） */
const hasVisibleFill = (fills: readonly FigmaPaint[] | undefined): boolean =>
  (fills ?? []).some((fill) => fill.visible !== false);

/**
 * 设计稿节点是否参与画布命中。判据逐条列在 `RenderNode.hittable` 的注释里。
 *
 * 与 `designKind` 分开写是**故意的**：后者把没有图片填充的 RECTANGLE 也归为
 * `container`（那是「怎么渲染」的归类），而命中的「容器」是「盒即结构」的意思。
 * 混用会让「矩形备份」这类隐藏填充的备份图形变成隐形靶子。
 *
 * ⚠️ 判定顺序是**被真实数据逼出来的**，不要按「读起来顺」重排：
 *  `hasFill` 由插件算成「可见填充 **或** 可见描边」（`figma-plugin/src/plugin/serialize.ts`
 *  `out.hasFill = hasVisiblePaint(fills) || hasVisiblePaint(strokes)`）。于是
 *  「填充被隐藏 + 有一条 1.5px 描边」的节点 `hasFill === true` —— 若先按 hasFill 放行，
 *  它就会以**整盒**参与命中，而描边其实只画在边缘那一圈。
 *
 * ## 2026-09-22 晚：最终形态 = **容器按盒命中**（四套判据逐点实测后的选择）
 *
 * 起因是用户报「同排 tab 里『待收货』点得到、『消息』点不到」。当晚试过四个版本，
 * 判据=「画得出像素的节点拿到多少独占点」。全局用 60×120 采样；「消息」「待收货」两列是
 * **在自身盒内**按 0.5px 步长采样得到的**自身可点比例**（这一列才是症状本身）：
 *
 *   | 判据 | 盲盒抽奖稿（266 候选） | 个人中心稿（450 候选） | 「消息」自身可点 | 「待收货」自身可点 |
 *   |---|---|---|---|---|
 *   | 旧闸门（含②） | **5503 点** | **6337 点** | **0.0%** ✗ | 36.2% |
 *   | 按盒（撤②⑥，全量） | — | 可见被点到 234 → 211 个 | **仍是 0%** ✗ | **0%** ✗ |
 *   | **只撤②（容器按盒）✅ 采用** | 5351（**−152 / −2.8%**） | 5449（**−888 / −14%**） | **42.2%** ✅ | 36.2% ✅ |
 *   | 撤② + 几何条件 | — | 更差（30×60 口径 −4286） | 42.2% | 36.2% |
 *
 * 三条结论：
 *  1. **全量按盒（撤②⑥）被否决**。它只解除「自己被闸门挡住」，解不了「被更上面的层盖住」——
 *     而「消息」正是后者：它 24×24 里有一个同尺寸同位置的隐藏填充子节点 `Rectangle 3976`，
 *     一起参与就会整盒盖住父级 → **消息依旧 0%**；「待收货」被它的「矩形备份」同样封死，
 *     36.2% → **0%**。白丢一个原本点得到的。
 *  2. **采用「只撤②」**：容器一律按盒（填充状态无关），**零像素图形类继续出局** —— 挡在
 *     「消息」盒上的恰好是 RECTANGLE，让开之后「消息」自身可点 **0% → 42.2%**，与同排的
 *     「待收货 36.2% / 待付款 43.8% / 待发货 42.2%」拉平（剩下的 56% 归盒中央的图标本体
 *     `Rectangle 1312321435`，这是对的）。代价是可见元素少拿 152 点（盲盒稿 2.8%）/
 *     888 点（个人中心稿 14%）—— 被 375×44 的透明状态栏这类**大透明容器**抢走。
 *     再叠「盒内无非亲缘可见节点相交」的几何条件只会更差，不采用。
 *  3. **代价由图层面板兜底**：透明罩子抢走的点，从图层面板里照样能选中那层
 *     （那里的列表是全量、不看命中）。
 *     ⚠️ 2026-09-28 之前还有第二条兜底通道「右键选择图层菜单」（`layersAtPoint` +
 *     `LayerInspectMenu`），按用户要求移除；上面这条随之成为**唯一**的兜底。
 *     ⚠️ 已知副作用：「返回」12×12 空壳
 *     FRAME 会盖满父级「跳转箭头」，让父级与同级 VECTOR 的可点面积归零 —— 走图层面板。
 *
 * 复现方式：`/tmp` 探针按逐点归属模拟（`ownerAt` = 沿拍平数组倒序找最上面那个命中者），
 * 见 skill `uii-offline-probe`。**别只跑单例夹具** —— 这个坑是「单例说 true、真实样本说
 * 0 命中」的第三次重演（前两次都在命中闸门上）。
 */
export function designNodeHittable(node: DesignNode): boolean {
  if (node.visible === false) return false;

  // ① **容器一律按盒命中，填充状态完全无关**（FRAME / GROUP / INSTANCE / COMPONENT /
  //    COMPONENT_SET / SECTION）。这是 2026-09-22 晚的最终形态，替换了旧的第 ① 条
  //    「设过填充且全部隐藏 → 一律出局」。
  //
  //    旧闸门挡住的正是这类层：24×24 的图标容器「消息」（FRAME + fills=[{visible:false}]）
  //    整盒 0 点可中，而同排的「待收货」（GROUP + `fills` 缺字段）却有 22 点 —— 同一排
  //    tab 里只有它点不到。**两条写法在 Figma 里等价（都不画像素、都不因此变成不可选）**，
  //    我们却区别对待。容器的盒本身就是结构，指针落进去就该选中它。
  //
  //    ⚠️ 为什么不是「所有节点都按盒」（把第 ② 条也撤掉）：那样挡在「消息」盒上的
  //    `Rectangle 3976`（同尺寸同位置的隐藏填充矩形）会一起参与并整盒盖住父级 →
  //    **「消息」依旧 0 点**，而「待收货」被它的 `矩形备份 18` 同样封死，22 → **0 点**。
  //    只放行容器、让零像素图形类继续出局，才能让那层挡路的矩形让开。
  if (CONTAINER_TYPES.has(node.type)) return true;

  // ② 图形类：填充被**显式隐藏** → 出局。哪怕它还有一条可见描边也不改判 —— 描边只画在
  //    边缘那一圈，按整盒放行会吃掉底下所有东西（实测 `Rectangle 34626668` 349×93.9 带
  //    1.5px 白描边，按盒命中吃掉 **99.1%** 采样点，30 个节点只剩 4 个选得中）。
  //    想选到这些层：走图层面板（右键「选择图层」菜单已于 2026-09-28 移除）。
  if (node.fills != null && hasAnyFill(node.fills) && !hasVisibleFill(node.fills)) return false;

  // ③ 其余图形类：画得出像素才参与。这里 `hasFill` 由插件算成「可见填充 **或** 可见描边」，
  //    于是图标 / 线 / 描边字（`fills` 从没设过、`hasFill=true`）照样命中 ——「个人中心优化」
  //    样本里这类有 22 个，一律关掉会让图标在画布上彻底选不中（实测可命中 49 → 39）。
  //    `fills` 缺字段 = 老导出（那时还没有「描边也算像素」），同口径退回插件结论。
  return node.hasFill !== false;
}

/**
 * SDK 判「这个节点自己画不画得出像素」的那一条。
 *
 * ⚠️ 2026-09-24 晚已回退 0.1.9：App 侧命中闸门 `appNodeHittable` **不再**用它
 * （命中只看「可见 && 非盾牌」，与设计稿侧同手感）。它现在**只**喂给盾牌判定
 * `appDrawsSomething`，用来区分「画得出东西的真实元素」与「透明壳」。
 * ⚠️ 与 `appDrawsSomething` 差一个 `text`：盾牌判定要含文本，免得把有文字的真实元素误判成透明壳。
 */
const appDrawsPixels = (node: AppNode): boolean =>
  node.hasVisualContent || node.isSvg || node.isImage || node.isGradient;

/**
 * 自己画不画得出任何像素（文本 / 图片 / 渐变 / SDK 判定的可见内容）。
 *
 * **比 `appDrawsPixels` 宽一格**（多认文本），只喂给盾牌判定 —— 有文字的节点本来就不该
 * 被判成透明盾牌。命中闸门不要用它，理由见 `appNodeHittable`。
 */
const appDrawsSomething = (node: AppNode): boolean => appDrawsPixels(node) || node.text != null;

/**
 * 已知的**框架层覆盖类名片段**（小写包含匹配）。
 *
 * 这些视图在真机上被 RN 设成 `pointerEvents="none"`（不接收触摸），但端上 dump 拿不到
 * 这个属性（它是 RN 在 JS 侧设的，原生 `ViewGroup` 上没有对应的系统字段），于是 Mac 端
 * 只能按类名认。它们共同的特征是：**铺满整个 RN 内容区、什么都不画**，一旦参与命中
 * 就是一块盖住全屏的隐形靶子。
 */
const NON_INTERACTIVE_CLASS_MARKERS: readonly string[] = [
  // React Native 的元素检查器 / 调试高亮层。
  // 两端类名不同、但同一条子串认得出来：
  //   安卓 `com.facebook.react.views.debuggingoverlay.DebuggingOverlay`
  //   iOS  `RCTDebuggingOverlay`（新架构 Fabric 下的对应类）
  'debuggingoverlay',

  // iOS 26 的**系统悬浮条宿主**：`_UIFloatingBarContainerView` 及它那个 Swift 泛型子类
  // （`_TtGC5UIKitP10$…FloatingBarHostingView…`）。铺满整窗（实测 402×874）、
  // `hasVisualContent=false`、无文本，却 `userInteractionEnabled=true`。
  //
  // ⚠️ 它没有安卓对应物 —— 是 2026-09-24 iOS 上传打通后才暴露的新一类。
  // 泛型名字里的 `$1903e4ad022` 是 UIKit 的模块哈希，会随 iOS 版本变，所以只匹配
  // 稳定的语义片段，不匹配整名。
  'floatingbarhostingview',
  'uifloatingbarcontainerview',
];

/**
 * 判定「透明盾牌」的覆盖比例阈值：盒子面积 ≥ 父盒面积的 90%。
 *
 * 0.9 是实测出来的：0.8 / 0.9 / 0.99 在 6 份快照上结论一致（见下方函数注释的数据表），
 * 取 0.9 是为了让「比父盒略小一圈」的盾牌（状态栏 / 圆角裁掉几 pt）也能被认出来，
 * 同时不至于误伤卡片里那种只占父盒两三成的空白 View —— 那是真实的布局元素。
 */
const SHIELD_COVER_RATIO = 0.9;

/**
 * 标出 App 树里的**透明盾牌**：不参与画布命中的节点（`hitShield: true`）。
 *
 * 为什么需要它（2026-09-16 用户报「截图那侧只能选中根节点」）：
 * 端上 dump 的视图树里有大量**框架塞进去的透明层**，它们不是页面的一部分：
 *   · `DebuggingOverlay`（360×774）是 RN 元素检查器的调试层，铺满整个 ReactSurfaceView，
 *     且是父节点的唯一子节点 → DOM 里它盖住全部内容：全屏 3160 点采样里 **98.3%**
 *     命中它，可命中的不同节点只有 **2 个**（它 + 底部导航栏）。用户看到的就是
 *     「怎么点都是整屏一个框」，即所谓的「只能选中根节点」。
 *   · 它的父 `ReactViewGroup`（同样 360×774、同样什么都不画）是第二层盾牌 —— 只关掉
 *     DebuggingOverlay 的话，命中会退到它身上，症状一模一样。所以判定必须**自底向上**：
 *     子节点全被判成盾牌的父节点，自己若是透明且铺满父盒，同样算盾牌。
 *
 * 判据（**先按类名短路**，其余四条全满足才算盾牌）：
 *   0. **类名命中** `NON_INTERACTIVE_CLASS_MARKERS` → 直接判盾牌，不依赖下面四条
 *      （调试层在高亮元素时会临时挂上红框子节点，那时第 4 条反而不成立）。
 *      ⚠️ 它必须排在**所有**判据之前，尤其要在「可点击」之前判 —— 理由见循环里的注释：
 *      iOS 的 `clickable` 恒为 true，排在后面这条规则就废了。
 *   1. 自己画不出任何像素（无可见内容 / 图片 / 渐变 / 文本）；
 *   2. **不可点击**（`clickable` 的空 View 是真实的触摸热区，必须能选）。
 *      ⚠️ 这条只有安卓的 `clickable`（`View.isClickable()`）撑得住；iOS 那边是
 *      `userInteractionEnabled`，默认恒为 true，等于没有区分度 —— 别把 iOS 的
 *      「点不动」归因到这一条上。
 *   3. 盒子面积 ≥ 父盒的 90%（只盖住父盒一小块的空白 View 是真布局，不是盾牌）；
 *   4. 所有子节点都是盾牌或不可见（整棵子树都不画像素 ⇒ 这一支在屏幕上完全不存在）。
 *
 * 实测（6 份 app 快照，30×60 网格采样，指标=「能命中的不同节点数 / 整屏级命中占比」）：
 *   · 规则前：2 / 0.983、2 / 0.983、13 / 0.662、20 / 0.653、66 / 0.417、19 / 0.677
 *   · 规则后：109 / 0.053、98 / 0.124、13 / 0.662、20 / 0.653、66 / 0.417、19 / 0.677
 *   —— 两份被盾牌吃掉的快照恢复（2 → 109 / 2 → 98），**其余四份一个节点都没少**。
 *   （曾试过更激进的「空壳即关」：那四份会掉到 5 / 17 / 40 / 16 —— 空白占位 View
 *     也是验收对象，不能一刀切。）
 *
 * ⚠️ 只标 App 侧。Figma 树是人搭出来的，没有这种框架层透明壳 —— 设计稿侧的判据是
 * `designNodeHittable`（**容器一律按盒命中**；隐藏图层、零像素图形类出局）。
 * 别把「面积占比 + 子节点全透明」这套搬去设计稿侧：那两类规则各管一侧，混用会让两侧
 * 在同一次比对里分叉。
 *
 * @returns 新的节点数组（不改动入参；只有被标成盾牌的节点是新对象）
 */
export function markAppHitShields(nodes: readonly AppNode[]): AppNode[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenOf = new Map<string, AppNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const bucket = childrenOf.get(node.parentId);
    if (bucket) bucket.push(node);
    else childrenOf.set(node.parentId, [node]);
  }

  const shielded = new Set<string>();
  // 自底向上：子节点的 depth 一定大于父节点（端上 dump 的保证），降序遍历即可保证
  // 「算父节点时它的所有子节点都已经有结论」。
  const ordered = [...nodes].sort((a, b) => b.depth - a.depth);

  for (const node of ordered) {
    if (!isAppNodeEffectivelyVisible(node)) continue;

    // ① **先按类名认框架层覆盖物** —— 这一步必须在 `clickable` 判断之前，顺序不能挪。
    //
    //    ⚠️ 2026-09-24 实测踩到的坑：iOS 端 `clickable` 取自 `userInteractionEnabled`，
    //    而 UIView 默认就是 `true` —— 只要类名规则排在它后面，iOS 上就**永远走不到**。
    //    后果是 `RCTDebuggingOverlay`（安卓侧早就被这条规则挡住的那个调试层）在 iOS 上
    //    整帧吃掉画布命中：959 个节点、2409 个采样点 **100% 只命中同一个节点**，
    //    其余 903 个可命中节点一个都点不到；安卓同一套规则的分布是 37 个不同命中者。
    //    `_UIFloatingBarContainerView`（iOS 26 悬浮条宿主）是同一类东西，只是安卓没有对应物。
    const className = (node.className ?? '').toLowerCase();
    if (NON_INTERACTIVE_CLASS_MARKERS.some((marker) => className.includes(marker))) {
      shielded.add(node.nodeId);
      continue;
    }

    // ② 其余节点按「不画像素 + 不可点击」继续筛。
    if (appDrawsSomething(node) || node.clickable) continue;
    // 根节点没有父盒可比，永远不当盾牌（否则整帧会点不动）
    if (!node.parentId) continue;
    const parent = byId.get(node.parentId);
    const parentArea = parent ? parent.width * parent.height : 0;
    if (parentArea <= 0) continue;
    if (node.width * node.height < SHIELD_COVER_RATIO * parentArea) continue;

    const children = childrenOf.get(node.nodeId) ?? [];
    const allTransparent = children.every(
      (child) => !isAppNodeEffectivelyVisible(child) || shielded.has(child.nodeId),
    );
    if (allTransparent) shielded.add(node.nodeId);
  }

  if (shielded.size === 0) return [...nodes];
  return nodes.map((node) =>
    shielded.has(node.nodeId) ? { ...node, hitShield: true } : node,
  );
}

/**
 * App 侧节点是否参与画布命中。
 *
 * **2026-09-24 晚按用户要求回退到 0.1.9 之前的手感**：只判「可见 && 非盾牌」，
 * 透明壳 / 占位 View / 零尺寸 / 被祖先裁剪的节点**一律按盒参与命中**（与设计稿侧同手感）。
 *
 * 为什么回退：0.1.9 曾把闸门收紧成「只认画得出像素的节点」以对齐 iOS 浮层
 * `getUiAcceptanceDrawableNodes`，结果把安卓透明壳 `frame` 挡在了命中之外 —— 对安卓是回归，
 * 用户确认「原来的安卓命中逻辑很正确」。用户拍板「两端全恢复」，即撤销 0.1.9 的收紧。
 *
 * 代价（已知、用户接受）：Mac 画布与手机浮层 `getUiAcceptanceDrawableNodes` 重新不一致 ——
 * iOS 上约 34% 落点会被透明壳接走（逐点一致率从 ~100% 跌回 ~66%）。被壳抢走的落点仍可用
 * **图层面板**兜底（列表是全量、不看 hittable），不必放宽命中闸门。
 * ⚠️ 2026-09-28 之前还有第二条兜底「右键选择图层菜单」（按矩形几何），按用户要求移除。
 *
 * ⚠️ 这里**不要**再加 `appDrawsPixels` / `clippedOut` / 尺寸 之类的闸门 —— 那正是 0.1.9
 * 改坏的东西。透明盾牌的过滤交给 `markAppHitShields`（按类名 + 面积占比 + 子节点全透明），
 * 命中闸门只管「可见 && 非盾牌」。
 */
export function appNodeHittable(node: AppNode): boolean {
  if (!isAppNodeEffectivelyVisible(node)) return false;
  if (node.hitShield === true) return false;
  return true;
}

export function toRenderNode(node: DesignNode, source: 'design'): RenderNode;
export function toRenderNode(node: AppNode, source: 'app'): RenderNode;
export function toRenderNode(node: DesignNode | AppNode, source: VerifySource): RenderNode {
  if (source === 'design') {
    const d = node as DesignNode;
    return {
      id: d.id,
      parentId: d.parentId,
      source: 'design',
      rect: d.rect,
      kind: designKind(d),
      label: d.text?.characters || d.name,
      depth: d.depth,
      index: d.index ?? 0,
      path: d.path,
      visible: d.visible,
      // hasFill 缺失时保守视为可命中，避免整层点不动
      hasFill: d.hasFill !== false,
      hittable: designNodeHittable(d),
      clipped: d.clipped === true,
      clipsContent: designClipsContent(d),
      text: d.text?.characters ?? null,
      detail: {
        type: d.type,
        fills: d.fills,
        effects: d.effects,
        layout: d.layout,
        text: d.text,
        opacity: d.opacity,
        cornerRadius: d.cornerRadius,
        component: d.component,
        absoluteRect: d.absRect,
      },
    };
  }

  const a = node as AppNode;
  return {
    id: a.nodeId,
    parentId: a.parentId,
    source: 'app',
    rect: { x: a.x, y: a.y, width: a.width, height: a.height },
    pixelRect: a.pixelRect,
    kind: a.isImage ? 'image' : a.text != null ? 'text' : 'container',
    label: a.text || a.contentDescription || a.resourceName || a.className,
    depth: a.depth,
    index: a.index,
    path: a.className,
    visible: isAppNodeEffectivelyVisible(a),
    hasFill: a.hasVisualContent || a.isImage || a.isGradient,
    hittable: appNodeHittable(a),
    clipped: false,
    clippedOut: a.clippedOut === true,
    clipsContent: appClipsContent(a),
    text: a.text,
  };
}

/**
 * 把扁平节点表还原成父子树，供画布用嵌套 DOM 渲染（裁剪与叠放才能天然对齐）。
 * 返回根节点数组（`parentId` 为 null 或指向不存在的节点时视为根）。
 */
export function buildNodeTree(nodes: RenderNode[]): RenderTree {
  const childrenOf = new Map<string | null, RenderNode[]>();
  const ids = new Set(nodes.map((node) => node.id));

  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(node);
    else childrenOf.set(parent, [node]);
  }

  return { roots: childrenOf.get(null) ?? [], childrenOf };
}

export interface RenderTree {
  roots: RenderNode[];
  childrenOf: Map<string | null, RenderNode[]>;
}

/** 图层列表里的一行：节点 + 缩进深度 + 展开状态 */
export interface FlatLayerRow {
  node: RenderNode;
  depth: number;
  /** 有子节点（决定要不要画折叠箭头） */
  hasChildren: boolean;
  /** 是否正在展开（仅 hasChildren 时有意义） */
  open: boolean;
}

/**
 * 把节点树按**当前展开状态**拉平成一维行列表，供图层列表渲染（对齐 Figma 的 Layers）。
 *
 * 为什么先拉平、而不是写递归组件：递归组件的 children 每次渲染都是新对象，
 * `React.memo` 会因此完全失效 —— 而 300+ 行的列表里，选中态一变就要重建全部行
 * （每行还带内联图标），那正是最需要 memo 的场景。
 *
 * 折叠判定用回调而不是键集合：键的构造规则（来源前缀之类）属于 UI 侧，
 * 这里只回答「这一行折了吗」。
 *
 * ⚠️ 同一父节点下的兄弟按**数组原序**输出 —— 这是刻意对齐 Figma：导出的 children
 * 是 back-to-front（0 = 最底层），而 **Figma 的 Layers 面板就是按数组原序排的**
 * （index 0 在面板最上面；用户拿真实样本的截图钉死过：卡片组里与父同尺寸的背景板
 * 排在面板第一行 —— 此前一度按「面板顶部 = 最上层」做了逆序，是误读，已改回）。
 * 于是「列表从上到下」＝「画布上从下到上」：面板首行是背景板，越往下越靠前；
 * 画布 DOM 同样按数组原序 append（背景先画、内容后画）—— 两边共用同一份顺序，
 * 谁都不许再翻。
 */
export function flattenVisibleTree(
  tree: RenderTree,
  isCollapsed: (node: RenderNode) => boolean,
): FlatLayerRow[] {
  const out: FlatLayerRow[] = [];

  const walk = (list: RenderNode[], depth: number): void => {
    for (let index = 0; index < list.length; index += 1) {
      const node = list[index];
      const children = tree.childrenOf.get(node.id) ?? [];
      const hasChildren = children.length > 0;
      const open = hasChildren && !isCollapsed(node);
      out.push({ node, depth, hasChildren, open });
      if (open) walk(children, depth + 1);
    }
  };

  walk(tree.roots, 0);
  return out;
}
