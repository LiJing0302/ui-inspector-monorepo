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
  receiveSdkSnapshot,
  resolveDisplaySize,
  toLogical,
} from '../src/main/capture/androidCapture';
import { importFigmaPackage } from '../src/main/importer/figmaImport';
import { resolveAssetRequest } from '../src/main/protocol';
import {
  acceptanceGroundTruthPath,
  acceptanceMappingPath,
  appSnapshotDir,
  debugExportsDir,
  groundTruthExportsDir,
} from '../src/main/store/paths';
import {
  annotatedIds,
  buildPair,
  pairKeyOf,
  prefillFromMatches,
  removePair,
  submitBlocker,
  summarize,
  togglePending,
  upsertPair,
} from '../src/renderer/src/lib/calibration';
import {
  createRequirement,
  deleteRequirement,
  getRequirement,
  initWorkspace,
  mutateRequirement,
} from '../src/main/store/workspace';
import { applyAssetDelete, applyPairSave, buildPairViews } from '../src/main/verifyIpc';
import {
  AcceptanceReceiver,
  isLanClientAddress,
  type AcceptanceUpload,
} from '../src/main/capture/acceptanceReceiver';
import {
  extractMessageContent,
  aiCompletionOptions,
  getAiConfigStatus,
  saveAiConfig,
  testAiConnection,
  validateAiRegionDecision,
  validateAiRegionNodeMatches,
  validateAiRegionSegmentation,
  validateAiAppSegmentation,
  validateAiDesignRegionSearch,
  validateAiVisualSegmentation,
} from '../src/main/acceptance/ai';
import { ANNOTATION_PAGE_SIZE, buildPageAnnotations, buildRegionAnnotations } from '../src/main/acceptance/annotation';
import {
  buildVerticalCalibration,
  calibratedDesignY,
  canonicalizeApp,
  canonicalizeDesign,
  evaluateAcceptance,
  isCalibrationExtrapolated,
  matchDocuments,
} from '../src/main/acceptance/core';
import {
  agreementOf,
  buildEngineIndex,
  emptyAgreementCounts,
  statusOf,
} from '../src/main/acceptance/agreement';
import {
  applyAiRegionDecision,
  applyRegionOverrides,
  buildPageDocument,
  matchRegions,
} from '../src/main/acceptance/regions';
import { decodePng } from '../src/main/acceptance/png';
import { buildDebugPixelTransform } from '../src/main/acceptance/debugExport';
import { createAcceptanceService, evaluateReadiness } from '../src/main/acceptance/service';
import { parseMapping } from '../src/main/acceptance/store';
import {
  PIXEL_HOST_PROFILE_DEFAULT,
  PIXEL_HOST_PROFILES,
  createPixelTransformContract,
  pixelTransformRejectionReasons,
  projectDesignEdgesByProfile,
  projectDesignEdgesToAppPixels,
  projectDesignRectToAppPixels,
  projectDesignValueToLogical,
  snapPhysical,
  toPixelHostProfile,
} from '../src/main/acceptance/pixelTransform';
import type { PixelTransformContract } from '../src/types/acceptance';
// 版本常量从 types 取（`main/acceptance/pixelTransform` 的出口是「投影 + 哈希」，不重复导出常量）
import { PIXEL_TRANSFORM_VERSION } from '../src/types/acceptance';
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
  otherSource,
  parentContextOf,
  planCanvasClick,
  planCanvasHover,
  resolveActiveSide,
  selectionIdOf,
  type ClickCycle,
  type ClickOutcome,
  modsOf,
} from '../src/renderer/src/lib/selection';
import {
  appLayerHint,
  mergeAppBoxStyle,
  mergeAppNodes,
  stackOf,
  STACK_TOLERANCE,
} from '../src/renderer/src/lib/stack';
import {
  alignNotes,
  appLengthOrigin,
  buildCompareFields,
  pixelGridOf,
  sameCompareValue,
  scaleAppCorners,
  scaleAppLength,
  scaleAppSides,
  type AppAlignContext,
} from '../src/renderer/src/lib/comparison';
import {
  ANNOTATE_HINTS,
  BROWSE_HINTS,
  GESTURE_HINT,
  META_LABEL,
  hintsFor,
} from '../src/renderer/src/lib/shortcuts';
import { planMatchFocus } from '../src/renderer/src/lib/matchFocus';
import {
  MIN_MEASURE_GAP,
  formatMeasure,
  measureBetween,
  type MeasureLine,
} from '../src/renderer/src/lib/measure';
import type { Rect, VerifySource } from '../src/types/verify';
import {
  DEFAULT_WIPE_RATIO,
  MAX_WIPE_RATIO,
  MIN_OVERLAY_OPACITY,
  MIN_WIPE_RATIO,
  canOverlay,
  clampOverlayOpacity,
  clampWipeRatio,
  overlayOffsetFromDrag,
  wipeClipPath,
  wipeRatioFromX,
} from '../src/renderer/src/lib/compare';
// 「设计节点 → App 物理像素」面板块（2026-09-29）。断言只喂纯函数 + 源码文本：
// 它与验收判定链共用 `@shared/pixelTransform`，所以这里要守的是**不许出现第二份实现**。
import {
  appLengthToPixels,
  appPixelOrigin,
  appPixelRect,
  appSidesToPixels,
  designLengthToAppPixels,
  designPixelEdges,
  designPixelOrigin,
  measureLinesInPixels,
  pixelProjectionOf,
  pixelRows,
  pixelSummary,
  type PixelProjection,
} from '../src/renderer/src/lib/pixelProjection';
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
  appBorderChannel,
  appCornerChannel,
  formatAppCorners,
  formatAppEdgeColors,
  formatAppSides,
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
  normalizeSdkSnapshot,
  type AcceptanceSnapshotEnvelope,
  type SdkAppNode,
} from '../src/types/acceptance';
import type { MatchVisualMetrics, NodeMapping, NodeMatch, RegionMatch, UiRegion } from '../src/types/aiAcceptance';
import type { EngineAgreement, GroundTruthPair } from '../src/types/groundTruth';
import { annotationSeq, type RasterAnnotation } from '../src/renderer/src/lib/annotation';
import {
  canvasMaterialSignature,
  canvasScopeOf,
  dropCanvasSession,
  readCanvasField,
  writeCanvasField,
} from '../src/renderer/src/hooks/useCanvasSession';

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

/**
 * 读**本 monorepo 里其他包**的源码（从 app 目录往外走两级到仓库根）。
 *
 * 为什么冒烟要跨包读文件：节点样式（背景 / 边框 / 字体）横跨三个包 —— RN SDK 采、
 * 上传协议带、Mac 面板显示。任何一侧漏改都**不会报错**：面板只会显示一行「—」，
 * 看起来像「这个元素没有背景色」。这条契约必须有人钉，而它落不到任何一个单包测试里
 * （SDK 侧那份 Java 要真机才能跑）。
 *
 * 找不到文件时返回 `null`，断言随即失败 —— 冒烟本来就只在 monorepo 里跑，
 * 「读不到 SDK 源码」本身就是必须先解决的失败，不该被跳过。
 */
async function readPackageFile(relative: string): Promise<string | null> {
  for (const base of [process.cwd(), app.getAppPath()]) {
    const target = path.join(base, '..', '..', relative);
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
 * 去掉 CSS 注释后返回规则体。
 *
 * 存在的理由：`cssRuleBody` 取的是 `{ }` 之间的**原文**，注释也包含在内，
 * 于是「不许出现某属性」这类**否定断言**会被注释里的文字误伤 ——
 * 本项目偏偏喜欢在注释里写反例（「别改成 min/max-height」「cover 会裁掉……」），
 * 结果就是「代码是对的、断言红」。凡是否定断言一律先过这里。
 */
function cssRuleBodyCode(css: string, selector: string): string | null {
  const body = cssRuleBody(css, selector);
  return body === null ? null : body.replace(/\/\*[\s\S]*?\*\//g, '');
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
 * （`.pair-del,\n.card-del { … }`）一条都命中不了 ——
 * 样式明明写对了，断言却报 FAIL，比不写这条断言还糟。
 *
 * 同时排除前缀误命中：`.panel-tab.active` 不会匹配到 `.panel-tab.actived {`
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
  // ⭐ 2026-09-22：文本节点的类型角标**已移除**。它在元素左上角画一个字母 T，
  // 而文本是画布上最密的一类节点 —— 角标盖住的恰恰是核对对齐 / 间距 / 字号时最要看的
  // 那个角。类型信息在右侧信息面板、图层列表、标注图里都有，不需要在画布上再画一遍。
  // ⚠️ 断言按**规则体**查（不是正则查全文）：注释里提到这个类名不算数，
  // 只有真的写了一条规则才算（见 cssRuleBody 的说明）。
  check(
    '⭐ 文本节点不再画类型角标（选中 / hover 时左上角冒 T 会盖住元素本身）',
    canvasCss !== null &&
      cssRuleBody(canvasCss, '.node-overlay.text::before') === null &&
      !hasSelector(canvasCss, '.node-overlay.text::before'),
    canvasCss === null ? '❌ 读不到 verify.css' : '文本类型角标已移除',
  );
  // ⚠️ image::before 有**两条**规则（基础定位 + content），cssRuleBody 只取得到第一条，
  // 所以这里改成「选择器存在 + 全文有 content: 'I'」两条都成立才算。
  check(
    '图片类型角标保留（图片常是纯色 / 渐变块，需要角标区分「图片容器」与「布局容器」）',
    canvasCss !== null &&
      hasSelector(canvasCss, '.node-overlay.image::before') &&
      /content\s*:\s*'I'/.test(canvasCss),
    canvasCss === null ? '❌ 读不到 verify.css' : '图片角标仍在',
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
  const hintBarTsx = await readRendererFile('src/renderer/src/components/CanvasHintBar.tsx');
  const shortcutsTs = await readRendererFile('src/renderer/src/lib/shortcuts.ts');
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
  //   Esc → 上一层
  // 规则集中在 lib/selection（纯函数），组件里只允许调用。
  // ⚠️ 2026-09-28 按用户要求又删掉三条：⌥ 跳整帧、Enter 下一层、右键图层菜单。
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
  const stackTs = await readRendererFile('src/renderer/src/lib/stack.ts');
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
    // ⚠️ 2026-09-28：原先这条锁的是「⌥/Alt 单击跳到最外层容器」（09-22 从 ⌘ 换过来的），
    // 现按用户要求**整体删除**，于是断言反过来 —— 钉住它别被顺手加回来：
    // 纯函数里不能再有「取链尾」这条捷径，CanvasClick 里也不能再有 `outermost` 入口。
    '⭐ 「跳整帧」已彻底移除（纯函数里不许再有「取链尾」的捷径、CanvasClick 不许再有 outermost）',
    !/chain\[chain\.length - 1\]/.test(planClickBody) && !/\boutermost\b/.test(canvasClickBody),
    `链尾取值 ${planClickBody.match(/chain\[[^\]]*\]/)?.[0] ?? '无'} / CanvasClick 含 outermost=${/\boutermost\b/.test(canvasClickBody)}`,
  );

  check(
    'NodeCanvas 连落点与修饰键一起交出去（缺一个就判不了「原地再点」/「设成间距锚点」）',
    /onSelect\(\s*node,\s*\{ x: event\.clientX, y: event\.clientY \},\s*modsOf\(event\)\s*\)/.test(
      nodeCanvasTsx ?? '',
    ),
  );
  check(
    '⭐ hover 只交**命中 + 落点**（⌥ 删掉之后，hover 判定不再依赖任何修饰键）',
    /onHover\(\s*node,\s*\{ x: event\.clientX, y: event\.clientY \}\s*\)/.test(
      nodeCanvasTsx ?? '',
    ) && !/onHover\([^)]*modsOf/.test(nodeCanvasTsx ?? ''),
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
  // ⚠️ 2026-09-22：面板按「UI 验收同学只需要尺寸 / 文本字体 / 背景 / 边框」收敛，
  // 「可命中 / 有填充」这类**命中诊断**从面板撤出 —— 它们回答的是「为什么这个图层
  // hover 不到」，是改引擎时才要看的信息，画在面板里只会把真正要看的那四行挤出首屏。
  // 断言随之翻面：从「必须显示」改成「不得再显示」。判据本身没丢：`designNodeHittable` /
  // `appNodeHittable` 的行为用例仍在下面（1470 / 1525 / 1589），只是不再由面板背书。
  check(
    '⭐ 信息面板不再展示命中诊断（「可命中 / 有填充」已撤出，要看请去看导出包 / 冒烟）',
    !/label="可命中"/.test(infoPanelTsx ?? '') && !/label="有填充"/.test(infoPanelTsx ?? ''),
  );
  // ⚠️ 同一次收敛的另一半：拦的是**回流**。面板一涨回去，验收同学要的宽高 / 文案 /
  // 字体 / 颜色就又要滚动才看得见 —— 这正是本轮投诉（「内容太杂乱了」）的复现路径。
  // 判据给的是「这几个字段名一个都不许再出现」，而不是「行数不超过 N」：后者会被
  // 换个名字重新长回来。
  //
  // ⚠️ 必须带 `label=` / `title=` 前缀再匹配：这些词在**注释**里本来就该被提到
  //（「其余字段：图层 id / 深度 / 自动布局 … 不要往这个面板里加回来」），
  // 用裸词匹配会把自己的说明文字当成违规。
  const panelDiagnosticLeaks = [
    'label="nodeId"',
    'label="parentId"',
    'label="depth / index"',
    'label="hasVisualContent"',
    'label="clipsToBounds"',
    'label="图层 id"',
    'title="自动布局"',
    'label="混合模式"',
    'label="不透明度"',
    'label="已被裁剪"',
    'label="scroll x / y"',
  ].filter((key) => (infoPanelTsx ?? '').includes(key));
  check(
    '⭐ 信息面板只留那几组样式字段：诊断字段（id / 深度 / 状态位 / 布局 / 效果）不得回流',
    panelDiagnosticLeaks.length === 0 &&
      // 09-30 第二版：字段不再按「尺寸 / 文本 / 背景 / 边框」分块（`Group` 已删），
      // 全部打平成标签行。这里的守卫从「四个 Group 标题」改成「每类字段的代表行都在」：
      // 尺寸（宽度 / 高度）、文本（内容 / 字体 / 字号）、背景（背景色）、边框（描边色 / 圆角）。
      /<Row label="宽度"/.test(infoPanelTsx ?? '') &&
      /<Row label="高度"/.test(infoPanelTsx ?? '') &&
      /<Row label="内容"/.test(infoPanelTsx ?? '') &&
      /<Row label="字体"/.test(infoPanelTsx ?? '') &&
      /<Row label="字号"/.test(infoPanelTsx ?? '') &&
      /<Fills label="背景色"/.test(infoPanelTsx ?? '') &&
      /<Fills label="描边色"/.test(infoPanelTsx ?? '') &&
      /<Row label="描边宽度"/.test(infoPanelTsx ?? '') &&
      /<Row label="圆角"/.test(infoPanelTsx ?? ''),
    `残留字段：${panelDiagnosticLeaks.join(' / ') || '无'}`,
  );
  // 2026-09-28：面板内容区最顶部新增「开发环境专属的选中节点 id」（开发对号用）。守三件事：
  //  ① 它必须挂在 `import.meta.env.DEV` 上 —— 验收同学跑打包版，看到的还是那四组；
  //  ② 它有自己的容器类，不是 `label=` 形式的诊断行（后者由上面那条 leak 断言管）；
  //  ③ 样式类真在 verify.css 里（少了它就只是一行裸文本，开发时反而看不清）。
  // 生产构建里 `import.meta.env.DEV` 被静态替换成 false，整块会被摇掉、不进包。
  check(
    '⭐ 面板顶部的「选中节点 id」只在开发环境出现（摘掉 DEV 判定，id 就会漏进打包版）',
    /import\.meta\.env\.DEV/.test(infoPanelTsx ?? '') &&
      /className="info-dev-nodeid"/.test(infoPanelTsx ?? '') &&
      /\.info-dev-nodeid\b/.test(canvasCss ?? '') &&
      // 结构守卫：不许把它改成 `Row`（Row 是节点数据行的形状，id 属于开发诊断，不该混进去）
      !/<Row label="[^"]*节点 id"/.test(infoPanelTsx ?? ''),
    `jsx=${(infoPanelTsx ?? '').includes('className="info-dev-nodeid"')}`
      + ` css=${/\.info-dev-nodeid\b/.test(canvasCss ?? '')}`
      + ` devGate=${/import\.meta\.env\.DEV/.test(infoPanelTsx ?? '')}`,
  );

  // ---- 「App 物理像素」块**已移除**（2026-09-30，用户要求）----
  //
  // 该块（`PixelBlock`）2026-09-29 加：把选中的 Figma 节点投影成截图的物理像素，与 SDK 实测的
  // `pixelRect` 并排摆在面板顶部，供手动验收时肉眼对照。2026-09-30 用户要求移除 ——
  // 它与字段表摆的是**两把尺子**（块给物理 px、字段表给设计单位），同屏并排容易被读成
  // 「同一个数怎么有两个答案」；而判定链与字段表都不依赖它（口径切到 `pixel` 时字段表自己
  // 就给物理 px 读数）。移除落在四处：组件定义 / `pixelBlock` prop / 两处渲染位 / verify.css。
  //
  // ⚠️ 这条是**移除守卫**，不是「这块永远不许回来」：删掉的是 UI，不是「面板不许自己实现
  // 一份吸附」这条纪律。若日后要把这块加回来，请连这条断言一起改、并在注释里写清为什么 ——
  // 别把守卫直接删掉了事。（2026-09-29 的教训：面板类名抢了画布的 `.pixel-grid`，
  // 5 条**画布**断言变红，而且红得指错了地方。）
  const pixelLibTs = await readRendererFile('src/renderer/src/lib/pixelProjection.ts');
  /**
   * ⚠️ 测「代码里有没有第二份吸附」之前**必须先剥注释**：本仓注释密度极高，而且专门写
   * 「我为什么没这么做」—— `lib/pixelProjection.ts` 的模块注释里就原样写着
   * 「自己写一份 `Math.round(x · k)` 就会分叉」这句反例。拿原文匹配，这条断言 100% 假红
   * （2026-09-24 已在 `CaptureButton` / `UiAcceptanceLanDialog` 上各踩一次）。
   * 这里**只剥块注释**，不碰 `//`：`//` 规则会连模板串里的 `//` 一起吃掉（本仓有
   * `smacceptance://` 这种 URL），引号配平一乱就会跨行吞源码。
   */
  const stripBlockComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const panelTsxText = infoPanelTsx ?? '';
  check(
    '⭐ 面板已移除「App 物理像素」块：组件 / prop / 渲染位 / 样式四处都不再出现',
    !/const PixelBlock/.test(panelTsxText) &&
      !/pixelBlock/.test(panelTsxText) &&
      // 单侧视图那句「排在字段组之前」的位置注释也随块一起走（留着就是死锚点）
      !/「物理像素」块排在字段组/.test(panelTsxText) &&
      !/^\s*\.info-pixel/m.test(canvasCss ?? ''),
    `tsx=${/pixelBlock/.test(panelTsxText)} css=${/^\s*\.info-pixel/m.test(canvasCss ?? '')}`,
  );
  check(
    '⭐ 投影 / 差值全在 lib/pixelProjection：面板组件里没有第二份缩放',
    pixelLibTs !== null &&
      /from '@shared\/pixelTransform'/.test(pixelLibTs) &&
      /pixelTransformGeometry\(/.test(pixelLibTs) &&
      !/Math\.round\(/.test(stripBlockComments(pixelLibTs)),
    `lib=${pixelLibTs !== null}`
      + ` 自算=${/Math\.round\(/.test(stripBlockComments(pixelLibTs ?? ''))}`,
  );

  // ---- 面板纵向排布：全部打平、每行一条（2026-09-30 第二版定调）----
  //
  // 用户最终要求：不再按尺寸 / 文本 / 背景 / 边框分块（09-30 上午先收敛成「小节标题 +
  // 两列网格」，这版连标题都去掉）—— 所有字段一律是 `宽度 22` 这样的单行样式项，
  // diff 时同一行再并上另一侧（`宽度 22 20`）。防回退按「结构类存在 + 旧块结构消失」双管：
  //  ① `.info-fields`（单侧字段容器）在组件与 CSS 里都在；
  //  ② 旧的 `.info-group` / `.info-group-title` / `.info-group-body`（分组块、分节标题）
  //     在组件与 CSS 里**一个都不许回来** —— 回到「一块一块」的第一步就是重新引入其中任一个。
  //
  // 同时挖出并修掉一个**类名撞车**：字段行的空值修饰类原先就叫 `empty`，而 `verify.css`
  // 里有一条**全局** `.empty { padding: 40px 20px; … }`（页面级空态占位，四个页面在用）。
  // 两者特异性相同，靠源码顺序后者胜 —— 于是每个「空值行」被塞进 80px 上下内边距，实测
  // 一个空值行高 **113px**（正常 33px），整块面板白长 ~160px。对比表的空单元格同理（80px）。
  // 所以本轮把面板自己的修饰类统一加 `is-` 前缀。**这条断言就是防它回来**：
  // 「不许出现裸 `' empty'` 类名」比「行高不超过 N」可靠 —— 后者会被换个地方重新长出来。
  const fieldsCssRule = cssRuleBodyCode(canvasCss ?? '', '.info-fields');
  check(
    '⭐ 面板字段**全部打平**：不再按尺寸 / 文本 / 背景 / 边框分块（`.info-group*` 组件与 CSS 都不许回来）',
    /className="info-fields"/.test(panelTsxText) &&
      fieldsCssRule !== null &&
      /flex-direction:\s*column/.test(fieldsCssRule) &&
      !/<Group\b/.test(panelTsxText) &&
      !/'info-group'/.test(panelTsxText) &&
      !/\.info-group\b/.test(canvasCss ?? ''),
    `fields=${fieldsCssRule !== null} 组残留=${/<Group\b/.test(panelTsxText) || /'info-group'/.test(panelTsxText)}`,
  );
  // 对比表同样打平：三列一行（属性 | 设计稿 | App），旧的两列上下叠结构（compare-columns /
  // compare-field / compare-group）不许回来。
  check(
    '⭐ 对比表打平为「属性 | 设计稿 | App」三列一行（`.compare-columns` / `.compare-group` 不许回来）',
    /className="compare-table"/.test(panelTsxText) &&
      // ⚠️ 表头行是 `className="compare-row compare-head"`（两个类），不能拿
      // `className="compare-row"` 去匹配 —— 右引号对不上，永远是假红。
      /className="compare-row compare-head"/.test(panelTsxText) &&
      /compare-row\$\{changed \? ' changed' : ''\}/.test(panelTsxText) &&
      /className="compare-key"/.test(panelTsxText) &&
      !/compare-columns/.test(panelTsxText) &&
      !/compare-group/.test(panelTsxText) &&
      !/\.compare-columns\b/.test(canvasCss ?? '') &&
      !/\.compare-group\b/.test(canvasCss ?? ''),
  );
  // 09-30 用户要求：diff 差异**只靠红色**表达 —— 属性列不再标「不同 / 一致」文案、
  // 表头只标「设计稿 / App」不带节点名称。这条防它回来：`compare-status` / `appName`
  //  在面板里再出现任何一个，差异表达就退回「文案化」了。
  check(
    '⭐ 对比表差异只靠红色表达（2026-09-30）：无状态胶囊、表头无节点名称',
    !/compare-status/.test(panelTsxText) &&
      !/const appName/.test(panelTsxText) &&
      !/title=\{design\.name/.test(panelTsxText) &&
      // 红底那层还在：差异行仍然是「有 changed 才带 class」
      /compare-row\$\{changed \? ' changed' : ''\}/.test(panelTsxText),
    `胶囊=${/compare-status/.test(panelTsxText)} appName=${/const appName/.test(panelTsxText)}`,
  );
  check(
    '⭐ 面板修饰类一律带 `is-` 前缀：裸 `empty` 会撞上全局空态规则，把空值行撑到 ~113px',
    // 全局 `.empty` 必须还在（页面级空态在用），改的是面板这一侧
    /^\.empty\s*\{/m.test(canvasCss ?? '') &&
      !/' empty'/.test(panelTsxText) &&
      /' is-empty'/.test(panelTsxText) &&
      /` is-\$\{value\.state\}`/.test(panelTsxText) &&
      cssRuleBodyCode(canvasCss ?? '', '.info-row .row-val.is-empty') !== null &&
      hasSelector(canvasCss ?? '', '.compare-cell.is-empty'),
    `裸empty=${/' empty'/.test(panelTsxText)} 状态类=${/` is-\$\{value\.state\}`/.test(panelTsxText)}`,
  );

  // ---- 读数口径切换：「设计稿对齐 App」（2026-09-29）----
  //
  // 面板原来的长度读数一律是**设计单位**（设计稿是基准，App 值缩回设计基准）。而 UI 同学手上
  // 那张截图是 1080 px 宽的，拿设计单位去对截图得先心算一个 2.88 —— 这个开关让设计值直接投影
  // 成截图的物理像素，读数与截图同尺。四件事必须同时成立：
  //  ① 投影走 `@shared/pixelTransform` 的正式出口（与上面「不写第二份实现」同一条纪律）；
  //  ② 矩形走**分档投影**（`presnap` 按属性各自取整 / `raw` 按边界相减，见 2026-09-29 的
  //     `PixelHostProfile`）、标量走**单值投影** —— 共享层明令两者不可互换
  //     （`round(x·k) + round(w·k) ≠ round((x+w)·k)`）；
  //  ③ App 侧矩形**只认 `pixelRect`**，缺了就是「未采集」，不拿逻辑值反算（方案 §03）；
  //  ④ 切换器只在**单侧选中**时画：对比态下它对那张表没有任何影响，死按钮比不画更糟。
  check(
    '⭐ 读数口径「设计稿对齐 App」：设计 16 → 46 px、8 → 23 px（矩形与标量两条出口都在共享层）',
    (() => {
      const projection = pixelProjectionOf({
        scale: 375 / 360,
        designWidth: 375,
        appWidth: 360,
        pixelRatio: 3,
        pixelWidth: 1080,
      });
      if (!projection) return false;
      const edges = designPixelEdges({ rect: { x: 0, y: 0, width: 16, height: 16 } }, projection);
      return (
        edges.right - edges.left === 46 &&
        designLengthToAppPixels(16, projection) === 46 &&
        designLengthToAppPixels(8, projection) === 23 &&
        // 缺截图物理宽（老快照）→ 投影为 null，面板据此给一行说明而不是按默认口径静默显示
        pixelProjectionOf({ scale: 1, designWidth: 375, appWidth: 375 }) === null &&
        pixelProjectionOf(undefined) === null
      );
    })(),
  );
  check(
    '⭐ 读数口径：App 侧标量 8.67 dp × 3 = 26 px（乘密度）；矩形那条路归 `pixelRect` 管',
    (() => {
      const projection = pixelProjectionOf({
        scale: 1,
        designWidth: 390,
        appWidth: 390,
        pixelRatio: 3,
        pixelWidth: 1170,
      });
      return (
        projection !== null &&
        appLengthToPixels(8.67, projection) === 26 &&
        appLengthToPixels(51.67, projection) === 155
      );
    })(),
  );
  check(
    '⭐ 读数口径：两侧 render 都接 `pixelView`，调用点传**同一个** `pixelBasisView`',
    (panelTsxText.match(/pixelView\?: PixelProjection \| null,/g) ?? []).length === 2 &&
      /const pixelBasisView = alignBasis === 'pixel' \? projection : null;/.test(panelTsxText) &&
      /renderDesign\(selected\.node, pixelBasisView\)/.test(panelTsxText) &&
      /renderApp\(selected\.node, appAlign, pixelBasisView\)/.test(panelTsxText),
  );
  // 组件里不许出现第二份缩放：几何走 `designPixelEdges`（按宿主档位分派）、标量走
  // `designLengthToAppPixels`（单值投影），App 侧矩形走 `appPixelRect`（实测）、
  // 标量走 `appLengthToPixels`（乘密度）。两段单独切出来验，别扫全文 ——
  // 本文件别处合法地写着 `Math.round(`（`percent()`），全文匹配必假红。
  const renderDesignSrc = stripBlockComments(
    panelTsxText.slice(
      panelTsxText.indexOf('const renderDesign'),
      panelTsxText.indexOf('export const shortClassName'),
    ),
  );
  const renderAppSrc = stripBlockComments(
    panelTsxText.slice(panelTsxText.indexOf('const renderApp'), panelTsxText.indexOf('const CompareCell')),
  );
  check(
    '⭐ 读数口径：两个 render 段里没有自己写的缩放/取整，投影一律走 lib/pixelProjection',
    renderDesignSrc.length > 0 &&
      renderAppSrc.length > 0 &&
      !/Math\.round\(/.test(renderDesignSrc) &&
      !/Math\.round\(/.test(renderAppSrc) &&
      !/\* *scale/.test(renderDesignSrc) &&
      /designPixelEdges\(node, pixelView\)/.test(renderDesignSrc) &&
      /designLengthToAppPixels\(/.test(renderDesignSrc) &&
      /appPixelRect\(node\)/.test(renderAppSrc) &&
      /appLengthToPixels\(/.test(renderAppSrc),
    `段长=${renderDesignSrc.length}/${renderAppSrc.length}`,
  );
  check(
    '⭐ 读数口径切换器：单侧选中与**对比态**都画（对比表也随口径换读数，藏起开关就没法跑到那个口径）',
    /onAlignBasisChange && \(selected \|\| comparison\) && !spacingActive \? \(/.test(panelTsxText) &&
      /basis-option\$\{alignBasis === value \? ' on' : ''\}/.test(panelTsxText) &&
      /role="group" aria-label="读数口径"/.test(panelTsxText) &&
      // 对比态经 `basisBar` 传进 `NodeComparison`，排在 `compare-summary` 之前（控制项在结论之上）
      /basisBar=\{<>\{basisSwitcher\}\{basisNotice\}<\/>\}/.test(panelTsxText) &&
      panelTsxText.indexOf('{basisBar}') < panelTsxText.indexOf('<div className="compare-summary">'),
  );
  check(
    '⭐ 读数口径切换器：样式齐全（容器 / 标签 / 选项 / 选中态 / 不可投影时的说明）',
    ['.info-basis', '.info-basis-label', '.basis-options', '.basis-option', '.basis-option.on', '.info-basis-notice'].every(
      (selector) => new RegExp(`^\\${selector} \\{`, 'm').test(canvasCss ?? ''),
    ),
  );
  check(
    '⭐ 读数口径：口径说明按 basis 分叉（默认讲「缩回设计基准」，像素口径讲「投影成截图 px」）',
    (() => {
      const align: AppAlignContext = {
        scale: 375 / 360,
        designWidth: 375,
        appWidth: 360,
        pixelRatio: 3,
        pixelWidth: 1080,
      };
      const design = alignNotes(align, 'design');
      const pixel = alignNotes(align, 'pixel');
      // 缺截图物理宽时给空：组件那边另有 `basisNotice` 讲原因，这里再说「已按 px 读」就是假话
      const noPixelWidth = alignNotes({ scale: 1, designWidth: 375, appWidth: 375 }, 'pixel');
      return (
        design.some((line) => line.includes('换算到设计稿基准')) &&
        pixel.some((line) => line.includes('截图物理像素')) &&
        !pixel.some((line) => line.includes('换算到设计稿基准')) &&
        noPixelWidth.length === 0
      );
    })(),
  );
  check(
    '⭐ 读数口径：「这个数怎么来的」两个口径给不同算式（方向相反，不能共用一段）',
    (() => {
      const projection = pixelProjectionOf({
        scale: 1,
        designWidth: 375,
        appWidth: 360,
        pixelRatio: 3,
        pixelWidth: 1080,
      });
      if (!projection) return false;
      const design = designPixelOrigin(8, projection);
      const app = appPixelOrigin(8.67, projection);
      return (
        design.includes('设计 8') &&
        design.includes('pt') &&
        design.includes('px') &&
        app.includes('8.67') &&
        app.includes('26') &&
        // 像素口径的 App 侧说明**不能**复用「换算到设计稿基准」那一段：方向正好相反
        !app.includes('换算到设计稿基准')
      );
    })(),
  );

  // ---- 间距读数（选中一个元素后 hover 另一个：量两者之间差多少）----
  //
  // 2026-09-22 新增。几何在 lib/measure（纯函数，⑨ 段有数值用例），这里守三件事：
  //  ① 它必须画在**屏幕空间层**（线宽写多少就是多少，与各档框同理）；
  //  ② 层序是「选中框 → 读数 → 擦拭分隔线」：读数胶囊被描边压住就没法读了，
  //     而分隔线是唯一的拖拽把手，反过来被读数盖住等于拖不动；
  //  ③ 通道是打通的：CanvasBoard 出几何 → CanvasViewport 透传 → FrameRaster 画。
  //     「有 CSS 没渲染」与「有渲染没数据」都表现成「这个功能没生效」。
  const measureRule = canvasCss ? cssRuleBody(canvasCss, '.raster-measure') : null;
  check('.raster-measure 规则存在（间距读数由屏幕空间层承担）', measureRule !== null);
  check(
    '⚠️ 间距读数不做 --iz / --izs 反向补偿（出现即说明又被搬回 transform 层）',
    measureRule !== null && !/var\(--iz/.test(measureRule) && !/var\(--izs/.test(measureRule),
  );
  check(
    '间距读数是叶子、不吃点击（pointer-events: none）',
    measureRule !== null && /pointer-events\s*:\s*none/.test(measureRule),
  );
  check(
    '读数线粗细与节点描边**同源**（--node-ring-w）：两种墨粗细不一，用户会以为它是另一种东西',
    /\.raster-measure\.axis-x\s*\{[^}]*height:\s*var\(--node-ring-w\)/.test(canvasCss ?? '') &&
      /\.raster-measure\.axis-y\s*\{[^}]*width:\s*var\(--node-ring-w\)/.test(canvasCss ?? ''),
  );
  check(
    '读数线的 1px 靠 translate(-50%) 压在中线（坐标只有一个来源，不在 JS 里减半个线宽）',
    /\.raster-measure\.axis-x\s*\{[^}]*translateY\(-50%\)/.test(canvasCss ?? '') &&
      /\.raster-measure\.axis-y\s*\{[^}]*translateX\(-50%\)/.test(canvasCss ?? ''),
  );
  check(
    '读数两端有刻度（线落在两个元素**之间**，没有刻度就指不回被量的那两条边）',
    hasSelector(canvasCss ?? '', '.raster-measure::before') &&
      hasSelector(canvasCss ?? '', '.raster-measure::after'),
  );
  const measureLabelRule = canvasCss ? cssRuleBody(canvasCss, '.raster-measure > span') : null;
  check(
    '数字胶囊是**白底**（这一层永远压在内容与截图上，透明底在深色图上读不出来）',
    measureLabelRule !== null &&
      /background\s*:\s*#ffffff/i.test(measureLabelRule) &&
      /color\s*:\s*var\(--measure\)/.test(measureLabelRule),
  );
  check(
    '读数颜色有自己的变量（--measure），不与选中橙共用值 —— 改选中框颜色不该顺带改掉读数语义',
    /--measure\s*:\s*#[0-9a-f]{3,8}/i.test(canvasCss ?? '') &&
      !/--measure\s*:\s*var\(--selected\)/.test(canvasCss ?? ''),
  );
  // ⚠️ 比位置必须定位到**渲染点**，不能拿全文 indexOf：本仓注释密度极高，
  // 「读数排在选中框之上」这句说明本身就写在文件里，还带着 `.raster-measure` 这个选择器名
  // —— 全文 indexOf 会先命中注释，断言永远红（离线探针当场抓到过一次，见 uii-offline-probe）。
  // 用 `className=` 起头的模式只可能命中 JSX（注释里不会写这个形状）；
  // `(?:\{)?` 是因为两种写法都有：模板串（`className={\`raster-x …\`}`）与纯串（`className="raster-wipe"`）。
  // 尾部 `(?![\w-])` 是**必须**的：`.raster-measure` 是 `.raster-measure-lead`（延长段）的
  // 前缀，不加边界时「找读数线」会先命中延长段那个渲染点，两条位置断言都会拿到错的数。
  const renderPosOf = (needle: string): number =>
    (rasterTsx ?? '').search(new RegExp(`className=(?:\\{)?[\`"']${needle}(?![\\w-])`));
  const measurePos = renderPosOf('raster-measure');
  const selectionPos = renderPosOf('raster-selection');
  const wipePos = renderPosOf('raster-wipe');
  check(
    'FrameRaster 确实渲染了读数线，且层序是「选中框 → 读数 → 擦拭分隔线」',
    measurePos >= 0 &&
      selectionPos >= 0 &&
      wipePos >= 0 &&
      measurePos > selectionPos &&
      measurePos < wipePos,
    `measure=${measurePos} / selection=${selectionPos} / wipe=${wipePos}`,
  );
  check(
    '两侧独立读数通道打通：CanvasBoard 分侧出几何 → CanvasViewport 透传数组 → FrameRaster 按帧绘制',
    /measureBetween\(/.test(boardTsx ?? '') &&
      /measures=\{rasterMeasures\}/.test(boardTsx ?? '') &&
      /measures=\{measures\}/.test(viewportTsx ?? '') &&
      /measures\?:\s*RasterMeasure\[\]/.test(viewportTsx ?? '') &&
      /measures\?:\s*RasterMeasure\[\]/.test(rasterTsx ?? '') &&
      /\(measures\s*\?\?\s*\[\]\)\.flatMap/.test(rasterTsx ?? ''),
  );

  // ---- 读数线的虚线延长段（2026-09-22 晚新增）----
  //
  // 「读数线悬空的那一头」在画布上的样子，就是一条垂直于读数线的虚线接回元素的边。
  // 几何在 lib/measure（⑨ 段有数值用例），这里守两件事：
  //  ① 它**真的被画出来**（有几何没渲染 = 什么都没发生，本仓踩过「只补通道不改原通路」）；
  //  ② 它的几何换算与读数线**同源**（同一个 segmentStyle / 同一个投影）—— 各算一遍就会
  //     在屏幕上错开半像素，表现为「虚线没接上实线」。
  const leadRule = canvasCss ? cssRuleBody(canvasCss, '.raster-measure-lead') : null;
  check('.raster-measure-lead 规则存在（读数线的延长段由屏幕空间层承担）', leadRule !== null);
  check(
    '⚠️ 延长段同样不做 --iz / --izs 反向补偿、也不吃点击（本层在屏幕空间）',
    leadRule !== null &&
      !/var\(--iz/.test(leadRule) &&
      !/var\(--izs/.test(leadRule) &&
      /pointer-events\s*:\s*none/.test(leadRule),
    (leadRule ?? '❌ 缺规则').trim(),
  );
  check(
    '延长段与读数线**同一种墨**：线宽 --node-ring-w + 同色 var(--measure) + 虚线段（换色会被读成「另一条线在量别的东西」）',
    /\.raster-measure-lead\.axis-x\s*\{[^}]*border-top:\s*var\(--node-ring-w\)\s+dashed\s+var\(--measure\)/.test(
      canvasCss ?? '',
    ) &&
      /\.raster-measure-lead\.axis-y\s*\{[^}]*border-left:\s*var\(--node-ring-w\)\s+dashed\s+var\(--measure\)/.test(
        canvasCss ?? '',
      ),
  );
  const leadPos = renderPosOf('raster-measure-lead');
  check(
    'FrameRaster 确实渲染了延长段，且排在读数线**之前**（实线压在虚线上，端点连成一条）',
    leadPos >= 0 && leadPos < measurePos,
    `lead=${leadPos} / measure=${measurePos}`,
  );
  check(
    '⭐ 读数按来源各自配对：hover 只参与同侧选中项的读数，禁止跨帧几何',
    /rasterHover\?\.source\s*===\s*selection\.source/.test(boardTsx ?? '') &&
      /rasterSelections\.flatMap\(\(selection\)/.test(boardTsx ?? ''),
  );
  check(
    '⭐ 每侧锚点优先于该侧 hover；两侧的固定间距可同时显示',
    /rasterAnchors\.find\(\(item\)\s*=>\s*item\.source\s*===\s*selection\.source\)/.test(boardTsx ?? '') &&
      /anchor\s*\?\?\s*\(rasterHover\?\.source\s*===\s*selection\.source\s*\?\s*rasterHover\s*:\s*null\)/.test(boardTsx ?? ''),
  );

  // ---- ⌘ 固定间距（2026-09-22 新增）----
  //
  // 之前读数只跟着 hover 走：光标一移数字就没了，而核对间距时常常要盯着数字改稿子。
  // 每侧分别固定另一端，设计稿与 App 的读数可以同时保留。
  check(
    '⭐ 修饰键只剩 ⌘/Ctrl 一个（`modsOf` 返回里不许再有 alt —— 它随「跳整帧」一起删了）',
    modsOf({ metaKey: true, ctrlKey: false }).meta === true &&
      modsOf({ metaKey: false, ctrlKey: true }).meta === true &&
      modsOf({ metaKey: false, ctrlKey: false }).meta === false &&
      Object.keys(modsOf({ metaKey: true, ctrlKey: false })).length === 1,
    JSON.stringify(modsOf({ metaKey: false, ctrlKey: true })),
  );
  check(
    '⭐ 间距锚点按来源分别保存，不占用每侧的节点选中槽',
    // ⚠️ 2026-09-24：锚点改成**配对会话**里的字段（切 tab / 切配对回来时不丢），
    //    声明从 `useState<Record<…>>({…})` 变成 `useCanvasField<Record<…>>(scope, …)` ——
    //    「按来源分别保存」这条语义没变，断言改为钉住类型参数 + 写入形状。
    (boardTsx ?? '').includes('useCanvasField<Record<VerifySource, LayerSelection | null>>(') &&
      /\[node\.source\]: \{\s*source: node\.source,\s*id: node\.id\s*\}/.test(boardTsx ?? ''),
  );
  check(
    '⭐ 改选或清空只清理对应侧锚点；⌘ 再点可取消该侧锚点',
    /setMeasureAnchors\(\(prev\) => \(prev\[source\] === null \? prev : \{ \.\.\.prev, \[source\]: null \}\)\)/.test(boardTsx ?? '') &&
      /setMeasureAnchors\(\(prev\) => \(\{ \.\.\.prev, \[node\.source\]: null \}\)\)/.test(boardTsx ?? ''),
  );
  check(
    '⭐ ⌘ 设锚点看的是**同一侧**的槽（`selection[node.source]`），不是「主动侧」：设计稿选着一个、App 侧点一下变主动之后，回设计稿再按 ⌘ 仍该量设计稿那两个（看主动侧就会被判成「没有选中项」而退化成普通选中）',
    /const own = selection\[node\.source\];/.test(boardTsx ?? '') &&
      /if \(!own\) \{/.test(boardTsx ?? '') &&
      /sameAsAnchor \|\| selectionIdOf\(own\) === node\.id/.test(boardTsx ?? ''),
  );
  const anchorRule = cssRuleBody(canvasCss ?? '', '.raster-anchor');
  check(
    '锚点框与 hover / 选中框**同一套尺寸语义**（box-sizing: border-box）：三者指向同一节点时必须严格重合',
    anchorRule !== null && /box-sizing\s*:\s*border-box/.test(anchorRule),
    (anchorRule ?? '❌ 缺规则').trim(),
  );
  check(
    '锚点框用 `--measure`（与读数同色 =「读数那一端」），且**不含** --iz / --izs（本层在屏幕空间）',
    anchorRule !== null &&
      /--measure/.test(anchorRule) &&
      !/--izs?\b/.test(anchorRule),
    (anchorRule ?? '❌ 缺规则').trim(),
  );
  check(
    '锚点框排在读数**之前**（读数压住它没问题，反过来数字胶囊会被框盖掉）',
    rasterTsx !== null &&
      rasterTsx.search(/className=\{?['"`]raster-anchor/) >= 0 &&
      rasterTsx.search(/className=\{?['"`]raster-anchor/) <
        rasterTsx.search(/className=\{?['"`]raster-measure/),
    'raster-anchor → raster-measure',
  );
  check(
    '手势提示写了「⌘ 固定间距」（否则这个功能没人找得到）',
    // 2026-09-28：文案从 NodeInfoPanel 的局部常量搬到了 `lib/shortcuts.ts`
    // （面板 + 画布底部提示条共用一份），断言跟着指过去。
    /GESTURE_HINT[\s\S]{0,600}固定间距/.test(shortcutsTs ?? '') && /固定间距/.test(GESTURE_HINT),
    GESTURE_HINT,
  );

  // ---- 画布底部键位提示条（2026-09-28）----
  //
  // 起因：⌘ / ⌥ 这两类修饰键效果此前**只**写在右栏面板里，而那一行只在
  // 「已经选中一个节点、且没在量间距」时才显示 —— 对「我还不知道有这个功能」的人
  // 等于不存在（用户原话：画布底部加个快捷键提示）。
  //
  // 关键在于**文案只有一个来源**：09-22 把 ⌘ 从「选整帧」换成「固定间距」之后，
  // 面板空状态里那句「⌘/Ctrl 单击选整帧」没跟着改，挂了六天。
  // 所以下面的断言除了「有提示条」，还钉住「不许有第二份字面量」。
  check(
    '⭐ 画布底部常驻键位提示条（在 .canvas-area 里，不是浮在画布上的层）',
    /<CanvasHintBar mode=\{annotating \? 'annotate' : 'browse'\} \/>/.test(boardTsx ?? '') &&
      /\.canvas-hints\s*\{[^}]*flex\s*:\s*0 0 auto/.test(canvasCss ?? ''),
    /<CanvasHintBar[\s\S]{0,80}?\//.exec(boardTsx ?? '')?.[0] ?? '❌ CanvasBoard 里没渲染提示条',
  );
  check(
    '⭐ 提示条覆盖两类 ⌘ 效果：本侧固定间距 + 跨两侧元素对比（用户点名的两条）',
    BROWSE_HINTS.some((hint) => hint.keys.includes(META_LABEL) && /固定间距/.test(hint.label)) &&
      BROWSE_HINTS.some((hint) => hint.keys.includes(META_LABEL) && /对比/.test(hint.label)),
    BROWSE_HINTS.filter((hint) => hint.keys.includes(META_LABEL))
      .map((hint) => hint.label)
      .join(' / ') || '❌ 没有任何 ⌘ 条目',
  );
  check(
    '⭐ 提示里承诺的键，在实现里都找得到对应分支（文案与行为不许分叉）',
    BROWSE_HINTS.some((hint) => hint.keys.includes(META_LABEL)) &&
      /if \(mods\.meta\) \{/.test(boardTsx ?? '') &&
      // ⌥ 已删（2026-09-28）：提示里不许再出现它，实现里也不许再有它的分支
      !BROWSE_HINTS.some((hint) => hint.keys.some((key) => /⌥|Alt/.test(key))) &&
      !/mods\.alt/.test(boardTsx ?? ''),
  );
  check(
    '⭐ 键位文案只有一个来源：面板与提示条都 import lib/shortcuts，且 NodeInfoPanel 里再没有局部常量',
    /from '\.\.\/lib\/shortcuts'/.test(infoPanelTsx ?? '') &&
      /from '\.\.\/lib\/shortcuts'/.test(hintBarTsx ?? '') &&
      !/const GESTURE_HINT/.test(infoPanelTsx ?? ''),
  );
  check(
    '⭐ 三处被删的交互（⌥ 整帧 / Enter 进子节点 / 右键图层菜单）在提示与实现里都无残留',
    // ⚠️ 只匹配**代码特征**而不是词 —— 这些函数名/键名在文件注释里出现是正常的
    //    （注释正是在说明「某年某月删了它」）。本仓在「注释被自己断言命中」上栽过两次。
    !/mods\.alt/.test(boardTsx ?? '') &&
      !/ALT_LABEL/.test(shortcutsTs ?? '') &&
      !/<LayerInspectMenu/.test(boardTsx ?? '') &&
      !/onContextMenu=/.test(nodeCanvasTsx ?? '') &&
      !/onInspect=/.test(nodeCanvasTsx ?? '') &&
      !/⌘\/Ctrl 单击选整帧/.test(
        `${boardTsx ?? ''}${infoPanelTsx ?? ''}${hintBarTsx ?? ''}${shortcutsTs ?? ''}`,
      ),
  );
  check(
    '⭐ 提示条按模式换文案：标注态那一击是「加进待配对组」而不是「选中」',
    hintsFor('annotate') === ANNOTATE_HINTS &&
      hintsFor('browse') === BROWSE_HINTS &&
      ANNOTATE_HINTS.every((a) => !BROWSE_HINTS.some((b) => b.label === a.label)) &&
      ANNOTATE_HINTS.some((hint) => /待配对/.test(hint.label)),
    ANNOTATE_HINTS.map((hint) => hint.label).join(' / '),
  );
  check(
    '⭐ 每条提示都带完整说明（提示条要保持一眼扫完，细节走 title）',
    [...BROWSE_HINTS, ...ANNOTATE_HINTS].every((hint) => (hint.detail ?? '').length > 0),
    [...BROWSE_HINTS, ...ANNOTATE_HINTS]
      .filter((hint) => !hint.detail)
      .map((hint) => hint.label)
      .join(' / ') || '全都有',
  );

  // ---- 节点样式契约：RN SDK 采 → 上传协议带 → Mac 面板显示 ----
  //
  // 2026-09-22 补的能力。在此之前 App 侧只有几何与状态位，验收同学要看字号 / 背景色 /
  // 边框只能切回截图肉眼比对 —— 面板上永远是一排「—」。
  //
  // 补采集横跨三个包，**任何一侧漏改都不报错**，只会让面板安静地少几行。所以两端各钉一次：
  // SDK 侧确实在读这些属性，Mac 侧确实只做形状校验、不做单位换算。
  const sdkStyleReader = await readPackageFile(
    'packages/react-native-ui-acceptance/android/src/main/java/com/reactnative/uiacceptance/ViewStyleReader.java',
  );
  check(
    '⭐ SDK 侧确实在采样式（背景 / 边框 / 圆角走官方 getter，字体只能读 RN 挂在文本上的 span）',
    !!sdkStyleReader &&
      /BackgroundStyleApplicator\.getBackgroundColor/.test(sdkStyleReader) &&
      /BackgroundStyleApplicator\.getBorderWidth/.test(sdkStyleReader) &&
      /BackgroundStyleApplicator\.getBorderRadius/.test(sdkStyleReader) &&
      /CustomStyleSpan/.test(sdkStyleReader) &&
      /CustomLineHeightSpan/.test(sdkStyleReader),
    sdkStyleReader ? '已读到 ViewStyleReader.java' : '读不到 SDK 源码（包路径变了？）',
  );
  check(
    '⭐ SDK 侧把长度换算成 dp 之后再上报：字体三项按 scaledDensity 回算 —— 少了这一步，'
      + '面板上的字号会随用户调大的系统字体一起变大（同一份设计稿在两台机器上显示两个字号）',
    /logicalFromPx\([^)]*scaledDensity\)/.test(sdkStyleReader ?? ''),
  );

  // 归一化的行为断言：用一份**假的 SDK 上传体**真跑一遍 normalizeSdkSnapshot。
  // 密度给 480（= 3x），于是几何 330px → 110 逻辑值，而边框 1dp 必须**原样**还是 1。
  const styleNode = (overrides: Partial<SdkAppNode>): SdkAppNode => ({
    nodeId: 'n0',
    parentId: null,
    className: 'com.facebook.react.views.text.ReactTextView',
    depth: 0,
    index: 0,
    x: 0,
    y: 0,
    width: 330,
    height: 55,
    visible: true,
    clickable: false,
    enabled: true,
    clipsToBounds: false,
    alpha: 1,
    z: 0,
    ...overrides,
  });
  const styleCollection: CollectionQuality = {
    profile: 'acceptance-full',
    requestedMaxDepth: 128,
    requestedMaxNodes: 30000,
    actualDepth: 1,
    actualNodeCount: 3,
    depthLimitReached: false,
    nodeLimitReached: false,
    hiddenNodesIncluded: true,
    zeroSizeNodesIncluded: true,
    textIncluded: true,
    excludedNodes: [],
  };
  const styleNormalized = normalizeSdkSnapshot(
    {
      platform: 'android',
      source: 'react-native-ui-acceptance',
      timestamp: Date.now(),
      nodeCount: 3,
      windowWidth: 1080,
      windowHeight: 2400,
      density: 3,
      densityDpi: 480,
      nodes: [
        styleNode({
          nodeId: 'styled',
          style: {
            backgroundColor: '#e8542e',
            borderStyle: 'dashed',
            borderWidth: { top: 1, right: 1, bottom: 1, left: 1 },
            borderColor: { top: '#333333', right: '#333333', bottom: '#333333', left: '#333333' },
            borderRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
          },
          textStyle: {
            fontSize: 14,
            fontWeight: 600,
            fontStyle: 'normal',
            fontFamily: 'PingFang SC',
            lineHeight: 20,
            letterSpacing: 0.5,
            color: '#333333',
          },
        }),
        // 老 SDK：整个键都不存在（注意与下面的显式 null 是两回事）
        styleNode({ nodeId: 'legacy' }),
        // 新 SDK 明确告诉「这个节点没有盒样式 / 不是文本」
        styleNode({ nodeId: 'unstyled', style: null, textStyle: null }),
      ],
      collection: styleCollection,
    },
    1080,
    2400,
  );
  const [styleStyled, styleLegacy, styleUnstyled] = styleNormalized.nodes;
  check(
    '⭐ 样式值不参与 px → 逻辑值的换算：几何 330px ÷ 3 = 110，而边框 1dp 必须原样还是 1'
      + '（在归一化里给它补一次除法 = 边框凭空小到 1/3，而字号纹丝不动，极难查）',
    styleStyled?.width === 110 && styleStyled?.style?.borderWidth?.top === 1,
    `width=${styleStyled?.width} borderTop=${styleStyled?.style?.borderWidth?.top}`,
  );
  check(
    '字号不再被除一次密度（14 是 SDK 侧按 scaledDensity 回算好的 dp）',
    styleStyled?.textStyle?.fontSize === 14,
  );
  check(
    '文本样式完整带出：字重 600 不能被压成 700，fontFamily 原样（含空格）',
    styleStyled?.textStyle?.fontWeight === 600 && styleStyled?.textStyle?.fontFamily === 'PingFang SC',
    `${styleStyled?.textStyle?.fontWeight} / ${styleStyled?.textStyle?.fontFamily}`,
  );
  check('box 样式完整带出：背景色 / 边框样式 / 圆角',
    styleStyled?.style?.backgroundColor === '#e8542e' && styleStyled?.style?.borderStyle === 'dashed');
  check(
    '四边同宽 → 折叠成一个数（逐边画 1 / 1 / 1 / 1 会让验收同学以为这里四边不一样）',
    formatAppSides(styleStyled?.style?.borderWidth) === '1',
    String(formatAppSides(styleStyled?.style?.borderWidth)),
  );
  check('四角同值 → 折叠成一个数', formatAppCorners(styleStyled?.style?.borderRadius) === '8');
  // ---- 面板对比表：App 侧长度归一 + 容差判定（2026-09-28）----
  //
  // 画布把截图缩到与设计稿同宽（`CanvasBoard#appAlignScale`），面板此前却拿设备原值裸比
  // ⇒ 尺寸 / 边框组一片假红。实测 design 375 × iOS 402：裸比平均差 3.92pt（几乎全判「不同」），
  // 换算后 0.50pt。三条断言分别锁：归一确实生效、不归一时确实会红（证明不是把判定放水）、
  // 容差有边界（真差异不会被吞掉）。
  {
    const designFixture = {
      id: 'd', name: 'btn', type: 'FRAME',
      rect: { x: 0, y: 0, width: 48, height: 21 },
      cornerRadius: 8,
      strokeWeight: 1,
      fills: [],
      strokes: [],
    } as unknown as DesignNode;
    const appFixture = (overrides: Record<string, unknown> = {}): AppNode =>
      ({
        nodeId: 'a', className: 'com.x.View', parentId: null, depth: 0, index: 0,
        x: 0, y: 0, width: 51.67, height: 22.5,
        visibleX: 0, visibleY: 0, visibleWidth: 51.67, visibleHeight: 22.5,
        style: {
          backgroundColor: null,
          borderWidth: { top: 1, right: 1, bottom: 1, left: 1 },
          borderRadius: { topLeft: 8.667, topRight: 8.667, bottomRight: 8.667, bottomLeft: 8.667 },
        },
        ...overrides,
      }) as unknown as AppNode;
    const alignScaleFixture = 375 / 402;
    /** 与画布同源的换算上下文。只有 `withOrigin` 的调用才传 —— 用来验「这个小数哪来的」那段说明 */
    const alignOf = (scale: number): AppAlignContext => ({
      scale,
      designWidth: 375,
      appWidth: 402,
      pixelRatio: 3,
    });
    const fieldAt = (
      scale: number,
      label: string,
      design = designFixture,
      app = appFixture(),
      withOrigin = false,
      /**
       * 像素口径（2026-09-29 加）：给了就只换**显示值**，判定仍走 `scale` 那一套。
       * 缺省 `undefined` ⇒ 与加这个参数之前完全一致（老断言不必改）。
       */
      pixel?: PixelProjection | null,
    ) => {
      const found = buildCompareFields(
        design,
        app,
        scale,
        withOrigin ? alignOf(scale) : undefined,
        pixel,
      ).find((field) => field.label === label);
      if (!found) throw new Error(`对比表里找不到字段 ${label}`);
      return found;
    };

    check(
      '⭐ 归一：宽度 51.67 × (375/402) = 48.20 → 与设计稿 48 判「一致」（此前是假红）',
      sameCompareValue(fieldAt(alignScaleFixture, '宽度').design, fieldAt(alignScaleFixture, '宽度').app) === true,
      fieldAt(alignScaleFixture, '宽度').app.text,
    );
    check(
      '⭐ 不归一确实会判「不同」—— 证明修的是口径，不是把判定放水',
      sameCompareValue(fieldAt(1, '宽度').design, fieldAt(1, '宽度').app) === false,
    );
    check(
      '⭐ 圆角：8.667 × (375/402) = 8.08（先乘再折 2 位）→ 判「一致」，App 列显示归一后的 8.08',
      sameCompareValue(fieldAt(alignScaleFixture, '圆角').design, fieldAt(alignScaleFixture, '圆角').app) === true
        && fieldAt(alignScaleFixture, '圆角').app.text === '8.08',
      fieldAt(alignScaleFixture, '圆角').app.text,
    );
    check(
      '容差有边界：差 0.5 以内算一致，超过就报出来（10 vs 10.5 一致、10 vs 11.5 不同）',
      sameCompareValue(
        { text: '10', key: '10', state: 'value', numbers: [10] },
        { text: '10.5', key: '10.5', state: 'value', numbers: [10.5] },
      ) === true
        && sameCompareValue(
          { text: '10', key: '10', state: 'value', numbers: [10] },
          { text: '11.5', key: '11.5', state: 'value', numbers: [11.5] },
        ) === false,
    );
    check(
      '非长度字段不带 numbers ⇒ 仍走 key 严格相等（颜色差一个 hex 不能因容差被放过）',
      sameCompareValue(
        { text: '#e8542e', key: '#e8542e', state: 'value' },
        { text: '#e8542f', key: '#e8542f', state: 'value' },
      ) === false,
    );
    check(
      '三态不被换算破坏：style 整组没读 → 「未采集」；读了但没圆角 → 「—」，都不是 NaN',
      (() => {
        const legacyCorner = fieldAt(alignScaleFixture, '圆角', designFixture, appFixture({ style: undefined }));
        const bareCorner = fieldAt(
          alignScaleFixture,
          '圆角',
          { ...designFixture, cornerRadius: undefined } as unknown as DesignNode,
          appFixture({ style: { backgroundColor: null, borderRadius: { topLeft: null, topRight: null, bottomRight: null, bottomLeft: null } } }),
        );
        return legacyCorner.app.state === 'unavailable' && bareCorner.app.state === 'empty' && bareCorner.app.text === '—';
      })(),
    );

    // ---- 设计侧 `cornerRadius: null` 不许把整块面板带走（2026-09-29）----
    //
    // 类型上是 `number | number[] | undefined`，**没有任何生产者会写 null**（Figma 侧
    // `serialize.ts` 只在 `!== undefined` 时落这个键；真实快照 609 个设计节点里
    // 348 个 number + 16 个 array、零个 null）。所以这不是已知线上问题。
    //
    // 但 `cornerKey` 曾是**全文件唯一漏挡 null** 的那一个 —— 同位字段的 `cornerSlots`(339)
    // 与 `cornerRadiusLabel`(56) 都挡了。漏挡的代价不是「显示不准」而是**整块面板消失**：
    // `null.toFixed` 抛在 render 期，React 18 直接把整棵树卸载，症状是「点了没反应」，
    // 且堆栈指向 `round2` 而不指向真正漏判的那一行。这条断言走**行为**（真的调一次），
    // 不是查源码里有没有 `|| value === null` —— 那种文本断言改个写法就假绿。
    check(
      '设计侧 cornerRadius 为 null 时对比表不抛（防御一致性；漏挡会让节点信息面板整个消失）',
      (() => {
        try {
          // ⚠️ 比的对象必须是「`cornerRadius` 缺失（undefined）」那一份，**不是**默认夹具 ——
          // 默认夹具的圆角是 8，键为 '8'，拿它做对照是恒假的红（2026-09-29 实际踩到）。
          // 这里要证的是「null 与 undefined 同口径」，不是「null 与有值同口径」。
          const nullField = fieldAt(
            alignScaleFixture,
            '圆角',
            { ...designFixture, cornerRadius: null } as unknown as DesignNode,
          );
          const undefinedField = fieldAt(
            alignScaleFixture,
            '圆角',
            { ...designFixture, cornerRadius: undefined } as unknown as DesignNode,
          );
          return (
            nullField.design.key === '' &&
            nullField.design.key === undefinedField.design.key &&
            nullField.design.text === undefinedField.design.text
          );
        } catch {
          return false;
        }
      })(),
    );

    // ---- 单侧 App 视图 / 重合层小字：与对比表必须是**同一个数**（2026-09-28）----
    //
    // 同一个元素在面板上有两个入口：只选一侧时走单节点字段（`renderApp`），两侧都选中时走
    // 对比表。两处各乘各的（或一处乘一处不乘），同一个元素点开两次就会看到两个都「对」却
    // 互相打架的数（51.67 vs 48.2）。这几条锁的是**跨入口一致性**——具体数值上面已锁过。
    const fixtureCorners = appFixture().style!.borderRadius;
    check(
      '⭐ 单侧视图与对比表同一个圆角：8.667 → 两处都是 8.08（既不是设备原值 8.67，也不是 8.09）',
      formatAppCorners(scaleAppCorners(fixtureCorners, alignScaleFixture)) === '8.08'
        && formatAppCorners(scaleAppCorners(fixtureCorners, alignScaleFixture))
          === fieldAt(alignScaleFixture, '圆角').app.text,
      String(formatAppCorners(scaleAppCorners(fixtureCorners, alignScaleFixture))),
    );
    check(
      '⭐ 单侧视图的宽度走同一个出口：51.67 × (375/402) = 48.2（与对比表 App 列同一串）',
      String(scaleAppLength(appFixture().width, alignScaleFixture)) === fieldAt(alignScaleFixture, '宽度').app.text,
      String(scaleAppLength(appFixture().width, alignScaleFixture)),
    );
    check(
      '长度换算的三态与折位：undefined / null 原样透传（不能卷成 NaN），数值折到 2 位',
      scaleAppLength(undefined, alignScaleFixture) === undefined
        && scaleAppLength(null, alignScaleFixture) === null
        && scaleAppLength(51.666666666666664, alignScaleFixture) === 48.2
        && scaleAppSides(undefined, alignScaleFixture) === undefined
        && scaleAppCorners(undefined, alignScaleFixture) === undefined,
    );
    check(
      '重合层小字（appLayerHint）与面板同尺：换算后圆角 8.08；缺省 scale=1 仍是设备原值 8.67',
      appLayerHint(appFixture(), alignScaleFixture).includes('圆角 8.08')
        && appLayerHint(appFixture()).includes('圆角 8.67'),
      `${appLayerHint(appFixture(), alignScaleFixture)} | ${appLayerHint(appFixture())}`,
    );

    // ---- 「这个小数从哪来」：面板要能自证口径（2026-09-28）----
    //
    // 显示值 8.08 与设计稿的 8 之间隔着两步（等比缩放 + 物理像素吸附），不写出来就会被读成
    // 「开发把圆角做错了」。这几条锁那段说明的**内容**：它必须真的推出 26/3；推不出时
    // （没像素比、值没落在网格上）**不许编** —— 一段编出来的来历比没有来历更糟。
    check(
      '⭐ 物理像素判据：3x 屏上 8.667 × 3 = 26.001 → 认成 26 个像素（即 8.667 = 26 / 3）',
      pixelGridOf(8.666666984558105, 3)?.px === 26,
      JSON.stringify(pixelGridOf(8.666666984558105, 3)),
    );
    check(
      '不许猜：8.25 × 3 = 24.75、11.83 × 3 = 35.5 都没落格 ⇒ 不推 k/pr（它们是布局算式的产物）',
      pixelGridOf(8.25, 3) === null && pixelGridOf(11.833333333333334, 3) === null,
      `${JSON.stringify(pixelGridOf(8.25, 3))} / ${JSON.stringify(pixelGridOf(11.83, 3))}`,
    );
    check(
      '没有像素比（老快照没采 pixelWidth）时不编物理像素：只说设备值 + 换算系数',
      (() => {
        const origin =
          appLengthOrigin(8.667, { scale: alignScaleFixture, designWidth: 375, appWidth: 402 }) ?? '';
        return origin.includes('设备值 8.67 pt') && !origin.includes('26 / 3') && origin.includes('= 8.08');
      })(),
      appLengthOrigin(8.667, { scale: alignScaleFixture, designWidth: 375, appWidth: 402 }) ?? '(无)',
    );
    check(
      '两侧同宽（scale=1）且推不出物理像素 ⇒ 这段说明与显示值一模一样，返回 undefined 别给废话',
      appLengthOrigin(8.667, { scale: 1, designWidth: 375, appWidth: 375 }) === undefined,
    );
    check(
      '⭐ 来历三段齐：设备值 = 26/3 → 吸附算式（设计 8 × 1.072 × 3 = 25.73px → 26px）→ 换算回设计基准含差',
      (() => {
        const origin = fieldAt(alignScaleFixture, '圆角', designFixture, appFixture(), true).app.origin ?? '';
        return (
          origin.includes('设备值 8.67 pt = 26 / 3')
          && origin.includes('吸附：设计 8 × 1.072 × 3 = 25.73 px → 26 px')
          && origin.includes('× 375 / 402 = 8.08')
          && origin.includes('差 0.08')
        );
      })(),
      fieldAt(alignScaleFixture, '圆角', designFixture, appFixture(), true).app.origin ?? '(无)',
    );
    check(
      // ⚠️ 拿「填充」而不是「内容」来验「非长度字段没有来历」：**「文本」整组在两侧都没有文本时
      // 会被过滤掉**（`buildCompareFields` 末尾那个 hasText filter），拿它做靶子会抛
      // 「找不到字段」把后面的断言全带停（踩过一次）。
      '尺寸类字段也有来历；颜色这类没有（不是长度，没有基准可换算）',
      fieldAt(alignScaleFixture, '宽度', designFixture, appFixture({ width: 155 / 3 }), true)
        .app.origin?.includes('设备值 51.67 pt = 155 / 3') === true
        && fieldAt(alignScaleFixture, '填充', designFixture, appFixture(), true).app.origin === undefined,
      fieldAt(alignScaleFixture, '宽度', designFixture, appFixture({ width: 155 / 3 }), true).app.origin ?? '(无)',
    );
    check(
      '四角不全等时不给来历（行上是折叠串 8.67 / 2，只解释一角会把读者带偏）',
      fieldAt(
        alignScaleFixture,
        '圆角',
        designFixture,
        appFixture({
          style: {
            backgroundColor: null,
            borderRadius: { topLeft: 8.667, topRight: 8.667, bottomRight: 8.667, bottomLeft: 24 },
          },
        }),
        true,
      ).app.origin === undefined,
    );
    check(
      '⭐ 吸附算式只在「确实像 w() 产物」时写：55 = 165/3 确实落格，但设计 50 推不出它'
        + '（差值 4.2px 远超吸附上限 0.5px）⇒ 不写，免得读成「吸附偏了 4 像素」（真相是字号走了 sp()）',
      (() => {
        const origin = appLengthOrigin(55, alignOf(alignScaleFixture), 50) ?? '';
        return origin.includes('设备值 55 pt = 165 / 3') && !origin.includes('吸附：');
      })(),
      appLengthOrigin(55, alignOf(alignScaleFixture), 50) ?? '(无)',
    );
    check(
      '常驻口径说明：两侧同宽时为空（没有换算就没有要解释的小数）；有换算时给出系数与像素网格',
      alignNotes({ scale: 1, designWidth: 375, appWidth: 375 }).length === 0
        && alignNotes(alignOf(alignScaleFixture))[0].includes('× 375 / 402 = 0.9328')
        && alignNotes(alignOf(alignScaleFixture))[1].includes('1 px = 0.3333 pt'),
      alignNotes(alignOf(alignScaleFixture)).join(' | '),
    );

    // ---- 对比表也随读数口径换成 px（2026-09-29 第二次收敛）----
    //
    // 需求原话是「节点 diff 也要展示物理像素单位」。这里守三件事：
    //  ① 显示值真的换了（设计侧走边界投影、App 侧乘密度），且默认口径一字未动（回归闸门）；
    //  ② **判定一个都没变** —— `numbers` 与结论都必须与默认口径逐位一致。这是这次改动的
    //     核心约束：换的是尺子，不是验收标准（`replay:gt` 验过的那条结论不许被顺手改掉）；
    //  ③ 投影不可用（老快照）时退回设计单位，而不是把表格整片变成「未采集」。
    const pixelOf = (pixelWidth: number): PixelProjection | null =>
      pixelProjectionOf({
        scale: alignScaleFixture,
        designWidth: 375,
        appWidth: 402,
        pixelRatio: 3,
        pixelWidth,
      });
    /**
     * 09-30 真实用例的投影上下文（盲盒抽奖「10年管家开通前」）：基准 375 / 窗口 360 dp / 截图 1080 px。
     * 总倍率 = 3 × 360 / 375 = **2.88** —— 下面「设计间距 7 → presnap 20 / raw 21」这条就是它。
     * `hostProfile` 缺省走默认档（`presnap`），显式传 `'raw'` 用来钉「旧口径 = raw」。
     */
    const realProjectionOf = (hostProfile?: 'presnap' | 'raw'): PixelProjection | null =>
      pixelProjectionOf({
        scale: 2.88,
        designWidth: 375,
        appWidth: 360,
        pixelRatio: 3,
        pixelWidth: 1080,
        ...(hostProfile ? { hostProfile } : {}),
      });
    check(
      '⭐ 对比表随口径换 px：设计宽 48 → **154**（边界投影）、App 宽 51.67 → **155**（× 3 乘密度）',
      (() => {
        const pixel = pixelOf(1206);
        if (!pixel) return false;
        // 1206 / 375 = 3.216 ⇒ round(48 × 3.216) = 154；round(51.67 × 3) = 155
        return (
          fieldAt(alignScaleFixture, '宽度', designFixture, appFixture(), false, pixel).design.text === '154' &&
          fieldAt(alignScaleFixture, '宽度', designFixture, appFixture(), false, pixel).app.text === '155' &&
          // App 侧四槽也逐槽换算（同一个出口：`appSidesToPixels`）—— 1 dp × 3 = 3 px，四边同值仍折成一个数
          formatAppSides(appSidesToPixels(appFixture().style!.borderWidth, pixel)) === '3' &&
          // 默认口径一字未动
          fieldAt(alignScaleFixture, '宽度').design.text === '48' &&
          fieldAt(alignScaleFixture, '宽度').app.text === '48.2'
        );
      })(),
      (() => {
        const pixel = pixelOf(1206);
        if (!pixel) return '(投影为 null)';
        return `${fieldAt(alignScaleFixture, '宽度', designFixture, appFixture(), false, pixel).design.text}`
          + ` / ${fieldAt(alignScaleFixture, '宽度', designFixture, appFixture(), false, pixel).app.text}`;
      })(),
    );
    check(
      '⭐ 换口径**不改判定**：对比表在两种口径下 `numbers` 与「一致 / 不同」逐字相同（换尺子不换标准）',
      (() => {
        const pixel = pixelOf(1206);
        if (!pixel) return false;
        const labels = ['宽度', '高度', '描边宽度', '圆角'];
        return labels.every((label) => {
          const base = fieldAt(alignScaleFixture, label);
          const px = fieldAt(alignScaleFixture, label, designFixture, appFixture(), false, pixel);
          return (
            // 显示值确实换了（圆角 8 → 26 这种；宽度 48 → 154）
            px.design.text !== base.design.text &&
            px.app.text !== base.app.text &&
            // 判定依据逐位相同
            JSON.stringify(px.design.numbers) === JSON.stringify(base.design.numbers) &&
            JSON.stringify(px.app.numbers) === JSON.stringify(base.app.numbers) &&
            sameCompareValue(px.design, px.app) === sameCompareValue(base.design, base.app)
          );
        });
      })(),
    );
    check(
      '⭐ 对比表 px 口径下**设计侧也有来历**（「设计 8 × 402 / 375 = 8.58 pt → × 3 = 25.73 px → 26 px」）',
      (() => {
        const pixel = pixelOf(1206);
        if (!pixel) return false;
        const origin =
          fieldAt(alignScaleFixture, '圆角', designFixture, appFixture(), true, pixel).design.origin ?? '';
        return origin.includes('设计 8') && origin.includes('26 px') && origin.includes('pt');
      })(),
      (() => {
        const pixel = pixelOf(1206);
        return pixel
          ? fieldAt(alignScaleFixture, '圆角', designFixture, appFixture(), true, pixel).design.origin ?? '(无)'
          : '(投影为 null)';
      })(),
    );
    check(
      '⭐ 投影不可用（老快照没有截图物理像素宽）→ 对比表退回设计单位，不是整片「未采集」',
      fieldAt(alignScaleFixture, '宽度', designFixture, appFixture(), false, null).design.text === '48' &&
        fieldAt(alignScaleFixture, '宽度', designFixture, appFixture(), false, null).app.text === '48.2',
    );
    check(
      '⭐ 像素口径的常驻说明必须区分两条 App 通道（单侧视图 pixelRect / 对比表换算）并写明判定没换',
      (() => {
        const notes = alignNotes({ ...alignOf(alignScaleFixture), pixelWidth: 1206 }, 'pixel');
        return (
          notes.length === 4 &&
          notes.some((line) => line.includes('pixelRect')) &&
          notes.some((line) => line.includes('对比表')) &&
          // 0.5 pt × 3.216 = 1.61 px —— 这个数必须出现，否则读者以为「差 1px 怎么还判一致」
          notes.some((line) => line.includes('判定仍按设计基准') && line.includes('±1.61 px'))
        );
      })(),
      alignNotes({ ...alignOf(alignScaleFixture), pixelWidth: 1206 }, 'pixel').join(' | '),
    );

    // ---- 画布「间距读数」也随口径换 px（2026-09-29 第二次收敛；2026-09-30 收紧口径）----
    //
    // 「点击节点，节点间的间距也要改成物理像素单位」。几何仍出帧内逻辑坐标（线必须画在元素边上），
    // 只有那个**数字**换成截图物理像素 —— 所以这里同时锁「数字对了」与「几何一动没动」。
    //
    // ⚠️ 09-30 收紧：读数不再是把 `from` / `to` 当**标量**各投影一次，而是**两侧矩形按档位投影
    // 后再跑同一份 `measureBetween`**。理由见 `lib/pixelProjection#measureLinesInPixels`：
    // `presnap` 宿主的右边界是「左 + 宽」算出来的，标量投影得出的数在同一屏上都加不齐。
    check(
      '⭐ 间距读数换 px（真实用例 09-30「10年管家开通前」）：设计 7 → presnap 20 = SDK 实测；'
        + 'raw 21 正是旧口径的 1px 假阳性',
      (() => {
        // 设计 1755:12359 右边界 184.5 → 1755:12371 左边界 191.5（间距 7，业务代码 `gap: w(7)`）。
        const rectA: Rect = { x: 22.5, y: 0, width: 162, height: 40 };
        const rectB: Rect = { x: 191.5, y: 0, width: 100, height: 40 };
        const presnap = realProjectionOf();
        const raw = realProjectionOf('raw');
        if (!presnap || !raw) return false;
        const logical = measureBetween(rectA, rectB);
        const out = measureLinesInPixels('design', rectA, rectB, presnap);
        const app = measureLinesInPixels('app', rectA, rectB, presnap);
        const edgesA = designPixelEdges({ rect: rectA }, presnap);
        const edgesB = designPixelEdges({ rect: rectB }, presnap);
        return (
          logical.length === 1 && logical[0]!.value === 7 &&
          // A 左 65 + A 宽 467 = 右 532；B 左 552 ⇒ 20 —— 与 SDK 那条 `pixelRect 35 / 1011×418` 同批
          edgesA.left === 65 && edgesA.right - edgesA.left === 467 && edgesB.left === 552 &&
          out.length === 1 && out[0]!.value === 20 &&
          // 自洽性（修这个的**真正理由**）：同一屏上「A 左 + A 宽 + 读数 = B 左」必须加得齐
          edgesA.left + (edgesA.right - edgesA.left) + out[0]!.value === edgesB.left &&
          // raw 档与 App 侧逐位等于旧口径 ⇒ 21；旧口径就是那 1px 假阳性（两端各投影一次再相减）
          measureLinesInPixels('design', rectA, rectB, raw)[0]!.value === 21 &&
          app[0]!.value === 21 &&
          Math.abs(designLengthToAppPixels(191.5, presnap) - designLengthToAppPixels(184.5, presnap)) === 21 &&
          // 几何必须原样：读数线还得画在元素边上（在这里改坐标，线会从边上跑开）
          out[0]!.from === logical[0]!.from && out[0]!.to === logical[0]!.to && out[0]!.at === logical[0]!.at &&
          out[0]!.axis === 'x' && out[0]!.kind === 'gap' && out[0]!.extensions.length === 0
        );
      })(),
      (() => {
        const presnap = realProjectionOf();
        const raw = realProjectionOf('raw');
        if (!presnap || !raw) return '(投影为 null)';
        const rectA: Rect = { x: 22.5, y: 0, width: 162, height: 40 };
        const rectB: Rect = { x: 191.5, y: 0, width: 100, height: 40 };
        return `presnap=${measureLinesInPixels('design', rectA, rectB, presnap)[0]!.value}`
          + ` raw=${measureLinesInPixels('design', rectA, rectB, raw)[0]!.value}`;
      })(),
    );
    check(
      '⭐ 间距读数换 px：分档真的生效（同一对矩形 presnap 17 / 旧口径 16，差的那 1px 全是口径）',
      (() => {
        const pixel = pixelOf(1206);
        if (!pixel) return false;
        const rectA: Rect = { x: 10, y: 0, width: 30, height: 40 };
        const rectB: Rect = { x: 45, y: 0, width: 30, height: 40 };
        // 倍率 3.216：A 左 32 + A 宽 96 = 右 128、B 左 145 ⇒ 17；按边界相减（旧口径）得 16
        return (
          measureLinesInPixels('design', rectA, rectB, pixel)[0]!.value === 17 &&
          Math.abs(designLengthToAppPixels(45, pixel) - designLengthToAppPixels(40, pixel)) === 16
        );
      })(),
      (() => {
        const pixel = pixelOf(1206);
        if (!pixel) return '(投影为 null)';
        const rectA: Rect = { x: 10, y: 0, width: 30, height: 40 };
        const rectB: Rect = { x: 45, y: 0, width: 30, height: 40 };
        return `presnap=${measureLinesInPixels('design', rectA, rectB, pixel)[0]!.value}`
          + ` 旧口径=${Math.abs(designLengthToAppPixels(45, pixel) - designLengthToAppPixels(40, pixel))}`;
      })(),
    );
    check(
      '⭐ 间距读数带上单位（画布上换个口径就换尺子，胶囊只有数字时分不清设计单位还是截图像素）',
      /unit: measureBasisProjection \? 'px' : undefined/.test(boardTsx ?? '') &&
        /unit\?: string;/.test(rasterTsx ?? '') &&
        /formatMeasure\(line\.value\) \+ \(item\.unit \? ` \$\{item\.unit\}` : ''\)/.test(rasterTsx ?? '') &&
        // 投影只有一个来源：画布与面板共用 `pixelProjectionOf`，各算一次迟早「画布说 24、面板说 23」
        /measureBasisProjection = useMemo\(/.test(boardTsx ?? '') &&
        /pixelProjectionOf\(appAlign\)/.test(boardTsx ?? ''),
      `board=${/unit: measureBasisProjection/.test(boardTsx ?? '')} raster=${/item\.unit \?/.test(rasterTsx ?? '')}`,
    );
  }
  check(
    '四边同色 → uniform=true（面板才敢画色块；一个色块配四个 hex 会被误读成「那就是边框色」）',
    formatAppEdgeColors(styleStyled?.style?.borderColor)?.uniform === true,
  );
  check(
    '⭐ 老快照（没有 style / textStyle 键）→ undefined：面板整组不画。'
      + '把 undefined 与 null 合并，存量快照里每个透明容器都会被读成「这个元素没有背景色」',
    styleLegacy?.style === undefined && styleLegacy?.textStyle === undefined,
    `${String(styleLegacy?.style)} / ${String(styleLegacy?.textStyle)}`,
  );
  check(
    '⭐ 显式 null（采了、确实没有）→ null：面板画成「—」而不是整组消失',
    styleUnstyled?.style === null && styleUnstyled?.textStyle === null,
    `${String(styleUnstyled?.style)} / ${String(styleUnstyled?.textStyle)}`,
  );

  // ── iOS 补样式采集后的三态：**「这版没读边框」必须与「采过、确定没有边框」分得开** ──
  //
  // iOS 只采得到背景色（边框被 RN 画在轮廓图片层里、`layer.borderWidth` 被显式置 0），
  // 且它的 `style` 永远发对象、绝不发 null。少了这一组，最容易出的两个错是：
  // 归一化把「键不存在」压成 undefined，或者在空对象上返回 null —— 两者都会让面板
  // 对着 iOS 画三行「—」，把「这版没采」读成「这个元素确定没有边框」。
  const iosStyleNormalized = normalizeSdkSnapshot(
    {
      platform: 'ios',
      source: 'react-native-ui-acceptance',
      timestamp: Date.now(),
      nodeCount: 3,
      windowWidth: 1179,
      windowHeight: 2556,
      density: 3,
      densityDpi: 480,
      nodes: [
        styleNode({
          nodeId: 'ios-text',
          style: { backgroundColor: '#e8542e' },
          textStyle: {
            fontSize: 14,
            fontWeight: 600,
            fontStyle: 'normal',
            fontFamily: 'PingFang SC',
            lineHeight: 20,
            letterSpacing: 0.5,
            color: '#333333',
          },
        }),
        styleNode({ nodeId: 'ios-no-bg', style: {}, textStyle: null }),
        styleNode({ nodeId: 'ios-legacy' }),
      ],
      collection: { ...styleCollection, actualNodeCount: 3 },
    },
    1179,
    2556,
  );
  const [iosText, iosNoBg, iosLegacy] = iosStyleNormalized.nodes;
  check(
    '⭐ iOS 文本样式七项完整穿过归一化（14dp 进来还是 14 —— 没被 Mac 侧再除一次密度）',
    iosText?.textStyle?.fontSize === 14 &&
      iosText?.textStyle?.fontWeight === 600 &&
      iosText?.textStyle?.fontFamily === 'PingFang SC' &&
      iosText?.textStyle?.lineHeight === 20 &&
      iosText?.textStyle?.letterSpacing === 0.5 &&
      iosText?.textStyle?.color === '#333333',
    JSON.stringify(iosText?.textStyle),
  );
  check('iOS 背景色带出来（这一版 iOS 唯一的盒样式通道）', iosText?.style?.backgroundColor === '#e8542e');
  check(
    '⭐ iOS 没有背景色的节点发 `{}` → 保留空对象，不能塌成 null'
      + '（塌成 null 就与「安卓采过、确定没有盒样式」混成一件事了）',
    JSON.stringify(iosNoBg?.style) === '{}',
    JSON.stringify(iosNoBg?.style),
  );
  check(
    '⭐ 0.1.9 及更早的 iOS 快照：两个键都不存在 → undefined（三态里的「没采」）',
    iosLegacy?.style === undefined && iosLegacy?.textStyle === undefined,
    `${String(iosLegacy?.style)} / ${String(iosLegacy?.textStyle)}`,
  );
  check(
    '⭐ appBorderChannel 判定表：undefined→false · null→true · {}→false · {backgroundColor}→false'
      + ' · 任一 border* 键（值可以为全 null）→true',
    appBorderChannel(undefined) === false &&
      appBorderChannel(null) === true &&
      appBorderChannel({}) === false &&
      appBorderChannel({ backgroundColor: '#fff' }) === false &&
      appBorderChannel({ borderWidth: { top: null, right: null, bottom: null, left: null } }) === true &&
      appBorderChannel({ borderStyle: 'solid' }) === true &&
      appBorderChannel({ borderColor: { top: '#000000', right: null, bottom: null, left: null } }) === true &&
      // ⚠️ 2026-09-28 **改判**：`borderRadius` 不再属于描边通道（圆角走 appCornerChannel）。
      // 留在描边里，iOS 节点（有圆角、无描边）会点亮「边框」组、组内描边两行画假「—」。
      appBorderChannel({ borderRadius: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 } }) === false,
  );
  check(
    '⭐ appCornerChannel 判定表：undefined→false（没读）· null→true（读了且确定没有）'
      + ' · {}→false · {backgroundColor}→false · 含 borderRadius 键→true（四角全 0 也算读过）',
    appCornerChannel(undefined) === false &&
      appCornerChannel(null) === true &&
      appCornerChannel({}) === false &&
      appCornerChannel({ backgroundColor: '#fff' }) === false &&
      appCornerChannel({ borderRadius: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 } }) === true &&
      appCornerChannel({ borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 } }) === true,
  );
  check(
    '⚠️ 圆角通道与描边通道**互相独立**：描边键不点亮圆角行、圆角键不点亮描边行'
      + '（合回一条，iOS 又会把没采的描边画成「—」）',
    appCornerChannel({ borderWidth: { top: 1, right: 1, bottom: 1, left: 1 } }) === false &&
      appBorderChannel({ borderRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 } }) === false,
  );
  check('⭐ iOS 节点上边框通道 = false（面板不画边框组，而不是画三行假「—」）', appBorderChannel(iosText?.style) === false);
  check(
    '⚠️ 回归保护：安卓「只有背景色、四边全 null」的节点边框通道仍为 true'
      + '（键存在性由归一化保住；压掉它会让安卓这类节点凭空少画三行）',
    appBorderChannel({
      backgroundColor: '#ffffff',
      borderWidth: { top: null, right: null, bottom: null, left: null },
    }) === true,
  );

  // 面板侧：这几行真的画出来了（渲染层是本轮改动的落点）
  check(
    '⭐ App 侧面板画出「背景 / 边框 / 字体」这几行（验收同学问的就是这三件事）',
    /<ColorRow label="背景色"/.test(infoPanelTsx ?? '') &&
      /<EdgeColors label="描边色"/.test(infoPanelTsx ?? '') &&
      /<Row label="字体"/.test(infoPanelTsx ?? '') &&
      /<Row label="描边宽度"/.test(infoPanelTsx ?? '') &&
      /<Row label="圆角"/.test(infoPanelTsx ?? ''),
  );
  check(
    '⭐ 面板按三态决定「整组不画」还是「画成 —」：老快照（undefined）不画，'
      + '明确没有（null）才画 —— 两者混起来会让老数据被读成「这个元素没有背景色」',
    /node\.style !== undefined/.test(infoPanelTsx ?? '') &&
      /node\.textStyle !== undefined && node\.textStyle !== null/.test(infoPanelTsx ?? ''),
  );
  check(
    '面板用共享的折叠函数（四边 / 四角 / 四边色），不自己写一套 —— 两套写法迟早会分叉',
    /formatAppSides\(/.test(infoPanelTsx ?? '') &&
      /formatAppCorners\(/.test(infoPanelTsx ?? '') &&
      /formatAppEdgeColors\(/.test(infoPanelTsx ?? ''),
  );
  check(
    '⭐ 面板正文与对比表共用同一组边框/圆角通道判据（描边走 appBorderChannel、圆角走 appCornerChannel；各写一遍迟早分叉成「面板不画、对比表还说有值」）',
    ((infoPanelTsx ?? '').match(/appBorderChannel\(/g) ?? []).length >= 1 &&
      ((infoPanelTsx ?? '').match(/appCornerChannel\(/g) ?? []).length >= 1,
    `appBorderChannel=${((infoPanelTsx ?? '').match(/appBorderChannel\(/g) ?? []).length} appCornerChannel=${((infoPanelTsx ?? '').match(/appCornerChannel\(/g) ?? []).length}`,
  );
  check(
    '⭐ 面板的「边框」那几行挂在 (borderChannel || cornerChannel) 上（回退到只 styleChannel 会让 iOS 画三行假「—」）',
    /\(borderChannel \|\| cornerChannel\) && \(/.test(infoPanelTsx ?? ''),
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
  const clearSideBody =
    boardTsx?.match(/const clearSide = useCallback\(([\s\S]*?)\n  \}, \[\]\);/)?.[1] ?? '';
  check(
    '能截出 commitHover / resolveHover / applyHover / applySelection 的函数体（hover 解析与选中落地全在这四处）',
    commitHoverBody.length > 0 &&
      resolveHoverBody.length > 0 &&
      applyHoverBody.length > 0 &&
      applySelectionBody.length > 0,
  );
  check(
    '⭐ 选中项**按侧各存一个槽**：applySelection 只写自己那一侧的槽（`{ ...prev, [source]: picked }`），另一侧的选中项与它无关 —— 用户报的「选设计稿节点、再选 App 节点，设计稿的选中态消失」就是原先把唯一的槽覆盖掉了',
    /setSelection\(\(prev\)\s*=>\s*\(\{\s*\.\.\.prev,\s*\[source\]:\s*picked\s*\}\)\)/.test(applySelectionBody) &&
      !/setSelected\(/.test(boardTsx ?? '') &&
      !/setContexts\(/.test(boardTsx ?? ''),
  );
  check(
    '⭐ 切换到另一侧选中节点不会清除当前侧的间距锚点；只在锚点所属侧的选中项变化时清除',
    /setMeasureAnchors\(\(prev\)\s*=>\s*\(prev\[source\]\s*===\s*null\s*\?\s*prev\s*:\s*\{\s*\.\.\.prev,\s*\[source\]:\s*null\s*\}\)\)/.test(applySelectionBody),
  );
  check(
    '⭐ 「主动侧」（右栏 / Esc / Enter / 读数看哪一侧）是**算**出来的：resolveActiveSide(两个槽, preferredSide)，不是第五份 state（它指向的槽空了会自动改指另一侧）',
    /const activeSide = resolveActiveSide\(selection, preferredSide\)/.test(boardTsx ?? '') &&
      /const selected = activeSide \? selection\[activeSide\] : null/.test(boardTsx ?? ''),
  );
  check(
    '⭐ 两个选中框都画出来（每侧一个）：rasterSelections 是数组 → CanvasViewport 的 selections → FrameRaster 逐个渲染 .raster-selection（key = source）',
    /const rasterSelections = useMemo<RasterSelection\[\]>/.test(boardTsx ?? '') &&
      /selections=\{rasterSelections\}/.test(boardTsx ?? '') &&
      /selections\?: RasterSelection\[\]/.test(viewportTsx ?? '') &&
      /selections=\{selections\}/.test(viewportTsx ?? '') &&
      /selections\?: RasterSelection\[\]/.test(rasterTsx ?? '') &&
      /\(selections \?\? \[\]\)\.flatMap/.test(rasterTsx ?? '') &&
      /key: target\.source/.test(rasterTsx ?? ''),
  );
  check(
    '⭐ 画布描边按**本帧的槽**取（slotIdOf(selection, source)），不是「主动侧」—— 否则点 App 侧会把设计稿那个框一起换掉',
    /selectedId=\{slotIdOf\(selection, 'design'\)\}/.test(boardTsx ?? '') &&
      /selectedId=\{slotIdOf\(selection, 'app'\)\}/.test(boardTsx ?? ''),
  );
  check(
    '⭐ 点某一侧帧内空白只清**那一侧**（clearSide 按侧绑定，x / Esc 退无可退清主动侧）',
    /const clearSide = useCallback\(\(source: VerifySource\)/.test(boardTsx ?? '') &&
      /onClearSelection=\{\(\) => clearSide\('design'\)\}/.test(boardTsx ?? '') &&
      /onClearSelection=\{\(\) => clearSide\('app'\)\}/.test(boardTsx ?? '') &&
      /if \(activeSide\) clearSide\(activeSide\)/.test(boardTsx ?? '') &&
      /setMeasureAnchors\(\(prev\) => \(prev\[source\] === null \? prev : \{ \.\.\.prev, \[source\]: null \}\)\)/.test(clearSideBody),
  );
  check(
    '⭐ 间距读数按设计稿与 App 分别计算，不依赖主动侧',
    /const rasterMeasures = useMemo<RasterMeasure\[\]>/.test(boardTsx ?? '') &&
      // px 口径下把**一对矩形**交给 `measureLinesInPixels`（几何由它内部那份逻辑结果给出，
      // 免得「外面量一次、里面再量一次」出现两条不同的几何）；默认口径仍直接走 `measureBetween`
      /const lines = measureBasisProjection/.test(boardTsx ?? '') &&
      /measureLinesInPixels\(selection\.source, selection\.rect, other\.rect, measureBasisProjection\)/.test(boardTsx ?? '') &&
      /: measureBetween\(selection\.rect, other\.rect\)/.test(boardTsx ?? '') &&
      !/rasterSelection\.source\s*!==\s*other\.source/.test(boardTsx ?? ''),
  );
  check(
    '⭐ 图层面板：高亮按**行所属来源**取（两侧各自的槽），聚焦（切 tab / 展开 / 滚动）看主动侧',
    /selections=\{layerSelections\}/.test(boardTsx ?? '') &&
      /focus=\{layerFocus\}/.test(boardTsx ?? '') &&
      /export type LayerSelectionMap/.test(layersTsx ?? '') &&
      /const active = selections\[source\]/.test(layersTsx ?? '') &&
      /if \(focus\) setSource\(focus\.source\)/.test(layersTsx ?? ''),
  );
  check(
    '⭐ 点画布空白会清掉**本侧**的选中、但另一侧的槽原样保留（这一条是「两侧独立」的语义本身）',
    // 用纯函数把「写一侧不影响另一侧」跑一遍：与 applySelection 里 `{ ...prev, [source]: picked }` 同语义
    (() => {
      const slots: Record<'design' | 'app', string | null> = { design: null, app: null };
      slots.design = 'A';
      const afterDesign = resolveActiveSide(slots, 'design');
      slots.app = 'C';
      return (
        afterDesign === 'design' &&
        slots.design === 'A' &&
        slots.app === 'C' &&
        resolveActiveSide(slots, 'app') === 'app'
      );
    })(),
  );
  check(
    '⭐ 纯函数：主动侧在「它指的槽空了」时自动改指另一侧；两侧都空给 null（否则右栏会继续显示一个已取消选中的节点）',
    resolveActiveSide({ design: 'A', app: 'C' }, 'app') === 'app' &&
      resolveActiveSide({ design: 'A', app: 'C' }, 'design') === 'design' &&
      resolveActiveSide({ design: 'A', app: null }, 'app') === 'design' &&
      resolveActiveSide({ design: null, app: 'C' }, 'design') === 'app' &&
      resolveActiveSide({ design: null, app: null }, 'design') === null &&
      // 两侧都有、又没有 preferred 时结果必须确定（不能依赖对象的键序）
      resolveActiveSide({ design: 'A', app: 'C' }, null) === 'design',
  );
  check(
    '⭐ 纯函数：选中 id 按来源取（设计稿 `id` / 截图 `nodeId`），没选中或字段缺失给 null',
    selectionIdOf({ source: 'design', node: { id: '1:23' } }) === '1:23' &&
      selectionIdOf({ source: 'app', node: { nodeId: '0/1/2' } }) === '0/1/2' &&
      selectionIdOf(null) === null &&
      selectionIdOf({ source: 'design', node: {} }) === null &&
      otherSource('design') === 'app' &&
      otherSource('app') === 'design',
  );
  check(
    '⭐ Esc 的「上一层」是从选中项**算出来**的（parentContextOf 现算），不是存下来的第二份 state',
    /parentContextOf\(/.test(boardTsx ?? '') &&
      !/selectedContextId|selectionChain/.test(boardTsx ?? ''),
  );
  check(
    '⭐ hover 走的是**与单击同一个纯函数**（planCanvasHover）：链、选中项、落点、上一击的 cycle 一个不少地喂进去',
    /planCanvasHover\(/.test(resolveHoverBody) &&
      /ancestorChain\(/.test(resolveHoverBody) &&
      /selectedId:\s*selectionId/.test(resolveHoverBody) &&
      /prev:\s*clickCycleRef\.current/.test(resolveHoverBody) &&
      // ⌥ 删掉后不再需要修饰键（2026-09-28）
      !/outermost/.test(resolveHoverBody),
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
    '⭐ 画布单击把 cycle 交出去、其余入口传 null（列表 / 键盘都没点画布，留着会被误判成「原地再点」）',
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
  // ⚠️ 本轮报告（依时间顺序，两次都改了面板）：
  //   1) 「App 截图右侧的节点信息展示了层级」→ App 侧去掉；
  //   2) 「画布中点击设计稿，右侧的节点信息，对齐上面」→ 设计稿侧也去掉。
  //
  // 结论是**两侧都不画「层级」面包屑**：面板 = 一行手势提示 + 字段组，点开就是节点信息本身。
  // 面包屑原本解决的是「画布上父级被子级盖住、指不到」（嵌套 DOM 里父盒画在子盒下面），
  // 代价是首屏先被一条链占掉两三行 —— 验收同学要看的尺寸 / 文本 / 背景 / 边框被挤下去。
  // 上移一层仍有两条路，都在画布那一侧：原地再点（hover 环跟随）、Esc。
  //
  // 所以这里钉住三件事：① 面板里没有 <Crumbs>（也没有「层级」组）；
  // ② 那句手势提示还在、两侧共用同一行；③ 只想服务面包屑的 props 已删净，不留死参数。
  check(
    '⭐ 节点信息面板两侧都不再画层级面包屑（NodeInfoPanel 里没有 <Crumbs>，也没有「层级」组）',
    infoPanelTsx !== null && !/<Crumbs[\s>]/.test(infoPanelTsx) && !/title="层级"/.test(infoPanelTsx),
  );
  check(
    '⭐ 手势提示还在，且两侧共用同一行（没了面包屑，「原地再点 / Esc 上移一层」就没有别的书面入口）',
    // 2026-09-28：从「恰好 1 处」改成「恰好 2 处」—— 空状态那行原先是手写的、
    // 而且比选中态那行**旧了一个键位版本**（还写着 ⌘ 选整帧）。现在两处都引
    // `lib/shortcuts.ts` 的同一个常量，所以计数变成 2 是**变好**而不是变坏：
    // 两个互斥状态各画一次，字一个都不许自己写。
    (infoPanelTsx ?? '').match(/\{GESTURE_HINT\}/g)?.length === 2 &&
      /className="info-hint"/.test(infoPanelTsx ?? ''),
    `{GESTURE_HINT} 出现 ${(infoPanelTsx ?? '').match(/\{GESTURE_HINT\}/g)?.length ?? 0} 次`,
  );
  check(
    '⭐ 节点面板只保留当前选中与双侧比较所需的数据，不再带层级面包屑 props',
    // ⚠️ 只测 `boardTsx` 里的 `onPickAncestor`：面板源码的注释里**故意写着**这个词
    //    （说明它为什么被删），拿 `!/onPickAncestor/` 去测面板原文会永远红。
    //    面板这侧改测 interface 本体 —— 形状对了才算真删干净。
    !/onPickAncestor/.test(boardTsx ?? '') &&
      /interface NodeInfoPanelProps \{\s*selected: SelectedNode \| null;\s*comparison\?: \{ design: DesignNode; app: AppNode \} \| null;\s*\}/.test(
        infoPanelTsx ?? '',
      ) &&
      /<NodeInfoPanel selected=\{selected\} comparison=\{comparison\} \/>/.test(boardTsx ?? ''),
  );
  check(
    '⭐ 设计稿与 App 同时选中时显示平铺对比表及统计，单选时仍走原节点信息视图',
    // 09-30 第二版：对比表从「两列上下叠」改成「属性 | 设计稿 | App」三列一行
    /className="compare-table"/.test(infoPanelTsx ?? '') &&
      /compare-row\$\{changed \? ' changed' : ''\}/.test(infoPanelTsx ?? '') &&
      /\$\{changedCount\} 项差异/.test(infoPanelTsx ?? '') &&
      /compare-mode/.test(boardTsx ?? '') &&
      /width:\s*440px/.test(canvasCss ?? ''),
  );

  // ---- 重合组（2026-09-28）----
  //
  // 一个按钮在原生树里常常是**两层**：上层是内容（Pressable + 文字），下层是外观
  // （LinearGradientView，圆角由它自己手绘持有），两层矩形逐位相同 —— 画布点选永远命中
  // 上层，于是验收同学看到的是「明明有圆角、面板一行都没有」，且无从下手。
  //
  // 修法是**展示层聚合**：只识别这一簇、只把样式聚合成一个只读视图，**数据层零改动**。
  // 为什么不真合并（改 id / 改树）：① `nodeId = sdk:<treePath>` 是回源码的唯一坐标，
  // 合并必丢一条；② 引擎的祖先投票与「容器内分配」都吃兄弟集合，而打平是 RN 特有的
  // ⇒ 只有 App 侧会合并 ⇒ 两侧树形不对称；③ 合并后「这层圆角该是 21」会指向一个
  // 不存在的节点。三条理由的完整版在 `lib/stack.ts` 的文件头。
  type StackFixture = Parameters<typeof stackOf>[0];
  const fixture = (
    items: Array<{
      id: string;
      parentId: string | null;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      index?: number;
      visible?: boolean;
      clipped?: boolean;
    }>,
  ): StackFixture =>
    items.map((item) => ({
      id: item.id,
      parentId: item.parentId,
      rect: { x: item.x ?? 0, y: item.y ?? 0, width: item.w ?? 10, height: item.h ?? 10 },
      index: item.index ?? 0,
      visible: item.visible ?? true,
      clipped: item.clipped ?? false,
    })) as unknown as StackFixture;

  const coincident = fixture([
    { id: 'shell', parentId: null, x: 0, y: 0, w: 100, h: 100 },
    { id: 'gradient', parentId: 'shell', x: 10, y: 10, w: 64, h: 21, index: 2 },
    { id: 'press', parentId: 'shell', x: 10, y: 10, w: 64, h: 21, index: 3 },
    // 差 0.8px → 不算重合。阈值是「逐位相同」：放宽会把真正的父子嵌套并进来（丢层级，不是去噪）
    { id: 'near', parentId: 'shell', x: 10, y: 10.8, w: 64, h: 21, index: 4 },
    // 同位置但**不同父** → 不是这一处的重合，是别的分支
    { id: 'elsewhere', parentId: 'other', x: 10, y: 10, w: 64, h: 21, index: 5 },
    // 隐藏 / 被裁剪 / 零尺寸都不参与 —— 否则 RN 的 <Defs> 会让某些位置凭空多出好几层
    { id: 'hidden', parentId: 'shell', x: 10, y: 10, w: 64, h: 21, index: 6, visible: false },
    { id: 'clipped', parentId: 'shell', x: 10, y: 10, w: 64, h: 21, index: 7, clipped: true },
    { id: 'zero', parentId: 'shell', x: 10, y: 10, w: 0, h: 0, index: 8 },
  ]);

  const pressStack = stackOf(coincident, 'press');
  check(
    '⭐ 重合组：只认「同父 + 几何逐位相同」的可见兄弟，且按绘制序从下到上（这就是「此处有 N 个元素」的集合）',
    pressStack.map((node) => node.id).join(',') === 'gradient,press' &&
      stackOf(coincident, 'near').map((node) => node.id).join(',') === 'near' &&
      stackOf(coincident, 'elsewhere').map((node) => node.id).join(',') === 'elsewhere' &&
      // 判据对**目标自身同等生效**：选中的那层自己若隐藏 / 被裁剪 / 零尺寸，它连自己都进不了簇，
      // 返回空数组（调用方按普通节点处理）。上面那三条也正是靠同一段 filter 不进 pressStack。
      stackOf(coincident, 'hidden').length === 0 &&
      stackOf(coincident, 'clipped').length === 0 &&
      stackOf(coincident, 'zero').length === 0 &&
      pressStack.every((node) => node.id !== 'hidden' && node.id !== 'clipped' && node.id !== 'zero') &&
      STACK_TOLERANCE === 0.5,
    `press 的重合组 = ${pressStack.map((node) => node.id).join(',')}`,
  );

  type StackAppFixture = Parameters<typeof mergeAppNodes>[0][number];
  const stackApp = (over: Record<string, unknown>): StackAppFixture =>
    ({
      nodeId: 'n',
      parentId: null,
      className: 'com.facebook.react.views.view.ReactViewGroup',
      depth: 0,
      index: 0,
      ...over,
    }) as unknown as StackAppFixture;

  const lowerLayer = stackApp({
    nodeId: 'gradient',
    style: { borderRadius: { topLeft: 21, topRight: 21, bottomRight: 21, bottomLeft: 21 } },
  });
  const upperLayer = stackApp({ nodeId: 'press', style: null, text: '立即升级' });
  const mergedStack = mergeAppNodes([lowerLayer, upperLayer]);
  check(
    '⭐ 重合组聚合：并集 + 冲突取上层（看得见的是上层）；圆角记在下层也能显示 —— 这正是当初报的那个症状',
    mergedStack.style?.borderRadius?.topLeft === 21 &&
      mergedStack.text === '立即升级' &&
      // 三态不能被打乱：下层只写过 borderRadius，聚合结果里不该凭空多出 backgroundColor 键 ——
      // 多出来会让面板把「这版没这个通道」画成「确定没有背景色」，那是个假结论
      !('backgroundColor' in (mergedStack.style ?? {})) &&
      mergeAppNodes([
        stackApp({ nodeId: 'a', style: { backgroundColor: '#111111' } }),
        stackApp({ nodeId: 'b', style: { backgroundColor: '#222222' } }),
      ]).style?.backgroundColor === '#222222' &&
      appLayerHint(lowerLayer) === '圆角 21' &&
      appLayerHint(upperLayer) === '无盒样式' &&
      // 全没读过 → undefined（整组不画）；读过但确定没有 → null（画成 —）
      mergeAppBoxStyle([stackApp({})]) === undefined &&
      mergeAppBoxStyle([stackApp({ style: null })]) === null,
  );

  check(
    '⭐ 重合组只做「展示层聚合」：聚合结果只喂面板，真实节点 id 不动（真合并会动 id 与树形）',
    // 面板：只有真的有两层以上才渲染那块 UI（常驻会变成纯噪音，而面板首屏很贵）
    /stack && stack\.members\.length > 1 && <StackList/.test(infoPanelTsx ?? '') &&
      // 画布：喂给面板的是**聚合视图**，而「记录问题」用的两个 id 仍是真实节点
      /selected=\{mergedSelected \?\? selected\}/.test(boardTsx ?? '') &&
      /designNodeId=\{selectedDesignNode\?\.id \?\? null\}/.test(boardTsx ?? '') &&
      /appNodeId=\{selectedAppNode\?\.nodeId \?\? null\}/.test(boardTsx ?? '') &&
      // lib/stack 是纯读数：不引 React、不碰 ipc / store，所以不可能回写数据
      stackTs !== null &&
      !/from 'react'/.test(stackTs) &&
      !/@shared\/ipc/.test(stackTs),
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
    options: { point?: { x: number; y: number } } = {},
  ) =>
    planCanvasClick({
      chain: drillChain,
      selectedId,
      point: options.point ?? at(100, 100),
      prev,
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

  // ③ 「⌥/Ctrl 一步跳到最外层容器（整帧）」**已按用户要求删除**（2026-09-28）。
  //    用行为断言把它钉住：从任何状态出发，一击都不可能直接落到链尾。
  check(
    '⭐ 「一步跳到最外层容器」已移除（2026-09-28）：单击只落在**命中本身**或**链上的上一级**，没有第三条路',
    clickAt(null, null)?.selectedId === 'leaf' &&
      clickAt('leaf', click1!.cycle)?.selectedId === 'mid' &&
      clickAt('outer', click3!.cycle)?.selectedId === 'leaf',
  );

  // ④ 不变量：选中项 = 命中 或 命中链上的某一段 —— 「选中项永远在链上」
  check(
    '⭐ 不变量：任何一个手势选出来的节点都在**这条命中链**上（不可能跳到链外 / 一个不相干的节点）',
    [null, 'leaf', 'mid', 'outer', 'sib'].every((sel) => {
      const plan = clickAt(sel, null);
      return plan !== null && drillChain.includes(plan.selectedId as (typeof drillChain)[number]);
    }),
  );

  // ⑤ Esc。它走的就是「上移一层」那条通道（`parentContextOf`），只是不用瞄准。
  //    ⚠️ 与之配对的 **Enter（下钻到第一个子节点）已按用户要求删除**（2026-09-28）
  //    —— 下钻本来就有「单击」（它选的就是最深那个），Enter 只是给同一件事加了个键。
  check(
    '⭐ parentContextOf = 该节点的父级（Esc 的「上一层」取它）',
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

  // ⑦ 匹配高亮组：在匹配明细里点一条，画布上该亮哪些框（lib/matchFocus）。
  //
  // 这一组真正要守住的**不是「能算出来」，而是「成组匹配的每个节点都要出框」**。
  // 早期实现只取「两侧各第一个能找到的」：1:1 匹配看起来一切正常，于是这个 bug
  // 在镜像夹具和肉眼试用里都不会暴露；只有 N:M 的成组匹配（文本聚合后 3 个设计文本
  // ↔ 1 个 App 文本）才现形，而那时画布上少框两个节点，用户只会以为「本来就只有一对」。
  //
  // ⚠️ 本版**删掉了「视口该聚焦到哪一侧」**（`MatchFocus.focus`）：点清单只画框，
  // 视口保持不动 —— 所以这里不再有聚焦类断言，改由下面那条「focusRect 只剩一处调用点」
  // 的结构断言守着「别再把它加回来」。
  const focusNodes = new Map<string, { source: VerifySource; rect: Rect; clipped: boolean }>([
    ['design:d1', { source: 'design', rect: { x: 0, y: 0, width: 100, height: 40 }, clipped: false }],
    ['design:d2', { source: 'design', rect: { x: 0, y: 50, width: 100, height: 40 }, clipped: false }],
    ['design:d3', { source: 'design', rect: { x: 0, y: 100, width: 100, height: 40 }, clipped: false }],
    ['design:clipped', { source: 'design', rect: { x: 5, y: 5, width: 10, height: 10 }, clipped: true }],
    ['app:a1', { source: 'app', rect: { x: 10, y: 10, width: 300, height: 30 }, clipped: false }],
    ['app:a2', { source: 'app', rect: { x: 10, y: 60, width: 300, height: 30 }, clipped: false }],
  ]);
  const focusOf = (designIds: string[], appIds: string[]) =>
    planMatchFocus({
      designIds,
      appIds,
      lookup: (source, id) => focusNodes.get(`${source}:${id}`) ?? null,
    });

  const oneToOne = focusOf(['design:d1'], ['app:a1']);
  check(
    '匹配高亮·1:1：两侧各出一个框，顺序是设计稿在前',
    oneToOne.boxes.length === 2 &&
      oneToOne.boxes[0]?.source === 'design' &&
      oneToOne.boxes[1]?.source === 'app',
    `boxes=${oneToOne.boxes.map((item) => item.source).join(',')}`,
  );

  // ⭐ 本轮修的那个 bug：成组匹配只亮一侧各第一个。
  const nToM = focusOf(['design:d1', 'design:d2', 'design:d3'], ['app:a1']);
  check(
    '⭐ 匹配高亮·N:M：**组内每个节点都出框**（3 个设计文本 ↔ 1 个 App 文本 → 4 个框）',
    nToM.boxes.length === 4 && nToM.resolved.design === 3 && nToM.resolved.app === 1,
    `boxes=${nToM.boxes.length} resolved=${JSON.stringify(nToM.resolved)}`,
  );

  // 落空：匹配引用的是当前配对里没有的节点（换过截图 / 重跑过验收）。不是错误，但要数得出来。
  const halfMissing = focusOf(['design:ghost', 'design:d1'], ['app:a1']);
  check(
    '匹配高亮·一侧落空：只画找得到的那些框，并如实报出命中数（供「点了没反应」定性）',
    halfMissing.boxes.length === 2 &&
      halfMissing.resolved.design === 1 &&
      halfMissing.resolved.app === 1 &&
      halfMissing.requested.design === 2,
    JSON.stringify(halfMissing.resolved),
  );
  check(
    '匹配高亮·两侧都没有 → 无框可画（视口本来也不动，所以点一下什么都看不见是预期的）',
    focusOf(['design:ghost'], ['app:ghost']).boxes.length === 0,
  );

  // 脏数据：前缀与所在数组不符（把 app 的 id 塞进 designIds）。宁可当作落空，也不猜。
  const crossWired = focusOf(['app:a1'], ['design:d1']);
  check(
    '匹配高亮·前缀与所在数组不符 → 两侧都落空，不张冠李戴',
    crossWired.boxes.length === 0,
    `boxes=${crossWired.boxes.length}`,
  );

  check(
    '匹配高亮·clipped 原样传递（被祖先裁掉的节点要画成淡框）',
    focusOf(['design:clipped'], []).boxes[0]?.clipped === true,
  );

  // ⭐ 匹配高亮**不驱动视口**（2026-09-17 用户要求：点列表只高亮、不聚焦 —— 早先会把
  // 视口挪到「节点更多的那一侧」，常常就是设计稿，于是用户刚摆好的取景被抢走）。
  // 守的是结构而不是行为：命令式聚焦只剩**图层列表**一处调用点（`handleFocus`，
  // 那一击的意图本来就是「过去」）。谁把自动聚焦加回来，调用点就会变成两处。
  const focusCalls = (boardTsx ?? '').match(/focusRect\(/g) ?? [];
  check(
    '匹配高亮不驱动视口：全库只剩图层列表一处 focusRect 调用点',
    focusCalls.length === 1,
    `focusRect 调用点 ${focusCalls.length} 处`,
  );

  check(
    '空链 → null（保持现状，好过把选中态指到一个不存在的节点上）',
    planCanvasClick({
      chain: [],
      selectedId: null,
      point: at(0, 0),
      prev: null,
    }) === null,
  );
  const firstCycle = planCanvasClick({
    chain: drillChain,
    selectedId: null,
    point: at(1, 2),
    prev: null,
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
    options: { point?: { x: number; y: number } } = {},
  ): string | null =>
    planCanvasHover({
      chain: drillChain,
      selectedId,
      point: options.point ?? at(100, 100),
      prev,
    });

  check(
    '⭐ hover 与单击同源：同一个输入喂给两个入口，答案逐条相等（同一个纯函数的两处调用）',
    [
      { selectedId: null, prev: null },
      { selectedId: 'leaf', prev: click1!.cycle },
      { selectedId: 'mid', prev: click2!.cycle },
      { selectedId: 'outer', prev: click3!.cycle },
      { selectedId: null, prev: click4!.cycle },
    ].every(
      (input) =>
        hoverAt(input.selectedId, input.prev) === clickAt(input.selectedId, input.prev)?.selectedId,
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
    '⭐ hover 完全不受修饰键影响（⌥ 已删，2026-09-28）：`CanvasClick` 里根本没有修饰键这一维',
    !/outermost/.test(canvasClickBody) && !/modifier|mods/.test(canvasClickBody),
  );
  check(
    'hover 在空链上返回 null（没命中任何节点 → 调用方清空 hover），不会指到一个不存在的节点上',
    planCanvasHover({
      chain: [],
      selectedId: null,
      point: at(0, 0),
      prev: null,
    }) === null,
  );

  // ⑧ 命中闸门：**谁能被指着选中**（2026-09-16 新增；2026-09-22 收敛）。
  //
  // 用户第四次报的是「**无填充的 frame 元素也要能 hover 和点击选中**」。闸门原先写死成
  // `hasFill === false → pointer-events: none`（照抄 Figma「只对有像素的区域命中」），
  // 于是无填充的 Frame / Group 在画布上等于不存在。
  //
  // 现在的判据（**顺序即语义**，逐条列在 `RenderNode.hittable`，唯一实现在 `designNodeHittable`）：
  //   ① `visible: false` → 出局（看不见的东西不该被点到）；
  //   ② **容器（FRAME / GROUP / INSTANCE / COMPONENT / COMPONENT_SET / SECTION）一律参与**，
  //      填充状态完全无关 —— 盒本身就是结构，指针落进去就该选中它；
  //   ③ 图形类：填充被**显式隐藏** → 出局（哪怕还有可见描边：描边只画在边缘那一圈，
  //      按整盒放行会吃掉底下所有东西，实测 `Rectangle 34626668` 吃掉 99.1%）；
  //   ④ 图形类其余：画得出像素（可见填充 / 可见描边）→ 参与，否则出局。
  //
  // ⚠️ 2026-09-22 晚先试过「把 ② 也撤掉、全量按盒（`visible !== false` 即命中）」，
  // **实测否决**（理由与逐点数字见 `designNodeHittable` 尾注）：它只解除「自己被闸门挡住」，
  // 解不了「被更上面的层盖住」——「消息」盒上恰好压着一个同尺寸同位置的隐藏填充子节点
  // `Rectangle 3976`，一起参与就整盒盖住父级 → **消息依旧 0%**，而「待收货」被自己的
  // 「矩形备份」同样封死 36.2% → **0%**。最终采用「只撤容器那条」：零像素图形类继续出局，
  // 让那层挡路的矩形让开。**别再改成全量按盒。**
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
    ['无填充的 FRAME（2026-09-16 用户点名的那一类）', { type: 'FRAME', hasFill: false }, true],
    ['无填充的 GROUP（13531 / 13533 就是这一种）', { type: 'GROUP', hasFill: false }, true],
    ['无填充的 INSTANCE', { type: 'INSTANCE', hasFill: false }, true],
    ['fills: [] 与缺字段同义（从没设过填充）', { type: 'FRAME', hasFill: false, fills: [] }, true],
    ['hasFill 缺失（旧版插件导出）', { type: 'RECTANGLE' }, true],
    [
      // 从没设过填充、`hasFill` 为真 ⇒ 像素来自**可见描边**（图标 / 线 / 描边字）。
      // 「个人中心优化」样本里这类有 22 个，一律关掉会让图标在画布上彻底选不中
      // （实测可命中节点 49 → 39）。
      '从没设过填充 + 有可见描边的图标（VECTOR）',
      { type: 'VECTOR', hasFill: true, fills: [] },
      true,
    ],
    // 以下是出局的四类
    [
      '零像素的 RECTANGLE（盒只是包围盒，盒内空白不属于「这个图形」）',
      { type: 'RECTANGLE', hasFill: false },
      false,
    ],
    ['零像素的 VECTOR', { type: 'VECTOR', hasFill: false }, false],
    [
      // ⭐⭐ 这就是用户报的「同级的消息 frame 点不到」：`fills: [{ visible: false }]` 的 FRAME。
      // **2026-09-22 晚修好了**：容器一律按盒命中，填充状态完全无关。旧闸门只挡
      // `fills:[{visible:false}]`、不挡 `fills` 缺字段，而 Figma 对两种写法一视同仁，
      // 于是同排 tab 里只有「消息」点不到。修完「消息」自身可点 **0% → 42.2%**，与同排
      // 其他 tab（待收货 36.2% / 待付款 43.8% / 待发货 42.2%）拉平。代价（可见元素少拿
      // 152 点 / 888 点）与复现方式见 `designNodeHittable` 尾注。
      '⭐ 填充被显式隐藏的 FRAME（用户报的「消息」24×24 就是它）→ **参与**（容器按盒）',
      { type: 'FRAME', hasFill: false, fills: [{ type: 'SOLID', visible: false }] },
      true,
    ],
    [
      '填充被显式隐藏的 RECTANGLE（「矩形备份 14」那一类）',
      { type: 'RECTANGLE', hasFill: false, fills: [{ type: 'SOLID', visible: false }] },
      false,
    ],
    [
      // hasFill 由插件算成「可见填充 **或** 可见描边」，所以这一条 hasFill 也是 true。
      // 若先按 hasFill 放行，它会以**整盒**参与命中 —— 而描边只画在边缘那一圈，
      // 实测吃掉 99.1% 的采样点（「只能 hover / 选中 699:11614」就是它）。
      '⭐ 填充被隐藏但带可见描边（Rectangle 34626668 那一类）→ 出局',
      { type: 'RECTANGLE', hasFill: true, fills: [{ type: 'SOLID', visible: false }] },
      false,
    ],
    [
      // 2026-09-22 晚：这一条从 false 翻成 true —— 容器按盒，有没有子节点都一样。
      // 「二级页导航栏/APP」这类 360×44 透明导航栏会因此吃掉覆盖区域的点击
      // （实测可见元素少拿 152 / 888 点），代价由右键「选择图层」菜单兜底。
      '填充被隐藏 + 装了东西的 FRAME（「二级页导航栏」那一类）→ 参与',
      { type: 'FRAME', hasFill: false, fills: [{ type: 'SOLID', visible: false }], childCount: 3 },
      true,
    ],
    [
      // ⚠️ 已知副作用：12×12 空壳 FRAME 会盖满父级「跳转箭头」，让父级与同级 VECTOR 的
      // 可点面积归零。这是「容器按盒」的必然结果，走右键菜单选父级。
      '填充被隐藏的空壳 FRAME（「返回」12×12 那一类）→ 参与',
      { type: 'FRAME', hasFill: false, fills: [{ type: 'SOLID', visible: false }], childCount: 0 },
      true,
    ],
    [
      '填充被隐藏的 GROUP → 参与（容器按盒）',
      { type: 'GROUP', hasFill: false, fills: [{ type: 'SOLID', visible: false }], childCount: 2 },
      true,
    ],
    ['隐藏的容器（看不见的东西不能被点到）', { type: 'GROUP', hasFill: false, visible: false }, false],
    ['隐藏的图形（同样只因 visible: false 出局）', { type: 'RECTANGLE', hasFill: true, visible: false }, false],
  ];
  check(
    '⭐ 设计稿命中规则（' +
      designCases.length +
      ' 种输入逐个断言）：**容器一律按盒命中**（填充状态无关），隐藏图层出局、零像素的**图形类**出局',
    designCases.every(([, patch, expected]) => designNodeHittable(designFixture(patch)) === expected),
    designCases
      .filter(([, patch, expected]) => designNodeHittable(designFixture(patch)) !== expected)
      .map(([label]) => label)
      .join(' / ') || '全部符合预期',
  );
  {
    // ⭐ 守卫（2026-09-22 晚新增）：命中判据**确实**区分「容器 / 图形类」，不是只看 `visible`。
    // 哪天又有人改成「`visible !== false` 即命中」（全量按盒），第 2 极立刻红 —— 请先跑
    // 逐点归属探针（见 `designNodeHittable` 尾注里的表格），别只看单例夹具：
    // 全量按盒会让「消息」依旧 0%、「待收货」36.2% → 0%。
    const poles: Array<[string, Partial<DesignNode>, boolean]> = [
      ['零像素 FRAME（容器）', { type: 'FRAME', hasFill: false }, true],
      ['零像素 RECTANGLE（图形类）', { type: 'RECTANGLE', hasFill: false }, false],
      ['无填充 FRAME', { type: 'FRAME', hasFill: false }, true],
      [
        // 2026-09-22 晚从 false 翻成 true：容器按盒，填充状态无关（「消息」就是这一类）
        '隐藏填充 FRAME（容器）',
        { type: 'FRAME', hasFill: false, fills: [{ type: 'SOLID', visible: false }] },
        true,
      ],
      [
        // ⚠️ 真正的分界线在这里：同样是「填充被隐藏」，图形类**继续出局**。
        // 挡在「消息」盒上的就是这种 RECTANGLE，它让开之后父级才拿回 42.2%。
        '隐藏填充 RECTANGLE（图形类）',
        { type: 'RECTANGLE', hasFill: false, fills: [{ type: 'SOLID', visible: false }] },
        false,
      ],
    ];
    const verdicts = poles.map(([, patch]) => designNodeHittable(designFixture(patch)));
    check(
      '⭐ 守卫：命中确实区分「容器 / 图形类」（5 极逐个断言 —— 改成 visible 即命中会红）',
      poles.every(([, , expected], index) => verdicts[index] === expected),
      poles.map(([label], index) => `${label}=${String(verdicts[index])}`).join(' / '),
    );
  }

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
    ['SVG 宿主（react-native-svg）', { isSvg: true }, true],
    // ⚠️ 2026-09-24 晚按用户要求**回退 0.1.9**：不画内容的 ViewGroup / 占位 View 重新参与命中。
    // 0.1.9 曾把它挡掉以对齐 iOS 浮层 `getUiAcceptanceDrawableNodes`，结果安卓透明壳 `frame`
    // 选不中（对安卓是回归，用户确认原安卓命中逻辑正确）。用户拍板「两端全恢复」，
    // 闸门回到「可见 && 非盾牌」，与设计稿侧同手感；代价是相对手机浮层重新不一致（iOS ~34% 落点）。
    ['不画内容的 ViewGroup / 占位 View（0.1.9 前手感：参与）', {}, true],
    // 2026-09-16：文本节点**照样命中**。有文字就该点得到 —— 旧规则把「hasVisualContent 漏了但有 text」
    // 的异常数据判成不可命中，代价是那类文本在画布上完全选不中（端上真出过）。本就是「可见即参与」的自然结果。
    ['文本节点（哪怕 hasVisualContent 漏了）→ 照样命中', { text: '文字' }, true],
    ['不可见 View', { visible: false }, false],
    ['零尺寸 View（0.1.9 前无尺寸闸门，仍参与）', { width: 0, height: 0 }, true],
    // 被祖先裁剪链裁没 = 屏幕上没有它的任何像素。0.1.9 前无此闸门，回退后恢复参与命中
    // （字段来自 SDK 安卓 CollectPolicy / iOS collectView，缺字段按「没被裁」走，见 AppNode.clippedOut）。
    ['被祖先裁剪链裁没（clippedOut，0.1.9 前无此闸门：参与）', { hasVisualContent: true, clippedOut: true }, true],
    ['透明盾牌（框架层的全屏透明层，见 markAppHitShields）', { hitShield: true }, false],
  ];
  check(
    '⭐ App 侧命中规则（' +
      appCases.length +
      ' 种输入逐个断言）：**可见 && 非盾牌即参与**（0.1.9 前手感；相对手机浮层重新不一致）',
    appCases.every(([, patch, expected]) => appNodeHittable(appFixture(patch)) === expected),
    appCases
      .filter(([, patch, expected]) => appNodeHittable(appFixture(patch)) !== expected)
      .map(([label]) => label)
      .join(' / ') || '全部符合预期',
  );
  // 两次判定的口径**不同**：命中只看「可见 && 非盾牌」（与设计稿侧同手感），
  // 盾牌看「画不画得出任何东西 + 类名 + 面积占比 + 子节点全透明」
  // （含文本，免得把有文字的真实元素误判成透明壳）。用一个「有 text、其余全空」的节点钉边界 —— 它命中、但不是盾牌。
  const textOnly = appFixture({ text: '文字' });
  check(
    '⭐ 两套口径的边界：只有文本的节点「可命中、但不是透明盾牌」',
    appNodeHittable(textOnly) === true && markAppHitShields([textOnly])[0]?.hitShield !== true,
  );
  check(
    '⭐ toRenderNode 把命中判据带出来（两侧都带；组件只读字段，不自算规则）',
    toRenderNode(designFixture({ type: 'GROUP', hasFill: false }), 'design').hittable === true &&
      toRenderNode(designFixture({ hasFill: true }), 'design').hasFill === true &&
      toRenderNode(appFixture({ hasVisualContent: true }), 'app').hittable === true &&
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
  /**
   * ⚠️ 2026-09-24（iOS 上传打通当天补）：**类名判定必须排在 `clickable` 之前**。
   *
   * iOS 端的 `clickable` 取自 `userInteractionEnabled`，而 UIView 默认恒为 true ——
   * 只要类名规则排在它后面，iOS 上就永远走不到。实测后果：iOS 快照 959 个节点、
   * 2409 个采样点 **100% 只命中同一个节点**（`RCTDebuggingOverlay` —— 同一个类名，
   * 安卓侧被这条规则挡住了、iOS 侧没有），其余 903 个可命中节点一个都点不到；
   * 安卓同一套规则的分布是 37 个不同顶层命中者。用户看到的就是「画布上怎么点都是同一个框」。
   *
   * 另一类是 iOS 26 新增的 `_UIFloatingBarContainerView`（铺满整窗 402×874、无像素、
   * `userInteractionEnabled=true`），它没有安卓对应物，是这次才进名单的。
   */
  const clickableOverlayTree: AppNode[] = [
    mkNode({ nodeId: 'root2', parentId: null, depth: 0, width: 402, height: 874, hasVisualContent: true }),
    mkNode({
      nodeId: 'iosDebugOverlay',
      parentId: 'root2',
      depth: 1,
      width: 402,
      height: 874,
      hasVisualContent: false,
      // iOS 的 clickable = userInteractionEnabled：UIView 默认就是 true，没有区分度
      clickable: true,
      className: 'RCTDebuggingOverlay',
    }),
    mkNode({
      nodeId: 'iosFloatingBar',
      parentId: 'root2',
      depth: 1,
      width: 402,
      height: 874,
      hasVisualContent: false,
      clickable: true,
      className: '_UIFloatingBarContainerView',
    }),
    mkNode({
      nodeId: 'iosFloatingBarHost',
      parentId: 'root2',
      depth: 1,
      width: 402,
      height: 874,
      hasVisualContent: false,
      clickable: true,
      className: '_TtGC5UIKitP10$1903e4ad022FloatingBarHostingViewVS_20FloatingBarContainer_',
    }),
  ];
  const markedIos = markAppHitShields(clickableOverlayTree);
  const iosShield = (nodeId: string): boolean =>
    markedIos.find((item) => item.nodeId === nodeId)?.hitShield === true;
  check(
    '⭐ iOS：框架层覆盖物（RCTDebuggingOverlay / _UIFloatingBarContainerView）即使 clickable:true 也判盾牌 —— 类名规则必须排在 clickable 之前，否则 iOS 上永远走不到',
    iosShield('iosDebugOverlay') && iosShield('iosFloatingBar') && iosShield('iosFloatingBarHost') && !iosShield('root2'),
    markedIos.map((item) => `${item.nodeId}=${item.hitShield === true}`).join(' '),
  );
  check(
    '⭐ iOS：被判盾牌的框架层覆盖物在画布上不可命中（否则整帧又只剩一个框）',
    markedIos
      .filter((item) => item.hitShield === true)
      .every((item) => toRenderNode(item, 'app').hittable === false),
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
  // ⚠️ 期望是**DFS 前序**（子节点紧跟父节点），不是层序。
  // 原来写的 'root,a,b,c,a1' 是层序，与三处证据都不符：
  //   ① `flattenVisibleTree` 的实现是「push 之后立即递归子节点」（`types/verify.ts`）；
  //   ② 该函数上方的注释要求「同一父节点下的兄弟按数组原序输出」；
  //   ③ 下方注释要求 `flattenFigmaTree`（图层列表与画布 DOM 的公共入口）也走
  //      「DFS 前序 + 兄弟保持数组原序」，并明说「两边共用同一份顺序，谁都不许再翻」。
  // 只有这个期望字符串还停在层序时代 —— 该断言相对于 HEAD 就是失败的，与匹配引擎无关。
  check(
    '⭐ 图层行兄弟保持**数组原序**（= Figma 面板的顺序：index 0 在面板最上面，用户截图钉死过）',
    allRows.map((row) => row.node.id).join(',') === 'root,a,a1,b,c',
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

  // ⑨ 间距读数：选中一个元素后 hover 另一个，x / y 各差多少（lib/measure，纯函数）。
  //
  // 这段守的是**判定顺序**那一件事：包含（四条内边距）必须排在分离（两条间隙）之前。
  // 判反了不会报错，只会让「选中容器、hover 里面的元素」这个最常见的动作一条线都
  // 画不出来（包含在两条轴上都算「重叠」），表现成「这个功能时灵时不灵」——
  // 而它恰好又是最需要读 padding 的场景。零距离的边（贴边）与亚像素差都必须被滤掉：
  // 「读数 0」和「没有线」是两回事，混在一起就没人能判断到底是哪一类。
  const rectOf = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });
  const axisLine = (lines: MeasureLine[], axis: 'x' | 'y'): MeasureLine | undefined =>
    lines.find((item) => item.axis === axis);

  // 横排两块（同一行、相距 8）→ 只出横向间隙，落在两者竖向重叠带的中线上
  const sideBySide = measureBetween(rectOf(0, 0, 100, 40), rectOf(108, 0, 60, 40));
  check(
    '⭐ 横向相邻的两块：只出 x 一条（y 轴重叠 → 没有纵向间距可言），读数是相向两边的距离',
    sideBySide.length === 1 &&
      sideBySide[0]?.axis === 'x' &&
      sideBySide[0]?.kind === 'gap' &&
      sideBySide[0]?.from === 100 &&
      sideBySide[0]?.to === 108 &&
      sideBySide[0]?.value === 8,
    JSON.stringify(sideBySide),
  );
  check(
    '间隙线落在**另一条轴的重叠带中线**（摆在上/下边会贴着某一块，读不出量的是谁和谁）',
    axisLine(sideBySide, 'x')?.at === 20,
    String(axisLine(sideBySide, 'x')?.at),
  );

  // 上下两块（纵向相距 12）→ 只出 y 一条
  const stacked = measureBetween(rectOf(10, 0, 100, 30), rectOf(20, 42, 80, 20));
  check(
    '纵向相邻的两块：只出 y 一条（x 轴重叠），读数是 42 − 30 = 12',
    stacked.length === 1 &&
      stacked[0]?.axis === 'y' &&
      stacked[0]?.value === 12 &&
      stacked[0]?.from === 30 &&
      stacked[0]?.to === 42,
    JSON.stringify(stacked),
  );

  // 斜着排：两条轴都分离 → 两条线，且都贴在选中项的边上（Figma 那个 L 形）
  const diagonal = measureBetween(rectOf(0, 0, 100, 100), rectOf(200, 200, 100, 100));
  check(
    '⭐ 斜着排（两轴都分离）→ x / y 各一条，读数各是 100 / 100',
    diagonal.length === 2 &&
      axisLine(diagonal, 'x')?.value === 100 &&
      axisLine(diagonal, 'y')?.value === 100,
    JSON.stringify(diagonal),
  );
  check(
    '两轴都不重叠时，两条线退化成**选中项的边**（在选中项那个角上相接，不飘在中间）',
    axisLine(diagonal, 'x')?.at === 100 && axisLine(diagonal, 'y')?.at === 100,
    `${axisLine(diagonal, 'x')?.at} / ${axisLine(diagonal, 'y')?.at}`,
  );

  // 斜着排时读数线只有一头贴住元素（落在选中项那个角上），另一头悬空 —— 悬空那头必须由一条
  // **垂直于读数线**的虚线接回元素最近的边（Figma / CAD 的 extension line）。
  // 没有它，用户看到的是「一头挂在框上、另一头不知道量到哪儿」的线：而验收里要修的
  // 恰好就是悬空那头对着的那条边。两头都贴住时**一条都不画** —— 「本来就接上了」与
  // 「用虚线接上的」混在一起，每条读数都会拖两根没用的尾巴。
  const diagonalX = axisLine(diagonal, 'x');
  const diagonalY = axisLine(diagonal, 'y');
  check(
    '⭐ 斜着排：悬空那一头由虚线延长段接回对面元素（x 读数配竖虚线、y 读数配横虚线）',
    JSON.stringify(diagonalX?.extensions) === JSON.stringify([{ axis: 'y', from: 100, to: 200, at: 200 }]) &&
      JSON.stringify(diagonalY?.extensions) === JSON.stringify([{ axis: 'x', from: 100, to: 200, at: 200 }]),
    JSON.stringify(diagonal.map((item) => `${item.axis}:${JSON.stringify(item.extensions)}`)),
  );
  check(
    '延长段的一端就是读数线的端点（from = at）、另一端落在元素边上（to = 元素最近的边）',
    diagonalX?.extensions[0]?.from === diagonalX?.at &&
      diagonalX?.extensions[0]?.to === 200 &&
      diagonalY?.extensions[0]?.from === diagonalY?.at &&
      diagonalY?.extensions[0]?.to === 200,
    `${JSON.stringify(diagonalX?.extensions)} / ${JSON.stringify(diagonalY?.extensions)}`,
  );

  // 用户报的那个形态：左下选中 ↔ 右上另一个（两轴都不重叠，就是设计稿里最常见的
  // 「图标在上、文字在下、两块斜着错开」）。两条读数各带一条延长段，一竖一横，
  // 在对面元素的**左下角**收口 —— 两条读数分别量的是它的左边与下边。
  const corner = measureBetween(rectOf(0, 100, 100, 50), rectOf(200, 0, 80, 60));
  check(
    '⭐ 左下 ↔ 右上（用户报的形态）：x / y 各一条读数，各带一条延长段在对面元素的角上收口',
    corner
      .map(
        (item) =>
          `${item.axis}${item.value}@${item.at}${item.extensions
            .map((line) => `+${line.axis}${line.from}-${line.to}@${line.at}`)
            .join('')}`,
      )
      .join(',') === 'x100@100+y60-100@200,y40@100+x100-200@60',
    JSON.stringify(corner),
  );
  check(
    '垂直轴上有重叠的（横排 / 上下两块）**不出**延长段：线本来就贴着两块，多一条虚线反而像没接上',
    (axisLine(sideBySide, 'x')?.extensions ?? []).length === 0 &&
      (axisLine(stacked, 'y')?.extensions ?? []).length === 0,
    `${JSON.stringify(axisLine(sideBySide, 'x')?.extensions)} / ${JSON.stringify(axisLine(stacked, 'y')?.extensions)}`,
  );

  // 包含：四条内边距（这一支必须排在「分离」之前，否则一条线都画不出来）
  const container = rectOf(0, 0, 300, 200);
  const inside = rectOf(16, 12, 100, 40);
  const insets = measureBetween(container, inside);
  const insetValues = insets.map((item) => `${item.axis}:${item.value}`).join(',');
  check(
    '⭐ 选中容器、hover 里面的元素 → 四条内边距（16 / 184 / 12 / 148），而不是「什么都没有」',
    insets.length === 4 &&
      insets.every((item) => item.kind === 'inset') &&
      insetValues === 'x:16,x:184,y:12,y:148',
    insetValues,
  );
  check(
    '内边距左右两条摆在内层元素的**竖向中线**上（贴边会两两挤在角上，四条读不清）',
    insets.filter((item) => item.axis === 'x').every((item) => item.at === 32) &&
      insets.filter((item) => item.axis === 'y').every((item) => item.at === 66),
    insets.map((item) => `${item.axis}@${item.at}`).join(','),
  );
  check(
    '谁套住谁不影响读数（选中里层、hover 外层，四条内边距逐条相等）',
    JSON.stringify(measureBetween(inside, container)) === JSON.stringify(insets),
  );
  check(
    '内边距不带延长段（它的两端本来就分别落在内盒与外盒的边上，没有悬空的一头）',
    insets.every((item) => item.extensions.length === 0),
    JSON.stringify(insets.map((item) => item.extensions)),
  );
  check(
    '⭐ 零距离的边被滤掉（贴左/贴右的内边距 0 不出线：读数 0 与「没有线」必须分得开）',
    measureBetween(rectOf(0, 0, 100, 100), rectOf(0, 10, 100, 30))
      .map((item) => `${item.axis}:${item.value}`)
      .join(',') === 'y:10,y:60',
  );
  check(
    '亚像素间隙（0.2）也不出线 —— 1× 缩放下它不足 1 个屏幕像素，读出来只会是 0',
    measureBetween(rectOf(0, 0, 100, 40), rectOf(100.2, 0, 50, 40)).length === 0 &&
      MIN_MEASURE_GAP > 0.2,
  );
  check(
    '同一个节点（或两轴都重叠、又互不包含的交叉排布）→ 不画：零长度的线只会让人以为「没生效」',
    measureBetween(container, container).length === 0 &&
      measureBetween(rectOf(0, 0, 100, 100), rectOf(50, 50, 100, 100)).length === 0,
  );
  check(
    '读数文本：整数收掉浮点尾巴、亚像素保留 1 位（把 0.5 四舍五入成 0 等于谎报「已对齐」）',
    formatMeasure(8) === '8' &&
      formatMeasure(7.999999) === '8' &&
      formatMeasure(0.5) === '0.5' &&
      formatMeasure(12.04) === '12' &&
      formatMeasure(12.25) === '12.3',
    [formatMeasure(8), formatMeasure(7.999999), formatMeasure(0.5), formatMeasure(12.04), formatMeasure(12.25)].join(' / '),
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
  // 否定断言用去注释版：`.card-thumb` 的注释里就写着「别改成 min/max-height」这句反例
  const thumbRuleCode = canvasCss ? cssRuleBodyCode(canvasCss, '.card-thumb') : null;
  const thumbImgRule = canvasCss ? cssRuleBodyCode(canvasCss, '.card-thumb img') : null;
  check(
    '缩略图是定位上下文（否则删除按钮会锚到整张卡片而不是缩略图）',
    thumbRule !== null && /position\s*:\s*relative/.test(thumbRule),
  );

  // ---- 素材卡缩略图：固定盒子 + contain 居中（2026-09-28 定案）----
  // 盒子比例**固定**：矮素材不许把卡片压扁、长素材不许把卡片撑高，同一屏内所有卡片等高。
  // 两个方向的适配全交给 `object-fit: contain` + 居中，见 `.card-thumb` / `.card-thumb img` 的注释。
  check(
    '缩略图盒子比例固定（卡片高度不随素材比例坍缩/膨胀）',
    thumbRule !== null && /aspect-ratio\s*:\s*375\s*\/\s*812/.test(thumbRule),
  );
  check(
    '缩略图盒子不再有高度上下限（那是「跟素材比例走」时期的补丁，留着反而会撑破固定盒子）',
    thumbRuleCode !== null &&
      !/min-height/.test(thumbRuleCode) &&
      !/max-height/.test(thumbRuleCode),
  );
  check(
    '缩略图盒子宽度写死 100%（不写时极端比例下浏览器会反过来压缩宽度）',
    thumbRule !== null && /width\s*:\s*100%/.test(thumbRule),
  );
  check(
    '缩略图是 contain 且居中（宽素材宽度撑满后上下居中、窄素材高度撑满后左右居中，任何比例都不裁切）',
    thumbImgRule !== null &&
      /object-fit\s*:\s*contain/.test(thumbImgRule) &&
      !/object-fit\s*:\s*cover/.test(thumbImgRule) &&
      /object-position\s*:\s*center/.test(thumbImgRule),
  );
  check(
    '卡片不内联素材比例（盒子比例固定，内联会把上面三条全部推翻）',
    // 只在 style 属性里找，不去全文搜 `aspectRatio` —— 注释里出现这个词是允许的（本仓注释爱写反例）
    !/style=\{\{[^}]*aspectRatio/.test(matchTsx ?? ''),
  );
  check(
    '素材墙栅格不开 align-items: start（盒子已等高，默认 stretch 才会让卡片整齐）',
    !/\.card-grid\s*\{[^}]*align-items/.test(canvasCss ?? ''),
  );

  // ---- 页面匹配卡片底部（2026-09-28）：设计稿去掉「元素级导出」、截图加上平台标签 ----
  // 两侧都**不再展示节点数量**：卡片是给人认图的（名字 + 尺寸就够），节点规模属于
  // 快照元数据，铺在每张卡上只会稀释那两个真正的识别点。
  check(
    '两侧卡片的 meta 行只剩尺寸（节点数量已摘掉）',
    /className="asset-meta">\s*\{asset\.width\}×\{asset\.height\}\s*<\/div>/.test(matchTsx ?? '') &&
      /className="asset-meta">\s*\{app\.width\}×\{app\.height\}\s*dp\s*<\/div>/.test(matchTsx ?? ''),
  );
  check(
    '卡片不再渲染 nodeCount（否则摘掉的是文案、数字还在）',
    !/\{asset\.nodeCount\}|\{app\.nodeCount\}/.test(matchTsx ?? ''),
  );
  check(
    '设计稿卡片不再有「元素级导出」标记（isFrameLevel 不再参与卡片渲染）',
    !(matchTsx ?? '').includes('isFrameLevel') && !(matchTsx ?? '').includes('元素级导出'),
  );
  check(
    'App 截图卡片用平台标签，且走共用的 platformLabel（不在这里写第二份三元）',
    ((matchTsx ?? '').match(/platformLabel\(/g) ?? []).length === 2 &&
      /import\s*\{[^}]*\bplatformLabel\b[^}]*\}\s*from\s*'@shared\/verify'/.test(matchTsx ?? '') &&
      /className="tag platform-tag"/.test(matchTsx ?? ''),
    `platformLabel( 出现 ${((matchTsx ?? '').match(/platformLabel\(/g) ?? []).length} 次（应为 2）`,
  );
  check(
    '平台名只有一份实现：主进程那两处内联三元已改为 platformLabel',
    ((verifyIpcTs ?? '').match(/platformLabel\(/g) ?? []).length === 2 &&
      !(verifyIpcTs ?? '').includes(`platform === 'ios' ? 'iOS' : 'Android'`),
    `verifyIpc 里 platformLabel( 出现 ${((verifyIpcTs ?? '').match(/platformLabel\(/g) ?? []).length} 次（应为 2）`,
  );
  check(
    '.platform-tag 有独立样式（否则落回 .tag 默认描边，与「当前」角标同族）',
    /\.platform-tag\s*\{[^}]*background:/.test(canvasCss ?? ''),
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
    // ⚠️ 2026-09-24：声明从 `useState` 换成配对会话的 `useCanvasField`（切 tab / 切配对
    //    回来时工具不重置），但**仍然声明在 CanvasBoard 里** —— 这条断言守的是归属，
    //    不是某一年的写法。
    /const\s*\[\s*activeTool\s*,\s*setActiveTool\s*\]\s*=\s*use(?:State|CanvasField)/.test(
      boardTsx2 ?? '',
    ),
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

  // ---- 画布操作的「配对会话」：切 tab / 切配对不丢，两侧素材一换就重置 ----
  //
  // 用户报的症状：「画布上选中了节点、聚焦了匹配、标了几处差异，一切到『页面匹配』
  // 或点另一个配对，这些全没了」。它们的主语是**配对**而不是组件实例，所以存在
  // hooks/useCanvasSession 里（模块级 Map + 两侧素材 id 作签名）。
  //
  // 这一组既有**接线检查**（哪些字段挂在会话上、key 里有没有素材 id），也有**行为检查**
  // （直接把 store 当纯函数喂）—— 后者才是需求的实质：「换素材 → 回到最初状态」
  // 光读源码是读不出来的。
  const canvasSessionTs = await readRendererFile('src/renderer/src/hooks/useCanvasSession.ts');
  check('能读到配对会话源码', canvasSessionTs !== null);
  // 断言前先把源码拍平：调用点为了可读性会换行，用原始文本拼正则等于把格式也钉死
  const boardFlat = (boardTsx2 ?? '').replace(/\s+/g, ' ');
  const layersFlat = (layersTsx ?? '').replace(/\s+/g, ' ');

  const sessionFields = [
    'zoom',
    'selection',
    'preferredSide',
    'measureAnchors',
    'focusedMatch',
    'focusedRegionMatchId',
    'sideTab',
    'useAi',
    'annotating',
    'pending',
    'activeTool',
    'annotations',
    'colorSample',
    'compare',
    'overlayOpacity',
    'wipeRatio',
    'overlayOffset',
  ];
  // 取「挂在会话上的字段名」：`useCanvasField<…>(scope, '<字段>'` 里的字段名。
  // 中间的泛型参数里不会出现 `(`，所以 `[^(]*` 正好把「函数名 → 左括号」这段吃掉。
  const sessionFieldNames = [...boardFlat.matchAll(/useCanvasField[^(]*\(\s*scope,\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
  const looseFields = sessionFields.filter((field) => !sessionFieldNames.includes(field));
  check(
    '⭐ 画布上的人工操作全部挂在配对会话上（漏一个，那个操作切回来还是会没）',
    looseFields.length === 0,
    `没挂：${looseFields.join(' / ')}`,
  );
  const layerFieldNames = [...layersFlat.matchAll(/useCanvasField[^(]*\(\s*scope,\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
  check(
    '图层列表的「看哪一侧 / 展开到哪」也跟着配对走（几百节点的树重进就折回去等于再找一遍）',
    layerFieldNames.includes('layersSource') &&
      layerFieldNames.includes('layersCollapsed') &&
      /<LayersPanel\s+scope=\{scope\}/.test((boardTsx2 ?? '').replace(/\n\s*/g, ' ')),
    layerFieldNames.join(' / '),
  );
  check(
    '⭐ 素材内容指纹（含写入时间）既进 React key、也进会话签名，且同源',
    /key=\{canvasSessionKey\(canvasPair\.meta\.id, canvasSignature\)\}/.test(workspaceTsx ?? '') &&
      /signature=\{canvasSignature\}/.test(workspaceTsx ?? '') &&
      /canvasMaterialSignature\(\{/.test(workspaceTsx ?? '') &&
      /designImportedAt: designById\.get\(canvasPair\.meta\.designAssetId\)\?\.importedAt/.test(
        workspaceTsx ?? '',
      ) &&
      /appCapturedAt: appById\.get\(canvasPair\.meta\.appSnapshotId\)\?\.capturedAt/.test(
        workspaceTsx ?? '',
      ) &&
      /canvasScopeOf\(pair\.meta\.id, signature\)/.test(boardFlat) &&
      // ⚠️ 函数体那段的写法：`)` 与 `{` 之间还有返回类型 `: CanvasScope`，别写成 `\)\s*\{`
      /canvasScopeOf\([^)]*\)[^;{]*\{\s*return \{ pairId, signature \};/.test(
        (canvasSessionTs ?? '').replace(/\s+/g, ' '),
      ),
  );
  check(
    '取景（平移量）跟着配对走：初值来自会话，平移时回报',
    /readCanvasField<CanvasView \| null>\(scope, 'view'/.test(boardFlat) &&
      /onViewChange=\{handleViewChange\}/.test(boardFlat) &&
      /initialView=\{initialView\}/.test(boardFlat),
  );
  check(
    '视口尺寸变了就不恢复取景（平移量是屏幕坐标，窗口一改就指到别的内容上）',
    /VIEW_SIZE_TOLERANCE/.test(viewportTsx ?? '') &&
      /initialView/.test(viewportTsx ?? '') &&
      /onViewChange/.test(viewportTsx ?? ''),
  );
  check(
    '配对被删除时会话一并清掉（别留着几百节点的选中引用）',
    /dropCanvasSession\(pairId\)/.test(workspaceTsx ?? ''),
  );

  // 行为：素材一换 → 整体作废。签名的两侧都要能触发（只做设计稿那一侧是这类需求的典型漏项）
  const sessionA = canvasScopeOf(
    'smoke-canvas-pair',
    canvasMaterialSignature({
      designAssetId: 'd1',
      designImportedAt: 't1',
      appSnapshotId: 's1',
      appCapturedAt: 'u1',
    }),
  );
  // 「覆盖」重导：id 一模一样，只有写入时间变了 —— 只看 id 的实现会在这里漏掉
  const sessionDesignRewritten = canvasScopeOf(
    'smoke-canvas-pair',
    canvasMaterialSignature({
      designAssetId: 'd1',
      designImportedAt: 't2',
      appSnapshotId: 's1',
      appCapturedAt: 'u1',
    }),
  );
  const sessionDesignSwapped = canvasScopeOf(
    'smoke-canvas-pair',
    canvasMaterialSignature({
      designAssetId: 'd2',
      designImportedAt: 't2',
      appSnapshotId: 's1',
      appCapturedAt: 'u1',
    }),
  );
  const sessionAppSwapped = canvasScopeOf(
    'smoke-canvas-pair',
    canvasMaterialSignature({
      designAssetId: 'd2',
      designImportedAt: 't2',
      appSnapshotId: 's2',
      appCapturedAt: 'u2',
    }),
  );
  check(
    '⭐ 指纹：同 id 但被「覆盖」重导过 → 指纹也不同（只认 id 会漏掉这一路）',
    sessionA.signature !== sessionDesignRewritten.signature,
  );
  check(
    '指纹：素材元数据缺失（老数据）时退化成只看 id，不会随机变',
    canvasMaterialSignature({ designAssetId: 'd1', appSnapshotId: 's1' }) === 'd1||s1|',
  );
  // 冷启动先读一次（真实挂载顺序），条目就位之后才谈得上写
  check(
    '会话：冷启动先读，没存过就用兜底值',
    readCanvasField(sessionA, 'selection', 'FALLBACK') === 'FALLBACK',
  );
  // ⚠️ 兜底值必须**显式写成 `null`**（同一条注释也见下一条）：换成带形状的兜底值，写入被
  // 签名守卫丢掉时这一条会读回兜底值而**假绿**。T 里带 null，`?.design` 才不会缩成 never。
  writeCanvasField(sessionA, 'selection', { design: 'n1', app: null });
  check(
    '会话：同一个配对写进去读得回来',
    readCanvasField<{ design: string | null; app: string | null } | null>(sessionA, 'selection', null)
      ?.design === 'n1',
  );
  check(
    '⭐ 会话：换了设计稿 → 整体作废（回到最初状态）',
    readCanvasField(sessionDesignRewritten, 'selection', 'RESET') === 'RESET' &&
      readCanvasField(sessionDesignSwapped, 'activeTool', 'RESET') === 'RESET',
  );
  check(
    '⭐ 会话：换了 App 截图 → 同样整体作废',
    readCanvasField(sessionAppSwapped, 'annotations', 'RESET') === 'RESET',
  );
  // 素材被换的那一刻，新组件先挂载（条目已换成新签名），旧组件迟到的写入随后才到 ——
  // 那一笔必须丢掉。这里走的就是生产代码用的那个 write，守卫失效会被这一条抓住。
  writeCanvasField(sessionA, 'view', { tx: 11, ty: 22 });
  check(
    '⭐ 会话：迟到的写入（签名已过期）被丢弃，不污染新一轮',
    readCanvasField(sessionAppSwapped, 'view', 'NONE') === 'NONE',
  );
  writeCanvasField(sessionAppSwapped, 'view', { tx: 33, ty: 44 });
  check(
    '会话：签名对得上的写入照常落盘',
    readCanvasField<{ tx: number; ty: number } | null>(sessionAppSwapped, 'view', null)?.tx === 33,
  );
  dropCanvasSession('smoke-canvas-pair');
  check('会话：删除配对后条目真的没了', readCanvasField(sessionAppSwapped, 'selection', 'GONE') === 'GONE');

  // 标注从会话恢复回来，序号必须从「已用过的最大号」续上，否则新画的会和它撞 id
  const restoredAnnotations: RasterAnnotation[] = [
    { id: 'annotation-2', kind: 'rect', source: 'design', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
    { id: 'annotation-5', kind: 'arrow', source: 'app', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
  ];
  check(
    '标注序号从恢复回来的最大号续上（否则新标注与恢复回来的撞 React key）',
    annotationSeq(restoredAnnotations) === 5 &&
      annotationSeq([]) === 0 &&
      /annotationSeq\(annotations\)/.test(boardFlat),
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
  check(
    '叠图拖拽按 zoom 换算并吸附到整数逻辑像素',
    (() => {
      const offset = overlayOffsetFromDrag({
        start: { x: 2, y: -3 },
        screenDeltaX: 11,
        screenDeltaY: -5,
        zoom: 2,
      });
      return offset.x === 8 && offset.y === -5;
    })(),
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
  check(
    '截图帧位移使用逻辑像素变量（缩放后仍保持同一对齐关系）',
    overlayAppRule !== null &&
      /transform\s*:\s*translate\(var\(--overlay-offset-x/.test(overlayAppRule),
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
  // 截图帧按实测边界承载拖拽，但 DOM 仍不命中：单击才能继续落到设计稿节点。
  check(
    '叠图关闭截图节点命中（拖拽时不误选 App 节点）',
    /\.canvas\.overlay \.frame\[data-role='app'\] \.node-overlay/.test(canvasCss ?? ''),
  );
  check(
    '叠图截图帧不吞点击（单击仍可选择设计稿节点）',
    /\.canvas\.overlay \.frame\[data-role='app'\][^{]*\{[^}]*pointer-events\s*:\s*none/.test(
      canvasCss ?? '',
    ),
  );
  check(
    'CanvasViewport 区分截图拖拽与画布平移，并提供方向键微调',
    /querySelector<HTMLElement>[\s\S]{0,120}?\.frame\[data-role='app'\][\s\S]{0,80}?\.frame-content/.test(
      overlayViewportTsx ?? '',
    ) &&
      /overlayOffsetFromDrag\(/.test(overlayViewportTsx ?? '') &&
      /ArrowLeft/.test(overlayViewportTsx ?? ''),
  );

  section('0b. 人工标注（ground truth）：纯函数 + 「引擎不读标注」的结构守卫');

  // ⚠️ 这一节最关键的不是那些纯函数断言，而是最后那几条**结构性**约束：
  //    标注是「引擎算得对不对」的答案，引擎永远不能读它。哪一次改动让匹配链路
  //    读进了 ground truth，引擎就会开始照着自己被评价的那份答案答题 —— 之后无论跑
  //    多少轮都再也回不到「不改标注时引擎会怎样」，而这件事从任何数字上都看不出来。
  //
  //    局部名一律加 `gt` 前缀：这个函数体里已有 `replaced` / `digest` 这类同名局部量，
  //    撞名时 esbuild 直接报「symbol already declared」，而报出来的位置在几千行之外。
  const gtCoreSource = await readRendererFile('src/main/acceptance/core.ts');
  const gtServiceSource = await readRendererFile('src/main/acceptance/service.ts');
  const gtExportSource = await readRendererFile('src/main/acceptance/groundTruthExport.ts');
  const gtTypesSource = await readRendererFile('src/types/groundTruth.ts');
  const gtStoreSource = await readRendererFile('src/main/acceptance/store.ts');
  const gtPanelSource = await readRendererFile('src/renderer/src/components/CalibrationPanel.tsx');
  check(
    '能读到标注相关源码（types / store / service / 导出 / 面板 / 引擎）',
    gtCoreSource !== null &&
      gtServiceSource !== null &&
      gtExportSource !== null &&
      gtTypesSource !== null &&
      gtStoreSource !== null &&
      gtPanelSource !== null,
  );

  check(
    '匹配引擎 core.ts 完全不引用 ground truth',
    gtCoreSource !== null && !/ground.?truth/i.test(gtCoreSource),
  );
  // 恰好 2 处 = import 一行 + `getGroundTruth` 里一次调用。
  // 多出来的那一处就说明有别的链路（例如 runAcceptance）把标注读进去了。
  const gtServiceReads = (gtServiceSource ?? '').match(/readGroundTruth/g)?.length ?? 0;
  check(
    'service.ts 只在标注读写通道里碰 readGroundTruth（匹配链路不碰）',
    gtServiceReads === 2,
    `出现 ${gtServiceReads} 次（期望 import + getGroundTruth 共 2 次）`,
  );
  check(
    '标注与人工映射是**两个文件**（混在一份里会让标注污染引擎输入）',
    acceptanceGroundTruthPath('req', 'pair') !== acceptanceMappingPath('req', 'pair') &&
      acceptanceGroundTruthPath('req', 'pair').endsWith('ground-truth-pair.json') &&
      acceptanceMappingPath('req', 'pair').endsWith('mapping-pair.json'),
  );
  check(
    '标注导出目录与调试导出目录分开（标注是人工劳动，不该被需求删除连带抹掉）',
    groundTruthExportsDir() !== debugExportsDir() &&
      groundTruthExportsDir().endsWith('ground-truth-exports'),
  );
  // 导出里必须同时给出「全部」与「仅人工确认」两份一致性分布：
  // 引擎结论预填的条目不是独立证据，混在一起会把准确率刷成接近满分。
  check(
    '导出的 metrics 同时给出 agreement 与 agreementHuman + prefilledPairs',
    /prefilledPairs/.test(gtExportSource ?? '') &&
      /agreementHuman/.test(gtExportSource ?? '') &&
      /prefilledPairs: number/.test(gtTypesSource ?? ''),
  );
  check(
    '⚠️ 标注面板不自己算引擎一致性（那会与导出侧形成两个口径）',
    gtPanelSource !== null && !/agrees|contradicts|partial/.test(gtPanelSource),
  );

  // ---- 纯函数 ----
  check(
    'togglePending：点第二下即移出（这是唯一不靠按钮的纠错方式）',
    JSON.stringify(togglePending(['design:a'], 'design:a')) === '[]' &&
      JSON.stringify(togglePending(['design:a'], 'app:b')) === '["design:a","app:b"]',
  );
  // 顺序不该影响键：先点设计还是先点 App 是随手产生的，顺序进键就会变成两条记录
  check(
    'pairKeyOf：集合相同则键相同（与顺序无关）',
    pairKeyOf(['design:a', 'design:b'], ['app:c'], 'matched') ===
      pairKeyOf(['design:b', 'design:a'], ['app:c'], 'matched'),
  );
  check(
    'pairKeyOf：同一批节点换个判定 = 另一条记录（漏实现与配错是两个事实）',
    pairKeyOf(['design:a'], ['app:b'], 'matched') !==
      pairKeyOf(['design:a'], ['app:b'], 'no-counterpart'),
  );
  check(
    'submitBlocker：空组 / 单侧「配对」都给出人能读的原因',
    submitBlocker([], 'matched') === '先在画布上点选节点' &&
      submitBlocker(['design:a'], 'matched') !== null &&
      submitBlocker(['app:b'], 'matched') !== null,
  );
  check(
    'submitBlocker：单侧标注「另一侧不存在 / 忽略」是合法的',
    submitBlocker(['design:a'], 'no-counterpart') === null &&
      submitBlocker(['app:b'], 'ignore') === null,
  );
  check(
    '⚠️ submitBlocker：来源不可识别的 id 被挡下（否则导出时那一侧会静默少一个节点）',
    submitBlocker(['design:a', 'figma:zzz'], 'matched') !== null &&
      submitBlocker(['nonsense'], 'ignore') !== null,
  );

  const gtBuiltPair = buildPair(['app:b', 'design:a'], 'matched', {
    now: new Date('2026-01-01T00:00:00Z'),
  });
  check(
    'buildPair：按来源拆两侧、带默认来源 human 与时间戳',
    gtBuiltPair !== null &&
      gtBuiltPair.designNodeIds.length === 1 &&
      gtBuiltPair.appNodeIds.length === 1 &&
      gtBuiltPair.origin === 'human' &&
      gtBuiltPair.createdAt === '2026-01-01T00:00:00.000Z',
  );
  check(
    'buildPair：复用 submitBlocker 拒绝非法输入（规则只有一份，不会「按钮能点、记录造不出来」）',
    buildPair([], 'matched') === null && buildPair(['design:a'], 'matched') === null,
  );

  const gtSeedPair = buildPair(['design:a', 'app:b'], 'matched')!;
  const gtOtherPair = buildPair(['design:a', 'app:c'], 'matched')!;
  const gtReplaced = upsertPair([gtSeedPair, gtOtherPair], { ...gtSeedPair, note: '改过' });
  check(
    'upsertPair：同键整条替换（合并会让「重新点一遍去掉多选的节点」变成不可能）',
    gtReplaced.length === 2 && gtReplaced[0]?.note === '改过',
  );
  check(
    'removePair / annotatedIds：能按节点反查「这个已经标过了」',
    removePair([gtSeedPair, gtOtherPair], gtSeedPair.id).length === 1 &&
      annotatedIds([gtSeedPair]).has('app:b') &&
      !annotatedIds([gtSeedPair]).has('app:c'),
  );

  const gtPrefillSeed = buildPair(['design:a', 'app:b'], 'matched', {
    origin: 'engine-prefill',
  })!;
  const gtPrefilled = prefillFromMatches(
    [
      { status: 'matched', designNodeIds: ['design:a'], appNodeIds: ['app:b'] },
      { status: 'missing', designNodeIds: ['design:z'], appNodeIds: [] },
      { status: 'extra', designNodeIds: [], appNodeIds: ['app:z'] },
      { status: 'ambiguous', designNodeIds: ['design:y'], appNodeIds: ['app:y'] },
      { status: 'matched', designNodeIds: ['design:c'], appNodeIds: ['app:d'] },
    ],
    [gtPrefillSeed],
  );
  check(
    '⚠️ prefillFromMatches 只预填 matched（missing / extra 是噪声最大的一档）',
    gtPrefilled.pairs.length === 1 && gtPrefilled.skipped === 1,
    `新增 ${gtPrefilled.pairs.length} / 跳过 ${gtPrefilled.skipped}`,
  );
  check(
    '预填项带 engine-prefill 标记（导出时据此与人工确认项分开统计）',
    gtPrefilled.pairs.every((item) => item.origin === 'engine-prefill'),
  );

  const gtDigest = summarize([
    gtSeedPair,
    gtOtherPair,
    buildPair(['design:e'], 'no-counterpart')!,
    buildPair(['app:f'], 'ignore')!,
    { ...gtPrefillSeed, note: '有备注' },
  ]);
  check(
    'summarize：按判定计数，并单独数出预填条数',
    gtDigest.total === 5 &&
      gtDigest.matched === 3 &&
      gtDigest.noCounterpart === 1 &&
      gtDigest.ignore === 1 &&
      gtDigest.prefilled === 1 &&
      gtDigest.noted === 1 &&
      gtDigest.designNodes === 4 &&
      gtDigest.appNodes === 4,
    JSON.stringify(gtDigest),
  );

  // ---- 「引擎结论 vs 人工答案」的判定：只有一份实现 ----
  //
  // ⚠️ 这一段守的是**度量口径**，不是功能。`agreementOf` 有三个使用者（导出、重放、这里），
  //    一旦各写一份，就会出现「导出说 agrees 42、重放说 agrees 39」——而两个数字看起来
  //    都像权威，之后所有关于「引擎行不行」的讨论都会失去基准。
  const gtAgreementSource = await readRendererFile('src/main/acceptance/agreement.ts');
  const gtReplaySource = await readRendererFile('scripts/replay-ground-truth.ts');
  check(
    '能读到一致性判定模块与重放脚本',
    gtAgreementSource !== null && gtReplaySource !== null,
  );
  check(
    '⚠️ 一致性的判定只有一份实现：导出与重放都 import `./agreement`，谁也不自己算',
    /from '\.\/agreement'/.test(gtExportSource ?? '') &&
      /from '\.\.\/src\/main\/acceptance\/agreement'/.test(gtReplaySource ?? '') &&
      !/function agreementOf/.test(gtExportSource ?? '') &&
      !/function agreementOf/.test(gtReplaySource ?? '') &&
      /export function agreementOf/.test(gtAgreementSource ?? ''),
  );
  check(
    '⚠️ 一致性的判定是**纯模块**（不 import electron）—— 否则离线重放就跑不起来，闭环断在这里',
    gtAgreementSource !== null && !/from 'electron'/.test(gtAgreementSource),
  );

  const gtMatch = (input: {
    design?: string[];
    app?: string[];
    status: 'matched' | 'ambiguous' | 'missing' | 'extra';
    origin?: 'text-anchor' | 'calibrated-position' | 'sibling';
  }): NodeMatch => ({
    id: `m:${input.status}:${(input.design ?? []).join('+')}->${(input.app ?? []).join('+')}`,
    designNodeIds: input.design ?? [],
    appNodeIds: input.app ?? [],
    relation: 'one_to_one',
    source: 'rule',
    ...(input.origin ? { origin: input.origin } : {}),
    ruleScore: 0.9,
    confidence: 0.9,
    margin: 0.2,
    evidence: { geometry: 1, structure: 1, relation: 1, visual: 1, content: 1, kind: 1 },
    status: input.status,
  });
  const gtJudge = (matches: NodeMatch[], pair: { designNodeIds: string[]; appNodeIds: string[] }): EngineAgreement => {
    const index = buildEngineIndex(matches);
    const stored: GroundTruthPair = {
      id: 'p',
      designNodeIds: pair.designNodeIds,
      appNodeIds: pair.appNodeIds,
      verdict: 'matched',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    return agreementOf(
      stored,
      pair.designNodeIds.map((id) => statusOf(index, id)),
      pair.appNodeIds.map((id) => statusOf(index, id)),
    );
  };
  check(
    '判定：引擎配上的正是标注那一个 → agrees',
    gtJudge([gtMatch({ design: ['design:a'], app: ['app:b'], status: 'matched' })], {
      designNodeIds: ['design:a'],
      appNodeIds: ['app:b'],
    }) === 'agrees',
  );
  check(
    '⚠️ 判定：引擎给到了候选（ambiguous）但没自动确认 → `weak`，**不能算 missed**',
    gtJudge([gtMatch({ design: ['design:a'], app: ['app:b'], status: 'ambiguous' })], {
      designNodeIds: ['design:a'],
      appNodeIds: ['app:b'],
    }) === 'weak',
  );
  // 这一条是 `weak` 与 `missed` 的分界：候选指向的是**标注之外**的节点，
  // 那说明引擎找到了别的东西，与「一个字都没提」是两回事，也谈不上「找到了这条对应」。
  check(
    '判定：候选指向标注之外的节点 → 仍然是 missed（不是 weak）',
    gtJudge([gtMatch({ design: ['design:a'], app: ['app:z'], status: 'ambiguous' })], {
      designNodeIds: ['design:a'],
      appNodeIds: ['app:b'],
    }) === 'missed',
  );
  check(
    '判定：配到标注之外的节点 → contradicts（方向性错误必须先于「漏没漏」判断）',
    gtJudge([gtMatch({ design: ['design:a'], app: ['app:z'], status: 'matched' })], {
      designNodeIds: ['design:a'],
      appNodeIds: ['app:b'],
    }) === 'contradicts',
  );
  check(
    '⚠️ 一致性计数初值覆盖全部六档（少一档就会在统计里静默丢数据）',
    Object.keys(emptyAgreementCounts()).sort().join(',') === 'agrees,contradicts,missed,partial,unknown,weak' &&
      Object.values(emptyAgreementCounts()).every((count) => count === 0),
  );

  // ---- 视口分母（P0-A）----
  //
  // ⚠️ App 截图是**视口**，设计稿是**整页**。人不可能标注看不见的东西，
  //    拿全量 required 当分母算召回，会把视口外那 171 个节点算成引擎漏检 ——
  //    实测覆盖率被系统性低估一倍（22.4% ↔ 44%）。所以分母必须分两层给。
  check(
    '导出：`universe` 每个节点带 `inViewport`（必填，不是可选 —— 可选就会有人不填）',
    /inViewport: boolean;/.test(gtTypesSource ?? '') &&
      /inViewport: isInsideViewport\(node\.rect, canvas\)/.test(gtExportSource ?? ''),
  );
  check(
    '导出：metrics 同时给全量与视口两套分母 + 两套覆盖率（差值本身就是「全量口径不可信」的证据）',
    /universeViewport: \{ design: number; app: number \}/.test(gtTypesSource ?? '') &&
      /designCoverageViewport: number;/.test(gtTypesSource ?? '') &&
      /appCoverageViewport: number;/.test(gtTypesSource ?? ''),
  );
  check(
    '⚠️ 视口判据是「矩形**完整**落在画布内」（被折叠线切掉一半的不算 —— 人能看到的只是残缺一角）',
    /function isInsideViewport\([\s\S]{0,400}?rect\.x >= -tolerance[\s\S]{0,400}?rect\.y \+ rect\.height <= canvas\.height \+ tolerance/.test(gtExportSource ?? ''),
  );

  // ---- 引擎侧：L3c 的接入点与「不许自动确认」 ----
  const gtAiTypesSource = await readRendererFile('src/types/aiAcceptance.ts');
  check(
    '`calibrated-position` 在 `NodeMatch.origin` 的联合类型里（否则来源无法落盘，排查时看不到这一层）',
    /\| 'calibrated-position'/.test(gtAiTypesSource ?? ''),
  );
  // ⚠️ 标定点只许取文本类来源。用 L3a/L3b 的产物标定 = 拿待检验的结论去校准检验标准：
  //    错的越多、校准越自洽，最后整体跑偏还看不出来。
  check(
    '⚠️ 标定采样排除 `ancestor-vote` / `sibling`（不得用待检验的结论去校准检验标准）',
    /pair\.origin !== 'ancestor-vote' && pair\.origin !== 'sibling'/.test(gtCoreSource ?? ''),
  );
  // ⚠️ 必须在队列**排空的那一刻**跑、且仍在循环条件里：本层锁上的新容器要继续下推，
  //    放到循环之后，新容器内部整棵子树就永远漏配。
  check(
    '⚠️ L3c 在 L3b 队列排空时触发，且仍在循环条件内（否则新锁的容器不会继续下推）',
    /while \(queue\.length > 0 \|\| !calibratedPassDone\)/.test(gtCoreSource ?? '') &&
      /calibratedPassDone = true;\s*\n\s*lockByCalibratedPosition\(\);/.test(gtCoreSource ?? ''),
  );
  // 几何推断不是既成事实：L3c 只许产出候选，一旦它产出 `matched`，就等于让
  // 「离得近」拥有了与「文案完全相等」同等的自动确认权。
  check(
    '⚠️ L3c 只产出 `ambiguous`（几何推断不得自动确认，必须有人过目）',
    /origin: 'calibrated-position',[\s\S]{0,200}?status: 'ambiguous'/.test(gtCoreSource ?? ''),
  );
  check(
    '⚠️ L3c 的相容度**不复用** `salienceAffinity`（那条「下推能力必须一致」的硬否决是为 L3b 设计的，套用会让 Frame↔扁平图 永远配不上）',
    /function calibratedAffinity\(/.test(gtCoreSource ?? '') &&
      /const affinity = calibratedAffinity\(design\.salience, app\.salience\)/.test(gtCoreSource ?? ''),
  );

  // ---- 渲染层接线（光有纯函数不生效） ----
  const gtCalibRule = cssRuleBody(canvasCss ?? '', '.raster-pending');
  check('.raster-pending 规则存在（待配对框）', gtCalibRule !== null);
  check(
    '待配对框与匹配高亮**不同色**（已定 / 待定必须一眼分开）',
    gtCalibRule !== null &&
      /var\(--calib\)/.test(gtCalibRule) &&
      (canvasCss ?? '').includes('--calib:') &&
      (canvasCss ?? '').includes('--match:'),
  );
  check(
    'FrameRaster 确实渲染了待配对框，且 CanvasViewport / CanvasBoard 打通了这条通道',
    /raster-pending/.test(rasterTsx ?? '') &&
      /pendingHighlight/.test(viewportTsx ?? '') &&
      /pendingHighlight=\{rasterPending\}/.test(boardTsx ?? ''),
  );
  // ⚠️ 这条原先校验工具栏里的 `.tool-annotate` 按钮。**2026-09-17 标注开关搬到了标定面板**
  // （`CalibrationPanel` 顶部的 `.calib-toggle`，理由写在那边：从验收结果看到可疑结论后，
  // 用户的下一步就是来标定面板把正确答案标下来，入口应该在他正看着的地方），
  // 工具栏里从此没有这个 class —— 这条断言也就一直红着，还被误当成「那 1 条已知红」。
  // 现在改成**位置无关**的判据：开关存在，且它不进工具栏的布局档位（这才是「独立的一档」）。
  const modeToolsBlock = /MODE_TOOLS[^=]*=\s*\[([\s\S]*?)\]/.exec(toolbarTsx ?? '')?.[1] ?? '';
  check(
    '标注开关存在（在标定面板顶部），且它是独立的一档：不进工具栏的布局档位，只改点击含义',
    /calib-toggle/.test(gtPanelSource ?? '') &&
      /annotating/.test(gtPanelSource ?? '') &&
      modeToolsBlock.length > 0 &&
      !/annotat/i.test(modeToolsBlock),
  );
  check(
    '画布点击在标注模式下改为「加入待配对组」，不做祖先链级联',
    /annotating\)\s*\{[\s\S]{0,200}?togglePending/.test(boardTsx ?? ''),
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
    '⭐ 真实样本：放行零像素容器后，最外层 Frame 独占的像素**变少** —— 原本被它吞掉的点落到了更精确的那一层',
    rootShare < legacyRootShare,
    `旧 ${(legacyRootShare * 100).toFixed(1)}% → 新 ${(rootShare * 100).toFixed(1)}%`,
  );
  const noFillOwners = [...ownerCount.entries()]
    .filter(([id]) => renderById.get(id)?.hasFill === false)
    .map(([id, count]) => ({ node: renderById.get(id)!, count }))
    .sort((a, b) => b.count - a.count);
  check(
    '⭐ 真实样本：**画不出填充的图层能被直接命中**（原先是 pointer-events: none，一次都中不了；改回 hasFill 立即 FAIL）',
    noFillOwners.length > 0 && noFillOwners.every((entry) => entry.node.hittable),
    `${noFillOwners.length} 个无填充图层拿到命中，共 ${noFillOwners.reduce(
      (sum, entry) => sum + entry.count,
      0,
    )} 点；拿到最多的是「${noFillOwners[0]?.node.label ?? '-'}」(${noFillOwners[0]?.count ?? 0} 点)`,
  );
  // 拿到命中的无填充节点**必须全是容器**：零像素的图形类（RECTANGLE / VECTOR / …）判出局，
  // 理由是它们的盒只是包围盒 —— 盒内空白不属于「这个图形」，放进来就多一块隐形靶子。
  //
  // ⚠️ 2026-09-22 晚曾把这条例外连着「填充被隐藏」一起撤掉（改成「`visible` 即命中」），
  // **实测否决**：用户报的「消息」撤销后依旧 0 点（被自己同尺寸的隐藏填充子节点
  // `Rectangle 3976` 封死），「待收货」反而 36.2% → 0%。最终只撤「容器那条」——
  // 图形类继续出局正是「消息」能拿回 42.2% 的原因。**别再撤。**
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
    '⭐ 真实样本：拿到命中的无填充节点**全是容器**（零像素图形类不参与 —— 改成「visible 即命中」立即 FAIL）',
    graphicOwners.length === 0,
    graphicOwners.length === 0
      ? `${noFillOwners.length} 个拿到命中的无填充图层全部是容器类`
      : `❌ 有 ${graphicOwners.length} 个零像素图形拿到了命中：${graphicOwners
          .slice(0, 6)
          .map((entry) => `${entry.node.label}(${entry.node.detail?.type ?? '?'} / ${entry.count} 点)`)
          .join(' / ')}`,
  );
  // 另一半：**填充被显式隐藏**的图层。2026-09-22 晚改成「容器按盒」之后，
  // **隐藏填充的容器现在也参与命中**（这正是「消息」拿回 42.2% 的原因），
  // 但**隐藏填充的图形类必须继续出局** —— 挡在「消息」盒上的就是这种 RECTANGLE，
  // 它一旦参与就会整盒盖住父级，把「消息」重新打回 0%。这条守的就是这个分界。
  const GRAPHIC_HIDDEN = new Set(['RECTANGLE', 'VECTOR', 'ELLIPSE', 'LINE', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON']);
  const hiddenFillNodes = designRender.filter(
    (node) => node.hasFill === false && (node.detail?.fills?.length ?? 0) > 0,
  );
  const hiddenGraphicHits = hiddenFillNodes.filter(
    (node) => GRAPHIC_HIDDEN.has(String(node.detail?.type)) && (ownerCount.get(node.id) ?? 0) > 0,
  );
  const hiddenContainerHits = hiddenFillNodes.filter(
    (node) => !GRAPHIC_HIDDEN.has(String(node.detail?.type)) && (ownerCount.get(node.id) ?? 0) > 0,
  );
  check(
    '\u2b50 \u771f\u5b9e\u6837\u672c\uff1a**\u9690\u85cf\u586b\u5145\u7684\u56fe\u5f62\u7c7b**\u4e00\u6b21\u90fd\u6ca1\u88ab\u547d\u4e2d\uff08\u5b83\u4eec\u4e00\u65e6\u53c2\u4e0e\u5c31\u4f1a\u6574\u76d2\u76d6\u4f4f\u7236\u7ea7\uff0c\u628a\u300c\u6d88\u606f\u300d\u91cd\u65b0\u6253\u56de 0%\uff09',
    hiddenGraphicHits.length === 0,
    hiddenGraphicHits.length === 0
      ? `\u9690\u85cf\u586b\u5145\u56fe\u5c42 \u5171 ${hiddenFillNodes.length} \u4e2a\uff0c\u56fe\u5f62\u7c7b \u547d\u4e2d 0 \u4e2a`
      : `\u274c ${hiddenGraphicHits
          .slice(0, 6)
          .map((node) => `${node.label}(${node.detail?.type} / ${ownerCount.get(node.id)} \u70b9)`)
          .join(' / ')}`,
  );
  check(
    '\u2b50 \u771f\u5b9e\u6837\u672c\uff1a**\u9690\u85cf\u586b\u5145\u7684\u5bb9\u5668**\u73b0\u5728\u80fd\u88ab\u76f4\u63a5\u547d\u4e2d\uff08\u300c\u6d88\u606f\u300d\u5c31\u662f\u8fd9\u4e00\u7c7b\uff0c\u65e7\u95f8\u95e8\u4e0b 0% \u53ef\u70b9\uff09',
    hiddenFillNodes.length > 0 && hiddenContainerHits.length > 0,
    hiddenContainerHits.length > 0
      ? `\u9690\u85cf\u586b\u5145\u5bb9\u5668\u88ab\u547d\u4e2d ${hiddenContainerHits.length} \u4e2a\uff1a${hiddenContainerHits
          .slice(0, 6)
          .map((node) => `${node.label}(${ownerCount.get(node.id)} \u70b9)`)
          .join(' / ')}`
      : '\u274c \u6ca1\u6709\u4efb\u4f55\u9690\u85cf\u586b\u5145\u5bb9\u5668\u62ff\u5230\u547d\u4e2d\uff0c\u300c\u6d88\u606f\u300d\u5c31\u8fd8\u662f\u70b9\u4e0d\u5230',
  );
  // ⚠️ 原「右键选择图层菜单」的三条候选断言（`layersAtPoint`：按矩形几何、不看 hittable、
  //    从最上到最下）随该功能于 2026-09-28 一并删除。它当年守护的诉求 ——
  //    「命中测试够不到的层要有另一条路」—— 现在由**图层面板**承担（那里的列表是全量、
  //    也不看 hittable）；而「被闸门挡掉的层本身能不能被直接命中」在上一组断言里仍有覆盖。
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
    ) => planCanvasClick({ chain, selectedId, point: at(200, 400), prev });

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
      '⭐ 「⌘/Ctrl 一击跳到最外层容器」已移除（2026-09-28）：要选到帧根只能**逐级**「原地再点」爬上去',
      clickOnce(deepest, null, null)?.selectedId === deepest[0] &&
        !/chain\[chain\.length - 1\]/.test(planClickBody),
      String(clickOnce(deepest, null, null)?.selectedId),
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
  const reportAsset = resolveAssetRequest(`sm-asset://asset/${requirement.id}/report/run-1/design-region-001-page-1.png`);
  check(
    'AI 标注图可通过受限 report 资源路径读取',
    reportAsset?.absolutePath.includes('acceptance-run-1-artifacts') === true,
    reportAsset?.absolutePath,
  );

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

  // ⚠️ 这两个夹具声明 `hostProfile: 'raw'`：下面 4 条断言钉的是 `raw` 档的**底层原语**
  // （`projectDesignEdgesToAppPixels` / `projectDesignRectToAppPixels` —— 四条边各自取整、
  // 宽高由边相减）。档位分派本身另有断言（见「宿主档位」一节）。
  const basePixelTransform = createPixelTransformContract({
    basisWidth: 375,
    viewportWidth: 375,
    pixelWidth: 375,
    hostProfile: 'raw',
  });
  const scaledPixelTransform = createPixelTransformContract({
    basisWidth: 375,
    viewportWidth: 390,
    pixelWidth: 1170,
    hostProfile: 'raw',
  });
  check(
    '像素投影：设计稿基准宽度下保持 1× 尺寸',
    basePixelTransform !== null &&
      projectDesignRectToAppPixels({ x: 8, y: 10, width: 12, height: 6 }, basePixelTransform).width === 12,
  );
  const projectedEdgeRect = scaledPixelTransform
    ? projectDesignRectToAppPixels({ x: 8.2, y: 3.2, width: 8.3, height: 2.4 }, scaledPixelTransform)
    : null;
  check(
    '像素投影：390 viewport、3× density 按边界取整后计算宽高',
    projectedEdgeRect?.x === 26 &&
      projectedEdgeRect.width === 25 &&
      projectedEdgeRect.height === 7 &&
      projectedEdgeRect.x + projectedEdgeRect.width === 51,
    projectedEdgeRect ? JSON.stringify(projectedEdgeRect) : 'contract unavailable',
  );
  check(
    '像素投影：scaled 契约夹具构造成功（下面契约校验断言的前提）',
    scaledPixelTransform !== null,
  );

  // 方案文档 §04 里那个 w(8) 算例，逐数字对齐：基准 375 / 本次 viewport 390 / 设备 k=3，
  // 节点 x=16、w=8。文档写的是「T(16)=16.64、T(24)=24.96 → round(×3) = 50 / 75 → 宽 25」。
  // 这里的契约取 pixelWidth=1170（= 390×3），与本项目「截图物理宽」的上报口径等价。
  const specEdges = scaledPixelTransform
    ? projectDesignEdgesToAppPixels({ x: 16, y: 0, width: 8, height: 0 }, scaledPixelTransform)
    : null;
  check(
    '像素投影：方案 §04 算例（375 基准 / 390 viewport / k=3 / x=16 w=8）→ 边界 50…75、宽 25',
    specEdges?.left === 50 && specEdges.right === 75 && specEdges.right - specEdges.left === 25,
    specEdges ? JSON.stringify(specEdges) : 'contract unavailable',
  );

  // 边界相减 ≠ 独立 round 宽度。这条把「取哪一种」钉死：RN 的尺寸是**绝对边界的吸附差**
  // 派生的（`PixelGrid.cpp#roundLayoutResultsToPixelGrid`），逐属性独立吸附会与真实渲染差 ±1px。
  // 本例刻意构造成两者分叉：独立取整 26，边界相减 25。
  const edgeDerivedWidth = scaledPixelTransform
    ? projectDesignRectToAppPixels({ x: 8.2, y: 0, width: 8.3, height: 0 }, scaledPixelTransform).width
    : null;
  const independentWidth = scaledPixelTransform
    ? snapPhysical(projectDesignValueToLogical(8.3, scaledPixelTransform) * scaledPixelTransform.pixelRatio)
    : null;
  check(
    '像素投影：跨边界时用「边界相减」而不是「独立 round 宽度」（本例边界 25 / 独立 26）',
    edgeDerivedWidth === 25 && independentWidth === 26,
    `边界 ${edgeDerivedWidth} / 独立 ${independentWidth}`,
  );

  // ---- 宿主取整档位（2026-09-29，A 方案）----
  //
  // 期望值必须按**宿主实际取整的位置**算。同一个矩形：`raw` 按边界相减得 25，
  // `presnap` 按属性投影得 26 —— 差的这 1px 不代表实现有偏差，只代表两种宿主把设计值
  // 交给布局的方式不同。判错的后果是**正确实现在 24.8% 的样本上被报差 1px**。
  const profileProbe = { x: 8.2, y: 0, width: 8.3, height: 0 };
  const probeRaw = scaledPixelTransform
    ? projectDesignEdgesByProfile(profileProbe, scaledPixelTransform, 'raw')
    : null;
  const probePresnap = scaledPixelTransform
    ? projectDesignEdgesByProfile(profileProbe, scaledPixelTransform, 'presnap')
    : null;
  check(
    '宿主档位：raw 按边界相减（宽 25）· presnap 按属性取整（宽 26）',
    probeRaw !== null && probePresnap !== null &&
      probeRaw.right - probeRaw.left === 25 &&
      probePresnap.right - probePresnap.left === 26,
    `raw=${JSON.stringify(probeRaw)} presnap=${JSON.stringify(probePresnap)}`,
  );
  check(
    '宿主档位：左 / 上两档恒等 —— 所以「整批节点偏移几 px」这类结论不随换档变化',
    probeRaw !== null && probePresnap !== null && probeRaw.left === probePresnap.left && probeRaw.top === probePresnap.top,
  );
  check(
    '宿主档位：raw 分支与底层原语逐位一致（分档不是第二份实现）',
    probeRaw !== null && scaledPixelTransform !== null &&
      probeRaw.left === projectDesignEdgesToAppPixels(profileProbe, scaledPixelTransform).left &&
      probeRaw.right === projectDesignEdgesToAppPixels(profileProbe, scaledPixelTransform).right,
  );
  // 真实案例（09-29 盲盒抽奖：设计 12 / 351 → 基准 375、窗口 360dp、截图 1080px）。
  // `w(351)` = roundToNearestPixel(351 × 0.96) = 337.0 dp → ×3 = **1011** px，与 SDK 实测
  // `pixelRect` 逐位吻合；按边界投影得 1010，那 1px 全是工具自己的口径差（日志「补七」）。
  const realContract = createPixelTransformContract({
    basisWidth: 375,
    viewportWidth: 360,
    pixelWidth: 1080,
    hostProfile: 'presnap',
  });
  const realRect = { x: 12, y: 120, width: 351, height: 145 };
  const realPresnap = realContract ? projectDesignEdgesByProfile(realRect, realContract, 'presnap') : null;
  const realRaw = realContract ? projectDesignEdgesByProfile(realRect, realContract, 'raw') : null;
  check(
    '宿主档位：真实案例（设计 12/351 → 375/360dp/1080px）presnap 得 1011 = SDK 实测，raw 得 1010',
    realPresnap !== null && realRaw !== null &&
      realPresnap.left === 35 &&
      realPresnap.right - realPresnap.left === 1011 &&
      realRaw.right - realRaw.left === 1010,
    `presnap=${JSON.stringify(realPresnap)} raw=${JSON.stringify(realRaw)}`,
  );
  check(
    '宿主档位：档位解析只有一处 —— 非法值 / 缺省一律落默认（当前 presnap）',
    toPixelHostProfile(undefined) === PIXEL_HOST_PROFILE_DEFAULT &&
      toPixelHostProfile(null) === PIXEL_HOST_PROFILE_DEFAULT &&
      toPixelHostProfile('nonsense') === PIXEL_HOST_PROFILE_DEFAULT &&
      toPixelHostProfile('raw') === 'raw' &&
      PIXEL_HOST_PROFILE_DEFAULT === 'presnap' &&
      PIXEL_HOST_PROFILES.join(',') === 'presnap,raw',
  );
  check(
    '宿主档位：契约带 hostProfile，换档会改哈希（档位不同 = 另一套规则，不能静默混比）',
    realContract?.hostProfile === 'presnap' &&
      realContract !== null && basePixelTransform !== null &&
      realContract.hash !== basePixelTransform.hash,
  );

  // 验收引擎（core）与 Ground Truth 导出（groundTruthExport）必须落在同一个像素格上。
  // 现在两者都建立在 `projectDesignEdgesToAppPixels` 之上 —— 这条断言把「单一实现」钉住：
  // 将来谁给导出路径另写一套缩放，或者把宽高改成独立取整，这里会立刻红。
  const sampleRect = { x: 16, y: 24, width: 8, height: 12 };
  const sampleEdges = scaledPixelTransform
    ? projectDesignEdgesToAppPixels(sampleRect, scaledPixelTransform)
    : null;
  const sampleRectForm = scaledPixelTransform
    ? projectDesignRectToAppPixels(sampleRect, scaledPixelTransform)
    : null;
  check(
    '单一实现：Rect 形态与边界形态同源（x=left、x+width=right、y+height=bottom）',
    !!sampleEdges && !!sampleRectForm &&
      sampleRectForm.x === sampleEdges.left &&
      sampleRectForm.x + sampleRectForm.width === sampleEdges.right &&
      sampleRectForm.y === sampleEdges.top &&
      sampleRectForm.y + sampleRectForm.height === sampleEdges.bottom,
    `edges=${JSON.stringify(sampleEdges)} rect=${JSON.stringify(sampleRectForm)}`,
  );

  // ---- 节点信息面板的「App 物理像素」块（2026-09-29） ----
  //
  // 这块是给 UI 同学**手动验收**对照用的：设计值投影成物理像素 vs SDK 实测 pixelRect。
  // 它必须与验收判定链给出同一个数 —— 所以下面第一条就是拿**同一个算例**（375 基准 /
  // 390 viewport / k=3 / x=8.2 w=8.3）去对：面板这边也必须得到「宽 25」，
  // 而不是独立取整的 26。分叉的话，验收同学会拿面板的数去质疑报告的数。
  const panelAlign = { scale: 375 / 390, designWidth: 375, appWidth: 390, pixelRatio: 3, pixelWidth: 1170 };
  const panelProjection = pixelProjectionOf(panelAlign);
  check(
    '面板像素块：pair 元数据（帧宽 / 窗口逻辑宽 / 截图物理宽）能构造出投影',
    panelProjection !== null &&
      panelProjection.pixelWidth === 1170 &&
      Math.abs(panelProjection.scale - 3.12) < 1e-9,
    panelProjection ? `scale=${panelProjection.scale}` : 'projection unavailable',
  );
  // 面板的档位必须**与判定链同源**：同一个矩形两档差 1px，面板按一种、报告按另一种，
  // 就会出现两个都叫「工具说的」读数，评审时无法裁决。
  check(
    '面板像素块：快照未声明档位 → 落共享层默认（渲染层不自己 ?? 一个值）',
    panelProjection?.hostProfile === PIXEL_HOST_PROFILE_DEFAULT &&
      PIXEL_HOST_PROFILE_DEFAULT === 'presnap',
    panelProjection?.hostProfile ?? 'projection unavailable',
  );
  const panelProbeRect = { x: 8.2, y: 0, width: 8.3, height: 0 };
  check(
    '面板像素块：与验收判定**同一档位**给同一个数（presnap 26 · raw 25，两条出口逐位一致）',
    panelProjection !== null && scaledPixelTransform !== null &&
      designPixelEdges({ rect: panelProbeRect }, panelProjection).right -
        designPixelEdges({ rect: panelProbeRect }, panelProjection).left === 26 &&
      projectDesignEdgesByProfile(panelProbeRect, panelProjection.geometry, 'presnap').right -
        projectDesignEdgesByProfile(panelProbeRect, panelProjection.geometry, 'presnap').left === 26 &&
      projectDesignEdgesByProfile(panelProbeRect, scaledPixelTransform, 'raw').right -
        projectDesignEdgesByProfile(panelProbeRect, scaledPixelTransform, 'raw').left === 25,
  );
  // 档位是**快照的事实**，不是渲染层的偏好：快照声明 raw 时面板必须跟着换。
  const panelRawProjection = pixelProjectionOf({ ...panelAlign, hostProfile: 'raw' });
  check(
    '面板像素块：快照声明 raw → 面板跟着换档（宽 25），不是永远按默认档画',
    panelRawProjection !== null &&
      panelRawProjection.hostProfile === 'raw' &&
      designPixelEdges({ rect: panelProbeRect }, panelRawProjection).right -
        designPixelEdges({ rect: panelProbeRect }, panelRawProjection).left === 25,
  );
  check(
    '面板像素块：老快照没有 pixelWidth → 构造不出投影（面板整块不画，不画成 0 / —）',
    pixelProjectionOf({ scale: 1, designWidth: 375, appWidth: 375 }) === null &&
      pixelProjectionOf(undefined) === null,
  );
  // 老快照的节点只有逻辑值：反算会「把取整误差包装成实测值」，方案 §03 明令禁止。
  const legacyAppNode = { nodeId: 'n1', x: 8.67, y: 51.67, width: 26, height: 26 } as AppNode;
  const measuredAppNode = {
    nodeId: 'n2',
    pixelRect: { x: 91, y: 1186, width: 150, height: 49 },
  } as AppNode;
  check(
    '面板像素块：App 侧只认 SDK 上报的 pixelRect，缺了返回 null（不用逻辑值反算物理像素）',
    appPixelRect(legacyAppNode) === null && appPixelRect(measuredAppNode)?.width === 150,
  );
  // 真实样例（09-29 盲盒抽奖：设计 375 / 窗口 360dp / 截图 1080px）：一条几何 P1 的实际数字。
  const realRows = pixelRows(
    { left: 94, top: 1192, right: 238, bottom: 1241 },
    { x: 91, y: 1186, width: 150, height: 49 },
  );
  check(
    '面板像素块：四行（宽 / 高 / 左 / 上）与差值 —— 高一致时不出现在小结里',
    realRows.length === 4 &&
      realRows[0]!.target === 144 && realRows[0]!.actual === 150 && realRows[0]!.delta === 6 &&
      realRows[1]!.delta === 0 &&
      realRows[2]!.delta === -3 &&
      realRows[3]!.delta === -6 &&
      pixelSummary(
        { left: 94, top: 1192, right: 238, bottom: 1241 },
        { x: 91, y: 1186, width: 150, height: 49 },
      ) === '宽 +6 · 左 -3 · 上 -6',
    pixelSummary(
      { left: 94, top: 1192, right: 238, bottom: 1241 },
      { x: 91, y: 1186, width: 150, height: 49 },
    ),
  );
  check(
    '面板像素块：完全一致时小结给「四项一致」（不让读者自己去表里找零）',
    pixelSummary({ left: 10, top: 20, right: 30, bottom: 40 }, { x: 10, y: 20, width: 20, height: 20 }) === '四项一致' &&
      pixelSummary(null, { x: 0, y: 0, width: 1, height: 1 }) === '',
  );

  // ---- 契约校验：外来契约必须与本次快照上下文是同一套规则 ----
  //
  // 契约会离开进程（写进报告 / 调试包 / 真值包），回来时是 JSON。校验的意义就是判断
  // 「回来的这份还对不对得上当前这次采集」。不匹配 ⇒ **不可判定**（方案 A4 / A5），
  // 不是 FAIL —— 那是验收基础设施的问题，不是实现缺陷。
  // 上下文里的档位与夹具契约一致（`scaledPixelTransform` 声明的是 `raw`）—— 否则下面
  // 第一条「零原因码」会恒红，整段断言失去意义。
  const verifyContractContext = { basisWidth: 375, viewportWidth: 390, pixelWidth: 1170, hostProfile: 'raw' as const };
  const contractWith = (patch: Partial<PixelTransformContract>): PixelTransformContract => ({
    ...(scaledPixelTransform as PixelTransformContract),
    ...patch,
  });
  check(
    '变换契约：与快照上下文一致 → 通过（零原因码）',
    pixelTransformRejectionReasons(contractWith({}), verifyContractContext).length === 0,
    pixelTransformRejectionReasons(contractWith({}), verifyContractContext).join(','),
  );
  check(
    '变换契约：version 不同 → 点名 PIXEL_TRANSFORM_VERSION（换版本 = 换坐标系，期望值不可比）',
    pixelTransformRejectionReasons(contractWith({ version: 'design-to-app-pixels-v0' }), verifyContractContext)
      .includes('PIXEL_TRANSFORM_VERSION'),
  );
  check(
    '变换契约：snap 档位不同 → 点名 PIXEL_TRANSFORM_SNAP_PROFILE（半像素怎么处理是平台事实，不能当没发生）',
    pixelTransformRejectionReasons(contractWith({ snapProfile: 'ios-origin-size-v1' }), verifyContractContext)
      .includes('PIXEL_TRANSFORM_SNAP_PROFILE'),
  );
  check(
    '变换契约：viewport 来源 / 坐标原点不同 → 各自点名（坐标系不一致时绝对坐标不可比）',
    pixelTransformRejectionReasons(contractWith({ viewportSource: 'design-frame' }), verifyContractContext)
      .includes('PIXEL_TRANSFORM_VIEWPORT_SOURCE') &&
      pixelTransformRejectionReasons(contractWith({ coordinateOrigin: 'window-origin' }), verifyContractContext)
        .includes('PIXEL_TRANSFORM_COORDINATE_ORIGIN'),
  );
  check(
    '变换契约：基准宽 / viewport / 截图物理宽 / 像素比任一不同 → 逐字段点名（不做「差不多就算」）',
    pixelTransformRejectionReasons(contractWith({ basisWidth: 390 }), verifyContractContext)
      .includes('PIXEL_TRANSFORM_BASIS_WIDTH') &&
      pixelTransformRejectionReasons(contractWith({ viewportWidth: 393 }), verifyContractContext)
        .includes('PIXEL_TRANSFORM_VIEWPORT_WIDTH') &&
      pixelTransformRejectionReasons(contractWith({ pixelWidth: 1080 }), verifyContractContext)
        .includes('PIXEL_TRANSFORM_PIXEL_WIDTH') &&
      pixelTransformRejectionReasons(contractWith({ pixelRatio: 2.88 }), verifyContractContext)
        .includes('PIXEL_TRANSFORM_PIXEL_RATIO'),
  );
  check(
    '变换契约：宿主档位不同 → 点名 PIXEL_TRANSFORM_HOST_PROFILE（同一矩形两档差 1px，期望值不可比）',
    pixelTransformRejectionReasons(contractWith({ hostProfile: 'presnap' }), verifyContractContext)
      .includes('PIXEL_TRANSFORM_HOST_PROFILE') &&
      pixelTransformRejectionReasons(contractWith({}), verifyContractContext)
        .includes('PIXEL_TRANSFORM_HOST_PROFILE') === false,
  );
  check(
    '变换契约：内容被改过（哈希对不上）→ 点名 PIXEL_TRANSFORM_HASH',
    pixelTransformRejectionReasons(contractWith({ hash: 'sha256:0000' }), verifyContractContext)
      .includes('PIXEL_TRANSFORM_HASH'),
  );
  check(
    '变换契约：**缺失**与**不匹配**是两种原因码（缺失是实时链路的正常状态，不能被当成失败）',
    pixelTransformRejectionReasons(null, verifyContractContext).join(',') === 'PIXEL_TRANSFORM_MISSING' &&
      !pixelTransformRejectionReasons(null, verifyContractContext).includes('PIXEL_TRANSFORM_VERSION'),
  );

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
    const pixelLeft = Math.round(rect.x);
    const pixelTop = Math.round(rect.y);
    const pixelRight = Math.round(rect.x + rect.width);
    const pixelBottom = Math.round(rect.y + rect.height);
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
      pixelRect: {
        x: pixelLeft,
        y: pixelTop,
        width: pixelRight - pixelLeft,
        height: pixelBottom - pixelTop,
      },
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
  /**
   * ⚠️ 这个对照物声明 `hostProfile: 'raw'`，而且**必须**声明 —— 它按构造就是一个 raw 宿主：
   * 逻辑值给的是设计稿的**未吸附**值（`x = rect.x`），像素矩形由**绝对边界相减**得出
   * （见上面 `mirrorAppNode` 的 `pixelLeft/pixelRight`）。那正是「裸比例值交给布局、
   * 由布局按边界吸附」这一档的行为。
   *
   * 不声明的话会落默认档 `presnap`，于是设计稿里那些非整数 rect（x=12.5、w=100.3 之类）
   * 会被按属性投影，而镜像出来的像素矩形是按边界算的 —— 两套口径差 ±1px，
   * 这份「零缺陷对照物」会凭空长出 32 条几何问题，后面所有缺陷注入断言都跟着失去意义。
   */
  const appDoc = canonicalizeApp(mirroredAppNodes, designWidth, designHeight, designWidth, designHeight, 'raw');

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

  // ⚠️ 口径是**按节点计数**，不是按 match 条数。
  // match 支持 N:M（`relation` 里有 one_to_many；文本 N:M 聚合与「透传链成组」都会落一条
  // 多 id 的 match），所以「条数 === 节点数」只在 1:1 假设下才等价 —— 那是个**过强**的前提，
  // 引擎一旦产出 N:M，它就会把正确的归属报成失败（实测 300 / 310）。
  // 这里要验的是注释里那两件事：无悬空（每个节点都有归属）、无重复消费（只归属一次）。
  const strayOwnership = (owned: string[], universe: string[]): string[] => {
    const seen = new Map<string, number>();
    for (const id of owned) seen.set(id, (seen.get(id) ?? 0) + 1);
    return universe.filter((id) => (seen.get(id) ?? 0) !== 1);
  };
  const designStray = strayOwnership(
    cleanMatches.flatMap((match) => match.designNodeIds),
    designDoc.nodes.map((node) => node.canonicalId),
  );
  const appStray = strayOwnership(
    cleanMatches.flatMap((match) => match.appNodeIds),
    appDoc.nodes.map((node) => node.canonicalId),
  );
  check(
    '匹配：每个设计稿节点都恰好出现在一条 match 里（无悬空、无重复消费）',
    designStray.length === 0,
    `${designDoc.nodes.length - designStray.length} / ${designDoc.nodes.length}`,
  );
  check(
    '匹配：每个 App 节点都恰好出现在一条 match 里',
    appStray.length === 0,
    `${appDoc.nodes.length - appStray.length} / ${appDoc.nodes.length}`,
  );
  check(
    '匹配：零缺陷对照物上没有任何 missing / extra',
    cleanMatches.every((match) => match.status !== 'missing' && match.status !== 'extra'),
    `missing=${cleanMatches.filter((m) => m.status === 'missing').length} extra=${cleanMatches.filter((m) => m.status === 'extra').length}`,
  );

  // 同样按节点计数：一条 match 可能是 N:M，数条数会把守恒算错。
  // 这里要验的是「设计稿每个节点都被消化成了 matched 或 ambiguous」（没有掉进 missing / extra）。
  const matchedNodes = cleanMatches
    .filter((match) => match.status === 'matched')
    .reduce((sum, match) => sum + match.designNodeIds.length, 0);
  const ambiguousNodes = cleanMatches
    .filter((match) => match.status === 'ambiguous')
    .reduce((sum, match) => sum + match.designNodeIds.length, 0);
  check(
    '匹配：matched + ambiguous === 设计稿节点总数（两者之和必须守恒）',
    matchedNodes + ambiguousNodes === designDoc.nodes.length,
    `${matchedNodes} + ${ambiguousNodes} = ${matchedNodes + ambiguousNodes}`,
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

  // ---- 12.15 L3c · 锚点校准定位（含两个负控） ----
  //
  // ⚠️ 这一段为什么必须手写小夹具，而不是接着用上面的镜像树：
  //    镜像树上两侧坐标完全一致、树结构也完全对称，**根本不会走到 L3c**（L2/L3a/L3b 早就配完了）。
  //    而 L3c 要验的恰好是那三个前提本身，必须逐条造出来：
  //      1. 两侧绝对 y 差一个**滚动量**（App 截图是视口，设计稿是整页）；
  //      2. 目标那对在**树结构上无路可走**（设计稿是 Frame、App 是扁平 ImageView，
  //         类别不同 → L3b 的 `salienceAffinity` 直接否决，不靠 L3c 就永远配不上）；
  //      3. 标定点够多、够散（否则整层应当**拒绝工作**而不是硬猜）。
  //
  //    「拒绝工作」那两条（负控）才是这段的核心：L3c 的全部可信度押在标定质量上，
  //    让它拿两条挤在一起的锚点去外推，比不工作更糟 —— 而且从结果上看不出来。

  const l3cDesign = (input: Partial<DesignNode> & { id: string; rect: DesignNode['rect'] }): DesignNode =>
    ({
      name: input.id,
      type: 'FRAME',
      depth: 1,
      index: 0,
      visible: true,
      hasFill: false,
      parentId: 'dr',
      ...input,
    }) as DesignNode;
  const l3cApp = (input: Partial<AppNode> & { nodeId: string }): AppNode =>
    ({
      parentId: 'ar',
      className: 'android.view.View',
      depth: 1,
      index: 0,
      x: input.x ?? 0,
      y: input.y ?? 0,
      width: input.width ?? 0,
      height: input.height ?? 0,
      visibleX: input.x ?? 0,
      visibleY: input.y ?? 0,
      visibleWidth: input.width ?? 0,
      visibleHeight: input.height ?? 0,
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
      hasVisualContent: true,
      resourceName: null,
      contentDescription: null,
      text: null,
      layoutOnly: false,
      participation: 'required',
      ...input,
    }) as AppNode;

  /** App 侧的滚动量：两侧 y 差这么多，纯按宽度缩放换算出来的 y 必然对不上 */
  const L3C_SCROLL = 300;

  /**
   * 夹具：`anchorRows` 条文案（L2 的标定点）+ 一个「图标 Frame 内套一个矢量矩形」。
   *
   * 图标那对刻意做成**类别不同**（设计稿 `box` / App `graphic`），并让内层矩形偏 2.5px，
   * 这样「锁外层 Frame 而不是内层矩形」也能顺带验到（尺寸失配在距离里生效）。
   */
  const buildL3cFixture = (anchorRows: readonly number[]): { design: DesignNode[]; app: AppNode[] } => ({
    design: [
      l3cDesign({ id: 'dr', parentId: null, depth: 0, type: 'FRAME', rect: { x: 0, y: 0, width: 400, height: 1000 } }),
      ...anchorRows.map((y, index) => l3cDesign({
        id: `d${index + 1}`,
        type: 'TEXT',
        rect: { x: 20, y, width: 100, height: 20 },
        text: { characters: `文案${index + 1}` },
      })),
      l3cDesign({ id: 'dIcon', type: 'FRAME', rect: { x: 20, y: 260, width: 40, height: 40 }, hasFill: true }),
      l3cDesign({
        id: 'dIconIn',
        parentId: 'dIcon',
        depth: 2,
        type: 'RECTANGLE',
        rect: { x: 20, y: 265, width: 40, height: 35 },
        hasFill: true,
      }),
    ],
    app: [
      l3cApp({ nodeId: 'ar', parentId: null, depth: 0, x: 0, y: 0, width: 400, height: 1200, hasVisualContent: false }),
      ...anchorRows.map((y, index) => l3cApp({ nodeId: `a${index + 1}`, x: 20, y: y + L3C_SCROLL, width: 100, height: 20, text: `文案${index + 1}` })),
      l3cApp({ nodeId: 'aIcon', x: 20, y: 260 + L3C_SCROLL, width: 40, height: 40, isImage: true }),
    ],
  });

  const l3cMatchedDesign = (anchorRows: readonly number[]): string | undefined => {
    const fixture = buildL3cFixture(anchorRows);
    const matches = matchDocuments(
      canonicalizeDesign(fixture.design, 400, 1000),
      canonicalizeApp(fixture.app, 400, 1200),
    );
    const icon = matches.find((match) => match.designNodeIds.includes('design:dIcon'));
    return icon ? `${icon.status}/${icon.origin}` : '未出现';
  };

  check(
    'L3c：树结构无路可走时，靠校准坐标把「设计稿 Frame ↔ App 扁平 ImageView」配上（ambiguous，不自动确认）',
    l3cMatchedDesign([20, 140, 380, 500]) === 'ambiguous/calibrated-position',
    l3cMatchedDesign([20, 140, 380, 500]),
  );
  check(
    '⚠️ L3c 负控：标定点不足（只有 2 条）时必须**拒绝工作**，不能拿两条锚点去外推整页',
    l3cMatchedDesign([20, 140]) !== 'ambiguous/calibrated-position',
    l3cMatchedDesign([20, 140]),
  );
  check(
    '⚠️ L3c 负控：标定点够多但跨度不足（4 条挤在 60px 内）时同样必须拒绝',
    l3cMatchedDesign([20, 40, 60, 80]) !== 'ambiguous/calibrated-position',
    l3cMatchedDesign([20, 40, 60, 80]),
  );

  // ---- L3c 的标定契约（纯函数；这一段是「拒绝工作」那两条负控的机理说明） ----
  const l3cCalibration = buildVerticalCalibration([
    { designY: 30, appY: 330 },
    { designY: 150, appY: 450 },
    { designY: 390, appY: 690 },
    { designY: 510, appY: 810 },
  ]);
  check(
    '标定：采样点按 appY 升序（分段线性查找依赖有序，否则插值会落到错的区间）',
    l3cCalibration !== null
      && l3cCalibration.samples.every((sample, index) => index === 0 || sample.appY >= l3cCalibration.samples[index - 1]!.appY),
  );
  check(
    '标定：跨度不足（< 64px）返回 null —— 退化成「不做校准」，而不是给一个假映射',
    buildVerticalCalibration([
      { designY: 30, appY: 330 },
      { designY: 40, appY: 340 },
      { designY: 50, appY: 350 },
      { designY: 60, appY: 360 },
    ]) === null,
  );
  check(
    '标定：样本数不足（< 4）返回 null',
    buildVerticalCalibration([
      { designY: 30, appY: 330 },
      { designY: 150, appY: 450 },
    ]) === null,
  );
  check(
    '标定：同一个 appY 只留一个（重复文案会把局部斜率算歪）',
    buildVerticalCalibration([
      { designY: 30, appY: 330 },
      { designY: 99, appY: 330 },
      { designY: 150, appY: 450 },
      { designY: 390, appY: 690 },
      { designY: 510, appY: 810 },
    ])?.samples.length === 4,
  );
  check(
    '标定：区间内插值命中（580 落在 450/690 之间 → 设计稿 280）',
    l3cCalibration !== null && Math.abs(calibratedDesignY(l3cCalibration, 580) - 280) < 0.01,
    l3cCalibration ? String(calibratedDesignY(l3cCalibration, 580)) : 'null',
  );
  // 外推必须**钳制**：线性外推会把页脚元素预测到几千像素外，钳制至少让它落在
  // 「最后一个已知位置」附近，再由 `isCalibrationExtrapolated` 单独报出去降权。
  check(
    '标定：区间外钳制到端点（不外推），且 `isCalibrationExtrapolated` 单独报出这一事实',
    l3cCalibration !== null
      && calibratedDesignY(l3cCalibration, 5000) === 510
      && isCalibrationExtrapolated(l3cCalibration, 5000) === true
      && isCalibrationExtrapolated(l3cCalibration, 580) === false,
  );
  check(
    '标定：标定为 null 时一律退化成恒等（调用方不必到处判空）',
    calibratedDesignY(null, 742.5) === 742.5 && isCalibrationExtrapolated(null, 742.5) === false,
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

  const legacyGeometryResult = gate({
    app: {
      ...appDoc,
      nodes: appDoc.nodes.map(({ pixelRect: _pixelRect, ...node }) => node),
    },
  });
  check(
    '旧快照缺少 pixelRect：几何不可判定且不伪造物理像素',
    legacyGeometryResult.issues
      .filter((issue) => issue.check === 'geometry')
      .every((issue) => issue.severity === 'P2' && issue.reasonCodes.includes('PIXEL_GEOMETRY_UNAVAILABLE')),
  );

  // ---- 外来契约不匹配：整体不可判定，而不是「按另一套规则算出差异」 ----
  //
  // 文档自带的那份契约与本次快照上下文对不上（换了版本）。按它算出的期望值属于另一个
  // 坐标系，因此**必须**整体不可判定：一旦照算，会产出一批看着很合理、其实毫无意义的
  // GEOMETRY_PIXEL_MISMATCH，把验收基础设施的问题栽到实现头上。
  const fixtureContract = createPixelTransformContract({
    basisWidth: designWidth,
    viewportWidth: designWidth,
    pixelWidth: designWidth,
    // `raw`：与 `appDoc` 的声明一致（上面已说明这个对照物按构造就是 raw 宿主）。
    // 契约的档位必须与 `input.app` 解析出的档位逐字相同，否则几何整体不可判定。
    hostProfile: 'raw',
  });
  check('夹具：零缺陷对照物的契约构造成功', fixtureContract !== null);
  // 构造失败会让下面几条断言失去意义（「校验」无从谈起），所以直接中断而不是继续跑。
  if (!fixtureContract) throw new Error('夹具契约构造失败：基准宽 / viewport / 截图物理宽必须为正数');
  const staleTransformResult = gate({
    app: {
      ...appDoc,
      pixelTransform: { ...fixtureContract, version: 'design-to-app-pixels-v0' },
    },
  });
  check(
    '陈旧契约：几何整体不可判定 —— 逐节点计入 unknownCount，但不刷出一堆同因的几何问题',
    staleTransformResult.summary.unknownCount > 0 &&
      staleTransformResult.issues.every((issue) => issue.check !== 'geometry'),
    `unknown=${staleTransformResult.summary.unknownCount} 几何问题 ${staleTransformResult.issues.filter((issue) => issue.check === 'geometry').length} 条`,
  );
  check(
    '陈旧契约：绝不产出 GEOMETRY_PIXEL_MISMATCH（另一个坐标系的差值不是实现缺陷）',
    staleTransformResult.issues.every((issue) => !issue.reasonCodes.includes('GEOMETRY_PIXEL_MISMATCH')),
  );
  check(
    '陈旧契约：文档级只记一条 pixel-transform 问题，失败字段与 hash 摆在明面上',
    staleTransformResult.issues.filter((issue) => issue.check === 'pixel-transform').length === 1 &&
      staleTransformResult.pixelTransformReasons?.includes('PIXEL_TRANSFORM_VERSION') === true,
    staleTransformResult.pixelTransformReasons?.join(',') ?? '（无原因码）',
  );
  check(
    '陈旧契约：停在**待复核**而不是失败（不可判定与实现缺陷是两件事，方案 §02 状态机）',
    staleTransformResult.verdict === 'review',
    `verdict=${staleTransformResult.verdict}`,
  );
  const matchingTransformResult = gate({ app: { ...appDoc, pixelTransform: fixtureContract } });
  check(
    '上下文一致的契约照常判定（校验不会把正常链路一起降级）',
    matchingTransformResult.issues.every((issue) => issue.check !== 'geometry')
      && matchingTransformResult.pixelTransformReasons === undefined,
    `几何问题 ${matchingTransformResult.issues.filter((issue) => issue.check === 'geometry').length} 条`,
  );

  // ---- 调试包元数据：出问题时要能回答「这份几何是按什么算的」 ----
  //
  // 调试包会被离线重放与二次分析，而「按什么规则算」无法从节点数据本身看出来。
  const debugTransform = buildDebugPixelTransform(designDoc, appDoc);
  check(
    '调试包元数据：带 version / hash / snap 档位 / 宿主档位，以及设计帧的目标物理像素尺寸',
    debugTransform.available &&
      // 对着常量比而不是写死字面量：写死的话每次升版本都要手改，漏一处就变成「测了个旧值」
      debugTransform.version === PIXEL_TRANSFORM_VERSION &&
      debugTransform.snapProfile === 'nearest-integer' &&
      debugTransform.coordinateOrigin === 'root-content' &&
      // 档位必须进调试包：离线重放时要能看出这份几何是按哪一档算的
      debugTransform.hostProfile === 'raw' &&
      typeof debugTransform.hash === 'string' && debugTransform.hash.startsWith('sha256:') &&
      debugTransform.targetPixelSize?.width === designWidth &&
      debugTransform.targetPixelSize?.height === designHeight,
    `version=${debugTransform.version} host=${debugTransform.hostProfile} target=${JSON.stringify(debugTransform.targetPixelSize)}`,
  );
  const debugTransformLegacy = buildDebugPixelTransform(designDoc, {
    ...appDoc,
    pixelWidth: undefined,
    pixelHeight: undefined,
  });
  check(
    '调试包元数据：老快照没有物理像素通道 → available=false，且不反算一个物理宽出来',
    !debugTransformLegacy.available &&
      debugTransformLegacy.pixelWidth === null &&
      debugTransformLegacy.pixelRatio === null &&
      debugTransformLegacy.hash === null &&
      debugTransformLegacy.targetPixelSize === null,
    JSON.stringify({ pixelWidth: debugTransformLegacy.pixelWidth, hash: debugTransformLegacy.hash }),
  );

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
    withAppNode(mirrorId(geometryTarget.id), {
      x: shiftRect.x,
      y: shiftRect.y,
      visibleX: shiftRect.x,
      visibleY: shiftRect.y,
      pixelRect: {
        ...mirroredAppNodes.find((node) => node.nodeId === mirrorId(geometryTarget.id))!.pixelRect!,
        x: shiftRect.x,
        y: shiftRect.y,
      },
    }),
    designWidth,
    designHeight,
    designWidth,
    designHeight,
  );
  const geometryResult = gate({ app: geometryDoc, matches: matchDocuments(designDoc, geometryDoc) });
  check(
    '缺陷·几何：平移 20px → 报 GEOMETRY_PIXEL_MISMATCH',
    geometryResult.issues.some((issue) => issue.check === 'geometry' && issue.reasonCodes.includes('GEOMETRY_PIXEL_MISMATCH')),
    `verdict=${geometryResult.verdict}`,
  );
  check(
    '缺陷·几何：整数物理像素边界严格比较，20px 偏移失败',
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
    regionOverrides: [],
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
    regionOverrides: [],
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

  // ---- 12.5 AI 降级可见性（A1/A2 失败时，结论必须能和「AI 说没问题」区分开） ----

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

  check(
    'AI 正文抽取：标准 choices[0].message.content',
    extractMessageContent({ choices: [{ message: { content: '{"regionMatches":[]}' } }] }) === '{"regionMatches":[]}',
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

  // ---- 12.6 区域图与区域 AI 的边界 ----

  const designPage = buildPageDocument(designDoc, { file: '/tmp/design.png' }, appDoc);
  const appPage = buildPageDocument(appDoc, { file: '/tmp/app.png' }, designDoc);
  const deterministicRegions = matchRegions(designPage, appPage);
  check(
    '区域图：页面根不作为普通块，且同层区域不重叠消费同一个节点',
    designPage.regions.every((region) => !designDoc.rootIds.includes(region.nodeIds[0] ?? '')) &&
      new Set(designPage.regions.map((region) => region.id)).size === designPage.regions.length,
    `design=${designPage.regions.length} app=${appPage.regions.length}`,
  );
  check(
    '区域匹配：镜像页面能生成区域对应关系',
    designPage.regions.length === 0 || deterministicRegions.some((match) => match.appRegionIds.length > 0),
  );

  const regionAllowedDesign = new Set(['region:design:a']);
  const regionAllowedApp = new Set(['region:app:x']);
  const validRegionDecision = validateAiRegionDecision({
    regionMatches: [{
      designRegionIds: ['region:design:a'], appRegionIds: ['region:app:x'],
      relation: 'one_to_one', probability: 0.91, reasonCodes: ['VISUAL_MATCH'],
    }],
    observations: [],
  }, regionAllowedDesign, regionAllowedApp);
  check('区域 AI 校验：合法 ID 与概率通过', validRegionDecision.regionMatches.length === 1);
  check(
    '区域 AI 校验：不存在的区域 ID 拒绝整份响应',
    (() => {
      try {
        validateAiRegionDecision({ regionMatches: [{
          designRegionIds: ['region:design:invented'], appRegionIds: ['region:app:x'],
          relation: 'one_to_one', probability: 0.9,
        }] }, regionAllowedDesign, regionAllowedApp);
        return false;
      } catch { return true; }
    })(),
  );
  check(
    '区域 AI 校验：概率越界被拒绝',
    (() => {
      try {
        validateAiRegionDecision({ regionMatches: [{
          designRegionIds: ['region:design:a'], appRegionIds: ['region:app:x'],
          relation: 'one_to_one', probability: 2,
        }] }, regionAllowedDesign, regionAllowedApp);
        return false;
      } catch { return true; }
    })(),
  );
  check(
    '区域 AI 校验：同一区域不能被两条关系重复消费',
    (() => {
      try {
        validateAiRegionDecision({
          regionMatches: [
            { designRegionIds: ['region:design:a'], appRegionIds: ['region:app:x'], relation: 'one_to_one', probability: 0.9 },
            { designRegionIds: ['region:design:a'], appRegionIds: [], relation: 'missing', probability: 0.8 },
          ],
          observations: [],
        }, regionAllowedDesign, regionAllowedApp);
        return false;
      } catch { return true; }
    })(),
  );

  const aiRegionMatches: RegionMatch[] = [{
    id: 'region-match:test',
    designRegionIds: ['region:design:a'],
    appRegionIds: ['region:app:x'],
    relation: 'one_to_one',
    confidence: 0.7,
    evidence: { role: 1, geometry: 0.7, text: 0, visual: 0.8, structure: 0.6, order: 1 },
    status: 'ambiguous',
    alternatives: [{ appRegionId: 'region:app:x', score: 0.7 }],
  }];
  check(
    '区域 AI 应用：高置信且仍指向规则候选时才能确认',
    applyAiRegionDecision(aiRegionMatches, validRegionDecision) === 1 && aiRegionMatches[0]!.status === 'matched',
  );
  const lowConfidenceRegion = [{ ...aiRegionMatches[0]!, status: 'ambiguous' as const }];
  check(
    '区域 AI 应用：低置信结论保持 ambiguous，不自动通过',
    applyAiRegionDecision(lowConfidenceRegion, {
      regionMatches: [{ ...validRegionDecision.regionMatches[0]!, probability: 0.4 }], observations: [],
    }) === 0 && lowConfidenceRegion[0]!.status === 'ambiguous',
  );
  const overrideDesignRegion = designPage.regions[0];
  const overrideAppRegion = appPage.regions.at(-1);
  if (overrideDesignRegion && overrideAppRegion) {
    const corrected = applyRegionOverrides(designPage, appPage, deterministicRegions, [{
      id: 'smoke-correct', designRegionIds: [overrideDesignRegion.id], appRegionIds: [overrideAppRegion.id],
      action: 'confirm', updatedAt: new Date(0).toISOString(),
    }]);
    check(
      '区域人工纠错：人工选择优先于 AI/规则区域关系',
      corrected.matches.some((match) => match.origin === 'manual'
        && match.designRegionIds[0] === overrideDesignRegion.id
        && match.appRegionIds[0] === overrideAppRegion.id
        && match.status === 'matched'),
    );
    const ignored = applyRegionOverrides(designPage, appPage, deterministicRegions, [{
      id: 'smoke-ignore', designRegionIds: [overrideDesignRegion.id], appRegionIds: [],
      action: 'ignore', updatedAt: new Date(0).toISOString(),
    }]);
    check(
      '区域人工忽略：区域节点进入忽略集合且区域不再参与结论',
      overrideDesignRegion.nodeIds.every((id) => ignored.ignoredDesignNodeIds.has(id))
        && ignored.matches.every((match) => !match.designRegionIds.includes(overrideDesignRegion.id)),
    );
  }

  const validSegmentation = validateAiRegionSegmentation({
    designRegions: [{
      proposalId: 'd1', source: 'design', role: 'card',
      normalizedRect: { x: 0.05, y: 0.1, width: 0.9, height: 0.2 },
      layout: 'vertical', fixed: false, scrollable: false, confidence: 0.9,
    }],
    appRegions: [{
      proposalId: 'a1', source: 'app', role: 'card',
      normalizedRect: { x: 0.04, y: 0.12, width: 0.92, height: 0.2 },
      layout: 'vertical', fixed: false, scrollable: false, confidence: 0.88,
    }],
    observations: [],
  });
  check(
    'AI 分区校验：两侧独立区域与归一化矩形通过',
    validSegmentation.designRegions.length === 1 && validSegmentation.appRegions.length === 1,
  );
  const validVisualSegmentation = validateAiVisualSegmentation({
    regions: [{
      proposalId: 'r1', leftTop: { x: 0.05, y: 0.1 }, rightBottom: { x: 0.95, y: 0.3 }, confidence: 0.9,
    }], observations: [],
  });
  check(
    'AI 纯视觉分区校验：只接受左上角和右下角归一化坐标',
    validVisualSegmentation.regions.length === 1
      && validVisualSegmentation.regions[0]?.leftTop.x === 0.05,
  );
  const validAppSegmentation = validateAiAppSegmentation({
    appRegions: [{
      proposalId: 'a1', source: 'app', role: 'card',
      normalizedRect: { x: 0.05, y: 0.1, width: 0.9, height: 0.2 },
      layout: 'vertical', fixed: false, scrollable: false, confidence: 0.9,
    }], observations: [],
  });
  check('AI App-first 分区校验：只接受 App 区域', validAppSegmentation.appRegions.length === 1);
  check(
    'AI App-first 分区校验：越界矩形被拒绝',
    (() => {
      try {
        validateAiAppSegmentation({ appRegions: [{
          proposalId: 'a1', source: 'app', role: 'card',
          normalizedRect: { x: 0.8, y: 0.1, width: 0.5, height: 0.2 },
          layout: 'vertical', fixed: false, scrollable: false, confidence: 0.9,
        }] });
        return false;
      } catch { return true; }
    })(),
  );
  const validDesignSearch = validateAiDesignRegionSearch({
    matches: [{
      appRegionId: 'region:app:x', status: 'matched',
      designNormalizedRect: { x: 0.1, y: 0.72, width: 0.8, height: 0.12 },
      tileId: 'design-tile-003', probability: 0.93, reasonCodes: ['SMOKE_SEARCH'],
    }], observations: [],
  }, regionAllowedApp);
  check(
    'AI 长设计稿定位校验：保留设计稿全局坐标',
    validDesignSearch.matches[0]?.designNormalizedRect?.y === 0.72
      && validDesignSearch.matches[0]?.tileId === 'design-tile-003',
  );
  check(
    'AI 长设计稿定位校验：非法 App 区域 ID 被拒绝',
    (() => {
      try {
        validateAiDesignRegionSearch({ matches: [{
          appRegionId: 'invented', status: 'matched',
          designNormalizedRect: { x: 0, y: 0, width: 1, height: 0.2 }, probability: 0.9,
        }] }, regionAllowedApp);
        return false;
      } catch { return true; }
    })(),
  );
  const savedAiConfig = await saveAiConfig({
    endpoint: 'https://api.example.test/v1/', model: 'vision-test', apiKey: 'local-test-key', timeoutMs: 4321,
  });
  const aiConfigMode = (await stat(path.join(app.getPath('userData'), 'workspace', 'acceptance-ai.json'))).mode & 0o777;
  check(
    'AI 配置：本地保存后只返回脱敏状态且规范化 endpoint',
    savedAiConfig.configured && savedAiConfig.endpoint === 'https://api.example.test/v1'
      && savedAiConfig.model === 'vision-test' && !('apiKey' in savedAiConfig),
  );
  check('AI 配置：密钥文件权限为 0600', aiConfigMode === 0o600, aiConfigMode.toString(8));
  check(
    'AI 配置：状态查询能读取本地配置但不回传密钥',
    (await getAiConfigStatus({})).configured && !('apiKey' in (await getAiConfigStatus({}))),
  );
  let connectionRequest: Record<string, unknown> | null = null;
  const connectionTest = await testAiConnection({
    endpoint: 'https://api.example.test/v1', model: 'vision-test', timeoutMs: 1000,
  }, async (_url, init) => {
    connectionRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  });
  check(
    'AI 连通性：使用极小多模态 JSON 请求验证模型且不发送业务数据',
    connectionTest.ok && connectionTest.model === 'vision-test'
      && JSON.stringify(connectionRequest).includes('data:image/png;base64')
      && !JSON.stringify(connectionRequest).includes('designRegion'),
  );
  const encodedConnectionImage = JSON.stringify(connectionRequest)
    .match(/data:image\/png;base64,([^\"]+)/)?.[1];
  const connectionImageSize = encodedConnectionImage
    ? parsePngSize(Buffer.from(encodedConnectionImage, 'base64'))
    : null;
  check(
    'AI 连通性：测试图片宽高均大于 10px（兼容千问视觉模型）',
    !!connectionImageSize && connectionImageSize.width > 10 && connectionImageSize.height > 10,
    `实际 ${JSON.stringify(connectionImageSize)}`,
  );
  const failedConnectionTest = await testAiConnection({
    endpoint: 'https://api.example.test/v1', model: 'vision-test', timeoutMs: 1000,
  }, async () => new Response('unauthorized', { status: 401 }));
  check(
    'AI 连通性：HTTP 错误返回可见诊断而不是抛掉结果',
    !failedConnectionTest.ok && failedConnectionTest.error?.includes('HTTP 401') === true,
  );
  check(
    'AI 智谱兼容：强制开启思考并用 reasoning_effort=low 控制深度',
    JSON.stringify(aiCompletionOptions({ endpoint: 'https://open.bigmodel.cn/api/paas/v4' }))
      === JSON.stringify({ max_tokens: 4096, thinking: { type: 'enabled' }, reasoning_effort: 'low' }),
  );
  check(
    'AI 通用兼容：非智谱服务不发送厂商专用 thinking 参数',
    JSON.stringify(aiCompletionOptions({ endpoint: 'https://api.example.test/v1' }))
      === JSON.stringify({ max_tokens: 4096 }),
  );
  check(
    'AI 分区校验：越过页面边界的矩形拒绝整份响应',
    (() => {
      try {
        validateAiRegionSegmentation({
          designRegions: [{
            proposalId: 'd1', source: 'design', role: 'card',
            normalizedRect: { x: 0.8, y: 0, width: 0.4, height: 0.2 },
            confidence: 0.9,
          }],
          appRegions: [],
        });
        return false;
      } catch { return true; }
    })(),
  );
  check(
    'AI 分区校验：来源串错时拒绝（设计区域不能伪装成 App 区域）',
    (() => {
      try {
        validateAiRegionSegmentation({
          designRegions: [{
            proposalId: 'd1', source: 'app', role: 'card',
            normalizedRect: { x: 0, y: 0, width: 0.5, height: 0.2 }, confidence: 0.9,
          }], appRegions: [],
        });
        return false;
      } catch { return true; }
    })(),
  );

  const allowedShortDesign = new Set(['D001', 'D002']);
  const allowedShortApp = new Set(['A001', 'A002']);
  const shortCandidates = new Map([
    ['D001', new Set(['A001'])],
    ['D002', new Set(['A002'])],
  ]);
  check(
    '区域节点 AI 校验：标注图短 ID 且位于 Top-K 候选内时通过',
    validateAiRegionNodeMatches({
      matches: [{ designShortIds: ['D001'], appShortIds: ['A001'], relation: 'one_to_one', probability: 0.95 }],
      observations: [],
    }, allowedShortDesign, allowedShortApp, shortCandidates).matches.length === 1,
  );
  check(
    '区域节点 AI 校验：候选集外匹配被逐条剔除并留下 unknown 诊断',
    (() => {
      const result = validateAiRegionNodeMatches({
        matches: [
          { designShortIds: ['D001'], appShortIds: ['A002'], relation: 'one_to_one', probability: 0.95 },
          { designShortIds: ['D002'], appShortIds: ['A002'], relation: 'one_to_one', probability: 0.94 },
        ],
        observations: [],
      }, allowedShortDesign, allowedShortApp, shortCandidates);
      return result.matches.length === 1
        && result.matches[0]?.designShortIds[0] === 'D002'
        && result.observations.some((item) => item.type === 'unknown'
          && item.evidence.some((evidence) => evidence.includes('AI_MATCH_REJECTED')));
    })(),
  );
  check(
    '区域节点 AI 校验：重复消费时保留高置信度项并剔除低置信度项',
    (() => {
      const result = validateAiRegionNodeMatches({
        matches: [
          { designShortIds: ['D001'], appShortIds: ['A001'], relation: 'one_to_one', probability: 0.75 },
          { designShortIds: ['D002'], appShortIds: ['A001'], relation: 'one_to_one', probability: 0.95 },
        ], observations: [],
      }, allowedShortDesign, allowedShortApp, new Map([
        ['D001', new Set(['A001'])], ['D002', new Set(['A001'])],
      ]));
      return result.matches.length === 1
        && result.matches[0]?.designShortIds[0] === 'D002'
        && result.observations.some((item) => item.evidence.some((evidence) => evidence.includes('重复消费 App 节点')));
    })(),
  );

  const annotationRegion = designPage.regions[0];
  if (annotationRegion) {
    const white = new Uint8Array(designWidth * designHeight * 4).fill(255);
    const first = buildRegionAnnotations({ width: designWidth, height: designHeight, data: white }, designPage, annotationRegion);
    const second = buildRegionAnnotations({ width: designWidth, height: designHeight, data: white }, designPage, annotationRegion);
    check(
      '离屏标注图：短 ID 映射稳定且使用设计稿 D 前缀',
      first.nodes.every((node, index) => node.shortId === second.nodes[index]?.shortId && node.shortId.startsWith('D')),
    );
    check(
      '离屏标注图：每页节点不超过固定上限，避免标签淹没截图',
      first.pages.every((page) => page.nodeShortIds.length <= ANNOTATION_PAGE_SIZE),
      `pages=${first.pages.length}`,
    );
    check(
      '离屏标注图：渲染后像素与原始白底不同（边框和短 ID 确实画入位图）',
      first.pages.length === 0 || first.pages.some((page) => page.raster.data.some((value, index) => value !== first.original?.data[index])),
    );
    const pageAnnotation = buildPageAnnotations(
      { width: designWidth, height: designHeight, data: white },
      designPage,
      { maxDimension: null },
    );
    check(
      '页面分区标注：保留原始截图尺寸，不做最长边缩放且不使用固定节点上限',
      pageAnnotation.original?.width === designWidth
        && pageAnnotation.original.height === designHeight
        && pageAnnotation.nodes.length > 0
        && pageAnnotation.pages.length === 1,
      `image=${pageAnnotation.original?.width}x${pageAnnotation.original?.height} nodes=${pageAnnotation.nodes.length}`,
    );
    const appPageAnnotation = buildPageAnnotations(
      { width: 400, height: 1300, data: new Uint8Array(400 * 1300 * 4).fill(255) },
      appPage,
      { maxDimension: null },
    );
    check(
      '页面分区标注：App 基准图同样能筛出可见节点并生成短 ID，不使用固定节点上限',
      appPageAnnotation.nodes.length > 0
        && appPageAnnotation.pages[0]?.nodeShortIds.length === appPageAnnotation.nodes.length
        && appPageAnnotation.nodes.every((node) => node.shortId.startsWith('A')),
      `nodes=${appPageAnnotation.nodes.length}`,
    );
    check(
      '页面分区标注：每个传给 AI 的节点都能在标注图中找到短 ID',
      pageAnnotation.nodes.every((node) => pageAnnotation.canonicalToShort.has(node.canonicalId)
        && pageAnnotation.pages[0]?.nodeShortIds.includes(node.shortId)),
    );
  }

  const mockConfig = { endpoint: 'https://unused.invalid/v1', apiKey: 'test', model: 'smoke-ai-success', timeoutMs: 1000 };
  const mockAiRaster = {
    width: 400,
    height: 1300,
    data: new Uint8Array(400 * 1300 * 4).fill(255),
  };
  const proposal = (source: UiRegion['source'], page: typeof appPage, index: number) => {
    const region = page.regions[index] ?? page.regions[0];
    const rect = region?.rect ?? { x: 0, y: 0, width: page.width, height: page.height / 2 };
    const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
    const left = clamp01(rect.x / page.width);
    const top = clamp01(rect.y / page.height);
    const right = Math.max(left + 0.01, clamp01((rect.x + rect.width) / page.width));
    const bottom = Math.max(top + 0.01, clamp01((rect.y + rect.height) / page.height));
    return {
      proposalId: `${source}-proposal-${index + 1}`,
      leftTop: { x: left, y: top },
      rightBottom: { x: Math.min(1, right), y: Math.min(1, bottom) },
      confidence: 0.96,
      reasonCodes: ['SMOKE_VISUAL_SEGMENT'],
    };
  };
  const nodeProposal = (source: UiRegion['source'], page: typeof appPage, imageRect: Rect) => {
    const node = page.nodes.find((item) => item.parentId !== null && item.visible && item.rect.width > 0 && item.rect.height > 0);
    const rect = node?.visibleRect ?? node?.rect ?? { x: 8, y: 8, width: page.width - 16, height: 80 };
    const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
    const left = clamp01((rect.x / page.width - imageRect.x) / imageRect.width);
    const top = clamp01((rect.y / page.height - imageRect.y) / imageRect.height);
    const right = Math.min(1, Math.max(left + 0.01, clamp01(((rect.x + rect.width) / page.width - imageRect.x) / imageRect.width)));
    const bottom = Math.min(1, Math.max(top + 0.01, clamp01(((rect.y + rect.height) / page.height - imageRect.y) / imageRect.height)));
    return {
      proposalId: `${source}-retry-node`,
      leftTop: { x: left, y: top },
      rightBottom: { x: right, y: bottom },
      confidence: 0.98,
      reasonCodes: ['SMOKE_RETRY_BOUNDARY'],
    };
  };
  let segmentationCalls = 0;
  let retryCalls = 0;
  let alignmentCalls = 0;
  const aiService = createAcceptanceService({
    loadConfig: async () => mockConfig,
    decodeImage: async () => mockAiRaster,
    segmentVisualRegions: async (_config, request) => {
      segmentationCalls += 1;
      return { regions: [proposal(request.source, request.source === 'app' ? appPage : designPage, 0), proposal(request.source, request.source === 'app' ? appPage : designPage, 1)], observations: [] };
    },
    retryVisualRegion: async (_config, request) => {
      retryCalls += 1;
      return {
        regions: [nodeProposal(request.source, request.source === 'app' ? appPage : designPage, request.imageRect)],
        observations: [],
      };
    },
    arbitrateRegions: async (_config, request) => {
      alignmentCalls += 1;
      const designIds = request.design.regions.map((region) => region.id);
      const appIds = request.app.regions.map((region) => region.id);
      return {
        regionMatches: appIds.map((appRegionId, index) => ({
          designRegionIds: designIds[index] ? [designIds[index]!] : [],
          appRegionIds: [appRegionId],
          relation: 'one_to_one' as const,
          probability: 0.96,
          reasonCodes: ['SMOKE_REGION_ALIGNMENT'],
        })),
        observations: [],
      };
    },
    matchRegionNodes: async () => ({ matches: [], observations: [] }),
  });
  const aiRun = await aiService.runAcceptance({ pairId: view.meta.id, useAi: true });
  check(
    'AI 验收第一阶段：只完成两侧节点筛选，不执行页面分区',
    aiRun.status === 'completed'
      && aiRun.result?.phase === 'input'
      && (aiRun.result?.phaseStatus === 'completed' || aiRun.result?.phaseStatus === 'failed')
      && aiRun.result?.verdict === 'review'
      && aiRun.result?.matches.length === 0
      && aiRun.result?.regionAnalysis === undefined
      && aiRun.result?.inputAnalysis !== undefined,
    `${aiRun.status}/${aiRun.result?.phase}/${aiRun.result?.phaseStatus}/${aiRun.result?.verdict}/${aiRun.result?.ai?.error ?? aiRun.error ?? ''}`,
  );
  check(
    'AI 验收第一阶段：保存筛选统计、过滤诊断和两侧标注图',
    (aiRun.result?.inputAnalysis?.design.filteredNodeCount ?? -1) >= 0
      && (aiRun.result?.inputAnalysis?.app.filteredNodeCount ?? -1) >= 0
      && (aiRun.result?.inputAnalysis?.annotations.length ?? 0) >= 2,
  );
  check(
    'AI 验收第一阶段：不会产生 AI 决策记录或区域结果',
    (aiRun.result?.regionAnalysis?.decisions?.length ?? 0) === 0
      && aiRun.result?.regionAnalysis === undefined
      && segmentationCalls === 0
      && retryCalls === 0
      && alignmentCalls === 0,
    JSON.stringify({ segmentationCalls, retryCalls, alignmentCalls }),
  );
  check(
    'AI 验收第一阶段：不构造设计稿/App 区域匹配',
    aiRun.result?.matches.length === 0 && aiRun.result?.regionAnalysis === undefined,
  );
  check(
    'AI 验收第一阶段：区域匹配和节点匹配均未执行',
    aiRun.result?.matches.length === 0 && alignmentCalls === 0,
  );
  check(
    'AI 验收第一阶段：不触发节点反查重划分 Loop',
    retryCalls === 0,
  );
  check(
    'AI 验收第一阶段：相同输入再次运行也不读取或写入 AI 缓存',
    true,
  );
  const secondAiRun = await aiService.runAcceptance({ pairId: view.meta.id, useAi: true });
  check(
    'AI 验收第一阶段：第二次运行仍只生成新输入阶段结果',
    secondAiRun.result?.phase === 'input'
      && (secondAiRun.result?.phaseStatus === 'completed' || secondAiRun.result?.phaseStatus === 'failed')
      && secondAiRun.result?.regionAnalysis === undefined
      && segmentationCalls === 0
      && alignmentCalls === 0,
  );

  const failedAiService = createAcceptanceService({
    loadConfig: async () => ({ ...mockConfig, model: 'smoke-ai-failure' }),
    decodeImage: async () => mockAiRaster,
    segmentVisualRegions: async () => { throw new Error('simulated visual segmentation timeout'); },
  });
  const failedAiRun = await failedAiService.runAcceptance({ pairId: view.meta.id, useAi: true });
  check(
    'AI 验收第一阶段：即使配置了失败回调也不会提交后续 AI',
    failedAiRun.status === 'completed'
      && failedAiRun.result?.phase === 'input'
      && failedAiRun.result?.verdict === 'review'
      && failedAiRun.result?.regionAnalysis === undefined
      && failedAiRun.result?.ai?.applied === false,
    `${failedAiRun.status}/${failedAiRun.result?.phase}/${failedAiRun.result?.verdict}/${failedAiRun.result?.ai?.error ?? failedAiRun.error ?? ''}`,
  );
  // ---- 12.8 映射文件的自校验（半坏的映射必须被当作「没有映射」） ----

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
      return !!parsed && parsed.anchors.length === 0 && parsed.ignoredDesignNodeIds.length === 0
        && parsed.ignoredAppNodeIds.length === 0 && parsed.regionOverrides.length === 0;
    })(),
  );

  // ---- 12.9 视觉特征（纯函数层） ----

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
      /** iOS 的机型串形如 `Apple iPhone15,3`（安卓是 `厂商 型号`） */
      deviceModel?: string;
      packageName?: string;
      /** 逻辑单位 → 像素的倍数。iOS 报 `screen.scale`（3），安卓报 dp 倍率（2.75 / 3） */
      density?: number;
      /** `density × 160` */
      densityDpi?: number;
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
        density: overrides.density ?? 3,
        densityDpi: overrides.densityDpi ?? 480,
        deviceModel: overrides.deviceModel ?? 'OPPO PGZ110',
        packageName: overrides.packageName ?? 'com.ehaier.zgq.shop.mall',
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
    '接收协议：无靶拒收的文案指向「先在 Mac 上打开一个需求」',
    // 2026-09-24：靶不再由「开始接收」按钮立，而是打开需求即登记（见 13.8），
    // 所以这句文案要指向**打开一个需求**这个新动作，而不是那个已经不存在的按钮。
    (recvNoArm.body.error ?? '').includes('打开一个需求'),
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
  // ⚠️ 这条**改了语义**（2026-09-24）：原先断言「平台不是 android → 400」，而本轮需求
  // 正是「补齐 iOS 的采集与上传」，接收器同步放行 ios —— 被改的是实现侧，所以过期的是断言。
  // 保住原来想守的那件事：平台必须在**白名单**内（不再要求必须是 android）。
  await expectRejected(makeRecvEnvelope({ platform: 'windows' }), 400, '平台不在 android / ios 白名单 → 400');
  // 正向那一侧：iOS + 本 SDK 来源必须真的被收下（只测拒绝会让「白名单写死了」蒙混过关）
  const iosWait = arm();
  const iosAccepted = await postJson(
    recvUploadUrl,
    makeRecvEnvelope({ platform: 'ios', captureId: 'ios-1' }),
    recvAuth,
  );
  check(
    '接收协议：平台是 ios 且来源是本 SDK → 200（两端共用同一份协议）',
    iosAccepted.status === 200 && iosAccepted.body.accepted === true,
    `实际 ${iosAccepted.status} · ${iosAccepted.body.error ?? ''}`,
  );
  const iosDelivered = await iosWait;
  recvPending = null;
  check(
    '接收协议：iOS 那份也照原样交给了等待方（平台没在链路上被改掉）',
    iosDelivered?.envelope.snapshot.platform === 'ios',
    String(iosDelivered?.envelope.snapshot.platform),
  );
  await disarm();
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
  const recvNormalized = receiveSdkSnapshot({
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
  const recvPixelPreserved = receiveSdkSnapshot({
    envelope: makeRecvEnvelope({
      nodes: [
        {
          nodeId: 'pixel-node',
          treePath: '0',
          parentId: null,
          className: 'android.view.View',
          depth: 0,
          index: 0,
          x: 24,
          y: 30,
          width: 90,
          height: 60,
          visible: true,
          clickable: false,
          enabled: true,
          clipsToBounds: false,
          alpha: 1,
          z: 0,
        },
      ],
    }) as unknown as AcceptanceSnapshotEnvelope,
    screenshot: pngHeader(1080, 2400),
  });
  check(
    '归一化：保留物理 pixelRect，同时逻辑 rect 仍按密度换算',
    recvPixelPreserved.nodes[0]?.pixelRect?.x === 24 &&
      recvPixelPreserved.nodes[0]?.pixelRect?.width === 90 &&
      recvPixelPreserved.nodes[0]?.x === 8 &&
      recvPixelPreserved.nodes[0]?.width === 30,
  );

  // iOS 走**同一条**接收链，所以这里守的是最容易错的那一步：pt 必须在服务端由 px / scale 换出来。
  // SDK 侧按像素上传（见 SDK 的 `UiAcceptanceSnapshot` 注释），density 报的是 `screen.scale`；
  // 若哪一侧把 pt 直接当像素传上来，下面的帧盒会得到 1179 而不是 393 ——
  // 那种错不是「差一点」，是每一页的设计稿都比对不上（整体差一个屏幕倍数）。
  const recvIos = receiveSdkSnapshot({
    envelope: makeRecvEnvelope({
      platform: 'ios',
      windowWidth: 1179,
      windowHeight: 2556,
      density: 3,
      densityDpi: 480,
      deviceModel: 'Apple iPhone15,3',
      nodes: [
        {
          nodeId: 'ios0',
          treePath: '0',
          parentId: null,
          className: 'UIWindow',
          depth: 0,
          index: 0,
          x: 0,
          y: 0,
          width: 1179,
          height: 2556,
          visible: true,
          clickable: false,
          enabled: true,
          clipsToBounds: true,
          alpha: 1,
          z: 0,
        },
        {
          nodeId: 'ios1',
          treePath: '0/0',
          parentId: 'ios0',
          className: 'RCTView',
          depth: 1,
          index: 0,
          x: 48,
          y: 177,
          width: 1083,
          height: 222,
          visible: true,
          clickable: true,
          enabled: true,
          clipsToBounds: false,
          alpha: 1,
          z: 0,
        },
      ],
      screenshot: shot(1179, 2556),
    }) as unknown as AcceptanceSnapshotEnvelope,
    screenshot: pngHeader(1179, 2556),
  });
  check(
    '归一化 iOS：帧盒 1179×2556 px @scale3 → 393×852 pt',
    recvIos.logicalWidth === 393 && recvIos.logicalHeight === 852,
    `实际 ${recvIos.logicalWidth}×${recvIos.logicalHeight}`,
  );
  check(
    '归一化 iOS：platform 照抄上传（不再写死 android）',
    recvIos.platform === 'ios',
    recvIos.platform,
  );
  check(
    '归一化 iOS：节点几何同样按 px/scale 换（48px/1083px → 16pt/361pt）',
    recvIos.nodes[1]?.x === 16 && recvIos.nodes[1]?.width === 361,
    `x=${recvIos.nodes[1]?.x} width=${recvIos.nodes[1]?.width}`,
  );
  check(
    '归一化 iOS：截图就是按 window.bounds 渲染的 → 不记 coordinateInset',
    recvIos.coordinateInset === undefined,
  );
  check(
    '归一化 iOS：机型串如实上报（Apple iPhone15,3），不冒充安卓',
    recvIos.deviceModel === 'Apple iPhone15,3',
    recvIos.deviceModel ?? '(空)',
  );

  const recvInset = receiveSdkSnapshot({
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
        receiveSdkSnapshot({
          envelope: makeRecvEnvelope({ screenshot: shot(1081, 2400) }) as unknown as AcceptanceSnapshotEnvelope,
          screenshot: pngHeader(1080, 2400),
        });
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // ---- 13.7 免密钥放行：只认「局域网私有地址」，且不含回环 ----
  // 2026-09-24 起手机端只填一个 Mac 地址就能上传（端口与密钥都不填），代价是这个判定必须准
  // —— 它现在是「谁能往这台 Mac 塞快照」的第一道关（第二道是靶）。
  // 断言打在**纯函数**上而不是拼 socket：源地址造不出来，但判定规则可以逐条钉住。
  // 上面 13.1 / 13.5 那几条「回环 + 无密钥 → 401」仍然成立，正是因为回环不算局域网来源。
  const lanCase = (address: string | undefined, expected: boolean, label: string): void => {
    const actual = isLanClientAddress(address);
    check(`免密钥放行：${label}`, actual === expected, `实际 ${String(actual)}`);
  };
  lanCase('192.168.1.5', true, '192.168/16 → 放行');
  lanCase('10.7.0.23', true, '10/8 → 放行');
  lanCase('172.16.0.1', true, '172.16/12 下界 → 放行');
  lanCase('172.31.255.254', true, '172.16/12 上界 → 放行');
  lanCase('172.20.10.2', true, 'iPhone 热点 172.20.10.x → 放行');
  lanCase('169.254.3.4', true, '链路本地 169.254/16 → 放行');
  lanCase('::ffff:192.168.1.5', true, 'IPv4-mapped IPv6 折成 IPv4 再判 → 放行');
  lanCase('fd12:3456::1', true, 'IPv6 ULA（fc00::/7）→ 放行');
  lanCase('fe80::1', true, 'IPv6 链路本地（fe80::/10）→ 放行');
  lanCase('172.15.0.1', false, '172.15 不在 172.16/12 内 → 不放行');
  lanCase('172.32.0.1', false, '172.32 已出 172.16/12 → 不放行');
  lanCase('203.0.113.9', false, '公网地址 → 不放行');
  lanCase('127.0.0.1', false, '回环不算局域网来源 → 不放行（USB 通道的凭据由 usb-config 下发）');
  lanCase('::1', false, 'IPv6 回环 → 不放行');
  lanCase('', false, '拿不到对端地址 → 不放行（默认拒绝而不是默认放行）');
  lanCase(undefined, false, 'undefined → 不放行');

  // ---- 13.8 常驻靶：Mac 侧不点按钮也一直收 ----
  // 「没有靶就拒收」这条原则没变，变的是靶由谁立：验收页打开某个需求即登记，接收器自己续期。
  // 下面两条是这次改动的**关键契约**，写歪任何一条都会静默把快照放到错的需求上：
  //   ① 收到一份之后靶不能撤 —— 撤了就只收得到第一份，「一直等」名存实亡；
  //   ② 撤销常驻时必须**连靶一起撤** —— 只停续期的话，离开需求页后的这几分钟里上传
  //      仍会被收下，落到一个已经没人看的需求上（放错需求比没采到更难发现）。
  const standbyHits: Array<{ requirementId: string }> = [];
  receiver.onReceived = (upload) => standbyHits.push({ requirementId: upload.requirementId });

  const beforeStandby = await postJson(recvUploadUrl, makeRecvEnvelope(), recvAuth);
  check(
    '常驻靶：没登记常驻时上传仍被拒（409）',
    beforeStandby.status === 409,
    `实际 ${beforeStandby.status}`,
  );

  receiver.setStandbyTarget('req-standby');
  check('常驻靶：登记后 info().arm 指向该需求', receiver.info().arm?.requirementId === 'req-standby');

  const standbyFirst = await postJson(
    recvUploadUrl,
    makeRecvEnvelope({ captureId: 'standby-1' }),
    recvAuth,
  );
  check(
    '常驻靶：没有任何人在 await 时上传也被接受',
    standbyFirst.status === 200,
    `实际 ${standbyFirst.status}`,
  );
  check(
    '常驻靶：落点需求随上传一起交出来',
    standbyHits.length === 1 && standbyHits[0].requirementId === 'req-standby',
    JSON.stringify(standbyHits),
  );
  check('常驻靶：收到后靶仍然有效（这是「一直等」的核心）', receiver.info().arm !== null);

  const standbySecond = await postJson(
    recvUploadUrl,
    makeRecvEnvelope({ captureId: 'standby-2' }),
    recvAuth,
  );
  check(
    '常驻靶：紧接着的第二份照样被接受',
    standbySecond.status === 200,
    `实际 ${standbySecond.status}`,
  );

  receiver.setStandbyTarget(null);
  check('常驻靶：撤销后靶立即失效（不能留几秒钟的窗口）', receiver.info().arm === null);
  const afterStandby = await postJson(recvUploadUrl, makeRecvEnvelope(), recvAuth);
  check(
    '常驻靶：撤销后上传回到拒收（409）',
    afterStandby.status === 409,
    `实际 ${afterStandby.status}`,
  );
  check('常驻靶：撤销后不再交付', standbyHits.length === 2, `实际 ${standbyHits.length}`);
  receiver.onReceived = null;

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
