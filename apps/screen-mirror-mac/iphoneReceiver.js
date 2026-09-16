const net = require('net');

// Mac 端 iPhone 接收器：监听 TCP，接收 ReplayKit Broadcast Extension 经 WiFi 推来的 Annex-B H.264 流。
// 推流端见 ios/MallApp/UiAcceptanceBroadcaster/SampleHandler.swift（NWConnection 直推）。
class IPhoneReceiver {
  constructor() {
    this.onData = null;
    this.onFrame = null;
    this.onStatus = null;
    this.server = null;
    this.socket = null;
  }

  start(address) {
    const [host = '0.0.0.0', port = '23456'] = (address || '0.0.0.0:23456').split(':');
    const portNum = parseInt(port, 10);

    this.server = net.createServer((socket) => {
      // 只接受第一个连接；新的连接会替换旧的
      if (this.socket && this.socket !== socket) {
        try { this.socket.destroy(); } catch (e) { /* ignore */ }
      }
      this.socket = socket;
      let pending = Buffer.alloc(0);
      this._report(`iPhone 已连接，接收画面中…`);
      socket.on('data', (chunk) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

        while (pending.length >= 4) {
          const frameLength = pending.readUInt32BE(0);
          // A corrupted length must not make the receiver retain unbounded data.
          if (frameLength === 0 || frameLength > 32 * 1024 * 1024) {
            this._report(`iPhone 视频帧长度异常：${frameLength}`);
            socket.destroy();
            return;
          }
          if (pending.length < frameLength + 4) return;

          const frame = pending.subarray(4, frameLength + 4);
          pending = pending.subarray(frameLength + 4);
          if (this.onFrame) this.onFrame(frame);
          else if (this.onData) this.onData(frame);
        }
      });
      socket.on('error', (err) => {
        this._report(`iPhone 连接错误：${err.message}`);
      });
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null;
          this._report('iPhone 断开');
        }
      });
    });

    this.server.on('error', (err) => {
      this._report(`监听失败：${err.message}（端口可能被占用，或权限不足）`);
    });

    this.server.listen(portNum, host, () => {
      this._report(`等待 iPhone 通过 WiFi 连接…（监听 ${host}:${portNum}）`);
    });
  }

  stop() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (e) { /* ignore */ }
      this.socket = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  _report(text) {
    if (this.onStatus) this.onStatus(text);
  }
}

module.exports = IPhoneReceiver;
