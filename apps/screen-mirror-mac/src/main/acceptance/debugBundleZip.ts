/**
 * 调试包 ZIP 的纯组装：输入全是内存数据，不碰磁盘、不弹窗、不依赖 electron，可单测。
 *
 * 截图以 `Buffer | null` 传入 —— null 表示源文件不在盘上，记入 `missing` 而不中断。
 */

import JSZip from 'jszip';

export interface DebugBundleParts {
  requirement: { id: string; name: string };
  pair: { id: string };
  design: {
    assetId: string;
    name: string;
    width: number;
    height: number;
    pixelWidth: number | null;
    pixelHeight: number | null;
    exportScale: number;
    nodeCount: number;
  };
  app: {
    snapshotId: string;
    name: string;
    platform: string;
    device: string | null;
    osVersion: string | null;
    width: number;
    height: number;
    pixelWidth: number;
    pixelHeight: number;
    scaleX: number | null;
    scaleY: number | null;
    densityDpi: number | null;
    nodeCount: number;
    collectionQuality: unknown | null;
  };
  designNodes: unknown[];
  appNodes: unknown[];
  mapping: unknown | null;
  groundTruth: unknown | null;
  designScreenshot: Buffer | null;
  appScreenshot: Buffer | null;
}

export interface BuiltDebugBundle {
  payload: Buffer;
  /** 包内实际装入的文件清单 */
  files: string[];
  /** 缺失的文件清单（截图不在盘上） */
  missing: string[];
}

export async function buildDebugBundleZip(parts: DebugBundleParts): Promise<BuiltDebugBundle> {
  const missing: string[] = [];
  const files: string[] = [];
  const zip = new JSZip();
  const addJson = (zipPath: string, value: unknown): void => {
    zip.file(zipPath, `${JSON.stringify(value, null, 2)}\n`);
    files.push(zipPath);
  };
  const addBinary = (zipPath: string, data: Buffer | null): void => {
    if (data) {
      zip.file(zipPath, data);
      files.push(zipPath);
    } else {
      // 截图可能被清理过：记缺失、不中断，节点侧回归照样可用
      missing.push(zipPath);
    }
  };

  addJson('design/nodes.json', parts.designNodes);
  addJson('app/nodes.json', parts.appNodes);
  addBinary('design/screenshot.png', parts.designScreenshot);
  addBinary('app/screenshot.png', parts.appScreenshot);
  if (parts.mapping) addJson('mapping.json', parts.mapping);
  if (parts.groundTruth) addJson('ground-truth.json', parts.groundTruth);

  // meta.json 的 files 清单包含自身：先占位再写，避免 addJson 的 push 顺序导致清单少一项
  files.push('meta.json');
  zip.file(
    'meta.json',
    `${JSON.stringify(
      {
        kind: 'ui-acceptance-debug-bundle',
        version: 1,
        exportedAt: new Date().toISOString(),
        requirement: parts.requirement,
        pair: parts.pair,
        design: parts.design,
        app: parts.app,
        files,
        missing,
      },
      null,
      2,
    )}\n`,
  );

  const payload = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { payload, files, missing };
}

