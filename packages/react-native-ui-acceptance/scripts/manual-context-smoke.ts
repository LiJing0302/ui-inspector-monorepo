import assert from 'node:assert/strict';
import test from 'node:test';
import type { AcceptanceContext } from '@ui-inspector/protocol';
import UiAcceptanceModule from '../src/uiAcceptanceModule';
import { state } from './fixtures/acceptance-rn';
const context: AcceptanceContext = {
  version: 1, logicalUnit: 'dp', viewport: { width: 360, height: 800 }, pixelRatio: 3, fontScale: 1,
  design: { width: 375, height: 667, unitsPerPoint: 1, rules: {
    width: { scale: 'width', rounding: 'nearest-pixel' }, height: { scale: 'width', rounding: 'nearest-pixel' },
    radius: { scale: 'min', rounding: 'none' }, spacing: { scale: 'width', rounding: 'none' },
  } },
};
const snapshot: any = { platform: 'android', source: 'react-native-ui-acceptance', nodes: [{ nodeId: 'n0', width: 288 }], collection: { profile: 'acceptance-full' } };
test('actual JS SDK attaches configured rules to capture/bundle/upload and leaves native geometry untouched', async () => {
  state.snapshot = { ...snapshot, acceptanceContext: undefined };
  UiAcceptanceModule.configureAcceptance(context.design!, (node) => node.nodeId === 'n0' ? { radius: { scale: 'fixed', rounding: 'none' } } : undefined);
  const bundle = await UiAcceptanceModule.captureBundle();
  assert.deepEqual(bundle.snapshot.acceptanceContext, context);
  assert.equal(bundle.snapshot.nodes[0].width, 288);
  assert.equal(bundle.snapshot.nodes[0].acceptanceRules?.radius?.scale, 'fixed');
  assert.equal((await UiAcceptanceModule.capture()).acceptanceContext?.viewport.width, 360);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, options: any) => {
    state.uploaded = JSON.parse(options.body);
    return { ok: true, json: async () => ({ accepted: true }) };
  }) as any;
  try {
    await UiAcceptanceModule.uploadBundle({ host: 'localhost', port: 1234 });
    assert.deepEqual(state.uploaded.snapshot.acceptanceContext, context);
    UiAcceptanceModule.configureAcceptance(null);
    assert.equal((await UiAcceptanceModule.captureBundle()).snapshot.acceptanceContext?.design, undefined);
    assert.equal((await UiAcceptanceModule.captureBundle()).snapshot.nodes[0].acceptanceRules, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('SDK can capture the host adaptation viewport, and freezes the node resolver for an in-flight capture', async () => {
  UiAcceptanceModule.configureAcceptance(context.design!, () => ({ width: { scale: 'fixed', rounding: 'none' } }), () => ({ width: 359, height: 799 }));
  const pending = UiAcceptanceModule.captureBundle();
  const captured = await pending;
  assert.equal(captured.snapshot.acceptanceContext?.viewport.width, 359);
  UiAcceptanceModule.configureAcceptance(context.design!, () => ({ width: { scale: 'fixed', rounding: 'none' } }));
  const inFlight = UiAcceptanceModule.captureBundle();
  UiAcceptanceModule.configureAcceptance(context.design!, () => ({ width: { scale: 'height', rounding: 'none' } }));
  assert.equal((await inFlight).snapshot.nodes[0].acceptanceRules?.width?.scale, 'fixed');
  UiAcceptanceModule.configureAcceptance(null);
});

test('SDK rejects a capture when the window changes during native capture', async () => {
  state.onCapture = () => { state.width = 400; };
  try { await assert.rejects(UiAcceptanceModule.captureBundle(), /采集期间窗口/); }
  finally { state.onCapture = undefined; state.width = 360; }
});
