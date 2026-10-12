import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

import type {
  AcceptanceReceiverInfo,
  AndroidCaptureResult,
  AndroidControlCommand,
  AndroidDeviceInfo,
  AppSnapshotReceived,
  CanvasCapture,
  CanvasCaptureBounds,
  BridgeApi,
  BridgeEvent,
  BridgeStatus,
  CaptureAndroidInput,
  CreateRequirementInput,
  DeleteAssetInput,
  ExportPairDebugInput,
  ExportPairDebugResult,
  ExportGroundTruthInput,
  ExportGroundTruthResult,
  GroundTruth,
  H264Payload,
  ImportFigmaInput,
  ImportResult,
  InspectorEvent,
  InspectorPickPoint,
  IPhoneSession,
  Issue,
  MatchPairMeta,
  MirrorApi,
  NetworkAddress,
  RenameSnapshotInput,
  NodeMapping,
  RequirementMeta,
  SaveGroundTruthInput,
  SaveIssueInput,
  SavePairInput,
  StartSourceOptions,
  StatusPayload,
  VerifyApi,
  VerifyPairView,
  SaveNodeMappingInput,
  VideoPacket,
} from '../types/ipc';

/** 订阅型通道：注册监听并返回取消函数，避免渲染层直接碰 ipcRenderer */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** 验收工作流：全部走 invoke，只传纯数据 */
const verify: VerifyApi = {
  listRequirements: (): Promise<RequirementMeta[]> => ipcRenderer.invoke('verify:req-list'),

  createRequirement: (input: CreateRequirementInput): Promise<RequirementMeta> =>
    ipcRenderer.invoke('verify:req-create', input),

  deleteRequirement: (id: string): Promise<void> => ipcRenderer.invoke('verify:req-delete', id),

  getRequirement: (id: string): Promise<RequirementMeta | null> =>
    ipcRenderer.invoke('verify:req-get', id),

  pickImportPath: (): Promise<string | null> => ipcRenderer.invoke('verify:pick-import-path'),

  importFigmaPackage: (input: ImportFigmaInput): Promise<ImportResult> =>
    ipcRenderer.invoke('verify:import-figma', input),

  listAndroidDevices: (): Promise<AndroidDeviceInfo[]> => ipcRenderer.invoke('verify:android-devices'),

  getAcceptanceReceiver: (): Promise<AcceptanceReceiverInfo> =>
    ipcRenderer.invoke('verify:acceptance-receiver'),

  setAcceptanceStandby: (requirementId: string | null): Promise<AcceptanceReceiverInfo> =>
    ipcRenderer.invoke('verify:acceptance-standby', requirementId),

  onAppSnapshotReceived: (listener: (result: AppSnapshotReceived) => void): (() => void) =>
    subscribe<AppSnapshotReceived>('verify:app-snapshot-received', listener),

  captureAndroid: (input: CaptureAndroidInput): Promise<AndroidCaptureResult> =>
    ipcRenderer.invoke('verify:capture-android', input),

  cancelAndroidCapture: (): Promise<void> => ipcRenderer.invoke('verify:cancel-android-capture'),

  getAcceptanceReadiness: (pairId: string) => ipcRenderer.invoke('verify:acceptance-readiness', pairId),

  getAiConfigStatus: () => ipcRenderer.invoke('verify:ai-config-status'),

  saveAiConfig: (input) => ipcRenderer.invoke('verify:ai-config-save', input),

  testAiConnection: (input) => ipcRenderer.invoke('verify:ai-config-test', input),

  runAcceptance: (input) => ipcRenderer.invoke('verify:acceptance-run', input),

  runSamaAcceptance: (input) => ipcRenderer.invoke('verify:sama-run', input),

  loadSamaClean: (input) => ipcRenderer.invoke('verify:sama-clean', input),

  getAcceptanceRun: (input) => ipcRenderer.invoke('verify:acceptance-run-get', input),

  getAcceptanceRunHistory: (pairId: string) => ipcRenderer.invoke('verify:acceptance-run-history', pairId),

  getNodeMapping: (pairId: string): Promise<NodeMapping | null> =>
    ipcRenderer.invoke('verify:node-mapping-get', pairId),

  saveNodeMapping: (input: SaveNodeMappingInput): Promise<NodeMapping> =>
    ipcRenderer.invoke('verify:node-mapping-save', input),

  getGroundTruth: (pairId: string): Promise<GroundTruth | null> =>
    ipcRenderer.invoke('verify:ground-truth-get', pairId),

  saveGroundTruth: (input: SaveGroundTruthInput): Promise<GroundTruth> =>
    ipcRenderer.invoke('verify:ground-truth-save', input),

  exportGroundTruth: (input: ExportGroundTruthInput): Promise<ExportGroundTruthResult> =>
    ipcRenderer.invoke('verify:ground-truth-export', input),

  renameSnapshot: (input: RenameSnapshotInput): Promise<void> =>
    ipcRenderer.invoke('verify:snapshot-rename', input),

  deleteDesignAsset: (input: DeleteAssetInput): Promise<void> =>
    ipcRenderer.invoke('verify:design-delete', input),

  deleteSnapshot: (input: DeleteAssetInput): Promise<void> =>
    ipcRenderer.invoke('verify:snapshot-delete', input),

  savePair: (input: SavePairInput): Promise<MatchPairMeta> =>
    ipcRenderer.invoke('verify:pair-save', input),

  deletePair: (id: string): Promise<void> => ipcRenderer.invoke('verify:pair-delete', id),

  saveIssue: (input: SaveIssueInput): Promise<Issue> => ipcRenderer.invoke('verify:issue-save', input),

  deleteIssue: (id: string): Promise<void> => ipcRenderer.invoke('verify:issue-delete', id),

  captureCanvas: (bounds: CanvasCaptureBounds): Promise<CanvasCapture> =>
    ipcRenderer.invoke('verify:canvas-capture', bounds),

  getPairs: (requirementId: string): Promise<VerifyPairView[]> =>
    ipcRenderer.invoke('verify:pairs', requirementId),

  exportPairDebug: (input: ExportPairDebugInput): Promise<ExportPairDebugResult> =>
    ipcRenderer.invoke('verify:export-pair-debug', input),

  /**
   * 拖拽文件的真实磁盘路径。
   * ⚠️ Electron 30 已移除 `File.path`，渲染层拿不到路径；
   * `webUtils.getPathForFile` 只能在 preload/主进程侧调用，故经此桥接。
   */
  getDroppedFilePath: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

/** Figma 插件直传通道：状态查询 + 事件订阅（接收到的内容走事件推，没有可以拿返回值的请求） */
const bridge: BridgeApi = {
  status: (): Promise<BridgeStatus> => ipcRenderer.invoke('bridge:status'),

  setEnabled: (enabled: boolean): Promise<BridgeStatus> =>
    ipcRenderer.invoke('bridge:set-enabled', enabled),

  onEvent: (cb: (event: BridgeEvent) => void): (() => void) => subscribe<BridgeEvent>('bridge:event', cb),
};

const api: MirrorApi = {
  startSource: (opts: StartSourceOptions): Promise<IPhoneSession | void> =>
    ipcRenderer.invoke('start-source', opts),

  stopSource: (): Promise<void> => ipcRenderer.invoke('stop-source'),

  sendAndroidControl: (command: AndroidControlCommand): Promise<void> =>
    ipcRenderer.invoke('android-control', command),

  getLocalIp: (): Promise<NetworkAddress[]> => ipcRenderer.invoke('get-local-ip'),

  openVerify: (): Promise<void> => ipcRenderer.invoke('open-verify'),

  verify,

  bridge,

  onStatus: (cb: (text: StatusPayload) => void): (() => void) => subscribe<StatusPayload>('status', cb),

  onH264: (cb: (data: H264Payload) => void): (() => void) => subscribe<H264Payload>('h264', cb),

  onVideoPacket: (cb: (packet: VideoPacket) => void): (() => void) =>
    subscribe<VideoPacket>('video-packet', cb),

  inspector: {
    status: (): Promise<{ running: boolean; runtimeConnected: boolean; editorConnected: boolean }> =>
      ipcRenderer.invoke('inspector:status'),
    pick: (point: InspectorPickPoint): Promise<void> => ipcRenderer.invoke('inspector:pick', point),
    clear: (): Promise<void> => ipcRenderer.invoke('inspector:clear'),
    onEvent: (cb: (event: InspectorEvent) => void): (() => void) => subscribe<InspectorEvent>('inspector:event', cb),
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api);
} else {
  // contextIsolation 关闭时的兜底（当前窗口配置恒为 true，保留分支防止后续改动踩空）
  (window as unknown as { api: MirrorApi }).api = api;
}
