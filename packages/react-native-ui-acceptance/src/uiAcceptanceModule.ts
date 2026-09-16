import { NativeModules, Platform } from 'react-native';

export interface UiAcceptanceOptions {
  /** Draw native bounds over the current window. */
  showOverlay?: boolean;
  /** Draw class name and dimensions beside each node. */
  showLabels?: boolean;
  /** Include hidden or transparent native nodes that are still attached to the window. */
  includeInvisible?: boolean;
  /** Include nodes with zero width or height. */
  includeZeroSize?: boolean;
  /** Include text from native text controls. Disabled by default. */
  includeText?: boolean;
  maxDepth?: number;
  maxNodes?: number;
  refreshIntervalMs?: number;
}

export interface AcceptanceCaptureOptions extends UiAcceptanceOptions {
  profile?: 'acceptance-full';
}

export interface UiAcceptanceNode {
  nodeId: string;
  treePath?: string;
  parentId: string | null;
  className: string;
  resourceName?: string | null;
  contentDescription?: string | null;
  accessibilityIdentifier?: string | null;
  accessibilityLabel?: string | null;
  text?: string | null;
  depth: number;
  index: number;
  siblingCount?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Android native visible rectangle after ancestor clipping. */
  visibleX?: number | null;
  visibleY?: number | null;
  visibleWidth?: number | null;
  visibleHeight?: number | null;
  scrollX?: number;
  scrollY?: number;
  visible: boolean;
  attached?: boolean;
  /** Whether the native node itself has visible content or a non-transparent background. */
  hasVisualContent?: boolean;
  /** Whether the node is the native host view for a react-native-svg tree. */
  isSvg?: boolean;
  /** Whether the node is a native image host, including asynchronously loading images. */
  isImage?: boolean;
  /** Whether the node is a native linear-gradient host that paints with Canvas/Core Animation. */
  isGradient?: boolean;
  zeroSize?: boolean;
  hiddenByAncestor?: boolean;
  outsideVisibleRect?: boolean;
  clipped?: boolean;
  layoutOnly?: boolean;
  textRedacted?: boolean;
  participation?: 'required' | 'optional' | 'context' | 'ignored' | 'unavailable';
  clickable: boolean;
  enabled: boolean;
  clipsToBounds: boolean;
  alpha: number;
  z: number;
  elevation?: number;
}

/**
 * Options accepted by `startRecording`.
 *
 * The recorder captures a full snapshot on every tick, so `fps` drives both file size and
 * main-thread cost. Start at 10 and raise it only after reading `RecordingResult.avgCaptureMs`.
 */
export interface RecordingOptions {
  /** Target frames per second. Clamped to 1..60. Defaults to 10. */
  fps?: number;
  /** Stop automatically after this many frames. `0` means unlimited. Defaults to 0. */
  maxFrames?: number;
  /** Capture text content. Disabled by default because it may contain user input. */
  includeText?: boolean;
  maxDepth?: number;
  maxNodes?: number;
}

/**
 * Summary returned by `stopRecording`.
 *
 * `avgCaptureMs` and `maxCaptureMs` cover the tree walk only, not serialisation or disk I/O. They
 * decide whether a higher frame rate or an incremental recorder is viable for a given screen.
 */
export interface RecordingResult {
  /** Absolute path of the JSONL file written to the app's files directory. */
  path: string;
  frameCount: number;
  byteSize: number;
  durationMs: number;
  avgCaptureMs: number;
  maxCaptureMs: number;
}

export interface UiAcceptanceSnapshot {
  platform: 'android' | 'ios';
  source: 'android-view-tree' | 'react-native-ui-acceptance' | 'ios-uiview-tree';
  timestamp: number;
  /** Wall time spent walking the tree, in milliseconds. Android only. */
  captureDurationMs?: number;
  nodeCount: number;
  windowWidth: number;
  windowHeight: number;
  density?: number;
  scale?: number;
  nodes: UiAcceptanceNode[];
  collection?: {
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
    excludedNodes: Array<{ reason: 'sdk-overlay' | 'explicit-ignore'; count: number }>;
  };
  /** Nested status for protocol consumers; flat fields remain for backward compatibility. */
  state?: {
    visible: boolean;
    attached: boolean;
    hasVisualContent: boolean;
    layoutOnly: boolean;
    clipped: boolean;
    zeroSize: boolean;
    hiddenByAncestor: boolean;
    outsideVisibleRect: boolean;
    participation: 'required' | 'optional' | 'context' | 'ignored' | 'unavailable';
  };
}

/**
 * 一并上传的屏幕截图，PNG 的 base64。
 *
 * 为什么和节点树塞进**同一个请求**而不是分两条：截图与节点必须来自同一帧。
 * 分两次上传必然遇到「先传了节点、再传截图时页面已经翻页」，而两者对不上时，
 * 验收画布上的节点层与底图会整体错位 —— 那种错位看起来像「开发写歪了」，比直接报错更难查。
 */
export interface AcceptanceScreenshot {
  mimeType: 'image/png';
  /** 截图的**真实**像素尺寸（Android 侧编码时的位图尺寸）。 */
  width: number;
  height: number;
  /**
   * 标准 base64，**不带** `data:image/png;base64,` 前缀，**不带**换行。
   *
   * 服务端对字母表是逐字符校验的（`Buffer.from` 会静默吞掉非法字符，
   * 于是「半个字节流」也能解出点东西），所以不能依赖「解出来能看就行」。
   */
  base64: string;
}

/** 一次原生采集的完整产物：同一帧的节点树 + 截图。 */
export interface AcceptanceCaptureBundle {
  snapshot: UiAcceptanceSnapshot;
  screenshot: AcceptanceScreenshot;
}

export interface AcceptanceSnapshotEnvelope {
  protocol: 'ui-acceptance-sdk-v2';
  captureId: string;
  sdkVersion: string;
  snapshot: UiAcceptanceSnapshot;
  screenshot: AcceptanceScreenshot;
}

/**
 * Mac 接收端凭据。
 *
 * 与旧模型（每次采集现生成一次性的 endpoint/token/sessionId，再想办法送到手机上）相比，
 * 这里只有一份**长期有效**的地址与密钥：Mac 上生成一次、落盘保存，手机配对一次即可反复使用。
 * 旧模型要求人工把三个随机值抄进手机，而等待窗口只有十几秒 —— 实际用起来基本必失败。
 */
export interface AcceptanceReceiverConfig {
  /** Mac 的局域网地址，IPv4 或主机名。 */
  host: string;
  port: number;
  /** 长期密钥（Mac 侧 `acceptance-receiver.json` 里那一串 hex）。 */
  token: string;
}

export interface AcceptanceUploadOptions {
  /** 调用方自己指定 captureId（一般不用；默认按时间戳生成）。 */
  captureId?: string;
  /** 采集合成截图时的选项，默认验收全量档。 */
  captureOptions?: AcceptanceCaptureOptions;
  /** 上传超时。截图有几 MB，比纯节点树大得多，默认给到 20 秒。 */
  timeoutMs?: number;
}

export interface AcceptanceUploadResult {
  accepted: boolean;
  captureId: string;
  nodeCount: number;
  /** 服务端**解码校验后**的截图字节数。与本地字节数不一致说明链路把它们改坏了。 */
  screenshotBytes: number;
  serverTimestamp: number;
}

/** 生成一个 captureId。只用于日志关联，不参与鉴权，所以不需要 uuid 依赖。 */
export function createAcceptanceCaptureId(now: number = Date.now()): string {
  return `cap-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 解析 Mac 上那一行连接串。
 *
 * 格式与 Mac 侧 `buildConnectionString` 严格一致：`smacceptance://<host>:<port>?token=<token>`。
 * 让用户复制/粘贴一整行，而不是分两个框填地址和密钥 —— 后者要求用户自己判断
 * 「冒号后面那段是端口还是密钥」，错一次的表现是「连接失败」，没有任何线索指向哪里填错了。
 *
 * 这里刻意**不用 `URL`**：RN 的 URL polyfill 对自定义协议的解析在不同版本上并不一致，
 * 而我们要的只是三个字段，正则足够且行为完全可预期。
 */
export function parseAcceptanceConnectionString(value: string): AcceptanceReceiverConfig {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('连接串为空。请从 Mac 的验收页复制那一行「smacceptance://…」');
  }
  const matched = /^smacceptance:\/\/([^:/\s]+):(\d{1,5})\?token=([A-Za-z0-9]+)$/.exec(trimmed);
  if (!matched) {
    throw new Error(
      '连接串格式不对。应形如 smacceptance://192.168.1.5:23458?token=<密钥>，' +
        '请从 Mac 的验收页直接复制，不要手工删改。',
    );
  }
  const port = Number(matched[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`连接串里的端口不合法：${matched[2]}`);
  }
  return { host: matched[1]!, port, token: matched[3]! };
}

/** 与 Mac 侧 `buildConnectionString` 对称，主要用于回显与自测。 */
export function buildAcceptanceConnectionString(receiver: AcceptanceReceiverConfig): string {
  return `smacceptance://${receiver.host}:${receiver.port}?token=${receiver.token}`;
}

function uploadUrl(receiver: AcceptanceReceiverConfig): string {
  return `http://${receiver.host}:${receiver.port}/v1/acceptance/upload`;
}

function pingUrl(receiver: AcceptanceReceiverConfig): string {
  return `http://${receiver.host}:${receiver.port}/v1/acceptance/ping`;
}

/** 把 fetch 层的各种失败翻译成「该去检查什么」，而不是把 `Network request failed` 抛给用户。 */
function describeNetworkError(error: unknown, receiver: AcceptanceReceiverConfig): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted|abort/i.test(message)) {
    return new Error(
      `上传超时（${receiver.host}:${receiver.port}）。截图有几 MB，弱网下可能不够；` +
        '也可能是 Mac 侧没有点「开始接收」，上传在等待靶的过程中被挂住。',
    );
  }
  return new Error(
    `连不上 Mac（${receiver.host}:${receiver.port}）：${message}。` +
      '请确认手机与 Mac 在同一局域网、Mac 的验收页开着，且地址取的是手机所在那张网卡。',
  );
}


interface NativeUiAcceptanceModule {
  start(options: UiAcceptanceOptions): Promise<boolean>;
  stop(): Promise<boolean>;
  capture(options?: AcceptanceCaptureOptions): Promise<UiAcceptanceSnapshot>;
  /**
   * 同一帧的节点树 + 截图。Android only。
   *
   * 原生侧在这期间会藏掉自己的调试浮层，调用方**不需要**再额外处理它。
   * 但**调用方自己的悬浮 UI 要自己藏**：它是 React 视图，原生不认识它，
   * 落在截图里会变成设计稿上不存在的元素，直接被验收判成差异。
   */
  captureBundle(options?: AcceptanceCaptureOptions): Promise<AcceptanceCaptureBundle>;
  /** Android only. Rejects with `UI_ACCEPTANCE_RECORD_IO_FAILED` if the file cannot be created. */
  startRecording(options: RecordingOptions): Promise<boolean>;
  /** Android only. Rejects with `UI_ACCEPTANCE_NOT_RECORDING` when no session is active. */
  stopRecording(): Promise<RecordingResult>;
  isRecording(): Promise<boolean>;
}

const nativeModule = NativeModules.UiAcceptanceModule as NativeUiAcceptanceModule | undefined;

/**
 * 上报给 Mac 的 SDK 版本。
 *
 * 与 `package.json` 的 version 必须一致 —— 服务端会把它记进快照元数据，
 * 用来判断「这份数据是哪版 SDK 采的」。漂移了不会报错，只会在排查旧数据时误导人。
 */
const SDK_VERSION = '0.1.0';

function getNativeModule(): NativeUiAcceptanceModule {
  if (!['android', 'ios'].includes(Platform.OS) || !nativeModule) {
    throw new Error('UiAcceptanceModule is unavailable on this platform');
  }
  return nativeModule;
}

const UiAcceptanceModule = {
  start(options: UiAcceptanceOptions = {}): Promise<boolean> {
    return getNativeModule().start(options);
  },

  stop(): Promise<boolean> {
    return getNativeModule().stop();
  },

  capture(options: AcceptanceCaptureOptions = { profile: 'acceptance-full' }): Promise<UiAcceptanceSnapshot> {
    return getNativeModule().capture(options);
  },

  /**
   * 同一帧的节点树 + 截图。**调用方需要先把自己的悬浮 UI 隐藏**（见类型注释）。
   */
  captureBundle(options: AcceptanceCaptureOptions = { profile: 'acceptance-full' }): Promise<AcceptanceCaptureBundle> {
    return getNativeModule().captureBundle(options);
  },

  /**
   * 「测试连接」。在真正上传之前先探一次，把「地址填错了」和「Mac 没点开始接收」区分开。
   *
   * 一次上传要传几 MB，失败重试的成本远高于先花几十毫秒 ping 一下。
   */
  async ping(receiver: AcceptanceReceiverConfig, timeoutMs = 4000): Promise<{ ok: boolean; armed: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(pingUrl(receiver), {
        method: 'GET',
        headers: { Authorization: `Bearer ${receiver.token}` },
        signal: controller.signal,
      });
      if (response.status === 401) {
        throw new Error('密钥不对（Mac 重新生成过接收器凭据？请重新复制那一行连接串）');
      }
      if (!response.ok) {
        throw new Error(`Mac 返回 ${response.status}`);
      }
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; armed?: boolean };
      return { ok: body.ok === true, armed: body.armed === true };
    } catch (error) {
      if (error instanceof Error && !/aborted|abort|Network request failed/i.test(error.message)) {
        throw error;
      }
      throw describeNetworkError(error, receiver);
    } finally {
      clearTimeout(timeout);
    }
  },

  /**
   * 一次做完「采节点 + 截图 + 上传」。悬浮按钮的「上传」走的就是它。
   *
   * 本地先做两道门禁，再发请求：
   * ① 平台与档位 —— 轻量档的树没有隐藏节点、没有文本，放上去会被读成「App 没这个元素」。
   *    这是**假阴性**，在验收里比漏报更危险，所以宁可本地就拒。
   * ② 截图 —— 缺了它这次上传没有任何底图，服务端也会拒，但那时几 MB 已经传完了。
   */
  async uploadBundle(
    receiver: AcceptanceReceiverConfig,
    options: AcceptanceUploadOptions = {},
  ): Promise<AcceptanceUploadResult> {
    const captureId = options.captureId ?? createAcceptanceCaptureId();
    const bundle = await this.captureBundle(options.captureOptions);
    const { snapshot, screenshot } = bundle;

    if (snapshot.platform !== 'android' || snapshot.source !== 'react-native-ui-acceptance') {
      throw new Error('Acceptance upload currently supports Android react-native-ui-acceptance snapshots only');
    }
    const profile = snapshot.collection?.profile;
    if (profile !== 'acceptance-full') {
      throw new Error(
        `Acceptance upload requires the acceptance-full capture profile, got ${profile ?? '(no collection metadata)'}. ` +
          'Call uploadBundle() without overriding captureOptions.profile.',
      );
    }
    if (!screenshot || screenshot.mimeType !== 'image/png' || !screenshot.base64) {
      throw new Error('Acceptance upload is missing the screenshot that the native module should have produced');
    }

    const envelope: AcceptanceSnapshotEnvelope = {
      protocol: 'ui-acceptance-sdk-v2',
      captureId,
      sdkVersion: SDK_VERSION,
      snapshot,
      screenshot,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
    try {
      const response = await fetch(uploadUrl(receiver), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${receiver.token}`,
          'X-UI-Acceptance-Capture': captureId,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as Partial<AcceptanceUploadResult> & {
        error?: string;
      };
      if (!response.ok || body.accepted !== true) {
        // 服务端拒绝的每一条都对应一个具体的动作（先点开始接收 / 换档位 / 换网卡…），
        // 所以把它的原文透出去，不要翻译成笼统的「上传失败」。
        throw new Error(body.error || `UI acceptance upload failed (${response.status})`);
      }
      return {
        accepted: true,
        captureId: body.captureId ?? captureId,
        nodeCount: body.nodeCount ?? snapshot.nodes.length,
        screenshotBytes: body.screenshotBytes ?? 0,
        serverTimestamp: body.serverTimestamp ?? Date.now(),
      };
    } catch (error) {
      if (error instanceof Error && !/aborted|abort|Network request failed/i.test(error.message)) {
        throw error;
      }
      throw describeNetworkError(error, receiver);
    } finally {
      clearTimeout(timeout);
    }
  },

  startRecording(options: RecordingOptions = {}): Promise<boolean> {
    return getNativeModule().startRecording(options);
  },

  stopRecording(): Promise<RecordingResult> {
    return getNativeModule().stopRecording();
  },

  isRecording(): Promise<boolean> {
    return getNativeModule().isRecording();
  },
};

export default UiAcceptanceModule;
