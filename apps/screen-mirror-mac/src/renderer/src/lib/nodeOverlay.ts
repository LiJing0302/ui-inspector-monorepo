import type { Rect } from '@shared/verify';

export interface OverlayImage {
  imageUrl?: string;
  width: number;
  height: number;
}
export interface NodeOverlaySource extends OverlayImage { rect: Rect }

export interface NodeOverlayCamera { zoom: number; x: number; y: number }
export const DEFAULT_NODE_OVERLAY_CAMERA: NodeOverlayCamera = { zoom: 1, x: 0, y: 0 };

/** Expand the fitted view to the actual canvas aspect ratio; camera offsets use source units. */
export function nodeOverlayView(view: Rect, size: { width: number; height: number }, camera: NodeOverlayCamera) {
  const scale = Math.min(size.width / view.width, size.height / view.height) * camera.zoom;
  const width = size.width / scale;
  const height = size.height / scale;
  return { x: view.x + view.width / 2 + camera.x - width / 2,
    y: view.y + view.height / 2 + camera.y - height / 2, width, height, scale };
}

/** Keep the same source point under the pointer while zooming. */
export function zoomNodeOverlay(camera: NodeOverlayCamera, factor: number,
  pointer: { x: number; y: number }, scale: number): NodeOverlayCamera {
  const zoom = Math.max(0.25, Math.min(16, camera.zoom * factor));
  const ratio = zoom / camera.zoom;
  return { zoom, x: camera.x + pointer.x / scale * (1 - 1 / ratio),
    y: camera.y + pointer.y / scale * (1 - 1 / ratio) };
}

/** Work in screenshot-frame coordinates, just like the main canvas. Never stretch a node to fit its peer. */
export function nodeOverlayLayout(design: NodeOverlaySource, app: NodeOverlaySource) {
  const valid = (source: NodeOverlaySource): boolean =>
    [source.width, source.height, source.rect.width, source.rect.height].every(v => Number.isFinite(v) && v > 0)
    && [source.rect.x, source.rect.y].every(Number.isFinite);
  if (!valid(design) || !valid(app)) return null;
  const scale = design.width / app.width;
  const width = Math.max(design.rect.width, app.rect.width * scale);
  const height = Math.max(design.rect.height, app.rect.height * scale);
  const padding = Math.max(4, Math.min(24, Math.max(width, height) * 0.12));
  const imageRect = (source: NodeOverlaySource, ratio: number): Rect => ({
    x: -source.rect.x * ratio, y: -source.rect.y * ratio,
    width: source.width * ratio, height: source.height * ratio,
  });
  const appBounds = { x: 0, y: 0, width: app.rect.width * scale, height: app.rect.height * scale };
  const view = { x: -padding, y: -padding, width: width + padding * 2, height: height + padding * 2 };
  if (![scale, ...Object.values(view), ...Object.values(appBounds)].every(Number.isFinite)) return null;
  return { scale, view, designImage: imageRect(design, 1), appImage: imageRect(app, scale),
    designBounds: { x: 0, y: 0, width: design.rect.width, height: design.rect.height }, appBounds };
}
