/**
 * M4 像素测量通道 —— 颜色 / 圆角
 *
 * 为什么必须有它：**App 侧盒样式覆盖率只有 9%**（46/494，其中 borderWidth 有值的只有 2 个），
 * 颜色、圆角、描边这类差异**无法从节点树判定**；而设计侧有完整声明值可作期望。
 * 所以口径是：**设计声明期望 → 截图采样实测 → CIEDE2000 / 像素容差阈值化**。
 *
 * 本文件是纯逻辑：只依赖 `Sampler` 接口，PNG 解码在 `node/pngSampler.ts`。
 */

import type { ColorCheck, CornerCheck, PixelImage, PixelReport } from './types.ts';
import { composite, deltaE2000, toHex, type Rgb } from './color.ts';

export interface Sampler {
  width: number;
  height: number;
  /** 越界返回 null */
  pixel(x: number, y: number): [number, number, number, number] | null;
}

/** 从大图裁出子图（纯函数；越界部分补透明） */
export function cropImage(img: PixelImage, box: [number, number, number, number]): PixelImage {
  const [bx, by, bw, bh] = box;
  const w = Math.max(1, Math.min(bw, img.width - bx));
  const h = Math.max(1, Math.min(bh, img.height - by));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = by + y;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = bx + x;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * 最近邻降采样（给 VLM 用）。
 *
 * ⚠️ **只用在这里，不能改 `cropImage` 本身**（2026-10-04）：
 * M4 像素通道要的是**逐像素真实色值**，降采样会把颜色判定的基准改掉
 * （ΔE00 直接失真）。VLM 反而不需要物理像素——它看的是布局与观感，
 * 而「一张 1080×1620 的图」对它的判读价值远不如「一张 720×1080 的图」，
 * 后者请求体小一半、超时概率明显下降。
 *
 * 用最近邻而不是双线性：判布局有没有错位时，**不该引入插值造出来的中间色**。
 */
export function downscaleForReview(img: PixelImage, maxEdge = 720): PixelImage {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxEdge) return img;
  const k = maxEdge / longest;
  // 至少 1px：极小的标记（几 px 高）在缩到 0 时会整块消失
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / k));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / k));
      const si = (sy * img.width + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return { width: w, height: h, data: out };
}

export interface PixelThresholds {
  /** CIEDE2000 阈值：超过即判颜色偏差 */
  deltaE: number;
  /** 圆角容差（App 物理像素） */
  cornerTolerancePx: number;
}

export interface PixelCheckInput {
  id: string;
  region?: string | null;
  /** 设计逻辑矩形 */
  designBox: [number, number, number, number];
  /** 设计声明的填充色（可选） */
  expectedColorHex?: string | null;
  /** 设计声明的圆角（设计逻辑像素，可选） */
  expectedRadius?: number | null;
}

export interface PixelCheckContext {
  designSampler: Sampler | null;
  appSampler: Sampler | null;
  designScale: number;
  appScale: number;
  /** App 逻辑宽 / 设计逻辑宽（实测 360/375 = 0.96） */
  logicalRatio: number;
  thresholds: PixelThresholds;
  /**
   * L1 拟合的 y 投影（设计逻辑 y → App 逻辑 y）。
   * ⚠️ 必须用它而不是 `y * logicalRatio`：实测 Δy 从 −2.7 累积漂移到 −42.7，
   * 常量比例会在下半屏产生 40px 级采样偏移，直接把圆角/颜色采到隔壁元素上。
   */
  projectY?: (designY: number) => { appY: number } | null;
}

function rgba(p: [number, number, number, number] | null): Rgb | null {
  if (!p) return null;
  return { r: p[0], g: p[1], b: p[2], a: p[3] / 255 };
}

const CHANNEL_TOL = 24;

function closeTo(a: Rgb, b: Rgb, tol = CHANNEL_TOL): boolean {
  return Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
}

/** 在矩形内按网格采样，返回出现次数最多的颜色（中位数滤波，抗抗锯齿噪点） */
export function measureFillColor(
  sampler: Sampler,
  box: [number, number, number, number],
  marginRatio = 0.15,
): { color: Rgb; samples: number; spread: number } | null {
  const [x, y, w, h] = box;
  const mx = w * marginRatio;
  const my = h * marginRatio;
  const x0 = Math.round(x + mx);
  const y0 = Math.round(y + my);
  const x1 = Math.round(x + w - mx);
  const y1 = Math.round(y + h - my);
  if (x1 <= x0 || y1 <= y0) return null;

  const stepX = Math.max(1, Math.floor((x1 - x0) / 12));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 12));
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  let samples = 0;

  for (let yy = y0; yy <= y1; yy += stepY) {
    for (let xx = x0; xx <= x1; xx += stepX) {
      const c = rgba(sampler.pixel(xx, yy));
      if (!c) continue;
      // 量化到 8 级桶，避免抗锯齿造成的碎片
      const key = `${c.r >> 4},${c.g >> 4},${c.b >> 4}`;
      const cur = buckets.get(key);
      if (cur) {
        cur.n++;
        cur.r += c.r;
        cur.g += c.g;
        cur.b += c.b;
      } else buckets.set(key, { n: 1, r: c.r, g: c.g, b: c.b });
      samples++;
    }
  }
  if (samples === 0) return null;

  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  if (!best) return null;
  const color: Rgb = { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n, a: 1 };
  return { color, samples, spread: 1 - best.n / samples };
}

/**
 * 圆角半径估计（像素级启发式）。
 *
 * 关键点：**先找到形状自己的边，再看角**。
 * 直接用"设计框映射过去的左上角"当起点是不行的 —— L1 投影有 ±10px 级误差，
 * 一旦起点落进形状内部，首行内缩就是 0，半径恒判 0（实测踩过：11 个角全測成 0）。
 *
 * 步骤：
 *   1. 在框的**中线**向右/向下扫描，定位形状的真实左边界 `xL` 与上边界 `yT`；
 *   2. 从 (xL, yT) 起逐行找第一个前景像素，内缩量即该行的弧内缩；
 *   3. 半径 ≈ 前几行内缩量的最大值；单调性作为置信度。
 */
export function measureCornerRadius(
  sampler: Sampler,
  box: [number, number, number, number],
  fill: Rgb | null,
  maxScan = 48,
): { radius: number; confidence: number; note: string } | null {
  const [x, y, w, h] = box;
  if (w < 8 || h < 8) return null;

  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  // ---- 1. 用"搜索窗外 4px"的像素当背景参考 ----
  // 不要用 (x−3, y−3)：L1 投影有 ±10px 误差，那个点很可能**已经在形状内部**，
  // 于是"背景"= 形状填充色，整块全被判成前景，内缩恒为 0（实测 11 个角全测试成 0 的原因）。
  const slack = 14;
  const bgTop = rgba(sampler.pixel(cx, Math.round(y - slack - 4)));
  const bgLeft = rgba(sampler.pixel(Math.round(x - slack - 4), cy));
  const bgRef = bgLeft ?? bgTop;
  if (!bgRef) return null;

  // ---- 1b. 自适应阈值 ----
  // 固定阈值 18 会漏掉"白卡(#fff) 叠在浅灰页(#f5f5f5) 上"这种低对比场景（逐通道只差 10），
  // 实测直接导致整块判不出形状、返回 null。用内外对比度的 35% 做阈值，并夹在 [6, 24]。
  const interior = rgba(sampler.pixel(cx, cy));
  let spread = 0;
  if (interior) {
    spread = Math.max(
      Math.abs(interior.r - bgRef.r),
      Math.abs(interior.g - bgRef.g),
      Math.abs(interior.b - bgRef.b),
    );
  }
  const diffTol = Math.max(6, Math.min(24, spread * 0.35));

  const differs = (p: Rgb): boolean => !closeTo(p, bgRef, diffTol);

  // ---- 2. 定位形状自身的左边界 / 上边界 ----
  let xL = -1;
  for (let d = 0; d <= slack * 2 + 10; d++) {
    const px = Math.round(x - slack + d);
    const c = rgba(sampler.pixel(px, cy));
    if (c && differs(c)) {
      xL = px;
      break;
    }
  }
  let yT = -1;
  for (let d = 0; d <= slack * 2 + 10; d++) {
    const py = Math.round(y - slack + d);
    const c = rgba(sampler.pixel(cx, py));
    if (c && differs(c)) {
      yT = py;
      break;
    }
  }
  if (xL < 0 || yT < 0) return null;

  // ---- 2b. 边界微调：抗锯齿/阴影会让"第一处不同"晚 2-3px ----
  // 圆角半径对起始行极敏感（R=34.6 时，若从第 2 行起算只剩 ≈23px），必须先顶到真边界。
  for (let i = 0; i < 6; i++) {
    const c = rgba(sampler.pixel(xL - 1, cy));
    if (c && differs(c)) xL -= 1;
    else break;
  }
  for (let i = 0; i < 6; i++) {
    const c = rgba(sampler.pixel(cx, yT - 1));
    if (c && differs(c)) yT -= 1;
    else break;
  }

  // ---- 3. 从形状真实左上角逐行量内缩 ----
  const insets: number[] = [];
  const limit = Math.min(maxScan, Math.floor(w / 2), Math.floor(h / 2));
  for (let dy = 0; dy <= limit; dy++) {
    const yy = Math.round(yT + dy);
    let inset = -1;
    for (let dx = 0; dx <= limit; dx++) {
      const c = rgba(sampler.pixel(Math.round(xL + dx), yy));
      if (!c) break;
      if (differs(c)) {
        inset = dx;
        break;
      }
    }
    insets.push(inset);
  }

  const valid = insets.filter((v) => v >= 0);
  if (valid.length < 3) return null;

  // ---- 4. 用最小二乘拟合圆模型 ----
  // 模型：inset(dy) = R − sqrt(2R·dy − dy²)
  //
  // 为什么不直接取 max(前几行)？实测最深内缩所在的"第一行"因抗锯齿会被阈值判断跳过，
  // 拿 max 会系统性低估约 15-25%（实测 34.6px 的圆角测成 26px，直接误报）。
  // 拟合用上整条弧的所有行，对前几行的缺失不敏感。
  let bestR = 0;
  let bestSse = Infinity;
  let bestN = 0;
  for (let R = 3; R <= Math.min(maxScan + 8, 120); R += 1) {
    let sse = 0;
    let n = 0;
    for (let dy = 0; dy < insets.length && dy <= R; dy++) {
      const o = insets[dy];
      if (o == null || o < 0) continue;
      const pred = R - Math.sqrt(Math.max(0, 2 * R * dy - dy * dy));
      sse += (pred - o) ** 2;
      n++;
    }
    if (n < 3) continue;
    if (sse < bestSse) {
      bestSse = sse;
      bestR = R;
      bestN = n;
    }
  }
  if (!bestR) return null;
  const radius = bestR;
  const rms = Math.sqrt(bestSse / Math.max(1, bestN));

  // 置信度 = 拟合残差 × 弧的单调性
  let mono = 0;
  let cmp = 0;
  for (let i = 1; i < valid.length; i++) {
    cmp++;
    if (valid[i] <= valid[i - 1] + 1) mono++;
  }
  const monoScore = cmp === 0 ? 0.2 : mono / cmp;
  let confidence = Math.max(0.2, Math.min(1, (1 - Math.min(1, rms / 8)) * 0.6 + monoScore * 0.4));
  // 若给定的填充色与形状区域几乎不重合，说明采样框整体偏移，置信度打折
  if (fill) {
    const probe = rgba(sampler.pixel(cx, cy));
    if (probe && !closeTo(probe, fill, 40)) confidence = Math.min(confidence, 0.4);
  }

  return {
    radius,
    confidence,
    note:
      `形状左上角定位 (${xL}, ${yT})；圆模型最小二乘拟合 R=${radius}px` +
      `（${bestN} 行参与拟合，残差 RMS=${rms.toFixed(2)}px，单调性 ${(monoScore * 100).toFixed(0)}%）`,
  };
}

export function runPixelChecks(inputs: PixelCheckInput[], ctx: PixelCheckContext): PixelReport {
  // `designSampler` 有意不解构：设计侧的位置是权威，颜色/圆角的期望值都来自设计节点树，
  // 不需要拿设计截图反查它。它仍留在 `PixelCheckContext` 里（接口完整性 + 将来做设计侧自检）。
  const { appSampler, designScale, appScale, logicalRatio, thresholds } = ctx;
  const colorChecks: ColorCheck[] = [];
  const cornerChecks: CornerCheck[] = [];

  if (!appSampler) {
    return {
      available: false,
      reason: 'App 截图未加载，像素通道不可用',
      thresholds,
      colorChecks,
      cornerChecks,
      summary: { checked: 0, failed: 0 },
    };
  }

  for (const it of inputs) {
    // 设计**逻辑**矩形 → App **物理**矩形
    //
    //   x / w / h：按逻辑宽度比等比映射（App 逻辑宽 360 ↔ 设计逻辑宽 375）
    //   y       ：优先走 L1 拟合投影（实测存在 −2.7 → −42.7 的累积漂移，等比映射会在下半屏偏 40px）
    //
    // 历史 bug：这里曾写成 `dx / logicalRatio * appScale`（除而非乘），
    // 等于把 x 放大 1/0.96≈1.042 倍，宽元素还好、小图标直接采到隔壁 —— 已于本次修复。
    const [dx, dy, dw, dh] = it.designBox;
    const projectedY = ctx.projectY ? ctx.projectY(dy)?.appY : null;
    const appYLogical = projectedY ?? dy * logicalRatio;
    const appBox: [number, number, number, number] = [
      Math.round(dx * logicalRatio * appScale),
      Math.round(appYLogical * appScale),
      Math.max(1, Math.round(dw * logicalRatio * appScale)),
      Math.max(1, Math.round(dh * logicalRatio * appScale)),
    ];

    // ---- 颜色 ----
    if (it.expectedColorHex) {
      const measured = measureFillColor(appSampler, appBox);
      if (measured) {
        const expected = hexToRgb(it.expectedColorHex);
        if (expected) {
          const de = deltaE2000(expected, measured.color);
          colorChecks.push({
            id: it.id,
            side: 'app',
            region: it.region ?? null,
            expectedHex: it.expectedColorHex,
            measuredHex: toHex(measured.color),
            deltaE: Math.round(de * 100) / 100,
            pass: de <= thresholds.deltaE,
            sampleCount: measured.samples,
            note: `App 物理采样框 [${appBox.join(',')}]，采样 ${measured.samples} 点，离散度 ${(measured.spread * 100).toFixed(0)}%`,
          });
        }
      }
    }

    // ---- 圆角 ----
    if (it.expectedRadius != null && it.expectedRadius > 0) {
      // 用**实测底色**做前景判据（而不是设计声明的颜色）：
      // 设计声明色可能与 App 实际色有 ΔE 偏差，用错颜色会把整块判成"背景"，半径退化为 0。
      const measuredFill = measureFillColor(appSampler, appBox)?.color ?? null;
      const measured = measureCornerRadius(appSampler, appBox, measuredFill);
      if (measured) {
        // 设计逻辑圆角 → App 物理像素（含两端逻辑宽度比）
        const expectedPx = it.expectedRadius * logicalRatio * appScale;
        const diff = Math.abs(measured.radius - expectedPx);
        cornerChecks.push({
          id: it.id,
          expectedRadius: Math.round(expectedPx * 10) / 10,
          measuredRadius: measured.radius,
          tolerancePx: thresholds.cornerTolerancePx,
          pass: diff <= thresholds.cornerTolerancePx,
          confidence: measured.confidence,
          note:
            `${measured.note}；设计声明 ${it.expectedRadius}px（逻辑）→ App 期望 ${expectedPx.toFixed(1)}px（物理）` +
            `（designScale=${designScale}，appScale=${appScale}，logicalRatio=${logicalRatio.toFixed(4)}）`,
        });
      }
    }
  }

  const failed =
    colorChecks.filter((c) => !c.pass).length +
    cornerChecks.filter((c) => !c.pass && c.confidence >= CORNER_MIN_CONFIDENCE).length;
  return {
    available: true,
    thresholds,
    colorChecks,
    cornerChecks,
    summary: { checked: colorChecks.length + cornerChecks.length, failed },
  };
}

/**
 * 圆角判定的最低置信度。
 * 低于它的拟合结果**不进入结论**（实测低对比度场景会把 34.6px 测成 3px），
 * 只保留在 `cornerChecks` 里供人工复核。
 */
export const CORNER_MIN_CONFIDENCE = 0.6;

/** 取 #RRGGBB(AA) 的 alpha（无 alpha 记 1） */
export function alphaOfHex(hex: string): number {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return 1;
  return m[2] ? parseInt(m[2], 16) / 255 : 1;
}

/**
 * 解析设计侧声明的色值。
 *
 * ⚠️ 8 位 hex 的字节序是 **#RRGGBBAA**（Figma 口径，alpha 在**末尾**），
 * 不是 React Native 的 #AARRGGBB。实测样本里 `#e7d1ff66`（紫 40%）若按 ARGB 解析
 * 会得到 r=0xd1,g=0xff,b=0x66 的墨绿，ΔE 直接炸到 28 —— 这是最容易误判的一处。
 * 带 alpha 的颜色会先按白底合成，再与截图采样值比（截图里已经是合成后的颜色）。
 */
function parseDesignColor(hex: string, over: Rgb = { r: 255, g: 255, b: 255, a: 1 }): Rgb | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6}(?:[0-9a-f]{2})?)$/i);
  if (!m) return null;
  const h = m[1];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  if (a >= 0.999) return { r, g, b, a: 1 };
  return composite({ r, g, b, a }, over);
}

/** 兼容旧名（内部使用） */
const hexToRgb = parseDesignColor;
