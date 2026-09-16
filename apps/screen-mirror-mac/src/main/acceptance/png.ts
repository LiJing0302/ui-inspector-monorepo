/**
 * 纯 TS 的 PNG 解码器。
 *
 * 为什么不用 Electron 的 `nativeImage`：
 *   1. `toBitmap()` 返回的是**平台相关**的 BGRA 序（Electron 只在 `createFromBitmap`
 *      的入参里承诺 BGRA，没承诺 `toBitmap` 的输出序），颜色通道一旦判错，
 *      DeltaE 全线飘 —— 而「颜色对不对」正是本模块要回答的问题，判据不能有歧义。
 *   2. `nativeImage` 依赖 Electron 运行时，**无法在冒烟测试里断言**。
 *      纯 TS 实现可以在测试里用 zlib 现场编一张 PNG 做往返验证，判据可证。
 *
 * 支持范围刻意收窄到验收链路真正会遇到的形态：
 *   - 位深 8（唯一）
 *   - 颜色类型 0 灰度 / 2 RGB / 4 灰度+Alpha / 6 RGBA
 *   - 非隔行（Adam7 直接判不支持）
 * 调色板（类型 3）、16 位、隔行一律返回 null —— 由调用方降级为
 * 「视觉特征不可用」，而不是猜一个错的颜色出来。
 *
 * 截图来源：设计稿侧是 Figma 导出的 PNG，App 侧是 `adb screencap -p` 的 PNG，
 * 两者都落在支持范围内。
 */

import { inflateSync } from 'node:zlib';

/** RGBA8 位图，行优先，长度恒为 `width * height * 4` */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 每条扫描线的字节数（不含 filter 字节） */
function bytesPerLine(width: number, channels: number): number {
  return width * channels;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 就地反滤波。
 * `raw` 是 inflate 后的连续扫描线（每条前面带 1 字节 filter type），
 * `out` 是复原后的像素字节（行优先）。
 */
function unfilter(raw: Uint8Array, out: Uint8Array, width: number, height: number, channels: number): void {
  const stride = bytesPerLine(width, channels);
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const lineStart = y * stride;
    const previousStart = lineStart - stride;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[rawOffset + x] ?? 0;
      // a = 左邻（同一行前一字节），b = 上邻，c = 左上邻
      const a = x >= channels ? out[lineStart + x - channels]! : 0;
      const b = y > 0 ? out[previousStart + x]! : 0;
      const c = y > 0 && x >= channels ? out[previousStart + x - channels]! : 0;

      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + a;
          break;
        case 2:
          restored = value + b;
          break;
        case 3:
          restored = value + ((a + b) >> 1);
          break;
        case 4:
          restored = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`PNG 扫描线使用了未知的 filter 类型：${filter}`);
      }
      out[lineStart + x] = restored & 0xff;
    }
    rawOffset += stride;
  }
}

/**
 * 解码 PNG。任何不支持的形态都返回 null（不抛），由调用方降级。
 */
export function decodePng(buffer: Uint8Array): RasterImage | null {
  if (buffer.byteLength < 8) return null;
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (buffer[i] !== SIGNATURE[i]) return null;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  let sawIhdr = false;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      buffer[offset + 4]!,
      buffer[offset + 5]!,
      buffer[offset + 6]!,
      buffer[offset + 7]!,
    );
    const dataStart = offset + 8;
    if (dataStart + length > buffer.byteLength) return null;

    if (type === 'IHDR') {
      if (length < 13) return null;
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      bitDepth = buffer[dataStart + 8]!;
      colorType = buffer[dataStart + 9]!;
      interlace = buffer[dataStart + 12]!;
      sawIhdr = true;
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }

    // length + type + data + crc
    offset = dataStart + length + 4;
  }

  if (!sawIhdr || width <= 0 || height <= 0) return null;
  if (bitDepth !== 8) return null;
  if (interlace !== 0) return null;
  if (idat.length === 0) return null;

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) return null;

  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))));
  } catch {
    return null;
  }

  const stride = bytesPerLine(width, channels);
  if (raw.byteLength < (stride + 1) * height) return null;

  const pixels = new Uint8Array(stride * height);
  try {
    unfilter(raw, pixels, width, height, channels);
  } catch {
    return null;
  }

  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (channels === 1) {
      const gray = pixels[source]!;
      data[target] = gray;
      data[target + 1] = gray;
      data[target + 2] = gray;
      data[target + 3] = 255;
    } else if (channels === 2) {
      const gray = pixels[source]!;
      data[target] = gray;
      data[target + 1] = gray;
      data[target + 2] = gray;
      data[target + 3] = pixels[source + 1]!;
    } else if (channels === 3) {
      data[target] = pixels[source]!;
      data[target + 1] = pixels[source + 1]!;
      data[target + 2] = pixels[source + 2]!;
      data[target + 3] = 255;
    } else {
      data[target] = pixels[source]!;
      data[target + 1] = pixels[source + 1]!;
      data[target + 2] = pixels[source + 2]!;
      data[target + 3] = pixels[source + 3]!;
    }
  }

  return { width, height, data };
}
