import type {
  Rect,
  SchemaEffect,
  SchemaLayout,
  SchemaNode,
  SchemaPaint,
  SchemaText,
  FrameSchema,
} from '../shared/types';

export const SCHEMA_VERSION = '1.0.0';

/** 把 figma RGB(A) 转成 #RRGGBB / #RRGGBBAA */
export function toHex(color: RGB | RGBA, alpha?: number): string {
  const r = Math.round((color.r ?? 0) * 255);
  const g = Math.round((color.g ?? 0) * 255);
  const b = Math.round((color.b ?? 0) * 255);
  const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const a = alpha ?? ('a' in color ? (color as RGBA).a : 1);
  if (a === undefined || a >= 1) return hex;
  const av = Math.round(a * 255);
  return `${hex}${av.toString(16).padStart(2, '0')}`;
}

/** figma.mixed 是一个 unique symbol，typeof 判断为 'symbol' */
function isMixed(value: unknown): boolean {
  return typeof value === 'symbol';
}

function round(n: number, digits = 2): number {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function simplifyPaint(paint: Paint, includeImageFills: boolean): SchemaPaint | null {
  if (paint.type === 'SOLID') {
    return {
      type: 'SOLID',
      visible: paint.visible !== false,
      opacity: paint.opacity === undefined ? 1 : round(paint.opacity, 3),
      color: toHex(paint.color, paint.opacity),
      blendMode: (paint as any).blendMode,
    };
  }

  if (paint.type.startsWith('GRADIENT')) {
    const g = paint as GradientPaint;
    // 通过 gradientTransform 估算渐变角度，验收对比够用
    const t = (g as any).gradientTransform as Transform | undefined;
    let angle: number | undefined;
    if (t && Array.isArray(t) && t.length === 2) {
      const [[a], [c]] = t as [[number, number, number], [number, number, number]];
      angle = round(((Math.atan2(c, a) * 180) / Math.PI + 360) % 360, 1);
    }
    return {
      type: paint.type,
      visible: paint.visible !== false,
      opacity: paint.opacity === undefined ? 1 : round(paint.opacity, 3),
      gradientStops: (g.gradientStops || []).map((s) => ({
        color: toHex(s.color, s.color.a),
        position: round(s.position, 3),
      })),
      gradientAngle: angle,
      blendMode: (paint as any).blendMode,
    };
  }

  if (paint.type === 'IMAGE') {
    const img = paint as ImagePaint;
    return {
      type: 'IMAGE',
      visible: paint.visible !== false,
      opacity: paint.opacity === undefined ? 1 : round(paint.opacity, 3),
      imageHash: includeImageFills ? (img.imageHash ?? undefined) : undefined,
      scaleMode: img.scaleMode,
      blendMode: (paint as any).blendMode,
    };
  }

  return null;
}

function readPaints(node: SceneNode, key: 'fills' | 'strokes', includeImageFills: boolean): SchemaPaint[] | undefined {
  const raw = (node as any)[key];
  if (!raw) return undefined;
  if (isMixed(raw)) return undefined;
  const list: readonly Paint[] = Array.isArray(raw) ? raw : [raw];
  const result: SchemaPaint[] = [];
  for (const p of list) {
    const simplified = simplifyPaint(p, includeImageFills);
    if (simplified) result.push(simplified);
  }
  // Preserve a collected empty channel; omitted channels remain unknown to inspection.
  return list.length === 0 ? [] : result.length ? result : undefined;
}

function readEffects(node: SceneNode): SchemaEffect[] | undefined {
  const raw = (node as any).effects;
  if (!raw || isMixed(raw) || !Array.isArray(raw)) return undefined;
  const out: SchemaEffect[] = [];
  for (const e of raw as Effect[]) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      out.push({
        type: e.type,
        visible: e.visible !== false,
        color: toHex(e.color, e.color.a),
        offset: { x: round(e.offset.x), y: round(e.offset.y) },
        radius: round(e.radius),
        spread: 'spread' in e ? round((e as any).spread) : undefined,
      });
    } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
      out.push({ type: e.type, visible: e.visible !== false, radius: round(e.radius) });
    }
  }
  return raw.length === 0 ? [] : out.length ? out : undefined;
}

function readCornerRadius(node: SceneNode): number | number[] | undefined {
  const n = node as any;
  if (typeof n.cornerRadius === 'number') return round(n.cornerRadius);
  const corners = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
  if (corners.every((c) => typeof c === 'number')) {
    const [tl, tr, br, bl] = corners.map((c) => round(c));
    if (tl === tr && tr === br && br === bl) return tl;
    return [tl, tr, br, bl];
  }
  return undefined;
}

function readText(node: TextNode): SchemaText {
  const info: SchemaText = { characters: node.characters };

  const read = <T>(value: T | PluginAPI['mixed']): T | undefined => (isMixed(value) ? undefined : (value as T));

  const fontName = read<FontName>(node.fontName);
  if (fontName) {
    info.fontFamily = fontName.family;
    info.fontStyle = fontName.style;
  }
  const fontSize = read<number>(node.fontSize);
  if (typeof fontSize === 'number') info.fontSize = round(fontSize);

  const lineHeight = read<LineHeight>(node.lineHeight);
  if (lineHeight && typeof lineHeight === 'object') {
    if (lineHeight.unit === 'AUTO') {
      info.lineHeight = 'AUTO';
    } else if (lineHeight.unit === 'PERCENT') {
      info.lineHeight = `${round(lineHeight.value)}%`;
    } else {
      info.lineHeight = round(lineHeight.value);
    }
  }

  const letterSpacing = read<LetterSpacing>(node.letterSpacing);
  if (letterSpacing && typeof letterSpacing === 'object') {
    info.letterSpacing =
      letterSpacing.unit === 'PERCENT' ? `${round(letterSpacing.value, 3)}%` : round(letterSpacing.value, 3);
  }

  info.textAlignHorizontal = read<string>(node.textAlignHorizontal);
  info.textAlignVertical = read<string>(node.textAlignVertical);
  info.textDecoration = read<string>(node.textDecoration);
  info.textCase = read<string>(node.textCase);
  info.textAutoResize = read<string>(node.textAutoResize);
  info.lineCount = node.characters ? node.characters.split('\n').length : 0;

  const fills = readPaints(node, 'fills', false);
  const solid = fills?.find((f) => f.type === 'SOLID');
  if (solid?.color) info.color = solid.color;

  return info;
}

function readLayout(node: SceneNode): SchemaLayout | undefined {
  const n = node as any;
  if (typeof n.layoutMode !== 'string') return undefined;
  return {
    mode: n.layoutMode,
    direction: n.layoutMode === 'NONE' ? undefined : n.layoutMode,
    gap: typeof n.itemSpacing === 'number' ? round(n.itemSpacing) : undefined,
    counterAxisGap: typeof n.counterAxisSpacing === 'number' ? round(n.counterAxisSpacing) : undefined,
    padding: {
      top: round(n.paddingTop ?? 0),
      right: round(n.paddingRight ?? 0),
      bottom: round(n.paddingBottom ?? 0),
      left: round(n.paddingLeft ?? 0),
    },
    alignItems: n.counterAxisAlignItems,
    justifyContent: n.primaryAxisAlignItems,
    wrap: n.layoutWrap,
    clipsContent: n.clipsContent,
  };
}

function readComponent(node: SceneNode): SchemaNode['component'] {
  if (node.type === 'COMPONENT') {
    return { kind: 'COMPONENT' };
  }
  if (node.type === 'COMPONENT_SET') {
    return { kind: 'COMPONENT_SET' };
  }
  if (node.type === 'INSTANCE') {
    let mainComponentId: string | undefined;
    let mainComponentName: string | undefined;
    try {
      const main = (node as InstanceNode).mainComponent;
      if (main) {
        mainComponentId = main.id;
        mainComponentName = main.name;
      }
    } catch {
      /* 远端组件可能取不到，忽略 */
    }
    return { kind: 'INSTANCE', mainComponentId, mainComponentName };
  }
  return undefined;
}

export interface SerializeOptions {
  includeHidden: boolean;
  includeImageFills: boolean;
}

interface SerializeContext extends SerializeOptions {
  originX: number;
  originY: number;
  count: { total: number; skipped: number };
}

/** 判断节点是否"有像素"：Figma 只对有填充/描边的区域做点击命中 */
function hasVisiblePaint(paints: SchemaPaint[] | undefined): boolean {
  return !!paints && paints.some((p) => p.visible !== false && (p.opacity ?? 1) > 0);
}

/** rect 是否被完整包含在裁剪区内（0.5px 容差） */
function insideRect(outer: Rect, inner: Rect): boolean {
  const t = 0.5;
  return (
    inner.x >= outer.x - t &&
    inner.y >= outer.y - t &&
    inner.x + inner.width <= outer.x + outer.width + t &&
    inner.y + inner.height <= outer.y + outer.height + t
  );
}

function intersectRect(a: Rect, b: Rect | null): Rect {
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function buildNode(
  node: SceneNode,
  parentPath: string,
  depth: number,
  ctx: SerializeContext,
  index = 0,
  clip: Rect | null = null,
): SchemaNode | null {
  // 隐藏节点默认跳过（验收时线上也渲染不出来）
  if (!ctx.includeHidden && node.visible === false) {
    ctx.count.skipped += 1;
    return null;
  }

  const path = parentPath ? `${parentPath}/${node.name}` : node.name;
  const abs = node.absoluteBoundingBox;

  let rect: Rect;
  let rectEstimated = false;
  if (abs) {
    rect = {
      x: round(abs.x - ctx.originX),
      y: round(abs.y - ctx.originY),
      width: round(abs.width),
      height: round(abs.height),
    };
  } else {
    rectEstimated = true;
    rect = {
      x: 0,
      y: 0,
      width: round((node as any).width ?? 0),
      height: round((node as any).height ?? 0),
    };
  }

  const out: SchemaNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    path,
    depth,
    index,
    visible: node.visible !== false,
    rect,
    rectEstimated: rectEstimated || undefined,
  };

  for (const key of ['layoutSizingHorizontal', 'layoutSizingVertical'] as const) {
    const sizing = (node as SceneNode & { layoutSizingHorizontal?: string; layoutSizingVertical?: string })[key];
    if (sizing === 'FIXED' || sizing === 'HUG' || sizing === 'FILL') out[key] = sizing;
  }

  out.absRect = abs
    ? { x: round(abs.x), y: round(abs.y), width: round(abs.width), height: round(abs.height) }
    : undefined;

  if (typeof (node as any).locked === 'boolean') out.locked = (node as any).locked;
  if (typeof (node as any).opacity === 'number' && (node as any).opacity < 1) out.opacity = round((node as any).opacity, 3);
  if (typeof (node as any).rotation === 'number' && (node as any).rotation !== 0) out.rotation = round((node as any).rotation, 2);
  if (typeof (node as any).blendMode === 'string' && (node as any).blendMode !== 'NORMAL') out.blendMode = (node as any).blendMode;

  const radius = readCornerRadius(node);
  if (radius !== undefined) out.cornerRadius = radius;

  const fills = readPaints(node, 'fills', ctx.includeImageFills);
  if (fills) out.fills = fills;

  const strokes = readPaints(node, 'strokes', ctx.includeImageFills);
  if (strokes) out.strokes = strokes;

  out.hasFill = hasVisiblePaint(fills) || hasVisiblePaint(strokes);
  // 被 clipsContent 祖先裁掉的部分，在 Figma 里既看不见也点不中
  if (clip && !insideRect(clip, rect)) out.clipped = true;

  if (typeof (node as any).strokeWeight === 'number') out.strokeWeight = round((node as any).strokeWeight);
  if (typeof (node as any).strokeAlign === 'string') out.strokeAlign = (node as any).strokeAlign;

  const effects = readEffects(node);
  if (effects) out.effects = effects;

  if (node.type === 'TEXT') out.text = readText(node);

  const layout = readLayout(node);
  if (layout) out.layout = layout;

  const constraints = (node as any).constraints;
  if (constraints) out.constraints = { horizontal: constraints.horizontal, vertical: constraints.vertical };

  const component = readComponent(node);
  if (component) out.component = component;

  ctx.count.total += 1;

  // 子节点继承裁剪区：本节点开了 clipsContent 就与自身矩形求交
  const childClip = (node as any).clipsContent === true ? intersectRect(rect, clip) : clip;

  // 子树全量展开：验收要的是与线上一致的完整层级，裁剪过的树会让「少一个节点」
  // 无法与「设计稿本来就没有」区分开，所以这里不做任何深度限制。
  if ('children' in node) {
    const children: SchemaNode[] = [];
    const list = (node as ChildrenMixin).children;
    for (let i = 0; i < list.length; i++) {
      const built = buildNode(list[i], path, depth + 1, ctx, i, childClip);
      if (built) children.push(built);
    }
    if (children.length) out.children = children;
  }

  return out;
}

/**
 * 节点在所属页面内的层级路径（不含 PAGE 自身），如 "首页/Header/标题"。
 * 元素级导出时用它在 UI 与 manifest 里消歧同名节点。
 */
export function nodePath(node: BaseNode): string {
  const parts: string[] = [];
  let cur: BaseNode | null = node;
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join('/');
}

export interface SerializeResult {
  schema: FrameSchema;
  nodeCount: number;
  skipped: number;
}

export function serializeFrame(
  frame: SceneNode,
  pageId: string,
  pageName: string,
  exportScale: number,
  screenshotPath: string,
  options: SerializeOptions,
): SerializeResult {
  const abs = frame.absoluteBoundingBox;
  const originX = abs ? abs.x : 0;
  const originY = abs ? abs.y : 0;

  const ctx: SerializeContext = {
    ...options,
    originX,
    originY,
    count: { total: 0, skipped: 0 },
  };

  const tree = buildNode(frame, '', 0, ctx);

  const backgroundColor = (() => {
    const fills = readPaints(frame, 'fills', false);
    const solid = fills?.find((f) => f.type === 'SOLID');
    return solid?.color;
  })();

  const schema: FrameSchema = {
    schemaVersion: SCHEMA_VERSION,
    frameId: frame.id,
    frameName: frame.name,
    pageId,
    pageName,
    width: round((frame as any).width ?? 0),
    height: round((frame as any).height ?? 0),
    designUnit: 'figma',
    exportScale,
    screenshot: screenshotPath,
    backgroundColor,
    nodeCount: ctx.count.total,
    exportedAt: new Date().toISOString(),
    tree: tree as SchemaNode,
    rootType: frame.type,
    rootPath: tree?.path ?? nodePath(frame),
  };

  return { schema, nodeCount: ctx.count.total, skipped: ctx.count.skipped };
}
