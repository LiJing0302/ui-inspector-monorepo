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
 * 归属问题（这份快照算哪个需求的）用「靶」解决。靶有两条来路：
 *  - **常驻靶**（默认）：验收页打开某个需求即向接收器登记（`setStandbyTarget`），接收器自己
 *    续期、一直等着，收到也不撤销 —— 手机上点上传的人不必先让 Mac 这边点一下按钮；
 *  - **手动靶**：`waitForUpload` 立靶后等一份，拿到即收工（留给程序化调用与测试）。
 * 两条路都要求落点是**一个具体的需求**；没有靶时**拒收**而不是随便找个需求放 ——
 * 快照放错需求比没采到更难发现。
 *
 * ④ 密钥不是必填的（2026-09-24）：**来自局域网私有地址的请求一律放行**，见
 * `isLanClientAddress`。原先手机端必须粘一整行 `smacceptance://ip:port?token=<64 位 hex>`，
 * 而这一行里只有 IP 是用户能自己看出来的东西，另外两个字段都得靠「别抄错」。
 * 现在 App 里只填 Mac 的局域网地址即可。
 *
 * ⚠️ 真正拦人的一直是**靶**，而靶的时效窗口在同期被放大了：从「点一次开始接收、3 分钟、
 * 一次即消耗」变成「Mac 上开着某个需求的那段时间」（常驻续期）。免密钥与常驻靶叠加之后，
 * **同一局域网内知道地址的机器可以在那个窗口里塞一份快照**进去。后果限于脏数据
 * （`requirementId` 取自靶、不取自请求体，没有路径穿越，也不执行任何代码），
 * 而跨网段的来源仍然必须带密钥。
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

/**
 * 常驻靶的续期间隔与单次有效期。
 *
 * 常驻靶复用同一套 `arm` 字段，只是**由接收器自己不断续期**，于是对外表现为「一直在等」。
 * 有效期给 3 分钟、每 60 秒续一次：留 2 分钟余量，即便某次续期被事件循环拖慢也不会掉靶。
 */
const STANDBY_RENEW_MS = 60 * 1000;
const STANDBY_ARM_TTL_MS = 3 * 60 * 1000;

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

/**
 * 常驻等待时收到的一份上传：除了内容本身，还得带上**它该落到哪个需求**。
 *
 * 手动接收（`waitForUpload`）不需要这个字段 —— 那个需求是调用方自己传进来的；
 * 常驻等待没有调用方在等，落点只能由接收器随上传一起交出去。
 */
export interface AcceptanceReceivedUpload extends AcceptanceUpload {
  requirementId: string;
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

/** 取出对端地址，并把 IPv4-mapped IPv6（`::ffff:192.168.1.5`）折成 IPv4 形态。 */
function peerAddress(request: IncomingMessage): string {
  const raw = (request.socket.remoteAddress || '').trim().toLowerCase();
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = peerAddress(request);
  return address === '::1' || address.startsWith('127.');
}

/**
 * 「局域网客户端的来源」判定 —— 免密钥放行的**唯一**依据（纯函数，便于离线用例）。
 *
 * 只管一件事：这个来源地址是不是同一局域网里的私有地址。
 *
 * ⚠️ 回环**不算**局域网来源。理由不是「本机更不被信任」，而是场景不同：回环请求来自
 * Mac 自己的进程（USB 通道经 adb reverse 打到 127.0.0.1，凭据由 `usb-config` 自动下发），
 * 它根本没有「用户手填一个地址」的处境，不需要豁免。
 *
 * 覆盖：10/8、172.16/12（含 iPhone 热点的 172.20.10.x）、192.168/16、169.254/16（链路本地），
 * 以及 IPv6 的 ULA `fc00::/7` 与链路本地 `fe80::/10`。
 */
export function isLanClientAddress(remoteAddress: string | undefined): boolean {
  const raw = (remoteAddress || '').trim().toLowerCase();
  if (!raw) return false;
  const address = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  if (address === '::1' || address.startsWith('127.')) return false;
  if (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    address.startsWith('169.254.')
  ) {
    return true;
  }
  const second = /^172\.(\d{1,3})\./.exec(address);
  if (second) {
    const octet = Number(second[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  return /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
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
  /** 常驻靶：界面开着某个需求时，接收器**一直**等着它的下一份上传。null 表示没开。 */
  private standby: string | null = null;
  private standbyTimer: NodeJS.Timeout | null = null;

  /**
   * 收到一份上传、且**没有等待方**时调用。
   *
   * 走这条路的是「常驻等待」：手机点上传时 Mac 侧没有任何人在 `await`，落盘只能由
   * 这里接住。手动接收仍然走 `waitForUpload` 的返回值，两条路不会同时拿到同一份 ——
   * 见 `handleUpload` 里的分发。
   */
  onReceived: ((upload: AcceptanceReceivedUpload) => void) | null = null;

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
    this.setStandbyTarget(null);
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
   * 常驻靶：把「接下来所有的上传」都绑到某个需求上，**收到之后不撤销**。
   *
   * 与 `waitForUpload` 的差别只在「谁在等」：
   *  - 那条路是「先立靶、再等一份、拿到就收工」，靶与一次等待同生命周期（手动接收）；
   *  - 这条路是「界面开着某个需求，就一直等着它的下一份上传」—— 手机上点上传的人
   *    不必先让 Mac 这边的人点一下按钮。
   *
   * 靶仍复用 `arm` 字段、仍按 TTL 过期，只是由接收器**自己续期**（每 60 秒一次），
   * 于是对外表现为「一直在等」。传 null（离开需求页）即撤销常驻。
   *
   * ⚠️ 落点仍必须是**一个具体的需求**：常驻等待不等于「随便找个需求放」。
   * 没打开任何需求时传 null，上传会被照旧拒掉（409）—— 快照放错需求比没采到更难发现。
   */
  setStandbyTarget(requirementId: string | null): AcceptanceReceiverInfo {
    const next = (requirementId ?? '').trim() || null;
    if (next === this.standby) return this.info();

    this.stopStandby();
    this.standby = next;
    if (next) {
      this.renewStandby();
      this.standbyTimer = setInterval(() => this.renewStandby(), STANDBY_RENEW_MS);
      // 不拴住事件循环：冒烟套件跑完就该退出，不能被这个续期定时器吊着。
      this.standbyTimer.unref?.();
    }
    return this.info();
  }

  /** 当前常驻等待的需求 id；null 表示没开。给测试与排错用。 */
  standbyTarget(): string | null {
    return this.standby;
  }

  private renewStandby(): void {
    if (!this.standby) return;
    this.setArm(this.standby, STANDBY_ARM_TTL_MS);
  }

  private stopStandby(): void {
    if (this.standbyTimer) clearInterval(this.standbyTimer);
    this.standbyTimer = null;
    const previous = this.standby;
    this.standby = null;

    // 撤掉常驻时**必须连它立的靶一起撤**：靶的有效期是 3 分钟，只停止续期的话，
    // 离开需求页之后的这几分钟里手机传上来仍会被接住、落到一个已经没人看的需求上 ——
    // 而「放错需求」比「没收下」更难发现，正是靶存在要防的那件事。
    //
    // 只在靶确实指向常驻需求时才撤：手动等待（`waitForUpload`）立的靶不能被动掉，
    // 否则那条路上的上传会变成 409。
    if (previous && this.arm?.requirementId === previous) this.clearArm();
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
      const auth = this.authorize(request);
      writeJson(response, 200, {
        ok: true,
        name: 'UI 验收投屏',
        port: this.port,
        armed: this.currentArm() !== null,
        /** 这次是靠密钥进来的（token），还是因为来源在局域网里（lan）。排查「配上了吗」用得上。 */
        auth,
      });
      return;
    }

    if (path === '/v1/acceptance/usb-config') {
      if (method !== 'GET') throw new HttpError(405, 'USB 配置只支持 GET');
      // 这条**会下发长期密钥**，所以只能回环 —— 局域网那侧不再需要它（见 isLanClientAddress）。
      if (!isLoopbackRequest(request)) {
        throw new HttpError(403, 'USB 配置只允许通过本机回环通道读取');
      }
      writeJson(response, 200, {
        ok: true,
        host: '127.0.0.1',
        port: this.port,
        token: this.token,
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

  /**
   * 放行判定（ping 与 upload 共用）：**先认密钥，再认局域网来源**。
   *
   * 密钥仍然算数（跨网段、显式配置过密钥的客户端照旧走它），但不再是唯一入口 ——
   * 来自局域网私有地址的请求一律放行，让手机端只需填一个地址。见 `isLanClientAddress`。
   *
   * 返回值就是这次靠什么进来的，ping 会把它回给调用方。
   */
  private authorize(request: IncomingMessage): 'token' | 'lan' {
    const authorization = getHeader(request, 'authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (tokenMatches(this.token, token)) return 'token';
    if (isLanClientAddress(request.socket.remoteAddress)) return 'lan';
    throw new HttpError(
      401,
      '接收器密钥无效，且请求来源不是局域网私有地址。请确认手机与 Mac 在同一局域网，' +
        '或从 Mac 验收页复制连接串（带密钥）再试。',
    );
  }

  private async handleUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 顺序刻意如此：先做放行判定，再看靶，最后才读 body。
    // 反过来会出现「攻击者用超大 body 逼服务端先分配 64MB」的路径。
    this.authorize(request);

    const arm = this.currentArm();
    if (!arm) {
      throw new HttpError(
        409,
        'Mac 验收页当前没有打开任何需求，这一份没有落点，已拒收。请在 Mac 上打开一个需求再传。',
      );
    }

    const envelope = validateSdkSnapshotEnvelope(await readBody(request));
    validateCollection(envelope.snapshot.collection, envelope.snapshot.nodes.length);
    validateTree(envelope.snapshot);
    const screenshot = decodeScreenshot(envelope.screenshot);

    this.received = envelope;
    // 手动接收的靶是一次性的：落盘成功后必须重新 arm，否则连点两下会把同一个需求写进两份快照。
    // 常驻靶恰恰相反 —— 撤销了就漏掉紧接着的第二份，所以原地续期、继续等。
    if (this.standby) this.renewStandby();
    else this.clearArm();

    const result: SdkSnapshotAccepted = {
      accepted: true,
      captureId: envelope.captureId,
      nodeCount: envelope.snapshot.nodes.length,
      screenshotBytes: screenshot.byteLength,
      serverTimestamp: Date.now(),
    };
    writeJson(response, 200, result);

    // 先回响应再把数据交出去：落盘可能要读几 MB 的图，
    // 让手机先拿到 200 再慢慢等 Mac 处理，免得 SDK 侧的超时先炸。
    //
    // 一份上传只交给**一个**消费者：有等待方（手动接收）就唤醒它，没有才交给常驻监听
    // （界面开着某个需求在等）。两边都收到的话，同一份快照会被落盘两次。
    if (this.waiter) this.waiter({ envelope, screenshot });
    else this.onReceived?.({ requirementId: arm.requirementId, envelope, screenshot });
  }
}

export { DEFAULT_PORT as ACCEPTANCE_RECEIVER_PORT };
