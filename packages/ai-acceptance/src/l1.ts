/**
 * L1 锚点保序拟合 —— 对齐不是常量平移
 *
 * 对应报告 §3.2。实测：48 组同名文本的 Δy 从 −2.7 单调漂到 −42.7（再到 −152），
 * 任何全局平移都会产出成片假差异，因此必须拟合 `design.y → app.y` 的单调映射。
 *
 * 算法：
 *   1. 强锚点 = 同名文本在两侧**都唯一**、且都在流式层（固定层另走 fixedLayer 通道）；
 *   2. 用 PAVA（保序回归）拟合单调不减的 y 映射，再分段线性插值；
 *   3. 残差离群的锚点判为**对齐断裂**（设计多一段 / App 少一段），从拟合中剔除后重拟合；
 *   4. 用拟合结果消解"文本重复"（`更多`×2 / `自营`×2 / `福利天天领` 1↔2）的配对歧义。
 */

import type { AlignmentResult, AnchorPair, FitSegment, NormNode, ShapedSide } from './types.ts';

/* ---------------------------------------------------------------------------
 * PAVA（Pool Adjacent Violators Algorithm）—— 单调不减回归
 * -------------------------------------------------------------------------*/

export function isotonicNonDecreasing(y: number[], w?: number[]): number[] {
  const n = y.length;
  if (n === 0) return [];
  const weights = w ?? new Array<number>(n).fill(1);
  interface Block {
    start: number;
    end: number;
    sumW: number;
    sumWY: number;
  }
  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ start: i, end: i, sumW: weights[i], sumWY: weights[i] * y[i] });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sumWY / a.sumW <= b.sumWY / b.sumW) break;
      blocks.pop();
      blocks[blocks.length - 1] = {
        start: a.start,
        end: b.end,
        sumW: a.sumW + b.sumW,
        sumWY: a.sumWY + b.sumWY,
      };
    }
  }
  const out = new Array<number>(n).fill(0);
  for (const b of blocks) {
    const mean = b.sumWY / b.sumW;
    for (let i = b.start; i <= b.end; i++) out[i] = mean;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 拟合与投影
 * -------------------------------------------------------------------------*/

export interface Projection {
  appY: number;
  confidence: number;
  extrapolated: boolean;
}

export interface Projector {
  (designY: number): Projection;
  /** 参与拟合的锚点 x（升序去重） */
  xs: number[];
  /** 拟合值 */
  ys: number[];
}

const EXTRAPOLATION_CONFIDENCE = 0.2;

export function buildProjector(points: Array<{ x: number; y: number }>): Projector {
  // 同 x 合并（取均值）
  const merged = new Map<number, { sum: number; n: number }>();
  for (const p of points) {
    const cur = merged.get(p.x);
    if (cur) {
      cur.sum += p.y;
      cur.n += 1;
    } else merged.set(p.x, { sum: p.y, n: 1 });
  }
  const xs = [...merged.keys()].sort((a, b) => a - b);
  const rawY = xs.map((x) => merged.get(x)!.sum / merged.get(x)!.n);
  const fitted = isotonicNonDecreasing(rawY);

  const gapsBetween = xs.slice(1).map((x, i) => x - xs[i]);
  const medianGap = gapsBetween.length
    ? [...gapsBetween].sort((a, b) => a - b)[Math.floor(gapsBetween.length / 2)]
    : 200;

  const slopeAt = (i: number): number => {
    if (xs.length < 2) return 1;
    const j = Math.min(i, xs.length - 2);
    const dx = xs[j + 1] - xs[j];
    if (dx === 0) return 1;
    return (fitted[j + 1] - fitted[j]) / dx;
  };

  const project = ((designY: number): Projection => {
    if (xs.length === 0) return { appY: designY, confidence: 0, extrapolated: true };

    let appY: number;
    let extrapolated = false;
    let conf: number;

    if (designY <= xs[0]) {
      const s = clamp(slopeAt(0), 0.3, 1.4);
      appY = fitted[0] + (designY - xs[0]) * s;
      extrapolated = designY < xs[0];
      conf = EXTRAPOLATION_CONFIDENCE;
    } else if (designY >= xs[xs.length - 1]) {
      const s = clamp(slopeAt(xs.length - 2), 0.3, 1.4);
      appY = fitted[fitted.length - 1] + (designY - xs[xs.length - 1]) * s;
      extrapolated = designY > xs[xs.length - 1];
      conf = EXTRAPOLATION_CONFIDENCE;
    } else {
      let lo = 0;
      let hi = xs.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= designY) lo = mid;
        else hi = mid;
      }
      const dx = xs[hi] - xs[lo] || 1;
      const t = (designY - xs[lo]) / dx;
      appY = fitted[lo] + t * (fitted[hi] - fitted[lo]);

      const slope = (fitted[hi] - fitted[lo]) / dx;
      const slopePenalty = Math.min(1, Math.abs(slope - 1) / 0.5);
      const distToAnchor = Math.min(designY - xs[lo], xs[hi] - designY);
      const densityPenalty = Math.min(1, distToAnchor / Math.max(medianGap, 1)) * 0.4;
      conf = clamp(1 - slopePenalty * 0.5 - densityPenalty, 0.15, 1);
    }

    return { appY, confidence: conf, extrapolated };
  }) as Projector;

  project.xs = xs;
  project.ys = fitted;
  return project;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = clamp(Math.round((s.length - 1) * p), 0, s.length - 1);
  return s[idx];
}

/* ---------------------------------------------------------------------------
 * 锚点构建
 * -------------------------------------------------------------------------*/

export interface AlignOptions {
  /** 相邻段 Δy 跳变阈值：超过即判对齐断裂 */
  gapJump?: number;
  /** 段斜率相对 1 的偏离容忍度 */
  gapSlopeTolerance?: number;
  /** 二次迭代次数（用几何消解重复文本后重拟合） */
  iterations?: number;
}

export interface AlignOutput extends AlignmentResult {
  /** 设计侧 y → App 侧 y 的对齐断点（供 L2 分区切片使用） */
  usableRange: { designY0: number; designY1: number };
  /** 水平方向的系统偏移（设计中位数 − App 中位数，已折算到设计逻辑坐标） */
  xOffset: number;
  /** App 逻辑宽度 → 设计逻辑宽度的换算比 */
  appToDesignX: number;
}

function textIndex(side: ShapedSide, layer?: 'flow' | 'fixed'): Map<string, NormNode[]> {
  const map = new Map<string, NormNode[]>();
  for (const n of side.nodes) {
    if (!n.text) continue;
    if (layer && n.layer !== layer) continue;
    const arr = map.get(n.text);
    if (arr) arr.push(n);
    else map.set(n.text, [n]);
  }
  return map;
}

export function alignAnchors(design: ShapedSide, app: ShapedSide, opts: AlignOptions = {}): AlignOutput {
  const gapJump = opts.gapJump ?? 40;
  const gapSlopeTol = opts.gapSlopeTolerance ?? 0.35;
  const iterations = opts.iterations ?? 2;

  const dFlow = textIndex(design, 'flow');
  const aFlow = textIndex(app, 'flow');
  const dFixed = textIndex(design, 'fixed');
  const aFixed = textIndex(app, 'fixed');

  // ---- 固定层锚点：只按文本身份配对，Δy 不作对流式层的结论 ----
  const fixedLayer: AnchorPair[] = [];
  for (const [text, dns] of dFixed) {
    const ans = aFixed.get(text);
    if (!ans || dns.length !== 1 || ans.length !== 1) continue;
    const d = dns[0];
    const a = ans[0];
    fixedLayer.push(makeAnchor(text, d, a, { uniqueText: true, signature: false, order: false }, true, '固定层'));
  }

  // ---- 一次锚点：两侧都唯一的同名文本 ----
  const primary: AnchorPair[] = [];
  for (const [text, dns] of dFlow) {
    const ans = aFlow.get(text);
    if (!ans) continue;
    if (dns.length !== 1 || ans.length !== 1) continue;
    const d = dns[0];
    const a = ans[0];
    primary.push(
      makeAnchor(
        text,
        d,
        a,
        { uniqueText: true, signature: false, order: false },
        true,
        '两侧同名唯一',
      ),
    );
  }
  primary.sort((p, q) => p.designY - q.designY);

  // ---- 迭代：拟合 → 剔除断裂 → 用几何消解重复文本 → 重拟合 ----
  let projector = buildProjector(primary.map((p) => ({ x: p.designY, y: p.appY })));
  let active = primary.slice();
  let promoted: AnchorPair[] = [];
  let gaps: AlignmentResult['gaps'] = [];

  for (let it = 0; it < iterations; it++) {
    // 1) 断裂检测：相邻强锚点 Δy 跳变 / 斜率塌陷
    const kept: AnchorPair[] = [];
    const removed: AnchorPair[] = [];
    for (let i = 0; i < active.length; i++) {
      const cur = active[i];
      const prev = active[i - 1];
      const next = active[i + 1];
      let breakHere = false;
      let note = '';
      if (prev) {
        const ddx = cur.designY - prev.designY;
        const ddy = cur.deltaY - prev.deltaY;
        const slope = ddx > 0 ? (cur.appY - prev.appY) / ddx : 1;
        if (Math.abs(ddy) > gapJump) {
          breakHere = true;
          note = `Δy 从 ${prev.deltaY.toFixed(1)} 跳到 ${cur.deltaY.toFixed(1)}（跳变 ${ddy.toFixed(1)}px）`;
        } else if (Math.abs(slope - 1) > gapSlopeTol && ddx > 60) {
          breakHere = true;
          note = `局部斜率 ${slope.toFixed(2)} 偏离 1（设计 ${prev.designY.toFixed(0)}→${cur.designY.toFixed(0)}）`;
        }
      }
      if (breakHere) {
        removed.push(cur);
        if (prev) gaps.push({ designY0: prev.designY, designY1: cur.designY, note });
        continue;
      }
      void next;
      kept.push(cur);
    }
    // 更新断裂区间（合并重叠）
    gaps = mergeGaps(gaps);

    active = kept;
    projector = buildProjector(active.map((p) => ({ x: p.designY, y: p.appY })));

    // 2) 用几何消解重复文本
    promoted = [];
    for (const [text, dns] of dFlow) {
      const ans = aFlow.get(text);
      if (!ans || dns.length === 1) continue; // 唯一文本已在 primary
      if (ans.length === 0) continue;
      for (const d of dns) {
        const predicted = projector(d.rect.y).appY;
        let best: NormNode | null = null;
        let bestDist = Infinity;
        for (const a of ans) {
          const dist = Math.abs(a.rect.y - predicted);
          if (dist < bestDist) {
            bestDist = dist;
            best = a;
          }
        }
        if (!best) continue;
        // 只有落在断裂区间之外、且残差可接受，才升级为强锚点
        if (bestDist > 24) continue;
        if (inGaps(d.rect.y, gaps)) continue;
        promoted.push(
          makeAnchor(
            text,
            d,
            best,
            { uniqueText: false, signature: d.pathSignature === best.pathSignature, order: d.orderInParent === best.orderInParent },
            true,
            `几何消解重复文本（残差 ${(best.rect.y - predicted).toFixed(1)}px）`,
          ),
        );
      }
    }
  }

  const strongAnchors = [...active, ...promoted].sort((p, q) => p.designY - q.designY);

  // 弱锚点：两侧同名但唯一性/几何都不满足 → 只做验证，不参与拟合
  const weakAnchors: AnchorPair[] = [];
  const strongKeys = new Set(strongAnchors.map((a) => `${a.text}@${a.designId}`));
  for (const [text, dns] of dFlow) {
    const ans = aFlow.get(text);
    if (!ans) continue;
    for (const d of dns) {
      if (strongKeys.has(`${text}@${d.id}`)) continue;
      const nearest = ans.reduce<NormNode | null>(
        (acc, a) => (!acc || Math.abs(a.rect.y - projector(d.rect.y).appY) < Math.abs(acc.rect.y - projector(d.rect.y).appY) ? a : acc),
        null,
      );
      if (!nearest) continue;
      weakAnchors.push(
        makeAnchor(text, d, nearest, { uniqueText: false, signature: false, order: false }, false, '未通过去歧义，仅作验证'),
      );
    }
  }

  // ---- 段与残差统计 ----
  const segments: FitSegment[] = [];
  for (let i = 1; i < strongAnchors.length; i++) {
    const a = strongAnchors[i - 1];
    const b = strongAnchors[i];
    const dx = b.designY - a.designY;
    const slope = dx > 0 ? (b.appY - a.appY) / dx : 1;
    segments.push({
      designY0: a.designY,
      designY1: b.designY,
      appY0: a.appY,
      appY1: b.appY,
      anchors: 2,
      residualMedian: median([a.deltaY, b.deltaY]),
      gap: dx > 0 && Math.abs(slope - 1) > gapSlopeTol,
    });
  }

  const residuals = strongAnchors.map((a) => a.deltaY);
  const lastAnchorY = strongAnchors.length ? strongAnchors[strongAnchors.length - 1].designY : 0;
  const firstAnchorY = strongAnchors.length ? strongAnchors[0].designY : 0;

  if (lastAnchorY > 0 && lastAnchorY < Math.max(design.docHeight, app.docHeight)) {
    gaps.push({
      designY0: lastAnchorY,
      designY1: Math.max(design.docHeight, app.docHeight),
      note: '锚点区间之外：映射由外推得到，低置信',
    });
  }
  if (firstAnchorY > 0) {
    gaps.push({ designY0: 0, designY1: firstAnchorY, note: '锚点区间之前：映射由外推得到，低置信' });
  }
  gaps = mergeGaps(gaps);

  // ---- 水平偏移与口径换算 ----
  // 实测：x 方向未发现累积漂移，用常量偏移即可；比值取两侧逻辑宽度之比（375/360 = 1.0417）。
  const appToDesignX = app.viewportWidth > 0 ? design.viewportWidth / app.viewportWidth : 1;
  const dxs: number[] = [];
  for (const a of strongAnchors) {
    const d = design.nodes.find((n) => n.id === a.designId);
    const ap = app.nodes.find((n) => n.id === a.appId);
    if (!d || !ap) continue;
    dxs.push(d.rect.x - ap.rect.x * appToDesignX);
  }
  const xOffset = dxs.length ? median(dxs) : 0;

  return {
    anchors: [...strongAnchors, ...weakAnchors],
    strongAnchors,
    weakAnchors,
    segments,
    residualMedian: median(residuals),
    residualP90: percentile(residuals.map(Math.abs), 0.9),
    within3: residuals.filter((r) => Math.abs(r) <= 3).length,
    projectY: (y: number) => projector(y),
    gaps,
    fixedLayer,
    usableRange: { designY0: firstAnchorY, designY1: lastAnchorY },
    xOffset,
    appToDesignX,
  };
}

function makeAnchor(
  text: string,
  d: NormNode,
  a: NormNode,
  disambiguation: AnchorPair['disambiguation'],
  strong: boolean,
  reason: string,
): AnchorPair {
  return {
    text,
    designId: d.id,
    appId: a.id,
    designY: d.rect.y,
    appY: a.rect.y,
    deltaY: a.rect.y - d.rect.y,
    disambiguation,
    strong,
    reason,
  };
}

function inGaps(y: number, gaps: Array<{ designY0: number; designY1: number }>): boolean {
  return gaps.some((g) => y >= g.designY0 && y <= g.designY1);
}

function mergeGaps(
  gaps: Array<{ designY0: number; designY1: number; note: string }>,
): Array<{ designY0: number; designY1: number; note: string }> {
  if (gaps.length <= 1) return gaps;
  const sorted = [...gaps].sort((a, b) => a.designY0 - b.designY0);
  const out: typeof sorted = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && g.designY0 <= last.designY1 + 1) {
      last.designY1 = Math.max(last.designY1, g.designY1);
      if (!last.note.includes(g.note)) last.note = `${last.note}；${g.note}`;
    } else out.push({ ...g });
  }
  return out;
}
