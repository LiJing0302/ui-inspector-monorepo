const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'iphone.js'), 'utf8');

function fixture() {
  const diagnostics = { textContent: '' };
  const timers = new Map();
  const statuses = [];
  let nextTimer = 0;
  let clock = 10000;
  class Room {
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
    }
    on(event, handler) { this.handlers.set(event, handler); }
    async connect() {}
    async disconnect() { this.disconnected = true; }
    removeAllListeners() { this.handlers.clear(); }
  }
  const events = Object.fromEntries(['TrackSubscribed', 'TrackUnsubscribed', 'Reconnecting', 'Reconnected', 'Disconnected', 'DataReceived']
    .map((event) => [event, event]));
  const context = vm.createContext({
    window: { LivekitClient: { Room, RoomEvent: events, Track: { Kind: { Video: 'video' }, Source: { ScreenShare: 'screen_share' } }, VideoQuality: { HIGH: 2 } } },
    document: { getElementById: () => diagnostics },
    TextDecoder,
    Date: { now: () => clock },
    setTimeout: (callback, delay) => { nextTimer += 1; timers.set(nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: (timer) => timers.delete(timer),
  });
  vm.runInContext(source, context);
  const video = { videoWidth: 886, videoHeight: 1920, play: async () => {} };
  const placeholder = { classList: { add() {}, remove() {} } };
  const mirror = new context.window.IPhoneMirror(video, placeholder, (status) => statuses.push(status));
  const tick = async () => {
    const entry = Array.from(timers.entries()).find(([, timer]) => timer.delay === 1000);
    assert.ok(entry, '统计应继续采样');
    timers.delete(entry[0]);
    await entry[1].callback();
  };
  return { mirror, diagnostics, timers, statuses, video, tick, advance: (milliseconds) => { clock += milliseconds; } };
}

function report(overrides = {}) {
  return new Map([
    ['video', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 1000,
      framesDecoded: 30, framesDropped: 0, packetsLost: 0, jitterBufferDelay: 0.3,
      jitterBufferEmittedCount: 30, jitterBufferTargetDelay: 0.6, jitterBufferMinimumDelay: 0.15,
      totalDecodeTime: 0.06, codecId: 'codec', transportId: 'transport', ...overrides }],
    ['codec', { mimeType: 'video/H264' }],
    ['transport', { selectedCandidatePairId: 'pair' }],
    ['pair', { localCandidateId: 'candidate' }],
    ['candidate', { protocol: 'udp' }],
  ]);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('高质量订阅、零额外缓冲、区间统计及停止清理', async () => {
  const { mirror, diagnostics, timers, tick, video } = fixture();
  await mirror.start({ url: 'ws://localhost', token: 'test' });
  const room = mirror.room;
  assert.equal(room.options.adaptiveStream, false);
  let current = report();
  const track = { kind: 'video', attach() {}, detach() {},
    setPlayoutDelay(value) { this.delay = value; }, getRTCStatsReport: async () => current };
  const publication = { source: 'screen_share', setVideoQuality(value) { this.quality = value; } };
  await room.handlers.get('TrackSubscribed')(track, publication);
  await settle();
  assert.equal(publication.quality, 2);
  assert.equal(track.delay, 0);
  assert.match(diagnostics.textContent, /待采样/);
  video.onplaying();
  current = report({ timestamp: 2000, bytesReceived: 1001000, framesDecoded: 60,
    framesDropped: 2, packetsLost: 3, jitterBufferDelay: 0.6, jitterBufferEmittedCount: 60,
    jitterBufferTargetDelay: 1.2, jitterBufferMinimumDelay: 0.3, totalDecodeTime: 0.12 });
  await tick();
  assert.match(diagnostics.textContent, /886×1920 · H264 · 30.0fps · 8.00Mbps/);
  assert.match(diagnostics.textContent, /Mac 接收段 UDP · 缓冲 10.0ms · 解码 2.0ms · 丢包 \+3 \/ 丢帧 \+2/);
  assert.match(diagnostics.textContent, /缓冲实际\/目标\/最小：10.0ms \/ 20.0ms \/ 5.0ms/);
  assert.match(diagnostics.textContent, /回读不支持/);
  current = report({ timestamp: 3000, bytesReceived: 10, framesDecoded: 1 });
  await tick();
  assert.match(diagnostics.textContent, /码率待采样/);
  await mirror.stop();
  assert.equal(diagnostics.textContent, '');
  assert.equal(timers.size, 0);
  assert.equal(room.disconnected, true);
});

const encodeMetrics = (sender) => new TextEncoder().encode(JSON.stringify({ version: 1, sender }));

test('发布端差分统计、重复采样过期和计数器重置', async () => {
  const { mirror, advance } = fixture();
  const first = { id: 'outbound', timestampMs: 1000, framesEncoded: 10, framesSent: 10,
    bytesSent: 1000, encodeSeconds: 0.01, sendDelaySeconds: 0.1, packetsSent: 10,
    sourceFps: 30, limitation: 'cpu', protocol: 'udp', rttMs: 8, availableMbps: 20 };
  mirror.receiveSenderMetrics(encodeMetrics(first));
  assert.match(mirror.senderDiagnostics(), /编码 — \/ 发送 —/);
  const second = { ...first, timestampMs: 3000, framesEncoded: 70, framesSent: 68,
    bytesSent: 1001000, encodeSeconds: 0.19, sendDelaySeconds: 0.3, packetsSent: 110 };
  advance(2000);
  mirror.receiveSenderMetrics(encodeMetrics(second));
  assert.match(mirror.senderDiagnostics(), /输入\(IPC后\) 30.0fps · 编码 30.0fps \/ 发送 29.0fps · 4.0Mbps/);
  assert.match(mirror.senderDiagnostics(), /编码 3.0ms\/帧 · 发包等待 2.0ms\/包 · 限制 cpu/);
  assert.match(mirror.senderDiagnostics(), /iPhone 上行 UDP · RTT 8.0ms/);
  mirror.receiveSenderMetrics(encodeMetrics(first));
  assert.equal(mirror.previousSender.timestampMs, 3000);
  advance(6500);
  mirror.receiveSenderMetrics(encodeMetrics(second));
  assert.match(mirror.senderDiagnostics(), /发布端：统计缺失或已过期/);
  mirror.receiveSenderMetrics(encodeMetrics({ ...first, timestampMs: 10000 }));
  assert.match(mirror.senderDiagnostics(), /编码 — \/ 发送 —/);
  advance(6500);
  assert.match(mirror.senderDiagnostics(), /超过6秒未收到上报/);
});

test('诊断只接收配对发布者指定 topic，拒绝坏包并清理重连状态', async () => {
  const { mirror } = fixture();
  await mirror.start({});
  const handler = mirror.room.handlers.get('DataReceived');
  const payload = encodeMetrics({ id: 'outbound', timestampMs: 1000 });
  handler(payload, { identity: 'other' }, undefined, 'screen-mirror.metrics.v1');
  handler(payload, { identity: 'iphone-publisher' }, undefined, 'wrong-topic');
  assert.equal(mirror.senderMetrics, null);
  handler(new Uint8Array(1201), { identity: 'iphone-publisher' }, undefined, 'screen-mirror.metrics.v1');
  handler(new TextEncoder().encode('{broken'), { identity: 'iphone-publisher' }, undefined, 'screen-mirror.metrics.v1');
  handler(encodeMetrics({}), { identity: 'iphone-publisher' }, undefined, 'screen-mirror.metrics.v1');
  assert.equal(mirror.senderMetrics, null);
  handler(payload, { identity: 'iphone-publisher' }, undefined, 'screen-mirror.metrics.v1');
  assert.ok(mirror.senderMetrics);
  mirror.room.handlers.get('Reconnecting')();
  assert.equal(mirror.senderMetrics, null);
  await mirror.stop();
  handler(payload, { identity: 'iphone-publisher' }, undefined, 'screen-mirror.metrics.v1');
  assert.equal(mirror.senderMetrics, null);
});

test('播放设置回读区分不支持、未设置和零提示', () => {
  const { mirror } = fixture();
  assert.match(mirror.playoutSettings({}), /回读不支持/);
  assert.match(mirror.playoutSettings({ receiver: { playoutDelayHint: undefined } }), /回读未设置/);
  assert.match(mirror.playoutSettings({ receiver: { playoutDelayHint: 0, jitterBufferTarget: 25 } }),
    /回读0.0ms · jitterBufferTarget 25.0ms（非实际延迟）/);
});

test('只向发布者授予诊断数据发送权限', async () => {
  const LiveKitSession = require('../src/livekitSession');
  const session = new LiveKitSession('/unused');
  session.apiKey = 'test-key';
  session.apiSecret = 'test-secret-only-for-local-verification';
  session.room = 'test-room';
  const claims = async (publisher) => JSON.parse(Buffer.from((await session.token(
    publisher ? 'iphone-publisher' : 'mac-viewer', publisher
  )).split('.')[1], 'base64url').toString());
  const sender = await claims(true);
  const viewer = await claims(false);
  assert.equal(sender.video.canPublishData, true);
  assert.equal(sender.video.canSubscribe, false);
  assert.deepEqual(sender.video.canPublishSources, ['screen_share']);
  assert.equal(viewer.video.canPublishData, false);
  assert.equal(viewer.video.canPublish, false);
});

test('统计缺失、异常、重连、无关取消订阅和断开', async () => {
  const { mirror, diagnostics, tick, timers } = fixture();
  await mirror.start({});
  const room = mirror.room;
  const track = { kind: 'video', attach() {}, detach() {}, setPlayoutDelay() {}, getRTCStatsReport: async () => undefined };
  await room.handlers.get('TrackSubscribed')(track, { source: 'screen_share', setVideoQuality() {} });
  await settle();
  assert.match(diagnostics.textContent, /等待 WebRTC/);
  track.getRTCStatsReport = async () => { throw new Error('closed'); };
  await tick();
  assert.match(diagnostics.textContent, /暂不可用/);
  room.handlers.get('TrackUnsubscribed')({});
  assert.equal(mirror.videoTrack, track);
  room.handlers.get('Reconnecting')();
  assert.equal(mirror.statsMonitor, null);
  track.getRTCStatsReport = async () => report();
  room.handlers.get('Reconnected')();
  await settle();
  assert.match(diagnostics.textContent, /H264/);
  room.handlers.get('TrackUnsubscribed')(track);
  assert.equal(mirror.videoTrack, null);
  assert.equal(diagnostics.textContent, '');
  room.handlers.get('Disconnected')();
  assert.equal(timers.size, 0);
});

test('停止后异步统计不得更新界面或重建定时器', async () => {
  const { mirror, diagnostics, timers } = fixture();
  await mirror.start({});
  let finish;
  mirror.startDiagnostics(mirror.room, { getRTCStatsReport: () => new Promise((resolve) => { finish = resolve; }) });
  await mirror.stop();
  finish(report());
  await settle();
  assert.equal(diagnostics.textContent, '');
  assert.equal(timers.size, 0);
});
