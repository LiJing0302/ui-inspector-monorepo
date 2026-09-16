window.IPhoneMirror = class {
  constructor(video, placeholder, onStatus) {
    this.video = video;
    this.placeholder = placeholder;
    this.onStatus = onStatus;
    this.room = null;
    this.diagnostics = document.getElementById('iphone-diagnostics');
    this.videoTrack = null;
    this.statsMonitor = null;
    this.senderMetrics = null;
    this.previousSender = null;
  }

  async start(session) {
    await this.stop();
    const { Room, RoomEvent, Track, VideoQuality } = window.LivekitClient;
    const room = new Room({ adaptiveStream: false });
    this.room = room;
    this.video.hidden = false;
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (this.room !== room || participant?.identity !== 'iphone-publisher' || topic !== 'screen-mirror.metrics.v1') return;
      this.receiveSenderMetrics(payload);
    });
    this.video.onplaying = () => {
      if (this.room !== room) return;
      clearTimeout(this.firstFrameTimeout);
      this.placeholder.classList.add('hidden');
      this.onStatus(`iPhone 画面已显示 (${this.video.videoWidth}×${this.video.videoHeight})`);
    };
    room.on(RoomEvent.TrackSubscribed, async (track, publication) => {
      if (this.room !== room || track.kind !== Track.Kind.Video || publication.source !== Track.Source.ScreenShare) return;
      publication.setVideoQuality(VideoQuality.HIGH);
      track.setPlayoutDelay(0);
      this.videoTrack = track;
      this.onStatus('已订阅 iPhone 屏幕轨道，等待首帧…');
      track.attach(this.video);
      this.startDiagnostics(room, track);
      clearTimeout(this.firstFrameTimeout);
      this.firstFrameTimeout = setTimeout(() => {
        this.onStatus('已订阅但未显示首帧：请检查 Mac 防火墙及 7881/TCP、7882/UDP');
      }, 15000);
      try { await this.video.play(); } catch (error) { this.onStatus(`视频播放失败：${error.message}`); }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (this.room !== room || this.videoTrack !== track) return;
      this.videoTrack = null;
      this.stopDiagnostics();
      track.detach(this.video);
      clearTimeout(this.firstFrameTimeout);
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
      clearTimeout(this.firstFrameTimeout);
      this.video.srcObject = null;
      this.placeholder.classList.remove('hidden');
      this.onStatus('LiveKit 已断开，请重新开始投屏');
    });
    await room.connect(session.url, session.token, { rtcConfig: { iceServers: [] } });
    this.onStatus('Mac 已加入房间，请在 iPhone 填写地址和配对码并开始共享');
  }

  startDiagnostics(room, track) {
    this.stopDiagnostics();
    const monitor = { previous: null, timer: null };
    this.statsMonitor = monitor;
    const isCurrent = () => this.room === room && this.statsMonitor === monitor;
    const poll = async () => {
      try {
        const report = await track.getRTCStatsReport();
        if (!isCurrent()) return;
        const inbound = report && Array.from(report.values()).find((entry) =>
          entry.type === 'inbound-rtp' && (entry.kind === 'video' || entry.mediaType === 'video'));
        if (!inbound) {
          this.diagnostics.textContent = '接收指标：等待 WebRTC 统计…';
          return;
        }
        const previous = monitor.previous;
        const comparable = previous?.id === inbound.id && inbound.timestamp > previous.timestamp;
        const delta = (field) => comparable && Number.isFinite(inbound[field]) && Number.isFinite(previous[field])
          && inbound[field] >= previous[field] ? inbound[field] - previous[field] : null;
        const elapsed = comparable ? inbound.timestamp - previous.timestamp : 0;
        const bytes = delta('bytesReceived');
        const frames = delta('framesDecoded');
        const emitted = delta('jitterBufferEmittedCount');
        const bufferDelay = delta('jitterBufferDelay');
        const targetDelay = delta('jitterBufferTargetDelay');
        const minimumDelay = delta('jitterBufferMinimumDelay');
        const decodeTime = delta('totalDecodeTime');
        const lost = delta('packetsLost');
        const dropped = delta('framesDropped');
        const codec = report.get(inbound.codecId)?.mimeType?.replace('video/', '') || '未知编码';
        const transport = report.get(inbound.transportId);
        const pair = report.get(transport?.selectedCandidatePairId);
        const candidate = report.get(pair?.localCandidateId);
        const protocol = candidate?.protocol?.toUpperCase() || '未知传输';
        const fps = frames !== null && elapsed > 0 ? `${(frames * 1000 / elapsed).toFixed(1)}fps` : 'fps 待采样';
        const bitrate = bytes !== null && elapsed > 0 ? `${(bytes * 8 / elapsed / 1000).toFixed(2)}Mbps` : '码率待采样';
        const buffer = bufferDelay !== null && emitted > 0 ? `${(bufferDelay * 1000 / emitted).toFixed(1)}ms` : '—';
        const target = targetDelay !== null && emitted > 0 ? `${(targetDelay * 1000 / emitted).toFixed(1)}ms` : '—';
        const minimum = minimumDelay !== null && emitted > 0 ? `${(minimumDelay * 1000 / emitted).toFixed(1)}ms` : '—';
        const decode = decodeTime !== null && frames > 0 ? `${(decodeTime * 1000 / frames).toFixed(1)}ms` : '—';
        const width = inbound.frameWidth || this.video.videoWidth;
        const height = inbound.frameHeight || this.video.videoHeight;
        this.diagnostics.textContent = `${width}×${height} · ${codec} · ${fps} · ${bitrate}\n`
          + `Mac 接收段 ${protocol} · 缓冲 ${buffer} · 解码 ${decode} · 丢包 +${lost ?? '—'} / 丢帧 +${dropped ?? '—'}\n`
          + `缓冲实际/目标/最小：${buffer} / ${target} / ${minimum}\n`
          + `${this.playoutSettings(track)}\n${this.senderDiagnostics()}`;
        monitor.previous = inbound;
      } catch {
        if (isCurrent()) this.diagnostics.textContent = '接收指标暂不可用，视频播放不受影响';
      } finally {
        if (isCurrent()) monitor.timer = setTimeout(poll, 1000);
      }
    };
    if (this.diagnostics) void poll();
  }

  playoutSettings(track) {
    const receiver = track.receiver;
    const read = (property, scale) => {
      if (!receiver || !(property in receiver)) return '不支持';
      const value = receiver[property];
      return Number.isFinite(value) && value >= 0 ? `${(value * scale).toFixed(1)}ms` : '未设置';
    };
    return `播放提示 请求0ms / 回读${read('playoutDelayHint', 1000)} · jitterBufferTarget ${read('jitterBufferTarget', 1)}（非实际延迟）`;
  }

  receiveSenderMetrics(payload) {
    try {
      if (!payload || payload.byteLength > 1200) return;
      const metrics = JSON.parse(new TextDecoder().decode(payload));
      if (metrics?.version !== 1) return;
      const now = Date.now();
      const sender = metrics.sender;
      const previous = this.previousSender;
      const valid = (value) => Number.isFinite(value) && value >= 0;
      if (sender !== undefined && (!sender || typeof sender.id !== 'string' || !valid(sender.timestampMs))) return;
      if (sender && previous?.id === sender.id && sender.timestampMs < previous.timestampMs) return;
      const comparable = sender && previous?.id === sender.id && valid(sender.timestampMs)
        && valid(previous.timestampMs) && sender.timestampMs > previous.timestampMs;
      const elapsed = comparable ? (sender.timestampMs - previous.timestampMs) / 1000 : 0;
      const delta = (field) => comparable && valid(sender[field]) && valid(previous[field]) && sender[field] >= previous[field]
        ? sender[field] - previous[field] : null;
      const rate = (field) => { const value = delta(field); return value !== null && elapsed > 0 ? value / elapsed : null; };
      const frames = delta('framesEncoded');
      const encode = delta('encodeSeconds');
      const packets = delta('packetsSent');
      const sendDelay = delta('sendDelaySeconds');
      const bytes = rate('bytesSent');
      const sameSample = sender && previous?.id === sender.id && sender.timestampMs === previous.timestampMs;
      const senderSampleAt = sameSample ? this.senderMetrics?.senderSampleAt : now;
      const rates = sameSample ? this.senderMetrics?.rates : {
        encodedFps: rate('framesEncoded'), sentFps: rate('framesSent'),
        mbps: bytes === null ? null : bytes * 8 / 1_000_000,
        encodeMs: encode !== null && frames > 0 ? encode * 1000 / frames : null,
        sendDelayMs: sendDelay !== null && packets > 0 ? sendDelay * 1000 / packets : null,
      };
      this.senderMetrics = { sender, receivedAt: now, senderSampleAt, rates };
      this.previousSender = sender;
    } catch {}
  }

  senderDiagnostics() {
    const metrics = this.senderMetrics;
    if (!metrics) return 'iOS 指标：等待上报（需新版 iOS 和 Mac，重新配对）';
    const age = Date.now() - metrics.receivedAt;
    if (age > 6000 || age < 0) return 'iOS 指标：已过期（超过6秒未收到上报）';
    const number = (value, suffix = '') => Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)}${suffix}` : '—';
    const captureText = 'Broadcast 原始入口：SDK 未开放统计';
    const sender = metrics.sender;
    if (!sender || Date.now() - metrics.senderSampleAt > 6000) return `${captureText}\niOS 发布端：统计缺失或已过期`;
    const rates = metrics.rates || {};
    const reason = ['none', 'cpu', 'bandwidth', 'other'].includes(sender.limitation) ? sender.limitation : '未知';
    const protocol = ['udp', 'tcp'].includes(sender.protocol) ? sender.protocol.toUpperCase() : '未知';
    return `${captureText}\n`
      + `iOS 输入(IPC后) ${number(sender.sourceFps, 'fps')} · 编码 ${number(rates.encodedFps, 'fps')} / 发送 ${number(rates.sentFps, 'fps')} · ${number(rates.mbps, 'Mbps')}\n`
      + `编码 ${number(rates.encodeMs, 'ms/帧')} · 发包等待 ${number(rates.sendDelayMs, 'ms/包')} · 限制 ${reason}\n`
      + `iPhone 上行 ${protocol} · RTT ${number(sender.rttMs, 'ms')} · 可用带宽估计 ${number(sender.availableMbps, 'Mbps')}`;
  }

  stopDiagnostics() {
    clearTimeout(this.statsMonitor?.timer);
    this.statsMonitor = null;
    this.senderMetrics = null;
    this.previousSender = null;
    if (this.diagnostics) this.diagnostics.textContent = '';
  }

  async stop() {
    const room = this.room;
    this.room = null;
    this.senderMetrics = null;
    this.previousSender = null;
    this.videoTrack = null;
    this.stopDiagnostics();
    clearTimeout(this.firstFrameTimeout);
    this.video.onplaying = null;
    if (room) {
      room.removeAllListeners();
      await room.disconnect();
    }
    this.video.srcObject = null;
    this.video.hidden = true;
  }
};
