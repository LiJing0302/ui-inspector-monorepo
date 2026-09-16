/**
 * 冒烟测试：在不启动窗口的前提下，真实跑一遍验收工作流的核心链路。
 *
 * 覆盖（编号与下方 section 一一对应）：
 *   1. workspace 初始化与需求 CRUD
 *   2. 导入管线 · 导出文件夹（真实样本 310 节点）
 *   3. 冲突策略 · skip / replace 重复导入
 *   4. 导入管线 · zip（含中文文件名）
 *   5. 坏包整包拒绝且不落盘
 *   6. 配对写入语义（建立 / 复用 / 替换）与配对视图组装
 *   7. sm-asset 协议的路径解析与穿越防护（安全边界）
 *   8. R4 按宽对齐系数（纯函数，含非法输入回退）
 *   9. uiautomator XML → AppNode 映射与 dp 换算
 *  10. 插件直传通道（Origin 闸 / 协议协商 / 分片上传 / 字节导入 ≡ 本地导入）
 *  14. 级联删除
 *
 * 编号 11 不再使用（历史编号）；12 / 13 的**执行顺序排在 14 之前**：
 * 它们要读配对元数据，而 14 会把整个需求删掉，所以删除只能是最后一步。
 *  12. 验收引擎（归一化 / 匹配 / 门禁 / 裁决 / 视觉特征 / AI 仲裁边界）
 *  13. 节点上传协议（token / 过期 / 重放 / 版本 / captureId / 节点树 / 采集档位）
 *
 * 运行（在 electron/ 目录下）：
 *   npm run test:verify-smoke
 *
 * ⚠️ 在无头 / 受限环境（CI、沙箱）里跑需要 `ELECTRON_DISABLE_SANDBOX=1`：
 * 否则 Chromium 的 sandbox 起不来，进程会以 SIGTRAP 直接退出，看不到任何断言。
 * 本机正常桌面环境不需要这个变量。
 *
 * 等价于：esbuild 打包到 .smoke/，再用 electron 跑（需要 electron 主进程环境，
 * 因为 store/protocol 依赖 app.getPath；普通 node 跑不起来）。
 * 真实样本可用 SM_SAMPLE_DIR / SM_SAMPLE_ZIP 覆盖，缺失时整体跳过（退出码 0）。
 */

import { app } from 'electron';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, type RawData } from 'ws';

import { DesignBridge, isAllowedOrigin } from '../src/main/bridge/designBridge';
import {
  parseDensity,
  parsePngSize,
  parseUiAutomatorXml,
  parseWmSize,
  receiveAndroidSnapshot,
  resolveDisplaySize,
  toLogical,
} from '../src/main/capture/androidCapture';
import { importFigmaPackage } from '../src/main/importer/figmaImport';
import { resolveAssetRequest } from '../src/main/protocol';
import { appSnapshotDir } from '../src/main/store/paths';
import {
  createRequirement,
  deleteRequirement,
  getRequirement,
  initWorkspace,
  mutateRequirement,
} from '../src/main/store/workspace';
import { applyAssetDelete, applyPairSave, buildPairViews } from '../src/main/verifyIpc';
import { AcceptanceReceiver, type AcceptanceUpload } from '../src/main/capture/acceptanceReceiver';
import { extractMessageContent, validateAiResponse } from '../src/main/acceptance/ai';
import {
  AI_ACCEPT_THRESHOLD,
  applyAiCandidates,
  canonicalizeApp,
  canonicalizeDesign,
  evaluateAcceptance,
  matchDocuments,
} from '../src/main/acceptance/core';
import { decodePng } from '../src/main/acceptance/png';
import { evaluateReadiness } from '../src/main/acceptance/service';
import { parseMapping } from '../src/main/acceptance/store';
import { deltaE00, hammingDistance, rgbToLab } from '../src/main/acceptance/visuals';
import {
  FOCUS_FILL,
  FOCUS_KEEP_RATIO_MAX,
  FOCUS_MAX_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  PIXEL_GRID_MIN_CELL_PX,
  PIXEL_GRID_UNIT,
  clampZoom,
  imageSamplingScale,
  pixelGridCellPx,
  pixelGridPhase,
  planFocus,
  shouldShowPixelGrid,
  shouldUseCrispSampling,
  zoomStepFor,
} from '../src/renderer/src/lib/zoom';
import {
  CLICK_REPEAT_RADIUS,
  ancestorChain,
  descendInto,
  parentContextOf,
  planCanvasClick,
  planCanvasHover,
  type ClickCycle,
  type ClickOutcome,
} from '../src/renderer/src/lib/selection';
import {
  DEFAULT_WIPE_RATIO,
  MAX_WIPE_RATIO,
  MIN_OVERLAY_OPACITY,
  MIN_WIPE_RATIO,
  canOverlay,
  clampOverlayOpacity,
  clampWipeRatio,
  wipeClipPath,
  wipeRatioFromX,
} from '../src/renderer/src/lib/compare';
import {
  BRIDGE_MAX_UPLOAD_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientMessage,
  type BridgeEvent,
  type BridgeServerMessage,
} from '../src/types/bridge';
import {
  appNodeHittable,
  buildNodeTree,
  designNodeHittable,
  flattenFigmaTree,
  flattenVisibleTree,
  markAppHitShields,
  toRenderNode,
  widthAlignScale,
  type AppNode,
  type DesignNode,
  type RenderNode,
} from '../src/types/verify';
import type { FigmaNode } from '../src/types/figma';
import type { CollectionQuality } from '../src/types/acceptance';
import {
  SDK_ACCEPTANCE_PROTOCOL,
  decodeScreenshot,
  MAX_SCREENSHOT_BYTES,
  type AcceptanceSnapshotEnvelope,
} from '../src/types/acceptance';
import type { MatchVisualMetrics, NodeMapping, NodeMatch } from '../src/types/aiAcceptance';

// 隔离：把 userData 指到临时目录，绝不碰真实应用数据
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'smoke-verify-'));
app.setPath('userData', path.join(sandbox, 'userData'));

// 真实样本可被环境变量覆盖（默认指向本机那份 Figma 插件导出）
const SAMPLE_DIR =
  process.env.SM_SAMPLE_DIR ?? '/Users/lijing/Downloads/盲盒抽奖活动-nodes-2026-09-11-06-26';
const SAMPLE_ZIP_DIR = process.env.SM_SAMPLE_ZIP_DIR ?? '/Users/lijing/Documents/figma-plugin/.smoke-out';

/**
 * 解析样本 zip。
 *
 * 插件冒烟每次都会导出带时间戳的新包（`xxx-nodes-YYYY-MM-DD-HH-mm.zip`），
 * 把文件名写死等于给自己埋一个「隔天必失效」的假失败。
 * 所以默认取目录里**最新**的那个 zip；要固定就用 SM_SAMPLE_ZIP。
 */
async function resolveSampleZip(): Promise<string | null> {
  const explicit = process.env.SM_SAMPLE_ZIP;
  if (explicit) return (await exists(explicit)) ? explicit : null;

  const names = await readdir(SAMPLE_ZIP_DIR).catch(() => [] as string[]);
  const zips = names.filter((name) => name.toLowerCase().endsWith('.zip'));
  if (zips.length === 0) return null;

  const candidates = await Promise.all(
    zips.map(async (name) => {
      const full = path.join(SAMPLE_ZIP_DIR, name);
      const info = await stat(full).catch(() => null);
      return { full, mtime: info?.mtimeMs ?? 0 };
    }),
  );
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full ?? null;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 1×1 透明 PNG，用于伪造截图文件 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 合成一个只含头部的 PNG（8 字节签名 + IHDR），用于测 `parsePngSize`。
 * 真实截图不必进仓库 —— 尺寸断言只关心 IHDR 里的宽高。
 */
function pngHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(header.buffer);
  view.setUint32(8, 13);
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return header;
}

let passed = 0;
let failed = 0;
let skipped = false;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/**
 * 直传通道的测试客户端。
 *
 * 刻意做成「顺序取消息」而不是「按类型筛选」：服务端回给客户端的消息序列是
 * 确定性的（welcome / error / requirements / upload-ready / upload-result），
 * 一旦多出一条就说明协议跑偏了，这时应该让断言直接失败，而不是被悄悄跳过。
 */
class Probe {
  readonly ws: WebSocket;
  /** 连接被服务端以 HTTP 状态码拒绝时记在这里（Origin 闸就靠它验证） */
  rejectedStatus: number | null = null;

  private readonly inbox: BridgeServerMessage[] = [];
  private readonly waiters: Array<(msg: BridgeServerMessage) => void> = [];

  constructor(port: number, origin?: string, host = '127.0.0.1') {
    this.ws = new WebSocket(
      `ws://${host}:${port}`,
      origin ? { origin } : undefined,
    );

    this.ws.on('message', (data: RawData) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8');
      const msg = JSON.parse(text) as BridgeServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.inbox.push(msg);
    });

    // ws 客户端在握手被拒时会 emit('unexpected-response')，之后还会 emit('error')；
    // 两者都要有监听，否则连接被拒会变成未捕获异常
    this.ws.on('error', () => undefined);
  }

  open(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接超时')), timeoutMs);
      const done = (): void => clearTimeout(timer);

      this.ws.once('open', () => {
        done();
        resolve();
      });
      this.ws.once('unexpected-response', (_req, res) => {
        done();
        this.rejectedStatus = res.statusCode ?? 0;
        res.resume();
        reject(new Error(`握手被拒 HTTP ${this.rejectedStatus}`));
      });
      this.ws.once('error', (error) => {
        done();
        reject(error);
      });
    });
  }

  send(message: BridgeClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  sendBytes(bytes: Buffer): void {
    this.ws.send(bytes);
  }

  next(timeoutMs = 5000): Promise<BridgeServerMessage> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待服务端消息超时')), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }
}

/** 把 Blob/分片收尾写干净：给服务端一点时间把最后一片处理完 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按 size 切片发送，用来验证服务端的分片拼装 */
function sendInChunks(probe: Probe, bytes: Buffer, size: number): number {
  let chunks = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    probe.sendBytes(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
    chunks += 1;
  }
  return chunks;
}

/** 普通 HTTP 请求看端口是否拒绝（非 WebSocket 一律 426） */
function probeHttp(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
}

/**
 * 读取渲染层源码文件。
 *
 * 从 `process.cwd()` 起步（npm script 固定从 `electron/` 跑），再回退到 Electron 的
 * appPath —— 免得换个启动方式就变成「文件找不到」的假失败。
 */
async function readRendererFile(relative: string): Promise<string | null> {
  for (const base of [process.cwd(), app.getAppPath()]) {
    const target = path.join(base, relative);
    if (await exists(target)) return readFile(target, 'utf8');
  }
  return null;
}

/** 取某条 CSS 规则的花括号内容。选择器要求后面紧跟 `{`，避免命中注释或 `.a.b` 这类前缀匹配 */
function cssRuleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
}

/**
 * 按 CSS 的 padding 简写规则展开出四边数值（只处理 px，够用于本项目）。
 *
 * 存在的理由：叠图布局把 `.frame[data-role='app']` 的 left/top 写成与 `.canvas`
 * 内边距**相同的字面量**。这是一处真实的隐性耦合 —— 改了内边距而没改偏移量，
 * 截图帧就会整体错开几个像素。错开后**看起来仍然像一张正常的叠图**，
 * 只是所有几何结论都偏了，属于「不报错但结论全错」的那类问题，必须有断言守着。
 */
function parsePaddingPx(rule: string | null): { top: number; left: number } | null {
  const raw = rule?.match(/padding\s*:\s*([^;]+)/)?.[1];
  if (!raw) return null;
  const parts = raw
    .trim()
    .split(/\s+/)
    .map((item) => Number.parseFloat(item));
  if (parts.some((value) => !Number.isFinite(value))) return null;
  const first = parts[0];
  if (first === undefined) return null;
  // 简写展开：1 值 = 四边；2 值 = 上下 / 左右；3 值 = 上 / 左右 / 下；4 值 = 上 / 右 / 下 / 左
  const left = parts.length >= 4 ? parts[3] : parts.length === 1 ? first : parts[1];
  if (left === undefined) return null;
  return { top: first, left };
}

/**
 * 某条选择器是否出现在规则的**选择器列表**里。
 *
 * 为什么不复用 `cssRuleBody`：它要求选择器后**紧跟** `{`，于是分组选择器
 * （`.crumb.context,\n.crumb.context:hover { … }`）一条都命中不了 ——
 * 样式明明写对了，断言却报 FAIL，比不写这条断言还糟。
 *
 * 同时排除前缀误命中：`.crumb.context` 不会匹配到 `.crumb.contextual {`
 * （要求选择器之后是 `,` 或 `{`）。
 */
function hasSelector(css: string, selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[,\\n])\\s*${escaped}\\s*[,{]`).test(css);
}

/**
 * 找出「被换行劈断的声明名」：整行只有小写字母和连字符（如 `box-si`），
 * 既没有 `:` 也没有 `{` `}` `;`。CSS 里这种行必然是残缺声明的一部分。
 *
 * 真实踩过：`box-sizing: border-box;` 被劈成 `box-si` + `ing: border-box` 两行，
 * 浏览器按规范**整条忽略**这条声明，页面不报任何错 —— 但全页盒模型从 border-box
 * 悄悄退回 content-box，画布选中框的边框把盒撑大 2×线宽、右 / 下边界外移。
 * 靠肉眼 review CSS 是发现不了的，必须让机器盯着。
 */
function truncatedDeclarationLines(css: string): string[] {
  return css
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z][a-z-]*$/.test(line));
}

async function main(): Promise<void> {
  // 纯静态约定，放在样本检查之前 —— 缺样本时这几条照样要跑
  section('0. 静态结构约定（画布渲染层 / 页面匹配 / IPC 三方对齐；不依赖样本）');
  const canvasCss = await readRendererFile('src/renderer/src/styles/verify.css');
  const canvasTsx = await readRendererFile('src/renderer/src/components/NodeCanvas.tsx');
  const rasterTsx = await readRendererFile('src/renderer/src/components/FrameRaster.tsx');
  check(
    '能读到渲染层画布源码（CSS / NodeCanvas / FrameRaster）',
    canvasCss !== null && canvasTsx !== null && rasterTsx !== null,
  );

  // 教训：选中态曾用 z-index 把自己抬到最上层「保证看得见」，代价是它连同整个子树
  // 盖住了后面（更靠前）的兄弟节点 —— 表现成「点选一个大容器后，里面的元素再也点不到，
  // 取消选中才恢复」。可见性必须由独立的、不吃点击的描边层承担。
  const selectedRule = canvasCss ? cssRuleBody(canvasCss, '.node-overlay.selected') : null;
  check('.node-overlay.selected 规则存在', selectedRule !== null);
  check(
    '选中态不用 z-index 改变命中顺序（否则选中容器后会挡死它后面的节点）',
    selectedRule !== null && !/z-index/.test(selectedRule),
    selectedRule?.match(/z-index[^;]*/)?.[0] ?? '',
  );

  // 选中框已搬到**屏幕空间**（`.raster-selection`，由 FrameRaster 渲染）。
  // 原先它在 `.nodes-layer` 里，线宽靠 calc(var(--node-ring-w) * --iz * --izs) 反向补偿。
  // 但补偿只是布局层面的等式：那一层在 transform: scale() 内部，本地线宽要写成 1/zoom，
  // zoom = 16 时是 0.0625px —— 光栅化几乎画不出这条线，再被合成器拉伸 16 倍，
  // 就是「选中框随缩放变粗、变糊、边缘不齐」的来源。
  const outlineRule = canvasCss ? cssRuleBody(canvasCss, '.raster-selection') : null;
  check('.raster-selection 规则存在（选中框由屏幕空间层承担）', outlineRule !== null);
  check(
    '选中框只描边、不吃点击（pointer-events: none）',
    outlineRule !== null && /pointer-events\s*:\s*none/.test(outlineRule),
  );
  // ⚠️ 核心回归守卫：--iz / --izs 是给「活在缩放层里、需要反向补偿」的元素用的。
  // 选中框一旦引用它们，说明又被搬回 transform 层 —— 线宽会重新随缩放变化。
  check(
    '⚠️ 选中框不做 --iz / --izs 反向补偿（出现即说明又被搬回 transform 层）',
    outlineRule !== null && !/var\(--iz/.test(outlineRule) && !/var\(--izs/.test(outlineRule),
    outlineRule?.match(/var\(--iz[^)]*\)/g)?.join(' ') ?? '',
  );
  check(
    '选中框仍由 border 承担描边（clipped 时要能切成虚线）',
    outlineRule !== null && /border\s*:/.test(outlineRule),
  );
  check(
    'FrameRaster 确实渲染了选中框（光有 CSS 不生效）',
    rasterTsx !== null && /raster-selection/.test(rasterTsx),
  );
  check(
    'NodeCanvas 不再渲染选中框（那一层在 transform 内，画不出稳定的 1px）',
    canvasTsx !== null && !/selection-outline/.test(canvasTsx),
  );
  check(
    '旧规则 .selection-outline 已彻底删除（留着就是两条真相互相矛盾）',
    !/\.selection-outline\s*\{/.test(canvasCss ?? ''),
  );

  // 默认态必须干净：一帧动辄几百个节点，若每个都描边，画布会被满屏线框盖住 ——
  // 看得见的是框，看不见的是设计稿本身。描边只在 hover / 选中时按需出现。
  const overlayRule = canvasCss ? cssRuleBody(canvasCss, '.node-overlay') : null;
  check('.node-overlay 基础规则存在', overlayRule !== null);
  const baseBorder = overlayRule?.match(/border(?:-width)?\s*:\s*([^;]+)/)?.[1]?.trim() ?? '0';
  check(
    '默认态不绘制边框（满屏描边会盖掉设计稿本身）',
    /^0(px)?$/.test(baseBorder),
    `实际 border: ${baseBorder}`,
  );
  check(
    '不得给数据源加常驻边框（design / app 各一种颜色，正是"满屏边框"的来源）',
    !/\.node-overlay\s*\[\s*data-source/.test(canvasCss ?? ''),
  );

  // hover 环与选中框**同住屏幕空间**（`.raster-hover` / `.raster-selection`）。
  // 原先 hover 环写成 `.node-overlay:hover { background; box-shadow: inset … }`，那两个
  // 问题一次都躲不掉：① 本层在 transform: scale() 内部，线宽得写成 calc(1px × --iz × --izs)，
  // zoom = 16 时是 0.0625px，光栅化画不出这条线，再被合成器拉伸 16 倍就是又粗又灰的带子；
  // ② `:hover` 在嵌套 DOM 下会**同时命中整条祖先链**，最外层 Frame 会给整块 375×867 铺一层
  // 15% 蓝、把设计稿盖住。②只能靠 `:has(.node-overlay:hover)` 打补丁，而补丁本身也是错的：
  // 「该高亮谁」这件事根本不由 CSS 决定，而由 lib/selection 的**当前上下文层**决定。
  const hoverRingRule = canvasCss ? cssRuleBody(canvasCss, '.raster-hover') : null;
  check('.raster-hover 规则存在（hover 环由屏幕空间层承担）', hoverRingRule !== null);
  check(
    '⚠️ hover 环不做 --iz / --izs 反向补偿（出现即说明又被搬回 transform 层）',
    hoverRingRule !== null && !/var\(--iz/.test(hoverRingRule) && !/var\(--izs/.test(hoverRingRule),
    hoverRingRule?.match(/var\(--iz[^)]*\)/g)?.join(' ') ?? '',
  );
  check(
    'hover 环用 border 描边（要能切成虚线，与实线的选中框区分开）',
    hoverRingRule !== null && /border\s*:/.test(hoverRingRule) && /dashed/.test(hoverRingRule),
  );
  check(
    '.raster-hover 自己声明 box-sizing: border-box（与选中框同一套尺寸语义，两者才能严格重合）',
    hoverRingRule !== null && /box-sizing\s*:\s*border-box/.test(hoverRingRule),
  );
  check(
    'FrameRaster 确实渲染了 hover 环，且排在选中框**之前**（实线压在虚线上）',
    rasterTsx !== null &&
      /raster-hover/.test(rasterTsx) &&
      rasterTsx.indexOf('raster-hover') < rasterTsx.lastIndexOf('raster-selection'),
  );
  check(
    '旧做法已删除：`.node-overlay:hover` 不再自己画环（那一层在 transform 内，画不出稳定的 1px）',
    canvasCss !== null && cssRuleBody(canvasCss, '.node-overlay:hover') === null,
  );
  check(
    '旧做法已删除：不再靠 :has(.node-overlay:hover) 抑制祖先环（谁该高亮由 lib/selection 决定，不是 CSS）',
    !/:has\(\.node-overlay:hover\)\s*[,{]/.test(canvasCss ?? ''),
  );
  check(
    '节点层只留 .hovered 钩子给类型角标（::before 可见），本身**不画描边**',
    canvasCss !== null &&
      hasSelector(canvasCss, '.node-overlay.hovered::before') &&
      cssRuleBody(canvasCss, '.node-overlay.hovered') === null,
  );
  check(
    '选中态本体不重复描边（描边由 .raster-selection 单独承担）',
    selectedRule !== null && !/border\s*:/.test(selectedRule),
  );
  // ⚠️ 曾经有一条「hover 描边必须用 inset box-shadow、不许用 border」的约定，
  // 因为 border 会占据布局盒，而绝对定位的子节点以父元素 padding box 为包含块 ——
  // 每多一层边框，整棵子树就整体偏移 border-width（第 7 层已偏了 7px）。
  // 环搬到屏幕空间后这条不再适用：`.raster-hover` 是**兄弟层里的绝对定位元素**，
  // 它自己就是叶子，没有子节点可偏移；那里的 border 反而正是我们要的（能切虚线）。
  check(
    'hover / 选中两框都在屏幕空间层、都是绝对定位的叶子（border 不参与任何节点布局）',
    outlineRule !== null &&
      hoverRingRule !== null &&
      /position\s*:\s*absolute/.test(outlineRule) &&
      /position\s*:\s*absolute/.test(hoverRingRule) &&
      !/\.raster-(hover|selection)\s+\./.test(canvasCss ?? ''),
  );

  // hover 与选中的线宽必须出自同一个变量（--node-ring-w），且**都是裸引用**：
  // 搬家之后两者都在屏幕空间，「屏幕上的最终宽度相等」不再需要任何补偿。
  // 带 calc(… × --iz) 反而是「又被搬回 transform 层」的信号。
  const outlineRing = outlineRule?.match(/border\s*:\s*(var\(--node-ring-w\))/)?.[1];
  const hoverRing = hoverRingRule?.match(/border\s*:\s*(var\(--node-ring-w\))/)?.[1];
  const normWidth = (value?: string): string => value?.replace(/\s+/g, '') ?? '';
  check(
    '能解析出 hover 与选中的描边宽度',
    normWidth(hoverRing) !== '' && normWidth(outlineRing) !== '',
    `hover=${normWidth(hoverRing)} / selected=${normWidth(outlineRing)}`,
  );
  check(
    '两态线宽同源且都是**裸** var(--node-ring-w)（屏幕空间里写多少就是多少，不能再有补偿）',
    normWidth(hoverRing) === 'var(--node-ring-w)' &&
      normWidth(outlineRing) === 'var(--node-ring-w)',
    `hover=${normWidth(hoverRing)} / selected=${normWidth(outlineRing)}`,
  );
  check(
    '描边宽度只有一处定义（--node-ring-w），两态都引用它',
    /--node-ring-w\s*:\s*[\d.]+px/.test(canvasCss ?? '') &&
      normWidth(hoverRing).includes('var(--node-ring-w)') &&
      normWidth(outlineRing).includes('var(--node-ring-w)'),
  );

  // 盒模型前提：选中框的 width/height 直接取节点 rect，**只有 border-box** 才能让
  // 「边框外沿 = rect 外沿」。曾因 `box-sizing: border-box` 被换行劈成
  // `box-si` + `ing: border-box` 两行（CSS 整条忽略），而验收页只引入 verify.css
  // （global.css 归投屏页），于是全页静默退回 content-box —— 选中框的 border 把盒
  // 撑大 2×线宽，右 / 下边界整体外移，看起来像「橙框比 hover 蓝框往右下偏」。
  const brokenDeclNames = truncatedDeclarationLines(canvasCss ?? '');
  check(
    '没有被换行劈断的声明名（这类残缺声明会被 CSS 整条忽略，静默改掉布局前提）',
    brokenDeclNames.length === 0,
    brokenDeclNames.join(' / '),
  );
  const resetBody = canvasCss?.match(/\*\s*\{([^}]*)\}/)?.[1] ?? '';
  check(
    '全局重置里 box-sizing: border-box 完好（本页不引入 global.css，它是唯一来源）',
    /box-sizing\s*:\s*border-box\s*;/.test(resetBody),
    resetBody.replace(/\s+/g, ' ').trim(),
  );
  check(
    '.node-overlay 自己声明 box-sizing: border-box（节点盒必须恰好等于 rect）',
    overlayRule !== null && /box-sizing\s*:\s*border-box/.test(overlayRule),
  );
  check(
    '.raster-selection 自己声明 box-sizing: border-box（否则边框外沿不再等于矩形外沿，选中框当不了尺子）',
    outlineRule !== null && /box-sizing\s*:\s*border-box/.test(outlineRule),
  );

  // ---- 放大上限与采样方式 ----
  // 上限原先在 CanvasViewport 与 VerifyToolbar 里各写了一份 `MAX_ZOOM = 4`：
  // 改上限必须同时改两个文件，漏一个就会出现「滚轮能放到 16x、加号按钮 4x 就顶住」
  // 这类不对称行为。现在常量只此一处（lib/zoom.ts），两个组件都必须引用它。
  const viewportTsx = await readRendererFile('src/renderer/src/components/CanvasViewport.tsx');
  const toolbarTsx = await readRendererFile('src/renderer/src/components/VerifyToolbar.tsx');
  const zoomTs = await readRendererFile('src/renderer/src/lib/zoom.ts');
  check('能读到缩放相关源码', viewportTsx !== null && toolbarTsx !== null && zoomTs !== null);
  check(
    '缩放常量只在 lib/zoom.ts 定义（组件里不得再写死 MIN_ZOOM / MAX_ZOOM / ZOOM_STEP）',
    !/const\s+(MIN_ZOOM|MAX_ZOOM|ZOOM_STEP)\s*=/.test(viewportTsx ?? '') &&
      !/const\s+(MIN_ZOOM|MAX_ZOOM|ZOOM_STEP)\s*=/.test(toolbarTsx ?? ''),
  );
  check(
    '画布与工具栏都从 lib/zoom 取常量（同一份上限才有意义）',
    /from\s+'\.\.\/lib\/zoom'/.test(viewportTsx ?? '') &&
      /from\s+'\.\.\/lib\/zoom'/.test(toolbarTsx ?? ''),
  );
  // 旧的 4x 上限连像素格门槛都够不着 —— 用户会觉得「放大倍率不够」且永远看不到格子
  check(
    '上限放到 16，且足以触达像素格阈值（否则「放大后显示像素格」永远看不到）',
    MAX_ZOOM >= 16 && MAX_ZOOM >= PIXEL_GRID_MIN_CELL_PX,
    `MAX_ZOOM = ${MAX_ZOOM} / 阈值 = ${PIXEL_GRID_MIN_CELL_PX}`,
  );

  // s = zoom × alignScale ÷ exportScale —— 「源图 1 像素占几个 CSS px」。
  // s < 1 源像素被缩小（必须平滑插值，否则出摩尔纹）；
  // s ≥ 1 源像素被放大（必须最近邻，否则 1px 的错位会被插值糊成 3px 渐变）。
  check(
    '采样比 s：100% + exportScale 2 → 0.5（源像素被缩小）',
    imageSamplingScale(1, 1, 2) === 0.5,
    `s = ${imageSamplingScale(1, 1, 2)}`,
  );
  check(
    '采样比 s：200% + exportScale 2 → 1（源像素恰好铺满 1 CSS px）',
    imageSamplingScale(2, 1, 2) === 1,
    `s = ${imageSamplingScale(2, 1, 2)}`,
  );
  check(
    's < 1 走平滑插值（缩图若切最近邻会出摩尔纹）',
    shouldUseCrispSampling(1, 1, 2) === false && shouldUseCrispSampling(1.9, 1, 2) === false,
  );
  check(
    's ≥ 1 切最近邻（放大时把像素边界还原成硬边，验收才看得出 1px 错位）',
    shouldUseCrispSampling(2, 1, 2) === true && shouldUseCrispSampling(8, 1, 2) === true,
  );
  check(
    'R4 的 alignScale 参与采样判定（截图帧按宽缩放会同步移动阈值）',
    imageSamplingScale(2, 0.96, 2) === 0.96 && shouldUseCrispSampling(2, 0.96, 2) === false,
    `s = ${imageSamplingScale(2, 0.96, 2)}`,
  );
  check(
    'exportScale / alignScale 非法时退回 1（不把 0 或 NaN 带进比值）',
    imageSamplingScale(2, 0, 0) === 2 && imageSamplingScale(2, Number.NaN, 2) === 1,
    `s(align=0,export=0) = ${imageSamplingScale(2, 0, 0)}`,
  );

  check(
    '像素格阈值：1 逻辑单位 ≥ 4.5 个 CSS px 才出现，即 450%（低于此格线几乎占满格宽，看着像一层纱）',
    PIXEL_GRID_MIN_CELL_PX === 4.5 &&
      shouldShowPixelGrid(4.5, 1) === true &&
      shouldShowPixelGrid(4.4, 1) === false,
    `阈值 = ${PIXEL_GRID_MIN_CELL_PX}`,
  );
  check(
    '旧门槛（800%）已放开：7.9 在旧阈值下不显示、现在显示（这正是本次下调的目的）',
    shouldShowPixelGrid(7.9, 1) === true && shouldShowPixelGrid(6, 1) === true,
    `${shouldShowPixelGrid(7.9, 1)} / ${shouldShowPixelGrid(6, 1)}`,
  );
  check(
    '截图的 alignScale 同样计入像素格阈值（不能只看 zoom）',
    shouldShowPixelGrid(4.8, 0.952) === true && shouldShowPixelGrid(4.4, 0.9) === false,
    `${shouldShowPixelGrid(4.8, 0.952)} / ${shouldShowPixelGrid(4.4, 0.9)}`,
  );
  check(
    '像素格格距 = zoom（1 设计稿逻辑单位 = 1 世界单位，屏幕空间里直接就是 CSS px）',
    PIXEL_GRID_UNIT === 1 && pixelGridCellPx(8) === 8 && pixelGridCellPx(0.5) === 0.5,
    `unit = ${PIXEL_GRID_UNIT}`,
  );
  // 画布可以往右下拖到世界坐标为负的区域，此时 JS 的 % 返回负值。归一化到 [0, cell)
  // 才与 CSS background-position 的语义一致，否则格子会整体错开一格。
  check(
    '像素格相位归一化到 [0, cell)（拖到负世界坐标时不能让格子错开一格）',
    pixelGridPhase(13, 8) === 5 &&
      pixelGridPhase(-3, 8) === 5 &&
      pixelGridPhase(-8, 8) === 0 &&
      pixelGridPhase(0, 8) === 0,
    `13→${pixelGridPhase(13, 8)} / -3→${pixelGridPhase(-3, 8)} / -8→${pixelGridPhase(-8, 8)}`,
  );
  // 像素格是**设计稿**尺度的背景网格，调用点必须恒传 alignScale = 1；
  // 传截图帧的对齐系数会让阈值随配对浮动（同一倍率下有的配对显示、有的不显示）。
  check(
    '像素格按设计稿尺度显示（调用点恒传 alignScale = 1，不随配对的对齐系数浮动）',
    /shouldShowPixelGrid\(zoom,\s*1\)/.test(viewportTsx ?? ''),
  );

  check('缩放下限被夹住', clampZoom(0.01) === MIN_ZOOM && clampZoom(-5) === MIN_ZOOM);
  check('缩放上限被夹住（16 之上不再放大）', clampZoom(99) === MAX_ZOOM && clampZoom(16) === MAX_ZOOM);

  // ---- 图层列表（Figma 的 Layers）与「点图层 → 聚焦画布」----
  //
  // 这一段守两条**不许重复实现**：
  //  ① 图层列表不得自己按 parentId 拼一遍树。与画布共用 buildNodeTree，否则遇到
  //     「parentId 指向缺失节点」这类脏数据时，两边对「谁是根」的判断会分叉 ——
  //     表现成「列表里是一个根，画布上是另一个根」。
  //  ② 帧的世界坐标不得在第二处测量。复用 FrameRaster 的 measureFrameBoxes，
  //     否则底图 / 选中框 / 聚焦三者迟早会在 alignScale 或内边距上错开。
  const layersTsx = await readRendererFile('src/renderer/src/components/LayersPanel.tsx');
  const boardTsx = await readRendererFile('src/renderer/src/components/CanvasBoard.tsx');
  check('能读到图层列表与画布组装源码', layersTsx !== null && boardTsx !== null);
  check(
    '图层列表复用 buildNodeTree（不许自己拼一遍「扁平表 → 树」）',
    /buildNodeTree\(/.test(layersTsx ?? ''),
  );
  check(
    '图层行的拉平 / 折叠复用 flattenVisibleTree（顺序与深度因此可测，不必肉眼 review 300 节点的树）',
    /flattenVisibleTree\(/.test(layersTsx ?? ''),
  );
  check('CanvasBoard 渲染了图层列表', /<LayersPanel/.test(boardTsx ?? ''));
  check(
    '画布持有视图句柄（聚焦要命令式调用；靠 props 重渲染做不到「让视口动一下」）',
    /useRef<CanvasViewportHandle>/.test(boardTsx ?? '') &&
      /ref=\{viewportRef\}/.test(boardTsx ?? ''),
  );
  check(
    '点图层行 = 选中 + 聚焦（onPick 走 handleFocus）',
    /onPick=\{handleFocus\}/.test(boardTsx ?? ''),
  );
  // 画布内点击**不能**聚焦：节点本来就在眼前，再挪一次视口会丢掉用户刚拖好的位置
  check(
    '画布内点击只选中不聚焦（onSelect 走 handleCanvasPick）',
    /onSelect=\{handleCanvasPick\}/.test(boardTsx ?? '') &&
      !/onSelect=\{handleFocus\}/.test(boardTsx ?? ''),
  );
  check(
    'CanvasViewport 暴露命令式聚焦接口（useImperativeHandle + focusRect）',
    /useImperativeHandle/.test(viewportTsx ?? '') && /focusRect/.test(viewportTsx ?? ''),
  );
  check(
    '帧世界坐标只有一处测量实现（FrameRaster 导出，CanvasViewport 复用）',
    /export function measureFrameBoxes/.test(rasterTsx ?? '') &&
      /measureFrameBoxes\(/.test(viewportTsx ?? ''),
  );

  const layersPanelRule = canvasCss ? cssRuleBody(canvasCss, '.layers-panel') : null;
  const layersTreeRule = canvasCss ? cssRuleBody(canvasCss, '.layers-tree') : null;
  check('.layers-panel 规则存在', layersPanelRule !== null);
  check(
    '图层列表在画布左侧（border-right 接画布，不是 border-left）',
    layersPanelRule !== null && /border-right\s*:/.test(layersPanelRule),
  );
  check(
    '图层树是唯一滚动区且可被压缩（flex:1 + min-height:0；少了后者面板会被内容顶高，把画布挤出视口）',
    layersTreeRule !== null && /flex\s*:\s*1/.test(layersTreeRule) && /min-height\s*:\s*0/.test(layersTreeRule),
  );
  check(
    '图层行有选中高亮（列表里也要能看出选中的是哪一行）',
    canvasCss ? cssRuleBody(canvasCss, '.layer-row.active') !== null : false,
  );

  // ---- 画布点击：**点哪选哪** ----
  //
  // 这一段守的是一条被真实数据证明过的事实（第 6 段有全帧采样）：**被子树盖住的父级
  // 是点不到的**。节点层是嵌套 DOM —— 父盒画在子盒下面，于是父节点只剩「子级没盖住的
  // 空隙」可点。
  //
  // ⚠️ 「无填充容器完全不参与命中」曾经也是真的（照抄 Figma「只对有像素的区域命中」，
  // 直接 `pointer-events: none`），**2026-09-16 已按用户要求推翻**：无填充的 Frame /
  // Group 也要能 hover 与点击（判据改成 `RenderNode.hittable`，规则与实测数据见那里）。
  // 所以现在点不到的**只剩**「被后代盖住的那一块」—— 那是「点哪选哪」的应有之义。
  //
  // 上一版对此的答案是 Figma 的「当前上下文层」：单击选**上下文层的最外层**
  // （help.figma.com/hc/en-us/articles/360040449873，官方原话 "we'll select the parent
  // by default"），而默认上下文是顶层 —— 于是单击**永远**落在帧根上。用户报了两次
  // 「某些节点 hover 和点击都选不中」，第一次是 Union、第二次是「只能选中最外层的根节点」。
  //
  // 现在反过来，参照物换成 **Chrome DevTools 的元素检查器**：
  //   单击 → 选中命中本身（最深）
  //   原地再点 → **上移一层**（DevTools 的 "click again to select the parent"）
  //   ⌘/Ctrl + 单击 → 一步跳到最外层容器（整帧）
  //   Esc → 上一层     Enter → 下一层
  // 规则集中在 lib/selection（纯函数），组件里只允许调用。
  //
  // ⚠️ 第三次报告是 **hover**：「13531 / 13533 / 13532 无法通过 hover 选中，
  // 只能选到子节点 13534 / 13535」。归因不是命中测试，而是 hover 当时**直接拿原始命中
  // 当目标** —— 而原始命中永远是命中最深的那一个，父级恰恰永远不是它。于是「原地再点」
  // 爬到父级的过程中环一直停在子节点上：点得到、却看不见。修法不是给 hover 另写一套
  // 规则（那会重新长出「环画在 A、点下去选中 B」），而是让它走**同一个 `planCanvasClick`**。
  //
  // ⚠️ 第四次报告（本轮）：「**无填充的 frame 元素也能被 hover 和点击选中**」。
  // 这次改的是**命中闸门本身**：从 `hasFill` 换成 `RenderNode.hittable`。
  const selectionTs = await readRendererFile('src/renderer/src/lib/selection.ts');
  const nodeCanvasTsx = await readRendererFile('src/renderer/src/components/NodeCanvas.tsx');
  const infoPanelTsx = await readRendererFile('src/renderer/src/components/NodeInfoPanel.tsx');
  check(
    '能读到选中规则 / 节点层 / 信息面板源码',
    selectionTs !== null && nodeCanvasTsx !== null && infoPanelTsx !== null,
  );
  check(
    '规则集中在 lib/selection（CanvasBoard 里不得自己写一遍循环 / 链构造 / hover 解析）',
    /export function planCanvasClick/.test(selectionTs ?? '') &&
      /export function planCanvasHover/.test(selectionTs ?? '') &&
      /export function ancestorChain/.test(selectionTs ?? '') &&
      /planCanvasClick\(/.test(boardTsx ?? '') &&
      /planCanvasHover\(/.test(boardTsx ?? '') &&
      /ancestorChain\(/.test(boardTsx ?? '') &&
      !/hitId/.test(boardTsx ?? ''),
  );
  // 单击**不看上下文**：上一版「单击永远落到帧根」的病根，就是那个解析器只回答
  // 「当前上下文层的最外层是谁」。输入里没有 contextId，这个病就不可能复发。
  const canvasClickBody =
    selectionTs?.match(/export interface CanvasClick \{([\s\S]*?)\n\}/)?.[1] ?? '';
  check(
    '⭐ CanvasClick 里没有 contextId（单击不再参考上下文层 —— 上一版「单击永远落到帧根」的病根）',
    canvasClickBody.length > 0 && !/contextId/.test(canvasClickBody),
  );
  // ⚠️ 先把函数体**截出来**再匹配：靠 `[\s\S]*?` 做全文松散匹配会被文件后面同名的
  // 另一处喂饱而永远通过（上一版就在这条上栽过）。
  const bodyOf = (source: string | null, signature: string): string =>
    source?.match(new RegExp(`${signature}\\(([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  const planClickBody = bodyOf(selectionTs, 'export function planCanvasClick');
  check('能截出 planCanvasClick 的函数体', planClickBody.length > 0);
  check(
    '⭐ 普通单击直接采用**命中本身**（chain[0]）—— 不是「当前上下文层的最外层」',
    /const hitId = chain\[0\]/.test(planClickBody) && /snap\(hitId\)/.test(planClickBody),
  );
  const hoverRuleBody = bodyOf(selectionTs, 'export function planCanvasHover');
  check('能截出 planCanvasHover 的函数体', hoverRuleBody.length > 0);
  check(
    '⭐ hover 规则**委托**给 planCanvasClick（不另写一套）：「环所在的层级」= 「下一击会选中的层级」因此是恒等式，而不是靠人维护的约定',
    /planCanvasClick\(/.test(hoverRuleBody) && /selectedId/.test(hoverRuleBody),
    (hoverRuleBody.match(/return[^;]*/)?.[0] ?? '').replace(/\s+/g, ' '),
  );
  check(
    '⭐ 原地再点是**上移一层**（chain[at + 1]），走到最外层则回绕到命中本身（% chain.length）—— 不是「进入一层」',
    /chain\[\(at \+ 1\) % chain\.length\]/.test(planClickBody),
    planClickBody.match(/snap\(chain\[[^\]]*\]\)/)?.[0] ?? '',
  );
  check(
    '⭐ ⌘/Ctrl 单击跳到**最外层容器**（chain 的最后一个）：点哪选哪之后，这是唯一需要「反着来」的动作',
    /chain\[chain\.length - 1\]/.test(planClickBody),
  );

  check(
    'NodeCanvas 连落点与 ⌘/Ctrl 一起交出去（缺一个就判不了「原地再点」/「跳到整帧」）',
    /onSelect\(\s*node,\s*\{ x: event\.clientX, y: event\.clientY \},\s*event\.metaKey \|\| event\.ctrlKey,?\s*\)/.test(
      nodeCanvasTsx ?? '',
    ),
  );
  check(
    '⭐ hover 交出去的东西与单击**完全一致**（命中 + 落点 + ⌘/Ctrl）：两者喂给同一个判定，缺一个就会各自算出不同答案',
    /onHover\(\s*node,\s*\{ x: event\.clientX, y: event\.clientY \},\s*event\.metaKey \|\| event\.ctrlKey,?\s*\)/.test(
      nodeCanvasTsx ?? '',
    ),
  );
  check(
    'NodeCanvas 给每个节点打 data-node-id（hover 要把 DOM 上的原始命中反查成节点）',
    /data-node-id=\{node\.id\}/.test(nodeCanvasTsx ?? ''),
  );
  // ⚠️ 2026-09-16：命中闸门从 `hasFill` 换成了 `hittable`。改回去就等于把「无填充的
  // Frame / Group」再次挡在门外 —— 而那正是用户第四次报的原话（「无填充的 frame 元素
  // 也要能被 hover 和点击选中」）。这条守卫是那次改动的唯一防线。
  check(
    '⭐ 命中闸门是 `node.hittable`（不是 `node.hasFill`）：无填充的容器照样能点到，改回 hasFill 立即 FAIL',
    /pointerEvents:\s*node\.hittable\s*\?\s*undefined\s*:\s*'none'/.test(nodeCanvasTsx ?? '') &&
      !/pointerEvents:\s*node\.hasFill/.test(nodeCanvasTsx ?? ''),
    (nodeCanvasTsx?.match(/pointerEvents:[^,]*/)?.[0] ?? '').trim(),
  );
  check(
    '⭐ 信息面板把「可命中」与「有填充」分开显示（用户问「为什么这个图层 hover 不到」时面板要能答）',
    /label="可命中"/.test(infoPanelTsx ?? '') && /label="有填充"/.test(infoPanelTsx ?? ''),
  );
  check(
    'NodeCanvas 在 .frame-stage 上监听 mousemove 并带 onMouseLeave 清空（挂在 pointer-events:none 的节点层上，光标进空隙就不再触发，环会停住不动）',
    /onMouseMove=\{handleHoverMove\}/.test(nodeCanvasTsx ?? '') &&
      /onMouseLeave=\{\(\) => onHover\(null\)\}/.test(nodeCanvasTsx ?? ''),
  );

  const commitHoverBody =
    boardTsx?.match(/const commitHover = useCallback\(([\s\S]*?)\n  \}, \[\]\);/)?.[1] ?? '';
  const resolveHoverBody =
    boardTsx?.match(/const resolveHover = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  const applyHoverBody =
    boardTsx?.match(/const applyHover = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  const applySelectionBody =
    boardTsx?.match(/const applySelection = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  check(
    '能截出 commitHover / resolveHover / applyHover / applySelection 的函数体（hover 解析与选中落地全在这四处）',
    commitHoverBody.length > 0 &&
      resolveHoverBody.length > 0 &&
      applyHoverBody.length > 0 &&
      applySelectionBody.length > 0,
  );
  check(
    '⭐ 选中项是**唯一**的状态：applySelection 里只 setSelected；CanvasBoard 里没有第二份「按帧各存一份」的上下文 state（上一版两份状态互相矛盾，就是「环画在 A、点下去选中 B」的根）',
    /setSelected\(/.test(applySelectionBody) &&
      !/setContexts\(/.test(boardTsx ?? '') &&
      !/Record<VerifySource, string \| null>/.test(boardTsx ?? ''),
  );
  check(
    '⭐ 「当前上下文层」是从选中项**算出来**的（parentContextOf），不是存下来的 —— 所以不存在对不上的可能',
    /parentContextOf\(/.test(boardTsx ?? '') &&
      /contextId=\{selectedContextId\}/.test(boardTsx ?? ''),
  );
  check(
    '⭐ hover 走的是**与单击同一个纯函数**（planCanvasHover）：链、选中项、落点、上一击的 cycle 一个不少地喂进去',
    /planCanvasHover\(/.test(resolveHoverBody) &&
      /ancestorChain\(/.test(resolveHoverBody) &&
      /selectedId:\s*selectionId/.test(resolveHoverBody) &&
      /prev:\s*clickCycleRef\.current/.test(resolveHoverBody) &&
      /outermost:\s*hit\.outermost/.test(resolveHoverBody),
  );
  check(
    '⭐ hover 不再直接拿原始命中当目标（`id: node.id` 那种写法）—— 那正是「13531 / 13533 / 13532 hover 不到、只能 hover 到子节点 13534 / 13535」的原因',
    !/id:\s*node\.id/.test(applyHoverBody) && !/id:\s*node\.id/.test(resolveHoverBody),
  );
  check(
    '⭐ hover 解析用的选中项是**参数传进来的**（不现读 state：落地选中的同一轮里 state 还没更新，读到旧值会把「刚点过」判成「没点过」，环落在错的一层）',
    /selectionId: string \| null/.test(resolveHoverBody) && !/selectedNodeId/.test(resolveHoverBody),
  );
  check(
    '⭐ 落地选中后**立刻用同一个落点重算 hover**：不重算的话，原地再点之后环还停在子节点上，直到鼠标再动一下才跳上去',
    /commitHover\(resolveHover\(hit, nodeId\)\)/.test(applySelectionBody) &&
      /lastHoverRef\.current/.test(applySelectionBody),
  );
  check(
    '鼠标移动时先用 ref 挡住重复的 setState（mousemove 每秒几十次，不挡就是每秒几十轮 300+ 节点的重渲染）',
    /hoverKeyRef\.current === key/.test(commitHoverBody),
  );
  check(
    '⭐ 画布单击把 cycle 交出去、其余入口传 null（列表 / 面包屑 / 键盘都没点画布，留着会被误判成「原地再点」）',
    /applySelection\(\s*node\.source,\s*outcome\.selectedId,\s*outcome\.cycle\s*\)/.test(boardTsx ?? '') &&
      /applySelection\(\s*node\.source,\s*node\.id,\s*null\s*\)/.test(boardTsx ?? '') &&
      /applySelection\(\s*source,\s*(parent|child),\s*null\s*\)/.test(boardTsx ?? ''),
    boardTsx?.match(/applySelection\(\s*node\.source,[\s\S]{0,80}/)?.[0]?.replace(/\s+/g, ' ') ?? '',
  );
  check(
    '⭐ 「原地再点」的判据用的是**命中 + 选中 + 落点**（选中项被别处改过就不算重复点击）',
    /prev\.hitId === hitId/.test(planClickBody) &&
      /prev\.selectedId === selectedId/.test(planClickBody) &&
      /CLICK_REPEAT_RADIUS/.test(planClickBody),
  );
  check(
    'Enter / Esc 挂在 window 上（画布容器不可聚焦，挂在它上面事件根本到不了）',
    /window\.addEventListener\('keydown'/.test(boardTsx ?? '') &&
      /addEventListener\('keydown', onKeyDown\)/.test(boardTsx ?? ''),
  );
  check(
    '键盘要挡掉输入框（否则在面板输入框里按 Esc / Enter 会去改画布选中）',
    /INPUT|isContentEditable/.test(boardTsx ?? '') && /INPUT/.test(boardTsx ?? ''),
  );
  check(
    '信息面板拿到链路与**当前上下文**（上下文 = 选中项的父级，由选中项算出来，不单独存）',
    /chain=\{selectionChain\}/.test(boardTsx ?? '') &&
      /contextId=\{selectedContextId\}/.test(boardTsx ?? '') &&
      /onPickAncestor=\{handleSelect\}/.test(boardTsx ?? ''),
  );
  check(
    '当前节点那一格不可点（它就是选中项，可点样式只会变成「按了没反应」）',
    /disabled=\{index === last\}/.test(infoPanelTsx ?? ''),
  );
  check(
    '⭐ 面包屑区分三态：上下文之上的祖先淡化（outside）、当前上下文层高亮（context）、选中项不可点（current）',
    /'outside'/.test(infoPanelTsx ?? '') && /'context'/.test(infoPanelTsx ?? ''),
  );
  check(
    '层级面包屑样式存在（链最长可到 7 层，必须能换行，否则把面板撑破）',
    canvasCss
      ? cssRuleBody(canvasCss, '.info-crumbs')?.includes('flex-wrap') === true
      : false,
  );
  check(
    '面包屑的「当前上下文层」有独立样式（否则那三态在视觉上分不开，等于没标）',
    canvasCss ? hasSelector(canvasCss, '.crumb.context') : false,
  );
  check(
    '面包屑「上下文之上」的祖先也有独立样式（淡化）',
    canvasCss ? hasSelector(canvasCss, '.crumb.outside') : false,
  );

  // 纯函数行为：链的构造 + 三种手势
  const chainMap = new Map<string, { parentId: string | null }>([
    ['leaf', { parentId: 'mid' }],
    ['mid', { parentId: 'outer' }],
    ['outer', { parentId: null }],
    // 与 leaf 同祖（outer）的另一支 —— 验证「换了点击目标」时原地再点应当失效
    ['sib', { parentId: 'outer' }],
    ['orphan', { parentId: 'missing' }],
    ['loopA', { parentId: 'loopB' }],
    ['loopB', { parentId: 'loopA' }],
  ]);
  check(
    '祖先链：最深 → 最外层（含自身）',
    ancestorChain(chainMap, 'leaf').join(',') === 'leaf,mid,outer',
    ancestorChain(chainMap, 'leaf').join(','),
  );
  check(
    '祖先链：parentId 指向缺失节点时就地截断（与 buildNodeTree 的「视为根」保持一致）',
    ancestorChain(chainMap, 'orphan').join(',') === 'orphan',
  );
  check(
    '祖先链：脏数据成环时不死循环（一份坏导出不该把渲染线程挂死）',
    ancestorChain(chainMap, 'loopA').join(',') === 'loopA,loopB',
    ancestorChain(chainMap, 'loopA').join(','),
  );

  const drillChain = ['leaf', 'mid', 'outer'] as const;
  const at = (x: number, y: number): { x: number; y: number } => ({ x, y });
  const clickAt = (
    selectedId: string | null,
    prev: ClickCycle | null,
    options: { outermost?: boolean; point?: { x: number; y: number } } = {},
  ) =>
    planCanvasClick({
      chain: drillChain,
      selectedId,
      point: options.point ?? at(100, 100),
      prev,
      outermost: options.outermost === true,
    });

  // ① 单击 → **命中本身**（最深）。方向上与上一版正好相反。
  const click1 = clickAt(null, null);
  check(
    '⭐ 单击 → 选中**命中本身**（最深那个）—— 上一版这里是「当前上下文层的最外层」，也就是帧根',
    click1?.selectedId === 'leaf',
    `选中 ${click1?.selectedId}`,
  );
  check(
    '⭐ 一击就够：链长 3 的最深节点，**单击一次**就选中（上一版要点 3 次逐级「进入」）',
    clickAt(null, null)?.selectedId === 'leaf',
  );
  check(
    '⭐ 单击**完全不看选中项**：不管之前选的是谁，这一击都落在命中本身（上一版的病根就是它去参考上下文层）',
    [null, 'leaf', 'mid', 'outer', 'sib'].every((sel) => clickAt(sel, null)?.selectedId === 'leaf'),
  );

  // ② 原地再点 = 上移一层（Chrome DevTools 的 "click again to select the parent"）
  const click2 = clickAt('leaf', click1!.cycle);
  check(
    '⭐ 原地再点 → **上移一层**：选中 mid',
    click2?.selectedId === 'mid',
    `选中 ${click2?.selectedId}`,
  );
  const click3 = clickAt('mid', click2!.cycle, { point: at(102, 101) });
  check(
    '继续原地再点（落点带 2px 手抖仍算原地）→ 再上移一层：选中 outer（最外层容器）',
    click3?.selectedId === 'outer',
    `选中 ${click3?.selectedId}`,
  );
  const click4 = clickAt('outer', click3!.cycle);
  check(
    '⭐ 到最外层再点 → **回绕到命中本身**（每一击都必须有可见的变化 ——「点了没反应」会被当成点击失灵）',
    click4?.selectedId === 'leaf',
    `选中 ${click4?.selectedId}`,
  );
  check(
    '⭐ 整条链是个闭环：原地连点刚好走一圈（不管父级有没有像素，链上每一层都点得到）',
    (() => {
      const seen: string[] = [];
      let cyc = clickAt(null, null)!;
      seen.push(cyc.selectedId);
      for (let i = 0; i < drillChain.length; i += 1) {
        cyc = clickAt(cyc.selectedId, cyc.cycle)!;
        seen.push(cyc.selectedId);
      }
      return seen.join(',') === 'leaf,mid,outer,leaf';
    })(),
  );

  // ③ ⌘/Ctrl = 一步跳到最外层容器
  check(
    '⭐ ⌘/Ctrl 单击 → 一步跳到**最外层容器**（从深节点出发「看整页」；点哪选哪之后这是唯一「反着来」的动作）',
    clickAt(null, null, { outermost: true })?.selectedId === 'outer',
  );

  // ④ 不变量：选中项 = 命中 或 命中链上的某一段 —— 「选中项永远在链上」
  check(
    '⭐ 不变量：任何一个手势选出来的节点都在**这条命中链**上（不可能跳到链外 / 一个不相干的节点）',
    [null, 'leaf', 'mid', 'outer', 'sib'].every((sel) => {
      const plan = clickAt(sel, null);
      return plan !== null && drillChain.includes(plan.selectedId as (typeof drillChain)[number]);
    }),
  );

  // ⑤ Enter / Esc。Esc 走的就是「上移一层」那条通道（`parentContextOf`），只是不用瞄准。
  check(
    '⭐ parentContextOf = 该节点的父级（面包屑的「当前层」与 Esc 都取它）',
    parentContextOf(chainMap, 'mid') === 'outer' && parentContextOf(chainMap, 'outer') === null,
    String(parentContextOf(chainMap, 'mid')),
  );
  check(
    '⭐ parentContextOf 不认**幽灵父级**（parentId 指向缺失节点时给 null，而不是一个谁也匹配不上的 id）',
    parentContextOf(chainMap, 'orphan') === null,
  );
  check(
    '⭐ Esc 与「原地再点」等价：从 leaf 出发，两条路径都落到 mid',
    clickAt('leaf', click1!.cycle)?.selectedId === parentContextOf(chainMap, 'leaf'),
    `Esc→${String(parentContextOf(chainMap, 'leaf'))} / 再点→${String(clickAt('leaf', click1!.cycle)?.selectedId)}`,
  );
  // ⚠️ 幽灵 id 必须排在**前面**：把它放在后面的话 `childIds[0]` 正好是合法节点，
  //    「过滤不存在节点」这条实现被删掉也照样通过 —— 断言就白写了。
  const entered = descendInto(chainMap, ['ghost', 'leaf']);
  check(
    'Enter → 选中第一个**真实存在**的子节点（幽灵 id 跳过，别把选中指到不存在的节点上）',
    entered === 'leaf',
    String(entered),
  );
  check('无子节点时 Enter 返回 null（无可进入，保持现状）', descendInto(chainMap, []) === null);

  // ⑥ 原地再点的容差与脏数据
  check(
    '落点挪开超过容差 → 不再算原地再点，落到命中本身（手移开了就是换了目标）',
    clickAt('mid', click2!.cycle, { point: at(100 + CLICK_REPEAT_RADIUS + 1, 100) })?.selectedId ===
      'leaf',
  );
  check(
    '重复判定的容差就在边界上：恰好 CLICK_REPEAT_RADIUS 算原地、多 1px 不算',
    CLICK_REPEAT_RADIUS === 4 &&
      clickAt('mid', click2!.cycle, { point: at(100 + CLICK_REPEAT_RADIUS, 100) })?.selectedId ===
        'outer' &&
      clickAt('mid', click2!.cycle, { point: at(100 + CLICK_REPEAT_RADIUS + 1, 100) })?.selectedId ===
        'leaf',
  );
  check(
    '命中元素变了 → 不算原地再点（不是同一个元素上的重复点击）',
    planCanvasClick({
      chain: ['other'],
      selectedId: 'leaf',
      point: at(100, 100),
      prev: click1!.cycle,
      outermost: false,
    })?.selectedId === 'other',
  );
  check(
    '⭐ 选中项被别处（图层列表 / Esc）改过 → 不算原地再点，按普通一击处理（回到命中本身）',
    clickAt('mid', click1!.cycle)?.selectedId === 'leaf',
    String(clickAt('mid', click1!.cycle)?.selectedId),
  );
  const staleCycle: ClickCycle = { hitId: 'leaf', selectedId: 'deleted', x: 100, y: 100 };
  check(
    '上一击选中的节点已不在链上（被删 / 换了页面）→ 落到命中本身，不瞎跳',
    clickAt('deleted', staleCycle)?.selectedId === 'leaf',
    String(clickAt('deleted', staleCycle)?.selectedId),
  );
  check(
    '空链 → null（保持现状，好过把选中态指到一个不存在的节点上）',
    planCanvasClick({
      chain: [],
      selectedId: null,
      point: at(0, 0),
      prev: null,
      outermost: false,
    }) === null,
  );
  const firstCycle = planCanvasClick({
    chain: drillChain,
    selectedId: null,
    point: at(1, 2),
    prev: null,
    outermost: false,
  });
  check(
    '⭐ 每次点击都带回 cycle（命中 + 选中 + 落点）—— 下一次的「还是不是原地再点」全靠它',
    firstCycle?.cycle.hitId === 'leaf' &&
      firstCycle.cycle.selectedId === 'leaf' &&
      firstCycle.cycle.x === 1 &&
      firstCycle.cycle.y === 2,
  );

  // ⑦ hover 与单击**同源**：环 = 「下一击会选中的那个」。
  //
  // 用户第三次报的是 hover：「13531 / 13533 / 13532 无法通过 hover 选中，只能选到子节点
  // 13534 / 13535」。根因不是命中测试，而是 hover 当时**直接拿原始命中**当目标 —— 而原始
  // 命中永远是命中最深的那一个，父级恰恰永远不是它。于是「原地再点」往上爬的过程中，
  // 环一直停在子节点上：**点得到、却看不见**。
  const hoverAt = (
    selectedId: string | null,
    prev: ClickCycle | null,
    options: { outermost?: boolean; point?: { x: number; y: number } } = {},
  ): string | null =>
    planCanvasHover({
      chain: drillChain,
      selectedId,
      point: options.point ?? at(100, 100),
      prev,
      outermost: options.outermost === true,
    });

  check(
    '⭐ hover 与单击同源：同一个输入喂给两个入口，答案逐条相等（同一个纯函数的两处调用）',
    [
      { selectedId: null, prev: null, outermost: false },
      { selectedId: 'leaf', prev: click1!.cycle, outermost: false },
      { selectedId: 'mid', prev: click2!.cycle, outermost: false },
      { selectedId: 'outer', prev: click3!.cycle, outermost: false },
      { selectedId: null, prev: null, outermost: true },
    ].every(
      (input) =>
        hoverAt(input.selectedId, input.prev, { outermost: input.outermost }) ===
        clickAt(input.selectedId, input.prev, { outermost: input.outermost })?.selectedId,
    ),
  );
  check(
    '⭐ hover 能到**链上每一层**：原地再点爬到哪一层，环就在哪一层（父级没有像素也照样 hover 得到）',
    (() => {
      const seen: string[] = [];
      let selection: string | null = null;
      let cycle: ClickCycle | null = null;
      for (let i = 0; i <= drillChain.length; i += 1) {
        seen.push(hoverAt(selection, cycle) ?? '-');
        const step: ClickOutcome | null = clickAt(selection, cycle);
        if (!step) break;
        selection = step.selectedId;
        cycle = step.cycle;
      }
      return seen.join(',') === 'leaf,mid,outer,leaf';
    })(),
    '逐击的 hover 应为 leaf,mid,outer,leaf',
  );
  check(
    '⭐ 什么都没选中时 hover 就在命中本身（不是上一版那套「上下文层」）',
    hoverAt(null, null) === 'leaf',
  );
  check(
    '⭐ ⌘/Ctrl + hover 预告的正是「⌘/Ctrl + 单击」会选中的那个（最外层容器）—— 修饰键在 hover 与 click 上语义一致',
    hoverAt(null, null, { outermost: true }) === 'outer' &&
      clickAt(null, null, { outermost: true })?.selectedId === 'outer',
  );
  check(
    'hover 在空链上返回 null（没命中任何节点 → 调用方清空 hover），不会指到一个不存在的节点上',
    planCanvasHover({
      chain: [],
      selectedId: null,
      point: at(0, 0),
      prev: null,
      outermost: false,
    }) === null,
  );

  // ⑧ 命中闸门：**谁能被指着选中**（2026-09-16 新增，纯函数、不依赖样本）。
  //
  // 用户第四次报的是「**无填充的 frame 元素也要能 hover 和点击选中**」。闸门原先写死成
  // `hasFill === false → pointer-events: none`（照抄 Figma「只对有像素的区域命中」），
  // 于是无填充的 Frame / Group 在画布上等于不存在。新判据（`RenderNode.hittable`）：
  //   ① 画得出像素（hasFill，含可见描边）→ 参与；
  //   ② 画不出像素但**是容器**（FRAME / GROUP / INSTANCE / COMPONENT / SECTION）→ 也参与；
  // 两类例外（都不参与）：`visible: false` 的隐藏图层；**填充被显式隐藏**的图层 ——
  // 后者在画面上一片空白，放进来只会变成「看不见的靶子」抢走真元素的 hover
  // （用户在「个人中心优化」样本上实测：会抢走 522 个采样点）。
  const designFixture = (patch: Partial<DesignNode>): DesignNode => ({
    id: 'd1',
    name: 'fixture',
    type: 'FRAME',
    path: 'root/fixture',
    depth: 1,
    visible: true,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    parentId: null,
    ...patch,
  });
  const designCases: Array<[string, Partial<DesignNode>, boolean]> = [
    ['有填充的矩形', { type: 'RECTANGLE', hasFill: true }, true],
    ['无填充的 FRAME（本轮要求的那一类）', { type: 'FRAME', hasFill: false }, true],
    ['无填充的 GROUP（13531 / 13533 就是这一种）', { type: 'GROUP', hasFill: false }, true],
    ['无填充的 INSTANCE', { type: 'INSTANCE', hasFill: false }, true],
    ['fills: [] 与缺字段同义（从没设过填充）', { type: 'FRAME', hasFill: false, fills: [] }, true],
    ['hasFill 缺失（旧版插件导出）→ 保守按可命中，避免整层点不动', { type: 'RECTANGLE' }, true],
    ['无填充的 RECTANGLE（盒只是包围盒，盒内空白不属于它）', { type: 'RECTANGLE', hasFill: false }, false],
    ['无填充的 VECTOR', { type: 'VECTOR', hasFill: false }, false],
    [
      '填充被显式隐藏的 FRAME（看不见的靶子）',
      { type: 'FRAME', hasFill: false, fills: [{ type: 'SOLID', visible: false }] },
      false,
    ],
    [
      '填充被显式隐藏的 RECTANGLE（图里「矩形备份 14」那一类）',
      { type: 'RECTANGLE', hasFill: false, fills: [{ type: 'SOLID', visible: false }] },
      false,
    ],
    [
      // ⚠️ 这一条是 2026-09-16 用户报「只能 hover / 选中 699:11614」的直接原因。
      // 插件的 `hasFill = 可见填充 || 可见描边`，所以「填充被隐藏 + 只剩 1.5px 描边」
      // 的节点 hasFill 是 true —— 若先按 hasFill 放行，这个 349×93.9 的整帧矩形
      // 会以**整盒**参与命中，逐像素实测吃掉 99.1% 的采样点，30 个节点只剩 4 个选得中。
      '⭐ 填充被隐藏但带可见描边（Rectangle 34626668 那一类）→ 不参与，否则整帧被它吃掉',
      { type: 'RECTANGLE', hasFill: true, fills: [{ type: 'SOLID', visible: false }] },
      false,
    ],
    [
      // 反面：从没设过填充、`hasFill` 为真 ⇒ 像素来自可见描边（图标 / 线 / 描边字）。
      // 这类在「个人中心优化」样本里有 22 个，一律关掉会让图标在画布上彻底选不中
      // （实测可命中节点 49 → 39），所以必须保留。
      '从没设过填充 + 有可见描边的图标（VECTOR）→ 参与',
      { type: 'VECTOR', hasFill: true, fills: [] },
      true,
    ],
    [
      // 填充被隐藏的 FRAME：**装了东西**才放行 —— 它只吃「盒内没被任何后代盖住的空隙」，
      // 那些点原本归最外层帧，归它更准。「消息」24×24 带 3 个子正是这样，
      // 放行后可命中节点 +1，且没有任何节点受损。
      '填充被隐藏但装了东西的 FRAME → 参与（只吃空隙）',
      { type: 'FRAME', hasFill: false, fills: [{ type: 'SOLID', visible: false }], childCount: 3 },
      true,
    ],
    [
      // 反面：**空壳 FRAME** —— 看不见，又常正好盖满父节点，放行即盾牌。
      // 「返回」是 12×12 的空 FRAME，恰好盖满父级「跳转箭头」：FRAME 一律放行时，
      // 父级与同级 VECTOR 的命中面积**双双归零**（可命中节点 51 → 50，比不改更差）。
      '填充被隐藏的**空壳** FRAME → 不参与（否则变成盖住父级的盾牌）',
      { type: 'FRAME', hasFill: false, fills: [{ type: 'SOLID', visible: false }], childCount: 0 },
      false,
    ],
    [
      '填充被隐藏的 GROUP（只有 FRAME 享受「有子就放行」，其余一律不放行）',
      { type: 'GROUP', hasFill: false, fills: [{ type: 'SOLID', visible: false }], childCount: 2 },
      false,
    ],
    ['隐藏的容器（看不见的东西不能被点到）', { type: 'GROUP', hasFill: false, visible: false }, false],
  ];
  check(
    '⭐ 设计稿命中规则（' +
      designCases.length +
      ' 种输入逐个断言）：无填充的容器参与命中；图形类零像素 / 空壳隐藏填充 / 隐藏图层都不参与',
    designCases.every(([, patch, expected]) => designNodeHittable(designFixture(patch)) === expected),
    designCases
      .filter(([, patch, expected]) => designNodeHittable(designFixture(patch)) !== expected)
      .map(([label]) => label)
      .join(' / ') || '全部符合预期',
  );

  const appFixture = (patch: Partial<AppNode>): AppNode => ({
    nodeId: 'v1',
    parentId: null,
    className: 'android.view.View',
    depth: 1,
    index: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    visibleX: 0,
    visibleY: 0,
    visibleWidth: 100,
    visibleHeight: 100,
    scrollX: 0,
    scrollY: 0,
    visible: true,
    enabled: true,
    clickable: false,
    alpha: 1,
    z: 0,
    elevation: 0,
    clipsToBounds: false,
    isImage: false,
    isSvg: false,
    isGradient: false,
    hasVisualContent: false,
    resourceName: null,
    contentDescription: null,
    text: null,
    ...patch,
  });
  const appCases: Array<[string, Partial<AppNode>, boolean]> = [
    ['有内容的 View', { hasVisualContent: true }, true],
    ['图片', { isImage: true }, true],
    ['渐变', { isGradient: true }, true],
    ['不画内容的 ViewGroup / 占位 View → 按容器命中（与设计稿侧同一套手感）', {}, true],
    // 2026-09-16：文本节点从「不按容器兜底」改成**照样命中**。有文字就该点得到 ——
    // 旧规则把「hasVisualContent 漏了但有 text」的异常数据判成不可命中，代价是那类
    // 文本在画布上完全选不中（端上真出过这种数据）。
    ['文本节点（哪怕 hasVisualContent 漏了）→ 照样命中', { text: '文字' }, true],
    ['不可见 View', { visible: false }, false],
    ['透明盾牌（框架层的全屏透明层，见 markAppHitShields）', { hitShield: true }, false],
  ];
  check(
    '⭐ App 侧命中规则（' +
      appCases.length +
      ' 种输入逐个断言）：不画内容的 View 就是布局容器，照样能被指着选中',
    appCases.every(([, patch, expected]) => appNodeHittable(appFixture(patch)) === expected),
    appCases
      .filter(([, patch, expected]) => appNodeHittable(appFixture(patch)) !== expected)
      .map(([label]) => label)
      .join(' / ') || '全部符合预期',
  );
  check(
    '⭐ toRenderNode 把命中判据带出来（两侧都带；组件只读字段，不自算规则）',
    toRenderNode(designFixture({ type: 'GROUP', hasFill: false }), 'design').hittable === true &&
      toRenderNode(designFixture({ hasFill: true }), 'design').hasFill === true &&
      toRenderNode(appFixture({}), 'app').hittable === true &&
      toRenderNode(appFixture({ visible: false }), 'app').hittable === false,
  );

  /**
   * 透明盾牌（2026-09-16 用户报「截图那侧只能选中根节点」）。
   *
   * 真机上 RN 的 `DebuggingOverlay` 是 360×774 的全屏透明层、且是父节点的唯一子节点，
   * DOM 里它盖住整帧：3160 点采样里 98.3% 命中它，可命中的不同节点只剩 2 个。
   * 构造一份同构的小树，把「谁该退、谁该留」逐条钉住。
   */
  const mkNode = (patch: Partial<AppNode>): AppNode => ({ ...appFixture({}), ...patch });
  const shieldTree: AppNode[] = [
    mkNode({ nodeId: 'root', parentId: null, depth: 0, width: 360, height: 792, hasVisualContent: true }),
    mkNode({ nodeId: 'page', parentId: 'root', depth: 1, width: 360, height: 774, hasVisualContent: true }),
    // 占父盒 1.2% 的空白 View：真实布局元素，不能当盾牌
    mkNode({ nodeId: 'spacer', parentId: 'page', depth: 2, width: 40, height: 40, hasVisualContent: false }),
    // 铺满父盒但**可点击**：是触摸热区，不能当盾牌
    mkNode({ nodeId: 'hot', parentId: 'page', depth: 2, width: 360, height: 774, hasVisualContent: false, clickable: true }),
    // 铺满父盒、不画东西、唯一子节点还是调试层 → 盾牌（只关调试层的话命中会退到它身上）
    mkNode({ nodeId: 'shell', parentId: 'root', depth: 1, width: 360, height: 774, hasVisualContent: false }),
    mkNode({
      nodeId: 'overlay',
      parentId: 'shell',
      depth: 2,
      width: 360,
      height: 774,
      hasVisualContent: false,
      className: 'com.facebook.react.views.debuggingoverlay.DebuggingOverlay',
    }),
  ];
  const marked = markAppHitShields(shieldTree);
  const isShield = (nodeId: string): boolean =>
    marked.find((item) => item.nodeId === nodeId)?.hitShield === true;
  check(
    '⭐ 透明盾牌：全屏透明层**和它的父壳**一起退出命中，页面内容 / 空白 View / 点击热区都不受影响',
    isShield('overlay') &&
      isShield('shell') &&
      !isShield('page') &&
      !isShield('spacer') &&
      !isShield('hot') &&
      !isShield('root'),
    marked.map((item) => `${item.nodeId}=${item.hitShield === true}`).join(' '),
  );
  check(
    '⭐ markAppHitShields 不改入参（只给被标中的节点返回新对象）',
    shieldTree.every((item) => item.hitShield === undefined),
  );
  const markedOverlay = marked.find((item) => item.nodeId === 'overlay');
  const markedPage = marked.find((item) => item.nodeId === 'page');
  check(
    '⭐ 盾牌退出命中后画布仍能点到页面里的节点（否则整帧又只剩一个框）',
    markedOverlay != null &&
      markedPage != null &&
      appNodeHittable(markedOverlay) === false &&
      appNodeHittable(markedPage) === true,
  );


  // 聚焦的判据全部在 planFocus 里（纯函数）。组件只负责「测量世界矩形」与「应用结果」，
  // 于是「死区 / 填充率 / 上限」这几条能被真正执行，而不只是被 grep 到。
  const FOCUS_VW = 1000;
  const FOCUS_VH = 700;
  const keepPlan = planFocus({
    zoom: 1,
    viewportWidth: FOCUS_VW,
    viewportHeight: FOCUS_VH,
    worldX: 0,
    worldY: 0,
    worldWidth: 200,
    worldHeight: 300,
  });
  check(
    '聚焦死区：目标尺寸已合适时保持当前倍数（只居中，不乱跳倍数）',
    keepPlan?.zoom === 1,
    `zoom = ${keepPlan?.zoom}`,
  );
  check(
    '聚焦居中：目标矩形中心落在视口中心',
    keepPlan !== null &&
      Math.abs(keepPlan.tx + 200 / 2 * keepPlan.zoom - FOCUS_VW / 2) < 1e-9 &&
      Math.abs(keepPlan.ty + 300 / 2 * keepPlan.zoom - FOCUS_VH / 2) < 1e-9,
    `tx=${keepPlan?.tx} / ty=${keepPlan?.ty}`,
  );

  const bigPlan = planFocus({
    zoom: 1,
    viewportWidth: FOCUS_VW,
    viewportHeight: FOCUS_VH,
    worldX: 0,
    worldY: 0,
    worldWidth: 375,
    worldHeight: 867,
  });
  check(
    '聚焦整帧（375×867，装不下）→ 缩到装得下（按较小边充满 FOCUS_FILL）',
    bigPlan?.zoom === clampZoom((FOCUS_VH * FOCUS_FILL) / 867),
    `zoom = ${bigPlan?.zoom}`,
  );
  check(
    '聚焦小图标（12×16）→ 放大，但停在 FOCUS_MAX_ZOOM',
    planFocus({
      zoom: 1,
      viewportWidth: FOCUS_VW,
      viewportHeight: FOCUS_VH,
      worldX: 0,
      worldY: 0,
      worldWidth: 12,
      worldHeight: 16,
    })?.zoom === FOCUS_MAX_ZOOM,
  );
  check(
    '8× 的聚焦上限低于 16× 的滚轮上限（点小图标不该直接把画布怼到 1600%，那是滚轮才该有的自由度）',
    FOCUS_MAX_ZOOM < MAX_ZOOM,
  );
  check(
    '死区上限高于填充率（否则「缩到 0.8」与「判定为合适」会在边界来回抖动）',
    FOCUS_KEEP_RATIO_MAX > FOCUS_FILL,
  );
  check(
    '视口还没测量出来时返回 null（返回 0 平移会把画布直接甩回世界原点）',
    planFocus({
      zoom: 1,
      viewportWidth: 0,
      viewportHeight: FOCUS_VH,
      worldX: 0,
      worldY: 0,
      worldWidth: 10,
      worldHeight: 10,
    }) === null,
  );
  check(
    '世界矩形尺寸为 0 / NaN 时按 1 个单位兜底（除零会把 zoom 算成 Infinity）',
    planFocus({
      zoom: 1,
      viewportWidth: FOCUS_VW,
      viewportHeight: FOCUS_VH,
      worldX: 0,
      worldY: 0,
      worldWidth: 0,
      worldHeight: Number.NaN,
    })?.zoom === FOCUS_MAX_ZOOM,
  );

  // 图层行的拉平 / 折叠：这是列表里最容易悄悄写错的一段（顺序、深度、折叠边界），
  // 抽成纯函数之后就不必肉眼 review 一棵 300 节点的树。
  const mkRow = (id: string, parentId: string | null, depth: number): RenderNode => ({
    id,
    parentId,
    source: 'design',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    kind: 'container',
    label: id,
    depth,
    index: 0,
    path: id,
    visible: true,
    hasFill: true,
    // 这一段只测图层行的拉平 / 折叠，命中面与它无关；给 true 以免与新增的命中闸门混淆
    hittable: true,
    clipped: false,
    clipsContent: false,
  });
  const layerTree = buildNodeTree([
    mkRow('root', null, 0),
    mkRow('a', 'root', 1),
    mkRow('b', 'root', 1),
    mkRow('c', 'root', 1),
    mkRow('a1', 'a', 2),
  ]);
  const allRows = flattenVisibleTree(layerTree, () => false);
  check(
    '⭐ 图层行兄弟保持**数组原序**（= Figma 面板的顺序：index 0 在面板最上面，用户截图钉死过）',
    allRows.map((row) => row.node.id).join(',') === 'root,a,b,c,a1',
    allRows.map((row) => row.node.id).join(','),
  );

  // 整条链的**入口**不能重排：`assets.ts` 与 `figmaImport.ts` 都走 flattenFigmaTree。
  // 它必须「DFS 前序 + 保持原数组顺序」（子节点紧跟父节点，同一父下的兄弟保持 back-to-front）。
  // 这一步若被翻转，下面那条「面板 ≡ 数组原序」还会成立（两边一起翻），
  // 但画布 DOM 就真的画反了 —— 背景会盖住内容，所以单独守一条。
  const figmaFixture: FigmaNode = {
    id: 'frameA',
    name: 'FrameA',
    type: 'FRAME',
    path: 'FrameA',
    depth: 0,
    visible: true,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    children: [
      {
        id: 'childrenB',
        name: 'childrenB',
        type: 'RECTANGLE',
        path: 'FrameA/childrenB',
        depth: 1,
        visible: true,
        rect: { x: 0, y: 0, width: 100, height: 100 },
      },
      {
        id: 'childrenA',
        name: 'childrenA',
        type: 'TEXT',
        path: 'FrameA/childrenA',
        depth: 1,
        visible: true,
        rect: { x: 10, y: 10, width: 40, height: 20 },
        children: [
          {
            id: 'childrenA1',
            name: 'childrenA1',
            type: 'VECTOR',
            path: 'FrameA/childrenA/childrenA1',
            depth: 2,
            visible: true,
            rect: { x: 12, y: 12, width: 8, height: 8 },
          },
        ],
      },
    ],
  };
  check(
    '⭐ flattenFigmaTree 保持原数组顺序（DFS 前序，兄弟仍是 back-to-front）：childrenB 在 childrenA 之前',
    flattenFigmaTree(figmaFixture)
      .map((node) => node.id)
      .join(',') === 'frameA,childrenB,childrenA,childrenA1',
    flattenFigmaTree(figmaFixture)
      .map((node) => node.id)
      .join(','),
  );
  check(
    '图层行深度正确（缩进跟着层级走）',
    allRows.map((row) => row.depth).join(',') === '0,1,2,1,1',
    allRows.map((row) => row.depth).join(','),
  );
  const foldedRows = flattenVisibleTree(layerTree, (node) => node.id === 'a');
  check(
    '折叠一个节点后它的整棵子树都不出现',
    foldedRows.map((row) => row.node.id).join(',') === 'root,a,b,c',
    foldedRows.map((row) => row.node.id).join(','),
  );
  check(
    'hasChildren / open 反映真实状态（决定箭头画不画、朝哪边）',
    foldedRows.find((row) => row.node.id === 'a')?.hasChildren === true &&
      foldedRows.find((row) => row.node.id === 'a')?.open === false &&
      foldedRows.find((row) => row.node.id === 'b')?.hasChildren === false &&
      foldedRows.find((row) => row.node.id === 'b')?.open === false,
  );

  // 固定的 0.25 步进在 16x 上限下，从 100% 按到顶要 60 次 —— 上限放开了但按不到
  // 等于没放开。自适应步进必须让这段路走得更短。
  const countClicksToMax = (): number => {
    let current = 1;
    let clicks = 0;
    while (current < MAX_ZOOM && clicks < 500) {
      current = clampZoom(current + zoomStepFor(current));
      clicks += 1;
    }
    return clicks;
  };
  check(
    '步进随倍数增长（低倍精细、高倍粗放）',
    zoomStepFor(1) === 0.25 && zoomStepFor(3) === 0.5 && zoomStepFor(5) === 1 && zoomStepFor(9) === 2,
  );
  check(
    '从 100% 按到上限不超过 20 次（固定 0.25 步进需要 60 次）',
    countClicksToMax() <= 20,
    `实际 ${countClicksToMax()} 次`,
  );

  // ---- 屏幕空间光栅层：底图 + 像素格 ----
  //
  // 这一段守的是一条结构约束：**需要像素级精确的东西不许待在 transform 层里**。
  // 待在里面的内容会先被光栅化成位图、再被合成器拉伸放大，而 CSS 只能影响
  // 「元素自己画自己」那一步 —— image-rendering 管不到合成器的重采样，
  // 线宽反向补偿也算不准（zoom = 8 时格线本地只有 0.125px，光栅化覆盖率 12.5%，
  // 画出来本就是一条浅灰带）。搬出去之后，「有没有被搬回去」就由下面这几条盯着。

  const rasterRule = canvasCss ? cssRuleBody(canvasCss, '.raster-layer') : null;
  const viewportRule = canvasCss ? cssRuleBody(canvasCss, '.canvas-viewport') : null;
  check('.raster-layer / .canvas-viewport 规则存在', rasterRule !== null && viewportRule !== null);
  {
    const rasterZ = Number(/z-index\s*:\s*(-?\d+)/.exec(rasterRule ?? '')?.[1] ?? Number.NaN);
    const viewportZ = Number(/z-index\s*:\s*(-?\d+)/.exec(viewportRule ?? '')?.[1] ?? Number.NaN);
    check(
      '底图层在节点层**之下**（节点层大面积透明，底图压在上面会把整个画布盖死）',
      Number.isFinite(rasterZ) && Number.isFinite(viewportZ) && rasterZ < viewportZ,
      `raster z=${rasterZ} / viewport z=${viewportZ}`,
    );
  }
  check(
    '光栅层不吃点击（节点选中全靠上层节点层）',
    rasterRule !== null && /pointer-events\s*:\s*none/.test(rasterRule),
  );

  const rasterImageRule = canvasCss ? cssRuleBody(canvasCss, '.raster-image') : null;
  check('.raster-image 规则存在', rasterImageRule !== null);
  check(
    '图片默认平滑（源像素被缩小时不插值会出摩尔纹）',
    rasterImageRule !== null && /image-rendering\s*:\s*auto/.test(rasterImageRule),
  );
  // 用 transform 定位就等于又回到「先光栅化再被合成器拉伸」，搬层的意义全部归零
  check(
    '底图不用 transform 定位（用 transform 就等于又回到合成器放大）',
    rasterImageRule !== null && !/(^|[^-])transform\s*:/.test(rasterImageRule),
  );
  const crispRule = canvasCss ? cssRuleBody(canvasCss, ".raster-image[data-crisp='true']") : null;
  check(
    '放大时切最近邻：.raster-image[data-crisp=true] → pixelated',
    crispRule !== null && /image-rendering\s*:\s*pixelated/.test(crispRule),
    crispRule ?? '规则缺失',
  );

  const gridRule = canvasCss ? cssRuleBody(canvasCss, '.pixel-grid') : null;
  check('.pixel-grid 规则存在', gridRule !== null);
  // 格线与选中框必须**同宽**，否则「选中框压在格线上」时会露出一条更宽或更细的边。
  // 同宽靠共用一个变量保证，不靠两处各写 1px 的巧合。
  check(
    '像素格线宽与选中框同源（--node-ring-w）：等宽是「重合」的前提',
    gridRule !== null && /var\(--node-ring-w\)/.test(gridRule) && !/\b1px\b/.test(
      gridRule.replace(/var\(--node-ring-w\)/g, ''),
    ),
    gridRule?.match(/linear-gradient\([^;]*\)/g)?.join(' ') ?? '',
  );
  check(
    '像素格不吃点击（否则整层会盖死节点选中）',
    gridRule !== null && /pointer-events\s*:\s*none/.test(gridRule),
  );
  check('像素格默认隐藏（只在放大到阈值后出现）', gridRule !== null && /opacity\s*:\s*0\b/.test(gridRule));
  // ⚠️ 核心回归守卫：--iz / --izs 是给「活在 transform 层里、需要反向补偿」的元素用的。
  // 像素格一旦引用它们，说明又被搬回缩放层内部 —— 格线会重新变糊。
  check(
    '像素格不再做 --iz / --izs 反向补偿（出现即说明被搬回 transform 层）',
    gridRule !== null && !/var\(--iz/.test(gridRule) && !/var\(--izs/.test(gridRule),
    gridRule?.match(/var\(--iz[^)]*\)/g)?.join(' ') ?? '',
  );
  check(
    '像素格格距交给 background-size（JS 按 zoom 计算），不再靠 transform 放大',
    gridRule !== null && /background-repeat\s*:\s*repeat/.test(gridRule) && !/calc\(/.test(gridRule),
  );
  check(
    '像素格线上色取自变量（--pixel-grid-line），不在规则里写死颜色',
    gridRule !== null && /var\(--pixel-grid-line\)/.test(gridRule) && /--pixel-grid-line\s*:/.test(canvasCss ?? ''),
  );
  const gridShowRule = canvasCss
    ? cssRuleBody(canvasCss, '.raster-layer.pixel-grid-on .pixel-grid')
    : null;
  check(
    '放大到阈值后像素格才显示：.raster-layer.pixel-grid-on .pixel-grid → opacity 1',
    gridShowRule !== null && /opacity\s*:\s*1/.test(gridShowRule),
    gridShowRule ?? '规则缺失',
  );
  // 常驻的 50px 视口背景网格已整体移除：它与像素格尺度差三个数量级，
  // 且在任何倍率下都出现，低倍时紧贴视口边缘会被误读成「画布的背景边框」。
  // 匹配规则本体（带 `{`）而不是裸字符串 —— 说明性的注释里还留着这个名字。
  check(
    '常驻的 50px 视口背景网格已移除（网格现在只有 .pixel-grid 一个来源）',
    !/\.canvas-scroll::before\s*\{/.test(canvasCss ?? '') && !/50px\s+50px/.test(canvasCss ?? ''),
  );
  check(
    'CanvasViewport 不再挂 pixel-grid-on（该类的唯一用途是让位那个背景网格）',
    !/pixel-grid-on/.test(viewportTsx ?? ''),
  );

  // 光有 CSS 不生效：开关与几何必须由组件写进 DOM
  check(
    'FrameRaster 渲染了 raster 层与像素格',
    /raster-layer/.test(rasterTsx ?? '') && /className="pixel-grid"/.test(rasterTsx ?? ''),
  );
  check(
    'FrameRaster 把 data-crisp 写到每张底图上（CSS 的开关来源）',
    /data-crisp=/.test(rasterTsx ?? ''),
  );
  // 相位必须锁设计稿帧的原点：.canvas 有 64px 左内边距，锁世界原点会整体错开 8 格
  check(
    '像素格相位锁在**设计稿帧**原点（锁世界原点会整体错开 8 格）',
    /source === 'design'/.test(rasterTsx ?? '') && /pixelGridPhase\(/.test(rasterTsx ?? ''),
  );
  check(
    '世界坐标由 .frame-content 实测反推并除以 zoom（与缩放无关，平移时无需重测）',
    /\.frame-content\[data-frame\]/.test(rasterTsx ?? '') && /\/ safeZoom/.test(rasterTsx ?? ''),
  );
  // 采样阈值需要 exportScale，而它必须来自**图片真实像素**：IPC 元数据可能与文件不一致
  check(
    '导出倍率从图片真实像素反推（naturalWidth ÷ 逻辑宽），不依赖 IPC 元数据',
    /naturalWidth/.test(rasterTsx ?? '') && /exportScale/.test(rasterTsx ?? ''),
  );

  // 反面约束：底图与像素格**不许**再出现在 transform 层内（NodeCanvas 就是那一层）
  check(
    '⚠️ NodeCanvas 不再渲染任何底图 / 像素格元素（挂在缩放层内必然被合成器拉伸）',
    !/frame-image/.test(canvasTsx ?? '') && !/className="pixel-grid"/.test(canvasTsx ?? ''),
  );
  check(
    'NodeCanvas 给 .frame-content 打上 data-frame（FrameRaster 靠它配对与测量）',
    /data-frame=\{source\}/.test(canvasTsx ?? ''),
  );

  // 帧盒让位：底图在它下层，只要它还留着不透明底色，底图就被整块盖住
  const frameStageRule = canvasCss ? cssRuleBody(canvasCss, '.frame-stage') : null;
  check('.frame-stage 规则存在', frameStageRule !== null);
  check(
    '帧盒背景透明（否则会盖住位于它下层的光栅底图）',
    frameStageRule !== null && /background\s*:\s*transparent/.test(frameStageRule),
  );
  check(
    '帧盒那圈 1px 描边改用 box-shadow 并按 --iz 反向补偿（留 border 的话高倍下会变成 8~16px）',
    frameStageRule !== null &&
      !/(^|[^-])border\s*:/.test(frameStageRule) &&
      /box-shadow/.test(frameStageRule) &&
      /calc\(1px\s*\*\s*var\(--iz/.test(frameStageRule),
  );

  // ---- 页面匹配：素材删除（设计稿 / 截图）----
  // 这一组只查「接线是否完整、位置是否合理」。级联语义本身在第 11 段实测。
  const matchTsx = await readRendererFile('src/renderer/src/components/MatchBoard.tsx');
  const workspaceTsx = await readRendererFile('src/renderer/src/pages/VerifyWorkspacePage.tsx');
  const preloadTs = await readRendererFile('src/preload/index.ts');
  const ipcTypesTs = await readRendererFile('src/types/ipc.ts');
  const verifyIpcTs = await readRendererFile('src/main/verifyIpc.ts');
  check(
    '能读到素材删除涉及的五个源码文件',
    matchTsx !== null &&
      workspaceTsx !== null &&
      preloadTs !== null &&
      ipcTypesTs !== null &&
      verifyIpcTs !== null,
  );

  // 两侧都要有入口 —— 「只做了一侧」是这类需求最常见的漏项，且单看截图很容易漏掉
  check('设计稿卡片有删除入口', (matchTsx ?? '').includes('onDeleteDesign(asset.id)'));
  check('App 截图卡片有删除入口', (matchTsx ?? '').includes('onDeleteApp(app.id)'));
  check(
    '两个删除按钮都用 .card-del 样式（数量必须是 2）',
    ((matchTsx ?? '').match(/className="card-del"/g) ?? []).length === 2,
    `实际 ${((matchTsx ?? '').match(/className="card-del"/g) ?? []).length}`,
  );
  // 卡片本体的 onClick 就是「把这一侧换成它」，不拦冒泡的话点 × 会先替换一次再删，
  // 用户看到的是「删掉的那个东西自己跳到了当前配对里」
  check(
    '两个删除按钮都拦了冒泡（否则点删除会顺带把这张卡选为当前一侧）',
    ((matchTsx ?? '').match(/stopPropagation\(\);\s*onDelete(?:Design|App)\(/g) ?? []).length === 2,
    `实际 ${((matchTsx ?? '').match(/stopPropagation\(\);\s*onDelete(?:Design|App)\(/g) ?? []).length}`,
  );

  check(
    '配对卡与素材卡的删除按钮共用同一条规则（视觉不会各自漂移）',
    /\.pair-del,\s*\.card-del\s*\{/.test(canvasCss ?? ''),
  );
  check(
    '删除按钮默认隐藏、hover 卡片才出现（素材墙每格常驻 × 会很吵）',
    /\.pair-card:hover \.pair-del,\s*\.asset-card:hover \.card-del\s*\{[^}]*display:\s*flex/.test(
      canvasCss ?? '',
    ),
  );
  check(
    '素材卡的删除按钮锚在缩略图右下角（避开「当前」「已配对」两个角标）',
    /\.card-del\s*\{[^}]*bottom:\s*6px[^}]*right:\s*6px/.test(canvasCss ?? ''),
  );
  check(
    '素材卡的删除按钮有白色衬底（深色设计稿上纯描边色的 × 看不见）',
    /\.card-del\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/.test(canvasCss ?? ''),
  );
  // `.card-del` 用 `position: absolute` 定位，锚点取决于最近的定位祖先 ——
  // 缩略图一旦不是 relative，按钮就会跑到整张卡片的角上
  const thumbRule = canvasCss ? cssRuleBody(canvasCss, '.card-thumb') : null;
  check(
    '缩略图是定位上下文（否则删除按钮会锚到整张卡片而不是缩略图）',
    thumbRule !== null && /position\s*:\s*relative/.test(thumbRule),
  );

  check(
    '工作台把删除意图接给了两侧卡片',
    /onDeleteDesign=\{\(id\) => handleDeleteAsset\('design', id\)\}/.test(workspaceTsx ?? '') &&
      /onDeleteApp=\{\(id\) => handleDeleteAsset\('app', id\)\}/.test(workspaceTsx ?? ''),
  );
  check(
    '删除前有确认框，且把「会被连带删除的配对数」插进提示里',
    /window\.confirm\(/.test(workspaceTsx ?? '') && /\$\{cascaded\}/.test(workspaceTsx ?? ''),
  );
  check(
    '草稿若引用着被删素材会被清空（否则草稿停在指向不存在 id 的引用上，两侧永远凑不齐）',
    (workspaceTsx ?? '').includes('referenced === assetId ? null : current'),
  );

  // 素材删除的**三方对齐**：契约（ipc.ts）↔ preload 桥 ↔ 主进程 handler。
  // 三处在三个目录，漏任何一处都是「点了没反应」或「调用即 reject」，
  // 而它们都不会在 typecheck 里报错（invoke 的通道名是字符串）。
  const assetDeleteChannels: Array<{ method: string; channel: string; kind: string }> = [
    { method: 'deleteDesignAsset', channel: 'verify:design-delete', kind: 'design' },
    { method: 'deleteSnapshot', channel: 'verify:snapshot-delete', kind: 'app' },
  ];
  for (const { method, channel } of assetDeleteChannels) {
    check(
      `素材删除三方对齐：${channel}`,
      new RegExp(`${method}\\s*\\(`).test(ipcTypesTs ?? '') &&
        (preloadTs ?? '').includes(`'${channel}'`) &&
        (verifyIpcTs ?? '').includes(`'${channel}'`),
    );
  }
  check(
    '两个通道都走同一个级联实现（绝不能一侧级联、另一侧只从数组里摘掉）',
    /'verify:design-delete'[\s\S]{0,200}?removeAsset\(input\.requirementId, 'design'/.test(
      verifyIpcTs ?? '',
    ) &&
      /'verify:snapshot-delete'[\s\S]{0,200}?removeAsset\(input\.requirementId, 'app'/.test(
        verifyIpcTs ?? '',
      ),
  );
  check(
    '落盘顺序是「先改索引、再删目录」（反过来会留下指向不存在目录的索引条目）',
    /applyAssetDelete\(requirement, kind, assetId\)[\s\S]{0,600}?rm\(dir, \{ recursive: true, force: true \}\)/.test(
      verifyIpcTs ?? '',
    ),
  );

  // ---- 叠图比对（#30 工具状态 / #33 三种看法） ----
  // 这一段守的是「按钮点了有没有用」：原先「叠图验收」只有高亮变化，
  // 因为工具状态存在 VerifyToolbar 里、画布无从得知。断言分三层：
  // 纯函数行为 → 状态归属 → 布局与绘制的耦合。
  const overlayToolbarTsx = await readRendererFile(
    'src/renderer/src/components/VerifyToolbar.tsx',
  );
  const boardTsx2 = await readRendererFile('src/renderer/src/components/CanvasBoard.tsx');
  const compareTs = await readRendererFile('src/renderer/src/lib/compare.ts');
  check(
    '能读到叠图相关源码（lib/compare / VerifyToolbar / CanvasBoard）',
    compareTs !== null && overlayToolbarTsx !== null && boardTsx2 !== null,
  );

  check(
    '叠图状态归属：VerifyToolbar 不再自持 activeTool（自持就改不动画布）',
    overlayToolbarTsx !== null &&
      !/const\s*\[\s*activeTool\s*,\s*setActiveTool\s*\]/.test(overlayToolbarTsx) &&
      !/useState/.test(overlayToolbarTsx),
  );
  check(
    '叠图状态归属：activeTool 由 CanvasBoard 持有',
    /const\s*\[\s*activeTool\s*,\s*setActiveTool\s*\]\s*=\s*useState/.test(boardTsx2 ?? ''),
  );
  // 存两份必然出现「工具栏显示全页、画布已经叠上」——而这两个方向分别被写坏，
  // 且没有任何东西能把它们对回去。
  check(
    '布局模式从 activeTool 推导，不另存一份（两份迟早不一致）',
    /const\s+mode\s*:\s*VerifyMode\s*=/.test(boardTsx2 ?? '') &&
      !/const\s*\[\s*mode\s*,\s*setMode\s*\]/.test(boardTsx2 ?? ''),
  );
  check(
    '叠图只在两张底图都在时可用（缺图时按钮置灰，而不是点进去看一张图）',
    /canOverlay\s*\(\s*pair\s*\)/.test(boardTsx2 ?? ''),
  );

  // 透明度下限不取 0：拖到底只剩设计稿一张图，界面上却没有任何提示说明截图去了哪儿
  check(
    '透明度下限不取 0（否则「看不到截图了」且没有任何提示）',
    MIN_OVERLAY_OPACITY > 0 && clampOverlayOpacity(0) === MIN_OVERLAY_OPACITY,
    `MIN = ${MIN_OVERLAY_OPACITY} / clamp(0) = ${clampOverlayOpacity(0)}`,
  );
  check(
    '透明度非法值退回默认（不把 NaN 写进 style）',
    clampOverlayOpacity(Number.NaN) > 0 &&
      clampOverlayOpacity(Number.NaN) <= 1 &&
      clampOverlayOpacity(2) === 1,
  );
  // 两端不收成 0/1：手柄贴到帧边缘后要刚好点中那一条才能拖回来
  check(
    '擦拭比例两端留边（手柄贴边后会变得极难点中）',
    clampWipeRatio(-5) === MIN_WIPE_RATIO &&
      clampWipeRatio(9) === MAX_WIPE_RATIO &&
      clampWipeRatio(Number.NaN) === DEFAULT_WIPE_RATIO,
    `${clampWipeRatio(-5)} / ${clampWipeRatio(9)}`,
  );

  // inset 的四值顺序是 top / right / bottom / left。裁掉截图**左边**才能露出底下的设计稿；
  // 写成 `inset(0 X% 0 0)` 会让「手柄往右拖、露出的却是左边」，交互方向反了。
  const wipeAt30 = wipeClipPath(0.3);
  check(
    '擦拭裁掉的是截图左边（左边露设计稿），不是右边',
    /^inset\(0\s+0\s+0\s+30(\.0+)?%\)$/.test(wipeAt30),
    wipeAt30,
  );
  check('擦拭裁边方向守卫：绝不能裁右边（交互会与手柄方向相反）', !/inset\(0\s+[1-9]/.test(wipeAt30));

  // 换算必须跟着 zoom 走 —— 否则放大后分隔线与它应该对齐的帧边界会错开
  check(
    '擦拭换算：世界原点 100 / 宽 200，x = 200 → 0.5',
    wipeRatioFromX({ localX: 200, frameWorldX: 100, frameWorldWidth: 200, zoom: 1 }) === 0.5,
  );
  check(
    '擦拭换算跟着 zoom 走（zoom = 2 时同一世界点落在 x = 400）',
    wipeRatioFromX({ localX: 400, frameWorldX: 100, frameWorldWidth: 200, zoom: 2 }) === 0.5,
  );
  check(
    '擦拭换算越界时夹到边界（不返回 0/1，两者都不可再拖回）',
    wipeRatioFromX({ localX: -999, frameWorldX: 100, frameWorldWidth: 200, zoom: 1 }) ===
      MIN_WIPE_RATIO &&
      wipeRatioFromX({ localX: 9999, frameWorldX: 100, frameWorldWidth: 200, zoom: 1 }) ===
        MAX_WIPE_RATIO,
  );
  check(
    '帧宽不可测时返回 null（不让分隔线跳到 0 位置）',
    wipeRatioFromX({ localX: 200, frameWorldX: 100, frameWorldWidth: 0, zoom: 1 }) === null &&
      wipeRatioFromX({ localX: 200, frameWorldX: 100, frameWorldWidth: 200, zoom: 0 }) === null,
  );
  check(
    '叠图可用性：两张底图都在才算可用',
    canOverlay({ design: { imageUrl: 'a' }, app: { imageUrl: 'b' } }) === true &&
      canOverlay({ design: { imageUrl: 'a' }, app: {} }) === false &&
      canOverlay({ design: {}, app: { imageUrl: 'b' } }) === false,
  );

  // 布局与绘制分属两个组件：`.canvas.overlay` 管位置，FrameRaster 管观感。
  // 只有一边生效就会得到「叠上了但看不出来」或反之。
  const overlayCanvasRule = canvasCss ? cssRuleBody(canvasCss, '.canvas.overlay') : null;
  check('.canvas.overlay 布局规则存在', overlayCanvasRule !== null);
  const overlayAppRule = canvasCss
    ? cssRuleBody(canvasCss, ".canvas.overlay .frame[data-role='app']")
    : null;
  check(
    '叠图把截图帧绝对定位（否则两帧只是并排，谈不上叠）',
    overlayAppRule !== null &&
      /position\s*:\s*absolute/.test(overlayAppRule) &&
      /z-index/.test(overlayAppRule),
  );
  // ⚠️ 隐性耦合：偏移量取自 `.canvas` 的 padding。改了 padding 而没改这里，
  // 截图帧会整体错开几个像素 —— 画面看起来仍像一张正常叠图，只是结论全偏。
  const canvasPadding = parsePaddingPx(canvasCss ? cssRuleBody(canvasCss, '.canvas') : null);
  const appLeft = overlayAppRule?.match(/left\s*:\s*(\d+(?:\.\d+)?)px/)?.[1];
  const appTop = overlayAppRule?.match(/top\s*:\s*(\d+(?:\.\d+)?)px/)?.[1];
  check(
    '⚠️ 叠图偏移量 === .canvas 的内边距（改内边距必须同步改这里，否则整体错位）',
    canvasPadding !== null &&
      Number(appLeft) === canvasPadding.left &&
      Number(appTop) === canvasPadding.top,
    `padding(${canvasPadding?.top},${canvasPadding?.left}) vs offset(${appTop},${appLeft})`,
  );
  check(
    'NodeCanvas 给帧打了来源标记（叠图按来源定位，不靠 nth-child）',
    /data-role=\{source\}/.test(canvasTsx ?? ''),
  );
  const overlayViewportTsx = await readRendererFile(
    'src/renderer/src/components/CanvasViewport.tsx',
  );
  check(
    'CanvasViewport 在叠图时给 .canvas 加类，并把参数透传给 FrameRaster',
    /overlay\s*\?\s*'\s*overlay'\s*:\s*''/.test(overlayViewportTsx ?? '') &&
      /overlay=\{overlay\}/.test(overlayViewportTsx ?? ''),
  );

  // 三种看法必须在绘制层真的分叉，否则「切换比对方式」又是三个改高亮的死按钮
  check(
    '差值模式使用 mix-blend-mode: difference（相同处趋黑、差异处发亮）',
    /mixBlendMode\s*:\s*'difference'/.test(rasterTsx ?? ''),
  );
  check(
    '擦拭模式在绘制层裁边（不是只在工具栏改数字）',
    /clipPath\s*:\s*wipeClipPath\(/.test(rasterTsx ?? ''),
  );
  check(
    '叠图样式只作用于截图帧（设计稿是基准，反过来每次都要做逆变换）',
    /box\.source\s*===\s*'app'\s*\?\s*appOverlayStyle/.test(rasterTsx ?? ''),
  );
  // .raster-layer 整层 pointer-events: none，分隔线必须自己开 auto，
  // 否则「线画得出来却拖不动」，且没有任何报错
  const wipeRule = canvasCss ? cssRuleBody(canvasCss, '.raster-wipe') : null;
  check('.raster-wipe 规则存在', wipeRule !== null);
  check(
    '⚠️ 分隔线自己开 pointer-events: auto（父层是 none，不开就拖不动且不报错）',
    wipeRule !== null && /pointer-events\s*:\s*auto/.test(wipeRule),
  );
  check(
    '分隔线恒 1px（加宽命中带交给 ::before，不靠调粗线宽）',
    wipeRule !== null && /width\s*:\s*1px/.test(wipeRule),
  );
  // ⚠️ 这条守的是一个真实踩过的坑：覆盖规则若排在基础规则之前，
  // `cssRuleBody` 取到的是覆盖规则，于是上面「帧盒背景透明」这类基础断言全部误报 ——
  // 断言没错，是 CSS 的顺序错了。修法不是放宽断言，而是把覆盖规则放后面。
  check(
    '⚠️ 叠图覆盖规则排在 .frame-stage 基础规则之后（否则会顶掉基础断言）',
    (canvasCss ?? '').indexOf(".canvas.overlay .frame[data-role='app'] .frame-stage") >
      (canvasCss ?? '').indexOf('.frame-stage {'),
  );
  // .node-overlay 显式写了 pointer-events: auto，祖先设 none 拦不住它 ——
  // 只写 .frame 会因为「子元素自己开了 auto」而完全失效，且没有任何报错。
  check(
    '⚠️ 叠图关闭截图侧命中时连 .node-overlay 一起关（祖先 none 拦不住显式 auto）',
    /\.canvas\.overlay \.frame\[data-role='app'\] \.node-overlay/.test(canvasCss ?? ''),
  );
  check(
    '叠图关闭截图侧命中（避免「上半区选 App / 下半区选设计稿」的不一致点击分区）',
    /\.canvas\.overlay \.frame\[data-role='app'\][^{]*\{[^}]*pointer-events\s*:\s*none/.test(
      canvasCss ?? '',
    ),
  );

  const sampleZip = await resolveSampleZip();
  // 样本是导入管线的核心被测对象，缺了就没法验证——直接跳过，不要伪装成失败
  if (!(await exists(SAMPLE_DIR)) || sampleZip === null) {
    skipped = true;
    console.log('\nSKIPPED  缺少真实 Figma 导出样本，导入管线未验证。');
    console.log(`  期望文件夹：${SAMPLE_DIR}`);
    console.log(`  期望 zip  ：${sampleZip ?? `${SAMPLE_ZIP_DIR} 下没有 .zip`}`);
    console.log('  用 SM_SAMPLE_DIR / SM_SAMPLE_ZIP 覆盖，或从插件重新导出一份。');
    return;
  }

  section('1. workspace 初始化 + 需求 CRUD');
  await initWorkspace();
  const requirement = await createRequirement({ name: '冒烟测试 · 盲盒抽奖' });
  check('创建需求', !!requirement.id);
  check('需求初始为空', requirement.designAssets.length === 0 && requirement.pairs.length === 0);

  section('2. 导入管线 · 文件夹（真实样本 310 节点）');
  const folderResult = await importFigmaPackage(requirement.id, SAMPLE_DIR, 'skip');
  check('无致命错误', !folderResult.fatal, folderResult.fatal ?? '');
  check('导入 1 帧', folderResult.frames.length === 1);
  const folderFrame = folderResult.frames[0];
  check('状态为 imported', folderFrame?.status === 'imported');
  check('节点数 310', folderFrame?.nodeCount === 310, `实际 ${folderFrame?.nodeCount}`);
  check('逻辑尺寸 375×867', folderFrame?.width === 375 && folderFrame?.height === 867);
  check('识别为帧级导出', folderFrame?.isFrameLevel === true);

  section('3. 冲突策略 · 同包重复导入');
  const skipAgain = await importFigmaPackage(requirement.id, SAMPLE_DIR, 'skip');
  check('skip 策略下被跳过', skipAgain.frames[0]?.status === 'skipped');
  const afterSkip = await getRequirement(requirement.id);
  check('资产数仍为 1', afterSkip?.designAssets.length === 1, `实际 ${afterSkip?.designAssets.length}`);

  const replaceAgain = await importFigmaPackage(requirement.id, SAMPLE_DIR, 'replace');
  check('replace 策略下被覆盖', replaceAgain.frames[0]?.status === 'replaced');
  const afterReplace = await getRequirement(requirement.id);
  check('覆盖后资产数仍为 1（未产生碎片）', afterReplace?.designAssets.length === 1);
  check(
    '覆盖后 assetId 复用',
    afterReplace?.designAssets[0]?.id === afterSkip?.designAssets[0]?.id,
  );

  section('4. 导入管线 · zip（含中文文件名）');
  const zipResult = await importFigmaPackage(requirement.id, sampleZip, 'skip');
  check('无致命错误', !zipResult.fatal, zipResult.fatal ?? '');
  check('导入 1 帧', zipResult.frames.length === 1);
  check('中文帧名可读', zipResult.frames[0]?.name === '首页', `实际 ${zipResult.frames[0]?.name}`);

  section('5. 坏包必须整包拒绝且不落盘');
  const badDir = path.join(sandbox, 'bad-package');
  await mkdir(badDir, { recursive: true });
  await writeFile(path.join(badDir, 'manifest.json'), JSON.stringify({ schemaVersion: '9.9.9', frames: [] }));
  const before = (await getRequirement(requirement.id))?.designAssets.length ?? 0;
  const badResult = await importFigmaPackage(requirement.id, badDir, 'skip');
  check('返回致命错误', !!badResult.fatal, badResult.fatal ?? '');
  check('未写入任何帧', badResult.frames.length === 0);
  check('资产数未变', ((await getRequirement(requirement.id))?.designAssets.length ?? 0) === before);

  const missing = await importFigmaPackage(requirement.id, path.join(sandbox, '不存在'), 'skip');
  check('路径不存在时报错而非崩溃', !!missing.fatal);

  section('6. 配对写入语义（建立 / 复用 / 替换）与视图组装');
  const current = await getRequirement(requirement.id);
  const designAsset = current!.designAssets[0]!;

  // 伪造一份 App 快照（绕过 adb，仅验证落盘 + 组装链路）
  const snapshotId = 'smoke-snapshot';
  const snapshotDir = appSnapshotDir(requirement.id, snapshotId);
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(path.join(snapshotDir, 'screenshot.png'), TINY_PNG);
  await writeFile(path.join(snapshotDir, 'thumb.png'), TINY_PNG);
  await writeFile(
    path.join(snapshotDir, 'nodes.json'),
    JSON.stringify([
      {
        nodeId: 'uia:0',
        parentId: null,
        className: 'android.widget.FrameLayout',
        depth: 0,
        index: 0,
        x: 0,
        y: 0,
        width: 375,
        height: 867,
        visibleX: 0,
        visibleY: 0,
        visibleWidth: 375,
        visibleHeight: 867,
        scrollX: 0,
        scrollY: 0,
        visible: true,
        enabled: true,
        clickable: false,
        alpha: 1,
        z: 0,
        elevation: 0,
        clipsToBounds: true,
        isImage: false,
        isSvg: false,
        isGradient: false,
        hasVisualContent: false,
        resourceName: null,
        contentDescription: null,
        text: null,
      },
    ]),
  );

  await mutateRequirement(requirement.id, (target) => {
    target.appSnapshots.push({
      id: snapshotId,
      requirementId: requirement.id,
      platform: 'android',
      label: '活动进行中',
      width: 375,
      height: 867,
      pixelWidth: 1080,
      pixelHeight: 2400,
      densityDpi: 480,
      nodesFile: 'nodes.json',
      screenshotFile: 'screenshot.png',
      thumbnailFile: 'thumb.png',
      nodeCount: 1,
      textSamples: [],
      source: 'uiautomator',
      capturedAt: new Date().toISOString(),
    });
    target.pairs.push({
      id: 'smoke-pair',
      requirementId: requirement.id,
      designAssetId: designAsset.id,
      appSnapshotId: snapshotId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  });

  const views = await buildPairViews((await getRequirement(requirement.id))!);
  check('产出 1 个配对视图', views.length === 1);
  const view = views[0]!;
  check('设计稿节点已从 schema 拍平', view.design.nodes.length === 310, `实际 ${view.design.nodes.length}`);
  check(
    '拍平后补上了 parentId',
    view.design.nodes.some((node) => node.parentId !== null),
  );

  // 后面两段（图层顺序 / 命中面）都吃这棵渲染树，先在这里建一次，避免各建一棵而分叉。
  const designRender = view.design.nodes.map((node) => toRenderNode(node, 'design'));
  const renderTree = buildNodeTree(designRender);
  const renderById = new Map(designRender.map((node) => [node.id, node]));

  // ---- 图层顺序：面板自上而下 ≡ 导出数组原序（≡ DOM 叠放自下而上）----
  //
  // 用户两次提问顺序：第一次怀疑「顺序被翻过会不会让画布 DOM 画反 / hover 不一致」
  // （答案是不会）；第二次拿着 Figma 面板的截图报「图层列表还是反的」—— 这次是真翻过。
  //
  // 事实（数组语义两端都有官方口径；**面板语义由用户截图钉死**，不再靠文档转述）：
  //  · Figma 插件 API：`children` 是 **back-to-front**，原话 "the first child in the array is
  //    the bottommost layer on the screen, and the last child in the array is the topmost layer"。
  //    插件导出端（`figma-plugin/src/plugin/serialize.ts`）**正序**遍历、原样落盘，所以
  //    schema 数组同样是 0 = 最底层。真实样本也能自证：卡片类容器的 index 0 恒为与父同尺寸的
  //    背景板（有可见填充），文字都在它之内 —— 若 0 是最上层，那些文字会被整块盖住。
  //  · **Figma 的 Layers 面板就是按数组原序排的**：index 0 在面板最上面。用户的截图
  //    （Group 1000005869）里，与父同尺寸的背景板 Rectangle 34626661 排在面板第一行 ——
  //    它在画布上必然是最底层（否则会盖住文字），所以「面板顶部 = 最底层」，不是最上层。
  //    此前按帮助中心那句 "top of the layers panel appear above…" 推出「面板 = 数组逆序」，
  //    据此给 `flattenVisibleTree` 加了逆序 —— 那是误读，已改回正序。
  //
  // 所以正确的不变量是：**同一组兄弟，面板自上而下 ≡ 导出数组原序 ≡ DOM 叠放自下而上**，
  // 而且逐层如此 —— 子树仍紧跟其父，不是整棵树全局翻转。面板与 DOM 用的是同一份顺序：
  // 面板第一行是背景板，画布最先画的也是背景板；谁要是给任何一边「顺手」加个 reverse，
  // 这里立刻红。
  const ROOT_GROUP_KEY = '\u0000root';
  const panelRows = flattenVisibleTree(renderTree, () => false);
  const panelChildren = new Map<string, string[]>();
  const shapeProblems: string[] = [];
  const openRows: Array<{ id: string; depth: number }> = [];
  for (const row of panelRows) {
    while (openRows.length > 0 && openRows[openRows.length - 1]!.depth >= row.depth) {
      openRows.pop();
    }
    const parentId = openRows.length > 0 ? openRows[openRows.length - 1]!.id : null;
    if (parentId === null && row.depth !== 0) {
      shapeProblems.push(`${row.node.id} 深度 ${row.depth} 却出现在根层级`);
    }
    if (parentId !== null && renderById.get(row.node.id)?.parentId !== parentId) {
      shapeProblems.push(`${row.node.id} 的面板父级 ${parentId} ≠ 它的 parentId`);
    }
    const key = parentId ?? ROOT_GROUP_KEY;
    const bucket = panelChildren.get(key);
    if (bucket) bucket.push(row.node.id);
    else panelChildren.set(key, [row.node.id]);
    openRows.push({ id: row.node.id, depth: row.depth });
  }

  let groupMismatch: string | null = null;
  for (const [parentId, kids] of renderTree.childrenOf) {
    const got = panelChildren.get(parentId ?? ROOT_GROUP_KEY) ?? [];
    const want = kids.map((node) => node.id);
    if (got.join(',') !== want.join(',')) {
      groupMismatch = `${parentId ?? '<帧根>'} 下：面板 [${got.slice(0, 4).join(',')}…] ≠ 数组原序 [${want.slice(0, 4).join(',')}…]`;
      break;
    }
  }
  const rootGroup = renderTree.childrenOf.get(null) ?? [];
  const rootPanelFirst = rootGroup[0]?.id ?? '(空)';
  check(
    '⭐ 每一组兄弟：面板自上而下 ≡ 导出数组原序（逐层如此，子树仍紧跟其父 —— 面板与画布共用同一份顺序，谁都不许翻）',
    shapeProblems.length === 0 &&
      groupMismatch === null &&
      panelChildren.size === renderTree.childrenOf.size &&
      panelRows.length === designRender.length,
    groupMismatch ??
      shapeProblems[0] ??
      `比对 ${renderTree.childrenOf.size} 组兄弟 / ${panelRows.length} 行；根层级面板首行 = 数组首项 = ${rootPanelFirst}（最先画 = 最靠下 = 背景板）`,
  );
  check(
    '⭐ 画布按导出数组顺序渲染（`children.map` 正序 append），不 reverse、不 sort —— 叠放顺序就是数组顺序',
    /children\.map\(/.test(nodeCanvasTsx ?? '') &&
      !/children[^;]{0,80}\.reverse\(/.test(nodeCanvasTsx ?? '') &&
      !/children[^;]{0,80}\.sort\(/.test(nodeCanvasTsx ?? ''),
  );
  check(
    '选中判定不读 DOM / 叠放顺序：lib/selection 里不出现 childrenOf（层级链只走 parentId）—— 顺序真被翻了也不会「hover 与 click 不一致」',
    selectionTs !== null && !/childrenOf/.test(selectionTs),
  );

  // ---- 真实数据的命中面：到底能点到谁 ----
  //
  // 这一段把「为什么有些元素点不中 / 现在哪些能点到了」量出来，而不只是讲道理。
  // 按浏览器的命中规则逐点模拟（下面 hitAt 的注释列出了四条规则），两条结论都在这儿被守住：
  //   · 被子树盖住的那部分只能点到后代 —— **最外层 Frame 只剩很小一块像素**（旧闸门 ~6%）；
  //   · **无填充的容器（样本里 49 个：24 GROUP / 23 FRAME / 2 INSTANCE）如今能被直接点到**。
  //     它们原先是 `pointer-events: none`，在整个采样里一次都命不中 —— 在画布上等于不存在。
  //     这正是用户第四次报告的由来（「无填充的 frame 元素也要能 hover 和点击选中」）。
  //
  // 结论不是「换个模型」：换成 Figma 的「当前上下文层」，单击就永远落在帧根上，用户照样
  // 报「选不中」（第二次报告）。不依赖命中的那条通道（原地再点 + hover 同源）继续保留，
  // 它管的是另一半 —— **被后代完全盖住**的那部分。
  /**
   * 单个像素上「会点到谁」。规则与浏览器一致：
   *  1. 元素的盒必须含该点（绝对定位的节点盒 = rect）；
   *  2. 兄弟**后画的先算**（导出数组是 back-to-front，DOM 顺序即叠放顺序）；
   *  3. 祖先开了 clipsContent（overflow: hidden）→ 超出的部分既不显示也点不中；
   *  4. `hittable === false`（pointer-events: none）只让**该元素自己**退出命中，
   *     子树该命中还命中 —— 所以不能整棵跳过，必须继续往里找。
   *
   * ⚠️ 第 4 条在 2026-09-16 换了闸门（`hasFill` → `node.hittable`：无填充的容器也参与）。
   * 这里**直接读同一个字段**，模拟与组件因此不会分叉；`allow` 参数只为把旧闸门当成对照
   * 基线（量「这次改动改变了多少像素的归属」），没有第二条规则实现。
   */
  const hitAt = (
    node: RenderNode,
    px: number,
    py: number,
    clip: readonly [number, number, number, number],
    allow: (target: RenderNode) => boolean,
  ): RenderNode | null => {
    const { x, y, width, height } = node.rect;
    if (px < x || py < y || px >= x + width || py >= y + height) return null;

    const inner: readonly [number, number, number, number] = node.clipsContent
      ? [
          Math.max(clip[0], x),
          Math.max(clip[1], y),
          Math.min(clip[2], x + width),
          Math.min(clip[3], y + height),
        ]
      : clip;

    const children = renderTree.childrenOf.get(node.id) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const hit = hitAt(children[i]!, px, py, inner, allow);
      if (hit) return hit;
    }
    if (px < clip[0] || py < clip[1] || px >= clip[2] || py >= clip[3]) return null;
    return allow(node) ? node : null;
  };

  const frameRoot = renderTree.roots[0]!;
  const frameBox: readonly [number, number, number, number] = [
    0,
    0,
    view.design.width,
    view.design.height,
  ];
  const bump = (map: Map<string, number>, id: string): void => {
    map.set(id, (map.get(id) ?? 0) + 1);
  };
  /** 每个节点在采样里「独占」多少点（新闸门 / 旧闸门各一份，后者只作对照） */
  const ownerCount = new Map<string, number>();
  const legacyCount = new Map<string, number>();
  let sampled = 0;
  for (let py = 0; py < view.design.height; py += 3) {
    for (let px = 0; px < view.design.width; px += 3) {
      sampled += 1;
      const hit = hitAt(frameRoot, px, py, frameBox, (node) => node.hittable);
      if (hit) bump(ownerCount, hit.id);
      const legacy = hitAt(frameRoot, px, py, frameBox, (node) => node.hasFill && node.visible);
      if (legacy) bump(legacyCount, legacy.id);
    }
  }
  const rootShare = (ownerCount.get(frameRoot.id) ?? 0) / sampled;
  const legacyRootShare = (legacyCount.get(frameRoot.id) ?? 0) / sampled;
  check(
    '⭐ 真实样本 · 旧闸门基线：只看 hasFill 时最外层 Frame 独占一大片点（父盒画在子盒下面，其余全被后代占着）',
    legacyRootShare > 0 && legacyRootShare < 0.2,
    `旧闸门可点占比 ${(legacyRootShare * 100).toFixed(1)}%（采样 ${sampled} 点）`,
  );
  check(
    '⭐ 真实样本：改成按盒命中后，最外层 Frame 独占的像素**变少** —— 原本被它吞掉的点落到了更精确的那一层',
    rootShare < legacyRootShare,
    `旧 ${(legacyRootShare * 100).toFixed(1)}% → 新 ${(rootShare * 100).toFixed(1)}%`,
  );
  const noFillOwners = [...ownerCount.entries()]
    .filter(([id]) => renderById.get(id)?.hasFill === false)
    .map(([id, count]) => ({ node: renderById.get(id)!, count }))
    .sort((a, b) => b.count - a.count);
  check(
    '⭐ 真实样本：**无填充容器现在能被直接命中**（原先是 pointer-events: none，一次都中不了；改回 hasFill 立即 FAIL）',
    noFillOwners.length > 0 && noFillOwners.every((entry) => entry.node.hittable),
    `${noFillOwners.length} 个无填充容器拿到命中，共 ${noFillOwners.reduce(
      (sum, entry) => sum + entry.count,
      0,
    )} 点；拿到最多的是「${noFillOwners[0]?.node.label ?? '-'}」(${noFillOwners[0]?.count ?? 0} 点)`,
  );
  // 拿到命中的无填充节点**必须全是容器**：图形类（RECTANGLE / VECTOR / …）零像素时盒只是
  // 包围盒，放进来会让「盒内空白」变成隐形靶子（用户点哪儿都点不到真元素）。
  const GRAPHIC_TYPES = new Set([
    'RECTANGLE',
    'VECTOR',
    'ELLIPSE',
    'LINE',
    'BOOLEAN_OPERATION',
    'STAR',
    'POLYGON',
  ]);
  const graphicOwners = noFillOwners.filter((entry) =>
    GRAPHIC_TYPES.has(String(entry.node.detail?.type)),
  );
  check(
    '⭐ 拿到命中的无填充节点**全是容器**（图形类零像素不参与，否则盒内空白会变成「看不见的靶子」）',
    graphicOwners.length === 0,
    graphicOwners.map((entry) => `${entry.node.label}(${entry.node.detail?.type})`).join(' / ') ||
      '无',
  );
  // 另一半：**填充被显式隐藏**的图层（画面上一片空白）一次都不许被命中 —— 这是上一条的
  // 量化守卫。样本里这类有 8 个（3 RECTANGLE / 3 FRAME / 2 INSTANCE），其中 FRAME / INSTANCE
  // 确实是「容器」，照样不许进 —— 在用户那份「个人中心优化」样本上，放它们进来会抢走 522 点。
  const hiddenFillNodes = designRender.filter(
    (node) => node.hasFill === false && (node.detail?.fills?.length ?? 0) > 0,
  );
  const hiddenFillHits = hiddenFillNodes.filter((node) => (ownerCount.get(node.id) ?? 0) > 0);
  check(
    '⭐ 真实样本：**填充被显式隐藏**的图层一次都没被命中（隐形靶子全被挡在门外，哪怕它是 Frame / Instance）',
    hiddenFillNodes.length > 0 && hiddenFillHits.length === 0,
    `隐藏填充图层 ${hiddenFillNodes.length} 个，被命中 ${hiddenFillHits.length} 个`,
  );
  check(
    '⭐ 真实样本：310 个节点沿 parentId 都能走到最外层（往上爬的通道对全帧成立，没有孤儿）',
    designRender.every((node) => {
      const chain = ancestorChain(renderById, node.id);
      return chain[chain.length - 1] === frameRoot.id;
    }),
  );
  {
    // 端到端 1：**一击命中**最深，之后每次「原地再点」上移一层，直到最外层容器。
    // 这是「点哪选哪」最该保证的两件事 —— 想选深的不用往下钻，想选浅的不用瞄准。
    const deepest = designRender
      .map((node) => ancestorChain(renderById, node.id))
      .sort((a, b) => b.length - a.length)[0]!;
    const clickOnce = (
      chain: readonly string[],
      selectedId: string | null,
      prev: ClickCycle | null,
      outermost = false,
    ) => planCanvasClick({ chain, selectedId, point: at(200, 400), prev, outermost });

    const first = clickOnce(deepest, null, null);
    check(
      '⭐ 一击命中：链长 ' +
        deepest.length +
        ' 的最深节点，**单击一次**就选中（上一版要点 ' +
        deepest.length +
        ' 次逐级「进入」才够得到）',
      first?.selectedId === deepest[0],
      String(first?.selectedId),
    );

    // 逐级上移：每一击的选中项都往上一层，直到最外层容器
    let cycle = first;
    const climbed: string[] = [cycle!.selectedId];
    for (let step = 1; step < deepest.length; step += 1) {
      cycle = clickOnce(deepest, cycle!.selectedId, cycle!.cycle);
      climbed.push(cycle!.selectedId);
    }
    check(
      '⭐ 逐级「原地再点」一路**上移**到最外层容器（' + climbed.join(' › ') + '）',
      cycle?.selectedId === deepest[deepest.length - 1],
      String(cycle?.selectedId),
    );
    check(
      '⭐ 上移的每一击都恰好是链上的下一层（不跳层、不重复）',
      climbed.join(',') === [...deepest].join(','),
      climbed.join(','),
    );
    check(
      '⭐ ⌘/Ctrl 一击跳到最外层容器（不必点 ' + deepest.length + ' 次）',
      clickOnce(deepest, null, null, true)?.selectedId === deepest[deepest.length - 1],
      String(clickOnce(deepest, null, null, true)?.selectedId),
    );

    // 端到端 3：hover 与单击逐击同源。
    // 用户第三次报的是 hover（「13531 / 13533 / 13532 无法通过 hover 选中，只能选到子节点
    // 13534 / 13535」）—— 用数据回答它：链上**每一层**都先被 hover 预告过。
    check(
      '⭐ 真实样本：hover 与单击逐击同源 —— 上移的每一层都先被 hover 预告过，走一圈刚好回到起点',
      (() => {
        const seen: string[] = [];
        let sel: string | null = null;
        let cyc: ClickCycle | null = null;
        for (let step = 0; step <= deepest.length; step += 1) {
          seen.push(
            planCanvasHover({
              chain: deepest,
              selectedId: sel,
              point: at(200, 400),
              prev: cyc,
              outermost: false,
            }) ?? '-',
          );
          const next: ClickOutcome | null = clickOnce(deepest, sel, cyc);
          if (!next) break;
          sel = next.selectedId;
          cyc = next.cycle;
        }
        return (
          seen.length === deepest.length + 1 &&
          seen.every((id) => deepest.includes(id)) &&
          seen.join(',') === [...deepest, deepest[0]].join(',')
        );
      })(),
      '链长 ' + deepest.length,
    );

    // 用户报的「hover 不到、只能 hover 到子节点」的那类图层 = **无填充容器**。
    // 本轮之前它们有两条路都不通：进不了原始命中（pointer-events: none），hover 又只认
    // 原始命中。现在两条都通了 —— 一条是上面那条守卫（自己就有命中区），另一条就是这里：
    // **被后代完全盖住时，「原地再点」爬上去，环照样跟着到它**。
    const noFillDeep = designRender.filter(
      (node) => !node.hasFill && ancestorChain(renderById, node.id).length >= 3,
    );
    check(
      '⭐ 真实样本：无填充容器**能 hover 到** —— 被后代盖住时，只要「原地再点」爬到它下面那一层，环就跟着上来',
      noFillDeep.length > 0 &&
        noFillDeep.every((node) => {
          const chain = ancestorChain(renderById, node.id);
          const index = chain.indexOf(node.id);
          if (index <= 0) return true; // 它自己就是命中点，谈不上「爬上去」
          return (
            planCanvasHover({
              chain,
              selectedId: chain[index - 1]!,
              point: at(200, 400),
              prev: { hitId: chain[0]!, selectedId: chain[index - 1]!, x: 200, y: 400 },
              outermost: false,
            }) === node.id
          );
        }),
      `无填充容器 ${noFillDeep.length} 个`,
    );

    // 端到端 2：拿用户点名的那个 Union 走一遍完整链路。
    // 用户先后报了四次「某些节点 hover 和点击都选不中」：Union、帧根、「只能 hover 到
    // 子节点」、以及本轮的无填充 Frame。用数据回答它：它 hasFill 是 true（**不是**
    // 「无填充」问题），位置在链长 7 的深处 —— 靠「一击命中 + 原地再点上移」这条通道够得到。
    const union = designRender.find((node) => node.label === 'Union');
    check('⭐ 真实样本：能定位到用户点名的那个 Union 节点', !!union, union?.label ?? '未找到');
    if (union) {
      const unionChain = ancestorChain(renderById, union.id);
      check(
        '⭐ 该 Union 的 hasFill 是 true —— 它点不到**不是**「无填充」问题，是方向问题（别归因到 pointer-events）',
        union.hasFill === true,
        `hasFill = ${String(union.hasFill)}`,
      );
      check(
        '⭐ 该 Union 是布尔运算节点（BOOLEAN_OPERATION）',
        union.detail?.type === 'BOOLEAN_OPERATION',
        `类型 ${union.detail?.type ?? '-'}`,
      );
      check(
        '⭐ 该 Union 在链长 ' +
          unionChain.length +
          ' 的深处：现在**一击就能选中它**（上一版这里要一路「进入」' +
          unionChain.length +
          ' 次）',
        unionChain.length >= 6 && clickOnce(unionChain, null, null)?.selectedId === union.id,
        `深度 ${unionChain.length} / ${unionChain
          .map((id) => renderById.get(id)?.label ?? id)
          .join(' › ')}`,
      );
    }
  }
  check('设计稿尺寸为逻辑尺寸（非 2x 位图尺寸）', view.design.width === 375 && view.design.height === 867);
  check(
    '设计稿图片走 sm-asset 协议',
    view.design.imageUrl?.startsWith('sm-asset://asset/') === true,
    view.design.imageUrl ?? '',
  );
  check('App 节点已加载', view.app.nodes.length === 1);

  // ---- 配对写入语义：替换 ≠ 新建 ----
  // UI 上「换掉一侧」看起来永远是对的，但若走成「按组合新建」，
  // 结果会是列表悄悄多出一项而旧的那项还在 —— 只能在这里按住。
  const secondDesign = current!.designAssets[1];
  check('有第二份设计稿可用于替换', !!secondDesign, `设计稿数 ${current!.designAssets.length}`);

  const secondSnapshotId = 'smoke-snapshot-2';
  await mutateRequirement(requirement.id, (target) => {
    target.appSnapshots.push({
      id: secondSnapshotId,
      requirementId: requirement.id,
      platform: 'android',
      label: '抽奖结果',
      width: 390,
      height: 844,
      pixelWidth: 1080,
      pixelHeight: 2340,
      densityDpi: 480,
      nodesFile: 'nodes.json',
      screenshotFile: 'screenshot.png',
      thumbnailFile: 'thumb.png',
      nodeCount: 1,
      textSamples: [],
      source: 'uiautomator',
      capturedAt: new Date().toISOString(),
    });
  });

  // 先把配对标成「已验收」，才能验证替换会把它拉回待验收
  await mutateRequirement(requirement.id, (target) => {
    const pair = target.pairs.find((item) => item.id === 'smoke-pair');
    if (pair) pair.status = 'verified';
  });

  const replaced = await mutateRequirement(requirement.id, (target) =>
    applyPairSave(target, {
      requirementId: requirement.id,
      pairId: 'smoke-pair',
      designAssetId: secondDesign!.id,
      appSnapshotId: secondSnapshotId,
    }),
  );
  check('替换后仍是同一个配对（id 不变）', replaced.id === 'smoke-pair');
  check('替换后设计稿已换', replaced.designAssetId === secondDesign!.id);
  check('替换后截图已换', replaced.appSnapshotId === secondSnapshotId);
  check('替换后状态回到待验收', replaced.status === 'pending');

  const afterPairReplace = await getRequirement(requirement.id);
  check(
    '替换不会多出配对（总数仍为 1）',
    afterPairReplace?.pairs.length === 1,
    `实际 ${afterPairReplace?.pairs.length}`,
  );

  // 对照一：不带 pairId 的同组合 → 复用已有配对，不新建
  const reused = await mutateRequirement(requirement.id, (target) =>
    applyPairSave(target, {
      requirementId: requirement.id,
      designAssetId: secondDesign!.id,
      appSnapshotId: secondSnapshotId,
    }),
  );
  check('同组合重复保存复用已有配对', reused.id === 'smoke-pair');

  // 对照二：不带 pairId 的新组合 → 新建（这是「建立配对」的正常路径）
  const createdPair = await mutateRequirement(requirement.id, (target) =>
    applyPairSave(target, {
      requirementId: requirement.id,
      designAssetId: designAsset.id,
      appSnapshotId: secondSnapshotId,
      matchScore: 0.42,
    }),
  );
  check('新组合不带 pairId 时新建配对', createdPair.id !== 'smoke-pair');
  check('新建配对带上推荐分', createdPair.matchScore === 0.42);
  check(
    '新建后配对总数为 2',
    (await getRequirement(requirement.id))?.pairs.length === 2,
    `实际 ${(await getRequirement(requirement.id))?.pairs.length}`,
  );

  section('7. sm-asset 协议解析与穿越防护');
  const validUrl = `sm-asset://asset/${requirement.id}/design/${designAsset.id}/screenshot.png`;
  const resolved = resolveAssetRequest(validUrl);
  check('合法 URL 解析成功', resolved !== null);
  check('解析出的路径落在 workspace 内', resolved?.absolutePath.includes('/workspace/') === true);
  check('content-type 正确', resolved?.contentType === 'image/png');

  check('拒绝上跳路径', resolveAssetRequest('sm-asset://asset/../../etc/design/x/screenshot.png') === null);
  check(
    '拒绝编码后的上跳',
    resolveAssetRequest(`sm-asset://asset/${encodeURIComponent('../../etc')}/design/x/screenshot.png`) === null,
  );
  check('拒绝不可执行的后缀', resolveAssetRequest(`sm-asset://asset/a/design/b/evil.sh`) === null);
  check('拒绝未知 host', resolveAssetRequest(`sm-asset://evil/a/design/b/screenshot.png`) === null);
  check('拒绝段数不符', resolveAssetRequest(`sm-asset://asset/a/design/screenshot.png`) === null);

  section('8. R4 按宽对齐（纯函数）');
  const aligned = widthAlignScale(375, 390);
  check('缩放系数 = 设计宽/截图宽', Math.abs(aligned - 375 / 390) < 1e-9, `实际 ${aligned}`);
  check('对齐后两帧等宽', Math.abs(390 * aligned - 375) < 1e-9, `实际 ${390 * aligned}`);
  check('纵向残差落在底部（≈55pt）', Math.abs(867 - 844 * aligned - 55.42) < 0.5);
  check('同宽时不缩放', widthAlignScale(375, 375) === 1);
  check('截图宽为 0 时回退 1（不除零）', widthAlignScale(375, 0) === 1);
  check('设计宽为 0 时回退 1', widthAlignScale(0, 390) === 1);
  check('NaN 时回退 1', widthAlignScale(Number.NaN, 390) === 1);
  check('负数时回退 1', widthAlignScale(375, -390) === 1);

  section('9. 采集侧纯函数（uiautomator → AppNode · 尺寸权威 · dp 取整）');
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" text="" resource-id="" bounds="[0,0][1080,2400]" clickable="false" enabled="true">
    <node index="0" class="android.widget.TextView" text="活动进行中 &amp; 抽奖" resource-id="com.demo:id/title" bounds="[60,300][900,420]" clickable="true" enabled="true" displayed="true"/>
    <node index="1" class="android.widget.ImageView" content-desc="奖品图片" bounds="[60,480][1020,1200]" clickable="false" enabled="true"/>
  </node>
</hierarchy>`;

  const dpi = 480;
  const nodes = parseUiAutomatorXml(xml, 160 / dpi);
  check('解析出 3 个节点', nodes.length === 3, `实际 ${nodes.length}`);
  check('parentId 层级正确', nodes[1]?.parentId === nodes[0]?.nodeId);
  check('depth 正确', nodes[0]?.depth === 0 && nodes[1]?.depth === 1);
  check('bounds 换算为 dp（1080px @480dpi → 360dp）', nodes[0]?.width === 360, `实际 ${nodes[0]?.width}`);
  check('高度换算正确（2400px → 800dp）', nodes[0]?.height === 800, `实际 ${nodes[0]?.height}`);
  check('文本实体已反转义', nodes[1]?.text === '活动进行中 & 抽奖', `实际 ${nodes[1]?.text}`);
  check('resource-id → resourceName', nodes[1]?.resourceName === 'com.demo:id/title');
  check('content-desc → contentDescription', nodes[2]?.contentDescription === '奖品图片');
  check('ImageView 识别为图片', nodes[2]?.isImage === true);
  check('clickable 解析正确', nodes[1]?.clickable === true && nodes[2]?.clickable === false);

  // ---- 9.2 PNG 真实尺寸 > wm size ----
  // 截图是后续叠图/裁切/取色的底图，帧盒与节点必须跟它走。
  check(
    '真实 PNG 读出 1×1',
    parsePngSize(TINY_PNG)?.width === 1 && parsePngSize(TINY_PNG)?.height === 1,
    `实际 ${JSON.stringify(parsePngSize(TINY_PNG))}`,
  );
  check(
    '解析 1080×2400 的 IHDR',
    parsePngSize(pngHeader(1080, 2400))?.height === 2400,
    `实际 ${parsePngSize(pngHeader(1080, 2400))?.height}`,
  );
  check('非 PNG 字节返回 null', parsePngSize(Buffer.from('this is not a png file at all')) === null);
  check('截断字节返回 null（<24B）', parsePngSize(TINY_PNG.subarray(0, 12)) === null);
  const idatFirst = pngHeader(1080, 2400);
  idatFirst.set([0x49, 0x44, 0x41, 0x54], 12);
  check('首个数据块不是 IHDR 返回 null', parsePngSize(idatFirst) === null);

  // ---- 9.3 wm size / wm density 必须同源（都优先 Override）----
  // screencap 与 uiautomator 都取 SurfaceFlinger 当前的 display，
  // 设备开了 `wm size` 覆盖时二者输出 Override 尺寸；size 若在此取 Physical，帧盒就与底图分叉。
  const wmSizeOut = 'Physical size: 1440x3120\nOverride size: 1080x1920';
  const wmDensityOut = 'Physical density: 560\nOverride density: 480';
  check('parseWmSize 优先 Override', parseWmSize(wmSizeOut)?.width === 1080, `实际 ${parseWmSize(wmSizeOut)?.width}`);
  check('parseDensity 优先 Override', parseDensity(wmDensityOut) === 480, `实际 ${parseDensity(wmDensityOut)}`);
  check(
    'size 与 density 同源（同一份输出里都取 Override）',
    parseWmSize(wmSizeOut)?.width === 1080 && parseDensity(wmDensityOut) === 480,
  );
  check('无 Override 时 size 回退 Physical', parseWmSize('Physical size: 1440x3120')?.width === 1440);
  check('无 Override 时 density 回退 Physical', parseDensity('Physical density: 560') === 560);
  check('wm size 解析不出时返回 null', parseWmSize('garbage') === null);

  // ---- 9.4 分叉时以截图为准 ----
  const sizeAgree = resolveDisplaySize({ width: 1080, height: 2400 }, { width: 1080, height: 2400 });
  check('尺寸一致时不告警', sizeAgree?.size.width === 1080 && sizeAgree?.warning === undefined);
  const sizeDiverged = resolveDisplaySize({ width: 1440, height: 3120 }, { width: 1080, height: 1920 });
  check('不一致时以截图为准', sizeDiverged?.size.width === 1080 && sizeDiverged?.size.height === 1920);
  check(
    '不一致时告警里带上 wm size 原文',
    typeof sizeDiverged?.warning === 'string' && sizeDiverged.warning.includes('1440×3120'),
    `实际 ${sizeDiverged?.warning ?? 'undefined'}`,
  );
  const sizeNoPng = resolveDisplaySize({ width: 1080, height: 2400 }, null);
  check('读不出 PNG 时回退 wm size 并告警', sizeNoPng?.size.width === 1080 && typeof sizeNoPng.warning === 'string');
  check('两者都拿不到返回 null', resolveDisplaySize(null, null) === null);

  // 关键回归：上面那台「开了 wm size 覆盖」的机器，帧盒必须是 360dp
  const overrideResolved = resolveDisplaySize(parseWmSize(wmSizeOut), parsePngSize(pngHeader(1080, 1920)));
  const overrideLogical = toLogical(overrideResolved!.size.width, 160 / 480);
  check('Override 生效时帧盒 = 360dp', overrideLogical === 360, `实际 ${overrideLogical}`);
  check('（反面）误取 Physical 会得到 480dp，与 360dp 的节点层错位 1.33 倍', toLogical(1440, 160 / 480) === 480);

  // ---- 9.5 帧盒与节点共用同一取整规则 ----
  // dpi=420 时 1080 × 160/420 = 411.428…：帧盒若取整成 411，末位节点(411.43)就会超出帧盒 0.43dp
  check('toLogical 保留 2 位小数（不截断成整数）', toLogical(1080, 160 / 420) === 411.43, `实际 ${toLogical(1080, 160 / 420)}`);
  check('整除数仍得整数（1080px @480dpi → 360）', toLogical(1080, 160 / 480) === 360, `实际 ${toLogical(1080, 160 / 480)}`);
  check('帧盒 ≥ 任意节点右下边界', toLogical(1080, 160 / 420) >= toLogical(1079, 160 / 420));

  section('10. 插件直传通道（Origin 闸 / 协议 / 分片 / 字节导入）');

  // ---- 10.1 Origin 白名单（纯函数）----
  // 这是整条通道唯一的安全闸：只有「不是网页发起的连接」才放行。
  check('放行缺失 Origin', isAllowedOrigin(undefined));
  check('放行空串 Origin', isAllowedOrigin(''));
  check('放行 null Origin（Figma 插件 iframe）', isAllowedOrigin('null'));
  check('放行 figma.com', isAllowedOrigin('https://figma.com'));
  check('放行子域 www.figma.com', isAllowedOrigin('https://www.figma.com'));
  check('拒绝任意网页', !isAllowedOrigin('https://evil.com'));
  check('拒绝后缀伪装 figma.com.evil.com', !isAllowedOrigin('https://figma.com.evil.com'));
  check('拒绝非 https 的 figma.com', !isAllowedOrigin('http://figma.com'));
  check('拒绝非法 Origin 串', !isAllowedOrigin('not-a-url'));
  check('拒绝 file: 协议', !isAllowedOrigin('file:///tmp/x.html'));

  const bridge = new DesignBridge();
  const bridgeEvents: BridgeEvent[] = [];
  bridge.onEvent = (event) => bridgeEvents.push(event);

  // ---- 10.2 启动（端口 0 = 系统挑空闲端口，避免和真实实例抢 23457）----
  const started = await bridge.start(0);
  check('服务已监听', started.running && started.port > 0, `端口 ${started.port}`);
  check('只绑回环地址', started.host === '127.0.0.1', started.host);
  check('HTTP 请求被拒（只收 WebSocket）', (await probeHttp(started.port)) === 426);

  // ---- 10.3 Origin 闸在真实连接上生效 ----
  const evil = new Probe(started.port, 'https://evil.com');
  const evilBlocked = await evil.open(2000).then(
    () => false,
    () => true,
  );
  check('真实连接：非白名单 Origin 被拒', evilBlocked);
  check('拒连回 403（便于插件 DevTools 里定位）', evil.rejectedStatus === 403, `实际 ${evil.rejectedStatus}`);
  check('拒连计数递增', bridge.status().rejected === 1, `实际 ${bridge.status().rejected}`);
  evil.ws.terminate();

  // 放行 null Origin：这正是 Figma 插件 iframe 的真实形态
  const nullOrigin = new Probe(started.port, 'null');
  const nullAllowed = await nullOrigin.open(2000).then(
    () => true,
    () => false,
  );
  check('真实连接：null Origin 被放行', nullAllowed);
  nullOrigin.ws.close();

  // 插件实际连的是 localhost（manifest 的 allowedDomains 只接受主机名，裸 IP 会被判非法），
  // 而服务端只绑了 127.0.0.1 —— 这条断言保证「必须写 localhost」不会变成「连不上」
  const viaLocalhost = new Probe(started.port, undefined, 'localhost');
  const localhostOk = await viaLocalhost.open(2000).then(
    () => true,
    () => false,
  );
  check('localhost（插件实际使用的地址）可连通', localhostOk);
  viaLocalhost.ws.close();
  // ---- 10.4 协议协商 ----
  const client = new Probe(started.port);
  await client.open();
  client.send({ type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION });
  const welcome = await client.next();
  check('hello → welcome', welcome.type === 'welcome', welcome.type);
  if (welcome.type === 'welcome') {
    check('协议版本回显一致', welcome.protocol === BRIDGE_PROTOCOL_VERSION);
    check('回传上传上限', welcome.maxUploadBytes === BRIDGE_MAX_UPLOAD_BYTES);
    check('回传应用名', welcome.app === 'UI 验收投屏', welcome.app);
  }
  // 前面的探测连接可能还处在关闭握手中，这里只要求「至少跟踪到一个活跃连接」
  check('状态里可见活跃客户端', bridge.status().clients >= 1, `实际 ${bridge.status().clients}`);

  // ---- 10.5 未握手 / 协议版本不符 ----
  const raw = new Probe(started.port);
  await raw.open();
  raw.send({ type: 'list-requirements' });
  const notHelloed = await raw.next();
  check(
    '未握手先请求被拒（not-helloed）',
    notHelloed.type === 'error' && notHelloed.code === 'not-helloed',
    notHelloed.type === 'error' ? notHelloed.code : notHelloed.type,
  );
  raw.ws.close();

  const stale = new Probe(started.port);
  await stale.open();
  stale.send({ type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION + 1 });
  const mismatch = await stale.next();
  check(
    '协议版本不符被拒（protocol-mismatch）',
    mismatch.type === 'error' && mismatch.code === 'protocol-mismatch',
    mismatch.type === 'error' ? mismatch.code : mismatch.type,
  );
  await sleep(80);
  check('版本不符后连接被关闭', stale.ws.readyState === WebSocket.CLOSED, `readyState=${stale.ws.readyState}`);

  // ---- 10.6 需求列表：只回摘要，不外泄节点表 ----
  const transferReq = await createRequirement({ name: '冒烟 · 插件直传' });
  client.send({ type: 'list-requirements' });
  const list = await client.next();
  check('list-requirements → requirements', list.type === 'requirements', list.type);
  if (list.type === 'requirements') {
    const brief = list.items.find((item) => item.id === transferReq.id);
    check('列表含新建需求', !!brief, brief?.name ?? '');
    check('摘要含资产计数', brief?.designCount === 0 && brief?.pairCount === 0);
    check('摘要不含节点表字段', brief !== undefined && !('nodes' in brief));
  }

  // ---- 10.7 分片上传 → 落盘导入 ----
  const zipBytes = await readFile(sampleZip);
  client.send({
    type: 'upload-begin',
    requirementId: transferReq.id,
    fileName: '直传.zip',
    byteLength: zipBytes.byteLength,
    conflict: 'skip',
  });
  const ready = await client.next();
  check('upload-begin → upload-ready', ready.type === 'upload-ready', ready.type);
  if (ready.type === 'upload-ready') {
    check('回显待收字节数', ready.byteLength === zipBytes.byteLength);
  }

  const chunkCount = sendInChunks(client, zipBytes, Math.ceil(zipBytes.byteLength / 3));
  check('确实分了多片发送', chunkCount >= 2, `${chunkCount} 片`);

  const uploadResult = await client.next(20000);
  check('upload-result 到达', uploadResult.type === 'upload-result', uploadResult.type);
  if (uploadResult.type === 'upload-result') {
    check('导入无致命错误', !uploadResult.fatal, uploadResult.fatal ?? '');
    check('导入成功 ok=true', uploadResult.ok === true);
    check('导入 1 帧', uploadResult.frames.length === 1, `实际 ${uploadResult.frames.length}`);
    check('中文帧名经通道未损坏', uploadResult.frames[0]?.name === '首页', uploadResult.frames[0]?.name ?? '');
    check('帧状态为 imported', uploadResult.frames[0]?.status === 'imported');
  }
  check('忙状态已复位', bridge.status().busy === false);

  // ---- 10.8 字节通道 ≡ 本地 zip 通道（同包必须同结果）----
  // 直传只是换了「怎么把字节交进来」，不该产生任何数据差异。
  const localReq = await createRequirement({ name: '冒烟 · 本地 zip 对照' });
  await importFigmaPackage(localReq.id, sampleZip, 'skip');
  const remoteAsset = (await getRequirement(transferReq.id))!.designAssets[0]!;
  const localAsset = (await getRequirement(localReq.id))!.designAssets[0]!;
  check('两通道帧名一致', remoteAsset.name === localAsset.name, `${remoteAsset.name} / ${localAsset.name}`);
  check(
    '两通道逻辑尺寸一致',
    remoteAsset.width === localAsset.width && remoteAsset.height === localAsset.height,
    `${remoteAsset.width}×${remoteAsset.height} / ${localAsset.width}×${localAsset.height}`,
  );
  check(
    '两通道节点数一致',
    remoteAsset.nodeCount === localAsset.nodeCount,
    `${remoteAsset.nodeCount} / ${localAsset.nodeCount}`,
  );
  check('两通道唯一帧键一致', remoteAsset.frameKey === localAsset.frameKey, remoteAsset.frameKey);
  check('两通道包名溯源一致', remoteAsset.packageName === localAsset.packageName, remoteAsset.packageName ?? '');

  // ---- 10.9 冲突策略经通道生效 ----
  client.send({
    type: 'upload-begin',
    requirementId: transferReq.id,
    fileName: '直传.zip',
    byteLength: zipBytes.byteLength,
    conflict: 'skip',
  });
  await client.next();
  sendInChunks(client, zipBytes, zipBytes.byteLength);
  const skipRun = await client.next(20000);
  check(
    'skip 策略下重复上传被跳过',
    skipRun.type === 'upload-result' && skipRun.frames[0]?.status === 'skipped',
    skipRun.type === 'upload-result' ? (skipRun.frames[0]?.status ?? '无帧') : skipRun.type,
  );
  check(
    '跳过未产生重复资产',
    (await getRequirement(transferReq.id))?.designAssets.length === 1,
    `实际 ${(await getRequirement(transferReq.id))?.designAssets.length}`,
  );

  // ---- 10.10 拒绝路径：都得是明确错误码，不能静默吞掉 ----
  client.send({
    type: 'upload-begin',
    requirementId: 'no-such-requirement',
    fileName: 'x.zip',
    byteLength: 16,
    conflict: 'skip',
  });
  const unknownReq = await client.next();
  check(
    '未知需求被拒（unknown-requirement）',
    unknownReq.type === 'error' && unknownReq.code === 'unknown-requirement',
    unknownReq.type === 'error' ? unknownReq.code : unknownReq.type,
  );

  client.send({
    type: 'upload-begin',
    requirementId: transferReq.id,
    fileName: 'big.zip',
    byteLength: BRIDGE_MAX_UPLOAD_BYTES + 1,
    conflict: 'skip',
  });
  const tooLarge = await client.next();
  check(
    '超过 100MB 被拒（too-large）',
    tooLarge.type === 'error' && tooLarge.code === 'too-large',
    tooLarge.type === 'error' ? tooLarge.code : tooLarge.type,
  );

  client.send({
    type: 'upload-begin',
    requirementId: transferReq.id,
    fileName: 'x.zip',
    byteLength: 16,
    conflict: 'overwrite' as unknown as 'skip',
  });
  const badConflict = await client.next();
  check(
    '非法冲突策略被拒（bad-request）',
    badConflict.type === 'error' && badConflict.code === 'bad-request',
    badConflict.type === 'error' ? badConflict.code : badConflict.type,
  );

  client.send({
    type: 'upload-begin',
    requirementId: transferReq.id,
    fileName: 'x.zip',
    byteLength: -1,
    conflict: 'skip',
  });
  const badLength = await client.next();
  check(
    '非法字节数被拒（bad-request）',
    badLength.type === 'error' && badLength.code === 'bad-request',
    badLength.type === 'error' ? badLength.code : badLength.type,
  );

  client.ws.send('这不是 JSON');
  const notJson = await client.next();
  check(
    '非 JSON 文本被拒（bad-request）',
    notJson.type === 'error' && notJson.code === 'bad-request',
    notJson.type === 'error' ? notJson.code : notJson.type,
  );

  client.send({ type: 'unknown-command' } as unknown as BridgeClientMessage);
  const unknownCmd = await client.next();
  check(
    '未知指令被拒（bad-request）',
    unknownCmd.type === 'error' && unknownCmd.code === 'bad-request',
    unknownCmd.type === 'error' ? unknownCmd.code : unknownCmd.type,
  );

  // 没有进行中的上传却发二进制 → 明确拒绝，不能当成某次上传的续片
  client.sendBytes(Buffer.from([1, 2, 3]));
  const strayChunk = await client.next();
  check(
    '无上传时收到二进制被拒（bad-request）',
    strayChunk.type === 'error' && strayChunk.code === 'bad-request',
    strayChunk.type === 'error' ? strayChunk.code : strayChunk.type,
  );

  // ---- 10.11 事件与收尾 ----
  check('导入事件已推给渲染层', bridgeEvents.some((event) => event.type === 'imported'));
  check('状态事件里带 lastImport', bridge.status().lastImport?.requirementId === transferReq.id);
  // 最近一次是 skip 那次：imported=0 / skipped=1，说明 tally 是按帧状态真实统计的
  check('lastImport 计数正确（最近一次为跳过）', bridge.status().lastImport?.skipped === 1);
  check('lastImport 累计导入数为 0', bridge.status().lastImport?.imported === 0);

  client.ws.close();
  await sleep(120);
  check('客户端断开后计数归零', bridge.status().clients === 0, `实际 ${bridge.status().clients}`);

  await bridge.stop();
  check('停止后 running=false', bridge.status().running === false);
  const afterStop = await probeHttp(started.port).then(
    () => false,
    () => true,
  );
  check('停止后端口已释放', afterStop);

  // 幂等：重复 stop 不应抛错
  await bridge.stop();
  check('重复 stop 不抛错', true);

  await deleteRequirement(transferReq.id);
  await deleteRequirement(localReq.id);

  section('12. 验收引擎（归一化 / 匹配 / 门禁 / 视觉 / AI 仲裁）');

  // ------------------------------------------------------------------
  // 这一段为什么用**真实** Figma 节点当夹具，而不是手写小树：
  //
  // 匹配引擎的分数是六个维度的加权和，手写 3 个节点的小树只能验出「同样的东西
  // 算得一样」，验不出「真实数据里 310 个节点会不会全被拆成 missing」。
  // 而后者才是这个引擎最容易出错的地方（打分阈值 / 匈牙利分配的边界）。
  //
  // 做法：把设计稿节点**镜像**成一份 App 节点树（同 rect、同父子、同文本），
  // 得到一份「零缺陷」的对照物 —— 匹配引擎理应把两侧一一配上，一条 missing 都不该有。
  // 然后在这个对照物上**逐条注入缺陷**（挪 20px / 改文案 / 删节点），
  // 断言每一类缺陷都被对应检查抓到。这样每个断言都只依赖「注入的那一条」，
  // 不会被真实数据里本来就存在的歧义噪声干扰。
  // ------------------------------------------------------------------

  const designNodes = view.design.nodes;
  const designWidth = view.design.width;
  const designHeight = view.design.height;

  /** 每个设计稿节点的子节点数（镜像 App 树要用它判定 layoutOnly） */
  const childCountOf = new Map<string, number>();
  for (const node of designNodes) {
    if (node.parentId) childCountOf.set(node.parentId, (childCountOf.get(node.parentId) ?? 0) + 1);
  }

  /** App 侧的镜像 id。加前缀是为了让断言里一眼能看出「这是造出来的」 */
  const mirrorId = (designId: string): string => `ax:${designId}`;

  /**
   * 把设计稿节点镜像成 App 节点。
   *
   * ⚠️ 各字段的口径必须与 `core.canonicalize` 内部**完全一致**，否则「零缺陷」
   * 这个前提就不成立，后面的缺陷注入会分不清「我注入的」和「镜像本身就不一致」：
   *   - `hasVisualContent` ↔ design 的 `hasFill`
   *   - `isImage` ↔ `fills` 里有可见的 IMAGE
   *   - `isSvg` ↔ design 的 `type` 是 VECTOR / ELLIPSE / BOOLEAN_OPERATION
   *   - `isGradient` ↔ `fills` 里有 GRADIENT_*
   *   - `layoutOnly` ↔ `!hasFill && 无文本 && 有子节点`（相等才能让 participation 相等）
   */
  const mirrorAppNode = (node: DesignNode): AppNode => {
    const hasFill = node.hasFill !== false;
    const text = node.text?.characters ?? null;
    const hasChildren = (childCountOf.get(node.id) ?? 0) > 0;
    const layoutOnly = !hasFill && !text && hasChildren;
    const rect = node.rect;
    return {
      nodeId: mirrorId(node.id),
      parentId: node.parentId ? mirrorId(node.parentId) : null,
      className: 'android.view.View',
      depth: node.depth,
      index: node.index ?? 0,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      visibleX: rect.x,
      visibleY: rect.y,
      visibleWidth: rect.width,
      visibleHeight: rect.height,
      scrollX: 0,
      scrollY: 0,
      visible: node.visible !== false,
      enabled: true,
      clickable: false,
      alpha: node.opacity ?? 1,
      z: 0,
      elevation: 0,
      clipsToBounds: node.layout?.clipsContent === true,
      isImage: !!node.fills?.some((paint) => paint.type === 'IMAGE' && paint.visible !== false),
      isSvg: node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'BOOLEAN_OPERATION',
      isGradient: !!node.fills?.some((paint) => paint.type.startsWith('GRADIENT')),
      hasVisualContent: hasFill,
      resourceName: null,
      contentDescription: null,
      text,
      layoutOnly,
      participation: layoutOnly ? 'context' : 'required',
    };
  };

  const mirroredAppNodes = designNodes.map(mirrorAppNode);

  /**
   * App 侧宽度刻意取**与设计稿相同**：`transformAppRect` 的 scale 退化成 1，
   * 于是「几何分数 = 1」是构造上的必然，而不是靠样本恰好尺寸一致。
   * 分辨率不一致（375 vs 390）的对齐策略是另一个议题（R4），不该混进匹配引擎的断言里。
   */
  const designDoc = canonicalizeDesign(designNodes, designWidth, designHeight);
  const appDoc = canonicalizeApp(mirroredAppNodes, designWidth, designHeight);

  check(
    '归一化：设计稿节点数 === 拍平后的节点数（没有节点被静默丢弃）',
    designDoc.nodes.length === designNodes.length,
    `${designDoc.nodes.length} / ${designNodes.length}`,
  );
  check(
    '归一化：App 节点数 === 镜像节点数',
    appDoc.nodes.length === mirroredAppNodes.length,
    `${appDoc.nodes.length} / ${mirroredAppNodes.length}`,
  );
  check('归一化：两侧都只有一个根节点', designDoc.rootIds.length === 1 && appDoc.rootIds.length === 1);
  check(
    '归一化：canonicalId 带来源前缀（design: / app:），两侧不会撞 id',
    designDoc.nodes.every((node) => node.canonicalId.startsWith('design:')) &&
      appDoc.nodes.every((node) => node.canonicalId.startsWith('app:')),
  );

  const cleanMatches = matchDocuments(designDoc, appDoc);

  const designSide = cleanMatches.filter((match) => match.designNodeIds.length > 0).length;
  const appSide = cleanMatches.filter((match) => match.appNodeIds.length > 0).length;
  check(
    '匹配：每个设计稿节点都恰好出现在一条 match 里（无悬空、无重复消费）',
    designSide === designDoc.nodes.length,
    `${designSide} / ${designDoc.nodes.length}`,
  );
  check(
    '匹配：每个 App 节点都恰好出现在一条 match 里',
    appSide === appDoc.nodes.length,
    `${appSide} / ${appDoc.nodes.length}`,
  );
  check(
    '匹配：零缺陷对照物上没有任何 missing / extra',
    cleanMatches.every((match) => match.status !== 'missing' && match.status !== 'extra'),
    `missing=${cleanMatches.filter((m) => m.status === 'missing').length} extra=${cleanMatches.filter((m) => m.status === 'extra').length}`,
  );

  const cleanSummary = {
    matched: cleanMatches.filter((match) => match.status === 'matched').length,
    ambiguous: cleanMatches.filter((match) => match.status === 'ambiguous').length,
  };
  check(
    '匹配：matched + ambiguous === 设计稿节点总数（两者之和必须守恒）',
    cleanSummary.matched + cleanSummary.ambiguous === designDoc.nodes.length,
    `${cleanSummary.matched} + ${cleanSummary.ambiguous} = ${cleanSummary.matched + cleanSummary.ambiguous}`,
  );

  // 歧义必须带候选：面板上「确认 / 忽略」两个按钮的全部价值就在 alternatives 里，
  // 没有候选的重探是死路（用户只能盲选）。Top-K 上限由 core 的常量约束。
  const ambiguousSample = cleanMatches.find((match) => match.status === 'ambiguous');
  check(
    '匹配：歧义条目带 Top-K 候选（面板可据此人工作选择）',
    ambiguousSample
      ? (ambiguousSample.alternatives?.length ?? 0) >= 2 &&
          (ambiguousSample.alternatives?.length ?? 0) <= 5
      : true,
    ambiguousSample ? `${ambiguousSample.alternatives?.length} 个候选` : '本样本无歧义条目',
  );

  // 确定性：同一输入两次必须给出同一结论。匹配里若混入任何随机或时间相关的东西
  // （Map 迭代顺序、Set 去重的偶然性），用户会看到「什么都没改，结论变了」。
  const cleanMatchesAgain = matchDocuments(designDoc, appDoc);
  check(
    '匹配：同一输入两次结论完全一致（无随机 / 无状态泄漏）',
    cleanMatchesAgain.length === cleanMatches.length &&
      cleanMatchesAgain.every((match, index) => match.id === cleanMatches[index]!.id && match.status === cleanMatches[index]!.status),
  );

  // ---- 12.2 门禁（纯函数，四种来源缺陷各自可解释） ----

  const sdkQuality: CollectionQuality = {
    profile: 'acceptance-full',
    requestedMaxDepth: 64,
    requestedMaxNodes: 5000,
    actualDepth: 8,
    actualNodeCount: mirroredAppNodes.length,
    depthLimitReached: false,
    nodeLimitReached: false,
    hiddenNodesIncluded: false,
    zeroSizeNodesIncluded: true,
    textIncluded: true,
    excludedNodes: [],
  };

  /**
   * 门禁吃的是**素材元数据**（`DesignAssetMeta` / `AppSnapshotMeta`），不是画布视图
   * （`SideData` 只带宽高与节点）。所以从索引里按配对的两个 id 把元数据取回来 ——
   * 这也正是 `service.runAcceptance` 的做法，这里刻意走同一条路：
   * 如果两边取元数据的方式不同，冒烟测出来的门禁结论就不代表真实运行。
   */
  const engineReq = (await getRequirement(requirement.id))!;
  const designMeta = engineReq.designAssets.find((asset) => asset.id === view.meta.designAssetId) ?? null;
  const appMeta = engineReq.appSnapshots.find((snapshot) => snapshot.id === view.meta.appSnapshotId) ?? null;
  check('夹具就绪：能从索引里取回配对两侧的素材元数据', !!designMeta && !!appMeta);
  // 取不到就直接失败退出：后面每一条门禁断言都以这两份元数据为输入，
  // 用假对象兜底等于让整段断言失去意义。
  if (!designMeta || !appMeta) throw new Error('冒烟夹具缺失：配对两侧的素材元数据取不到');

  const readyInput = {
    pairId: view.meta.id,
    design: designMeta,
    app: appMeta,
    designNodeCount: designDoc.nodes.length,
    appNodeCount: appDoc.nodes.length,
  };

  const readinessReady = evaluateReadiness({
    ...readyInput,
    app: { ...appMeta, source: 'sdk', collectionQuality: sdkQuality },
  });
  check('门禁：SDK 来源 + acceptance-full + 未截断 → ready', readinessReady.ready === true, readinessReady.reasons.join(','));
  check('门禁：ready 时 coordinateValid=true 且 source=sdk', readinessReady.coordinateValid === true && readinessReady.source === 'sdk');

  const readinessLegacy = evaluateReadiness({ ...readyInput, app: { ...appMeta, source: 'uiautomator', collectionQuality: undefined } });
  check(
    '门禁：旧格式来源（uiautomator）→ 不 ready，且原因里点名来源',
    !readinessLegacy.ready && readinessLegacy.reasons.includes('APP_NODE_SOURCE_NOT_SDK'),
    readinessLegacy.reasons.join(','),
  );
  check(
    '门禁：缺少采集质量信息单独成一条原因（不能只报「来源不对」）',
    readinessLegacy.reasons.includes('COLLECTION_QUALITY_MISSING'),
  );

  const readinessTruncated = evaluateReadiness({
    ...readyInput,
    app: { ...appMeta, source: 'sdk', collectionQuality: { ...sdkQuality, nodeLimitReached: true } },
  });
  check(
    '门禁：节点树被截断 → 不 ready（截断会被误读成「App 没这个节点」，是假阴性）',
    !readinessTruncated.ready && readinessTruncated.reasons.includes('COLLECTION_TRUNCATED'),
    readinessTruncated.reasons.join(','),
  );

  const readinessWrongProfile = evaluateReadiness({
    ...readyInput,
    app: { ...appMeta, source: 'sdk', collectionQuality: { ...sdkQuality, profile: 'legacy' } },
  });
  check(
    '门禁：采集档位不是 acceptance-full → 不 ready',
    !readinessWrongProfile.ready && readinessWrongProfile.reasons.includes('COLLECTION_PROFILE_NOT_FULL'),
    readinessWrongProfile.reasons.join(','),
  );

  const readinessNoNodes = evaluateReadiness({
    ...readyInput,
    app: { ...appMeta, source: 'sdk', collectionQuality: sdkQuality },
    appNodeCount: 0,
  });
  check(
    '门禁：App 节点树为空 → 不 ready（空树会让所有节点变成 missing）',
    !readinessNoNodes.ready && readinessNoNodes.reasons.includes('APP_NODE_TREE_EMPTY'),
  );

  const readinessNoPair = evaluateReadiness({ ...readyInput, design: null, app: null, designNodeCount: 0, appNodeCount: 0 });
  check('门禁：配对缺一侧 → PAIR_INCOMPLETE', readinessNoPair.reasons.includes('PAIR_INCOMPLETE'));
  check('门禁：缺素材时 coordinateValid=false', readinessNoPair.coordinateValid === false);

  // ---- 12.3 裁决：证据不足绝不 PASS ----
  //
  // 这条是整套验收的**产品红线**：没有视觉证据时必须停在 review。
  // 一旦允许「没证据 = 通过」，用户拿到的绿灯就不再意味着「验过了」。

  const gate = (overrides: Partial<Parameters<typeof evaluateAcceptance>[0]>) =>
    evaluateAcceptance({
      design: designDoc,
      app: appDoc,
      matches: cleanMatches,
      source: 'sdk',
      coordinateValid: true,
      collectionQuality: sdkQuality,
      ...overrides,
    });

  const cleanResult = gate({});

  // 这两条同时验证了两件事：镜像的字段口径与 core 的归一化口径一致（否则会报一堆
  // 几何 / 文案差异），以及「零缺陷」这个前提成立。它们是后面所有缺陷注入断言的地基。
  check(
    '零缺陷对照物：不产生任何几何问题（镜像口径与归一化口径一致）',
    cleanResult.issues.every((issue) => issue.check !== 'geometry'),
    `几何问题 ${cleanResult.issues.filter((issue) => issue.check === 'geometry').length} 条`,
  );
  check(
    '零缺陷对照物：不产生任何文案问题',
    cleanResult.issues.every((issue) => issue.check !== 'text'),
    `文案问题 ${cleanResult.issues.filter((issue) => issue.check === 'text').length} 条`,
  );

  check(
    '裁决：没有视觉证据 → 绝不 PASS（逐节点 unknown，停在待复核）',
    cleanResult.verdict === 'review' && cleanResult.summary.unknownCount > 0,
    `verdict=${cleanResult.verdict} unknown=${cleanResult.summary.unknownCount}`,
  );
  check(
    '裁决：没有视觉证据时不产生「颜色 / 视觉差异」类问题（没有证据就不该下结论）',
    cleanResult.issues.every((issue) => issue.check !== 'color' && issue.check !== 'visual-differs' && issue.check !== 'asset-differs'),
  );

  const legacySource = gate({ source: 'legacy', collectionQuality: undefined });
  check(
    '裁决：来源不是 SDK → blocked（不是 fail，也不是 review）',
    legacySource.verdict === 'blocked',
    `verdict=${legacySource.verdict}`,
  );
  check(
    '裁决：blocked 会记一条 P0 readiness 问题，把原因摆在明面上',
    legacySource.issues.some((issue) => issue.check === 'readiness' && issue.severity === 'P0' && issue.reasonCodes.includes('APP_NODE_SOURCE_NOT_SDK')),
  );

  // ---------------- 缺陷注入的公共夹具 ----------------

  /** 只改 App 侧一个节点，其余原样 —— 每个断言只依赖自己注入的那一条 */
  const withAppNode = (nodeId: string, patch: Partial<AppNode>): AppNode[] =>
    mirroredAppNodes.map((node) => (node.nodeId === nodeId ? { ...node, ...patch } : node));

  /** 从镜像树里摘掉一个节点（连同它的子树）—— 用来伪造「App 侧少了一个节点」 */
  const withoutSubtree = (rootId: string): AppNode[] => {
    const doomed = new Set<string>([mirrorId(rootId)]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of mirroredAppNodes) {
        if (node.parentId && doomed.has(node.parentId) && !doomed.has(node.nodeId)) {
          doomed.add(node.nodeId);
          grew = true;
        }
      }
    }
    return mirroredAppNodes.filter((node) => !doomed.has(node.nodeId));
  };

  /** 挑一个「有文本、且在镜像里能被匹配上」的设计稿节点，作为文案缺陷的靶子 */
  const textTarget =
    designNodes.find(
      (node) =>
        (node.text?.characters ?? '').trim().length >= 4 &&
        (childCountOf.get(node.id) ?? 0) === 0 &&
        !mirroredAppNodes.find((app) => app.nodeId === mirrorId(node.id))!.layoutOnly,
    ) ?? designNodes.find((node) => (node.text?.characters ?? '').trim().length >= 4);

  check('夹具就绪：找到带文本的设计稿节点', !!textTarget, textTarget?.text?.characters ?? '无');

  const textDoc = canonicalizeApp(
    withAppNode(mirrorId(textTarget!.id), { text: `${textTarget!.text!.characters}·改过了` }),
    designWidth,
    designHeight,
  );
  const textResult = gate({ app: textDoc, matches: matchDocuments(designDoc, textDoc) });
  check(
    '缺陷·文案：改动一个文字节点 → 报 TEXT_MISMATCH',
    textResult.issues.some((issue) => issue.check === 'text' && issue.reasonCodes.includes('TEXT_MISMATCH')),
    `verdict=${textResult.verdict}`,
  );
  check(
    '缺陷·文案：P1 问题 → 结论 fail（文案错了不能只算「待复核」）',
    textResult.verdict === 'fail',
    `verdict=${textResult.verdict}`,
  );
  check(
    '缺陷·文案：问题条目带上是哪一对节点（否则面板点不动）',
    textResult.issues
      .filter((issue) => issue.check === 'text')
      .every((issue) => issue.designNodeIds.length > 0 && issue.appNodeIds.length > 0),
  );

  /** 挑一个非 context（有实体视觉）的节点做几何缺陷靶子 */
  const geometryTarget =
    designNodes.find((node) => {
      const mirror = mirroredAppNodes.find((app) => app.nodeId === mirrorId(node.id))!;
      return !mirror.layoutOnly && node.rect.width > 8 && node.rect.height > 8;
    }) ?? designNodes[1]!;

  const shiftRect = { x: geometryTarget.rect.x + 20, y: geometryTarget.rect.y + 20 };
  const geometryDoc = canonicalizeApp(
    withAppNode(mirrorId(geometryTarget.id), { x: shiftRect.x, y: shiftRect.y, visibleX: shiftRect.x, visibleY: shiftRect.y }),
    designWidth,
    designHeight,
  );
  const geometryResult = gate({ app: geometryDoc, matches: matchDocuments(designDoc, geometryDoc) });
  check(
    '缺陷·几何：平移 20px → 报 GEOMETRY_OUT_OF_TOLERANCE',
    geometryResult.issues.some((issue) => issue.check === 'geometry' && issue.reasonCodes.includes('GEOMETRY_OUT_OF_TOLERANCE')),
    `verdict=${geometryResult.verdict}`,
  );
  check(
    '缺陷·几何：容差按设计稿尺寸的 1% 兜底（375 宽 → 20px 必定超差）',
    geometryResult.issues.some((issue) => issue.check === 'geometry' && issue.severity === 'P1'),
  );

  const missingDoc = canonicalizeApp(withoutSubtree(geometryTarget.id), designWidth, designHeight);
  const missingResult = gate({ app: missingDoc, matches: matchDocuments(designDoc, missingDoc) });
  check(
    '缺陷·缺失：App 侧少了节点 → 报 DESIGN_NODE_MISSING',
    missingResult.issues.some((issue) => issue.check === 'presence' && issue.reasonCodes.includes('DESIGN_NODE_MISSING')),
    `verdict=${missingResult.verdict}`,
  );
  check(
    '缺陷·缺失：计数守恒（少掉的节点记进 missingCount，不是凭空消失）',
    missingResult.summary.missingCount > 0 &&
      missingResult.summary.missingCount + missingResult.summary.matchedCount + missingResult.summary.ambiguousCount === designDoc.nodes.length,
    `missing=${missingResult.summary.missingCount}`,
  );

  // 反证：几何缺陷必须**真的**来自那条位移。否则「报错」可能只是镜像本身就不一致，
  // 上面几条断言就退化成「反正总会报点什么」。
  check(
    '反证：位移回到 0 后，该节点的几何问题随之消失',
    !cleanResult.issues.some(
      (issue) => issue.check === 'geometry' && issue.designNodeIds.includes(`design:${geometryTarget.id}`),
    ),
  );

  // ---- 12.4 人工映射：忽略与确认必须真的改变结论 ----

  /** 忽略一个设计稿节点：它不该再被报「缺失」，也不该再出现 missing */
  const ignoredMapping: NodeMapping = {
    version: '1.0.0',
    pairId: view.meta.id,
    anchors: [],
    // ⚠️ 必须是**归一化 id**（`design:xxx`），不是画布上的原始图层 id：
    // matchDocuments 拿它去比 `canonicalId`，原始 id 放进来是一条永不生效的规则 ——
    // 而且它不报错，只在「用户点了忽略、问题还在」时才暴露。
    ignoredDesignNodeIds: [`design:${geometryTarget.id}`],
    ignoredAppNodeIds: [],
    matches: [],
    updatedAt: new Date(0).toISOString(),
  };
  const ignoredMatches = matchDocuments(designDoc, missingDoc, ignoredMapping);
  check(
    '人工·忽略：被忽略的设计稿节点不再产生 missing 条目',
    ignoredMatches.every((match) => !match.designNodeIds.includes(`design:${geometryTarget.id}`)),
    `仍匹配到 ${ignoredMatches.filter((m) => m.designNodeIds.includes(`design:${geometryTarget.id}`)).length} 条`,
  );
  check(
    '人工·忽略：被忽略的节点不再被报「缺失」（忽略是用户的意志，不能被规则覆盖回来）',
    !gate({ app: missingDoc, matches: ignoredMatches }).issues.some(
      (issue) => issue.designNodeIds.includes(`design:${geometryTarget.id}`) && issue.check === 'presence',
    ),
  );
  check(
    '人工·忽略：原始图层 id（未加来源前缀）不会被误当成归一化 id（防止「忽略不生效」的静默 bug）',
    matchDocuments(designDoc, missingDoc, {
      ...ignoredMapping,
      ignoredDesignNodeIds: [geometryTarget.id],
    }).some((match) => match.designNodeIds.includes(`design:${geometryTarget.id}`)),
  );

  /** 确认一条人工匹配：必须原样保留，且 source=manual / 置信度 1 */
  const manualPair = cleanMatches.find((match) => match.status === 'matched' && match.designNodeIds.length === 1);
  check('夹具就绪：找到一条可用于人工确认的匹配', !!manualPair);
  const manualMapping: NodeMapping = {
    version: '1.0.0',
    pairId: view.meta.id,
    anchors: [],
    ignoredDesignNodeIds: [],
    ignoredAppNodeIds: [],
    matches: manualPair ? [{ ...manualPair, source: 'manual', status: 'matched' }] : [],
    updatedAt: new Date(0).toISOString(),
  };
  const manualMatches = matchDocuments(designDoc, appDoc, manualMapping);
  const manualApplied = manualMatches.find((match) => match.id === manualPair!.id);
  check(
    '人工·确认：锚定的配对以 source=manual / confidence=1 / status=matched 出现',
    !!manualApplied && manualApplied.source === 'manual' && manualApplied.confidence === 1 && manualApplied.status === 'matched',
    manualApplied ? `${manualApplied.source}/${manualApplied.confidence}/${manualApplied.status}` : '未找到',
  );
  check(
    '人工·确认：锚点不会被 AI 或规则改写（映射优先级最高）',
    matchDocuments(designDoc, appDoc, manualMapping).every(
      (match) => match.source !== 'ai' || match.id !== manualPair!.id,
    ),
  );

  // ---- 12.5 AI 仲裁的边界（只确认，不推翻） ----

  const aiAmbiguous = cleanMatches.find((match) => match.status === 'ambiguous' && (match.alternatives?.length ?? 0) >= 2);
  check('夹具就绪：存在带候选的歧义条目（AI 仲裁只对这类条目生效）', !!aiAmbiguous);

  if (aiAmbiguous) {
    const candidateSets = new Map([[aiAmbiguous.id, (aiAmbiguous.alternatives ?? []).map((entry) => entry.appNodeId)]]);
    const selfAppId = aiAmbiguous.appNodeIds[0]!;

    /** 深拷贝：applyAiCandidates 是**原地改** matches 的，复用同一份会让断言互相污染 */
    const clone = (match: NodeMatch): NodeMatch => ({
      ...match,
      designNodeIds: [...match.designNodeIds],
      appNodeIds: [...match.appNodeIds],
      evidence: { ...match.evidence },
      alternatives: match.alternatives ? match.alternatives.map((entry) => ({ ...entry })) : undefined,
    });

    const promoted = [clone(aiAmbiguous)];
    const promoteOutcome = applyAiCandidates(
      promoted,
      {
        candidates: [
          { designNodeId: aiAmbiguous.designNodeIds[0]!, appNodeIds: [selfAppId], relation: 'one_to_one', probability: 0.95, reasonCodes: [] },
        ],
        observations: [],
      },
      candidateSets,
    );
    check(
      'AI·确认：高置信度指向规则原候选 → 提升为 matched，并标记来源为 ai',
      promoteOutcome.promoted === 1 && promoted[0]!.status === 'matched' && promoted[0]!.source === 'ai',
      `${promoteOutcome.promoted} promoted / ${promoted[0]!.status}`,
    );
    check(
      'AI·确认：阈值常量与判定一致（AI_ACCEPT_THRESHOLD）',
      AI_ACCEPT_THRESHOLD === 0.85,
      `实际 ${AI_ACCEPT_THRESHOLD}`,
    );

    const lowConfidence = [clone(aiAmbiguous)];
    const lowOutcome = applyAiCandidates(
      lowConfidence,
      {
        candidates: [
          { designNodeId: aiAmbiguous.designNodeIds[0]!, appNodeIds: [selfAppId], relation: 'one_to_one', probability: 0.5, reasonCodes: [] },
        ],
        observations: [],
      },
      candidateSets,
    );
    check(
      'AI·低置信：达不到阈值 → 停在 ambiguous，只记 aiScore（不硬提）',
      lowOutcome.promoted === 0 && lowConfidence[0]!.status === 'ambiguous' && lowConfidence[0]!.aiScore === 0.5,
      `${lowConfidence[0]!.status} aiScore=${lowConfidence[0]!.aiScore}`,
    );

    const outOfSet = [clone(aiAmbiguous)];
    const outOfSetOutcome = applyAiCandidates(
      outOfSet,
      {
        candidates: [
          { designNodeId: aiAmbiguous.designNodeIds[0]!, appNodeIds: ['app:不存在的节点'], relation: 'one_to_one', probability: 0.99, reasonCodes: [] },
        ],
        observations: [],
      },
      candidateSets,
    );
    check(
      'AI·越界：指向候选集之外的 App 节点 → 整条忽略，原状态不变',
      outOfSetOutcome.ignored === 1 && outOfSetOutcome.promoted === 0 && outOfSet[0]!.status === aiAmbiguous.status,
      `ignored=${outOfSetOutcome.ignored}`,
    );

    const unknownDesign = [clone(aiAmbiguous)];
    const unknownOutcome = applyAiCandidates(
      unknownDesign,
      {
        candidates: [
          { designNodeId: 'design:不存在的节点', appNodeIds: [selfAppId], relation: 'one_to_one', probability: 0.99, reasonCodes: [] },
        ],
        observations: [],
      },
      candidateSets,
    );
    check(
      'AI·越界：指向不存在的设计稿节点 → 整条忽略（AI 不能凭空造节点）',
      unknownOutcome.ignored === 1 && unknownOutcome.promoted === 0,
    );

    const manualGuard = [{ ...clone(aiAmbiguous), source: 'manual' as const, status: 'matched' as const }];
    const manualGuardOutcome = applyAiCandidates(
      manualGuard,
      {
        candidates: [
          { designNodeId: aiAmbiguous.designNodeIds[0]!, appNodeIds: [selfAppId], relation: 'one_to_one', probability: 0.99, reasonCodes: [] },
        ],
        observations: [],
      },
      candidateSets,
    );
    check(
      'AI·人工优先：source=manual 的条目 AI 碰不到（人工意志高于模型判断）',
      manualGuardOutcome.ignored === 1 && manualGuardOutcome.promoted === 0 && manualGuard[0]!.source === 'manual',
    );

    // AI 被要求参与却失败 → 必须落一条可解释的问题，且结论不能是 PASS。
    // 「AI 挂了」与「AI 说没问题」若在结论上无法区分，这个开关就是不可信的。
    const aiDown = gate({ ai: { requested: true, applied: false, error: 'ECONNREFUSED' } });
    check(
      'AI·降级：请求了 AI 但失败 → 记一条 ai-arbitration 问题（带原因）',
      aiDown.issues.some((issue) => issue.check === 'ai-arbitration' && issue.reasonCodes.includes('AI_UNAVAILABLE')),
    );
    check(
      'AI·降级：AI 失败时结论不是 pass（绝不静默通过）',
      aiDown.verdict !== 'pass',
      `verdict=${aiDown.verdict}`,
    );
    check(
      'AI·降级：问题详情里带上失败原因，便于排查',
      aiDown.issues.some((issue) => issue.check === 'ai-arbitration' && String(issue.actual).includes('ECONNREFUSED')),
    );
  }

  // ---- 12.6 AI 响应的输入校验（越界 id 必须被拒，而不是被静默丢弃） ----

  const allowedDesign = new Set(['design:a', 'design:b']);
  const allowedApp = new Set(['app:x', 'app:y']);

  const validateThrows = (value: unknown): boolean => {
    try {
      validateAiResponse(value, allowedDesign, allowedApp);
      return false;
    } catch {
      return true;
    }
  };

  check('AI 校验：合法响应通过', !validateThrows({ candidates: [{ designNodeId: 'design:a', appNodeIds: ['app:x'], relation: 'one_to_one', probability: 0.9 }] }));
  check(
    'AI 校验：引用不存在的设计稿 id → 抛错（拒绝整份响应）',
    validateThrows({ candidates: [{ designNodeId: 'design:zzz', appNodeIds: ['app:x'], probability: 0.9 }] }),
  );
  check(
    'AI 校验：引用不存在的 App id → 抛错',
    validateThrows({ candidates: [{ designNodeId: 'design:a', appNodeIds: ['app:zzz'], probability: 0.9 }] }),
  );
  check('AI 校验：probability 越界 → 抛错', validateThrows({ candidates: [{ designNodeId: 'design:a', appNodeIds: ['app:x'], probability: 1.5 }] }));
  check('AI 校验：candidates 不是数组 → 抛错', validateThrows({ candidates: {} }));
  check('AI 校验：非对象 → 抛错', validateThrows('随便一段文字'));
  check(
    'AI 校验：observations 里的越界 id 同样被拒',
    validateThrows({ observations: [{ type: 'missing', designNodeIds: ['design:zzz'] }] }),
  );
  check(
    'AI 校验：observations 的 type 非法 → 抛错',
    validateThrows({ observations: [{ type: '乱写的类型' }] }),
  );
  check(
    'AI 校验：省略 candidates / observations 视为空（不是错）',
    !validateThrows({}) && !validateThrows({ candidates: [], observations: [] }),
  );

  check(
    'AI 正文抽取：标准 choices[0].message.content',
    extractMessageContent({ choices: [{ message: { content: '{"candidates":[]}' } }] }) === '{"candidates":[]}',
  );
  check(
    'AI 正文抽取：分段 content 数组被拼接（部分网关这么返回）',
    extractMessageContent({ choices: [{ message: { content: [{ text: '{"a":' }, { text: '1}' }] } }] }) === '{"a":1}',
  );
  check(
    'AI 正文抽取：没有 choices → 抛错',
    (() => {
      try {
        extractMessageContent({});
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // ---- 12.7 映射文件的自校验（半坏的映射必须被当作「没有映射」） ----

  const goodMapping = { version: '1.0.0', pairId: 'p1', anchors: [], matches: [] };
  check('映射解析：合法映射被接受', parseMapping(goodMapping, 'p1')?.pairId === 'p1');
  check('映射解析：pairId 不匹配 → null（不能把别人的映射拿来用）', parseMapping(goodMapping, 'p2') === null);
  check('映射解析：版本不符 → null', parseMapping({ ...goodMapping, version: '9.9.9' }, 'p1') === null);
  check('映射解析：matches 不是数组 → null', parseMapping({ ...goodMapping, matches: 'x' }, 'p1') === null);
  check('映射解析：非对象 → null', parseMapping(null, 'p1') === null);
  check(
    '映射解析：缺失的可选数组被补成空数组（老文件也能读）',
    (() => {
      const parsed = parseMapping({ version: '1.0.0', pairId: 'p1', matches: [] }, 'p1');
      return !!parsed && parsed.anchors.length === 0 && parsed.ignoredDesignNodeIds.length === 0 && parsed.ignoredAppNodeIds.length === 0;
    })(),
  );

  // ---- 12.8 视觉特征（纯函数层） ----

  check(
    '视觉·ΔE00：同色为 0，黑白差异远大于阈值',
    Math.abs(deltaE00(rgbToLab({ r: 10, g: 20, b: 30 }), rgbToLab({ r: 10, g: 20, b: 30 }))) < 1e-9 &&
      deltaE00(rgbToLab({ r: 0, g: 0, b: 0 }), rgbToLab({ r: 255, g: 255, b: 255 })) > 50,
    `黑白 ΔE=${deltaE00(rgbToLab({ r: 0, g: 0, b: 0 }), rgbToLab({ r: 255, g: 255, b: 255 })).toFixed(1)}`,
  );
  check(
    '视觉·ΔE00：对称性（ΔE(a,b) === ΔE(b,a)）',
    Math.abs(deltaE00(rgbToLab({ r: 12, g: 200, b: 90 }), rgbToLab({ r: 200, g: 12, b: 90 })) - deltaE00(rgbToLab({ r: 200, g: 12, b: 90 }), rgbToLab({ r: 12, g: 200, b: 90 }))) < 1e-9,
  );
  check('视觉·汉明距离：同串为 0，全反为位数', hammingDistance('00000000', '00000000') === 0 && hammingDistance('0000', '1111') === 4);

  const decoded = decodePng(TINY_PNG);
  check(
    '视觉·PNG 解码：1×1 样本能解出 RGBA（纯 TS 解码器，不依赖 nativeImage 的通道顺序）',
    !!decoded && decoded.width === 1 && decoded.height === 1 && decoded.data.length === 4,
    decoded ? `${decoded.width}×${decoded.height} bytes=${decoded.data.length}` : '解码失败',
  );
  check('视觉·PNG 解码：非 PNG 字节返回 null 而不是抛错', decodePng(Buffer.from('绝对不是 PNG')) === null);

  const visualMap = new Map<string, MatchVisualMetrics>();
  for (const match of cleanMatches) {
    if (match.status !== 'matched') continue;
    const designNode = designDoc.nodes.find((node) => node.canonicalId === match.designNodeIds[0]);
    if (!designNode || designNode.participation === 'context') continue;
    // `unavailable` 缺省即「特征可用」；它一旦是**非空字符串**就会被判为不可用，
    // 所以可用态必须省略该字段，不能写成 false / 空串。
    visualMap.set(match.id, { colorDeltaE: 0.2, pHashDistance: 0, ssim: 1 });
  }
  const visualClean = gate({ visual: visualMap });
  check(
    '视觉·达标：ΔE / pHash / SSIM 全部达标 → 不产生颜色或视觉差异问题',
    !visualClean.issues.some((issue) => issue.check === 'color' || issue.check === 'visual-differs' || issue.check === 'asset-differs'),
    `verdict=${visualClean.verdict}`,
  );

  /** 给指定 match 注入「差得很明显」的视觉度量 */
  const withBadVisual = (target: NodeMatch, metrics: MatchVisualMetrics): Map<string, MatchVisualMetrics> => {
    const next = new Map(visualMap);
    next.set(target.id, metrics);
    return next;
  };

  const colorTarget = cleanMatches.find((match) => {
    const designNode = designDoc.nodes.find((node) => node.canonicalId === match.designNodeIds[0]);
    return match.status === 'matched' && designNode && designNode.participation !== 'context' && designNode.kind !== 'image' && designNode.kind !== 'icon';
  });
  check('夹具就绪：找到一条可用作颜色缺陷的匹配', !!colorTarget);
  if (colorTarget) {
    const colorResult = gate({ visual: withBadVisual(colorTarget, { colorDeltaE: 18, pHashDistance: 0, ssim: 1 }) });
    check(
      '视觉·颜色：ΔE=18 → 报 COLOR_DELTA_E_OVER_FAIL（P1）',
      colorResult.issues.some((issue) => issue.check === 'color' && issue.reasonCodes.includes('COLOR_DELTA_E_OVER_FAIL') && issue.severity === 'P1'),
      `verdict=${colorResult.verdict}`,
    );
    check('视觉·颜色：P1 → 结论 fail', colorResult.verdict === 'fail');

    // 中间档：3 < ΔE ≤ 6 只算「待复核」，不该把轻微色差直接判死。
    const colorReview = gate({ visual: withBadVisual(colorTarget, { colorDeltaE: 4.5, pHashDistance: 0, ssim: 1 }) });
    check(
      '视觉·颜色：4.5 落在复核区间 → 报 COLOR_DELTA_E_REVIEW（P2），不升级成 P1',
      colorReview.issues.some((issue) => issue.check === 'color' && issue.reasonCodes.includes('COLOR_DELTA_E_REVIEW') && issue.severity === 'P2') &&
        !colorReview.issues.some((issue) => issue.check === 'color' && issue.severity === 'P1'),
      `verdict=${colorReview.verdict}`,
    );
  }

  const assetTarget = cleanMatches.find((match) => {
    const designNode = designDoc.nodes.find((node) => node.canonicalId === match.designNodeIds[0]);
    return match.status === 'matched' && designNode && (designNode.kind === 'image' || designNode.kind === 'icon');
  });
  check('夹具就绪：找到一条图标 / 图片类匹配', !!assetTarget, assetTarget ? '已找到' : '样本里没有可用的图元');
  if (assetTarget) {
    const assetResult = gate({ visual: withBadVisual(assetTarget, { colorDeltaE: 0.5, pHashDistance: 30, ssim: 0.4 }) });
    check(
      '视觉·素材：图的 pHash / SSIM 不达标 → 走 asset-differs（「图换了」而不是「样子变了」）',
      assetResult.issues.some((issue) => issue.check === 'asset-differs' && issue.reasonCodes.includes('VISUAL_DIFFERS')),
      assetResult.issues.filter((issue) => issue.check === 'asset-differs' || issue.check === 'visual-differs').map((issue) => issue.check).join(',') || '无',
    );
  }

  /** 纯布局容器不该产出视觉结论：拿它去比会把容器底色差异误报成缺陷 */
  const contextMatch = cleanMatches.find((match) => {
    const designNode = designDoc.nodes.find((node) => node.canonicalId === match.designNodeIds[0]);
    return match.status === 'matched' && designNode?.participation === 'context';
  });
  if (contextMatch) {
    const contextResult = gate({ visual: withBadVisual(contextMatch, { colorDeltaE: 25, pHashDistance: 40, ssim: 0.1 }) });
    check(
      '视觉·容器豁免：participation=context 的纯布局容器不产出视觉问题',
      !contextResult.issues.some((issue) => issue.matchId === contextMatch.id && (issue.check === 'color' || issue.check === 'visual-differs' || issue.check === 'asset-differs')),
    );
  }

  const unavailableResult = gate({ visual: withBadVisual(cleanMatches[0]!, { unavailable: 'crop-below-min-size' }) });
  check(
    '视觉·不可用：特征不可用计入 unknown（不是 0 分 —— 0 分会被误判成「极其不像」）',
    unavailableResult.summary.unknownCount > 0 && unavailableResult.verdict !== 'pass',
    `unknown=${unavailableResult.summary.unknownCount} verdict=${unavailableResult.verdict}`,
  );

  // ---- 12.9 窗口尺寸不一致：可校准，但不能 PASS ----
  //
  // 用真实样本的原点当「SDK window 与截图差一条系统栏」的场景：差值只是一条平移，
  // 但每个节点的 x/y 都会跟着偏，几何结论整列失真。裁决必须停在待复核，
  // 而不是因为它「能校准」就放行成 PASS（那正是用户拿到假绿灯的路径）。

  const insetResult = gate({ windowSizeMismatch: true });
  check(
    '窗口尺寸：SDK window ≠ 截图 → 记一条 window-size 问题（P2）',
    insetResult.issues.some((issue) => issue.check === 'window-size' && issue.reasonCodes.includes('WINDOW_SIZE_MISMATCH')),
  );
  check('窗口尺寸：结论不是 pass（可校准 ≠ 可以放行）', insetResult.verdict !== 'pass', `verdict=${insetResult.verdict}`);
  check(
    '窗口尺寸：不把整份验收变成 blocked（文案 / 颜色等与坐标无关的结论仍然有效）',
    insetResult.verdict !== 'blocked',
    `verdict=${insetResult.verdict}`,
  );

  section('13. 接收协议（密钥 / 靶 / 截图 / 节点树 / 档位）');

  // ------------------------------------------------------------------
  // AcceptanceReceiver 是 SDK 与 Mac 之间**唯一**的信任边界：密钥校验、靶绑定、
  // 截图完整性、节点树合法性、采集档位全在这里把关。它也是这条链路里唯一
  // 「外部输入直通」的模块 —— 所以每一条拒绝路径都要有断言，
  // 否则「校验写错了」与「校验根本没被调用」在结果上无法区分。
  //
  // 与上一版的三点差别，正是这三组断言存在的理由：
  //  ① 密钥长期化（不再每次采集现生成）→ 目标归属改由「靶」表达；
  //  ② 靶一次性消费 → 必须断言「用过即失效」和「取消即撤销」；
  //  ③ **截图也从这个边界进来了**（以前是 Mac 自己 adb 抓的，不经过校验）→
  //     截图完整性成了新的攻击面，一条都不能少。
  // ------------------------------------------------------------------

  const receiver = new AcceptanceReceiver();
  // 0 让内核分配空闲端口，避免与真实运行中的应用抢 23458
  await receiver.start(0);
  const recvInfo = receiver.info();
  const recvBase = `http://127.0.0.1:${recvInfo.port}`;
  const recvUploadUrl = `${recvBase}/v1/acceptance/upload`;
  const recvPingUrl = `${recvBase}/v1/acceptance/ping`;
  const recvAuth = { Authorization: `Bearer ${recvInfo.token}` };

  interface RecvReply {
    error?: string;
    ok?: boolean;
    armed?: boolean;
    accepted?: boolean;
    nodeCount?: number;
    screenshotBytes?: number;
  }

  /** 直接打 HTTP —— 这一层不该依赖 SDK 侧的 fetch 实现 */
  const postJson = async (
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: RecvReply }> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as RecvReply };
  };

  const getJson = async (
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: RecvReply }> => {
    const response = await fetch(url, { headers });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as RecvReply };
  };

  /**
   * 声明尺寸与图片实际一致的合法截图。
   * `pngHeader` 只补到 IHDR —— 尺寸对账只用得上它，不必把真图塞进仓库。
   */
  const shot = (width: number, height: number) => ({
    mimeType: 'image/png' as const,
    width,
    height,
    base64: Buffer.from(pngHeader(width, height)).toString('base64'),
  });

  /** 一屏 1080×2400 的合法上传体；不合法的那几个字段由参数覆盖 */
  const makeRecvEnvelope = (
    overrides: {
      captureId?: string;
      protocol?: string;
      platform?: string;
      source?: string;
      nodes?: unknown[];
      collection?: Partial<CollectionQuality>;
      nodeCount?: number;
      windowWidth?: number;
      windowHeight?: number;
      screenshot?: unknown;
      /** 整个字段不出现 —— 「缺字段」和「字段是 undefined」在 JSON 里是两回事 */
      withoutScreenshot?: boolean;
    } = {},
  ): Record<string, unknown> => {
    const nodes = overrides.nodes ?? [
      {
        nodeId: 'n0',
        treePath: '0',
        parentId: null,
        className: 'android.widget.FrameLayout',
        depth: 0,
        index: 0,
        x: 0,
        y: 0,
        width: 1080,
        height: 2400,
        visible: true,
        clickable: false,
        enabled: true,
        clipsToBounds: true,
        alpha: 1,
        z: 0,
      },
    ];
    const envelope: Record<string, unknown> = {
      protocol: overrides.protocol ?? SDK_ACCEPTANCE_PROTOCOL,
      captureId: overrides.captureId ?? 'capture-1',
      sdkVersion: '0.1.0',
      snapshot: {
        platform: overrides.platform ?? 'android',
        source: overrides.source ?? 'react-native-ui-acceptance',
        timestamp: Date.now(),
        nodeCount: overrides.nodeCount ?? nodes.length,
        windowWidth: overrides.windowWidth ?? 1080,
        windowHeight: overrides.windowHeight ?? 2400,
        density: 3,
        densityDpi: 480,
        deviceModel: 'OPPO PGZ110',
        packageName: 'com.ehaier.zgq.shop.mall',
        nodes,
        collection: {
          profile: 'acceptance-full',
          requestedMaxDepth: 128,
          requestedMaxNodes: 30000,
          actualDepth: 1,
          actualNodeCount: nodes.length,
          depthLimitReached: false,
          nodeLimitReached: false,
          hiddenNodesIncluded: true,
          zeroSizeNodesIncluded: true,
          textIncluded: true,
          excludedNodes: [],
          ...overrides.collection,
        },
      },
    };
    if (!overrides.withoutScreenshot) {
      envelope.screenshot = overrides.screenshot ?? shot(1080, 2400);
    }
    return envelope;
  };

  /** 一行节点；拒绝路径的用例大多只关心「哪一项不合法」，几何给个最小值即可 */
  const flatNode = (
    nodeId: string,
    treePath: string,
    parentId: string | null,
    depth: number,
  ): Record<string, unknown> => ({
    nodeId,
    treePath,
    parentId,
    className: 'android.view.View',
    depth,
    index: 0,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    visible: true,
    clickable: false,
    enabled: true,
    clipsToBounds: true,
    alpha: 1,
    z: 0,
  });

  /**
   * 立靶并吞掉取消/超时的 rejection —— 测试只关心 HTTP 侧的拒绝码。
   *
   * ⚠️ `waitForUpload` 是**同步**立靶、异步等待：调用它的那一刻靶就已经立好了。
   */
  let recvPending: Promise<AcceptanceUpload | undefined> | null = null;
  /**
   * 返回 promise 而不是 void：需要拿结果的用例直接 await 返回值，
   * 不必去读 `recvPending` —— 后者在 TS 眼里可能还停在初值 `null` 上。
   */
  const arm = (): Promise<AcceptanceUpload | undefined> => {
    const pending = receiver
      .waitForUpload({ requirementId: 'req-recv', ttlMs: 10_000 })
      .catch(() => undefined);
    recvPending = pending;
    return pending;
  };
  const disarm = async (): Promise<void> => {
    receiver.cancelWait('测试收尾');
    await recvPending;
    recvPending = null;
  };

  /** 每条拒绝路径都是「立靶 → 上传 → 收尾」，避免靶残留污染下一条 */
  const expectRejected = async (body: unknown, status: number, label: string): Promise<void> => {
    arm();
    const response = await postJson(recvUploadUrl, body, recvAuth);
    await disarm();
    check(
      `接收协议：${label}`,
      response.status === status,
      `实际 ${response.status} · ${response.body.error ?? ''}`,
    );
  };

  // ---- 13.1 凭据形态 ----
  check('接收协议：密钥足够长（32 字节 hex = 64 字符）', recvInfo.token.length === 64, `实际 ${recvInfo.token.length}`);
  check(
    '接收协议：端口是内核分配的真实端口（不是写死的默认端口）',
    recvInfo.port > 0 && recvInfo.port !== 23458,
    `实际 ${recvInfo.port}`,
  );
  check('接收协议：初始没有接收靶（没立靶就不该收）', recvInfo.arm === null);

  const pingNoToken = await getJson(recvPingUrl);
  check('接收协议：ping 缺 Authorization → 401（不能默认放行）', pingNoToken.status === 401, `实际 ${pingNoToken.status}`);
  const pingBadToken = await getJson(recvPingUrl, { Authorization: 'Bearer wrong-token-0123456789' });
  check('接收协议：ping 错误密钥 → 401', pingBadToken.status === 401, `实际 ${pingBadToken.status}`);
  const pingOk = await getJson(recvPingUrl, recvAuth);
  check(
    '接收协议：ping 正确密钥 → 200（App 侧「测试连接」靠它）',
    pingOk.status === 200 && pingOk.body.ok === true,
    `实际 ${pingOk.status}`,
  );

  const recvNotFound = await getJson(`${recvBase}/v1/acceptance/nope`, recvAuth);
  check('接收协议：未知路径 → 404', recvNotFound.status === 404, `实际 ${recvNotFound.status}`);
  const recvWrongMethod = await postJson(recvPingUrl, {}, recvAuth);
  check('接收协议：ping 用 POST → 405', recvWrongMethod.status === 405, `实际 ${recvWrongMethod.status}`);

  // ---- 13.2 没有靶一律拒收 ----
  // 快照放错需求比没采到更难发现：它会以「某个页面明明没验过、却显示已验」的形态留在索引里。
  const recvNoArm = await postJson(recvUploadUrl, makeRecvEnvelope(), recvAuth);
  check('接收协议：没有立靶就上传 → 409', recvNoArm.status === 409, `实际 ${recvNoArm.status}`);
  check(
    '接收协议：无靶拒收的文案指向「先在验收页点开始接收」',
    (recvNoArm.body.error ?? '').includes('开始接收'),
    recvNoArm.body.error ?? '',
  );

  // ---- 13.3 立靶后正常接收 ----
  const recvWait = arm();
  const recvAccepted = await postJson(recvUploadUrl, makeRecvEnvelope({ captureId: 'capture-ok' }), recvAuth);
  check(
    '接收协议：立靶后上传 → 200 且 accepted',
    recvAccepted.status === 200 && recvAccepted.body.accepted === true,
    `实际 ${recvAccepted.status} · ${recvAccepted.body.error ?? ''}`,
  );
  check(
    '接收协议：回执带节点数与截图字节数（双方对账用）',
    recvAccepted.body.nodeCount === 1 && (recvAccepted.body.screenshotBytes ?? 0) > 0,
    `nodeCount=${recvAccepted.body.nodeCount} screenshotBytes=${recvAccepted.body.screenshotBytes}`,
  );

  const recvDelivered = await recvWait;
  recvPending = null;
  check('接收协议：等待方拿到的正是这一份上传', recvDelivered?.envelope.captureId === 'capture-ok');
  check(
    '接收协议：等待方顺带拿到已解码的截图字节（不必再解一次 base64）',
    (recvDelivered?.screenshot.byteLength ?? 0) > 0,
    `实际 ${recvDelivered?.screenshot.byteLength ?? 0}`,
  );
  check('接收协议：收到后状态变 received', receiver.status().state === 'received');

  const recvReplay = await postJson(recvUploadUrl, makeRecvEnvelope({ captureId: 'capture-ok' }), recvAuth);
  check(
    '接收协议：靶是一次性的 → 同一靶再传一次 → 409（连点两下不会写两份快照）',
    recvReplay.status === 409,
    `实际 ${recvReplay.status}`,
  );

  // ---- 13.4 取消等待会撤销靶 ----
  arm();
  await disarm();
  const recvAfterCancel = await postJson(recvUploadUrl, makeRecvEnvelope(), recvAuth);
  check(
    '接收协议：取消等待后靶被撤销 → 409（不能在用户已经放弃之后偷偷落盘）',
    recvAfterCancel.status === 409,
    `实际 ${recvAfterCancel.status}`,
  );

  // ---- 13.5 鉴权发生在读 body 之前 ----
  // 顺序是刻意的：反过来的话，攻击者可以用超大 body 逼服务端先分配 64MB 再谈鉴权。
  arm();
  const recvBadToken = await postJson(recvUploadUrl, makeRecvEnvelope(), {
    Authorization: 'Bearer wrong-token-0123456789',
  });
  check('接收协议：错误密钥 → 401', recvBadToken.status === 401, `实际 ${recvBadToken.status}`);
  const recvNoToken = await postJson(recvUploadUrl, makeRecvEnvelope());
  check('接收协议：缺少 Authorization → 401', recvNoToken.status === 401, `实际 ${recvNoToken.status}`);
  await disarm();

  // ---- 13.6 截图校验（新的攻击面：Mac 已不再自己截图）----
  await expectRejected(
    makeRecvEnvelope({ withoutScreenshot: true }),
    400,
    '缺少截图 → 400（缺了它这次上传没有任何底图）',
  );
  await expectRejected(
    makeRecvEnvelope({ screenshot: { ...shot(1080, 2400), mimeType: 'image/jpeg' } }),
    400,
    '截图不是 PNG → 400',
  );
  await expectRejected(
    makeRecvEnvelope({ screenshot: { ...shot(1080, 2400), width: 0 } }),
    400,
    '截图声明宽度为 0 → 400',
  );
  await expectRejected(
    makeRecvEnvelope({ screenshot: { ...shot(1080, 2400), base64: 'not base64 !!' } }),
    400,
    '截图 base64 含非法字符 → 400（Buffer.from 会静默丢弃非法字符，不能被它「修好」）',
  );
  await expectRejected(
    makeRecvEnvelope({ screenshot: { ...shot(1080, 2400), base64: 'AAAAA' } }),
    400,
    '截图 base64 长度不是 4 的倍数 → 400',
  );
  await expectRejected(
    makeRecvEnvelope({
      screenshot: { ...shot(1080, 2400), base64: Buffer.from('这不是 PNG').toString('base64') },
    }),
    400,
    '截图 base64 合法但不是 PNG → 400（文件头签名校验）',
  );

  // ---- 13.7 节点树 / 档位校验 ----
  await expectRejected(makeRecvEnvelope({ protocol: 'ui-acceptance-sdk-v1' }), 400, '协议版本不匹配 → 400');
  await expectRejected(makeRecvEnvelope({ platform: 'ios' }), 400, '来源平台不是 android → 400');
  await expectRejected(makeRecvEnvelope({ source: 'android-view-tree' }), 400, '来源不是 react-native-ui-acceptance → 400');
  await expectRejected(makeRecvEnvelope({ nodes: [] }), 400, '空节点树 → 400');
  await expectRejected(
    makeRecvEnvelope({ nodes: [flatNode('dup', '0', null, 0), flatNode('dup', '0.0', null, 1)] }),
    400,
    'nodeId 重复 → 400',
  );
  await expectRejected(
    makeRecvEnvelope({ nodes: [flatNode('p1', '0', null, 0), flatNode('p2', '0', null, 1)] }),
    400,
    'treePath 重复 → 400（归一化拿它做稳定主键）',
  );
  await expectRejected(
    makeRecvEnvelope({ nodes: [flatNode('o1', '0', null, 0), flatNode('o2', '0.0', 'missing', 1)] }),
    400,
    'parentId 悬空 → 400',
  );
  await expectRejected(
    makeRecvEnvelope({ nodes: [flatNode('c1', '0', 'c2', 0), flatNode('c2', '0.0', 'c1', 1)] }),
    400,
    '父子循环 → 400（拍平树时会死循环）',
  );
  await expectRejected(makeRecvEnvelope({ nodeCount: 7 }), 400, 'nodeCount 与 nodes.length 不符 → 400');

  await expectRejected(makeRecvEnvelope({ collection: { profile: 'legacy' } }), 400, '采集档位不是 acceptance-full → 400');
  await expectRejected(
    makeRecvEnvelope({ collection: { actualNodeCount: 99 } }),
    400,
    'collection.actualNodeCount 与 nodes.length 不符 → 400',
  );
  await expectRejected(
    makeRecvEnvelope({ collection: { depthLimitReached: true } }),
    400,
    '节点树被深度上限截断 → 400（截断的树不能当验收输入）',
  );
  await expectRejected(makeRecvEnvelope({ collection: { nodeLimitReached: true } }), 400, '节点树被数量上限截断 → 400');
  await expectRejected(
    makeRecvEnvelope({ collection: { requestedMaxDepth: 999 } }),
    400,
    '采集上限超出协议允许范围 → 400',
  );

  await expectRejected('this is not json', 400, 'body 不是 JSON → 400');
  await expectRejected('', 400, '空 body → 400');

  // ---- 13.8 纯函数：截图解码上限 ----
  // 这条路刻意走纯函数：造一份 32MB 的 base64 过一遍 HTTP，只为验证一条与网络无关的规则，
  // 代价是多花几秒并吃掉几十 MB 内存。
  check(
    '截图解码：超过 24MB 上限 → 抛（不留「大图悄悄占满内存」的口子）',
    (() => {
      // 长度刚过线即可，判定发生在解码之前 —— 不会真的分配 24MB 位图
      const huge = 'A'.repeat(Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4);
      try {
        decodeScreenshot({ mimeType: 'image/png', width: 1, height: 1, base64: huge });
        return false;
      } catch {
        return true;
      }
    })(),
  );
  check(
    '截图解码：合法 PNG 能解出字节',
    decodeScreenshot(shot(1080, 2400)).byteLength === pngHeader(1080, 2400).byteLength,
  );

  // ---- 13.9 归一化：截图与节点的对账 ----
  const recvNormalized = receiveAndroidSnapshot({
    envelope: makeRecvEnvelope() as unknown as AcceptanceSnapshotEnvelope,
    screenshot: pngHeader(1080, 2400),
  });
  check(
    '归一化：帧盒按截图真实尺寸算（1080×2400 px @480dpi → 360×800 dp）',
    recvNormalized.logicalWidth === 360 && recvNormalized.logicalHeight === 800,
    `实际 ${recvNormalized.logicalWidth}×${recvNormalized.logicalHeight}`,
  );
  check(
    '归一化：机型与包名来自上传（不再依赖 adb dumpsys）',
    recvNormalized.deviceModel === 'OPPO PGZ110' && recvNormalized.packageName === 'com.ehaier.zgq.shop.mall',
    `${recvNormalized.deviceModel} / ${recvNormalized.packageName}`,
  );
  check('归一化：SDK 窗口与截图一致时不记 coordinateInset', recvNormalized.coordinateInset === undefined);

  const recvInset = receiveAndroidSnapshot({
    envelope: makeRecvEnvelope({ windowHeight: 2280 }) as unknown as AcceptanceSnapshotEnvelope,
    screenshot: pngHeader(1080, 2400),
  });
  check(
    '归一化：SDK 窗口 ≠ 截图 → 记下差值并告警（几何结论降级待复核，而不是直接失败）',
    recvInset.coordinateInset?.sdkHeight === 2280 &&
      recvInset.coordinateInset?.screenshotHeight === 2400 &&
      (recvInset.warning ?? '').includes('不一致'),
    recvInset.warning ?? '',
  );
  check(
    '归一化：声明尺寸与图片实际不符 → 抛（说明编码或传输坏了，不能凑合用）',
    (() => {
      try {
        receiveAndroidSnapshot({
          envelope: makeRecvEnvelope({ screenshot: shot(1081, 2400) }) as unknown as AcceptanceSnapshotEnvelope,
          screenshot: pngHeader(1080, 2400),
        });
        return false;
      } catch {
        return true;
      }
    })(),
  );

  await receiver.stop();
  const recvAfterStop = await postJson(recvUploadUrl, makeRecvEnvelope(), recvAuth).then(
    () => false,
    () => true,
  );
  check('接收协议：停止后端口已释放', recvAfterStop);

  // 编号顺延到 14 而不是 11：上面两段（12 验收引擎 / 13 接收协议）要用 `view` 与
  // 配对元数据，而本段会把整个需求连同素材一起删掉 —— 所以它必须排在最后。
  // 段落编号在这里表示执行顺序，为了迁就编号把它提前，只会换来一串「对象已被删除」的假失败。
  section('14. 级联删除');

  // ---- 素材删除必须级联到配对与问题 ----
  // 只在索引里摘掉素材、留下引用它的配对，界面看起来是「对的」（卡片没了、画布也没了），
  // 但 index.json 里会攒下永远点不到、也永远删不掉的悬空配对。这条只能在这里按住。
  await mutateRequirement(requirement.id, (target) => {
    const design = target.designAssets[0]!;
    const appA = target.appSnapshots[0]!;
    const appB = target.appSnapshots[1]!;
    // 同一份设计稿对两张截图 —— 正是「删一张设计稿会带走多个配对」的场景
    target.pairs.push(
      {
        id: 'cascade-a',
        requirementId: requirement.id,
        designAssetId: design.id,
        appSnapshotId: appA.id,
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'cascade-b',
        requirementId: requirement.id,
        designAssetId: design.id,
        appSnapshotId: appB.id,
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    );
    target.issues.push({
      id: 'cascade-issue',
      requirementId: requirement.id,
      pairId: 'cascade-a',
      source: 'design',
      position: null,
      nodeId: null,
      category: 'layout',
      severity: 'P1',
      description: '级联删除夹具',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
  });

  const preCascade = (await getRequirement(requirement.id))!;
  const victimDesignId = preCascade.designAssets[0]!.id;
  const pairsOnVictim = preCascade.pairs.filter(
    (pair) => pair.designAssetId === victimDesignId,
  ).length;
  check(
    '夹具就绪：同一份设计稿被多个配对引用',
    pairsOnVictim >= 2,
    `实际 ${pairsOnVictim}`,
  );

  const cascadePlan = await mutateRequirement(requirement.id, (target) =>
    applyAssetDelete(target, 'design', victimDesignId),
  );
  check('删除素材返回 found', cascadePlan.found === true);
  check(
    '级联删除的配对数量 = 引用该素材的配对数',
    cascadePlan.pairIds.length === pairsOnVictim,
    `${cascadePlan.pairIds.length} / ${pairsOnVictim}`,
  );
  check('级联删掉了挂在被删配对上的问题', cascadePlan.issueCount >= 1, `实际 ${cascadePlan.issueCount}`);

  const postCascade = (await getRequirement(requirement.id))!;
  check('素材已从索引移除', postCascade.designAssets.every((asset) => asset.id !== victimDesignId));
  check(
    '没有任何配对再引用被删素材',
    postCascade.pairs.every((pair) => pair.designAssetId !== victimDesignId),
  );
  check(
    '没有任何问题再挂在被删配对下（悬空问题同样会留在索引里）',
    postCascade.issues.every((issue) => postCascade.pairs.some((pair) => pair.id === issue.pairId)),
  );
  check(
    '两侧引用都能解析的配对数 = 索引里的配对数（没有悬空配对）',
    postCascade.pairs.every(
      (pair) =>
        postCascade.designAssets.some((asset) => asset.id === pair.designAssetId) &&
        postCascade.appSnapshots.some((snapshot) => snapshot.id === pair.appSnapshotId),
    ),
  );
  const viewsAfterCascade = await buildPairViews(postCascade);
  check(
    '视图组装产出的配对数 = 索引里的配对数（没有条目被静默 continue 跳过）',
    viewsAfterCascade.length === postCascade.pairs.length,
    `${viewsAfterCascade.length} / ${postCascade.pairs.length}`,
  );

  // 幂等：删一个已经不在的素材不该抛错，也不该误删任何东西
  const beforeIdempotent = (await getRequirement(requirement.id))!;
  const again = await mutateRequirement(requirement.id, (target) =>
    applyAssetDelete(target, 'design', victimDesignId),
  );
  const afterIdempotent = (await getRequirement(requirement.id))!;
  check(
    '重复删除是幂等空操作（found=false 且不动任何数据）',
    again.found === false &&
      again.pairIds.length === 0 &&
      afterIdempotent.pairs.length === beforeIdempotent.pairs.length,
  );

  // 删截图同理：换一侧（app）走同一条路径，不能只有设计稿那侧级联。
  // 刻意挑**被配对引用过的**那张，否则「级联 0 个」也是绿的，等于没测。
  const victimSnapshot =
    afterIdempotent.appSnapshots.find((snapshot) =>
      afterIdempotent.pairs.some((pair) => pair.appSnapshotId === snapshot.id),
    ) ?? afterIdempotent.appSnapshots[0]!;
  const pairsOnSnapshot = afterIdempotent.pairs.filter(
    (pair) => pair.appSnapshotId === victimSnapshot.id,
  ).length;
  check('夹具就绪：挑中的截图确实被配对引用', pairsOnSnapshot >= 1, `实际 ${pairsOnSnapshot}`);
  const snapshotPlan = await mutateRequirement(requirement.id, (target) =>
    applyAssetDelete(target, 'app', victimSnapshot.id),
  );
  const afterSnapshotDelete = (await getRequirement(requirement.id))!;
  check(
    '删截图同样级联（截图侧不是只摘数组）',
    snapshotPlan.found === true &&
      afterSnapshotDelete.appSnapshots.every((snapshot) => snapshot.id !== victimSnapshot.id) &&
      afterSnapshotDelete.pairs.every((pair) => pair.appSnapshotId !== victimSnapshot.id) &&
      snapshotPlan.pairIds.length === pairsOnSnapshot,
    `${snapshotPlan.pairIds.length} / ${pairsOnSnapshot}`,
  );

  await deleteRequirement(requirement.id);
  check('需求已删除', (await getRequirement(requirement.id)) === null);

  console.log(
    skipped
      ? '\nSKIPPED（缺少样本）'
      : `\n${failed === 0 ? 'ALL PASS' : 'SOME FAILED'}  passed=${passed} failed=${failed}`,
  );
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    console.error('\n冒烟测试异常：', error);
    failed += 1;
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
    app.exit(skipped || failed === 0 ? 0 : 1);
  }
});
