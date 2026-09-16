/**
 * 视觉特征的纯函数集合（无 IO、无 Electron 依赖，全部可测）。
 *
 * 设计原则：**能算就算，不能算就返 null**。
 * PLAN 明确要求「缺失字段不按 0 分处理，而是重新归一化可用特征」——
 * 返回 null 表示「这项特征不可用」，由调用方降级；返回 0 会被误读成「极其不像」。
 *
 * 三组判据（阈值同样以常量导出，测试直接断言）：
 *   - 颜色：CIEDE2000（DeltaE00），感知均匀，比 RGB 欧氏距离可靠得多
 *   - 结构：pHash（DCT 低频感知哈希）距离 + SSIM（结构相似度）
 *   - 边缘：dHash（水平梯度哈希），对局部错位更敏感
 */

import type { RasterImage } from './png';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** 颜色判据阈值：≤通过，≤复核，>失败 */
export const DELTA_E_PASS = 3;
export const DELTA_E_REVIEW = 6;
/** pHash 距离阈值（64 位） */
export const PHASH_PASS_DISTANCE = 6;
/** SSIM 阈值 */
export const SSIM_PASS = 0.92;

/** 小于这个边长的裁切区域不参与视觉判定：抗锯齿与压缩噪声会主导结果 */
export const MIN_VISUAL_CROP_PX = 4;

// ---------- 裁切与采样 ----------

/**
 * 按逻辑矩形从位图上裁切。
 * `scale` = 该位图上「每 1 个逻辑单位占多少像素」。
 * 越界只裁掉超出部分；完全越界或宽高归零时返回 null。
 */
export function cropRaster(image: RasterImage, rect: { x: number; y: number; width: number; height: number }, scale: number): RasterImage | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const rawX = Math.round(rect.x * scale);
  const rawY = Math.round(rect.y * scale);
  const rawWidth = Math.round(rect.width * scale);
  const rawHeight = Math.round(rect.height * scale);
  if (rawWidth <= 0 || rawHeight <= 0) return null;

  const x0 = Math.max(0, rawX);
  const y0 = Math.max(0, rawY);
  const x1 = Math.min(image.width, rawX + rawWidth);
  const y1 = Math.min(image.height, rawY + rawHeight);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((y0 + y) * image.width + x0) * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** 平均色。完全透明的像素不参与（否则透明边缘会把颜色拉向黑）。不可用时返回 null。 */
export function averageColor(image: RasterImage): Rgb | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let index = 0; index < image.width * image.height; index += 1) {
    const offset = index * 4;
    if (image.data[offset + 3]! < 16) continue;
    r += image.data[offset]!;
    g += image.data[offset + 1]!;
    b += image.data[offset + 2]!;
    count += 1;
  }
  if (count === 0) return null;
  return { r: r / count, g: g / count, b: b / count };
}

/**
 * 主色：按每通道 4 bit（16 级）分桶，取最拥挤的桶，再在桶内求均值。
 * 比平均色更抗「少量高对比噪点」，适合判断「这块主色对不对」。
 */
export function dominantColor(image: RasterImage): Rgb | null {
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  for (let index = 0; index < image.width * image.height; index += 1) {
    const offset = index * 4;
    if (image.data[offset + 3]! < 16) continue;
    const r = image.data[offset]!;
    const g = image.data[offset + 1]!;
    const b = image.data[offset + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
  }
  let best: { r: number; g: number; b: number; count: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best) return null;
  return { r: best.r / best.count, g: best.g / best.count, b: best.b / best.count };
}

/** 转灰度（Rec.709 亮度权重，与 sRGB 原色空间配套） */
export function toGray(image: RasterImage): Uint8Array {
  const gray = new Uint8Array(image.width * image.height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    const alpha = image.data[offset + 3]! / 255;
    // 透明像素按白底合成：截图里透明=露出页面底色，按黑处理会把结果整体拉暗
    const r = image.data[offset]! * alpha + 255 * (1 - alpha);
    const g = image.data[offset + 1]! * alpha + 255 * (1 - alpha);
    const b = image.data[offset + 2]! * alpha + 255 * (1 - alpha);
    gray[index] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return gray;
}

/**
 * 面积平均缩放（box filter）。
 * 缩小时它是低通滤波，正是感知哈希需要的；放大时退化为最近邻。
 */
export function resizeGray(gray: Uint8Array, width: number, height: number, targetWidth: number, targetHeight: number): Uint8Array | null {
  if (width <= 0 || height <= 0 || targetWidth <= 0 || targetHeight <= 0) return null;
  const out = new Uint8Array(targetWidth * targetHeight);

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = Math.floor((ty * height) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.ceil(((ty + 1) * height) / targetHeight));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = Math.floor((tx * width) / targetWidth);
      const x1 = Math.max(x0 + 1, Math.ceil(((tx + 1) * width) / targetWidth));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < Math.min(y1, height); y += 1) {
        const row = y * width;
        for (let x = x0; x < Math.min(x1, width); x += 1) {
          sum += gray[row + x]!;
          count += 1;
        }
      }
      out[ty * targetWidth + tx] = count === 0 ? 0 : Math.round(sum / count);
    }
  }
  return out;
}

// ---------- 哈希 ----------

const HASH_SIZE = 8;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * dHash：缩到 (size+1)×size，逐行比较相邻像素，左亮于右记 1。
 * 对局部横向错位敏感，用于抓「图标整体挪了位置」这类问题。
 */
export function dHash(image: RasterImage, size = HASH_SIZE): string | null {
  const gray = resizeGray(toGray(image), image.width, image.height, size + 1, size);
  if (!gray) return null;
  let bits = '';
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      bits += gray[y * (size + 1) + x]! > gray[y * (size + 1) + x + 1]! ? '1' : '0';
    }
  }
  return bits;
}

/** 预计算的余弦表（32 点 DCT-II），避免每个节点重复算三角函数 */
const DCT_SIZE = 32;
const DCT_TABLE: Float64Array = (() => {
  const table = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let u = 0; u < DCT_SIZE; u += 1) {
    for (let x = 0; x < DCT_SIZE; x += 1) {
      table[u * DCT_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_SIZE));
    }
  }
  return table;
})();

/**
 * pHash：缩到 32×32 灰度 → 二维 DCT-II → 取左上 8×8 低频块 → 以中位数为阈值出 64 位。
 * 低频块描述的是「大块明暗分布」，所以对压缩噪声和轻微色彩偏移不敏感，
 * 正好用来回答「这里的图/图标还是不是同一个」。
 */
export function pHash(image: RasterImage, size = HASH_SIZE): string | null {
  const gray = resizeGray(toGray(image), image.width, image.height, DCT_SIZE, DCT_SIZE);
  if (!gray) return null;

  const coefficients: number[] = [];
  for (let v = 0; v < size; v += 1) {
    for (let u = 0; u < size; u += 1) {
      let sum = 0;
      for (let y = 0; y < DCT_SIZE; y += 1) {
        const rowCos = DCT_TABLE[v * DCT_SIZE + y]!;
        const row = y * DCT_SIZE;
        let inner = 0;
        for (let x = 0; x < DCT_SIZE; x += 1) {
          inner += gray[row + x]! * DCT_TABLE[u * DCT_SIZE + x]!;
        }
        sum += rowCos * inner;
      }
      // 归一化系数：c(0)=1/√2，其余 1
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      coefficients.push((sum * cu * cv) / 4);
    }
  }

  const threshold = median(coefficients);
  return coefficients.map((value) => (value > threshold ? '1' : '0')).join('');
}

/** 汉明距离。长度不一致时返回 -1（表示不可比，而不是 0） */
export function hammingDistance(first: string, second: string): number {
  if (first.length !== second.length || first.length === 0) return -1;
  let distance = 0;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) distance += 1;
  }
  return distance;
}

// ---------- SSIM ----------

/**
 * 分窗 SSIM（窗口 8、步长 4，均匀窗）。
 * 输入必须是同一尺寸的方形灰度图（由调用方统一缩放到公共尺寸后再比）。
 */
export function ssim(first: Uint8Array, second: Uint8Array, size: number, window = 8, stride = 4): number | null {
  if (first.length !== second.length || first.length !== size * size) return null;
  if (window > size) return null;

  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const perWindow = window * window;
  let total = 0;
  let windows = 0;

  for (let wy = 0; wy + window <= size; wy += stride) {
    for (let wx = 0; wx + window <= size; wx += stride) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      for (let y = 0; y < window; y += 1) {
        const row = (wy + y) * size + wx;
        for (let x = 0; x < window; x += 1) {
          const a = first[row + x]!;
          const b = second[row + x]!;
          sumA += a;
          sumB += b;
          sumAA += a * a;
          sumBB += b * b;
          sumAB += a * b;
        }
      }
      const meanA = sumA / perWindow;
      const meanB = sumB / perWindow;
      const varianceA = sumAA / perWindow - meanA * meanA;
      const varianceB = sumBB / perWindow - meanB * meanB;
      const covariance = sumAB / perWindow - meanA * meanB;
      const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
      const denominator = (meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2);
      total += denominator === 0 ? 1 : numerator / denominator;
      windows += 1;
    }
  }

  if (windows === 0) return null;
  const score = total / windows;
  return Math.max(-1, Math.min(1, score));
}

/** 把两张裁切图统一缩到 size×size 灰度，供 pHash / SSIM 同尺度比较 */
export function toComparableGray(image: RasterImage, size: number): Uint8Array | null {
  return resizeGray(toGray(image), image.width, image.height, size, size);
}

// ---------- 颜色空间 ----------

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** sRGB → CIELAB（D65 白点） */
export function rgbToLab(color: Rgb): Lab {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);

  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;

  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  const f = (value: number): number => (value > epsilon ? Math.cbrt(value) : (kappa * value + 16) / 116);

  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function toDegrees(radians: number): number {
  const degrees = (radians * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

/**
 * CIEDE2000 色差。实现按 Sharma 等人的标准公式，
 * 与 RGB 欧氏距离的关键差别：它在大色块与小色块上给出**一致**的「可察觉程度」，
 * 所以 3 / 6 这两条阈值才能在明暗不同的设计稿上都成立。
 */
export function deltaE00(first: Lab, second: Lab): number {
  const kL = 1;
  const kC = 1;
  const kH = 1;
  const pow25to7 = 25 ** 7;

  const c1 = Math.hypot(first.a, first.b);
  const c2 = Math.hypot(second.a, second.b);
  const cBar = (c1 + c2) / 2;
  const cBar7 = cBar ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + pow25to7)));

  const a1Prime = (1 + g) * first.a;
  const a2Prime = (1 + g) * second.a;
  const c1Prime = Math.hypot(a1Prime, first.b);
  const c2Prime = Math.hypot(a2Prime, second.b);
  const h1Prime = toDegrees(Math.atan2(first.b, a1Prime));
  const h2Prime = toDegrees(Math.atan2(second.b, a2Prime));

  const deltaLPrime = second.L - first.L;
  const deltaCPrime = c2Prime - c1Prime;

  let deltaHPrimeAngle = 0;
  if (c1Prime * c2Prime !== 0) {
    deltaHPrimeAngle = h2Prime - h1Prime;
    if (deltaHPrimeAngle > 180) deltaHPrimeAngle -= 360;
    else if (deltaHPrimeAngle < -180) deltaHPrimeAngle += 360;
  }
  const deltaHPrime = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(((deltaHPrimeAngle / 2) * Math.PI) / 180);

  const lBarPrime = (first.L + second.L) / 2;
  const cBarPrime = (c1Prime + c2Prime) / 2;

  let hBarPrime: number;
  if (c1Prime * c2Prime === 0) {
    hBarPrime = h1Prime + h2Prime;
  } else if (Math.abs(h1Prime - h2Prime) <= 180) {
    hBarPrime = (h1Prime + h2Prime) / 2;
  } else if (h1Prime + h2Prime < 360) {
    hBarPrime = (h1Prime + h2Prime + 360) / 2;
  } else {
    hBarPrime = (h1Prime + h2Prime - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos(((hBarPrime - 30) * Math.PI) / 180) +
    0.24 * Math.cos(((2 * hBarPrime) * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hBarPrime + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hBarPrime - 63) * Math.PI) / 180);

  const deltaTheta = 30 * Math.exp(-(((hBarPrime - 275) / 25) ** 2));
  const cBarPrime7 = cBarPrime ** 7;
  const rc = 2 * Math.sqrt(cBarPrime7 / (cBarPrime7 + pow25to7));
  const sl = 1 + (0.015 * (lBarPrime - 50) ** 2) / Math.sqrt(20 + (lBarPrime - 50) ** 2);
  const sc = 1 + 0.045 * cBarPrime;
  const sh = 1 + 0.015 * cBarPrime * t;
  const rt = -Math.sin(((2 * deltaTheta) * Math.PI) / 180) * rc;

  const termL = deltaLPrime / (kL * sl);
  const termC = deltaCPrime / (kC * sc);
  const termH = deltaHPrime / (kH * sh);

  return Math.sqrt(termL * termL + termC * termC + termH * termH + rt * termC * termH);
}
