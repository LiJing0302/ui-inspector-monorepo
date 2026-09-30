import React, { useState } from 'react';

import type { AppNode, AppNodeCorners, AppNodeSides, DesignNode, IssueSeverity } from '@shared/verify';
import { appBorderChannel, appCornerChannel, designNodeFontStyle, formatAppCorners, formatAppEdgeColors, formatAppSides } from '@shared/verify';
import type { FigmaPaint } from '@shared/figma';
import type { CanvasCapture, SaveIssueInput } from '@shared/ipc';
// 对比表的**纯逻辑**在 `lib/comparison.ts`（与 `lib/stack.ts` 同层，可被冒烟直接测行为）。
// 这里是它唯一的消费方：本文件只负责把这些字段渲染成人能看的表格。
import {
  alignNotes,
  appLengthOrigin,
  buildCompareFields,
  cornerRadiusLabel,
  paintLabel,
  sameCompareValue,
  scaleAppCorners,
  scaleAppLength,
  scaleAppSides,
  soleValue,
  type AlignBasis,
  type AppAlignContext,
  type CompareField,
  type CompareValue,
} from '../lib/comparison';
// 手势提示与画布底部那条键位提示条**同一份来源**（`lib/shortcuts.ts`）。
// 不在这里另写一份：2026-09-22 把 ⌘ 从「选整帧」换成「固定间距」之后，
// 本文件里两处提示只改了一处，另一处挂着错的说法挂了六天（见该模块的注释）。
// 2026-09-28 又删掉 ⌥ 选整帧 / Enter 进子节点 / 右键菜单，同一份来源让这次改一处就够。
import { GESTURE_HINT } from '../lib/shortcuts';
// 「App 物理像素」那一块的全部逻辑（投影走 `@shared/pixelTransform`，与验收判定同源）。
// 本文件只负责把它的返回值排成表 —— 与 `lib/comparison.ts` 同一套分工。
// ⚠️ 09-29 那块同名的对照表（`PixelBlock`）09-30 已移除，但**这一层仍在使用**：口径切到
// 「设计稿 → App」时，两侧 render 的宽/高/左/上要走 `designPixelEdges` / `appPixelRect`，
// 标量（圆角 / 描边 / 字号）走 `designLengthToAppPixels` / `appLengthToPixels`，
// `appPixelOrigin` 给「这个数怎么来的」那行 title。一律从这里取，组件里不许有第二份乘法。
import {
  PIXEL_ACTUAL_TITLE,
  PIXEL_RECT_MISSING_TITLE,
  appLengthToPixels,
  appPixelOrigin,
  appPixelRect,
  designLengthToAppPixels,
  designPixelEdges,
  pixelProjectionOf,
  type PixelProjection,
} from '../lib/pixelProjection';

/** 选中的节点：来源与原始节点绑定，面板据此决定展示哪些字段 */
export type SelectedNode =
  | { source: 'design'; node: DesignNode }
  | { source: 'app'; node: AppNode };

/**
 * 重合组里的一层（见 `lib/stack.ts`）。
 *
 * `members` 是**从下到上**（绘制序）—— 面板显示时反过来，对上「我点的那个画在最上面」
 * 的直觉。（原先还要求与右键图层菜单同序，那个菜单 2026-09-28 已移除。）
 */
export interface StackMemberView {
  id: string;
  /** 列表里的名字：App 侧是短类名，设计稿侧是图层名 */
  name: string;
  /** 这一层有什么（圆角 / 背景 / 描边）—— 决定用户要不要切过去看 */
  hint: string;
}

/** 与选中项**几何完全重合**的兄弟层。长度 ≤1 时面板整块不画（绝大多数节点没有） */
export interface StackView {
  /** 当前选中的那一层（`members` 里的某个 id） */
  selectedId: string;
  members: StackMemberView[];
}

/**
 * 单选时展示当前节点详情；设计稿与 App 同时选中时展示字段对齐的差异。
 *
 * 2026-09-22 之前这里还有 `chain` / `contextId` / `onPickAncestor` 三个 props，
 * 它们只服务「层级」面包屑（点某一格跳到那一层）。面包屑两侧都不再画之后它们全成了
 * 死参数，一并删掉。换节点仍然有两条路，且都在画布那一侧：**原地再点上移一层**、
 * **Esc 上移一层** —— 面板只剩「告诉用户这两条路存在」的职责（见 `GESTURE_HINT`）。
 */
interface NodeInfoPanelProps {
  visible: boolean;
  selected: SelectedNode | null;
  comparison?: { design: DesignNode; app: AppNode } | null;
  spacingActive: boolean;
  requirementId: string;
  pairId: string;
  designNodeId: string | null;
  appNodeId: string | null;
  onIssueSaved: () => void;
  onCaptureCanvas: () => Promise<CanvasCapture>;
  /**
   * 与选中项几何完全重合的兄弟层（2026-09-28 加）。
   *
   * 起因：一个按钮在原生树里常是两层（外观 + 内容），圆角记在**下面**那层，而画布点选
   * 永远命中上面那层 —— 验收同学看到的是「明明有圆角、面板一行都没有」，且毫无头绪。
   * 这里把那一簇列出来，并把样式聚合成一份（聚合在 `lib/stack.ts`，**数据层零改动**）。
   */
  stack?: StackView | null;
  /** 点了列表里的另一层：换本侧选中（另一侧的槽不动，与画布单击同一条规则） */
  onPickStackLayer?: (id: string) => void;
  /**
   * App 侧长度读数换算进**设计稿基准**的上下文（`design.width / app.width` + 两侧宽度 + 像素比，
   * 2026-09-28 加）。
   *
   * `scale` 与画布上截图的对齐缩放同源（`CanvasBoard#appAlignScale`）：面板里「宽度 / 高度 /
   * 圆角 / 描边宽度 / 字号 / 行高 / 字距」都乘它之后再与设计稿比。不这么做，iPhone 402pt 配 375
   * 设计稿时尺寸类字段平均差 3.92pt，几乎全判「不同」—— 画布明明是对齐的。
   *
   * `designWidth` / `appWidth` / `pixelRatio` **不参与换算**（有 `scale` 就够），是给
   * 「这个读数是怎么来的」那段说明用的：`× 375 / 402` 比 `× 0.9328` 好读，像素比则让
   * `8.67 = 26 / 3` 这种来历写得出来。缺省时面板不显示那段说明。
   */
  appAlign?: AppAlignContext;
  /**
   * 读数口径（2026-09-29 加，见 `lib/comparison.ts#AlignBasis`）。
   *
   * 它只决定**面板里的长度读数用哪把尺子**，不影响对比表的判定，也不动画布的空间对齐。
   * 缺省 `'design'`（现状）：设计稿是基准，App 侧换算回设计单位。
   */
  alignBasis?: AlignBasis;
  /** 切换读数口径。缺省时不画那个切换器（面板在别处被复用时不至于凭空多一个死按钮）。 */
  onAlignBasisChange?: (next: AlignBasis) => void;
}

interface IssueContext {
  source: SaveIssueInput['source'];
  designNodeId: string | null;
  appNodeId: string | null;
}

/**
 * 字段行：`标签` + `值`，**整行一条**（2026-09-30 第二版定调）。
 *
 * ⚠️ 09-30 上午先是「组卡片」，随后收敛成「小节标题 + 两列网格」，这版按用户最终要求
 * **全部打平**：不再按尺寸 / 文本 / 背景 / 边框分块、也不两列并排 —— 所有字段都是
 * `宽度 22` / `高度 120` 这样的单行样式项（diff 时同一行再并上另一侧的值）。
 *
 * `title` 只在**显示值被换算过**时给（见 `renderApp` 的 `len`）：显示的是设计稿基准的值，
 * 而开发改代码要的是真机上量到的那个数 —— 换算值在真机上并不存在，不给退路就等于藏了它。
 */
const Row: React.FC<{ label: string; value: React.ReactNode; title?: string }> = ({ label, value, title }) => {
  const empty = value === null || value === undefined || value === '';
  const display =
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : value;
  return (
    <div className="info-row">
      <div className="row-key">{label}</div>
      {/* ⚠️ 修饰类一律带 `is-` 前缀：`verify.css` 里有一条**全局**的 `.empty`
          （`padding: 40px 20px` 的空态占位，页面级在用）。2026-09-30 之前这里直接写
          `empty`，于是每个「空值行」都被那条全局规则塞进 80px 上下内边距 ——
          设计侧「边框」组三行里两行高到 113px，整块面板白长 ~160px。
          同类事故本仓已踩过多次（`.pixel-grid` 被面板抢走那次）。凡面板自己的修饰类，
          都要能一眼看出是面板的。 */}
      <div className={`row-val${empty ? ' is-empty' : ''}`} title={title}>
        {empty ? '—' : display}
      </div>
    </div>
  );
};

/**
 * 字段集合：单侧视图的**全部字段打成一列**（2026-09-30 第二版定调）。
 *
 * 原来的「尺寸 / 文本 / 背景 / 边框」四组分块（以及 09-30 上午那版的两列网格）都按用户
 * 要求取消：所有字段一律当**样式属性**平铺，标签自解释（宽度 / 字号 / 背景色 / 圆角…），
 * 无需再分节标题占一行。`.info-fields` 只是行与行之间的垂直容器。
 *
 * ⚠️ 字段**顺序**仍按原分组排（尺寸 → 文本 → 背景 → 边框），只是不再有标题；
 * 单行样式项读起来是连续的清单。
 */
const Fields: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="info-fields">{children}</div>
);

/** 颜色块：Figma 的 hex 可能是 8 位带 alpha（如 #93eeff33），CSS 直接支持 */
const Swatch: React.FC<{ color?: string }> = ({ color }) =>
  color ? <span className="swatch" style={{ background: color }} /> : null;

const PaintRow: React.FC<{ paint: FigmaPaint; index: number }> = ({ paint, index }) => {
  const stops = paint.gradientStops;
  return (
    <div className="paint-row">
      <Swatch color={paint.color ?? stops?.[0]?.color} />
      <div className="paint-main">
        {/* ⚠️ 类型与值**横排**（2026-09-30 打磨）：原先上下两行（纯色 / #4e0000），
            在打平的字段清单里凭空多占一行高，而且一眼看去像「两个字段」；
            色块 + 「纯色 #4e0000°」单行才符合一个字段的样子。渐变 stops 长时允许换行。 */}
        <span className="paint-type">
          {paintLabel(paint)}
          {index > 0 ? ` #${index + 1}` : ''}
        </span>
        <span className="paint-val">
          {paint.color ?? (stops ? stops.map((s) => s.color).join(' → ') : '—')}
          {paint.gradientAngle !== undefined ? ` · ${Math.round(paint.gradientAngle)}°` : ''}
        </span>
      </div>
    </div>
  );
};

/**
 * 一组 paints（填充或描边）。`label` 决定行名 —— 同一份渲染给「背景色」与「描边色」两处用，
 * 免得两处各写一遍颜色块逻辑（写法一分裂，色块大小与 hex 显示就会走样）。
 */
const Fills: React.FC<{ label: string; paints?: FigmaPaint[] }> = ({ label, paints }) => {
  const visible = (paints ?? []).filter((p) => p.visible !== false);
  if (visible.length === 0) return <Row label={label} value={null} />;
  return (
    <div className="info-row paints">
      <div className="row-key">{label}</div>
      <div className="row-val paints-val">
        {visible.map((paint, i) => (
          <PaintRow key={i} paint={paint} index={i} />
        ))}
      </div>
    </div>
  );
};

/** 颜色行：色块 + hex。文本颜色等单色值共用（与 `Fills` 的差别是它只有一个值、无 paint 类型） */
const ColorRow: React.FC<{ label: string; color?: string | null }> = ({ label, color }) => (
  <div className="info-row">
    <div className="row-key">{label}</div>
    <div className={`row-val${color ? '' : ' is-empty'}`}>
      {color ? (
        <>
          <Swatch color={color} />
          {color}
        </>
      ) : (
        '—'
      )}
    </div>
  </div>
);

/**
 * 面板的取舍原则（本轮收敛）：**这块面板只服务 UI 验收同学**，回答的是
 * 「这个元素长得对不对」——尺寸、文案、字体、背景、边框，五件事。
 *
 * 其余字段（图层 id / 深度 / 路径 / 自动布局 / 效果 / 不透明度 / 混合模式 / 可见性…）
 * 是排查**匹配引擎**用的诊断信息，画在这里只会把上面那几行挤出首屏：一帧的字段能铺
 * 三屏，验收同学要的那 4 行反而要滚动才看得见。诊断要看就去看导出包 / 冒烟，
 * 不要往这个面板里加回来 —— 加之前先问「验收同学会因为这个数字改结论吗」。
 */
const renderDesign = (
  node: DesignNode,
  /**
   * 「设计稿对齐 App」口径的投影上下文（2026-09-29 加）。非空 ⇒ 所有**长度**读数换成
   * 截图的物理像素；颜色 / 文本 / 字体名 / 字重没有坐标系，两个口径下都原样显示。
   * 为空（默认口径，或这份快照没有物理像素宽）⇒ 走原来的设计单位读数。
   */
  pixelView?: PixelProjection | null,
): React.ReactNode => {
  /**
   * ⚠️ **矩形与标量走两套算式**：标量（圆角 / 描边宽度 / 字号 / 行高）在几何上**没有两条边
   * 可减**，只能单值投影（`designLengthToAppPixels`）；矩形则由宿主档位决定（2026-09-29）——
   * `presnap` 下左 / 宽各自取整（与 `screenUtils.w()` 同口径），`raw` 下四条边各自取整、
   * 宽高由边相减。判别式 `round(x·k) + round(w·k) ≠ round((x+w)·k)` 说的正是这两条路的差
   * （实测 24.8% 样本差 ±1px），所以**档位必须跟着快照走**，不能两边各拍一个。
   * 两套都在 `@shared/pixelTransform`，这里只决定调哪一个。
   */
  const edges = pixelView ? designPixelEdges(node, pixelView) : null;
  /**
   * 标量长度：有投影就换，否则原样透传。
   * ⚠️ 入参收 `string`：Figma 的 `lineHeight` 可能是 `"auto"`（不是长度），
   * 那种值不参与投影，直接照原样显示 —— 收窄成 `number` 会在类型层就把它挡掉，而它必须画出来。
   */
  const px = (value: number | string | null | undefined): number | string | null | undefined =>
    typeof value === 'number' && pixelView ? designLengthToAppPixels(value, pixelView) : value;
  /** 圆角可能是单值或四角数组：逐值投影后再交给 `cornerRadiusLabel` 折叠成一行 */
  const corner = (): DesignNode['cornerRadius'] => {
    const value = node.cornerRadius;
    if (!pixelView || value === undefined || value === null) return value;
    return Array.isArray(value)
      ? value.map((radius) => designLengthToAppPixels(radius, pixelView))
      : designLengthToAppPixels(value, pixelView);
  };
  return (
    <Fields>
      {/* 位置只在「设计稿对齐 App」口径下画：那个口径存在的理由就是「这个元素落在截图的
          哪个坐标」，而默认口径的坐标基准是设计稿本身、画布上直接看得到，不必多占两行。 */}
      {edges && <Row label="左" value={edges.left} />}
      {edges && <Row label="上" value={edges.top} />}
      <Row label="宽度" value={edges ? edges.right - edges.left : node.rect.width} />
      <Row label="高度" value={edges ? edges.bottom - edges.top : node.rect.height} />
      {(node.text || node.type === 'TEXT') && (
        <>
          <Row label="内容" value={node.text?.characters} />
          <Row label="字体" value={node.text?.fontFamily} />
          <Row label="字号" value={px(node.text?.fontSize)} />
          {/* ⚠️ Figma 没有 fontWeight 数值，粗细只有 `fontStyle` 字符串（如 "Medium"） */}
          <Row label="字重" value={designNodeFontStyle(node)} />
          <Row label="行高" value={px(node.text?.lineHeight)} />
          <ColorRow label="颜色" color={node.text?.color} />
        </>
      )}
      <Fills label="背景色" paints={node.fills} />
      <Fills label="描边色" paints={node.strokes} />
      <Row label="描边宽度" value={px(node.strokeWeight)} />
      <Row label="圆角" value={cornerRadiusLabel(corner())} />
    </Fields>
  );
};

/**
 * 类名的包名部分对验收同学没有意义（`com.facebook.react.views.text.` 一行占掉半个屏），只留类名。
 *
 * 导出是为了让重合组列表（`CanvasBoard` 构造 `StackView` 时）用**同一份**短名规则 ——
 * 两处各写一遍 `split('.').pop()`，面板正文与列表很快就会出现「同一层两个名字」。
 */
export const shortClassName = (className: string): string => className.split('.').pop() || className;

/**
 * 四边颜色：**同色才画色块**。
 *
 * 一个色块旁边跟着 `#ff0000 / #00ff00 / …` 四个 hex，读者会把那个色块当成「边框色」，
 * 而它其实只代表第一条边 —— 异色时只列值，让「这边和那边不一样」自己说出来。
 *
 * ⚠️ 四边异色时那串 hex 很长，整行都是它的（字段已打平，没有半格之说）。
 */
const EdgeColors: React.FC<{ label: string; colors?: AppNodeSides<string | null> | null }> = ({
  label,
  colors,
}) => {
  const folded = formatAppEdgeColors(colors);
  if (!folded) return <Row label={label} value={null} />;
  return folded.uniform ? (
    <ColorRow label={label} color={folded.label} />
  ) : (
    <Row label={label} value={folded.label} />
  );
};

/**
 * App 侧字段。
 *
 * 2026-09-22 起 App 侧**也能给出背景 / 边框 / 字体**了：采集侧补上了这些字段
 * （见 SDK 的 `ViewStyleReader`），于是两侧的面板终于回答同一组问题 —— 尺寸、文案、
 * 字体、背景、边框。在这之前 App 侧只有几何与状态位，验收同学要看颜色和字号
 * 只能切回截图肉眼比对。
 *
 * ⚠️ 三态而不是两态：`undefined` = **这版快照根本没有这个通道**（老 SDK），
 * `null` = 采集了、明确没有（比如一个透明容器就是没有背景色）。
 * 前者不画这一组，后者画成 `—` —— 「采不到」和「就是没有」在验收里是两个结论，
 * 混在一起会让老数据被读成「这个元素没有背景」。
 *
 * 为什么「类型」这一行留着：App 侧的类名（`TextInput` / `ScrollView`…）是面板里
 * 唯一能读出「我点的到底是个什么东西」的线索 —— 只留宽高的话这里就只剩两个数字。
 * 设计稿侧不画这一行：它那边的「这是谁」由左侧图层面板 + 画布上的选中框回答，
 * 再抄一遍只是噪音。
 */
/**
 * `align` = App 侧长度读数换算进设计稿基准的完整上下文（`design.width / app.width` + 两侧宽度 +
 * 像素比，2026-09-28 加）。
 *
 * ⚠️ **这是本视图与对比表容易分叉的地方**：同一个元素、同一份快照，单侧视图若给设备原值
 * （8.67 / 51.67），对比表给换算值（8.08 / 48.2），用户看到两个都「对」的数却无从取舍 ——
 * 与画布上截图被缩到设计稿同宽这件事也对不上。所以长度类字段一个不落地走 `len`。
 * 不参与换算的：内容 / 描述 / 字体名 / 字重 / 颜色 / 背景色（它们不是长度，也没有基准概念）。
 *
 * 传整个上下文而不只是一个比值，是因为**单侧视图也要能回答「这个小数哪来的」**：对比表手上有
 * 设计稿的值，能写「设计 8 · 差 0.08」；单侧视图没有，但「设备值 8.67 = 26 / 3」这一层
 * 只靠像素比就推得出来（见 `appLengthOrigin`）。
 */
const renderApp = (
  node: AppNode,
  align?: AppAlignContext,
  /**
   * 「设计稿对齐 App」口径的投影上下文（2026-09-29 加）。非空 ⇒ 长度读数直接给**截图物理像素**。
   *
   * ⚠️ 两类值的来源**刻意不同**：
   *  - 矩形（左 / 上 / 宽 / 高）取 SDK 实测的 `pixelRect`，缺了就是「未采集」—— 绝不拿逻辑值
   *    乘密度反算（方案 §03）；
   *  - 标量（圆角 / 描边宽度 / 字号 / 行高 / 字距）在快照里**没有**物理像素通道，只能乘回密度，
   *    title 里写明「这是换算、不是实测」。
   */
  pixelView?: PixelProjection | null,
): React.ReactNode => {
  const scale = align?.scale ?? 1;
  /** 像素口径下的矩形来源：**只有** SDK 上报的 `pixelRect` 这一条路 */
  const pixelRect = pixelView ? appPixelRect(node) : null;
  const style = node.style ?? null;
  // 老快照没有 style 这个键 → 整组不画；有键（哪怕是 null）→ 画，缺值显示 —
  const styleChannel = node.style !== undefined;
  const textChannel = node.textStyle !== undefined && node.textStyle !== null;
  const textStyle = node.textStyle ?? null;
  /**
   * 「边框」组只有在**这版快照真的读过描边或圆角**时才画 —— 判据的唯一实现是
   * `appBorderChannel` / `appCornerChannel`（对比表用的是同一个，两处各写一遍迟早分叉成
   * 「面板不画、对比表还说有值」）。
   *
   * 三态在这里要再分一层：`style === null`（采了、确定没有）与
   * 「对象里一个描边键都没有」（这版没读，如 iOS 只采背景色与圆角）画出来都是 `—`，
   * 但结论相反 —— 后者是在告诉验收同学「这个元素确定没有描边」，一句假话。
   * 描边与圆角**各判各的**：iOS 有圆角、没描边，合成一条就会把没采的描边画成 `—`。
   */
  const borderChannel = appBorderChannel(node.style);
  // 圆角独立成通道，与描边分开判：iOS 采得到圆角、采不到描边，合成一条会让描边两行
  // 在没采的情况下画成「—」（假结论），见 appBorderChannel / appCornerChannel 的注释。
  const cornerChannel = appCornerChannel(node.style);

  /**
   * 一行 App 长度读数：**显示换算到设计稿基准的值**，`title` 说明「这个数是怎么来的」。
   *
   * ⚠️ `appLengthOrigin` 必须收到**设备原值**：它要靠 `value × pixelRatio` 反推物理像素数，
   * 喂换算过的值就把网格判据算歪了。
   *
   * 换算只有 `lib/comparison.ts` 那一份实现，这里不自己乘 —— 单侧视图与对比表给出同一个数
   * 是本视图的硬要求，各写一遍迟早分叉（对比表那边刚因为漏乘而一片假红）。
   */
  const len = (
    label: string,
    value: number | null | undefined,
    designValue?: number | null,
  ): React.ReactNode => (
    <Row
      label={label}
      value={
        typeof value === 'number' && pixelView
          ? appLengthToPixels(value, pixelView)
          : scaleAppLength(value, scale)
      }
      title={
        typeof value === 'number' && pixelView
          ? appPixelOrigin(value, pixelView)
          : appLengthOrigin(value, align, typeof designValue === 'number' ? designValue : undefined)
      }
    />
  );

  // 四边 / 四角是折叠成一行字符串的，走不了上面的 `len`：先换算再折叠（顺序反过来读出的
  // 是设备原值），两串都算出来，显示换算值、`title` 给原值。
  /**
   * 四槽（描边宽度 / 圆角）逐槽换算。两个口径各一套，**都不自己写乘法**：
   * - 默认口径：复用 `scaleAppSides` / `scaleAppCorners`（× `scale` 缩回设计基准）；
   * - 像素口径：`appLengthToPixels`（× 像素密度吸附到整数）。
   * 三态逐槽原样透传（`undefined` = 这版没这个通道、`null` = 采了且确定没有），别卷进乘法。
   */
  const pxSides = (
    sides: AppNodeSides<number | null> | undefined,
  ): AppNodeSides<number | null> | undefined => {
    if (!pixelView || sides === undefined) return sides;
    const one = (value: number | null): number | null =>
      typeof value === 'number' ? appLengthToPixels(value, pixelView) : value;
    return { top: one(sides.top), right: one(sides.right), bottom: one(sides.bottom), left: one(sides.left) };
  };
  const pxCorners = (
    corners: AppNodeCorners<number | null> | undefined,
  ): AppNodeCorners<number | null> | undefined => {
    if (!pixelView || corners === undefined) return corners;
    const one = (value: number | null): number | null =>
      typeof value === 'number' ? appLengthToPixels(value, pixelView) : value;
    return {
      topLeft: one(corners.topLeft),
      topRight: one(corners.topRight),
      bottomRight: one(corners.bottomRight),
      bottomLeft: one(corners.bottomLeft),
    };
  };

  const scaledSides = formatAppSides(pixelView ? pxSides(style?.borderWidth) : scaleAppSides(style?.borderWidth, scale));
  const rawSides = formatAppSides(style?.borderWidth);
  const scaledCorners = formatAppCorners(
    pixelView ? pxCorners(style?.borderRadius) : scaleAppCorners(style?.borderRadius, scale),
  );
  const rawCorners = formatAppCorners(style?.borderRadius);
  /**
   * 四槽全等才给「来历」（`soleValue`）：行上显示的是折叠串 `8.67 / 2`，四值不同时只解释一角
   * 会把读者带偏。这时 `appLengthOrigin` 返回 `undefined`，退回**原值串** —— 至少让开发
   * 还能拿到真机读数。`—`（采了、确定没有）与「未采集」都不给 `title`。
   */
  /** 四槽里唯一那个值（四槽不全等时为 undefined）—— 两套口径的「来历」都从它出发 */
  const borderSole = soleValue([
    style?.borderWidth?.top,
    style?.borderWidth?.right,
    style?.borderWidth?.bottom,
    style?.borderWidth?.left,
  ]);
  const cornerSole = soleValue([
    style?.borderRadius?.topLeft,
    style?.borderRadius?.topRight,
    style?.borderRadius?.bottomRight,
    style?.borderRadius?.bottomLeft,
  ]);
  /**
   * 「这个读数是怎么来的」。⚠️ 必须收**设备原值**：两个口径都要拿它乘出去。
   * 像素口径**不能**复用 `appLengthOrigin` —— 那一段讲的是「换算回设计基准」，方向正好相反，
   * 挂在 px 读数上会把读者带反。
   */
  const lengthOrigin = (value: number | undefined): string | undefined =>
    value === undefined ? undefined : pixelView ? appPixelOrigin(value, pixelView) : appLengthOrigin(value, align);
  const slotsTitle = (raw: string | number | null, origin: string | undefined): string | undefined =>
    // 像素口径下不给「设备原值」兜底：那个数在这把尺子上不存在，写了只会让人以为面板算错了
    origin ?? (pixelView || scale === 1 || raw === null ? undefined : `设备原值 ${raw}`);
  const sidesTitle = slotsTitle(rawSides, lengthOrigin(borderSole));
  const cornersTitle = slotsTitle(rawCorners, lengthOrigin(cornerSole));

  return (
    <Fields>
      {/* ⚠️ 像素口径下矩形**只认 `pixelRect`**（SDK 上报的实测物理像素原值）：缺了就是
          「未采集」—— 绝不拿逻辑值乘密度反算，那会包装出一个「看起来像量到的」数（方案 §03）。
          代价是老快照在像素口径下 App 侧尺寸为空，这是**正确**的结论，不是缺陷。 */}
      {pixelView ? (
        <>
          <Row label="左" value={pixelRect?.x} title={pixelRect ? PIXEL_ACTUAL_TITLE : PIXEL_RECT_MISSING_TITLE} />
          <Row label="上" value={pixelRect?.y} title={pixelRect ? PIXEL_ACTUAL_TITLE : PIXEL_RECT_MISSING_TITLE} />
          <Row label="宽度" value={pixelRect?.width} title={pixelRect ? PIXEL_ACTUAL_TITLE : PIXEL_RECT_MISSING_TITLE} />
          <Row label="高度" value={pixelRect?.height} title={pixelRect ? PIXEL_ACTUAL_TITLE : PIXEL_RECT_MISSING_TITLE} />
        </>
      ) : (
        <>
          {len('宽度', node.width)}
          {len('高度', node.height)}
        </>
      )}
      {(textChannel || node.text || node.contentDescription) && (
        <>
          <Row label="内容" value={node.text} />
          <Row label="描述" value={node.contentDescription} />
          {/* 字体这几行只在**这版快照确实带了文本样式**时画：不带时画一排「—」
              会被读成「这个文本没有字体设置」，而事实是「这一版没采」。 */}
          {textChannel && (
            <>
              <Row label="字体" value={textStyle?.fontFamily} />
              {len('字号', textStyle?.fontSize)}
              <Row label="字重" value={textStyle?.fontWeight} />
              {len('行高', textStyle?.lineHeight)}
              {len('字距', textStyle?.letterSpacing)}
              <ColorRow label="颜色" color={textStyle?.color} />
            </>
          )}
        </>
      )}
      {styleChannel && <ColorRow label="背景色" color={style?.backgroundColor} />}
      {(borderChannel || cornerChannel) && (
        <>
          {borderChannel && <EdgeColors label="描边色" colors={style?.borderColor} />}
          {borderChannel && <Row label="描边宽度" value={scaledSides} title={sidesTitle} />}
          {cornerChannel && <Row label="圆角" value={scaledCorners} title={cornersTitle} />}
          {/* 实线是默认值，画出来只是一行恒定的「solid」——只在真改过样式时才占一行 */}
          {borderChannel && style?.borderStyle && style.borderStyle !== 'solid' && (
            <Row label="边框样式" value={style.borderStyle} />
          )}
        </>
      )}
    </Fields>
  );
};

/**
 * 一个对比单元格。`title` 是「这个读数怎么来的」的说明：默认口径下只有 App 侧长度字段有
 * （设计稿侧是基准、没有来历可讲，悬停给个空 title 反而会让人以为漏了什么）；
 * 2026-09-29 起**像素口径下设计侧也有来历了**（设计值 × 倍率 → 取整），两边都给。
 *
 * ⚠️ `value.state` 加 `is-` 前缀再当类名用（2026-09-30）：`state` 的字面量是
 * `'empty' | 'unavailable'`，直接用会撞上 `verify.css` 里那条**全局** `.empty`
 * （空态占位，`padding: 40px 20px`）—— 对比表的空单元格因此被撑到 80px 高。
 * 与 `Row` / `ColorRow` 的 `is-empty` 是同一条纪律：面板的修饰类必须能一眼看出归属。
 */
const CompareCell: React.FC<{ value: CompareValue; changed: boolean }> = ({ value, changed }) => (
  <div
    className={`compare-cell${changed ? ' changed' : ''}${value.state !== 'value' ? ` is-${value.state}` : ''}`}
    title={value.origin}
  >
    {value.color && <Swatch color={value.color} />}
    <span>{value.text}</span>
  </div>
);

/**
 * 设计稿 vs App 的字段对齐表。
 *
 * `scale` 是 App 侧长度值换算进设计稿基准的系数（见 `buildCompareFields`）。⚠️ 它必须与
 * 画布上截图被缩放的比例**是同一个数**，否则「画布看起来对齐、面板说不同」，用户无从判断
 * 该信哪个 —— 2026-09-28 之前就是这样，尺寸类字段清一色假红。
 */
const NodeComparison: React.FC<{
  design: DesignNode;
  app: AppNode;
  scale?: number;
  appAlign?: AppAlignContext;
  /**
   * 「设计稿对齐 App」口径（2026-09-29 加）：非空 ⇒ 长度字段的**显示值**换成截图物理像素。
   *
   * ⚠️ 判定**不随它变**：`buildCompareFields` 里 `numbers` 始终是设计单位那一套，
   * `LENGTH_TOLERANCE`（±0.5 pt）也没动 —— 换的只是读数单位。见该函数的注释。
   */
  pixelView?: PixelProjection | null;
  /**
   * 读数口径切换器（2026-09-29 加）。放在 `.compare-content` **内部**、小结之上：
   * 它是控制项，而小结是结论 —— 控制永远在结论之上，与单侧视图「切换器在手势提示之前」同一条规则。
   *
   * ⚠️ 它在对比态下**必须能出现**（与单侧视图不同）：像素口径会改变这张表的读数，
   * 藏起开关就等于让用户没法跑到那个口径去。
   */
  basisBar?: React.ReactNode;
}> = ({ design, app, scale = 1, appAlign, pixelView, basisBar }) => {
  const fields = buildCompareFields(design, app, scale, appAlign, pixelView);
  /** 两侧都读到值才谈得上比 —— 一侧「未采集」时既不计数也不判差异 */
  const comparableOf = (field: CompareField): boolean =>
    field.comparable !== false && field.design.state !== 'unavailable' && field.app.state !== 'unavailable';
  /**
   * ⚠️ 判定**不是** `design.key !== app.key`（2026-09-28 改）：长度类字段带 `numbers` 时走
   * 容差逐位比（见 `sameCompareValue`），颜色 / 文本这类仍走 key 严格相等。
   */
  const changedOf = (field: CompareField): boolean => comparableOf(field) && !sameCompareValue(field.design, field.app);
  const comparableCount = fields.filter(comparableOf).length;
  const changedCount = fields.filter(changedOf).length;

  /**
   * 对比表（2026-09-30 第三版）：与单侧视图一样**全部打平** ——
   * 每个字段一行：`属性 | 设计稿值 | App 值`（`宽度 22 20`）。
   *
   * 差异**只靠红色**表达（2026-09-30 用户要求）：
   *  - 差异行 `.compare-row.changed` 淡红底 + 变化的值红字；
   *  - 属性列**不再**标「不同 / 一致」文案胶囊 —— 文案是噪音，底色一眼就够；
   *  - 表头只标「设计稿 / App」，**不展示节点名称** —— 名称画布上有，表头重复只是占位
   *    （还能避免名称一长就把列宽顶走）。
   */
  return (
    <div className="info-content compare-content">
      {basisBar}
      <div className="compare-summary">
        {changedCount === 0 ? `无差异 · ${comparableCount} 项可比较` : `${changedCount} 项差异 · ${comparableCount} 项可比较`}
      </div>
      <div className="compare-table">
        {/* 表头随滚动吸顶（`position: sticky`，见 `.compare-head`）：
            字段一多就要滚，「属性 / 设计稿 / App」必须一直在视线里。 */}
        <div className="compare-row compare-head">
          <div className="compare-key">属性</div>
          <div className="compare-col-head">
            <span className="src-tag design">设计稿</span>
          </div>
          <div className="compare-col-head">
            <span className="src-tag app">App</span>
          </div>
        </div>
        {fields.map((field) => {
          const changed = changedOf(field);
          return (
            <div className={`compare-row${changed ? ' changed' : ''}`} key={field.label}>
              <div className="compare-key">
                <span>{field.label}</span>
              </div>
              <div className="compare-col">
                <CompareCell value={field.design} changed={changed} />
              </div>
              <div className="compare-col">
                <CompareCell value={field.app} changed={changed} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ⚠️ 这里 2026-09-29 曾有一块 `PixelBlock`（「App 物理像素」：设计值投影 vs SDK 实测 pixelRect
// 并排的手动验收对照表），2026-09-30 按用户要求**整块移除**。移除的理由与替代路径见 `info-content`
// 单侧视图那一段的注释：判定链与字段表都不依赖它，口径切到 `pixel` 时字段表自己就给物理 px 读数。
// 若要加回来，请连 `scripts/verify-import-smoke.ts` 里那条「已移除」守卫一起改。

/**
 * 手势提示：面板内容区的**第一行**，两侧都画。
 *
 * 它回答的是「面板里换不了节点，那要怎么换」：单击选指针底下那个、原地再点上移一层、
 * ⌘/Ctrl 点另一个元素固定间距、Esc 上移一层。2026-09-22 设计稿侧也去掉
 * 「层级」面包屑之后，这就是面板侧的书面入口。
 *
 * ⚠️ 文案在 `lib/shortcuts.ts#GESTURE_HINT`，与画布底部提示条同一份来源 ——
 *    本文件里**不许**再出现第二份键位字面量，那正是「⌘ 换了、这里没跟着换」的成因。
 */

/**
 * 重合组的列表 —— 「此处有 N 个元素」。
 *
 * 它补的是**信息**，不是**命中规则**：命中该怎么算还怎么算（点哪选哪），这里只是把
 * 「这个位置其实有几层」说出来，并提供一个切过去的入口。之前「透明容器点不到」的教训
 * 是同一件事 —— 正解是给兜底通道，不是放宽命中（放宽必然抢走别的元素的可点面积）。
 *
 * ⚠️ **只在真的重合时出现**（调用方判 `members.length > 1`）。常驻的话，一帧 500 个节点
 * 里绝大多数都只有一层，那块 UI 就变成了纯噪音 —— 而面板首屏很贵。
 */
const StackList: React.FC<{ stack: StackView; onPick?: (id: string) => void }> = ({
  stack,
  onPick,
}) => (
  <div className="info-stack">
    <div className="stack-head">
      <span className="stack-count">此处有 {stack.members.length} 个元素</span>
      <span className="stack-badge">位置重合</span>
    </div>
    <div className="stack-rows">
      {/* 倒序显示：`members` 从下到上，列表要「上 → 下」 */}
      {[...stack.members].reverse().map((member) => {
        const current = member.id === stack.selectedId;
        return (
          <button
            key={member.id}
            type="button"
            className={`stack-row${current ? ' on' : ''}`}
            // 已经是当前层就不要再点一次（没有可见变化的一击会被当成点击失灵）
            disabled={current}
            title={current ? '当前选中的层' : '切到这一层'}
            onClick={() => onPick?.(member.id)}
          >
            <span className="stack-name">{member.name}</span>
            <span className="stack-hint">{member.hint}</span>
          </button>
        );
      })}
    </div>
    <div className="stack-foot">样式按「并集、冲突取上层」聚合显示，数据未合并</div>
  </div>
);

/**
 * 节点信息面板的**内容区**。
 *
 * ⚠️ 本组件不自带 `.info-panel` 外壳（边框 / 宽度 / 头部 / 关闭按钮都不在这里）：
 * 右栏现在有两个 tab（节点信息 / 验收结果），外壳与 tab 头属于**栏**而不属于某个 tab，
 * 由 `CanvasBoard` 统一持有。若这里再渲染一层 `aside.info-panel`，就会嵌出两个边框、
 * 两排标题，且「关闭按钮」的语义也和 tab 头打架。
 *
 * 于是这里只负责在给定的选中态下画出内容（空态、单节点字段或双列差异）。
 *
 * 两侧内容**对称**了（2026-09-22）：同一行手势提示打头，后面接各自的字段组。
 * 之前设计稿侧在首屏多一组「层级」面包屑（画布上被子级盖住的父级指不到，
 * 面包屑是那条「上移一层」的可点入口），App 侧不画 —— 用户看过之后定调：
 * 这一组也去掉。面板从此只剩「提示 + 字段」，点开就是节点信息本身。
 */
const NodeInfoPanel: React.FC<NodeInfoPanelProps> = ({
  visible,
  selected,
  comparison,
  spacingActive,
  requirementId,
  pairId,
  designNodeId,
  appNodeId,
  onIssueSaved,
  onCaptureCanvas,
  stack,
  onPickStackLayer,
  appAlign,
  alignBasis = 'design',
  onAlignBasisChange,
}) => {
  /** 换算系数只有这一个取法，单侧视图与对比表都从这里走 */
  const alignScale = appAlign?.scale ?? 1;
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueSeverity, setIssueSeverity] = useState<IssueSeverity>('P2');
  const [issueDescription, setIssueDescription] = useState('');
  const [issueImage, setIssueImage] = useState<CanvasCapture | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [issueContext, setIssueContext] = useState<IssueContext | null>(null);
  const hasIssueTarget = Boolean(designNodeId || appNodeId);
  /**
   * **开发环境专属**：面板顶部打出被点中节点的 id（设计稿 / App 各一条），方便在快照文件、
   * 日志、导出包之间对号。
   *
   * 为什么必须挂在 `import.meta.env.DEV` 上：验收同学跑的是打包版，面板只留
   * 「尺寸 / 文本 / 背景 / 边框」四组是 2026-09-24 那次「内容太杂乱」的收敛结论，
   * 冒烟里「诊断字段不得回流」那条断言守的就是它。dev 之外一律不画 —— 生产构建里
   * `import.meta.env.DEV` 被 Vite 静态替换成 `false`，这一块会连同样式一起被摇掉、不进包。
   *
   * 另外它**刻意不走 `Row`、不写 `label=` 形式**：上面那条断言盯的就是「以 `label=` 把诊断字段名
   * 重新写回面板」，用 Row 等于把 id 变回面板数据行、正面撞上它。这里用独立容器 + `<code>`
   * 原样显示 id。
   *
   * ⚠️ 这段注释里**不要引用那条断言的匹配串原文**：它扫的是本文件全文、**包含注释**，
   * 写上去等于自己把自己判成违规字段（2026-09-28 踩过一次，假红）。
   *
   * 两侧 id 都为空（没选中任何节点）时整块不画，免得白占一行。
   */
  const showDevNodeId = import.meta.env.DEV && Boolean(designNodeId || appNodeId);

  const openIssueForm = (): void => {
    const source: SaveIssueInput['source'] = designNodeId && appNodeId
      ? 'both'
      : designNodeId
        ? 'design'
        : 'app';
    setIssueContext({ source, designNodeId, appNodeId });
    setIssueSeverity('P2');
    setIssueDescription('');
    setIssueImage(null);
    setIssueError(null);
    setIssueOpen(true);
  };

  const saveIssue = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!issueContext || !issueDescription.trim()) return;
    setIssueBusy(true);
    setIssueError(null);
    try {
      await window.api.verify.saveIssue({
        requirementId,
        pairId,
        source: issueContext.source,
        position: null,
        nodeId: issueContext.designNodeId ?? issueContext.appNodeId,
        designNodeId: issueContext.designNodeId,
        appNodeId: issueContext.appNodeId,
        severity: issueSeverity,
        description: issueDescription.trim(),
        image: issueImage
          ? { dataUrl: issueImage.dataUrl, width: issueImage.width, height: issueImage.height }
          : null,
      });
      setIssueOpen(false);
      setIssueDescription('');
      setIssueContext(null);
      onIssueSaved();
    } catch (cause) {
      setIssueError((cause as Error).message || '保存问题失败');
    } finally {
      setIssueBusy(false);
    }
  };

  const captureCanvas = async (): Promise<void> => {
    setCaptureBusy(true);
    setIssueError(null);
    try {
      setIssueImage(await onCaptureCanvas());
    } catch (cause) {
      setIssueError((cause as Error).message || '截取画布失败');
    } finally {
      setCaptureBusy(false);
    }
  };

  /**
   * 本配对的投影上下文（2026-09-29 加，`lib/pixelProjection#pixelProjectionOf`）。
   *
   * ⚠️ 它只被**一处**消费：下面 `pixelBasisView`（口径切到「设计稿对齐 App」时，单侧视图与
   * 对比表都把长度读数换成截图像素）。09-29 加的「App 物理像素」块共用过它，那块 09-30 已移除 ——
   * 但**投影仍要算**：`basisNotice` 靠 `projection === null` 判断「这份快照支不支持像素口径」，
   * 藏掉它就没法把「为什么读数没变」说清楚。
   */
  const projection = pixelProjectionOf(appAlign);
  /**
   * 「设计稿对齐 App」口径要用的投影。投影拿不到（老快照没有截图物理像素宽）时为 null，
   * 那时面板给一行说明，而不是静默退回默认口径。
   */
  const pixelBasisView = alignBasis === 'pixel' ? projection : null;

  /**
   * 读数口径切换器 —— 单侧选中与**对比态**都画（2026-09-29 第二次收敛）。
   *
   * 首版只在单侧选中时画，理由是「对比表不随口径变，摆一个按下去没反应的控件比不摆更糟」。
   * 现在对比表也换成 px 显示了（`buildCompareFields` 的 `pixel` 参数），那个理由不再成立 ——
   * 藏起开关反而变成「用户没法跑到那个口径去」。于是它与单侧视图共用同一个元素，
   * 在对比态经 `NodeComparison` 的 `basisBar` 传进去，位置仍是「控制项在结论之上」。
   *
   * ⚠️ 拿不到投影（老快照没有截图物理像素宽）时**照画**：那正是要让用户看见「这个配对支持不了
   * 这个口径」，藏起开关只会让她以为自己没找对地方。切换后由 `basisNotice` 给出原因。
   */
  const basisSwitcher =
    onAlignBasisChange && (selected || comparison) && !spacingActive ? (
      <div className="info-basis">
        <span className="info-basis-label">读数口径</span>
        <div className="basis-options" role="group" aria-label="读数口径">
          {((
            [
              ['design', 'App → 设计稿'],
              ['pixel', '设计稿 → App'],
            ] as Array<[AlignBasis, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`basis-option${alignBasis === value ? ' on' : ''}`}
              aria-pressed={alignBasis === value}
              onClick={() => onAlignBasisChange(value)}
            >
              {label}
            </button>
          )))}
        </div>
      </div>
    ) : null;

  /** 选了像素口径却投影不出来：把原因说出来，别让用户对着没变化的读数猜 */
  const basisNotice =
    alignBasis === 'pixel' && !projection ? (
      <div className="info-basis-notice">
        这份快照没有「截图物理像素宽」，无法把设计值投影成截图像素 —— 读数仍是设计单位。
      </div>
    ) : null;

  let content: React.ReactNode;
  if (spacingActive) {
    content = <div className="info-empty">正在进行间距对比，节点属性暂不显示</div>;
  } else if (comparison) {
    content = (
      <NodeComparison
        {...comparison}
        scale={alignScale}
        appAlign={appAlign}
        pixelView={pixelBasisView}
        // 控制项在结论之上：切换器与「投影不可用」说明都排在 `compare-summary` 之前
        basisBar={<>{basisSwitcher}{basisNotice}</>}
      />
    );
  } else if (!selected) {
    content = (
      <div className="info-empty">
        单击画布选中元素
        <br />
        {/* 这里曾经手写着一句过时的修饰键说明：09-22 ⌘ 改职责之后它没跟着改，
            于是面板上同时挂着两种说法，按下去得到第三种。
            现在与画布底部同引一份常量：改键位只改 `lib/shortcuts.ts`。 */}
        {GESTURE_HINT}
      </div>
    );
  } else {
    content = (
      <div className="info-content">
        {/* 口径切换器排在**手势提示之前**：它是「面板怎么显示」，而提示是「面板怎么操作」——
            控制类永远在说明类之上，否则用户要读完一句操作提示才发现上面有个开关。 */}
        {basisSwitcher}
        {basisNotice}
        <div className="info-hint">{GESTURE_HINT}</div>
        {/* 重合组紧跟在手势提示之后、字段组之前：它描述的是「你选的这个位置有什么」，
            属于数据；而手势提示是「面板怎么操作」，属于说明 —— 说明在前、数据在后，
            与原有结构一致（见 `.info-hint` 的注释：它必须留在首屏，所以不让位）。 */}
        {stack && stack.members.length > 1 && <StackList stack={stack} onPick={onPickStackLayer} />}
        {/* ⚠️ 这里原先排着「App 物理像素」块（`PixelBlock`，2026-09-29 加、09-30 按用户要求移除）：
            它把设计值投影成的 px 与 SDK 实测 `pixelRect` 并排放在字段组之前。移除的理由是它与
            下面那张字段表摆的是**两把尺子**（块给物理 px、表给设计单位），同屏并排容易被读成
            「同一个数怎么有两个答案」；而**它想回答的问题字段表自己就能回答** —— 口径切到
            「设计稿 → App」时，字段表的宽/高/左/上就是截图像素读数（`pixelBasisView`），
            且与判定用的是同一份投影，不会出现两个来源。 */}
        {/* ⚠️ 换算必须传进**单侧视图**也传：只给对比表的话，同一个元素点开两次
            （一次只有 App 选中、一次两侧都选中）会看到两个不同的宽高，用户没法判断该信哪个。
            传的是**整个 `appAlign`**（不只是那个比值）：单侧视图手上没有设计稿的值，
            但仍要能写出「8.67 = 26 / 3」这一层来历（见 `renderApp` 的 `len`）。 */}
        {selected.source === 'design'
          ? renderDesign(selected.node, pixelBasisView)
          : renderApp(selected.node, appAlign, pixelBasisView)}
      </div>
    );
  }

  /**
   * 面板底部的口径说明（**常驻**，不需要 hover）。
   *
   * 为什么不靠上面那些 `title` 就够了：`title` 要鼠标停上去才出现，而「这面板怎么全是小数」是
   * 拿起来第一眼就会冒出来的疑问。不给答案，验收同学的第一反应是「工具算不准」，
   * 那她接着就不会信面板里真正该处理的差异了（见 `alignNotes`）。
   *
   * 只在**真的有东西可比**时画：空状态（没选中 / 正在量间距）下多一行说明只是噪音。
   */
  const alignNoteLines = spacingActive || (!comparison && !selected) ? [] : alignNotes(appAlign, alignBasis);

  return (
    <>
      {visible && (
        <>
          {/* 开发环境专属：选中节点 id（生产构建里整块被摇掉，见 showDevNodeId 的注释）。
              包一层 Fragment 只是因为 `visible &&` 现在要带两个兄弟节点（dev 条 + content）；
              Fragment 不产生 DOM，两者仍是面板容器的直接子项，内容区 flex:1 不受影响。 */}
          {showDevNodeId && (
            <div className="info-dev-nodeid">
              <span className="dev-nodeid-title">DEV · 选中节点 id</span>
              {designNodeId && (
                <div className="dev-nodeid-item">
                  <span className="src-tag design">设计稿</span>
                  <code>{designNodeId}</code>
                </div>
              )}
              {appNodeId && (
                <div className="dev-nodeid-item">
                  <span className="src-tag app">App</span>
                  <code>{appNodeId}</code>
                </div>
              )}
            </div>
          )}
          {content}
          {alignNoteLines.length > 0 && (
            <div className="info-note">
              {alignNoteLines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="issue-create-area">
        {!issueOpen ? (
          <button type="button" className="btn issue-create-trigger" disabled={!hasIssueTarget} onClick={openIssueForm}>
            ＋ 记录问题
          </button>
        ) : (
          <form className="issue-create-form" onSubmit={(event) => void saveIssue(event)}>
            <div className="issue-create-title">记录问题</div>
            <div className="issue-target-tags">
              {issueContext?.designNodeId && <span className="src-tag design">设计稿节点</span>}
              {issueContext?.appNodeId && <span className="src-tag app">App 节点</span>}
            </div>
            <div className="issue-form-fields">
              <label>
                级别
                <select value={issueSeverity} onChange={(event) => setIssueSeverity(event.target.value as IssueSeverity)}>
                  <option value="P0">P0 · 阻断</option>
                  <option value="P1">P1 · 严重</option>
                  <option value="P2">P2 · 一般</option>
                </select>
              </label>
            </div>
            <div className="issue-image-field">
              <div className="issue-image-actions">
                <span className="issue-image-label">问题图片</span>
                <button type="button" className="btn tiny" disabled={issueBusy || captureBusy} onClick={() => void captureCanvas()}>
                  {captureBusy ? '请拖拽选择…' : issueImage ? '重新截取画布' : '拖拽截取画布'}
                </button>
                {issueImage && (
                  <button type="button" className="btn tiny" disabled={issueBusy || captureBusy} onClick={() => setIssueImage(null)}>
                    移除
                  </button>
                )}
              </div>
              {issueImage ? (
                <img className="issue-image-preview" src={issueImage.dataUrl} alt="问题截图预览" />
              ) : (
                <span className="issue-image-hint">点击后在画布上拖拽选择图片区域</span>
              )}
            </div>
            <label className="issue-description-label">
              问题描述
              <textarea
                value={issueDescription}
                onChange={(event) => setIssueDescription(event.target.value)}
                placeholder="描述实际表现与预期差异"
                rows={3}
                required
              />
            </label>
            {issueError && <div className="issue-form-error" role="alert">{issueError}</div>}
            <div className="issue-form-actions">
              <button type="button" className="btn tiny" disabled={issueBusy || captureBusy} onClick={() => setIssueOpen(false)}>取消</button>
              <button type="submit" className="btn primary tiny" disabled={issueBusy || captureBusy || !issueDescription.trim()}>
                {issueBusy ? '保存中…' : '保存问题'}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
};

export default NodeInfoPanel;
