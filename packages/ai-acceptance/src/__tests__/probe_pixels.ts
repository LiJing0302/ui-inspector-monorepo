/**
 * 像素探针：打印指定设计节点在 App 截图上的采样框与左上角像素网格。
 *   node --experimental-strip-types src/__tests__/probe_pixels.ts <bundleDir> <designNodeId>
 */
import { loadBundle } from '../node/loadBundle.ts';
import { shapeBoth } from '../l0.ts';
import { alignAnchors } from '../l1.ts';
import { createBundleProfile2026_09_30 } from '../profile.ts';
import { PngSampler } from '../node/pngSampler.ts';

const dir = process.argv[2] ?? '/tmp/uii-dbg';
const want = process.argv[3] ?? '1755:12855';

const loaded = loadBundle(dir);
const profile = createBundleProfile2026_09_30();
const shape = shapeBoth({
  meta: loaded.input.meta,
  designNodes: loaded.input.designNodes,
  appNodes: loaded.input.appNodes,
  profile,
});
const align = alignAnchors(shape.design, shape.app, { gapJump: 40 });

const node = shape.design.nodes.find((n) => n.id === want);
if (!node) {
  console.log('design node not found:', want);
  process.exit(1);
}
const appImg = await loaded.input.appImage!.load!();
const s = new PngSampler(appImg);
const logicalRatio = loaded.input.meta.app.width / loaded.input.meta.design.width;
const appScale = loaded.input.meta.app.scaleX ?? 3;

const [dx, dy, dw, dh] = [node.rect.x, node.rect.y, node.rect.width, node.rect.height];
const py = align.projectY(dy).appY;
const box = [
  Math.round(dx * logicalRatio * appScale),
  Math.round(py * appScale),
  Math.max(1, Math.round(dw * logicalRatio * appScale)),
  Math.max(1, Math.round(dh * logicalRatio * appScale)),
];
console.log('design node:', node.id, node.kind, JSON.stringify(node.text), 'rect=', node.rect);
console.log('cornerRadius(design logical)=', node.boxStyle?.cornerRadius, ' fill=', node.boxStyle?.backgroundColor);
console.log('projectY(', dy, ') =', py.toFixed(1), ' appScale=', appScale, ' logicalRatio=', logicalRatio);
console.log('appBox(physical) =', box, ' expected radius px =', ((node.boxStyle?.cornerRadius ?? 0) * logicalRatio * appScale).toFixed(1));

const hex = (p: [number, number, number, number] | null) =>
  p ? `#${p[0].toString(16).padStart(2, '0')}${p[1].toString(16).padStart(2, '0')}${p[2].toString(16).padStart(2, '0')}` : '  --  ';

const [bx, by] = box;
console.log('\n--- grid (x from box.x-6, y from box.y-6), 6px step ---');
let header = '        ';
for (let x = bx - 6; x <= bx + 54; x += 6) header += `${String(x).padStart(7)} `;
console.log(header);
for (let yy = by - 6; yy <= by + 42; yy += 6) {
  let row = `${String(yy).padStart(6)}  `;
  for (let x = bx - 6; x <= bx + 54; x += 6) row += `${hex(s.pixel(x, yy))} `;
  console.log(row);
}
console.log('\n--- first foreground x per row (bg ref at box.x-18, box.y+box.h/2) ---');
const bg = s.pixel(bx - 18, by + Math.round(box[3] / 2));
console.log('bgRef =', hex(bg));
for (let yy = by - 8; yy <= by + 40; yy += 1) {
  let first = -1;
  for (let x = bx - 10; x <= bx + 60; x++) {
    const c = s.pixel(x, yy);
    if (!c) continue;
    const d = bg && (Math.abs(c[0] - bg[0]) > 18 || Math.abs(c[1] - bg[1]) > 18 || Math.abs(c[2] - bg[2]) > 18);
    if (d) {
      first = x;
      break;
    }
  }
  console.log(`  y=${String(yy).padStart(5)} first=${String(first).padStart(5)} inset=${first >= 0 ? first - bx : 'n/a'}`);
}
