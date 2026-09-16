import type { CollectionQuality } from '../../types/acceptance';
import type { AppNode, DesignNode, Rect } from '../../types/verify';
import type {
  AcceptanceIssue,
  AcceptanceResult,
  AcceptanceProfile,
  AiAcceptanceResponse,
  CanonicalDocument,
  CanonicalKind,
  CanonicalNode,
  ContentFeatures,
  GeometryFeatures,
  MatchVisualMetrics,
  NodeMapping,
  NodeMatch,
  StructureFeatures,
  VisualFeatures,
} from '../../types/aiAcceptance';
import { toCanonicalId } from '../../types/aiAcceptance';
import {
  DELTA_E_PASS,
  DELTA_E_REVIEW,
  PHASH_PASS_DISTANCE,
  SSIM_PASS,
} from './visuals';

export const DEFAULT_ACCEPTANCE_PROFILE: AcceptanceProfile = {
  version: '1.0.0',
  geometry: {
    positionTolerance: 2,
    sizeTolerance: 2,
    gapTolerance: 2,
    cornerRadiusTolerance: 1,
  },
  text: {
    exact: true,
    normalizeWhitespace: true,
    caseSensitive: true,
    dynamicPatterns: [],
  },
  requiredChecks: ['presence', 'geometry', 'text', 'visual'],
  failOnCollectionTruncation: true,
};

const MATCH_THRESHOLD = 0.38;
const AUTO_MATCH_THRESHOLD = 0.85;
const AUTO_MATCH_MARGIN = 0.12;
/** 送进 AI 仲裁的候选数。太大只会把噪声喂给模型，太小又可能漏掉正确答案 */
export const TOP_K_CANDIDATES = 5;
/** AI 置信度达到这个值才允许把 ambiguous 提升为 matched */
export const AI_ACCEPT_THRESHOLD = 0.85;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function normalizeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : '';
}

function normalizedTextEqual(first: string | null, second: string | null): boolean {
  return normalizeText(first) === normalizeText(second);
}

function textSimilarity(first: string | null, second: string | null): number {
  const left = normalizeText(first);
  const right = normalizeText(second);
  if (left == null || right == null || left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return clamp(1 - (previous[right.length] ?? longest) / longest);
}

function rectRight(rect: Rect): number {
  return rect.x + rect.width;
}

function rectBottom(rect: Rect): number {
  return rect.y + rect.height;
}

function relativeDirection(first: Rect, second: Rect): 'horizontal' | 'vertical' | 'freeform' {
  const horizontal = Math.abs(first.y - second.y) <= Math.max(2, Math.min(first.height, second.height) * 0.15);
  const vertical = Math.abs(first.x - second.x) <= Math.max(2, Math.min(first.width, second.width) * 0.15);
  if (horizontal) return 'horizontal';
  if (vertical) return 'vertical';
  return 'freeform';
}

function kindForDesign(node: DesignNode, childCount: number): CanonicalKind {
  if (node.type === 'TEXT') return 'text';
  if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'BOOLEAN_OPERATION') return 'icon';
  if (node.fills?.some((paint) => paint.type === 'IMAGE' && paint.visible !== false)) return 'image';
  if (node.component || node.type === 'INSTANCE' || node.type === 'COMPONENT') return 'control';
  return childCount > 0 ? 'container' : 'unknown';
}

function kindForApp(node: AppNode, childCount: number): CanonicalKind {
  if (node.isImage) return 'image';
  if (node.isSvg) return 'icon';
  if (node.text != null) return 'text';
  if (node.clickable) return 'control';
  return childCount > 0 ? 'container' : 'unknown';
}

function buildChildren(nodes: Array<{ id: string; parentId: string | null }>): Map<string | null, string[]> {
  const children = new Map<string | null, string[]>();
  for (const node of nodes) {
    const current = children.get(node.parentId) ?? [];
    current.push(node.id);
    children.set(node.parentId, current);
  }
  return children;
}

function countSubtree(nodeId: string, children: Map<string | null, string[]>): number {
  const descendants = children.get(nodeId) ?? [];
  return 1 + descendants.reduce((total, childId) => total + countSubtree(childId, children), 0);
}

function layoutDirection(childRects: Rect[]): StructureFeatures['layoutDirection'] {
  if (childRects.length < 2) return 'unknown';
  const first = childRects[0]!;
  const second = childRects[1]!;
  return relativeDirection(first, second);
}

function makeGeometry(rect: Rect, parentRect: Rect | null): GeometryFeatures {
  const rootWidth = Math.max(1, parentRect?.width ?? rect.width);
  const rootHeight = Math.max(1, parentRect?.height ?? rect.height);
  return {
    normalizedX: rect.x / rootWidth,
    normalizedY: rect.y / rootHeight,
    normalizedWidth: rect.width / rootWidth,
    normalizedHeight: rect.height / rootHeight,
    centerX: rect.x + rect.width / 2,
    centerY: rect.y + rect.height / 2,
    aspectRatio: rect.height === 0 ? 0 : rect.width / rect.height,
    parentOffset: {
      left: rect.x - (parentRect?.x ?? 0),
      top: rect.y - (parentRect?.y ?? 0),
      right: (parentRect ? rectRight(parentRect) : 0) - rectRight(rect),
      bottom: (parentRect ? rectBottom(parentRect) : 0) - rectBottom(rect),
    },
  };
}

function makeContent(text: string | null, textRedacted: boolean, resourceName: string | null, contentDescription: string | null): ContentFeatures {
  return {
    rawText: text,
    normalizedText: normalizeText(text),
    textRedacted,
    resourceName,
    contentDescription,
  };
}

function makeVisual(
  hasVisualContent: boolean,
  isImage: boolean,
  isSvg: boolean,
  isGradient: boolean,
  alpha: number,
): VisualFeatures {
  return { hasVisualContent, isImage, isSvg, isGradient, alpha };
}

function makeQuality(source: 'design' | 'app', node: DesignNode | AppNode): CanonicalNode['quality'] {
  if (source === 'design') {
    return { geometry: 'available', structure: 'available', content: 'available', visual: 'available' };
  }
  const app = node as AppNode;
  return {
    geometry: 'available',
    structure: 'available',
    content: app.textRedacted ? 'partial' : 'available',
    visual: app.hasVisualContent || app.isImage || app.isSvg || app.isGradient ? 'partial' : 'available',
  };
}

function canonicalize(
  source: 'design' | 'app',
  nodes: Array<DesignNode | AppNode>,
  width: number,
  height: number,
): CanonicalDocument {
  const ids = nodes.map((node) =>
    toCanonicalId(source, source === 'design' ? (node as DesignNode).id : (node as AppNode).nodeId),
  );
  const parentIds = nodes.map((node) => {
    const parentId = source === 'design' ? (node as DesignNode).parentId : (node as AppNode).parentId;
    return parentId ? toCanonicalId(source, parentId) : null;
  });
  const children = buildChildren(ids.map((id, index) => ({ id, parentId: parentIds[index] ?? null })));
  const byId = new Map(ids.map((id, index) => [id, nodes[index]! ]));
  const rectById = new Map(ids.map((id, index) => [id, (nodes[index] as DesignNode | AppNode)]));

  const canonicalNodes: CanonicalNode[] = ids.map((id, index) => {
    const node = nodes[index]!;
    const app = source === 'app' ? node as AppNode : null;
    const design = source === 'design' ? node as DesignNode : null;
    const childIds = children.get(id) ?? [];
    const parentId = parentIds[index] ?? null;
    const parentRaw = parentId ? byId.get(parentId) : null;
    const rawRect = design?.rect ?? {
      x: app?.x ?? 0,
      y: app?.y ?? 0,
      width: app?.width ?? 0,
      height: app?.height ?? 0,
    };
    const visibleRect = design
      ? (design.clipped ? null : rawRect)
      : app?.visibleWidth != null && app.visibleHeight != null
      ? { x: app.visibleX, y: app.visibleY, width: app.visibleWidth, height: app.visibleHeight }
      : rawRect;
    const childRawRects = childIds.map((childId) => {
      const child = rectById.get(childId) as DesignNode | AppNode | undefined;
      return child && 'rect' in child ? child.rect : child ? { x: child.x, y: child.y, width: child.width, height: child.height } : rawRect;
    });
    const kind = design ? kindForDesign(design, childIds.length) : kindForApp(app!, childIds.length);
    const text = design?.text?.characters ?? app?.text ?? null;
    const layoutOnly = design
      ? !design.hasFill && !text && childIds.length > 0
      : app?.layoutOnly ?? (!app?.hasVisualContent && !app?.clickable && childIds.length > 0);
    const participation = design
      ? layoutOnly ? 'context' : 'required'
      : (app?.participation ?? (layoutOnly ? 'context' : 'optional'));

    return {
      canonicalId: id,
      source,
      rawIds: [source === 'design' ? (design as DesignNode).id : (app as AppNode).nodeId],
      parentId,
      childIds,
      depth: node.depth,
      siblingIndex: node.index ?? index,
      rect: rawRect,
      visibleRect,
      kind,
      participation,
      visible: design?.visible ?? app!.visible,
      clipped: design?.clipped ?? app?.outsideVisibleRect ?? false,
      layoutOnly,
      virtual: false,
      geometry: makeGeometry(rawRect, parentRaw && 'rect' in parentRaw ? parentRaw.rect : parentRaw ? { x: parentRaw.x, y: parentRaw.y, width: parentRaw.width, height: parentRaw.height } : null),
      structure: {
        childCount: childIds.length,
        visibleChildCount: childIds.filter((childId) => {
          const child = byId.get(childId) as DesignNode | AppNode | undefined;
          return design ? child?.visible !== false : child?.visible !== false;
        }).length,
        visualChildCount: childIds.filter((childId) => {
          const child = rectById.get(childId) as DesignNode | AppNode | undefined;
          return design ? !!(child as DesignNode)?.hasFill : !!(child as AppNode)?.hasVisualContent;
        }).length,
        textChildCount: childIds.filter((childId) => {
          const child = rectById.get(childId) as DesignNode | AppNode | undefined;
          return design ? !!(child as DesignNode)?.text : (child as AppNode)?.text != null;
        }).length,
        imageChildCount: childIds.filter((childId) => {
          const child = rectById.get(childId) as DesignNode | AppNode | undefined;
          return design ? !!(child as DesignNode)?.fills?.some((paint) => paint.type === 'IMAGE') : !!(child as AppNode)?.isImage;
        }).length,
        siblingCount: parentId ? (children.get(parentId)?.length ?? 1) : (children.get(null)?.length ?? 1),
        siblingIndex: node.index ?? index,
        subtreeNodeCount: countSubtree(id, children),
        layoutDirection: layoutDirection(childRawRects),
      },
      content: makeContent(
        text,
        app?.textRedacted ?? false,
        design ? null : app?.resourceName ?? null,
        design ? null : app?.contentDescription ?? null,
      ),
      visual: makeVisual(
        design ? !!design.hasFill : !!app?.hasVisualContent,
        design ? !!design.fills?.some((paint) => paint.type === 'IMAGE') : !!app?.isImage,
        design ? design.type === 'VECTOR' : !!app?.isSvg,
        design ? !!design.fills?.some((paint) => paint.type.startsWith('GRADIENT')) : !!app?.isGradient,
        design?.opacity ?? app?.alpha ?? 1,
      ),
      quality: makeQuality(source, node),
    };
  });

  return {
    source,
    width,
    height,
    nodes: canonicalNodes,
    rootIds: children.get(null) ?? [],
  };
}

export function canonicalizeDesign(nodes: DesignNode[], width: number, height: number): CanonicalDocument {
  return canonicalize('design', nodes, width, height);
}

export function canonicalizeApp(nodes: AppNode[], width: number, height: number): CanonicalDocument {
  return canonicalize('app', nodes, width, height);
}

function transformAppRect(rect: Rect, design: CanonicalDocument, app: CanonicalDocument): Rect {
  const scale = design.width > 0 && app.width > 0 ? design.width / app.width : 1;
  return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

function geometryScore(design: CanonicalNode, app: CanonicalNode, designDoc: CanonicalDocument, appDoc: CanonicalDocument): number {
  const actual = transformAppRect(app.rect, designDoc, appDoc);
  const denominator = Math.max(1, designDoc.width + designDoc.height);
  const delta = Math.abs(design.rect.x - actual.x) + Math.abs(design.rect.y - actual.y) + Math.abs(design.rect.width - actual.width) + Math.abs(design.rect.height - actual.height);
  return clamp(1 - delta / denominator);
}

function structureScore(design: CanonicalNode, app: CanonicalNode): number {
  const expected = Math.max(1, design.structure.childCount);
  const actual = Math.max(1, app.structure.childCount);
  return clamp(1 - Math.abs(expected - actual) / Math.max(expected, actual));
}

function relationScore(design: CanonicalNode, app: CanonicalNode, designDoc: CanonicalDocument, appDoc: CanonicalDocument): number {
  const sibling = Math.max(design.structure.siblingCount, app.structure.siblingCount, 1);
  const order = 1 - Math.min(1, Math.abs(design.siblingIndex / sibling - app.siblingIndex / sibling));
  const direction = design.structure.layoutDirection === 'unknown' || app.structure.layoutDirection === 'unknown'
    ? 0.5
    : design.structure.layoutDirection === app.structure.layoutDirection ? 1 : 0;
  const parent = design.parentId && app.parentId ? geometryScore(
    designDoc.nodes.find((node) => node.canonicalId === design.parentId) ?? design,
    appDoc.nodes.find((node) => node.canonicalId === app.parentId) ?? app,
    designDoc,
    appDoc,
  ) : 0.5;
  return clamp((order + direction + parent) / 3);
}

function visualScore(design: CanonicalNode, app: CanonicalNode): number {
  const flags = [
    design.visual.hasVisualContent === app.visual.hasVisualContent,
    design.visual.isImage === app.visual.isImage,
    design.visual.isSvg === app.visual.isSvg,
    design.visual.isGradient === app.visual.isGradient,
  ];
  return flags.filter(Boolean).length / flags.length;
}

function contentScore(design: CanonicalNode, app: CanonicalNode): number {
  if (design.content.rawText == null) return 0.5;
  if (app.content.textRedacted) return 0.25;
  return textSimilarity(design.content.rawText, app.content.rawText);
}

function kindScore(design: CanonicalNode, app: CanonicalNode): number {
  if (design.kind === 'unknown' || app.kind === 'unknown') return 0.5;
  if (design.kind === app.kind) return 1;
  if ((design.kind === 'icon' || design.kind === 'image') && (app.kind === 'icon' || app.kind === 'image')) return 0.7;
  if (design.kind === 'container' && app.kind === 'control') return 0.5;
  return 0;
}

function scorePair(design: CanonicalNode, app: CanonicalNode, designDoc: CanonicalDocument, appDoc: CanonicalDocument): { score: number; evidence: NodeMatch['evidence'] } {
  const evidence = {
    geometry: geometryScore(design, app, designDoc, appDoc),
    structure: structureScore(design, app),
    relation: relationScore(design, app, designDoc, appDoc),
    visual: visualScore(design, app),
    content: contentScore(design, app),
    kind: kindScore(design, app),
  };
  const weights = { geometry: 0.28, structure: 0.18, relation: 0.16, visual: 0.16, content: 0.1, kind: 0.12 };
  const score = Object.entries(weights).reduce((total, [key, weight]) => total + weight * evidence[key as keyof typeof evidence], 0);
  return { score: clamp(score), evidence };
}

/** Maximum-score assignment for one sibling group, padded with zero-score dummy entries. */
function maximizeAssignment(matrix: number[][]): Array<{ row: number; column: number }> {
  const size = Math.max(matrix.length, matrix[0]?.length ?? 0);
  if (size === 0) return [];
  const score = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => matrix[row]?.[column] ?? 0));
  const u = new Array<number>(size + 1).fill(0);
  const v = new Array<number>(size + 1).fill(0);
  const p = new Array<number>(size + 1).fill(0);
  const way = new Array<number>(size + 1).fill(0);

  for (let i = 1; i <= size; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(size + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= size; j += 1) {
        if (used[j]) continue;
        const current = -(score[i0 - 1]?.[j - 1] ?? 0) - u[i0]! - v[j]!;
        if (current < minv[j]!) {
          minv[j] = current;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= size; j += 1) {
        if (used[j]) {
          u[p[j]!] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  const result: Array<{ row: number; column: number }> = [];
  for (let column = 1; column <= size; column += 1) {
    const row = p[column]!;
    if (row > 0) result.push({ row: row - 1, column: column - 1 });
  }
  return result;
}

function canonicalMap(document: CanonicalDocument): Map<string, CanonicalNode> {
  return new Map(document.nodes.map((node) => [node.canonicalId, node]));
}

function matchId(designIds: string[], appIds: string[]): string {
  return `match:${designIds.join(',')}:${appIds.join(',')}`;
}

export function matchDocuments(
  designDocument: CanonicalDocument,
  appDocument: CanonicalDocument,
  mapping?: NodeMapping,
): NodeMatch[] {
  const designById = canonicalMap(designDocument);
  const appById = canonicalMap(appDocument);
  const ignoredDesign = new Set(mapping?.ignoredDesignNodeIds ?? []);
  const ignoredApp = new Set(mapping?.ignoredAppNodeIds ?? []);
  const matches: NodeMatch[] = [];
  const matchedDesign = new Set<string>();
  const matchedApp = new Set<string>();
  const confirmed = new Map<string, NodeMatch>();

  for (const manual of mapping?.matches ?? []) {
    if (manual.source !== 'manual') continue;
    if (manual.designNodeIds.every((id) => designById.has(id)) && manual.appNodeIds.every((id) => appById.has(id))) {
      confirmed.set(manual.designNodeIds.join(','), { ...manual, confidence: 1, source: 'manual' });
    }
  }

  // Anchors are the user-confirmed equivalent of a manual match. Keep them in the
  // same reservation path so automatic assignment cannot consume either side.
  for (const anchor of mapping?.anchors ?? []) {
    if (!anchor.confirmed) continue;
    if (!anchor.designNodeIds.every((id) => designById.has(id)) || !anchor.appNodeIds.every((id) => appById.has(id))) continue;
    const key = anchor.designNodeIds.join(',');
    if (confirmed.has(key)) continue;
    confirmed.set(key, {
      id: `anchor:${anchor.id}`,
      designNodeIds: anchor.designNodeIds,
      appNodeIds: anchor.appNodeIds,
      relation: anchor.relation === 'group' ? 'one_to_many' : anchor.relation,
      source: 'manual',
      ruleScore: 1,
      confidence: 1,
      margin: 1,
      evidence: { geometry: 1, structure: 1, relation: 1, visual: 1, content: 1, kind: 1 },
      status: 'matched',
    });
  }

  const visit = (designIds: string[], appIds: string[]): void => {
    const rows = designIds.filter((id) => !ignoredDesign.has(id) && !matchedDesign.has(id));
    const columns = appIds.filter((id) => !ignoredApp.has(id) && !matchedApp.has(id));
    const matrix = rows.map((designId) => columns.map((appId) => scorePair(designById.get(designId)!, appById.get(appId)!, designDocument, appDocument).score));
    const assignments = maximizeAssignment(matrix);

    for (const row of rows) {
      const manual = confirmed.get(row);
      if (!manual) continue;
      matches.push(manual);
      manual.designNodeIds.forEach((id) => matchedDesign.add(id));
      manual.appNodeIds.forEach((id) => matchedApp.add(id));
    }

    for (const assignment of assignments) {
      const designId = rows[assignment.row];
      const appId = columns[assignment.column];
      if (!designId || !appId || matchedDesign.has(designId) || matchedApp.has(appId)) continue;
      const designNode = designById.get(designId)!;
      const appNode = appById.get(appId)!;
      const scored = scorePair(designNode, appNode, designDocument, appDocument);
      if (scored.score < MATCH_THRESHOLD) continue;
      // Top-K 候选直接从**这一行的打分矩阵**取，保证与 ruleScore 同源
      const ranked = columns
        .map((appNodeId, index) => ({ appNodeId, score: matrix[assignment.row]?.[index] ?? 0 }))
        .sort((a, b) => b.score - a.score || a.appNodeId.localeCompare(b.appNodeId));
      const bestAlternative = ranked.find((entry) => entry.appNodeId !== appId)?.score ?? 0;
      const margin = scored.score - bestAlternative;
      const status = scored.score >= AUTO_MATCH_THRESHOLD && margin >= AUTO_MATCH_MARGIN ? 'matched' : 'ambiguous';
      const match: NodeMatch = {
        id: matchId([designId], [appId]),
        designNodeIds: [designId],
        appNodeIds: [appId],
        relation: 'one_to_one',
        source: 'rule',
        ruleScore: scored.score,
        confidence: status === 'matched' ? scored.score : Math.min(scored.score, 0.84),
        margin,
        evidence: scored.evidence,
        status,
        alternatives: status === 'ambiguous' ? ranked.slice(0, TOP_K_CANDIDATES) : undefined,
      };
      matches.push(match);
      matchedDesign.add(designId);
      matchedApp.add(appId);
      visit(designNode.childIds, appNode.childIds);
    }
  };

  visit(designDocument.rootIds, appDocument.rootIds);

  for (const node of designDocument.nodes) {
    if (ignoredDesign.has(node.canonicalId) || matchedDesign.has(node.canonicalId)) continue;
    matches.push({
      id: matchId([node.canonicalId], []),
      designNodeIds: [node.canonicalId],
      appNodeIds: [],
      relation: 'missing',
      source: 'rule',
      ruleScore: 0,
      confidence: node.participation === 'context' ? 0.7 : 0.95,
      margin: 1,
      evidence: { geometry: 0, structure: 0, relation: 0, visual: 0, content: 0, kind: 0 },
      status: 'missing',
    });
  }
  for (const node of appDocument.nodes) {
    if (ignoredApp.has(node.canonicalId) || matchedApp.has(node.canonicalId)) continue;
    matches.push({
      id: matchId([], [node.canonicalId]),
      designNodeIds: [],
      appNodeIds: [node.canonicalId],
      relation: 'extra',
      source: 'rule',
      ruleScore: 0,
      confidence: 0.9,
      margin: 1,
      evidence: { geometry: 0, structure: 0, relation: 0, visual: 0, content: 0, kind: 0 },
      status: 'extra',
    });
  }
  return matches;
}

/**
 * 把 AI 的仲裁结果落到 matches 上。
 *
 * 边界（全部来自 PLAN 对 AI 的约束）：
 *   - **只允许确认，不允许改判**。AI 若指向与规则不同的候选，记为 conflict 并让该条
 *     留在 ambiguous —— 不静默改写，也不静默接受。取「冲突→复核」而不是「按 AI 覆盖」，
 *     是因为规则的候选集本身就是匈牙利算法的最优解，AI 的「另一个更像」需要人来背书。
 *   - **人工映射优先级最高**：source === 'manual' 的条目 AI 碰不到。
 *   - **忽略规则优先**：被忽略的节点不会因为 AI 一句话又回到匹配里。
 *   - **不提高结论等级**：本函数只改 match.status / confidence，
 *     最终 verdict 仍由 evaluateAcceptance 按 P0/P1/unknown 统一裁决。
 */
export interface AiApplicationOutcome {
  /** 被 AI 确认并提升为 matched 的条数 */
  promoted: number;
  /** AI 与规则指向不一致的条数 */
  conflicts: number;
  /** AI 引用了非法/无权限条目而被忽略的次数 */
  ignored: number;
}

export function applyAiCandidates(
  matches: NodeMatch[],
  response: AiAcceptanceResponse,
  candidateSets: ReadonlyMap<string, string[]>,
  ignoredDesign: ReadonlySet<string> = new Set(),
  ignoredApp: ReadonlySet<string> = new Set(),
): AiApplicationOutcome {
  const byDesign = new Map<string, NodeMatch>();
  const claimed = new Map<string, string>();
  for (const match of matches) {
    const designId = match.designNodeIds[0];
    if (designId) byDesign.set(designId, match);
    const appId = match.appNodeIds[0];
    if (appId) claimed.set(appId, match.id);
  }

  let promoted = 0;
  let conflicts = 0;
  let ignored = 0;

  for (const candidate of response.candidates) {
    const match = byDesign.get(candidate.designNodeId);
    if (!match) {
      ignored += 1;
      continue;
    }
    if (match.source === 'manual' || match.status === 'missing' || match.status === 'extra') {
      ignored += 1;
      continue;
    }
    if (match.designNodeIds.some((id) => ignoredDesign.has(id))) {
      ignored += 1;
      continue;
    }
    const chosen = candidate.appNodeIds[0];
    if (!chosen || ignoredApp.has(chosen)) {
      ignored += 1;
      continue;
    }
    const allowed = candidateSets.get(match.id) ?? [];
    if (!allowed.includes(chosen)) {
      ignored += 1;
      continue;
    }
    const owner = claimed.get(chosen);
    if (owner && owner !== match.id) {
      conflicts += 1;
      match.status = 'ambiguous';
      match.confidence = Math.min(match.confidence, 0.84);
      continue;
    }
    if (chosen !== match.appNodeIds[0]) {
      // AI 想把这条指向另一个候选 → 冲突，交给人
      conflicts += 1;
      match.aiScore = candidate.probability;
      match.status = 'ambiguous';
      match.confidence = Math.min(candidate.probability, 0.84);
      continue;
    }

    match.aiScore = candidate.probability;
    if (candidate.probability >= AI_ACCEPT_THRESHOLD) {
      match.status = 'matched';
      match.confidence = candidate.probability;
      match.source = match.source === 'rule' ? 'ai' : 'mixed';
      promoted += 1;
    } else {
      match.status = 'ambiguous';
      match.confidence = Math.min(candidate.probability, 0.84);
    }
  }

  return { promoted, conflicts, ignored };
}

function mergeProfile(profile?: Partial<AcceptanceProfile>): AcceptanceProfile {
  return {
    ...DEFAULT_ACCEPTANCE_PROFILE,
    ...profile,
    geometry: { ...DEFAULT_ACCEPTANCE_PROFILE.geometry, ...(profile?.geometry ?? {}) },
    text: { ...DEFAULT_ACCEPTANCE_PROFILE.text, ...(profile?.text ?? {}) },
    requiredChecks: profile?.requiredChecks ?? DEFAULT_ACCEPTANCE_PROFILE.requiredChecks,
  };
}

function issue(check: string, category: AcceptanceIssue['category'], severity: AcceptanceIssue['severity'], match: NodeMatch, expected: unknown, actual: unknown, delta: unknown, confidence: number, reasonCodes: string[]): AcceptanceIssue {
  return {
    id: `${match.id}:${check}`,
    category,
    severity,
    matchId: match.id,
    designNodeIds: match.designNodeIds,
    appNodeIds: match.appNodeIds,
    check,
    expected,
    actual,
    delta,
    confidence,
    reasonCodes,
    status: 'open',
  };
}

export function evaluateAcceptance(input: {
  design: CanonicalDocument;
  app: CanonicalDocument;
  matches: NodeMatch[];
  source: 'sdk' | 'legacy' | 'unknown';
  coordinateValid: boolean;
  collectionQuality?: CollectionQuality;
  profile?: Partial<AcceptanceProfile>;
  /** matchId → 视觉度量；缺省表示该配对没有视觉证据 */
  visual?: ReadonlyMap<string, MatchVisualMetrics>;
  /**
   * SDK 上报的窗口尺寸与截图尺寸不一致（差值见 `AppSnapshotMeta.coordinateInset`）。
   *
   * 为什么是「记一条 P2」而不是「blocked」：差值通常就是一条系统栏，属于**可校准**的
   * 平移（PLAN 也要求保留系统安全区）。但它会让每个节点的 x/y 偏移一个常量，
   * 于是「位置差异」这一列全部失真 —— 所以结论不能是 PASS，只能停在待复核，
   * 由人决定这条偏移是否可接受。**不阻断**是因为阻断会连带把文案 / 颜色这些
   * 与坐标无关的结论一起废掉，那是过度惩罚。
   */
  windowSizeMismatch?: boolean;
  /** AI 仲裁的执行情况；`requested && !applied` 时不允许 PASS */
  ai?: { requested: boolean; applied: boolean; error?: string };
}): AcceptanceResult {
  const profile = mergeProfile(input.profile);
  const designById = canonicalMap(input.design);
  const appById = canonicalMap(input.app);
  const issues: AcceptanceIssue[] = [];
  let unknownCount = 0;

  for (const match of input.matches) {
    const designNode = match.designNodeIds[0] ? designById.get(match.designNodeIds[0]) : undefined;
    const appNode = match.appNodeIds[0] ? appById.get(match.appNodeIds[0]) : undefined;
    if (match.status === 'missing') {
      if (designNode?.participation !== 'context' && profile.requiredChecks.includes('presence')) {
        issues.push(issue('presence', 'structure', 'P1', match, 'present', 'missing', null, match.confidence, ['DESIGN_NODE_MISSING']));
      }
      continue;
    }
    if (match.status === 'extra') {
      if (appNode?.participation !== 'context') {
        issues.push(issue('extra-node', 'structure', 'P2', match, 'not-present', 'extra', null, match.confidence, ['APP_NODE_EXTRA']));
      }
      continue;
    }
    if (!designNode || !appNode) continue;

    if (match.status === 'ambiguous') {
      unknownCount += 1;
      issues.push(issue('mapping', 'structure', 'P2', match, 'unique-match', 'ambiguous', null, match.confidence, ['LOW_MATCH_CONFIDENCE']));
    }

    if (profile.requiredChecks.includes('geometry')) {
      const scaledApp = transformAppRect(appNode.rect, input.design, input.app);
      const dx = Math.abs(designNode.rect.x - scaledApp.x);
      const dy = Math.abs(designNode.rect.y - scaledApp.y);
      const dw = Math.abs(designNode.rect.width - scaledApp.width);
      const dh = Math.abs(designNode.rect.height - scaledApp.height);
      const toleranceX = Math.max(profile.geometry.positionTolerance, input.design.width * 0.01);
      const toleranceY = Math.max(profile.geometry.positionTolerance, input.design.height * 0.01);
      const toleranceW = Math.max(profile.geometry.sizeTolerance, input.design.width * 0.01);
      const toleranceH = Math.max(profile.geometry.sizeTolerance, input.design.height * 0.01);
      if (dx > toleranceX || dy > toleranceY || dw > toleranceW || dh > toleranceH) {
        issues.push(issue('geometry', 'layout', 'P1', match, designNode.rect, scaledApp, { dx, dy, dw, dh }, match.confidence, ['GEOMETRY_OUT_OF_TOLERANCE']));
      }
    }

    if (profile.requiredChecks.includes('text') && designNode.content.rawText != null) {
      if (appNode.content.textRedacted) {
        unknownCount += 1;
        issues.push(issue('text', 'text', 'P2', match, 'text-present', 'redacted', null, 0.5, ['APP_TEXT_REDACTED']));
      } else if (!normalizedTextEqual(designNode.content.rawText, appNode.content.rawText)) {
        issues.push(issue('text', 'text', 'P1', match, designNode.content.rawText, appNode.content.rawText, null, match.confidence, ['TEXT_MISMATCH']));
      }
    }

    // 视觉判定只对「有像素可看」的节点做：纯布局容器（participation=context）
    // 本来就不该有视觉结论，拿它去比会把容器底色差异误报成缺陷。
    if (profile.requiredChecks.includes('visual') && designNode.participation !== 'context') {
      const metrics = input.visual?.get(match.id);
      if (!metrics || metrics.unavailable) {
        // 必检项没有证据 → 计数为 unknown，结论最多 review，绝不 PASS。
        // 这与「特征缺失按 0 分」是两件事：0 分会被当成「极其不像」而误判成缺陷。
        unknownCount += 1;
      } else {
        if (typeof metrics.colorDeltaE === 'number') {
          if (metrics.colorDeltaE > DELTA_E_REVIEW) {
            issues.push(issue('color', 'color', 'P1', match, 'deltaE<=3', metrics.colorDeltaE, metrics.colorDeltaE, match.confidence, ['COLOR_DELTA_E_OVER_FAIL']));
          } else if (metrics.colorDeltaE > DELTA_E_PASS) {
            issues.push(issue('color', 'color', 'P2', match, 'deltaE<=3', metrics.colorDeltaE, metrics.colorDeltaE, match.confidence, ['COLOR_DELTA_E_REVIEW']));
          }
        }
        const hashed = typeof metrics.pHashDistance === 'number' && metrics.pHashDistance >= 0;
        if (hashed && typeof metrics.ssim === 'number') {
          if (metrics.pHashDistance! > PHASH_PASS_DISTANCE || metrics.ssim < SSIM_PASS) {
            // 图片/图标走 asset 类别（「图换了」），其余走 visual（「样子变了」）
            const isAsset = designNode.kind === 'image' || designNode.kind === 'icon';
            issues.push(issue(
              isAsset ? 'asset-differs' : 'visual-differs',
              isAsset ? 'asset' : 'visual',
              'P2',
              match,
              { pHashDistance: `<=${PHASH_PASS_DISTANCE}`, ssim: `>=${SSIM_PASS}` },
              { pHashDistance: metrics.pHashDistance, ssim: metrics.ssim },
              null,
              match.confidence,
              ['VISUAL_DIFFERS'],
            ));
          }
        }
      }
    }
  }

  const collectionTruncated = !!input.collectionQuality && (input.collectionQuality.depthLimitReached || input.collectionQuality.nodeLimitReached);
  const blockingReasons = [
    input.source !== 'sdk' ? 'APP_NODE_SOURCE_NOT_SDK' : null,
    !input.collectionQuality ? 'COLLECTION_QUALITY_MISSING' : null,
    !input.coordinateValid ? 'COORDINATE_INVALID' : null,
    collectionTruncated && profile.failOnCollectionTruncation ? 'COLLECTION_TRUNCATED' : null,
  ].filter((reason): reason is string => reason !== null);

  // AI 被要求参与却没能参与（未配置 / 网络失败 / 响应非法）→ 记一条 open 问题。
  // 这条不能省：否则「AI 挂了」与「AI 说没问题」在结论上无法区分。
  if (input.ai?.requested && !input.ai.applied) {
    const aiMatch: NodeMatch = {
      id: 'acceptance:ai',
      designNodeIds: [],
      appNodeIds: [],
      relation: 'one_to_one',
      source: 'rule',
      ruleScore: 0,
      confidence: 1,
      margin: 1,
      evidence: { geometry: 0, structure: 0, relation: 0, visual: 0, content: 0, kind: 0 },
      status: 'ambiguous',
    };
    issues.push(
      issue('ai-arbitration', 'process', 'P2', aiMatch, 'ai-applied', input.ai.error ?? 'not-applied', null, 1, ['AI_UNAVAILABLE']),
    );
  }

  if (input.windowSizeMismatch) {
    const windowMatch: NodeMatch = {
      id: 'acceptance:window',
      designNodeIds: [],
      appNodeIds: [],
      relation: 'one_to_one',
      source: 'rule',
      ruleScore: 0,
      confidence: 1,
      margin: 1,
      evidence: { geometry: 0, structure: 0, relation: 0, visual: 0, content: 0, kind: 0 },
      status: 'ambiguous',
    };
    issues.push(
      issue(
        'window-size',
        'process',
        'P2',
        windowMatch,
        'sdk window === screenshot',
        'SDK 窗口尺寸与截图不一致',
        null,
        1,
        ['WINDOW_SIZE_MISMATCH'],
      ),
    );
  }

  const verdict: AcceptanceResult['verdict'] = blockingReasons.length > 0
    ? 'blocked'
    : issues.some((item) => item.severity === 'P0' || item.severity === 'P1')
    ? 'fail'
    : unknownCount > 0 || issues.some((item) => item.status === 'open')
    ? 'review'
    : 'pass';

  if (blockingReasons.length > 0) {
    const blockedMatch: NodeMatch = {
      id: 'acceptance:readiness',
      designNodeIds: [],
      appNodeIds: [],
      relation: 'one_to_one',
      source: 'rule',
      ruleScore: 0,
      confidence: 1,
      margin: 1,
      evidence: { geometry: 0, structure: 0, relation: 0, visual: 0, content: 0, kind: 0 },
      status: 'ambiguous',
    };
    issues.push(issue('readiness', 'structure', 'P0', blockedMatch, 'valid SDK snapshot', blockingReasons, null, 1, blockingReasons));
  }

  return {
    verdict,
    source: input.source,
    coordinateValid: input.coordinateValid,
    collectionQuality: input.collectionQuality,
    matches: input.matches,
    issues,
    summary: {
      designNodeCount: input.design.nodes.length,
      appNodeCount: input.app.nodes.length,
      matchedCount: input.matches.filter((match) => match.status === 'matched').length,
      missingCount: input.matches.filter((match) => match.status === 'missing').length,
      extraCount: input.matches.filter((match) => match.status === 'extra').length,
      ambiguousCount: input.matches.filter((match) => match.status === 'ambiguous').length,
      unknownCount,
    },
    readinessReasons: blockingReasons,
  };
}
