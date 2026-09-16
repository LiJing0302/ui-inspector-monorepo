import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Rect, VerifySource } from '@shared/verify';

import { clampWipeRatio, wipeClipPath, wipeRatioFromX, type OverlayCompare } from '../lib/compare';
import { pixelGridCellPx, pixelGridPhase, shouldUseCrispSampling } from '../lib/zoom';

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
  /** 当前选中的节点（帧内逻辑矩形）。缺省时不画选中框 */
  selection?: RasterSelection | null;
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
   * 对侧的同配对节点（设计稿选中 → 这里给 App 侧那一个，反之亦然）。
   *
   * 验收的核心动作是「同一个元素在两侧是否一致」，所以选中一侧时，
   * **另一侧的对应节点必须同时可见** —— 否则用户得靠肉眼在两块画布间找同一个元素，
   * 那正是这个工具要消灭的工作。
   */
  peers?: RasterSelection[];
  /**
   * 叠图比对参数。传入即表示「两帧已经叠在一处」（布局由 `.canvas.overlay` 负责），
   * 本层据此决定截图那张图怎么画、以及要不要画擦拭分隔线。
   *
   * ⚠️ 布局与绘制是**两个组件分别负责的**：`.canvas.overlay` 管位置，
   * 这里管观感。任何一边单独生效都会得到「图叠上了但看不出来」或反之。
   */
  overlay?: RasterOverlay | null;
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
 * 本层从下到上依次是**底图 → 像素格 → hover 环 → 选中框**：前两者必须在节点层**之下**
 * （节点层大面积透明，只在 hover / 选中时染色），像素格还要盖在底图上
 * （Figma 的 pixel grid 同样压在内容上）；两个框排在本层最上 —— 它们既压在格线上，
 * 又不会被底图遮住，且共用同一个坐标系，所以「框与格线重合」是自然结果。
 */
const FrameRaster: React.FC<FrameRasterProps> = ({
  viewportRef,
  tx,
  ty,
  zoom,
  sources,
  pixelGrid,
  selection,
  hover,
  peers,
  overlay,
}) => {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const boxes = useFrameRects(viewportRef, safeZoom);

  const bySource = useMemo(
    () => new Map(sources.map((item) => [item.source, item])),
    [sources],
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
   * `alignScale` 同样从实测反推（`worldWidth ÷ logicalWidth`），不由调用方再传一遍 ——
   * 同一套几何算两处，迟早在「哪边该乘 alignScale」上分叉。
   *
   * 两者**共用这一个换算**：一旦各写一份，「hover 环与选中框在同一个节点上是否严格重合」
   * 就变成了两个公式的巧合，而不是结构上的必然。
   */
  const [selectionBox, hoverBox, peerBoxes] = useMemo(() => {
    const toBox = (target: RasterSelection | null | undefined) => {
      if (!target) return null;
      const box = boxes.find((item) => item.source === target.source);
      const source = bySource.get(target.source);
      if (!box || !source || !(source.logicalWidth > 0)) return null;
      const scale = box.worldWidth / source.logicalWidth;
      return {
        left: tx + (box.worldX + target.rect.x * scale) * safeZoom,
        top: ty + (box.worldY + target.rect.y * scale) * safeZoom,
        width: target.rect.width * scale * safeZoom,
        height: target.rect.height * scale * safeZoom,
      };
    };
    return [
      toBox(selection),
      toBox(hover),
      // key 里带序号而不是只用 source：一侧节点可能对应对侧多个节点（1→N 匹配），
      // 只按 source 做 key 会让第二个框被 React 当成同一个元素而丢掉。
      (peers ?? []).flatMap((peer, index) => {
        const box = toBox(peer);
        return box
          ? [{ box, clipped: peer.clipped === true, key: `${peer.source}:${index}` }]
          : [];
      }),
    ];
  }, [selection, hover, peers, boxes, bySource, tx, ty, safeZoom]);

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
          轮廓随 selected 变化重算，但走的是纯算术：不测量、不二次渲染。 */}
      {selectionBox && (
        <div
          className={`raster-selection${selection?.clipped ? ' clipped' : ''}`}
          style={selectionBox}
        />
      )}

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
