import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceTarget, validateAcceptanceContext, type AcceptanceContext } from '@ui-inspector/protocol';
import { buildManualFields, buildSpacingFields, designAlignedScale, displayLengthValue, designStroke, formatManualNumbers, hasExplicitValue, hasPropertyValue, manualEvidence, visibleManualFields } from '../src/renderer/src/lib/manualAcceptance';
import { normalizeSdkSnapshot, validateSdkSnapshotEnvelope } from '../src/types/acceptance';
import { toRenderNode } from '../src/types/verify';
import { stackOf } from '../src/renderer/src/lib/stack';
import { buildInspectionFields, inspectApp, inspectDesign, inspectionEvidence, inspectionKey, resolveProperties } from '../src/renderer/src/lib/elementInspection';
import { DEFAULT_NODE_OVERLAY_CAMERA, nodeOverlayLayout, nodeOverlayView, zoomNodeOverlay } from '../src/renderer/src/lib/nodeOverlay';

test('node overlay viewport fits different aspect ratios without stretching either layer', () => {
  const bounds = { x: -12, y: -12, width: 124, height: 68 };
  for (const size of [{ width: 360, height: 180 }, { width: 1000, height: 640 }, { width: 200, height: 500 }]) {
    const view = nodeOverlayView(bounds, size, DEFAULT_NODE_OVERLAY_CAMERA);
    assert.ok(view.width >= bounds.width && view.height >= bounds.height);
    assert.ok(Math.abs(view.width / view.height - size.width / size.height) < 1e-10);
    assert.equal(view.x + view.width / 2, bounds.x + bounds.width / 2);
    assert.equal(view.y + view.height / 2, bounds.y + bounds.height / 2);
  }
});

test('node overlay zoom preserves pointer anchor after panning and clamps at either zoom limit', () => {
  const bounds = { x: -12, y: -12, width: 124, height: 68 };
  const size = { width: 1000, height: 640 };
  const camera = { zoom: 2, x: 17, y: -11 };
  const point = { x: 230, y: -120 };
  const before = nodeOverlayView(bounds, size, camera);
  for (const factor of [1.25, 0.8, 1000, 0.0001]) {
    const next = zoomNodeOverlay(camera, factor, point, before.scale);
    const after = nodeOverlayView(bounds, size, next);
    assert.ok(next.zoom >= 0.25 && next.zoom <= 16);
    assert.ok(Math.abs(camera.x + point.x / before.scale - next.x - point.x / after.scale) < 1e-10);
    assert.ok(Math.abs(camera.y + point.y / before.scale - next.y - point.y / after.scale) < 1e-10);
  }
  assert.deepEqual(zoomNodeOverlay({ zoom: 16, x: 17, y: -11 }, 2, point, before.scale), { zoom: 16, x: 17, y: -11 });
});

test('node overlay aligns origins using page width ratio and preserves size differences and source rectangles', () => {
  const design = { width: 375, height: 667, rect: { x: 16, y: 100, width: 100, height: 44 } };
  const app = { width: 360, height: 800, rect: { x: 24, y: 160, width: 96, height: 46 } };
  const before = JSON.stringify([design, app]);
  const layout = nodeOverlayLayout(design, app)!;
  assert.equal(layout.scale, 375 / 360);
  assert.equal(layout.designImage.x + design.rect.x, 0);
  assert.equal(layout.designImage.y + design.rect.y, 0);
  assert.equal(layout.appImage.x + app.rect.x * layout.scale, 0);
  assert.equal(layout.appImage.y + app.rect.y * layout.scale, 0);
  assert.equal(layout.appBounds.width, 100);
  assert.ok(Math.abs(layout.appBounds.height - 46 * 375 / 360) < 1e-10);
  assert.notEqual(layout.appBounds.height, layout.designBounds.height);
  assert.ok(layout.view.width > layout.appBounds.width);
  assert.ok(layout.view.height > layout.appBounds.height);
  assert.equal(JSON.stringify([design, app]), before);
});

test('node overlay rejects invalid geometry and supports partially off-page nodes without rounding', () => {
  const source = { width: 375, height: 667, rect: { x: -2.5, y: 1.25, width: 22, height: 20 } };
  assert.equal(nodeOverlayLayout(source, source)!.designImage.x, 2.5);
  for (const bad of [{ ...source, width: 0 }, { ...source, height: NaN },
    { ...source, rect: { ...source.rect, x: Infinity } }, { ...source, rect: { ...source.rect, width: 0 } }]) {
    assert.equal(nodeOverlayLayout(bad, source), null);
    assert.equal(nodeOverlayLayout(source, bad), null);
  }
});

const context: AcceptanceContext = {
  version: 1, logicalUnit: 'dp', viewport: { width: 360, height: 800 }, pixelRatio: 3, fontScale: 1,
  design: { width: 375, height: 667, unitsPerPoint: 1, rules: {
    width: { scale: 'width', rounding: 'nearest-pixel' }, height: { scale: 'width', rounding: 'nearest-pixel' },
    radius: { scale: 'min', rounding: 'none' }, spacing: { scale: 'width', rounding: 'none' },
  } },
};
const align = { scale: 375 / 360, designWidth: 375, designHeight: 667, appWidth: 360, pixelRatio: 3, platform: 'android' as const, acceptanceContext: context };
const design: any = { id: 'button', name: '按钮', type: 'RECTANGLE', parentId: null, rect: { x: 16, y: 100, width: 100, height: 44 }, cornerRadius: 12 };
const node: any = { nodeId: 'n0', treePath: '0', parentId: null, className: 'View', depth: 0, index: 0, x: 46, y: 288, width: 288, height: 127, visible: true, style: { borderRadius: { topLeft: 11.52, topRight: 11.52, bottomRight: 11.52, bottomLeft: 11.52 } } };
const snapshot: any = { platform: 'android', source: 'react-native-ui-acceptance', windowWidth: 1080, windowHeight: 2400, timestamp: Date.now(), density: 3, densityDpi: 480, nodes: [node], collection: { profile: 'acceptance-full' }, acceptanceContext: context };
const actual = normalizeSdkSnapshot(snapshot, 1080, 2400).nodes[0];
const field = (name: string, d = design, a = actual, c: any = align) => buildManualFields(d, a, c).find((f) => f.label === name)!;

test('706:13558 native 69px displays in the design coordinate system without changing raw comparison', () => {
  const d = { ...design, id: '706:13558', rect: { ...design.rect, width: 24, height: 24 } };
  const a = { ...actual, pixelRect: { ...actual.pixelRect!, width: 69, height: 69 } };
  const f = field('宽度', d, a);
  const before = JSON.stringify(f);
  const scale = designAlignedScale(align)!;
  assert.equal(f.design.text, '24 px');
  assert.equal(f.actual.text, '23 dp');
  assert.equal(f.physical, '69 px');
  assert.equal(displayLengthValue(f.target, scale).text, '24 px');
  assert.equal(displayLengthValue(f.actual, scale).text, '23.96 px');
  assert.equal(f.status, 'discrepancy');
  assert.equal(JSON.stringify(f), before);
  assert.match(manualEvidence([f], align), /应有 24 px → App 23\.96 px/);
  assert.match(manualEvidence([f], align), /应有 23\.04 dp → 实测 23 dp/);
});

test('aligned presentation follows screenshot width while target computation follows device page width', () => {
  const c = { ...align, appWidth: 400, devicePageWidth: 360, scale: 375 / 400 };
  const f = field('宽度', design, actual, c);
  assert.equal(f.target.text, '96 dp');
  assert.equal(displayLengthValue(f.actual, designAlignedScale(c)).text, '90 px');
  assert.equal(displayLengthValue(f.target, designAlignedScale(c)).text, '90 px');
  assert.equal(f.status, 'consistent');
  for (const pixelRatio of [1, 2.625, 3]) {
    assert.equal(designAlignedScale({ ...align, pixelRatio, pixelWidth: 2000 }), 375 / 360);
  }
  for (const c of [undefined, { ...align, appWidth: 0 }, { ...align, appWidth: NaN }, { ...align, designWidth: -1 }]) {
    assert.equal(designAlignedScale(c), undefined);
    assert.equal(displayLengthValue(f.actual, designAlignedScale(c)), f.actual);
  }
  const missing = { text: '未采集', key: '', state: 'unavailable' as const };
  assert.equal(displayLengthValue(missing, designAlignedScale(align)), missing);
  const corners = field('圆角');
  assert.equal(displayLengthValue(corners.actual, designAlignedScale(align)).text, '12 px');
  assert.equal(displayLengthValue(field('圆角', { ...design, cornerRadius: 0 }, { ...actual, style: null }).actual,
    designAlignedScale(align)).state, 'unavailable');
});

test('699:11336 text dimensions remain reference values for dynamic, fixed and incomplete measurements', () => {
  const d = { ...design, id: '699:11336', type: 'TEXT', rect: { x: 201.5, y: 340, width: 50, height: 17 },
    layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', text: { characters: '积分商城', textAutoResize: 'HEIGHT' } };
  const a = { ...actual, pixelRect: { x: 582, y: 1186, width: 150, height: 49 } };
  for (const label of ['宽度', '高度']) {
    const f = field(label, d, a);
    assert.equal(f.status, 'reference');
    assert.match(f.reason, /仅展示数值供参考/);
    assert.ok(hasExplicitValue(f.design) && hasExplicitValue(f.target) && hasExplicitValue(f.actual));
    assert.equal(buildManualFields(d, a).find(f => f.label === label)!.status, 'reference');
    assert.equal(field(label, d, { ...a, pixelRect: undefined, width: NaN, height: NaN }).status, 'reference');
    assert.equal(field(label, { ...d, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', text: { textAutoResize: 'NONE' } }, a).status, 'reference');
  }
  assert.equal(field('宽度', d, a).target.numbers?.[0], 48);
  assert.equal(field('宽度', d, a).actual.numbers?.[0], 50);
  assert.equal(field('宽度', { ...d, type: 'FRAME', text: undefined }, a).status, 'discrepancy');
  const fixed = { ...d, type: 'FRAME', text: undefined, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' };
  assert.equal(field('宽度', fixed, a).status, 'discrepancy');
  assert.equal(field('高度', fixed, a).status, 'discrepancy');
  assert.equal(field('宽度', fixed, { ...a, text: '积分商城' }).status, 'reference');
  assert.equal(field('字号', { ...d, text: { fontSize: 12 } }, { ...a, textStyle: { fontSize: 14 } }).status, 'discrepancy');
  const diff = buildInspectionFields({ design: inspectDesign(d, [d]), app: inspectApp(a, [a]) }, align);
  assert.equal(diff.find(f => f.label === '宽度')!.status, 'reference');
  assert.equal(diff.find(f => f.label === '高度')!.status, 'reference');
});

test('706:13395 glyph fill is text color, never a box background in single inspection or diff', () => {
  const d = { ...design, id: '706:13395', name: '商品收藏', type: 'TEXT',
    fills: [{ type: 'SOLID', visible: true, opacity: 1, color: '#333333' }],
    text: { characters: '商品收藏', color: '#333333', fontSize: 12 } };
  const app = { ...actual, text: '商品收藏', textStyle: { color: '#333333', fontSize: 12 }, style: null };
  const before = JSON.stringify(d);
  const group = inspectDesign(d, [d]);
  const properties = resolveProperties('design', group, align);
  assert.equal(properties.find(p => p.label === '颜色')!.value.text, '#333333');
  assert.equal(hasExplicitValue(properties.find(p => p.label === '填充')!.value), false);
  const diff = buildInspectionFields({ design: group, app: inspectApp(app, [app]) }, align);
  assert.equal(diff.find(f => f.label === '颜色')!.status, 'consistent');
  assert.equal(visibleManualFields(diff).some(f => f.label === '填充'), false);
  // An independently measured App background still keeps the diff row.
  const withBackground = { ...app, style: { backgroundColor: '#ffffff' } };
  const fill = visibleManualFields(buildManualFields(d, withBackground, align)).find(f => f.label === '填充')!;
  assert.equal(hasExplicitValue(fill.design), false); assert.equal(hasExplicitValue(fill.target), false);
  assert.equal(fill.actual.text, '#ffffff'); assert.equal(fill.status, 'discrepancy');
  // A non-text design node's box fill remains available.
  assert.equal(hasExplicitValue(field('填充', { ...d, type: 'RECTANGLE', text: undefined }, app).design), true);
  assert.equal(JSON.stringify(d), before);
});

// Relevant stored attributes from the reported icon; raw configuration stays intact.
const locationIcon: any = { ...design, id: '699:11888', name: '定位', type: 'INSTANCE',
  hasFill: false, strokeWeight: 0.69, rect: { x: 253, y: 60, width: 22, height: 22 } };
test('699:11888 has no enabled stroke; stored width never becomes a numeric target or issue requirement', () => {
  const before = JSON.stringify(locationIcon);
  assert.equal(designStroke(locationIcon).width.text, '无描边');
  const fields = buildManualFields(locationIcon, actual, align);
  for (const label of ['描边色', '描边宽度']) {
    const f = fields.find(f => f.label === label)!;
    assert.equal(f.design.text, '无描边'); assert.equal(f.target.text, '无描边');
    assert.equal(f.design.numbers, undefined); assert.equal(f.target.numbers, undefined);
    assert.equal(f.status, 'not-applicable');
  }
  assert.doesNotMatch(manualEvidence(fields, align), /0\.69/);
  assert.equal(JSON.stringify(locationIcon), before);
});

test('empty, hidden and fully transparent stroke paints cannot activate a stored width', () => {
  for (const strokes of [[], [{ type: 'SOLID', color: '#333333', visible: false }],
    [{ type: 'SOLID', color: '#333333', opacity: 0 }], [{ type: 'SOLID', color: '#33333300' }],
    [{ type: 'GRADIENT_LINEAR', gradientStops: [{ position: 0, color: '#00000000' }, { position: 1, color: '#ffffff00' }] }]]) {
    assert.equal(designStroke({ ...locationIcon, hasFill: true, strokes }).state, 'none');
    assert.equal(field('描边宽度', { ...locationIcon, hasFill: true, strokes }).target.text, '无描边');
  }
  assert.equal(designStroke({ ...locationIcon, strokes: [{ type: 'SOLID', color: '#333333' }], opacity: 0 }).state, 'none');
});

test('a legacy node with unknown paints cannot infer a stroke from its width or a visible fill', () => {
  for (const hasFill of [true, undefined]) {
    const unknown = { ...locationIcon, hasFill, fills: [{ type: 'SOLID', color: '#333333' }] };
    const f = field('描边宽度', unknown);
    assert.equal(f.design.text, '未确认'); assert.equal(f.target.text, '未确认');
    assert.equal(f.status, 'insufficient'); assert.equal(f.target.numbers, undefined);
  }
});

test('enabled vector strokes keep real widths, scaling and explicit zero; incomplete widths remain unknown', () => {
  const vector = { ...locationIcon, type: 'VECTOR', strokes: [{ type: 'SOLID', color: '#333333' }], strokeWeight: 1.38 };
  assert.equal(designStroke(vector).state, 'present');
  assert.equal(field('描边宽度', vector).design.text, '1.38 px');
  assert.equal(field('描边宽度', vector).target.text, '1.32 dp');
  assert.equal(field('描边宽度', { ...vector, strokeWeight: 0 }).target.text, '0 dp');
  for (const strokeWeight of [undefined, NaN, -1, [1, 1]]) {
    assert.equal(field('描边宽度', { ...vector, strokeWeight }).design.text, '未确认');
    assert.equal(field('描边宽度', { ...vector, strokeWeight }).status, 'insufficient');
  }
});

test('summary, diff and provenance use effective strokes; child vector widths stay on their own nodes', () => {
  const child = { ...locationIcon, id: 'vector', parentId: locationIcon.id, type: 'VECTOR',
    rect: { x: 255.75, y: 61.38, width: 16.5, height: 19.38 }, hasFill: true, strokeWeight: 1.38 };
  const dg = inspectDesign(locationIcon, [locationIcon, child]);
  assert.equal(dg.members.length, 1);
  const single = resolveProperties('design', dg, align).find(f => f.label === '描边宽度')!;
  const diff = buildInspectionFields({ design: dg, app: inspectApp(actual, [actual]) }, align).find(f => f.label === '描边宽度')!;
  assert.deepEqual(single.value, diff.design); assert.equal(diff.target.text, '无描边');
  const peer = { ...locationIcon, id: 'peer', strokeWeight: 99 };
  const group = inspectDesign(locationIcon, [locationIcon, peer]);
  assert.equal(resolveProperties('design', group, align).find(f => f.label === '描边宽度')?.value.text, '无描边');
  const painted = { ...peer, strokes: [{ type: 'SOLID', color: '#333333' }], strokeWeight: 0.69 };
  const conflict = buildInspectionFields({ design: inspectDesign(locationIcon, [locationIcon, painted]), app: inspectApp(actual, [actual]) }, align).find(f => f.label === '描边宽度')!;
  assert.equal(conflict.design.text, '多层待确认'); assert.equal(conflict.target.text, '多层待确认');
});

const shell = { ...actual, nodeId: 'shell', index: 10, style: null, hasVisualContent: false,
  text: null, textStyle: null, contentDescription: null, isImage: false, isSvg: false, isGradient: false };
const gradient = { ...actual, nodeId: 'gradient', index: 0, className: 'LinearGradientView', hasVisualContent: true,
  isGradient: true, text: null, textStyle: null, contentDescription: null };
const groupFields = (nodes: any[], d = design, anchor = nodes[0]) => buildInspectionFields({
  design: inspectDesign(d, [d]), app: inspectApp(anchor, nodes),
}, align);

test('multi-layer numeric conflicts follow two decimal places in displayed design coordinates', () => {
  const corners = (n: number) => ({ topLeft: n, topRight: n, bottomRight: n, bottomLeft: n });
  const c = { ...align, appWidth: 500 };
  const lower = { ...gradient, isGradient: false, style: { borderRadius: corners(8.001) } };
  const upper = { ...lower, nodeId: 'upper', style: { borderRadius: corners(8.006) } };
  const before = JSON.stringify([lower, upper]);
  const radius = (peer: any) => resolveProperties('app', inspectApp(lower, [lower, peer]), c).find(p => p.label === '圆角')!;
  // Raw values round differently, but both aligned values round to 6px.
  assert.equal(radius(upper).sources.state, 'resolved');
  assert.equal(displayLengthValue(radius(upper).value, designAlignedScale(c)).text, '6 px');
  assert.equal(radius({ ...upper, style: { borderRadius: corners(8.007) } }).sources.state, 'ambiguous');
  assert.equal(radius({ ...upper, style: undefined }).sources.state, 'ambiguous');
  assert.equal(JSON.stringify([lower, upper]), before);

  const d = { ...design, cornerRadius: 8.661 };
  const designRadius = (n: number) => resolveProperties('design', inspectDesign(d, [d, { ...d, id: 'peer', cornerRadius: n }]), c).find(p => p.label === '圆角')!;
  assert.equal(designRadius(8.664).sources.state, 'resolved');
  assert.equal(designRadius(8.667).sources.state, 'ambiguous');
  assert.equal(formatManualNumbers([8.661, 8.664, 8.661, 8.664], 'px'), '8.66 px');
  assert.equal(formatManualNumbers([8.661, 8.667, 0, -0.001], 'px'), '8.66 / 8.67 / 0 / 0 px');
});

test('I699:11891;232:3248 GROUP does not turn its sibling rectangle radius into a collection conflict', () => {
  const rect = { ...design, id: 'I699:11891;232:3247', name: 'Rectangle 3677', parentId: '699:11891',
    rect: { x: 297, y: 60, width: 22, height: 22 }, cornerRadius: 0, hasFill: false,
    fills: [{ type: 'SOLID', visible: false, color: '#d9d9d9' }] };
  const group = { ...rect, id: 'I699:11891;232:3248', name: '编组-2', type: 'GROUP', cornerRadius: undefined, fills: undefined };
  const radius = (peer: any, anchor: any = peer) => resolveProperties('design', inspectDesign(anchor, [rect, peer]), align).find(p => p.label === '圆角')!;
  for (const anchor of [rect, group]) {
    const result = radius(group, anchor);
    assert.equal(result.sources.state, 'resolved');
    assert.equal(result.value.text, '0 px');
    assert.equal(result.sources.candidates.find(c => c.id === group.id)?.ignored, true);
  }
  // A roundable node with an absent radius remains unknown; a real nonzero radius still conflicts.
  assert.equal(radius({ ...group, type: 'RECTANGLE' }).sources.state, 'ambiguous');
  assert.equal(radius({ ...group, type: 'RECTANGLE', cornerRadius: 2 }).sources.state, 'ambiguous');
  assert.equal(group.cornerRadius, undefined);
});

test('a proven empty shell exposes the gradient radius identically in single inspection and diff', () => {
  const before = JSON.stringify([shell, gradient]);
  const group = inspectApp(shell, [shell, gradient]);
  const radius = resolveProperties('app', group, align).find(p => p.label === '圆角')!;
  assert.equal(group.anchor, shell);
  assert.equal(radius.owner, gradient);
  assert.equal(radius.value.text, '11.52 dp');
  assert.equal(radius.sources.candidates.find(c => c.id === 'shell')?.ignored, true);
  const diff = groupFields([shell, gradient]).find(p => p.label === '圆角')!;
  assert.deepEqual(diff.actual, radius.value);
  assert.equal(diff.target.text, '11.52 dp');
  assert.equal(diff.status, 'consistent');
  assert.equal(groupFields([shell, gradient])[0].actual.text, '96 dp');
  assert.equal(JSON.stringify([shell, gradient]), before);
});

test('unknown and painted upper layers block a radius pass; explicit zero remains a conflicting candidate', () => {
  for (const upper of [
    { ...shell, style: undefined },
    { ...shell, hasVisualContent: true, style: { backgroundColor: '#ffffffff' } },
    { ...shell, hasVisualContent: true, style: { borderRadius: { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 } } },
  ]) {
    const radius = groupFields([upper, gradient]).find(p => p.label === '圆角')!;
    assert.equal(radius.actual.text, '多层待确认');
    assert.equal(radius.status, 'insufficient');
    assert.equal(radius.sources?.app?.candidates.length, 2);
    assert.equal(radius.sources?.app?.candidates[0].ignored, false);
    assert.equal(radius.physical, undefined);
  }
  const zero = { ...gradient, nodeId: 'zero', style: { borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 } } };
  const radius = groupFields([zero, gradient]).find(p => p.label === '圆角')!;
  assert.equal(radius.sources?.app?.candidates[0].value.numbers?.[0], 0);
});

test('index, z and input order cannot resolve conflicting properties', () => {
  const red = { ...gradient, nodeId: 'red', isGradient: false, style: { backgroundColor: '#ffff0000' }, index: 0, z: 100 };
  const blue = { ...red, nodeId: 'blue', style: { backgroundColor: '#ff0000ff' }, index: 1, z: 0 };
  for (const nodes of [[red, blue], [blue, red], [{ ...red, index: 200, z: 0 }, { ...blue, index: 0, z: 100 }]]) {
    const fill = groupFields(nodes).find(p => p.label === '填充')!;
    assert.equal(fill.actual.text, '多层待确认');
    assert.equal(fill.status, 'insufficient');
  }
});

test('design and app groups resolve independently and preserve their anchors and width ratio', () => {
  const dShell = { ...design, id: 'design-shell', type: 'FRAME', fills: [], strokes: [], effects: [], cornerRadius: 0, layout: { mode: 'NONE', clipsContent: false } };
  const dPaint = { ...design, id: 'design-paint', fills: [{ type: 'SOLID', color: '#2196f3' }], strokes: [] };
  const dg = inspectDesign(dShell, [dShell, dPaint]), ag = inspectApp(shell, [shell, gradient]);
  const radius = buildInspectionFields({ design: dg, app: ag }, align).find(f => f.label === '圆角')!;
  assert.equal(radius.design.text, '12 px'); assert.equal(radius.target.text, '11.52 dp');
  assert.equal(radius.actual.text, '11.52 dp'); assert.equal(radius.status, 'consistent');
  assert.equal(dg.anchor.id, 'design-shell'); assert.equal(ag.anchor.nodeId, 'shell');
  const conflict = { ...dShell, fills: [{ type: 'SOLID', color: '#000000' }] };
  const unresolved = buildInspectionFields({ design: inspectDesign(conflict, [conflict, dPaint]), app: ag }, align).find(f => f.label === '圆角')!;
  assert.equal(unresolved.design.text, '多层待确认');
  assert.equal(unresolved.target.text, '多层待确认');
  assert.equal(unresolved.status, 'insufficient');
});

test('missing design paint channels are not evidence of a harmless shell', () => {
  const unknown = { ...design, id: 'unknown', cornerRadius: undefined, fills: undefined, strokes: undefined };
  const dg = inspectDesign(unknown, [unknown, design]);
  const radius = resolveProperties('design', dg, align).find(f => f.label === '圆角')!;
  assert.equal(radius.sources.state, 'ambiguous');
  assert.equal(radius.sources.candidates[0].ignored, false);
  for (const extra of [{ effects: undefined }, { layout: undefined }, { layout: { mode: 'NONE', clipsContent: true } }]) {
    const shell = { ...unknown, type: 'FRAME', fills: [], strokes: [], effects: [], cornerRadius: 0, layout: { mode: 'NONE', clipsContent: false }, ...extra };
    assert.equal(resolveProperties('design', inspectDesign(shell, [shell, design]), align).find(f => f.label === '圆角')?.sources.state, 'ambiguous');
  }
});

test('single-layer mode exposes the selected layer without borrowing group styles', () => {
  const groups = { design: inspectDesign(design, [design]), app: inspectApp(shell, [shell, gradient]) };
  const radius = buildInspectionFields(groups, align, { app: 'layer' }).find(f => f.label === '圆角')!;
  assert.equal(radius.actual.state, 'unavailable'); assert.equal(radius.status, 'insufficient');
  assert.deepEqual(radius.sources?.app?.candidates.map(c => c.id), ['shell']);
  assert.equal(inspectionKey('app', groups.app), inspectionKey('app', inspectApp(gradient, [gradient, shell])));
});

test('text content and fonts remain coupled; nontext anchors cannot crash optional rows', () => {
  const text = { ...shell, nodeId: 'text', text: 'Hello', textStyle: { fontFamily: 'Inter', fontSize: 16 } };
  const unknown = { ...shell, nodeId: 'unknown', text: undefined, textStyle: undefined };
  const d = { ...design, text: { characters: 'Hello', fontFamily: 'Inter', fontSize: 16 } };
  const safe = groupFields([shell, text], d).find(f => f.label === '内容')!;
  assert.equal(safe.actual.text, 'Hello'); assert.equal(safe.status, 'consistent');
  for (const nodes of [[unknown, text], [text, { ...text, nodeId: 'different', text: 'World' }]]) {
    const fields = groupFields(nodes, d);
    for (const label of ['内容', '字体', '字号']) {
      assert.equal(fields.find(f => f.label === label)?.actual.text, '多层待确认');
      assert.equal(fields.find(f => f.label === label)?.status, 'insufficient');
    }
  }
  const description = { ...shell, nodeId: 'description', contentDescription: '按钮' };
  assert.equal(groupFields([shell, description]).find(f => f.label === '辅助描述')?.actual.text, '按钮');
});

test('border color and width cannot be assembled across owners', () => {
  const color = { ...gradient, nodeId: 'color', style: { borderColor: { top: '#ff000000', right: '#ff000000', bottom: '#ff000000', left: '#ff000000' } } };
  const width = { ...gradient, nodeId: 'width', style: { borderWidth: { top: 1, right: 1, bottom: 1, left: 1 } } };
  for (const label of ['描边色', '描边宽度']) {
    const f = groupFields([color, width]).find(f => f.label === label)!;
    assert.equal(f.actual.text, '多层待确认'); assert.equal(f.status, 'insufficient');
  }
});

test('transparent, gradient and custom fills remain unconfirmed instead of claiming a composite color', () => {
  for (const extra of [{ isGradient: true }, { isImage: true }, { isSvg: true }, { alpha: 0.5 },
    { style: { backgroundColor: '#802196f3' } }]) {
    const painted = { ...gradient, isGradient: false, style: { backgroundColor: '#ff2196f3' }, ...extra };
    assert.equal(groupFields([shell, painted]).find(f => f.label === '填充')?.actual.text, '多层待确认');
  }
});

test('single linear gradients are comparable end-to-end in manual acceptance', () => {
  const d = { ...design, type: 'RECTANGLE', fills: [{ type: 'GRADIENT_LINEAR', visible: true,
    gradientStops: [{ position: 0, color: '#ff8757ff' }, { position: 1, color: '#f54238ff' }], gradientAngle: 45 }] };
  const a = { ...actual, isGradient: true, style: { gradient: {
    type: 'linear' as const, colors: ['#ffff8757', '#fff54238'], startPoint: { x: 0.5, y: 0 },
    endPoint: { x: 0.5, y: 1 }, useAngle: true, angle: 45,
  } } };
  const normalized = normalizeSdkSnapshot({ ...snapshot, nodes: [{ ...node, isGradient: true, style: a.style }] }, 1080, 2400).nodes[0];
  assert.deepEqual(normalized.style?.gradient?.colors, ['#ffff8757', '#fff54238']);
  assert.equal(normalized.style?.gradient?.angle, 45);
  const unsupported = normalizeSdkSnapshot({ ...snapshot, nodes: [{ ...node, style: { gradient: { type: 'radial', colors: a.style.gradient.colors } } }] }, 1080, 2400).nodes[0];
  assert.equal(unsupported.style?.gradient, undefined);
  const f = field('填充', d, a);
  assert.equal(f.design.text, '线性渐变 #ff8757ff → #f54238ff · 45°');
  assert.equal(f.actual.text, f.design.text);
  assert.equal(f.status, 'consistent');
  assert.equal(visibleManualFields([f]).length, 1);
  const shifted = { ...a, style: { ...a.style, gradient: { ...a.style.gradient, locations: [0, 0.25] } } };
  assert.equal(field('填充', d, shifted).status, 'discrepancy');
});

test('a transparent shell and a collected gradient expose the same fill in inspection and diff', () => {
  const d = { ...design, fills: [{ type: 'GRADIENT_LINEAR', visible: true,
    gradientStops: [{ position: 0, color: '#eef7ff' }, { position: 1, color: '#eef7ff80' }], gradientAngle: 90 }] };
  const paint = { ...gradient, alpha: 1, style: { gradient: {
    type: 'linear' as const, colors: ['#eef7ff', '#80eef7ff'],
    startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 }, useAngle: false, angle: 45,
  } } };
  const before = JSON.stringify([shell, paint]);
  for (const members of [[shell, paint], [paint, shell]]) {
    for (const anchor of members) {
      const group = inspectApp(anchor, members);
      assert.equal(group.members.length, 2);
      const single = resolveProperties('app', group, align).find(p => p.label === '填充')!;
      assert.equal(single.owner, paint);
      assert.equal(single.sources.state, 'resolved');
      assert.equal(single.sources.candidates.find(c => c.id === shell.nodeId)?.ignored, true);
      assert.equal(single.value.text, '线性渐变 #eef7ff → #eef7ff80 · 90°');
      const f = groupFields(members, d, anchor).find(f => f.label === '填充')!;
      assert.equal(f.actual.text, single.value.text);
      assert.equal(f.status, 'consistent');
      assert.equal(visibleManualFields([f]).length, 1);
      const changed = { ...d, fills: [{ ...d.fills[0], gradientStops: [
        { position: 0, color: '#ffffff' }, { position: 1, color: '#eef7ff80' },
      ] }] };
      assert.equal(groupFields(members, changed, anchor).find(f => f.label === '填充')!.status, 'discrepancy');
      const layer = resolveProperties('app', group, align, 'layer').find(p => p.label === '填充')!;
      assert.equal(hasExplicitValue(layer.value), anchor === paint);
    }
  }
  // Symmetric design groups also pass through a single collected gradient.
  const dShell = { ...design, id: 'design-shell', type: 'RECTANGLE', fills: [], strokes: [], effects: [], cornerRadius: 0 };
  const designs = inspectDesign(dShell, [dShell, d]);
  assert.equal(designs.members.length, 2);
  const designFill = resolveProperties('design', designs, align).find(p => p.label === '填充')!;
  assert.equal(designFill.owner, d);
  assert.equal(designFill.sources.state, 'resolved');
  assert.equal(buildInspectionFields({ design: designs, app: inspectApp(shell, [shell, paint]) }, align)
    .find(f => f.label === '填充')!.status, 'consistent');
  // A second painted or uncollected layer must not silently disappear.
  for (const extra of [{ ...shell, style: undefined },
    { ...shell, hasVisualContent: true, style: { backgroundColor: '#ffffff' } },
    { ...paint, nodeId: 'second-gradient' }]) {
    assert.equal(groupFields([extra, paint], d).find(f => f.label === '填充')!.status, 'insufficient');
  }
  assert.equal(JSON.stringify([shell, paint]), before);
});

test('iOS exact-bound gradient parent and empty-style content host form the same two-layer inspection from either node', () => {
  const parentId = 'sdk:0/0/0/0/0/0/0/0/0/0/0/0/0/1/0/0/0/0/0/1/0/0/0/1/0/0/0/0/1/0/0/0/0/1/0/1/16/0';
  const pixelRect = { x: 72.99999904632568, y: 1343.9999771118164, width: 520.0000305175781, height: 154.00003051757812 };
  const corners = { topLeft: 8.666666666666666, topRight: 8.666666666666666, bottomRight: 8.666666666666666, bottomLeft: 8.666666666666666 };
  const parent = { ...gradient, nodeId: parentId, parentId: 'outer', className: 'BVLinearGradient',
    x: 24.33, y: 448, width: 173.33, height: 51.33, pixelRect, alpha: 1, clipsToBounds: true,
    style: { borderRadius: corners, gradient: { type: 'linear' as const, colors: ['#fff3ed', '#80fff3ed'],
      startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 }, useAngle: false, angle: 45 } } };
  const child = { ...shell, nodeId: parentId + '/0', parentId, className: 'RCTViewComponentView',
    x: parent.x, y: parent.y, width: parent.width, height: parent.height, pixelRect: { ...pixelRect },
    style: {}, alpha: 1, clipsToBounds: false };
  const outer = { ...child, nodeId: 'outer', parentId: 'page', width: 200, pixelRect: { ...pixelRect, width: 600 } };
  const unrelated = { ...child, nodeId: 'other-branch', parentId: 'elsewhere' };
  const content = { ...child, nodeId: 'text', parentId: child.nodeId, width: 60,
    pixelRect: { ...pixelRect, width: 180 }, hasVisualContent: true, text: '内容', textStyle: { fontSize: 16 } };
  const d = { ...design, fills: [{ type: 'GRADIENT_LINEAR', gradientAngle: 90,
    gradientStops: [{ position: 0, color: '#fff3ed' }, { position: 1, color: '#fff3ed80' }] }] };
  const ios = { ...align, platform: 'ios' as const };
  const nodes = [outer, parent, child, content, unrelated];
  const before = JSON.stringify(nodes);
  for (const members of [nodes, [...nodes].reverse()]) {
    for (const anchor of [parent, child]) {
      const group = inspectApp(anchor, members);
      assert.equal(group.anchor, anchor);
      assert.deepEqual(new Set(group.members.map(n => n.nodeId)), new Set([parentId, child.nodeId]));
      assert.equal(inspectionKey('app', group), inspectionKey('app', inspectApp(child, nodes)));
      const properties = resolveProperties('app', group, ios);
      for (const label of ['填充', '圆角']) {
        const property = properties.find(p => p.label === label)!;
        assert.equal(property.owner, parent);
        assert.equal(property.sources.state, 'resolved');
        assert.equal(property.sources.candidates.find(c => c.id === child.nodeId)?.ignored, true);
      }
      const fill = properties.find(p => p.label === '填充')!;
      assert.equal(fill.value.text, '线性渐变 #fff3ed → #fff3ed80 · 90°');
      const groups = { design: inspectDesign(d, [d]), app: group };
      const diff = buildInspectionFields(groups, ios).find(f => f.label === '填充')!;
      assert.equal(diff.actual.text, fill.value.text);
      assert.equal(diff.actual.state, fill.value.state);
      assert.equal(diff.status, 'consistent');
      const single = buildInspectionFields(groups, ios, { app: 'layer' }).find(f => f.label === '填充')!;
      assert.equal(hasExplicitValue(single.actual), anchor === parent);
      assert.deepEqual(single.sources?.app?.candidates.map(c => c.id), [anchor.nodeId]);
    }
  }
  assert.equal(JSON.stringify(nodes), before);
});

test('Android and iOS grouping depends on exact bounds and hierarchy, independently of layer properties', () => {
  const parent = { ...gradient, nodeId: 'paint', parentId: 'page', alpha: 1 };
  const child = { ...shell, nodeId: 'host', parentId: parent.nodeId, style: {}, alpha: 1 };
  for (const changed of [
    { ...child, style: undefined }, { ...child, style: { borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 } } },
    { ...child, hasVisualContent: true }, { ...child, clipsToBounds: true }, { ...child, alpha: 0.5 },
    { ...child, text: 'text', textStyle: { fontSize: 16 } }, { ...child, textStyle: undefined },
  ]) {
    const nodes = [parent, changed];
    for (const anchor of nodes) assert.equal(inspectApp(anchor, nodes).members.length, 2);
  }
  const secondChild = { ...child, nodeId: 'another-child', width: 1, pixelRect: { ...child.pixelRect!, width: 3 } };
  const siblings = [parent, child, secondChild];
  assert.deepEqual(inspectApp(parent, siblings).members.map(n => n.nodeId), ['paint', 'host']);
  const emptyParent = { ...child, nodeId: 'empty-parent', parentId: 'page' };
  const emptyChild = { ...child, parentId: emptyParent.nodeId };
  assert.equal(inspectApp(emptyParent, [emptyParent, emptyChild]).members.length, 2);
  const sibling = { ...parent, nodeId: 'sibling', isGradient: false, style: { backgroundColor: '#ffffff' } };
  const connected = [parent, child, sibling];
  for (const anchor of connected) {
    const group = inspectApp(anchor, connected);
    assert.equal(group.members.length, 3);
    assert.equal(resolveProperties('app', group, align).find(p => p.label === '填充')!.sources.state, 'ambiguous');
  }
});

test('App parent-child groups reject unequal or missing native bounds, hidden/clipped/zero nodes and disconnected branches', () => {
  const parent = { ...gradient, nodeId: 'parent', parentId: 'page' };
  const child = { ...shell, nodeId: 'child', parentId: parent.nodeId, style: {} };
  for (const changed of [
    { ...child, pixelRect: undefined },
    ...(['x', 'y', 'width', 'height'] as const).map(key => ({ ...child,
      pixelRect: { ...child.pixelRect!, [key]: child.pixelRect![key] + 1e-10 } })),
    { ...child, visible: false }, { ...child, clippedOut: true }, { ...child, width: 0 }, { ...child, height: 0 },
  ]) {
    const nodes = [parent, changed];
    for (const anchor of nodes) assert.equal(inspectApp(anchor, nodes).members.length, 1);
  }
  const middle = { ...child, nodeId: 'middle', pixelRect: { ...child.pixelRect!, width: child.pixelRect!.width + 1 } };
  const descendant = { ...child, parentId: middle.nodeId };
  const elsewhere = { ...child, nodeId: 'other', parentId: 'other-branch' };
  const nodes = [parent, middle, descendant, elsewhere];
  for (const anchor of nodes) assert.equal(inspectApp(anchor, nodes).members.length, 1);
  const legacy = [{ ...parent, pixelRect: undefined }, { ...child, pixelRect: undefined }];
  assert.equal(inspectApp(legacy[0], legacy).members.length, 2);
  assert.equal(inspectApp({ ...parent, visible: false }, [{ ...parent, visible: false }, child]).members.length, 1);
  // A malformed parent cycle must terminate and return the same connected group.
  const cycle = [{ ...parent, parentId: child.nodeId }, child];
  for (const anchor of cycle) assert.equal(inspectApp(anchor, cycle).members.length, 2);
});

test('three coincident native layers retain gradient provenance and merge equal displayed radii on both platforms', () => {
  const baseId = 'sdk:0/0/0/0/0/0/0/0/0/0/0/0/0/1/0/0/0/0/0/1/0/0/0/1/0/0/0/0/1/0/0/0/0/1/0/1/16';
  const pixelRect = { x: 72.99999904632568, y: 1343.9999771118164, width: 520.0000305175781, height: 154.00003051757812 };
  const corners = (n: number) => ({ topLeft: n, topRight: n, bottomRight: n, bottomLeft: n });
  const d = { ...design, fills: [{ type: 'GRADIENT_LINEAR', gradientAngle: 90,
    gradientStops: [{ position: 0, color: '#fff3ed' }, { position: 1, color: '#fff3ed80' }] }] };
  for (const platform of ['android', 'ios'] as const) {
    const outer = { ...shell, nodeId: baseId, parentId: 'page', x: 24.33, y: 448, width: 173.33, height: 51.33,
      pixelRect, alpha: 1, clipsToBounds: true, className: platform === 'ios' ? 'RCTLegacyViewManagerInteropComponentView' : 'ReactViewGroup',
      style: { borderRadius: corners(8.666666984558105) } };
    const paint = { ...outer, nodeId: baseId + '/0', parentId: baseId, hasVisualContent: true, isGradient: true,
      className: platform === 'ios' ? 'BVLinearGradient' : 'LinearGradientView',
      style: { borderRadius: corners(8.666666666666666), gradient: { type: 'linear' as const, colors: ['#fff3ed', '#80fff3ed'],
        startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 }, useAngle: false, angle: 45 } } };
    const host = { ...outer, nodeId: baseId + '/0/0', parentId: paint.nodeId, clipsToBounds: false,
      className: platform === 'ios' ? 'RCTViewComponentView' : 'ReactViewGroup', style: platform === 'ios' ? {} : null };
    const nodes = [outer, paint, host];
    const before = JSON.stringify(nodes);
    const ctx = { ...align, platform };
    for (const members of [nodes, [host, outer, paint], [...nodes].reverse()]) {
      for (const anchor of nodes) {
        const group = inspectApp(anchor, members);
        assert.equal(group.anchor, anchor);
        assert.equal(group.members.length, 3);
        assert.equal(inspectionKey('app', group), inspectionKey('app', inspectApp(host, nodes)));
        const properties = resolveProperties('app', group, ctx);
        const fill = properties.find(p => p.label === '填充')!;
        assert.equal(fill.owner, paint);
        assert.equal(fill.sources.state, 'resolved');
        assert.equal(fill.value.text, '线性渐变 #fff3ed → #fff3ed80 · 90°');
        assert.deepEqual(new Set(fill.sources.candidates.filter(c => c.ignored).map(c => c.id)), new Set([outer.nodeId, host.nodeId]));
        const radius = properties.find(p => p.label === '圆角')!;
        assert.equal(radius.sources.state, 'resolved');
        assert.equal(displayLengthValue(radius.value, designAlignedScale(ctx)).text, '9.03 px');
        assert.equal(hasPropertyValue(radius.value, radius.sources), true);
        assert.deepEqual(new Set(radius.sources.candidates.filter(c => !c.ignored).map(c => c.value.numbers![0])),
          new Set([8.666666984558105, 8.666666666666666]));
        const groups = { design: inspectDesign(d, [d]), app: group };
        const diff = buildInspectionFields(groups, ctx);
        assert.equal(diff.find(f => f.label === '填充')!.status, 'consistent');
        assert.equal(diff.find(f => f.label === '圆角')!.status, 'discrepancy');
        assert.equal(diff.find(f => f.label === '圆角')!.actual.text, `8.67 ${platform === 'ios' ? 'pt' : 'dp'}`);
        assert.equal(visibleManualFields(diff).some(f => f.label === '圆角'), true);
        const noDesignRadius = { ...d, cornerRadius: undefined };
        const actualOnly = buildInspectionFields({ design: inspectDesign(noDesignRadius, [noDesignRadius]), app: group }, ctx);
        assert.equal(hasExplicitValue(actualOnly.find(f => f.label === '圆角')!.design), false);
        assert.equal(visibleManualFields(actualOnly).some(f => f.label === '圆角'), true);
        const single = resolveProperties('app', group, ctx, 'layer');
        assert.ok(single.every(p => p.owner === anchor && p.sources.candidates.length === 1 && p.sources.state === 'resolved'));
        assert.equal(hasExplicitValue(single.find(p => p.label === '填充')!.value), anchor === paint);
        assert.match(inspectionEvidence(groups), /"scope":"element"/);
      }
    }
    const sameRadius = { ...outer, style: { borderRadius: paint.style.borderRadius } };
    assert.equal(resolveProperties('app', inspectApp(sameRadius, [sameRadius, paint, host]), ctx)
      .find(p => p.label === '圆角')!.sources.state, 'resolved');
    // Unknown fills, another painted background, and ancestor opacity still block a false pass.
    for (const changed of [{ ...outer, style: undefined }, { ...outer, alpha: 0.5 },
      { ...outer, style: { ...outer.style, backgroundColor: '#ffffff' } }, { ...outer, hasVisualContent: true }]) {
      const group = inspectApp(host, [changed, paint, host]);
      assert.equal(group.members.length, 3);
      assert.equal(buildInspectionFields({ design: inspectDesign(d, [d]), app: group }, ctx)
        .find(f => f.label === '填充')!.status, 'insufficient');
    }
    assert.equal(JSON.stringify(nodes), before);
  }
});

test('property visibility keeps collected conflict values without exposing empty or ignored-only sources', () => {
  const value = { text: '多层待确认', key: '', state: 'unavailable' as const };
  const absent = { text: '未采集', key: '', state: 'unavailable' as const };
  const zero = { text: '0 dp', key: '0', state: 'value' as const, numbers: [0, 0, 0, 0] };
  const sources = { state: 'ambiguous' as const, reason: '冲突', candidates: [
    { id: 'a', name: 'View', value: zero }, { id: 'b', name: 'View', value: absent },
  ] };
  assert.equal(hasExplicitValue(value), false); // No fabricated composite number.
  assert.equal(hasPropertyValue(value, sources), true);
  const f = { label: '圆角', design: absent, target: absent, actual: value,
    status: 'insufficient' as const, reason: sources.reason, sources: { app: sources } };
  assert.deepEqual(visibleManualFields([f]), [f]);
  assert.equal(visibleManualFields([{ ...f, sources: { design: sources } }]).length, 1);
  for (const missingSources of [undefined, { ...sources, candidates: [] },
    { ...sources, candidates: sources.candidates.map(c => ({ ...c, value: absent })) },
    { ...sources, candidates: sources.candidates.map(c => ({ ...c, ignored: true })) },
    { ...sources, candidates: [{ id: 'bad', name: 'View', value: { ...zero, numbers: [NaN] } }] },
  ]) {
    assert.equal(hasPropertyValue(value, missingSources), false);
    assert.equal(visibleManualFields([{ ...f, sources: { app: missingSources } }]).length, 0);
  }
});

test('layers equal at two decimals merge while evidence freezes original precision and scopes', () => {
  const corners = (v: number) => ({ topLeft: v, topRight: v, bottomRight: v, bottomLeft: v });
  const first = { ...gradient, nodeId: 'first', style: { borderRadius: corners(11.52) } };
  const second = { ...gradient, nodeId: 'second', style: { borderRadius: corners(11.5200000001) } };
  const groups = { design: inspectDesign(design, [design]), app: inspectApp(first, [first, second]) };
  const fields = buildInspectionFields(groups, align);
  assert.equal(fields.find(f => f.label === '圆角')?.status, 'consistent');
  const frozen = manualEvidence(fields, align) + '\n' + inspectionEvidence(groups);
  assert.match(frozen, /11.5200000001/); assert.match(frozen, /"anchorId":"first"/);
  assert.match(frozen, /"memberIds":\["first","second"\]/); assert.match(frozen, /"scope":"element"/);
  buildInspectionFields({ ...groups, app: inspectApp(second, [first, second]) }, align, { app: 'layer' });
  assert.match(frozen, /"anchorId":"first"/);
});

test('coincident nodes require exact position and size without rounding or tolerance', () => {
  const base = toRenderNode({ ...design, index: 0, visible: true }, 'design');
  const identical = { ...base, id: 'identical', index: 1, rect: { ...base.rect } };
  for (const axis of ['x', 'y', 'width', 'height'] as const) {
    for (const delta of [0.5, 0.4, 0.001, 1e-10]) {
      const different = { ...base, id: 'different', index: 2, rect: { ...base.rect, [axis]: base.rect[axis] + delta } };
      const nodes = [base, identical, different];
      assert.deepEqual(stackOf(nodes, base.id).map(n => n.id), [base.id, identical.id], `${axis} differs by ${delta}`);
      assert.deepEqual(stackOf(nodes, different.id).map(n => n.id), [different.id]);
    }
  }
});

test('native bounds survive the render conversion and prevent rounded logical rectangles from merging', () => {
  const base = toRenderNode(actual, 'app');
  assert.deepEqual(base.pixelRect, actual.pixelRect);
  for (const axis of ['x', 'y', 'width', 'height'] as const) {
    const changed = toRenderNode({ ...actual, nodeId: 'changed', index: 1,
      pixelRect: { ...actual.pixelRect!, [axis]: actual.pixelRect![axis] + 1 } }, 'app');
    assert.deepEqual(changed.rect, base.rect); // Same rounded presentation; distinct original physical bounds.
    assert.deepEqual(stackOf([base, changed], base.id).map(n => n.id), [base.id]);
  }
  const sameNative = toRenderNode({ ...actual, nodeId: 'same-native', index: 1, x: actual.x + 0.001 }, 'app');
  assert.deepEqual(stackOf([base, sameNative], base.id).map(n => n.id), [base.id, sameNative.id]);
  const legacy = toRenderNode({ ...actual, nodeId: 'legacy', pixelRect: undefined, index: 2 }, 'app');
  assert.deepEqual(stackOf([base, sameNative, legacy], legacy.id).map(n => n.id), [legacy.id]);
  assert.deepEqual(stackOf([base, sameNative, legacy], base.id).map(n => n.id), [base.id, sameNative.id]);
});

test('nearby nodes cannot form a changing coincident group when selection switches', () => {
  const nodes = [0, 0.4, 0.8].map((offset, index) => toRenderNode({ ...design,
    id: `node-${index}`, index, visible: true, rect: { ...design.rect, x: design.rect.x + offset } }, 'design'));
  for (const node of nodes) assert.deepEqual(stackOf(nodes, node.id).map(n => n.id), [node.id]);
});

test('device targets are independent of SDK policy, font scale, and measured node values', () => {
  const baseline = field('宽度').target;
  for (const c of [
    { ...align, acceptanceContext: undefined },
    { ...align, acceptanceContext: { ...context, fontScale: 1.5, design: { width: 999, height: 999, unitsPerPoint: 3,
      rules: { width: { scale: 'unknown', rounding: 'logical-integer' } } } } },
  ]) {
    assert.deepEqual(field('宽度', design, { ...actual, pixelRect: undefined, width: 999,
      acceptanceRules: { width: { scale: 'fixed', rounding: 'logical-integer' } } } as any, c).target, baseline);
  }
});

test('375 → 360 scales design values continuously; native geometry retains full precision', () => {
  assert.equal(field('宽度').design.text, '100 px');
  assert.equal(field('宽度').target.text, '96 dp');
  assert.equal(field('宽度').actual.text, '96 dp');
  assert.equal(field('宽度').status, 'consistent');
  assert.equal(field('高度').target.text, '42.24 dp');
  assert.equal(field('高度').actual.text, '42.33 dp');
  assert.equal(field('高度').actual.numbers![0], 127 / 3);
  assert.equal(field('高度').status, 'discrepancy');
});
test('radius keeps fractional runtime semantics; density does not round it into a different scalar', () => {
  assert.equal(field('圆角').target.text, '11.52 dp');
  assert.equal(field('圆角').actual.text, '11.52 dp');
  assert.equal(field('圆角').physical, '34.56 px');
  assert.equal(field('圆角').status, 'consistent');
});
test('legacy SDK utility: fixed, width, height and minimum scaling stay distinct on short and tall windows', () => {
  const short = { ...context, viewport: { width: 375, height: 600 } };
  assert.equal(acceptanceTarget(100, { scale: 'fixed', rounding: 'none' }, short), 100);
  assert.equal(acceptanceTarget(100, { scale: 'width', rounding: 'none' }, short), 100);
  assert.ok(Math.abs(acceptanceTarget(100, { scale: 'min', rounding: 'none' }, short)! - 100 * 600 / 667) < 1e-8);
  assert.ok(acceptanceTarget(100, { scale: 'height', rounding: 'none' }, context)! > 100);
});
test('legacy SDK utility: 2x design density differs from PNG export scale', () => {
  const doubled = { ...context, design: { ...context.design!, width: 750, height: 1334, unitsPerPoint: 2 } };
  assert.equal(acceptanceTarget(200, { scale: 'width', rounding: 'none' }, doubled), 96);
  assert.equal(acceptanceTarget(32, { scale: 'fixed', rounding: 'none' }, doubled), 16);
});
test('legacy SDK utility: fractional density, snap then integer, and unsnapped values follow exact declarations', () => {
  const c = { ...context, pixelRatio: 2.625 };
  const raw = acceptanceTarget(12, { scale: 'width', rounding: 'none' }, c)!;
  assert.equal(raw, 11.52);
  assert.equal(acceptanceTarget(12, { scale: 'width', rounding: 'nearest-pixel' }, c), Math.round(raw * 2.625) / 2.625);
  assert.equal(acceptanceTarget(12, { scale: 'width', rounding: 'pixel-then-integer' }, c), Math.round(Math.round(raw * 2.625) / 2.625));
});
test('node rules and legacy snapshots do not alter platform targets or equality', () => {
  for (const rule of [{ scale: 'fixed', rounding: 'logical-integer' }, { scale: 'unknown', rounding: 'none' }]) {
    const overridden = { ...actual, acceptanceRules: { width: rule } };
    assert.equal(field('宽度', design, overridden as any).target.text, '96 dp');
    assert.equal(field('宽度', design, overridden as any).status, 'consistent');
  }
  assert.equal(field('宽度', design, actual, { ...align, acceptanceContext: undefined }).status, 'consistent');
});
test('only real design/page widths change targets; density, screenshot and declared viewport do not', () => {
  assert.equal(field('宽度', design, actual, { ...align, designWidth: 400 }).target.text, '90 dp');
  assert.equal(field('宽度', design, actual, { ...align, devicePageWidth: 320 }).target.text, '85.33 dp');
  assert.equal(field('宽度', design, actual, { ...align, appWidth: 400, devicePageWidth: 360 }).target.text, '96 dp');
  for (const pixelRatio of [1, 2.625, 3]) {
    const c = { ...align, pixelRatio, acceptanceContext: { ...context, viewport: { width: 123, height: 456 } } };
    assert.equal(field('宽度', design, actual, c).target.text, '96 dp');
  }
  for (const c of [undefined, { ...align, designWidth: 0 }, { ...align, devicePageWidth: NaN }, { ...align, devicePageWidth: -1 }]) {
    const f = buildManualFields(design, actual, c).find((v) => v.label === '宽度')!;
    assert.equal(f.target.state, 'unavailable');
    assert.equal(f.status, 'insufficient');
  }
});
test('uncertain geometry retains the design-derived reference but remains unjudged', () => {
  for (const d of [{ ...design, rotation: 15 }, { ...design, rectEstimated: true }, { ...design, text: { textAutoResize: 'WIDTH_AND_HEIGHT' } }]) {
    assert.equal(field('宽度', d).status, 'insufficient');
    assert.equal(field('宽度', d).target.text, '96 dp');
  }
  assert.equal(field('圆角', design, { ...actual, style: {} }).actual.text, '未采集');
  assert.equal(field('圆角', design, { ...actual, style: null }).actual.state, 'unavailable');
});
test('699:11361 FILL container dimensions compare using page ratio and the raw pixel rectangle', () => {
  const d = { ...design, id: '699:11361', type: 'FRAME', rect: { x: 12, y: 399, width: 351, height: 126 },
    layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FIXED' };
  const a = { ...actual, nodeId: 'sdk:container20', text: null, pixelRect: { x: 35, y: 1369, width: 1010, height: 351 } };
  const fields = buildInspectionFields({ design: inspectDesign(d, [d]), app: inspectApp(a, [a]) }, align);
  const width = fields.find(f => f.label === '宽度')!;
  assert.equal(width.target.text, '336.96 dp');
  assert.equal(width.actual.text, '336.67 dp');
  assert.equal(width.status, 'discrepancy');
  assert.equal(fields.find(f => f.label === '高度')!.status, 'discrepancy');
  for (const layoutSizingHorizontal of ['FILL', 'HUG']) {
    const container = { ...design, type: 'FRAME', layoutSizingHorizontal };
    assert.equal(field('宽度', container).status, 'consistent');
    assert.equal(field('宽度', container, { ...actual, pixelRect: { ...actual.pixelRect!, width: 300 } }).status, 'discrepancy');
    assert.equal(buildManualFields(container, actual).find(f => f.label === '宽度')!.status, 'insufficient');
  }
  for (const horizontal of ['STRETCH', 'SCALE']) {
    assert.equal(field('宽度', { ...design, constraints: { horizontal } }).status, 'consistent');
  }
});
test('all geometry differences are discrepancies regardless of device pixel density', () => {
  assert.equal(field('宽度', design, { ...actual, pixelRect: { ...actual.pixelRect!, width: 289 } }).status, 'discrepancy');
  assert.equal(field('宽度', design, { ...actual, pixelRect: { ...actual.pixelRect!, width: 290 } }).status, 'discrepancy');
  for (const pixelRatio of [1, 2, 3, 4]) {
    for (const delta of [0.000001, 0.01, 0.1, 0.5]) {
      assert.equal(field('宽度', design, { ...actual, pixelRect: undefined, width: 96 + delta }, { ...align, pixelRatio }).status, 'discrepancy');
      const selected = { x: 0, y: 0, width: 10, height: 10 };
      const d = { selected, other: { x: 20, y: 0, width: 10, height: 10 } };
      const a = { selected, other: { x: 19.6 + delta, y: 0, width: 10, height: 10 } };
      assert.equal(buildSpacingFields(d, a, { ...align, pixelRatio }).find(f => f.label === '水平间距')!.status, 'discrepancy');
    }
  }
  // Continuous proportional calculations still treat mathematically equal numbers as equal.
  assert.equal(field('宽度', { ...design, rect: { ...design.rect, width: 0.1 } },
    { ...actual, pixelRect: undefined, width: 0.096 }).status, 'consistent');
});
test('missing border widths and incomplete side/corner samples never become measured zero', () => {
  const c = { ...align, acceptanceContext: { ...context, design: { ...context.design!, rules: {
    ...context.design!.rules, borderWidth: { scale: 'fixed', rounding: 'none' },
  } } } };
  const d = { ...design, strokeWeight: 0, strokes: [{ type: 'SOLID', color: '#000000' }] };
  const colorOnly = { ...actual, style: { borderColor: { top: '#000000', right: null, bottom: null, left: null } } };
  assert.equal(field('描边宽度', d, colorOnly, c).actual.text, '未采集');
  assert.equal(field('描边宽度', d, colorOnly, c).status, 'insufficient');
  const partial = normalizeSdkSnapshot({ ...snapshot, nodes: [{ ...node, style: {
    borderWidth: { top: 0 }, borderRadius: { topLeft: 0 },
  } }] }, 1080, 2400).nodes[0];
  assert.equal(field('描边宽度', d, partial, c).status, 'insufficient');
  assert.equal(field('圆角', { ...design, cornerRadius: 0 }, partial, c).status, 'insufficient');
  assert.equal(field('描边宽度', d, { ...actual, style: null }, c).status, 'insufficient');
});
test('zero design radius matches unset App radius without inventing measured values', () => {
  const unsetStyles = [undefined, null, {}, { borderRadius: null },
    { borderRadius: { topLeft: null, topRight: null, bottomRight: null, bottomLeft: null } }];
  for (const cornerRadius of [0, [0, 0, 0, 0]]) {
    for (const style of unsetStyles) {
      const d = { ...design, id: '699:11890', cornerRadius };
      const app = normalizeSdkSnapshot({ ...snapshot, nodes: [{ ...node, style }] }, 1080, 2400).nodes[0];
      const before = JSON.stringify([d, app]);
      const f = buildInspectionFields({ design: inspectDesign(d, [d]), app: inspectApp(app, [app]) }, align)
        .find(f => f.label === '圆角')!;
      assert.equal(f.status, 'consistent');
      assert.equal(f.target.text, '0 dp');
      assert.equal(f.actual.state, 'unavailable');
      assert.equal(visibleManualFields([f]).length, 1);
      assert.match(f.reason, /未设置圆角/);
      assert.equal(field('圆角', design, app).status, 'insufficient');
      assert.equal(JSON.stringify([d, app]), before);
    }
  }
  const d = { ...design, cornerRadius: 0 };
  assert.equal(buildManualFields(d, { ...actual, style: null }).find(f => f.label === '圆角')!.status, 'consistent');
  assert.equal(field('圆角', d, { ...actual, style: { borderRadius: {
    topLeft: 0, topRight: 0, bottomRight: 1, bottomLeft: 0,
  } } }).status, 'discrepancy');
  for (const v of [0, 1, NaN, Infinity]) {
    assert.equal(field('圆角', d, { ...actual, style: { borderRadius: {
      topLeft: v, topRight: null, bottomRight: null, bottomLeft: null,
    } } }).status, 'insufficient');
    const incomplete = normalizeSdkSnapshot({ ...snapshot, nodes: [{ ...node, style: { borderRadius: { topLeft: v } } }] }, 1080, 2400).nodes[0];
    assert.equal(field('圆角', d, JSON.parse(JSON.stringify(incomplete))).status, 'insufficient');
  }
  const other = { ...actual, nodeId: 'other', style: { borderRadius: {
    topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4,
  } } };
  const fields = buildInspectionFields({ design: inspectDesign(d, [d]),
    app: { anchor: actual, members: [{ ...actual, style: null, hasVisualContent: true }, other] } }, align);
  assert.equal(fields.find(f => f.label === '圆角')!.status, 'insufficient');
});
test('text nodes never turn null box styles into zero; explicit measured zeros remain visible', () => {
  const d = { ...design, type: 'TEXT', cornerRadius: undefined, strokes: [], text: { characters: 'Hello', fontSize: 16 } };
  const textNode = { ...node, text: 'Hello', textStyle: { fontSize: 16 } };
  const missingStyles = [undefined, null, {},
    { borderWidth: null, borderRadius: null },
    { borderWidth: { top: null, right: null, bottom: null, left: null },
      borderRadius: { topLeft: null, topRight: null, bottomRight: null, bottomLeft: null } },
    { borderWidth: { top: 0, right: null, bottom: 0, left: 0 },
      borderRadius: { topLeft: 0, topRight: 0, bottomRight: null, bottomLeft: 0 } },
  ];
  for (const style of missingStyles) {
    const raw = { ...snapshot, nodes: [{ ...textNode, style }] };
    const before = JSON.stringify(raw);
    const app = normalizeSdkSnapshot(raw, 1080, 2400).nodes[0];
    const properties = resolveProperties('app', inspectApp(app, [app]), align);
    const diff = buildInspectionFields({ design: inspectDesign(d, [d]), app: inspectApp(app, [app]) }, align);
    for (const label of ['描边宽度', '圆角']) {
      const single = properties.find(p => p.label === label)!;
      assert.equal(hasExplicitValue(single.value), false);
      assert.deepEqual(diff.find(f => f.label === label)!.actual, single.value);
      assert.equal(visibleManualFields(diff).some(f => f.label === label), false);
      // A real design value keeps the diff row without fabricating an App measurement.
      const required = field(label, { ...d, cornerRadius: 0, strokes: [{ type: 'SOLID', color: '#000000' }], strokeWeight: 0 }, app);
      assert.equal(visibleManualFields([required]).length, 1);
      assert.equal(required.actual.state, 'unavailable');
      assert.equal(required.status, label === '圆角' && style !== missingStyles[5] ? 'consistent' : 'insufficient');
    }
    assert.equal(JSON.stringify(raw), before);
  }
  const zero = normalizeSdkSnapshot({ ...snapshot, nodes: [{ ...textNode, style: {
    borderWidth: { top: 0, right: 0, bottom: 0, left: 0 },
    borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
  } }] }, 1080, 2400).nodes[0];
  const properties = resolveProperties('app', inspectApp(zero, [zero]), align);
  const diff = buildInspectionFields({ design: inspectDesign(d, [d]), app: inspectApp(zero, [zero]) }, align);
  for (const label of ['描边宽度', '圆角']) {
    assert.equal(properties.find(p => p.label === label)!.value.text, '0 dp');
    assert.equal(visibleManualFields(diff).find(f => f.label === label)!.actual.text, '0 dp');
  }
});
test('font scaling uncertainty and non-solid paints do not produce a false pass', () => {
  const d = { ...design, text: { characters: 'Hello', fontSize: 16 }, fills: [{ type: 'IMAGE' }] };
  const a = { ...actual, text: 'hello', textStyle: { fontSize: 16 } };
  assert.equal(field('内容', d, a).status, 'discrepancy');
  assert.equal(field('填充', d, a).status, 'insufficient');
  const textField = field('字号', d, a, { ...align, acceptanceContext: { ...context, fontScale: 1.3 } });
  assert.equal(textField.status, 'insufficient');
  assert.equal(textField.target.text, '15.36 dp');
});
test('spacing includes tiny/zero gaps and overlap; distances are facts, not inferred padding', () => {
  const selected = { x: 0, y: 0, width: 100, height: 40 };
  const d = { selected, other: { x: 116, y: 0, width: 80, height: 40 } };
  for (const [x, expected] of [[100, '0 dp'], [100.2, '0.2 dp'], [98, '-2 dp']] as const) {
    const fields = buildSpacingFields(d, { selected, other: { x, y: 0, width: 80, height: 40 } }, align);
    assert.equal(fields.find((f) => f.label === '水平间距')?.actual.text, expected);
    assert.equal(fields.find((f) => f.label === '水平间距')?.status, 'discrepancy');
  }
  const outer = { selected: { x: 0, y: 0, width: 100, height: 100 }, other: { x: 0, y: 0, width: 90, height: 90 } };
  assert.equal(buildSpacingFields(outer, undefined, align).find((f) => f.label === '左边距离')?.design.text, '0 px');
  const reversed = { selected: { ...selected, x: 116 }, other: { x: 0, y: 0, width: 100, height: 40 } };
  const reversedField = buildSpacingFields(d, reversed, align).find((f) => f.label === '水平间距')!;
  assert.equal(reversedField.status, 'insufficient');
  assert.equal(reversedField.target.text, '15.36 dp');
});
test('all length attributes and spacing use the same width ratio without SDK rules', () => {
  const d = { ...design, strokeWeight: 2, strokes: [{ type: 'SOLID', color: '#000000' }], text: { characters: 'A', fontSize: 16, lineHeight: 24, letterSpacing: 1 } };
  const legacy = { ...align, acceptanceContext: undefined };
  for (const [name, expected] of [['宽度', '96 dp'], ['高度', '42.24 dp'], ['圆角', '11.52 dp'],
    ['描边宽度', '1.92 dp'], ['字号', '15.36 dp'], ['行高', '23.04 dp'], ['字距', '0.96 dp']]) {
    assert.equal(field(name, d, actual, legacy).target.text, expected);
  }
  const gap = buildSpacingFields({ selected: design.rect, other: { ...design.rect, x: 132 } }, undefined, legacy)[0];
  assert.equal(gap.target.text, '15.36 dp');
  assert.equal(gap.actual.text, '未采集');
});
test('iOS uses pt; screenshot pixel width and display zoom cannot change a measurement', () => {
  const ios = { ...align, platform: 'ios', pixelWidth: 500, acceptanceContext: { ...context, logicalUnit: 'pt' } };
  assert.equal(field('宽度', design, actual, ios).actual.text, '96 pt');
  assert.equal(field('宽度', design, actual, { ...ios, scale: 0.25, pixelWidth: 900 }).actual.text, '96 pt');
});
test('SDK metadata survives normalization and JSON roundtrip; raw native rectangle is retained', () => {
  const normalized = normalizeSdkSnapshot(JSON.parse(JSON.stringify(snapshot)), 1080, 2400);
  assert.deepEqual(normalized.acceptanceContext, context);
  assert.deepEqual(normalized.nodes[0].pixelRect, { x: 46, y: 288, width: 288, height: 127 });
  assert.match(manualEvidence(buildManualFields(design, actual, align), align), /应有 96 dp → 实测 96 dp/);
});
test('invalid contexts, platforms, density and node rules are rejected at the upload boundary', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
  const envelope: any = { protocol: 'ui-acceptance-sdk-v2', captureId: 'manual-test', sdkVersion: 'test', snapshot,
    screenshot: { mimeType: 'image/png', width: 1080, height: 2400, base64: png } };
  assert.doesNotThrow(() => validateSdkSnapshotEnvelope(envelope));
  for (const invalid of [{ ...context, version: 2 }, { ...context, pixelRatio: 0 }, { ...context, viewport: { width: NaN, height: 800 } },
    { ...context, design: { ...context.design, unitsPerPoint: 0 } }, { ...context, design: { ...context.design, rules: { width: { scale: 'auto', rounding: 'none' } } } }]) {
    assert.throws(() => validateAcceptanceContext(invalid));
  }
  assert.throws(() => validateSdkSnapshotEnvelope({ ...envelope, snapshot: { ...snapshot, acceptanceContext: { ...context, logicalUnit: 'pt' } } }));
  assert.throws(() => validateSdkSnapshotEnvelope({ ...envelope, snapshot: { ...snapshot, densityDpi: 400 } }));
  assert.throws(() => validateSdkSnapshotEnvelope({ ...envelope, snapshot: { ...snapshot, nodes: [{ ...node, acceptanceRules: { invalid: {} } }] } }));
});
