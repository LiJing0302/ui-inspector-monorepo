import {
  getUiAcceptanceDrawableNodes,
  getUiAcceptanceNodeDistance,
} from '../src/components/uiAcceptance/geometry';
import {
  selectUiAcceptanceNode,
  EMPTY_UI_ACCEPTANCE_SELECTION,
} from '../src/components/uiAcceptance/selection';
import type { UiAcceptanceSnapshot } from '../src/uiAcceptanceModule';

const snapshot: UiAcceptanceSnapshot = {
  platform: 'ios',
  source: 'ios-uiview-tree',
  timestamp: 0,
  nodeCount: 3,
  windowWidth: 375,
  windowHeight: 667,
  scale: 3,
  nodes: [
    {
      nodeId: 'root',
      parentId: null,
      className: 'UIWindow',
      depth: 0,
      index: 0,
      x: 0,
      y: 0,
      width: 375,
      height: 667,
      visible: true,
      hasVisualContent: false,
      clickable: false,
      enabled: true,
      clipsToBounds: true,
      alpha: 1,
      z: 0,
    },
    {
      nodeId: 'container',
      parentId: 'root',
      className: 'UIView',
      depth: 1,
      index: 0,
      x: 20,
      y: 20,
      width: 100,
      height: 100,
      visible: true,
      hasVisualContent: false,
      clickable: false,
      enabled: true,
      clipsToBounds: true,
      alpha: 1,
      z: 0,
    },
    {
      nodeId: 'label',
      parentId: 'container',
      className: 'UILabel',
      depth: 2,
      index: 0,
      x: 80,
      y: 80,
      width: 80,
      height: 40,
      visible: true,
      hasVisualContent: true,
      clickable: false,
      enabled: true,
      clipsToBounds: false,
      alpha: 1,
      z: 0,
    },
  ],
};

describe('ui acceptance geometry', () => {
  it('keeps transparent ancestors for clipping but only draws visual nodes', () => {
    const nodes = getUiAcceptanceDrawableNodes(snapshot);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].node.nodeId).toBe('label');
    expect(nodes[0].rect).toEqual({ left: 80, top: 80, right: 120, bottom: 120 });
  });

  it('measures separated rectangles on both axes', () => {
    expect(
      getUiAcceptanceNodeDistance(
        { left: 0, top: 0, right: 40, bottom: 40 },
        { left: 60, top: 80, right: 100, bottom: 120 }
      )
    ).toMatchObject({
      horizontalGap: 20,
      verticalGap: 40,
      relation: 'separate',
    });
  });

  it('promotes a repeated selection to the measurement anchor', () => {
    const selected = selectUiAcceptanceNode(EMPTY_UI_ACCEPTANCE_SELECTION, 'label');

    expect(selectUiAcceptanceNode(selected, 'label')).toEqual({
      anchorNodeId: 'label',
      activeNodeId: 'label',
    });
  });
});
