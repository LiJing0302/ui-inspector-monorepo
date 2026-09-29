/**
 * 插件主线程与 UI 之间、以及导出产物中使用的共享类型。
 *
 * 坐标约定（重要）：
 *  - rect    : 相对于「设计稿根节点」左上角的坐标，单位 = 设计稿 px（未乘截图倍率）
 *  - absRect : 相对于 Figma 页面原点(0,0)的绝对坐标，用于跨设计稿定位
 *  - 渲染时：截图像素坐标 = rect * exportScale
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 简化后的填充 / 描边 / 阴影，只保留验收对比需要的字段 */
export interface SchemaPaint {
  type: string; // SOLID | GRADIENT_LINEAR | GRADIENT_RADIAL | IMAGE | ...
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  /** #RRGGBB 或 #RRGGBBAA */
  color?: string;
  /** 渐变停靠点（仅渐变时存在） */
  gradientStops?: Array<{ color: string; position: number }>;
  /** 渐变角度（度），由 gradientTransform 归一化而来 */
  gradientAngle?: number;
  /** 图片填充的 hash（可用 Figma API 换取图片） */
  imageHash?: string;
  scaleMode?: string;
}

export interface SchemaEffect {
  type: string; // DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR
  visible?: boolean;
  color?: string;
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
}

export interface SchemaText {
  characters: string;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  lineHeight?: number | string;
  letterSpacing?: number | string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textDecoration?: string;
  textCase?: string;
  textAutoResize?: string;
  /** 首段文字颜色，方便直接做色值对比 */
  color?: string;
  /** 行数（按换行符估算） */
  lineCount?: number;
}

export interface SchemaLayout {
  mode: string; // NONE | HORIZONTAL | VERTICAL
  direction?: string;
  gap?: number;
  counterAxisGap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  alignItems?: string;
  justifyContent?: string;
  wrap?: string;
  clipsContent?: boolean;
}

export interface SchemaNode {
  /** Figma node id，验收平台可与 App 侧的映射表对齐 */
  id: string;
  name: string;
  /** FRAME / TEXT / RECTANGLE / INSTANCE / COMPONENT ... */
  type: string;
  /** 层级路径，如 "首页/Header/标题" */
  path: string;
  depth: number;
  /**
   * 在父节点 children 数组中的序号。Figma 的 children 是 back-to-front：
   * 0 = 最底层，序号越大越靠上。DOM 里按数组顺序依次渲染即可复刻 Figma 的叠放。
   */
  index?: number;
  /**
   * 是否有可见填充（fills / strokes 中存在 visible 且 alpha > 0 的 paint）。
   * Figma 的画布点击只对"有像素"的区域命中，无填充的节点在画布上点不到，
   * HTML 侧要对齐就得给它 pointer-events: none。
   */
  hasFill?: boolean;
  /** 超出最近的 clipsContent 祖先边界，Figma 中这部分被裁掉（既看不见也点不中） */
  clipped?: boolean;
  visible: boolean;
  locked?: boolean;
  /** 相对于设计稿根节点的矩形（设计稿 px） */
  rect: Rect;
  /** 绝对坐标（页面坐标） */
  absRect?: Rect;
  /** absRect 缺失时用估算值填充，仅作参考 */
  rectEstimated?: boolean;
  opacity?: number;
  rotation?: number;
  blendMode?: string;
  cornerRadius?: number | number[];
  fills?: SchemaPaint[];
  strokes?: SchemaPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: SchemaEffect[];
  text?: SchemaText;
  layout?: SchemaLayout;
  constraints?: { horizontal: string; vertical: string };
  component?: {
    kind: 'COMPONENT' | 'INSTANCE' | 'COMPONENT_SET';
    /** 主组件 id（INSTANCE） */
    mainComponentId?: string;
    mainComponentName?: string;
  };
  children?: SchemaNode[];
}

/** 单个设计稿的完整 Schema 产物 */
export interface FrameSchema {
  schemaVersion: string;
  frameId: string;
  frameName: string;
  pageId: string;
  pageName: string;
  /** 设计稿尺寸（设计稿 px） */
  width: number;
  height: number;
  /** 截图倍率，渲染时 rect * exportScale = 截图像素坐标 */
  exportScale: number;
  /** 截图在 zip 内的相对路径 */
  screenshot: string;
  /** 背景色（设计稿根节点的第一个纯色填充） */
  backgroundColor?: string;
  nodeCount: number;
  exportedAt: string;
/** 根节点自身即 tree */
  tree: SchemaNode;
  /** 根节点类型：FRAME / COMPONENT / TEXT / RECTANGLE ...（精确到元素导出时不再是容器） */
  rootType: string;
  /** 根节点在所属页面里的层级路径，如 "首页/Header/标题" */
  rootPath: string;
}

export interface FrameMeta {
  id: string;
  name: string;
  /** 根节点类型：FRAME / TEXT / INSTANCE ... */
  type: string;
  /** 层级路径，如 "首页/Header/标题"，元素级导出时用于消歧同名节点 */
  path: string;
  pageId: string;
  pageName: string;
  width: number;
  height: number;
  screenshot: string;
  schemaFile: string;
  nodeCount: number;
}

export interface ExportManifest {
  schemaVersion: string;
  generator: string;
  exportedAt: string;
  fileKey: string | null;
  fileName: string;
  exportScale: number;
  imageFormat: 'PNG' | 'JPG';
  frames: FrameMeta[];
}

/* ------------------------------ UI 协议 ------------------------------ */

export interface FrameBrief {
  id: string;
  name: string;
  /** FRAME / TEXT / RECTANGLE / INSTANCE ... */
  type: string;
  /** 层级路径，如 "首页/Header/标题" */
  path: string;
  width: number;
  height: number;
}

/** 画布点选内部的图层时，导出目标取「图层本身」还是「它所属的最近容器」 */
export type SelectionGranularity = 'element' | 'frame';

export interface PageBrief {
  id: string;
  name: string;
  frames: FrameBrief[];
}

export interface ExportOptions {
  frameIds: string[];
  scale: number;
  format: 'PNG' | 'JPG';
  withScreenshot: boolean;
  includeHidden: boolean;
  includeImageFills: boolean;
  includeNestedFrames: boolean; // 扫描时是否把嵌套 Frame 也作为设计稿候选
  includePreview: boolean; // 产物中是否带 index.html 预览页
}

export type PluginToUIMessage =
  | { type: 'SCAN_RESULT'; pages: PageBrief[]; selection: FrameBrief[]; fileName: string; error?: string }
  | { type: 'SELECTION_CHANGED'; frames: FrameBrief[]; rawCount: number }
  | { type: 'EXPORT_PROGRESS'; current: number; total: number; label: string }
  | { type: 'EXPORT_DONE'; data: Uint8Array; fileName: string; frameCount: number; bytes: number }
  | { type: 'EXPORT_ERROR'; message: string }
  | { type: 'LOG'; level: 'info' | 'warn' | 'error'; message: string };

export type UIToPluginMessage =
  | { type: 'SCAN'; includeNestedFrames: boolean; granularity: SelectionGranularity }
  | { type: 'SET_GRANULARITY'; value: SelectionGranularity }
  | { type: 'EXPORT'; options: ExportOptions }
  | { type: 'CANCEL' }
  | { type: 'NOTIFY'; message: string };
