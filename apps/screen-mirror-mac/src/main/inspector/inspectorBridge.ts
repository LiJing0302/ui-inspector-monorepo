import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import { WebSocketServer, type WebSocket } from 'ws';

import type { InspectorMessage, InspectorNode, InspectorSession } from '@ui-inspector/protocol';

export const INSPECTOR_DEFAULT_PORT = 23459;
const INSPECTOR_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 5000;
const INSPECTOR_PROTOCOL_VERSION = 1;
const INSPECTOR_TOKEN = process.env['UI_INSPECTOR_TOKEN'] || '';

export interface InspectorBridgeStatus {
  running: boolean;
  host: string;
  port: number;
  runtimeConnected: boolean;
  editorConnected: boolean;
  session: InspectorSession | null;
}

export type InspectorBridgeEvent =
  | { type: 'runtime-ready'; session: InspectorSession }
  | { type: 'node-picked'; requestId: string; nodes: InspectorNode[] }
  | { type: 'highlight-result'; requestId: string; resolution: unknown }
  | { type: 'error'; requestId?: string; code: string; message: string };

interface Client {
  socket: WebSocket;
  kind: 'runtime' | 'editor';
}

interface PendingPick {
  resolve: (nodes: InspectorNode[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Localhost WebSocket router between the RN runtime, the Mac renderer and VS Code. */
export class InspectorBridge {
  onEvent: (event: InspectorBridgeEvent) => void = () => {};

  private server: Server | null = null;
  private clients = new Set<Client>();
  private pendingPicks = new Map<string, PendingPick>();
  private session: InspectorSession | null = null;
  private port = INSPECTOR_DEFAULT_PORT;

  status(): InspectorBridgeStatus {
    return {
      running: this.server !== null,
      host: INSPECTOR_HOST,
      port: this.port,
      runtimeConnected: [...this.clients].some((client) => client.kind === 'runtime'),
      editorConnected: [...this.clients].some((client) => client.kind === 'editor'),
      session: this.session,
    };
  }

  async start(port = INSPECTOR_DEFAULT_PORT): Promise<InspectorBridgeStatus> {
    if (this.server) return this.status();
    const server = createServer((_request, response) => {
      response.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('UI Inspector only accepts WebSocket connections');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (client) => this.attach(client));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, INSPECTOR_HOST);
    });
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : port;
    this.server = server;
    return this.status();
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingPicks.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('InspectorBridge stopped'));
    }
    this.pendingPicks.clear();
    for (const client of this.clients) client.socket.close();
    this.clients.clear();
    this.session = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async pick(point: { x: number; y: number; width: number; height: number }): Promise<void> {
    const runtime = this.clientOf('runtime');
    if (!runtime) throw new Error('React Native Inspector 未连接');
    const requestId = randomBytes(12).toString('hex');
    const message: InspectorMessage = { type: 'pick', requestId, ...point };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPicks.delete(requestId);
        reject(new Error('等待 React Native 节点响应超时'));
      }, REQUEST_TIMEOUT_MS);
      this.pendingPicks.set(requestId, {
        resolve: () => resolve(),
        reject,
        timer,
      });
      this.send(runtime, message);
    });
  }

  clear(): void {
    this.sendTo('runtime', { type: 'clear-highlight' });
  }

  private attach(socket: WebSocket): void {
    const client: Client = { socket, kind: 'editor' };
    this.clients.add(client);
    socket.on('message', (data) => this.onMessage(client, data.toString()));
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
    if (this.session) this.send(client, { type: 'runtime-ready', session: this.session });
  }

  private onMessage(client: Client, raw: string): void {
    let message: InspectorMessage;
    try {
      message = JSON.parse(raw) as InspectorMessage;
    } catch {
      this.sendError(client, 'INVALID_JSON', 'Inspector 消息不是有效 JSON');
      return;
    }
    if (message.type === 'hello') {
      if (message.protocol !== INSPECTOR_PROTOCOL_VERSION) {
        this.sendError(client, 'PROTOCOL_MISMATCH', `不支持协议版本 ${message.protocol}`);
        client.socket.close();
        return;
      }
      if (INSPECTOR_TOKEN && message.token !== INSPECTOR_TOKEN) {
        this.sendError(client, 'AUTH_FAILED', 'Inspector token 不正确');
        client.socket.close();
        return;
      }
      client.kind = message.appId === 'vscode-extension' ? 'editor' : 'runtime';
      if (client.kind === 'runtime') {
        for (const other of [...this.clients]) {
          if (other !== client && other.kind === 'runtime') other.socket.close();
        }
      }
      return;
    }
    if (message.type === 'runtime-ready') {
      if (client.kind !== 'runtime') return;
      this.session = message.session;
      this.broadcast({ type: 'runtime-ready', session: message.session });
      this.onEvent({ type: 'runtime-ready', session: message.session });
      return;
    }
    if (message.type === 'node-picked') {
      const pending = this.pendingPicks.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPicks.delete(message.requestId);
        pending.resolve(message.nodes);
      }
      if (message.nodes[0]) {
        this.broadcast({
          type: 'open-source',
          requestId: message.requestId,
          source: message.nodes[0].source,
          instanceCount: message.nodes.length,
        });
      }
      this.onEvent({ type: 'node-picked', requestId: message.requestId, nodes: message.nodes });
      return;
    }
    if (message.type === 'highlight-source') {
      this.sendTo('runtime', message);
      return;
    }
    if (message.type === 'clear-highlight') {
      this.sendTo('runtime', message);
      return;
    }
    if (message.type === 'highlight-result') {
      this.sendTo('editor', message);
      this.onEvent({ type: 'highlight-result', requestId: message.requestId, resolution: message.resolution });
    }
  }

  private clientOf(kind: Client['kind']): Client | undefined {
    return [...this.clients].find((client) => client.kind === kind);
  }

  private sendTo(kind: Client['kind'], message: InspectorMessage): void {
    const client = this.clientOf(kind);
    if (client) this.send(client, message);
  }

  private broadcast(message: InspectorMessage): void {
    for (const client of this.clients) this.send(client, message);
  }

  private send(client: Client, message: InspectorMessage): void {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(message));
  }

  private sendError(client: Client, code: string, message: string): void {
    this.send(client, { type: 'error', code, message });
  }
}
