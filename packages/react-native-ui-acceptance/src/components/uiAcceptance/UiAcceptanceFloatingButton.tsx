import React, { useCallback, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import UiAcceptanceModule, {
  type AcceptanceReceiverConfig,
  type AcceptanceUploadResult,
  type UiAcceptanceSnapshot,
} from '../../uiAcceptanceModule';
import UiAcceptanceBoundsOverlay from './UiAcceptanceBoundsOverlay';
import { useUiAcceptanceSelection } from './selection';

export interface UiAcceptanceFloatingButtonProps {
  onError?: (error: unknown) => void;
  onSnapshot?: (snapshot: UiAcceptanceSnapshot) => void;
  /** 上传成功。返回值里有节点数与服务端确认的截图字节数，适合直接显示给使用者。 */
  onUploaded?: (result: AcceptanceUploadResult) => void;
  /**
   * Mac 接收端配置（由 App 自己持久化，例如 MMKV / AsyncStorage）。
   *
   * 为空时不渲染「上传」按钮 —— 还没配对就摆一个必然失败的按钮，
   * 只会让人以为「上传功能坏了」，而不是「我还没配对」。
   */
  receiver?: AcceptanceReceiverConfig | null;
  style?: StyleProp<ViewStyle>;
  /**
   * 是否渲染「边界」按钮（显示/隐藏布局边界浮层）。
   * 默认 true。单帧抓取场景可设 false，只保留「采集 / 上传」按钮。
   */
  showBoundsButton?: boolean;
}

/** 等两帧：让 `opacity: 0` 先落到屏幕上，再触发原生截图。 */
async function waitForHideToLand(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  // rAF 只保证「下一帧前」，不保证这一帧已经合成完。再给一小段时间，
  // 免得截图抢在隐藏生效之前 —— 那一张图里会带着悬浮按钮，成为设计稿上不存在的元素。
  await new Promise<void>((resolve) => setTimeout(resolve, 48));
}

/**
 * 悬浮工具条：采集节点 / 上传到 Mac / 显示布局边界。
 *
 * <p>「上传」是一次性动作：采同一帧的节点树与截图，直接 POST 回 Mac。
 * 不需要 USB、不需要 adb、不需要在 Mac 上先选设备 —— Mac 那边只要在验收页点一次「开始接收」。
 */
const UiAcceptanceFloatingButton: React.FC<UiAcceptanceFloatingButtonProps> = ({
  onError,
  onSnapshot,
  onUploaded,
  receiver,
  style,
  showBoundsButton = true,
}) => {
  const [capturing, setCapturing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [showBounds, setShowBounds] = useState(false);
  const [snapshot, setSnapshot] = useState<UiAcceptanceSnapshot | null>(null);
  const { anchorNodeId, selectedNodeIds, selectNode, clearSelection } = useUiAcceptanceSelection();

  const busy = capturing || uploading;

  const captureNativeUi = useCallback(async () => {
    const shouldRestoreBounds = showBounds;
    clearSelection();

    if (shouldRestoreBounds) {
      setShowBounds(false);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }

    try {
      const nextSnapshot = await UiAcceptanceModule.capture();
      setSnapshot(nextSnapshot);
      onSnapshot?.(nextSnapshot);
    } finally {
      if (shouldRestoreBounds) {
        setShowBounds(true);
      }
    }
  }, [clearSelection, onSnapshot, showBounds]);

  const handleCapture = useCallback(async () => {
    if (busy) {
      return;
    }

    setCapturing(true);
    try {
      await captureNativeUi();
    } catch (error) {
      onError?.(error);
    } finally {
      setCapturing(false);
    }
  }, [busy, captureNativeUi, onError]);

  const handleToggleBounds = useCallback(async () => {
    if (busy) {
      return;
    }

    if (showBounds) {
      clearSelection();
      setSnapshot(null);
      setShowBounds(false);
      return;
    }

    setCapturing(true);
    try {
      await captureNativeUi();
      setShowBounds(true);
    } catch (error) {
      onError?.(error);
    } finally {
      setCapturing(false);
    }
  }, [busy, captureNativeUi, clearSelection, onError, showBounds]);

  const handleUpload = useCallback(async () => {
    if (busy || !receiver) {
      return;
    }

    setUploading(true);
    // 先把自己的 UI 藏起来再截图：这是一层 React 视图，原生不认识它，
    // 落在截图里就是设计稿上不存在的几个圆角方块，直接被验收判成差异。
    setHidden(true);
    try {
      await waitForHideToLand();
      const result = await UiAcceptanceModule.uploadBundle(receiver);
      onUploaded?.(result);
    } catch (error) {
      onError?.(error);
    } finally {
      setHidden(false);
      setUploading(false);
    }
  }, [busy, onUploaded, onError, receiver]);

  return (
    <View pointerEvents='box-none' style={[styles.host, hidden && styles.hostHidden]}>
      <UiAcceptanceBoundsOverlay
        snapshot={showBounds ? snapshot : null}
        selectedNodeIds={selectedNodeIds}
        anchorNodeId={anchorNodeId}
        onNodePress={selectNode}
      />
      <View pointerEvents='box-none' style={[styles.container, style]}>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel='采集原生节点'
          accessibilityHint='输出当前页面原生节点信息'
          accessibilityState={{ busy: capturing }}
          disabled={busy}
          onPress={handleCapture}
          style={[styles.actionButton, busy && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>采集</Text>
        </Pressable>
        {receiver && (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='上传节点与截图到 Mac'
            accessibilityHint='把同一帧的节点树和屏幕截图一起传到 Mac 的验收页'
            accessibilityState={{ busy: uploading }}
            disabled={busy}
            onPress={handleUpload}
            style={[styles.actionButton, styles.uploadButton, busy && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>{uploading ? '上传中' : '上传'}</Text>
          </Pressable>
        )}
        {showBoundsButton && (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={showBounds ? '隐藏布局边界' : '显示布局边界'}
            accessibilityState={{ busy: capturing, checked: showBounds }}
            disabled={busy}
            onPress={handleToggleBounds}
            style={[
              styles.actionButton,
              styles.boundsButton,
              showBounds && styles.boundsButtonActive,
              busy && styles.buttonDisabled,
            ]}
          >
            <Text style={styles.buttonText}>{showBounds ? '隐藏' : '边界'}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  /** 满屏容器：把「边界浮层」与「工具条」包成一层，截图前可以一起隐藏。 */
  host: {
    ...StyleSheet.absoluteFillObject,
  },
  /**
   * 截图期间的状态。
   *
   * 用 `opacity: 0` 而不是卸载：卸载会触发一次 React 重挂载 —— 按钮的忙碌态、
   * 选中的节点、布局边界会被一并丢掉，截图回来之后界面「跳」一下，人看到会以为出错了。
   */
  hostHidden: {
    opacity: 0,
  },
  container: {
    position: 'absolute',
    bottom: 24,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 3000,
  },
  actionButton: {
    minWidth: 52,
    height: 52,
    paddingHorizontal: 12,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1677FF',
    borderWidth: 1,
    borderColor: '#FFFFFF',
    zIndex: 3000,
    elevation: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 5,
  },
  /** 上传是「把数据交出去」的动作，与就地采集区分开：橙，且排在采集右边。 */
  uploadButton: {
    marginLeft: 10,
    backgroundColor: '#C2410C',
  },
  boundsButton: {
    marginLeft: 10,
    backgroundColor: '#0F766E',
  },
  boundsButtonActive: {
    backgroundColor: '#115E59',
  },
  buttonDisabled: {
    opacity: 0.72,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});

export default UiAcceptanceFloatingButton;
