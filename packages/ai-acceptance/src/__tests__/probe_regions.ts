/**
 * 手工探针：打印某段设计/App 文本与投影曲线，用于核对分区配对是否符合预期。
 *   node --experimental-strip-types src/__tests__/probe_regions.ts <bundleDir> [dY0 dY1 aY0 aY1]
 */
import { loadBundle } from '../node/loadBundle.ts';
import { shapeBoth } from '../l0.ts';
import { alignAnchors } from '../l1.ts';
import { createBundleProfile2026_09_30 } from '../profile.ts';

const dir = process.argv[2] ?? '/tmp/uii-dbg';
const dY0 = Number(process.argv[3] ?? 440);
const dY1 = Number(process.argv[4] ?? 620);
const aY0 = Number(process.argv[5] ?? 400);
const aY1 = Number(process.argv[6] ?? 600);

const loaded = loadBundle(dir);
const profile = createBundleProfile2026_09_30();
const shape = shapeBoth({
  meta: loaded.input.meta,
  designNodes: loaded.input.designNodes,
  appNodes: loaded.input.appNodes,
  profile,
});
const align = alignAnchors(shape.design, shape.app, { gapJump: 40 });

console.log(`=== design texts y in [${dY0}, ${dY1}] ===`);
for (const n of shape.design.nodes
  .filter((n) => n.kind === 'text' && n.text && n.rect.y >= dY0 && n.rect.y <= dY1)
  .sort((a, b) => a.rect.y - b.rect.y)) {
  console.log(`  dY=${String(n.rect.y.toFixed(0)).padStart(4)} x=${String(n.rect.x.toFixed(0)).padStart(4)} ${JSON.stringify(n.text)} layer=${n.layer}`);
}

console.log(`=== app texts y in [${aY0}, ${aY1}] ===`);
for (const n of shape.app.nodes
  .filter((n) => n.kind === 'text' && n.text && n.rect.y >= aY0 && n.rect.y <= aY1)
  .sort((a, b) => a.rect.y - b.rect.y)) {
  console.log(`  aY=${String(n.rect.y.toFixed(0)).padStart(4)} x=${String(n.rect.x.toFixed(0)).padStart(4)} ${JSON.stringify(n.text)} layer=${n.layer}`);
}

for (const y of [339, 395, 440, 470, 520, 560, 594, 621, 689, 759, 805, 900, 1000, 1080, 1140, 1261]) {
  const p = align.projectY(y);
  console.log(`  projectY(${String(y).padStart(4)}) -> appY=${p.appY.toFixed(1)} conf=${p.confidence.toFixed(2)}`);
}
console.log('usableRange:', align.usableRange, 'anchorX ratio:', align.appToDesignX, 'xOffset:', align.xOffset);
