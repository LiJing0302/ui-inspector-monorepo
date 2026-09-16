import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AndroidControlCommand, VideoPacket } from '../types/ipc';

const ADB_SERVER_HOST = '127.0.0.1';
const ADB_SERVER_PORT = 5037;
const SCRCPY_SERVER_FILENAME = '/data/local/tmp/scrcpy-server.jar';

const ANDROID_KEY_ACTION_DOWN = 0;
const ANDROID_KEY_ACTION_UP = 1;
const ANDROID_TOUCH_DOWN = 0;
const ANDROID_TOUCH_UP = 1;
const ANDROID_TOUCH_MOVE = 2;
const ANDROID_TOUCH_CANCEL = 3;
const ANDROID_PRIMARY_BUTTON = 1;
const ANDROID_GENERIC_FINGER = -2n;

/**
 * @yume-chan 系列是 beta（3.0.0-beta.2），公开类型随版本变动。
 * 这里只在「模块加载边界」做一次any收口，收口之后运行时对象全部按下面接口使用，
 * 避免 any 扩散到业务逻辑。后续SDK稳定后可替换为官方类型导入。
 */
interface AdbDeviceLike {
  serial: string;
  state?: string;
  model?: string;
}

interface AdbLike {
  close(): Promise<void>;
}

interface AdbServerClientLike {
  getDevices(states?: string[]): Promise<AdbDeviceLike[]>;
  createAdb(opts: { serial: string }): Promise<AdbLike>;
}

interface ScrcpyControllerLike {
  injectTouch(args: Record<string, unknown>): Promise<void>;
  injectScroll(args: Record<string, unknown>): Promise<void>;
  injectKeyCode(args: Record<string, unknown>): Promise<void>;
  injectText(text: string): Promise<void>;
}

interface ScrcpyClientLike {
  controller?: ScrcpyControllerLike;
  videoStream: Promise<{ metadata?: { width?: number; height?: number }; width?: number; height?: number; stream: ReadableStream<Uint8Array> }>;
  close(): Promise<void>;
}

interface ScrcpyModules {
  AdbServerClient: new (connector: unknown) => AdbServerClientLike;
  AdbScrcpyClient: {
    pushServer(adb: AdbLike, file: ReadableStream<Uint8Array>): Promise<void>;
    start(adb: AdbLike, filename: string, options: unknown): Promise<ScrcpyClientLike>;
  };
  AdbScrcpyOptions4_0: new (options: Record<string, unknown>) => unknown;
  AdbServerNodeTcpConnector: new (opts: { host: string; port: number }) => unknown & {
    clearReverseTunnels(): Promise<void>;
  };
}

/**
 * scrcpy 视频包：底层是 Uint8Array，运行时按 type 附带不同元数据。
 * - session：width/height/isClientResize
 * - data（帧）：data/keyframe/pts
 */
type ScrcpyPacket = Uint8Array & {
  type?: string;
  width?: number;
  height?: number;
  isClientResize?: boolean;
  keyframe?: boolean;
  pts?: bigint;
  data?: Uint8Array;
};
type PacketReader = ReadableStreamDefaultReader<ScrcpyPacket>;

interface Runtime {
  adbServer: AdbServerClientLike;
  connector: { clearReverseTunnels(): Promise<void> };
  adb: AdbLike;
  client: ScrcpyClientLike | null;
  reader: PacketReader | null;
  videoWidth: number;
  videoHeight: number;
  controlQueue: Promise<void>;
}

/**
 * Android 投屏：scrcpy 4.x 的协议、ADB multiplexing 和 server 启动交给 Tango ADB，
 * 本类只负责 Electron 生命周期管理和把视频包转发给渲染层。
 */
export class AndroidScrcpy {
  onVideoPacket: ((packet: VideoPacket) => void) | null = null;
  onStatus: ((text: string) => void) | null = null;

  private serial = '';
  private runtime: Runtime | null = null;
  private modulesPromise: Promise<ScrcpyModules> | null = null;
  private serverBytes: Uint8Array | null = null;
  private runId = 0;

  async start(serial: string): Promise<void> {
    await this.stop();
    this.serial = serial || '';
    const runId = ++this.runId;

    try {
      const modules = await this.loadModules();
      const adbPath = this.resolveAdb();
      const serverPath = this.resolveServer();
      await this.ensureAdbServer(adbPath);

      const connector = new modules.AdbServerNodeTcpConnector({
        host: ADB_SERVER_HOST,
        port: ADB_SERVER_PORT,
      }) as unknown as { clearReverseTunnels(): Promise<void> };

      const adbServer = new modules.AdbServerClient(connector);
      const devices = await adbServer.getDevices(['device', 'unauthorized', 'offline']);
      const authorized = devices.filter((device) => device.state === 'device');

      if (authorized.length === 0) {
        throw new Error('未检测到已授权的安卓设备。请通过 USB 连接并允许 USB 调试');
      }

      const device = this.selectDevice(authorized);
      if (!device) {
        throw new Error(
          `指定设备 ${this.serial} 未连接或未授权（当前：${authorized.map((item) => item.serial).join(', ')}）`,
        );
      }

      this.serial = device.serial;
      if (authorized.length > 1 && !serial) {
        this.report(`检测到多台设备，使用 ${this.serial}`);
      }

      const adb = await adbServer.createAdb({ serial: this.serial });
      const runtime: Runtime = {
        adbServer,
        connector,
        adb,
        client: null,
        reader: null,
        videoWidth: 0,
        videoHeight: 0,
        controlQueue: Promise.resolve(),
      };
      this.runtime = runtime;

      this.report(`正在启动 scrcpy server 4.0（${device.model || this.serial}）…`);
      await this.pushServer(modules.AdbScrcpyClient, adb, serverPath);

      const options = new modules.AdbScrcpyOptions4_0({
        video: true,
        audio: false,
        control: true,
        sendFrameMeta: true,
        sendDeviceMeta: true,
        sendCodecMeta: true,
        tunnelForward: false,
        maxSize: 0,
        bitRate: 8_000_000,
        maxFps: 0,
      });

      const client = await modules.AdbScrcpyClient.start(adb, SCRCPY_SERVER_FILENAME, options);
      if (runId !== this.runId) {
        await client.close();
        return;
      }
      runtime.client = client;

      const video = await client.videoStream;
      runtime.videoWidth = video.metadata?.width || video.width || 0;
      runtime.videoHeight = video.metadata?.height || video.height || 0;
      this.report(`已连接 ${this.serial}，scrcpy 画面已嵌入验收窗口`);

      void this.consumeVideo(video.stream, runtime, runId);
    } catch (error) {
      await this.stop();
      const err = error as { output?: string[]; message?: string };
      const detail = err.output?.filter(Boolean).slice(-1)[0];
      this.report(`安卓投屏启动失败：${detail || err.message}`);
    }
  }

  async stop(): Promise<void> {
    this.runId += 1;
    const runtime = this.runtime;
    this.runtime = null;
    if (!runtime) return;

    try {
      await runtime.reader?.cancel();
    } catch {
      // cancel 可能与 scrcpy server 同时断开，关闭流程无需重复提示。
    }
    try {
      await runtime.client?.close();
    } catch {
      // server 已经退出时 close 可能返回连接错误。
    }
    try {
      await runtime.adb?.close();
    } catch {
      // ignore cleanup errors
    }
    try {
      await runtime.connector?.clearReverseTunnels();
    } catch {
      // ignore cleanup errors
    }
  }

  /**
   * 反向控制。指针移动可能快于 ADB socket 写入速度，
   * 因此所有控制指令串行排队，避免并发写 scrcpy。
   */
  sendControl(command: AndroidControlCommand): Promise<void> {
    const runtime = this.runtime;
    const controller = runtime?.client?.controller;
    if (!runtime || !controller) {
      return Promise.reject(new Error('安卓投屏尚未连接，无法发送控制指令'));
    }

    const task = runtime.controlQueue.then(async () => {
      if (this.runtime !== runtime || !runtime.client?.controller) {
        throw new Error('安卓投屏已停止');
      }
      await this.writeControl(runtime, command);
    });
    runtime.controlQueue = task.catch(() => {});
    return task;
  }

  private async writeControl(runtime: Runtime, command: AndroidControlCommand): Promise<void> {
    const controller = runtime.client?.controller;
    if (!controller) return;

    const width = this.dimension(command.videoWidth || runtime.videoWidth);
    const height = this.dimension(command.videoHeight || runtime.videoHeight);

    if (command.type === 'touch') {
      const action = this.touchAction(command.action);
      const buttons = Number.isFinite(command.buttons)
        ? Math.max(0, Math.trunc(command.buttons as number))
        : action === ANDROID_TOUCH_UP || action === ANDROID_TOUCH_CANCEL
          ? 0
          : ANDROID_PRIMARY_BUTTON;
      await controller.injectTouch({
        action,
        pointerId: ANDROID_GENERIC_FINGER,
        pointerX: this.coordinate(command.pointerX, width),
        pointerY: this.coordinate(command.pointerY, height),
        videoWidth: width,
        videoHeight: height,
        pressure: this.pressure(command.pressure, action),
        actionButton: action === ANDROID_TOUCH_MOVE ? 0 : ANDROID_PRIMARY_BUTTON,
        buttons,
      });
      return;
    }

    if (command.type === 'scroll') {
      await controller.injectScroll({
        pointerX: this.coordinate(command.pointerX, width),
        pointerY: this.coordinate(command.pointerY, height),
        videoWidth: width,
        videoHeight: height,
        scrollX: this.clamp(Number(command.scrollX) || 0, -1, 1),
        scrollY: this.clamp(Number(command.scrollY) || 0, -1, 1),
        buttons: 0,
      });
      return;
    }

    if (command.type === 'key') {
      await controller.injectKeyCode({
        action: command.action === ANDROID_KEY_ACTION_UP ? ANDROID_KEY_ACTION_UP : ANDROID_KEY_ACTION_DOWN,
        keyCode: this.integer(command.keyCode, 0, 255),
        repeat: this.integer(command.repeat, 0, 255),
        metaState: this.integer(command.metaState, 0, 0x7fffffff),
      });
      return;
    }

    if (command.type === 'text') {
      if (typeof command.text !== 'string' || command.text.length === 0) return;
      await controller.injectText(command.text.slice(0, 4096));
      return;
    }

    throw new Error(`未知的安卓控制指令：${String(command.type)}`);
  }

  private touchAction(action: number | undefined): number {
    const value = Number(action);
    if ([ANDROID_TOUCH_DOWN, ANDROID_TOUCH_UP, ANDROID_TOUCH_MOVE, ANDROID_TOUCH_CANCEL].includes(value)) {
      return value;
    }
    throw new Error(`无效的触摸动作：${String(action)}`);
  }

  private dimension(value: number | undefined): number {
    return this.integer(value, 1, 0xffff) || 1;
  }

  private coordinate(value: number | undefined, dimension: number): number {
    return this.integer(value, 0, dimension);
  }

  private pressure(value: number | undefined, action: number): number {
    if (action === ANDROID_TOUCH_UP || action === ANDROID_TOUCH_CANCEL) return 0;
    return this.clamp(Number(value) || 1, 0, 1);
  }

  private integer(value: number | undefined, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, Math.trunc(number)));
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private async consumeVideo(stream: ReadableStream<Uint8Array>, runtime: Runtime, runId: number): Promise<void> {
    // 用局部 const 持有非 null 的 reader：类型收窄后 read / releaseLock 不再需要判空
    const reader = stream.getReader() as unknown as PacketReader;
    runtime.reader = reader;
    try {
      while (runId === this.runId) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.type === 'session') {
          runtime.videoWidth = value.width ?? runtime.videoWidth;
          runtime.videoHeight = value.height ?? runtime.videoHeight;
        }
        if (this.onVideoPacket && value) {
          this.onVideoPacket(this.serializeVideoPacket(value));
        }
      }
    } catch (error) {
      if (runId === this.runId) {
        this.report(`scrcpy 视频流已断开：${(error as Error).message}`);
      }
    } finally {
      reader.releaseLock();
      if (this.runtime === runtime) runtime.reader = null;
    }
  }

  private serializeVideoPacket(packet: ScrcpyPacket): VideoPacket {
    if (packet.type === 'session') {
      return {
        type: 'session',
        isClientResize: packet.isClientResize,
        width: packet.width ?? 0,
        height: packet.height ?? 0,
      };
    }
    return {
      type: packet.type === 'configuration' ? 'configuration' : 'data',
      keyframe: packet.keyframe,
      pts: packet.pts === undefined ? undefined : packet.pts.toString(),
      data: new Uint8Array(packet.data ?? new Uint8Array()),
    };
  }

  private loadModules(): Promise<ScrcpyModules> {
    if (!this.modulesPromise) {
      this.modulesPromise = Promise.all([
        import('@yume-chan/adb'),
        import('@yume-chan/adb-scrcpy'),
        import('@yume-chan/adb-server-node-tcp'),
      ]).then(([adb, scrcpy, connector]) => ({
        AdbServerClient: adb.AdbServerClient,
        AdbScrcpyClient: scrcpy.AdbScrcpyClient,
        AdbScrcpyOptions4_0: scrcpy.AdbScrcpyOptions4_0,
        AdbServerNodeTcpConnector: connector.AdbServerNodeTcpConnector,
      })) as unknown as Promise<ScrcpyModules>;
    }
    return this.modulesPromise;
  }

  private selectDevice(devices: AdbDeviceLike[]): AdbDeviceLike | undefined {
    if (!this.serial) return devices[0];
    return devices.find((device) => device.serial === this.serial);
  }

  private async pushServer(
    AdbScrcpyClient: ScrcpyModules['AdbScrcpyClient'],
    adb: AdbLike,
    serverPath: string,
  ): Promise<void> {
    if (!this.serverBytes) {
      this.serverBytes = new Uint8Array(readFileSync(serverPath));
    }
    const bytes = this.serverBytes;
    const file = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await AdbScrcpyClient.pushServer(adb, file);
  }

  private resolveAdb(): string {
    const env = process.env;
    const candidates = [
      env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'platform-tools', 'adb'),
      env.ANDROID_SDK_ROOT && path.join(env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
      '/opt/homebrew/bin/adb',
      '/usr/local/bin/adb',
      '/usr/bin/adb',
      path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
    ].filter(Boolean) as string[];
    return candidates.find((candidate) => existsSync(candidate)) || 'adb';
  }

  private resolveServer(): string {
    const env = process.env;
    const candidates = [
      env.SCRCPY_SERVER,
      path.join(process.resourcesPath || '', 'resources', 'scrcpy-server'),
      path.join(__dirname, '..', 'resources', 'scrcpy-server'),
      '/opt/homebrew/share/scrcpy/scrcpy-server',
      '/opt/homebrew/Cellar/scrcpy/4.0/share/scrcpy/scrcpy-server',
      '/usr/local/share/scrcpy/scrcpy-server',
      '/Applications/QtScrcpy.app/Contents/MacOS/scrcpy-server',
    ].filter(Boolean) as string[];
    const serverPath = candidates.find((candidate) => existsSync(candidate));
    if (!serverPath) {
      throw new Error('未找到 scrcpy-server 4.0，请安装 scrcpy 4.0 或设置 SCRCPY_SERVER');
    }
    return serverPath;
  }

  private ensureAdbServer(adb: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(adb, ['start-server'], { timeout: 10000 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`${stderr.trim() || error.message}（无法启动 ADB server）`));
          return;
        }
        resolve();
      });
    });
  }

  private report(text: string): void {
    this.onStatus?.(text);
  }
}

export default AndroidScrcpy;
