import type {
  AppNode,
  AppNodeBoxStyle,
  AppNodeCorners,
  AppNodeSides,
  AppNodeTextStyle,
  Rect,
} from './verify';

export const SDK_ACCEPTANCE_PROTOCOL = 'ui-acceptance-sdk-v2' as const;

/**
 * 变换契约的版本。
 *
 * `-v1` → `-v2`（2026-09-29）：几何从「一律按边界投影」改成**按宿主档位分派**
 * （`PixelHostProfile`，见 `@shared/pixelTransform`），`presnap` 档下宽高改为按属性投影。
 * 同一个设计矩形在 v1 与 v2 下可能算出差 1px 的期望值 —— 但那是**判据语义**变了，不是
 * 数据变了，所以必须换版本号：存着 v1 契约的调试包 / 真值包拿回来复跑时会被
 * `pixelTransformRejectionReasons` 判成不可比对（而不是静默按新语义算出一批看着合理的红）。
 */
export const PIXEL_TRANSFORM_VERSION = 'design-to-app-pixels-v2' as const;
export const PIXEL_SNAP_PROFILE = 'nearest-integer' as const;
export const PIXEL_COORDINATE_ORIGIN = 'root-content' as const;
export const PIXEL_VIEWPORT_SOURCE = 'app-snapshot-logical-width' as const;

/**
 * 变换的**身份 + 数值**——投影只需要这八个字段（版本化，随报告一起留痕）。
 *
 * ⚠️ 五个「身份」字段（`version` / `viewportSource` / `snapProfile` / `coordinateOrigin` /
 * `hostProfile`）刻意声明为 `string` 而不是上面那几个 `as const` 字面量类型。这不是偷懒：
 *
 *   契约是要**离开进程**的（写进报告、调试包、真值包），回来时是 `JSON.parse` 的结果。
 *   校验的整个意义就是「回来的这份和当前这次采集是不是同一套规则」。若字段是字面量类型，
 *   TS 会在编译期把「不一样」这件事直接抹掉，`contract.version === PIXEL_TRANSFORM_VERSION`
 *   变成恒真 —— 校验函数降级成死代码，而它唯一的用途正是捕捉不相等。
 *
 * 真值来源仍然是上面那几个常量（`createPixelTransformContract` 与校验都引用它们），
 * 所以「可表示不匹配」不等于「可以随便写」：比对时逐字段对着常量比。
 *
 * `basisWidth` / `viewportWidth` / `pixelWidth` / `pixelRatio` 是数值，天然可表示不匹配，
 * 保持 `number`。
 *
 * 与 `PixelTransformContract` 分开（2026-09-29），是为了让**渲染层**也能算投影：
 * `@shared/pixelTransform` 的纯数学只吃这一层，而 `hash` 要 sha256（`node:crypto`），
 * 进不了浏览器包。⚠️ 这不是把投影拆成两套实现 —— 投影函数只有一份（`projectDesign*`），
 * 只是在共享层收窄了入参类型。
 */
export interface PixelTransformGeometry {
  version: string;
  basisWidth: number;
  viewportWidth: number;
  viewportSource: string;
  pixelWidth: number;
  pixelRatio: number;
  snapProfile: string;
  coordinateOrigin: string;
  /**
   * 宿主取整档位（2026-09-29 加）：`'presnap'`（宿主按属性预吸附，`w()` 型）或
   * `'raw'`（裸比例值交给布局、由布局按边界吸附）。取值与含义见 `@shared/pixelTransform`
   * 的 `PixelHostProfile` —— 常量与类型都放在那边（本文件的投影消费方只有这里的字符串比对），
   * 放过来会造成 `acceptance ↔ pixelTransform` 的循环依赖。
   *
   * ⚠️ 它**进哈希**：档位不同 = 期望值算法不同 = 另一套坐标，不能与本次采集比对。
   */
  hostProfile: string;
}

export interface PixelTransformContract extends PixelTransformGeometry {
  /** 上面八个字段按固定顺序（数组载荷，不看键序）的 sha256，由主进程计算 */
  hash: string;
}

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
  /** 透传包装（自身不绘制 + 恰好一个铺满自身的有效子节点）；老 SDK 不带这个字段 */
  passThrough?: boolean;
  zeroSize?: boolean;
  hiddenByAncestor?: boolean;
  outsideVisibleRect?: boolean;
  clipped?: boolean;
  /**
   * 裁剪链结论（安卓 `NativeNode` / iOS `captureBundle` 都往这里塞一份）。
   *
   * 顶层同名与它**重复出现**是历史原因：两端都把这两个值同时写在顶层与 `state` 里。
   * 归一化两个位置都读，取「任一为真」—— 少读一处就会让某一端的快照静默失效。
   */
  clippedByAncestor?: boolean;
  clippedOut?: boolean;
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
  /**
   * 沿祖先裁剪链求交后的**有效可见矩形**（px，与 x/y/width/height 同口径）。
   *
   * 与上面那组 `visible*` 的区别，是「屏幕上还有没有像素」这个问题的唯一可信答案：
   * 平台口径的可见矩形对 RN 的 `overflow:hidden`（绘制期裁剪）完全无感。缺字段 = 这版
   * 快照不带这个通道（老 SDK）⇒ 下游按「没被裁」处理，宁可多放行也不让存量快照突然点不动。
   */
  effectiveVisibleX?: number | null;
  effectiveVisibleY?: number | null;
  effectiveVisibleWidth?: number | null;
  effectiveVisibleHeight?: number | null;
  /** 自身矩形被祖先裁剪链裁小（含裁没）。与平台口径的 `clipped` 不同源。 */
  clippedByAncestor?: boolean;
  /** 自身有面积、有效可见矩形却为空：屏幕上没有它的任何像素。 */
  clippedOut?: boolean;

  visible: boolean;
  /** Whether an ancestor hid this node; retained here for flat/legacy payloads. */
  hiddenByAncestor?: boolean;
  /** Flat compatibility fields emitted alongside the nested state object. */
  outsideVisibleRect?: boolean;
  clipped?: boolean;
  attached?: boolean;
  hasVisualContent?: boolean;
  /** 透传包装；老 SDK 不带这个字段（缺省时由匹配引擎按矩形自行判定） */
  passThrough?: boolean;
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
  /**
   * 盒样式（背景 / 边框 / 圆角）与文本样式（字号 / 字重 / 字体 / 行高 / 字距 / 颜色）。
   *
   * 2026-09-22 新增。**长度单位已经是 dp**，与同一份 payload 里的几何字段（px）不同口径：
   * SDK 侧拿得到 `density` 与 `fontScale`，字体那几项要按 `scaledDensity` 回算，所以换算
   * 只能发生在那边（细节见 SDK 的 `NativeNode.BoxStyle` / `TextStyle`）。
   *
   * 老 SDK 不带这两个字段 —— 面板按「没有」处理（显示 `—`），不要兜底成 0 / 黑色：
   * 「这版 SDK 采不到」与「这里就是 0」在验收里是两个结论。
   */
  style?: SdkNodeBoxStyle | null;
  textStyle?: SdkNodeTextStyle | null;
}

/** 四边 / 四角的具名值。与 SDK 侧的 key 名逐字一致（top/right/bottom/left、topLeft/…）。 */
export interface SdkNodeSides<T> {
  top?: T | null;
  right?: T | null;
  bottom?: T | null;
  left?: T | null;
}

export interface SdkNodeCorners<T> {
  topLeft?: T | null;
  topRight?: T | null;
  bottomRight?: T | null;
  bottomLeft?: T | null;
}

/**
 * 盒样式。**两端采集能力不对称**：
 *
 *  - 安卓五项全采（`BackgroundStyleApplicator` 的官方 getter，四边逐边可靠）；
 *  - **iOS 只采得到 `backgroundColor`**，且只会发这一个键。边框 / 圆角在 iOS 上读不到 ——
 *    RN 把边框画成轮廓图贴在 `_borderLayer` 上并把 `layer.borderWidth` 置 0
 *    （`RCTViewComponentView.mm:944`），只有「四边同类同色 + solid + 四角等半径 + (宽=0 或
 *    `clipsToBounds` 或边框透明)」时才走 layer 那条路（判定 `:885`），而 RN 默认 `overflow`
 *    不是 hidden —— **最需要看边框的节点恰好读不到**。
 *
 * 所以「某个边框键不存在」在 iOS 上的含义是「这版没读」，不是「没有边框」。面板据此决定
 * 画不画「边框」组（见 `NodeInfoPanel` 的 `borderChannel`）。
 */
export interface SdkNodeBoxStyle {
  backgroundColor?: string | null;
  borderStyle?: string | null;
  /** 四边宽度（dp） */
  borderWidth?: SdkNodeSides<number> | null;
  /** 四边颜色（`#rrggbb` / `#aarrggbb`） */
  borderColor?: SdkNodeSides<string> | null;
  /** 四角半径（dp） */
  borderRadius?: SdkNodeCorners<number> | null;
}

export interface SdkNodeTextStyle {
  /**
   * 字号（dp，已按各平台的字体缩放回算）。
   *
   * 两端各除各的：安卓 `scaledDensity`（= density × fontScale）、iOS 查
   * `UIContentSizeCategory` 那张倍数表（RN `RCTAccessibilityManager.mm:256`）。
   * 两边**都**是「除回设计稿口径」，用的是同一个已知近似：`allowFontScaling={false}`
   * 的文本会被多除一次倍数。
   */
  fontSize?: number;
  /** 100–900 */
  fontWeight?: number;
  fontStyle?: string | null;
  /**
   * 字体族名。
   *
   * ⚠️ 两端形式不同源：安卓报的是 RN 写的**原始串**（`PingFang SC`），iOS 报的是
   * `UIFont.familyName`（**解析后**的字面族名）。自定义字族一般同名，但字体不存在时
   * RN 会回退到系统字体，iOS 那边就会报成系统族名 —— 对比表上可能假红。
   */
  fontFamily?: string | null;
  /** 行高（dp）；SDK 报 null = RN 没设行高 */
  lineHeight?: number | null;
  /** 字距（dp） */
  letterSpacing?: number | null;
  color?: string | null;
}

export interface SdkSnapshotPayload {
  /**
   * 采集端平台。两端都写 `react-native-ui-acceptance` 作为 source，
   * 平台差异只由这个字段表达 —— 见 `validateSdkSnapshotEnvelope`。
   */
  platform: 'android' | 'ios';
  source: 'react-native-ui-acceptance';
  timestamp: number;
  captureDurationMs?: number;
  nodeCount: number;
  /**
   * ⚠️ **与 `nodes` 的几何同一口径：物理像素**（两端都是）。
   *
   * 安卓的 `getLocationInWindow` / iOS 的 `convertRect:toView:` 乘屏幕倍数之后都是像素，
   * 本文件里那条唯一的换算 `toLogical(value, densityDpi) = value × 160 / densityDpi`
   * 正是建立在这个前提上：
   *   安卓 densityDpi=440 → logical = px × 160/440 = dp
   *   iOS  densityDpi = scale×160（如 480）→ logical = px × 160/480 = px / scale = pt
   * 所以 iOS 也必须上报 `density = screen.scale`，否则整份设计稿会差一个屏幕倍数。
   */
  windowWidth: number;
  windowHeight: number;
  density?: number;
  /** `density × 160`。iOS 与 `scaledDensity` 同值（那边不上报字体缩放）。 */
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

// ---------- 样式透传（背景 / 边框 / 圆角 / 字体） ----------
//
// ⚠️ 这一段**刻意不做任何单位换算**，与上面所有几何字段相反 —— 那是最容易看混的地方，
// 所以在这里写死并把理由说清楚：SDK 上报的样式值本来就是 dp。
//
//   · 边框宽度 / 圆角：RN 的 `getBorderWidth` 内部做过 pxToDp、`getBorderRadius` 的 POINT
//     本来就是 dp，所以 SDK 侧拿到的已经是「开发写的那个数」。
//   · 字号 / 行高 / 字距：RN 交给 TextView 前乘过 `density × fontScale`，SDK 侧按
//     `scaledDensity` 除回去了 —— 而 `scaledDensity` 只在那边的 `DisplayMetrics` 上，
//     Mac 侧的 payload 里虽然也有这个字段，但没有「这一段文本到底开没开 allowFontScaling」
//     这个信息，在这边算只能猜。
//
// 于是这里只做**形状校验**（`unknown` → 具名结构），一个数字也不改。将来若有人在
// `style` 上补一次 toLogical，两件事会同时发生：边框宽度凭空小到 1/2.75，而字号纹丝不动 ——
// 那种「一半对一半错」的症状极难查，所以宁可在这里留一段显眼的注释。

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 四边数值的**键存在性**要原样传下去，哪怕四个值全是 `null`。
 *
 * 曾经的写法是 `Object.values(out).some(v => v !== null) ? out : undefined`，把「SDK 发了这个键
 * 但四边都没值」和「SDK 压根没发这个键」压成了同一个 `undefined`。在 iOS 补样式采集之前，
 * 这个压缩是无害的（两端要么全发、要么全不发）。现在它是**有害的**：
 *
 *   · 安卓的 `NativeNode.toWritableMap` 只要 `style != null` 就无条件写全部五个键，
 *     所以「`borderWidth` 键存在」= 「安卓真的读过边框」；
 *   · iOS 这一版**只采到背景色**（边框被 RN 画在轮廓图片层里，`layer.borderWidth` 是 0），
 *     它的 `style` 里一个边框键都没有。
 *
 * 压掉键存在性之后，面板就没法区分这两者，只能对着 iOS 画三行「—」，而那会被读成
 * 「这个元素确定没有边框」—— 一个**假结论**。所以这里保留键、保留全 null。
 */
function normalizeNumberSides(sides: SdkNodeSides<number> | null | undefined): AppNodeSides<number | null> | undefined {
  if (!sides) return undefined;
  return {
    top: asFiniteNumber(sides.top),
    right: asFiniteNumber(sides.right),
    bottom: asFiniteNumber(sides.bottom),
    left: asFiniteNumber(sides.left),
  };
}

function normalizeNumberCorners(
  corners: SdkNodeCorners<number> | null | undefined,
): AppNodeCorners<number | null> | undefined {
  if (!corners) return undefined;
  return {
    topLeft: asFiniteNumber(corners.topLeft),
    topRight: asFiniteNumber(corners.topRight),
    bottomRight: asFiniteNumber(corners.bottomRight),
    bottomLeft: asFiniteNumber(corners.bottomLeft),
  };
}

function normalizeColorSides(sides: SdkNodeSides<string> | null | undefined): AppNodeSides<string | null> | undefined {
  if (!sides) return undefined;
  // 同上：保留键、保留全 null，别用「有没有非空值」去推断「SDK 发没发这一组」。
  return {
    top: asNonEmptyText(sides.top),
    right: asNonEmptyText(sides.right),
    bottom: asNonEmptyText(sides.bottom),
    left: asNonEmptyText(sides.left),
  };
}

/**
 * SDK 的盒样式 → `AppNode.style`。
 *
 * **三态原样透传**（这是这个函数存在的全部理由）：
 *  - 键不存在 → `undefined`：这版 SDK 不采样式，面板整组不画；
 *  - 显式 `null` → `null`：采了、这个节点确实没有盒样式，面板画成 `—`；
 *  - 对象 → 剥掉空值字段后的具名结构。
 *
 * 不把 `null` 与 `undefined` 合并成同一个「没有」，是因为它们在面板上是两个结论：
 * 合并之后存量快照里的每一个透明容器都会被读成「这个元素没有背景色」。
 *
 * 空值**标量**字段直接不写进结果（而不是写 null）：面板按「有这个键就说明这一项采到了」
 * 判断，一堆 null 会让 `Object.keys` 看起来有内容。
 *
 * ⚠️ 但**四边 / 四角**那三组是例外，它们的键存在性本身就是信息（见 `normalizeNumberSides`）。
 * 也正因为如此，整个对象为空时这里返回 `{}` 而不是 `null`：iOS 这一版会发
 * `style: {}`（采过、但这个节点没有背景色、且这版不采边框），返回 `null` 就与
 * 「安卓采过、确定没有盒样式」混成一件事了。安卓不会发空对象（`BoxStyle.isEmpty()` 时它直接
 * 写 `null`），所以这条分支只影响 iOS。
 */
function normalizeSdkBoxStyle(style: SdkNodeBoxStyle | null | undefined): AppNodeBoxStyle | null | undefined {
  if (style === undefined) return undefined;
  if (style === null) return null;
  const out: AppNodeBoxStyle = {};
  const backgroundColor = asNonEmptyText(style.backgroundColor);
  if (backgroundColor) out.backgroundColor = backgroundColor;
  const borderStyle = asNonEmptyText(style.borderStyle);
  if (borderStyle) out.borderStyle = borderStyle;
  const borderWidth = normalizeNumberSides(style.borderWidth);
  if (borderWidth) out.borderWidth = borderWidth;
  const borderColor = normalizeColorSides(style.borderColor);
  if (borderColor) out.borderColor = borderColor;
  const borderRadius = normalizeNumberCorners(style.borderRadius);
  if (borderRadius) out.borderRadius = borderRadius;
  return out;
}

/**
 * SDK 的文本样式 → `AppNode.textStyle`，三态语义同上。
 *
 * `fontSize` 缺失就当「不是文本节点」（返回 `null`）：字号是这套字段的锚（没有它，
 * 面板上的「字重 / 行高」只是一堆孤立数字），而且 SDK 侧对任何 TextView 都会给出来。
 */
function normalizeSdkTextStyle(style: SdkNodeTextStyle | null | undefined): AppNodeTextStyle | null | undefined {
  if (style === undefined) return undefined;
  if (style === null) return null;
  const fontSize = asFiniteNumber(style.fontSize);
  if (fontSize === null) return null;
  const fontWeight = asFiniteNumber(style.fontWeight);
  return {
    fontSize,
    ...(fontWeight !== null ? { fontWeight } : {}),
    fontStyle: asNonEmptyText(style.fontStyle),
    fontFamily: asNonEmptyText(style.fontFamily),
    lineHeight: asFiniteNumber(style.lineHeight),
    letterSpacing: asFiniteNumber(style.letterSpacing),
    color: asNonEmptyText(style.color),
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
  const rawNodesById = new Map(snapshot.nodes.map((node) => [node.nodeId, node]));
  const hiddenAncestorCache = new Map<string, boolean>();

  for (const [index, node] of snapshot.nodes.entries()) {
    const path = node.treePath || String(index);
    nodeIds.set(node.nodeId, `sdk:${path}`);
  }

  // Older SDK snapshots can contain a hidden parent and visible children without the propagated
  // field. Derive the effective ancestor state here as a compatibility fallback; new snapshots
  // still carry the explicit flag so the result remains directly explainable in the UI.
  const hasHiddenAncestor = (node: SdkAppNode, visiting = new Set<string>()): boolean => {
    if (!node.parentId || visiting.has(node.nodeId)) return false;
    const cached = hiddenAncestorCache.get(node.nodeId);
    if (cached !== undefined) return cached;
    const parent = rawNodesById.get(node.parentId);
    if (!parent) return false;
    visiting.add(node.nodeId);
    const hidden =
      parent.visible === false ||
      parent.hiddenByAncestor === true ||
      parent.state?.hiddenByAncestor === true ||
      hasHiddenAncestor(parent, visiting);
    visiting.delete(node.nodeId);
    hiddenAncestorCache.set(node.nodeId, hidden);
    return hidden;
  };

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
    // 有效可见矩形：与上面那组是**两条独立通道**（前者是平台口径、对绘制期裁剪无感）。
    // ⚠️ 缺字段时**不兜底成自身矩形** —— 兜底会把「这版 SDK 没有这个通道」伪装成
    // 「算出来就是完整可见」，下游再也分不出这两件事；这里如实留成 undefined，
    // 由消费方按「没被裁」处理。
    const hasEffectiveRect =
      node.effectiveVisibleX != null &&
      node.effectiveVisibleY != null &&
      node.effectiveVisibleWidth != null &&
      node.effectiveVisibleHeight != null;
    const effectiveRect = hasEffectiveRect
      ? toRect(
          node.effectiveVisibleX!,
          node.effectiveVisibleY!,
          node.effectiveVisibleWidth!,
          node.effectiveVisibleHeight!,
          densityDpi,
        )
      : null;
    const canonicalId = nodeIds.get(node.nodeId) || `sdk:${path}`;
    const state = node.state;
    const outsideVisibleRect = state?.outsideVisibleRect === true || node.outsideVisibleRect === true;
    const clipped = state?.clipped === true || node.clipped === true;
    const clippedByAncestor = state?.clippedByAncestor === true || node.clippedByAncestor === true;
    const clippedOut = state?.clippedOut === true || node.clippedOut === true;
    const hiddenByAncestor =
      state?.hiddenByAncestor === true ||
      node.hiddenByAncestor === true ||
      hasHiddenAncestor(node);

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
      pixelRect: {
        x: node.x,
        y: node.y,
        width: Math.max(0, node.width),
        height: Math.max(0, node.height),
      },
      visibleX: visibleRect.x,
      visibleY: visibleRect.y,
      visibleWidth: visibleRect.width,
      visibleHeight: visibleRect.height,
      effectiveVisibleX: effectiveRect?.x,
      effectiveVisibleY: effectiveRect?.y,
      effectiveVisibleWidth: effectiveRect?.width,
      effectiveVisibleHeight: effectiveRect?.height,
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
      hiddenByAncestor,
      outsideVisibleRect,
      clipped,
      clippedByAncestor,
      clippedOut,
      layoutOnly: state?.layoutOnly ?? false,
      passThrough: node.passThrough ?? state?.passThrough ?? false,
      textRedacted: node.textRedacted ?? false,
      // 样式两侧同口径（dp），这一步只做形状校验，不做换算 —— 理由见上面那一段注释。
      style: normalizeSdkBoxStyle(node.style),
      textStyle: normalizeSdkTextStyle(node.textStyle),
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
  // 平台白名单：Android 与 iOS 走**同一条**接收链（同一个协议、同一套节点字段），
  // 判据只有两条 —— 来源必须是本 SDK、平台必须是我们支持的两端之一。
  // 2026-09-24 之前这里写死 android，iOS 的快照会在几 MB 传完之后被 400 拒掉。
  if (!snapshot || (snapshot.platform !== 'android' && snapshot.platform !== 'ios')) {
    throw new Error(
      `SDK 节点平台不在支持范围内：${String(snapshot?.platform)}（只接受 android / ios）`,
    );
  }
  if (snapshot.source !== 'react-native-ui-acceptance') {
    throw new Error(
      `SDK 节点来源必须是 react-native-ui-acceptance，收到：${String(snapshot.source)}`,
    );
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
