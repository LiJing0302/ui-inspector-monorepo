/**
 * Figma 导出包导入管线。
 *
 * **两条来源链路（zip / 文件夹）共用同一条管线**，只在 `openFigmaPackage` 处分叉，
 * 保证行为一致。
 *
 * 核心原则：**不允许半入库**。
 * 所有校验与读取都在写入任何文件**之前**完成；只要有一帧不合格，整包拒绝，
 * 并指出**具体是哪一帧、什么原因**。否则用户会得到一个「看起来导入成功、
 * 实际少了一半页面」的库，比直接失败更糟。
 */

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { nativeImage } from 'electron';

import {
  FIGMA_SCHEMA_VERSION,
  isFrameLevelExport,
  type FigmaFrameSchema,
  type FigmaManifest,
} from '../../types/figma';
import type { DesignAssetMeta, RequirementMeta } from '../../types/verify';
import { flattenFigmaTree, normalizeTextSamples } from '../../types/verify';
import type { ConflictPolicy, ImportFrameResult, ImportResult } from '../../types/ipc';
import { writeBinaryAtomic, writeFileAtomic, writeJsonAtomic } from '../store/atomic';
import { designAssetDir } from '../store/paths';
import { createId, getRequirement, mutateRequirement, timestamp } from '../store/workspace';
import { findEntry, openFigmaPackage, openZipBuffer, type FigmaPackage } from './package';
import { writeThumbnail } from './thumb';

/** 唯一键：`pageId + frameId`（manifest.fileKey 实测为 null，不可依赖） */
function frameKeyOf(pageId: string | undefined, frameId: string): string {
  return `${pageId ?? ''}::${frameId}`;
}

interface PreparedFrame {
  meta: FigmaManifest['frames'][number];
  frameKey: string;
  schema: FigmaFrameSchema;
  schemaBytes: Uint8Array;
  screenshotBytes: Uint8Array;
  /** 截图扩展名（含点），如 `.png` */
  ext: string;
  isFrameLevel: boolean;
  /** 归一化文本指纹，供页面匹配用 */
  textSamples: string[];
}

function decodeJson<T>(bytes: Uint8Array, label: string): T {
  let text: string;
  try {
    text = new TextDecoder('utf-8').decode(bytes);
  } catch {
    throw new Error(`${label} 不是合法的 UTF-8 文本`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${(error as Error).message}`);
  }
}

async function readManifest(pkg: FigmaPackage): Promise<{ manifest: FigmaManifest; entry: string }> {
  const entry = findEntry(pkg.entries, 'manifest.json');
  if (!entry) {
    throw new Error('包内找不到 manifest.json —— 请确认导入的是 Figma 插件导出的包');
  }
  const bytes = await pkg.read(entry);
  if (!bytes) throw new Error('manifest.json 读取失败');

  const manifest = decodeJson<FigmaManifest>(bytes, 'manifest.json');
  if (!Array.isArray(manifest.frames)) {
    throw new Error('manifest.json 缺少 frames 数组');
  }
  if (manifest.schemaVersion !== FIGMA_SCHEMA_VERSION) {
    throw new Error(
      `schema 版本不匹配：包为 ${String(manifest.schemaVersion)}，本工具支持 ${FIGMA_SCHEMA_VERSION}。请升级插件后重新导出`,
    );
  }
  return { manifest, entry };
}

/** 逐帧读取并校验；任何一帧不合格都抛错（整包拒绝） */
async function prepareFrames(pkg: FigmaPackage, manifest: FigmaManifest): Promise<PreparedFrame[]> {
  if (manifest.frames.length === 0) {
    throw new Error('该包不包含任何导出单元');
  }

  const prepared: PreparedFrame[] = [];

  for (const meta of manifest.frames) {
    const label = `「${meta.name}」`;

    const schemaEntry = findEntry(pkg.entries, meta.schemaFile);
    if (!schemaEntry) {
      throw new Error(`帧 ${label} 的 schema 文件缺失：${meta.schemaFile}`);
    }
    const schemaBytes = await pkg.read(schemaEntry);
    if (!schemaBytes) {
      throw new Error(`帧 ${label} 的 schema 文件读取失败：${meta.schemaFile}`);
    }
    const schema = decodeJson<FigmaFrameSchema>(schemaBytes, `帧 ${label} 的 schema`);
    if (!schema.tree) {
      throw new Error(`帧 ${label} 的 schema 缺少 tree（节点树）`);
    }

    const screenshotEntry = findEntry(pkg.entries, meta.screenshot);
    if (!screenshotEntry) {
      throw new Error(`帧 ${label} 的截图缺失：${meta.screenshot}`);
    }
    const screenshotBytes = await pkg.read(screenshotEntry);
    if (!screenshotBytes || screenshotBytes.byteLength === 0) {
      throw new Error(`帧 ${label} 的截图读取失败或为空：${meta.screenshot}`);
    }

    const ext = path.extname(screenshotEntry).toLowerCase() || '.png';
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
      throw new Error(`帧 ${label} 的截图格式不支持：${ext}`);
    }

    // 文本指纹：先拍平再取 TEXT 节点的 characters，供页面匹配算重合度
    const flatNodes = flattenFigmaTree(schema.tree);
    const textSamples = normalizeTextSamples(
      flatNodes.map((node) => (node.type === 'TEXT' ? node.text?.characters : null)),
    );

    prepared.push({
      meta,
      frameKey: frameKeyOf(meta.pageId, meta.id),
      schema,
      schemaBytes,
      screenshotBytes,
      ext,
      // 只有帧级导出才当整页设计稿；元素级导出照收但打标
      isFrameLevel: isFrameLevelExport(schema.rootType || meta.type),
      textSamples,
    });
  }

  return prepared;
}

/** 写入单个帧的全部文件，返回元数据 */
async function writeFrame(
  requirementId: string,
  frame: PreparedFrame,
  assetId: string,
  packageName: string,
): Promise<DesignAssetMeta> {
  const dir = designAssetDir(requirementId, assetId);
  await mkdir(dir, { recursive: true });

  // schema 原样留存：格式升级时可重放，无需重新采集
  await writeFileAtomic(path.join(dir, 'schema.json'), frame.schemaBytes);

  const screenshotName = `screenshot${frame.ext}`;
  const screenshotPath = path.join(dir, screenshotName);
  await writeBinaryAtomic(screenshotPath, frame.screenshotBytes);

  await writeThumbnail(screenshotPath, path.join(dir, 'thumb.png'));

  const size = nativeImage.createFromPath(screenshotPath).getSize();

  const meta: DesignAssetMeta = {
    id: assetId,
    requirementId,
    frameId: frame.meta.id,
    frameKey: frame.frameKey,
    name: frame.meta.name,
    type: frame.schema.rootType || frame.meta.type,
    path: frame.meta.path,
    pageId: frame.meta.pageId,
    pageName: frame.meta.pageName,
    width: frame.meta.width,
    height: frame.meta.height,
    exportScale: frame.schema.exportScale || 1,
    pixelWidth: size.width || undefined,
    pixelHeight: size.height || undefined,
    isFrameLevel: frame.isFrameLevel,
    schemaFile: 'schema.json',
    screenshotFile: screenshotName,
    thumbnailFile: 'thumb.png',
    nodeCount: frame.schema.nodeCount ?? frame.meta.nodeCount ?? 0,
    textSamples: frame.textSamples,
    source: 'local-import',
    importedAt: timestamp(),
    packageName,
  };

  await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
  return meta;
}

/**
 * 导入的核心：**所有来源链路（本地 zip / 本地文件夹 / 插件直传字节流）最终都汇到这里**。
 *
 * 执行顺序（刻意如此）：
 *   1. 全量校验（失败则整包拒绝，**此时尚未写任何文件**）
 *   2. 读一次需求，判定每帧是新增 / 覆盖 / 跳过
 *   3. 写真实文件（schema / 截图 / 缩略图 / meta）
 *   4. **最后一次**事务：按 frameKey upsert 索引
 * 这样「索引里有的，文件一定在」，且只有一个写入索引的点。
 *
 * @param pkg        已打开的导出包（来源无关）
 * @param sourcePath 仅用于结果里回显来源（本地路径 / `figma-plugin:<文件名>`）
 * @param conflict   重复 frame 的处理策略：`skip` 跳过 / `replace` 覆盖
 */
async function runImport(
  requirementId: string,
  pkg: FigmaPackage,
  sourcePath: string,
  conflict: ConflictPolicy,
): Promise<ImportResult> {
  let declaredFileName = '';
  let prepared: PreparedFrame[];
  try {
    const { manifest } = await readManifest(pkg);
    declaredFileName = manifest.fileName || '';
    prepared = await prepareFrames(pkg, manifest);
  } catch (error) {
    // 整包拒绝：此时尚未写入任何文件
    return { packageName: pkg.name, sourcePath, frames: [], fatal: (error as Error).message };
  }

  const requirement = await getRequirement(requirementId);
  if (!requirement) {
    return { packageName: pkg.name, sourcePath, frames: [], fatal: `需求不存在：${requirementId}` };
  }

  const existingByKey = new Map(requirement.designAssets.map((asset) => [asset.frameKey, asset]));
  const results: ImportFrameResult[] = [];
  const succeeded: DesignAssetMeta[] = [];
  const packageName = declaredFileName || pkg.name;

  for (const frame of prepared) {
    const existing = existingByKey.get(frame.frameKey);

    if (existing && conflict === 'skip') {
      results.push({
        frameId: frame.meta.id,
        name: frame.meta.name,
        nodeCount: frame.schema.nodeCount ?? 0,
        width: frame.meta.width,
        height: frame.meta.height,
        status: 'skipped',
        isFrameLevel: frame.isFrameLevel,
        reason: '同 frameId 已存在，按「跳过」处理',
      });
      continue;
    }

    // 覆盖时复用原 id，避免索引里出现指向旧目录的碎片
    const assetId = existing?.id ?? createId();
    if (existing) {
      // 截图扩展名可能变（png↔jpg），先清目录再写，避免残留旧图
      await rm(designAssetDir(requirementId, assetId), { recursive: true, force: true });
    }

    try {
      const meta = await writeFrame(requirementId, frame, assetId, packageName);
      succeeded.push(meta);
      results.push({
        frameId: frame.meta.id,
        name: frame.meta.name,
        nodeCount: meta.nodeCount,
        width: meta.width,
        height: meta.height,
        status: existing ? 'replaced' : 'imported',
        isFrameLevel: meta.isFrameLevel,
      });
    } catch (error) {
      results.push({
        frameId: frame.meta.id,
        name: frame.meta.name,
        nodeCount: frame.schema.nodeCount ?? 0,
        width: frame.meta.width,
        height: frame.meta.height,
        status: 'failed',
        isFrameLevel: frame.isFrameLevel,
        reason: (error as Error).message,
      });
    }
  }

  if (succeeded.length > 0) {
    await mutateRequirement(requirementId, (target: RequirementMeta) => {
      for (const meta of succeeded) {
        const index = target.designAssets.findIndex((asset) => asset.frameKey === meta.frameKey);
        if (index >= 0) target.designAssets[index] = meta;
        else target.designAssets.push(meta);
      }
    });
  }

  return { packageName, sourcePath, frames: results };
}

/**
 * 导入本地导出包：`sourcePath` 为 zip 文件路径或导出文件夹路径。
 * 文件打不开属于「整包拒绝」，此时不会写入任何数据。
 */
export async function importFigmaPackage(
  requirementId: string,
  sourcePath: string,
  conflict: ConflictPolicy,
): Promise<ImportResult> {
  let pkg: FigmaPackage;
  try {
    pkg = await openFigmaPackage(sourcePath);
  } catch (error) {
    return { packageName: '', sourcePath, frames: [], fatal: (error as Error).message };
  }

  return runImport(requirementId, pkg, sourcePath, conflict);
}

/**
 * 导入插件直传来的 zip 字节流。
 *
 * 走的是和 {@link importFigmaPackage} **完全相同**的校验与写入逻辑，
 * 唯一区别是包从内存而不是磁盘来 —— 这样"插件直传"与"手动拖入"
 * 不可能出现行为分叉（否则两条链路迟早会各自长出一套只属于自己的边界）。
 *
 * @param bytes    完整 zip 字节
 * @param fileName 插件侧的 zip 文件名，用于兜底包名与来源回显
 */
export async function importFigmaPackageFromBytes(
  requirementId: string,
  bytes: Uint8Array,
  fileName: string,
  conflict: ConflictPolicy,
): Promise<ImportResult> {
  const sourcePath = `figma-plugin:${fileName}`;

  let pkg: FigmaPackage;
  try {
    pkg = await openZipBuffer(bytes, fileName.replace(/\.zip$/i, '') || 'figma-export');
  } catch (error) {
    return {
      packageName: fileName,
      sourcePath,
      frames: [],
      fatal: `上传的内容不是合法的 zip 包：${(error as Error).message}`,
    };
  }

  return runImport(requirementId, pkg, sourcePath, conflict);
}
