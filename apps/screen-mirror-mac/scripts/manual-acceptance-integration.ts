/** Exercise the real importer, capture persistence, pair-view assembly and issue IPC in an isolated workspace. */
import { app, ipcMain, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { registerVerifyIpc, buildPairViews } from '../src/main/verifyIpc';
import { createRequirement, getRequirement, initWorkspace } from '../src/main/store/workspace';
import { appSnapshotDir } from '../src/main/store/paths';
import { importFigmaPackage } from '../src/main/importer/figmaImport';
import { validateSdkSnapshotEnvelope } from '../src/types/acceptance';
import { buildManualFields, manualEvidence } from '../src/renderer/src/lib/manualAcceptance';
import { buildInspectionFields, inspectApp, inspectDesign, inspectionEvidence } from '../src/renderer/src/lib/elementInspection';

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'ui-manual-integration-'));
app.setPath('userData', path.join(sandbox, 'userData'));
const handlers = new Map<string, (...args: any[]) => any>();
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = ((name: string, handler: any) => { handlers.set(name, handler); }) as any;
const invoke = (name: string, input: any) => handlers.get(name)!({}, input);

app.whenReady().then(async () => {
let failed = false;
try {
  await initWorkspace();
  const req = await createRequirement({ name: '人工验收集成测试' });
  const pixel = nativeImage.createFromBitmap(Buffer.from([255, 255, 255, 255]), { width: 1, height: 1 });
  assert.equal(pixel.isEmpty(), false);
  const png = (width: number, height: number) => pixel.resize({ width, height }).toPNG();
  const button = { id: 'button', name: '按钮壳', type: 'RECTANGLE', visible: true, depth: 1, path: '首页/按钮', rect: { x: 16, y: 100, width: 100, height: 44 }, cornerRadius: 0, fills: [], strokes: [], effects: [], layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' };
  const paint = { ...button, id: 'paint', name: '按钮背景', cornerRadius: 12, fills: [{ type: 'SOLID', color: '#2196f3' }] };
  const tree = { id: 'frame', name: '首页', type: 'FRAME', visible: true, depth: 0, path: '首页', rect: { x: 0, y: 0, width: 375, height: 667 }, children: [button, paint] };
  const schema = { schemaVersion: '1.0.0', designUnit: 'figma', frameId: 'frame', frameName: '首页', pageId: 'page', pageName: '页面', width: 375, height: 667, exportScale: 2, screenshot: 'screen.png', nodeCount: 3, exportedAt: new Date().toISOString(), rootType: 'FRAME', rootPath: '首页', tree };
  const meta = { id: 'frame', name: '首页', type: 'FRAME', path: '首页', pageId: 'page', pageName: '页面', width: 375, height: 667, screenshot: 'screen.png', schemaFile: 'schema.json', nodeCount: 3 };
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ schemaVersion: '1.0.0', exportScale: 2, frames: [meta] }));
  zip.file('schema.json', JSON.stringify(schema)); zip.file('screen.png', png(750, 1334));
  const zipPath = path.join(sandbox, 'design.zip');
  await writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
  const imported = await importFigmaPackage(req.id, zipPath, 'skip');
  assert.equal(imported.fatal, undefined);
  assert.equal(imported.frames[0].status, 'imported');
  const context: any = { version: 1, logicalUnit: 'dp', viewport: { width: 123, height: 456 }, pixelRatio: 3, fontScale: 1,
    design: { width: 999, height: 999, unitsPerPoint: 3, rules: { width: { scale: 'fixed', rounding: 'logical-integer' } } } };
  const screenshot = png(1200, 2400); // Deliberately different from the 1080px adaptation window.
  const envelope: any = { protocol: 'ui-acceptance-sdk-v2', captureId: 'integration', sdkVersion: 'test',
    snapshot: { platform: 'android', source: 'react-native-ui-acceptance', timestamp: Date.now(), windowWidth: 1080, windowHeight: 2400,
      density: 3, densityDpi: 480, acceptanceContext: context, collection: { profile: 'acceptance-full' }, nodes: [
        { nodeId: 'button-native', treePath: '0', parentId: null, className: 'View', x: 46, y: 288, width: 288, height: 127, depth: 0, index: 0, visible: true,
          style: null, hasVisualContent: false, text: null, textStyle: null,
          acceptanceRules: { height: { scale: 'width', rounding: 'nearest-pixel' } } },
        { nodeId: 'gradient-native', treePath: '1', parentId: null, className: 'LinearGradientView', x: 46, y: 288, width: 288, height: 127, depth: 0, index: 1, visible: true,
          hasVisualContent: true, isGradient: true, text: null, textStyle: null,
          style: { borderRadius: { topLeft: 11.52, topRight: 11.52, bottomRight: 11.52, bottomLeft: 11.52 } } },
      ] }, screenshot: { mimeType: 'image/png', width: 1200, height: 2400, base64: screenshot.toString('base64') } };
  validateSdkSnapshotEnvelope(envelope);
  const receiver: any = { waitForUpload: async () => ({ envelope, screenshot }) };
  registerVerifyIpc(receiver);
  const capture = await invoke('verify:capture-android', { requirementId: req.id, transport: 'lan' });
  let stored = (await getRequirement(req.id))!;
  const saved = stored.appSnapshots[0];
  const diskMeta = JSON.parse(await readFile(path.join(appSnapshotDir(req.id, saved.id), 'meta.json'), 'utf8'));
  assert.deepEqual(diskMeta.acceptanceContext, context);
  assert.equal(diskMeta.sdkVersion, 'test');
  assert.equal(diskMeta.devicePageWidth, 360);
  assert.equal(diskMeta.width, 400); // Screenshot canvas width remains independent.
  const diskNodes = JSON.parse(await readFile(path.join(appSnapshotDir(req.id, saved.id), 'nodes.json'), 'utf8'));
  assert.equal(diskNodes[0].acceptanceRules.height.scale, 'width');
  assert.equal(saved.id, capture.snapshotId);
  const pair = await invoke('verify:pair-save', { requirementId: req.id, designAssetId: stored.designAssets[0].id, appSnapshotId: saved.id });
  stored = (await getRequirement(req.id))!;
  const view = (await buildPairViews(stored))[0];
  assert.equal(view.design.nodes[1].layoutSizingHorizontal, 'FIXED');
  assert.equal(view.app.platform, 'android');
  assert.equal(view.app.sdkVersion, 'test');
  assert.equal(view.app.pixelRatio, 3); // Native density, never screenshot / adaptation viewport.
  assert.deepEqual(view.app.acceptanceContext, context);
  const align = { scale: 375 / view.app.width, appWidth: view.app.width, designWidth: view.design.width, designHeight: view.design.height,
    devicePageWidth: view.app.devicePageWidth, platform: view.app.platform, pixelRatio: view.app.pixelRatio, acceptanceContext: view.app.acceptanceContext, sdkVersion: view.app.sdkVersion };
  const fields = buildManualFields(view.design.nodes[1], view.app.nodes[0], align);
  assert.equal(fields[0].target.text, '96 dp'); // PNG exportScale=2 did not enter the semantic conversion.
  assert.equal(fields[0].status, 'consistent');
  // Historical captures predate the page-width field and SDK context: derive the same width from saved native window metadata.
  const legacyRequirement = structuredClone(stored);
  delete legacyRequirement.appSnapshots[0].devicePageWidth;
  delete legacyRequirement.appSnapshots[0].acceptanceContext;
  const legacyView = (await buildPairViews(legacyRequirement))[0];
  assert.equal(legacyView.app.devicePageWidth, 360);
  assert.equal(buildManualFields(legacyView.design.nodes[1], legacyView.app.nodes[0], { ...align,
    devicePageWidth: legacyView.app.devicePageWidth, acceptanceContext: undefined })[0].target.text, '96 dp');
  const groups = { design: inspectDesign(view.design.nodes[1], view.design.nodes), app: inspectApp(view.app.nodes[0], view.app.nodes) };
  assert.equal(groups.design.members.length, 2); assert.equal(groups.app.members.length, 2);
  const resolved = buildInspectionFields(groups, align);
  const radius = resolved.find(f => f.label === '圆角')!;
  assert.equal(radius.design.text, '12 px'); assert.equal(radius.target.text, '11.52 dp');
  assert.equal(radius.actual.text, '11.52 dp'); assert.equal(radius.status, 'consistent');
  assert.equal(groups.design.anchor.id, 'button'); assert.equal(groups.app.anchor.nodeId, diskNodes[0].nodeId);
  const evidence = manualEvidence(resolved, align) + '\n' + inspectionEvidence(groups);
  assert.match(evidence, /"memberIds"/); assert.match(evidence, /圆角属性来源/);
  assert.match(evidence, /SDK test/);
  const issue = await invoke('verify:issue-save', { requirementId: req.id, pairId: pair.id, source: 'both', position: null,
    nodeId: 'button', designNodeId: 'button', appNodeId: diskNodes[0].nodeId, severity: 'P2', description: '检查间距', acceptanceEvidence: evidence });
  assert.equal((await getRequirement(req.id))!.issues[0].acceptanceEvidence, evidence);
  assert.equal((await getRequirement(req.id))!.issues[0].appNodeId, groups.app.anchor.nodeId);
  assert.equal((await getRequirement(req.id))!.issues[0].designNodeId, groups.design.anchor.id);
  const { acceptanceEvidence: _evidence, ...editInput } = issue;
  await invoke('verify:issue-save', { ...editInput, description: '补充描述' });
  assert.equal((await getRequirement(req.id))!.issues[0].acceptanceEvidence, evidence);
  console.log('PASS: 插件 schema → 导入 → SDK 采集 → meta/nodes 落盘 → 两侧独立汇总 → 逻辑单位比较 → 原始节点与来源证据保存');
} catch (error) { failed = true; console.error(error); }
finally {
  ipcMain.handle = originalHandle;
  await rm(sandbox, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}
});
