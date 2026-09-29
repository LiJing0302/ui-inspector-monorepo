/** 7.2 迁移前后对照：输出设计师画法样本的 salience/participation 快照（JSON）。 */
import { canonicalizeApp, canonicalizeDesign } from '../src/main/acceptance/core';
import type { AppNode, DesignNode } from '../src/types/verify';
import type { CanonicalDocument } from '../src/types/aiAcceptance';

function d(id: string, parentId: string | null, type: string, x: number, y: number, w: number, h: number, extra?: Record<string, unknown>): DesignNode {
  return { id, name: id, type, path: id, depth: parentId ? 1 : 0, visible: true, rect: { x, y, width: w, height: h }, parentId, ...extra } as unknown as DesignNode;
}
function a(nodeId: string, parentId: string | null, className: string, x: number, y: number, w: number, h: number, extra?: Record<string, unknown>): AppNode {
  return { nodeId, parentId, className, depth: parentId ? 1 : 0, index: 0, x, y, width: w, height: h, visibleX: x, visibleY: y, visibleWidth: w, visibleHeight: h, scrollX: 0, scrollY: 0, visible: true, enabled: true, ...extra } as unknown as AppNode;
}

const designNodes: DesignNode[] = [
  d('root', null, 'FRAME', 0, 0, 375, 800),
  d('t1', 'root', 'TEXT', 10, 20, 100, 20, { text: { characters: 'title' } }),
  d('imgwrap', 'root', 'FRAME', 10, 100, 200, 120, { hasFill: false }),
  d('photo', 'imgwrap', 'RECTANGLE', 10, 100, 200, 120, { hasFill: true, fills: [{ type: 'IMAGE', visible: true, opacity: 1 }] }),
  d('btn', 'root', 'RECTANGLE', 10, 240, 160, 48, { hasFill: true }),
  d('iconwrap', 'root', 'FRAME', 10, 310, 48, 48, { hasFill: false }),
  d('icon', 'iconwrap', 'VECTOR', 10, 310, 48, 48, { hasFill: true }),
];
const appNodes: AppNode[] = [
  a('root', null, 'RootView', 0, 0, 375, 800),
  a('u1', 'root', 'TextView', 10, 20, 100, 20, { text: 'title' }),
  a('imgwrap', 'root', 'ViewGroup', 10, 100, 200, 120),
  a('photo', 'imgwrap', 'ImageView', 10, 100, 200, 120, { isImage: true }),
  a('btn', 'root', 'View', 10, 240, 160, 48, { hasVisualContent: true }),
  a('iconwrap', 'root', 'ViewGroup', 10, 310, 48, 48),
  a('icon', 'iconwrap', 'ImageView', 10, 310, 48, 48, { isSvg: true }),
];

function snap(doc: CanonicalDocument) {
  return doc.nodes.map((n) => ({
    id: n.canonicalId, salience: n.salience, participation: n.participation,
    passThrough: n.passThrough, hasVisual: n.visual.hasVisualContent,
  }));
}

console.log(JSON.stringify({
  design: snap(canonicalizeDesign(designNodes, 375, 800)),
  app: snap(canonicalizeApp(appNodes, 375, 800)),
}, null, 1));
