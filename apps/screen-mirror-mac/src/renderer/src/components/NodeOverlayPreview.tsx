import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_OVERLAY_OFFSET, overlayOffsetFromDrag, type OverlayOffset } from '../lib/compare';
import { DEFAULT_NODE_OVERLAY_CAMERA, nodeOverlayLayout, nodeOverlayView, zoomNodeOverlay,
  type NodeOverlayCamera, type NodeOverlaySource } from '../lib/nodeOverlay';

type Layout = NonNullable<ReturnType<typeof nodeOverlayLayout>>;
const PreviewSizeIcon: React.FC<{ expanded?: boolean }> = ({ expanded = false }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={expanded ? 'M21 10h-7V3M3 14h7v7M14 10l7-7M10 14l-7 7' : 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'} />
  </svg>
);
interface CanvasProps {
  design: NodeOverlaySource;
  app: NodeOverlaySource;
  layout: Layout;
  camera: NodeOverlayCamera;
  setCamera: React.Dispatch<React.SetStateAction<NodeOverlayCamera>>;
  offset: OverlayOffset;
  setOffset: React.Dispatch<React.SetStateAction<OverlayOffset>>;
  opacity: number;
  setOpacity: (value: number) => void;
  onError: () => void;
}

const OverlayCanvas: React.FC<CanvasProps> = ({ design, app, layout, camera, setCamera, offset, setOffset, opacity, setOpacity, onError }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const appBoundsRef = useRef<SVGRectElement>(null);
  const [size, setSize] = useState({ width: 320, height: 180 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ id: number; x: number; y: number; camera: NodeOverlayCamera; offset: OverlayOffset;
    target: 'app' | 'canvas'; scale: number; moved: boolean } | null>(null);
  const view = nodeOverlayView(layout.view, size, camera);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const zoomAt = useCallback((factor: number, point = { x: 0, y: 0 }) => {
    setCamera(current => zoomNodeOverlay(current, factor, point, nodeOverlayView(layout.view, size, current).scale));
  }, [layout, size, setCamera]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (dragRef.current) return;
      const rect = svg.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      zoomAt(Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.002), {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      });
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, [zoomAt, size.height]);

  const endDrag = () => { dragRef.current = null; setDragging(false); };
  return <>
    <div className="node-preview-tools" role="group" aria-label="节点叠图缩放">
      <button type="button" aria-label="缩小节点叠图" disabled={camera.zoom <= 0.25} onClick={() => zoomAt(1 / 1.25)}>−</button>
      <output title="相对适应视图的缩放比例">{Math.round(camera.zoom * 100)}%</output>
      <button type="button" aria-label="放大节点叠图" disabled={camera.zoom >= 16} onClick={() => zoomAt(1.25)}>＋</button>
      <button type="button" onClick={() => setCamera(DEFAULT_NODE_OVERLAY_CAMERA)}>适应</button>
      <button type="button" onClick={() => setOffset(DEFAULT_OVERLAY_OFFSET)}>恢复对齐</button>
    </div>
    <svg ref={svgRef} className={`node-preview-canvas${dragging ? ' dragging' : ''}`} role="img" tabIndex={0}
      aria-label="设计稿与 App 选中节点叠图，滚轮缩放，截图节点内拖动截图，节点外平移画布"
      viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
      onDoubleClick={() => setCamera(DEFAULT_NODE_OVERLAY_CAMERA)}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(1.25); }
        else if (event.key === '-') { event.preventDefault(); zoomAt(1 / 1.25); }
        else if (event.key === '0') { event.preventDefault(); setCamera(DEFAULT_NODE_OVERLAY_CAMERA); }
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          const step = event.shiftKey ? 10 : 1;
          setOffset(current => ({
            x: current.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
            y: current.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }));
        }
      }}
      onPointerDown={event => {
        if (event.button !== 0 || dragRef.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        // The orange node bounds define the screenshot region in this local preview.
        // Decide once so crossing that boundary during a drag never switches gestures.
        const rect = appBoundsRef.current?.getBoundingClientRect();
        const overApp = rect && event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom;
        dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, camera, offset,
          target: overApp ? 'app' : 'canvas', scale: view.scale, moved: false };
        setDragging(true);
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) <= 4) return;
        drag.moved = true;
        if (drag.target === 'app') {
          setOffset(overlayOffsetFromDrag({ start: drag.offset, screenDeltaX: dx, screenDeltaY: dy, zoom: drag.scale }));
        } else {
          setCamera({ ...drag.camera, x: drag.camera.x - dx / drag.scale, y: drag.camera.y - dy / drag.scale });
        }
      }}
      onPointerUp={event => {
        if (dragRef.current?.id !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        endDrag();
      }}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <image data-preview-source="design" href={design.imageUrl} {...layout.designImage}
        preserveAspectRatio="none" onError={onError} />
      <image data-preview-source="app" href={app.imageUrl} {...layout.appImage} opacity={opacity}
        x={layout.appImage.x + offset.x} y={layout.appImage.y + offset.y}
        preserveAspectRatio="none" onError={onError} />
      <rect {...layout.designBounds} className="node-preview-bounds design" vectorEffect="non-scaling-stroke" />
      <rect ref={appBoundsRef} {...layout.appBounds} x={offset.x} y={offset.y}
        className="node-preview-bounds app" vectorEffect="non-scaling-stroke" />
    </svg>
    <label className="node-preview-opacity"><span>截图透明度</span>
      <input type="range" aria-label="节点叠图截图透明度" min="0" max="100" value={Math.round(opacity * 100)}
        onChange={event => setOpacity(Number(event.target.value) / 100)} />
      <output>{Math.round(opacity * 100)}%</output>
    </label>
    <div className="node-preview-note"><span className="design">设计稿</span><span className="app">App</span>
      <span>按页面宽度比例叠放，保留节点尺寸差异</span>
      <span className="node-preview-gesture">滚轮缩放 · 截图节点内拖动截图，节点外平移画布</span>
    </div>
  </>;
};

const OverlayDialog: React.FC<{ children: React.ReactNode; onClose: () => void; opener: React.RefObject<HTMLButtonElement>; manuallyAligned: boolean }> = ({ children, onClose, opener, manuallyAligned }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const trigger = opener.current;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [opener]);
  return createPortal(<dialog ref={dialogRef} className="node-preview-dialog" aria-label="节点叠图放大预览"
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ));
        const next = event.shiftKey ? controls.at(-1) : controls[0];
        const boundary = event.shiftKey ? controls[0] : controls.at(-1);
        if (next && (document.activeElement === boundary || document.activeElement === event.currentTarget)) {
          event.preventDefault();
          next.focus();
        }
      }
    }}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className="node-preview-dialog-head"><div><strong>节点叠图</strong><span>{manuallyAligned ? '手动偏移' : '左上角自动对齐'}</span></div>
      <button type="button" className="node-preview-size-toggle" autoFocus aria-label="缩小节点叠图预览" title="缩小" onClick={onClose}>
        <PreviewSizeIcon expanded />
      </button>
    </div>
    {children}
  </dialog>, document.body);
};

export const NodeOverlayPreview: React.FC<{ design: NodeOverlaySource; app: NodeOverlaySource }> = ({ design, app }) => {
  const [opacity, setOpacity] = useState(0.5);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [camera, setCamera] = useState(DEFAULT_NODE_OVERLAY_CAMERA);
  const [offset, setOffset] = useState(DEFAULT_OVERLAY_OFFSET);
  const manuallyAligned = offset.x !== 0 || offset.y !== 0;
  const expandRef = useRef<HTMLButtonElement>(null);
  const layout = nodeOverlayLayout(design, app);
  const error = !design.imageUrl || !app.imageUrl ? '缺少两侧图片，无法预览'
    : !layout ? '节点没有有效尺寸，无法预览' : failed ? '图片加载失败，无法预览' : null;
  const canvas = () => error || !layout ? <div className="node-preview-empty">{error}</div>
    : <OverlayCanvas design={design} app={app} layout={layout} camera={camera} setCamera={setCamera}
        offset={offset} setOffset={setOffset}
        opacity={opacity} setOpacity={setOpacity} onError={() => setFailed(true)} />;
  return <section className="node-overlay-preview" aria-label="选中节点叠图预览">
    <div className="node-preview-head"><strong>节点叠图</strong><span>{manuallyAligned ? '手动偏移' : '左上角自动对齐'}</span>
      <button ref={expandRef} type="button" className="node-preview-size-toggle" aria-label="放大节点叠图预览" title="放大"
        disabled={Boolean(error)} onClick={() => setExpanded(true)}><PreviewSizeIcon /></button>
    </div>
    {canvas()}
    {expanded && <OverlayDialog opener={expandRef} manuallyAligned={manuallyAligned} onClose={() => setExpanded(false)}>{canvas()}</OverlayDialog>}
  </section>;
};
