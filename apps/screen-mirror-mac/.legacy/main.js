const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const LiveKitSession = require('./src/livekitSession');
const AndroidScrcpy = require('./src/androidScrcpy');

// 静默 Chromium 后台联网噪音（组件更新/遥测）。大陆网络下访问 Google 会 SSL 握手失败打日志，
// 但不影响任何功能（投屏走局域网 TCP / USB adb，不经 HTTPS）。
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-features', 'OptimizationHints,MediaRouter');

let mainWindow = null;
let verifyWindow = null;
let iphoneReceiver = null;
let androidScrcpy = null;
let operation = Promise.resolve();
let quitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 860,
    minWidth: 360,
    minHeight: 600,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    void enqueue(stopAll);
    mainWindow = null;
  });
}

function pushH264(buffer) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 用 send + ipcRenderer.on('h264') 传递；Buffer 会被序列化成 Uint8Array 送达渲染层
    mainWindow.webContents.send('h264', buffer);
  }
}

function pushVideoPacket(packet) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('video-packet', packet);
  }
}

function setStatus(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', text);
  }
}

async function stopAll() {
  if (iphoneReceiver) {
    await iphoneReceiver.stop();
    iphoneReceiver = null;
  }
  if (androidScrcpy) {
    await androidScrcpy.stop();
    androidScrcpy = null;
  }
}

function enqueue(action) {
  const result = operation.then(action);
  operation = result.catch(() => {});
  return result;
}

ipcMain.handle('start-source', (_event, options) => enqueue(async () => {
  const { source, iphoneAddress, androidSerial } = options;
  await stopAll();
  if (source === 'iphone') {
    iphoneReceiver = new LiveKitSession(path.join(app.isPackaged ? process.resourcesPath : __dirname, 'resources'));
    iphoneReceiver.onStatus = setStatus;
    return iphoneReceiver.start(iphoneAddress);
  } else if (source === 'android') {
    androidScrcpy = new AndroidScrcpy();
    androidScrcpy.onVideoPacket = pushVideoPacket;
    androidScrcpy.onStatus = setStatus;
    await androidScrcpy.start(androidSerial || '');
  }
}));

ipcMain.handle('stop-source', () => enqueue(async () => {
  await stopAll();
  setStatus('已停止');
}));

ipcMain.handle('android-control', async (_event, command) => {
  if (!androidScrcpy) {
    throw new Error('安卓投屏尚未启动');
  }
  return androidScrcpy.sendControl(command);
});

ipcMain.handle('get-local-ip', async () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ name, address: net.address });
      }
    }
  }
  return addresses;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function createVerifyWindow() {
  if (verifyWindow && !verifyWindow.isDestroyed()) {
    verifyWindow.focus();
    return verifyWindow;
  }
  verifyWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#f5f6f8',
    title: '设计验收',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  verifyWindow.loadFile(path.join(__dirname, 'renderer', 'verify.html'));
  verifyWindow.on('closed', () => {
    verifyWindow = null;
  });
  return verifyWindow;
}

ipcMain.handle('open-verify', () => createVerifyWindow());

app.on('window-all-closed', () => {
  void enqueue(stopAll);
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void enqueue(stopAll).finally(() => app.quit());
});
