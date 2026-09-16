import React from 'react';

import { MIN_OVERLAY_OPACITY, OVERLAY_COMPARE_LABEL, type OverlayCompare } from '../lib/compare';
import { clampZoom, zoomStepFor } from '../lib/zoom';

interface VerifyToolbarProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onBack?: () => void;
  /** 当前配对信息，显示在工具栏左侧 */
  subtitle?: string;
  /**
   * 当前工具。**由 CanvasBoard 持有**（本组件不自持状态）。
   *
   * 原先它存在这里，于是「叠图验收」只能点亮自己那一格 —— 按钮的选中态归它管，
   * 而画布该不该换布局归 CanvasBoard 管，两边没有通道，点下去只有高亮变化。
   * 上提之后 mode 是从这个值**推导**出来的，两者不可能不一致。
   */
  activeTool: string;
  onActiveToolChange: (tool: string) => void;
  /** 叠图子模式。只在 mode === 'overlay' 时有意义 */
  compare: OverlayCompare;
  onCompareChange: (compare: OverlayCompare) => void;
  overlayOpacity: number;
  onOverlayOpacityChange: (opacity: number) => void;
  wipeRatio: number;
  onWipeRatioChange: (ratio: number) => void;
  /**
   * 叠图是否可用（两张图都在）。
   *
   * 不可用时把「叠图验收」置灰而不是让它照常可点：点进去只会看到一张图，
   * 而工具栏却是选中态 —— 用户会判断成「叠图功能坏了」，而不是「这页缺图」。
   */
  overlayEnabled: boolean;
}

interface ToolSpec {
  key: string;
  icon: string;
  label: string;
  /** 尚未实现的工具：保留占位，但置灰并说明，避免「点了没反应」被当成故障 */
  pending?: boolean;
}

const PRIMARY_TOOLS: ToolSpec[] = [
  { key: 'nav', icon: '☰', label: '导航', pending: true },
  { key: 'select', icon: '▶', label: '选择' },
];

const MODE_TOOLS: ToolSpec[] = [
  { key: 'full', icon: '▭', label: '全页验收' },
  { key: 'region', icon: '▢', label: '区域验收', pending: true },
  { key: 'overlay', icon: '▣', label: '叠图验收' },
];

const MARK_TOOLS: ToolSpec[] = [
  { key: 'picker', icon: '◆', label: '取色', pending: true },
  { key: 'rect', icon: '▭', label: '画框', pending: true },
  { key: 'arrow', icon: '↗', label: '箭头', pending: true },
];

const COMPARE_TOOLS: OverlayCompare[] = ['opacity', 'difference', 'wipe'];

const COMPARE_HINT: Record<OverlayCompare, string> = {
  opacity: '拖动滑块调整截图的透明度，两张图同时可见',
  difference: '相同处趋黑，差异处变亮 —— 找错位看这个最快',
  wipe: '拖动滑块或直接拖画布上的分隔线，左右分别露出设计稿与截图',
};

/**
 * 验收工具栏。
 *
 * 状态全部由 `CanvasBoard` 持有并传入 —— 这个组件只负责画和派发。
 * 理由见 `activeTool` 的注释：工具按钮与画布行为必须共用同一个状态源。
 */
const VerifyToolbar: React.FC<VerifyToolbarProps> = ({
  zoom,
  onZoomChange,
  subtitle,
  activeTool,
  onActiveToolChange,
  compare,
  onCompareChange,
  overlayOpacity,
  onOverlayOpacityChange,
  wipeRatio,
  onWipeRatioChange,
  overlayEnabled,
}) => {
  const step = zoomStepFor(zoom);
  const overlayOn = activeTool === 'overlay' && overlayEnabled;

  const renderTool = (tool: ToolSpec) => {
    const blocked = tool.pending === true;
    const unavailable = tool.key === 'overlay' && !overlayEnabled;
    const disabled = blocked || unavailable;
    const title = unavailable
      ? `${tool.label}：这一页缺图（设计稿或截图缺少底图）`
      : blocked
        ? `${tool.label}：尚未实现`
        : tool.label;
    return (
      <button
        key={tool.key}
        type="button"
        className={`tool${activeTool === tool.key ? ' active' : ''}${disabled ? ' pending' : ''}`}
        title={title}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={() => onActiveToolChange(tool.key)}
      >
        <span className="ico">{tool.icon}</span>
        <span className="label">{tool.label}</span>
      </button>
    );
  };

  return (
    <>
      <div className="toolbar">
        {subtitle && (
          <>
            <span className="toolbar-subtitle">{subtitle}</span>
            <div className="divider" />
          </>
        )}
        {PRIMARY_TOOLS.map(renderTool)}
        <div className="divider" />
        <div className="zoom-control">
          <button
            type="button"
            className="tool"
            title={`缩小 ${step}×`}
            onClick={() => onZoomChange(clampZoom(zoom - step))}
          >
            −
          </button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="tool"
            title={`放大 ${step}×`}
            onClick={() => onZoomChange(clampZoom(zoom + step))}
          >
            +
          </button>
        </div>
        <div className="divider" />
        {MODE_TOOLS.map(renderTool)}
        <div className="divider" />
        {MARK_TOOLS.map(renderTool)}
      </div>

      {/* 叠图子模式条：只在叠图模式下出现。
          常驻的话，三种看法在并排布局下无从作用，却会一直是可点的样子 ——
          又是一个「按了没反应」。 */}
      {overlayOn && (
        <div className="toolbar-subrow">
          <span className="subrow-title">比对方式</span>
          <div className="cmp-seg">
            {COMPARE_TOOLS.map((item) => (
              <button
                key={item}
                type="button"
                className={`cmp-btn${compare === item ? ' active' : ''}`}
                title={COMPARE_HINT[item]}
                onClick={() => onCompareChange(item)}
              >
                {OVERLAY_COMPARE_LABEL[item]}
              </button>
            ))}
          </div>

          {compare === 'opacity' && (
            <label className="cmp-slider">
              <span className="subrow-title">透明度</span>
              <input
                type="range"
                min={Math.round(MIN_OVERLAY_OPACITY * 100)}
                max={100}
                step={1}
                value={Math.round(overlayOpacity * 100)}
                onChange={(event) => onOverlayOpacityChange(Number(event.target.value) / 100)}
              />
              <span className="cmp-value">{Math.round(overlayOpacity * 100)}%</span>
            </label>
          )}

          {compare === 'wipe' && (
            <label className="cmp-slider">
              <span className="subrow-title">分割位置</span>
              <input
                type="range"
                min={2}
                max={98}
                step={1}
                value={Math.round(wipeRatio * 100)}
                onChange={(event) => onWipeRatioChange(Number(event.target.value) / 100)}
              />
              <span className="cmp-value">{Math.round(wipeRatio * 100)}%</span>
            </label>
          )}

          <span className="cmp-hint">
            {compare === 'wipe' ? COMPARE_HINT.wipe : COMPARE_HINT[compare]}
          </span>
        </div>
      )}
    </>
  );
};

export default VerifyToolbar;
