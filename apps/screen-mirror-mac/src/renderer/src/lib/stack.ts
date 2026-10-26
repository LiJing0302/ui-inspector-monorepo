import type {
  AppNode,
  AppNodeBoxStyle,
  AppNodeCorners,
  AppNodeSides,
  AppNodeTextStyle,
  DesignNode,
  Rect,
  RenderNode,
} from '@shared/verify';
import { appColorToCss } from '@shared/verify';
import type { FigmaPaint } from '@shared/figma';

/**
 * 重合组（coincident stack）：**几何完全重合**的兄弟节点。
 *
 * ## 它回答哪个问题
 *
 * 「这个按钮明明有圆角，面板里却一行都没有。」
 *
 * 在原生树里「一个按钮」常常是**两层**：上层是内容（`Pressable` + 文字），下层是外观
 * （`react-native-linear-gradient` 的 `LinearGradientView`，圆角由它自己手绘持有）。
 * 两层的矩形逐位相同，上层 `index` 更大 ⇒ 画布点选**永远命中上层**，而圆角记在下层。
 *
 * 实测（2026-09-28，523 节点的 Android 快照）：几何完全重合的兄弟 16 组，其中
 * 「至少一层带样式」且不是全屏根容器的只有 **3 组** —— 全是
 * 「`LinearGradientView`(圆角) + 无样式壳」这同一个模式。占比 0.6%，却是高频误踩，
 * 因为它是**系统性写法**（渐变按钮都这么写）。
 *
 * ## 为什么只识别、不合并
 *
 * 合并（无论落在采集侧还是展示侧）会撞三堵墙，细则见 `REF-canvas-rules.md`
 * 「重合兄弟」一节：
 *
 * 1. `nodeId = sdk:<treePath>` 是**回源码的唯一坐标**，合并必丢一条 treePath；
 * 2. 匹配引擎的祖先投票与「容器内分配」都吃**兄弟集合**，而 Fabric 打平是 RN 特有的
 *    ⇒ 只有 App 侧会合并 ⇒ 两侧树形不对称；
 * 3. 合并后「这层圆角该是 21」会指向一个**不存在的节点**，验收同学拿着它找不到改哪一层。
 *
 * `stackOf` 只识别这一簇。人工面板由 `elementInspection.ts` 解析逐属性来源，
 * 并额外识别严格同框的父子链（Android / iOS 共用，仅组成检查组），
 * 保留冲突／未知；下面的旧 merge 工具仅保留兼容，不能作为最终外观或人工 diff 依据。
 * 数据、id、引擎、配对一律不动。
 *
 * ## 阈值为什么是「逐位相同」而不是「差不多」
 *
 * 几何相同是这次聚合的**安全前提**：聚合后矩形就是原矩形，所以面板里的尺寸、画布上的
 * 间距读数都不可能因为聚合而变。放宽到「差 1px 也算」会把真正的父子嵌套并进来 —— 那是
 * 丢层级，不是去掉噪音。宁可漏掉近重合。
 */
export const STACK_TOLERANCE = 0;

const sameRect = (a: Rect, b: Rect): boolean =>
  (['x', 'y', 'width', 'height'] as const).every((key) =>
    Number.isFinite(a[key]) && Number.isFinite(b[key]) && a[key] === b[key]);

export const sameStackBounds = (a: RenderNode, b: RenderNode): boolean => {
  if (a.source !== b.source) return false;
  // Do not compare rounded logical rectangles when original native bounds exist.
  // A legacy node cannot bridge two distinct native rectangles into one group.
  if (a.pixelRect || b.pixelRect) return !!a.pixelRect && !!b.pixelRect && sameRect(a.pixelRect, b.pixelRect);
  return sameRect(a.rect, b.rect);
};

/**
 * 取某个节点所在的**重合组**，返回**从下到上**（绘制序，`index` 升序）的成员，恒含自身。
 *
 * 判据三条（原先是「与右键菜单的候选算法同口径」，那个算法 2026-09-28 随菜单一起删了）：
 *  - **同父** —— 只认兄弟。父子几何相同是另一回事（那种在命中链上本来就相邻，见
 *    `ancestorChain`：Esc / 原地再点已经能上移一层），把它并进来只会丢层级。
 *  - **可见、未被裁剪、有面积** —— 隐藏层与 0×0 的盒子不参与「这一处有几个元素」。
 *    （RN 的 `<Defs>` 里挂着一堆 0×0 的渐变 def，不排掉会让某些位置凭空多出好几层。）
 *  - **矩形逐位严格相同**：App 优先原始像素矩形；旧快照与设计稿使用原始逻辑矩形，
 *    不取整、不设容差。有原始像素与没有该元数据的节点不混成一组。
 *
 * 长度 1 = 没有重合兄弟，调用方按「普通节点」处理；长度 ≥2 才算一簇。
 *
 * ⚠️ 「可见、未被裁剪、有面积」这条对**目标自身同样成立**（见 `participates`）：选中的那层
 * 若自己就是隐藏 / 被裁剪 / 零尺寸，返回的是**空数组** —— 既不是「含它自己的长度 1」，更不是
 * 「它不在、却把兄弟列出来」的半截列表。调用方一律按 `length <= 1` 走普通节点分支，无需区分。
 */
export const participatesInStack = (node: RenderNode): boolean =>
  node.visible !== false && !node.clipped && !node.clippedOut && node.rect.width > 0 && node.rect.height > 0;

export function stackOf(
  nodes: readonly RenderNode[],
  id: string,
): RenderNode[] {
  const target = nodes.find((node) => node.id === id);
  // ⚠️ 目标自身**也要过资格这一关**，否则会得到「选中的那层不在自己的簇里」这种自相矛盾的列表
  //    （曾经：选中一个隐藏层 → 返回两个可见兄弟 → 面板说「此处有 2 个元素」，可选中项一个都不在）。
  //    连同下面 filter 里的同一判据，语义才是干净的：**不合格的层既不当目标、也不进别人的簇**。
  if (!target || !participatesInStack(target)) return [];
  return nodes
    .filter(
      (node) =>
        node.parentId === target.parentId &&
        participatesInStack(node) &&
        sameStackBounds(node, target),
    )
    .sort((a, b) => a.index - b.index);
}

/**
 * 从**上层往下**取第一个有值的（上层 = 数组末尾，见 `stackOf` 的排序）。
 *
 * 「冲突取上层」不是随手定的：两层几何完全重合时，**视觉上看得见的是上层** ——
 * 它的背景盖着下层、它的边就是画面的边。取下层的值会报出一个屏幕上根本看不到的数字，
 * 而这类「看起来像真的、实际不存在」的假结论正是验收工具最不能犯的错。
 */
function firstValue<S, V>(members: readonly S[], read: (member: S) => V | null | undefined): V | null {
  for (let i = members.length - 1; i >= 0; i -= 1) {
    const value = read(members[i]);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** `firstValue` 的「这个键到底要不要写」版本：`{ set: false }` = 整键不设 */
type Picked<V> = { set: false } | { set: true; value: V | null };

/**
 * 与 `firstValue` 同一个顺序，但**保留三态**。
 *
 * 面板判「这版快照有没有读过圆角」靠的是**键在不在**（`appCornerChannel`：含
 * `borderRadius` 键才算读过），所以聚合时不能简单地把「没有值」一律写成 `null` ——
 * 那会把「这版没这个通道」伪装成「读了、确定没有」，而两者在验收里结论相反。
 *
 * 于是：有任何一层给出值 → 用那个值；否则**只要有一层读过这个键** → `null`；再否则不设。
 */
function pickFromTop<S, V>(styles: readonly S[], read: (style: S) => V | null | undefined): Picked<V> {
  for (let i = styles.length - 1; i >= 0; i -= 1) {
    const value = read(styles[i]);
    if (value !== null && value !== undefined) return { set: true, value };
  }
  return styles.some((style) => read(style) !== undefined)
    ? { set: true, value: null }
    : { set: false };
}

/**
 * `pickFromTop` 的**结构体字段**版本，给 `borderWidth` / `borderColor` / `borderRadius` 用。
 *
 * 这三个与 `backgroundColor` / `borderStyle` 的三态**表达方式不同**：后两者的类型里带
 * 整体 `| null`（`null` = 这版读了、确定没有），而前三个的「没有」表达在 `sides` / `corners`
 * 的**每一个值**上，类型里没有整体 `null`。所以取到整体 `null` 时**不设键**（那种值在数据里
 * 本来就不存在，硬塞只会让类型与数据不一致）。
 *
 * ⚠️ 不设键**不等于丢通道**：`appBorderChannel` / `appCornerChannel` 判「这版读没读过」看的是
 * **键在不在**，而「读了但没有」由 `sides` / `corners` 里的 null 承载 —— 这是原语义，不是这里定的。
 */
function pickStruct<S, V>(
  styles: readonly S[],
  read: (style: S) => V | null | undefined,
): V | undefined {
  const picked = pickFromTop(styles, read);
  return picked.set && picked.value !== null ? picked.value : undefined;
}

/** 盒样式只有一个切面的枚举，抽出来只为让下面两段读起来是同构的 */
const withBoxKeys = (box: AppNodeBoxStyle, styles: readonly AppNodeBoxStyle[]): AppNodeBoxStyle => {
  const backgroundColor = pickFromTop(styles, (style) => style.backgroundColor);
  if (backgroundColor.set) box.backgroundColor = backgroundColor.value;
  const borderStyle = pickFromTop(styles, (style) => style.borderStyle);
  if (borderStyle.set) box.borderStyle = borderStyle.value;
  const borderWidth = pickStruct(styles, (style) => style.borderWidth);
  if (borderWidth !== undefined) box.borderWidth = borderWidth;
  const borderColor = pickStruct(styles, (style) => style.borderColor);
  if (borderColor !== undefined) box.borderColor = borderColor;
  const borderRadius = pickStruct(styles, (style) => style.borderRadius);
  if (borderRadius !== undefined) box.borderRadius = borderRadius;
  const gradient = pickFromTop(styles, (style) => style.gradient);
  if (gradient.set) box.gradient = gradient.value;
  return box;
};

/**
 * 聚合盒样式。**三态逐条对齐**原语义（`undefined` 没读 / `null` 读了且确定没有 /
 * 键在才算读过）—— 判据的唯一实现在 `types/verify.ts` 的 `appBorderChannel` /
 * `appCornerChannel`，这里只保证喂给它们的三态是干净的。
 */
export function mergeAppBoxStyle(
  members: readonly AppNode[],
): AppNodeBoxStyle | null | undefined {
  const styles = members
    .map((node) => node.style)
    .filter((style): style is AppNodeBoxStyle => style !== null && style !== undefined);

  // 一层都没有 style 对象：全 `undefined` = 这版没这个通道；出现过 `null` = 读过且确定没有
  if (styles.length === 0) {
    return members.some((node) => node.style === null) ? null : undefined;
  }
  return withBoxKeys({}, styles);
}

/** 聚合文本样式，三态规则与 `mergeAppBoxStyle` 一致 */
export function mergeAppTextStyle(
  members: readonly AppNode[],
): AppNodeTextStyle | null | undefined {
  const styles = members
    .map((node) => node.textStyle)
    .filter((style): style is AppNodeTextStyle => style !== null && style !== undefined);

  if (styles.length === 0) {
    return members.some((node) => node.textStyle === null) ? null : undefined;
  }

  // 逐键取值而**不逐键保留 null**：文本样式的三态判在**整个对象**上（面板判的是
  // `node.textStyle !== undefined && !== null`，见 `renderApp` 的 textChannel），
  // 所以键值缺失与键值 null 在展示上等价；而 `fontSize` / `fontWeight` 的类型里
  // 本来就没有 null，硬塞一个进去只会让类型与数据不一致。
  const pickNumber = (read: (style: AppNodeTextStyle) => number | null | undefined): number | undefined => {
    const picked = pickFromTop(styles, read);
    return picked.set && picked.value !== null ? picked.value : undefined;
  };
  const pickText = (read: (style: AppNodeTextStyle) => string | null | undefined): string | null | undefined => {
    const picked = pickFromTop(styles, read);
    return picked.set ? picked.value : undefined;
  };

  const merged: AppNodeTextStyle = {};
  const fontSize = pickNumber((style) => style.fontSize);
  if (fontSize !== undefined) merged.fontSize = fontSize;
  const fontWeight = pickNumber((style) => style.fontWeight);
  if (fontWeight !== undefined) merged.fontWeight = fontWeight;
  const fontStyle = pickText((style) => style.fontStyle);
  if (fontStyle !== undefined) merged.fontStyle = fontStyle;
  const fontFamily = pickText((style) => style.fontFamily);
  if (fontFamily !== undefined) merged.fontFamily = fontFamily;
  const lineHeight = pickNumber((style) => style.lineHeight);
  if (lineHeight !== undefined) merged.lineHeight = lineHeight;
  const letterSpacing = pickNumber((style) => style.letterSpacing);
  if (letterSpacing !== undefined) merged.letterSpacing = letterSpacing;
  const color = pickText((style) => style.color);
  if (color !== undefined) merged.color = color;
  return merged;
}

/**
 * 把一簇重合的 App 节点聚合成**一个只读视图**（只喂面板，不进任何数据管道）。
 *
 * `className` 刻意保留**选中项自己**的：面板那行「类型」回答的是「我点的到底是个什么
 * 东西」，而「这一处有几层、分别是什么」由 stack 列表回答 —— 两件事挤进同一个字段，
 * 只会得到一个两行都读不完整的字符串。
 */
export function mergeAppNodes(members: readonly AppNode[]): AppNode {
  const top = members[members.length - 1];
  if (members.length <= 1) return top;
  return {
    ...top,
    style: mergeAppBoxStyle(members),
    textStyle: mergeAppTextStyle(members),
    text: firstValue(members, (node) => node.text),
    contentDescription: firstValue(members, (node) => node.contentDescription),
  };
}

/** 「有没有填充」看的是**可见 paint**：`[]` 与「全是 `visible:false`」都等于没有 */
const hasVisiblePaint = (paints?: readonly FigmaPaint[]): boolean =>
  (paints ?? []).some((paint) => paint.visible !== false);

function firstVisiblePaints(
  members: readonly DesignNode[],
  read: (node: DesignNode) => FigmaPaint[] | undefined,
): FigmaPaint[] | undefined {
  for (let i = members.length - 1; i >= 0; i -= 1) {
    const paints = read(members[i]);
    if (hasVisiblePaint(paints)) return paints;
  }
  return undefined;
}

/**
 * 设计稿侧的同名能力。比 App 侧简单：Figma 的导出**永远带** fills / strokes 键，
 * 没有「未采集」那一态，所以只需照「从上往下第一个画得出像素的」取。
 */
export function mergeDesignNodes(members: readonly DesignNode[]): DesignNode {
  const top = members[members.length - 1];
  if (members.length <= 1) return top;
  return {
    ...top,
    fills: firstVisiblePaints(members, (node) => node.fills),
    strokes: firstVisiblePaints(members, (node) => node.strokes),
    strokeWeight: firstValue(members, (node) => node.strokeWeight) ?? undefined,
    cornerRadius: firstValue(members, (node) => node.cornerRadius) ?? undefined,
    text: firstValue(members, (node) => node.text) ?? undefined,
  };
}

/**
 * 四角折成一行（四角相同只报一个数）—— 与面板的 `formatAppCorners` 同一口味。
 *
 * `scale` = 换算进设计稿基准的系数（`design.width / app.width`，2026-09-28 加）。
 * 这一行小字与面板正文、对比表写的是同一个元素的同一个圆角，三处必须同一个数 ——
 * 一边 `8.67`、一边 `8.08`，读者只会以为「这两层不一样」。
 */
const cornerHint = (
  corners?: AppNodeCorners<number | null> | null,
  scale = 1,
): string | null => {
  if (!corners) return null;
  const values = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft]
    .filter((value): value is number => value !== null && value !== undefined)
    .map((value) => Math.round(value * scale * 100) / 100);
  if (values.length === 0) return null;
  const unique = [...new Set(values)];
  return `圆角 ${unique.length === 1 ? unique[0] : unique.join('/')}`;
};

const sidesHint = (sides?: AppNodeSides<number | null> | null): string | null => {
  if (!sides) return null;
  const values = [sides.top, sides.right, sides.bottom, sides.left].filter(
    (value): value is number => value !== null && value !== undefined && value > 0,
  );
  return values.length === 0 ? null : '描边';
};

/**
 * 列表里那行小字：**这一层有什么**。
 *
 * 它是「要不要切过去看」的唯一依据 —— 只写类名的话，`ReactViewGroup` 和
 * `LinearGradientView` 对验收同学都是天书，切过去才知道哪个有圆角。
 * 所以这里报的是**盒样式里最显眼的那个**，顺序固定：圆角 → 背景 → 描边。
 *
 * `scale` 见 `cornerHint`：列表小字与面板正文得是同一把尺子。缺省 1（两侧同宽）。
 */
export function appLayerHint(node: AppNode, scale = 1): string {
  const style = node.style;
  if (style === undefined) return '未采集样式';
  if (style === null) return '无盒样式';
  const parts = [
    cornerHint(style.borderRadius, scale),
    // ⚠️ 归一化成 CSS 口径（App 侧 8 位 hex 是 ARGB，见 `@shared/verify#appColorToCss`）——
    // 这行小字常被直接抄进工单，`#8a000000` 那个串没人读得懂它是「黑色 54%透明」。
    style.gradient ? `填充 ${style.gradient.colors.map((color) => appColorToCss(color) ?? color).join(' → ')}` :
      (style.backgroundColor ? `背景 ${appColorToCss(style.backgroundColor)}` : null),
    sidesHint(style.borderWidth),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? '无盒样式' : parts.join(' · ');
}

/** 设计稿侧的同一行小字，顺序同样是「外观看得出来的」优先：圆角 → 填充 → 描边 */
export function designLayerHint(node: DesignNode): string {
  const parts: string[] = [];
  const radius = Array.isArray(node.cornerRadius) ? node.cornerRadius[0] : node.cornerRadius;
  // 与 `cornerHint` 同口径折到 2 位：设计稿数值也可能带浮点尾巴（等比缩放算出来的），
  // 两侧小字一个 `8.666666984558105` 一个 `8.67` 会让人以为「这两层不一样」。
  if (typeof radius === 'number' && radius > 0) parts.push(`圆角 ${Math.round(radius * 100) / 100}`);
  const fill = (node.fills ?? []).find((paint) => paint.visible !== false);
  if (fill) parts.push(`填充 ${fill.color ?? fill.type}`);
  if (hasVisiblePaint(node.strokes)) parts.push('描边');
  return parts.length === 0 ? '无填充' : parts.join(' · ');
}
