import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { Rect, VerifySource } from '@shared/verify';
import type { CanvasCapture } from '@shared/ipc';

import { overlayOffsetFromDrag } from '../lib/compare';
import type {
  AnnotationPoint,
  AnnotationTool,
  ColorSample,
  RasterAnnotation,
} from '../lib/annotation';
import { ZOOM_EPSILON, clampZoom, planFocus, shouldShowPixelGrid } from '../lib/zoom';
import FrameRaster, {
  measureFrameBoxes,
  type RasterFrameSource,
  type RasterMeasure,
  type RasterOverlay,
  type RasterRegion,
  type RasterCleanMerged,
  type RasterSamaBand,
  type RasterSamaIssue,
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
  /** 截取当前可见画布区域，供问题记录保存为图片 */
  capture: () => Promise<CanvasCapture>;
}

interface CaptureSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CaptureRequest {
  resolve: (capture: CanvasCapture) => void;
  reject: (error: Error) => void;
}

/**
 * 一次取景：平移量 + **记录时的视口尺寸**。
 *
 * 尺寸不是装饰：平移量是**屏幕坐标**，只在一个固定的视口盒子里才有意义。窗口被改过
 * 大小之后，同一对 (tx, ty) 指向的是另一块内容 —— 所以恢复它之前要先比尺寸
 * （见下面的 `initialView`），对不上就退回居中，而不是把内容摆到看不见的地方。
 */
export interface CanvasView {
  tx: number;
  ty: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** 视口尺寸差在这个像素数以内，就认为「还是同一个窗口」（人眼分不出 8px 的取景偏移） */
const VIEW_SIZE_TOLERANCE = 8;

interface CanvasViewportProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /**
   * 上一轮的取景（存在配对会话里）。给了就**不做首次居中**，直接落回原位 ——
   * 用户在图层列表里聚焦过某个节点、或自己把画布拖到了某处，切个 tab 回来
   * 不该被抹平。尺寸对不上时忽略它（理由见 `CanvasView`）。
   */
  initialView?: CanvasView | null;
  /**
   * 取景变化上报（拖拽 / 滚轮缩放 / 聚焦 / 首次居中）。
   *
   * ⚠️ 回调**不得**引起上层 setState：拖拽时它每秒被调用几十次。这里的用途只是把值
   *    记进配对会话（一次 Map 写入），所以传进来的必须是一个纯记账的回调。
   */
  onViewChange?: (view: CanvasView) => void;
  /** 各帧底图来源。底图在**屏幕空间**绘制，见 FrameRaster */
  frames: RasterFrameSource[];
  /**
   * 当前选中的节点，**每侧最多一个**（设计稿 / 截图各有自己的选中槽，互不影响）。
   * 选中框同样在屏幕空间绘制，线宽不随缩放变化。空数组 = 都没选中。
   */
  selections?: RasterSelection[];
  /**
   * 当前 hover 的节点。与选中框同住屏幕空间、共用同一套换算 ——
   * 原先画在 `.node-overlay:hover` 上（transform 层内部），高倍下糊成灰带。
   * 传入的必须是**原始命中**（光标底下最深可命中节点），见 lib/selection。
   */
  hover?: RasterSelection | null;
  /** 对侧同配对节点（选中一侧时另一侧同步高亮），见 FrameRaster */
  peers?: RasterSelection[];
  /**
   * 「正在核对的那一条匹配」的全部节点（两侧，可能是 N:M 的成组匹配）。
   *
   * 与 `peers` 分两条通道传：`peers` 由**选中项推导**（选中一个 → 对侧那一个），
   * 而这里是用户在匹配列表里**显式挑中一条**的完整节点集合。合成一条通道的话，
   * `FrameRaster` 就没法用不同描边区分「一对一对应」与「这一组是 N:M」了。
   */
  matchHighlight?: RasterSelection[];
  /**
   * 标注模式下**待配对**的一组节点（还没提交的）。
   *
   * 与 `matchHighlight` 分开传而不是复用：一条是「已经配上了」的既成事实，
   * 另一条是「正在配」的中间态，两者用同一种描边会让用户分不清
   * 「这一组是我刚点进来的」还是「这一组早就标好了」。
   */
  pendingHighlight?: RasterSelection[];
  regions?: RasterRegion[];
  /**
   * SAMA 引擎的分片结论与 issue 节点框（第七档，只读展示）。
   *
   * 本层**只透传**：几何换算全部在 `FrameRaster.projectionOf`，
   * 这里不参与任何坐标计算（与 `regions` / `matchHighlight` 同约定）。
   */
  samaBands?: RasterSamaBand[];
  samaIssues?: RasterSamaIssue[];
  /**
   * 清洗 + 归并后的视图节点（**只有这一档**，剔除框不画）。
   *
   * 本层**只透传**：几何换算全在 `FrameRaster.projectionOf`，
   * 这里不参与任何坐标计算（与 `regions` / `matchHighlight` 同约定）。
   */
  cleanMerged?: RasterCleanMerged[];
  /**
   * 叠图参数。传入即进入叠图：`.canvas` 加 `overlay` 类让两帧叠在一处，
   * 绘制细节交给 FrameRaster（位置与观感分属两层，任一层单独生效都不成立）。
   */
  overlay?: RasterOverlay | null;
  /**
   * 间距读数的**固定**另一端（⌘ 单击设的锚点）。与 `hover` 分开传：
   * 一个是「光标现在指着谁」（随鼠标走），一个是「我钉住要看的那个」（不随鼠标走）。
   * 本层只透传，不参与几何。
   */
  anchors?: RasterSelection[];
  /**
   * **选中项 ↔ 另一端（锚点优先，其次 hover）**之间的间距读数（x / y 各一条）。
   *
   * 与各档框一样只在屏幕空间绘制：几何由 `lib/measure` 出（纯函数），
   * 屏幕换算由 `FrameRaster` 做 —— 本层只是把通道透传下去，不参与任何几何。
   */
  measures?: RasterMeasure[];
  /** 顶部通用标注工具。空值时维持原有平移 / 节点点选行为。 */
  annotationTool?: AnnotationTool | null;
  annotations?: RasterAnnotation[];
  onCreateAnnotation?: (kind: Exclude<AnnotationTool, 'picker'>, source: VerifySource, start: AnnotationPoint, end: AnnotationPoint) => void;
  onPickColor?: (sample: ColorSample) => void;
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
  (
    {
      zoom,
      onZoomChange,
      initialView = null,
      onViewChange,
      frames,
      selections,
      hover,
      anchors,
      peers,
      matchHighlight,
      pendingHighlight,
      regions,
      samaBands,
      samaIssues,
      cleanMerged,
      overlay,
      measures,
      annotationTool,
      annotations,
      onCreateAnnotation,
      onPickColor,
      children,
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    /**
     * 初始平移量取「上一轮的取景」。首屏就用它，避免「先居中再跳回去」闪一下；
     * 尺寸对不对由下面那个首次居中的 layout effect 判（对不上会当场改回居中）。
     */
    const [tx, setTx] = useState(initialView?.tx ?? 0);
    const [ty, setTy] = useState(initialView?.ty ?? 0);
    const [panning, setPanning] = useState(false);
    const [aligningOverlay, setAligningOverlay] = useState(false);
    const [captureActive, setCaptureActive] = useState(false);
    const [captureSelection, setCaptureSelection] = useState<CaptureSelection | null>(null);
    const [natural, setNatural] = useState({ w: 0, h: 0 });
    const [draftAnnotation, setDraftAnnotation] = useState<RasterAnnotation | null>(null);
    const [colorPreview, setColorPreview] = useState<(ColorSample & { clientX: number; clientY: number }) | null>(null);

    // 最新值镜像，供原生（非 React）事件监听闭包读取
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const txRef = useRef(tx);
    txRef.current = tx;
    const tyRef = useRef(ty);
    tyRef.current = ty;
    const onZoomChangeRef = useRef(onZoomChange);
    onZoomChangeRef.current = onZoomChange;
    const onViewChangeRef = useRef(onViewChange);
    onViewChangeRef.current = onViewChange;
    /** 挂载那一刻的取景；之后 prop 再变也与本次会话无关（只用于首次落地） */
    const initialViewRef = useRef(initialView);
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
    const captureRequestRef = useRef<CaptureRequest | null>(null);
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

    /**
     * 首次拿到自然尺寸时定下取景：**上一轮存过就用它**，否则居中。
     *
     * 居中只该发生在「这一页第一次被打开」；用户在图层列表里聚焦过节点、或自己拖到
     * 某处之后切个 tab 回来，画布被拉回正中央 = 刚才的取景白做了（这正是本次要修的
     * 症状之一）。所以会话里存了取景就直接落地，不再居中。
     *
     * ⚠️ 尺寸对不上就不恢复：平移量是屏幕坐标，窗口被改过大小之后它指向的是另一块
     *    内容，硬套会把内容摆出视野 —— 那种情况下宁可退回居中。
     */
    useLayoutEffect(() => {
      if (didInitRef.current || natural.w === 0) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();

      const restored = initialViewRef.current;
      if (
        restored &&
        Math.abs(restored.viewportWidth - rect.width) <= VIEW_SIZE_TOLERANCE &&
        Math.abs(restored.viewportHeight - rect.height) <= VIEW_SIZE_TOLERANCE
      ) {
        setTx(restored.tx);
        setTy(restored.ty);
        didInitRef.current = true;
        return;
      }

      setTx((rect.width - natural.w * zoom) / 2);
      setTy((rect.height - natural.h * zoom) / 2);
      didInitRef.current = true;
    }, [natural, zoom]);

    /**
     * 取景上报：平移量一变就告诉上层（配对会话据此记住「这一页我看到哪儿了」）。
     *
     * ⚠️ 回调必须是纯记账（写一个 Map），**不能** setState —— 拖拽时这里每秒跑几十次，
     *    接一个 setState 就等于把整棵节点树按帧重渲染。
     */
    useEffect(() => {
      const report = onViewChangeRef.current;
      if (!report) return;
      const rect = containerRef.current?.getBoundingClientRect();
      report({
        tx,
        ty,
        viewportWidth: rect?.width ?? 0,
        viewportHeight: rect?.height ?? 0,
      });
    }, [tx, ty]);

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
        capture: async () => {
          const container = containerRef.current;
          if (!container) throw new Error('画布尚未就绪');
          if (captureRequestRef.current) throw new Error('已有一个画布截取正在进行');
          setCaptureActive(true);
          setCaptureSelection(null);
          container.focus({ preventScroll: true });
          return new Promise<CanvasCapture>((resolve, reject) => {
            captureRequestRef.current = { resolve, reject };
          });
        },
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

    const frameAtPoint = (clientX: number, clientY: number) => {
      const framesInDom = Array.from(
        contentRef.current?.querySelectorAll<HTMLElement>('.frame-content[data-frame]') ?? [],
      );
      return framesInDom
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .find(
          ({ rect }) =>
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom,
        );
    };

    const pointInFrame = (clientX: number, clientY: number, rect: DOMRect, width: number, height: number) => ({
      x: Math.max(0, Math.min(width, ((clientX - rect.left) / rect.width) * width)),
      y: Math.max(0, Math.min(height, ((clientY - rect.top) / rect.height) * height)),
    });

    const sampleColor = (source: VerifySource, clientX: number, clientY: number): string => {
      const image = containerRef.current?.querySelector<HTMLImageElement>(
        `.raster-image[data-raster-source="${source}"]`,
      );
      if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        return source === 'design' ? '#dbeafe' : '#fef3c7';
      }
      const imageRect = image.getBoundingClientRect();
      const x = Math.max(0, Math.min(image.naturalWidth - 1, ((clientX - imageRect.left) / imageRect.width) * image.naturalWidth));
      const y = Math.max(0, Math.min(image.naturalHeight - 1, ((clientY - imageRect.top) / imageRect.height) * image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      try {
        const context = canvas.getContext('2d');
        if (!context) return '#888888';
        context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
        const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
        if (alpha < 8) return 'transparent';
        return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      } catch {
        return '#888888';
      }
    };

    const handleAnnotationHover = (event: React.MouseEvent<HTMLDivElement>) => {
      if (annotationTool !== 'picker') {
        if (colorPreview) setColorPreview(null);
        return;
      }
      const frame = frameAtPoint(event.clientX, event.clientY);
      if (!frame) {
        if (colorPreview) setColorPreview(null);
        return;
      }
      const source = (frame.element.dataset.frame ?? 'design') as VerifySource;
      const frameDefinition = frames.find((item) => item.source === source);
      if (!frameDefinition || frame.rect.width <= 0 || frame.rect.height <= 0) return;
      const point = pointInFrame(
        event.clientX,
        event.clientY,
        frame.rect,
        frameDefinition.logicalWidth,
        (frame.rect.height / frame.rect.width) * frameDefinition.logicalWidth,
      );
      setColorPreview({
        source,
        color: sampleColor(source, event.clientX, event.clientY),
        point,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };

    useEffect(() => {
      if (annotationTool !== 'picker') setColorPreview(null);
    }, [annotationTool]);

    const onMouseDown = (e: React.MouseEvent) => {
      if (e.button !== 0) return;

      if (captureActive || captureRequestRef.current) {
        const container = containerRef.current;
        if (!container) return;
        e.preventDefault();
        e.stopPropagation();
        const containerRect = container.getBoundingClientRect();
        const clampX = (value: number): number => Math.max(0, Math.min(containerRect.width, value));
        const clampY = (value: number): number => Math.max(0, Math.min(containerRect.height, value));
        const startX = clampX(e.clientX - containerRect.left);
        const startY = clampY(e.clientY - containerRect.top);
        const request = captureRequestRef.current;
        if (!request) return;

        let latestSelection: CaptureSelection = { x: startX, y: startY, width: 0, height: 0 };
        setCaptureSelection(latestSelection);
        const move = (event: MouseEvent) => {
          const endX = clampX(event.clientX - containerRect.left);
          const endY = clampY(event.clientY - containerRect.top);
          latestSelection = {
            x: Math.min(startX, endX),
            y: Math.min(startY, endY),
            width: Math.abs(endX - startX),
            height: Math.abs(endY - startY),
          };
          setCaptureSelection(latestSelection);
        };
        const up = async () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          suppressClickRef.current = true;
          captureRequestRef.current = null;
          setCaptureActive(false);
          setCaptureSelection(null);
          if (latestSelection.width < DRAG_THRESHOLD || latestSelection.height < DRAG_THRESHOLD) {
            request.reject(new Error('请在画布上拖拽选择截取区域'));
            return;
          }
          try {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const capture = await window.api.verify.captureCanvas({
              x: containerRect.left + latestSelection.x,
              y: containerRect.top + latestSelection.y,
              width: latestSelection.width,
              height: latestSelection.height,
            });
            request.resolve(capture);
          } catch (cause) {
            request.reject(cause instanceof Error ? cause : new Error('截取画布失败'));
          }
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return;
      }

      if (annotationTool) {
        const frame = frameAtPoint(e.clientX, e.clientY);
        if (!frame) return;
        e.preventDefault();
        e.stopPropagation();
        containerRef.current?.focus({ preventScroll: true });
        const source = (frame.element.dataset.frame ?? 'design') as VerifySource;
        const frameDefinition = frames.find((item) => item.source === source);
        if (!frameDefinition || frame.rect.width <= 0 || frame.rect.height <= 0) return;
        const start = pointInFrame(e.clientX, e.clientY, frame.rect, frameDefinition.logicalWidth, frame.rect.height / frame.rect.width * frameDefinition.logicalWidth);

        if (annotationTool === 'picker') {
          onPickColor?.({
            source,
            color: sampleColor(source, e.clientX, e.clientY),
            point: start,
          });
          suppressClickRef.current = true;
          return;
        }

        const kind = annotationTool;
        let moved = false;
        const move = (event: MouseEvent) => {
          if (!moved && Math.hypot(event.clientX - e.clientX, event.clientY - e.clientY) > DRAG_THRESHOLD) {
            moved = true;
          }
          if (moved) {
            const end = pointInFrame(
              event.clientX,
              event.clientY,
              frame.rect,
              frameDefinition.logicalWidth,
              (frame.rect.height / frame.rect.width) * frameDefinition.logicalWidth,
            );
            setDraftAnnotation({
              id: 'draft-annotation',
              kind,
              source,
              start,
              end,
            });
          }
        };
        const up = (event: MouseEvent) => {
          const end = pointInFrame(event.clientX, event.clientY, frame.rect, frameDefinition.logicalWidth, frame.rect.height / frame.rect.width * frameDefinition.logicalWidth);
          if (moved && onCreateAnnotation) onCreateAnnotation(kind, source, start, end);
          setDraftAnnotation(null);
          suppressClickRef.current = true;
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return;
      }

      // Choose the gesture once, at mousedown, using the screenshot's transformed bounds.
      // Outside the screenshot, the ordinary pan below moves both frames together.
      const appRect = overlay
        ? contentRef.current?.querySelector<HTMLElement>(".frame[data-role='app'] .frame-content")?.getBoundingClientRect()
        : undefined;
      const overAppFrame = appRect &&
        e.clientX >= appRect.left && e.clientX <= appRect.right &&
        e.clientY >= appRect.top && e.clientY <= appRect.bottom;
      if (overlay) {
        e.preventDefault();
        e.stopPropagation();
        containerRef.current?.focus({ preventScroll: true });
      }
      if (overlay && overAppFrame) {
        const startX = e.clientX;
        const startY = e.clientY;
        const startOffset = overlay.offset;
        let moved = false;
        setAligningOverlay(true);

        const move = (ev: MouseEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true;
          if (!moved) return;
          overlay.onOffsetChange(
            overlayOffsetFromDrag({
              start: startOffset,
              screenDeltaX: dx,
              screenDeltaY: dy,
              zoom: zoomRef.current,
            }),
          );
        };
        const up = () => {
          if (moved) suppressClickRef.current = true;
          setAligningOverlay(false);
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return;
      }

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

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!overlay) return;
      const delta = event.shiftKey ? 10 : 1;
      const movement: Record<string, { x: number; y: number }> = {
        ArrowLeft: { x: -delta, y: 0 },
        ArrowRight: { x: delta, y: 0 },
        ArrowUp: { x: 0, y: -delta },
        ArrowDown: { x: 0, y: delta },
      };
      const next = movement[event.key];
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      overlay.onOffsetChange({
        x: overlay.offset.x + next.x,
        y: overlay.offset.y + next.y,
      });
    };

    // Overlay clicks (including a short press) never reach the node-selection layer.
    const onClickCapture = (e: React.MouseEvent) => {
      if (overlay || suppressClickRef.current) {
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
    const canvasStyle = overlay
      ? ({
          ['--overlay-offset-x' as string]: `${overlay.offset.x}px`,
          ['--overlay-offset-y' as string]: `${overlay.offset.y}px`,
        } satisfies React.CSSProperties)
      : undefined;

    // 像素格是设计稿尺度的（alignScale 恒为 1），阈值只由 zoom 决定
    const pixelGrid = shouldShowPixelGrid(zoom, 1);

    return (
      <div
        ref={containerRef}
        className={`canvas-scroll${panning ? ' panning' : ''}${aligningOverlay ? ' aligning-overlay' : ''}${captureActive ? ' capture-mode' : ''}`}
        tabIndex={0}
        aria-label={overlay ? '叠图画布，截图内拖动截图，截图外平移画布，方向键微调截图' : '验收画布'}
        onMouseDown={onMouseDown}
        onMouseMove={handleAnnotationHover}
        onMouseLeave={() => setColorPreview(null)}
        onKeyDown={onKeyDown}
        onClickCapture={onClickCapture}
      >
        <FrameRaster
          viewportRef={contentRef}
          tx={tx}
          ty={ty}
          zoom={zoom}
          sources={frames}
          pixelGrid={pixelGrid}
          selections={overlay ? [] : selections}
          hover={overlay ? null : hover}
          anchors={overlay ? [] : anchors}
          peers={overlay ? [] : peers}
          matchHighlight={overlay ? [] : matchHighlight}
          pendingHighlight={overlay ? [] : pendingHighlight}
          regions={regions}
          samaBands={samaBands}
          samaIssues={samaIssues}
          cleanMerged={cleanMerged}
          overlay={overlay}
          measures={overlay ? [] : measures}
          annotations={draftAnnotation ? [...(annotations ?? []), draftAnnotation] : annotations}
        />
        {captureActive && captureSelection && (
          <div
            className="canvas-capture-selection"
            style={{
              left: captureSelection.x,
              top: captureSelection.y,
              width: captureSelection.width,
              height: captureSelection.height,
            }}
          >
            <span>释放鼠标完成截取</span>
          </div>
        )}
        {captureActive && !captureSelection && (
          <div className="canvas-capture-hint">在画布上拖拽选择截取区域</div>
        )}
        {colorPreview && (
          <div
            className="color-picker-preview"
            role="tooltip"
            style={{ left: colorPreview.clientX + 14, top: colorPreview.clientY + 14 }}
          >
            <span className="color-picker-preview-swatch" style={{ backgroundColor: colorPreview.color }} />
            <span className="color-picker-preview-value">
              <strong>{colorPreview.color}</strong>
              <small>{colorPreview.source === 'design' ? '设计稿' : '截图'}</small>
            </span>
          </div>
        )}
        <div ref={contentRef} className={`canvas-viewport${overlay ? ' overlay-viewport' : ''}`} style={viewportStyle}>
          {/* `overlay` 类只影响布局（两帧的摆法），观感在 FrameRaster。
              挂在这里而不是让 NodeCanvas 自己判断：两帧必须**同时**改变摆法，
              任一侧自己动就会出现帧重叠但节点层还留在原位的错位。 */}
          <div className={`canvas${overlay ? ' overlay' : ''}`} style={canvasStyle}>
            {children}
          </div>
        </div>
      </div>
    );
  },
);

CanvasViewport.displayName = 'CanvasViewport';

export default CanvasViewport;
