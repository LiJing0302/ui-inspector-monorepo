/**
 * 调试包 ZIP 导出门禁：验证 `buildDebugBundleZip` 的纯组装逻辑（合成数据）。
 *
 *  1. 全量输入 → 包内 7 个文件齐全，meta.json 字段正确，节点/截图原样 round-trip
 *  2. 截图缺失（null）→ 记入 missing，不中断，包照样生成
 *  3. 无 mapping/groundTruth → 那两个文件不出现，也不报错
 */
import JSZip from 'jszip';
import { buildDebugBundleZip, type DebugBundleParts } from '../src/main/acceptance/debugBundleZip';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function makeParts(overrides: Partial<DebugBundleParts> = {}): DebugBundleParts {
  return {
    requirement: { id: 'req-1', name: '需求A' },
    pair: { id: 'pair-1' },
    design: {
      assetId: 'd-asset', name: '首页', width: 375, height: 812,
      pixelWidth: 750, pixelHeight: 1624, exportScale: 2, nodeCount: 1,
    },
    app: {
      snapshotId: 'a-snap', name: '首页', platform: 'android', device: 'Pixel 7',
      osVersion: '14', width: 375, height: 812, pixelWidth: 1080, pixelHeight: 2400,
      scaleX: 2.88, scaleY: 2.955, densityDpi: 420, nodeCount: 1, collectionQuality: null,
    },
    designNodes: [{ id: 'n1', name: '标题', rect: { x: 0, y: 0, width: 100, height: 20 } }],
    appNodes: [{ nodeId: 'a1', className: 'TextView', text: '标题', x: 0, y: 0, width: 100, height: 20 }],
    mapping: { pairId: 'pair-1', anchors: [] },
    groundTruth: { pairId: 'pair-1', pairs: [] },
    designScreenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
    appScreenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]),
    ...overrides,
  };
}

async function readJson(zip: JSZip, path: string): Promise<any> {
  const file = zip.file(path);
  if (!file) throw new Error(`包内缺文件：${path}`);
  return JSON.parse(await file.async('string'));
}

async function main(): Promise<void> {
  console.log('门禁 1：全量输入 → 7 个文件齐全，元数据正确');
  {
    const parts = makeParts();
    const built = await buildDebugBundleZip(parts);
    const zip = await JSZip.loadAsync(built.payload);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
    for (const expected of [
      'meta.json', 'design/nodes.json', 'design/screenshot.png',
      'app/nodes.json', 'app/screenshot.png', 'mapping.json', 'ground-truth.json',
    ]) {
      check(`包内含 ${expected}`, names.includes(expected), `实际：${names.join(', ')}`);
    }
    const meta = await readJson(zip, 'meta.json');
    check('meta.kind 正确', meta.kind === 'ui-acceptance-debug-bundle');
    check('meta.version=1', meta.version === 1);
    check('设计稿尺寸 375x812', meta.design.width === 375 && meta.design.height === 812);
    check('设计稿 exportScale=2', meta.design.exportScale === 2);
    check('App 尺寸 375x812，pixel 1080x2400', meta.app.width === 375 && meta.app.pixelWidth === 1080);
    check('App densityDpi=420', meta.app.densityDpi === 420);
    check('nodeCount 与节点数组长度一致', meta.design.nodeCount === 1 && meta.app.nodeCount === 1);
    check('missing 为空', Array.isArray(meta.missing) && meta.missing.length === 0);
    check('files 清单 7 项', meta.files.length === 7);

    const designNodes = await readJson(zip, 'design/nodes.json');
    check('设计稿节点原样 round-trip', designNodes[0]?.id === 'n1' && designNodes[0]?.name === '标题');
    const appNodes = await readJson(zip, 'app/nodes.json');
    check('App 节点原样 round-trip', appNodes[0]?.nodeId === 'a1');
    const designPng = await zip.file('design/screenshot.png')!.async('nodebuffer');
    check('设计稿截图字节一致', Buffer.from(designPng).equals(parts.designScreenshot!));
    const appPng = await zip.file('app/screenshot.png')!.async('nodebuffer');
    check('App 截图字节一致', Buffer.from(appPng).equals(parts.appScreenshot!));
    check('built.files 与 missing 口径一致', built.files.length === 7 && built.missing.length === 0);
  }

  console.log('门禁 2：截图缺失 → 记入 missing，不中断');
  {
    const built = await buildDebugBundleZip(makeParts({ designScreenshot: null, appScreenshot: null }));
    const zip = await JSZip.loadAsync(built.payload);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
    check('缺失截图不进包', !names.includes('design/screenshot.png') && !names.includes('app/screenshot.png'));
    check('其余 5 个文件仍在', names.length === 5, `实际：${names.join(', ')}`);
    check(
      'missing 记了两处',
      built.missing.includes('design/screenshot.png') && built.missing.includes('app/screenshot.png'),
    );
    const meta = await readJson(zip, 'meta.json');
    check('meta.json.missing 同步', meta.missing.length === 2);
  }

  console.log('门禁 3：无 mapping/groundTruth → 文件不出现');
  {
    const built = await buildDebugBundleZip(makeParts({ mapping: null, groundTruth: null }));
    const zip = await JSZip.loadAsync(built.payload);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
    check('mapping.json 不出现', !names.includes('mapping.json'));
    check('ground-truth.json 不出现', !names.includes('ground-truth.json'));
    check('其余 5 个文件仍在', names.length === 5, `实际：${names.join(', ')}`);
  }

  console.log(failures === 0 ? '\n✅ 全部 3 项门禁通过' : `\n❌ ${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exit(1);
});
