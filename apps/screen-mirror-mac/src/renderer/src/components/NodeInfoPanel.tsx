import React from 'react';

import type { AppNode, DesignNode, RenderNode } from '@shared/verify';
import { appNodeHittable, designNodeFontStyle, designNodeHittable } from '@shared/verify';
import type { FigmaPaint } from '@shared/figma';

/** 选中的节点：来源与原始节点绑定，面板据此决定展示哪些字段 */
export type SelectedNode =
  | { source: 'design'; node: DesignNode }
  | { source: 'app'; node: AppNode };

interface NodeInfoPanelProps {
  selected: SelectedNode | null;
  /**
   * 选中节点的层级链（**最外层 → 当前**，含当前）。
   *
   * 为什么面板里要放它：画布上父级只有「子级没盖住的空隙」可点（嵌套 DOM 里父盒画在
   * 子盒下面），被子树完全盖住的容器仍然指不到，「原地再点上移一层」是一条需要记住的
   * 手势。面包屑把它变成看得见、点得着的一排 —— 点哪一格就跳到那一层。
   */
  chain: RenderNode[];
  /**
   * 当前上下文层的节点 id（null = 顶层）。**它就是选中项的父级** ——
   * 由 `CanvasBoard` 从选中项算出来（见 lib/selection：上下文不存，只存选中项）。
   *
   * 为什么面板要知道它：它就是「选中项的上一层」。面包屑把它标出来，于是
   * 「我现在在哪一层、再按一下 Esc 会退到哪」是看得见的 —— 比它更早的一律淡化。
   */
  contextId: string | null;
  /** 点面包屑的某一层：**只选中，不移动视口**（与画布内点击同一语义） */
  onPickAncestor: (node: RenderNode) => void;
}

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => {
  const empty = value === null || value === undefined || value === '';
  const display =
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : value;
  return (
    <div className="info-row">
      <div className="row-key">{label}</div>
      <div className={`row-val${empty ? ' empty' : ''}`}>{empty ? '—' : display}</div>
    </div>
  );
};

const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="info-group">
    <div className="info-group-title">{title}</div>
    {children}
  </div>
);

/** 颜色块：Figma 的 hex 可能是 8 位带 alpha（如 #93eeff33），CSS 直接支持 */
const Swatch: React.FC<{ color?: string }> = ({ color }) =>
  color ? <span className="swatch" style={{ background: color }} /> : null;

const paintLabel = (paint: FigmaPaint): string => {
  if (paint.type === 'SOLID') return '纯色';
  if (paint.type === 'IMAGE') return '图片填充';
  if (paint.type === 'GRADIENT_LINEAR') return '线性渐变';
  if (paint.type === 'GRADIENT_RADIAL') return '径向渐变';
  return paint.type;
};

const PaintRow: React.FC<{ paint: FigmaPaint; index: number }> = ({ paint, index }) => {
  const stops = paint.gradientStops;
  return (
    <div className="paint-row">
      <Swatch color={paint.color ?? stops?.[0]?.color} />
      <div className="paint-main">
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

const Fills: React.FC<{ paints?: FigmaPaint[] }> = ({ paints }) => {
  const visible = (paints ?? []).filter((p) => p.visible !== false);
  if (visible.length === 0) return <Row label="填充" value={null} />;
  return (
    <div className="info-row paints">
      <div className="row-key">填充</div>
      <div className="row-val paints-val">
        {visible.map((paint, i) => (
          <PaintRow key={i} paint={paint} index={i} />
        ))}
      </div>
    </div>
  );
};

const renderDesign = (node: DesignNode): React.ReactNode => (
  <>
    <Group title="基础">
      <Row label="图层 id" value={node.id} />
      <Row label="图层名" value={node.name} />
      <Row label="类型" value={node.type} />
      <Row label="深度 / 序号" value={`${node.depth} / ${node.index ?? 0}`} />
    </Group>
    <Group title="路径">
      <div className="info-path">{node.path}</div>
    </Group>
    <Group title="几何（相对导出单元根节点）">
      <Row label="x / y" value={`${node.rect.x} / ${node.rect.y}`} />
      <Row label="宽 / 高" value={`${node.rect.width} / ${node.rect.height}`} />
      <Row
        label="绝对 x / y"
        value={node.absRect ? `${node.absRect.x} / ${node.absRect.y}` : null}
      />
      <Row label="有填充" value={String(node.hasFill !== false)} />
      {/* 「可命中」与「有填充」是两个问题：无填充的容器照样能被指着选中（true / true 之外的
          组合都正常），而「有填充 = true、可命中 = false」正是**填充被隐藏 + 只剩描边**
          的图层 —— 插件的 hasFill 把可见描边也算像素，于是它看着「有内容」却在画布上
          不该吃命中。用户问「为什么这个图层 hover 不到 / 为什么另一个图层抢走了所有点击」，
          这两行连起来就是答案（判据见 RenderNode.hittable）。 */}
      <Row label="可命中" value={String(designNodeHittable(node))} />
      <Row label="已被裁剪" value={String(node.clipped === true)} />
    </Group>
    {(node.text || node.type === 'TEXT') && (
      <Group title="文本">
        <Row label="内容" value={node.text?.characters} />
        <Row label="字体" value={node.text?.fontFamily} />
        <Row label="字重" value={designNodeFontStyle(node)} />
        <Row label="字号" value={node.text?.fontSize} />
        <Row label="行高" value={node.text?.lineHeight} />
        <Row label="字距" value={node.text?.letterSpacing} />
        <Row label="水平对齐" value={node.text?.textAlignHorizontal} />
        <Row label="垂直对齐" value={node.text?.textAlignVertical} />
        <Row label="行数" value={node.text?.lineCount} />
        <div className="info-row">
          <div className="row-key">颜色</div>
          <div className={`row-val${node.text?.color ? '' : ' empty'}`}>
            {node.text?.color ? (
              <>
                <Swatch color={node.text.color} />
                {node.text.color}
              </>
            ) : (
              '—'
            )}
          </div>
        </div>
      </Group>
    )}
    <Group title="填充">
      <Fills paints={node.fills} />
    </Group>
    {node.strokes && node.strokes.length > 0 && (
      <Group title="描边">
        <Fills paints={node.strokes} />
        <Row label="描边宽度" value={node.strokeWeight} />
        <Row label="描边对齐" value={node.strokeAlign} />
      </Group>
    )}
    {node.layout && (
      <Group title="自动布局">
        <Row label="方向" value={node.layout.mode} />
        <Row label="间距" value={node.layout.gap} />
        <Row label="交叉轴间距" value={node.layout.counterAxisGap} />
        <Row
          label="内边距"
          value={
            node.layout.padding
              ? `${node.layout.padding.top} ${node.layout.padding.right} ${node.layout.padding.bottom} ${node.layout.padding.left}`
              : null
          }
        />
        <Row label="对齐" value={node.layout.alignItems} />
        <Row label="主轴分布" value={node.layout.justifyContent} />
        <Row label="裁剪内容" value={String(node.layout.clipsContent === true)} />
      </Group>
    )}
    {node.effects && node.effects.length > 0 && (
      <Group title="效果">
        {node.effects.map((effect, i) => (
          <Row
            key={i}
            label={effect.type}
            value={[effect.radius !== undefined ? `r=${effect.radius}` : null, effect.color]
              .filter(Boolean)
              .join(' · ')}
          />
        ))}
      </Group>
    )}
    <Group title="其他">
      <Row label="不透明度" value={node.opacity} />
      <Row
        label="圆角"
        value={Array.isArray(node.cornerRadius) ? node.cornerRadius.join(' / ') : node.cornerRadius}
      />
      <Row label="混合模式" value={node.blendMode} />
      <Row label="旋转" value={node.rotation} />
      <Row label="组件" value={node.component?.mainComponentName} />
      <Row label="可见" value={String(node.visible)} />
    </Group>
  </>
);

const renderApp = (node: AppNode): React.ReactNode => (
  <>
    <Group title="基础">
      <Row label="nodeId" value={node.nodeId} />
      <Row label="className" value={node.className} />
      <Row label="depth / index" value={`${node.depth} / ${node.index}`} />
      <Row label="parentId" value={node.parentId} />
    </Group>
    <Group title="几何">
      <Row label="x / y" value={`${node.x} / ${node.y}`} />
      <Row label="宽 / 高" value={`${node.width} / ${node.height}`} />
      <Row label="visible x / y" value={`${node.visibleX} / ${node.visibleY}`} />
      <Row label="visible 宽 / 高" value={`${node.visibleWidth} / ${node.visibleHeight}`} />
      <Row label="scroll x / y" value={`${node.scrollX} / ${node.scrollY}`} />
    </Group>
    <Group title="状态">
      <Row label="visible" value={String(node.visible)} />
      <Row label="enabled" value={String(node.enabled)} />
      <Row label="clickable" value={String(node.clickable)} />
      <Row label="clipsToBounds" value={String(node.clipsToBounds)} />
    </Group>
    <Group title="视觉">
      <Row label="alpha" value={node.alpha} />
      <Row label="z" value={node.z} />
      <Row label="elevation" value={node.elevation} />
      <Row label="hasVisualContent" value={String(node.hasVisualContent)} />
      {/* App 侧不画内容的 View 就是布局容器，照样能被指着选中；唯一的例外是**透明盾牌**
          （框架层的全屏透明层，如 RN 的 DebuggingOverlay）——它会吃掉整帧的点击，
          所以必须退出命中。判据见 AppNode.hitShield / markAppHitShields。 */}
      <Row label="可命中" value={String(appNodeHittable(node))} />
      {node.hitShield === true && <Row label="透明盾牌" value="true（已退出命中）" />}
      <Row label="isImage / isSvg" value={`${node.isImage} / ${node.isSvg}`} />
      <Row label="isGradient" value={String(node.isGradient)} />
    </Group>
    <Group title="内容">
      <Row label="text" value={node.text} />
      <Row label="contentDescription" value={node.contentDescription} />
      <Row label="resourceName" value={node.resourceName} />
      <Row label="fontSize" value={node.fontSize} />
      <Row label="fontWeight" value={node.fontWeight} />
      <div className="info-row">
        <div className="row-key">color</div>
        <div className={`row-val${node.color ? '' : ' empty'}`}>
          {node.color ? (
            <>
              <Swatch color={node.color} />
              {node.color}
            </>
          ) : (
            '—'
          )}
        </div>
      </div>
    </Group>
  </>
);

/**
 * 层级面包屑：最外层 → 当前节点。
 *
 * 三种状态，对应「这一格在链上的哪一段」：
 *  - `outside`（上下文之上）：上一层已经出了这块区域，先淡化；
 *  - `context`（当前上下文层 = 选中项的父级）：高亮，Esc / 原地再点就会落到它；
 *  - `current`（选中项）：不可点（它就是选中项，点了没有变化）。
 *
 * 点任意一格 = 跳到那一层（选中它；上下文随之成为它的父级，见 CanvasBoard.handleSelect）。
 */
const Crumbs: React.FC<{
  chain: RenderNode[];
  contextId: string | null;
  onPick: (node: RenderNode) => void;
}> = ({ chain, contextId, onPick }) => {
  if (chain.length === 0) return null;
  const last = chain.length - 1;
  const contextIndex = contextId ? chain.findIndex((node) => node.id === contextId) : -1;

  return (
    <Group title="层级">
      <div className="info-crumbs">
        {chain.map((node, index) => {
          const className = [
            'crumb',
            index === last ? 'current' : '',
            contextIndex >= 0 && index < contextIndex ? 'outside' : '',
            index === contextIndex ? 'context' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <React.Fragment key={`${node.source}:${node.id}`}>
              {index > 0 && <span className="crumb-sep">›</span>}
              <button
                type="button"
                className={className}
                disabled={index === last}
                title={node.label}
                onClick={() => onPick(node)}
              >
                {node.label}
              </button>
            </React.Fragment>
          );
        })}
      </div>
      <div className="info-hint">
        单击选指针底下那个 · 原地再点上移一层（hover 环跟随）· ⌘/Ctrl 选整帧 · Esc 上移一层
      </div>
    </Group>
  );
};

/**
 * 节点信息面板的**内容区**。
 *
 * ⚠️ 本组件不自带 `.info-panel` 外壳（边框 / 宽度 / 头部 / 关闭按钮都不在这里）：
 * 右栏现在有两个 tab（节点信息 / 验收结果），外壳与 tab 头属于**栏**而不属于某个 tab，
 * 由 `CanvasBoard` 统一持有。若这里再渲染一层 `aside.info-panel`，就会嵌出两个边框、
 * 两排标题，且「关闭按钮」的语义也和 tab 头打架。
 *
 * 于是这里只负责一件事：**在给定的选中态下画出内容**（空态或字段列表）。
 */
const NodeInfoPanel: React.FC<NodeInfoPanelProps> = ({
  selected,
  chain,
  contextId,
  onPickAncestor,
}) => {
  if (!selected) {
    return (
      <div className="info-empty">
        单击画布选中元素
        <br />
        原地再点上移一层 · hover 环 = 下一击选中项 · ⌘/Ctrl 单击选整帧
      </div>
    );
  }

  return (
    <div className="info-content">
      <Crumbs chain={chain} contextId={contextId} onPick={onPickAncestor} />
      {selected.source === 'design' ? renderDesign(selected.node) : renderApp(selected.node)}
    </div>
  );
};

export default NodeInfoPanel;
