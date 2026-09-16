import { useCallback, useEffect, useRef } from 'react';

import {
  H264Stream,
  buildAvcCDescription,
  concatAccessUnits,
  findParameterSets,
  getCodecString,
  hasKeyframe,
  removeParameterSets,
  toLengthPrefixed,
} from '../lib/h264';
import type { VideoPacket } from '@shared/ipc';

interface UseScrcpyDecoderOptions {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  onStatus: (text: string) => void;
  /** 首帧解码成功，用于隐藏占位层 */
  onFirstFrame: () => void;
  /** 管线重置（停止/切换源），用于恢复占位层 */
  onReset: () => void;
}

export interface ScrcpyDecoderApi {
  feedPacket: (packet: VideoPacket) => void;
  reset: () => void;
  /** 当前视频尺寸，用于触摸坐标归一化 */
  getVideoSize: () => { width: number; height: number };
}

/**
 * scrcpy 视频流 → WebCodecs 解码 → canvas。
 *
 * 把原先散落在模块级的解码状态收敛到 ref：切换信号源时不会残留上一路的 SPS/PPS，
 * 也避免 React 重渲染把解码器状态冲掉。
 */
export function useScrcpyDecoder({
  canvasRef,
  onStatus,
  onFirstFrame,
  onReset,
}: UseScrcpyDecoderOptions): ScrcpyDecoderApi {
  const streamRef = useRef<H264Stream>(new H264Stream());
  const decoderRef = useRef<VideoDecoder | null>(null);

  const spsRef = useRef<Uint8Array | null>(null);
  const ppsRef = useRef<Uint8Array | null>(null);
  const configurationDataRef = useRef<Uint8Array | null>(null);
  const codecStringRef = useRef<string | null>(null);
  const avcCRef = useRef<Uint8Array | null>(null);
  const configKeyRef = useRef('');

  const ptsCounterRef = useRef(0);
  const needsKeyframeRef = useRef(true);
  const annexBModeRef = useRef(false);
  const decodedFrameCountRef = useRef(0);
  const videoSizeRef = useRef({ width: 0, height: 0 });

  const ensureDecoder = useCallback((): boolean => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return false;
    if (!codecStringRef.current) return false;
    if (decoderRef.current && decoderRef.current.state === 'configured') return true;
    if (decoderRef.current && decoderRef.current.state !== 'closed') {
      try {
        decoderRef.current.close();
      } catch {
        /* ignore */
      }
    }

    const nextDecoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        videoSizeRef.current = { width: frame.displayWidth, height: frame.displayHeight };
        ctx.drawImage(frame, 0, 0);
        decodedFrameCountRef.current += 1;
        onFirstFrame();
        if (decodedFrameCountRef.current === 1 || decodedFrameCountRef.current % 30 === 0) {
          onStatus(`画面已解码：${decodedFrameCountRef.current} 帧（${frame.displayWidth}x${frame.displayHeight}）`);
        }
        frame.close();
      },
      error: (error) => {
        // WebCodecs 进入 error 状态后不可恢复，这里置空以便下一个 IDR 重建解码器。
        if (decoderRef.current === nextDecoder) {
          decoderRef.current = null;
          needsKeyframeRef.current = true;
        }
        console.error('[decoder]', error);
        onStatus(`解码失败：${error.message || String(error)}`);
      },
    });

    decoderRef.current = nextDecoder;
    try {
      decoderRef.current.configure(
        annexBModeRef.current
          ? { codec: codecStringRef.current, optimizeForLatency: true }
          : { codec: codecStringRef.current, description: avcCRef.current ?? undefined },
      );
    } catch (error) {
      decoderRef.current = null;
      console.error('[decoder configure]', error);
      onStatus(`解码器配置失败：${(error as Error).message || String(error)}`);
      return false;
    }
    needsKeyframeRef.current = true;
    return true;
  }, [canvasRef, onFirstFrame, onStatus]);

  const maybeConfigure = useCallback((): void => {
    const sps = spsRef.current;
    const pps = ppsRef.current;
    if (!sps || !pps) return;

    const newCodec = getCodecString(sps);
    const newAvcC = buildAvcCDescription(sps, pps);
    const key = `${newCodec}|${btoa(String.fromCharCode(...sps))}|${btoa(String.fromCharCode(...pps))}`;
    if (key === configKeyRef.current && decoderRef.current?.state === 'configured') return;

    configKeyRef.current = key;
    codecStringRef.current = newCodec;
    avcCRef.current = newAvcC;

    if (!ensureDecoder()) return;
    needsKeyframeRef.current = true;
    onStatus(`解码器就绪 ${newCodec}`);
  }, [ensureDecoder, onStatus]);

  const decodeAccessUnit = useCallback(
    (data: Uint8Array, timestamp: number): void => {
      // 以码流自身为准：scrcpy 的 keyframe 标记缺失/滞后时，
      // 绝不能把 delta 帧当成 configure() 后的第一帧，否则 Chromium 抛 "A key frame is required"。
      const isKeyframe = hasKeyframe(data);
      if (needsKeyframeRef.current && !isKeyframe) return;
      if (!ensureDecoder()) return;

      try {
        const accessUnit =
          isKeyframe && configurationDataRef.current ? concatAccessUnits(configurationDataRef.current, data) : data;
        const encodedData = annexBModeRef.current ? accessUnit : removeParameterSets(accessUnit);
        if (encodedData.length === 0) return;

        decoderRef.current?.decode(
          new EncodedVideoChunk({ type: isKeyframe ? 'key' : 'delta', timestamp, data: encodedData }),
        );
        if (isKeyframe) needsKeyframeRef.current = false;
      } catch (error) {
        needsKeyframeRef.current = true;
        console.error('[decode]', error);
      }
    },
    [ensureDecoder],
  );

  const feedH264 = useCallback(
    (bytes: Uint8Array): void => {
      for (const { type, payload } of streamRef.current.feed(bytes)) {
        if (type === 7) {
          annexBModeRef.current = false;
          spsRef.current = payload;
          maybeConfigure();
        } else if (type === 8) {
          annexBModeRef.current = false;
          ppsRef.current = payload;
          maybeConfigure();
        } else if (type === 1 || type === 5) {
          if (type !== 5 && needsKeyframeRef.current) continue;
          if (!ensureDecoder()) continue;
          try {
            decoderRef.current?.decode(
              new EncodedVideoChunk({
                type: type === 5 ? 'key' : 'delta',
                timestamp: ptsCounterRef.current++ * 1000,
                data: toLengthPrefixed(payload),
              }),
            );
            if (type === 5) needsKeyframeRef.current = false;
          } catch (error) {
            needsKeyframeRef.current = true;
            console.error('[decode]', error);
          }
        }
      }
    },
    [ensureDecoder, maybeConfigure],
  );

  const feedPacket = useCallback(
    (packet: VideoPacket): void => {
      if (!packet) return;
      if (packet.type === 'session') {
        videoSizeRef.current = {
          width: packet.width || videoSizeRef.current.width,
          height: packet.height || videoSizeRef.current.height,
        };
        return;
      }
      if (packet.type === 'configuration') {
        try {
          const data = new Uint8Array(packet.data);
          const { sequenceParameterSet, pictureParameterSet } = findParameterSets(data);
          spsRef.current = sequenceParameterSet;
          ppsRef.current = pictureParameterSet;
          configurationDataRef.current = data;
          annexBModeRef.current = true;
          maybeConfigure();
        } catch (error) {
          console.error('[scrcpy configuration]', error);
        }
        return;
      }
      if (packet.type !== 'data') return;
      const timestamp = packet.pts === undefined ? ptsCounterRef.current++ * 1000 : Number(packet.pts);
      decodeAccessUnit(new Uint8Array(packet.data), timestamp);
    },
    [decodeAccessUnit, maybeConfigure],
  );

  const reset = useCallback((): void => {
    if (decoderRef.current && decoderRef.current.state !== 'closed') {
      try {
        decoderRef.current.close();
      } catch {
        /* ignore */
      }
    }
    decoderRef.current = null;
    streamRef.current = new H264Stream();
    spsRef.current = null;
    ppsRef.current = null;
    configurationDataRef.current = null;
    codecStringRef.current = null;
    avcCRef.current = null;
    configKeyRef.current = '';
    ptsCounterRef.current = 0;
    needsKeyframeRef.current = true;
    annexBModeRef.current = false;
    decodedFrameCountRef.current = 0;
    videoSizeRef.current = { width: 0, height: 0 };
    onReset();
  }, [onReset]);

  // 组件卸载时释放解码器
  useEffect(
    () => () => {
      if (decoderRef.current && decoderRef.current.state !== 'closed') {
        try {
          decoderRef.current.close();
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  return {
    feedPacket,
    reset,
    getVideoSize: () => videoSizeRef.current,
    // h264 裸流通道保留（当前 iPhone 走 LiveKit，此通道未接数据源）
    ...{ feedH264 },
  } as ScrcpyDecoderApi & { feedH264: (bytes: Uint8Array) => void };
}
