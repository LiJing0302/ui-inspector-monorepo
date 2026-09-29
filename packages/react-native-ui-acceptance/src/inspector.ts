import { NativeModules, Platform } from 'react-native';

import type {
  InspectorInstance,
  InspectorMessage,
  InspectorNode,
  SourceRef,
  SourceResolution,
} from '@ui-inspector/protocol';

import UiAcceptanceModule, { type UiAcceptanceNode } from './uiAcceptanceModule';

const INSPECTOR_PROTOCOL_VERSION = 1;

export interface UiInspectorOptions {
  appId?: string;
  host?: string;
  port?: number;
  token?: string;
  projectRootHash?: string;
  /** @deprecated Native source inspection is request-driven and does not poll. */
  refreshIntervalMs?: number;
}

export type UiInspectorStatus = 'stopped' | 'connecting' | 'connected' | 'unavailable';

interface NativeInspectorModule {
  setInspectorSourceHighlights?: (source: SourceRef) => void;
  clearInspectorHighlights?: () => void;
}

const nativeInspector = NativeModules.UiAcceptanceModule as NativeInspectorModule | undefined;

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function containsSource(source: SourceRef, line: number, column: number): boolean {
  const afterStart = line > source.startLine || (line === source.startLine && column >= source.startColumn);
  const beforeEnd = line < source.endLine || (line === source.endLine && column <= source.endColumn);
  return afterStart && beforeEnd;
}

function sourceMatches(source: SourceRef, requested: SourceRef): boolean {
  if (requested.projectRootHash && source.projectRootHash !== requested.projectRootHash) return false;
  if (requested.sourceId) return source.sourceId === requested.sourceId;
  return source.relativePath === requested.relativePath &&
    containsSource(source, requested.startLine, requested.startColumn);
}

function inspectorNode(node: UiAcceptanceNode): InspectorNode | null {
  const source = node.source;
  if (!source) return null;
  const nativeTag = typeof node.nativeTag === 'number' ? node.nativeTag : 0;
  const instance: InspectorInstance = {
    instanceId: `${source.sourceId}:${node.nodeId}`,
    sourceId: source.sourceId,
    nativeTag,
    bounds: {
      x: node.visibleX ?? node.x,
      y: node.visibleY ?? node.y,
      width: node.visibleWidth ?? node.width,
      height: node.visibleHeight ?? node.height,
    },
    visible:
      node.visible &&
      node.hiddenByAncestor !== true &&
      node.width > 0 &&
      node.height > 0,
    depth: node.depth,
    index: node.index,
    componentName: source.displayName,
  };
  return { source, instance };
}

export class UiInspector {
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private options: Required<Pick<UiInspectorOptions, 'appId' | 'host' | 'port' | 'token'>> & UiInspectorOptions = {
    appId: 'react-native-app',
    host: '127.0.0.1',
    port: 23459,
    token: '',
  };
  private _status: UiInspectorStatus = 'stopped';

  get status(): UiInspectorStatus {
    return this._status;
  }

  async start(options: UiInspectorOptions = {}): Promise<boolean> {
    await this.stop();
    this.options = { ...this.options, ...options };
    if (Platform.OS !== 'android' || !nativeInspector?.setInspectorSourceHighlights) {
      this._status = 'unavailable';
      return false;
    }

    this._status = 'connecting';
    try {
      const socket = new WebSocket(`ws://${this.options.host}:${this.options.port}`);
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('InspectorBridge connection failed'));
      });
      this._status = 'connected';
      this.sessionId = randomId('rn');
      socket.onmessage = (event) => this.onMessage(event.data);
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
          this.sessionId = null;
          this._status = 'stopped';
          nativeInspector.clearInspectorHighlights?.();
        }
      };
      this.send({
        type: 'hello',
        protocol: INSPECTOR_PROTOCOL_VERSION,
        appId: this.options.appId,
        token: this.options.token,
      });
      this.send({
        type: 'runtime-ready',
        session: {
          sessionId: this.sessionId,
          appId: this.options.appId,
          projectRootHash: this.options.projectRootHash,
        },
      });
      return true;
    } catch {
      this.socket?.close();
      this.socket = null;
      this._status = 'stopped';
      return false;
    }
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.sessionId = null;
    nativeInspector?.clearInspectorHighlights?.();
    this._status = 'stopped';
  }

  private async mountedNodes(): Promise<InspectorNode[]> {
    const snapshot = await UiAcceptanceModule.capture({ profile: 'source-inspector' });
    return snapshot.nodes
      .map(inspectorNode)
      .filter((node): node is InspectorNode => node !== null && node.instance.visible);
  }

  private async pick(message: Extract<InspectorMessage, { type: 'pick' }>): Promise<void> {
    const nodes = await this.mountedNodes();
    const candidates = nodes
      .filter(({ instance }) => {
        const bounds = instance.bounds;
        return message.x >= bounds.x && message.x <= bounds.x + bounds.width &&
          message.y >= bounds.y && message.y <= bounds.y + bounds.height;
      })
      .sort((a, b) => {
        const areaA = a.instance.bounds.width * a.instance.bounds.height;
        const areaB = b.instance.bounds.width * b.instance.bounds.height;
        return areaA - areaB || b.instance.depth - a.instance.depth;
      });
    this.send({ type: 'node-picked', requestId: message.requestId, nodes: candidates });
  }

  private async highlightSource(
    message: Extract<InspectorMessage, { type: 'highlight-source' }>,
  ): Promise<void> {
    const nodes = await this.mountedNodes();
    const matching = nodes.filter(({ source }) => sourceMatches(source, message.source));
    nativeInspector?.setInspectorSourceHighlights?.(message.source);
    const resolution: SourceResolution = matching.length > 0
      ? {
          status: 'mounted',
          source: matching[0]!.source,
          instances: matching.map(({ instance }) => instance),
        }
      : {
          status: 'not-mounted',
          source: message.source,
          reason: 'condition-false',
        };
    this.send({ type: 'highlight-result', requestId: message.requestId, resolution });
  }

  private onMessage(raw: unknown): void {
    let message: InspectorMessage;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as InspectorMessage;
    } catch {
      return;
    }
    if (message.type === 'pick') {
      void this.pick(message).catch((error) => this.sendError(message.requestId, error));
    }
    if (message.type === 'highlight-source') {
      void this.highlightSource(message).catch((error) => this.sendError(message.requestId, error));
    }
    if (message.type === 'clear-highlight') nativeInspector?.clearInspectorHighlights?.();
  }

  private sendError(requestId: string, error: unknown): void {
    this.send({
      type: 'error',
      requestId,
      code: 'UI_INSPECTOR_NATIVE_CAPTURE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private send(message: InspectorMessage): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }
}

export function createUiInspector(options?: UiInspectorOptions): UiInspector {
  const inspector = new UiInspector();
  if (options) void inspector.start(options);
  return inspector;
}
