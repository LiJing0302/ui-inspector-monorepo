import React, { useCallback, useRef, useState } from 'react';

import type { ConflictPolicy, ImportResult } from '@shared/ipc';

interface ImportDropZoneProps {
  requirementId: string;
  onImported: () => void;
}

const STATUS_TEXT: Record<string, string> = {
  imported: '已导入',
  replaced: '已覆盖',
  skipped: '已跳过',
  failed: '失败',
};

/**
 * Figma 导出包导入区：拖拽 zip / 导出文件夹，或点选。
 *
 * ⚠️ 拖拽取路径不能用 `file.path` —— Electron 30 已移除该属性，
 * 必须走 preload 桥接的 `webUtils.getPathForFile()`。
 */
const ImportDropZone: React.FC<ImportDropZoneProps> = ({ requirementId, onImported }) => {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictPolicy>('skip');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // dragenter/dragleave 会在子元素间反复触发，用计数抵消
  const dragDepth = useRef(0);

  const runImport = useCallback(
    async (sourcePath: string) => {
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const imported = await window.api.verify.importFigmaPackage({
          requirementId,
          sourcePath,
          conflict,
        });
        setResult(imported);
        if (!imported.fatal && imported.frames.some((frame) => frame.status !== 'failed')) {
          onImported();
        }
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [conflict, onImported, requirementId],
  );

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) {
        setError('没有拿到文件，请从访达拖拽 zip 或文件夹');
        return;
      }

      const sourcePath = window.api.verify.getDroppedFilePath(files[0]!);
      if (!sourcePath) {
        setError('无法获取拖拽文件的真实路径，请改用「选择文件」按钮');
        return;
      }
      await runImport(sourcePath);
    },
    [runImport],
  );

  const handlePick = useCallback(async () => {
    const picked = await window.api.verify.pickImportPath();
    if (!picked) return;
    await runImport(picked);
  }, [runImport]);

  return (
    <div className="import-zone">
      <div
        className={`drop-target${dragging ? ' dragging' : ''}${busy ? ' busy' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDrop={(event) => void handleDrop(event)}
      >
        <div className="drop-title">{busy ? '正在导入…' : '把 Figma 导出包拖到这里'}</div>
        <div className="drop-sub">支持插件导出的 .zip，或直接拖导出后的文件夹</div>
        <button type="button" className="btn" disabled={busy} onClick={() => void handlePick()}>
          选择文件 / 文件夹
        </button>
      </div>

      <div className="import-options">
        <span className="field-label">同 frameId 重复导入时</span>
        <label className="radio">
          <input
            type="radio"
            name={`conflict-${requirementId}`}
            checked={conflict === 'skip'}
            onChange={() => setConflict('skip')}
          />
          跳过
        </label>
        <label className="radio">
          <input
            type="radio"
            name={`conflict-${requirementId}`}
            checked={conflict === 'replace'}
            onChange={() => setConflict('replace')}
          />
          覆盖
        </label>
      </div>

      {error && <div className="alert error">{error}</div>}

      {result?.fatal && <div className="alert error">导入失败（未写入任何数据）：{result.fatal}</div>}

      {result && !result.fatal && (
        <div className="import-result">
          <div className="import-result-head">
            <span className="pkg-name">{result.packageName}</span>
            <span className="pkg-count">共 {result.frames.length} 帧</span>
          </div>
          <ul className="frame-list">
            {result.frames.map((frame) => (
              <li key={frame.frameId} className={`frame-item ${frame.status}`}>
                <span className={`status-dot ${frame.status}`} />
                <span className="frame-name">{frame.name}</span>
                <span className="frame-meta">
                  {frame.width}×{frame.height} · {frame.nodeCount} 节点
                </span>
                {!frame.isFrameLevel && <span className="tag warn-tag">元素级</span>}
                <span className={`frame-status ${frame.status}`}>{STATUS_TEXT[frame.status] ?? frame.status}</span>
                {frame.reason && <span className="frame-reason">{frame.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default ImportDropZone;
