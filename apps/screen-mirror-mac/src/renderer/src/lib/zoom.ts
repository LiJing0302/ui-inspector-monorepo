/**
 * 画布缩放的**单一事实来源**。
 *
 * 这些常量原先在 `CanvasViewport` 与 `VerifyToolbar` 里各写了一份
 * （`MIN_ZOOM` / `MAX_ZOOM` 同名不同源），改上限必须同时改两个文件，
 * 漏一个就会出现「滚轮能放大到 16x、加号按钮到 4x 就顶住」这类不对称行为。
 * 现在只此一处，两侧都从这里取。
 */

/** 缩放下限：再小就只剩色块，没有比对价值 */
export const MIN_ZOOM = 0.25;

/**
 * 缩放上限。
 *
 * 4 → 16 的原因：源图 `exportScale = 2`（750×1734 对应逻辑 375×867），
 * Retina 上 zoom = 50% 时 1 源像素就已等于 1 设备像素。要放大到「一个源像素
 * 占满一块屏幕区域、肉眼能数出格子」的程度，需要更高倍率。
 */
export const MAX_ZOOM = 16;

/** 工具栏 ± 按钮的基础步进 */
export const ZOOM_STEP = 0.25;

/**
 * 1 逻辑单位在屏幕上占多少 CSS px 时开始显示像素格。
 *
 * 400% 起显示 1 设计稿 px 的像素格；低于 400% 保持纯色背景。
 *
 * ⚠️ 与 `zoomStepFor` 里的 8 无关：那个是 ± 按钮的步进分档点，不是显示阈值。
 */
export const PIXEL_GRID_MIN_CELL_PX = 4;

/** 统一收口：夹到 [MIN_ZOOM, MAX_ZOOM]，保留 3 位小数避免浮点累积噪声 */
export const clampZoom = (value: number): number =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 1000) / 1000));

/**
 * 工具栏 ± 的单步幅度，随当前倍数增长。
 *
 * 固定 0.25 步进在 MAX_ZOOM = 16 下，从 100% 走到顶要按 60 次 —— 上限放开了，
 * 但按不到就等于没放开。改成低倍精细、高倍粗放：100% 附近 0.25 一档（对齐
 * 「1 倍图看细节」的手感），800% 以上 2 一档（此时每档翻倍都不到）。
 */
export function zoomStepFor(zoom: number): number {
  if (zoom < 2) return ZOOM_STEP;
  if (zoom < 4) return 0.5;
  if (zoom < 8) return 1;
  return 2;
}

/** alignScale / exportScale 的防御：非有限正数一律退回 1，避免把 0 或 NaN 带进比值 */
const positive = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 1;

/**
 * 源图 1 像素在屏幕上占多少 **CSS px**：
 *
 * ```
 * s = zoom × alignScale ÷ exportScale
 * ```
 *
 * - `zoom × alignScale` —— 帧内 1 逻辑单位在屏幕上占的 CSS px 数
 * - `exportScale` —— 1 逻辑单位对应几个源像素（Figma 导出倍率，如 2）
 *
 * 为什么不带 DPR：这里的判据是「源像素是否被放大到肉眼可见的块」，
 * 而 CSS px 才是浏览器采样决策的输入；DPR 只决定它最终落在几个设备像素上。
 */
export function imageSamplingScale(zoom: number, alignScale: number, exportScale: number): number {
  return (zoom * positive(alignScale)) / positive(exportScale);
}

/**
 * 是否该切最近邻采样（`image-rendering: pixelated`）。
 *
 * `s < 1` 时源像素被**缩小**，必须让浏览器平滑插值，否则会出现摩尔纹；
 * `s ≥ 1` 时源像素被**放大**，此时插值会把「1px 的错位」糊成「3px 的渐变」——
 * 而这正是「验收时看不出差了 1 个像素」的根因，所以要切最近邻把像素边界变硬。
 */
export function shouldUseCrispSampling(zoom: number, alignScale: number, exportScale: number): boolean {
  return imageSamplingScale(zoom, alignScale, exportScale) >= 1;
}

/**
 * 是否该显示像素格。
 *
 * 格子是**逻辑坐标**尺度的（1 格 = 1 帧内逻辑单位，对齐 Figma 的 pixel grid），
 * 屏幕上每格占 `zoom × alignScale` 个 CSS px。低于阈值时格子比内容还密，
 * 格线会盖住真正要看的细节，所以只在放大到一定程度后出现。
 */
export function shouldShowPixelGrid(zoom: number, alignScale: number): boolean {
  return zoom * positive(alignScale) >= PIXEL_GRID_MIN_CELL_PX;
}

/**
 * 像素格的世界尺度：1 格 = 1 个**设计稿逻辑单位**。
 *
 * 基准取设计稿而不是截图：设计稿帧的 alignScale 恒为 1，于是它的 1 逻辑单位就是
 * 1 世界单位，格子直接对齐设计标注里的像素边界。截图帧按宽对齐后 1 逻辑单位 =
 * alignScale 个世界单位（≈1.03），格子会和背景格差约 3% —— 这是「一个网格只表达
 * 一个尺度」的必然代价，选它比选截图侧更划算：验收要对照的基准是设计稿。
 */
export const PIXEL_GRID_UNIT = 1;

/**
 * 像素格在屏幕上的格距（CSS px）。
 *
 * `zoom` 的定义就是「1 世界单位占几个 CSS px」，所以格距 = `zoom × PIXEL_GRID_UNIT`。
 * 注意这个值**不再乘 DPR**：它要直接写进 `background-size`，单位是 CSS px。
 */
export function pixelGridCellPx(zoom: number): number {
  return positive(zoom) * PIXEL_GRID_UNIT;
}

/**
 * 把「世界原点在视口里的偏移」归一化到 `[0, cell)` —— 即 `background-position` 该写的值。
 *
 * 必须处理负数：画布可以往右下拖到世界坐标为负的区域，此时 JS 的 `%` 返回负值，
 * 而 `background-position: -3px` 与 `+5px`（cell = 8）**渲染结果其实一样**，
 * 但一旦有人把它当成「必须非负」去加偏移量补偿，就会多错一格。这里统一收口。
 */
export function pixelGridPhase(offsetPx: number, cellPx: number): number {
  const cell = cellPx > 0 && Number.isFinite(cellPx) ? cellPx : PIXEL_GRID_UNIT;
  const rest = offsetPx % cell;
  return rest < 0 ? rest + cell : rest;
}

/** zoom 的比较容差：小于它视为「没变」，避免浮点噪声触发无意义的平移/重算 */
export const ZOOM_EPSILON = 1e-6;

// ---------------- 图层列表 → 画布聚焦（Figma 的 "zoom to selection"） ----------------

/**
 * 聚焦时的放大上限。
 *
 * 刻意**低于** `MAX_ZOOM`（16）：上限那是「用户主动滚轮要放到多大」，而聚焦是
 * 「点一下图层，让我看清它在哪」。取 16 倍时一个 375 宽的帧只能看到 23 个逻辑像素
 * —— 用户立刻失去方位感，不知道自己在看页面的哪一角。
 *
 * 取 8 的来历：最小的可读元素是 12px 字号（约 12×16 逻辑单位），放大到 8 倍后
 * 屏幕上是 96×128 CSS px —— 足以看清笔画与像素格；再大一档（16 倍）只会让
 * 「这一块属于哪个模块」变得不可判断。
 */
export const FOCUS_MAX_ZOOM = 8;

/**
 * 需要改变缩放时，让目标矩形占视口的比例。
 *
 * 0.8 而不是 0.95：留出四周留白，让人还能看见目标**周围**的内容 ——
 * 验收一个元素从来不只是看它自己，还看它和邻居的间距。
 *
 * ⚠️ 必须小于 `FOCUS_KEEP_RATIO_MAX`（0.9），否则「缩到 0.8 → 判定为合适 → 不再动」
 * 与「超出 0.9 → 缩到 0.8」在边界上会来回抖动。
 */
export const FOCUS_FILL = 0.8;

/**
 * 聚焦的**死区**：目标屏幕尺寸占视口的比例落在这个区间内时，保持当前缩放，只做居中。
 *
 * 没有死区的话，点任何图层都会改倍数 —— 而多数时候用户只是想「跳到那个元素」，
 * 视口一跳会造成方位丢失（Figma 的图层面板点击同样是不动视口的）。
 * 只有目标小到看不清（< 15%）或大到装不下（> 90%）时，才值得替用户调一次倍数。
 */
export const FOCUS_KEEP_RATIO_MIN = 0.15;
export const FOCUS_KEEP_RATIO_MAX = 0.9;

export interface FocusPlanInput {
  /** 当前缩放 */
  zoom: number;
  /** 视口尺寸（CSS px），即 `.canvas-scroll` 的尺寸 */
  viewportWidth: number;
  viewportHeight: number;
  /** 目标矩形在**世界坐标**里的位置与尺寸（已含帧内 alignScale） */
  worldX: number;
  worldY: number;
  worldWidth: number;
  worldHeight: number;
}

export interface FocusPlan {
  zoom: number;
  /** 落地用的平移量（CSS px）：使目标矩形中心与视口中心重合 */
  tx: number;
  ty: number;
}

/** 尺寸兜底：0 / 负数 / NaN 一律当成 1 个世界单位，避免除零把缩放算成 Infinity */
function safeSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * 计算「把某个世界矩形聚焦到视口中央」需要的缩放与平移。
 *
 * ⚠️ 返回 `null` 表示**不可计算，调用方应保持现状**（视口尺寸还没测量出来时
 * 就是这种情况）。返回一个「看起来没变」的结果更危险：`tx/ty` 会被写成 0，
 * 画布直接跳回世界原点。
 *
 * 这里是纯函数，组件只负责「测量世界矩形」和「应用结果」——
 * 聚焦的判据（死区、填充率、上限）全部集中在此，冒烟测试可以逐条断言。
 */
export function planFocus(input: FocusPlanInput): FocusPlan | null {
  const { viewportWidth: vw, viewportHeight: vh } = input;
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return null;

  const current = clampZoom(input.zoom);
  const width = safeSize(input.worldWidth);
  const height = safeSize(input.worldHeight);

  const screenWidth = width * current;
  const screenHeight = height * current;
  const inDeadZone =
    screenWidth >= vw * FOCUS_KEEP_RATIO_MIN &&
    screenWidth <= vw * FOCUS_KEEP_RATIO_MAX &&
    screenHeight >= vh * FOCUS_KEEP_RATIO_MIN &&
    screenHeight <= vh * FOCUS_KEEP_RATIO_MAX;

  // 不在死区：按「较小边也充满 FOCUS_FILL」定倍数，即整体完整可见且不留大片空白
  const fit = Math.min((vw * FOCUS_FILL) / width, (vh * FOCUS_FILL) / height);
  const zoom = inDeadZone ? current : clampZoom(Math.min(FOCUS_MAX_ZOOM, fit));

  const worldX = Number.isFinite(input.worldX) ? input.worldX : 0;
  const worldY = Number.isFinite(input.worldY) ? input.worldY : 0;

  return {
    zoom,
    tx: vw / 2 - (worldX + width / 2) * zoom,
    ty: vh / 2 - (worldY + height / 2) * zoom,
  };
}
