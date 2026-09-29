/**
 * 验收工作流的 IPC 层：把存储层 / 导入管线 / 采集模块接到渲染层。
 *
 * 约定（沿用主进程既有经验）：**handler 不能返回 BrowserWindow 等不可结构化克隆的对象**，
 * 否则 `invoke` 会直接 reject 且错误信息很难定位。这里统一只返回纯数据。
 */

import { BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeTextSamples,
  platformLabel,
  type AppSnapshotMeta,
  type DesignAssetMeta,
  type Issue,
  type MatchPairMeta,
  type RequirementMeta,
} from '../types/verify';
import type { AcceptanceReceiverInfo } from '../types/acceptance';
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
} from '../types/aiAcceptance';
import { getAiConfigStatus, saveAiConfig, testAiConnection } from './acceptance/ai';
import type {
  AndroidCaptureResult,
  AndroidDeviceInfo,
  AppSnapshotReceived,
  CanvasCaptureBounds,
  CaptureAndroidInput,
  CreateRequirementInput,
  DeleteAssetInput,
  ExportDebugBundleInput,
  ExportDebugBundleResult,
  ExportPairDebugInput,
  ExportPairDebugResult,
  ImportFigmaInput,
  ImportResult,
  RenameSnapshotInput,
  SaveIssueInput,
  SavePairInput,
  VerifyPairView,
} from '../types/ipc';
import type {
  ExportGroundTruthInput,
  ExportGroundTruthResult,
  GroundTruth,
  SaveGroundTruthInput,
} from '../types/groundTruth';

import {
  ensureAndroidAcceptanceReverse,
  listAndroidDevices,
  prepareAndroidAcceptanceReverse,
  receiveSdkSnapshot,
  removeAndroidAcceptanceReverse,
} from './capture/androidCapture';
import { AcceptanceReceiver, type AcceptanceUpload } from './capture/acceptanceReceiver';
import { createAcceptanceService } from './acceptance/service';
import { exportDebugBundle, exportPairDebug } from './acceptance/debugExport';
import { exportGroundTruth } from './acceptance/groundTruthExport';
import { importFigmaPackage } from './importer/figmaImport';
import { writeThumbnail } from './importer/thumb';
import { assetUrl } from './protocol';
import { writeBinaryAtomic, writeJsonAtomic } from './store/atomic';
import { loadAppNodes, loadDesignNodes } from './store/assets';
import { appSnapshotDir, designAssetDir, issueImagePath } from './store/paths';
import {
  createId,
  createRequirement,
  deleteRequirement,
  getRequirement,
  listRequirements,
  mutateRequirement,
  timestamp,
} from './store/workspace';

// ---------- 配对视图 ----------

function pairName(design: DesignAssetMeta | undefined, app: AppSnapshotMeta | undefined): string {
  if (design) return design.name;
  // 老快照没有 platform 字段时沿用历史兜底（这是配对/窗口名，不参与任何验收结论）
  if (app) return `${platformLabel(app.platform) ?? 'Android'} ${app.device ?? ''}`.trim();
  return '未命名配对';
}

/** 导出以便冒烟测试直接校验配对视图的组装结果 */
export async function buildPairViews(requirement: RequirementMeta): Promise<VerifyPairView[]> {
  const designById = new Map(requirement.designAssets.map((asset) => [asset.id, asset]));
  const appById = new Map(requirement.appSnapshots.map((snapshot) => [snapshot.id, snapshot]));

  const views: VerifyPairView[] = [];

  for (const [index, pair] of requirement.pairs.entries()) {
    const design = designById.get(pair.designAssetId);
    const app = appById.get(pair.appSnapshotId);
    if (!design || !app) continue;

    const [designNodes, appNodes] = await Promise.all([
      loadDesignNodes(requirement.id, design),
      loadAppNodes(requirement.id, app),
    ]);

    views.push({
      meta: pair,
      name: pairName(design, app),
      pageNumber: index + 1,
      issueCount: requirement.issues.filter((issue) => issue.pairId === pair.id && issue.status === 'open')
        .length,
      design: {
        width: design.width,
        height: design.height,
        imageUrl: assetUrl(requirement.id, 'design', design.id, design.screenshotFile),
        imageLabel: `${design.name}（${design.width}×${design.height}）`,
        nodes: designNodes,
      },
      app: {
        width: app.width,
        height: app.height,
        // 物理像素比（iOS 3 / 安卓 2.625）：渲染层靠它把「面板上这个小数的来历」写出来 ——
        // 设备侧的长度读数总可以写成 `k / pixelRatio`（`w(8)` 在 3x 屏上是 `26/3` = 8.67）。
        // 只是把已存在的元数据带过去，不参与任何换算，见 `SideData.pixelRatio`。
        pixelRatio: app.width > 0 ? app.pixelWidth / app.width : undefined,
        imageUrl: assetUrl(requirement.id, 'app', app.id, app.screenshotFile),
        imageLabel: `${app.device ?? app.platform}（${app.width}×${app.height}）`,
        nodes: appNodes,
      },
    });
  }

  return views;
}

/**
 * 配对写入：新建 / 复用 / 原地替换三种语义都收在这里。
 *
 * 抽成纯函数是为了能在冒烟测试里直接验证「替换不会多出一个配对」——
 * 这条分支靠 UI 点是验不出来的（UI 看起来都对，只是列表悄悄多了一项）。
 */
export function applyPairSave(requirement: RequirementMeta, input: SavePairInput): MatchPairMeta {
  // 替换：按 pairId 原地改两侧素材。
  // 缺省路径是「按组合查重再新建」，若用它来换一侧，新组合查不到就会**多出一个配对**，
  // 所以替换必须走这条分支。
  if (input.pairId) {
    const target = requirement.pairs.find((pair) => pair.id === input.pairId);
    if (target) {
      target.designAssetId = input.designAssetId;
      target.appSnapshotId = input.appSnapshotId;
      if (input.matchScore !== undefined) target.matchScore = input.matchScore;
      // 素材换了，之前的验收结论不再对应当前内容 → 回到待验收。
      // 已记录的问题**不删**（删除不可逆），由人复核后自行处理。
      target.status = 'pending';
      return target;
    }
  }

  const existing = requirement.pairs.find(
    (pair) => pair.designAssetId === input.designAssetId && pair.appSnapshotId === input.appSnapshotId,
  );
  if (existing) {
    existing.matchScore = input.matchScore;
    return existing;
  }

  const pair: MatchPairMeta = {
    id: createId(),
    requirementId: input.requirementId,
    designAssetId: input.designAssetId,
    appSnapshotId: input.appSnapshotId,
    matchScore: input.matchScore,
    status: 'pending',
    createdAt: timestamp(),
  };
  requirement.pairs.push(pair);
  return pair;
}

/** 素材种类。设计稿与截图的删除语义完全一致，只是所在数组不同 */
export type AssetKind = 'design' | 'app';

/** 删除素材的连带影响。返回给调用方（UI 提示 / 冒烟断言）用，不进 IPC 契约 */
export interface AssetDeletePlan {
  /** 素材是否存在。不存在时是**幂等空操作**：不抛错、不改任何数据 */
  found: boolean;
  /** 被级联删除的配对 id */
  pairIds: string[];
  /** 被级联删除的问题数 */
  issueCount: number;
}

/**
 * 删除一份素材（设计稿 / 截图），并**级联清掉引用它的配对与其下的问题**。
 *
 * 为什么不能只把素材从数组里摘掉：配对本质上只是「两份素材 id 的组合」，
 * 素材没了它就成悬空引用。而 `buildPairViews` 遇到解析不出的配对会 `continue` ——
 * 于是悬空配对**在界面上消失、却仍留在 index.json 里**：看不见、删不掉、
 * 还会让「配对总数」这类计数对不上（左列表 3 条、需求里其实 4 个）。
 * 问题记录同理，它们挂在 `pairId` 上，配对没了就没有归属。
 *
 * 抽成纯函数是为了能在冒烟里直接验证级联范围 —— 这条靠 UI 点是验不出来的：
 * 界面看起来都对（卡片和配对确实消失了），只有索引里是否残留幽灵数据看不出来。
 */
export function applyAssetDelete(
  requirement: RequirementMeta,
  kind: AssetKind,
  assetId: string,
): AssetDeletePlan {
  const exists =
    kind === 'design'
      ? requirement.designAssets.some((asset) => asset.id === assetId)
      : requirement.appSnapshots.some((snapshot) => snapshot.id === assetId);
  if (!exists) return { found: false, pairIds: [], issueCount: 0 };

  if (kind === 'design') {
    requirement.designAssets = requirement.designAssets.filter((asset) => asset.id !== assetId);
  } else {
    requirement.appSnapshots = requirement.appSnapshots.filter(
      (snapshot) => snapshot.id !== assetId,
    );
  }

  // 同一份设计稿可以对多张截图、同一张截图也可以对多份设计稿，所以要收全部命中项
  const pairIds = requirement.pairs
    .filter((pair) =>
      kind === 'design' ? pair.designAssetId === assetId : pair.appSnapshotId === assetId,
    )
    .map((pair) => pair.id);

  if (pairIds.length > 0) {
    const dead = new Set(pairIds);
    requirement.pairs = requirement.pairs.filter((pair) => !dead.has(pair.id));
    const before = requirement.issues.length;
    requirement.issues = requirement.issues.filter((issue) => !dead.has(issue.pairId));
    return { found: true, pairIds, issueCount: before - requirement.issues.length };
  }

  return { found: true, pairIds: [], issueCount: 0 };
}

/**
 * 素材删除的落盘顺序：**先改索引（`mutateRequirement` 内部已 persist）→ 再删目录**。
 * 反过来的话，删完目录还没写索引就崩溃，索引会指向一个不存在的目录 ——
 * 与 `deleteRequirement` 同一个理由。
 *
 * 目录清理失败只告警不抛错：用户的意图（素材从需求里消失）已经达成，
 * 残留一个孤儿目录不影响任何功能。而且素材级目录**不在 reconcile 的覆盖范围**
 * （`initWorkspace` 只查需求目录），这里更不能让它把整个删除动作拖失败。
 */
async function removeAsset(
  requirementId: string,
  kind: AssetKind,
  assetId: string,
): Promise<void> {
  const plan = await mutateRequirement(requirementId, (requirement) =>
    applyAssetDelete(requirement, kind, assetId),
  );
  if (!plan.found) return;

  const dir =
    kind === 'design'
      ? designAssetDir(requirementId, assetId)
      : appSnapshotDir(requirementId, assetId);
  await rm(dir, { recursive: true, force: true }).catch((cause: unknown) => {
    console.warn(`[verify] 素材目录清理失败（索引已更新，仅残留孤儿目录）：${dir}`, cause);
  });
}

// ---------- IPC 注册 ----------

/**
 * USB 直传隧道的巡检间隔。
 *
 * 这个值决定「插上线之后多久 App 判定 USB 可行」，也决定设备重插后多久恢复 ——
 * 太短会让 adb 被无谓地反复调用，太长则用户插好线还要等。15 秒是两者之间的折中：
 * 手机侧探一次只要 1.2 秒超时，探不到会立刻落到局域网，不会卡住用户。
 */
const USB_REVERSE_KEEPALIVE_MS = 15 * 1000;

export function registerVerifyIpc(
  receiver: AcceptanceReceiver,
  hooks: { onAppSnapshotReceived?: (result: AppSnapshotReceived) => void } = {},
): void {
  const acceptance = createAcceptanceService();
  let activeUsbReverse: { serial: string; devicePort: number } | null = null;
  /** 常驻等待期间的 USB 隧道巡检定时器；没开常驻时为空。 */
  let usbReverseTimer: NodeJS.Timeout | null = null;

  const clearUsbReverse = async (): Promise<void> => {
    const reverse = activeUsbReverse;
    activeUsbReverse = null;
    if (reverse) await removeAndroidAcceptanceReverse(reverse.serial, reverse.devicePort);
  };

  ipcMain.handle('verify:req-list', (): Promise<RequirementMeta[]> => listRequirements());

  ipcMain.handle('verify:req-get', (_event, id: string): Promise<RequirementMeta | null> =>
    getRequirement(id),
  );

  ipcMain.handle('verify:req-create', (_event, input: CreateRequirementInput): Promise<RequirementMeta> =>
    createRequirement(input),
  );

  ipcMain.handle('verify:req-delete', (_event, id: string): Promise<void> => deleteRequirement(id));

  ipcMain.handle('verify:pick-import-path', async (): Promise<string | null> => {
    const picked = await dialog.showOpenDialog({
      title: '选择 Figma 导出包（zip 或导出文件夹）',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Figma 导出包', extensions: ['zip'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return picked.filePaths[0] ?? null;
  });

  ipcMain.handle('verify:import-figma', (_event, input: ImportFigmaInput): Promise<ImportResult> =>
    importFigmaPackage(input.requirementId, input.sourcePath, input.conflict),
  );

  ipcMain.handle('verify:android-devices', (): Promise<AndroidDeviceInfo[]> => listAndroidDevices());

  ipcMain.handle(
    'verify:acceptance-receiver',
    (): AcceptanceReceiverInfo => receiver.info(),
  );

  ipcMain.handle(
    'verify:cancel-android-capture',
    async (): Promise<void> => {
      receiver.cancelWait();
      await clearUsbReverse();
    },
  );

  /**
   * 把一份 SDK 上传落成这个需求下的一份 App 截图。
   *
   * 手动接收与常驻接收共用一份实现：两者的差别只在「谁在等这份上传」，落盘这件事一个字都
   * 不该分叉 —— 一旦分叉，就会长出「手动传的能进去、常驻传的缺个缩略图」这种只在一条路上
   * 出现的问题，而它恰好不会在你手测的那条路上出现。
   */
  const persistAppSnapshot = async (
    requirementId: string,
    upload: AcceptanceUpload,
  ): Promise<AndroidCaptureResult> => {
    const output = receiveSdkSnapshot(upload);

    const snapshotId = createId();
    const dir = appSnapshotDir(requirementId, snapshotId);

    const screenshotName = 'screenshot.png';
    const screenshotPath = path.join(dir, screenshotName);
    await writeBinaryAtomic(screenshotPath, output.screenshot);

    const nodesFile = 'nodes.json';
    await writeJsonAtomic(path.join(dir, nodesFile), output.nodes);

    await writeThumbnail(screenshotPath, path.join(dir, 'thumb.png'));

    const meta: AppSnapshotMeta = {
      id: snapshotId,
      requirementId,
      // 照抄上传里报的平台（Android / iOS 共用这一条接收链）。写死 'android' 时，
      // iPhone 上采的那份会被记成安卓，配对列表里就成了「Android iPhone 15」。
      platform: output.platform,
      device: output.deviceModel,
      width: output.logicalWidth,
      height: output.logicalHeight,
      pixelWidth: output.pixelWidth,
      pixelHeight: output.pixelHeight,
      densityDpi: output.densityDpi,
      nodesFile,
      screenshotFile: screenshotName,
      thumbnailFile: 'thumb.png',
      nodeCount: output.nodes.length,
      textSamples: normalizeTextSamples(output.nodes.map((node) => node.text)),
      // 默认名给个有信息量的（前台包名 / 机型），UI 同学再改成页面名。
      // 兜底那个名字要跟着平台走 —— 写死「Android 截图」在 iOS 那条路上就是错的。
      label:
        output.packageName ??
        output.deviceModel ??
        `${platformLabel(output.platform) ?? 'App'} 截图`,
      source: 'sdk',
      captureId: output.captureId,
      collectionQuality: output.collection,
      coordinateInset: output.coordinateInset,
      capturedAt: timestamp(),
      foregroundPackage: output.packageName,
    };

    // 先写文件、后写索引
    await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
    await mutateRequirement(requirementId, (requirement: RequirementMeta) => {
      requirement.appSnapshots.push(meta);
    });

    return {
      snapshotId,
      captureId: output.captureId,
      source: output.source,
      nodeCount: meta.nodeCount,
      width: meta.width,
      height: meta.height,
      pixelWidth: meta.pixelWidth,
      pixelHeight: meta.pixelHeight,
      densityDpi: meta.densityDpi ?? 0,
      collection: output.collection,
      packageName: output.packageName,
      deviceModel: output.deviceModel,
      warning: output.warning,
    };
  };

  ipcMain.handle(
    'verify:capture-android',
    async (_event, request: CaptureAndroidInput): Promise<AndroidCaptureResult> => {
      if (request.transport === 'usb') {
        activeUsbReverse = await prepareAndroidAcceptanceReverse(
          request.androidSerial,
          receiver.info().port,
        );
      }

      // 立靶 + 等上传是一次调用：靶是「这份快照算哪个需求的」唯一依据，
      // 与等待分开会出现「立了靶但没人接」的中间态 —— 那时上传会被接受却没人落盘。
      try {
        const upload = await receiver.waitForUpload({
          requirementId: request.requirementId,
          ttlMs: request.ttlMs,
        });
        return await persistAppSnapshot(request.requirementId, upload);
      } finally {
        await clearUsbReverse();
      }
    },
  );

  /**
   * 常驻接收：手机点「上传」时 Mac 侧**没有人在 `await`**（用户没点过任何按钮），
   * 这份快照由这里接住 —— 落盘，然后推给验收页刷新。
   *
   * 失败只记日志：这是一次没有请求方在等的服务端动作，没有人能收到这个错误，
   * 唯一有意义的做法是把它留在日志里，同时让界面上的「等待中」状态继续有效。
   */
  receiver.onReceived = (upload) => {
    void persistAppSnapshot(upload.requirementId, upload)
      .then((result) => hooks.onAppSnapshotReceived?.({ ...result, requirementId: upload.requirementId }))
      .catch((error: unknown) => {
        console.error('[acceptance] 常驻接收落盘失败：', (error as Error).message);
      });
  };

  /**
   * 巡检并补齐 USB 直传隧道（adb reverse）。
   *
   * 手动时代隧道是点「开始接收（USB直传）」时建的、等到就拆 —— 那时它只需要活过一次等待。
   * 改成常驻等待之后，隧道必须**一直活着**：手机侧判断「USB 直传可不可行」探的就是这条
   * 隧道（`127.0.0.1:23458`），它不存在的话每次都被判不可行，用户就只能走局域网，
   * 而「插着线却总走 WiFi」这件事从界面上完全看不出来。
   * 设备重插、adb server 重启都会让映射消失，所以定期补一次 —— 纯幂等操作。
   */
  const ensureUsbReverses = async (): Promise<void> => {
    const devices = await listAndroidDevices().catch(() => [] as AndroidDeviceInfo[]);
    const port = receiver.info().port;
    for (const device of devices.filter((item) => item.state === 'device')) {
      await ensureAndroidAcceptanceReverse(device.serial, port).catch(() => {});
    }
  };

  const setUsbReverseKeepAlive = (active: boolean): void => {
    if (usbReverseTimer) clearInterval(usbReverseTimer);
    usbReverseTimer = null;
    if (!active) return;
    void ensureUsbReverses();
    usbReverseTimer = setInterval(() => void ensureUsbReverses(), USB_REVERSE_KEEPALIVE_MS);
    usbReverseTimer.unref?.();
  };

  /**
   * 常驻等待登记：验收页打开某个需求时调用，传 null（离开需求页）即撤销。
   *
   * 用一条独立通道而不是复用 `verify:capture-android`：那条通道的语义是「立靶 + 等一份」，
   * 会挂住一个 Promise 直到上传到达或超时；常驻等待没有任何人在等，两者混在一起会让
   * 「界面切走了，可旧的那个等待还活着」这类竞态无处安放。
   */
  ipcMain.handle(
    'verify:acceptance-standby',
    (_event, requirementId: string | null): AcceptanceReceiverInfo => {
      const info = receiver.setStandbyTarget(requirementId);
      setUsbReverseKeepAlive(receiver.standbyTarget() !== null);
      return info;
    },
  );

  ipcMain.handle('verify:snapshot-rename', (_event, input: RenameSnapshotInput): Promise<void> =>
    mutateOwningRequirement(input.snapshotId, (requirement: RequirementMeta) => {
      const snapshot = requirement.appSnapshots.find((item) => item.id === input.snapshotId);
      if (snapshot) snapshot.label = input.label.trim() || snapshot.label;
    }),
  );

  // 删除素材（设计稿 / 截图）。两者语义一致：素材本身 + 引用它的配对 + 那些配对的问题
  ipcMain.handle('verify:design-delete', (_event, input: DeleteAssetInput): Promise<void> =>
    removeAsset(input.requirementId, 'design', input.assetId),
  );

  ipcMain.handle('verify:snapshot-delete', (_event, input: DeleteAssetInput): Promise<void> =>
    removeAsset(input.requirementId, 'app', input.assetId),
  );

  ipcMain.handle('verify:pair-save', (_event, input: SavePairInput): Promise<MatchPairMeta> =>
    mutateRequirement(input.requirementId, (requirement: RequirementMeta): MatchPairMeta =>
      applyPairSave(requirement, input),
    ),
  );

  ipcMain.handle('verify:pair-delete', (_event, id: string): Promise<void> =>
    mutateOwningRequirement(id, (requirement) => {
      requirement.pairs = requirement.pairs.filter((pair) => pair.id !== id);
      requirement.issues = requirement.issues.filter((issue) => issue.pairId !== id);
    }),
  );

  ipcMain.handle('verify:canvas-capture', async (event, bounds: CanvasCaptureBounds) => {
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
      throw new Error('画布截取区域无效');
    }
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.width > 8192 || bounds.height > 8192) {
      throw new Error('画布截取区域尺寸无效');
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) throw new Error('验收窗口不可用');
    const image = await window.webContents.capturePage({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    const png = image.toPNG();
    const size = image.getSize();
    return {
      dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
      width: size.width,
      height: size.height,
    };
  });

  ipcMain.handle('verify:issue-save', async (_event, input: SaveIssueInput): Promise<Issue> => {
    const requirement = await getRequirement(input.requirementId);
    if (!requirement) throw new Error('需求不存在');
    const existing = input.id ? requirement.issues.find((issue) => issue.id === input.id) : undefined;
    const issueId = existing?.id ?? createId();
    let image: Issue['image'] | undefined;
    if (input.image) {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.image.dataUrl);
      if (!match) throw new Error('问题图片格式无效');
      const bytes = Buffer.from(match[1], 'base64');
      if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) {
        throw new Error('问题图片大小无效');
      }
      const decoded = nativeImage.createFromBuffer(bytes);
      const size = decoded.getSize();
      if (size.width <= 0 || size.height <= 0) throw new Error('问题图片尺寸无效');
      await writeBinaryAtomic(issueImagePath(input.requirementId, issueId), bytes);
      image = { fileName: 'capture.png', width: size.width, height: size.height };
    } else if (input.image === null && existing?.image) {
      await rm(issueImagePath(input.requirementId, issueId), { force: true });
    }
    return mutateRequirement(input.requirementId, (nextRequirement: RequirementMeta): Issue => {
      if (input.id) {
        const saved = nextRequirement.issues.find((issue) => issue.id === input.id);
        if (saved) {
          saved.severity = input.severity;
          saved.description = input.description;
          if (input.image !== undefined) saved.image = image;
          saved.position = input.position;
          saved.nodeId = input.nodeId;
          if (input.designNodeId !== undefined) saved.designNodeId = input.designNodeId;
          if (input.appNodeId !== undefined) saved.appNodeId = input.appNodeId;
          saved.source = input.source;
          return saved;
        }
      }
      const issue: Issue = {
        id: issueId,
        requirementId: input.requirementId,
        pairId: input.pairId,
        source: input.source,
        position: input.position,
        nodeId: input.nodeId,
        designNodeId: input.designNodeId ?? null,
        appNodeId: input.appNodeId ?? null,
        severity: input.severity,
        description: input.description,
        ...(image ? { image } : {}),
        status: 'open',
        createdAt: timestamp(),
      };
      requirement.issues.push(issue);
      return issue;
    });
  });

  ipcMain.handle('verify:issue-delete', async (_event, id: string): Promise<void> => {
    const requirements = await listRequirements();
    const owner = requirements.find((requirement) => requirement.issues.some((issue) => issue.id === id));
    await mutateOwningRequirement(id, (requirement) => {
      requirement.issues = requirement.issues.filter((issue) => issue.id !== id);
    });
    if (owner) await rm(issueImagePath(owner.id, id), { force: true });
  });

  ipcMain.handle('verify:pairs', async (_event, requirementId: string): Promise<VerifyPairView[]> => {
    const requirement = await getRequirement(requirementId);
    if (!requirement) return [];
    return buildPairViews(requirement);
  });

  /**
   * 配对调试包导出。刻意**不做成「保存到…」对话框**：排查一个需求时通常要连着导好几页，
   * 每次弹窗都要选一遍目录，反而更容易存丢。固定目录 + 返回路径，由界面把路径亮出来。
   */
  ipcMain.handle(
    'verify:export-pair-debug',
    (_event, input: ExportPairDebugInput): Promise<ExportPairDebugResult> => exportPairDebug(input),
  );

  /**
   * 可分享的调试包 ZIP。**走保存对话框**：这份包是用来发出去做真实样本回归的，
   * 落点每次都由用户定；取消时返回 `{ canceled: true }`，渲染层静默收起即可。
   */
  ipcMain.handle(
    'verify:export-debug-bundle',
    (event, input: ExportDebugBundleInput): Promise<ExportDebugBundleResult> =>
      exportDebugBundle(input, BrowserWindow.fromWebContents(event.sender)),
  );

  // ---------- 节点级验收 ----------
  // 这五个通道在 preload 里已经暴露给渲染层，缺一个就是「点了没反应」的静默失败。

  ipcMain.handle('verify:acceptance-readiness', (_event, pairId: string): Promise<AcceptanceReadiness> =>
    acceptance.getReadiness(pairId),
  );

  ipcMain.handle('verify:ai-config-status', (): Promise<AiConfigStatus> => getAiConfigStatus());
  ipcMain.handle('verify:ai-config-save', (_event, input: SaveAiConfigInput): Promise<AiConfigStatus> =>
    saveAiConfig(input));
  ipcMain.handle('verify:ai-config-test', (_event, input: TestAiConfigInput): Promise<AiConnectionTestResult> =>
    testAiConnection(input));

  ipcMain.handle('verify:acceptance-run', (_event, input: RunAcceptanceInput): Promise<AcceptanceRunMeta> =>
    acceptance.runAcceptance(input),
  );

  ipcMain.handle(
    'verify:acceptance-run-get',
    (_event, input: { requirementId: string; runId: string }): Promise<AcceptanceRunMeta | null> =>
      acceptance.getRun(input),
  );

  ipcMain.handle(
    'verify:acceptance-run-history',
    (_event, pairId: string): Promise<AcceptanceRunHistoryItem[]> => acceptance.getHistory(pairId),
  );

  ipcMain.handle('verify:node-mapping-get', (_event, pairId: string): Promise<NodeMapping | null> =>
    acceptance.getMapping(pairId),
  );

  ipcMain.handle('verify:node-mapping-save', (_event, input: SaveNodeMappingInput): Promise<NodeMapping> =>
    acceptance.saveMapping(input),
  );

  // ---------- 人工标注（ground truth） ----------
  // 与上面的 mapping 通道**并行存在**、互不读写：mapping 影响匹配结果，
  // 标注只记录「答案」，引擎永远不读它。详见 types/groundTruth.ts 顶部。

  ipcMain.handle('verify:ground-truth-get', (_event, pairId: string): Promise<GroundTruth | null> =>
    acceptance.getGroundTruth(pairId),
  );

  ipcMain.handle('verify:ground-truth-save', (_event, input: SaveGroundTruthInput): Promise<GroundTruth> =>
    acceptance.saveGroundTruth(input),
  );

  ipcMain.handle(
    'verify:ground-truth-export',
    (_event, input: ExportGroundTruthInput): Promise<ExportGroundTruthResult> =>
      exportGroundTruth(input),
  );
}

/**
 * 配对 / 问题 / 快照的 handler 常常只拿到自己的 id，
 * 需要先反查所属需求才能走需求级事务。抽出来避免重复样板。
 */
async function mutateOwningRequirement(
  entityId: string,
  mutator: (requirement: RequirementMeta) => void,
): Promise<void> {
  const all = await listRequirements();
  for (const requirement of all) {
    const owns =
      requirement.pairs.some((pair) => pair.id === entityId) ||
      requirement.issues.some((issue) => issue.id === entityId) ||
      requirement.designAssets.some((asset) => asset.id === entityId) ||
      requirement.appSnapshots.some((snapshot) => snapshot.id === entityId);
    if (owns) {
      await mutateRequirement(requirement.id, mutator);
      return;
    }
  }
}
