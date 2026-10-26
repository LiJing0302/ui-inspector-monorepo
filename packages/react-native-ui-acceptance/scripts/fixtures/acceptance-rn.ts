/** JS SDK boundary fixture. Native capture still requires separate device verification. */
export const state = { width: 360, height: 800, density: 3, fontScale: 1, platform: 'android', snapshot: {} as any, uploaded: null as any,
  onCapture: undefined as (() => void) | undefined };
export const Dimensions = { get: () => ({ width: state.width, height: state.height }) };
export const PixelRatio = { get: () => state.density, getFontScale: () => state.fontScale };
export const Platform = { get OS() { return state.platform; } };
export const NativeModules = { UiAcceptanceModule: {
  capture: async () => state.snapshot,
  captureBundle: async () => {
    state.onCapture?.();
    return { snapshot: state.snapshot, screenshot: { mimeType: 'image/png', width: 1080, height: 2400, base64: 'YWJj' } };
  },
} };
