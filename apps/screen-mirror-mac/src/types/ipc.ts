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
  IssueImage,
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
  AcceptanceRunHistoryItem,
  AcceptanceRunMeta,
  AiConfigStatus,
  AiConnectionTestResult,
  NodeMapping,
  RunAcceptanceInput,
  SaveNodeMappingInput,
  SaveAiConfigInput,
  TestAiConfigInput,
} from './aiAcceptance';
import type {
  ExportGroundTruthInput,
  ExportGroundTruthResult,
  GroundTruth,
  SaveGroundTruthInput,
} from './groundTruth';

/**
 * 领域类型转出去，让 preload / 渲染层只从「IPC 契约」这一个模块取类型，
 * 不用同时记住 verify.ts 的存在。
 */
export type {
  AppNode,
  DesignNode,
  Issue,
  IssueImage,
  IssueSeverity,
  MatchPairMeta,
  RequirementMeta,
  SideData,
};
export type { AcceptanceArmState, AcceptanceReceiverInfo, CollectionQuality } from './acceptance';
export type {
  AcceptanceReadiness,
  AcceptanceRunMeta,
  AiConfigStatus,
  AiConnectionTestResult,
  NodeMapping,
  RunAcceptanceInput,
  SaveNodeMappingInput,
  SaveAiConfigInput,
  TestAiConfigInput,
} from './aiAcceptance';
/** 人工标注（ground truth）的类型；渲染层的画布与面板都从这里取 */
export type {
  EngineAgreement,
  ExportGroundTruthInput,
  ExportGroundTruthResult,
  GroundTruth,
  GroundTruthPair,
  GroundTruthVerdict,
  SaveGroundTruthInput,
} from './groundTruth';

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
 * 常驻等待收到并落盘的一份 App 截图。
 *
 * 比 `AndroidCaptureResult` 多一个落点需求 id：手动接收的结果由调用方自己知道落哪，
 * 常驻接收没有调用方 —— 落点只有主进程知道，不一起推出去，界面就没法判断
 * 「这份是不是我正在等的那个需求」，只能在别的需求也在刷新列表时跟着白刷新一次。
 */
export type AppSnapshotReceived = AndroidCaptureResult & { requirementId: string };

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
  /** 上传通道；USB 模式通过 adb reverse 连接手机 localhost。 */
  transport?: 'usb' | 'network';
  /** USB 模式下指定设备；缺省使用第一台已授权设备。 */
  androidSerial?: string;
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
  designNodeId?: string | null;
  appNodeId?: string | null;
  severity: IssueSeverity;
  description: string;
  image?: IssueImageInput | null;
}

export interface IssueImageInput {
  dataUrl: string;
  width: number;
  height: number;
}

export interface CanvasCaptureBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasCapture {
  dataUrl: string;
  width: number;
  height: number;
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
 * 导出配对调试包：把这一次配对喂给验收引擎的**原始数据 + 归一化结果 + 匹配打分**
 * 整体落盘成一个 JSON（路径由主进程决定，见 `store/paths.debugExportsDir`）。
 *
 * 用途是排查「验收跑出来匹配 0」这类输入侧问题 —— 报告里只有结论，没有输入。
 */
export interface ExportPairDebugInput {
  requirementId: string;
  pairId: string;
}

export interface ExportPairDebugResult {
  /** 落盘绝对路径 */
  file: string;
  bytes: number;
  /** 匹配结果分档计数（matched / ambiguous / missing / extra …） */
  statusCounts: Record<string, number>;
}

/**
 * 导出可分享的调试包 ZIP：两侧原始节点 + 两侧截图原文件 + 画布/viewport 尺寸与
 * 坐标缩放元数据（`meta.json`）+ 人工映射 / ground truth（如有）。
 *
 * 用途是真实样本回归 —— 读者是拿不到 App 现场的人（或回归脚本），所以只装
 * **原始输入**、不跑引擎不下结论。保存位置由用户在对话框里选。
 */
export interface ExportDebugBundleInput {
  requirementId: string;
  pairId: string;
}

export interface ExportDebugBundleResult {
  /** 用户取消了保存对话框 */
  canceled: boolean;
  /** ZIP 落盘绝对路径（canceled 时缺省） */
  file?: string;
  bytes?: number;
  /** 包内缺失的文件（如截图不在盘上），UI 应提示 */
  missing?: string[];
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
   * 常驻等待登记：把接下来**所有**上传都绑到 `requirementId`（传 null 撤销）。
   *
   * 与 `captureAndroid` 的区别是「没有人在等」：不需要先点按钮，手机点上传就直接落盘，
   * 落完通过 `onAppSnapshotReceived` 推回来。验收页打开某个需求时就该登记它，
   * 离开时传 null —— 没登记任何需求时上传会被拒（409），而不是随便找个需求放。
   */
  setAcceptanceStandby(requirementId: string | null): Promise<AcceptanceReceiverInfo>;
  /** 常驻等待收到并落盘了一份快照。返回取消订阅函数。 */
  onAppSnapshotReceived(listener: (result: AppSnapshotReceived) => void): () => void;
  /**
   * 立靶并等待手机上传。返回即表示**已经落盘**，可以直接刷新需求。
   * 等待期间用 `cancelAndroidCapture` 取消。
   */
  captureAndroid(input: CaptureAndroidInput): Promise<AndroidCaptureResult>;
  cancelAndroidCapture(): Promise<void>;

  getAcceptanceReadiness(pairId: string): Promise<AcceptanceReadiness>;
  getAiConfigStatus(): Promise<AiConfigStatus>;
  saveAiConfig(input: SaveAiConfigInput): Promise<AiConfigStatus>;
  testAiConnection(input: TestAiConfigInput): Promise<AiConnectionTestResult>;
  runAcceptance(input: RunAcceptanceInput): Promise<AcceptanceRunMeta>;
  getAcceptanceRun(input: { requirementId: string; runId: string }): Promise<AcceptanceRunMeta | null>;
  getAcceptanceRunHistory(pairId: string): Promise<AcceptanceRunHistoryItem[]>;
  getNodeMapping(pairId: string): Promise<NodeMapping | null>;
  saveNodeMapping(input: SaveNodeMappingInput): Promise<NodeMapping>;

  /**
   * 人工标注（ground truth）。
   *
   * ⚠️ 这三条与上面 `*NodeMapping` 是**两套互不相通**的数据，不要互相复用：
   * mapping 是「喂给引擎的输入」（锚点 / 忽略），标注是「引擎算得对不对的答案」。
   * 把答案写进输入，下一轮就再也观察不到「不改输入时引擎会怎样」。
   */
  getGroundTruth(pairId: string): Promise<GroundTruth | null>;
  saveGroundTruth(input: SaveGroundTruthInput): Promise<GroundTruth>;
  /**
   * 导出标注包（自足 JSON，含答案 + 引擎基线 + 全量可匹配节点）。
   * 落盘路径由主进程决定并返回，渲染层只负责把路径显示出来。
   */
  exportGroundTruth(input: ExportGroundTruthInput): Promise<ExportGroundTruthResult>;

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
  captureCanvas(bounds: CanvasCaptureBounds): Promise<CanvasCapture>;

  /** 取某个需求的全部配对视图，供画布渲染 */
  getPairs(requirementId: string): Promise<VerifyPairView[]>;

  /**
   * 导出配对调试包。落盘路径由主进程决定并返回，渲染层只负责把路径显示出来。
   */
  exportPairDebug(input: ExportPairDebugInput): Promise<ExportPairDebugResult>;

  /**
   * 导出可分享的调试包 ZIP（两侧原始节点 + 两侧截图 + 坐标缩放元数据 +
   * 人工映射/ground truth）。保存位置由用户在对话框里选；取消时返回
   * `{ canceled: true }`。
   */
  exportDebugBundle(input: ExportDebugBundleInput): Promise<ExportDebugBundleResult>;

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
