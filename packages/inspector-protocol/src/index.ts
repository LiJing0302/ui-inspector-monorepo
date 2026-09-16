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

