import type {
  AiAnnotatedNode,
  AiAnnotationPage,
  CanonicalNode,
  CanonicalSource,
  PageDocument,
  UiRegion,
} from '../../types/aiAcceptance';
import type { Rect } from '../../types/verify';
import type { RasterImage } from './png';
import { cropRaster } from './visuals';

export const ANNOTATION_PAGE_SIZE = 24;
export const ANNOTATION_MAX_DIMENSION = 1536;

export interface AnnotationPageRaster extends Omit<AiAnnotationPage, 'dataUrl'> {
  raster: RasterImage;
}

export interface RegionAnnotationSet {
  nodes: AiAnnotatedNode[];
  shortToCanonical: Map<string, string>;
  canonicalToShort: Map<string, string>;
  original: RasterImage | null;
  pages: AnnotationPageRaster[];
}

export interface PageAnnotationOptions {
  /** 可选的节点上限；页面分区默认不设置上限，避免截断布局块。 */
  maxNodes?: number;
  /** null 表示保留截图原始像素尺寸，不做最长边缩放。 */
  maxDimension?: number | null;
  /** Include non-pass-through structural containers as sparse anchors. */
  includeContext?: boolean;
  /** 页面分区只标注结构布局块；区域内部匹配继续使用 content 策略。 */
  nodePolicy?: 'content' | 'layout-blocks' | 'meaningful';
  /** Explicit allow-list produced by the input gate. */
  nodeIds?: ReadonlySet<string>;
}

type Rgb = [number, number, number];

const COLORS: Record<CanonicalNode['kind'], Rgb> = {
  text: [37, 99, 235],
  image: [22, 163, 74],
  icon: [126, 34, 206],
  control: [234, 88, 12],
  container: [75, 85, 99],
  unknown: [8, 145, 178],
};

const GLYPHS: Record<string, readonly string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};

const area = (rect: Rect): number => Math.max(0, rect.width) * Math.max(0, rect.height);

function intersects(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.width && first.x + first.width > second.x
    && first.y < second.y + second.height && first.y + first.height > second.y;
}

function overlapRatio(first: Rect, second: Rect): number {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= x || bottom <= y) return 0;
  const overlap = (right - x) * (bottom - y);
  return overlap / Math.max(1, Math.min(area(first), area(second)));
}

function isDuplicateBox(first: Rect, second: Rect): boolean {
  const widthSimilarity = Math.min(first.width, second.width) / Math.max(1, Math.max(first.width, second.width));
  const heightSimilarity = Math.min(first.height, second.height) / Math.max(1, Math.max(first.height, second.height));
  const positionToleranceX = Math.max(2, Math.min(first.width, second.width) * 0.02);
  const positionToleranceY = Math.max(2, Math.min(first.height, second.height) * 0.02);
  return overlapRatio(first, second) >= 0.92
    && widthSimilarity >= 0.9
    && heightSimilarity >= 0.9
    && Math.abs(first.x - second.x) <= positionToleranceX
    && Math.abs(first.y - second.y) <= positionToleranceY;
}

function resizeRaster(image: RasterImage, maxDimension: number): RasterImage {
  if (Math.max(image.width, image.height) <= maxDimension) return image;
  const ratio = maxDimension / Math.max(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / ratio));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / ratio));
      const source = (sourceY * image.width + sourceX) * 4;
      const target = (y * width + x) * 4;
      data[target] = image.data[source]!;
      data[target + 1] = image.data[source + 1]!;
      data[target + 2] = image.data[source + 2]!;
      data[target + 3] = image.data[source + 3]!;
    }
  }
  return { width, height, data };
}

function blendPixel(image: RasterImage, x: number, y: number, color: Rgb, alpha = 1): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const index = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  const sourceAlpha = Math.max(0, Math.min(1, alpha));
  image.data[index] = Math.round(image.data[index]! * (1 - sourceAlpha) + color[0] * sourceAlpha);
  image.data[index + 1] = Math.round(image.data[index + 1]! * (1 - sourceAlpha) + color[1] * sourceAlpha);
  image.data[index + 2] = Math.round(image.data[index + 2]! * (1 - sourceAlpha) + color[2] * sourceAlpha);
  image.data[index + 3] = 255;
}

function fillRect(image: RasterImage, rect: Rect, color: Rgb, alpha = 1): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) blendPixel(image, x, y, color, alpha);
  }
}

function strokeRect(image: RasterImage, rect: Rect, color: Rgb, dashed: boolean): void {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(image.width - 1, Math.round(rect.x + rect.width));
  const y1 = Math.min(image.height - 1, Math.round(rect.y + rect.height));
  const draw = (x: number, y: number, offset: number) => {
    if (!dashed || Math.floor(offset / 5) % 2 === 0) {
      blendPixel(image, x, y, color);
      blendPixel(image, x + 1, y, color);
      blendPixel(image, x, y + 1, color);
    }
  };
  for (let x = x0; x <= x1; x += 1) {
    draw(x, y0, x - x0);
    draw(x, y1, x - x0);
  }
  for (let y = y0; y <= y1; y += 1) {
    draw(x0, y, y - y0);
    draw(x1, y, y - y0);
  }
}

function drawText(image: RasterImage, text: string, x: number, y: number, scale = 2): void {
  let cursor = x;
  for (const character of text) {
    const glyph = GLYPHS[character];
    if (!glyph) continue;
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row]!.length; column += 1) {
        if (glyph[row]![column] !== '1') continue;
        fillRect(image, { x: cursor + column * scale, y: y + row * scale, width: scale, height: scale }, [255, 255, 255]);
      }
    }
    cursor += 6 * scale;
  }
}

function labelRectFor(nodeRect: Rect, occupied: readonly Rect[], image: RasterImage): Rect {
  const width = 62;
  const height = 18;
  const positions = [
    { x: nodeRect.x, y: nodeRect.y },
    { x: nodeRect.x + nodeRect.width - width, y: nodeRect.y },
    { x: nodeRect.x, y: nodeRect.y + nodeRect.height - height },
    { x: nodeRect.x + nodeRect.width - width, y: nodeRect.y + nodeRect.height - height },
  ];
  for (const position of positions) {
    const rect = {
      x: Math.max(0, Math.min(image.width - width, position.x)),
      y: Math.max(0, Math.min(image.height - height, position.y)),
      width,
      height,
    };
    if (!occupied.some((item) => intersects(item, rect))) return rect;
  }
  const fallback = positions[0]!;
  return {
    x: Math.max(0, Math.min(image.width - width, fallback.x)),
    y: Math.max(0, Math.min(image.height - height, fallback.y)),
    width,
    height,
  };
}

function relevantNodes(
  page: PageDocument,
  region: UiRegion,
  excludedIds?: ReadonlySet<string>,
  maxNodes = Number.POSITIVE_INFINITY,
  includeContext = false,
  nodePolicy: PageAnnotationOptions['nodePolicy'] = 'content',
  optionsNodeIds?: ReadonlySet<string>,
): CanonicalNode[] {
  const allowed = optionsNodeIds ?? new Set(region.nodeIds);
  const candidates = page.nodes.filter((node) => {
    if (!allowed.has(node.canonicalId) || !node.visible) return false;
    if (nodePolicy === 'meaningful') {
      if (node.participation === 'ignored' || node.participation === 'unavailable') return false;
      if (node.salience === 'layout' || node.passThrough) return false;
      if (node.clipped && node.visibleRect === null) return false;
    } else if (nodePolicy === 'layout-blocks') {
      const layoutBlock = (node.salience === 'box' && !node.passThrough)
        || (node.salience === 'graphic'
          && (node.kind === 'image' || node.kind === 'unknown')
          && area(node.visibleRect ?? node.rect) >= page.width * page.height * 0.02);
      if (!layoutBlock || node.participation === 'ignored' || node.participation === 'unavailable') return false;
    } else if (!includeContext && node.participation !== 'required') {
      return false;
    } else if (node.salience === 'layout' && !(includeContext && node.kind === 'container' && !node.passThrough)) {
      return false;
    }
    if (excludedIds?.has(node.canonicalId) || area(node.visibleRect ?? node.rect) <= 0) return false;
    return includeContext
      ? intersects(node.rect, region.rect)
      : intersects(node.visibleRect ?? node.rect, region.visibleRect ?? region.rect);
  })
    .sort((first, second) => {
      const firstContainer = first.kind === 'container' ? 1 : 0;
      const secondContainer = second.kind === 'container' ? 1 : 0;
      return firstContainer - secondContainer
        || first.rect.y - second.rect.y
        || first.rect.x - second.rect.x
        || first.depth - second.depth
        || first.canonicalId.localeCompare(second.canonicalId);
    });

  if (nodePolicy === 'layout-blocks') {
    // The first segmentation pass needs the page skeleton, not the business
    // leaves. Keep every valid layout block; maxNodes is intentionally not a
    // semantic cap for this phase.
    return candidates
      .filter((node, index, all) => {
        const rect = node.visibleRect ?? node.rect;
        return !all.slice(0, index).some((previous) =>
          previous.depth <= node.depth
          && isDuplicateBox(previous.visibleRect ?? previous.rect, rect));
      })
      .slice(0, Math.max(0, maxNodes));
  }

  if (nodePolicy === 'meaningful') {
    // The input gate already decided the complete meaningful set. Do not apply
    // visual-box deduplication here: every retained node must have the same
    // short ID in the canvas, annotation image, and diagnostics panel.
    return candidates.slice(0, Math.max(0, maxNodes));
  }

  // Keep painted/content nodes first. Containers are retained only as structural
  // anchors after visible content has been selected, so wrapper layers do not
  // consume the label budget or cover the screenshot with duplicate boxes.
  const content = candidates.filter((node) => node.kind !== 'container');
  const containers = candidates.filter((node) => node.kind === 'container')
    .filter((node) => {
      const childContent = page.nodes.some((child) => child.parentId === node.canonicalId
        && child.visible && child.kind !== 'container' && area(child.visibleRect ?? child.rect) > 0);
      // A full-screen or one-child wrapper is useful for geometry but harmful as
      // a visual label. It remains available from JSON and region membership.
      return childContent && node.rect.width < page.width * 0.98 && node.rect.height < page.height * 0.98;
    });
  const ranked = [...content, ...containers]
    .filter((node, index, all) => {
      const rect = node.visibleRect ?? node.rect;
      // Collapse exact duplicate painted boxes from native wrappers while keeping
      // text nodes and distinct visual children available for matching.
      return !all.slice(0, index).some((previous) => previous.kind === node.kind
        && overlapRatio(previous.visibleRect ?? previous.rect, rect) >= 0.92
        && previous.depth <= node.depth);
    });
  return ranked.slice(0, Math.max(0, maxNodes));
}

function shortId(source: CanonicalSource, index: number): string {
  return `${source === 'design' ? 'D' : 'A'}${String(index + 1).padStart(3, '0')}`;
}

function paginate(nodes: CanonicalNode[]): CanonicalNode[][] {
  const content = nodes.filter((node) => node.kind !== 'container');
  const containers = nodes.filter((node) => node.kind === 'container');
  const output: CanonicalNode[][] = [];
  for (const group of [content, containers]) {
    for (let index = 0; index < group.length; index += ANNOTATION_PAGE_SIZE) {
      output.push(group.slice(index, index + ANNOTATION_PAGE_SIZE));
    }
  }
  return output;
}

export function buildRegionAnnotations(
  image: RasterImage,
  page: PageDocument,
  region: UiRegion,
  excludedIds?: ReadonlySet<string>,
  options?: PageAnnotationOptions & { paginate?: boolean },
): RegionAnnotationSet {
  const imageScale = page.width > 0 ? image.width / page.width : 0;
  const cropRect = region.visibleRect ?? region.rect;
  const rawCrop = cropRaster(image, cropRect, imageScale);
  const original = rawCrop
    ? options?.maxDimension === null
      ? rawCrop
      : resizeRaster(rawCrop, options?.maxDimension ?? ANNOTATION_MAX_DIMENSION)
    : null;
  const nodes = relevantNodes(
    page,
    region,
    excludedIds,
    options?.maxNodes ?? Number.POSITIVE_INFINITY,
    options?.includeContext ?? false,
    options?.nodePolicy ?? 'content',
    options?.nodeIds,
  );
  const shortToCanonical = new Map<string, string>();
  const canonicalToShort = new Map<string, string>();
  const summaries = nodes.map((node, index) => {
    const id = shortId(page.source, index);
    shortToCanonical.set(id, node.canonicalId);
    canonicalToShort.set(node.canonicalId, id);
    return {
      shortId: id,
      canonicalId: node.canonicalId,
      kind: node.kind,
      rect: node.rect,
      text: node.content.rawText,
      childCount: node.structure.childCount,
    } satisfies AiAnnotatedNode;
  });
  if (!original) return { nodes: summaries, shortToCanonical, canonicalToShort, original: null, pages: [] };

  const summaryByCanonical = new Map(summaries.map((item) => [item.canonicalId, item]));
  const scaleX = original.width / Math.max(1, cropRect.width);
  const scaleY = original.height / Math.max(1, cropRect.height);
  const pageGroups = options?.paginate === false ? [nodes] : paginate(nodes);
  const pages = pageGroups.map((pageNodes, pageIndex) => {
    const raster: RasterImage = { width: original.width, height: original.height, data: new Uint8Array(original.data) };
    const occupied: Rect[] = [];
    for (const node of pageNodes) {
      const nodeRect = node.visibleRect ?? node.rect;
      const rect = {
        x: (nodeRect.x - cropRect.x) * scaleX,
        y: (nodeRect.y - cropRect.y) * scaleY,
        width: nodeRect.width * scaleX,
        height: nodeRect.height * scaleY,
      };
      const color = COLORS[node.kind];
      strokeRect(raster, rect, color, node.kind === 'container');
      const label = labelRectFor(rect, occupied, raster);
      occupied.push(label);
      fillRect(raster, label, color, 0.94);
      drawText(raster, summaryByCanonical.get(node.canonicalId)!.shortId, label.x + 3, label.y + 2);
    }
    return {
      source: page.source,
      regionId: region.id,
      page: pageIndex + 1,
      nodeShortIds: pageNodes.map((node) => summaryByCanonical.get(node.canonicalId)!.shortId),
      raster,
    } satisfies AnnotationPageRaster;
  });

  return { nodes: summaries, shortToCanonical, canonicalToShort, original, pages };
}

/**
 * 生成页面分区阶段使用的整页稀疏标注图。
 *
 * 它与区域节点匹配的标注图不同：这里还没有 AI 区域，因此使用整页作为
 * 标注范围，只画可见结构布局块，并保留原始截图尺寸。页面分区不依赖叶子节点
 * 数量来确定边界，避免文本、图片和图标标签遮挡真实页面。
 */
export function buildPageAnnotations(
  image: RasterImage,
  page: PageDocument,
  options: PageAnnotationOptions = {},
): RegionAnnotationSet {
  const viewport = page.viewport.rect;
  const region: UiRegion = {
    id: `${page.source}-segmentation-page`,
    source: page.source,
    origin: 'rule',
    role: 'page',
    rect: viewport,
    visibleRect: viewport,
    nodeIds: page.nodes.map((node) => node.canonicalId),
    childRegionIds: [],
    text: [],
    visualFeatures: { hasVisualContent: true, imageCount: 0, iconCount: 0, textCount: 0 },
    layout: 'unknown',
    fixed: false,
    scrollable: false,
    confidence: 1,
    order: 0,
  };
  return buildRegionAnnotations(
    image,
    page,
    region,
    new Set(page.viewport.excludedNodeIds),
    { ...options, paginate: false, maxDimension: options.maxDimension ?? null, includeContext: true },
  );
}
