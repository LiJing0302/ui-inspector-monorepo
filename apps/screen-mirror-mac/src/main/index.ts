import { app, BrowserWindow, ipcMain, type BrowserWindow as BrowserWindowType } from 'electron';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import LiveKitSession from './livekitSession';
import AndroidScrcpy from './androidScrcpy';
import { AcceptanceReceiver } from './capture/acceptanceReceiver';
import { DesignBridge } from './bridge/designBridge';
import { registerBridgeIpc } from './bridge/bridgeIpc';
import { installSmAssetProtocol } from './protocol';
import { initWorkspace } from './store/workspace';
import { registerVerifyIpc } from './verifyIpc';
import type {
  AndroidControlCommand,
  BridgeEvent,
  IPhoneSession,
  MirrorSource,
  NetworkAddress,
  StartSourceOptions,
  VideoPacket,
} from '../types/ipc';

// ESM 下没有 __dirname：out/main/index.js 所在目录
const here = path.dirname(fileURLToPath(import.meta.url));
/** 渲染层产物目录（out/renderer），dev 模式下改用 dev server */
const RENDERER_DIST = path.join(here, '..', 'renderer');

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

/**
 * 启动直通验收页：命令行 `--verify` 或环境变量 SM_VERIFY=1。
 * 验收页处于高频迭代期，不必每次都从投屏页点进去。
 */
const startWithVerify =
  process.argv.includes('--verify') || process.env['SM_VERIFY'] === '1';

// 静默 Chromium 后台联网噪音（组件更新/遥测）。大陆网络下访问 Google 会 SSL 握手失败打日志，
// 但不影响任何功能（投屏走局域网 TCP / USB adb，不经 HTTPS）。
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-features', 'OptimizationHints,MediaRouter');

let mainWindow: BrowserWindowType | null = null;
let verifyWindow: BrowserWindowType | null = null;
let iphoneReceiver: LiveKitSession | null = null;
let androidScrcpy: AndroidScrcpy | null = null;
let designBridge: DesignBridge | null = null;
let acceptanceReceiver: AcceptanceReceiver | null = null;
/**
 * 用户在顶栏是否开着「插件直传」。
 *
 * 生命周期契约是「验收窗口开 = 监听」，但用户显式暂停后，
 * 关掉再开窗口不该悄悄把它的决定推翻 —— 所以用户意图单独记一份。
 */
let bridgeUserEnabled = true;
let operation: Promise<unknown> = Promise.resolve();
let quitting = false;

/**
 * 统一的 preload 路径。
 * 产物名固定为 index.mjs（见 electron.vite.config.ts 的 entryFileNames），
 * 与 package.json 的 type=module 保持一致。
 */
function preloadPath(): string {
  return path.join(app.getAppPath(), 'out', 'preload', 'index.mjs');
}

function rendererUrl(file: string): string {
  return isDev ? `${process.env['ELECTRON_RENDERER_URL']}/${file}` : path.join(RENDERER_DIST, file);
}

function loadRenderer(win: BrowserWindowType, file: string): void {
  const target = rendererUrl(file);
  if (isDev) {
    void win.loadURL(target);
  } else {
    void win.loadFile(target);
  }
}

/**
 * 渲染层诊断：加载失败必须可见，否则窗口白屏却查不到原因。
 * dev 下额外把渲染层的 warning/error 打到主进程 stdout。
 */
function attachRendererDiagnostics(win: BrowserWindowType): void {
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] 加载失败 ${url} (code=${code}): ${description}`);
  });

  if (isDev) {
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) console.error(`[renderer] ${message}`);
    });
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 860,
    minWidth: 360,
    minHeight: 600,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  loadRenderer(mainWindow, 'index.html');
  attachRendererDiagnostics(mainWindow);

  mainWindow.on('closed', () => {
    void enqueue(stopAll);
    mainWindow = null;
  });
}

function createVerifyWindow(): BrowserWindowType {
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
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  loadRenderer(verifyWindow, 'verify.html');
  attachRendererDiagnostics(verifyWindow);

  verifyWindow.on('closed', () => {
    verifyWindow = null;
    // 直传通道跟着验收窗口走：窗口不在了就没必要继续开着回环端口
    void enqueue(() => designBridge?.stop());
    // 接收器同时要撤销可能挂着的「等待手机上传」，否则那个 Promise 会一直悬着
    void enqueue(() => acceptanceReceiver?.stop());
  });

  // 渲染层可能比服务先就绪，所以这里不 await：状态经由 bridge:event 推过去，
  // 渲染层挂载后再 invoke('bridge:status') 取一次当前值
  if (bridgeUserEnabled) {
    void startBridge();
  }
  void startAcceptanceReceiver();

  return verifyWindow;
}

async function startAcceptanceReceiver(): Promise<void> {
  if (!acceptanceReceiver) return;
  try {
    await acceptanceReceiver.start();
  } catch (error) {
    console.error('[acceptance] 接收器启动失败：', (error as Error).message);
  }
}

/** 启动直传服务；失败只记日志 + 推状态，不能把窗口创建流程带崩 */
async function startBridge(): Promise<void> {
  if (!designBridge) return;
  try {
    await designBridge.start();
  } catch (error) {
    console.error('[bridge] 启动失败：', (error as Error).message);
    pushBridgeEvent({ type: 'status', status: designBridge.status() });
  }
}

function pushBridgeEvent(event: BridgeEvent): void {
  if (verifyWindow && !verifyWindow.isDestroyed()) {
    verifyWindow.webContents.send('bridge:event', event);
  }
}

function pushVideoPacket(packet: VideoPacket): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('video-packet', packet);
  }
}

function setStatus(text: string): void {
  for (const win of [mainWindow, verifyWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('status', text);
    }
  }
}

async function stopAll(): Promise<void> {
  if (iphoneReceiver) {
    await iphoneReceiver.stop();
    iphoneReceiver = null;
  }
  if (androidScrcpy) {
    await androidScrcpy.stop();
    androidScrcpy = null;
  }
}

/** 退出前的完整收摊：投屏源 + 直传通道。回环端口必须显式关掉才能放行进程退出 */
async function shutdown(): Promise<void> {
  await stopAll();
  await designBridge?.stop();
  await acceptanceReceiver?.stop();
}

/**
 * 串行化所有启停动作。
 * 用户快速切换信号源时，若不加锁会导致上一个子进程还没退出、下一个又去占用同一批端口。
 */
function enqueue<T>(action: () => Promise<T> | T): Promise<T> {
  const result = operation.then(action);
  operation = result.catch(() => {});
  return result as Promise<T>;
}

// ---------- IPC ----------

ipcMain.handle('start-source', (_event, options: StartSourceOptions) =>
  enqueue(async (): Promise<IPhoneSession | void> => {
    const source: MirrorSource = options.source;
    await stopAll();

    if (source === 'iphone') {
      const resourcesPath = path.join(
        app.isPackaged ? process.resourcesPath : app.getAppPath(),
        'resources',
      );
      iphoneReceiver = new LiveKitSession(resourcesPath);
      iphoneReceiver.onStatus = setStatus;
      return iphoneReceiver.start(options.iphoneAddress ?? '');
    }

    if (source === 'android') {
      androidScrcpy = new AndroidScrcpy();
      androidScrcpy.onVideoPacket = pushVideoPacket;
      androidScrcpy.onStatus = setStatus;
      await androidScrcpy.start(options.androidSerial ?? '');
    }
  }),
);

ipcMain.handle('stop-source', () =>
  enqueue(async () => {
    await stopAll();
    setStatus('已停止');
  }),
);

ipcMain.handle('android-control', async (_event, command: AndroidControlCommand) => {
  if (!androidScrcpy) {
    throw new Error('安卓投屏尚未启动');
  }
  return androidScrcpy.sendControl(command);
});

ipcMain.handle('get-local-ip', (): NetworkAddress[] => {
  const nets = networkInterfaces();
  const addresses: NetworkAddress[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ name, address: net.address });
      }
    }
  }
  return addresses;
});

ipcMain.handle('open-verify', (): void => {
  // 注意：不能返回 BrowserWindow 实例 —— 它无法被结构化克隆，会让 invoke 直接 reject
  createVerifyWindow();
});

// ---------- 生命周期 ----------

app.whenReady().then(async () => {
  // 协议必须在 ready 之后注册 handler（scheme 本身已在 protocol.ts 顶层声明为 privileged）
  installSmAssetProtocol();
  acceptanceReceiver = new AcceptanceReceiver();
  registerVerifyIpc(acceptanceReceiver);

  // 插件直传通道：单例。事件统一转成 bridge:event 推给验收窗口
  designBridge = new DesignBridge();
  designBridge.onEvent = (event) => pushBridgeEvent(event);
  registerBridgeIpc(designBridge, (enabled) => {
    bridgeUserEnabled = enabled;
  });

  // 初始化 workspace：建目录 + 加载索引 + reconcile（索引有但目录没了的条目会被丢弃）
  await initWorkspace().catch((error: unknown) => {
    console.error('[workspace] 初始化失败：', (error as Error).message);
  });

  if (startWithVerify) {
    createVerifyWindow();
  } else {
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    if (startWithVerify) {
      createVerifyWindow();
    } else {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  void enqueue(shutdown);
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void enqueue(shutdown).finally(() => app.quit());
});
