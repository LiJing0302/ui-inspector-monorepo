const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { ReadableStream } = require('stream/web');

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

// scrcpy 4.x 的协议、ADB multiplexing 和 server 启动由成熟的 Tango ADB
// 客户端处理。这里仅负责 Electron 生命周期和把视频包转发给 renderer。
class AndroidScrcpy {
  constructor() {
    this.onVideoPacket = null;
    this.onStatus = null;
    this.serial = '';
    this.runtime = null;
    this.modulesPromise = null;
    this.serverBytes = null;
    this.runId = 0;
  }

  async start(serial) {
    await this.stop();
    this.serial = serial || '';
    const runId = ++this.runId;

    try {
      const modules = await this._loadModules();
      const adbPath = this._resolveAdb();
      const serverPath = this._resolveServer();
      await this._ensureAdbServer(adbPath);

      const connector = new modules.AdbServerNodeTcpConnector({
        host: ADB_SERVER_HOST,
        port: ADB_SERVER_PORT,
      });
      const adbServer = new modules.AdbServerClient(connector);
      const devices = await adbServer.getDevices(['device', 'unauthorized', 'offline']);
      const authorized = devices.filter((device) => device.state === 'device');

      if (authorized.length === 0) {
        throw new Error('未检测到已授权的安卓设备。请通过 USB 连接并允许 USB 调试');
      }

      const device = this._selectDevice(authorized);
      if (!device) {
        throw new Error(`指定设备 ${this.serial} 未连接或未授权（当前：${authorized.map((item) => item.serial).join(', ')}）`);
      }
      this.serial = device.serial;
      if (authorized.length > 1 && !serial) {
        this._report(`检测到多台设备，使用 ${this.serial}`);
      }

      const adb = await adbServer.createAdb({ serial: this.serial });
      const runtime = {
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

      this._report(`正在启动 scrcpy server 4.0（${device.model || this.serial}）…`);
      await this._pushServer(modules.AdbScrcpyClient, adb, serverPath);

      const options = new modules.AdbScrcpyOptions4_0({
        video: true,
        audio: false,
        control: true,
        sendFrameMeta: true,
        sendDeviceMeta: true,
        sendCodecMeta: true,
        tunnelForward: false,
        maxSize: 0,
        bitRate: 8000000,
        maxFps: 0,
      });
      const client = await modules.AdbScrcpyClient.start(adb, SCRCPY_SERVER_FILENAME, options);
      if (runId !== this.runId) {
        await client.close();
        return;
      }
      runtime.client = client;

      const video = await client.videoStream;
      runtime.videoWidth = video.metadata.width || video.width || 0;
      runtime.videoHeight = video.metadata.height || video.height || 0;
      this._report(`已连接 ${this.serial}，scrcpy 画面已嵌入验收窗口`);
      this._consumeVideo(video.stream, runtime, runId);
    } catch (error) {
      await this.stop();
      const detail = error.output?.filter(Boolean).slice(-1)[0];
      this._report(`安卓投屏启动失败：${detail || error.message}`);
    }
  }

  async stop() {
    this.runId += 1;
    const runtime = this.runtime;
    this.runtime = null;
    if (!runtime) return;

    try {
      await runtime.reader?.cancel();
    } catch (error) {
      // cancel 可能与 scrcpy server 同时断开，关闭流程无需重复提示。
    }
    try {
      await runtime.client?.close();
    } catch (error) {
      // server 已经退出时 close 可能返回连接错误。
    }
    try {
      await runtime.adb?.close();
    } catch (error) {
      // ignore cleanup errors
    }
    try {
      await runtime.connector?.clearReverseTunnels();
    } catch (error) {
      // ignore cleanup errors
    }
  }

  sendControl(command) {
    const runtime = this.runtime;
    const controller = runtime?.client?.controller;
    if (!runtime || !controller) {
      return Promise.reject(new Error('安卓投屏尚未连接，无法发送控制指令'));
    }

    // Pointer moves can arrive faster than the ADB socket can write. Keep all
    // control messages ordered and avoid concurrent writes to scrcpy.
    const task = runtime.controlQueue.then(async () => {
      if (this.runtime !== runtime || !runtime.client?.controller) {
        throw new Error('安卓投屏已停止');
      }
      await this._writeControl(runtime, command);
    });
    runtime.controlQueue = task.catch(() => {});
    return task;
  }

  async _writeControl(runtime, command) {
    const controller = runtime.client.controller;
    const width = this._dimension(command.videoWidth || runtime.videoWidth);
    const height = this._dimension(command.videoHeight || runtime.videoHeight);

    if (command.type === 'touch') {
      const action = this._touchAction(command.action);
      const buttons = Number.isFinite(command.buttons)
        ? Math.max(0, Math.trunc(command.buttons))
        : action === ANDROID_TOUCH_UP || action === ANDROID_TOUCH_CANCEL
          ? 0
          : ANDROID_PRIMARY_BUTTON;
      await controller.injectTouch({
        action,
        pointerId: ANDROID_GENERIC_FINGER,
        pointerX: this._coordinate(command.pointerX, width),
        pointerY: this._coordinate(command.pointerY, height),
        videoWidth: width,
        videoHeight: height,
        pressure: this._pressure(command.pressure, action),
        actionButton: action === ANDROID_TOUCH_MOVE ? 0 : ANDROID_PRIMARY_BUTTON,
        buttons,
      });
      return;
    }

    if (command.type === 'scroll') {
      await controller.injectScroll({
        pointerX: this._coordinate(command.pointerX, width),
        pointerY: this._coordinate(command.pointerY, height),
        videoWidth: width,
        videoHeight: height,
        scrollX: this._clamp(Number(command.scrollX) || 0, -1, 1),
        scrollY: this._clamp(Number(command.scrollY) || 0, -1, 1),
        buttons: 0,
      });
      return;
    }

    if (command.type === 'key') {
      await controller.injectKeyCode({
        action: command.action === ANDROID_KEY_ACTION_UP
          ? ANDROID_KEY_ACTION_UP
          : ANDROID_KEY_ACTION_DOWN,
        keyCode: this._integer(command.keyCode, 0, 255),
        repeat: this._integer(command.repeat, 0, 255),
        metaState: this._integer(command.metaState, 0, 0x7fffffff),
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

  _touchAction(action) {
    const value = Number(action);
    if ([ANDROID_TOUCH_DOWN, ANDROID_TOUCH_UP, ANDROID_TOUCH_MOVE, ANDROID_TOUCH_CANCEL].includes(value)) {
      return value;
    }
    throw new Error(`无效的触摸动作：${String(action)}`);
  }

  _dimension(value) {
    return this._integer(value, 1, 0xffff) || 1;
  }

  _coordinate(value, dimension) {
    return this._integer(value, 0, dimension);
  }

  _pressure(value, action) {
    if (action === ANDROID_TOUCH_UP || action === ANDROID_TOUCH_CANCEL) return 0;
    return this._clamp(Number(value) || 1, 0, 1);
  }

  _integer(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, Math.trunc(number)));
  }

  _clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  async _consumeVideo(stream, runtime, runId) {
    const reader = stream.getReader();
    runtime.reader = reader;
    try {
      while (runId === this.runId) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.type === 'session') {
          runtime.videoWidth = value.width;
          runtime.videoHeight = value.height;
        }
        if (this.onVideoPacket && value) {
          this.onVideoPacket(this._serializeVideoPacket(value));
        }
      }
    } catch (error) {
      if (runId === this.runId) {
        this._report(`scrcpy 视频流已断开：${error.message}`);
      }
    } finally {
      reader.releaseLock();
      if (this.runtime === runtime) runtime.reader = null;
    }
  }

  _serializeVideoPacket(packet) {
    if (packet.type === 'session') {
      return {
        type: packet.type,
        isClientResize: packet.isClientResize,
        width: packet.width,
        height: packet.height,
      };
    }
    return {
      type: packet.type,
      keyframe: packet.keyframe,
      pts: packet.pts === undefined ? undefined : packet.pts.toString(),
      data: new Uint8Array(packet.data),
    };
  }

  async _loadModules() {
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
      }));
    }
    return this.modulesPromise;
  }

  _selectDevice(devices) {
    if (!this.serial) return devices[0];
    return devices.find((device) => device.serial === this.serial);
  }

  async _pushServer(AdbScrcpyClient, adb, serverPath) {
    if (!this.serverBytes) {
      this.serverBytes = new Uint8Array(fs.readFileSync(serverPath));
    }
    const file = new ReadableStream({
      start: (controller) => {
        controller.enqueue(this.serverBytes);
        controller.close();
      },
    });
    await AdbScrcpyClient.pushServer(adb, file);
  }

  _resolveAdb() {
    const env = process.env;
    const candidates = [
      env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'platform-tools', 'adb'),
      env.ANDROID_SDK_ROOT && path.join(env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
      '/opt/homebrew/bin/adb',
      '/usr/local/bin/adb',
      '/usr/bin/adb',
      path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || 'adb';
  }

  _resolveServer() {
    const env = process.env;
    const candidates = [
      env.SCRCPY_SERVER,
      path.join(process.resourcesPath || '', 'resources', 'scrcpy-server'),
      path.join(__dirname, '..', 'resources', 'scrcpy-server'),
      '/opt/homebrew/share/scrcpy/scrcpy-server',
      '/opt/homebrew/Cellar/scrcpy/4.0/share/scrcpy/scrcpy-server',
      '/usr/local/share/scrcpy/scrcpy-server',
      '/Applications/QtScrcpy.app/Contents/MacOS/scrcpy-server',
    ].filter(Boolean);
    const serverPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!serverPath) {
      throw new Error('未找到 scrcpy-server 4.0，请安装 scrcpy 4.0 或设置 SCRCPY_SERVER');
    }
    return serverPath;
  }

  _ensureAdbServer(adb) {
    return new Promise((resolve, reject) => {
      execFile(adb, ['start-server'], { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${stderr.trim() || error.message}（无法启动 ADB server）`));
          return;
        }
        resolve();
      });
    });
  }

  _report(text) {
    if (this.onStatus) this.onStatus(text);
  }
}

module.exports = AndroidScrcpy;
