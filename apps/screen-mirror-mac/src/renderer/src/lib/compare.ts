/**
 * 画布比对模式。
 *
 * 分成两层，因为它们是**两个不同的问题**：
 * - `VerifyMode` 决定「画布上摆几块、怎么摆」——全页是设计稿与截图并排，叠图是把两者压在同一处；
 * - `OverlayCompare` 只在叠图下有意义，决定「压在一起之后用哪种方式看差异」。
 *
 * 把这两层混成一个枚举（`full | opacity | difference | wipe`）会立刻出问题：
 * 「并排 + 差值」这种组合在类型上成立、在屏幕上没有意义，于是每个消费点都要
 * 自己判一遍「这个组合合法吗」。分开之后非法组合压根表达不出来。
 */

export type VerifyMode = 'full' | 'region' | 'overlay';

/** 叠图的三种看法。三者对同一份数据的呈现不同，但都不改变数据本身。 */
export type OverlayCompare = 'opacity' | 'difference' | 'wipe';

export const VERIFY_MODE_LABEL: Record<VerifyMode, string> = {
  full: '全页验收',
  region: '区域验收',
  overlay: '叠图验收',
};

export const OVERLAY_COMPARE_LABEL: Record<OverlayCompare, string> = {
  opacity: '透明度',
  difference: '差值',
  wipe: '擦拭',
};

/**
 * 透明度模式下的默认取值。
 *
 * 取 0.5 而不是 1 或 0：这个模式存在的意义就是「两张图同时可见」，
 * 而 1 = 只看截图（等于全页并排少了一半）、0 = 只看设计稿，两头都退化成单图。
 */
export const DEFAULT_OVERLAY_OPACITY = 0.5;

/**
 * 透明度下限不取 0：滑块拖到底就只剩设计稿一张图，而**界面上没有任何提示**
 * 说明「你现在看不到截图了」——用户会以为是截图丢了。留 0.05 让两张图始终都在。
 */
export const MIN_OVERLAY_OPACITY = 0.05;

/**
 * 擦拭位置（左侧显示设计稿的比例）。
 *
 * 两端不收成 0 / 1：拖到边界后手柄会贴到帧边缘，再想拖回来得刚好点中那一条，
 * 极难操作。留 2% 让手柄始终有一块可见、可抓的区域。
 */
export const MIN_WIPE_RATIO = 0.02;
export const MAX_WIPE_RATIO = 0.98;
export const DEFAULT_WIPE_RATIO = 0.5;

export function clampOverlayOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OVERLAY_OPACITY;
  return Math.min(1, Math.max(MIN_OVERLAY_OPACITY, value));
}

export function clampWipeRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIPE_RATIO;
  return Math.min(MAX_WIPE_RATIO, Math.max(MIN_WIPE_RATIO, value));
}

/**
 * 擦拭的裁剪：**保留右侧**，也就是「左边露设计稿、右边露截图」。
 *
 * `inset()` 的四值是 top / right / bottom / left，削减的是**自身**的边。
 * 想让左侧那一块露出底下的设计稿，就得把截图的左边裁掉 `ratio`，所以写 left 位。
 * 写成 `inset(0 X% 0 0)`（裁右边）的话，交互会与手柄方向相反——
 * 手柄往右拖、露出来的却是左边，这种「反直觉」在验收里会被当成 bug 反复报。
 */
export function wipeClipPath(ratio: number): string {
  const clamped = clampWipeRatio(ratio);
  return `inset(0 0 0 ${(clamped * 100).toFixed(3)}%)`;
}

/** 把光标在视口内容里的横坐标换算成擦拭比例；帧宽非法时返回 null（不动，而不是跳到 0）。 */
export function wipeRatioFromX(input: {
  localX: number;
  frameWorldX: number;
  frameWorldWidth: number;
  zoom: number;
}): number | null {
  const { localX, frameWorldX, frameWorldWidth, zoom } = input;
  if (!Number.isFinite(localX) || !Number.isFinite(zoom) || zoom <= 0) return null;
  if (!Number.isFinite(frameWorldWidth) || frameWorldWidth <= 0) return null;
  const screenWidth = frameWorldWidth * zoom;
  if (screenWidth <= 0) return null;
  return clampWipeRatio((localX - frameWorldX * zoom) / screenWidth);
}

/**
 * 叠图只对**两张图都在**的配对成立。
 *
 * 缺图时不能「照常进入叠图模式」：那时屏幕上只有一张图，用户点「差值」什么变化都看不到，
 * 而工具栏却是选中态—— 看起来像功能坏了。判据交给调用方在禁用按钮时用。
 */
export function canOverlay(pair: { design: { imageUrl?: string }; app: { imageUrl?: string } }): boolean {
  return Boolean(pair.design.imageUrl && pair.app.imageUrl);
}
