import React from 'react';

import { hintsFor, type CanvasHintMode } from '../lib/shortcuts';

interface CanvasHintBarProps {
  mode: CanvasHintMode;
}

/**
 * 画布底部的键位提示条 —— **常驻**（`CanvasBoard` 的 `.canvas-area` 最后一个子项）。
 *
 * 为什么常驻而不是「选中了才显示」：要解决的问题是**没人知道 ⌘ 能干什么**。
 * 只在选中后才出现的提示，对「我还不知道有这个功能」的人等于不存在。
 *
 * 为什么是布局里的真条子、而不是像 `.calib-bar` / `.annotation-tray` 那样浮在画布上：
 * 画布的职责是让像素被看清，任何浮层都在吃它的面积；而这条提示没有时效性，
 * 占固定高度、永远不遮内容，比浮层划算。代价是画布少 28px（实测 834px 宽下 1 行）。
 *
 * ⚠️ 行数会随画布宽度变（`flex-wrap: wrap`）：**加条目 = 可能把后面几条挤到第二行 =
 *    画布高度跟着跳**，所以改完必须按真实宽度量一遍
 *    （做法见 skill `uii-renderer-ui-preview` 的 `mount-hintbar.tsx`）。
 *    2026-09-28 实测：砍掉 ⌥ 整帧 / 右键菜单 / Enter 下钻之后剩 4 条，
 *    900 / 834 / 534（窗宽到 minWidth 1100 时的画布宽）**都是 1 行 28px、全部可见** ——
 *    原来 6 条时 534 会折成 2 行，这次瘦身顺带把它压回一行了。
 *
 * 文案全部来自 `lib/shortcuts`：这里只负责排版，**一个字的键位描述都不许自己写**。
 */
export const CanvasHintBar = ({ mode }: CanvasHintBarProps): React.ReactElement => {
  const hints = hintsFor(mode);

  return (
    <div
      className={`canvas-hints${mode === 'annotate' ? ' annotate' : ''}`}
      role="note"
      aria-label="画布快捷键"
    >
      {/* 序号的 key 用 label：同一模式下不会重复，比数组下标稳（改顺序时不会错位复用 DOM） */}
      {hints.map((hint) => (
        <span className="canvas-hint" key={`${mode}:${hint.label}`} title={hint.detail ?? hint.label}>
          <span className="canvas-hint-keys">
            {hint.keys.map((key) => (
              <kbd key={key}>{key}</kbd>
            ))}
          </span>
          <span className="canvas-hint-label">{hint.label}</span>
        </span>
      ))}
    </div>
  );
};

export default CanvasHintBar;
