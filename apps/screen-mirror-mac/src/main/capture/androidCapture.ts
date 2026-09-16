/**
 * Android 采集的归一化层：把 SDK 上传的「节点树 + 截图」转成 Mac 侧的统一契约。
 *
 * **截图也来自 SDK**（App 里点悬浮按钮时一并拍下、同一个请求传上来）。
 * 之前截图是 Mac 侧 `adb screencap` 取的，节点却由 SDK 经局域网上传 —— 两条通道各有各的延迟，
 * 靠 captureId 强行配对，稍微慢一点就会「节点是这一屏、图是下一屏」。
 * 现在两者在同一帧产生、同一个 body 送达，这个错位从根上没有了。
 *
 * 本文件里的 adb 相关代码（`listAndroidDevices` / `parseWmSize` / `parseDensity` /
 * `parseUiAutomatorXml`）**已不在验收采集路径上**：设备列表仍是「USB 是否连上」的诊断，
 * uiautomator 解析只为兼容读取历史快照。别再把它们接回采集主流程。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AndroidDeviceInfo } from '../../types/ipc';
import type { AppNode } from '../../types/verify';
import {
  normalizeSdkSnapshot,
  type CollectionQuality,
  type SdkSnapshotPayload,
} from '../../types/acceptance';
import type { AcceptanceUpload } from './acceptanceReceiver';

const ADB_SERVER_HOST = '127.0.0.1';
const ADB_SERVER_PORT = 5037;

// ---------- Tango ADB 的模块边界收口（beta 版本类型不稳定，只在此处 any） ----------

interface AdbDeviceLike {
  serial: string;
  state?: string;
  model?: string;
}

interface AdbModules {
  AdbServerClient: new (connector: unknown) => {
    getDevices(states?: string[]): Promise<AdbDeviceLike[]>;
    createAdb(opts: { serial: string }): Promise<unknown>;
  };
  AdbServerNodeTcpConnector: new (opts: { host: string; port: number }) => unknown;
}

// ---------- 对外类型 ----------

/**
 * 一次采集的归一化结果。
 *
 * 尺寸的权威顺序 **截图真实尺寸 > SDK 上报的窗口尺寸**：截图是后续叠图/裁切/取色的底图，
 * 帧盒与节点必须跟它走。SDK 的 window 通常比整屏少一条系统栏，两者不一致时记录差值交给裁决，
 * 由 `evaluateAcceptance` 降级为待复核 —— 这里只负责如实采到，不替验收下结论。
 */
export interface AndroidCaptureOutput {
  screenshot: Uint8Array;
  nodes: AppNode[];
  source: 'sdk';
  captureId: string;
  /**
   * 逻辑尺寸（dp），与设计稿逻辑 px 同量纲。
   * 保留 2 位小数，且与节点 rect 走**同一个** `toLogical` —— 否则末位节点会超出帧盒。
   */
  logicalWidth: number;
  logicalHeight: number;
  /** 截图**真实**像素尺寸（取自 PNG 的 IHDR，不信任上传里的声明值） */
  pixelWidth: number;
  pixelHeight: number;
  densityDpi: number;
  collection: CollectionQuality;
  /**
   * SDK 窗口尺寸 ≠ 截图尺寸时的差值（见 `AppSnapshotMeta.coordinateInset`）。
   * 常见成因是系统栏；不阻断，但要传到验收裁决里降级为待复核。
   */
  coordinateInset?: {
    sdkWidth: number;
    sdkHeight: number;
    screenshotWidth: number;
    screenshotHeight: number;
  };
  deviceModel?: string;
  packageName?: string;
  /** 非致命告警，例如 SDK 窗口与截图尺寸不一致 */
  warning?: string;
}

// ---------- adb：仅保留「设备是否连上」的诊断能力 ----------
//
// 采集主路径已经不再用 adb（截图与节点都由 SDK 上传）。这里剩下的只有设备枚举，
// 供设置页展示「USB 是否连上」。下面是踩过的坑：命令一律给超时，
// 否则 adb server 卡住会连带把窗口的 IPC 响应挂死。

function resolveAdbPath(): string {
  const env = process.env;
  const candidates = [
    env['ANDROID_HOME'] && path.join(env['ANDROID_HOME'], 'platform-tools', 'adb'),
    env['ANDROID_SDK_ROOT'] && path.join(env['ANDROID_SDK_ROOT'], 'platform-tools', 'adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    '/usr/bin/adb',
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) || 'adb';
}

function ensureAdbServer(): Promise<void> {
  const adbPath = resolveAdbPath();
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['start-server'], { timeout: 10_000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr.trim() || error.message}（无法启动 ADB server）`));
        return;
      }
      resolve();
    });
  });
}

let modulesPromise: Promise<AdbModules> | null = null;

function loadModules(): Promise<AdbModules> {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import('@yume-chan/adb'),
      import('@yume-chan/adb-server-node-tcp'),
    ]).then(([adb, connector]) => ({
      AdbServerClient: adb.AdbServerClient,
      AdbServerNodeTcpConnector: connector.AdbServerNodeTcpConnector,
    })) as unknown as Promise<AdbModules>;
  }
  return modulesPromise;
}

// ---------- 解析 ----------

/**
 * `wm size` → 显示尺寸（像素）。可能同时有 Physical / Override 两行，**优先 Override**。
 *
 * ⚠️ 这里必须与 `parseDensity` 取同一行。
 *
 * `screencap` 与 `uiautomator dump` 拿到的都是 **SurfaceFlinger 当前 display**，
 * 设备一旦开了 `wm size` 覆盖（测试机为模拟分辨率常这么开），二者输出的都是
 * **Override 尺寸**而非物理尺寸。若此处取 Physical，就会与截图/节点差出
 * `Physical / Override` 倍 —— 实测 1440×3120 / 1080×1920 的机器上，
 * 帧盒会算成 480dp 而节点只铺到 360dp，**整层错位 1.33 倍**。
 *
 * 当然，更权威的是 PNG 里的真实宽高，见 `resolveDisplaySize`。
 */
export function parseWmSize(output: string): { width: number; height: number } | null {
  const physical = /Physical size:\s*(\d+)x(\d+)/i.exec(output);
  const override = /Override size:\s*(\d+)x(\d+)/i.exec(output);
  const match = override ?? physical;
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * `wm density` → densityDpi（如 420）。换算到 dp 用 `160 / densityDpi`。
 * 同样**优先 Override**，与 `parseWmSize` 保持同源。
 */
export function parseDensity(output: string): number | null {
  const physical = /Physical density:\s*(\d+)/i.exec(output);
  const override = /Override density:\s*(\d+)/i.exec(output);
  const match = override ?? physical;
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** PNG 文件头：8 字节签名 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * 从 PNG 字节流读真实宽高（IHDR 块）。
 *
 * 为什么不能只信 `wm size`：**截图尺寸才是唯一事实**，`wm size` 只是旁证。
 * 一旦设备开了 `wm size` 覆盖、或 ROM 对 screencap 做了额外处理，两者就会分叉，
 * 而分叉的后果是帧盒与截图错位（见 `resolveDisplaySize`）。
 *
 * IHDR 位置固定：8 字节签名 + 4 字节块长 + 4 字节类型 `IHDR` → 宽高落在第 16 / 20 字节。
 */
export function parsePngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  // 'I' 'H' 'D' 'R'
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 像素 → 逻辑（dp），**统一保留 2 位小数**。
 *
 * 节点 rect 与帧盒必须共用这一个函数：帧盒若 `Math.round` 成整数而节点留真值，
 * 末位节点会超出帧盒零点几 dp（右/下边缘被 `overflow` 裁掉），
 * 截图也会被 `object-fit: fill` 按帧盒拉伸 → 与节点层产生亚像素错位。
 * 例：dpi=420 时 `1080 × 160/420 = 411.428…`，取整成 411 就与节点真值差 0.43dp。
 */
export function toLogical(pixel: number, scaleToLogical: number): number {
  return Math.round(pixel * scaleToLogical * 100) / 100;
}

/**
 * 定夺本次采集的「显示尺寸」，并在分叉时给出告警。
 *
 * 优先级：**PNG 真实尺寸 > `wm size`**。两者不一致时以截图为准 ——
 * 截图是后续一切比对（叠图、裁切、取色）的底图，
 * 帧盒/节点若按 `wm size` 走就会与底图错位。
 */
export function resolveDisplaySize(
  wmSize: { width: number; height: number } | null,
  pngSize: { width: number; height: number } | null,
): { size: { width: number; height: number }; warning?: string } | null {
  if (pngSize) {
    if (wmSize && (wmSize.width !== pngSize.width || wmSize.height !== pngSize.height)) {
      return {
        size: pngSize,
        warning:
          `设备上报的显示尺寸 ${wmSize.width}×${wmSize.height} 与截图实际尺寸 ` +
          `${pngSize.width}×${pngSize.height} 不一致（设备可能开了 wm size 覆盖），` +
          `已按截图真实尺寸为准。`,
      };
    }
    return { size: pngSize };
  }
  if (wmSize) {
    return {
      size: wmSize,
      warning: '无法从截图中读取尺寸（可能不是 PNG），已回退到 wm size 上报的尺寸。',
    };
  }
  return null;
}

const XML_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
};

function unescapeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    attrs[match[1]!] = unescapeXml(match[2]!);
  }
  return attrs;
}

/** `bounds="[l,t][r,b]"` → 矩形 */
function parseBounds(value: string | undefined): { x: number; y: number; width: number; height: number } | null {
  if (!value) return null;
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(value);
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1, 5).map(Number) as [number, number, number, number];
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * 解析 uiautomator 的 XML 视图树。
 *
 * 不用 XML 库：uiautomator 的输出由系统生成、格式规整，
 * 且属性值里的 `>` 一定被转义成 `&gt;`，因此「匹配到第一个 `>` 为止」是安全的。
 */
export function parseUiAutomatorXml(xml: string, scaleToLogical: number): AppNode[] {
  const nodes: AppNode[] = [];
  // 栈里存 id 路径，用于生成 parentId 与稳定的节点 id
  const stack: string[] = [];

  const tagRe = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(xml)) !== null) {
    if (match[0] === '</node>') {
      stack.pop();
      continue;
    }

    const attrs = parseAttributes(match[1] ?? '');
    const selfClosing = match[2] === '/';

    const index = Number(attrs['index'] ?? '0') || 0;
    const idPath = [...stack, `${index}`].join('.');
    const nodeId = `uia:${idPath}`;
    const parentId = stack.length > 0 ? `uia:${stack[stack.length - 1]}` : null;

    const bounds = parseBounds(attrs['bounds']) ?? { x: 0, y: 0, width: 0, height: 0 };
    // 与帧盒（`captureAndroid` 的 logicalWidth/Height）共用同一取整规则，否则末位节点会超出帧盒
    const px = (value: number): number => toLogical(value, scaleToLogical);

    const className = attrs['class'] ?? '';
    const textValue = attrs['text'] ?? '';
    const descValue = attrs['content-desc'] ?? '';
    const resourceId = attrs['resource-id'] ?? '';
    const isImage = /imageview|(^|\.)image($|\.)|photo/i.test(className);

    nodes.push({
      nodeId,
      parentId,
      className,
      depth: stack.length,
      index,

      // uiautomator 的 bounds 已经是**屏幕上的实际可见区域**（裁剪后的），
      // 所以 x/y/width/height 与 visible* 同值。
      x: px(bounds.x),
      y: px(bounds.y),
      width: px(bounds.width),
      height: px(bounds.height),
      visibleX: px(bounds.x),
      visibleY: px(bounds.y),
      visibleWidth: px(bounds.width),
      visibleHeight: px(bounds.height),

      // uiautomator 不提供滚动偏移
      scrollX: 0,
      scrollY: 0,

      visible: attrs['displayed'] === undefined ? true : attrs['displayed'] === 'true',
      enabled: attrs['enabled'] !== 'false',
      clickable: attrs['clickable'] === 'true',

      alpha: 1,
      z: 0,
      elevation: 0,
      // uiautomator 不暴露裁剪标记；bounds 已裁剪，无需再算
      clipsToBounds: false,

      isImage,
      isSvg: false,
      isGradient: false,
      hasVisualContent: isImage || textValue.length > 0 || descValue.length > 0,

      resourceName: resourceId || null,
      contentDescription: descValue || null,
      text: textValue || null,
    });

    if (!selfClosing) stack.push(`${index}`);
  }

  return nodes;
}

// ---------- 对外 API ----------

export async function listAndroidDevices(): Promise<AndroidDeviceInfo[]> {
  const modules = await loadModules();
  await ensureAdbServer();

  const connector = new modules.AdbServerNodeTcpConnector({
    host: ADB_SERVER_HOST,
    port: ADB_SERVER_PORT,
  });
  const server = new modules.AdbServerClient(connector);
  const devices = await server.getDevices(['device', 'unauthorized', 'offline']);

  return devices.map((device) => ({
    serial: device.serial,
    model: device.model,
    state: device.state,
  }));
}

/**
 * 把一份 SDK 上传归一化成 Mac 侧的采集结果。
 *
 * 这是**纯函数**：给同样的上传，永远得到同样的输出。原来这里要连 adb、跑 `wm size` /
 * `screencap` / `dumpsys`，任何一条命令抖动都会改变结果，也就没法断言「一次采集到底采到了什么」。
 *
 * 尺寸的权威顺序 **截图真实尺寸 > SDK 上报的窗口尺寸**：截图是后续叠图/裁切/取色的底图，
 * 帧盒与节点必须跟它走。上传里声明的 `width/height` 只用来与图片实际尺寸**对账** ——
 * 声明值与真实字节不符说明客户端编码或传输坏了，此时唯一安全的动作是拒收。
 */
export function receiveAndroidSnapshot(upload: AcceptanceUpload): AndroidCaptureOutput {
  const { envelope, screenshot } = upload;
  const snapshot: SdkSnapshotPayload = envelope.snapshot;

  const pngSize = parsePngSize(screenshot);
  if (!pngSize) throw new Error('上传的截图不是可解析的 PNG（读不到 IHDR 尺寸）');
  const declared = envelope.screenshot;
  if (pngSize.width !== declared.width || pngSize.height !== declared.height) {
    throw new Error(
      `上传截图的声明尺寸 ${declared.width}×${declared.height} 与图片实际 ` +
      `${pngSize.width}×${pngSize.height} 不符`,
    );
  }
  const size = pngSize;

  // densityDpi 取自 SDK 上报的 DisplayMetrics（`normalizeSdkSnapshot` 已经处理了
  // densityDpi 缺失时用 density 兜底）。像素 → dp 的换算必须与节点 rect 同源，
  // 所以这里只用归一化结果里的那一个值。
  const normalized = normalizeSdkSnapshot(snapshot, size.width, size.height);
  const densityDpi = normalized.densityDpi;
  const scaleToLogical = 160 / densityDpi;

  const warnings: string[] = [];
  // SDK 的 window 与整屏 display 通常差一条系统栏。这里不纠偏（纠偏需要知道
  // 是状态栏还是导航栏、以及在哪一侧，属于页面平移策略），只把差值记下来交给裁决 ——
  // 本函数的职责是「如实采到」，不是「替验收下结论」。
  const windowMismatch =
    snapshot.windowWidth !== size.width || snapshot.windowHeight !== size.height;
  if (windowMismatch) {
    warnings.push(
      `SDK 节点窗口尺寸 ${snapshot.windowWidth}×${snapshot.windowHeight} ` +
      `与截图 ${size.width}×${size.height} 不一致，已按截图尺寸作为帧基准，` +
      '该配对的几何结论将降级为待复核。',
    );
  }

  return {
    screenshot,
    nodes: normalized.nodes,
    source: 'sdk',
    captureId: envelope.captureId,
    logicalWidth: toLogical(size.width, scaleToLogical),
    logicalHeight: toLogical(size.height, scaleToLogical),
    pixelWidth: size.width,
    pixelHeight: size.height,
    densityDpi,
    collection: normalized.collection,
    coordinateInset: windowMismatch
      ? {
          sdkWidth: snapshot.windowWidth,
          sdkHeight: snapshot.windowHeight,
          screenshotWidth: size.width,
          screenshotHeight: size.height,
        }
      : undefined,
    deviceModel: snapshot.deviceModel,
    packageName: snapshot.packageName,
    warning: warnings.length > 0 ? warnings.join(' ') : undefined,
  };
}
