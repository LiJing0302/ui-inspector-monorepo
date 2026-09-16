import { useCallback, useState } from 'react';

export interface UiAcceptanceSelectionState {
  // 双击（再次点击同一元素）固定的基准元素，之后测量的都是它到其他元素的距离
  anchorNodeId: string | null;
  // 当前点击选中的元素
  activeNodeId: string | null;
}

export const EMPTY_UI_ACCEPTANCE_SELECTION: UiAcceptanceSelectionState = {
  anchorNodeId: null,
  activeNodeId: null,
};

export const selectUiAcceptanceNode = (
  state: UiAcceptanceSelectionState,
  nodeId: string
): UiAcceptanceSelectionState => {
  // 已固定基准时：点基准自身表示取消固定；再次点击当前目标表示把它升为新基准；
  // 点其他元素只替换测量目标，基准保持不变。
  if (state.anchorNodeId !== null) {
    if (state.anchorNodeId === nodeId) {
      return { anchorNodeId: null, activeNodeId: nodeId };
    }

    if (state.activeNodeId === nodeId) {
      return { anchorNodeId: nodeId, activeNodeId: nodeId };
    }

    return { anchorNodeId: state.anchorNodeId, activeNodeId: nodeId };
  }

  // 未固定基准时，再次点击同一元素即把它固定为基准
  if (state.activeNodeId === nodeId) {
    return { anchorNodeId: nodeId, activeNodeId: nodeId };
  }

  return { anchorNodeId: null, activeNodeId: nodeId };
};

export const clearUiAcceptanceSelection = (): UiAcceptanceSelectionState => ({
  ...EMPTY_UI_ACCEPTANCE_SELECTION,
});

export const getUiAcceptanceSelectedNodeIds = (state: UiAcceptanceSelectionState): string[] => {
  const { anchorNodeId, activeNodeId } = state;

  if (anchorNodeId !== null && activeNodeId !== null && anchorNodeId !== activeNodeId) {
    return [anchorNodeId, activeNodeId];
  }

  return [activeNodeId ?? anchorNodeId].filter((nodeId): nodeId is string => nodeId !== null);
};

export const useUiAcceptanceSelection = () => {
  const [state, setState] = useState<UiAcceptanceSelectionState>(EMPTY_UI_ACCEPTANCE_SELECTION);

  const selectNode = useCallback((nodeId: string) => {
    setState((currentState) => selectUiAcceptanceNode(currentState, nodeId));
  }, []);

  const clearSelection = useCallback(() => {
    setState(clearUiAcceptanceSelection());
  }, []);

  return {
    ...state,
    selectedNodeIds: getUiAcceptanceSelectedNodeIds(state),
    selectNode,
    clearSelection,
  };
};
