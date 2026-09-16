import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AccessToken, TrackSource } from 'livekit-server-sdk';

import type { IPhoneSession } from '../types/ipc';

/** 配对失败锁定阈值：错误 20 次后需 Mac 重新开始 */
const MAX_PAIRING_FAILURES = 20;
/** 服务启动超时（毫秒） */
const LAUNCH_TIMEOUT_MS = 15_000;

/**
 * iPhone 投屏会话：起本地 livekit-server 子进程 + 配对 HTTP 服务 + JWT 签发。
 *
 * 安全边界（见 README）：每次开始随机房间 / 密钥 / 配对码，
 * 密钥只落在 0600 临时目录，停止即删，不写入源码、不传给 iPhone。
 */
export class LiveKitSession {
  private readonly resourcesPath: string;

  onStatus: (text: string) => void = () => {};

  private stopped = false;
  private child: ChildProcess | null = null;
  private server: http.Server | null = null;
  private directory: string | null = null;

  private room = '';
  private apiKey = '';
  private apiSecret = '';
  private pairingCode = '';
  private host = '';

  constructor(resourcesPath: string) {
    this.resourcesPath = resourcesPath;
  }

  async start(host: string): Promise<IPhoneSession> {
    if (net.isIP(host) !== 4 || host === '0.0.0.0' || host.startsWith('127.')) {
      throw new Error('请选择 iPhone 可以访问的 Mac 局域网 IPv4 地址');
    }

    this.room = `mirror-${crypto.randomUUID()}`;
    this.apiKey = crypto.randomBytes(16).toString('hex');
    this.apiSecret = crypto.randomBytes(32).toString('hex');
    this.pairingCode = crypto.randomBytes(6).toString('hex');
    this.host = host;

    this.directory = await mkdtemp(path.join(os.tmpdir(), 'screen-mirror-'));
    const configPath = path.join(this.directory, 'livekit.json');
    await writeFile(
      configPath,
      JSON.stringify({
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
      }),
      { mode: 0o600 },
    );

    const executable = path.join(this.resourcesPath, 'livekit-server');
    try {
      await access(executable, constants.X_OK);
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
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new Error('缺少 LiveKit Server，请在 electron 目录运行 npm run setup:livekit');
      }
      throw error;
    }
  }

  private launch(executable: string, configPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let ready = false;
      let output = '';
      const timeout = setTimeout(
        () => reject(new Error(`LiveKit 启动超时：${output}`)),
        LAUNCH_TIMEOUT_MS,
      );

      this.child = spawn(executable, ['--config', configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const read = (data: Buffer): void => {
        output = (output + data.toString()).slice(-4000);
        if (!ready && output.includes('starting LiveKit server')) {
          ready = true;
          clearTimeout(timeout);
          resolve();
        }
      };

      this.child.stdout?.on('data', read);
      this.child.stderr?.on('data', read);
      this.child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.child.once('exit', (code) => {
        clearTimeout(timeout);
        if (!ready) {
          reject(new Error(`LiveKit 启动失败 (${code})：${output}`));
        } else if (!this.stopped) {
          this.onStatus(`LiveKit 服务退出 (${code})，请重新开始投屏`);
          void this.stop();
        }
      });
    });
  }

  private async token(identity: string, publisher: boolean): Promise<string> {
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

  private listenForPairing(): Promise<void> {
    let failures = 0;

    this.server = http.createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json');

      if (request.method !== 'POST' || request.url !== '/pair') {
        response.writeHead(404).end('{}');
        return;
      }

      const supplied = Buffer.from(String(request.headers['x-pairing-code'] ?? ''));
      const expected = Buffer.from(this.pairingCode);
      if (
        failures >= MAX_PAIRING_FAILURES ||
        supplied.length !== expected.length ||
        !crypto.timingSafeEqual(supplied, expected)
      ) {
        failures += 1;
        response.writeHead(403).end('{}');
        return;
      }

      this.token('iphone-publisher', true)
        .then((token) => {
          response.end(JSON.stringify({ url: `ws://${this.host}:7880`, token }));
          this.onStatus('iPhone 已配对，等待屏幕视频轨道…');
        })
        .catch(() => {
          response.writeHead(500).end('{}');
        });
    });

    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;

    return new Promise((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(23456, this.host, resolve);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }

    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    this.child = null;

    if (this.directory) {
      await rm(this.directory, { recursive: true, force: true });
      this.directory = null;
    }
  }
}

export default LiveKitSession;
