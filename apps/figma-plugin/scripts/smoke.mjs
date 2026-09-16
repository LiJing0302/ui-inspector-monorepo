/**
 * 冒烟测试：用 mock 的 Figma API 跑一遍 dist/code.js，
 * 校验产出的 zip 结构、schema 坐标、截图与预览页是否符合预期。
 * 运行：node scripts/smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const outDir = path.join(root, '.smoke-out');

let idSeq = 0;
const registry = new Map();

function makeNode(def, parentAbs) {
  const id = `n${++idSeq}`;
  const x = def.x ?? 0;
  const y = def.y ?? 0;
  const width = def.width ?? 100;
  const height = def.height ?? 100;
  const abs = { x: (parentAbs?.x ?? 0) + x, y: (parentAbs?.y ?? 0) + y, width, height };
  const node = {
    id,
    name: def.name ?? '未命名',
    type: def.type ?? 'FRAME',
    x,
    y,
    width,
    height,
    visible: def.visible !== false,
    absoluteBoundingBox: abs,
    parent: def.parent ?? null,
    ...def.extra,
  };
  if (def.children) {
    node.children = def.children.map((c) => makeNode({ ...c, parent: node }, abs));
  }
  registry.set(id, node);
  return node;
}

const solid = (hex, a = 1) => {
  const n = parseInt(hex.slice(1), 16);
  return {
    type: 'SOLID',
    visible: true,
    opacity: a,
    color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a },
  };
};

const homePage = makeNode(
  {
    name: '首页',
    type: 'FRAME',
    x: 0,
    y: 0,
    width: 375,
    height: 812,
    extra: { fills: [solid('#FFFFFF')], layoutMode: 'VERTICAL', itemSpacing: 8, paddingTop: 0 },
    children: [
      {
        name: 'Header',
        type: 'FRAME',
        x: 0,
        y: 0,
        width: 375,
        height: 88,
        extra: { fills: [solid('#E8542E')], cornerRadius: 12, clipsContent: true },
        children: [
          {
            name: '标题',
            type: 'TEXT',
            x: 16,
            y: 20,
            width: 200,
            height: 28,
            extra: {
              characters: '商品详情',
              fontSize: 20,
              fontName: { family: 'PingFang SC', style: 'Regular' },
              lineHeight: { unit: 'PIXELS', value: 28 },
              fills: [solid('#1F2328')],
            },
          },
          {
            name: '隐藏的装饰',
            type: 'RECTANGLE',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            visible: false,
            extra: { fills: [solid('#000000')] },
          },
          {
            name: '溢出元素',
            type: 'RECTANGLE',
            x: 400,
            y: 40,
            width: 60,
            height: 20,
            extra: { fills: [solid('#00AA00')] },
          },
          {
            name: '透明占位',
            type: 'FRAME',
            x: 20,
            y: 60,
            width: 80,
            height: 20,
            extra: { fills: [] },
          },
        ],
      },
      {
        name: '价格',
        type: 'TEXT',
        x: 16,
        y: 120,
        width: 120,
        height: 32,
        extra: { characters: '¥199.00', fontSize: 24, fills: [solid('#E8542E')] },
      },
      {
        name: '主按钮',
        type: 'INSTANCE',
        x: 16,
        y: 700,
        width: 343,
        height: 48,
        extra: {
          fills: [solid('#2563EB')],
          mainComponent: { id: 'cmp-1', name: 'Button/Primary' },
        },
      },
    ],
  },
  null,
);

const section = makeNode(
  { name: 'Section A', type: 'SECTION', x: 0, y: 0, width: 375, height: 812, children: [] },
  null,
);
section.children = [homePage];
homePage.parent = section;

const pageNode = {
  id: 'page-1',
  name: '页面 1',
  type: 'PAGE',
  children: [section],
};
registry.set('page-1', pageNode);
section.parent = pageNode;

const posted = [];
const handlers = {};
const figma = {
  root: { name: '验收示例文件', children: [pageNode], type: 'DOCUMENT' },
  currentPage: { id: 'page-1', name: '页面 1', selection: [] },
  fileKey: 'abc123XYZ',
  ui: {
    postMessage: (msg) => posted.push(msg),
    onmessage: null,
  },
  notify: (m) => console.log('[figma.notify]', m),
  editorType: 'figma',
  on: (name, cb) => {
    handlers[name] = cb;
  },
  async loadAllPagesAsync() {},
  async getNodeByIdAsync(id) {
    return registry.get(id) ?? null;
  },
  showUI() {},
};

/* ---- 生成一张真实的 PNG 截图，便于直接打开 index.html 肉眼核对叠加效果 ---- */
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height, painter) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = painter(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const SCALE = 2;
for (const n of registry.values()) {
  if (n.type === 'PAGE') continue;
  n.exportAsync = async () =>
    makePng(Math.round(n.width * SCALE), Math.round(n.height * SCALE), (x, y) => {
      const dy = y / SCALE;
      const dx = x / SCALE;
      if (dy < 88) return [232, 84, 46]; // Header 橙色
      if (dy > 700 && dy < 748 && dx > 16 && dx < 359) return [37, 99, 235]; // 主按钮
      if (dy > 120 && dy < 152 && dx > 16 && dx < 136) return [232, 84, 46]; // 价格文字色块
      return [253, 248, 242]; // 米白背景
    });
}

const sandbox = { figma, __html__: '<html></html>', console, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(dist, 'code.js'), 'utf8'), sandbox);

await figma.ui.onmessage({
  type: 'EXPORT',
  options: {
    frameIds: [homePage.id],
    scale: 2,
    format: 'PNG',
    withScreenshot: true,
    includeHidden: false,
    includeImageFills: false,
    maxDepth: 0,
    includeNestedFrames: false,
    includePreview: true,
  },
});

const done = posted.find((m) => m.type === 'EXPORT_DONE');
if (!done) {
  console.error('❌ 没有收到 EXPORT_DONE，实际消息：', posted.map((m) => m.type));
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, done.fileName);
fs.writeFileSync(zipPath, Buffer.from(done.data));
console.log(`✅ 产出 ${done.fileName}  ${(done.bytes / 1024).toFixed(1)} KB`);

const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
const names = Object.keys(zip.files).sort();
console.log('\nzip 内容：');
names.forEach((n) => console.log('  -', n));

/* ------------------------------ 断言 ------------------------------ */
const errors = [];
const assert = (cond, msg) => {
  if (!cond) errors.push(msg);
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
};

/* ---------------- 插件 manifest 的合法性（Figma 在加载阶段校验） ----------------
 * 这段是补出来的教训：`allowedDomains` 里写 `ws://127.0.0.1:23457` 会让插件**整个加载失败**，
 * Figma 只给一句 `Invalid value for allowedDomains ... must be a valid URL`，
 * 而本地 build 一路绿灯 —— 只有真去 Figma 里跑才暴露。所以把 Figma 的几条硬规则搬到这里先守一遍。
 */
const pluginManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const network = pluginManifest.networkAccess ?? {};
const patterns = [...(network.allowedDomains ?? []), ...(network.devAllowedDomains ?? [])];

console.log('\n插件 manifest 校验：');
assert(Array.isArray(network.allowedDomains) && network.allowedDomains.length > 0, 'allowedDomains 非空');

const bareIp = patterns.filter((p) => /\/\/\d{1,3}(\.\d{1,3}){3}/.test(p));
assert(
  bareIp.length === 0,
  `域名字面量不写裸 IP（Figma 只接受主机名，写 IP 会让插件加载失败）${bareIp.length ? ` — 违规：${bareIp.join(', ')}` : ''}`,
);

const badScheme = patterns.filter((p) => /^[a-z]+:\/\//i.test(p) && !/^(https?|wss?):\/\//i.test(p));
assert(
  badScheme.length === 0,
  `scheme 只用 http / https / ws / wss${badScheme.length ? ` — 违规：${badScheme.join(', ')}` : ''}`,
);

const touchesLocal = patterns.some((p) => /localhost|\d{1,3}(\.\d{1,3}){3}/.test(p));
assert(
  !touchesLocal || typeof network.reasoning === 'string',
  '涉及本地/开发服务器时必须提供 reasoning',
);

/* ---------------- UI 元素与事件绑定的一致性 ----------------
 * 这段是「点选了但界面没反应」的教训：ui.html 里明明有 `#mac-requirement` 下拉，
 * 但 ui.ts 忘了给 `#target-mac` 单选绑 onchange，于是点「直接发送到 Mac 应用」后
 * mac-panel 的 hidden 永远摘不掉，整个需求下拉面板根本不出现 ——
 * typecheck 和 build 全绿，只有人肉点一遍才发现。
 *
 * 三类问题在这里守：
 *   1. ui.ts 用了 html 里不存在的 id（拼写错，运行期 $() 返回 null 直接 TypeError）
 *   2. html 里有交互元素但 ui.ts 从没引用（死 UI）
 *   3. 交互元素被引用、也被赋值读取，但没绑任何事件（点了没反应）
 */
const uiHtml = fs.readFileSync(path.join(root, 'src/ui/ui.html'), 'utf8');
const uiTs = fs.readFileSync(path.join(root, 'src/ui/ui.ts'), 'utf8');

// 前面要加否定后视，否则会误吃 `data-page-node-id="..."` 里的 `id="`
const htmlIds = new Set([...uiHtml.matchAll(/(?<![-\w])id="([^"]+)"/g)].map((m) => m[1]));
// 只认 `$('id')` 与 `$<HTMLInputElement>('id')` 这两种真实形态。
// 不能用宽松的 `\$[^(\n]*\(` —— 那会把模板字符串 `${count('imported')}` 里的
// `${count(` 也当成取元素，冒出 imported / replaced / skipped 这类假缺失。
const tsIds = new Set(
  [...uiTs.matchAll(/\$(?:<[^>]*>)?\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
);

console.log('\nUI 元素与事件绑定校验：');

const missingInHtml = [...tsIds].filter((id) => !htmlIds.has(id));
assert(
  missingInHtml.length === 0,
  `ui.ts 引用的 id 都存在于 ui.html${missingInHtml.length ? ` — 缺失：${missingInHtml.join(', ')}` : ''}`,
);

// 只挑真正需要交互的元素：按钮 / 输入框 / 下拉框
const interactiveIds = [
  ...uiHtml.matchAll(/<(button|input|select)\b[^>]*(?<![-\w])id="([^"]+)"/g),
].map((m) => m[2]);
const deadUi = interactiveIds.filter((id) => !tsIds.has(id));
assert(
  deadUi.length === 0,
  `ui.html 的交互元素都被 ui.ts 引用（没有点了没反应的死 UI）${
    deadUi.length ? ` — 未引用：${deadUi.join(', ')}` : ''
  }`,
);

// 这些元素必须自己绑事件：光被引用不够（值是要靠用户改的）
const NEEDS_HANDLER = [
  'refresh',
  'opt-nested',
  'opt-follow',
  'opt-granularity',
  'select-all',
  'select-none',
  'use-selection',
  'export',
  'target-zip',
  'target-mac',
  'mac-connect',
  'mac-reload',
];
const unbound = NEEDS_HANDLER.filter((id) => {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 匹配 `$('id').onclick = …` / `$<HTMLInputElement>('id').onchange = …`
  return !new RegExp(`\\(\\s*'${escaped}'\\s*\\)\\s*\\.\\s*(on[a-z]+|addEventListener)\\b`).test(uiTs);
});
assert(
  unbound.length === 0,
  `交互元素都绑了事件处理器${unbound.length ? ` — 漏绑：${unbound.join(', ')}` : ''}`,
);

const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
console.log('\n校验：');
assert(manifest.frames.length === 1, 'manifest 包含 1 个设计稿');
assert(manifest.frames[0].type === 'FRAME', 'manifest 记录了根节点类型');
assert(manifest.frames[0].path === 'Section A/首页', `manifest 记录了根节点路径（实际 ${manifest.frames[0].path}）`);
assert(manifest.frames[0].width === 375 && manifest.frames[0].height === 812, '设计稿尺寸 375×812');
assert(manifest.exportScale === 2, '截图倍率记录为 2');

const schemaText = await zip.file(manifest.frames[0].schemaFile).async('string');
const schema = JSON.parse(schemaText);
assert(schema.tree.rect.x === 0 && schema.tree.rect.y === 0, '根节点 rect 相对自身为 (0,0)');

const header = schema.tree.children.find((c) => c.name === 'Header');
assert(!!header, '存在 Header 子节点');
assert(header.rect.x === 0 && header.rect.y === 0, 'Header rect = (0,0)');
assert(header.rect.width === 375 && header.rect.height === 88, 'Header 尺寸 375×88');
assert(header.cornerRadius === 12, 'Header 圆角 12');
assert(header.fills[0].color === '#e8542e', `Header 填充色 #e8542e（实际 ${header.fills[0]?.color}）`);

const title = header.children.find((c) => c.name === '标题');
assert(!!title, '存在「标题」文本节点');
assert(title.rect.x === 16 && title.rect.y === 20, `标题 rect = (16,20)（实际 ${title.rect.x},${title.rect.y}）`);
assert(title.text.characters === '商品详情', '标题文案正确');
assert(title.text.fontSize === 20, '标题字号 20');
assert(title.text.color === '#1f2328', `标题文字色（实际 ${title.text.color}）`);
assert(title.absRect.x === 16 && title.absRect.y === 20, 'absRect 与页面坐标一致');

const hidden = header.children.find((c) => c.name === '隐藏的装饰');
assert(!hidden, '隐藏节点默认被跳过');

const price = schema.tree.children.find((c) => c.name === '价格');
assert(price.rect.y === 120, `价格节点 y=120（实际 ${price.rect.y}）`);

/* ---- 与 HTML DOM 渲染对齐需要的元数据 ---- */
console.log('\n渲染对齐元数据：');
const headerKids = header.children;
assert(headerKids.every((c) => typeof c.index === 'number'), '每个子节点都带 index（父 children 数组序号）');
// index 用的是 Figma children 的原始序号：隐藏节点被跳过但序号不压缩，
// 这样 z 序（谁盖住谁）才不会错位
const overflow = headerKids.find((c) => c.name === '溢出元素');
const transparent = headerKids.find((c) => c.name === '透明占位');
assert(
  headerKids.find((c) => c.name === '标题').index === 0 && overflow.index === 2 && transparent.index === 3,
  `index 是 Figma children 原始序号，跳过隐藏节点后留空（实际 ${headerKids.map((c) => c.index).join(',')}）`,
);
assert(header.hasFill === true, '有填充的节点 hasFill = true');
assert(title.hasFill === true, '文本节点 hasFill = true');

assert(!!overflow && overflow.clipped === true, '超出 clipsContent 容器的子节点被标记 clipped');
assert(!!transparent && transparent.hasFill === false, '无填充的节点 hasFill = false（Figma 画布点不中它）');
assert(price.clipped !== true, '未被裁剪的节点不带 clipped 标记');

const btn = schema.tree.children.find((c) => c.name === '主按钮');
assert(btn.component?.kind === 'INSTANCE', '主按钮被标记为 INSTANCE');
assert(btn.component?.mainComponentName === 'Button/Primary', '记录了主组件名称');

const pngEntry = names.find((n) => n.endsWith('.png'));
assert(!!pngEntry, '存在设计稿截图');
const png = await zip.file(pngEntry).async('uint8array');
assert(png[0] === 0x89 && png[1] === 0x50, '截图内容是合法 PNG 头');

const html = await zip.file('index.html').async('string');
assert(html.includes('window.__DATA__'), '预览页内联了数据');
assert(html.includes('screenshots/'), '预览页引用了截图相对路径');
assert(!!(await zip.file('README.md')), '存在 README 说明');

/* ---- 画布点选 → 导出目标映射（「跟随画布选择」的底层逻辑）---- */
const lastSel = () => posted.filter((m) => m.type === 'SELECTION_CHANGED').pop();
const titleNode = homePage.children[0].children[0];

console.log('\n选区同步（默认粒度：导出点中的元素本身）：');

// 核心回归：Frame 嵌在 Section 里时，选中 Frame 必须导出 Frame 本身，而不是外层 Section
figma.currentPage.selection = [homePage];
handlers.selectionchange();
let msg = lastSel();
assert(!!msg, 'selectionchange 会向 UI 推送 SELECTION_CHANGED');
assert(msg?.frames?.[0]?.id === homePage.id, `选中 Section 内的 Frame → 解析为「${homePage.name}」而不是外层 Section`);
assert(msg?.frames?.[0]?.width === 375 && msg?.frames?.[0]?.height === 812, '解析结果带上了尺寸（供 UI 渲染「当前选区」分组）');
assert(msg?.frames?.[0]?.type === 'FRAME', '解析结果带上了类型（UI 据此显示类型徽标）');

// 精确到元素：点中的是 TEXT 图层，就必须导出这个 TEXT，而不是它所在的 Header
figma.currentPage.selection = [titleNode];
handlers.selectionchange();
msg = lastSel();
assert(msg?.frames?.[0]?.id === titleNode.id, `选中文字图层「${titleNode.name}」→ 导出它本身（而不是所属容器）`);
assert(msg?.frames?.[0]?.type === 'TEXT', '解析结果类型为 TEXT');
assert(msg?.frames?.[0]?.path === 'Section A/首页/Header/标题', `解析结果带完整路径（实际 ${msg?.frames?.[0]?.path}）`);

figma.currentPage.selection = [];
handlers.selectionchange();
msg = lastSel();
assert(msg?.frames?.length === 0 && msg?.rawCount === 0, '清空选区后推送空 frames（UI 侧据此保留原勾选）');

// 切到 frame 粒度：同一图层应向上归到最近的容器
await figma.ui.onmessage({ type: 'SET_GRANULARITY', value: 'frame' });
figma.currentPage.selection = [titleNode];
handlers.selectionchange();
msg = lastSel();
assert(msg?.frames?.[0]?.id === homePage.children[0].id, `frame 粒度下：文字图层归到最近容器「${homePage.children[0].name}」`);
await figma.ui.onmessage({ type: 'SET_GRANULARITY', value: 'element' });
figma.currentPage.selection = [];
handlers.selectionchange();

/* ---- 元素级导出：根目录是那个 TEXT 节点本身 ---- */
posted.length = 0;
await figma.ui.onmessage({
  type: 'EXPORT',
  options: {
    frameIds: [titleNode.id],
    scale: 2,
    format: 'PNG',
    withScreenshot: true,
    includeHidden: false,
    includeImageFills: false,
    maxDepth: 0,
    includeNestedFrames: false,
    includePreview: true,
  },
});
const elemDone = posted.find((m) => m.type === 'EXPORT_DONE');
console.log('\n元素级导出：');
assert(!!elemDone, '导出单个元素会产生 EXPORT_DONE');

const elemZip = await JSZip.loadAsync(Buffer.from(elemDone.data));
const elemNames = Object.keys(elemZip.files).sort();
const elemManifest = JSON.parse(await elemZip.file('manifest.json').async('string'));
assert(elemManifest.frames.length === 1, 'manifest 只有 1 个导出目标');
assert(elemManifest.frames[0].type === 'TEXT', `manifest 记录根节点类型 TEXT（实际 ${elemManifest.frames[0].type}）`);
assert(elemManifest.frames[0].path === 'Section A/首页/Header/标题', 'manifest 记录了完整路径');
assert(elemManifest.frames[0].pageId === 'page-1', `元素级导出也能定位到所属页面（实际 ${elemManifest.frames[0].pageId}）`);
assert(elemManifest.frames[0].pageName === '页面 1', `页面名取自最近的 PAGE 祖先（实际 ${elemManifest.frames[0].pageName}）`);
assert(elemManifest.frames[0].width === 200 && elemManifest.frames[0].height === 28, '导出尺寸就是该元素自身尺寸 200×28');

const elemSchema = JSON.parse(await elemZip.file(elemManifest.frames[0].schemaFile).async('string'));
assert(elemSchema.rootType === 'TEXT', 'schema.rootType = TEXT');
assert(elemSchema.tree.rect.x === 0 && elemSchema.tree.rect.y === 0, '元素作为根节点时 rect 归零');
assert(elemSchema.tree.rect.width === 200 && elemSchema.tree.rect.height === 28, '根节点尺寸 = 元素尺寸');
assert(elemSchema.tree.absRect.x === 16 && elemSchema.tree.absRect.y === 20, 'absRect 仍保留页面绝对坐标 (16,20)');
assert(elemSchema.tree.text.characters === '商品详情', '根节点自身的文本信息被完整导出');
assert(elemSchema.nodeCount === 1, '叶子元素的节点数为 1');

const elemShot = elemNames.find((n) => !elemZip.files[n].dir && n.startsWith('screenshots/'));
assert(!!elemShot && elemShot.includes('Header-标题'), `截图文件名带父级前缀避免重名（实际 ${elemShot}）`);
const elemPng = await elemZip.file(elemShot).async('uint8array');
assert(elemPng[0] === 0x89 && elemPng[1] === 0x50, '元素截图是合法 PNG');

console.log(`\n产物已解压到：${outDir}`);
for (const n of names) {
  if (zip.files[n].dir) continue;
  const target = path.join(outDir, n);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(await zip.file(n).async('uint8array')));
}

// 顺带把元素级样例展开，方便直接打开看「单个 TEXT 节点 + 它自己的截图」
const elemOut = path.join(outDir, 'element-example');
fs.rmSync(elemOut, { recursive: true, force: true });
for (const n of elemNames) {
  if (elemZip.files[n].dir) continue;
  const target = path.join(elemOut, n);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(await elemZip.file(n).async('uint8array')));
}
console.log(`元素级样例：${elemOut}/index.html`);

if (errors.length) {
  console.error(`\n❌ ${errors.length} 项校验失败`);
  process.exit(1);
}
console.log('\n🎉 全部校验通过');
