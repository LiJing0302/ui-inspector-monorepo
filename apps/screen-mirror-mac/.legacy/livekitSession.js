const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { AccessToken, TrackSource } = require('livekit-server-sdk');

class LiveKitSession {
  constructor(resourcesPath) {
    this.resourcesPath = resourcesPath;
    this.onStatus = () => {};
    this.stopped = false;
  }

  async start(host) {
    if (net.isIP(host) !== 4 || host === '0.0.0.0' || host.startsWith('127.')) {
      throw new Error('请选择 iPhone 可以访问的 Mac 局域网 IPv4 地址');
    }
    this.room = `mirror-${crypto.randomUUID()}`;
    this.apiKey = crypto.randomBytes(16).toString('hex');
    this.apiSecret = crypto.randomBytes(32).toString('hex');
    this.pairingCode = crypto.randomBytes(6).toString('hex');
    this.host = host;
    this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-mirror-'));
    const configPath = path.join(this.directory, 'livekit.json');
    await fs.writeFile(configPath, JSON.stringify({
      port: 7880,
      bind_addresses: ['127.0.0.1', host],
      rtc: {
        tcp_port: 7881,
        udp_port: 7882,
        node_ip: host,
        use_external_ip: false,
        ips: { includes: [`${host}/32`] },
      },
      keys: { [this.apiKey]: this.apiSecret },
      room: { max_participants: 2, empty_timeout: 60 },
    }), { mode: 0o600 });
    const executable = path.join(this.resourcesPath, 'livekit-server');
    try {
      await fs.access(executable, 1);
      await this.launch(executable, configPath);
      await this.listenForPairing();
      return {
        url: 'ws://127.0.0.1:7880',
        token: await this.token('mac-viewer', false),
        pairingAddress: `http://${host}:23456`,
        pairingCode: this.pairingCode,
      };
    } catch (error) {
      await this.stop();
      if (error.code === 'ENOENT') {
        throw new Error('缺少 LiveKit Server，请在 electron 目录运行 npm run setup:livekit');
      }
      throw error;
    }
  }

  launch(executable, configPath) {
    return new Promise((resolve, reject) => {
      let ready = false;
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`LiveKit 启动超时：${output}`)), 15000);
      this.child = spawn(executable, ['--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const read = (data) => {
        output = (output + data.toString()).slice(-4000);
        if (!ready && output.includes('starting LiveKit server')) {
          ready = true;
          clearTimeout(timeout);
          resolve();
        }
      };
      this.child.stdout.on('data', read);
      this.child.stderr.on('data', read);
      this.child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      this.child.once('exit', (code) => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(`LiveKit 启动失败 (${code})：${output}`));
        else if (!this.stopped) {
          this.onStatus(`LiveKit 服务退出 (${code})，请重新开始投屏`);
          void this.stop();
        }
      });
    });
  }

  async token(identity, publisher) {
    const token = new AccessToken(this.apiKey, this.apiSecret, { identity, ttl: '10m' });
    token.addGrant({
      roomJoin: true,
      room: this.room,
      canPublish: publisher,
      canSubscribe: !publisher,
      canPublishData: publisher,
      ...(publisher ? { canPublishSources: [TrackSource.SCREEN_SHARE] } : {}),
    });
    return token.toJwt();
  }

  listenForPairing() {
    let failures = 0;
    this.server = http.createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json');
      if (request.method !== 'POST' || request.url !== '/pair') {
        response.writeHead(404).end('{}');
        return;
      }
      const supplied = Buffer.from(String(request.headers['x-pairing-code'] || ''));
      const expected = Buffer.from(this.pairingCode);
      if (failures >= 20 || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        failures += 1;
        response.writeHead(403).end('{}');
        return;
      }
      try {
        response.end(JSON.stringify({ url: `ws://${this.host}:7880`, token: await this.token('iphone-publisher', true) }));
        this.onStatus('iPhone 已配对，等待屏幕视频轨道…');
      } catch {
        response.writeHead(500).end('{}');
      }
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(23456, this.host, resolve);
    });
  }

  async stop() {
    this.stopped = true;
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) {
      const child = this.child;
      await new Promise((resolve) => {
        const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        child.kill('SIGTERM');
      });
    }
    this.child = null;
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
  }
}

module.exports = LiveKitSession;
