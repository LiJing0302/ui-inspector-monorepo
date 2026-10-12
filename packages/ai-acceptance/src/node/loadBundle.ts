/**
 * Node 侧：debug bundle 加载（M1–M4 的 I/O 入口，不属于纯核心）
 *
 * 支持两种输入：
 *   - 目录（已解包）
 *   - .zip（用系统 `unzip` 解到临时目录后按目录处理）
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AcceptanceInput, AppNode, BundleMeta, DesignNode, ImageRef, PixelImage } from '../types.ts';
import { decodePng } from './pngSampler.ts';

export interface LoadedBundle {
  dir: string;
  input: AcceptanceInput;
  /** 是否用了临时目录（退出时清理） */
  temp: string | null;
}

export function loadBundle(pathArg: string): LoadedBundle {
  let dir = resolve(pathArg);
  let temp: string | null = null;

  if (pathArg.toLowerCase().endsWith('.zip')) {
    temp = mkdtempSync(join(tmpdir(), 'ai-acceptance-'));
    execFileSync('unzip', ['-o', '-q', dir, '-d', temp], { stdio: 'pipe' });
    dir = temp;
  }

  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) {
    throw new Error(`meta.json 不存在：${metaPath}（需要一个 debug bundle 目录或 .zip）`);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as BundleMeta;

  const designNodes = JSON.parse(readFileSync(join(dir, 'design', 'nodes.json'), 'utf8')) as DesignNode[];
  const appNodes = JSON.parse(readFileSync(join(dir, 'app', 'nodes.json'), 'utf8')) as AppNode[];

  const designImage = imageRef(join(dir, 'design', 'screenshot.png'), meta.design.pixelWidth, meta.design.pixelHeight);
  const appImage = imageRef(join(dir, 'app', 'screenshot.png'), meta.app.pixelWidth, meta.app.pixelHeight);

  return {
    dir,
    temp,
    input: { meta, designNodes, appNodes, designImage: designImage ?? undefined, appImage: appImage ?? undefined },
  };
}

/** 截图惰性加载器（`fromWorkspace.ts` 复用同一份实现，不重复造） */
export function imageRef(file: string, w?: number, h?: number): ImageRef | null {
  if (!existsSync(file)) return null;
  return {
    width: w ?? 0,
    height: h ?? 0,
    load: async (): Promise<PixelImage> => decodePng(readFileSync(file)),
  };
}

export function cleanupBundle(loaded: LoadedBundle): void {
  if (loaded.temp) {
    try {
      rmSync(loaded.temp, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

/** 把内存里的 bundle 写盘（供测试/夹具使用） */
export function writeBundle(dir: string, input: AcceptanceInput): void {
  mkdirSync(join(dir, 'design'), { recursive: true });
  mkdirSync(join(dir, 'app'), { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(input.meta, null, 2));
  writeFileSync(join(dir, 'design', 'nodes.json'), JSON.stringify(input.designNodes, null, 2));
  writeFileSync(join(dir, 'app', 'nodes.json'), JSON.stringify(input.appNodes, null, 2));
}
