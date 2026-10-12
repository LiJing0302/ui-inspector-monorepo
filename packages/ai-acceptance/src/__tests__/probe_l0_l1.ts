/**
 * 开发探针：只跑 L0 + L1，打印关键统计。
 * 用途：改完整形/对齐规则后，先看数字有没有跑偏，再跑全量。
 *
 *   node --experimental-strip-types src/__tests__/probe_l0_l1.ts /tmp/uii-dbg
 */

import { loadBundle } from '../node/loadBundle.ts';
import { shapeBoth } from '../l0.ts';
import { alignAnchors } from '../l1.ts';
import { createBundleProfile2026_09_30 } from '../profile.ts';

const dir = process.argv[2] ?? '/tmp/uii-dbg';
const { input } = loadBundle(dir);
const profile = createBundleProfile2026_09_30();

const { design, app } = shapeBoth({
  meta: input.meta,
  designNodes: input.designNodes,
  appNodes: input.appNodes,
  profile,
});

const pd = (s: typeof design) => {
  console.log(
    `  total=${s.stats.total} kept=${s.stats.kept} dropped=${s.stats.dropped} ` +
      `text=${s.stats.text} visual=${s.stats.visual} container=${s.stats.container} chromeDrop=${s.stats.chrome} ` +
      `flow=${s.stats.flow} fixed=${s.stats.fixed} inPixels=${s.stats.inPixels} clippedOutRequired=${s.stats.clippedOutRequired} ` +
      `docH=${s.docHeight}`,
  );
  const reasons: Record<string, number> = {};
  for (const d of s.dropped) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
  console.log('  dropped:', reasons);
};

console.log('=== L0 design ===');
pd(design);
console.log('=== L0 app ===');
pd(app);

const align = alignAnchors(design, app, { gapJump: profile.thresholds!.gapJump });
console.log('=== L1 ===');
console.log(`anchors=${align.anchors.length} strong=${align.strongAnchors.length} weak=${align.weakAnchors.length} fixed=${align.fixedLayer.length}`);
console.log(`residualMedian=${align.residualMedian.toFixed(2)} p90(|Δy|)=${align.residualP90.toFixed(2)} within3=${align.within3}`);
console.log('usableRange=', align.usableRange, 'xOffset=', align.xOffset.toFixed(2), 'appToDesignX=', align.appToDesignX.toFixed(4));
console.log('gaps:');
for (const g of align.gaps) console.log(`  [${g.designY0.toFixed(0)}, ${g.designY1.toFixed(0)}] ${g.note}`);
console.log('strong anchors:');
for (const a of align.strongAnchors) {
  console.log(`  ${a.text.slice(0, 16).padEnd(18)} dY=${a.designY.toFixed(0).padStart(6)} aY=${a.appY.toFixed(0).padStart(6)} Δy=${a.deltaY.toFixed(2).padStart(8)}  ${a.reason}`);
}
console.log('fixed layer anchors:');
for (const a of align.fixedLayer) console.log(`  ${a.text}  dY=${a.designY} aY=${a.appY} Δy=${a.deltaY.toFixed(1)}`);
console.log('weak anchors:');
for (const a of align.weakAnchors) console.log(`  ${a.text.slice(0, 16).padEnd(18)} Δy=${a.deltaY.toFixed(2)}  ${a.reason}`);
