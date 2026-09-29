/**
 * Figma 插件导出产物的运行时契约。
 *
 * ⚠️ 权威源在另一个工程：`figma-plugin/src/shared/types.ts`。
 * 本文件是**产物契约的副本**（不含插件内部的 UI 协议），因为两个工程没有 monorepo 关联，
 * 无法直接共享类型。改动插件导出结构时必须同步本文件，并把 FIGMA_SCHEMA_VERSION 对齐。
 *
 * 产物结构（一个文件夹或一个 zip）：
 *   manifest.json                     —— 全部导出单元的索引
 *   schema/<导出单元名>.json           —— 该单元的完整节点树（FrameSchema）
 *   screenshots/<导出单元名>.png       —— 该单元的整图截图
 *   README.md / index.html            —— 说明与可视化预览（可选）
 *
 * 坐标约定（**最关键，写错会导致整个节点层错位**）：
 *   - `rect`    : 相对「**本次导出单元根节点**」左上角，单位 = 设计稿 px（未乘倍率）
 *   - `absRect` : 相对 Figma 页面原点 (0,0) 的绝对坐标
 *   - 渲染到截图上：**截图像素坐标 = rect × manifest.exportScale**
 *
 * 注意「导出单元」不一定是整屏 Frame —— 插件支持元素级导出（在画布上点一个 TEXT
 * 就导出它自己），此时导出单元根节点就是那个元素，其 `rect` 恒为 (0,0,w,h)。
 * 因此 `rect` 只有在「导出单元 = 帧」时才等价于「帧内局部坐标」。
 */

/** 与 `figma-plugin` 产物对齐的 schema 版本；不匹配则拒绝导入 */
export const FIGMA_SCHEMA_VERSION = '1.0.0';

export interface FigmaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 简化后的填充 / 描边 / 阴影，只保留验收对比需要的字段（对应插件 SchemaPaint） */
export interface FigmaPaint {
  /** SOLID | GRADIENT_LINEAR | GRADIENT_RADIAL | IMAGE | ... */
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  /** `#RRGGBB` 或 `#RRGGBBAA`（可能带 alpha，解析需同时支持） */
  color?: string;
  gradientStops?: Array<{ color: string; position: number }>;
  /** 渐变角度（度） */
  gradientAngle?: number;
  /** 图片填充的 hash；**注意：有 IMAGE 填充不代表这里有值，插件可能不导出** */
  imageHash?: string;
  scaleMode?: string;
}

export interface FigmaEffect {
  /** DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR */
  type: string;
  visible?: boolean;
  color?: string;
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
}

export interface FigmaText {
  characters: string;
  fontFamily?: string;
  /** 字体粗细是**字符串**（如 `"Medium"` / `"Bold"`），Figma 导出**没有 fontWeight 数值字段** */
  fontStyle?: string;
  fontSize?: number;
  /** `"AUTO"` 或数值 */
  lineHeight?: number | string;
  letterSpacing?: number | string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textDecoration?: string;
  textCase?: string;
  textAutoResize?: string;
  /** 首段文字颜色 */
  color?: string;
  lineCount?: number;
}

export interface FigmaLayout {
  /** NONE | HORIZONTAL | VERTICAL */
  mode: string;
  direction?: string;
  gap?: number;
  counterAxisGap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  alignItems?: string;
  justifyContent?: string;
  wrap?: string;
  clipsContent?: boolean;
}

export interface FigmaNode {
  id: string;
  name: string;
  /** FRAME | TEXT | RECTANGLE | INSTANCE | COMPONENT | GROUP | VECTOR | ELLIPSE | BOOLEAN_OPERATION ... */
  type: string;
  /** 层级路径，如 `"首页/Header/标题"`，起点是导出单元根节点 */
  path: string;
  depth: number;
  /**
   * 在父节点 children 数组中的序号。
   * ⚠️ Figma 的 children 是 **back-to-front**：0 = 最底层，序号越大越靠上。
   * DOM 里**按数组顺序依次渲染**即可复刻叠放；跳过隐藏节点时该序号**不压缩**。
   */
  index?: number;
  /**
   * 是否有可见填充 —— 精确说是**画不画得出像素**（fills/strokes 中存在可见且不透明的
   * paint）。插件侧算好存下来，字段可能缺失（旧导出）。
   *
   * ⚠️ 它**不直接等于**画布命中：命中看 `RenderNode.hittable`（`designNodeHittable`），
   * 那里是「容器一律按盒命中、图形类才看像素」。这里保留它是给验收引擎判
   * `layoutOnly` 与信息面板展示用。
   *
   * ⚠️⚠️ 也别反过来拿它推命中：插件算的是 `可见填充 || 可见描边`，于是「填充被隐藏 +
   * 只剩 1.5px 描边」的节点 hasFill 也是 true，而描边只画在边缘那一圈 —— 拿整盒当命中区
   * 会吃掉底下所有元素（实测 99.1% 的采样点）。判据一律走 `designNodeHittable`。
   */
  hasFill?: boolean;
  /** 超出最近的 clipsContent 祖先边界，Figma 中这部分已被裁掉（看不见也点不中） */
  clipped?: boolean;
  visible: boolean;
  locked?: boolean;
  /** 相对**导出单元根节点**的矩形（设计稿 px） */
  rect: FigmaRect;
  /** 绝对坐标（页面坐标） */
  absRect?: FigmaRect;
  /** absRect 缺失时用估算值填充，仅作参考 */
  rectEstimated?: boolean;
  opacity?: number;
  rotation?: number;
  blendMode?: string;
  cornerRadius?: number | number[];
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: FigmaEffect[];
  text?: FigmaText;
  layout?: FigmaLayout;
  constraints?: { horizontal: string; vertical: string };
  component?: {
    kind: 'COMPONENT' | 'INSTANCE' | 'COMPONENT_SET';
    mainComponentId?: string;
    mainComponentName?: string;
  };
  children?: FigmaNode[];
}

/** 单个导出单元的完整产物（`schema/<名>.json` 的顶层） */
export interface FigmaFrameSchema {
  schemaVersion: string;
  frameId: string;
  frameName: string;
  pageId: string;
  pageName: string;
  /** 导出单元的逻辑尺寸（设计稿 px） */
  width: number;
  height: number;
  /** 截图倍率：截图像素坐标 = rect × exportScale */
  exportScale: number;
  /** 截图在包内的相对路径 */
  screenshot: string;
  backgroundColor?: string;
  nodeCount: number;
  exportedAt: string;
  /** 根节点自身即 tree */
  tree: FigmaNode;
  /** 根节点类型；精确到元素导出时不再是容器 */
  rootType: string;
  /** 根节点在所属页面里的层级路径 */
  rootPath: string;
}

/** `manifest.json` 里 frames[] 的每一项 */
export interface FigmaFrameMeta {
  id: string;
  name: string;
  /** 根节点类型：FRAME / TEXT / INSTANCE ... */
  type: string;
  /** 页面级全路径，用于消歧同名节点 */
  path: string;
  pageId: string;
  pageName: string;
  /** 逻辑尺寸 */
  width: number;
  height: number;
  screenshot: string;
  schemaFile: string;
  nodeCount: number;
}

export interface FigmaManifest {
  schemaVersion: string;
  generator: string;
  exportedAt: string;
  /** ⚠️ 实测样本为 `null`，**不可依赖**；唯一键请用 `pageId + frame.id` */
  fileKey: string | null;
  fileName: string;
  exportScale: number;
  imageFormat: 'PNG' | 'JPG' | string;
  frames: FigmaFrameMeta[];
}

/**
 * 判断某个导出单元是否「帧级」（可作为整页设计稿参与页面匹配）。
 * 元素级导出（点选一个 TEXT/RECTANGLE 导出它自己）不适合当整页设计稿。
 */
export function isFrameLevelExport(rootType: string): boolean {
  return rootType === 'FRAME' || rootType === 'COMPONENT' || rootType === 'COMPONENT_SET' || rootType === 'SECTION';
}
