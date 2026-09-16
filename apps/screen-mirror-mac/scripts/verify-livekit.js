const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow, ipcMain } = require('electron');
const project = path.join(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const appResources = path.join(project, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'UI 验收投屏.app', 'Contents', 'Resources');
const root = packaged ? path.join(appResources, 'app.asar') : project;
const resources = path.join(packaged ? appResources : project, 'resources');
const LiveKitSession = require(path.join(root, 'src', 'livekitSession'));
let session;
let receiver;
let publisher;
const timeout = setTimeout(async () => {
  process.stderr.write('LiveKit 验证超时\n');
  await session?.stop();
  app.exit(1);
}, 60000);

app.whenReady().then(async () => {
  try {
    const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
      entries.filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => ({ name, address: entry.address })));
    const host = (addresses.find((entry) => entry.name.startsWith('en')) || addresses[0])?.address;
    assert.ok(host, '需要局域网 IPv4 地址');
    ipcMain.handle('get-local-ip', () => addresses);
    session = new LiveKitSession(resources);
    const credentials = await session.start(host);
    const conflicting = new LiveKitSession(resources);
    await assert.rejects(conflicting.start(host), /LiveKit 启动失败/);
    await conflicting.stop();
    const unauthorized = await fetch(`${credentials.pairingAddress}/pair`, { method: 'POST' });
    assert.equal(unauthorized.status, 403);
    const response = await fetch(`${credentials.pairingAddress}/pair`, {
      method: 'POST', headers: { 'X-Pairing-Code': credentials.pairingCode },
    });
    assert.equal(response.status, 200);
    const publishCredentials = await response.json();
    const claims = JSON.parse(Buffer.from(publishCredentials.token.split('.')[1], 'base64url'));
    assert.deepEqual(claims.video.canPublishSources, ['screen_share']);
    assert.equal(claims.video.canSubscribe, false);
    assert.equal(claims.video.canPublishData, true);
    const windows = [];
    for (let index = 0; index < 2; index += 1) {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(root, 'preload.js'), backgroundThrottling: false },
      });
      window.webContents.on('console-message', (_event, level, message) => {
        if (level >= 3) process.stderr.write(`renderer: ${message}\n`);
      });
      await window.loadFile(path.join(root, 'renderer', 'index.html'));
      windows.push(window);
    }
    [receiver, publisher] = windows;
    await receiver.webContents.executeJavaScript(`iphoneMirror.start(${JSON.stringify(credentials)})`);
    await publisher.webContents.executeJavaScript(`(async () => {
      window.testRoom = new LivekitClient.Room();
      await window.testRoom.connect(${JSON.stringify(credentials.url)}, ${JSON.stringify(publishCredentials.token)}, { rtcConfig: { iceServers: [] } });
      window.testCanvas = document.createElement('canvas');
      testCanvas.width = 320;
      testCanvas.height = 240;
      const context = testCanvas.getContext('2d');
      window.testTimer = setInterval(() => {
        context.fillStyle = '#00ff00';
        context.fillRect(0, 0, 320, 240);
        context.fillStyle = '#000000';
        context.fillText(String(Date.now()), 20, 20);
      }, 50);
      window.testTrack = testCanvas.captureStream(20).getVideoTracks()[0];
      await testRoom.localParticipant.publishTrack(testTrack, { source: LivekitClient.Track.Source.ScreenShare });
    })()`);
    const frame = await receiver.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const timer = setInterval(() => {
        const video = document.getElementById('iphone-screen');
        if (video.videoWidth && video.getVideoPlaybackQuality().totalVideoFrames > 3) {
          clearInterval(timer);
          const sample = document.createElement('canvas');
          sample.width = 320; sample.height = 240;
          const context = sample.getContext('2d');
          context.drawImage(video, 0, 0, 320, 240);
          resolve({ width: video.videoWidth, height: video.videoHeight,
            pixel: Array.from(context.getImageData(160, 120, 1, 1).data),
            hidden: document.getElementById('placeholder').classList.contains('hidden') });
        } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('未收到真实视频帧')); }
      }, 100);
    })`);
    assert.equal(frame.width, 320);
    assert.equal(frame.height, 240);
    assert.ok(frame.pixel[1] > 180 && frame.pixel[0] < 60, '解码后像素应为绿色');
    assert.equal(frame.hidden, true);
    await publisher.webContents.executeJavaScript(`testRoom.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ version: 1, sender: {
        id: 'test-outbound', timestampMs: 1000, sourceFps: 20, limitation: 'none'
      } })), { topic: 'screen-mirror.metrics.v1', reliable: true }
    )`);
    const metrics = await receiver.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const timer = setInterval(() => {
        if (iphoneMirror.senderMetrics) { clearInterval(timer); resolve(iphoneMirror.senderDiagnostics()); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('未收到诊断数据')); }
      }, 100);
    })`);
    assert.match(metrics, /输入\(IPC后\) 20.0fps/);
    process.stdout.write('PASS: 发布端诊断数据通道（合成指标）\n');
    process.stdout.write(`PASS: 配对鉴权、屏幕发布权限、WebRTC 发布/订阅、真实视频解码 ${JSON.stringify(frame)}\n`);
    await publisher.webContents.executeJavaScript('testTrack.stop(); clearInterval(testTimer); testRoom.disconnect()');
    await receiver.webContents.executeJavaScript('iphoneMirror.stop()');
    await session.stop();
    session = new LiveKitSession(resources);
    await session.start(host);
    process.stdout.write('PASS: 停止后可立即重启服务\n');
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  } finally {
    receiver?.destroy();
    publisher?.destroy();
    await session?.stop();
    clearTimeout(timeout);
    app.exit(process.exitCode || 0);
  }
});
