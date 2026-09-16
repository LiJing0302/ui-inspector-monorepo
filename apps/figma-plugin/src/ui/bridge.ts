/**
 * 插件 UI ↔ Mac 应用「UI 验收投屏」的直传客户端。
 *
 * 跑在 UI iframe 里 —— **主线程（code.ts）没有任何网络能力**，这是 Figma 的沙箱限制，
 * 所以网络动作只能放在这一层。好在 zip 字节流本来就已经通过 `EXPORT_DONE` 递到 UI 了，
 * 于是这条通道对 `code.ts` 是零改动。
 *
 * 设计取舍：
 * - **串行**：UI 上一次只会有一个操作在飞（取需求列表 or 上传），所以用一个
 *   `type → waiter` 的槽位而不是给每条消息配请求 id。少一层状态机，少一类乱序 bug。
 * - **收满即导入**：字节总数以 `upload-begin.byteLength` 为准，没有 `upload-end`，
 *   客户端也就没有机会"提前声称结束"。
 * - **错误信息要能照做**：浏览器不暴露连接失败的具体原因（端口没开 / 被拒都是同一个
 *   `onerror`），所以提示必须直接指向"去 Mac 应用看顶栏状态"，而不是丢一句 network error。
 */

import {
  BRIDGE_CHUNK_BYTES,
  BRIDGE_DEFAULT_PORT,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientMessage,
  type BridgeConflictPolicy,
  type BridgeRequirementBrief,
  type BridgeServerMessage,
  type BridgeUploadResult,
} from '../shared/bridge';

const PLUGIN_NAME = '设计稿节点导出';

const CONNECT_TIMEOUT_MS = 4_000;
const HANDSHAKE_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 6_000;
const IMPORT_TIMEOUT_MS = 120_000;

/** 连不上时的提示必须可以直接照做，否则用户只会看到"点了没反应" */
function unreachableHint(port: number): string {
  return `连不上 localhost:${port}。请确认 Mac 应用「UI 验收投屏」已打开，且顶栏「插件直传」显示为「就绪」。`;
}

/**
 * 必须用 `localhost` 而不是 `127.0.0.1`。
 *
 * manifest 的 `networkAccess.allowedDomains` 只接受**主机名**，写裸 IP
 * 会直接报 `Invalid value for allowedDomains. 'ws://127.0.0.1:...' must be a valid URL`
 * 把插件卡在加载阶段。而 `localhost` 会被解析成 `[::1, 127.0.0.1]`，
 * `::1` 立即 ECONNREFUSED 后自动回退到 `127.0.0.1` —— 所以 Mac 端只绑 IPv4 回环也能连上，
 * 不需要为了它去做双栈监听。
 */
function bridgeUrl(port: number): string {
  return `ws://localhost:${port}`;
}

export class BridgeError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export interface BridgeState {
  phase: 'idle' | 'connecting' | 'ready' | 'uploading';
  port: number;
  chunkBytes: number;
  /** 上传进度 0~1；不在上传时为 null */
  progress: number | null;
  requirements: BridgeRequirementBrief[];
  error: string | null;
}

export interface UploadInput {
  requirementId: string;
  fileName: string;
  bytes: Uint8Array;
  conflict: BridgeConflictPolicy;
}

interface Waiter {
  resolve: (message: BridgeServerMessage) => void;
  reject: (error: Error) => void;
}

export class BridgeClient {
  onState: (state: BridgeState) => void = () => {};

  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private ready = false;
  private waiters = new Map<string, Waiter>();

  private state: BridgeState = {
    phase: 'idle',
    port: BRIDGE_DEFAULT_PORT,
    chunkBytes: BRIDGE_CHUNK_BYTES,
    progress: null,
    requirements: [],
    error: null,
  };

  getState(): BridgeState {
    return this.state;
  }

  /** 连上并完成协议协商。已就绪时是幂等空操作（UI 可以放心重复调用） */
  async ensureReady(port: number = BRIDGE_DEFAULT_PORT): Promise<void> {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.connect(port).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;

    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close();
      } catch {
        /* 已经凉了就算了 */
      }
    }

    this.failAll(new BridgeError('已断开与 Mac 应用的连接'));
    this.patch({ phase: 'idle', progress: null, requirements: [] });
  }

  async listRequirements(port: number = BRIDGE_DEFAULT_PORT): Promise<BridgeRequirementBrief[]> {
    await this.ensureReady(port);
    const pending = this.waitFor('requirements', REQUEST_TIMEOUT_MS, 'Mac 应用没有返回需求列表');
    this.send({ type: 'list-requirements' });

    const message = await pending;
    if (message.type !== 'requirements') throw new BridgeError('Mac 应用返回了预期之外的消息');

    this.patch({ requirements: message.items });
    return message.items;
  }

  async upload(input: UploadInput, port: number = BRIDGE_DEFAULT_PORT): Promise<BridgeUploadResult> {
    await this.ensureReady(port);

    // 先声明再发内容：需求不存在 / 超出体积上限会在这一步被拒，避免几 MB 白传
    const accepted = this.waitFor('upload-ready', REQUEST_TIMEOUT_MS, 'Mac 应用没有接受这次上传');
    this.send({
      type: 'upload-begin',
      requirementId: input.requirementId,
      fileName: input.fileName,
      byteLength: input.bytes.byteLength,
      conflict: input.conflict,
    });
    await accepted;

    const resultPending = this.waitFor('upload-result', IMPORT_TIMEOUT_MS, '等待 Mac 应用导入结果超时');
    this.patch({ phase: 'uploading', progress: 0, error: null });

    const chunkBytes = this.state.chunkBytes || BRIDGE_CHUNK_BYTES;
    const total = input.bytes.byteLength;

    try {
      for (let offset = 0; offset < total; offset += chunkBytes) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          throw new BridgeError('发送过程中与 Mac 应用的连接断开');
        }

        const end = Math.min(offset + chunkBytes, total);
        socket.send(input.bytes.subarray(offset, end));
        this.patch({ progress: end / total });

        // 每 8 片让出一次任务队列：几十 MB 一路同步发会把 iframe 主线程占死、界面卡住
        if (offset / chunkBytes % 8 === 7) {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
      }

      const message = await resultPending;
      if (message.type !== 'upload-result') throw new BridgeError('Mac 应用返回了预期之外的消息');
      return message;
    } finally {
      this.patch({ phase: 'ready', progress: null });
    }
  }

  // ---------- 内部 ----------

  private connect(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.patch({ phase: 'connecting', port, error: null, requirements: [] });

      let socket: WebSocket;
      try {
        socket = new WebSocket(bridgeUrl(port));
      } catch (cause) {
        this.patch({ phase: 'idle' });
        reject(new BridgeError(`无法创建到 localhost:${port} 的连接：${(cause as Error).message}`));
        return;
      }

      let settled = false;
      let timer = 0;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);

        if (!error) {
          resolve();
          return;
        }

        this.socket = null;
        this.ready = false;
        this.patch({ phase: 'idle' });
        reject(error);
      };

      timer = window.setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* 忽略 */
        }
        finish(new BridgeError(`连接 localhost:${port} 超时。${unreachableHint(port)}`));
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        // socket 先挂上：send() 会检查它，否则 hello 都发不出去
        this.socket = socket;

        // 等待器必须先于 hello 就位，否则 welcome 可能比它更早到达而被丢掉
        const pending = this.waitFor('welcome', HANDSHAKE_TIMEOUT_MS, 'Mac 应用没有回应协议协商');
        this.send({
          type: 'hello',
          protocol: BRIDGE_PROTOCOL_VERSION,
          plugin: { name: PLUGIN_NAME },
        });

        void pending
          .then((message) => {
            if (message.type !== 'welcome') {
              throw new BridgeError('Mac 应用返回了预期之外的消息');
            }
            this.ready = true;
            this.patch({
              phase: 'ready',
              port: message.port,
              chunkBytes: message.chunkBytes || BRIDGE_CHUNK_BYTES,
              error: null,
            });
            finish();
          })
          .catch((error: Error) => {
            try {
              socket.close();
            } catch {
              /* 忽略 */
            }
            finish(error);
          });
      };

      socket.onmessage = (event) => this.handleMessage(event);

      socket.onerror = () => {
        finish(new BridgeError(unreachableHint(port)));
      };

      socket.onclose = () => {
        const wasReady = this.ready;
        this.socket = null;
        this.ready = false;
        this.failAll(new BridgeError('与 Mac 应用的连接已断开'));
        // 已 settled 时是空操作
        finish(new BridgeError(unreachableHint(port)));
        if (wasReady) this.patch({ phase: 'idle' });
      };
    });
  }

  private handleMessage(event: MessageEvent): void {
    let message: BridgeServerMessage;
    try {
      message = JSON.parse(String(event.data)) as BridgeServerMessage;
    } catch {
      return;
    }

    if (message.type === 'error') {
      const error = new BridgeError(message.message, message.code);
      // 协议不一致是"整条通道不可用"，值得直接显示在面板上
      if (message.code === 'protocol-mismatch') this.patch({ error: message.message });
      // 有操作在等结果时要立刻让它失败，而不是让它傻等到超时
      if (!this.rejectFirstWaiter(error)) this.patch({ error: message.message });
      return;
    }

    // 给面板留一份需求列表（下次打开面板无需重新请求）
    if (message.type === 'requirements') this.patch({ requirements: message.items });
    this.settle(message.type, message);
  }

  private waitFor(type: string, timeoutMs: number, timeoutMessage: string): Promise<BridgeServerMessage> {
    return new Promise<BridgeServerMessage>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.waiters.delete(type)) reject(new BridgeError(timeoutMessage));
      }, timeoutMs);

      this.waiters.set(type, {
        resolve: (message) => {
          window.clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private settle(type: string, message: BridgeServerMessage): void {
    const waiter = this.waiters.get(type);
    if (!waiter) return;
    this.waiters.delete(type);
    waiter.resolve(message);
  }

  private rejectFirstWaiter(error: Error): boolean {
    const key = this.waiters.keys().next().value as string | undefined;
    if (key === undefined) return false;

    const waiter = this.waiters.get(key);
    this.waiters.delete(key);
    waiter?.reject(error);
    return true;
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
  }

  private send(message: BridgeClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new BridgeError('尚未连接 Mac 应用');
    }
    socket.send(JSON.stringify(message));
  }

  private patch(partial: Partial<BridgeState>): void {
    this.state = { ...this.state, ...partial };
    this.onState(this.state);
  }
}
