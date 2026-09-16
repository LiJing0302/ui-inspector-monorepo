/**
 * 节点 + 截图接收器（Android SDK → Mac，局域网上传）。
 *
 * 与它替换掉的 `NodeIngestServer` 相比，只有一处关键区别：**凭据不再是每次采集新生成的**。
 *
 * 旧模型是「Mac 点采集 → 现场生成 endpoint/token/captureId → 想办法把三个值送到手机上 →
 * 15 秒内上传完」。手机与 Mac 之间没有可靠通道，于是那三个值只能靠人抄 ——
 * 而抄写要时间，等待窗口又只有十几秒，实际用起来基本必失败。
 *
 * 现在的模型是：**密钥落盘、只生成一次**；手机上配对一次，之后每个页面点一下悬浮按钮就走。
 * 每次上传唯一新生成的是 captureId，由 App 自己生成，Mac 只把它当作日志关联标识。
 *
 * 归属问题（这份快照算哪个需求的）用「靶」解决：渲染层在某个需求页点「开始接收」时
 * 把这个需求 arm 起来，接下来的一份上传就落到它头上。没有靶时**拒收**而不是随便找个需求放 ——
 * 快照放错需求比没采到更难发现。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { readJsonSafe, writeJsonAtomic } from '../store/atomic';
import { acceptanceReceiverPath } from '../store/paths';
import {
  decodeScreenshot,
  validateSdkSnapshotEnvelope,
  type AcceptanceArmState,
  type AcceptanceReceiverInfo,
  type AcceptanceSnapshotEnvelope,
  type ArmAcceptanceTargetInput,
  type CollectionQuality,
  type SdkSnapshotAccepted,
  type SdkSnapshotPayload,
} from '../../types/acceptance';

const DEFAULT_PORT = 23458;
/** 请求体上限：节点树 + 截图（base64 后约 4/3 体积）。截图本身已单独限到 24MB。 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_NODE_COUNT = 30000;

const DEFAULT_ARM_TTL_MS = 3 * 60 * 1000;
/** 下限压到 5 秒：调用方（含测试）需要能构造出「靶已过期」这一状态。 */
const MIN_ARM_TTL_MS = 5 * 1000;
const MAX_ARM_TTL_MS = 60 * 60 * 1000;

const RECEIVER_FILE_VERSION = 1;

/** 带状态码的失败。让每条拒绝路径都能给出**语义化**的状态码，而不是一律 400。 */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface StoredReceiver {
  version: number;
  token: string;
  createdAt: string;
}

export interface AcceptanceUploadStatus {
  state: 'idle' | 'armed' | 'received';
  arm: AcceptanceArmState | null;
  receivedCaptureId?: string;
  receivedNodeCount?: number;
}

/**
 * 一次成功接收的上传。
 *
 * 顺带把**已解码的截图字节**带出去：接收器为了校验已经解过一次 base64，
 * 调用方再解一次等于对同一张几 MB 的图做两遍同样的工作。
 */
export interface AcceptanceUpload {
  envelope: AcceptanceSnapshotEnvelope;
  screenshot: Uint8Array;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function getHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const length = Number(getHeader(request, 'content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new HttpError(413, 'SDK 上传超过 64MB 限制');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'SDK 上传超过 64MB 限制');
    chunks.push(buffer);
  }
  if (total === 0) throw new HttpError(400, 'SDK 上传为空');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'SDK 上传不是合法 JSON');
  }
}

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided || expected.length === 0) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateCollection(collection: CollectionQuality, nodeCount: number): void {
  if (collection.profile !== 'acceptance-full') {
    // 轻量档（Overlay / 录制）的树字段有退化：没有隐藏节点、没有文本、深度只到 64。
    // 放它进来会被读成「App 没这个节点」—— 这是假阴性，在验收里比漏报更危险，
    // 所以在上传边界就拒掉，让调用方立刻发现档位传错了。
    throw new HttpError(400, `SDK 采集档位必须是 acceptance-full，收到：${String(collection.profile)}`);
  }
  if (collection.actualNodeCount !== nodeCount) {
    throw new HttpError(400, 'SDK collection.actualNodeCount 与 nodes.length 不一致');
  }
  if (collection.requestedMaxDepth > 128 || collection.requestedMaxNodes > MAX_NODE_COUNT) {
    throw new HttpError(400, 'SDK 采集上限超过协议允许范围');
  }
  if (collection.depthLimitReached || collection.nodeLimitReached) {
    throw new HttpError(400, 'SDK 节点树已被采集上限截断，不能作为 AI 验收输入');
  }
}

function validateTree(snapshot: SdkSnapshotPayload): void {
  if (snapshot.nodeCount !== snapshot.nodes.length) {
    throw new HttpError(400, 'SDK snapshot.nodeCount 与 nodes.length 不一致');
  }
  if (snapshot.nodes.length > MAX_NODE_COUNT) {
    throw new HttpError(400, 'SDK 节点数量超过 30000');
  }
  if (!Number.isFinite(snapshot.windowWidth) || !Number.isFinite(snapshot.windowHeight)) {
    throw new HttpError(400, 'SDK 窗口尺寸无效');
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  const parentOf = new Map<string, string | null>();
  for (const node of snapshot.nodes) {
    const path = node.treePath || '';
    if (!path || paths.has(path)) throw new HttpError(400, 'SDK treePath 缺失或重复');
    paths.add(path);
    ids.add(node.nodeId);
    parentOf.set(node.nodeId, node.parentId);
    if (!Number.isInteger(node.depth) || node.depth < 0) {
      throw new HttpError(400, `SDK 节点 ${node.nodeId} depth 无效`);
    }
    if (node.width < 0 || node.height < 0) {
      throw new HttpError(400, `SDK 节点 ${node.nodeId} 尺寸无效`);
    }
  }

  for (const node of snapshot.nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) {
      throw new HttpError(400, `SDK 节点 ${node.nodeId} 的 parentId 不存在`);
    }
    const visited = new Set<string>();
    let current: string | null = node.nodeId;
    while (current !== null) {
      if (visited.has(current)) throw new HttpError(400, `SDK 节点 ${node.nodeId} 存在父子循环`);
      visited.add(current);
      current = parentOf.get(current) ?? null;
    }
  }
}

export class AcceptanceReceiver {
  private server: Server | null = null;
  private port = DEFAULT_PORT;
  private token = '';
  private tokenCreatedAt = '';
  private arm: { requirementId: string; expiresAt: number } | null = null;
  private armTimer: NodeJS.Timeout | null = null;
  private received: AcceptanceSnapshotEnvelope | null = null;
  private waiter: ((value: AcceptanceUpload) => void) | null = null;
  private waiterReject: ((reason: Error) => void) | null = null;

  async start(port = DEFAULT_PORT): Promise<void> {
    if (this.server) return;
    await this.ensureToken();

    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 400;
        if (!response.headersSent) writeJson(response, status, { error: (error as Error).message });
        else response.end();
      });
    });

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
      server.listen(port, '0.0.0.0');
    });

    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : port;
    this.server = server;
  }

  async stop(): Promise<void> {
    this.clearArm();
    this.received = null;
    this.waiterReject?.(new Error('节点接收服务已停止'));
    this.waiter = null;
    this.waiterReject = null;

    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * 读取（首次则生成）长期密钥。
   *
   * 读不到就当首次运行生成一份 —— 但**写失败不能拦住接收服务**：
   * 不能因为磁盘只读就让整个验收功能不可用；此时密钥退化为「本次进程内有效」。
   */
  async ensureToken(): Promise<void> {
    const stored = await readJsonSafe<StoredReceiver>(acceptanceReceiverPath());
    if (stored && typeof stored.token === 'string' && stored.token.length >= 32) {
      this.token = stored.token;
      this.tokenCreatedAt = stored.createdAt || new Date().toISOString();
      return;
    }

    this.token = randomBytes(32).toString('hex');
    this.tokenCreatedAt = new Date().toISOString();
    const next: StoredReceiver = {
      version: RECEIVER_FILE_VERSION,
      token: this.token,
      createdAt: this.tokenCreatedAt,
    };
    await writeJsonAtomic(acceptanceReceiverPath(), next).catch((error: unknown) => {
      console.warn('[acceptance] 接收器密钥落盘失败，本次运行使用临时密钥：', (error as Error).message);
    });
  }

  info(): AcceptanceReceiverInfo {
    return {
      port: this.port,
      token: this.token,
      createdAt: this.tokenCreatedAt,
      arm: this.currentArm(),
    };
  }

  status(): AcceptanceUploadStatus {
    return {
      state: this.received ? 'received' : this.arm ? 'armed' : 'idle',
      arm: this.currentArm(),
      receivedCaptureId: this.received?.captureId,
      receivedNodeCount: this.received?.snapshot.nodes.length,
    };
  }

  /**
   * 建立接收靶并等待一份上传。
   *
   * 靶与等待是**同一次调用**：两者分开会出现「已 arm 但没人接」的中间态，
   * 那种状态下上传会被接受、却没有任何人去落盘 —— 数据静默丢失。
   */
  waitForUpload(input: ArmAcceptanceTargetInput, timeoutMs?: number): Promise<AcceptanceUpload> {
    if (!this.server) return Promise.reject(new Error('节点接收服务尚未启动'));
    if (!input.requirementId) return Promise.reject(new Error('接收靶必须指定需求'));
    if (this.waiter) return Promise.reject(new Error('已有一份接收等待在进行中'));

    const ttl = Math.min(Math.max(input.ttlMs ?? timeoutMs ?? DEFAULT_ARM_TTL_MS, MIN_ARM_TTL_MS), MAX_ARM_TTL_MS);
    this.received = null;
    this.setArm(input.requirementId, ttl);

    return new Promise<AcceptanceUpload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.waiterReject = null;
        this.clearArm();
        reject(new Error(`等待手机上传超时（${Math.round(ttl / 1000)} 秒）。请在 App 里点悬浮按钮上传。`));
      }, ttl);

      this.waiter = (value) => {
        clearTimeout(timer);
        this.waiter = null;
        this.waiterReject = null;
        resolve(value);
      };
      this.waiterReject = (reason) => {
        clearTimeout(timer);
        this.waiter = null;
        this.waiterReject = null;
        reject(reason);
      };
    });
  }

  /** 用户取消等待：靶一并撤销，避免「取消之后又收到一份」被静默落盘。 */
  cancelWait(reason = '已取消接收'): void {
    this.clearArm();
    const reject = this.waiterReject;
    this.waiter = null;
    this.waiterReject = null;
    reject?.(new Error(reason));
  }

  private currentArm(): AcceptanceArmState | null {
    if (!this.arm) return null;
    if (Date.now() >= this.arm.expiresAt) return null;
    return { requirementId: this.arm.requirementId, expiresAt: new Date(this.arm.expiresAt).toISOString() };
  }

  private setArm(requirementId: string, ttlMs: number): void {
    this.clearArm();
    const expiresAt = Date.now() + ttlMs;
    this.arm = { requirementId, expiresAt };
    this.armTimer = setTimeout(() => this.clearArm(), ttlMs);
  }

  private clearArm(): void {
    if (this.armTimer) clearTimeout(this.armTimer);
    this.armTimer = null;
    this.arm = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method || 'GET';
    const url = new URL(request.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/v1/acceptance/ping') {
      if (method !== 'GET') throw new HttpError(405, 'ping 只支持 GET');
      this.assertToken(request);
      writeJson(response, 200, {
        ok: true,
        name: 'UI 验收投屏',
        port: this.port,
        armed: this.currentArm() !== null,
      });
      return;
    }

    if (path === '/v1/acceptance/upload') {
      if (method !== 'POST') throw new HttpError(405, '上传只支持 POST');
      await this.handleUpload(request, response);
      return;
    }

    throw new HttpError(404, '接收路径不存在');
  }

  private assertToken(request: IncomingMessage): void {
    const authorization = getHeader(request, 'authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!tokenMatches(this.token, token)) {
      throw new HttpError(401, '接收器密钥无效');
    }
  }

  private async handleUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 顺序刻意如此：先验身份，再看靶，最后才读 body。
    // 反过来会出现「攻击者用超大 body 逼服务端先分配 64MB」的路径。
    this.assertToken(request);

    const arm = this.currentArm();
    if (!arm) {
      throw new HttpError(409, 'Mac 侧没有正在等待接收的需求，请先在验收页点「开始接收」');
    }

    const envelope = validateSdkSnapshotEnvelope(await readBody(request));
    validateCollection(envelope.snapshot.collection, envelope.snapshot.nodes.length);
    validateTree(envelope.snapshot);
    const screenshot = decodeScreenshot(envelope.screenshot);

    this.received = envelope;
    // 靶是一次性的：落盘成功后必须手动重新 arm，否则连点两下会把同一个需求写进两份快照。
    this.clearArm();

    const result: SdkSnapshotAccepted = {
      accepted: true,
      captureId: envelope.captureId,
      nodeCount: envelope.snapshot.nodes.length,
      screenshotBytes: screenshot.byteLength,
      serverTimestamp: Date.now(),
    };
    writeJson(response, 200, result);

    // 先回响应再唤醒等待方：落盘可能要读几 MB 的图，
    // 让手机先拿到 200 再慢慢等 Mac 处理，免得 SDK 侧的超时先炸。
    this.waiter?.({ envelope, screenshot });
  }
}

export { DEFAULT_PORT as ACCEPTANCE_RECEIVER_PORT };
