/**
 * 颜色解析与 CIEDE2000 色差（纯函数）
 *
 * 需要它是因为：**App 侧盒样式覆盖率仅 9%**（46/494），颜色差异无法靠节点树判定，
 * 只能"设计声明期望值 → 截图采样实测值 → 色差阈值化"（报告 §1.1 / §5.2）。
 */

export interface Rgb {
  r: number; // 0-255
  g: number;
  b: number;
  a: number; // 0-1
}

/** 解析 #rgb / #rrggbb / #aarrggbb（Android ARGB）/ #rrggbbaa / rgb() / rgba() */
export function parseColor(input: string | null | undefined): Rgb | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();

  const hex = s.match(/^#([0-9a-f]+)$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      };
    }
    if (h.length === 8) {
      // Android 习惯是 #AARRGGBB；Figma 导出习惯是 #RRGGBBAA。
      // 判定：若前两位是惯常用的 alpha 值（00/ff）且后六位是合法颜色，两者都"合法"，
      // 无法可靠区分 → 采用显式约定：由调用方通过 `format` 指定，缺省按 Android ARGB
      // （因为 App 侧 style.backgroundColor 实测就是 #8a000000 这种形态）。
      const a = parseInt(h.slice(0, 2), 16) / 255;
      return {
        r: parseInt(h.slice(2, 4), 16),
        g: parseInt(h.slice(4, 6), 16),
        b: parseInt(h.slice(6, 8), 16),
        a,
      };
    }
    return null;
  }

  const fn = s.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[1].split(',').map((p) => p.trim());
    if (parts.length < 3) return null;
    const num = (t: string, scale = 1) => (t.endsWith('%') ? parseFloat(t) / 100 * 255 * scale : parseFloat(t));
    return {
      r: num(parts[0]),
      g: num(parts[1]),
      b: num(parts[2]),
      a: parts.length >= 4 ? parseFloat(parts[3]) : 1,
    };
  }
  return null;
}

export function toHex(c: Rgb): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** 把半透明色叠加到背景上（截图采样常见：带 alpha 的前景叠在底色上） */
export function composite(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export function rgbToLab(c: Rgb): Lab {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);

  // sRGB → XYZ (D65)
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;

  // 归一化到 D65 白点
  const xn = x / 0.95047;
  const yn = y / 1.0;
  const zn = z / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(xn);
  const fy = f(yn);
  const fz = f(zn);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * CIEDE2000 色差（Sharma 2005 实现口径）。
 * ΔE00 < 1 肉眼不可分；1–2 训练可辨；2–10 明显；>10 不同色。
 */
export function deltaE2000(c1: Rgb, c2: Rgb): number {
  const lab1 = rgbToLab(c1);
  const lab2 = rgbToLab(c2);
  const kL = 1;
  const kC = 1;
  const kH = 1;

  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;

  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;

  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const Cbarp = (C1p + C2p) / 2;

  const h1p = hueAngle(a1p, b1);
  const h2p = hueAngle(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);

  const Lbarp = (L1 + L2) / 2;

  let hbarp: number;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos(deg2rad(hbarp - 30)) +
    0.24 * Math.cos(deg2rad(2 * hbarp)) +
    0.32 * Math.cos(deg2rad(3 * hbarp + 6)) -
    0.2 * Math.cos(deg2rad(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const RC = 2 * Math.sqrt(Math.pow(Cbarp, 7) / (Math.pow(Cbarp, 7) + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(deg2rad(2 * dTheta)) * RC;

  return Math.sqrt(
    Math.pow(dLp / (kL * SL), 2) +
      Math.pow(dCp / (kC * SC), 2) +
      Math.pow(dHp / (kH * SH), 2) +
      RT * (dCp / (kC * SC)) * (dHp / (kH * SH)),
  );
}

function hueAngle(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return h;
}

function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

export function deltaEHex(a: string, b: string): number | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  return deltaE2000(ca, cb);
}
