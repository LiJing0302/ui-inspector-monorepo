import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { InspectorBridge } from '../.smoke/inspector-bridge.mjs';

const source = {
  projectRootHash: 'demo-root',
  relativePath: 'src/App.tsx',
  startLine: 4,
  startColumn: 1,
  endLine: 4,
  endColumn: 20,
  sourceId: 'source-1',
  displayName: 'View',
  role: 'host',
};

function waitFor(socket, predicate, label, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Inspector smoke message timeout: ${label}`)), timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

const bridge = new InspectorBridge();
await bridge.start(0);
const url = `ws://127.0.0.1:${bridge.status().port}`;
const runtime = new WebSocket(url);
const editor = new WebSocket(url);
await Promise.all([
  new Promise((resolve, reject) => { runtime.once('open', resolve); runtime.once('error', reject); }),
  new Promise((resolve, reject) => { editor.once('open', resolve); editor.once('error', reject); }),
]);

const runtimeReady = waitFor(editor, (message) => message.type === 'runtime-ready', 'runtime-ready');
runtime.send(JSON.stringify({ type: 'hello', protocol: 1, appId: 'react-native-app', token: 'test' }));
runtime.send(JSON.stringify({ type: 'runtime-ready', session: { sessionId: 'session-1', appId: 'react-native-app', projectRootHash: 'demo-root' } }));
await runtimeReady;

const pickMessage = waitFor(runtime, (message) => message.type === 'pick', 'pick');
const pickPromise = bridge.pick({ x: 10, y: 20, width: 100, height: 200 });
const pick = await pickMessage;
const openedPromise = waitFor(editor, (message) => message.type === 'open-source', 'open-source');
runtime.send(JSON.stringify({
  type: 'node-picked',
  requestId: pick.requestId,
  nodes: [{ source, instance: { instanceId: 'source-1:7', sourceId: 'source-1', nativeTag: 7, bounds: { x: 0, y: 0, width: 20, height: 30 }, visible: true, depth: 3 } }],
}));
await pickPromise;
const opened = await openedPromise;
assert.equal(opened.source.relativePath, source.relativePath);
assert.equal(opened.instanceCount, 1);

const highlightPromise = waitFor(runtime, (message) => message.type === 'highlight-source', 'highlight-source');
editor.send(JSON.stringify({ type: 'highlight-source', requestId: 'highlight-1', source }));
const highlight = await highlightPromise;
assert.equal(highlight.requestId, 'highlight-1');
const resultPromise = waitFor(editor, (message) => message.type === 'highlight-result', 'highlight-result');
runtime.send(JSON.stringify({ type: 'highlight-result', requestId: 'highlight-1', resolution: { status: 'mounted', source, instances: [] } }));
const result = await resultPromise;
assert.equal(result.requestId, 'highlight-1');

runtime.close();
editor.close();
await bridge.stop();
console.log('inspector bridge smoke OK');
