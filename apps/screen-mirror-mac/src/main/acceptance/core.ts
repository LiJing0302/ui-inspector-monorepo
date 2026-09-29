import type { CollectionQuality } from '../../types/acceptance';
import { isAppNodeEffectivelyVisible, type AppNode, type DesignNode, type Rect } from '../../types/verify';
import type {
  AcceptanceIssue,
  AcceptanceResult,
  AcceptanceProfile,
  CanonicalDocument,
  CanonicalKind,
  CanonicalNode,
  ContentFeatures,
  FilteredNode,
  FilteredNodeDiagnostic,
  FilteredNodeReason,
  FilteredNodeSet,
  GeometryFeatures,
  MatchVisualMetrics,
  NodeMapping,
  NodeMatch,
  Participation,
  Salience,
  StructureFeatures,
  VisualFeatures,
} from '../../types/aiAcceptance';
import { toCanonicalId } from '../../types/aiAcceptance';
import {
  createPixelTransformContract,
  projectDesignRectToAppPixels,
} from './pixelTransform';
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

/**
 * L3b 队列流动的调试开关（`SM_MATCH_TRACE=1`）。
 *
 * 排查「某些节点莫名掉进 missing」时打开：它会打出每次入队 / 出队时两侧的组数与链长，
 * 以及**没被分配掉的那些行**（`[L3b:leftover]`）。漏配只有两种可能 —— 要么没入队、
 * 要么入了队但整组被裁空 —— 这两种在日志里长得完全不同，一行就能分辨。
 * 默认关闭，无输出开销。
 */
const MATCH_TRACE =
  typeof process !== 'undefined' && process.env?.SM_MATCH_TRACE === '1';

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function normalizeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : '';
}

function colorAlpha(color: string | undefined): number {
  if (!color) return 1;
  const match = color.trim().match(/^#([0-9a-f]{8})$/i);
  if (!match) return 1;
  return parseInt(match[1]!.slice(6), 16) / 255;
}

function paintAlpha(paint: { visible?: boolean; opacity?: number; color?: string }): number {
  if (paint.visible === false) return 0;
  return clamp((paint.opacity ?? 1) * colorAlpha(paint.color));
}

function visiblePaintAlpha(node: DesignNode): number {
  const paints = [...(node.fills ?? []), ...(node.strokes ?? [])];
  if (paints.length === 0) return 1;
  return Math.max(0, ...paints.map((paint) => paintAlpha(paint)));
}

function hasVisibleDesignPaint(node: DesignNode): boolean {
  return [...(node.fills ?? []), ...(node.strokes ?? [])].some((paint) => paintAlpha(paint) > 0);
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

// ---------- L1 · 意义分类的前置工具 ----------

/**
 * 零宽字符（`\u200b` 等）与不换行空格。
 *
 * 剥掉它们不是洁癖：App 侧实测存在 `Caba\u200bs\u200ba...` 这种被插了零宽字符的文案
 * （业务侧为了断行或防复制塞的），而设计稿里是干净的同一串 —— 不做这一步，
 * 两侧「肉眼完全一样的文案」会永远锚不上，且没有任何日志会提示为什么。
 */
const ZERO_WIDTH_PATTERN = /[\u200b\u200c\u200d\ufeff\u2060]/g;

/**
 * 锚点用的文本归一化。
 *
 * ⚠️ 与 `normalizeText` **刻意分开**：后者服务于既有的相似度计算与展示（只折叠空白），
 * 改它会连带改掉 `contentScore` 的取值，进而动到 AI 候选排序。锚点判定需要更狠的清洗，
 * 就单独给一条路径，两边的口径互不污染。
 *
 * 大小写**不统一**：`AcceptanceProfile.text.caseSensitive` 的默认值是 true，
 * 引擎不该在这里偷偷放宽 —— 真要放宽得从 profile 走。
 */
function normalizeAnchorText(value: string | null | undefined): string {
  if (value == null) return '';
  return value
    .replace(ZERO_WIDTH_PATTERN, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 连空格都去掉的形式：判断「同父相邻文本拼接后是否等于对侧单个文本」时用 */
function squashText(value: string | null | undefined): string {
  return normalizeAnchorText(value).replace(/\s+/g, '');
}

/** 矩形是否近似相等（透传判定用） */
function sameRect(first: Rect, second: Rect, tolerance: number): boolean {
  return Math.abs(first.x - second.x) <= tolerance
    && Math.abs(first.y - second.y) <= tolerance
    && Math.abs(first.width - second.width) <= tolerance
    && Math.abs(first.height - second.height) <= tolerance;
}

/** 设计稿侧属于「图形」的节点类型（Figma 的矢量 / 形状） */
const GRAPHIC_DESIGN_TYPES: ReadonlySet<string> = new Set([
  'VECTOR',
  'ELLIPSE',
  'LINE',
  'BOOLEAN_OPERATION',
  'STAR',
  'POLYGON',
]);

/**
 * 透传判定的矩形容差（px）。
 *
 * ⚠️ 必须与 SDK 侧 `CollectPolicy.PASS_THROUGH_TOLERANCE` 保持一致：同一个判据在两处
 * 各算一遍，一旦容差不同，同一份快照在「采集侧认为的壳」与「匹配侧认为的壳」就会分叉，
 * 而那种分叉只体现在匹配率上，没有任何一处会报错。
 */
const PASS_THROUGH_TOLERANCE = 2;

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

/**
 * 节点是否**整体**落在画板外（与画板矩形无交集）。
 *
 * Figma 会把画板外的组件实例照样采进来（实测 110 个，最远的 x = −3301），而它们在导出
 * 截图里根本不存在 —— 与画板**有任何重叠**的都不算：那是一块看得见的内容，只是没被裁掉。
 */
function isOutsideCanvas(rect: Rect, canvas: { width: number; height: number }): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  return rectRight(rect) <= 0
    || rectBottom(rect) <= 0
    || rect.x >= canvas.width
    || rect.y >= canvas.height;
}

/**
 * 设计稿侧的参与度。
 *
 * ⚠️ 与 App 侧**刻意不对称**，两边的脏数据不是一回事：
 *   - Figma 侧零尺寸图层与画板外实例是常见的采集噪声（实测 36 + 110 个），
 *     它们在 App 侧永远不可能有对应 —— 保留成 `required` 就是稳定产出的假阴性
 *     （`required` 是唯一允许被判缺失的档），所以这里直接降级。
 *   - App 侧反过来：零尺寸但还在画东西是真异常，要继续报（见 `CollectPolicy`）。
 */
function designParticipation(input: {
  visible: boolean;
  rect: Rect;
  salience: Salience;
  canvas: { width: number; height: number };
}): Participation {
  if (!input.visible) return 'optional';
  if (input.rect.width <= 0 || input.rect.height <= 0) return 'ignored';
  if (isOutsideCanvas(input.rect, input.canvas)) return 'ignored';
  return input.salience === 'layout' ? 'context' : 'required';
}

/**
 * App 侧的参与度。
 *
 * 以「意义类别」为准（`layout` 不参与 missing / extra），但**保留 SDK 的一个硬否决**：
 * `unavailable`（未附着）是采集侧看得到、Mac 侧看不到的事实 —— `AppNode` 上不带
 * `attached` 字段，所以这一档只能由 SDK 给。
 *
 * 其余档位一律由这里重算，而不是沿用 SDK 的 `participation`：那个值是按
 * 「有没有像素」推出来的（`layoutOnly = !hasVisualContent`），会把承载结构的透明容器
 * 划成 context —— 新旧两套判据混用，只会得到一套谁也解释不清的参与度。
 */
function appParticipation(input: {
  visible: boolean;
  zeroSize: boolean;
  salience: Salience;
  sdkParticipation?: Participation;
}): Participation {
  if (input.sdkParticipation === 'unavailable') return 'unavailable';
  if (!input.visible) return 'optional';
  if (input.salience === 'layout') return input.zeroSize ? 'ignored' : 'context';
  return 'required';
}

function canonicalize(
  source: 'design' | 'app',
  nodes: Array<DesignNode | AppNode>,
  width: number,
  height: number,
  pixelWidth?: number,
  pixelHeight?: number,
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

  /** 两侧原始节点的矩形取值统一在这里，避免每处都写一遍 `'rect' in node` 的分支 */
  const rectOf = (node: DesignNode | AppNode | undefined): Rect => {
    if (!node) return { x: 0, y: 0, width: 0, height: 0 };
    return 'rect' in node
      ? node.rect
      : { x: node.x, y: node.y, width: node.width, height: node.height };
  };

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
      : app?.outsideVisibleRect
      ? null
      : app?.visibleWidth != null && app.visibleHeight != null
      ? { x: app.visibleX, y: app.visibleY, width: app.visibleWidth, height: app.visibleHeight }
      : (app?.outsideVisibleRect || app?.clipped ? null : rawRect);
    const childRawRects = childIds.map((childId) => {
      const child = rectById.get(childId) as DesignNode | AppNode | undefined;
      return child && 'rect' in child ? child.rect : child ? { x: child.x, y: child.y, width: child.width, height: child.height } : rawRect;
    });
    const kind = design ? kindForDesign(design, childIds.length) : kindForApp(app!, childIds.length);
    const text = design?.text?.characters ?? app?.text ?? null;

    // ---------- L1 · 意义分类 ----------
    // 有效子节点 = 可见 且 非零尺寸。被过滤的子节点分发不了任何内容，
    // 一个只剩它们的容器在屏幕上就是空的 —— 那才是纯占位。
    const effectiveChildIds = childIds.filter((childId) => {
      const child = byId.get(childId) as DesignNode | AppNode | undefined;
      if (!child || (source === 'app'
        ? !isAppNodeEffectivelyVisible(child as AppNode)
        : child.visible === false)) return false;
      const childRect = rectOf(child);
      return childRect.width > 0 && childRect.height > 0;
    });
    const textPresent = normalizeAnchorText(text).length > 0 || (app?.textRedacted ?? false);
    const selfDraws = design ? design.hasFill !== false : app?.hasVisualContent === true;
    const graphicKind = design
      ? GRAPHIC_DESIGN_TYPES.has(design.type) || !!design.fills?.some((paint) => paint.type === 'IMAGE')
      : !!(app?.isImage || app?.isSvg || app?.isGradient);
    const onlyChildRect = effectiveChildIds.length === 1 ? rectOf(byId.get(effectiveChildIds[0]!)) : null;
    // 透传 = 不画像素 + 恰好一个有效子节点 + 子节点铺满自身。
    // 两侧用**同一条判据**（SDK 侧的同名结论在 CollectPolicy.isPassThrough）：
    // 「什么算有意义的元素」必须是跨进程唯一的定义，否则同一次采集在两侧得出两套结论。
    const passThrough = !textPresent
      && !selfDraws
      && !!onlyChildRect
      && sameRect(onlyChildRect, rawRect, PASS_THROUGH_TOLERANCE);
    const salience: Salience = textPresent
      ? 'text'
      : effectiveChildIds.length === 0
      ? (selfDraws || graphicKind ? 'graphic' : 'layout')
      : passThrough
      ? 'layout'
      : 'box';

    const participation: Participation = design
      ? designParticipation({
        visible: design.visible,
        rect: rawRect,
        salience,
        canvas: { width, height },
      })
      : appParticipation({
        visible: isAppNodeEffectivelyVisible(app!),
        zeroSize: app!.zeroSize ?? (rawRect.width <= 0 || rawRect.height <= 0),
        salience,
        sdkParticipation: app!.participation,
      });

    return {
      canonicalId: id,
      source,
      rawIds: [source === 'design' ? (design as DesignNode).id : (app as AppNode).nodeId],
      parentId,
      childIds,
      depth: node.depth,
      siblingIndex: node.index ?? index,
      rect: rawRect,
      ...(app?.pixelRect ? { pixelRect: app.pixelRect } : {}),
      visibleRect,
      kind,
      salience,
      passThrough,
      participation,
      visible: design?.visible ?? isAppNodeEffectivelyVisible(app!),
      hiddenByAncestor: design ? undefined : app?.hiddenByAncestor === true,
      clipped: design?.clipped ?? app?.outsideVisibleRect ?? app?.clipped ?? false,
      layoutOnly: salience === 'layout',
      virtual: false,
      geometry: makeGeometry(rawRect, parentRaw && 'rect' in parentRaw ? parentRaw.rect : parentRaw ? { x: parentRaw.x, y: parentRaw.y, width: parentRaw.width, height: parentRaw.height } : null),
      structure: {
        childCount: childIds.length,
        visibleChildCount: childIds.filter((childId) => {
          const child = byId.get(childId) as DesignNode | AppNode | undefined;
          return design
            ? child?.visible !== false
            : !!child && isAppNodeEffectivelyVisible(child as AppNode);
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
        design ? (design.hasFill === true || hasVisibleDesignPaint(design)) : !!app?.hasVisualContent,
        design ? !!design.fills?.some((paint) => paint.type === 'IMAGE') : !!app?.isImage,
        design ? design.type === 'VECTOR' : !!app?.isSvg,
        design ? !!design.fills?.some((paint) => paint.type.startsWith('GRADIENT')) : !!app?.isGradient,
        design
          ? (design.opacity ?? 1) * visiblePaintAlpha(design)
          : app?.alpha ?? 1,
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
    ...(source === 'app' && pixelWidth && pixelHeight ? { pixelWidth, pixelHeight } : {}),
  };
}

export function canonicalizeDesign(nodes: DesignNode[], width: number, height: number): CanonicalDocument {
  return canonicalize('design', nodes, width, height);
}

export function canonicalizeApp(
  nodes: AppNode[],
  width: number,
  height: number,
  pixelWidth?: number,
  pixelHeight?: number,
): CanonicalDocument {
  return canonicalize('app', nodes, width, height, pixelWidth, pixelHeight);
}

function rectArea(rect: Rect | null | undefined): number {
  return rect ? Math.max(0, rect.width) * Math.max(0, rect.height) : 0;
}

function intersectsCanvas(rect: Rect, width: number, height: number): boolean {
  return rect.x < width && rect.y < height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

function meaningfulNode(node: CanonicalNode): boolean {
  return node.content.rawText?.trim().length
    ? true
    : node.visual.hasVisualContent
      || node.visual.isImage
      || node.visual.isSvg
      || node.visual.isGradient;
}

/**
 * Select the nodes that can provide visible evidence to the first AI stage.
 * This is deliberately separate from the normal matcher: structural containers
 * remain useful for matching, but a transparent/layout-only wrapper must not be
 * drawn as an AI input label or become a canvas hit target in this phase.
 */
export function filterMeaningfulNodes(document: CanonicalDocument): FilteredNodeSet {
  const byId = new Map(document.nodes.map((node) => [node.canonicalId, node]));
  const effectiveOpacity = new Map<string, number>();
  const hiddenByAncestor = new Map<string, boolean>();
  const visiting = new Set<string>();

  const opacityOf = (node: CanonicalNode): number => {
    const cached = effectiveOpacity.get(node.canonicalId);
    if (cached !== undefined) return cached;
    if (visiting.has(node.canonicalId)) return 0;
    visiting.add(node.canonicalId);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const value = clamp(node.visual.alpha)
      * (parent ? opacityOf(parent) : 1);
    visiting.delete(node.canonicalId);
    effectiveOpacity.set(node.canonicalId, value);
    return value;
  };

  const isEffectivelyHidden = (node: CanonicalNode): boolean => {
    const cached = hiddenByAncestor.get(node.canonicalId);
    if (cached !== undefined) return cached;
    if (visiting.has(node.canonicalId)) return true;
    visiting.add(node.canonicalId);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const hidden = node.hiddenByAncestor === true
      || (parent ? !parent.visible || parent.hiddenByAncestor === true || isEffectivelyHidden(parent) : false);
    visiting.delete(node.canonicalId);
    hiddenByAncestor.set(node.canonicalId, hidden);
    return hidden;
  };

  const retainedNodes: FilteredNode[] = [];
  const filteredNodes: FilteredNodeDiagnostic[] = [];

  for (const node of document.nodes) {
    const reasons: FilteredNodeReason[] = [];
    const opacity = opacityOf(node);
    const ownOpacity = clamp(node.visual.alpha);
    const visibleRect = node.visibleRect ?? node.rect;
    const ancestorHidden = isEffectivelyHidden(node);
    const hasNoVisibleClip = node.clipped && node.visibleRect === null;

    if (!node.visible && !ancestorHidden) reasons.push('invisible');
    if (ancestorHidden) reasons.push('hidden-by-ancestor');
    if (opacity <= 0 || ownOpacity <= 0) reasons.push('transparent');
    if (hasNoVisibleClip) reasons.push('clipped');
    if (node.rect.width <= 0 || node.rect.height <= 0 || rectArea(visibleRect) <= 0) reasons.push('zero-size');
    if (!intersectsCanvas(node.rect, document.width, document.height)) reasons.push('outside-viewport');
    if (node.participation === 'ignored') reasons.push('ignored');
    if (node.participation === 'unavailable') reasons.push('unavailable');
    if (node.layoutOnly) reasons.push('layout-only');
    if (node.passThrough) reasons.push('pass-through');
    if (!meaningfulNode(node)) reasons.push('no-rendered-content');

    if (reasons.length > 0) {
      filteredNodes.push({ canonicalId: node.canonicalId, reasons });
      continue;
    }

    retainedNodes.push({
      canonicalId: node.canonicalId,
      rect: node.rect,
      visibleRect: node.visibleRect,
      kind: node.kind,
      depth: node.depth,
      text: node.content.rawText,
      effectiveOpacity: opacity,
      reasons: ['meaningful-content'],
    });
  }

  return {
    source: document.source,
    totalNodeCount: document.nodes.length,
    retainedNodeCount: retainedNodes.length,
    filteredNodeCount: filteredNodes.length,
    retainedNodes,
    filteredNodes,
  };
}

/**
 * 把 App 侧坐标换算进**设计稿坐标系**（两侧宽度比）。
 *
 * 导出**只为本模块与标注导出共用同一个换算式**：标注导出要算「设计包围盒 vs App 包围盒」
 * 的 IoU / 中心偏移，如果自己再写一份乘以 `design.width / app.width` 的代码，
 * 那么哪天换算规则变了（例如引入 `coordinateInset` 补偿），导出里的几何度量就会
 * 与引擎内部悄悄不一致 —— 而几何度量恰恰是用来判断「引擎几何打分是不是算错了」的，
 * 它一歪，这个判断就废了。
 */
export function transformAppRect(rect: Rect, design: CanonicalDocument, app: CanonicalDocument): Rect {
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

// ==========================================================================
// 匹配 v2 · 锚点优先
//
// 完整规格与实测数据见 `docs/MATCH-RULES-V2.md`。一句话版本：
//
//   先相信内容，再相信位置。文本完全相等比「同一层第 3 个」强得多。
//
// 为什么必须换掉旧引擎（同层同步下探）：两份真实数据里 design 最大深度 11、
// app 最大深度 33，内容节点一个在 d2~d7、一个在 d24~d29，深度偏移在 +12 ~ +26 之间
// **浮动且不固定** —— 任何「两侧同层比较」或「固定深度偏移校正」的规则都会撞死。
// 实测 45 对文本锚点的偏移分布：{12×1, 13×4, 19×2, 21×3, 22×12, 23×22, 24×26, 25×2, 26×11}。
//
// 而数据本身是好的：全量一对一复算能配 453 对（其中 151 对 ≥0.85），105 个 design 文本节点
// 全部存在 ≥0.38 的对应者。**问题从来不是数据，是「怎么找到它」。**
// ==========================================================================

/** 两侧各只有一个相同文本 → 直接锁定（最强证据） */
const ANCHOR_UNIQUE_BASE = 1;
/** 同父相邻文本拼接后与对侧单节点相等（切分粒度不同）→ 比逐字相等弱一档 */
const ANCHOR_AGGREGATE_BASE = 0.9;
/** 文本重复、靠几何消歧后唯一 → 确认了是它，但毕竟不是唯一候选 */
const ANCHOR_DISAMBIGUATED_BASE = 0.95;

/**
 * 文本锚点的置信度 = 基数 × 文本长度因子 × 深度因子。
 *
 * ⚠️ 不能是常量：「页面主标题」和「列表项里第 8 个 ¥」的可信度差远了。
 *   - **基数**是主因（唯一性三档：两侧各自唯一 / 几何消歧 / N:M 聚合）；
 *   - **长度**：1~2 个字符（`¥` / `&` / `更多`）的撞车概率远高于 3 字以上的词 ——
 *     实测样本里两侧各自唯一的锚点全是 3 字以上中文词，40/45 全对；
 *   - **深度**：浅层锚点（页面主标题）一次能锁一大片，深层锚点只锁到自己 —— 但深层
 *     同样是精确匹配，可信度**不因作用域小而降**，所以只做极小修正。
 *
 * 两个因子都刻意压得很轻（合计最多降 5%），只用来在 `margin` 上拉开差别，
 * 不会把一条本来就正确的锚点推到 ambiguous。
 */
function anchorConfidence(base: number, text: string, depth: number): number {
  const lengthFactor = text.length >= 3 ? 1 : text.length === 2 ? 0.98 : 0.96;
  const depthFactor = depth <= 3 ? 1 : 0.99;
  return clamp(base * lengthFactor * depthFactor);
}
/** 几何消歧的门槛：低于它不算「同一个位置」 */
const DISAMBIGUATE_GEOMETRY_FLOOR = 0.85;
/** 文本 run 的最大拼接长度 */
const MAX_TEXT_RUN = 3;

/** 祖先投票：单票的分数门槛 */
const VOTE_SCORE_FLOOR = 0.55;
/** 祖先投票：锁定所需的票数（单票只是巧合，两票以上才是结构证据） */
const VOTE_LOCK_MIN_COUNT = 2;
/** 祖先投票 / 根对兜底：锁定所需的分数 */
const VOTE_LOCK_MIN_SCORE = 0.6;

/** 兄弟分配：低于它既不再收、也不再往下推 */
const SIBLING_MIN_SCORE = 0.7;

/**
 * 扩散产物的置信度区间。
 *
 * ⚠️ 上限 0.94 是**产品约束**，不是调参：`AUTO_MATCH_THRESHOLD` 是 0.85，
 * 但 `status` 由本模块直接给出 —— 扩散来的配对一律 `ambiguous`，因为它们是
 * 「合理推断」而不是「事实」。这与现有引擎「AI 只能确认不能改判」的性质配套：
 * 推断的东西必须有人过目，不能被规则自己升级成既成事实。
 */
const DIFFUSION_MIN_CONFIDENCE = 0.6;
const DIFFUSION_MAX_CONFIDENCE = 0.94;

/**
 * L3c · 锚点校准定位。
 *
 * 什么时候能开这一层：L2 至少锁定了 4 组文本锚点、且它们在纵向上铺开 ≥ 64px。
 * 少于这个量拟合不出有意义的斜率，硬开只会拿一条假映射去猜。
 *
 * ⚠️ 这一层的可信度**全部押在标定质量上**：标定点错，整层的候选都跟着错。
 * 所以采样只取文本类来源（见 `calibration` 的构造处），门槛也只认「近得很明显」的。
 */
const CALIBRATION_MIN_SAMPLES = 4;
const CALIBRATION_MIN_SPREAD = 64;
/** 标定区间外多留一点余量再算外推，避免边界抖动 */
const CALIBRATION_EXTRAPOLATION_TOLERANCE = 24;
/** 外推样本的降权系数：还能用，但不足以单独定案 */
const CALIBRATION_EXTRAPOLATION_PENALTY = 0.6;
/**
 * L3c：中心到中心的**曼哈顿距离**上限（设计稿坐标系，px）。
 *
 * 为什么是像素而不是 0..1 的分数：见 `lockByCalibratedPosition` 里的说明 ——
 * 分数挤在 0.85~1.0，用「分数差」当门槛永远达不到；像素距离可解释、可标定。
 * 28px 覆盖「半个图标宽度」的偏差，再多就不该自动配了。
 *
 * ⚠️ 这是**位置 + 尺寸**的合计预算（见 `centerDistance`），不只是位置。
 */
const CALIBRATION_MAX_DISTANCE = 28;
/**
 * L3c：尺寸失配在距离里的权重（1 = 与位置同权，直接按像素相加）。
 *
 * ⚠️ 这一项是**父子选择**的关键证据，不是锦上添花。实测漏配里最常见的形态是
 * 「设计稿的 32×32 图标 Frame ← App 的 30.67×30.67 扁平 ImageView」，
 * 而这个 Frame **内部**还套着一个 20.6×27.5 的矢量图。这三者的中心几乎重合：
 *
 * | App 节点 | 候选 | 位置失配 | 尺寸失配 |
 * |---|---|---|---|
 * | image 30.7×30.7 | **真值** container 32×32（外层） | 2.4 | **0.1** |
 * | image 30.7×30.7 | 引擎选中 icon 20.6×27.5（内层） | 1.4 | **15.7** |
 *
 * 只按中心距离最近邻时，位置项把两者判成平手甚至偏向内层（1.4 < 2.4），
 * 谁赢只取决于遍历顺序 —— 实测 16 例里 10 例选中了真值的**子孙节点**。
 * 尺寸项一加进去两者立刻分开（2.5 vs 17.1），而且方向是对的：
 * App 把整块内容拍平成一个节点，它的包围盒对应的是设计稿**外层**那个盒子。
 */
const CALIBRATION_SIZE_WEIGHT = 1;
/**
 * L3c：次优候选必须比最近候选远这么多倍才敢锁定。
 *
 * 这是这一层的**安全阀**。最近邻天生会给出一个答案，哪怕正确答案根本不在候选里；
 * 要求「次优明显更远」才能把「附近只有一个像的」与「附近挤着一排都差不多」区分开 ——
 * 后者正是 `contradicts`（差一位配到隔壁兄弟）的成因，不能在新层里重演。
 */
const CALIBRATION_DISTANCE_MARGIN = 1.6;
/**
 * L3c：判定「同一个盒子」的容差（px，逐边比较）。
 *
 * ⚠️ 为什么要有「同一个盒子」这个概念：采集侧会出现**同位置的多个等价节点**。
 * 实测最常见的是 SVG：`GroupView` 下面并排一个 `<mask>` 矩形与真正的内容组，
 * 两者尺寸位置完全一致（17×17@(31,536) 对 17×17@(31,536)）。
 * 它们对同一个设计节点来说是**同一个目标**，谁近 0.2px 纯属浮点噪声。
 *
 * 但这一层如果不认这件事，后果很重：次优候选只远 0.2px → `runnerUp >= distance × 1.6`
 * 必然不成立 → 整条**锁不上**（实测这类占了「引擎一个候选都没给」那一半）。
 * 所以竞争判定里要把「与最优候选同盒」的次优**排除在竞争之外**（见 `isSameBox`）。
 *
 * 为什么是排除次优、而不是在候选池里去掉重复节点：因为**去掉哪一个都可能去掉真值**。
 * 人对这种重复节点本来就会随手点其中一个（或者承接引擎预填的那个），
 * 池子里留两个、只让它们不互相否决，才能保住真值那一个。
 */
const CALIBRATION_TWIN_TOLERANCE = 3;

/** 一条已锁定的配对：锚点 / 投票 / 兄弟分配的产物，尚未落成 NodeMatch */
interface LockedPair {
  designIds: string[];
  appIds: string[];
  confidence: number;
  origin: NonNullable<NodeMatch['origin']>;
  status: 'matched' | 'ambiguous';
  relation: NodeMatch['relation'];
  alternatives?: Array<{ appNodeId: string; score: number }>;
}

function docScale(designDocument: CanonicalDocument, appDocument: CanonicalDocument): number {
  return designDocument.width > 0 && appDocument.width > 0
    ? designDocument.width / appDocument.width
    : 1;
}

/** 矩形中心的纵向坐标 —— 校准采样一律用中心，避免高矮不一的节点各按自己的顶边对齐 */
function centerY(rect: Rect): number {
  return rect.y + rect.height / 2;
}

/**
 * 纵向校准：`App y → 设计稿 y` 的单调分段线性映射。
 *
 * ⚠️ 为什么必须有：App 截图是**视口**，设计稿是**整页**。两侧绝对 y 之间差着一个滚动量，
 * 而且这个量逐页不同 —— 纯按宽度缩放（`transformAppRect`）做出来的 y 必然对不上。
 * 实测最扎眼的一例：同一个底栏「我的」，设计稿 y=1213 / App y=762，换算后 `dy=418`、
 * `IoU=0` —— 位置项直接归零，尽管它俩就是同一个东西。
 *
 * 采样来自 **L2 已锁定的文本锚点**：文本相等是高置信事实，拿它当标定点不引入新假设。
 * 只用文本类来源，**不能用** L3a/L3b 的产物 —— 那两层的结论本身可能是错的，用它标定
 * 等于拿待检验的答案去校准检验标准。
 */
export interface VerticalCalibration {
  /** 按 `appY` 升序的采样点 */
  readonly samples: ReadonlyArray<{ appY: number; designY: number }>;
}

/**
 * 建立纵向校准。采样不足或退化（所有点挤在一条水平线上）时返回 `null`，
 * 调用方一律要处理 `null`（退化成「不做校准」的旧行为），而不是拿一个假映射继续算。
 */
export function buildVerticalCalibration(
  pairs: ReadonlyArray<{ designY: number; appY: number }>,
): VerticalCalibration | null {
  // 同一 appY 只留一个：重复锚点（同一条文案出现多次）会把局部斜率算歪
  const byAppY = new Map<number, number>();
  for (const pair of pairs) {
    if (!Number.isFinite(pair.designY) || !Number.isFinite(pair.appY)) continue;
    if (!byAppY.has(pair.appY)) byAppY.set(pair.appY, pair.designY);
  }
  const samples = [...byAppY.entries()]
    .map(([appY, designY]) => ({ appY, designY }))
    .sort((first, second) => first.appY - second.appY);
  if (samples.length < CALIBRATION_MIN_SAMPLES) return null;
  const spread = samples[samples.length - 1]!.appY - samples[0]!.appY;
  if (spread < CALIBRATION_MIN_SPREAD) return null;
  return { samples };
}

/**
 * 把 App 侧 y 换算到**设计稿坐标系**。
 *
 * 落在采样区间外时**钳制**到端点值（`extrapolated` 由 `isCalibrationExtrapolated` 单独报出）：
 * 外推的线性映射会把页脚元素预测到几千像素外，钳制至少让它落在「最后一个已知位置」附近，
 * 再由调用方按 `extrapolated` 降权。
 */
export function calibratedDesignY(calibration: VerticalCalibration | null, appY: number): number {
  if (!calibration) return appY;
  const samples = calibration.samples;
  if (samples.length === 0) return appY;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (appY <= first.appY) return first.designY;
  if (appY >= last.appY) return last.designY;
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (samples[mid]!.appY <= appY) low = mid;
    else high = mid;
  }
  const left = samples[low]!;
  const right = samples[high]!;
  if (right.appY === left.appY) return left.designY;
  return left.designY + (right.designY - left.designY) * (appY - left.appY) / (right.appY - left.appY);
}

/** App y 是否落在标定区间之外 —— 外推值要降权，不能当等价证据用 */
export function isCalibrationExtrapolated(calibration: VerticalCalibration | null, appY: number): boolean {
  if (!calibration || calibration.samples.length === 0) return false;
  const first = calibration.samples[0]!;
  const last = calibration.samples[calibration.samples.length - 1]!;
  return appY < first.appY - CALIBRATION_EXTRAPOLATION_TOLERANCE
    || appY > last.appY + CALIBRATION_EXTRAPOLATION_TOLERANCE;
}

/**
 * L3c 专用的相容度 —— **不做「下推能力必须一致」的硬否决**。
 *
 * ⚠️ `salienceAffinity` 里那条规则（`box` 能分支、`graphic` 是叶子，不一致直接 0）是为
 * **L3b 的下推**设计的：配上了也推不动，所以是死刑。但本层不负责下推。
 * 实测漏配最多的形态恰恰是「设计稿的 Frame 壳 ↔ App 的扁平 ImageView」
 * （`container 24×24 ↔ image 24×24`、`container 32×32 ↔ image 30.67×30.67` 反复出现），
 * 套用硬否决会让这一整类**永远配不上** —— 而它们就是同一个图标。
 *
 * 真正该硬否决的只有一条：**文本 vs 非文本**。文案要么落在文本控件上，要么就是丢了，
 * 拿它去配一张图没有任何解释。其余跨类别只降权，不封死。
 */
function calibratedAffinity(design: Salience, app: Salience): number {
  if (design === app) return 1;
  if (design === 'text' || app === 'text') return 0.35;
  if (design === 'layout' || app === 'layout') return 0.5;
  return 0.85;
}

function isSameBox(first: CanonicalNode, second: CanonicalNode, tolerance: number): boolean {
  return Math.abs(first.rect.x - second.rect.x) <= tolerance
    && Math.abs(first.rect.y - second.rect.y) <= tolerance
    && Math.abs(first.rect.width - second.rect.width) <= tolerance
    && Math.abs(first.rect.height - second.rect.height) <= tolerance;
}

/**
 * 两点在设计稿坐标系下的顶点距离 = 中心曼哈顿距离 + 尺寸失配（外推区整体放大）。
 *
 * 为什么也要算尺寸：见 `CALIBRATION_SIZE_WEIGHT` —— 只看中心，设计稿的父子两层
 * 与同一个 App 节点的距离几乎相等，会稳定地选中内层子孙。
 *
 * 为什么尺寸失配用**绝对像素**而不是相对比例：位置项本来就是绝对像素，
 * 两者相加才是同一个量纲（「总共差了多少 px」），也才能和 `CALIBRATION_MAX_DISTANCE`
 * 这个预算直接比较。相对比例会让 300×300 的大卡片的 16px 偏差被当成零 ——
 * 而它可能正是「配到了隔壁那张卡」。
 */
function centerDistance(design: CanonicalNode, app: CanonicalNode, scale: number, calibration: VerticalCalibration): number {
  const appCenterY = app.rect.y + app.rect.height / 2;
  const appX = (app.rect.x + app.rect.width / 2) * scale;
  const appY = calibratedDesignY(calibration, appCenterY);
  const designX = design.rect.x + design.rect.width / 2;
  const designY = design.rect.y + design.rect.height / 2;
  const position = Math.abs(designX - appX) + Math.abs(designY - appY);
  const size = Math.abs(design.rect.width - app.rect.width * scale)
    + Math.abs(design.rect.height - app.rect.height * scale);
  // 超出标定区间时，映射是外推出来的 —— 还能用，但不足以与区间内的候选平等竞争
  const extrapolation = isCalibrationExtrapolated(calibration, appCenterY)
    ? 1 / CALIBRATION_EXTRAPOLATION_PENALTY
    : 1;
  return (position + size * CALIBRATION_SIZE_WEIGHT) * extrapolation;
}

/**
 * 局部几何分：**位置以父节点为参照，尺寸以自身为参照**。
 *
 * ⚠️ 为什么不能沿用 `geometryScore`（分母是整页宽+高）：那个口径下，小元素之间的差异
 * 会被整页尺寸淹没。实测 `148×100 ↔ 147×14`（高度差 86px，肉眼明显不是一个东西）
 * 在整页口径下仍有 **0.947** —— 于是兄弟分配会把它当正确答案收下。
 * 换成局部口径它只有 **0.567**，正好落在阈值之下。
 *
 * 位置为什么用**设计稿侧**的父节点做分母：设计稿是基准，App 侧同一容器的高度会因内容
 * 多少而变（滚动区尤甚），拿它当分母会让越靠下的元素分数越低 —— 那惩罚的是页面长度差异，
 * 不是布局错误。尺寸则对两侧取较大者：小元素差 1px 与差 10px 必须区分开。
 *
 * ⚠️ **位置偏移用的是绝对坐标差，不是父相对差 —— 试过了，父相对是负贡献，别重试。**
 * 理由反直觉：在 L3b 里两侧父容器**已经配对**，两种口径的排序**完全相同**
 * （`design.y - app.y·s` = `(designParent.y - appParent.y·s) + 父内相对差`，
 * 前一项对同一容器内所有候选都一样），差的只是一个**常数水平位**。
 * 但那个常数正被阈值依赖着：`SIBLING_MIN_SCORE`(0.7) 与 `AUTO_MATCH_MARGIN` 是在旧水平位
 * 上调出来的，去掉常数会让所有分数整体抬高，一批本被压在线下的错配因此过线。
 * 实测：改成父相对后 `contradicts` 1 → 3、`agrees` 33 → 32、found 42.3% → 41.0%。
 * L2 的重复文案消歧里两种口径排序**确实**不同，实测同样是绝对坐标更优。
 *
 * 要动这里就必须连着重调 L3b 的门槛，而单样本重调 = 过拟合。等真值样本攒够再动。
 */
function localGeometryScore(input: {
  design: CanonicalNode;
  app: CanonicalNode;
  designParent: CanonicalNode | null;
  designDocument: CanonicalDocument;
  scale: number;
}): number {
  const { design, app, designParent, designDocument, scale } = input;
  const appX = app.rect.x * scale;
  const appY = app.rect.y * scale;
  const appWidth = Math.max(0, app.rect.width * scale);
  const appHeight = Math.max(0, app.rect.height * scale);

  const widthDelta = Math.abs(design.rect.width - appWidth) / Math.max(design.rect.width, appWidth, 1);
  const heightDelta = Math.abs(design.rect.height - appHeight) / Math.max(design.rect.height, appHeight, 1);
  const size = clamp(1 - (widthDelta + heightDelta) / 2);

  const referenceWidth = Math.max(1, designParent ? designParent.rect.width : designDocument.width);
  const referenceHeight = Math.max(1, designParent ? designParent.rect.height : designDocument.height);
  const position = clamp(1 - (
    Math.abs(design.rect.x - appX) / referenceWidth
    + Math.abs(design.rect.y - appY) / referenceHeight
  ) / 2);

  // 尺寸与位置等权：只看位置会让「同一位置但大小差一倍」的容器也配上；
  // 只看尺寸会让「同尺寸但跑到别处」的卡片配上。
  return clamp(size * 0.5 + position * 0.5);
}

/**
 * 意义类别的相容度，乘在几何分上 —— 「不相容」等价于给这条配对判了死刑。
 *
 * ⚠️ 这里是**唯一的相容性判据来源**：L3b 的分配矩阵、L3a 的祖先投票、「两侧各一个根」
 * 的兜底都调它。判据一旦分散成三份，就会出现「某个组合在两处被允许、在第三处被拒绝」
 * 这种谁也解释不清的结果。
 *
 * 三条规则，各自对应一类实测错配：
 *   1. `text` 与其它类别 0.5 —— 文案要么落在文本控件上，要么就是真的丢了。0.5 倍乘数
 *      意味着需要几何分 ≥ 1.4 才能到 0.7 的门槛，数学上不可能，即硬否决。
 *   2. **下推能力必须一致** —— `box`（有子节点、还要往下比）配 `graphic`（叶子、
 *      到此为止）结构上自相矛盾：配上了也下推不了。这正是「设计侧 7 个子节点的盒子
 *      配到 App 侧一个叶子图形上、下推当场断掉」的直接成因；此前只给 0.85 的软惩罚，
 *      拦不住它（实测矩阵里这类错配稳定拿到 0.85 × 几何分，照样过 0.7 门槛）。
 *   3. 其余跨类别 0.85 —— `layout`（透传壳）配 `box` 确实存在「同一块东西被组织成
 *      不同结构」的情况（实测的页面容器就是壳套盒），留一条窄路。
 */
function salienceAffinity(first: Salience, second: Salience): number {
  if (first === second) return 1;
  if (first === 'text' || second === 'text') return 0.5;
  // 能不能继续往下走：`box` / `layout` 在分发内容，`graphic` 是叶子。
  // 两侧不一致 → 这条配对在结构上不成立，直接 0（不是罚款，是死刑）。
  const firstBranches = first === 'box' || first === 'layout';
  const secondBranches = second === 'box' || second === 'layout';
  if (firstBranches !== secondBranches) return 0;
  return 0.85;
}

interface TextRun {
  nodeIds: string[];
  key: string;
}

/**
 * 枚举文本 run：单个文本节点，以及**同一父节点下相邻**的 2~3 个文本节点的拼接。
 *
 * 为什么必须支持拼接：两侧的文本切分粒度不一致。实测设计稿是 `10年包修` + `&` +
 * `10年免费上门检测` 三个 TEXT 节点，App 侧是**同一个** ReactTextView 里的
 * `10年包修 & 10年免费上门检测`。只按单节点比，这三个文案全部对不上 ——
 * 它们是「仅 design 有」的 35 种文案里的一部分。
 *
 * 比较用 squash 后的形式（连空格一起去掉）：上面这个例子里设计稿没有空格、App 有空格，
 * 那是渲染差异而不是文案差异。
 *
 * 只在**文本**兄弟里取相邻：中间夹着图标的两个文本不算相邻，硬拼起来会造出
 * 一个两边都恰好存在的假 key。
 */
function collectTextRuns(document: CanonicalDocument, byId: Map<string, CanonicalNode>): Map<string, TextRun[]> {
  const runs = new Map<string, TextRun[]>();
  const push = (key: string, nodeIds: string[]): void => {
    if (key.length === 0) return;
    const bucket = runs.get(key);
    if (bucket) bucket.push({ nodeIds, key });
    else runs.set(key, [{ nodeIds, key }]);
  };

  for (const node of document.nodes) {
    if (node.salience !== 'text') continue;
    push(squashText(node.content.rawText), [node.canonicalId]);
  }

  // 同一父节点下的文本子节点，按文档数组顺序（= 扁平化时保留的原始顺序）
  const textChildrenOf = new Map<string, string[]>();
  for (const node of document.nodes) {
    if (node.salience !== 'text' || !node.parentId) continue;
    const bucket = textChildrenOf.get(node.parentId);
    if (bucket) bucket.push(node.canonicalId);
    else textChildrenOf.set(node.parentId, [node.canonicalId]);
  }
  for (const ids of textChildrenOf.values()) {
    for (let start = 0; start < ids.length; start += 1) {
      for (let length = 2; length <= MAX_TEXT_RUN && start + length <= ids.length; length += 1) {
        const run = ids.slice(start, start + length);
        const key = run.map((id) => squashText(byId.get(id)?.content.rawText)).join('');
        push(key, run);
      }
    }
  }

  return runs;
}

function relationOf(designCount: number, appCount: number): NodeMatch['relation'] {
  if (designCount === 1 && appCount === 1) return 'one_to_one';
  if (designCount === 1) return 'one_to_many';
  if (appCount === 1) return 'many_to_one';
  return 'one_to_one';
}

/**
 * L2 · 文本锚点提取。
 *
 * 三级可信度（全部来自实测）：
 *   1. 两侧各自唯一 → confidence 1.0。真实样本里 40/45 对落在这一档，**全部正确**；
 *   2. 两侧有一侧重复 → 几何消歧（候选对里取 geo ≥ 0.85 且一对一）→ 0.95；
 *   3. 凑不出唯一对应 → 不锁，留给 L3（宁可不锁，也不要锁错 —— 锚点错了会顺着
 *      祖先投票把整棵子树带偏）。
 */
function resolveTextAnchors(input: {
  designDocument: CanonicalDocument;
  appDocument: CanonicalDocument;
  designById: Map<string, CanonicalNode>;
  appById: Map<string, CanonicalNode>;
  scale: number;
  availableDesign: (id: string) => boolean;
  availableApp: (id: string) => boolean;
}): LockedPair[] {
  const designRuns = collectTextRuns(input.designDocument, input.designById);
  const appRuns = collectTextRuns(input.appDocument, input.appById);
  const locks: LockedPair[] = [];

  const designParentOf = (id: string): CanonicalNode | null => {
    const node = input.designById.get(id);
    return node?.parentId ? input.designById.get(node.parentId) ?? null : null;
  };

  for (const [key, designBucket] of designRuns) {
    const appBucket = appRuns.get(key);
    if (!appBucket) continue;
    const designs = designBucket.filter((run) => run.nodeIds.every(input.availableDesign));
    const apps = appBucket.filter((run) => run.nodeIds.every(input.availableApp));
    if (designs.length === 0 || apps.length === 0) continue;

    if (designs.length === 1 && apps.length === 1) {
      const design = designs[0]!;
      const app = apps[0]!;
      const single = design.nodeIds.length === 1 && app.nodeIds.length === 1;
      locks.push({
        designIds: design.nodeIds,
        appIds: app.nodeIds,
        confidence: anchorConfidence(
          single ? ANCHOR_UNIQUE_BASE : ANCHOR_AGGREGATE_BASE,
          key,
          input.designById.get(design.nodeIds[0]!)?.depth ?? 0,
        ),
        origin: single ? 'text-anchor' : 'text-aggregate',
        status: 'matched',
        relation: relationOf(design.nodeIds.length, app.nodeIds.length),
      });
      continue;
    }

    // 任一侧重复 → 几何消歧。候选对是 runs 的笛卡尔积，但重复文本的组通常只有两三个成员。
    const qualifying: Array<{ design: TextRun; app: TextRun }> = [];
    for (const design of designs) {
      for (const app of apps) {
        const designNode = input.designById.get(design.nodeIds[0]!);
        const appNode = input.appById.get(app.nodeIds[0]!);
        if (!designNode || !appNode) continue;
        const score = localGeometryScore({
          design: designNode,
          app: appNode,
          designParent: designParentOf(designNode.canonicalId),
          designDocument: input.designDocument,
          scale: input.scale,
        });
        if (score >= DISAMBIGUATE_GEOMETRY_FLOOR) qualifying.push({ design, app });
      }
    }
    // 「一对一」：这一对必须同时是它那一行、它那一列里**唯一**满足几何条件的 ——
    // 否则 4 个「更多」按钮会两两配上（两组候选都合格），那是错的。
    const designTally = new Map<string, number>();
    const appTally = new Map<string, number>();
    for (const pair of qualifying) {
      const designKey = pair.design.nodeIds.join(',');
      const appKey = pair.app.nodeIds.join(',');
      designTally.set(designKey, (designTally.get(designKey) ?? 0) + 1);
      appTally.set(appKey, (appTally.get(appKey) ?? 0) + 1);
    }
    for (const pair of qualifying) {
      if (designTally.get(pair.design.nodeIds.join(',')) !== 1) continue;
      if (appTally.get(pair.app.nodeIds.join(',')) !== 1) continue;
      locks.push({
        designIds: pair.design.nodeIds,
        appIds: pair.app.nodeIds,
        confidence: anchorConfidence(
          ANCHOR_DISAMBIGUATED_BASE,
          key,
          input.designById.get(pair.design.nodeIds[0]!)?.depth ?? 0,
        ),
        origin: 'text-disambiguated',
        status: 'matched',
        relation: relationOf(pair.design.nodeIds.length, pair.app.nodeIds.length),
      });
    }
  }

  return locks;
}

/** 有效子节点：可见且非零尺寸（被过滤的子节点分发不了任何内容） */
function effectiveChildren(node: CanonicalNode, byId: Map<string, CanonicalNode>): CanonicalNode[] {
  return node.childIds
    .map((id) => byId.get(id))
    .filter((child): child is CanonicalNode => !!child && child.visible && child.rect.width > 0 && child.rect.height > 0);
}

/** 戳穿透传链的最大跳数：18 层包装也够走到底，同时挡住自引用之类的异常数据 */
const PUNCH_THROUGH_MAX_HOPS = 24;

/**
 * 戳穿透传链：沿「唯一有效子节点」一路走下去，直到节点不再透传或分叉。
 *
 * 这是「识别无意义的嵌套 view」那条需求的落地点。App 侧真实内容前面挂着约 20 层框架包装
 * （ReactSurfaceView → GestureHandler → SafeAreaProvider → ScreenStack → Screen →
 * ScreenContentWrapper → ViewPager2 → RefreshControl → ReactScrollView …），设计稿侧
 * 也常见「一层 Frame 套一层 Frame」。匹配一旦锁在壳上，拿它的子节点去比对就只有一个候选，
 * 下推当场断掉 —— 而真正该比的是壳里面那层容器。
 *
 * 只沿**单子**链下探：一旦分叉（≥2 个有效子节点），说明这一层自己在分发内容，
 * 它就是那层「有意义的嵌套 view」，该停在它这里。
 */
/**
 * 沿「透传链」走到底，返回**整条路径**（含起点）。
 *
 * ⚠️ 这里返回路径而不是尾节点，是因为「替换」会丢节点。`punchThrough` 早期的写法是
 * 直接把壳换成壳里面那层，于是那一层**只**作为「容器」被拿去下推子节点，自己从来没被
 * 匹配过 —— 它掉进 missing，对面同一个位置掉进 extra。镜像夹具（两侧同构、零缺陷）
 * 上实测稳定产生 7 对：`83:53776 [box/ch=2] -> missing` / `ax:83:53776 -> extra`，
 * 而它父链上的壳 `53775 -> ambiguous` 是正常的。矩阵本身是对的
 * （`[[1,.36],[.36,1]]`，对角线 1.0 远超 0.7 门槛）—— 所以问题不在打分，在归属。
 */
function punchThroughPath(node: CanonicalNode, byId: Map<string, CanonicalNode>): CanonicalNode[] {
  const path = [node];
  let current = node;
  for (let hop = 0; hop < PUNCH_THROUGH_MAX_HOPS; hop += 1) {
    if (!current.passThrough) break;
    const children = effectiveChildren(current, byId);
    if (children.length !== 1) break;
    current = children[0]!;
    path.push(current);
  }
  return path;
}

/**
 * 戳穿透传链：沿「唯一有效子节点」一路走下去，直到节点不再透传或分叉。
 *
 * 这是「识别无意义的嵌套 view」那条需求的落地点。App 侧真实内容前面挂着约 20 层框架包装
 * （ReactSurfaceView → GestureHandler → SafeAreaProvider → ScreenStack → Screen →
 * ScreenContentWrapper → ViewPager2 → RefreshControl → ReactScrollView …），设计稿侧
 * 也常见「一层 Frame 套一层 Frame」。匹配一旦锁在壳上，拿它的子节点去比对就只有一个候选，
 * 下推当场断掉 —— 而真正该比的是壳里面那层容器。
 *
 * 只沿**单子**链下探：一旦分叉（≥2 个有效子节点），说明这一层自己在分发内容，
 * 它就是那层「有意义的嵌套 view」，该停在它这里。
 */
function punchThrough(node: CanonicalNode, byId: Map<string, CanonicalNode>): CanonicalNode {
  const path = punchThroughPath(node, byId);
  const last = path[path.length - 1]!;
  if (last === node) return node;
  // 只有**确实揭出一层在分发内容的容器**才值得跳。跳到另一个更小的壳上毫无收益，
  // 反而会把原本能配上的那一层丢掉（实测：无条件跳跃会让锁定数从 96 掉到 88）。
  return effectiveChildren(last, byId).length >= 2 ? last : node;
}

/**
 * 逻辑子节点组：把每个子节点连同它内部的透传链折成**一组**。
 *
 * 组是分配的最小单位。壳（无绘制 + 唯一子 + 子铺满）在屏幕上不占独立像素，它和它里面
 * 那层是**同一块东西**，所以「整条链 ↔ 对面整条链」才是一条正确的配对 —— 这样
 * 「每个节点恰好出现在一条 match 里」的守恒约束才成立（见 `punchThroughPath` 的实测）。
 */
function groupChildren(
  parent: CanonicalNode,
  byId: Map<string, CanonicalNode>,
  available: (id: string) => boolean,
): CanonicalNode[][] {
  const groups: CanonicalNode[][] = [];
  for (const id of parent.childIds) {
    if (!available(id)) continue;
    const child = byId.get(id);
    if (!child) continue;
    // 链上已被匹配的层要**裁掉**，而不是整组丢弃：壳链里某一层（往往是链尾那个文本 /
    // 图形）可能已经被 L2 锚点先锁走了，这时**壳自己还在等着配对** —— 丢掉整组会让壳
    // 掉进 missing（镜像夹具实测：4 个 `layout/PT/ch=1` 全部漏配，且 `rows` 比 `childIds`
    // 少 6 个）。
    //
    // 裁掉之后组尾可能退化成壳，几何分改用壳算 —— 分数不变：`passThrough` 的定义就要求
    // 「唯一子节点且**铺满自身**」（容差 2px），所以壳与它里面那层是同一块矩形。
    const group = punchThroughPath(child, byId).filter((node) => available(node.canonicalId));
    if (group.length === 0) continue;
    groups.push(group);
  }
  return groups;
}

/** 沿父链取祖先，**过滤掉 layout**（透传壳既不是结构证据，也不该被匹配） */function ancestorChain(
  nodeId: string,
  byId: Map<string, CanonicalNode>,
): CanonicalNode[] {
  const chain: CanonicalNode[] = [];
  let current = byId.get(nodeId)?.parentId ?? null;
  let guard = 0;
  while (current && guard < 256) {
    guard += 1;
    const node = byId.get(current);
    if (!node) break;
    if (node.salience !== 'layout') chain.push(node);
    current = node.parentId;
  }
  return chain;
}

/**
 * L3 · 祖先投票。
 *
 * 每条锚点都是一份「这两个节点指的是同一块东西」的证据，那么它们的祖先也大概率成对 ——
 * 这正是把 45 对锚点铺到整页容器的办法。**不做树形位置比较**：只在两条祖先链之间
 * 按几何分取最优，一个 App 祖先只投一票。
 *
 * ⚠️ 这里踩过的坑（必读）：第一版用「无视觉内容」判 layout，App 侧 527 个节点里 319 个
 * 被划成 layout —— 于是「找最近的盒子祖先」一步就跳到树根，45 个锚点**全部**投给根节点。
 * 换成「透传包装」判据后 App 侧 layout 降到 191，投票立刻收敛到真正的页面容器（38 票）。
 * 判据必须是「是否产生分支」，不是「是否画像素」。
 */
function collectAncestorVotes(
  anchors: LockedPair[],
  input: {
    designById: Map<string, CanonicalNode>;
    appById: Map<string, CanonicalNode>;
    designDocument: CanonicalDocument;
    scale: number;
    availableDesign: (id: string) => boolean;
    availableApp: (id: string) => boolean;
  },
): Map<string, { designId: string; appId: string; count: number; sum: number; average: number }> {
  const votes = new Map<string, { designId: string; appId: string; count: number; sum: number; average: number }>();

  for (const anchor of anchors) {
    const designStart = anchor.designIds[0];
    const appStart = anchor.appIds[0];
    if (!designStart || !appStart) continue;
    const designChain = ancestorChain(designStart, input.designById);
    const appChain = ancestorChain(appStart, input.appById);
    if (designChain.length === 0 || appChain.length === 0) continue;

    const used = new Set<string>();
    for (const designAncestor of designChain) {
      if (!input.availableDesign(designAncestor.canonicalId)) continue;
      let best: { appAncestor: CanonicalNode; score: number } | null = null;
      for (const appAncestor of appChain) {
        if (used.has(appAncestor.canonicalId)) continue;
        if (!input.availableApp(appAncestor.canonicalId)) continue;
        const score = localGeometryScore({
          design: designAncestor,
          app: appAncestor,
          designParent: designAncestor.parentId ? input.designById.get(designAncestor.parentId) ?? null : null,
          designDocument: input.designDocument,
          scale: input.scale,
        }) * salienceAffinity(designAncestor.salience, appAncestor.salience);
        if (!best || score > best.score) best = { appAncestor, score };
      }
      if (!best || best.score < VOTE_SCORE_FLOOR) continue;
      used.add(best.appAncestor.canonicalId);
      const key = `${designAncestor.canonicalId}|${best.appAncestor.canonicalId}`;
      const entry = votes.get(key) ?? {
        designId: designAncestor.canonicalId,
        appId: best.appAncestor.canonicalId,
        count: 0,
        sum: 0,
        average: 0,
      };
      entry.count += 1;
      entry.sum += best.score;
      entry.average = entry.sum / entry.count;
      votes.set(key, entry);
    }
  }

  return votes;
}

/**
 * 匹配过程的旁路观测出口。
 *
 * 只有「归宿表」需要它：要区分「这个节点没配上」和「这个节点**从没被考虑过**」，
 * 就必须知道哪些节点进过分配矩阵。做成可选参数而不是返回值，是因为它是**诊断**用的，
 * 引擎主路径不该为它多算一遍 —— `diagnoseMatching` 传实例，其余调用方不传。
 */
export interface MatchTrace {
  /** 进过某个容器分配矩阵的设计侧节点 */
  scopedDesign: Set<string>;
  /** 进过某个容器分配矩阵的 App 侧节点 */
  scopedApp: Set<string>;
}

export function matchDocuments(
  designDocument: CanonicalDocument,
  appDocument: CanonicalDocument,
  mapping?: NodeMapping,
  trace?: MatchTrace,
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

  // 人工确认与已确认锚点优先级最高：先把它们占用掉，规则层再也碰不到。
  // （旧引擎是在递归里逐层插入的，现在提前统一落盘 —— 顺序变了，优先级没变。）
  for (const entry of confirmed.values()) {
    matches.push(entry);
    entry.designNodeIds.forEach((id) => matchedDesign.add(id));
    entry.appNodeIds.forEach((id) => matchedApp.add(id));
  }

  const scale = docScale(designDocument, appDocument);
  const availableDesign = (id: string): boolean => !ignoredDesign.has(id) && !matchedDesign.has(id);
  const availableApp = (id: string): boolean => !ignoredApp.has(id) && !matchedApp.has(id);
  /** 本次锁定的全部配对（锚点 / 投票 / 兄弟分配），供后面的祖先投票与队列使用 */
  const applied: LockedPair[] = [];

  /**
   * 给「没有候选的歧义」补一份 Top-K。
   *
   * 为什么必须有：面板上「确认 / 忽略」的全部价值就在候选里 —— 没有候选的歧义条目，
   * 用户只能盲选（`MatchDetailList` 展开区那一栏是空的）。祖先投票与「两侧单根」的
   * 兜底都是**先锁一层容器**，投票本身不产生候选，所以在这里统一补。
   *
   * 候选池用 App 侧全量可用节点：这里只是给出**人可裁决的备选项**，不求最优分配
   * （那是 L3b 的活），所以不必受「同一父容器」的约束。
   */
  const fallbackAlternatives = (designNode: CanonicalNode): NodeMatch['alternatives'] => {
    const ranked = appDocument.nodes
      .filter((appNode) => availableApp(appNode.canonicalId))
      .map((appNode) => ({
        appNodeId: appNode.canonicalId,
        score: scorePair(designNode, appNode, designDocument, appDocument).score,
      }))
      .sort((a, b) => b.score - a.score || a.appNodeId.localeCompare(b.appNodeId))
      .slice(0, TOP_K_CANDIDATES);
    return ranked.length > 0 ? ranked : undefined;
  };

  /** 落一条锁定配对。任何一侧已被占用就整条放弃（锚点是独占的，不允许共享节点）。 */
  const apply = (pair: LockedPair): boolean => {
    if (!pair.designIds.every(availableDesign) || !pair.appIds.every(availableApp)) return false;
    // 代表节点取**组尾**：组首可能是透传壳（自己不画像素），拿它算六特征只会得到
    // 一堆莫名其妙的低分；真正可比的是链尾那层内容（见 `punchThroughPath`）。
    const designNode = designById.get(pair.designIds[pair.designIds.length - 1]!);
    const appNode = appById.get(pair.appIds[pair.appIds.length - 1]!);
    const evidence = designNode && appNode
      ? scorePair(designNode, appNode, designDocument, appDocument).evidence
      : { geometry: 0, structure: 0, relation: 0, visual: 0, content: 0, kind: 0 };
    const runnerUp = pair.alternatives?.find(
      (entry) => entry.appNodeId !== pair.appIds[pair.appIds.length - 1],
    );
    matches.push({
      id: matchId(pair.designIds, pair.appIds),
      designNodeIds: pair.designIds,
      appNodeIds: pair.appIds,
      relation: pair.relation,
      source: 'rule',
      origin: pair.origin,
      ruleScore: pair.confidence,
      confidence: pair.confidence,
      margin: runnerUp ? clamp(pair.confidence - runnerUp.score) : 1,
      evidence,
      status: pair.status,
      alternatives: pair.status === 'ambiguous'
        ? pair.alternatives ?? (designNode ? fallbackAlternatives(designNode) : undefined)
        : undefined,
    });
    pair.designIds.forEach((id) => matchedDesign.add(id));
    pair.appIds.forEach((id) => matchedApp.add(id));
    applied.push(pair);
    return true;
  };

  // ---- L2 · 文本锚点 ----
  for (const lock of resolveTextAnchors({
    designDocument,
    appDocument,
    designById,
    appById,
    scale,
    availableDesign,
    availableApp,
  })) {
    apply(lock);
  }

  /**
   * 纵向校准的采样点**只取文本类来源**（L2 锚点 + 人工锚点）。
   *
   * ⚠️ 绝不能把 `applied` 全量喂进来：L3a 的投票产物是 `ambiguous`、L3b 的兄弟分配
   * 可能本身就是错的（那 2 条 `contradicts` 全是 sibling 层差一位），拿它们当标定点，
   * 等于用待检验的结论去校准检验标准 —— 错的越多，校准越自洽，最后整体跑偏还看不出来。
   */
  const calibration = buildVerticalCalibration(
    applied
      .filter((pair) => pair.origin !== 'ancestor-vote' && pair.origin !== 'sibling')
      .flatMap((pair) => {
        const design = designById.get(pair.designIds[pair.designIds.length - 1]!);
        const app = appById.get(pair.appIds[pair.appIds.length - 1]!);
        return design && app ? [{ designY: centerY(design.rect), appY: centerY(app.rect) }] : [];
      }),
  );

  // ---- L3a · 祖先投票 ----
  const votes = collectAncestorVotes(applied, {
    designById,
    appById,
    designDocument,
    scale,
    availableDesign,
    availableApp,
  });
  // 按票数降序：高票项必须先落，否则低票的「同一棵子树里的重复项」会先把 App 节点占掉。
  // 实测里 d0 同时投给 a26（38 票）与 a2（7 票），靠这一步才收敛到 a26。
  const voteLocks = [...votes.values()]
    .filter((vote) => vote.count >= VOTE_LOCK_MIN_COUNT && vote.average >= VOTE_LOCK_MIN_SCORE)
    .sort((a, b) => b.count - a.count
      || b.average - a.average
      || a.designId.localeCompare(b.designId)
      || a.appId.localeCompare(b.appId));
  for (const vote of voteLocks) {
    apply({
      designIds: [vote.designId],
      appIds: [vote.appId],
      confidence: Math.min(DIFFUSION_MAX_CONFIDENCE, Math.max(DIFFUSION_MIN_CONFIDENCE, vote.average)),
      origin: 'ancestor-vote',
      status: 'ambiguous',
      relation: 'one_to_one',
    });
  }

  // ---- L3a' · 两侧各只有一个根时的兜底 ----
  // 没有文本锚点（纯图形页）时投票无从谈起，但「各一个根」本身就是无歧义的事实。
  // 只在确实没锁上时才做，避免和投票结果抢同一个节点。
  if (designDocument.rootIds.length === 1 && appDocument.rootIds.length === 1) {
    const designRoot = designById.get(designDocument.rootIds[0]!);
    const appRoot = appById.get(appDocument.rootIds[0]!);
    if (designRoot && appRoot && availableDesign(designRoot.canonicalId) && availableApp(appRoot.canonicalId)) {
      const score = localGeometryScore({ design: designRoot, app: appRoot, designParent: null, designDocument, scale })
        * salienceAffinity(designRoot.salience, appRoot.salience);
      if (score >= VOTE_LOCK_MIN_SCORE) {
        apply({
          designIds: [designRoot.canonicalId],
          appIds: [appRoot.canonicalId],
          confidence: Math.min(DIFFUSION_MAX_CONFIDENCE, score),
          origin: 'ancestor-vote',
          status: 'ambiguous',
          relation: 'one_to_one',
        });
      }
    }
  }

  // ---- L3b · 兄弟分配（含递归下推） ----
  // 队列而不是递归：一对容器锁定后才轮到它的子节点，而「谁先被锁定」决定了后面谁还能用
  // 哪些 App 节点 —— 顺序必须是确定的（同输入同结论），队列的 FIFO 天然满足。
  const queue: Array<{ designParent: CanonicalNode; appParent: CanonicalNode }> = [];
  const queued = new Set<string>();
  const enqueueContainer = (designNode: CanonicalNode | undefined, appNode: CanonicalNode | undefined): void => {
    if (!designNode || !appNode) return;
    // ⚠️ **先戳穿透传链再下推**。锁上的两侧往往只是壳：实测 App 侧一个 360×288 的
    // `ReactViewGroup`（单子、铺满）被锁到设计稿 375×265 的区块上，如果直接拿它的
    // 子节点去比对，就只剩 1 个候选 —— 而那个区块有 4 个子节点，下推当场断掉。
    // 沿「唯一有效子节点」一路走到真正的容器，两侧才对得齐。
    const designTarget = punchThrough(designNode, designById);
    const appTarget = punchThrough(appNode, appById);
    if (designTarget.childIds.length === 0 || appTarget.childIds.length === 0) return;
    const key = `${designTarget.canonicalId}|${appTarget.canonicalId}`;
    if (queued.has(key)) return;
    queued.add(key);
    if (MATCH_TRACE) {
      console.log(
        '[L3b:enqueue]',
        designNode.canonicalId,
        '->',
        designTarget.canonicalId,
        '|',
        appNode.canonicalId,
        '->',
        appTarget.canonicalId,
      );
    }
    queue.push({ designParent: designTarget, appParent: appTarget });
  };
  for (const pair of applied) {
    enqueueContainer(designById.get(pair.designIds[0]!), appById.get(pair.appIds[0]!));
  }

  /**
   * L3c · 锚点校准定位 —— 队列**排空的那一刻**跑一次。
   *
   * 为什么必须排在 L3b 之后、而不能提前：树结构证据强于几何推断。L3a/L3b 能锁的先让它们锁，
   * 本层只接剩下的漏网节点；提前跑会先把节点占掉，让本来能被结构层正确配对的节点被判成别的。
   *
   * 为什么必须排在 L3b **循环条件**里而不是循环之后：本层锁上的新容器需要继续下推，
   * 而「继续下推」的唯一入口就是 `enqueueContainer` + 这个队列。放在循环之后，
   * 新容器就只停在它自己那一层，里面整棵子树仍然漏配。
   *
   * ⚠️ 本层的证据**不来自树**，正因如此它才补得上最大的那个缺口：实测 42 个漏配对里
   * 「父容器已被锁定」的有 **0** 个 —— L3a 要祖先、L3b 要容器，两层同时空转。
   */
  let calibratedPassDone = false;
  const lockByCalibratedPosition = (): void => {
    if (!calibration) return;
    // 只考虑「有内容、允许匹配」的节点。`layout` 与 `ignored` 一律不进候选：
    // 前者是透传壳（它和里面那层是同一块东西，收进来就是自己跟自己抢），
    // 后者是采集噪声（零尺寸 / 画板外）。
    const designPool = designDocument.nodes.filter(
      (node) => availableDesign(node.canonicalId) && node.participation === 'required' && node.salience !== 'layout',
    );
    const appPool = appDocument.nodes.filter(
      (node) => availableApp(node.canonicalId) && node.participation === 'required' && node.salience !== 'layout',
    );
    if (designPool.length === 0 || appPool.length === 0) return;

    const distanceOf = (design: CanonicalNode, app: CanonicalNode): number => {
      const affinity = calibratedAffinity(design.salience, app.salience);
      // 相容度折进距离：亲和度低 = 等效距离被拉长，于是它要靠「近得多」才能赢。
      // 这样只需要一个标量比较，不必把「分数量纲」和「像素量纲」混在一起。
      return centerDistance(design, app, scale, calibration) / affinity;
    };

    // 双向最近邻：每个设计节点找最近的 App 节点，每个 App 节点也找最近的设计节点。
    // 只有**互为最近**才继续 —— 单向最近在「一排长得差不多的图标」上必然串位。
    //
    // `runnerUpId` 必须一起带上：竞争判定要问的不是「次优有多远」，而是
    // 「次优是不是同一块像素的另一个化身」（见 `CALIBRATION_TWIN_TOLERANCE`）。
    const bestAppForDesign = new Map<
      string,
      { appId: string; distance: number; runnerUp: number; runnerUpId: string | null }
    >();
    const bestDesignForApp = new Map<string, { designId: string; distance: number }>();
    for (const design of designPool) {
      let best = { appId: '', distance: Number.POSITIVE_INFINITY, runnerUp: Number.POSITIVE_INFINITY, runnerUpId: null as string | null };
      for (const app of appPool) {
        const distance = distanceOf(design, app);
        if (distance < best.distance) {
          best = { appId: app.canonicalId, distance, runnerUp: best.distance, runnerUpId: best.appId || null };
        } else if (distance < best.runnerUp) {
          best = { ...best, runnerUp: distance, runnerUpId: app.canonicalId };
        }
        const reverse = bestDesignForApp.get(app.canonicalId);
        if (!reverse || distance < reverse.distance) {
          bestDesignForApp.set(app.canonicalId, { designId: design.canonicalId, distance });
        }
      }
      if (best.appId) bestAppForDesign.set(design.canonicalId, best);
    }

    /** 两个候选是不是「同一块像素的另一个化身」（同侧同盒）。任一取不到就当不是 */
    const sameBoxTwins = (first?: CanonicalNode, second?: CanonicalNode): boolean =>
      !!first && !!second && isSameBox(first, second, CALIBRATION_TWIN_TOLERANCE);

    if (MATCH_TRACE) {
      // 只在调试时打：这一层的每一次「锁不上」都来自「最近的还不够近」或
      // 「次优的离得太近」—— 两者的修法完全相反，必须能分开看到。
      // ⚠️ 必须在双向表都填完之后再判 `mutual`：遍历途中另一侧的表还在被后续节点改写。
      for (const [designId, best] of bestAppForDesign) {
        if (!Number.isFinite(best.distance)) continue;
        console.log(
          '[L3c] design', designId,
          `best=${best.appId} d=${best.distance.toFixed(1)}`,
          `runnerUp=${Number.isFinite(best.runnerUp) ? best.runnerUp.toFixed(1) : '∞'}`,
          `mutual=${bestDesignForApp.get(best.appId)?.designId === designId}`,
          `ratio=${Number.isFinite(best.runnerUp) ? (best.runnerUp / Math.max(best.distance, 1e-6)).toFixed(2) : '∞'}`,
          `twin=${sameBoxTwins(appById.get(best.appId), best.runnerUpId ? appById.get(best.runnerUpId) : undefined)}`,
        );
      }
    }

    /**
     * 锁定顺序必须确定：距离近的先落，同距离按 id 字典序（与 L3a 的排序口径一致）。
     *
     * ⚠️ 门槛用**像素距离**与**倍数**，不用 0..1 的分数差。第一版拿 `localGeometryScore`
     * 的分数做「领先次优 ≥ 0.35」—— 分数挤在 0.85~1.0 之间，这个绝对值永远达不到，
     * 整层一条都锁不上（实测 `calibrated-position` 在来源分布里直接消失）。
     * 像素距离的量纲是「差多少 px」，配合倍数是可解释的。
     */
    const locks = [...bestAppForDesign.entries()]
      .filter(([designId, best]) =>
        (
          best.distance <= CALIBRATION_MAX_DISTANCE
          // 互为最近
          && bestDesignForApp.get(best.appId)?.designId === designId
          // 次优必须明显更远：附近挤着一排「都差不多」的时候不收，交给人工。
          // 但「与最优候选同盒的次优」不算竞争 —— 那是采集侧同一块像素派生的重复节点
          // （见 `CALIBRATION_TWIN_TOLERANCE`），拿它当竞争对手会把正确的配对也一起否掉。
          && (best.runnerUp === Number.POSITIVE_INFINITY
            || best.runnerUp >= best.distance * CALIBRATION_DISTANCE_MARGIN
            || sameBoxTwins(appById.get(best.appId), best.runnerUpId ? appById.get(best.runnerUpId) : undefined))
        ))
      .sort((a, b) => a[1].distance - b[1].distance
        || a[0].localeCompare(b[0]));

    for (const [designId, best] of locks) {
      // 距离 → 置信度：贴得越近越可信，但上限仍是 DIFFUSION_MAX_CONFIDENCE
      const proximity = clamp(1 - best.distance / Math.max(CALIBRATION_MAX_DISTANCE * 4, 1));
      const confidence = Math.min(
        DIFFUSION_MAX_CONFIDENCE,
        Math.max(DIFFUSION_MIN_CONFIDENCE, proximity),
      );
      // `applied` 里同一轮新锁的容器要接着下推 —— 这是本层与 L3b 的接口
      const locked = apply({
        designIds: [designId],
        appIds: [best.appId],
        confidence,
        origin: 'calibrated-position',
        // 几何推断，不是既成事实：与 L3a 投票同档，一律 ambiguous，必须有人过目
        status: 'ambiguous',
        relation: 'one_to_one',
      });
      if (locked) {
        enqueueContainer(designById.get(designId), appById.get(best.appId));
      }
    }
  };

  // 队列空 ≠ 收工：还要再给 L3c 一次机会（见循环体开头的分支）
  while (queue.length > 0 || !calibratedPassDone) {
    if (queue.length === 0) {
      calibratedPassDone = true;
      lockByCalibratedPosition();
      continue;
    }
    const current = queue.shift()!;
    const rows = groupChildren(current.designParent, designById, availableDesign);
    const columns = groupChildren(current.appParent, appById, availableApp);
    // 归宿表用：**进过分配矩阵**才算「被考虑过」。没进过的节点既没被匹配、也没被比较，
    // 它掉进 missing 说明的是「父容器没被锁定」（静默丢失），与「比过了但没配上」是
    // 两个完全不同的问题 —— 混在一起看永远查不出覆盖率低的真因。
    if (trace) {
      for (const group of rows) for (const node of group) trace.scopedDesign.add(node.canonicalId);
      for (const group of columns) for (const node of group) trace.scopedApp.add(node.canonicalId);
    }
    if (MATCH_TRACE) {
      console.log(
        '[L3b]',
        current.designParent.canonicalId,
        '<->',
        current.appParent.canonicalId,
        `rows=${rows.length}`,
        `cols=${columns.length}`,
        `chainLens=${rows.map((group) => group.length).join('/')}`,
      );
    }
    if (rows.length === 0 || columns.length === 0) continue;

    // 打分用**组尾**：壳在屏上不占独立像素，可比的是链尾那层内容。
    const tail = (group: CanonicalNode[]): CanonicalNode => group[group.length - 1]!;
    const matrix = rows.map((designGroup) => columns.map((appGroup) => {
      const design = tail(designGroup);
      const app = tail(appGroup);
      return localGeometryScore({
        design,
        app,
        designParent: current.designParent,
        designDocument,
        scale,
      }) * salienceAffinity(design.salience, app.salience);
    }));

    const created: Array<{ designId: string; appId: string }> = [];
    for (const assignment of maximizeAssignment(matrix)) {
      const designGroup = rows[assignment.row];
      const appGroup = columns[assignment.column];
      if (!designGroup || !appGroup) continue;
      // 组内每一层都要还可用：期间可能有别的容器把链上的某一层吃掉了
      if (!designGroup.every((node) => availableDesign(node.canonicalId))) continue;
      if (!appGroup.every((node) => availableApp(node.canonicalId))) continue;
      const score = matrix[assignment.row]?.[assignment.column] ?? 0;
      if (score < SIBLING_MIN_SCORE) continue;
      // Top-K 候选与 ruleScore **同源**（同一行打分矩阵），否则 AI 看到的候选与规则分数
      // 会对不上，「AI 推翻规则」这件事就说不清是发现还是噪声。
      const ranked = columns
        .map((group, column) => ({
          appNodeId: tail(group).canonicalId,
          score: matrix[assignment.row]?.[column] ?? 0,
        }))
        .sort((a, b) => b.score - a.score || a.appNodeId.localeCompare(b.appNodeId))
        .slice(0, TOP_K_CANDIDATES);
      const designIds = designGroup.map((node) => node.canonicalId);
      const appIds = appGroup.map((node) => node.canonicalId);
      // 状态按**分数与差距**判，不是一刀切 ambiguous。
      // 容器内的匈牙利分配有「几何 + 意义相容」两道门控，分数本身就度量了可信度：
      // 硬编码 ambiguous 会让 AUTO_MATCH_THRESHOLD / AUTO_MATCH_MARGIN 变成死代码，
      // 而且在「零缺陷对照物」这种两侧同构的场景下，正确配对的几何分是 1.0 ——
      // 那正是最该被自动确认的情形（实测：硬编码时 matched 恒等于文本锚点数 21，
      // 于是连「图标 / 图片类匹配」的视觉夹具都找不到样本）。
      // ⚠️ L3a 祖先投票**维持** ambiguous：那是「锚点扩散」，可信度来源不同。
      const runnerUpScore =
        ranked.find((entry) => entry.appNodeId !== appIds[appIds.length - 1]!)?.score ?? 0;
      const margin = score - runnerUpScore;
      const locked = apply({
        designIds,
        appIds,
        confidence: Math.min(DIFFUSION_MAX_CONFIDENCE, Math.max(DIFFUSION_MIN_CONFIDENCE, score)),
        origin: 'sibling',
        status: score >= AUTO_MATCH_THRESHOLD && margin >= AUTO_MATCH_MARGIN ? 'matched' : 'ambiguous',
        relation: relationOf(designIds.length, appIds.length),
        alternatives: ranked,
      });
      // 下推从**组尾**开始，不是组首。组首可能只是个壳，拿它重新 punchThrough 一遍，
      // 遇到「链尾是叶子」的回退（`punchThrough` 末行）会退回壳上，于是下推的第一站
      // 就是链中途那层已经配掉的节点 —— `available` 为 false，链当场断掉
      // （实测 `I83:53842;133:19610;106:60028 [graphic/ch=0] -> missing` 正是这么来的）。
      if (locked) {
        created.push({
          designId: designIds[designIds.length - 1]!,
          appId: appIds[appIds.length - 1]!,
        });
      }
    }

    if (MATCH_TRACE) {
      const taken = new Set(created.map((entry) => entry.designId));
      const leftover = rows
        .filter((group) => !taken.has(group[0]!.canonicalId))
        .map((group) => group.map((node) => node.canonicalId.replace(/^(design:|app:)/, '')).join('+'));
      if (leftover.length > 0) {
        console.log(
          '[L3b:leftover]',
          current.designParent.canonicalId.replace(/^(design:|app:)/, ''),
          JSON.stringify(leftover),
          `cols=${columns.map((g) => g.map((n) => n.canonicalId.replace(/^(design:|app:)/, '')).join('+')).join(',')}`,
        );
      }
    }

    for (const pair of created) {
      enqueueContainer(designById.get(pair.designId), appById.get(pair.appId));
    }
  }

  // ---- 收尾：没锁上的节点落成 missing / extra ----
  // ⚠️ 这里只负责**记账**；「哪些该被报成问题」由 evaluateAcceptance 按意义类别筛
  // （layout 既不判缺失也不判多余 —— 否则每页固定产出上百条噪声）。
  for (const node of designDocument.nodes) {
    if (ignoredDesign.has(node.canonicalId) || matchedDesign.has(node.canonicalId)) continue;
    matches.push({
      id: matchId([node.canonicalId], []),
      designNodeIds: [node.canonicalId],
      appNodeIds: [],
      relation: 'missing',
      source: 'rule',
      ruleScore: 0,
      confidence: node.participation === 'required' ? 0.95 : 0.7,
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

/** 诊断时每个设计根最多取几个 App 根做候选（矩阵可能很大，只留最有解释力的几行） */
const ROOT_SCORE_ROWS = 12;
const ROOT_SCORE_COLUMNS = 3;

export interface MatchDiagnosis {
  /**
   * 匹配引擎实际使用的阈值。
   *
   * ⚠️ v2（锚点优先）换掉了打分口径，这里必须同步 —— 否则导出包里的阈值是旧的，
   * 排查时会拿一套已经不生效的数字去解释结果（旧引擎留下的教训：诊断说 0.72、
   * 引擎说 0.3，整个排查过程就不可信了）。
   */
  thresholds: {
    /** @deprecated v1 的候选下限；v2 已不使用，仅保留给旧导出包对照 */
    match: number;
    /** 自动确认线：L3b 容器内分配的产物按「分数 + 次优差距」判 matched / ambiguous */
    autoMatch: number;
    /** 自动确认所需的「与次优的差距」 */
    autoMargin: number;
    topK: number;
    /** v2：文本锚点「两侧各自唯一」的置信度 */
    anchorText: number;
    /** v2：同父相邻文本拼接（切分粒度不同）的置信度 */
    anchorAggregate: number;
    /** v2：几何消歧门槛 */
    disambiguateGeometry: number;
    /** v2：祖先投票的单票门槛 / 锁定所需票数 / 锁定所需平均分 */
    voteScoreFloor: number;
    voteLockMinCount: number;
    voteLockMinScore: number;
    /** v2：兄弟分配门槛 */
    siblingMinScore: number;
    /** v2：扩散产物置信度上限（高于它只能是文本锚点） */
    diffusionMax: number;
  };
  designRootIds: string[];
  appRootIds: string[];
  /**
   * 根级候选打分，按分数降序、每个设计根最多 `ROOT_SCORE_COLUMNS` 条。
   * 每个设计根只给分数最高的几条，是因为「根都配不上」时真正的信息量在最高分是多少，
   * 而不在它和一堆零分候选的完整笛卡尔积。
   */
  rootScores: Array<{
    designNodeId: string;
    appNodeId: string;
    score: number;
    evidence: NodeMatch['evidence'];
  }>;
  participation: { design: Record<string, number>; app: Record<string, number> };
  kinds: { design: Record<string, number>; app: Record<string, number> };
  /**
   * 意义类别分布 —— v2 排错的第一站。
   *
   * 「匹配还是很少」最常见的两个原因直接体现在这里：一侧 `layout` 占比过高
   * （判据没生效，锚点的祖先链一步跳到根），或者 `text` 数量远低于预期（文本没采到）。
   */
  salience: { design: Record<string, number>; app: Record<string, number> };
  /**
   * **归宿表**：两侧节点最终去了哪里。这是「覆盖率」的正确口径。
   *
   * 之前只报「匹配对数 / 两侧节点并集」—— 那个比值既说不清漏了多少，也说不清错配了
   * 多少（同一份数据里，错配和漏配会互相抵消成同一个难看的小数）。按 App 侧
   * `required` 节点算归属，才回答得了「这次验收到底审了多少东西」。
   */
  resolve: { design: ResolveTable; app: ResolveTable };
}

/**
 * 一侧节点的归宿分布。
 *
 * ⚠️ `outOfScope` 是最该先看的一格：它表示这个节点**从没进过任何分配矩阵** ——
 * 不是「比过了没配上」，而是「父容器没被锁定，它压根没被考虑」。覆盖率低时先看这一格：
 * 它高说明问题在**扩散链断了**（容器没锁上），而不是打分太严、阈值太高。
 * 这两种病因的修法完全不同，混在一起看永远查不出来。
 */
export interface ResolveTable {
  total: number;
  ignored: number;
  matched: number;
  ambiguous: number;
  missing: number;
  extra: number;
  /** 未匹配且从未进过分配矩阵 —— 静默丢失 */
  outOfScope: number;
  /**
   * 非 `required`、非 `ignored` 的那一档（context / optional / unavailable）。
   *
   * 和 `required` 是一组对称的分法：`ignored` 不参与、`required` 必须交代、
   * 剩下的归这里。三档相加恒等于 `total` —— 少了一档就说明有节点哪儿都没算进去。
   */
  contextual: number;
  /** 只看 `required` 档：这才是「必须交代」的那一部分 */
  required: {
    total: number;
    matched: number;
    ambiguous: number;
    unresolved: number;
    /** `unresolved` 里「从没进过分配矩阵」的那部分 —— 覆盖率低的头号嫌疑 */
    outOfScope: number;
  };
}

function countBy<T>(items: T[], pick: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * 匹配诊断：回答「为什么一条都没配上」。
 *
 * 存在的理由是一个很难自查的失败模式：`matchDocuments` **只从根节点开始逐层递归**
 * （见 `visit` 的调用点），所以根级一旦配不上，整棵子树都会退化成 missing / extra，
 * 最终在界面上只表现为「匹配 0」—— 而报告里没有任何字段能说明是哪一层断的。
 * 这个函数把断点直接摆出来：两侧的根 id、根之间的完整打分、参与度与类型分布。
 *
 * 它**不参与裁决**，只被调试导出调用。放在 core 里而不是调用方，是为了让诊断用的
 * 分数与引擎用的分数共用同一个 `scorePair` —— 否则两套分数迟早分叉，
 * 「诊断说 0.72、引擎说 0.3」这种事一旦发生，整个排查过程就不可信了。
 */
export function diagnoseMatching(
  designDocument: CanonicalDocument,
  appDocument: CanonicalDocument,
  matches?: NodeMatch[],
  trace?: MatchTrace,
): MatchDiagnosis {
  const designById = canonicalMap(designDocument);
  const appById = canonicalMap(appDocument);

  // 归宿表要跑一遍引擎。调用方（debugExport / probe）通常**已经**跑过，把结果与 trace
  // 传进来就不必再跑 —— 这个引擎在 600 节点上不便宜，诊断不该让它翻倍。
  const effectiveMatches =
    matches ?? matchDocuments(designDocument, appDocument, undefined, trace);
  const designStatus = new Map<string, NodeMatch['status']>();
  const appStatus = new Map<string, NodeMatch['status']>();
  for (const match of effectiveMatches) {
    for (const id of match.designNodeIds) designStatus.set(id, match.status);
    for (const id of match.appNodeIds) appStatus.set(id, match.status);
  }

  const buildResolve = (
    nodes: CanonicalNode[],
    status: Map<string, NodeMatch['status']>,
    scoped: ReadonlySet<string>,
  ): ResolveTable => {
    const table: ResolveTable = {
      total: nodes.length,
      required: { total: 0, matched: 0, ambiguous: 0, unresolved: 0, outOfScope: 0 },
      contextual: 0,
      ignored: 0,
      matched: 0,
      ambiguous: 0,
      missing: 0,
      extra: 0,
      outOfScope: 0,
    };
    for (const node of nodes) {
      const id = node.canonicalId;
      const state = status.get(id);
      const isMatched = state === 'matched';
      const isAmbiguous = state === 'ambiguous';
      if (isMatched) table.matched += 1;
      else if (isAmbiguous) table.ambiguous += 1;
      else if (state === 'missing') table.missing += 1;
      else if (state === 'extra') table.extra += 1;

      // 「静默丢失」= 没配上、且从没进过任何分配矩阵。
      const silent = !isMatched && !isAmbiguous && !scoped.has(id);
      if (silent) table.outOfScope += 1;

      if (node.participation === 'ignored') {
        table.ignored += 1;
      } else if (node.participation === 'required') {
        table.required.total += 1;
        if (isMatched) table.required.matched += 1;
        else if (isAmbiguous) table.required.ambiguous += 1;
        else {
          table.required.unresolved += 1;
          if (silent) table.required.outOfScope += 1;
        }
      } else {
        table.contextual += 1;
      }
    }
    return table;
  };

  const emptyScope: ReadonlySet<string> = new Set<string>();

  const rootScores: MatchDiagnosis['rootScores'] = [];
  for (const designId of designDocument.rootIds.slice(0, ROOT_SCORE_ROWS)) {
    const designNode = designById.get(designId);
    if (!designNode) continue;
    const row = appDocument.rootIds
      .flatMap((appId) => {
        const appNode = appById.get(appId);
        if (!appNode) return [];
        const scored = scorePair(designNode, appNode, designDocument, appDocument);
        return [
          {
            designNodeId: designId,
            appNodeId: appId,
            score: scored.score,
            evidence: scored.evidence,
          },
        ];
      })
      .sort((a, b) => b.score - a.score || a.appNodeId.localeCompare(b.appNodeId))
      .slice(0, ROOT_SCORE_COLUMNS);
    rootScores.push(...row);
  }

  return {
    thresholds: {
      match: MATCH_THRESHOLD,
      autoMatch: AUTO_MATCH_THRESHOLD,
      autoMargin: AUTO_MATCH_MARGIN,
      topK: TOP_K_CANDIDATES,
      anchorText: ANCHOR_UNIQUE_BASE,
      anchorAggregate: ANCHOR_AGGREGATE_BASE,
      disambiguateGeometry: DISAMBIGUATE_GEOMETRY_FLOOR,
      voteScoreFloor: VOTE_SCORE_FLOOR,
      voteLockMinCount: VOTE_LOCK_MIN_COUNT,
      voteLockMinScore: VOTE_LOCK_MIN_SCORE,
      siblingMinScore: SIBLING_MIN_SCORE,
      diffusionMax: DIFFUSION_MAX_CONFIDENCE,
    },
    designRootIds: [...designDocument.rootIds],
    appRootIds: [...appDocument.rootIds],
    rootScores,
    participation: {
      design: countBy(designDocument.nodes, (node) => node.participation),
      app: countBy(appDocument.nodes, (node) => node.participation),
    },
    kinds: {
      design: countBy(designDocument.nodes, (node) => node.kind),
      app: countBy(appDocument.nodes, (node) => node.kind),
    },
    salience: {
      design: countBy(designDocument.nodes, (node) => node.salience),
      app: countBy(appDocument.nodes, (node) => node.salience),
    },
    resolve: {
      design: buildResolve(designDocument.nodes, designStatus, trace?.scopedDesign ?? emptyScope),
      app: buildResolve(appDocument.nodes, appStatus, trace?.scopedApp ?? emptyScope),
    },
  };
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

/**
 * 匹配结果的**分档计数**（`matched` / `ambiguous` / `missing` / `extra` …）。
 *
 * 提出来共用是因为它必须与验收报告的 `summary` 同口径：两个导出包（配对调试包 /
 * 标注包）都靠这个数与报告对账，「导出说 12 条 missing、报告说 15 条」这种偏差
 * 会把人引向一个根本不存在的 bug。计数逻辑只有一份就不会有这个问题。
 *
 * ⚠️ 按 `status` 计数，**不是**按 `relation`：v2 引擎里 `relation` 描述的是集合形状，
 * 而 `status` 才是裁决结果，报告用的也是后者。
 */
export function countMatchStatuses(matches: readonly NodeMatch[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of matches) {
    counts[match.status] = (counts[match.status] ?? 0) + 1;
  }
  return counts;
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
  const pixelTransform = input.app.pixelWidth
    ? createPixelTransformContract({
      basisWidth: input.design.width,
      viewportWidth: input.app.width,
      pixelWidth: input.app.pixelWidth,
    })
    : null;
  const issues: AcceptanceIssue[] = [];
  let unknownCount = 0;

  for (const match of input.matches) {
    const designNode = match.designNodeIds[0] ? designById.get(match.designNodeIds[0]) : undefined;
    const appNode = match.appNodeIds[0] ? appById.get(match.appNodeIds[0]) : undefined;
    if (match.status === 'missing') {
      // 只有 `required` 允许被判缺失 —— 这是 SDK 与归一化阶段共同的约定
      // （见 `CollectPolicy.participationOf` 与 `designParticipation`）。
      // ⚠️ 曾经写的是「不等于 context 就算」，那会让 `ignored` / `optional` 也落进来：
      // 设计稿侧被降级的脏节点（零尺寸 / 画板外，实测 146 个）会立刻变成上百条假 P1。
      if (designNode?.participation === 'required' && profile.requiredChecks.includes('presence')) {
        issues.push(issue('presence', 'structure', 'P1', match, 'present', 'missing', null, match.confidence, ['DESIGN_NODE_MISSING']));
      }
      continue;
    }
    if (match.status === 'extra') {
      // 同理，只有 App 侧 `required` 的节点才算「多出来的东西」。
      // 透明壳（layout）/ 隐藏（optional）/ 未附着（unavailable）都不参与 ——
      // 它们不构成「页面上多了一块」，只会把噪声堆到几百条。
      if (appNode?.participation === 'required') {
        issues.push(issue('extra-node', 'structure', 'P2', match, 'not-present', 'extra', null, match.confidence, ['APP_NODE_EXTRA']));
      }
      continue;
    }
    if (!designNode || !appNode) continue;

    if (match.status === 'ambiguous') {
      // 纯布局容器即便配上了也不该报「待确认」：那条提示的全部意义是「这对可能配错了，
      // 请看一眼」，而 layout 既不参与缺失也不参与多余，配错与否不影响任何结论。
      if (designNode.participation === 'required') {
        unknownCount += 1;
        issues.push(issue('mapping', 'structure', 'P2', match, 'unique-match', 'ambiguous', null, match.confidence, ['LOW_MATCH_CONFIDENCE']));
      }
    }

    if (profile.requiredChecks.includes('geometry')) {
      if (!pixelTransform || !appNode.pixelRect) {
        unknownCount += 1;
        issues.push(issue(
          'geometry',
          'process',
          'P2',
          match,
          { unit: 'app-pixel', transform: 'available' },
          { unit: appNode.pixelRect ? 'app-pixel' : 'logical', transform: pixelTransform ? 'available' : 'missing' },
          null,
          match.confidence,
          ['PIXEL_GEOMETRY_UNAVAILABLE'],
        ));
      } else {
        const expected = projectDesignRectToAppPixels(designNode.rect, pixelTransform);
        const actual = appNode.pixelRect;
        const expectedEdges = {
          left: expected.x,
          top: expected.y,
          right: expected.x + expected.width,
          bottom: expected.y + expected.height,
        };
        const actualEdges = {
          left: actual.x,
          top: actual.y,
          right: actual.x + actual.width,
          bottom: actual.y + actual.height,
        };
        const delta = {
          left: actualEdges.left - expectedEdges.left,
          top: actualEdges.top - expectedEdges.top,
          right: actualEdges.right - expectedEdges.right,
          bottom: actualEdges.bottom - expectedEdges.bottom,
          width: actual.width - expected.width,
          height: actual.height - expected.height,
        };
        const beyondViewport = expected.height > (input.app.pixelHeight ?? 0);
        const hasEdgeMismatch = delta.left !== 0 || delta.top !== 0 || delta.right !== 0 || delta.bottom !== 0;
        const hasSizeMismatch = delta.width !== 0 || (delta.height !== 0 && !beyondViewport);
        if (hasEdgeMismatch || hasSizeMismatch) {
          issues.push(issue(
            'geometry',
            'layout',
            'P1',
            match,
            { unit: 'app-pixel', edges: expectedEdges, width: expected.width, height: expected.height },
            { unit: 'app-pixel', edges: actualEdges, width: actual.width, height: actual.height },
            delta,
            match.confidence,
            ['GEOMETRY_PIXEL_MISMATCH'],
          ));
        } else if (beyondViewport && delta.height !== 0) {
          issues.push(issue(
            'geometry',
            'layout',
            'P2',
            match,
            { unit: 'app-pixel', height: '<=app-viewport' },
            { unit: 'app-pixel', height: actual.height },
            delta,
            match.confidence,
            ['GEOMETRY_BEYOND_APP_VIEWPORT'],
          ));
        }
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
    ...(pixelTransform ? { pixelTransform } : {}),
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
    ...(input.ai ? { ai: input.ai } : {}),
    readinessReasons: blockingReasons,
  };
}
