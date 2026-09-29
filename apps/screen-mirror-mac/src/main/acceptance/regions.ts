import type {
  AiRegionDecision,
  AiRegionProposal,
  CanonicalDocument,
  CanonicalNode,
  ImageRef,
  NodeMapping,
  NodeMatch,
  PageDocument,
  RegionAcceptanceResult,
  RegionMatch,
  RegionOverride,
  RegionMatchEvidence,
  ModuleNodeCandidate,
  ModuleNodeResolution,
  UiRegion,
  UiRegionRole,
  ViewportInfo,
} from '../../types/aiAcceptance';
import type { Rect } from '../../types/verify';

const REGION_MATCH_FLOOR = 0.48;
const REGION_AUTO_MATCH = 0.7;
const REGION_AUTO_MARGIN = 0.08;
const NODE_MATCH_FLOOR = 0.64;
const NODE_AUTO_MATCH = 0.79;
const NODE_AUTO_MARGIN = 0.06;

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const area = (rect: Rect): number => Math.max(0, rect.width) * Math.max(0, rect.height);
const centerX = (rect: Rect): number => rect.x + rect.width / 2;
const centerY = (rect: Rect): number => rect.y + rect.height / 2;

function intersection(first: Rect, second: Rect): Rect | null {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function iou(first: Rect, second: Rect): number {
  const overlap = intersection(first, second);
  if (!overlap) return 0;
  return area(overlap) / Math.max(1, area(first) + area(second) - area(overlap));
}

function overlapOfSmaller(first: Rect, second: Rect): number {
  const overlap = intersection(first, second);
  return overlap ? area(overlap) / Math.max(1, Math.min(area(first), area(second))) : 0;
}

function contains(outer: Rect, inner: Rect, tolerance = 2): boolean {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, '').toLocaleLowerCase();
}

function textSet(nodes: readonly CanonicalNode[]): string[] {
  return [...new Set(nodes.map((node) => normalizeText(node.content.rawText)).filter(Boolean))];
}

function jaccard(first: readonly string[], second: readonly string[]): number {
  if (first.length === 0 && second.length === 0) return 0.5;
  const a = new Set(first);
  const b = new Set(second);
  let common = 0;
  for (const value of a) if (b.has(value)) common += 1;
  return common / Math.max(1, a.size + b.size - common);
}

function descendants(root: CanonicalNode, byId: ReadonlyMap<string, CanonicalNode>): CanonicalNode[] {
  const output: CanonicalNode[] = [];
  const queue = [...root.childIds];
  const seen = new Set<string>();
  while (queue.length > 0 && output.length < 5000) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    output.push(node);
    queue.push(...node.childIds);
  }
  return output;
}

function inferFixedNodes(document: CanonicalDocument): string[] {
  const navigationWords = new Set(['首页', '分类', '购物车', '我的', '许愿池']);
  const navigationTexts = document.nodes.filter((node) => navigationWords.has(normalizeText(node.content.rawText)));
  const output = new Set<string>();
  if (navigationTexts.length >= 3) {
    const averageY = navigationTexts.reduce((sum, node) => sum + centerY(node.rect), 0) / navigationTexts.length;
    if (averageY >= document.height * 0.75) navigationTexts.forEach((node) => output.add(node.canonicalId));
  }
  for (const node of document.nodes) {
    const resource = normalizeText(node.content.resourceName);
    const description = normalizeText(node.content.contentDescription);
    if (/statusbar|navigationbar/.test(resource) || /采集|上传节点|上传中/.test(description)) {
      output.add(node.canonicalId);
    }
  }
  return [...output];
}

function buildViewport(document: CanonicalDocument, counterpart?: CanonicalDocument): ViewportInfo {
  const fixedNodeIds = inferFixedNodes(document);
  const fixed = document.nodes.filter((node) => fixedNodeIds.includes(node.canonicalId));
  const bottomSystem = fixed
    .filter((node) => /navigationbar/i.test(node.content.resourceName ?? ''))
    .reduce((value, node) => Math.max(value, document.height - node.rect.y), 0);
  const topSystem = fixed
    .filter((node) => /statusbar/i.test(node.content.resourceName ?? ''))
    .reduce((value, node) => Math.max(value, node.rect.y + node.rect.height), 0);
  const comparableHeight = counterpart
    ? Math.min(document.height, counterpart.height * document.width / Math.max(1, counterpart.width))
    : document.height;
  return {
    rect: { x: 0, y: 0, width: document.width, height: document.height },
    comparableRect: { x: 0, y: 0, width: document.width, height: comparableHeight },
    systemInsets: { top: topSystem, right: 0, bottom: bottomSystem, left: 0 },
    fixedNodeIds,
    excludedNodeIds: fixed.filter((node) => /statusbar|navigationbar/i.test(node.content.resourceName ?? '')).map((node) => node.canonicalId),
  };
}

function inferRole(node: CanonicalNode, members: readonly CanonicalNode[], document: CanonicalDocument, fixed: boolean): UiRegionRole {
  const text = textSet(members).join('|');
  if (fixed && /首页|分类|购物车|我的|许愿池/.test(text)) return 'navigation';
  if (node.rect.y <= document.height * 0.08 && node.rect.height <= document.height * 0.22) return 'header';
  if (/线下|专卖店|地址|km/.test(text)) return 'store';
  if (/精选好物|¥|自营/.test(text)) return 'product';
  const ratio = node.rect.width / Math.max(1, node.rect.height);
  if (ratio >= 3.2 && node.rect.height <= document.height * 0.2) return 'banner';
  const visibleChildren = members.filter((item) => item.parentId === node.canonicalId && item.visible && area(item.rect) > 0);
  if (visibleChildren.length >= 4) {
    const xs = new Set(visibleChildren.map((item) => Math.round(item.rect.x / 8)));
    const ys = new Set(visibleChildren.map((item) => Math.round(item.rect.y / 8)));
    if (xs.size >= 2 && ys.size >= 2) return 'grid';
    return 'list';
  }
  return 'card';
}

function candidateRegions(document: CanonicalDocument, viewport: ViewportInfo): UiRegion[] {
  const byId = new Map(document.nodes.map((node) => [node.canonicalId, node]));
  const viewportRect = viewport.rect;
  const maxHeight = Math.max(180, viewport.rect.height * 0.55);
  const candidates = document.nodes.filter((node) => {
    if (!node.visible || node.participation !== 'required' || node.salience === 'layout') return false;
    if (node.rect.width < document.width * 0.58 || node.rect.height < 28 || node.rect.height > maxHeight) return false;
    if (area(node.rect) >= area(viewportRect) * 0.82) return false;
    return intersection(node.rect, viewportRect) !== null;
  }).map((node) => {
    const nested = descendants(node, byId).filter((item) => contains(node.rect, item.rect));
    const spatial = document.nodes.filter((item) => item.canonicalId !== node.canonicalId && contains(node.rect, item.rect));
    const members = [...new Map([...nested, ...spatial, node].map((item) => [item.canonicalId, item])).values()];
    const fixed = [node, ...nested].some((item) => viewport.fixedNodeIds.includes(item.canonicalId));
    const visible = intersection(node.visibleRect ?? node.rect, viewport.rect);
    return {
      id: `region:${node.canonicalId}`,
      source: document.source,
      origin: 'rule',
      role: inferRole(node, members, document, fixed),
      rect: node.rect,
      visibleRect: visible,
      nodeIds: members.map((item) => item.canonicalId),
      childRegionIds: [],
      text: textSet(members),
      visualFeatures: {
        hasVisualContent: members.some((item) => item.visual.hasVisualContent),
        imageCount: members.filter((item) => item.kind === 'image').length,
        iconCount: members.filter((item) => item.kind === 'icon').length,
        textCount: members.filter((item) => item.kind === 'text').length,
      },
      layout: node.structure.layoutDirection,
      fixed,
      scrollable: node.clipped || node.rect.height > (visible?.height ?? node.rect.height) + 2,
      confidence: node.visual.hasVisualContent ? 0.9 : node.structure.subtreeNodeCount >= 3 ? 0.78 : 0.65,
      order: 0,
    } satisfies UiRegion;
  });

  // Keep first-level content bands. Narrow nested banners/grids remain nodes inside the band;
  // treating them as peer regions makes one card compete with its own children.
  const wideCandidates = candidates.filter((item) => item.rect.width >= document.width * 0.9 && item.rect.height >= 50);

  // Collapse duplicate native/Figma wrappers that describe the same painted rectangle.
  const selected: UiRegion[] = [];
  for (const candidate of wideCandidates.sort((a, b) => a.rect.y - b.rect.y || area(b.rect) - area(a.rect))) {
    const duplicate = selected.find((item) => iou(item.rect, candidate.rect) >= 0.86);
    if (duplicate) {
      if (candidate.nodeIds.length > duplicate.nodeIds.length) {
        duplicate.nodeIds = candidate.nodeIds;
        duplicate.text = candidate.text;
        duplicate.visualFeatures = candidate.visualFeatures;
      }
      continue;
    }
    // Prefer card-sized peers over a container that merely covers several already selected cards.
    const overlaps = selected.filter((item) => intersection(item.rect, candidate.rect) && iou(item.rect, candidate.rect) < 0.4);
    if (overlaps.length >= 2 && candidate.rect.height > overlaps.reduce((sum, item) => sum + item.rect.height, 0) * 0.8) continue;
    selected.push(candidate);
  }

  // A framework wrapper often covers two or more real painted bands. If those bands account for
  // most of its height, the wrapper is structural rather than a content region.
  const withoutWrappers = selected.filter((candidate) => {
    const contained = selected.filter((item) => item !== candidate
      && item.rect.y >= candidate.rect.y - 2
      && item.rect.y + item.rect.height <= candidate.rect.y + candidate.rect.height + 2
      && item.rect.height < candidate.rect.height * 0.82);
    const coveredHeight = contained.reduce((sum, item) => sum + item.rect.height, 0);
    return contained.length < 2 || coveredHeight < candidate.rect.height * 0.55;
  });

  // Select a deterministic non-overlapping top-level sequence. This is the region graph's root
  // level; nested structure is retained through nodeIds and can be split by AI later.
  const ordered = withoutWrappers.sort((a, b) => a.rect.y + a.rect.height - (b.rect.y + b.rect.height));
  const previous = ordered.map((candidate, index) => {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (ordered[cursor]!.rect.y + ordered[cursor]!.rect.height <= candidate.rect.y + 2) return cursor;
    }
    return -1;
  });
  const score = (region: UiRegion): number => 1 + region.rect.width / document.width
    + Math.min(0.35, region.rect.height / Math.max(1, viewport.rect.height)) + region.confidence * 0.2;
  const dp = new Array<number>(ordered.length + 1).fill(0);
  for (let index = 1; index <= ordered.length; index += 1) {
    const take = score(ordered[index - 1]!) + dp[previous[index - 1]! + 1]!;
    dp[index] = Math.max(dp[index - 1]!, take);
  }
  const topLevel: UiRegion[] = [];
  for (let index = ordered.length; index > 0;) {
    const candidate = ordered[index - 1]!;
    const take = score(candidate) + dp[previous[index - 1]! + 1]!;
    if (take >= dp[index - 1]! - 1e-9) {
      topLevel.push(candidate);
      index = previous[index - 1]! + 1;
    } else {
      index -= 1;
    }
  }

  topLevel.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  topLevel.forEach((region, index) => { region.order = index; });
  return topLevel;
}

export function buildPageDocument(
  document: CanonicalDocument,
  screenshot: ImageRef,
  counterpart?: CanonicalDocument,
  options?: { includeRegions?: boolean },
): PageDocument {
  const viewport = buildViewport(document, counterpart);
  return {
    source: document.source,
    width: document.width,
    height: document.height,
    screenshot,
    nodes: document.nodes,
    viewport,
    regions: options?.includeRegions === false ? [] : candidateRegions(document, viewport),
  };
}

function proposalRect(proposal: AiRegionProposal, page: PageDocument): Rect {
  return {
    x: proposal.normalizedRect.x * page.width,
    y: proposal.normalizedRect.y * page.height,
    width: proposal.normalizedRect.width * page.width,
    height: proposal.normalizedRect.height * page.height,
  };
}

export interface ModuleBox {
  leftTop: { x: number; y: number };
  rightBottom: { x: number; y: number };
}

const rectFromModuleBox = (box: ModuleBox): Rect => {
  const left = Math.min(box.leftTop.x, box.rightBottom.x);
  const top = Math.min(box.leftTop.y, box.rightBottom.y);
  const right = Math.max(box.leftTop.x, box.rightBottom.x);
  const bottom = Math.max(box.leftTop.y, box.rightBottom.y);
  return { x: left, y: top, width: right - left, height: bottom - top };
};

function cornerScore(target: Rect, candidate: Rect, page: PageDocument): number {
  const error = (
    Math.abs(target.x - candidate.x) / Math.max(1, page.width)
    + Math.abs(target.y - candidate.y) / Math.max(1, page.height)
    + Math.abs(target.x + target.width - candidate.x - candidate.width) / Math.max(1, page.width)
    + Math.abs(target.y + target.height - candidate.y - candidate.height) / Math.max(1, page.height)
  ) / 4;
  // AI's rectangle is visual evidence, so allow a few pixels of raster/coordinate drift.
  return clamp(1 - error / 0.045);
}

function sizeScore(target: Rect, candidate: Rect, page: PageDocument): number {
  const error = (
    Math.abs(target.width - candidate.width) / Math.max(1, page.width)
    + Math.abs(target.height - candidate.height) / Math.max(1, page.height)
  ) / 2;
  return clamp(1 - error / 0.22);
}

function moduleNodeStructureScore(node: CanonicalNode): number {
  if (node.participation === 'required' && node.salience === 'box') return 1;
  if (node.salience === 'graphic' || node.salience === 'text') return 0.78;
  if (node.participation === 'optional' || node.participation === 'context') return 0.58;
  return 0.4;
}

/**
 * Resolve an AI visual module rectangle to the native node closest to both
 * diagonal corners. The rectangle itself remains authoritative; the node is
 * only an explainable anchor for navigation and later evidence.
 */
export function resolveModuleNode(page: PageDocument, box: ModuleBox): ModuleNodeResolution {
  const target = rectFromModuleBox(box);
  if (target.width <= 0 || target.height <= 0) {
    return { nodeId: null, confidence: 0, status: 'not-found', candidates: [] };
  }
  const excluded = new Set(page.viewport.excludedNodeIds);
  const candidates: ModuleNodeCandidate[] = page.nodes
    .filter((node) => node.visible && !excluded.has(node.canonicalId))
    .filter((node) => node.participation !== 'ignored' && node.participation !== 'unavailable')
    .filter((node) => !page.nodes.some((root) => root.canonicalId === node.canonicalId && root.parentId === null))
    .filter((node) => !(node.passThrough && area(node.rect) >= area(page.viewport.rect) * 0.98))
    .map((node): ModuleNodeCandidate | null => {
      const nodeRect = node.visibleRect ?? node.rect;
      if (area(nodeRect) <= 0) return null;
      const corners = cornerScore(target, nodeRect, page);
      const overlap = iou(target, nodeRect);
      const size = sizeScore(target, nodeRect, page);
      const structure = moduleNodeStructureScore(node);
      return {
        nodeId: node.canonicalId,
        score: clamp(corners * 0.5 + overlap * 0.25 + size * 0.15 + structure * 0.1),
        depth: node.depth,
        cornerScore: corners,
        iouScore: overlap,
        sizeScore: size,
        nested: false,
      };
    })
    .filter((candidate): candidate is ModuleNodeCandidate => !!candidate)
    .sort((first, second) => second.score - first.score || first.nodeId.localeCompare(second.nodeId));
  const byId = new Map(page.nodes.map((node) => [node.canonicalId, node]));
  const best = candidates[0];
  const feasible = candidates.filter((candidate) => candidate.score >= 0.45);
  if (!best || feasible.length === 0) {
    return { nodeId: null, confidence: best?.score ?? 0, status: 'not-found', candidates: candidates.slice(0, 8) };
  }

  // Nesting is a selection rule, not a tie-breaker limited to the nearest
  // score. A card container may score below its title child because the AI
  // boundary includes a little visual padding, but it is still the correct
  // module anchor when both nodes satisfy the geometry floor. Keep every
  // feasible node in this pass; only the diagnostic list is capped.
  const feasibleIds = new Set(feasible.map((candidate) => candidate.nodeId));
  for (const candidate of feasible) {
    let child = byId.get(candidate.nodeId);
    const seen = new Set<string>();
    while (child?.parentId && !seen.has(child.parentId)) {
      seen.add(child.parentId);
      const parent = byId.get(child.parentId);
      if (!parent) break;
      if (feasibleIds.has(parent.canonicalId)
        && contains(parent.visibleRect ?? parent.rect, child.visibleRect ?? child.rect, 2)) {
        candidate.nested = true;
        break;
      }
      child = parent;
    }
  }
  const outermost = feasible.filter((candidate) => !candidate.nested);
  const selected = outermost.length > 0
    ? [...outermost].sort((first, second) => {
      const firstNode = byId.get(first.nodeId)!;
      const secondNode = byId.get(second.nodeId)!;
      return firstNode.depth - secondNode.depth || second.score - first.score;
    })[0]!
    : best;
  const confidence = selected.score;
  return {
    nodeId: selected.nodeId,
    confidence,
    status: 'matched',
    candidates: feasible.slice(0, 8),
  };
}

/** Resolve an AI region whose corners are normalized to the source page. */
export function resolveRegionNode(
  page: PageDocument,
  input: { leftTop: { x: number; y: number }; rightBottom: { x: number; y: number } },
): ModuleNodeResolution {
  return resolveModuleNode(page, {
    leftTop: { x: input.leftTop.x * page.width, y: input.leftTop.y * page.height },
    rightBottom: { x: input.rightBottom.x * page.width, y: input.rightBottom.y * page.height },
  });
}

/** Convert AI visual proposals into locally-owned stable regions. */
export function validateRegionProposals(
  page: PageDocument,
  proposals: readonly AiRegionProposal[],
  candidates: readonly UiRegion[] = page.regions,
): UiRegion[] {
  const usable = proposals
    .filter((proposal) => proposal.source === page.source && proposal.confidence >= 0.6)
    .map((proposal) => ({ proposal, rect: proposalRect(proposal, page) }))
    .filter(({ rect }) => area(rect) >= 32 * 16 && area(rect) <= page.width * page.height * 0.92)
    .sort((first, second) => second.proposal.confidence - first.proposal.confidence
      || first.rect.y - second.rect.y || first.rect.x - second.rect.x);
  const deduped: typeof usable = [];
  for (const item of usable) {
    if (deduped.some((accepted) => overlapOfSmaller(accepted.rect, item.rect) > 0.7
      && Math.abs(accepted.rect.y - item.rect.y) < page.height * 0.05)) continue;
    deduped.push(item);
  }

  const fixedIds = new Set(page.viewport.fixedNodeIds);
  const excludedIds = new Set(page.viewport.excludedNodeIds);
  const regions = deduped.map(({ proposal, rect }) => {
    const members = page.nodes.filter((node) => {
      if (!node.visible || excludedIds.has(node.canonicalId)) return false;
      const visible = node.visibleRect ?? node.rect;
      const centerInside = centerX(visible) >= rect.x && centerX(visible) <= rect.x + rect.width
        && centerY(visible) >= rect.y && centerY(visible) <= rect.y + rect.height;
      return centerInside || iou(visible, rect) >= 0.15;
    });
    const business = members.filter((node) => node.participation === 'required' && node.salience !== 'layout');
    // Keep the AI rectangle as the visual module boundary. Node bounds are only
    // supporting evidence; replacing the rectangle with a union of native nodes
    // would erase configured backgrounds and visual-only spacing.
    const snapped = rect;
    const supportingCandidates = candidates.filter((candidate) => overlapOfSmaller(candidate.rect, snapped) >= 0.45);
    const moduleNode = resolveModuleNode(page, {
      leftTop: { x: rect.x, y: rect.y },
      rightBottom: { x: rect.x + rect.width, y: rect.y + rect.height },
    });
    const fixed = proposal.fixed || members.some((node) => fixedIds.has(node.canonicalId));
    const visual = intersection(snapped, page.viewport.rect);
    return {
      id: '',
      source: page.source,
      origin: 'ai' as const,
      role: proposal.role,
      rect: snapped,
      visibleRect: visual,
      nodeIds: members.map((node) => node.canonicalId),
      childRegionIds: [],
      text: textSet(members),
      visualFeatures: {
        hasVisualContent: members.some((node) => node.visual.hasVisualContent),
        imageCount: members.filter((node) => node.kind === 'image').length,
        iconCount: members.filter((node) => node.kind === 'icon').length,
        textCount: members.filter((node) => node.kind === 'text').length,
      },
      layout: proposal.layout,
      fixed,
      scrollable: proposal.scrollable,
      confidence: proposal.confidence,
      order: 0,
      reasonCodes: proposal.reasonCodes,
      support: {
        mode: business.length === 0 ? 'visual-only' as const : supportingCandidates.length > 0 ? 'mixed' as const : 'nodes' as const,
        anchorNodeIds: business.map((node) => node.canonicalId),
        candidateRegionIds: supportingCandidates.map((candidate) => candidate.id),
        ...(moduleNode.nodeId ? { moduleNodeId: moduleNode.nodeId } : {}),
        moduleNodeConfidence: moduleNode.confidence,
        moduleNodeStatus: moduleNode.status,
        moduleNodeCandidates: moduleNode.candidates,
      },
    } satisfies UiRegion;
  }).sort((first, second) => first.rect.y - second.rect.y || first.rect.x - second.rect.x);
  regions.forEach((region, index) => {
    region.id = `${page.source}-region-${String(index + 1).padStart(3, '0')}`;
    region.order = index;
  });
  return regions;
}

function transformAppRect(rect: Rect, design: PageDocument, app: PageDocument, fixed: boolean): Rect {
  const scale = design.width / Math.max(1, app.width);
  if (fixed) {
    const bottom = (app.height - rect.y - rect.height) * scale;
    return { x: rect.x * scale, y: design.height - bottom - rect.height * scale, width: rect.width * scale, height: rect.height * scale };
  }
  return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

function compatibleRole(design: UiRegionRole, app: UiRegionRole): number {
  if (design === app) return 1;
  const containers = new Set<UiRegionRole>(['card', 'grid', 'list', 'product', 'store', 'unknown']);
  if (containers.has(design) && containers.has(app)) return 0.72;
  if ((design === 'banner' && app === 'card') || (design === 'card' && app === 'banner')) return 0.55;
  return 0;
}

function regionEvidence(designRegion: UiRegion, appRegion: UiRegion, design: PageDocument, app: PageDocument): RegionMatchEvidence {
  const actual = transformAppRect(appRegion.rect, design, app, designRegion.fixed || appRegion.fixed);
  const expected = designRegion.rect;
  const distance = Math.abs(centerX(expected) - centerX(actual)) / Math.max(1, design.width)
    + Math.abs(centerY(expected) - centerY(actual)) / Math.max(1, design.viewport.comparableRect.height);
  const size = 1 - Math.min(1, (Math.abs(expected.width - actual.width) + Math.abs(expected.height - actual.height))
    / Math.max(1, expected.width + expected.height));
  const geometry = clamp((iou(expected, actual) * 1.4 + size + clamp(1 - distance * 2)) / 3.4);
  const maxOrder = Math.max(1, design.regions.length - 1, app.regions.length - 1);
  const order = clamp(1 - Math.abs(designRegion.order - appRegion.order) / maxOrder);
  const structure = clamp(1 - Math.abs(designRegion.nodeIds.length - appRegion.nodeIds.length)
    / Math.max(1, designRegion.nodeIds.length, appRegion.nodeIds.length));
  const imageDelta = Math.abs(designRegion.visualFeatures.imageCount - appRegion.visualFeatures.imageCount);
  const imageSimilarity = clamp(1 - imageDelta / Math.max(1, designRegion.visualFeatures.imageCount, appRegion.visualFeatures.imageCount));
  const visualSignals = [imageSimilarity];
  const designColor = designRegion.visualFeatures.dominantColor;
  const appColor = appRegion.visualFeatures.dominantColor;
  if (designColor && appColor) {
    const distance = Math.sqrt(
      (designColor.r - appColor.r) ** 2 + (designColor.g - appColor.g) ** 2 + (designColor.b - appColor.b) ** 2,
    );
    visualSignals.push(clamp(1 - distance / 220));
  }
  const designHash = designRegion.visualFeatures.pHash;
  const appHash = appRegion.visualFeatures.pHash;
  if (designHash && appHash && designHash.length === appHash.length) {
    let different = 0;
    for (let index = 0; index < designHash.length; index += 1) if (designHash[index] !== appHash[index]) different += 1;
    visualSignals.push(clamp(1 - different / Math.max(1, designHash.length)));
  }
  const designEdges = designRegion.visualFeatures.edgeDensity;
  const appEdges = appRegion.visualFeatures.edgeDensity;
  if (designEdges !== undefined && appEdges !== undefined) {
    visualSignals.push(clamp(1 - Math.abs(designEdges - appEdges) / Math.max(0.08, designEdges, appEdges)));
  }
  const visual = visualSignals.reduce((sum, value) => sum + value, 0) / visualSignals.length;
  return {
    role: compatibleRole(designRegion.role, appRegion.role),
    geometry,
    text: jaccard(designRegion.text, appRegion.text),
    visual,
    structure,
    order,
  };
}

function regionScore(evidence: RegionMatchEvidence): number {
  return clamp(evidence.role * 0.18 + evidence.geometry * 0.32 + evidence.text * 0.18
    + evidence.visual * 0.1 + evidence.structure * 0.08 + evidence.order * 0.14);
}

export function matchRegions(design: PageDocument, app: PageDocument): RegionMatch[] {
  const candidates = design.regions.flatMap((designRegion) => app.regions.map((appRegion) => {
    const evidence = regionEvidence(designRegion, appRegion, design, app);
    return { designRegion, appRegion, evidence, score: regionScore(evidence) };
  })).filter((item) => item.evidence.role > 0 && item.score >= REGION_MATCH_FLOOR)
    .sort((a, b) => b.score - a.score || a.designRegion.id.localeCompare(b.designRegion.id));
  const usedDesign = new Set<string>();
  const usedApp = new Set<string>();
  const matches: RegionMatch[] = [];

  for (const candidate of candidates) {
    if (usedDesign.has(candidate.designRegion.id) || usedApp.has(candidate.appRegion.id)) continue;
    const alternatives = candidates
      .filter((item) => item.designRegion.id === candidate.designRegion.id)
      .slice(0, 3)
      .map((item) => ({ appRegionId: item.appRegion.id, score: item.score }));
    const second = alternatives.find((item) => item.appRegionId !== candidate.appRegion.id)?.score ?? 0;
    const matched = candidate.score >= REGION_AUTO_MATCH && candidate.score - second >= REGION_AUTO_MARGIN;
    matches.push({
      id: `region-match:${candidate.designRegion.id}:${candidate.appRegion.id}`,
      designRegionIds: [candidate.designRegion.id],
      appRegionIds: [candidate.appRegion.id],
      relation: 'one_to_one',
      confidence: candidate.score,
      evidence: candidate.evidence,
      status: matched ? 'matched' : 'ambiguous',
      alternatives,
    });
    usedDesign.add(candidate.designRegion.id);
    usedApp.add(candidate.appRegion.id);
  }
  for (const region of design.regions) {
    if (!usedDesign.has(region.id)) matches.push({
      id: `region-missing:${region.id}`,
      designRegionIds: [region.id], appRegionIds: [], relation: 'missing', confidence: 0.9,
      evidence: { role: 0, geometry: 0, text: 0, visual: 0, structure: 0, order: 0 }, status: 'missing',
    });
  }
  for (const region of app.regions) {
    if (!usedApp.has(region.id)) matches.push({
      id: `region-extra:${region.id}`,
      designRegionIds: [], appRegionIds: [region.id], relation: 'extra', confidence: 0.85,
      evidence: { role: 0, geometry: 0, text: 0, visual: 0, structure: 0, order: 0 }, status: 'extra',
    });
  }
  return matches;
}

/**
 * AI 只能确认规则引擎已经提出的区域候选。首版不允许它把某个 App 区域改配给
 * 另一个设计区域，因为那会级联破坏后续区域；拆分/合并先作为 observation 留给人工复核。
 */
export function applyAiRegionDecision(
  matches: RegionMatch[],
  decision: AiRegionDecision,
  minimumProbability = 0.85,
): number {
  let applied = 0;
  for (const item of decision.regionMatches) {
    if (item.probability < minimumProbability || item.designRegionIds.length !== 1 || item.appRegionIds.length !== 1) continue;
    if (item.relation !== 'one_to_one') continue;
    const match = matches.find((candidate) => candidate.status === 'ambiguous'
      && candidate.designRegionIds.length === 1
      && candidate.designRegionIds[0] === item.designRegionIds[0]);
    if (!match) continue;
    const allowedAppIds = new Set([
      ...match.appRegionIds,
      ...(match.alternatives ?? []).map((candidate) => candidate.appRegionId),
    ]);
    if (!allowedAppIds.has(item.appRegionIds[0]!)) continue;
    // Re-targeting an already allocated App region would invalidate another region match.
    if (match.appRegionIds[0] !== item.appRegionIds[0]) continue;
    match.status = 'matched';
    match.relation = 'one_to_one';
    match.confidence = Math.max(match.confidence, item.probability);
    applied += 1;
  }
  return applied;
}

export function mergeAiRegionAlignment(
  design: PageDocument,
  app: PageDocument,
  deterministic: readonly RegionMatch[],
  decision: AiRegionDecision,
): RegionMatch[] {
  const designById = new Map(design.regions.map((region) => [region.id, region]));
  const appById = new Map(app.regions.map((region) => [region.id, region]));
  const usedDesign = new Set<string>();
  const usedApp = new Set<string>();
  const accepted: RegionMatch[] = [];
  const contiguous = (ids: readonly string[], source: ReadonlyMap<string, UiRegion>): boolean => {
    const orders = ids.map((id) => source.get(id)?.order).filter((order): order is number => order !== undefined).sort((a, b) => a - b);
    return orders.every((order, index) => index === 0 || order - orders[index - 1]! <= 1);
  };

  for (const item of [...decision.regionMatches].sort((first, second) => second.probability - first.probability)) {
    if (item.probability < 0.6) continue;
    if (item.designRegionIds.some((id) => !designById.has(id) || usedDesign.has(id))) continue;
    if (item.appRegionIds.some((id) => !appById.has(id) || usedApp.has(id))) continue;
    if (!contiguous(item.designRegionIds, designById) || !contiguous(item.appRegionIds, appById)) continue;
    const evidencePairs = item.designRegionIds.flatMap((designId) => item.appRegionIds.map((appId) => {
      const designRegion = designById.get(designId)!;
      const appRegion = appById.get(appId)!;
      return regionEvidence(designRegion, appRegion, design, app);
    }));
    const average = (key: keyof RegionMatchEvidence): number => evidencePairs.length === 0
      ? 0 : evidencePairs.reduce((sum, evidence) => sum + evidence[key], 0) / evidencePairs.length;
    const status: RegionMatch['status'] = item.relation === 'missing' ? 'missing'
      : item.relation === 'extra' ? 'extra'
        : item.probability >= 0.85 && item.relation !== 'ambiguous' ? 'matched' : 'ambiguous';
    accepted.push({
      id: `ai-region-match:${accepted.length + 1}`,
      designRegionIds: item.designRegionIds,
      appRegionIds: item.appRegionIds,
      relation: item.relation,
      confidence: item.probability,
      evidence: {
        role: average('role'), geometry: average('geometry'), text: average('text'),
        visual: average('visual'), structure: average('structure'), order: average('order'),
      },
      status,
    });
    item.designRegionIds.forEach((id) => usedDesign.add(id));
    item.appRegionIds.forEach((id) => usedApp.add(id));
  }

  for (const match of deterministic) {
    if (match.designRegionIds.some((id) => usedDesign.has(id)) || match.appRegionIds.some((id) => usedApp.has(id))) continue;
    accepted.push({ ...match, alternatives: match.alternatives?.map((item) => ({ ...item })) });
    match.designRegionIds.forEach((id) => usedDesign.add(id));
    match.appRegionIds.forEach((id) => usedApp.add(id));
  }
  return accepted;
}

export function applyRegionOverrides(
  design: PageDocument,
  app: PageDocument,
  inputMatches: readonly RegionMatch[],
  overrides: readonly RegionOverride[],
): {
  matches: RegionMatch[];
  ignoredDesignNodeIds: Set<string>;
  ignoredAppNodeIds: Set<string>;
} {
  const designById = new Map(design.regions.map((region) => [region.id, region]));
  const appById = new Map(app.regions.map((region) => [region.id, region]));
  let matches = inputMatches.map((match) => ({ ...match }));
  const ignoredDesignNodeIds = new Set<string>();
  const ignoredAppNodeIds = new Set<string>();

  for (const override of overrides) {
    if (override.designRegionIds.some((id) => !designById.has(id))
      || override.appRegionIds.some((id) => !appById.has(id))) continue;
    const designIds = new Set(override.designRegionIds);
    const appIds = new Set(override.appRegionIds);
    matches = matches.filter((match) =>
      !match.designRegionIds.some((id) => designIds.has(id))
      && !match.appRegionIds.some((id) => appIds.has(id)));
    if (override.action === 'ignore') {
      override.designRegionIds.flatMap((id) => designById.get(id)?.nodeIds ?? []).forEach((id) => ignoredDesignNodeIds.add(id));
      override.appRegionIds.flatMap((id) => appById.get(id)?.nodeIds ?? []).forEach((id) => ignoredAppNodeIds.add(id));
      continue;
    }
    if (override.designRegionIds.length === 0 || override.appRegionIds.length === 0) continue;
    const relation: RegionMatch['relation'] = override.designRegionIds.length === 1
      ? override.appRegionIds.length === 1 ? 'one_to_one' : 'one_to_many'
      : override.appRegionIds.length === 1 ? 'many_to_one' : 'ambiguous';
    matches.push({
      id: `manual-region:${override.id}`,
      origin: 'manual',
      designRegionIds: [...override.designRegionIds],
      appRegionIds: [...override.appRegionIds],
      relation,
      confidence: 1,
      evidence: { role: 1, geometry: 1, text: 1, visual: 1, structure: 1, order: 1 },
      status: relation === 'ambiguous' ? 'ambiguous' : 'matched',
    });
    override.designRegionIds.forEach((id) => { const region = designById.get(id); if (region) region.origin = 'manual'; });
    override.appRegionIds.forEach((id) => { const region = appById.get(id); if (region) region.origin = 'manual'; });
  }

  const consumedDesign = new Set(matches.flatMap((match) => match.designRegionIds));
  const consumedApp = new Set(matches.flatMap((match) => match.appRegionIds));
  for (const region of design.regions) {
    if (consumedDesign.has(region.id) || overrides.some((item) => item.action === 'ignore' && item.designRegionIds.includes(region.id))) continue;
    matches.push({
      id: `manual-unmatched-design:${region.id}`, origin: 'manual', designRegionIds: [region.id], appRegionIds: [],
      relation: 'missing', confidence: 1,
      evidence: { role: 0, geometry: 0, text: 0, visual: 0, structure: 0, order: 0 }, status: 'missing',
    });
  }
  for (const region of app.regions) {
    if (consumedApp.has(region.id) || overrides.some((item) => item.action === 'ignore' && item.appRegionIds.includes(region.id))) continue;
    matches.push({
      id: `manual-unmatched-app:${region.id}`, origin: 'manual', designRegionIds: [], appRegionIds: [region.id],
      relation: 'extra', confidence: 1,
      evidence: { role: 0, geometry: 0, text: 0, visual: 0, structure: 0, order: 0 }, status: 'extra',
    });
  }
  return { matches, ignoredDesignNodeIds, ignoredAppNodeIds };
}

function localRect(node: CanonicalNode, region: UiRegion): Rect {
  return {
    x: (node.rect.x - region.rect.x) / Math.max(1, region.rect.width),
    y: (node.rect.y - region.rect.y) / Math.max(1, region.rect.height),
    width: node.rect.width / Math.max(1, region.rect.width),
    height: node.rect.height / Math.max(1, region.rect.height),
  };
}

function nodeKindScore(design: CanonicalNode, app: CanonicalNode): number {
  if (design.kind === app.kind) return 1;
  if (design.kind === 'unknown' || app.kind === 'unknown') return 0.65;
  if (['image', 'icon'].includes(design.kind) && ['image', 'icon'].includes(app.kind)) return 0.85;
  if (design.kind === 'container' && app.kind === 'control') return 0.65;
  return 0.15;
}

function nodeScore(design: CanonicalNode, app: CanonicalNode, designRegion: UiRegion, appRegion: UiRegion): { score: number; geometry: number; visual: number; content: number; kind: number } {
  const expected = localRect(design, designRegion);
  const actual = localRect(app, appRegion);
  const delta = Math.abs(expected.x - actual.x) + Math.abs(expected.y - actual.y)
    + Math.abs(expected.width - actual.width) + Math.abs(expected.height - actual.height);
  const geometry = clamp(1 - delta / 2.2);
  const center = clamp(1 - (Math.abs(centerX(expected) - centerX(actual)) + Math.abs(centerY(expected) - centerY(actual))) / 1.2);
  const visualFlags = [
    design.visual.hasVisualContent === app.visual.hasVisualContent,
    design.visual.isImage === app.visual.isImage,
    design.visual.isSvg === app.visual.isSvg,
    design.visual.isGradient === app.visual.isGradient,
  ];
  const visual = visualFlags.filter(Boolean).length / visualFlags.length;
  const designText = normalizeText(design.content.rawText);
  const appText = normalizeText(app.content.rawText);
  const content = designText && appText ? (designText === appText ? 1 : 0) : designText || appText ? 0.25 : 0.6;
  const kind = nodeKindScore(design, app);
  const structure = clamp(1 - Math.abs(design.structure.childCount - app.structure.childCount)
    / Math.max(1, design.structure.childCount, app.structure.childCount));
  const hasText = !!designText || !!appText;
  const score = hasText
    ? geometry * 0.2 + visual * 0.13 + center * 0.12 + content * 0.35 + structure * 0.08 + kind * 0.12
    : geometry * 0.3 + visual * 0.24 + center * 0.18 + content * 0.08 + structure * 0.08 + kind * 0.12;
  return { score: clamp(score), geometry, visual, content, kind };
}

export function buildRegionNodeCandidates(input: {
  design: PageDocument;
  app: PageDocument;
  designRegion: UiRegion;
  appRegion: UiRegion;
  excludedDesignIds?: ReadonlySet<string>;
  excludedAppIds?: ReadonlySet<string>;
  limit?: number;
}): Array<{ designNodeId: string; appNodeIds: string[]; scores: number[] }> {
  const designById = new Map(input.design.nodes.map((node) => [node.canonicalId, node]));
  const appById = new Map(input.app.nodes.map((node) => [node.canonicalId, node]));
  const designNodes = input.designRegion.nodeIds.map((id) => designById.get(id))
    .filter((node): node is CanonicalNode => !!node)
    .filter((node) => node.visible && node.participation === 'required' && node.salience !== 'layout'
      && !input.excludedDesignIds?.has(node.canonicalId));
  const appNodes = input.appRegion.nodeIds.map((id) => appById.get(id))
    .filter((node): node is CanonicalNode => !!node)
    .filter((node) => node.visible && node.participation === 'required' && node.salience !== 'layout'
      && !input.excludedAppIds?.has(node.canonicalId));
  const limit = input.limit ?? 5;
  return designNodes.map((designNode) => {
    const candidates = appNodes.map((appNode) => ({
      appNodeId: appNode.canonicalId,
      score: nodeScore(designNode, appNode, input.designRegion, input.appRegion).score,
    })).filter((item) => item.score >= 0.35)
      .sort((first, second) => second.score - first.score || first.appNodeId.localeCompare(second.appNodeId))
      .slice(0, limit);
    return {
      designNodeId: designNode.canonicalId,
      appNodeIds: candidates.map((item) => item.appNodeId),
      scores: candidates.map((item) => item.score),
    };
  }).filter((item) => item.appNodeIds.length > 0);
}

export function matchNodesWithinRegions(input: {
  design: PageDocument;
  app: PageDocument;
  regionMatches: RegionMatch[];
  baseMatches: NodeMatch[];
  mapping?: NodeMapping;
}): NodeMatch[] {
  const designById = new Map(input.design.nodes.map((node) => [node.canonicalId, node]));
  const appById = new Map(input.app.nodes.map((node) => [node.canonicalId, node]));
  const designRegions = new Map(input.design.regions.map((region) => [region.id, region]));
  const appRegions = new Map(input.app.regions.map((region) => [region.id, region]));
  const matchedRegionPairs = input.regionMatches.filter((match) => match.status === 'matched' || match.status === 'ambiguous');
  const ignoredDesign = new Set(input.mapping?.ignoredDesignNodeIds ?? []);
  const ignoredApp = new Set(input.mapping?.ignoredAppNodeIds ?? []);
  const output = input.baseMatches.map((match) => ({
    ...match,
    alternatives: match.alternatives?.map((entry) => ({ ...entry })),
  }));
  const pairedDesign = new Set(output.filter((match) => match.designNodeIds.length > 0 && match.appNodeIds.length > 0).flatMap((match) => match.designNodeIds));
  const pairedApp = new Set(output.filter((match) => match.designNodeIds.length > 0 && match.appNodeIds.length > 0).flatMap((match) => match.appNodeIds));
  const replacements: NodeMatch[] = [];
  const replaceDesign = new Set<string>();
  const replaceApp = new Set<string>();

  for (const regionMatch of matchedRegionPairs) {
    const designRegion = regionMatch.designRegionIds[0] ? designRegions.get(regionMatch.designRegionIds[0]) : undefined;
    const appRegion = regionMatch.appRegionIds[0] ? appRegions.get(regionMatch.appRegionIds[0]) : undefined;
    if (!designRegion || !appRegion) continue;
    const designNodes = designRegion.nodeIds.map((id) => designById.get(id)).filter((node): node is CanonicalNode => !!node)
      .filter((node) => node.participation === 'required' && node.salience !== 'layout' && !pairedDesign.has(node.canonicalId) && !ignoredDesign.has(node.canonicalId));
    const appNodes = appRegion.nodeIds.map((id) => appById.get(id)).filter((node): node is CanonicalNode => !!node)
      .filter((node) => node.participation === 'required' && node.salience !== 'layout' && !pairedApp.has(node.canonicalId) && !ignoredApp.has(node.canonicalId));
    const candidates = designNodes.flatMap((designNode) => appNodes.map((appNode) => ({
      designNode,
      appNode,
      detail: nodeScore(designNode, appNode, designRegion, appRegion),
    }))).filter((item) => item.detail.score >= NODE_MATCH_FLOOR)
      .sort((a, b) => b.detail.score - a.detail.score || a.designNode.canonicalId.localeCompare(b.designNode.canonicalId));

    // Only lock mutual nearest neighbours. Repeated icons are deliberately left ambiguous unless
    // both row and column agree; greedy assignment is unsafe because one early choice shifts the
    // whole grid by one slot.
    const bestForDesign = new Map<string, (typeof candidates)[number]>();
    const bestForApp = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      if (!bestForDesign.has(candidate.designNode.canonicalId)) bestForDesign.set(candidate.designNode.canonicalId, candidate);
      if (!bestForApp.has(candidate.appNode.canonicalId)) bestForApp.set(candidate.appNode.canonicalId, candidate);
    }
    for (const candidate of candidates) {
      if (replaceDesign.has(candidate.designNode.canonicalId) || replaceApp.has(candidate.appNode.canonicalId)) continue;
      if (bestForDesign.get(candidate.designNode.canonicalId) !== candidate || bestForApp.get(candidate.appNode.canonicalId) !== candidate) continue;
      const alternatives = candidates
        .filter((item) => item.designNode.canonicalId === candidate.designNode.canonicalId && !replaceApp.has(item.appNode.canonicalId))
        .slice(0, 5)
        .map((item) => ({ appNodeId: item.appNode.canonicalId, score: item.detail.score }));
      const second = alternatives.find((item) => item.appNodeId !== candidate.appNode.canonicalId)?.score ?? 0;
      const auto = candidate.detail.score >= NODE_AUTO_MATCH && candidate.detail.score - second >= NODE_AUTO_MARGIN;
      if (!auto) continue;
      replacements.push({
        id: `region-node:${candidate.designNode.canonicalId}:${candidate.appNode.canonicalId}`,
        designNodeIds: [candidate.designNode.canonicalId],
        appNodeIds: [candidate.appNode.canonicalId],
        relation: 'one_to_one',
        source: 'rule',
        origin: 'region',
        ruleScore: candidate.detail.score,
        confidence: candidate.detail.score,
        margin: clamp(candidate.detail.score - second),
        evidence: {
          geometry: candidate.detail.geometry,
          structure: clamp(1 - Math.abs(candidate.designNode.structure.childCount - candidate.appNode.structure.childCount)
            / Math.max(1, candidate.designNode.structure.childCount, candidate.appNode.structure.childCount)),
          relation: regionMatch.confidence,
          visual: candidate.detail.visual,
          content: candidate.detail.content,
          kind: candidate.detail.kind,
        },
        status: 'matched',
      });
      replaceDesign.add(candidate.designNode.canonicalId);
      replaceApp.add(candidate.appNode.canonicalId);
    }
  }
  const retained = output.filter((match) => !match.designNodeIds.some((id) => replaceDesign.has(id))
    && !match.appNodeIds.some((id) => replaceApp.has(id)));
  return [...retained, ...replacements];
}

export function evaluateRegions(
  design: PageDocument,
  app: PageDocument,
  regionMatches: readonly RegionMatch[],
  nodeMatches: readonly NodeMatch[],
): RegionAcceptanceResult[] {
  const designRegions = new Map(design.regions.map((region) => [region.id, region]));
  const appRegions = new Map(app.regions.map((region) => [region.id, region]));
  return regionMatches.filter((match) => match.designRegionIds.length > 0).map((match) => {
    const matchedDesignRegions = match.designRegionIds.map((id) => designRegions.get(id)).filter((region): region is UiRegion => !!region);
    const matchedAppRegions = match.appRegionIds.map((id) => appRegions.get(id)).filter((region): region is UiRegion => !!region);
    const designRegion = matchedDesignRegions[0];
    const designIds = new Set(matchedDesignRegions.flatMap((region) => region.nodeIds));
    const appIds = new Set(matchedAppRegions.flatMap((region) => region.nodeIds));
    const relevant = nodeMatches.filter((item) => item.designNodeIds.some((id) => designIds.has(id)) || item.appNodeIds.some((id) => appIds.has(id)));
    const requiredDesign = design.nodes.filter((node) => designIds.has(node.canonicalId) && node.participation === 'required');
    const matchedDesign = new Set(relevant.filter((item) => item.status === 'matched' || item.status === 'ambiguous').flatMap((item) => item.designNodeIds));
    const missingNodeIds = relevant.filter((item) => item.status === 'missing').flatMap((item) => item.designNodeIds)
      .filter((id) => designIds.has(id));
    const extraNodeIds = relevant.filter((item) => item.status === 'extra').flatMap((item) => item.appNodeIds)
      .filter((id) => appIds.has(id));
    const coverage = requiredDesign.length === 0 ? 1 : matchedDesign.size / requiredDesign.length;
    const visualScore = match.evidence.visual;
    const contentScore = match.evidence.text;
    const structureScore = match.evidence.structure;
    const status: RegionAcceptanceResult['status'] = match.status === 'missing' ? 'fail'
      : match.status === 'ambiguous' ? 'unknown'
        : coverage < 0.6 ? 'fail' : coverage < 0.85 ? 'warning' : 'pass';
    return {
      regionId: designRegion?.id ?? match.designRegionIds[0]!,
      matchId: match.id,
      status,
      coverage,
      geometryScore: match.evidence.geometry,
      visualScore,
      contentScore,
      structureScore,
      missingNodeIds,
      extraNodeIds,
      observations: status === 'pass' ? [] : [{
        type: match.status === 'missing' ? 'missing' : coverage < 0.6 ? 'layout-difference' : 'unknown',
        designRegionIds: match.designRegionIds,
        appRegionIds: match.appRegionIds,
        evidence: [`coverage=${coverage.toFixed(3)}`, `region-confidence=${match.confidence.toFixed(3)}`],
      }],
    };
  });
}

export function regionPageScore(results: readonly RegionAcceptanceResult[], regions: readonly UiRegion[]): number {
  if (results.length === 0) return 0;
  const byId = new Map(regions.map((region) => [region.id, region]));
  let weighted = 0;
  let total = 0;
  for (const result of results) {
    const role = byId.get(result.regionId)?.role;
    const weight = role === 'header' || role === 'card' || role === 'grid' ? 1.4
      : role === 'navigation' ? 1.2 : role === 'banner' ? 1 : 0.8;
    const statusFactor = result.status === 'fail' ? 0 : result.status === 'unknown' ? 0.45 : result.status === 'warning' ? 0.7 : 1;
    weighted += weight * statusFactor * (result.coverage * 0.5 + result.geometryScore * 0.25 + result.visualScore * 0.15 + result.contentScore * 0.1);
    total += weight;
  }
  return total === 0 ? 0 : weighted / total;
}
