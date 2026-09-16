/**
 * 缩略图生成。
 *
 * 用 Electron 自带的 `nativeImage` 而不是 sharp —— 零额外依赖、零原生编译，
 * 代价是只能在主进程用（正好本模块也只在主进程跑）。
 */

import { nativeImage } from 'electron';

import { writeBinaryAtomic } from '../store/atomic';

const THUMB_WIDTH = 200;

/**
 * 由图片生成 200px 宽的缩略图并落盘。
 *
 * ⚠️ `createFromPath` 在读取失败时返回**空 image**（不抛错），
 * 此时 `resize`/`toPNG` 都返回空缓冲，会静默写出一个 0 字节文件。
 * 所以必须先判 `isEmpty()`。
 *
 * 只传 `width` 时 Electron 会**保持长宽比**；
 * `quality` 默认是 `'best'`（对整屏大图偏慢），批量导入显式降到 `'good'`。
 */
export async function writeThumbnail(sourceFile: string, targetFile: string): Promise<void> {
  const image = nativeImage.createFromPath(sourceFile);
  if (image.isEmpty()) {
    throw new Error(`生成缩略图失败：无法读取图片 ${sourceFile}`);
  }

  const resized = image.resize({ width: THUMB_WIDTH, quality: 'good' });
  await writeBinaryAtomic(targetFile, resized.toPNG());
}
