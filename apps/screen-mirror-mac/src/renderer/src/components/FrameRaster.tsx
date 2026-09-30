import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Rect, VerifySource } from '@shared/verify';

import {
  clampWipeRatio,
  wipeClipPath,
  wipeRatioFromX,
  type OverlayCompare,
  type OverlayOffset,
} from '../lib/compare';
import { formatMeasure, type MeasureAxis, type MeasureLine } from '../lib/measure';
import { pixelGridCellPx, pixelGridPhase, shouldUseCrispSampling } from '../lib/zoom';
import type { RasterAnnotation } from '../lib/annotation';

/** 各帧底图的来源描述。世界坐标不在这里 —— 由 FrameRaster 自己测量，见 useFrameRects */
export interface RasterFrameSource {
  source: VerifySource;
  /** 底图地址（sm-asset://）。缺省时该帧不画底图，由 NodeCanvas 的占位块兜底 */
  imageUrl?: string;
  imageLabel: string;
  /** 该帧的逻辑宽度（未乘 alignScale），用于从图片真实像素反推导出倍率 */
  logicalWidth: number;
}

/**
 * 叠图比对的绘制参数。`null`（或不传）= 不进叠图，两帧照常并排。
 *
 * 为什么不把这些拆成散落的 props：它们**只在叠图下同时成立**，
 * 散着传就会出现「传了 opacity 却没传 compare」这种半套状态，
 * 而绘制分支只能猜当时是哪种模式。
 */
export interface RasterOverlay {
  compare: OverlayCompare;
  /** `compare === 'opacity'`：截图的透明度 */
  opacity: number;
  /** `compare === 'wipe'`：分割位置（左侧露设计稿的比例） */
  wipeRatio: number;
  /** 拖动分隔线时回调 —— 与工具栏滑块共用同一个状态，两条入口不会各拖各的 */
  onWipeRatioChange: (ratio: number) => void;
  /** 截图相对设计稿的整数逻辑像素偏移。 */
  offset: OverlayOffset;
  /** 直接拖拽截图或键盘微调时回调。 */
  onOffsetChange: (offset: OverlayOffset) => void;
}

/**
 * 选中框：给出**帧内逻辑矩形**，由 FrameRaster 换算成屏幕位置。
 *
 * 之所以传逻辑坐标而不是屏幕坐标：`alignScale`（R4 按宽对齐）与帧的世界坐标
 * 都只有 FrameRaster 知道（前者由实测反推、后者由测量得到）。调用方再算一遍
 * 屏幕位置等于把同一套几何实现两遍，迟早分叉 —— 这也是底图当初踩过的坑。
 */
export interface RasterSelection {
  source: VerifySource;
  /** 帧内逻辑坐标（与节点 `rect` 同一空间，**未乘** alignScale） */
  rect: Rect;
  /** 该节点已被 clipsContent 祖先裁掉 → 虚线淡化 */
  clipped?: boolean;
}

export interface RasterRegion extends RasterSelection {
  label: string;
  status: 'pass' | 'warning' | 'fail' | 'unknown';
  active?: boolean;
}

/**
 * 间距读数（选中项 ↔ 当前 hover 的那个之间的 x / y 差）。
 *
 * 几何由 `lib/measure` 出（纯函数，喂两个矩形即可断言），这里只负责换算到屏幕
 * 并画出来 —— 与各档框同层、同换算，理由也相同：挂在 `transform: scale()` 内部的话，
 * 线宽要写成 `1/zoom`，而读数的数字胶囊在高倍下会跟着糊。
 *
 * ⚠️ 带上 `source` 是必须的：线段坐标是**帧内逻辑坐标**，不带上帧号就没法换算
 * （两帧的世界原点与 alignScale 都不同）。也因此**只有两侧同帧时才有意义** ——
 * 跨帧量出来的数字是错的，调用方必须按来源分别计算（见 CanvasBoard.rasterMeasures）。
 */
export interface RasterMeasure {
  source: VerifySource;
  /**
   * 每条读数线自带 `extensions`（虚线延长段，可能为空 —— 见 lib/measure）：
   * 斜着排时其中一头接不到元素上，靠它接回去。通道仍然只有这一条 ——
   * 延长段是读数线自己的一部分，不是第二种读数。
   */
  lines: MeasureLine[];
  /**
   * 读数单位（2026-09-29 加）。`undefined` = 帧内逻辑单位（设计稿 px / App dp）。
   *
   * 读数口径切到「设计稿对齐 App」时是 `'px'`，值也已在 `lib/pixelProjection` 里换算过 ——
   * 画在数字旁边是必须的：同一块画布换个口径就换一把尺子，而胶囊上只有数字时，
   * 读者（或一张截图）无从分辨那是设计单位还是截图像素。
   */
  unit?: string;
}

/**
 * 「帧内逻辑坐标 → 屏幕坐标」的投影参数。
 *
 * `originX/originY` 已经把世界原点与平移算进去，`scale` 是「1 逻辑单位 = 几个 CSS px」
 * （含 alignScale 与 zoom）。于是换算只剩一次乘加，而**同一份投影被所有覆盖层共用** ——
 * 选中框 / hover 环 / 对侧框 / 间距读数各自复算一遍的话，「两个框画在同一个节点上是否
 * 严格重合」就变成两个公式的巧合（这正是底图当初踩过的坑，见 measureFrameBoxes 注释）。
 */
interface ScreenProjection {
  originX: number;
  originY: number;
  scale: number;
}

const toScreenX = (projection: ScreenProjection, x: number): number =>
  projection.originX + x * projection.scale;

const toScreenY = (projection: ScreenProjection, y: number): number =>
  projection.originY + y * projection.scale;

/**
 * 一条**帧内逻辑线段**（走向 + 沿轴两端 + 垂直轴落位）→ 屏幕样式。
 *
 * 读数线与它的虚线延长段共用这一个换算（延长段的 `at` 就是读数线那一端的坐标）——
 * 各写一遍的话，「延长段是否严格从读数线的端点长出来」就变成两个公式的巧合，
 * 而它们在屏幕上错开半像素会表现为「虚线没接上实线」。
 *
 * 只给沿轴那一维的长度，垂直那一维由 CSS 给（1px 的线，见 `--node-ring-w`）。
 * ⚠️ 走轴上必须写明是**哪条轴**：延长段垂直于所属读数线，两者轴不同。
 */
function segmentStyle(
  projection: ScreenProjection,
  axis: MeasureAxis,
  from: number,
  to: number,
  at: number,
): React.CSSProperties {
  const start = axis === 'x' ? toScreenX(projection, from) : toScreenY(projection, from);
  const end = axis === 'x' ? toScreenX(projection, to) : toScreenY(projection, to);
  const cross = axis === 'x' ? toScreenY(projection, at) : toScreenX(projection, at);
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return axis === 'x'
    ? { left: low, top: cross, width: high - low }
    : { left: cross, top: low, height: high - low };
}

/** 一帧在 `.canvas` 世界坐标里的位置与尺寸（逻辑单位，宽高已含 alignScale） */
export interface FrameBox {
  source: VerifySource;
  worldX: number;
  worldY: number;
  worldWidth: number;
  worldHeight: number;
}

/**
 * 测量各帧在 `.canvas` 世界坐标里的盒子。
 *
 * **为什么是「除以 zoom」而不是「减 tx」**：`.frame-content` 的 screen rect 同时含
 * 平移与缩放，而世界坐标只由布局决定 —— `(rect - viewport) / zoom` 把这两个量都消掉，
 * 于是**测一次就与 zoom 无关**。平移 / 缩放时不再重复测量，屏幕位置由
 * `tx + worldX × zoom` 纯算术推导，每帧稳定，不会因为测量滞后和节点层错半帧。
 *
 * 用测量而不是自己复算 flex 布局（padding / gap / label 撑宽都会影响帧的横向位置）：
 * 让 CSS 说了算，任何布局调整都不用回来改这个函数。
 *
 * ⚠️ 导出给 `CanvasViewport` 的聚焦逻辑复用：那里需要把「图层列表点中的节点」
 * 换算成世界矩形，用的必须是**同一套**帧坐标。各自实现一遍的话，底图 / 选中框 /
 * 聚焦三者迟早在 alignScale 或 padding 上分叉（这正是底图当初踩过的坑）。
 */
export function measureFrameBoxes(root: HTMLElement, zoom: number): FrameBox[] {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const viewport = root.getBoundingClientRect();
  return Array.from(root.querySelectorAll<HTMLElement>('.frame-content[data-frame]')).map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      source: (el.dataset.frame ?? 'design') as VerifySource,
      worldX: (rect.left - viewport.left) / safeZoom,
      worldY: (rect.top - viewport.top) / safeZoom,
      worldWidth: rect.width / safeZoom,
      worldHeight: rect.height / safeZoom,
    };
  });
}

interface FrameRasterProps {
  /**
   * `.canvas-viewport` 元素（transform 层）。只用来**测量**各帧的世界坐标，
   * 底图本身不挂在它下面 —— 那正是「放大后发糊」的根因，见本文件顶部注释。
   */
  viewportRef: React.RefObject<HTMLDivElement>;
  tx: number;
  ty: number;
  zoom: number;
  sources: RasterFrameSource[];
  /** 是否显示像素格（阈值判据在 lib/zoom.ts，由 CanvasViewport 统一算一次） */
  pixelGrid: boolean;
  /**
   * 当前选中的节点，**每侧最多一个**（帧内逻辑矩形）。空数组 = 都没选中。
   *
   * ⚠️ 是数组而不是单值：设计稿与截图的选中**互相独立**（2026-09-23 起），
   * 两侧可以各选一个、两个框同时在。同侧恒只有一个（`source` 唯一，所以 key 用 source 就够）。
   */
  selections?: RasterSelection[];
  /**
   * 当前 hover 的节点。与选中框同一套换算、同住屏幕空间 —— 它原先画在
   * `.node-overlay:hover` 上（transform 层内部），线宽得写成 1/zoom，
   * 高倍下糊成一条灰带；搬过来之后线宽就是屏幕上的线宽。
   *
   * ⚠️ 传给这里的必须是**原始命中**（浏览器判定的最深可命中节点，见 lib/selection）：
   * 单击现在也选命中本身，所以环画在谁身上、点下去就选中谁，不可能分叉。
   */
  hover?: RasterSelection | null;
  /**
   * 间距读数的**固定**另一端（⌘ 单击设的锚点）。与 `hover` 是两条通道：
   * hover 随光标走，锚点钉住不动 —— 读数固定时屏幕上必须有它，否则只剩一条
   * 不知道在量谁的线。
   *
   * 描边用 `--measure`（与读数同色，比选中橙深一档）：它天生就是「读数那一端」，
   * 与选中框（实线橙）、hover 环（虚线蓝）在颜色上就分得开，不需要新的记号体系。
   */
  anchors?: RasterSelection[];
  /**
   * 对侧的同配对节点（设计稿选中 → 这里给 App 侧那一个，反之亦然）。
   *
   * 验收的核心动作是「同一个元素在两侧是否一致」，所以选中一侧时，
   * **另一侧的对应节点必须同时可见** —— 否则用户得靠肉眼在两块画布间找同一个元素，
   * 那正是这个工具要消灭的工作。
   */
  peers?: RasterSelection[];
  /**
   * 「我正在核对的那一条匹配」涉及的**全部节点**（两侧都可能有，且可能是 N:M）。
   *
   * 与 `peers` 的区别在**来源**：`peers` 是「选中某一个节点后，对侧那个对应的」
   * —— 由选中项推导出来，永远成对出现；这里是用户在匹配列表里**显式挑中的一条匹配**，
   * 携带的是这条匹配两侧的完整节点集合（成组匹配会有好几个）。
   *
   * 两者不能合并成一条通道：`peers` 表达的是「这一对是同一个元素」，会让用户以为
   * 两侧节点数必然相等；而实情是文本聚合后的 N:M 组（3 个设计文本 ↔ 1 个 App 文本）。
   * 用同一种虚线画出来，N:M 那条就会被误读成「有 N 个对侧节点」而不是「这一组是 N:M」。
   *
   * 传入即表示「用户正在核对这一条」。它画在 hover 环 / 对侧框 / 选中框**之下**、
   * 像素格**之上**：一组框可能同时罩住好几个节点、范围远大于单点框，压在最下面
   * 才不会把「我当前选中的是这一个」那条橙线盖掉；而必须在像素格之上，
   * 否则它的半透明填充会被格线切成碎块。
   */
  matchHighlight?: RasterSelection[];
  /**
   * **选中项 ↔ 另一端**之间的间距读数（x / y 两个方向各一条）。不传则不画。
   * 另一端是**锚点（⌘ 钉住的）优先、否则当前 hover 的那个** —— 上层已经挑好，
   * 这里只管画。
   *
   * 它排在选中框**之上**：读数回答的是「我选中的那个与另一个元素差多少」，
   * 数字胶囊被任何一条描边压住都会变成「这数字在说谁」。
   *
   * 它由**选中态与 hover 推导**（不是用户显式挑的），所以没有自己的状态：
   * 两者之一消失，读数就跟着消失 —— 不会留下一条「不知道在量谁」的线。
   */
  measures?: RasterMeasure[];
  /**
   * 标注模式下**待配对**的那一组节点。
   *
   * 它必须与 `matchHighlight` 分成两条通道，而不是复用一条：两者的含义正好相反 ——
   * `matchHighlight` 是「这条已经配上了」（既成事实），这里是「我正要把这几个配起来」
   * （还没有结论）。共用一条通道就只能共用一种颜色，而用户在下标的过程中最需要分辨的
   * 恰恰是「我已经标过的」与「我刚点进来的」——混在一起会出现「点了没反应」的错觉
   * （其实是画上了，只是颜色跟旁边已提交的那些一样）。
   *
   * 画在最上层（在选中框之上）：待配对的节点通常只有几个、范围小，
   * 且它带着「请再点下一步」的意图 —— 被任何一层盖住都会让「我刚点了什么」变得不确定。
   */
  pendingHighlight?: RasterSelection[];
  /** 验收引擎识别出的内容块边界；只读展示，不参与节点命中。 */
  regions?: RasterRegion[];
  /**
   * 叠图比对参数。传入即表示「两帧已经叠在一处」（布局由 `.canvas.overlay` 负责），
   * 本层据此决定截图那张图怎么画、以及要不要画擦拭分隔线。
   *
   * ⚠️ 布局与绘制是**两个组件分别负责的**：`.canvas.overlay` 管位置，
   * 这里管观感。任何一边单独生效都会得到「图叠上了但看不出来」或反之。
   */
  overlay?: RasterOverlay | null;
  /** 屏幕空间标注，避免随着画布 transform 被二次光栅化。 */
  annotations?: RasterAnnotation[];
}

/** 世界坐标的比较容差：getBoundingClientRect 返回浮点，需要挡住无意义的重测 */
const EPSILON = 0.05;

const sameBoxes = (a: FrameBox[], b: FrameBox[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((box, index) => {
    const other = b[index];
    return (
      box.source === other.source &&
      Math.abs(box.worldX - other.worldX) < EPSILON &&
      Math.abs(box.worldY - other.worldY) < EPSILON &&
      Math.abs(box.worldWidth - other.worldWidth) < EPSILON &&
      Math.abs(box.worldHeight - other.worldHeight) < EPSILON
    );
  });
};

/**
 * 测量各帧的盒子，并在世界坐标不变时**保持引用稳定** ——
 * 否则每次渲染都会新建数组，依赖它的 memo 全部失效。
 *
 * 无依赖：每次渲染后重新对账。世界坐标不变时 sameBoxes 拦住，不会触发二次渲染。
 */
function useFrameRects(viewportRef: React.RefObject<HTMLDivElement>, zoom: number): FrameBox[] {
  const [boxes, setBoxes] = useState<FrameBox[]>([]);

  useLayoutEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    const next = measureFrameBoxes(root, zoom);
    setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
  });

  return boxes;
}

interface RasterImageProps {
  box: FrameBox;
  source: RasterFrameSource;
  tx: number;
  ty: number;
  zoom: number;
  /**
   * 叠图时追加的绘制样式（透明度 / 混合模式 / 裁剪）。
   *
   * 与定位样式分开传，是因为两者的**归属不同**：left/top/width/height 是几何，
   * 必须与选中框、节点层同源；而这里的每一项都只影响「这层图怎么画」。
   * 混进几何里迟早会有人以为改 opacity 也要动世界坐标。
   */
  overlayStyle?: React.CSSProperties | null;
}

/** 单帧底图：**按最终屏幕尺寸**布局，采样由 data-crisp 决定 */
const RasterImage: React.FC<RasterImageProps> = ({ box, source, tx, ty, zoom, overlayStyle }) => {
  const imageRef = useRef<HTMLImageElement>(null);
  const [exportScale, setExportScale] = useState(1);

  /**
   * 导出倍率 = 源图真实像素宽 ÷ 逻辑宽度（Figma 侧的 `exportScale`，样本为 2）。
   *
   * 不从 IPC 元数据取，而是从**已加载的图片**反推：图片真实像素才是唯一事实，
   * 元数据与文件不一致时（换过导入版本、截图被外部工具重采样）会把采样阈值算错。
   */
  const syncExportScale = useCallback((): void => {
    const el = imageRef.current;
    if (!el || !el.naturalWidth || !source.logicalWidth) return;
    setExportScale(el.naturalWidth / source.logicalWidth);
  }, [source.logicalWidth]);

  // 命中缓存的图片不会再触发 onLoad，挂载 / 换图后补一次探测
  useEffect(syncExportScale, [syncExportScale, source.imageUrl]);

  // 对齐系数从实测反推（worldWidth = logicalWidth × alignScale），不必再传一遍
  const alignScale = source.logicalWidth > 0 ? box.worldWidth / source.logicalWidth : 1;
  const crisp = shouldUseCrispSampling(zoom, alignScale, exportScale);

  return (
      <img
        ref={imageRef}
        data-raster-source={source.source}
        className="raster-image"
      data-crisp={crisp ? 'true' : 'false'}
      src={source.imageUrl}
      alt={source.imageLabel}
      draggable={false}
      onLoad={syncExportScale}
      style={{
        left: tx + box.worldX * zoom,
        top: ty + box.worldY * zoom,
        width: box.worldWidth * zoom,
        height: box.worldHeight * zoom,
        ...overlayStyle,
      }}
    />
  );
};

/**
 * 屏幕空间光栅层：底图 + 像素格。
 *
 * ## 为什么必须离开 transform 层
 *
 * 原先底图与像素格都挂在 `.canvas-viewport`（`transform: translate() scale()`）内部。
 * 只要祖先带 scale，浏览器就把整棵子树**光栅化成一张位图**，再由合成器把位图拉大 ——
 * 而 CSS 只能影响「元素自己画自己」这一步，管不到合成器的纹理重采样：
 *
 * - `image-rendering: pixelated` 作用在「750px 源图 → 375px 布局盒」这**一次缩小**上；
 *   真正把它放大到 3000px 的是合成器，走双线性插值 → 放大后依旧糊。
 * - 像素格的线宽靠 `--iz` 反向补偿成 `1/zoom` 逻辑 px，zoom = 8 时是 0.125px ——
 *   光栅化覆盖率只有 12.5%，画出来本身就是一条浅灰带，再被合成器拉伸 → 线宽不齐。
 *
 * 解法不是换渲染器，而是**把这两层搬到屏幕空间按最终尺寸绘制**：光栅化直接发生在
 * 目标分辨率上，`pixelated` 与 1px 线宽都落在该落的地方。canvas 与 three.js 在此
 * 都不是必要条件（`NearestFilter` 与 `pixelated` 是同一个采样决策）。
 *
 * ## 本层内容与层序
 *
 * `.canvas-scroll` → `.raster-layer`（本层，z=1）→ `.canvas-viewport`（节点层，z=2）。
 * 本层从下到上依次是**底图 → 像素格 → 匹配高亮组 → hover 环 → 对侧框 → 选中框 →
 * 间距延长段 → 间距读数**：
 * 底图与像素格必须在节点层**之下**（节点层大面积透明，只在 hover / 选中时染色），
 * 像素格还要盖在底图上（Figma 的 pixel grid 同样压在内容上）；四个框排在本层最上 ——
 * 它们既压在格线上，又不会被底图遮住，且共用同一个坐标系，所以「框与格线重合」是自然结果。
 * 四个框之间的次序是「范围大的在下」：匹配高亮组可能罩住一组节点，压在最下面；
 * 选中框最精确也最「当前」，所以最上面。间距读数排在选中框**之上**：
 * 它量的是「选中的那个 ↔ 另一个」的关系，读数胶囊被描边压住就没法读了。
 * 而**延长段排在读数之下**（两者同色，虚线的端点必须接在实线的端点上，不能被实线盖出缺口）。
 */
const FrameRaster: React.FC<FrameRasterProps> = ({
  viewportRef,
  tx,
  ty,
  zoom,
  sources,
  pixelGrid,
  selections,
  hover,
  anchors: measureAnchors,
  peers,
  matchHighlight,
  pendingHighlight,
  regions,
  overlay,
  measures,
  annotations,
}) => {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const boxes = useFrameRects(viewportRef, safeZoom);

  const bySource = useMemo(
    () => new Map(sources.map((item) => [item.source, item])),
    [sources],
  );

  /**
   * 某一帧的屏幕投影。**所有覆盖层共用的唯一换算**（见 ScreenProjection 的注释）：
   * 帧的世界原点来自实测，alignScale 从「实测宽度 ÷ 逻辑宽度」反推 —— 两者都只有这里知道，
   * 调用方再算一遍就是同一套几何写两遍。
   *
   * 帧测不到（还没挂载 / 逻辑宽度缺失）时返回 null，调用方各自跳过即可。
   */
  const projectionOf = useCallback(
    (source: VerifySource): ScreenProjection | null => {
      const box = boxes.find((item) => item.source === source);
      const frame = bySource.get(source);
      if (!box || !frame || !(frame.logicalWidth > 0)) return null;
      return {
        originX: tx + box.worldX * safeZoom,
        originY: ty + box.worldY * safeZoom,
        scale: (box.worldWidth / frame.logicalWidth) * safeZoom,
      };
    },
    [boxes, bySource, tx, ty, safeZoom],
  );

  /**
   * 叠图时**只给截图那张图**追加样式。
   *
   * 方向不能反：设计稿是基准（像素格相位、alignScale 都以它为准），
   * 让它保持原样，差异才是「截图相对设计稿偏了多少」——反过来则每次都要在脑子里做一次逆变换。
   */
  const appOverlayStyle = useMemo<React.CSSProperties | null>(() => {
    if (!overlay) return null;
    if (overlay.compare === 'opacity') return { opacity: overlay.opacity };
    // difference 是逐通道相减取绝对值：完全相同 → 黑；偏一点 → 立刻发亮。
    // 找 1px 错位比肉眼来回切图快得多。
    if (overlay.compare === 'difference') return { mixBlendMode: 'difference' };
    return { clipPath: wipeClipPath(overlay.wipeRatio) };
  }, [overlay]);

  /**
   * 擦拭分隔线的屏幕位置。
   *
   * 横向基准取**设计稿帧**：叠图下两帧同原点、同宽（截图帧已按宽对齐），用哪一个数值
   * 都一样，但必须与 `handleWipeDown` 的换算取同一个 —— 两处各取一个帧，
   * 迟早会出现「拖到 50% 但线画在 47%」。
   *
   * 纵向取两帧的**并集**：截图帧常比设计稿高，只按设计稿画的话，线会在半空中断掉，
   * 而下面那截恰恰是只有截图才有内容的地方 —— 分割线在那里断掉看起来像图层坏了。
   */
  const wipeLine = useMemo(() => {
    if (overlay?.compare !== 'wipe') return null;
    const anchor = boxes.find((item) => item.source === 'design');
    const visible = boxes.filter((item) => bySource.get(item.source)?.imageUrl);
    if (!anchor || visible.length === 0) return null;
    const top = Math.min(...visible.map((item) => item.worldY));
    const bottom = Math.max(...visible.map((item) => item.worldY + item.worldHeight));
    const ratio = clampWipeRatio(overlay.wipeRatio);
    return {
      left: tx + (anchor.worldX + anchor.worldWidth * ratio) * safeZoom,
      top: ty + top * safeZoom,
      height: (bottom - top) * safeZoom,
    };
  }, [overlay, boxes, bySource, tx, ty, safeZoom]);

  /**
   * 拖分隔线。
   *
   * 换算基准取 `.canvas-viewport`（transform 层）的 rect：它已经带上了
   * translate + scale，所以「屏幕 x − 层左边界」正好等于「世界 x × zoom」，
   * 不必再自己乘一遍 —— 自己乘就会在缩放时与节点层错开。
   *
   * 拖拽期间该层不会移动（不是在平移画布），所以起始 rect 可以只取一次。
   */
  const handleWipeDown = useCallback(
    (event: React.MouseEvent) => {
      if (!overlay) return;
      // 拦住冒泡：否则 .canvas-scroll 会把这串事件当成平移，变成「拖分隔线顺带平移画布」
      event.stopPropagation();
      event.preventDefault();
      const layer = viewportRef.current;
      if (!layer) return;
      const rect = layer.getBoundingClientRect();
      const box = measureFrameBoxes(layer, safeZoom).find((item) => item.source === 'design');
      if (!box) return;

      const move = (ev: MouseEvent) => {
        const ratio = wipeRatioFromX({
          localX: ev.clientX - rect.left,
          frameWorldX: box.worldX,
          frameWorldWidth: box.worldWidth,
          zoom: safeZoom,
        });
        if (ratio !== null) overlay.onWipeRatioChange(ratio);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [overlay, safeZoom, viewportRef],
  );

  const cell = pixelGridCellPx(safeZoom);

  /**
   * 相位锁在**设计稿帧的原点**上：设计稿是基准（alignScale 恒为 1），
   * 它的第 k 个逻辑像素边界正好落在世界坐标 `designWorldX + k` 处。
   * 锁世界原点 (0,0) 是错的 —— `.canvas` 有 64px 左内边距，格子会整体错开 8 格。
   */
  const anchor = boxes.find((box) => box.source === 'design');
  const phaseX = pixelGridPhase(tx + (anchor?.worldX ?? 0) * safeZoom, cell);
  const phaseY = pixelGridPhase(ty + (anchor?.worldY ?? 0) * safeZoom, cell);

  /**
   * 选中框 / hover 环的屏幕矩形。换算式与底图**完全一致**：
   *
   * ```
   * 世界坐标 = 帧世界原点 + 帧内逻辑坐标 × alignScale
   * 屏幕坐标 = tx/ty + 世界坐标 × zoom
   * ```
   *
   * 两个量都来自 `projectionOf`（alignScale 由「实测宽度 ÷ 逻辑宽度」反推，不由调用方再传）——
   * 各档框**共用这一个换算**：一旦各写一份，「hover 环与选中框在同一个节点上是否严格重合」
   * 就变成了两个公式的巧合，而不是结构上的必然。
   */
  const [selectionBoxes, hoverBox, anchorBoxes, peerBoxes, matchBoxes, pendingBoxes, regionBoxes] =
    useMemo(() => {
    const toBox = (target: RasterSelection | null | undefined) => {
      if (!target) return null;
      const projection = projectionOf(target.source);
      if (!projection) return null;
      return {
        left: toScreenX(projection, target.rect.x),
        top: toScreenY(projection, target.rect.y),
        width: target.rect.width * projection.scale,
        height: target.rect.height * projection.scale,
      };
    };
    return [
      // 选中框：**每侧最多一个**（同侧只会有一个，所以 key 用 source 就唯一 —— 与
      // 下面几组不同，那些一侧可能有多个节点，序号必须进 key）
      (selections ?? []).flatMap((target) => {
        const box = toBox(target);
        return box
          ? [{ box, clipped: target.clipped === true, key: target.source }]
          : [];
      }),
      toBox(hover),
      (measureAnchors ?? []).flatMap((target) => {
        const box = toBox(target);
        return box ? [{ box, clipped: target.clipped === true, key: target.source }] : [];
      }),
      // key 里带序号而不是只用 source：一侧节点可能对应对侧多个节点（1→N 匹配），
      // 只按 source 做 key 会让第二个框被 React 当成同一个元素而丢掉。
      (peers ?? []).flatMap((peer, index) => {
        const box = toBox(peer);
        return box
          ? [{ box, clipped: peer.clipped === true, key: `${peer.source}:${index}` }]
          : [];
      }),
      // 同理：一条匹配可能两侧各好几个节点，序号是 key 的一部分
      (matchHighlight ?? []).flatMap((item, index) => {
        const box = toBox(item);
        return box
          ? [{ box, clipped: item.clipped === true, key: `${item.source}:${index}` }]
          : [];
      }),
      // 待配对组同样是「可能有几个」，序号照旧参与 key
      (pendingHighlight ?? []).flatMap((item, index) => {
        const box = toBox(item);
        return box
          ? [{ box, clipped: item.clipped === true, key: `${item.source}:${index}` }]
          : [];
      }),
      (regions ?? []).flatMap((item, index) => {
        const box = toBox(item);
        return box ? [{ box, label: item.label, status: item.status, active: item.active, key: `${item.source}:region:${index}` }] : [];
      }),
    ];
  }, [
    selections,
    hover,
    measureAnchors,
    peers,
    matchHighlight,
    pendingHighlight,
    regions,
    projectionOf,
  ]);

  const annotationBoxes = useMemo<Array<RasterAnnotation & { style: React.CSSProperties }>>(() => {
    return (annotations ?? []).flatMap((annotation) => {
      const projection = projectionOf(annotation.source);
      if (!projection) return [];
      const startX = toScreenX(projection, annotation.start.x);
      const startY = toScreenY(projection, annotation.start.y);
      const endX = toScreenX(projection, annotation.end.x);
      const endY = toScreenY(projection, annotation.end.y);
      if (annotation.kind === 'rect') {
        return [
          {
            ...annotation,
            style: {
              left: Math.min(startX, endX),
              top: Math.min(startY, endY),
              width: Math.abs(endX - startX),
              height: Math.abs(endY - startY),
            } satisfies React.CSSProperties,
          },
        ];
      }
      const dx = endX - startX;
      const dy = endY - startY;
      return [
        {
          ...annotation,
          style: {
            left: startX,
            top: startY,
            width: Math.max(1, Math.hypot(dx, dy)),
            height: 2,
            transform: `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI}deg)`,
          } satisfies React.CSSProperties,
        },
      ];
    });
  }, [annotations, projectionOf]);

  /**
   * 间距读数线的屏幕几何。
   *
   * 输入是 `lib/measure` 出的**帧内逻辑线段**（谁跟谁差多少是纯几何，与缩放无关），
   * 这里只做一次投影 —— 与各档框同一个 `projectionOf`，所以读数线的端点必然落在
   * 对应节点框的边上，不会因为 alignScale 各算一遍而错开。
   *
   * 线的粗细 / 端部刻度 / 数字胶囊都写在 CSS 里（`.raster-measure`）：这里只说「画在哪」。
   *
   * `unit` 拼在数字后面（口径切到物理像素时是 `px`）：同一块画布换个口径就换尺子，
   * 只有数字时读者分不清那是设计单位还是截图像素。
   */
  const measureLines = useMemo(() => {
    return (measures ?? []).flatMap((item) => {
      if (item.lines.length === 0) return [];
      const projection = projectionOf(item.source);
      if (!projection) return [];
      return item.lines.map((line, index) => ({
        key: `${item.source}-${line.axis}-${line.kind}-${index}`,
        axis: line.axis,
        label: formatMeasure(line.value) + (item.unit ? ` ${item.unit}` : ''),
        style: segmentStyle(projection, line.axis, line.from, line.to, line.at),
      }));
    });
  }, [measures, projectionOf]);

  /**
   * 虚线延长段的屏幕几何 —— 「读数线悬空的那一头」接回元素边上的那一段
   * （几何见 `lib/measure#MeasureExtension`，这里同样只做投影）。
   *
   * 与读数线共用 `segmentStyle`，所以两者的端点严格重合（虚线的起点 = 实线的端点）。
   * 它**没有**数字胶囊与端点刻度：这一段的长度不表示任何量，它只说明读数对着元素的哪条边 ——
   * 给它加读数会让「量的是哪两条边」变成两个数字之间的猜谜。
   */
  const measureExtensions = useMemo(() => {
    return (measures ?? []).flatMap((item) => {
      const projection = projectionOf(item.source);
      if (!projection) return [];
      return item.lines.flatMap((line, index) =>
        line.extensions.map((extension, order) => ({
          key: `${item.source}-${line.axis}-${line.kind}-${index}-ext${order}`,
          axis: extension.axis,
          style: segmentStyle(projection, extension.axis, extension.from, extension.to, extension.at),
        })),
      );
    });
  }, [measures, projectionOf]);

  return (
    <div className={`raster-layer${pixelGrid ? ' pixel-grid-on' : ''}`} aria-hidden="true">
      {boxes.map((box) => {
        const source = bySource.get(box.source);
        if (!source?.imageUrl) return null;
        return (
          <RasterImage
            key={box.source}
            box={box}
            source={source}
            tx={tx}
            ty={ty}
            zoom={safeZoom}
            // 只给截图那张叠加图样式，见 appOverlayStyle 的注释
            overlayStyle={box.source === 'app' ? appOverlayStyle : null}
          />
        );
      })}

      {/* 像素格铺满**整个视口**（不再局限在帧内），格距与相位由内联样式给出 ——
          CSS 没有数值比较，也算不出相位。 */}
      <div
        className="pixel-grid"
        style={{
          backgroundSize: `${cell}px ${cell}px`,
          backgroundPosition: `${phaseX}px ${phaseY}px`,
        }}
      />

      {regionBoxes.map((item) => (
        <div key={item.key} className={`raster-region ${item.status}${item.active ? ' active' : ''}`} style={item.box}>
          <span>{item.label}</span>
        </div>
      ))}

      {/* 「正在核对的那一条匹配」的全部节点（两侧、可能 N:M）。压在 hover / 对侧 /
          选中三档之下：它罩住的范围通常更大，画在上面会把精确的单点框盖掉。
          但它必须在像素格之上 —— 半透明填充被格线切碎就看不出「这是一组」了。 */}
      {matchBoxes.map((item) => (
        <div
          key={item.key}
          className={`raster-match${item.clipped ? ' clipped' : ''}`}
          style={item.box}
        />
      ))}

      {/* hover 环：**下一次单击必然选中的那个节点**（就是光标底下的原始命中 ——
          单击选命中本身，两者同一个节点，见 lib/selection）。
          虚线以区别于实线的选中框。
          排在像素格之上、选中框之下：两者指向同一个节点时，实线压在虚线上，
          用户看到的是「已经选中的那个」，而不是互相打架的两条边。 */}
      {hoverBox && <div className={`raster-hover${hover?.clipped ? ' clipped' : ''}`} style={hoverBox} />}

      {/* 对侧配对节点：与选中框、hover 环共用同一个 toBox 换算，所以
          「设计稿选中框」与「App 对侧框」在各自帧内是同一套几何，不会各偏一点。 */}
      {peerBoxes.map((peer) => (
        <div
          key={peer.key}
          className={`raster-peer${peer.clipped ? ' clipped' : ''}`}
          style={peer.box}
        />
      ))}

      {/* 选中框排在最后 = 压在像素格与 hover 环之上。位置/尺寸是最终 CSS px，
          线宽固定 1 CSS px（`--node-ring-w`）且**不做任何反向补偿** —— 本层已在屏幕空间。
          轮廓随 selections 变化重算，但走的是纯算术：不测量、不二次渲染。
          ⚠️ **每侧各一个**（两个框分属两帧，正常情况下不会叠在一起）：设计稿与截图的
          选中互相独立，点 App 侧不会把设计稿那个框收掉。 */}
      {selectionBoxes.map((item) => (
        <div
          key={item.key}
          className={`raster-selection${item.clipped ? ' clipped' : ''}`}
          style={item.box}
        />
      ))}

      {/* 间距锚点框：与读数**同色**，排在读数的紧前面 —— 它标的是「读数另一端是谁」，
          被选中框压住会看不清是哪个节点，压住读数又把数字盖掉。 */}
      {anchorBoxes.map((item) => (
        <div
          key={item.key}
          className={`raster-anchor${item.clipped ? ' clipped' : ''}`}
          style={item.box}
        />
      ))}

      {/* 虚线延长段：读数线悬空的那一头接回元素边上（Figma 的 extension line）。
          排在读数线**之前** = 压在它下面：实线必须在端点处连着，不能反过来被虚线压住。
          ⚠️ 只有「端点没贴到元素」的那一头才有一条，两头都贴住时一条都不画。 */}
      {measureExtensions.map((item) => (
        <div
          key={item.key}
          className={`raster-measure-lead axis-${item.axis}`}
          style={item.style}
        />
      ))}

      {/* 间距读数（选中项 ↔ 另一端）：压在选中框**之上** —— 它回答的是
          「我选中的这个与另一个元素差多少」，数字胶囊被任何一条描边压住都会变成
          「这数字在说谁」。⚠️ 端点与各档框共用同一个投影，所以读数线必然贴着节点边。 */}
      {measureLines.map((item) => (
        <div key={item.key} className={`raster-measure axis-${item.axis}`} style={item.style}>
          <span>{item.label}</span>
        </div>
      ))}

      {annotationBoxes.map((item) => (
        <div
          key={item.id}
          className={`raster-annotation raster-annotation-${item.kind}`}
          style={item.style}
        />
      ))}

      {/* 待配对组（标注模式）：压在选中框之上。理由见 `pendingHighlight` 的注释 ——
          它是唯一一条「请你继续操作」的提示，被盖住就等于没有反馈。 */}
      {pendingBoxes.map((item) => (
        <div
          key={item.key}
          className={`raster-pending${item.clipped ? ' clipped' : ''}`}
          style={item.box}
        />
      ))}

      {/* 擦拭分隔线。排在**最上**，与选中框同理：它既是「哪边是设计稿」的读数，
          又是唯一的拖拽把手 —— 被任何一层盖住都会变成「看得见却拖不动」。
          pointer-events 在本层是 none，所以这里必须自己开 auto（见 verify.css）。 */}
      {wipeLine && (
        <div
          className="raster-wipe"
          style={{ left: wipeLine.left, top: wipeLine.top, height: wipeLine.height }}
          onMouseDown={handleWipeDown}
        >
          <span className="raster-wipe-grip" />
        </div>
      )}
    </div>
  );
};

export default FrameRaster;
