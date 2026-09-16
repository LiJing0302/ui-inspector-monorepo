import React from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { UiAcceptanceSnapshot } from '../../uiAcceptanceModule';
import {
  getUiAcceptanceBorderSegments,
  getUiAcceptanceDrawableNodes,
  getUiAcceptanceNodeDistance,
  intersectUiAcceptanceRects,
  type UiAcceptanceRect,
  type UiAcceptanceRenderableNode,
} from './geometry';

const UI_ACCEPTANCE_ANCHOR_BORDER_COLOR = '#F59E0B';
const UI_ACCEPTANCE_ANCHOR_FILL_COLOR = 'rgba(245, 158, 11, 0.24)';
const UI_ACCEPTANCE_SELECTED_BORDER_COLOR = '#2563EB';
const UI_ACCEPTANCE_SELECTED_FILL_COLOR = 'rgba(37, 99, 235, 0.22)';
const UI_ACCEPTANCE_BORDER_SIZE = 1;
const UI_ACCEPTANCE_DISTANCE_LINE_SIZE = 2;
const UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH = 64;
const UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT = 18;
const UI_ACCEPTANCE_DISTANCE_LABEL_GAP = 4;
const UI_ACCEPTANCE_DIMENSION_LABEL_HEIGHT = 22;
const UI_ACCEPTANCE_DIMENSION_LABEL_GAP = 4;
const UI_ACCEPTANCE_DIMENSION_FONT_SIZE = 11;
const UI_ACCEPTANCE_DIMENSION_LABEL_PADDING = 10;

const toUiAcceptanceLabelRect = (
  left: number,
  top: number,
  labelWidth: number,
  labelHeight: number
): UiAcceptanceRect => ({
  left,
  top,
  right: left + labelWidth,
  bottom: top + labelHeight,
});

const estimateUiAcceptanceLabelWidth = (text: string): number => {
  const charWidth = text
    .split('')
    .reduce((sum, char) => sum + (/[一-鿿]/.test(char) ? 1 : 0.55), 0);

  return UI_ACCEPTANCE_DIMENSION_FONT_SIZE * charWidth + UI_ACCEPTANCE_DIMENSION_LABEL_PADDING;
};

export interface UiAcceptanceBoundsOverlayProps {
  snapshot: UiAcceptanceSnapshot | null;
  selectedNodeIds: readonly string[];
  anchorNodeId: string | null;
  onNodePress: (nodeId: string) => void;
}

const UiAcceptanceBoundsOverlay: React.FC<UiAcceptanceBoundsOverlayProps> = ({
  snapshot,
  selectedNodeIds,
  anchorNodeId,
  onNodePress,
}) => {
  const { width, height } = useWindowDimensions();

  if (!snapshot || snapshot.windowWidth <= 0) {
    return null;
  }

  const scale = width / snapshot.windowWidth;
  const borderSize =
    snapshot.platform === 'ios'
      ? UI_ACCEPTANCE_BORDER_SIZE / (snapshot.scale ?? 1)
      : UI_ACCEPTANCE_BORDER_SIZE;
  const drawableNodes = getUiAcceptanceDrawableNodes(snapshot);
  // 按选中顺序排列，保证基准元素排在第一位，颜色与距离路径的起点都以它为准
  const selectedNodes = selectedNodeIds
    .map((nodeId) => drawableNodes.find(({ node }) => node.nodeId === nodeId))
    .filter((item): item is UiAcceptanceRenderableNode => item !== undefined);
  const distance =
    selectedNodes.length === 2
      ? getUiAcceptanceNodeDistance(selectedNodes[0].rect, selectedNodes[1].rect)
      : null;
  const unit = snapshot.platform === 'ios' ? 'pt' : 'px';

  const formatNumber = (value: number): string => {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  };

  const getDimensionText = (nodeId: string, rect: UiAcceptanceRect): string => {
    return `${nodeId === anchorNodeId ? '基准 ' : ''}${formatNumber(
      rect.right - rect.left
    )} x ${formatNumber(rect.bottom - rect.top)} ${unit}`;
  };

  // 所有标签共用一套避让逻辑：先放尺寸标签，距离标签再绕开已占用的位置，避免互相压住。
  const placedLabelRects: UiAcceptanceRect[] = [];
  const placeLabel = (candidates: UiAcceptanceRect[]): UiAcceptanceRect => {
    const insideScreen = candidates.filter(
      (candidate) =>
        candidate.left >= 0 &&
        candidate.top >= 0 &&
        candidate.right <= width &&
        candidate.bottom <= height
    );
    const pool = insideScreen.length > 0 ? insideScreen : candidates;
    const chosen =
      pool.find(
        (candidate) =>
          !placedLabelRects.some((placed) => intersectUiAcceptanceRects(placed, candidate))
      ) ?? pool[0];

    placedLabelRects.push(chosen);
    return chosen;
  };

  const dimensionLabels = selectedNodes.map(({ node, rect }) => {
    const labelWidth = estimateUiAcceptanceLabelWidth(getDimensionText(node.nodeId, rect));
    const left = Math.min(Math.max(rect.left * scale, 0), Math.max(width - labelWidth, 0));

    return placeLabel([
      toUiAcceptanceLabelRect(
        left,
        rect.top * scale - UI_ACCEPTANCE_DIMENSION_LABEL_HEIGHT - UI_ACCEPTANCE_DIMENSION_LABEL_GAP,
        labelWidth,
        UI_ACCEPTANCE_DIMENSION_LABEL_HEIGHT
      ),
      toUiAcceptanceLabelRect(
        left,
        rect.bottom * scale + UI_ACCEPTANCE_DIMENSION_LABEL_GAP,
        labelWidth,
        UI_ACCEPTANCE_DIMENSION_LABEL_HEIGHT
      ),
      toUiAcceptanceLabelRect(
        left,
        rect.top * scale + UI_ACCEPTANCE_DIMENSION_LABEL_GAP,
        labelWidth,
        UI_ACCEPTANCE_DIMENSION_LABEL_HEIGHT
      ),
    ]);
  });

  const horizontalDistance = distance?.horizontal ?? null;
  const verticalDistance = distance?.vertical ?? null;

  const horizontalLine = horizontalDistance
    ? {
        left: Math.min(horizontalDistance.start.x, horizontalDistance.end.x) * scale,
        top: horizontalDistance.start.y * scale - UI_ACCEPTANCE_DISTANCE_LINE_SIZE / 2,
        width: horizontalDistance.gap * scale,
        height: UI_ACCEPTANCE_DISTANCE_LINE_SIZE,
      }
    : null;
  const verticalLine = verticalDistance
    ? {
        left: verticalDistance.start.x * scale - UI_ACCEPTANCE_DISTANCE_LINE_SIZE / 2,
        top: Math.min(verticalDistance.start.y, verticalDistance.end.y) * scale,
        width: UI_ACCEPTANCE_DISTANCE_LINE_SIZE,
        height: verticalDistance.gap * scale,
      }
    : null;

  const horizontalDistanceLabel = horizontalDistance
    ? (() => {
        const lineCenterY = horizontalDistance.start.y * scale;
        const lineLeft = horizontalLine!.left;
        const lineRight = lineLeft + horizontalDistance.gap * scale;
        const lineCenterX = (lineLeft + lineRight) / 2;

        return placeLabel([
          toUiAcceptanceLabelRect(
            lineCenterX - UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH / 2,
            lineCenterY - UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT - UI_ACCEPTANCE_DISTANCE_LABEL_GAP,
            UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT
          ),
          toUiAcceptanceLabelRect(
            lineCenterX - UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH / 2,
            lineCenterY + UI_ACCEPTANCE_DISTANCE_LABEL_GAP,
            UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT
          ),
          toUiAcceptanceLabelRect(
            lineRight + UI_ACCEPTANCE_DISTANCE_LABEL_GAP,
            lineCenterY - UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT / 2,
            UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT
          ),
          toUiAcceptanceLabelRect(
            lineLeft - UI_ACCEPTANCE_DISTANCE_LABEL_GAP - UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            lineCenterY - UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT / 2,
            UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT
          ),
        ]);
      })()
    : null;

  const verticalDistanceLabel = verticalDistance
    ? (() => {
        const lineCenterX = verticalDistance.start.x * scale;
        const lineTop = verticalLine!.top;
        const lineBottom = lineTop + verticalDistance.gap * scale;
        const lineCenterY = (lineTop + lineBottom) / 2;

        return placeLabel([
          toUiAcceptanceLabelRect(
            lineCenterX + UI_ACCEPTANCE_DISTANCE_LABEL_GAP,
            lineCenterY - UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT / 2,
            UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT
          ),
          toUiAcceptanceLabelRect(
            lineCenterX - UI_ACCEPTANCE_DISTANCE_LABEL_GAP - UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            lineCenterY - UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT / 2,
            UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT
          ),
          toUiAcceptanceLabelRect(
            lineCenterX - UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH / 2,
            lineBottom + UI_ACCEPTANCE_DISTANCE_LABEL_GAP,
            UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT
          ),
          toUiAcceptanceLabelRect(
            lineCenterX - UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH / 2,
            lineTop - UI_ACCEPTANCE_DISTANCE_LABEL_GAP - UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT,
            UI_ACCEPTANCE_DISTANCE_LABEL_WIDTH,
            UI_ACCEPTANCE_DISTANCE_LABEL_HEIGHT
          ),
        ]);
      })()
    : null;

  const toLabelStyle = (labelRect: UiAcceptanceRect) => ({
    left: labelRect.left,
    top: labelRect.top,
    width: labelRect.right - labelRect.left,
    height: labelRect.bottom - labelRect.top,
  });

  return (
    <View pointerEvents='box-none' style={StyleSheet.absoluteFill}>
      {selectedNodes.map(({ node, rect }, selectedIndex) => {
        const borderSegments = getUiAcceptanceBorderSegments(rect, [], borderSize);
        const isAnchor = node.nodeId === anchorNodeId;
        const borderColor = isAnchor
          ? UI_ACCEPTANCE_ANCHOR_BORDER_COLOR
          : UI_ACCEPTANCE_SELECTED_BORDER_COLOR;
        const fillColor = isAnchor
          ? UI_ACCEPTANCE_ANCHOR_FILL_COLOR
          : UI_ACCEPTANCE_SELECTED_FILL_COLOR;

        return (
          <React.Fragment key={node.nodeId}>
            <View
              testID={`ui-acceptance-selected-fill-${node.nodeId}`}
              pointerEvents='none'
              style={[
                styles.uiAcceptanceNodeFill,
                {
                  left: rect.left * scale,
                  top: rect.top * scale,
                  width: (rect.right - rect.left) * scale,
                  height: (rect.bottom - rect.top) * scale,
                  backgroundColor: fillColor,
                  zIndex: 1000 + selectedIndex * 4,
                },
              ]}
            />
            {borderSegments.map((segment, segmentIndex) => (
              <View
                testID={`ui-acceptance-selected-border-${node.nodeId}-${segmentIndex}`}
                key={`${node.nodeId}.border.${segmentIndex}`}
                pointerEvents='none'
                style={[
                  styles.uiAcceptanceNodeBorder,
                  {
                    left: segment.left * scale,
                    top: segment.top * scale,
                    width: (segment.right - segment.left) * scale,
                    height: (segment.bottom - segment.top) * scale,
                    backgroundColor: borderColor,
                    zIndex: 1001 + selectedIndex * 4,
                  },
                ]}
              />
            ))}
            <View
              testID={`ui-acceptance-selected-${node.nodeId}`}
              pointerEvents='none'
              style={[
                styles.uiAcceptanceSelectedNode,
                {
                  left: rect.left * scale,
                  top: rect.top * scale,
                  width: (rect.right - rect.left) * scale,
                  height: (rect.bottom - rect.top) * scale,
                  borderColor,
                  zIndex: 1002 + selectedIndex * 4,
                },
              ]}
            />
            <View
              testID={`ui-acceptance-dimensions-${node.nodeId}`}
              pointerEvents='none'
              style={[
                styles.uiAcceptanceDimensionLabel,
                { ...toLabelStyle(dimensionLabels[selectedIndex]), zIndex: 1100 + selectedIndex },
              ]}
            >
              <Text style={styles.uiAcceptanceDimensionText}>
                {getDimensionText(node.nodeId, rect)}
              </Text>
            </View>
          </React.Fragment>
        );
      })}
      {horizontalDistance && horizontalLine && horizontalDistanceLabel && (
        <>
          <View
            testID='ui-acceptance-distance-line-x'
            pointerEvents='none'
            style={[styles.uiAcceptanceDistanceLine, horizontalLine]}
          />
          <View
            testID='ui-acceptance-distance-label-x'
            pointerEvents='none'
            style={[styles.uiAcceptanceDistanceLabel, toLabelStyle(horizontalDistanceLabel)]}
          >
            <Text numberOfLines={1} style={styles.uiAcceptanceDistanceText}>
              {formatNumber(horizontalDistance.gap)} {unit}
            </Text>
          </View>
        </>
      )}
      {verticalDistance && verticalLine && verticalDistanceLabel && (
        <>
          <View
            testID='ui-acceptance-distance-line-y'
            pointerEvents='none'
            style={[styles.uiAcceptanceDistanceLine, verticalLine]}
          />
          <View
            testID='ui-acceptance-distance-label-y'
            pointerEvents='none'
            style={[styles.uiAcceptanceDistanceLabel, toLabelStyle(verticalDistanceLabel)]}
          >
            <Text numberOfLines={1} style={styles.uiAcceptanceDistanceText}>
              {formatNumber(verticalDistance.gap)} {unit}
            </Text>
          </View>
        </>
      )}
      {drawableNodes.map(({ node, rect }, nodeIndex) => {
        const isSelected = selectedNodeIds.includes(node.nodeId);
        const baseZIndex = nodeIndex * 4;

        return (
          <Pressable
            key={`${node.nodeId}.hit`}
            testID={`ui-acceptance-node-${node.nodeId}`}
            accessibilityRole='button'
            accessibilityLabel={`验收节点 ${node.className}`}
            accessibilityState={{ selected: isSelected }}
            onPress={() => onNodePress(node.nodeId)}
            style={[
              styles.uiAcceptanceNodeHitTarget,
              {
                left: rect.left * scale,
                top: rect.top * scale,
                width: (rect.right - rect.left) * scale,
                height: (rect.bottom - rect.top) * scale,
                zIndex: baseZIndex + 3,
              },
            ]}
          />
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  uiAcceptanceNodeFill: {
    position: 'absolute',
  },
  uiAcceptanceNodeBorder: {
    position: 'absolute',
  },
  uiAcceptanceSelectedNode: {
    position: 'absolute',
    borderWidth: 2,
  },
  uiAcceptanceDimensionLabel: {
    position: 'absolute',
    minHeight: 22,
    paddingHorizontal: 5,
    justifyContent: 'center',
    backgroundColor: 'rgba(17, 24, 39, 0.9)',
    borderRadius: 3,
  },
  uiAcceptanceDimensionText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
  uiAcceptanceDistanceLine: {
    position: 'absolute',
    backgroundColor: '#FDE047',
    zIndex: 2000,
  },
  uiAcceptanceDistanceLabel: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    backgroundColor: 'rgba(17, 24, 39, 0.94)',
    borderRadius: 3,
    zIndex: 2001,
  },
  uiAcceptanceDistanceText: {
    color: '#FDE047',
    fontSize: 10,
    fontWeight: '700',
  },
  uiAcceptanceNodeHitTarget: {
    position: 'absolute',
    backgroundColor: 'transparent',
  },
});

export default UiAcceptanceBoundsOverlay;
