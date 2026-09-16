/**
 * 插件直传通道的 IPC 暴露。
 *
 * 只有两个动作：查状态 / 开关服务。
 * 「接收到的设计稿」不在这里回给渲染层 —— 它走 `bridge:event` 推送，
 * 因为导入是**由插件触发的异步事件**，渲染层并没有发起请求可以拿返回值。
 */

import { ipcMain } from 'electron';

import type { BridgeStatus } from '../../types/bridge';
import type { DesignBridge } from './designBridge';

export function registerBridgeIpc(
  bridge: DesignBridge,
  /** 把用户的显式开关回传给窗口编排层，让它记住"用户不想要"这个决定 */
  onUserIntent?: (enabled: boolean) => void,
): void {
  ipcMain.handle('bridge:status', (): BridgeStatus => bridge.status());

  ipcMain.handle('bridge:set-enabled', async (_event, enabled: boolean): Promise<BridgeStatus> => {
    onUserIntent?.(enabled);
    if (enabled) {
      // 端口被占等启动失败要如实抛给渲染层，否则用户只会看到开关"弹回去"却不知为何
      return bridge.start();
    }
    await bridge.stop();
    return bridge.status();
  });
}
