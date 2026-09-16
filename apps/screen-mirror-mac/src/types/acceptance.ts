import type { AppNode, Rect } from './verify';

export const SDK_ACCEPTANCE_PROTOCOL = 'ui-acceptance-sdk-v2' as const;

export type CollectionParticipation = 'required' | 'optional' | 'context' | 'ignored' | 'unavailable';

export interface CollectionQuality {
  profile: 'acceptance-full' | string;
  requestedMaxDepth: number;
  requestedMaxNodes: number;
  actualDepth: number;
  actualNodeCount: number;
  depthLimitReached: boolean;
  nodeLimitReached: boolean;
  hiddenNodesIncluded: boolean;
  zeroSizeNodesIncluded: boolean;
  textIncluded: boolean;
  excludedNodes: Array<{
    reason: 'sdk-overlay' | 'explicit-ignore';
    count: number;
  }>;
}

export interface SdkNodeState {
  visible: boolean;
  attached?: boolean;
  hasVisualContent?: boolean;
  layoutOnly?: boolean;
  zeroSize?: boolean;
  hiddenByAncestor?: boolean;
  outsideVisibleRect?: boolean;
  clipped?: boolean;
  participation?: CollectionParticipation;
}

export interface SdkAppNode {
  nodeId: string;
  treePath?: string;
  parentId: string | null;
  className: string;
  resourceName?: string | null;
  contentDescription?: string | null;
  text?: string | null;
  textRedacted?: boolean;

  depth: number;
  index: number;
  siblingCount?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visibleX?: number | null;
  visibleY?: number | null;
  visibleWidth?: number | null;
  visibleHeight?: number | null;

  visible: boolean;
  attached?: boolean;
  hasVisualContent?: boolean;
  isSvg?: boolean;
  isImage?: boolean;
  isGradient?: boolean;
  clickable: boolean;
  enabled: boolean;
  clipsToBounds: boolean;
  alpha: number;
  z: number;
  elevation?: number;
  scrollX?: number;
  scrollY?: number;
  state?: SdkNodeState;
}

export interface SdkSnapshotPayload {
  platform: 'android';
  source: 'react-native-ui-acceptance';
  timestamp: number;
  captureDurationMs?: number;
  nodeCount: number;
  windowWidth: number;
  windowHeight: number;
  density?: number;
  densityDpi?: number;
  scaledDensity?: number;
  /**
   * 机型（`Build.MANUFACTURER + Build.MODEL`）与前台包名。
   *
   * 这两个字段以前是 Mac 侧通过 adb（`dumpsys window`）拿的。截图改由 SDK 上传后，
   * adb 整条链路退出验收路径，设备信息只能由采集方自己如实上报。
   */
  deviceModel?: string;
  packageName?: string;
  nodes: SdkAppNode[];
  collection: CollectionQuality;
}

/**
 * SDK 一并上传的屏幕截图。
 *
 * ⚠️ 为什么是 **base64 走 JSON**，而不是 multipart 或单独一条通道：
 * 截图与节点树必须来自**同一帧**——分两次请求就会遇到「先传了节点、再传截图时页面已经翻页」，
 * 而两者对不上时，验收画布上的节点层与底图会整体错位，这种错位看起来像「开发写歪了」，
 * 比直接报错更难查。放在同一个 body 里，服务端一次性接受或一次性拒绝。
 */
export interface SdkScreenshot {
  mimeType: 'image/png';
  /** 截图**真实**像素尺寸（SDK 侧编码时的位图尺寸）。 */
  width: number;
  height: number;
  /** 标准 base64，**不带** `data:image/png;base64,` 前缀。 */
  base64: string;
}

export interface AcceptanceSnapshotEnvelope {
  protocol: typeof SDK_ACCEPTANCE_PROTOCOL;
  captureId: string;
  sdkVersion: string;
  snapshot: SdkSnapshotPayload;
  screenshot: SdkScreenshot;
}

/**
 * 常驻接收器凭据。
 *
 * 与旧的「每次采集开一个一次性 session」相比，这里只有一份**长期有效**的密钥：
 * 它落在 workspace 里，App 端配对一次即可反复使用。旧模型要求每次采集都把
 * endpoint/token/captureId 三个值送到手机上，而手机与 Mac 之间并没有可靠的通道 ——
 * 实际结果是要人手抄一长串随机字符，且必须在等待窗口内抄完。悬浮按钮要「点一下就走」，
 * 前提就是凭据不能每次都变。
 */
export interface AcceptanceReceiverInfo {
  port: number;
  token: string;
  createdAt: string;
  /** 当前等待接收的目标；null 表示没有需求在等，此时上传会被拒。 */
  arm: AcceptanceArmState | null;
}

/** 接收靶：把「下一份上传」绑定到某个需求上。 */
export interface AcceptanceArmState {
  requirementId: string;
  expiresAt: string;
}

export interface ArmAcceptanceTargetInput {
  requirementId: string;
  ttlMs?: number;
}

export interface SdkSnapshotAccepted {
  accepted: true;
  captureId: string;
  nodeCount: number;
  screenshotBytes: number;
  serverTimestamp: number;
}

export interface NormalizedSdkSnapshot {
  nodes: AppNode[];
  logicalWidth: number;
  logicalHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  densityDpi: number;
  collection: CollectionQuality;
  capturedAt: string;
}

function toLogical(value: number, densityDpi: number): number {
  return Math.round(value * (160 / densityDpi) * 100) / 100;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}

function toRect(
  x: number,
  y: number,
  width: number,
  height: number,
  densityDpi: number,
): Rect {
  return {
    x: toLogical(x, densityDpi),
    y: toLogical(y, densityDpi),
    width: toLogical(Math.max(0, width), densityDpi),
    height: toLogical(Math.max(0, height), densityDpi),
  };
}

/** Convert SDK px coordinates to the existing logical AppNode contract. */
export function normalizeSdkSnapshot(
  snapshot: SdkSnapshotPayload,
  pixelWidth: number,
  pixelHeight: number,
): NormalizedSdkSnapshot {
  const densityDpi = finitePositive(snapshot.densityDpi, finitePositive(snapshot.density, 1) * 160);
  const nodeIds = new Map<string, string>();

  for (const [index, node] of snapshot.nodes.entries()) {
    const path = node.treePath || String(index);
    nodeIds.set(node.nodeId, `sdk:${path}`);
  }

  const nodes: AppNode[] = snapshot.nodes.map((node, index) => {
    const path = node.treePath || String(index);
    const rect = toRect(node.x, node.y, node.width, node.height, densityDpi);
    const hasVisibleRect =
      node.visibleX !== null &&
      node.visibleY !== null &&
      node.visibleWidth !== null &&
      node.visibleHeight !== null &&
      node.visibleX !== undefined &&
      node.visibleY !== undefined &&
      node.visibleWidth !== undefined &&
      node.visibleHeight !== undefined;
    const visibleRect = hasVisibleRect
      ? toRect(node.visibleX!, node.visibleY!, node.visibleWidth!, node.visibleHeight!, densityDpi)
      : rect;
    const canonicalId = nodeIds.get(node.nodeId) || `sdk:${path}`;
    const state = node.state;

    return {
      nodeId: canonicalId,
      treePath: path,
      parentId: node.parentId ? nodeIds.get(node.parentId) || null : null,
      className: node.className,
      depth: node.depth,
      index: node.index,
      siblingCount: node.siblingCount,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      visibleX: visibleRect.x,
      visibleY: visibleRect.y,
      visibleWidth: visibleRect.width,
      visibleHeight: visibleRect.height,
      scrollX: toLogical(node.scrollX ?? 0, densityDpi),
      scrollY: toLogical(node.scrollY ?? 0, densityDpi),
      visible: node.visible,
      enabled: node.enabled,
      clickable: node.clickable,
      alpha: node.alpha,
      z: node.z,
      elevation: node.elevation ?? 0,
      clipsToBounds: node.clipsToBounds,
      isImage: node.isImage ?? false,
      isSvg: node.isSvg ?? false,
      isGradient: node.isGradient ?? false,
      hasVisualContent: node.hasVisualContent ?? false,
      resourceName: node.resourceName ?? null,
      contentDescription: node.contentDescription ?? null,
      text: node.text ?? null,
      participation: state?.participation,
      zeroSize: state?.zeroSize ?? (rect.width <= 0 || rect.height <= 0),
      hiddenByAncestor: state?.hiddenByAncestor ?? false,
      outsideVisibleRect: state?.outsideVisibleRect ?? false,
      clipped: state?.clipped ?? node.state?.clipped ?? false,
      layoutOnly: state?.layoutOnly ?? false,
      textRedacted: node.textRedacted ?? false,
    };
  });

  return {
    nodes,
    logicalWidth: toLogical(snapshot.windowWidth, densityDpi),
    logicalHeight: toLogical(snapshot.windowHeight, densityDpi),
    pixelWidth,
    pixelHeight,
    densityDpi,
    collection: snapshot.collection,
    capturedAt: new Date(snapshot.timestamp).toISOString(),
  };
}

/** base64 里最多允许的截图体积（解码后）；超出的都属于异常上传，直接拒。 */
export const MAX_SCREENSHOT_BYTES = 24 * 1024 * 1024;

/** PNG 文件头 8 字节签名。截图必须是 PNG —— Mac 侧的纯 TS 解码器只认它。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function isPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * 校验并解码上传的截图。
 *
 * 逐项检查而不是「尽力而为」：截图是整条验收链路的底图。一份能被 base64 解出来、
 * 但不是 PNG、或尺寸字段与真实字节不符的截图，会在很久之后以「画布错位」的形态暴露出来，
 * 那时已经没有人记得它来自哪次上传了。所以宁可在边界上拒掉。
 */
export function decodeScreenshot(screenshot: SdkScreenshot): Uint8Array {
  if (!screenshot || typeof screenshot !== 'object') throw new Error('SDK 上传缺少截图');
  if (screenshot.mimeType !== 'image/png') {
    throw new Error(`SDK 截图只支持 image/png，收到：${String(screenshot.mimeType)}`);
  }
  if (!Number.isFinite(screenshot.width) || !Number.isFinite(screenshot.height)) {
    throw new Error('SDK 截图尺寸无效');
  }
  if (screenshot.width <= 0 || screenshot.height <= 0) throw new Error('SDK 截图尺寸必须为正数');
  const base64 = screenshot.base64;
  if (typeof base64 !== 'string' || base64.length === 0) throw new Error('SDK 截图内容为空');

  // `Buffer.from(x, 'base64')` 会**静默丢掉**非法字符，于是「半个字节流」也能解出一段东西来。
  // 先按 base64 字母表卡一道，非法输入就不会被悄悄修好。
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error('SDK 截图不是合法的 base64');
  }
  if ((base64.length / 4) * 3 > MAX_SCREENSHOT_BYTES) {
    throw new Error('SDK 截图超过 24MB 限制');
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength === 0) throw new Error('SDK 截图解码后为空');
  if (!isPng(bytes)) throw new Error('SDK 截图不是 PNG（文件头签名不匹配）');
  return bytes;
}

export function validateSdkSnapshotEnvelope(value: unknown): AcceptanceSnapshotEnvelope {
  if (!value || typeof value !== 'object') throw new Error('SDK 节点上传不是对象');
  const envelope = value as Partial<AcceptanceSnapshotEnvelope>;
  if (envelope.protocol !== SDK_ACCEPTANCE_PROTOCOL) throw new Error('SDK 节点协议版本不匹配');
  if (typeof envelope.captureId !== 'string' || envelope.captureId.length === 0) {
    throw new Error('SDK 节点上传缺少 captureId');
  }
  const snapshot = envelope.snapshot;
  if (!snapshot || snapshot.platform !== 'android' || snapshot.source !== 'react-native-ui-acceptance') {
    throw new Error('SDK 节点来源必须是 Android react-native-ui-acceptance');
  }
  if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) {
    throw new Error('SDK 节点树为空');
  }
  if (!snapshot.collection || typeof snapshot.collection !== 'object') {
    throw new Error('SDK 节点缺少 collection 采集质量信息');
  }
  // 截图必填：Mac 侧已不再自己截屏，缺了它就等于这次上传没有任何底图。
  decodeScreenshot(envelope.screenshot as SdkScreenshot);

  const ids = new Set<string>();
  for (const node of snapshot.nodes) {
    if (!node || typeof node.nodeId !== 'string' || ids.has(node.nodeId)) {
      throw new Error('SDK 节点 nodeId 缺失或重复');
    }
    ids.add(node.nodeId);
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.width) || !Number.isFinite(node.height)) {
      throw new Error(`SDK 节点 ${node.nodeId} 的几何数据无效`);
    }
  }
  for (const node of snapshot.nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) {
      throw new Error(`SDK 节点 ${node.nodeId} 的 parentId 不存在`);
    }
  }
  return envelope as AcceptanceSnapshotEnvelope;
}
