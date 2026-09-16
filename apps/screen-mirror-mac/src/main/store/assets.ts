/**
 * 素材读盘：把落盘的原始 schema / 节点表还原成扁平节点数组。
 *
 * 为什么单独成模块：`verifyIpc`（画布视图）与 `acceptance/service`（验收引擎）
 * 都要读同一份数据。**同一份几何算两处迟早分叉** ——
 * 画布上看到的位置和验收算出的位置必须来自同一个 loader。
 */

import path from 'node:path';

import {
  flattenFigmaTree,
  markAppHitShields,
  type AppNode,
  type AppSnapshotMeta,
  type DesignAssetMeta,
  type DesignNode,
} from '../../types/verify';
import type { FigmaFrameSchema } from '../../types/figma';

import { readJsonSafe } from './atomic';
import { appSnapshotDir, designAssetDir } from './paths';

/** 读设计稿节点：schema.json 原样留存 → 读时解析并拍平成扁平表 */
export async function loadDesignNodes(requirementId: string, asset: DesignAssetMeta): Promise<DesignNode[]> {
  const file = path.join(designAssetDir(requirementId, asset.id), asset.schemaFile);
  const schema = await readJsonSafe<FigmaFrameSchema>(file);
  if (!schema?.tree) return [];
  return flattenFigmaTree(schema.tree);
}

/**
 * 读 App 节点：端上 dump 的扁平表 + **命中盾牌标注**。
 *
 * `markAppHitShields` 放在 loader 里而不是渲染层：画布（verifyIpc）与验收引擎
 * （acceptance/service）都读这一个函数，标不标盾牌才不会出现「画布点不到、
 * 引擎却拿它当节点」的分叉。老快照没有 `hitShield` 字段，标注是幂等的 ——
 * 重新读盘就会补上，不需要重新采集。
 */
export async function loadAppNodes(requirementId: string, snapshot: AppSnapshotMeta): Promise<AppNode[]> {
  const file = path.join(appSnapshotDir(requirementId, snapshot.id), snapshot.nodesFile);
  const raw = (await readJsonSafe<AppNode[]>(file)) ?? [];
  return markAppHitShields(raw);
}

/** 设计稿截图的绝对路径（视觉特征要从这里裁切） */
export function designScreenshotPath(requirementId: string, asset: DesignAssetMeta): string {
  return path.join(designAssetDir(requirementId, asset.id), asset.screenshotFile);
}

export function appScreenshotPath(requirementId: string, snapshot: AppSnapshotMeta): string {
  return path.join(appSnapshotDir(requirementId, snapshot.id), snapshot.screenshotFile);
}
