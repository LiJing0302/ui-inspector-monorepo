/**
 * 原子写工具。
 *
 * 写入走「临时文件 + rename」：`rename` 在同一文件系统内是原子操作，
 * 因此读端要么看到旧内容、要么看到完整的新内容，不会读到写了一半的 JSON。
 * 这对 `index.json` 尤其重要 —— 它是全库唯一权威目录，写坏等于整库不可用。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 原子写文本。文件内容固定 UTF-8。
 * 临时文件与目标同目录（保证同一文件系统，rename 才不会退化成拷贝）。
 */
export async function writeFileAtomic(file: string, content: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, content);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * 读 JSON。文件不存在或内容损坏时返回 null，**不抛** ——
 * 让调用方决定是「首次运行」还是「数据坏了」，避免一处损坏导致整个应用起不来。
 */
export async function readJsonSafe<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 写二进制（截图 / 缩略图） */
export async function writeBinaryAtomic(file: string, data: Uint8Array): Promise<void> {
  await writeFileAtomic(file, data);
}
