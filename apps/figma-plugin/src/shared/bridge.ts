/**
 * 「直传到 Mac 应用」通道的线协议。
 *
 * ⚠️ **本文件与 screen-mirror-mac 仓库的 `electron/src/types/bridge.ts` 必须逐字对齐。**
 * 两个工程互不依赖（一个跑在 Figma 沙箱/iframe 里，一个跑在 Electron 里），
 * 所以用 `BRIDGE_PROTOCOL_VERSION` 做握手校验兜底：版本不一致时 Mac 端会明确拒绝并
 * 提示「请更新插件」，而不是用半懂的消息把数据写坏。**改协议先改版本号，两端一起改。**

 * 通道形态：`ws://localhost:23457`，JSON 文本帧传控制消息、二进制帧传 zip 内容。
 * ⚠️ **必须写 `localhost`，不能写 `127.0.0.1`**：manifest 的 `allowedDomains` 只接受主机名，
 * 裸 IP 会被 Figma 判为非法 URL 并让插件加载失败。`localhost` 会回退到 IPv4 回环，所以 Mac 端
 * 只绑 `127.0.0.1` 也能连上。
 * 为什么不走 HTTP：插件 UI 是 sandboxed iframe（origin 为 `null`），
 * 打 HTTP 需要专门处理 `Access-Control-Allow-Origin` 与 OPTIONS 预检，
 * 配错还是静默失败；WebSocket 不参与 CORS 那一套。
 */

/** 协议版本：与 Mac 端不一致会被拒绝握手 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** 固定端口：manifest.json 的 allowedDomains 必须写死具体端口，改端口要同步改 manifest */
export const BRIDGE_DEFAULT_PORT = 23457;

/** 分片大小缺省值（服务端 welcome 里会回真实值） */
export const BRIDGE_CHUNK_BYTES = 1024 * 1024;

/** 每个帧的导入结果，与 Mac 端同构 */
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

export interface BridgeRequirementBrief {
  id: string;
  name: string;
  designCount: number;
  appCount: number;
  pairCount: number;
  updatedAt: string;
}

export type BridgeConflictPolicy = 'skip' | 'replace';

export interface BridgeWelcome {
  protocol: number;
  app: string;
  version: string;
  host: string;
  port: number;
  maxUploadBytes: number;
  chunkBytes: number;
}

export interface BridgeUploadResult {
  ok: boolean;
  requirementId: string;
  packageName: string;
  frames: BridgeFrameResult[];
  fatal?: string;
}

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
 * 注意**没有** `upload-end`：字节总数由 `upload-begin.byteLength` 权威给定，
 * Mac 端收满即自动落盘导入。
 */
export type BridgeServerMessage =
  | ({ type: 'welcome' } & BridgeWelcome)
  | { type: 'error'; code: BridgeErrorCode; message: string }
  | { type: 'requirements'; items: BridgeRequirementBrief[] }
  | { type: 'upload-ready'; byteLength: number }
  | ({ type: 'upload-result' } & BridgeUploadResult);
