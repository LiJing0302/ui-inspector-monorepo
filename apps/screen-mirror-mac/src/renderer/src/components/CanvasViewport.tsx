import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { Rect, VerifySource } from '@shared/verify';

import { ZOOM_EPSILON, clampZoom, planFocus, shouldShowPixelGrid } from '../lib/zoom';
import FrameRaster, {
  measureFrameBoxes,
  type RasterFrameSource,
  type RasterOverlay,
  type RasterSelection,
} from './FrameRaster';

/** 滚轮每单位 deltaY 的缩放灵敏度（指数曲线，兼顾鼠标与触控板） */
const WHEEL_SENSITIVITY = 0.0015;
/** 拖拽超过该像素才算平移，否则视为点击（避免误吞节点选中） */
const DRAG_THRESHOLD = 4;

/** 命令式接口：目前只有图层列表需要的「聚焦到某个节点」 */
export interface CanvasViewportHandle {
  /** 把某帧内的**逻辑矩形**平移/缩放到视口中央（未知帧或尺寸不可测时静默不动） */
  focusRect: (target: { source: VerifySource; rect: Rect }) => void;
}

interface CanvasViewportProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** 各帧底图来源。底图在**屏幕空间**绘制，见 FrameRaster */
  frames: RasterFrameSource[];
  /** 当前选中的节点。选中框同样在屏幕空间绘制，线宽不随缩放变化 */
  selection?: RasterSelection | null;
  /**
   * 当前 hover 的节点。与选中框同住屏幕空间、共用同一套换算 ——
   * 原先画在 `.node-overlay:hover` 上（transform 层内部），高倍下糊成灰带。
   * 传入的必须是**原始命中**（光标底下最深可命中节点），见 lib/selection。
   */
  hover?: RasterSelection | null;
  /** 对侧同配对节点（选中一侧时另一侧同步高亮），见 FrameRaster */
  peers?: RasterSelection[];
  /**
   * 叠图参数。传入即进入叠图：`.canvas` 加 `overlay` 类让两帧叠在一处，
   * 绘制细节交给 FrameRaster（位置与观感分属两层，任一层单独生效都不成立）。
   */
  overlay?: RasterOverlay | null;
  children: React.ReactNode;
}

/**
 * 画布视口：统一承载「设计稿 + 截图」两个画布的缩放与平移。
 *
 * 采用「整层 transform: translate() scale()」的 pan/zoom 模型（类 Figma）：
 * - 滚轮缩放以【光标为锚点】——缩放后光标下的画布内容点保持不动；
 * - 工具栏缩放以【视口中心】为锚点；
 * - 平移以鼠标左键拖拽实现。
 *
 * 该模型不依赖原生滚动条，因此无论内容是否超出视口都能精确锚定光标，
 * 700+ 节点连续缩放仍流畅（GPU 复合，与节点数无关）。
 * 节点边框通过祖先 `--iz`(=1/zoom) 反向补偿，缩放后仍是 1px 实线。
 *
 * ⚠️ 这个 transform 层**只能装节点**：任何需要像素级精确的东西（底图、像素格）
 * 一旦挂进来，就会先被光栅化成位图、再被合成器拉伸放大 —— CSS 在那一层已经退场，
 * `image-rendering` 之类的声明都管不到。所以底图与像素格走同级的 `FrameRaster`，
 * 在屏幕空间按最终尺寸绘制（层序见 CanvasBoard / verify.css 的 z-index 注释）。
 *
 * 对外还暴露一个命令式句柄（`focusRect`）：图层列表点中某个节点时，把视口移到它上面。
 * 判据与算术都在 `lib/zoom.ts` 的 `planFocus` 里（纯函数，可测），这里只负责
 * 「测量世界矩形」与「把结果落地成 tx / ty / zoom」。
 */
const CanvasViewport = forwardRef<CanvasViewportHandle, CanvasViewportProps>(
  ({ zoom, onZoomChange, frames, selection, hover, peers, overlay, children }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [tx, setTx] = useState(0);
    const [ty, setTy] = useState(0);
    const [panning, setPanning] = useState(false);
    const [natural, setNatural] = useState({ w: 0, h: 0 });

    // 最新值镜像，供原生（非 React）事件监听闭包读取
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const txRef = useRef(tx);
    txRef.current = tx;
    const tyRef = useRef(ty);
    tyRef.current = ty;
    const onZoomChangeRef = useRef(onZoomChange);
    onZoomChangeRef.current = onZoomChange;
    const framesRef = useRef(frames);
    framesRef.current = frames;
    const prevZoomRef = useRef(zoom);
    // 滚轮缩放的光标锚点（视口内像素坐标 + 缩放前 zoom），缩放提交后落地到 translate
    const wheelAnchorRef = useRef<{ cx: number; cy: number; oldZoom: number } | null>(null);
    /**
     * 待落地的聚焦结果（图层列表点击）。
     *
     * 存在的理由：聚焦往往同时改 zoom 与 tx/ty，而 zoom 的 `useLayoutEffect` 会按
     * **锚点公式**重算 tx —— 两者在同一次更新里会互相覆盖。所以把结果暂存到这里，
     * 由那个 effect 优先消费，落地后立即清空（过期请求绝不二次生效）。
     */
    const pendingFocusRef = useRef<ReturnType<typeof planFocus>>(null);
    // 拖拽发生后，抑制紧随其后的 click，避免误选中节点
    const suppressClickRef = useRef(false);
    const didInitRef = useRef(false);

    // 测量内容自然尺寸（transform 不影响布局盒，offsetWidth 即自然尺寸）
    useEffect(() => {
      const el = contentRef.current;
      if (!el) return;
      const measure = () => setNatural({ w: el.offsetWidth, h: el.offsetHeight });
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // 首次拿到自然尺寸时，将内容居中
    useLayoutEffect(() => {
      if (didInitRef.current || natural.w === 0) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setTx((rect.width - natural.w * zoom) / 2);
      setTy((rect.height - natural.h * zoom) / 2);
      didInitRef.current = true;
    }, [natural, zoom]);

    /**
     * 视口尺寸与各帧世界盒 → 世界矩形 → 聚焦结果。
     *
     * 与 FrameRaster / NodeCanvas 共用 `measureFrameBoxes`：帧的世界原点、帧内
     * alignScale 全部来自这一次测量，不另算一遍（同一套几何算两处迟早在
     * 「哪边该乘 alignScale」上分叉）。
     */
    useImperativeHandle(
      ref,
      () => ({
        focusRect: ({ source, rect }) => {
          const container = containerRef.current;
          const root = contentRef.current;
          if (!container || !root) return;

          const box = measureFrameBoxes(root, zoomRef.current).find(
            (item) => item.source === source,
          );
          const frame = framesRef.current.find((item) => item.source === source);
          if (!box || !frame || !(frame.logicalWidth > 0)) return;

          // 帧内逻辑矩形 × alignScale(= 实测帧宽 ÷ 逻辑宽，与底图同一处反推) → 世界矩形
          const alignScale = box.worldWidth / frame.logicalWidth;
          const viewport = container.getBoundingClientRect();
          const plan = planFocus({
            zoom: zoomRef.current,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            worldX: box.worldX + rect.x * alignScale,
            worldY: box.worldY + rect.y * alignScale,
            worldWidth: rect.width * alignScale,
            worldHeight: rect.height * alignScale,
          });
          if (!plan) return;

          // 倍数不变时父级的 setZoom 会被 React 直接 bail out（值相同不重渲染），
          // 下面的 layout effect 也就不会跑 —— 平移必须当场落地。
          if (Math.abs(plan.zoom - zoomRef.current) < ZOOM_EPSILON) {
            setTx(plan.tx);
            setTy(plan.ty);
            return;
          }
          pendingFocusRef.current = plan;
          onZoomChangeRef.current(plan.zoom);
        },
      }),
      [],
    );

    // 缩放变化后：聚焦结果优先，其次滚轮以光标为锚点，最后工具栏以视口中心为锚点
    // 核心公式（保持锚点内容不动）：tx' = anchorX - ((anchorX - tx)/oldZoom) * zoom
    useLayoutEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const pending = pendingFocusRef.current;
      pendingFocusRef.current = null;
      if (pending && Math.abs(pending.zoom - zoom) < ZOOM_EPSILON) {
        // 聚焦自己算好了居中位置，不再叠加锚点公式
        setTx(pending.tx);
        setTy(pending.ty);
        prevZoomRef.current = zoom;
        return;
      }

      const oldZoom = prevZoomRef.current || zoom;
      let anchorX: number;
      let anchorY: number;
      if (wheelAnchorRef.current) {
        anchorX = wheelAnchorRef.current.cx;
        anchorY = wheelAnchorRef.current.cy;
        wheelAnchorRef.current = null;
      } else {
        const rect = el.getBoundingClientRect();
        anchorX = rect.width / 2;
        anchorY = rect.height / 2;
      }
      const newTx = anchorX - ((anchorX - txRef.current) / oldZoom) * zoom;
      const newTy = anchorY - ((anchorY - tyRef.current) / oldZoom) * zoom;
      setTx(newTx);
      setTy(newTy);
      prevZoomRef.current = zoom;
    }, [zoom]);

    // 原生非被动 wheel 监听，才能 preventDefault 阻止页面滚动
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const oldZoom = zoomRef.current;
        const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY);
        const next = clampZoom(oldZoom * factor);
        if (next === oldZoom) return;
        // 记录光标锚点，留给缩放提交的布局阶段落地（translate 与 zoom 同步更新）
        wheelAnchorRef.current = { cx, cy, oldZoom };
        onZoomChangeRef.current(next);
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, []);

    const onMouseDown = (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const startTx = txRef.current;
      const startTy = tyRef.current;
      let moved = false;
      setPanning(true);

      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true;
        if (moved) {
          setTx(startTx + dx);
          setTy(startTy + dy);
        }
      };
      const up = () => {
        if (moved) suppressClickRef.current = true;
        setPanning(false);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };

    // 拖拽产生的 click 在冒泡到节点前拦截
    const onClickCapture = (e: React.MouseEvent) => {
      if (suppressClickRef.current) {
        e.stopPropagation();
        e.preventDefault();
        suppressClickRef.current = false;
      }
    };

    const inverse = 1 / zoom;
    const viewportStyle: React.CSSProperties = {
      transform: `translate(${tx}px, ${ty}px) scale(${zoom})`,
      transformOrigin: '0 0',
      ['--iz' as string]: String(inverse),
    };

    // 像素格是设计稿尺度的（alignScale 恒为 1），阈值只由 zoom 决定
    const pixelGrid = shouldShowPixelGrid(zoom, 1);

    return (
      <div
        ref={containerRef}
        className={`canvas-scroll${panning ? ' panning' : ''}`}
        onMouseDown={onMouseDown}
        onClickCapture={onClickCapture}
      >
        <FrameRaster
          viewportRef={contentRef}
          tx={tx}
          ty={ty}
          zoom={zoom}
          sources={frames}
          pixelGrid={pixelGrid}
          selection={selection}
          hover={hover}
          peers={peers}
          overlay={overlay}
        />
        <div ref={contentRef} className="canvas-viewport" style={viewportStyle}>
          {/* `overlay` 类只影响布局（两帧的摆法），观感在 FrameRaster。
              挂在这里而不是让 NodeCanvas 自己判断：两帧必须**同时**改变摆法，
              任一侧自己动就会出现帧重叠但节点层还留在原位的错位。 */}
          <div className={`canvas${overlay ? ' overlay' : ''}`}>{children}</div>
        </div>
      </div>
    );
  },
);

CanvasViewport.displayName = 'CanvasViewport';

export default CanvasViewport;
