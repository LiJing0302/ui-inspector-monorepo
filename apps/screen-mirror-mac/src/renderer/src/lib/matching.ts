/**
 * 页面匹配推荐打分（PRD §8）。
 *
 * 定位是**排序辅助**，不是自动配对：只影响候选的先后顺序与「推荐/可能」标，
 * 最终配对永远由 UI 同学点选。所以这里宁可保守，也不要给出误导性的高分。
 *
 * 权重：名称 0.4 / 尺寸 0.3 / 文本 0.2 / 节点数 0.1
 * 宽高比差异 > 20% 时总分 ×0.7（机型 / 状态栏差异，避免误排到最前）
 */

import type { AppSnapshotMeta, DesignAssetMeta } from '@shared/verify';

export type MatchBucket = 'recommended' | 'possible' | 'low';

export interface MatchScoreDetail {
  name: number;
  size: number;
  text: number;
  node: number;
  /** 宽高比惩罚系数（1 = 无惩罚） */
  penalty: number;
}

export interface MatchScore {
  score: number;
  bucket: MatchBucket;
  detail: MatchScoreDetail;
}

const WEIGHTS = { name: 0.4, size: 0.3, text: 0.2, node: 0.1 } as const;
const RECOMMENDED_THRESHOLD = 0.6;
const POSSIBLE_THRESHOLD = 0.3;
const ASPECT_TOLERANCE = 0.2;
const ASPECT_PENALTY = 0.7;

/**
 * 归一化名称：去掉扩展名、日期串、分隔符与常见装饰词，再转小写。
 * 目的是让「抽奖结果UE-UI-活动进行中」和「活动进行中」能对上。
 */
function normalizeName(value: string): string {
  return value
    .replace(/\.(png|jpg|jpeg|zip)$/i, '')
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, '')
    .replace(/\b(nodes?|schema|screenshots?|export|导出|截图|设计稿|副本|copy)\b/gi, '')
    .replace(/[\s\-_·、,，.。()（）[\]【】]/g, '')
    .toLowerCase();
}

/** 编辑距离（滚动数组，O(min(m,n)) 空间） */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j] ?? 0;
  }
  return previous[b.length] ?? 0;
}

/** 编辑距离相似度，0~1 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - levenshtein(a, b) / longest;
}

/** Jaccard 相似度；两侧都为空时给 0（无信息，不应加分） */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let intersection = 0;
  for (const item of a) if (setB.has(item)) intersection += 1;
  const union = a.length + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * 设计稿的可读名候选：`name` 与 `path` 末段。
 * 取两者中与 App 名称最相似的一个，避免因为命名习惯不同而漏配。
 */
function designNameCandidates(design: DesignAssetMeta): string[] {
  const segments = design.path ? design.path.split('/') : [];
  const last = segments[segments.length - 1] ?? '';
  return [...new Set([design.name, last].filter(Boolean).map(normalizeName))].filter(
    (value) => value.length > 0,
  );
}

export function scorePair(design: DesignAssetMeta, app: AppSnapshotMeta): MatchScore {
  const appName = normalizeName(app.label || app.device || '');
  const nameScore = clamp01(
    Math.max(0, ...designNameCandidates(design).map((candidate) => similarity(candidate, appName))),
  );

  const designAspect = design.height > 0 ? design.width / design.height : 0;
  const appAspect = app.height > 0 ? app.width / app.height : 0;
  const aspectDelta = designAspect > 0 ? Math.abs(designAspect - appAspect) / designAspect : 1;
  const aspectScore = clamp01(1 - Math.min(1, aspectDelta));

  const absoluteScore = clamp01(
    1 -
      (Math.abs(design.width - app.width) + Math.abs(design.height - app.height)) /
        Math.max(1, design.width + design.height),
  );
  const sizeScore = (aspectScore + absoluteScore) / 2;

  const textScore = clamp01(jaccard(design.textSamples ?? [], app.textSamples ?? []));

  const maxNodes = Math.max(design.nodeCount, app.nodeCount);
  const nodeScore = maxNodes === 0 ? 0 : clamp01(1 - Math.abs(design.nodeCount - app.nodeCount) / maxNodes);

  const raw =
    WEIGHTS.name * nameScore +
    WEIGHTS.size * sizeScore +
    WEIGHTS.text * textScore +
    WEIGHTS.node * nodeScore;

  // 宽高比差异过大（多半不是同一个页面），总分打折而不是直接判 0
  const penalty = aspectDelta > ASPECT_TOLERANCE ? ASPECT_PENALTY : 1;
  const score = clamp01(raw * penalty);

  return {
    score,
    bucket:
      score >= RECOMMENDED_THRESHOLD ? 'recommended' : score >= POSSIBLE_THRESHOLD ? 'possible' : 'low',
    detail: { name: nameScore, size: sizeScore, text: textScore, node: nodeScore, penalty },
  };
}

export const BUCKET_LABEL: Record<MatchBucket, string> = {
  recommended: '推荐',
  possible: '可能',
  low: '低',
};

/** 按推荐分降序排列候选 */
export function rankCandidates(
  design: DesignAssetMeta,
  apps: AppSnapshotMeta[],
): Array<{ app: AppSnapshotMeta; match: MatchScore }> {
  return apps
    .map((app) => ({ app, match: scorePair(design, app) }))
    .sort((a, b) => b.match.score - a.match.score);
}
