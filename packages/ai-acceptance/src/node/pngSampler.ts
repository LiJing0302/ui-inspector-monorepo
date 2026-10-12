/**
 * Node 侧：PNG 解码 + 像素采样器（M4 的 I/O 实现）
 *
 * 纯核心只依赖 `Sampler` 接口；这里用 pngjs 把 PNG 变成 RGBA 缓冲。
 * 之所以必须走像素通道：**App 侧盒样式覆盖率只有 9%**（46/494），
 * 颜色/圆角/描边根本无法从节点树判定（报告 §1.1 / §5.2）。
 */

import pkg from 'pngjs';
import type { PixelImage } from '../types.ts';
import type { Sampler } from '../pixel.ts';

const { PNG } = pkg as unknown as { PNG: { sync: { read(b: Uint8Array): { width: number; height: number; data: Uint8Array } } } };

export function decodePng(buf: Uint8Array): PixelImage {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

export class PngSampler implements Sampler {
  readonly width: number;
  readonly height: number;
  private readonly img: PixelImage;

  constructor(img: PixelImage) {
    this.img = img;
    this.width = img.width;
    this.height = img.height;
  }

  /** 越界返回 null（调用方据此判断"没有像素证据"） */
  pixel(x: number, y: number): [number, number, number, number] | null {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return null;
    const i = (yi * this.width + xi) * 4;
    const d = this.img.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }
}

export function samplerFromPng(buf: Uint8Array): PngSampler {
  return new PngSampler(decodePng(buf));
}
