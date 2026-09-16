/**
 * 验收工作流的 IPC 层：把存储层 / 导入管线 / 采集模块接到渲染层。
 *
 * 约定（沿用主进程既有经验）：**handler 不能返回 BrowserWindow 等不可结构化克隆的对象**，
 * 否则 `invoke` 会直接 reject 且错误信息很难定位。这里统一只返回纯数据。
 */

import { dialog, ipcMain } from 'electron';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeTextSamples,
  type AppSnapshotMeta,
  type DesignAssetMeta,
  type Issue,
  type MatchPairMeta,
  type RequirementMeta,
} from '../types/verify';
import type { AcceptanceReceiverInfo } from '../types/acceptance';
import type {
  AcceptanceReadiness,
  AcceptanceRunMeta,
  NodeMapping,
  RunAcceptanceInput,
  SaveNodeMappingInput,
} from '../types/aiAcceptance';
import type {
  AndroidCaptureResult,
  AndroidDeviceInfo,
  CaptureAndroidInput,
  CreateRequirementInput,
  DeleteAssetInput,
  ImportFigmaInput,
  ImportResult,
  RenameSnapshotInput,
  SaveIssueInput,
  SavePairInput,
  VerifyPairView,
} from '../types/ipc';

import { listAndroidDevices, receiveAndroidSnapshot } from './capture/androidCapture';
import { AcceptanceReceiver } from './capture/acceptanceReceiver';
import { createAcceptanceService } from './acceptance/service';
import { importFigmaPackage } from './importer/figmaImport';
import { writeThumbnail } from './importer/thumb';
import { assetUrl } from './protocol';
import { writeBinaryAtomic, writeJsonAtomic } from './store/atomic';
import { loadAppNodes, loadDesignNodes } from './store/assets';
import { appSnapshotDir, designAssetDir } from './store/paths';
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
  if (app) return `${app.platform === 'ios' ? 'iOS' : 'Android'} ${app.device ?? ''}`.trim();
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

export function registerVerifyIpc(receiver: AcceptanceReceiver): void {
  const acceptance = createAcceptanceService();

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
    (): void => receiver.cancelWait(),
  );

  ipcMain.handle(
    'verify:capture-android',
    async (_event, request: CaptureAndroidInput): Promise<AndroidCaptureResult> => {
      // 立靶 + 等上传是一次调用：靶是「这份快照算哪个需求的」唯一依据，
      // 与等待分开会出现「立了靶但没人接」的中间态 —— 那时上传会被接受却没人落盘。
      const upload = await receiver.waitForUpload({
        requirementId: request.requirementId,
        ttlMs: request.ttlMs,
      });
      const output = receiveAndroidSnapshot(upload);

      const snapshotId = createId();
      const dir = appSnapshotDir(request.requirementId, snapshotId);

      const screenshotName = 'screenshot.png';
      const screenshotPath = path.join(dir, screenshotName);
      await writeBinaryAtomic(screenshotPath, output.screenshot);

      const nodesFile = 'nodes.json';
      await writeJsonAtomic(path.join(dir, nodesFile), output.nodes);

      await writeThumbnail(screenshotPath, path.join(dir, 'thumb.png'));

      const meta: AppSnapshotMeta = {
        id: snapshotId,
        requirementId: request.requirementId,
        platform: 'android',
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
        // 默认名给个有信息量的（前台包名/机型），UI 同学再改成页面名
        label: output.packageName ?? output.deviceModel ?? 'Android 截图',
        source: 'sdk',
        captureId: output.captureId,
        collectionQuality: output.collection,
        coordinateInset: output.coordinateInset,
        capturedAt: timestamp(),
        foregroundPackage: output.packageName,
      };

      await writeJsonAtomic(path.join(dir, 'meta.json'), meta);

      // 先写文件、后写索引
      await mutateRequirement(request.requirementId, (requirement: RequirementMeta) => {
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

  ipcMain.handle('verify:issue-save', (_event, input: SaveIssueInput): Promise<Issue> =>
    mutateRequirement(input.requirementId, (requirement: RequirementMeta): Issue => {
      if (input.id) {
        const existing = requirement.issues.find((issue) => issue.id === input.id);
        if (existing) {
          existing.category = input.category;
          existing.severity = input.severity;
          existing.description = input.description;
          existing.position = input.position;
          existing.nodeId = input.nodeId;
          existing.source = input.source;
          return existing;
        }
      }
      const issue: Issue = {
        id: createId(),
        requirementId: input.requirementId,
        pairId: input.pairId,
        source: input.source,
        position: input.position,
        nodeId: input.nodeId,
        category: input.category,
        severity: input.severity,
        description: input.description,
        status: 'open',
        createdAt: timestamp(),
      };
      requirement.issues.push(issue);
      return issue;
    }),
  );

  ipcMain.handle('verify:issue-delete', (_event, id: string): Promise<void> =>
    mutateOwningRequirement(id, (requirement) => {
      requirement.issues = requirement.issues.filter((issue) => issue.id !== id);
    }),
  );

  ipcMain.handle('verify:pairs', async (_event, requirementId: string): Promise<VerifyPairView[]> => {
    const requirement = await getRequirement(requirementId);
    if (!requirement) return [];
    return buildPairViews(requirement);
  });

  // ---------- 节点级验收 ----------
  // 这五个通道在 preload 里已经暴露给渲染层，缺一个就是「点了没反应」的静默失败。

  ipcMain.handle('verify:acceptance-readiness', (_event, pairId: string): Promise<AcceptanceReadiness> =>
    acceptance.getReadiness(pairId),
  );

  ipcMain.handle('verify:acceptance-run', (_event, input: RunAcceptanceInput): Promise<AcceptanceRunMeta> =>
    acceptance.runAcceptance(input),
  );

  ipcMain.handle(
    'verify:acceptance-run-get',
    (_event, input: { requirementId: string; runId: string }): Promise<AcceptanceRunMeta | null> =>
      acceptance.getRun(input),
  );

  ipcMain.handle('verify:node-mapping-get', (_event, pairId: string): Promise<NodeMapping | null> =>
    acceptance.getMapping(pairId),
  );

  ipcMain.handle('verify:node-mapping-save', (_event, input: SaveNodeMappingInput): Promise<NodeMapping> =>
    acceptance.saveMapping(input),
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
