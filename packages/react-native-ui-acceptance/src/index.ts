/**
 * SDK 的公开面只有两样东西：
 *
 * ① **能力** —— 连接与上传（`UiAcceptanceModule` 与它周围那几个纯函数）；
 * ② **浮层验收绘制** —— `UiAcceptanceBoundsOverlay` + `useUiAcceptanceSelection`
 *    + `geometry` 里那组几何纯函数。
 *
 * 工具条、弹窗这类**产品界面不在 SDK 里**：几个按钮、什么颜色、放哪个角落、要不要把
 * Mac 地址落盘，都是宿主 App 自己的事。曾经的 `UiAcceptanceFloatingButton` /
 * `UiAcceptanceLanDialog` 已迁出（2026-09-24），App 侧见
 * `src/components/uiAcceptance/`。
 *
 * 这么切还有一个工程上的好处：SDK 里的界面组件一旦被 App 引用，任何一次样式改动都要
 * 走「重新打包 → 升依赖 → 重装」；而它本身又不含任何需要原生支持的东西，放在 SDK 里
 * 只是把宿主的迭代速度绑在了发版上。
 */
export { default as UiAcceptanceModule } from "./uiAcceptanceModule";
export {
  buildAcceptanceConnectionString,
  createAcceptanceCaptureId,
  DEFAULT_ACCEPTANCE_RECEIVER_PORT,
  discoverUsbAcceptanceReceiver,
  // iOS 上「USB 直传走不通」的完整解释。宿主拿它做前置判断，
  // 就能省掉 iOS 上那次注定失败的 4 秒探测（见 discoverUsbAcceptanceReceiver）。
  IOS_USB_UPLOAD_UNSUPPORTED,
  parseAcceptanceConnectionString,
  parseAcceptanceTarget,
} from "./uiAcceptanceModule";
export type {
  RecordingOptions,
  RecordingResult,
  AcceptanceCaptureOptions,
  AcceptanceCaptureBundle,
  AcceptanceReceiverConfig,
  AcceptanceUploadOptions,
  AcceptanceScreenshot,
  AcceptanceSnapshotEnvelope,
  AcceptanceUploadResult,
  UiAcceptanceNode,
  UiAcceptanceOptions,
  UiAcceptanceSnapshot,
} from "./uiAcceptanceModule";
export { default as UiAcceptanceBoundsOverlay } from "./components/uiAcceptance/UiAcceptanceBoundsOverlay";
export { useUiAcceptanceSelection } from "./components/uiAcceptance/selection";
export {
  UiInspector,
  createUiInspector,
  type UiInspectorOptions,
  type UiInspectorStatus,
} from './inspector';
export type {
  UiAcceptanceDistanceAxis,
  UiAcceptanceNodeDistance,
  UiAcceptancePoint,
  UiAcceptanceRect,
  UiAcceptanceRenderableNode,
} from "./components/uiAcceptance/geometry";
export {
  getUiAcceptanceBorderSegments,
  getUiAcceptanceDrawableNodes,
  getUiAcceptanceNodeDistance,
  getUiAcceptanceNodeRect,
  getUiAcceptanceVisibleRect,
  intersectUiAcceptanceRects,
} from "./components/uiAcceptance/geometry";
