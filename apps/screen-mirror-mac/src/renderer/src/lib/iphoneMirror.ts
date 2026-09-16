import {
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  type DataPacket_Kind,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
} from 'livekit-client';

import type { IPhoneSession } from '@shared/ipc';

/** iOS 端每 2 秒经 data topic 上报的分段指标 */
interface SenderMetrics {
  id?: string;
  timestampMs?: number;
  sourceFps?: number;
  framesEncoded?: number;
  framesSent?: number;
  bytesSent?: number;
  encodeSeconds?: number;
  packetsSent?: number;
  sendDelaySeconds?: number;
  limitation?: string;
  protocol?: string;
  rttMs?: number;
  availableMbps?: number;
}

interface MetricsPayload {
  version?: number;
  sender?: SenderMetrics | null;
}

const METRICS_TOPIC = 'screen-mirror.metrics.v1';
const METRICS_MAX_BYTES = 1200;
const METRICS_STALE_MS = 6000;
const FIRST_FRAME_TIMEOUT_MS = 15_000;

/**
 * iPhone 投屏接收端：加入 LiveKit 房间、订阅 screen_share 视频轨道、采集接收端诊断。
 *
 * Mac 侧只订阅，不发布；iPhone 侧只发布 screen_share。
 * 诊断口径见 README：展示的是 Mac↔本地 LiveKit 这一段，不是端到端延迟。
 */
export class IPhoneMirror {
  private readonly video: HTMLVideoElement;
  private readonly placeholder: HTMLElement;
  private readonly onStatus: (text: string) => void;
  private readonly diagnostics: HTMLElement | null;

  private room: Room | null = null;
  private videoTrack: RemoteVideoTrack | null = null;
  private statsMonitor: { previous: Record<string, number> | null; timer: number | null } | null = null;
  private senderMetrics: { sender: SenderMetrics | null; receivedAt: number; senderSampleAt: number; rates: Record<string, number | null> } | null = null;
  private previousSender: SenderMetrics | null = null;
  private firstFrameTimeout: number | null = null;

  constructor(video: HTMLVideoElement, placeholder: HTMLElement, onStatus: (text: string) => void) {
    this.video = video;
    this.placeholder = placeholder;
    this.onStatus = onStatus;
    this.diagnostics = document.getElementById('iphone-diagnostics');
  }

  async start(session: IPhoneSession): Promise<void> {
    await this.stop();

    const room = new Room({ adaptiveStream: false });
    this.room = room;
    this.video.hidden = false;

    room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, _kind?: DataPacket_Kind, topic?: string) => {
      if (this.room !== room) return;
      if (participant?.identity !== 'iphone-publisher' || topic !== METRICS_TOPIC) return;
      this.receiveSenderMetrics(payload);
    });

    this.video.onplaying = () => {
      if (this.room !== room) return;
      this.clearFirstFrameTimeout();
      this.placeholder.classList.add('hidden');
      this.onStatus(`iPhone 画面已显示 (${this.video.videoWidth}×${this.video.videoHeight})`);
    };

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication) => {
      if (this.room !== room) return;
      if (track.kind !== Track.Kind.Video || publication.source !== Track.Source.ScreenShare) return;

      publication.setVideoQuality(VideoQuality.HIGH);
      track.setPlayoutDelay(0);
      this.videoTrack = track as RemoteVideoTrack;
      this.onStatus('已订阅 iPhone 屏幕轨道，等待首帧…');
      track.attach(this.video);
      this.startDiagnostics(room, track as RemoteVideoTrack);

      this.clearFirstFrameTimeout();
      this.firstFrameTimeout = window.setTimeout(() => {
        this.onStatus('已订阅但未显示首帧：请检查 Mac 防火墙及 7881/TCP、7882/UDP');
      }, FIRST_FRAME_TIMEOUT_MS);

      void this.video.play().catch((error: Error) => {
        this.onStatus(`视频播放失败：${error.message}`);
      });
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (this.room !== room || this.videoTrack !== track) return;
      this.videoTrack = null;
      this.stopDiagnostics();
      track.detach(this.video);
      this.clearFirstFrameTimeout();
      this.placeholder.classList.remove('hidden');
      this.onStatus('iPhone 已停止共享，等待重新开始…');
    });

    room.on(RoomEvent.Reconnecting, () => {
      if (this.room !== room) return;
      this.stopDiagnostics();
      this.senderMetrics = null;
      this.previousSender = null;
      this.onStatus('LiveKit 正在重连…');
    });

    room.on(RoomEvent.Reconnected, () => {
      if (this.room !== room) return;
      if (this.videoTrack) this.startDiagnostics(room, this.videoTrack);
      this.onStatus('LiveKit 已重连');
    });

    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.videoTrack = null;
      this.stopDiagnostics();
      this.clearFirstFrameTimeout();
      this.video.srcObject = null;
      this.placeholder.classList.remove('hidden');
      this.onStatus('LiveKit 已断开，请重新开始投屏');
    });

    await room.connect(session.url, session.token, { rtcConfig: { iceServers: [] } });
    this.onStatus('Mac 已加入房间，请在 iPhone 填写地址和配对码并开始共享');
  }

  async stop(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.senderMetrics = null;
    this.previousSender = null;
    this.videoTrack = null;
    this.stopDiagnostics();
    this.clearFirstFrameTimeout();
    this.video.onplaying = null;
    if (room) {
      room.removeAllListeners();
      await room.disconnect();
    }
    this.video.srcObject = null;
    this.video.hidden = true;
  }

  private clearFirstFrameTimeout(): void {
    if (this.firstFrameTimeout !== null) {
      clearTimeout(this.firstFrameTimeout);
      this.firstFrameTimeout = null;
    }
  }

  // ---------- 诊断 ----------

  private startDiagnostics(room: Room, track: RemoteVideoTrack): void {
    this.stopDiagnostics();
    const monitor = { previous: null as Record<string, number> | null, timer: null as number | null };
    this.statsMonitor = monitor;

    const isCurrent = (): boolean => this.room === room && this.statsMonitor === monitor;

    const poll = async (): Promise<void> => {
      try {
        const report = await track.getRTCStatsReport();
        if (!isCurrent() || !report) return;

        const inbound = Array.from(report.values()).find(
          (entry) =>
            entry.type === 'inbound-rtp' &&
            ((entry as Record<string, unknown>)['kind'] === 'video' ||
              (entry as Record<string, unknown>)['mediaType'] === 'video'),
        ) as Record<string, number> | undefined;

        if (!inbound) {
          if (this.diagnostics) this.diagnostics.textContent = '接收指标：等待 WebRTC 统计…';
          return;
        }

        const previous = monitor.previous;
        const comparable = previous?.['id'] === inbound['id'] && inbound['timestamp'] > previous['timestamp'];
        const delta = (field: string): number | null =>
          comparable && Number.isFinite(inbound[field]) && Number.isFinite(previous![field]) && inbound[field] >= previous![field]
            ? inbound[field] - previous![field]
            : null;
        const elapsed = comparable ? inbound['timestamp'] - previous!['timestamp'] : 0;

        const bytes = delta('bytesReceived');
        const frames = delta('framesDecoded');
        const emitted = delta('jitterBufferEmittedCount');
        const bufferDelay = delta('jitterBufferDelay');
        const targetDelay = delta('jitterBufferTargetDelay');
        const minimumDelay = delta('jitterBufferMinimumDelay');
        const decodeTime = delta('totalDecodeTime');
        const lost = delta('packetsLost');
        const dropped = delta('framesDropped');

        const codecEntry = report.get(String(inbound['codecId'] ?? '')) as { mimeType?: string } | undefined;
        const codec = codecEntry?.mimeType?.replace('video/', '') ?? '未知编码';

        const transport = report.get(String(inbound['transportId'] ?? '')) as { selectedCandidatePairId?: string } | undefined;
        const pair = report.get(String(transport?.selectedCandidatePairId ?? '')) as { localCandidateId?: string } | undefined;
        const candidate = report.get(String(pair?.localCandidateId ?? '')) as { protocol?: string } | undefined;
        const protocol = candidate?.protocol?.toUpperCase() ?? '未知传输';

        const fps = frames !== null && elapsed > 0 ? `${((frames * 1000) / elapsed).toFixed(1)}fps` : 'fps 待采样';
        const bitrate = bytes !== null && elapsed > 0 ? `${((bytes * 8) / elapsed / 1000).toFixed(2)}Mbps` : '码率待采样';
        const emittedCount = emitted ?? 0;
        const frameCount = frames ?? 0;
        const buffer = bufferDelay !== null && emittedCount > 0 ? `${((bufferDelay * 1000) / emittedCount).toFixed(1)}ms` : '—';
        const target = targetDelay !== null && emittedCount > 0 ? `${((targetDelay * 1000) / emittedCount).toFixed(1)}ms` : '—';
        const minimum = minimumDelay !== null && emittedCount > 0 ? `${((minimumDelay * 1000) / emittedCount).toFixed(1)}ms` : '—';
        const decode = decodeTime !== null && frameCount > 0 ? `${((decodeTime * 1000) / frameCount).toFixed(1)}ms` : '—';

        const width = inbound['frameWidth'] ?? this.video.videoWidth;
        const height = inbound['frameHeight'] ?? this.video.videoHeight;

        if (this.diagnostics) {
          this.diagnostics.textContent =
            `${width}×${height} · ${codec} · ${fps} · ${bitrate}\n` +
            `Mac 接收段 ${protocol} · 缓冲 ${buffer} · 解码 ${decode} · 丢包 +${lost ?? '—'} / 丢帧 +${dropped ?? '—'}\n` +
            `缓冲实际/目标/最小：${buffer} / ${target} / ${minimum}\n` +
            `${this.playoutSettings(track)}\n${this.senderDiagnostics()}`;
        }
        monitor.previous = inbound;
      } catch {
        if (isCurrent() && this.diagnostics) {
          this.diagnostics.textContent = '接收指标暂不可用，视频播放不受影响';
        }
      } finally {
        if (isCurrent()) monitor.timer = window.setTimeout(() => void poll(), 1000);
      }
    };

    if (this.diagnostics) void poll();
  }

  private playoutSettings(track: RemoteVideoTrack): string {
    const receiver = track.receiver as unknown as Record<string, unknown> | undefined;
    const read = (property: string, scale: number): string => {
      if (!receiver || !(property in receiver)) return '不支持';
      const value = receiver[property];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? `${(value * scale).toFixed(1)}ms`
        : '未设置';
    };
    return `播放提示 请求0ms / 回读${read('playoutDelayHint', 1000)} · jitterBufferTarget ${read('jitterBufferTarget', 1)}（非实际延迟）`;
  }

  private receiveSenderMetrics(payload: Uint8Array): void {
    try {
      if (!payload || payload.byteLength > METRICS_MAX_BYTES) return;
      const metrics = JSON.parse(new TextDecoder().decode(payload)) as MetricsPayload;
      if (metrics?.version !== 1) return;

      const sender = metrics.sender;
      const previous = this.previousSender;
      const valid = (value: number | undefined): boolean => Number.isFinite(value) && (value as number) >= 0;

      if (sender !== undefined && (!sender || typeof sender.id !== 'string' || !valid(sender.timestampMs))) return;
      if (sender && previous && previous.id === sender.id && (sender.timestampMs as number) < (previous.timestampMs as number)) {
        return;
      }

      const comparable =
        !!sender &&
        previous !== null &&
        previous.id === sender.id &&
        valid(sender.timestampMs) &&
        valid(previous.timestampMs) &&
        (sender.timestampMs as number) > (previous.timestampMs as number);
      const elapsed = comparable ? ((sender!.timestampMs as number) - (previous!.timestampMs as number)) / 1000 : 0;
      const delta = (field: keyof SenderMetrics): number | null => {
        const a = sender?.[field] as number | undefined;
        const b = previous?.[field] as number | undefined;
        return comparable && valid(a) && valid(b) && (a as number) >= (b as number) ? (a as number) - (b as number) : null;
      };
      const rate = (field: keyof SenderMetrics): number | null => {
        const value = delta(field);
        return value !== null && elapsed > 0 ? value / elapsed : null;
      };

      const frames = delta('framesEncoded');
      const encode = delta('encodeSeconds');
      const packets = delta('packetsSent');
      const sendDelay = delta('sendDelaySeconds');
      const bytes = rate('bytesSent');
      const sameSample =
        !!sender && previous !== null && previous.id === sender.id && sender.timestampMs === previous.timestampMs;
      const senderSampleAt = sameSample ? this.senderMetrics?.senderSampleAt ?? Date.now() : Date.now();
      const rates = sameSample
        ? this.senderMetrics?.rates ?? {}
        : {
            encodedFps: rate('framesEncoded'),
            sentFps: rate('framesSent'),
            mbps: bytes === null ? null : (bytes * 8) / 1_000_000,
            encodeMs: encode !== null && frames ? (encode * 1000) / frames : null,
            sendDelayMs: sendDelay !== null && packets ? (sendDelay * 1000) / packets : null,
          };

      this.senderMetrics = { sender: sender ?? null, receivedAt: Date.now(), senderSampleAt, rates };
      this.previousSender = sender ?? null;
    } catch {
      // 坏包直接忽略：诊断不可用时也不应影响画面
    }
  }

  private senderDiagnostics(): string {
    const metrics = this.senderMetrics;
    if (!metrics) return 'iOS 指标：等待上报（需新版 iOS 和 Mac，重新配对）';

    const age = Date.now() - metrics.receivedAt;
    if (age > METRICS_STALE_MS || age < 0) return 'iOS 指标：已过期（超过6秒未收到上报）';

    const number = (value: number | null | undefined, suffix = ''): string =>
      Number.isFinite(value) && (value as number) >= 0 ? `${(value as number).toFixed(1)}${suffix}` : '—';
    const captureText = 'Broadcast 原始入口：SDK 未开放统计';
    const sender = metrics.sender;
    if (!sender || Date.now() - metrics.senderSampleAt > METRICS_STALE_MS) {
      return `${captureText}\niOS 发布端：统计缺失或已过期`;
    }

    const rates = metrics.rates;
    const reason = ['none', 'cpu', 'bandwidth', 'other'].includes(sender.limitation ?? '') ? sender.limitation : '未知';
    const protocol = ['udp', 'tcp'].includes(sender.protocol ?? '') ? (sender.protocol as string).toUpperCase() : '未知';

    return (
      `${captureText}\n` +
      `iOS 输入(IPC后) ${number(sender.sourceFps, 'fps')} · 编码 ${number(rates['encodedFps'], 'fps')} / 发送 ${number(rates['sentFps'], 'fps')} · ${number(rates['mbps'], 'Mbps')}\n` +
      `编码 ${number(rates['encodeMs'], 'ms/帧')} · 发包等待 ${number(rates['sendDelayMs'], 'ms/包')} · 限制 ${reason}\n` +
      `iPhone 上行 ${protocol} · RTT ${number(sender.rttMs, 'ms')} · 可用带宽估计 ${number(sender.availableMbps, 'Mbps')}`
    );
  }

  private stopDiagnostics(): void {
    if (this.statsMonitor?.timer !== null && this.statsMonitor?.timer !== undefined) {
      clearTimeout(this.statsMonitor.timer);
    }
    this.statsMonitor = null;
    this.senderMetrics = null;
    this.previousSender = null;
    if (this.diagnostics) this.diagnostics.textContent = '';
  }
}
