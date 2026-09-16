import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AcceptanceReceiverInfo,
  AndroidCaptureResult,
  AndroidDeviceInfo,
  NetworkAddress,
} from '@shared/ipc';

interface CaptureButtonProps {
  requirementId: string;
  onCaptured: () => void;
}

/** 等待窗口：够在手机上翻到要验的页面、再点悬浮按钮。 */
const WAIT_TTL_MS = 3 * 60 * 1000;

/** 一行连接串。App 端粘贴这一行即可完成配对，不用分别抄地址和密钥。 */
export function buildConnectionString(address: string, port: number, token: string): string {
  return `smacceptance://${address}:${port}?token=${token}`;
}

/**
 * 采集面板：**节点与截图都由 App 里的 SDK 上传**，Mac 只负责接收与落盘。
 *
 * 这里曾经有三样东西，现在都没了：
 * ① 设备下拉框 —— 采集不再走 USB，选设备没有意义了；
 * ② 每次采集现生成的一串 endpoint/token/captureId —— 密钥已长期化，手机上配一次就够；
 * ③ 采集完要人手抄凭据的提示 —— 那是「必须人工搬运三个随机值」年代的产物。
 *
 * 替代它们的是：一行可复制的连接串 + 一个「开始接收」按钮。
 */
const CaptureButton: React.FC<CaptureButtonProps> = ({ requirementId, onCaptured }) => {
  const [receiver, setReceiver] = useState<AcceptanceReceiverInfo | null>(null);
  const [addresses, setAddresses] = useState<NetworkAddress[]>([]);
  const [address, setAddress] = useState<string>('');
  const [devices, setDevices] = useState<AndroidDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AndroidCaptureResult | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [info, list, deviceList] = await Promise.all([
        window.api.verify.getAcceptanceReceiver(),
        window.api.getLocalIp(),
        window.api.verify.listAndroidDevices().catch(() => [] as AndroidDeviceInfo[]),
      ]);
      setReceiver(info);
      setAddresses(list);
      setAddress((current) => current || list[0]?.address || '');
      setDevices(deviceList);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connection = useMemo(() => {
    if (!receiver || !address) return '';
    return buildConnectionString(address, receiver.port, receiver.token);
  }, [address, receiver]);

  const handleCopy = useCallback(async () => {
    if (!connection) return;
    try {
      await navigator.clipboard.writeText(connection);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('复制失败，请手工选中连接串复制');
    }
  }, [connection]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const captured = await window.api.verify.captureAndroid({
        requirementId,
        ttlMs: WAIT_TTL_MS,
      });
      setResult(captured);
      onCaptured();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onCaptured, requirementId]);

  const handleCancel = useCallback(async () => {
    await window.api.verify.cancelAndroidCapture().catch(() => {});
  }, []);

  const authorized = devices.filter((device) => device.state === 'device');

  return (
    <div className="capture-zone">
      <div className="capture-hint">
        <div className="capture-hint-title">① 手机端配对（只需一次）</div>
        <div>把下面这一行粘进 App 的「验收上传」调试页：</div>
        <div className="capture-conn">
          <code>{connection || '（正在读取接收地址…）'}</code>
          <button type="button" className="btn" disabled={!connection} onClick={() => void handleCopy()}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        {addresses.length > 1 && (
          <div className="capture-addr-row">
            <span>接收网卡：</span>
            <select
              className="input select"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            >
              {addresses.map((item) => (
                <option key={`${item.name}-${item.address}`} value={item.address}>
                  {item.name} · {item.address}
                </option>
              ))}
            </select>
            <span className="capture-addr-note">
              选手机所在的那张网卡；虚拟网卡（docker / vmnet）的实际地址手机连不上。
            </span>
          </div>
        )}
      </div>

      <div className="capture-row">
        <button
          type="button"
          className="btn primary"
          disabled={busy || !receiver}
          onClick={() => void handleStart()}
        >
          {busy ? '等待手机上传…' : '开始接收'}
        </button>
        {busy && (
          <button type="button" className="btn" onClick={() => void handleCancel()}>
            取消
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      <div className="capture-hint">
        {busy ? (
          <>
            <div className="capture-hint-title">② 在手机上点悬浮按钮</div>
            <div>
              翻到要验收的页面，点右下角悬浮按钮的「上传」。节点与当前屏幕截图会一起传回来。
              等待窗口 3 分钟，超时可重新点「开始接收」。
            </div>
          </>
        ) : (
          <>
            <div className="capture-hint-title">② 在手机上点悬浮按钮</div>
            <div>
              点上面的「开始接收」，然后在手机上点悬浮按钮的「上传」。
              <strong>截图与节点由 App 自己采集</strong>，不需要插 USB、也不需要 adb。
            </div>
          </>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}

      {result && (
        <div className="alert ok">
          接收成功：{result.width}×{result.height} dp（{result.pixelWidth}×{result.pixelHeight} px @
          {result.densityDpi}dpi），{result.nodeCount} 个节点
          {result.packageName ? ` · ${result.packageName}` : ''}
          {result.deviceModel ? ` · ${result.deviceModel}` : ''}
        </div>
      )}
      {result?.warning && <div className="alert warn">{result.warning}</div>}

      {!busy && authorized.length === 0 && (
        <div className="capture-hint subtle">
          提示：本机当前未检测到已授权的 USB 设备。这不影响上传，仅表示无法用 USB 做反控。
        </div>
      )}
    </div>
  );
};

export default CaptureButton;
