import { NativeModules, Platform } from 'react-native';
import type { SourceRef } from '@ui-inspector/protocol';

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
  profile?: 'acceptance-full' | 'source-inspector';
}

export interface UiAcceptanceNode {
  nodeId: string;
  treePath?: string;
  parentId: string | null;
  className: string;
  resourceName?: string | null;
  /** Babel source marker read directly from the Android View's nativeID tag. */
  source?: SourceRef | null;
  /** React Native host-view id. Source inspection does not resolve it through Fiber. */
  nativeTag?: number;
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
  /**
   * 平台给的可见矩形（Android `getGlobalVisibleRect` / iOS **不报**：iOS 没有等价 API，
   * 那边 `convertRect:toView:` 拿到的一直是布局矩形）。
   *
   * ⚠️ 它对 RN 的 `overflow:hidden` **无感**：那是绘制期裁剪出来的，没有走 `clipChildren`，
   * 所以被裁掉的行照样会报完整矩形。**不要用它判「屏幕上有没有像素」**，
   * 要判那个用 `effectiveVisibleWidth` 那一组。
   */
  visibleX?: number | null;
  visibleY?: number | null;
  visibleWidth?: number | null;
  visibleHeight?: number | null;
  /**
   * 沿祖先裁剪链求交后的有效可见矩形（SDK 侧算好，窗口坐标系；与 x/y/width/height 同口径）。
   *
   * 判据：自身布局矩形 ∩ 祖先里每个 `clipsToBounds` 容器的有效矩形 ∩ 窗口矩形。
   * 数字轮那类「一列 30 个候选行只有 1 行真绘制」的组件，靠它才能被正确识别。
   *
   * 两端都报：Android 在 `CollectPolicy.effectiveVisibleRect`，iOS 在
   * `HMClipWindowForChildren` —— 判据逐条一致，都只看 `clipsToBounds`。
   * ⚠️ 那条判据必须与 JS 侧本包浮层的 `getUiAcceptanceVisibleRect` 也一致：
   * 同一份快照在三个地方算出不同答案，症状只会是「画布上框了一个、点选又选不到」。
   */
  effectiveVisibleX?: number | null;
  effectiveVisibleY?: number | null;
  effectiveVisibleWidth?: number | null;
  effectiveVisibleHeight?: number | null;
  /** 自身矩形被祖先裁剪链裁小（含裁没）。与平台口径的 `clipped` 不同源。 */
  clippedByAncestor?: boolean;
  /**
   * 自身有面积、有效可见矩形却为空：屏幕上没有它的**任何**像素。
   *
   * ⚠️ 与「零尺寸」是两回事，别合并：前者是采集噪音（被列表裁掉的行），后者是布局事实。
   */
  clippedOut?: boolean;
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
  /**
   * 盒样式：背景色 / 边框 / 圆角。**一样都没有时是 `null`**（绝大多数布局容器）。
   *
   * ⚠️ 长度单位是 **dp**，与上面所有几何字段（px）**不同口径**：几何要原样保留才能和截图
   * 对齐，而样式回答的是「开发写的那个数是多少」—— 开发写的 `borderWidth: 1` 就是 1，
   * 不该因为机型密度变成 2.75。换算在原生侧完成，JS 与 Mac 侧都不要再除一次密度。
   *
   * ⚠️ **两端能力不对称**：Android 五项全采；**iOS 只采得到 `backgroundColor`**，
   * 且**永远发对象、不发 `null`**（没背景色时发 `{}`）。边框 / 圆角在 iOS 上读不到 —— RN 把
   * 边框画成轮廓图贴在 `_borderLayer` 上并把 `layer.borderWidth` 置 0，只有「四边同类同色 +
   * solid + 四角等半径 + (宽=0 或 `clipsToBounds` 或边框透明)」时才走 layer 那条路，而
   * RN 默认 `overflow` 不是 hidden，所以**最需要看边框的节点恰好读不到**。
   *
   * 消费端要区分「边框键不存在 = 这版没读」与「显式 `null` = 采过、确定没有」
   * —— Mac 侧那两件事分别对应「不画边框组」与「画三行 `—`」。
   */
  style?: UiAcceptanceBoxStyle | null;
  /**
   * 文本样式：字号 / 字重 / 字体 / 行高 / 字距 / 颜色。**非文本节点是 `null`**。
   *
   * 长度单位同样是 dp：两个平台各按**自己的**字体缩放回算过 —— Android 用 `scaledDensity`
   * （= density × fontScale），iOS 查 `UIContentSizeCategory` 那张倍数表
   * （RN `RCTAccessibilityManager.mm:256`，来源 `UIApplication.preferredContentSizeCategory`）。
   * 两端都不该再除第二次。
   *
   * 与 `text`（内容）分开：内容受 `includeText` 与密码脱敏控制，样式不受 ——
   * 一个密码框的字号该被看见，它的密码不该。
   */
  textStyle?: UiAcceptanceTextStyle | null;
}

/** 四边 / 四角的具名值。key 名与 Mac 侧 `SdkNodeSides` / `SdkNodeCorners` 逐字一致。 */
export interface UiAcceptanceSides<T> {
  top?: T | null;
  right?: T | null;
  bottom?: T | null;
  left?: T | null;
}

export interface UiAcceptanceCorners<T> {
  topLeft?: T | null;
  topRight?: T | null;
  bottomRight?: T | null;
  bottomLeft?: T | null;
}

export interface UiAcceptanceBoxStyle {
  /** `#rrggbb` 或 `#aarrggbb`；`null` = 没设背景色（含完全透明）。 */
  backgroundColor?: string | null;
  /** `solid` / `dashed` / `dotted`；`null` = 没有边框（样式无意义时不上报）。 */
  borderStyle?: string | null;
  /** 四边宽度（dp）；`null` = 这一边没有边框。 */
  borderWidth?: UiAcceptanceSides<number> | null;
  /** 四边颜色。 */
  borderColor?: UiAcceptanceSides<string> | null;
  /** 四角半径（dp）。 */
  borderRadius?: UiAcceptanceCorners<number> | null;
}

export interface UiAcceptanceTextStyle {
  /** 字号（dp）。 */
  fontSize?: number;
  /** 字重 100–900。 */
  fontWeight?: number;
  /** `normal` / `italic`。 */
  fontStyle?: string | null;
  /** RN 的 fontFamily 字符串；`null` = 没设。 */
  fontFamily?: string | null;
  /** 行高（dp）；`null` = RN 没设行高（TextView 用字体自带行距）。 */
  lineHeight?: number | null;
  /** 字距（dp）；`null` = 没设。 */
  letterSpacing?: number | null;
  /** 文字颜色。 */
  color?: string | null;
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
  /**
   * 采集来源。两端都写 `react-native-ui-acceptance` —— Mac 侧只认这一个值来判定
   * 「这份树是不是本 SDK 采的」，平台差异一律看 `platform`，不靠 source 分叉。
   *
   * 另外两个值是历史遗留（旧 iOS 版写 `ios-uiview-tree`、旧安卓版写 `android-view-tree`），
   * 类型里留着是为了那些已经落盘的旧数据仍读得出来，**新代码不要再用**。
   */
  source: 'android-view-tree' | 'react-native-ui-acceptance' | 'ios-uiview-tree';
  timestamp: number;
  /** Wall time spent walking the tree, in milliseconds. Android only. */
  captureDurationMs?: number;
  nodeCount: number;
  /**
   * ⚠️ **坐标口径**：`nodes` 的几何与 `windowWidth` / `windowHeight` 永远同一空间，但
   * **是哪一种空间取决于调用了哪个方法**：
   *
   * - `capture()`（含浮层路径）→ **逻辑单位**：安卓是 dp、iOS 是 pt。浮层的距离读数直接用它。
   * - `captureBundle()`（含上传路径）→ **物理像素**，与安卓 `getLocationInWindow` 同口径。
   *   Mac 侧只有一条换算 `logical = 值 × 160 / densityDpi`，所以这边必须是像素；
   *   报逻辑单位会被再除一次屏幕倍数，表现为「整份设计稿小 3 倍」。
   */
  windowWidth: number;
  windowHeight: number;
  /**
   * 逻辑单位 → 像素的倍数（安卓 dp 倍率、iOS `screen.scale`）。
   * 只与**像素口径**的坐标配对使用（即 `captureBundle()`）。
   */
  density?: number;
  /** `density × 160`。Mac 侧优先读它，缺省时退回 `density × 160`。 */
  densityDpi?: number;
  /** 含系统字体缩放的倍率。iOS 不上报字体缩放，与 `density` 同值。 */
  scaledDensity?: number;
  /** iOS 的 `screen.scale`，与 `density` 同源（浮层用它折算一物理像素的线宽）。 */
  scale?: number;
  /**
   * 机型与前台包名。安卓是 `厂商 型号` / 应用包名，iOS 是 `Apple iPhone15,3` / bundle id。
   *
   * 这两个字段以前由 Mac 侧用 adb（`dumpsys window`）问系统要；截图改由 SDK 自己上传后，
   * adb 整条链路退出验收路径，设备信息只能由采集方如实上报 —— 少了它们，
   * 需求里那堆截图就只能显示成「某台手机」，分不出是哪台跑的。
   */
  deviceModel?: string;
  packageName?: string;
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
    clippedByAncestor?: boolean;
    clippedOut?: boolean;
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
  /**
   * 长期密钥。**可以没有** —— 2026-09-24 起接收器对来自局域网私有地址的请求免密钥，
   * 所以「只填一个地址」的配置不带 token。只有两种情况下还需要它：
   * ① 显式粘贴过整行连接串（含旧版 App 的习惯）；② 手机与 Mac 不在同一网段。
   */
  token?: string;
}

/**
 * 接收器默认端口。
 *
 * 固定是有意的：Mac 侧 `AcceptanceReceiver.start()` 不传参就走这个端口，不会漂移，
 * 所以「只填 IP」时端口由 SDK 兜底，用户不必知道 23458 这个数字。
 */
export const DEFAULT_ACCEPTANCE_RECEIVER_PORT = 23458 as const;

/**
 * USB reverse 通道固定把手机侧的 localhost:23458 映射到 Mac 接收器。
 * 端口固定是为了 App 不需要再保存或输入任何 Mac 地址。
 *
 * ⚠️ **这条通道只对 Android 存在**（见 `IOS_USB_UPLOAD_UNSUPPORTED`）。
 */
export const USB_ACCEPTANCE_RECEIVER_HOST = '127.0.0.1' as const;
export const USB_ACCEPTANCE_RECEIVER_PORT = DEFAULT_ACCEPTANCE_RECEIVER_PORT;

/**
 * 「iOS 没有 USB 直传」这件事的完整解释，USB 两个入口（`discoverUsbAcceptanceReceiver` /
 * `uploadBundleViaUsb`）都以它作为错误文案，宿主也可以直接拿它做前置判断
 * （省掉 iOS 上那次注定失败的 4 秒探测）。
 *
 * 原因：安卓那条路靠 `adb reverse tcp:23458 tcp:23458`，方向是**设备 → Mac**
 * （手机连自己的 localhost，被 adb 转发到 Mac 的接收器）。iOS 侧的对应工具是
 * libimobiledevice 的 `iproxy`，而它只能反向绑定 —— 在 Mac 上监听、把连接转进设备，
 * 也就是 `adb forward` 那个方向。usbmuxd 协议本身不提供「设备发起、经 USB 打到 Mac 端口」
 * 的通道，所以 iOS 上不存在零配置直连，只能走局域网（同一 Wi-Fi 或 iPhone 热点）。
 */
export const IOS_USB_UPLOAD_UNSUPPORTED =
  'iOS 不支持 USB 直连上传（经 USB 让手机主动连上 Mac 需要 adb reverse 这类反向隧道，' +
  '而 iOS 侧的 iproxy 只能 Mac→设备）。请改用局域网：手机与 Mac 连同一个 Wi-Fi（或手机开热点、' +
  'Mac 连上去），在 Mac 验收页取局域网地址后用 uploadBundle(receiver) 上传。';

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

/**
 * 与 Mac 侧 `buildConnectionString` 对称，主要用于回显与自测。
 * 没有密钥时退化成 `host:port` —— 那正是「只填地址」的写法，`parseAcceptanceTarget` 能原样读回来。
 */
export function buildAcceptanceConnectionString(receiver: AcceptanceReceiverConfig): string {
  if (!receiver.token) return `${receiver.host}:${receiver.port}`;
  return `smacceptance://${receiver.host}:${receiver.port}?token=${receiver.token}`;
}

/**
 * 解析 App 侧填的「Mac 地址」——**只填 IP 也认**。
 *
 * 2026-09-24 起接收器对来自局域网私有地址的请求免密钥，用户只需要给一个地址。
 * 四种写法都收，因为用户手上会有不同来源的字符串：
 *   `192.168.1.5`               → host + 默认端口（接收器不会漂移，见 DEFAULT_ACCEPTANCE_RECEIVER_PORT）
 *   `192.168.1.5:23458`         → host + 显式端口
 *   `http://192.168.1.5:23458/` → 从浏览器地址栏复制来的那种，允许带协议与路径
 *   `smacceptance://…?token=…`  → 旧版整行连接串（向后兼容，带密钥）
 *
 * ⚠️ 不支持 IPv6 字面量：`fe80::1:23458` 里哪个冒号是端口分隔符没有公认答案，
 * 与其猜错，不如报错说清楚。
 */
export function parseAcceptanceTarget(value: string): AcceptanceReceiverConfig {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('请填写 Mac 的局域网地址，例如 192.168.1.5');
  }
  if (/^smacceptance:\/\//i.test(trimmed)) {
    return parseAcceptanceConnectionString(trimmed);
  }

  const withoutScheme = trimmed.replace(/^https?:\/\//i, '');
  // 路径 / 查询串一并丢掉：`http://10.0.0.9:23458/v1/acceptance/ping` 也应当能填。
  const bare = withoutScheme.split(/[/?#]/)[0] ?? '';
  const matched = /^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/.exec(bare);
  if (!matched) {
    throw new Error(
      `地址格式不对：${trimmed}。填 Mac 的局域网 IPv4 地址即可，` +
        '例如 192.168.1.5，或带端口 192.168.1.5:23458；IPv6 请改用连接串。',
    );
  }
  const port = matched[2] === undefined ? DEFAULT_ACCEPTANCE_RECEIVER_PORT : Number(matched[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`端口不合法：${matched[2]}`);
  }
  return { host: matched[1]!, port };
}

/** 有密钥就带上；「只填地址」的配置不带 —— 接收器按来源判定是否放行。 */
function authHeaders(receiver: AcceptanceReceiverConfig): Record<string, string> {
  return receiver.token ? { Authorization: `Bearer ${receiver.token}` } : {};
}

function uploadUrl(receiver: AcceptanceReceiverConfig): string {
  return `http://${receiver.host}:${receiver.port}/v1/acceptance/upload`;
}

function pingUrl(receiver: AcceptanceReceiverConfig): string {
  return `http://${receiver.host}:${receiver.port}/v1/acceptance/ping`;
}

function usbConfigUrl(): string {
  return `http://${USB_ACCEPTANCE_RECEIVER_HOST}:${USB_ACCEPTANCE_RECEIVER_PORT}/v1/acceptance/usb-config`;
}

/** 把 fetch 层的各种失败翻译成「该去检查什么」，而不是把 `Network request failed` 抛给用户。 */
function describeNetworkError(error: unknown, receiver: AcceptanceReceiverConfig): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (receiver.host === USB_ACCEPTANCE_RECEIVER_HOST) {
    if (/aborted|abort/i.test(message)) {
      return new Error('USB 上传超时：请确认数据线仍已连接，且 Mac 验收页正打开着某个需求。');
    }
    return new Error(
      `无法通过 USB 连接 Mac（${receiver.host}:${receiver.port}）：${message}。` +
        '请确认数据线已连接并允许 Android USB 调试 —— Mac 侧不需要任何额外操作。',
    );
  }
  if (/aborted|abort/i.test(message)) {
    return new Error(
      `上传超时（${receiver.host}:${receiver.port}）。截图有几 MB，弱网下可能不够；` +
        '也可能是 Mac 验收页当前没打开任何需求（打开一个就会自动开始等待）。',
    );
  }
  return new Error(
    `连不上 Mac（${receiver.host}:${receiver.port}）：${message}。` +
      '请确认手机与 Mac 在同一局域网、Mac 的验收页开着，' +
      '且填的是 Mac 在手机所在局域网里的那个地址（Mac 验收页上那一串）。',
  );
}

/**
 * 通过 ADB reverse 后的 localhost 通道自动读取 Mac 接收器凭据。
 * 这条请求只适用于 USB 模式，局域网模式仍使用手动配对的 receiver。
 *
 * iOS 上直接抛错而不去探一次：那条 localhost 通道在 iOS 上不存在，探测必然超时，
 * 而调用方（工具条）拿到的只会是 4 秒后的一句「连不上」—— 不如立刻说清是「这条路本来就走不通」。
 */
export async function discoverUsbAcceptanceReceiver(timeoutMs = 4000): Promise<AcceptanceReceiverConfig> {
  if (Platform.OS === 'ios') {
    throw new Error(IOS_USB_UPLOAD_UNSUPPORTED);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(usbConfigUrl(), { signal: controller.signal });
    const body = (await response.json().catch(() => ({}))) as Partial<AcceptanceReceiverConfig> & {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok || body.ok !== true || typeof body.token !== 'string') {
      throw new Error(body.error || `Mac 返回 ${response.status}`);
    }
    const port = body.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('Mac 返回的 USB 接收端口不合法');
    }
    return {
      host: USB_ACCEPTANCE_RECEIVER_HOST,
      port,
      token: body.token,
    };
  } catch (error) {
    if (error instanceof Error && !/aborted|abort|Network request failed/i.test(error.message)) {
      throw error;
    }
    throw new Error(
      '无法通过 USB 连接 Mac 验收服务：请确认 Mac 验收页已打开、数据线已连接并允许 USB 调试（Mac 侧不需要点任何按钮）。',
    );
  } finally {
    clearTimeout(timeout);
  }
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
 * 能被 Mac 接收器接受的平台。与接收器侧的判据**同一份白名单**：
 * 那边校验 `snapshot.platform` 与 `source`，这边上传前先自查一次 ——
 * 一次上传是几 MB，等传完再被服务端拒掉，用户只看到「等了很久然后失败」。
 */
const ACCEPTANCE_UPLOAD_PLATFORMS: ReadonlyArray<UiAcceptanceSnapshot['platform']> = ['android', 'ios'];

/** 原生侧是否具备出 bundle 的能力（含截图与 collection 元数据）。 */
function assertCaptureBundleAvailable(): void {
  if (!['android', 'ios'].includes(Platform.OS)) {
    throw new Error(`UI acceptance upload is unavailable on ${Platform.OS}`);
  }
  if (typeof nativeModule?.captureBundle !== 'function') {
    throw new Error(
      '当前的原生模块没有 captureBundle：Android 与 iOS 都需要它。' +
        '这通常说明原生依赖还是旧版本 —— 重新安装依赖并重建原生工程（iOS 记得重跑 pod install）后重试。',
    );
  }
}

/**
 * 上报给 Mac 的 SDK 版本。
 *
 * 与 `package.json` 的 version 必须一致 —— 服务端会把它记进快照元数据，
 * 用来判断「这份数据是哪版 SDK 采的」。漂移了不会报错，只会在排查旧数据时误导人。
 */
const SDK_VERSION = '0.1.16';

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
   * 「测试连接」。在真正上传之前先探一次，把「地址填错了」和「Mac 没开着需求」区分开。
   *
   * 一次上传要传几 MB，失败重试的成本远高于先花几十毫秒 ping 一下。
   * 回执里的 `armed` 现在是「Mac 验收页有没有打开某个需求」—— 2026-09-24 起打开需求即开始
   * 等待，不再需要人点按钮。
   */
  async ping(receiver: AcceptanceReceiverConfig, timeoutMs = 4000): Promise<{ ok: boolean; armed: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(pingUrl(receiver), {
        method: 'GET',
        headers: authHeaders(receiver),
        signal: controller.signal,
      });
      if (response.status === 401) {
        throw new Error(
          receiver.token
            ? '密钥不对（Mac 重新生成过接收器凭据？请重新复制那一行连接串）'
            : '这台 Mac 要求密钥：可能是旧版 Mac 应用（还不认「免密钥的局域网来源」），' +
              '也可能是手机与 Mac 不在同一网段。请升级 Mac 应用，或改填带密钥的连接串。',
        );
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
    // 先确认原生侧真能出 bundle，再去采集。
    //
    // 为什么要前置：平台门禁读的是 `snapshot.platform`，只能等采集回来才判得了，而旧版
    // 原生模块根本没有 `captureBundle` —— 于是 iOS 上先炸出来的是
    // `captureBundle is not a function` 这种 TypeError，那句「只支持 android」的
    // 友好文案一次都到不了用户眼前（实测过，是死代码）。把「能力是否存在」提到最前面，
    // 两条失败路径就各有一句说得清的话。
    assertCaptureBundleAvailable();
    const bundle = await this.captureBundle(options.captureOptions);
    const { snapshot, screenshot } = bundle;

    if (!ACCEPTANCE_UPLOAD_PLATFORMS.includes(snapshot.platform) || snapshot.source !== 'react-native-ui-acceptance') {
      throw new Error(
        `Acceptance upload only supports react-native-ui-acceptance snapshots (${ACCEPTANCE_UPLOAD_PLATFORMS.join(
          ' / ',
        )}), got platform=${snapshot.platform} source=${snapshot.source}`,
      );
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
          ...authHeaders(receiver),
          'X-UI-Acceptance-Capture': captureId,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as Partial<AcceptanceUploadResult> & {
        error?: string;
      };
      if (!response.ok || body.accepted !== true) {
        // 服务端拒绝的每一条都对应一个具体的动作（Mac 上先打开一个需求 / 换档位 / 换网卡…），
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

  /**
   * 通过 USB 数据线自动发现 Mac 接收器并上传，无需配置任何 Mac 地址。
   *
   * **仅 Android**（`adb reverse`）。iOS 上调它会立刻抛 `IOS_USB_UPLOAD_UNSUPPORTED`
   * 那句文案 —— 宿主据此把用户引到局域网那条路，不必先等一次注定失败的探测。
   */
  async uploadBundleViaUsb(options: AcceptanceUploadOptions = {}): Promise<AcceptanceUploadResult> {
    const receiver = await discoverUsbAcceptanceReceiver(options.timeoutMs ?? 4000);
    return this.uploadBundle(receiver, options);
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
