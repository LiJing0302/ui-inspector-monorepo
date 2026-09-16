export { default as UiAcceptanceModule } from "./uiAcceptanceModule";
export {
  buildAcceptanceConnectionString,
  createAcceptanceCaptureId,
  parseAcceptanceConnectionString,
} from "./uiAcceptanceModule";
export type {
  RecordingOptions,
  RecordingResult,
  AcceptanceCaptureOptions,
  AcceptanceCaptureBundle,
  AcceptanceReceiverConfig,
  AcceptanceScreenshot,
  AcceptanceSnapshotEnvelope,
  AcceptanceUploadOptions,
  AcceptanceUploadResult,
  UiAcceptanceNode,
  UiAcceptanceOptions,
  UiAcceptanceSnapshot,
} from "./uiAcceptanceModule";
export { default as UiAcceptanceBoundsOverlay } from "./components/uiAcceptance/UiAcceptanceBoundsOverlay";
export {
  default as UiAcceptanceFloatingButton,
  type UiAcceptanceFloatingButtonProps,
} from "./components/uiAcceptance/UiAcceptanceFloatingButton";
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
