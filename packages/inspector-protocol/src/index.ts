export interface SourceRange {
  relativePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type SourceRole = 'instance' | 'component' | 'host';

export interface SourceRef extends SourceRange {
  projectRootHash: string;
  sourceId: string;
  displayName: string;
  role: SourceRole;
}

export interface InspectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InspectorInstance {
  instanceId: string;
  sourceId: string;
  nativeTag: number;
  bounds: InspectorRect;
  visible: boolean;
  depth: number;
  key?: string;
  index?: number;
  componentName?: string;
  componentChain?: string[];
}

export interface InspectorNode {
  instance: InspectorInstance;
  source: SourceRef;
}

export type SourceResolution =
  | { status: 'mounted'; source: SourceRef; instances: InspectorInstance[] }
  | {
      status: 'not-mounted';
      source: SourceRef;
      reason: 'condition-false' | 'route-inactive' | 'virtualized-away';
    };

export const INSPECTOR_PROTOCOL_VERSION = 1;

export interface InspectorSession {
  sessionId: string;
  appId: string;
  projectRootHash?: string;
}

export type InspectorMessage =
  | {
      type: 'hello';
      protocol: number;
      appId: string;
      token: string;
    }
  | { type: 'runtime-ready'; session: InspectorSession }
  | {
      type: 'pick';
      requestId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | { type: 'node-picked'; requestId: string; nodes: InspectorNode[] }
  | { type: 'open-source'; requestId: string; source: SourceRef; instanceCount: number }
  | { type: 'highlight-source'; requestId: string; source: SourceRef }
  | { type: 'highlight-result'; requestId: string; resolution: SourceResolution }
  | { type: 'clear-highlight' }
  | { type: 'error'; requestId?: string; code: string; message: string };

export function sourceRangeContains(range: SourceRange, line: number, column: number): boolean {
  const afterStart = line > range.startLine || (line === range.startLine && column >= range.startColumn);
  const beforeEnd = line < range.endLine || (line === range.endLine && column <= range.endColumn);
  return afterStart && beforeEnd;
}
