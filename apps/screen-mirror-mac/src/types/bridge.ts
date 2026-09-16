/**
 * Figma 插件 → Mac 应用的直传通道协议（WebSocket over 回环地址）。
 *
 * ⚠️ **本文件与 `figma-plugin` 仓库的 `src/shared/bridge.ts` 必须逐字对齐。**
 * 两个仓库无法共享代码（插件跑在 Figma 沙箱里、本工程跑在 Electron 里），
 * 所以用 `BRIDGE_PROTOCOL_VERSION` 做握手校验兜底：版本不一致直接拒绝，
 * 而不是让"插件升级了、Mac 应用没升级"用半懂的消息把数据写坏。
 * 改协议时**先改版本号**，两端一起改。
 *
 * 为什么是 WebSocket 而不是 HTTP：
 * 插件 UI 是个 sandboxed iframe，origin 为 `null`，打 HTTP 会带上 `Origin: null`，
 * 得专门配 `Access-Control-Allow-Origin: *` 与 OPTIONS 预检，配错还是静默失败；
 * WebSocket 不参与 CORS 那一套，本机「插件 ↔ 桌面进程」这个场景下更稳。
 */

/** 协议版本：任一端不匹配即拒绝握手 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * 只绑回环地址，绝不绑 0.0.0.0（否则同局域网任何人都能推设计稿）。
 *
 * ⚠️ 插件侧**不要用这个字面量**去连：Figma 的 `networkAccess.allowedDomains` 只接受主机名，
 * 写 `ws://127.0.0.1:23457` 会让插件直接加载失败（`must be a valid URL`）。
 * 插件统一连 `ws://localhost:23457`；`localhost` 解析出 `[::1, 127.0.0.1]`，
 * `::1` 立即 ECONNREFUSED 后回退到 IPv4 回环 —— 所以这里只绑 IPv4 就够，不需要双栈监听。
 */
export const BRIDGE_HOST = '127.0.0.1';

/** 固定端口：插件 manifest 的 allowedDomains 必须写死具体端口 */
export const BRIDGE_DEFAULT_PORT = 23457;

/** 单次上传体积上限，防内存打爆 */
export const BRIDGE_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 单帧上限：客户端按块发，服务端逐块收，避免一整发大帧直接分配上百 MB */
export const BRIDGE_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** 插件端建议的分片大小 */
export const BRIDGE_CHUNK_BYTES = 1024 * 1024;

/** 需求列表项：只给插件够用的字段，不外泄节点表与截图路径 */
export interface BridgeRequirementBrief {
  id: string;
  name: string;
  designCount: number;
  appCount: number;
  pairCount: number;
  updatedAt: string;
}

/** 重复 frame 的处理策略，与本地导入共用同一套语义 */
export type BridgeConflictPolicy = 'skip' | 'replace';

/** 客户端（插件）→ 服务端（Mac 应用） */
export type BridgeClientMessage =
  | { type: 'hello'; protocol: number; plugin?: { name?: string; version?: string } }
  | { type: 'list-requirements' }
  | {
      type: 'upload-begin';
      requirementId: string;
      fileName: string;
      byteLength: number;
      conflict: BridgeConflictPolicy;
    }
  | { type: 'cancel' };

/**
 * 服务端（Mac 应用）→ 客户端（插件）。
 *
 * 注意**没有** `upload-end`：字节数由 `upload-begin.byteLength` 权威给定，
 * 服务端收满即自动落盘导入。少一个状态就少一类"客户端提前说结束"的边界。
 */
export type BridgeServerMessage =
  | {
      type: 'welcome';
      protocol: number;
      app: string;
      version: string;
      host: string;
      port: number;
      maxUploadBytes: number;
      chunkBytes: number;
    }
  | { type: 'error'; code: BridgeErrorCode; message: string }
  | { type: 'requirements'; items: BridgeRequirementBrief[] }
  | { type: 'upload-ready'; byteLength: number }
  | {
      type: 'upload-result';
      ok: boolean;
      requirementId: string;
      packageName: string;
      /** 单帧导入结果；整包被拒时为空数组 */
      frames: BridgeFrameResult[];
      /** 整包级致命错误（此时**未写入任何数据**） */
      fatal?: string;
    };

export type BridgeErrorCode =
  | 'protocol-mismatch'
  | 'origin-rejected'
  | 'bad-request'
  | 'too-large'
  | 'unknown-requirement'
  | 'busy'
  | 'already-uploading'
  | 'not-helloed'
  | 'import-failed';

/** 单帧导入结果：与本地导入的 ImportFrameResult 同构，独立声明避免两个仓库互相依赖 */
export interface BridgeFrameResult {
  frameId: string;
  name: string;
  nodeCount: number;
  width: number;
  height: number;
  status: 'imported' | 'skipped' | 'replaced' | 'failed';
  isFrameLevel: boolean;
  reason?: string;
}

// ---------- 渲染层可见的状态 ----------

export interface BridgeStatus {
  /** 服务是否在监听 */
  running: boolean;
  host: string;
  port: number;
  /** 当前已建立连接的客户端数（正常是 0 或 1） */
  clients: number;
  /** 是否有上传正在处理中 */
  busy: boolean;
  /** 被 Origin 白名单拒掉的连接次数，用于排查"插件连不上" */
  rejected: number;
  /** 最近一次成功接收的摘要 */
  lastImport?: BridgeLastImport;
}

export interface BridgeLastImport {
  requirementId: string;
  requirementName: string;
  packageName: string;
  importedAt: string;
  imported: number;
  replaced: number;
  skipped: number;
  failed: number;
  fatal?: string;
}

/** 主进程 → 渲染层的推送事件（渲染层据此刷新需求列表与工作台） */
export type BridgeEvent =
  | { type: 'status'; status: BridgeStatus }
  | { type: 'imported'; last: BridgeLastImport };
