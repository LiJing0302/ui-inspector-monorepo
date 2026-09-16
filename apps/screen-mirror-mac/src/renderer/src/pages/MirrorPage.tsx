import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useScrcpyDecoder } from '../hooks/useScrcpyDecoder';
import { IPhoneMirror } from '../lib/iphoneMirror';
import type { MirrorSource, NetworkAddress } from '@shared/ipc';

const ANDROID_KEY_CODES: Record<string, number> = {
  Backspace: 67,
  Tab: 61,
  Enter: 66,
  Escape: 4,
  Home: 3,
  ArrowLeft: 21,
  ArrowRight: 22,
  ArrowUp: 19,
  ArrowDown: 20,
  PageUp: 92,
  PageDown: 93,
  Delete: 112,
  ' ': 62,
};

const ANDROID_CONTROL_BUTTONS = [
  { keyCode: 4, label: '返回' },
  { keyCode: 3, label: 'Home' },
  { keyCode: 187, label: '最近' },
];

const TOUCH_DOWN = 0;
const TOUCH_UP = 1;
const TOUCH_MOVE = 2;
const TOUCH_CANCEL = 3;

const MirrorPage: React.FC = () => {
  const [source, setSource] = useState<MirrorSource>('iphone');
  const [addresses, setAddresses] = useState<NetworkAddress[]>([]);
  const [iphoneAddress, setIphoneAddress] = useState('');
  const [androidSerial, setAndroidSerial] = useState('');
  const [status, setStatus] = useState('空闲');
  const [pairingInfo, setPairingInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPlaceholder, setShowPlaceholder] = useState(true);
  const [placeholderText, setPlaceholderText] = useState('未连接');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const iphoneMirrorRef = useRef<IPhoneMirror | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  const webCodecsSupported = useMemo(() => typeof VideoDecoder !== 'undefined', []);

  const { feedPacket, reset, getVideoSize } = useScrcpyDecoder({
    canvasRef,
    onStatus: setStatus,
    onFirstFrame: () => setShowPlaceholder(false),
    onReset: () => setShowPlaceholder(true),
  });

  // ---- 初始化：网卡列表 + IPhoneMirror 实例 ----
  useEffect(() => {
    if (!webCodecsSupported) {
      setStatus('当前 Electron 不支持 WebCodecs，无法解码。请使用 Electron 30+。');
    }

    window.api
      .getLocalIp()
      .then((list) => {
        const sorted = [...list].sort(
          (a, b) => Number(b.name.startsWith('en')) - Number(a.name.startsWith('en')),
        );
        setAddresses(sorted);
        if (sorted.length > 0) setIphoneAddress((prev) => prev || sorted[0]!.address);
        if (sorted.length === 0) setStatus('没有可用局域网地址，请连接 Wi-Fi 后重启应用');
      })
      .catch((error: Error) => setStatus(error.message));

    if (videoRef.current && placeholderRef.current) {
      iphoneMirrorRef.current = new IPhoneMirror(videoRef.current, placeholderRef.current, setStatus);
    }

    const offStatus = window.api.onStatus(setStatus);
    const offPacket = window.api.onVideoPacket(feedPacket);
    return () => {
      offStatus();
      offPacket();
      void iphoneMirrorRef.current?.stop();
    };
  }, [feedPacket, webCodecsSupported]);

  // ---- Android 反向控制 ----
  const sendAndroidControl = useCallback((command: Parameters<typeof window.api.sendAndroidControl>[0]) => {
    if (source !== 'android') return;
    window.api.sendAndroidControl(command).catch((error: Error) => {
      console.error('[android control]', error);
    });
  }, [source]);

  const getVideoPoint = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const { width, height } = getVideoSize();
      const vw = width || canvas.width;
      const vh = height || canvas.height;
      return {
        pointerX: Math.max(0, Math.min(vw, Math.round(((event.clientX - rect.left) / rect.width) * vw))),
        pointerY: Math.max(0, Math.min(vh, Math.round(((event.clientY - rect.top) / rect.height) * vh))),
        videoWidth: vw,
        videoHeight: vh,
      };
    },
    [getVideoSize],
  );

  const sendTouch = useCallback(
    (action: number, event: React.PointerEvent<HTMLCanvasElement>, buttons: number) => {
      const point = getVideoPoint(event);
      if (!point) return;
      sendAndroidControl({
        type: 'touch',
        action,
        ...point,
        pressure: action === TOUCH_UP || action === TOUCH_CANCEL ? 0 : 1,
        buttons,
      });
    },
    [getVideoPoint, sendAndroidControl],
  );

  const sendKey = useCallback(
    (keyCode: number, action: number, repeat = 0) => {
      sendAndroidControl({ type: 'key', action, keyCode, repeat, metaState: 0 });
    },
    [sendAndroidControl],
  );

  // 键盘：仅在 Android 源且焦点不在输入控件时透传
  useEffect(() => {
    const isFormElement = (target: EventTarget | null): boolean => {
      const tagName = (target as HTMLElement | null)?.tagName;
      return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON';
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (source !== 'android' || isFormElement(event.target) || event.isComposing) return;
      const keyCode = ANDROID_KEY_CODES[event.key];
      if (keyCode !== undefined) {
        event.preventDefault();
        sendKey(keyCode, TOUCH_DOWN, event.repeat ? 1 : 0);
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        sendAndroidControl({ type: 'text', text: event.key });
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (source !== 'android' || isFormElement(event.target) || event.isComposing) return;
      const keyCode = ANDROID_KEY_CODES[event.key];
      if (keyCode !== undefined) {
        event.preventDefault();
        sendKey(keyCode, TOUCH_UP);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [sendAndroidControl, sendKey, source]);

  // ---- 启停 ----
  const stopSource = useCallback(async () => {
    await iphoneMirrorRef.current?.stop();
    await window.api.stopSource();
    setPairingInfo('');
    reset();
  }, [reset]);

  const runSourceAction = useCallback(
    async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
      } catch (error) {
        await stopSource().catch(() => {});
        setStatus(`投屏失败：${(error as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, stopSource],
  );

  const handleSelectSource = useCallback(
    (next: MirrorSource) => {
      void runSourceAction(async () => {
        await stopSource();
        setSource(next);
        setPlaceholderText('未连接');
      });
    },
    [runSourceAction, stopSource],
  );

  const handleStart = useCallback(() => {
    void runSourceAction(async () => {
      await stopSource();
      setStatus('启动中…');

      if (source === 'iphone') {
        const session = await window.api.startSource({ source: 'iphone', iphoneAddress: iphoneAddress.trim() });
        if (!session) return;
        setPairingInfo(`iPhone 填写：${session.pairingAddress}\n配对码：${session.pairingCode}`);
        setPlaceholderText('等待 iPhone 共享屏幕…');
        setShowPlaceholder(true);
        await iphoneMirrorRef.current?.start(session);
      } else {
        await window.api.startSource({ source: 'android', androidSerial: androidSerial.trim() });
        setPlaceholderText('等待 scrcpy 画面…');
        setShowPlaceholder(true);
      }
    });
  }, [androidSerial, iphoneAddress, runSourceAction, source, stopSource]);

  const handleOpenVerify = useCallback(() => {
    window.api.openVerify().catch((error: Error) => {
      setStatus(`打开验收页失败：${error.message}`);
    });
  }, []);

  const handleStop = useCallback(() => {
    void runSourceAction(async () => {
      await stopSource();
      setPlaceholderText('未连接');
      setShowPlaceholder(true);
      setStatus('已停止');
    });
  }, [runSourceAction, stopSource]);

  const isAndroid = source === 'android';

  return (
    <div className="app-root">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">UI 验收投屏</div>
          <button className="verify-entry" onClick={handleOpenVerify} title="打开设计稿验收窗口">
            设计验收 →
          </button>
        </div>
        <div className="source-switch">
          <button
            className={`src-btn${source === 'iphone' ? ' active' : ''}`}
            onClick={() => handleSelectSource('iphone')}
            disabled={busy}
          >
            iPhone (WiFi)
          </button>
          <button
            className={`src-btn${source === 'android' ? ' active' : ''}`}
            onClick={() => handleSelectSource('android')}
            disabled={busy}
          >
            Android (scrcpy)
          </button>
        </div>
      </header>

      <section className="config">
        {!isAndroid ? (
          <div className="field">
            <label>iPhone 可访问的 Mac 网卡</label>
            <select value={iphoneAddress} onChange={(e) => setIphoneAddress(e.target.value)}>
              {addresses.map(({ name, address }) => (
                <option key={`${name}-${address}`} value={address}>
                  {name} — {address}
                </option>
              ))}
            </select>
            <div className="pairing-info">{pairingInfo}</div>
          </div>
        ) : (
          <div className="field">
            <label>设备序列号（留空自动，USB 调试）</label>
            <input
              type="text"
              value={androidSerial}
              placeholder="如 3B1234device"
              onChange={(e) => setAndroidSerial(e.target.value)}
            />
          </div>
        )}

        <div className="actions">
          <button className="primary" onClick={handleStart} disabled={busy}>
            开始
          </button>
          <button className="ghost" onClick={handleStop} disabled={busy}>
            停止
          </button>
        </div>

        {isAndroid && (
          <div className="android-controls">
            {ANDROID_CONTROL_BUTTONS.map(({ keyCode, label }) => (
              <button
                key={keyCode}
                className="control-btn"
                onClick={() => {
                  sendKey(keyCode, TOUCH_DOWN);
                  sendKey(keyCode, TOUCH_UP);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="status">{status}</div>
      <div id="iphone-diagnostics" />

      <main className="stage">
        <canvas
          ref={canvasRef}
          id="screen"
          width={375}
          height={812}
          tabIndex={0}
          hidden={!isAndroid}
          onPointerDown={(event) => {
            if (!isAndroid || event.button !== 0) return;
            event.preventDefault();
            canvasRef.current?.focus();
            activePointerIdRef.current = event.pointerId;
            try {
              canvasRef.current?.setPointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
            sendTouch(TOUCH_DOWN, event, 1);
          }}
          onPointerMove={(event) => {
            if (!isAndroid || activePointerIdRef.current !== event.pointerId) return;
            event.preventDefault();
            sendTouch(TOUCH_MOVE, event, 1);
          }}
          onPointerUp={(event) => {
            if (!isAndroid || activePointerIdRef.current !== event.pointerId) return;
            event.preventDefault();
            sendTouch(TOUCH_UP, event, 0);
            try {
              canvasRef.current?.releasePointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
            activePointerIdRef.current = null;
          }}
          onPointerCancel={(event) => {
            if (!isAndroid || activePointerIdRef.current !== event.pointerId) return;
            sendTouch(TOUCH_CANCEL, event, 0);
            activePointerIdRef.current = null;
          }}
          onContextMenu={(event) => {
            if (isAndroid) event.preventDefault();
          }}
          onWheel={(event) => {
            if (!isAndroid) return;
            const point = getVideoPoint(event);
            if (!point) return;
            event.preventDefault();
            sendAndroidControl({
              type: 'scroll',
              ...point,
              scrollX: Math.max(-1, Math.min(1, -event.deltaX / 100)),
              scrollY: Math.max(-1, Math.min(1, -event.deltaY / 100)),
            });
          }}
        />

        <video ref={videoRef} id="iphone-screen" autoPlay muted playsInline hidden={isAndroid} />

        <div ref={placeholderRef} className={`placeholder${showPlaceholder ? '' : ' hidden'}`}>
          {placeholderText}
        </div>
      </main>
    </div>
  );
};

export default MirrorPage;
