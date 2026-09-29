import type {
  UiAcceptanceNode,
  UiAcceptanceSnapshot,
} from '../../uiAcceptanceModule';

export interface UiAcceptanceRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface UiAcceptanceRenderableNode {
  node: UiAcceptanceNode;
  rect: UiAcceptanceRect;
}

export interface UiAcceptancePoint {
  x: number;
  y: number;
}

export interface UiAcceptanceDistanceAxis {
  gap: number;
  start: UiAcceptancePoint;
  end: UiAcceptancePoint;
}

export interface UiAcceptanceNodeDistance {
  horizontalGap: number;
  verticalGap: number;
  edgeDistance: number;
  relation: 'overlap' | 'separate';
  horizontal: UiAcceptanceDistanceAxis | null;
  vertical: UiAcceptanceDistanceAxis | null;
}

export const getUiAcceptanceNodeRect = (node: UiAcceptanceNode): UiAcceptanceRect | null => {
  const hasNativeVisibleRect =
    node.visibleX !== undefined ||
    node.visibleY !== undefined ||
    node.visibleWidth !== undefined ||
    node.visibleHeight !== undefined;

  if (hasNativeVisibleRect) {
    if (
      node.visibleX === null ||
      node.visibleY === null ||
      node.visibleWidth === null ||
      node.visibleHeight === null ||
      node.visibleX === undefined ||
      node.visibleY === undefined ||
      node.visibleWidth === undefined ||
      node.visibleHeight === undefined ||
      node.visibleWidth <= 0 ||
      node.visibleHeight <= 0
    ) {
      return null;
    }

    return {
      left: node.visibleX,
      top: node.visibleY,
      right: node.visibleX + node.visibleWidth,
      bottom: node.visibleY + node.visibleHeight,
    };
  }

  if (node.width <= 0 || node.height <= 0) {
    return null;
  }

  return {
    left: node.x,
    top: node.y,
    right: node.x + node.width,
    bottom: node.y + node.height,
  };
};

export const intersectUiAcceptanceRects = (
  first: UiAcceptanceRect,
  second: UiAcceptanceRect
): UiAcceptanceRect | null => {
  const rect = {
    left: Math.max(first.left, second.left),
    top: Math.max(first.top, second.top),
    right: Math.min(first.right, second.right),
    bottom: Math.min(first.bottom, second.bottom),
  };

  return rect.right > rect.left && rect.bottom > rect.top ? rect : null;
};

export const getUiAcceptanceVisibleRect = (
  node: UiAcceptanceNode,
  nodesById: Map<string, UiAcceptanceNode>,
  windowRect: UiAcceptanceRect
): UiAcceptanceRect | null => {
  if (!node.visible || node.hiddenByAncestor === true) {
    return null;
  }

  let rect = getUiAcceptanceNodeRect(node);
  if (!rect) {
    return null;
  }

  rect = intersectUiAcceptanceRects(rect, windowRect);
  let parent = node.parentId ? nodesById.get(node.parentId) : undefined;
  const visitedParentIds = new Set<string>();

  while (rect && parent) {
    if (visitedParentIds.has(parent.nodeId)) {
      return null;
    }
    visitedParentIds.add(parent.nodeId);

    if (!parent.visible || parent.hiddenByAncestor === true) {
      return null;
    }

    if (parent.clipsToBounds) {
      const parentRect = getUiAcceptanceNodeRect(parent);
      rect = parentRect ? intersectUiAcceptanceRects(rect, parentRect) : null;
    }

    parent = parent.parentId ? nodesById.get(parent.parentId) : undefined;
  }

  return rect;
};

const subtractUiAcceptanceIntervals = (
  start: number,
  end: number,
  coveredIntervals: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> => {
  if (end <= start) {
    return [];
  }

  const intervals = coveredIntervals
    .map((interval) => ({
      start: Math.max(start, interval.start),
      end: Math.min(end, interval.end),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((first, second) => first.start - second.start);

  const result: Array<{ start: number; end: number }> = [];
  let cursor = start;

  for (const interval of intervals) {
    if (interval.start > cursor) {
      result.push({ start: cursor, end: interval.start });
    }

    cursor = Math.max(cursor, interval.end);
    if (cursor >= end) {
      return result;
    }
  }

  if (cursor < end) {
    result.push({ start: cursor, end });
  }

  return result;
};

const getUiAcceptanceHorizontalEdgeSegments = (
  edge: UiAcceptanceRect,
  occluders: UiAcceptanceRect[]
): UiAcceptanceRect[] => {
  const coveredIntervals = occluders
    .filter((occluder) => occluder.bottom > edge.top && occluder.top < edge.bottom)
    .map((occluder) => ({ start: occluder.left, end: occluder.right }));

  return subtractUiAcceptanceIntervals(edge.left, edge.right, coveredIntervals).map((interval) => ({
    left: interval.start,
    top: edge.top,
    right: interval.end,
    bottom: edge.bottom,
  }));
};

const getUiAcceptanceVerticalEdgeSegments = (
  edge: UiAcceptanceRect,
  occluders: UiAcceptanceRect[]
): UiAcceptanceRect[] => {
  const coveredIntervals = occluders
    .filter((occluder) => occluder.right > edge.left && occluder.left < edge.right)
    .map((occluder) => ({ start: occluder.top, end: occluder.bottom }));

  return subtractUiAcceptanceIntervals(edge.top, edge.bottom, coveredIntervals).map((interval) => ({
    left: edge.left,
    top: interval.start,
    right: edge.right,
    bottom: interval.end,
  }));
};

export const getUiAcceptanceBorderSegments = (
  rect: UiAcceptanceRect,
  occluders: UiAcceptanceRect[],
  borderSize: number
): UiAcceptanceRect[] => {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) {
    return [];
  }

  const thickness = Math.min(borderSize, width, height);
  const topEdge: UiAcceptanceRect = {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.top + thickness,
  };
  const bottomEdge: UiAcceptanceRect = {
    left: rect.left,
    top: rect.bottom - thickness,
    right: rect.right,
    bottom: rect.bottom,
  };
  const leftEdge: UiAcceptanceRect = {
    left: rect.left,
    top: rect.top + thickness,
    right: rect.left + thickness,
    bottom: rect.bottom - thickness,
  };
  const rightEdge: UiAcceptanceRect = {
    left: rect.right - thickness,
    top: rect.top + thickness,
    right: rect.right,
    bottom: rect.bottom - thickness,
  };

  return [
    ...getUiAcceptanceHorizontalEdgeSegments(topEdge, occluders),
    ...getUiAcceptanceHorizontalEdgeSegments(bottomEdge, occluders),
    ...getUiAcceptanceVerticalEdgeSegments(leftEdge, occluders),
    ...getUiAcceptanceVerticalEdgeSegments(rightEdge, occluders),
  ];
};

const getUiAcceptancePaintOrderedNodes = (nodes: UiAcceptanceNode[]): UiAcceptanceNode[] => {
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenByParentId = new Map<string, UiAcceptanceNode[]>();
  const roots: UiAcceptanceNode[] = [];

  for (const node of nodes) {
    if (node.parentId && nodesById.has(node.parentId)) {
      const children = childrenByParentId.get(node.parentId) ?? [];
      children.push(node);
      childrenByParentId.set(node.parentId, children);
    } else {
      roots.push(node);
    }
  }

  const compareSiblings = (first: UiAcceptanceNode, second: UiAcceptanceNode): number => {
    const zDifference = (first.z ?? 0) - (second.z ?? 0);
    if (zDifference !== 0) {
      return zDifference;
    }

    const elevationDifference = (first.elevation ?? 0) - (second.elevation ?? 0);
    if (elevationDifference !== 0) {
      return elevationDifference;
    }

    return first.index - second.index;
  };

  const orderedNodes: UiAcceptanceNode[] = [];
  const visited = new Set<string>();
  const visit = (node: UiAcceptanceNode): void => {
    if (visited.has(node.nodeId)) {
      return;
    }

    visited.add(node.nodeId);
    orderedNodes.push(node);
    const children = childrenByParentId.get(node.nodeId) ?? [];
    children.sort(compareSiblings);
    children.forEach(visit);
  };

  roots.sort(compareSiblings);
  roots.forEach(visit);
  nodes.forEach((node) => visit(node));

  return orderedNodes;
};

export const getUiAcceptanceDrawableNodes = (
  snapshot: UiAcceptanceSnapshot
): UiAcceptanceRenderableNode[] => {
  if (snapshot.windowWidth <= 0 || snapshot.windowHeight <= 0) {
    return [];
  }

  const nodesById = new Map(snapshot.nodes.map((node) => [node.nodeId, node]));
  const windowRect: UiAcceptanceRect = {
    left: 0,
    top: 0,
    right: snapshot.windowWidth,
    bottom: snapshot.windowHeight,
  };

  return getUiAcceptancePaintOrderedNodes(snapshot.nodes)
    .filter(
      (node) =>
        node.visible &&
        node.hiddenByAncestor !== true &&
        node.width > 0 &&
        node.height > 0 &&
        (node.visibleWidth === undefined ||
          (node.visibleWidth !== null &&
            node.visibleHeight !== undefined &&
            node.visibleHeight !== null &&
            node.visibleWidth > 0 &&
            node.visibleHeight > 0))
    )
    .map((node) => ({
      node,
      rect: getUiAcceptanceVisibleRect(node, nodesById, windowRect),
    }))
    .filter(
      (item): item is UiAcceptanceRenderableNode =>
        item.rect !== null &&
        (item.node.hasVisualContent === true ||
          item.node.isSvg === true ||
          item.node.isImage === true ||
          item.node.isGradient === true)
    );
};

const getUiAcceptanceOverlapMidpoint = (
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): number | null => {
  const overlapStart = Math.max(firstStart, secondStart);
  const overlapEnd = Math.min(firstEnd, secondEnd);

  return overlapEnd > overlapStart ? (overlapStart + overlapEnd) / 2 : null;
};

// 分离时量最近两条边之间的间隙；重叠（含嵌套）时量同一方向起始边之间的偏移量，
// 也就是子元素相对父元素的内边距。两种情况下返回的都是该轴上需要绘制的线段。
const getUiAcceptanceAxisMeasurement = (
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
  overlap: boolean
): { start: number; end: number } => {
  if (overlap) {
    return { start: firstStart, end: secondStart };
  }

  if (firstEnd <= secondStart) {
    return { start: firstEnd, end: secondStart };
  }

  if (secondEnd <= firstStart) {
    return { start: firstStart, end: secondEnd };
  }

  return { start: firstStart, end: secondStart };
};

export const getUiAcceptanceNodeDistance = (
  first: UiAcceptanceRect,
  second: UiAcceptanceRect
): UiAcceptanceNodeDistance => {
  const horizontalOverlap = first.left < second.right && second.left < first.right;
  const verticalOverlap = first.top < second.bottom && second.top < first.bottom;
  const firstIsAbove = first.bottom <= second.top;
  const horizontalMeasure = getUiAcceptanceAxisMeasurement(
    first.left,
    first.right,
    second.left,
    second.right,
    horizontalOverlap
  );
  const verticalMeasure = getUiAcceptanceAxisMeasurement(
    first.top,
    first.bottom,
    second.top,
    second.bottom,
    verticalOverlap
  );
  const horizontalGap = Math.abs(horizontalMeasure.end - horizontalMeasure.start);
  const verticalGap = Math.abs(verticalMeasure.end - verticalMeasure.start);
  const horizontalMidY = getUiAcceptanceOverlapMidpoint(
    first.top,
    first.bottom,
    second.top,
    second.bottom
  );
  const verticalMidX = getUiAcceptanceOverlapMidpoint(
    first.left,
    first.right,
    second.left,
    second.right
  );

  // 水平段贴着 first 朝向 second 的那条横边或两者的起始横边，垂直段贴着 second 朝向 first
  // 的那条竖边或两者的起始竖边，两段因此在同一坐标上相接，斜对角时画出一条直角折线。
  const horizontalY = horizontalMidY ?? (firstIsAbove ? first.bottom : first.top);
  const verticalX = verticalMidX ?? horizontalMeasure.end;

  return {
    horizontalGap,
    verticalGap,
    edgeDistance: Math.sqrt(horizontalGap ** 2 + verticalGap ** 2),
    relation: horizontalOverlap && verticalOverlap ? 'overlap' : 'separate',
    horizontal:
      horizontalGap > 0
        ? {
            gap: horizontalGap,
            start: { x: horizontalMeasure.start, y: horizontalY },
            end: { x: horizontalMeasure.end, y: horizontalY },
          }
        : null,
    vertical:
      verticalGap > 0
        ? {
            gap: verticalGap,
            start: { x: verticalX, y: verticalMeasure.start },
            end: { x: verticalX, y: verticalMeasure.end },
          }
        : null,
  };
};
