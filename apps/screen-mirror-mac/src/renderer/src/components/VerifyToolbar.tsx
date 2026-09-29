import React from 'react';

import {
  MIN_OVERLAY_OPACITY,
  OVERLAY_COMPARE_LABEL,
  type OverlayCompare,
  type OverlayOffset,
} from '../lib/compare';
import { clampZoom, zoomStepFor } from '../lib/zoom';

interface VerifyToolbarProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onBack?: () => void;
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
  overlayOffset: OverlayOffset;
  onOverlayOffsetReset: () => void;
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
  icon: React.ReactNode;
  label: string;
  /** 尚未实现的工具：保留占位，但置灰并说明，避免「点了没反应」被当成故障 */
  pending?: boolean;
}

const MODE_TOOLS: ToolSpec[] = [
  {
    key: 'full',
    icon: <svg viewBox="0 0 20 20"><rect x="3" y="2.75" width="14" height="14.5" rx="1.5" /><path d="M6 6h8M6 9h8" /></svg>,
    label: '全页验收',
  },
  {
    key: 'region',
    icon: <svg viewBox="0 0 20 20"><path d="M7 3.25H4.5A1.25 1.25 0 0 0 3.25 4.5V7M13 3.25h2.5A1.25 1.25 0 0 1 16.75 4.5V7M16.75 13v2.5a1.25 1.25 0 0 1-1.25 1.25H13M7 16.75H4.5a1.25 1.25 0 0 1-1.25-1.25V13" /></svg>,
    label: '区域验收',
    pending: true,
  },
  {
    key: 'overlay',
    icon: <svg viewBox="0 0 20 20"><rect x="5.25" y="3.25" width="11.5" height="12" rx="1.5" /><path d="M13.25 16.75H5A1.75 1.75 0 0 1 3.25 15V6.5" /></svg>,
    label: '叠图验收',
  },
];

const MARK_TOOLS: ToolSpec[] = [
  {
    key: 'picker',
    icon: <svg viewBox="0 0 20 20"><path d="m12.75 3.25 4 4M10.75 5.25l4 4M13.75 6.25l-7.5 7.5M5.25 13.25l1.5 1.5-3 2 2-3.5ZM11.5 4.5l2-2a1.77 1.77 0 0 1 2.5 0l1.5 1.5a1.77 1.77 0 0 1 0 2.5l-2 2" /></svg>,
    label: '取色',
  },
  {
    key: 'rect',
    icon: <svg viewBox="0 0 20 20"><rect x="3.25" y="4.25" width="13.5" height="11.5" rx="1.25" /></svg>,
    label: '画框',
  },
  {
    key: 'arrow',
    icon: <svg viewBox="0 0 20 20"><path d="M4 16 15.75 4.25M7 4.25h8.75V13" /></svg>,
    label: '箭头',
  },
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
  activeTool,
  onActiveToolChange,
  compare,
  onCompareChange,
  overlayOpacity,
  onOverlayOpacityChange,
  wipeRatio,
  onWipeRatioChange,
  overlayOffset,
  onOverlayOffsetReset,
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
        : tool.key === 'picker'
          ? '取色：点击画布中的像素，读取当前颜色'
          : tool.key === 'rect'
            ? '画框：在画布上拖拽创建矩形标注'
            : tool.key === 'arrow'
              ? '箭头：在画布上拖拽创建方向标注'
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
        <span className="ico" aria-hidden="true">{tool.icon}</span>
        <span className="label">{tool.label}</span>
      </button>
    );
  };

  return (
    <>
      <div className="toolbar">
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
        <div className="toolbar-tool-group" role="group" aria-label="验收模式">
          {MODE_TOOLS.map(renderTool)}
        </div>
        <div className="toolbar-tool-group annotation-tools" role="group" aria-label="标注工具">
          {MARK_TOOLS.map(renderTool)}
        </div>
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

          <div className="overlay-offset" aria-label="截图偏移量">
            <span className="subrow-title">偏移</span>
            <span className="overlay-offset-value">X {overlayOffset.x} · Y {overlayOffset.y} px</span>
            <button
              type="button"
              className="overlay-offset-reset"
              title="重置截图偏移"
              aria-label="重置截图偏移"
              disabled={overlayOffset.x === 0 && overlayOffset.y === 0}
              onClick={onOverlayOffsetReset}
            >
              ↺
            </button>
          </div>

          <span className="cmp-hint">
            拖动截图对齐；方向键微调 1 px，Shift + 方向键移动 10 px
          </span>
        </div>
      )}
    </>
  );
};

export default VerifyToolbar;
