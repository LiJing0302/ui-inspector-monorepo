import { Dimensions, findNodeHandle, NativeModules, UIManager } from 'react-native';

import type {
  InspectorInstance,
  InspectorMessage,
  InspectorNode,
  SourceRef,
  SourceResolution,
} from '@ui-inspector/protocol';

const INSPECTOR_PROTOCOL_VERSION = 1;
const DEFAULT_REFRESH_INTERVAL_MS = 250;
const SOURCE_MARKER = '__uiInspectorSource';

type Fiber = {
  tag?: number;
  key?: string | null;
  index?: number;
  type?: unknown;
  elementType?: unknown;
  stateNode?: unknown;
  return?: Fiber | null;
  child?: Fiber | null;
  sibling?: Fiber | null;
  memoizedProps?: Record<string, unknown> | null;
  pendingProps?: Record<string, unknown> | null;
  _debugOwner?: Fiber | null;
  _debugSource?: unknown;
};

type FiberRoot = { current: Fiber };

type DevToolsHook = {
  onCommitFiberRoot?: (...args: unknown[]) => void;
  onCommitFiberUnmount?: (...args: unknown[]) => void;
  _fiberRoots?: Map<number, Set<FiberRoot>>;
};

declare global {
  // React DevTools exposes this hook in development builds. It is intentionally optional so the
  // SDK remains a no-op in release builds and on RN versions that do not install DevTools.
  var __REACT_DEVTOOLS_GLOBAL_HOOK__: DevToolsHook | undefined;
}

export interface UiInspectorOptions {
  appId?: string;
  host?: string;
  port?: number;
  token?: string;
  projectRootHash?: string;
  refreshIntervalMs?: number;
}

export type UiInspectorStatus = 'stopped' | 'connecting' | 'connected' | 'unavailable';

interface RegistryEntry {
  source: SourceRef;
  nativeTag: number;
  fiber: Fiber;
  instance: InspectorInstance;
}

interface NativeInspectorModule {
  setInspectorHighlights?: (nativeTags: number[]) => void;
  clearInspectorHighlights?: () => void;
}

const nativeInspector = NativeModules.UiAcceptanceModule as NativeInspectorModule | undefined;

function sourceMarker(fiber: Fiber): SourceRef | null {
  const props = fiber.memoizedProps || fiber.pendingProps;
  const value = props?.[SOURCE_MARKER] || fiber._debugSource || props?.__source;
  if (!value || typeof value !== 'object') return null;
  const marker = value as Partial<SourceRef>;
  if (
    typeof marker.sourceId !== 'string' ||
    typeof marker.relativePath !== 'string' ||
    typeof marker.startLine !== 'number' ||
    typeof marker.startColumn !== 'number' ||
    typeof marker.endLine !== 'number' ||
    typeof marker.endColumn !== 'number' ||
    typeof marker.displayName !== 'string' ||
    (marker.role !== undefined && marker.role !== 'host' && marker.role !== 'instance' && marker.role !== 'component')
  ) {
    return null;
  }
  return {
    ...(marker as SourceRef),
    role: marker.role || (/^[a-z]/.test(marker.displayName) ? 'host' : 'instance'),
  };
}

function componentName(fiber: Fiber): string | null {
  const value = fiber.elementType || fiber.type;
  if (typeof value === 'string') return value;
  if (typeof value === 'function' && value.name) return value.name;
  if (value && typeof value === 'object' && 'displayName' in value) {
    const displayName = (value as { displayName?: unknown }).displayName;
    return typeof displayName === 'string' ? displayName : null;
  }
  return null;
}

function hostFiber(fiber: Fiber): Fiber | null {
  // HostComponent is tag 5 in both the Paper and Fabric Fiber implementations. The tag check
  // avoids treating a composite's function/class stateNode as a native view.
  if (fiber.tag === 5) return fiber;
  for (let child = fiber.child; child; child = child.sibling) {
    const host = hostFiber(child);
    if (host) return host;
  }
  return null;
}

function nativeTagFor(fiber: Fiber): number | null {
  const host = hostFiber(fiber);
  if (!host) return null;
  const handle = findNodeHandle(host.stateNode as Parameters<typeof findNodeHandle>[0]);
  return typeof handle === 'number' && handle > 0 ? handle : null;
}

function rootFromHook(hook: DevToolsHook): FiberRoot[] {
  const roots: FiberRoot[] = [];
  for (const rendererRoots of hook._fiberRoots?.values() || []) {
    for (const root of rendererRoots) roots.push(root);
  }
  return roots;
}

function containsSource(source: SourceRef, line: number, column: number): boolean {
  const afterStart = line > source.startLine || (line === source.startLine && column >= source.startColumn);
  const beforeEnd = line < source.endLine || (line === source.endLine && column <= source.endColumn);
  return afterStart && beforeEnd;
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function measureNativeTag(nativeTag: number): Promise<{ x: number; y: number; width: number; height: number }> {
  return new Promise((resolve) => {
    try {
      UIManager.measure(nativeTag, (_x, _y, width, height, pageX, pageY) => {
        resolve({
          x: Number(pageX) || 0,
          y: Number(pageY) || 0,
          width: Math.max(0, Number(width) || 0),
          height: Math.max(0, Number(height) || 0),
        });
      });
    } catch {
      resolve({ x: 0, y: 0, width: 0, height: 0 });
    }
  });
}

export class UiInspector {
  private socket: WebSocket | null = null;
  private hook: DevToolsHook | null = null;
  private previousCommit: ((...args: unknown[]) => void) | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private roots = new Set<FiberRoot>();
  private entries: RegistryEntry[] = [];
  private sessionId: string | null = null;
  private announcedProjectRootHash: string | undefined;
  private hasAnnouncedRuntimeReady = false;
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
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) {
      this._status = 'unavailable';
      return false;
    }

    this._status = 'connecting';
    this.installHook(hook);
    this.refreshRegistry();
    this.refreshTimer = setInterval(
      () => this.refreshRegistry(),
      Math.max(100, this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS),
    );

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
          this._status = 'stopped';
          nativeInspector?.clearInspectorHighlights?.();
        }
      };
      this.send({
        type: 'hello',
        protocol: INSPECTOR_PROTOCOL_VERSION,
        appId: this.options.appId,
        token: this.options.token,
      });
      this.announceRuntimeReady();
      return true;
    } catch {
      this.socket?.close();
      this.socket = null;
      this._status = 'stopped';
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.restoreHook();
    this.socket?.close();
    this.socket = null;
    this.entries = [];
    this.roots.clear();
    this.sessionId = null;
    this.announcedProjectRootHash = undefined;
    this.hasAnnouncedRuntimeReady = false;
    nativeInspector?.clearInspectorHighlights?.();
    this._status = 'stopped';
  }

  private installHook(hook: DevToolsHook): void {
    this.hook = hook;
    this.previousCommit = hook.onCommitFiberRoot;
    const previous = this.previousCommit;
    hook.onCommitFiberRoot = (...args: unknown[]) => {
      previous?.(...args);
      const root = args[1] as FiberRoot | undefined;
      if (root?.current) this.roots.add(root);
      this.refreshRegistry();
    };
    for (const root of rootFromHook(hook)) this.roots.add(root);
  }

  private restoreHook(): void {
    if (this.hook) {
      this.hook.onCommitFiberRoot = this.previousCommit;
    }
    this.hook = null;
    this.previousCommit = undefined;
  }

  private refreshRegistry(): void {
    const hook = this.hook;
    if (hook) for (const root of rootFromHook(hook)) this.roots.add(root);
    const next: RegistryEntry[] = [];
    for (const root of this.roots) this.collectFiber(root.current, next, 0);
    this.entries = next;
    this.announceRuntimeReady();
  }

  private announceRuntimeReady(): void {
    const projectRootHash = this.options.projectRootHash || this.entries[0]?.source.projectRootHash;
    if (!this.sessionId || this.socket?.readyState !== 1 ||
      (this.hasAnnouncedRuntimeReady && projectRootHash === this.announcedProjectRootHash)) return;
    this.announcedProjectRootHash = projectRootHash;
    this.hasAnnouncedRuntimeReady = true;
    this.send({
      type: 'runtime-ready',
      session: {
        sessionId: this.sessionId,
        appId: this.options.appId,
        projectRootHash,
      },
    });
  }

  private collectFiber(fiber: Fiber | null, output: RegistryEntry[], depth: number): void {
    if (!fiber) return;
    const source = sourceMarker(fiber);
    if (source) {
      const nativeTag = nativeTagFor(fiber);
      if (nativeTag !== null) {
        const chain: string[] = [];
        for (let owner: Fiber | null | undefined = fiber; owner; owner = owner.return) {
          const name = componentName(owner);
          if (name && !chain.includes(name)) chain.push(name);
        }
        output.push({
          source,
          nativeTag,
          fiber,
          instance: {
            instanceId: `${source.sourceId}:${nativeTag}`,
            sourceId: source.sourceId,
            nativeTag,
            bounds: { x: 0, y: 0, width: 0, height: 0 },
            visible: true,
            depth,
            ...(fiber.key == null ? {} : { key: fiber.key }),
            ...(typeof fiber.index === 'number' ? { index: fiber.index } : {}),
            componentName: componentName(fiber) || source.displayName,
            componentChain: chain,
          },
        });
      }
    }
    for (let child = fiber.child; child; child = child.sibling) {
      this.collectFiber(child, output, depth + 1);
    }
  }

  private async measuredEntries(): Promise<RegistryEntry[]> {
    const entries = this.entries;
    await Promise.all(entries.map(async (entry) => {
      const bounds = await measureNativeTag(entry.nativeTag);
      entry.instance.bounds = bounds;
      entry.instance.visible = bounds.width > 0 && bounds.height > 0;
    }));
    return entries.filter((entry) => entry.instance.visible);
  }

  private async pick(message: Extract<InspectorMessage, { type: 'pick' }>): Promise<void> {
    const entries = await this.measuredEntries();
    const candidates = entries
      .filter(({ instance }) => {
        const b = instance.bounds;
        return message.x >= b.x && message.x <= b.x + b.width && message.y >= b.y && message.y <= b.y + b.height;
      })
      .sort((a, b) => {
        const areaA = a.instance.bounds.width * a.instance.bounds.height;
        const areaB = b.instance.bounds.width * b.instance.bounds.height;
        return areaA - areaB || b.instance.depth - a.instance.depth;
      });
    this.send({
      type: 'node-picked',
      requestId: message.requestId,
      nodes: candidates.map(({ source, instance }) => ({ source, instance })),
    });
  }

  private async highlightSource(message: Extract<InspectorMessage, { type: 'highlight-source' }>): Promise<void> {
    const entries = await this.measuredEntries();
    const matching = entries.filter(({ source }) => {
      if (message.source.projectRootHash && source.projectRootHash !== message.source.projectRootHash) return false;
      if (message.source.sourceId && source.sourceId === message.source.sourceId) return true;
      return source.relativePath === message.source.relativePath && containsSource(
        source,
        message.source.startLine,
        message.source.startColumn,
      );
    });
    nativeInspector?.setInspectorHighlights?.(matching.map(({ nativeTag }) => nativeTag));
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
    if (message.type === 'pick') void this.pick(message);
    if (message.type === 'highlight-source') void this.highlightSource(message);
    if (message.type === 'clear-highlight') nativeInspector?.clearInspectorHighlights?.();
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

// Keep the Dimensions import live in older RN bundlers that tree-shake UIManager unexpectedly;
// the runtime uses the window size as a documented fallback for future coordinate adapters.
export function getUiInspectorWindowSize(): { width: number; height: number } {
  return Dimensions.get('window');
}
