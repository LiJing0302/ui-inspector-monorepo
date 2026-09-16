/**
 * 主进程 ↔ 渲染层 IPC 契约
 *
 * 这是全量 TS 化的地基：主进程 main/ 与渲染层 renderer/ 共用同一份类型，
 * 任何一端改签名都会在开发期暴露，不会再出现「改了 handler 忘了改调用方」。
 */

import type {
  AppNode,
  DesignNode,
  Issue,
  IssueCategory,
  IssueSeverity,
  MatchPairMeta,
  RequirementMeta,
  SideData,
} from './verify';
import type { BridgeEvent, BridgeStatus } from './bridge';
import type {
  AcceptanceReceiverInfo,
  CollectionQuality,
} from './acceptance';
import type {
  AcceptanceReadiness,
  AcceptanceRunMeta,
  NodeMapping,
  RunAcceptanceInput,
  SaveNodeMappingInput,
} from './aiAcceptance';

/**
 * 领域类型转出去，让 preload / 渲染层只从「IPC 契约」这一个模块取类型，
 * 不用同时记住 verify.ts 的存在。
 */
export type {
  AppNode,
  DesignNode,
  Issue,
  IssueCategory,
  IssueSeverity,
  MatchPairMeta,
  RequirementMeta,
  SideData,
};
export type { AcceptanceArmState, AcceptanceReceiverInfo, CollectionQuality } from './acceptance';
export type {
  AcceptanceReadiness,
  AcceptanceRunMeta,
  NodeMapping,
  RunAcceptanceInput,
  SaveNodeMappingInput,
} from './aiAcceptance';

/** Figma 插件直传通道的类型（协议细节在 bridge.ts，这里只是转出给渲染层用） */
export type {
  BridgeEvent,
  BridgeLastImport,
  BridgeRequirementBrief,
  BridgeStatus,
} from './bridge';

// ---------- 信号源 ----------

export type MirrorSource = 'iphone' | 'android';

export interface StartSourceOptions {
  source: MirrorSource;
  iphoneAddress?: string;
  androidSerial?: string;
}

/** iPhone 启动成功后返回给渲染层的会话信息（用于 LiveKit 订阅） */
export interface IPhoneSession {
  url: string;
  token: string;
  pairingAddress: string;
  pairingCode: string;
}

/** 网卡列表项 */
export interface NetworkAddress {
  name: string;
  address: string;
}

// ---------- Android 反向控制 ----------

export type AndroidControlType = 'touch' | 'scroll' | 'key' | 'text';

export interface AndroidControlCommand {
  type: AndroidControlType;
  // touch / scroll
  action?: number;
  pointerX?: number;
  pointerY?: number;
  buttons?: number;
  pressure?: number;
  // scroll
  scrollX?: number;
  scrollY?: number;
  // key
  keyCode?: number;
  repeat?: number;
  metaState?: number;
  // text
  text?: string;
  // 归一化基准，缺省用运行时记录的视频尺寸
  videoWidth?: number;
  videoHeight?: number;
}

// ---------- 视频包（Android / scrcpy） ----------

/** 会话包：设备分辨率（可能随旋屏变化） */
export interface ScrcpySessionPacket {
  type: 'session';
  isClientResize?: boolean;
  width: number;
  height: number;
}

/** 配置包：含 SPS/PPS，解码器据此初始化 */
export interface ScrcpyConfigurationPacket {
  type: 'configuration';
  data: Uint8Array;
}

/** 数据包：一帧 H.264 */
export interface ScrcpyDataPacket {
  type: 'data';
  keyframe?: boolean;
  pts?: string;
  /** Uint8Array 经 IPC 结构化克隆后仍是 Uint8Array */
  data: Uint8Array;
}

/**
 * 可辨识联合：用 type 字面量而非 string，
 * 这样渲染层 `if (packet.type === 'session')` 能真正收窄出 width/height。
 */
export type VideoPacket = ScrcpySessionPacket | ScrcpyConfigurationPacket | ScrcpyDataPacket;

export interface InspectorPickPoint {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InspectorEvent =
  | { type: 'runtime-ready'; session: { sessionId: string; appId: string; projectRootHash?: string } }
  | { type: 'node-picked'; requestId: string; nodes: unknown[] }
  | { type: 'highlight-result'; requestId: string; resolution: unknown }
  | { type: 'error'; requestId?: string; code: string; message: string };

export interface InspectorApi {
  status(): Promise<{ running: boolean; runtimeConnected: boolean; editorConnected: boolean }>;
  pick(point: InspectorPickPoint): Promise<void>;
  clear(): Promise<void>;
  onEvent(cb: (event: InspectorEvent) => void): () => void;
}

// ---------- 事件（主进程 → 渲染层） ----------

export type StatusPayload = string;
export type H264Payload = Uint8Array;

// ---------- 验收工作流 ----------

/** 单帧导入结果 */
export interface ImportFrameResult {
  frameId: string;
  name: string;
  nodeCount: number;
  width: number;
  height: number;
  status: 'imported' | 'skipped' | 'replaced' | 'failed';
  isFrameLevel: boolean;
  reason?: string;
}

export interface ImportResult {
  packageName: string;
  sourcePath: string;
  frames: ImportFrameResult[];
  /** 整包级致命错误（此时 frames 为空，且**未写入任何数据**） */
  fatal?: string;
}

/** 重复导入同一 frame 时的处理策略 */
export type ConflictPolicy = 'skip' | 'replace';

export interface AndroidDeviceInfo {
  serial: string;
  model?: string;
  state?: string;
}

export interface AndroidCaptureResult {
  snapshotId: string;
  captureId: string;
  source: 'sdk';
  nodeCount: number;
  /** 逻辑尺寸（dp） */
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  densityDpi: number;
  collection: CollectionQuality;
  packageName?: string;
  deviceModel?: string;
  /** 非致命告警，例如 SDK 窗口尺寸与截图不一致 */
  warning?: string;
}

/**
 * 「开始接收」：把接下来的**一份**上传绑定到这个需求上。
 *
 * 没有单独的「准备」步骤了 —— 接收地址与密钥是长期有效的，手机上配一次即可，
 * 所以这里一次调用就同时完成「立靶」和「等上传」。
 */
export interface CaptureAndroidInput {
  requirementId: string;
  /** 等待窗口，缺省 3 分钟。窗口内没等到就超时失败。 */
  ttlMs?: number;
}

export interface CreateRequirementInput {
  name: string;
  description?: string;
}

export interface ImportFigmaInput {
  requirementId: string;
  /** zip 文件路径或导出文件夹路径 */
  sourcePath: string;
  conflict: ConflictPolicy;
}

export interface SavePairInput {
  requirementId: string;
  designAssetId: string;
  appSnapshotId: string;
  matchScore?: number;
  /**
   * 传入则**原地替换**该配对的两侧素材。
   *
   * 缺省时按「设计稿 + 截图」组合查找/新建 —— 那是「建立配对」的语义，
   * 用它来「换掉一侧」会意外多出一个配对，所以替换必须显式带上 pairId。
   */
  pairId?: string;
}

export interface RenameSnapshotInput {
  requirementId: string;
  snapshotId: string;
  label: string;
}

/**
 * 删除一份素材（设计稿 / 截图）。
 *
 * ⚠️ 删除是**级联**的：引用该素材的配对、以及那些配对下的问题记录会一并删除。
 * 配对只是「两份素材 id 的组合」，素材没了就成了悬空引用 ——
 * 而 `buildPairViews` 会跳过解析不出的配对，于是它会「界面上消失但留在索引里」。
 */
export interface DeleteAssetInput {
  requirementId: string;
  /** 设计稿 id 或截图 id，取决于调用的通道 */
  assetId: string;
}

export interface SaveIssueInput {
  id?: string;
  requirementId: string;
  pairId: string;
  source: 'design' | 'app' | 'both';
  position: { x: number; y: number } | null;
  nodeId: string | null;
  category: IssueCategory;
  severity: IssueSeverity;
  description: string;
}

/** 画布要的一组配对视图（含两侧截图 URL 与节点表） */
export interface VerifyPairView {
  meta: MatchPairMeta;
  name: string;
  pageNumber: number;
  issueCount: number;
  design: SideData<DesignNode>;
  app: SideData<AppNode>;
}

/**
 * 验收工作流 API。
 * 通过 preload 暴露为 `window.api.verify`。
 */
export interface VerifyApi {
  listRequirements(): Promise<RequirementMeta[]>;
  createRequirement(input: CreateRequirementInput): Promise<RequirementMeta>;
  deleteRequirement(id: string): Promise<void>;
  getRequirement(id: string): Promise<RequirementMeta | null>;

  /** 打开系统选择框挑 zip / 文件夹；取消返回 null */
  pickImportPath(): Promise<string | null>;
  importFigmaPackage(input: ImportFigmaInput): Promise<ImportResult>;

  listAndroidDevices(): Promise<AndroidDeviceInfo[]>;

  /** 接收器凭据（地址端口 + 长期密钥）与当前接收靶。手机上配一次即可复用。 */
  getAcceptanceReceiver(): Promise<AcceptanceReceiverInfo>;
  /**
   * 立靶并等待手机上传。返回即表示**已经落盘**，可以直接刷新需求。
   * 等待期间用 `cancelAndroidCapture` 取消。
   */
  captureAndroid(input: CaptureAndroidInput): Promise<AndroidCaptureResult>;
  cancelAndroidCapture(): Promise<void>;

  getAcceptanceReadiness(pairId: string): Promise<AcceptanceReadiness>;
  runAcceptance(input: RunAcceptanceInput): Promise<AcceptanceRunMeta>;
  getAcceptanceRun(input: { requirementId: string; runId: string }): Promise<AcceptanceRunMeta | null>;
  getNodeMapping(pairId: string): Promise<NodeMapping | null>;
  saveNodeMapping(input: SaveNodeMappingInput): Promise<NodeMapping>;

  /** 改 App 快照的可读名称（页面匹配的名称相似度依赖它） */
  renameSnapshot(input: RenameSnapshotInput): Promise<void>;

  /** 删除一份设计稿；引用它的配对及其下问题一并删除 */
  deleteDesignAsset(input: DeleteAssetInput): Promise<void>;
  /** 删除一张 App 截图；引用它的配对及其下问题一并删除 */
  deleteSnapshot(input: DeleteAssetInput): Promise<void>;

  savePair(input: SavePairInput): Promise<MatchPairMeta>;
  deletePair(id: string): Promise<void>;

  saveIssue(input: SaveIssueInput): Promise<Issue>;
  deleteIssue(id: string): Promise<void>;

  /** 取某个需求的全部配对视图，供画布渲染 */
  getPairs(requirementId: string): Promise<VerifyPairView[]>;

  /**
   * 取拖拽文件的真实磁盘路径。
   * ⚠️ Electron 30 已移除 `File.path`，必须走 `webUtils.getPathForFile()`，
   * 而 webUtils 只在主进程侧可用，故经 preload 桥接。
   */
  getDroppedFilePath(file: File): string;
}

// ---------- 渲染层可调用的 API（经 preload contextBridge 暴露） ----------

/**
 * Figma 插件直传通道。
 *
 * 生命周期与验收窗口绑定：窗口打开即监听、关闭即停 —— 不需要用户在 Mac 端做任何预备动作，
 * 回环端口也不会常驻。`setEnabled` 只是给用户一个随时掐断的开关
 * （没做配对码，所以这个开关是必要的补偿控制）。
 */
export interface BridgeApi {
  status(): Promise<BridgeStatus>;
  setEnabled(enabled: boolean): Promise<BridgeStatus>;
  /** 订阅状态变化与导入完成事件；返回取消订阅函数 */
  onEvent(cb: (event: BridgeEvent) => void): () => void;
}

export interface MirrorApi {
  startSource(opts: StartSourceOptions): Promise<IPhoneSession | void>;
  stopSource(): Promise<void>;
  sendAndroidControl(command: AndroidControlCommand): Promise<void>;
  getLocalIp(): Promise<NetworkAddress[]>;
  openVerify(): Promise<void>;
  /** 验收工作流（窗口内视图切换的那套） */
  verify: VerifyApi;
  /** Figma 插件直传通道 */
  bridge: BridgeApi;
  onStatus(cb: (text: StatusPayload) => void): () => void;
  onH264(cb: (data: H264Payload) => void): () => void;
  onVideoPacket(cb: (packet: VideoPacket) => void): () => void;
  inspector: InspectorApi;
}

declare global {
  interface Window {
    api: MirrorApi;
  }
}
