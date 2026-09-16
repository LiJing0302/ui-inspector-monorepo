/**
 * Figma 插件直传通道：跑在 Mac 应用主进程里的 WebSocket 回环服务。
 *
 * ## 为什么要有这道 Origin 闸
 *
 * 「只绑 127.0.0.1」**并不等于安全**。WebSocket 不受 CORS 约束，
 * 所以你浏览器里任意一个网页都能尝试连 `ws://localhost:23457` ——
 * 能读需求列表，也能往里塞设计稿。
 *
 * 但浏览器**强制**为 WebSocket 握手带上真实的 `Origin` 头，JS 伪造不了；
 * 而 Figma 插件的 UI 是 sandboxed iframe，Origin 为 `null`。
 * 于是只放行「null / 缺失 / figma.com」，就能把你本机所有网页挡在门外，
 * 而用户侧零感知 —— 不需要输配对码，也不需要点任何确认。
 *
 * 残留风险（明确记录，不假装不存在）：**本机的非浏览器进程**可以伪造 Origin 连进来。
 * 但那种进程本来就能直接读写 workspace 目录，不是这条通道能防的对手。
 *
 * ## 状态机
 *
 * `连接 → hello（校验协议版本）→ list-requirements / upload-begin → 分片二进制 → 收满即导入`
 *
 * 刻意**没有** `upload-end`：字节总数由 `upload-begin` 权威给定，收满即落盘。
 * 少一个状态就少一类「客户端提前声称结束」的边界。
 */

import { app } from 'electron';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  BRIDGE_CHUNK_BYTES,
  BRIDGE_DEFAULT_PORT,
  BRIDGE_HOST,
  BRIDGE_MAX_FRAME_BYTES,
  BRIDGE_MAX_UPLOAD_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientMessage,
  type BridgeConflictPolicy,
  type BridgeErrorCode,
  type BridgeEvent,
  type BridgeFrameResult,
  type BridgeLastImport,
  type BridgeRequirementBrief,
  type BridgeServerMessage,
  type BridgeStatus,
} from '../../types/bridge';
import { importFigmaPackageFromBytes } from '../importer/figmaImport';
import { getRequirement, listRequirements } from '../store/workspace';

/**
 * 握手 Origin 白名单。
 *
 * 浏览器一定带 Origin 且不可伪造；非浏览器客户端（含 Figma 桌面端的插件 iframe）
 * 要么不带、要么是 `null`。所以这里放行「空 / null / figma.com」，
 * 等于只拒绝"被网页发起"的连接。
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '' || origin === 'null') return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'figma.com' || host.endsWith('.figma.com');
}

interface UploadState {
  requirementId: string;
  fileName: string;
  conflict: BridgeConflictPolicy;
  byteLength: number;
  received: number;
  chunks: Buffer[];
}

interface ClientSession {
  ws: WebSocket;
  helloed: boolean;
  upload: UploadState | null;
}

/** ws 的 RawData 有 Buffer / ArrayBuffer / Buffer[] 三种形态，统一成 Buffer */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function toBrief(requirement: {
  id: string;
  name: string;
  designAssets: unknown[];
  appSnapshots: unknown[];
  pairs: unknown[];
  updatedAt: string;
}): BridgeRequirementBrief {
  return {
    id: requirement.id,
    name: requirement.name,
    designCount: requirement.designAssets.length,
    appCount: requirement.appSnapshots.length,
    pairCount: requirement.pairs.length,
    updatedAt: requirement.updatedAt,
  };
}

function toFrameResult(frame: {
  frameId: string;
  name: string;
  nodeCount: number;
  width: number;
  height: number;
  status: BridgeFrameResult['status'];
  isFrameLevel: boolean;
  reason?: string;
}): BridgeFrameResult {
  return {
    frameId: frame.frameId,
    name: frame.name,
    nodeCount: frame.nodeCount,
    width: frame.width,
    height: frame.height,
    status: frame.status,
    isFrameLevel: frame.isFrameLevel,
    reason: frame.reason,
  };
}

export class DesignBridge {
  /** 状态变化 / 导入完成的统一出口，由 index.ts 接到渲染层 */
  onEvent: (event: BridgeEvent) => void = () => {};

  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private sessions = new Set<ClientSession>();
  private port = BRIDGE_DEFAULT_PORT;
  private running = false;
  private busy = false;
  private rejected = 0;
  private lastImport?: BridgeLastImport;

  status(): BridgeStatus {
    return {
      running: this.running,
      host: BRIDGE_HOST,
      port: this.port,
      clients: this.sessions.size,
      busy: this.busy,
      rejected: this.rejected,
      lastImport: this.lastImport,
    };
  }

  /**
   * 启动监听。
   * @param port 传 0 交给系统挑空闲端口（冒烟测试用；插件侧固定用 BRIDGE_DEFAULT_PORT）
   */
  async start(port: number = BRIDGE_DEFAULT_PORT): Promise<BridgeStatus> {
    if (this.running) return this.status();

    const server = createServer((_req, res) => {
      // 这个端口只服务插件直传，普通 HTTP 请求明确拒绝（也让它可被探测出"活着"）
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('本端口只接受 WebSocket 连接');
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: BRIDGE_MAX_FRAME_BYTES });

    server.on('upgrade', (req, socket, head) => {
      if (!isAllowedOrigin(req.headers.origin)) {
        this.rejected += 1;
        // 明确回 403 而不是直接断，方便在插件侧 DevTools 的 Network 里看到原因
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        this.emit();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, BRIDGE_HOST);
      });
    } catch (error) {
      // 端口被占是最常见的失败：报清楚"谁占了 / 怎么改"，别只丢一个 EADDRINUSE
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'EADDRINUSE'
          ? `端口 ${port} 已被占用，插件直传无法启动（可能是另一个本应用实例还在运行）`
          : `插件直传服务启动失败：${(error as Error).message}`,
      );
    }

    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : port;
    this.server = server;
    this.wss = wss;
    this.running = true;
    this.emit();

    return this.status();
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    for (const session of this.sessions) session.ws.terminate();
    this.sessions.clear();

    const wss = this.wss;
    const server = this.server;
    this.wss = null;
    this.server = null;
    this.running = false;
    this.busy = false;

    // closeAllConnections 防止"某个连接半死不活"把 close 回调永久挂住
    server?.closeAllConnections?.();

    await Promise.all([
      new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve())),
      new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
    ]);

    this.emit();
  }

  // ---------- 连接处理 ----------

  private attach(ws: WebSocket): void {
    const session: ClientSession = { ws, helloed: false, upload: null };
    this.sessions.add(session);
    this.emit();

    ws.on('message', (data: RawData, isBinary: boolean) => {
      // handleMessage 是 async：这里必须吞掉 rejection，
      // 否则单条坏消息会变成 unhandledRejection 把主进程带崩
      void this.handleMessage(session, data, isBinary).catch((error: unknown) => {
        this.sendError(session, 'import-failed', (error as Error).message);
      });
    });

    ws.on('close', () => {
      session.upload = null;
      this.sessions.delete(session);
      this.emit();
    });

    // 必须有 error 监听：ws 在超帧、协议错时会 emit('error')，
    // 没监听会直接抛未捕获异常
    ws.on('error', () => {
      /* close 紧随其后，状态在那里收敛 */
    });
  }

  private async handleMessage(
    session: ClientSession,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      await this.handleChunk(session, toBuffer(data));
      return;
    }

    let message: BridgeClientMessage;
    try {
      message = JSON.parse(toBuffer(data).toString('utf8')) as BridgeClientMessage;
    } catch {
      this.sendError(session, 'bad-request', '消息不是合法 JSON');
      return;
    }

    switch (message.type) {
      case 'hello':
        this.handleHello(session, message);
        return;

      case 'list-requirements': {
        if (!this.requireHello(session)) return;
        const requirements = await listRequirements();
        this.send(session, { type: 'requirements', items: requirements.map(toBrief) });
        return;
      }

      case 'upload-begin': {
        if (!this.requireHello(session)) return;
        await this.handleUploadBegin(session, message);
        return;
      }

      case 'cancel': {
        session.upload = null;
        return;
      }

      default:
        this.sendError(session, 'bad-request', `不认识的指令：${String((message as { type?: string }).type)}`);
    }
  }

  private handleHello(
    session: ClientSession,
    message: Extract<BridgeClientMessage, { type: 'hello' }>,
  ): void {
    if (message.protocol !== BRIDGE_PROTOCOL_VERSION) {
      this.sendError(
        session,
        'protocol-mismatch',
        `协议版本不一致：插件为 v${message.protocol}，本应用为 v${BRIDGE_PROTOCOL_VERSION}。请更新插件后重试`,
      );
      session.ws.close(1008, 'protocol mismatch');
      return;
    }

    session.helloed = true;
    this.send(session, {
      type: 'welcome',
      protocol: BRIDGE_PROTOCOL_VERSION,
      app: 'UI 验收投屏',
      version: app.getVersion(),
      host: BRIDGE_HOST,
      port: this.port,
      maxUploadBytes: BRIDGE_MAX_UPLOAD_BYTES,
      chunkBytes: BRIDGE_CHUNK_BYTES,
    });
  }

  private async handleUploadBegin(
    session: ClientSession,
    message: Extract<BridgeClientMessage, { type: 'upload-begin' }>,
  ): Promise<void> {
    if (session.upload) {
      this.sendError(session, 'already-uploading', '当前连接已有上传在进行中');
      return;
    }
    if (this.busy) {
      this.sendError(session, 'busy', '本应用正在处理上一份上传，请稍后重试');
      return;
    }

    const { requirementId, fileName, byteLength, conflict } = message;

    if (conflict !== 'skip' && conflict !== 'replace') {
      this.sendError(session, 'bad-request', `不认识的冲突策略：${String(conflict)}`);
      return;
    }
    if (!Number.isInteger(byteLength) || byteLength <= 0) {
      this.sendError(session, 'bad-request', `上传字节数不合法：${String(byteLength)}`);
      return;
    }
    if (byteLength > BRIDGE_MAX_UPLOAD_BYTES) {
      this.sendError(
        session,
        'too-large',
        `导出包 ${(byteLength / 1024 / 1024).toFixed(1)}MB 超出上限 ${BRIDGE_MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
      );
      return;
    }

    // 先确认需求存在再让客户端上传，避免几 MB 白传
    const requirement = await getRequirement(requirementId);
    if (!requirement) {
      this.sendError(session, 'unknown-requirement', `需求不存在或已被删除：${requirementId}`);
      return;
    }

    session.upload = {
      requirementId,
      fileName: fileName || 'figma-export.zip',
      conflict,
      byteLength,
      received: 0,
      chunks: [],
    };

    this.send(session, { type: 'upload-ready', byteLength });
  }

  private async handleChunk(session: ClientSession, chunk: Buffer): Promise<void> {
    const upload = session.upload;
    if (!upload) {
      this.sendError(session, 'bad-request', '收到二进制数据，但没有进行中的上传');
      return;
    }

    upload.received += chunk.byteLength;
    if (upload.received > upload.byteLength) {
      session.upload = null;
      this.sendError(session, 'too-large', '收到的字节数超出声明值，已中止本次上传');
      return;
    }

    upload.chunks.push(chunk);
    if (upload.received < upload.byteLength) return;

    // 收满即落盘：byteLength 是权威值，不需要客户端再发结束信号
    session.upload = null;
    await this.finishUpload(session, upload);
  }

  private async finishUpload(session: ClientSession, upload: UploadState): Promise<void> {
    this.busy = true;
    this.emit();

    try {
      const bytes = Buffer.concat(upload.chunks, upload.byteLength);
      const result = await importFigmaPackageFromBytes(
        upload.requirementId,
        bytes,
        upload.fileName,
        upload.conflict,
      );

      const requirement = await getRequirement(upload.requirementId);
      const tally = { imported: 0, replaced: 0, skipped: 0, failed: 0 };
      for (const frame of result.frames) tally[frame.status] += 1;

      const last: BridgeLastImport = {
        requirementId: upload.requirementId,
        requirementName: requirement?.name ?? '',
        packageName: result.packageName || upload.fileName,
        importedAt: new Date().toISOString(),
        ...tally,
        fatal: result.fatal,
      };
      this.lastImport = last;

      this.send(session, {
        type: 'upload-result',
        ok: !result.fatal,
        requirementId: upload.requirementId,
        packageName: last.packageName,
        frames: result.frames.map(toFrameResult),
        fatal: result.fatal,
      });

      this.onEvent({ type: 'imported', last });
    } catch (error) {
      this.sendError(session, 'import-failed', (error as Error).message);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  // ---------- 工具 ----------

  private requireHello(session: ClientSession): boolean {
    if (session.helloed) return true;
    this.sendError(session, 'not-helloed', '请先发送 hello 完成协议协商');
    return false;
  }

  private send(session: ClientSession, message: BridgeServerMessage): void {
    if (session.ws.readyState !== session.ws.OPEN) return;
    session.ws.send(JSON.stringify(message));
  }

  private sendError(session: ClientSession, code: BridgeErrorCode, message: string): void {
    this.send(session, { type: 'error', code, message });
  }

  private emit(): void {
    this.onEvent({ type: 'status', status: this.status() });
  }
}
