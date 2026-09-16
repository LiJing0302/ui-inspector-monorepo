/**
 * Figma 导出包的读取抽象：**zip 与文件夹用同一套接口**。
 *
 * 这样导入管线只有一条，两条来源链路的行为天然一致
 * （插件直传导出 zip，用户本地也可能直接把导出的文件夹拖进来）。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import JSZip from 'jszip';

export interface FigmaPackage {
  /** 包名：zip 文件名或文件夹名（不含扩展名） */
  name: string;
  /** 包内所有文件的相对路径，统一用 `/` 分隔 */
  entries: string[];
  /** 读取文件内容；不存在返回 null */
  read(relPath: string): Promise<Uint8Array | null>;
}

/** 统一成 `/` 分隔的相对路径（manifest 里的引用也是这种形式） */
function normalizeRelative(relative: string): string {
  return relative.split(path.sep).join('/').replace(/^\/+/, '');
}

/**
 * 校验包内条目路径安全：拒绝绝对路径与上跳。
 *
 * zip 是**不可信输入**（可能来自网络或他人），必须防路径穿越 ——
 * 否则 `../../..` 这类条目会让我们把文件写到 workspace 之外。
 */
function assertSafeEntry(entry: string): void {
  if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry)) {
    throw new Error(`包内存在绝对路径条目，已拒绝：${entry}`);
  }
  const segments = entry.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`包内存在上跳路径条目，已拒绝：${entry}`);
  }
}

async function openFolder(sourcePath: string): Promise<FigmaPackage> {
  const entries: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        await walk(path.join(dir, item.name), rel);
      } else if (item.isFile()) {
        // 跳过 macOS 打包常见的元数据噪声
        if (item.name === '.DS_Store') continue;
        entries.push(rel);
      }
    }
  };

  await walk(sourcePath, '');

  return {
    name: path.basename(sourcePath),
    entries,
    async read(relPath: string): Promise<Uint8Array | null> {
      assertSafeEntry(relPath);
      const absolute = path.join(sourcePath, ...relPath.split('/'));
      try {
        const buffer = await readFile(absolute);
        return new Uint8Array(buffer);
      } catch {
        return null;
      }
    },
  };
}

/**
 * 从**内存字节流**打开 zip 包。
 *
 * 插件直传链路用的是这一条：Figma 插件通过 WebSocket 把 zip 推过来，
 * 全程不落磁盘中间文件。两条链路（磁盘 / 网络）之后走的是同一段校验与写入代码，
 * 所以"插件直传"和"手动拖入"的结果必然一致 —— 不会有一套逻辑偷偷跑偏。
 *
 * @param name 包名（不含扩展名），仅用于日志与元数据
 */
export async function openZipBuffer(buffer: Uint8Array, name: string): Promise<FigmaPackage> {
  const zip = await JSZip.loadAsync(buffer);

  const entries: string[] = [];
  zip.forEach((relativePath, entry) => {
    const rel = normalizeRelative(relativePath);
    if (entry.dir) return;
    assertSafeEntry(rel);
    entries.push(rel);
  });

  return {
    name,
    entries,
    async read(relPath: string): Promise<Uint8Array | null> {
      assertSafeEntry(relPath);
      const entry = zip.file(relPath);
      if (!entry) return null;
      return entry.async('uint8array');
    },
  };
}

async function openZip(sourcePath: string): Promise<FigmaPackage> {
  const buffer = await readFile(sourcePath);
  return openZipBuffer(buffer, path.basename(sourcePath).replace(/\.zip$/i, ''));
}

/** 打开导出包；自动识别 zip 与文件夹 */
export async function openFigmaPackage(sourcePath: string): Promise<FigmaPackage> {
  const info = await stat(sourcePath).catch(() => null);
  if (!info) throw new Error(`找不到路径：${sourcePath}`);

  if (info.isDirectory()) return openFolder(sourcePath);
  if (/\.zip$/i.test(sourcePath)) return openZip(sourcePath);

  throw new Error('只支持插件导出的 .zip 文件或导出文件夹');
}

/** 在包内按条目名查找：优先精确匹配，再回退到「按文件名匹配」（容忍目录层级差异） */
export function findEntry(entries: string[], reference: string): string | null {
  const target = normalizeRelative(reference);
  const exact = entries.find((entry) => entry === target);
  if (exact) return exact;

  const basename = target.split('/').pop();
  if (!basename) return null;
  const matches = entries.filter((entry) => entry.split('/').pop() === basename);
  // 多个同名时不猜，交给调用方报错
  return matches.length === 1 ? matches[0]! : null;
}
