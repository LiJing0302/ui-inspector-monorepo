import type {
  ExportOptions,
  FrameBrief,
  PageBrief,
  PluginToUIMessage,
  SelectionGranularity,
  UIToPluginMessage,
} from '../shared/types';
import {
  BRIDGE_DEFAULT_PORT,
  type BridgeConflictPolicy,
  type BridgeRequirementBrief,
} from '../shared/bridge';
import { BridgeClient, type BridgeState } from './bridge';
import './ui.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const CONTAINERS = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

const selected = new Set<string>();
let pages: PageBrief[] = [];
/** 画布选区解析出的导出目标（可能不在扫描列表里，比如某个具体的 TEXT 图层） */
let selectionFrames: FrameBrief[] = [];
let exporting = false;

/** 导出产物往哪去：下载到本机，还是直传 Mac 应用 */
let target: 'zip' | 'mac' = 'zip';

const bridge = new BridgeClient();
/** 去重：同一时刻只允许一次"连接 + 取需求列表"，否则两个 waiter 会撞在同一个槽位上 */
let macRefresh: Promise<boolean> | null = null;
/** 上一次渲染过的需求 id 串，用来判断下拉需不需要重建（否则上传进度刷新会把选中项弹掉） */
let requirementSignature = '';

function send(msg: UIToPluginMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.className = level === 'error' ? 'e' : level === 'warn' ? 'w' : '';
  el.textContent = message;
  const box = $('log');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function setStatus(text: string): void {
  $('status').textContent = text;
}

function typeLabel(type: string): string {
  switch (type) {
    case 'TEXT':
      return 'T';
    case 'RECTANGLE':
      return '▭';
    case 'ELLIPSE':
      return '◯';
    case 'VECTOR':
    case 'LINE':
      return '／';
    case 'INSTANCE':
      return '◆';
    case 'COMPONENT':
      return '◈';
    case 'FRAME':
      return '▢';
    case 'GROUP':
      return '▣';
    default:
      return '·';
  }
}

function frameRow(f: FrameBrief, showType = false): string {
  const badge = showType
    ? `<span class="ty" title="${escapeHtml(f.type)}">${typeLabel(f.type)}</span>`
    : '';
  return `<div class="item" data-frame="${f.id}" title="${escapeHtml(f.path || f.name)}">
    <input type="checkbox" data-frame="${f.id}" ${selected.has(f.id) ? 'checked' : ''} />
    ${badge}
    <span class="nm">${escapeHtml(f.name)}</span>
    <span class="sz">${f.width}×${f.height}</span>
  </div>`;
}

function render(): void {
  const box = $('list');
  if (!pages.length) {
    box.innerHTML = '<div class="empty">没有找到可作为设计稿的 Frame / Component / Section</div>';
    return;
  }

  const unit = selectionFrames.some((f) => !CONTAINERS.has(f.type)) ? '元素' : '设计稿';
  // 「当前选区」永远置顶：保证画布点什么就勾什么，不受扫描候选范围限制
  const selectionGroup = selectionFrames.length
    ? `<div class="page">
        <div class="page-head">
          <span class="nm">当前选区</span>
          <span class="sz">${selectionFrames.length} 个${unit}</span>
        </div>
        ${selectionFrames.map((f) => frameRow(f, true)).join('')}
      </div>`
    : '';

  box.innerHTML =
    selectionGroup +
    pages
    .map((page) => {
      const allIds = page.frames.map((f) => f.id);
      const checkedCount = allIds.filter((id) => selected.has(id)).length;
      const pageState = checkedCount === 0 ? '' : checkedCount === allIds.length ? 'checked' : 'indeterminate';

      const items = page.frames.map((f) => frameRow(f)).join('');

      return `<div class="page">
        <div class="page-head">
          <input type="checkbox" data-page="${page.id}" ${pageState === 'checked' ? 'checked' : ''} />
          <span class="nm">${escapeHtml(page.name)}</span>
          <span class="sz">${page.frames.length}</span>
        </div>
        ${items || '<div class="item" style="padding-left:24px;color:#9ca3af">（无）</div>'}
      </div>`;
    })
    .join('');

  // 页面级 checkbox 的半选态
  pages.forEach((page) => {
    const ids = page.frames.map((f) => f.id);
    const el = box.querySelector<HTMLInputElement>(`input[data-page="${page.id}"]`);
    if (!el) return;
    const c = ids.filter((id) => selected.has(id)).length;
    el.indeterminate = c > 0 && c < ids.length;
  });

  bindList();
  updateExportButton();
}

function bindList(): void {
  const box = $('list');
  box.querySelectorAll<HTMLInputElement>('input[data-page]').forEach((el) => {
    el.onclick = (e) => e.stopPropagation();
    el.onchange = () => {
      const page = pages.find((p) => p.id === el.dataset.page);
      if (!page) return;
      page.frames.forEach((f) => (el.checked ? selected.add(f.id) : selected.delete(f.id)));
      render();
    };
  });

  box.querySelectorAll<HTMLInputElement>('input[data-frame]').forEach((el) => {
    el.onchange = () => {
      const id = el.dataset.frame!;
      if (el.checked) selected.add(id);
      else selected.delete(id);
      render();
    };
  });

  box.querySelectorAll<HTMLElement>('.item[data-frame]').forEach((el) => {
    el.onclick = (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const id = el.dataset.frame!;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      render();
    };
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 把一组设计稿 id 设为当前勾选（画布选择同步用），返回命中数量 */
function applySelection(ids: string[]): number {
  selected.clear();
  ids.forEach((id) => selected.add(id));
  render();
  scrollToFirstSelected();
  return selected.size;
}

function scrollToFirstSelected(): void {
  const first = $('list').querySelector<HTMLElement>('.item input[data-frame]:checked');
  if (first) {
    const row = first.closest('.item') as HTMLElement | null;
    row?.scrollIntoView({ block: 'center' });
  }
}

function followCanvas(): boolean {
  return $<HTMLInputElement>('opt-follow').checked;
}

/** 已勾选里的叶子元素（非容器）数量，用于状态文案 */
function leafCount(): number {
  const all = new Map<string, FrameBrief>();
  pages.forEach((p) => p.frames.forEach((f) => all.set(f.id, f)));
  selectionFrames.forEach((f) => all.set(f.id, f));
  let n = 0;
  selected.forEach((id) => {
    const f = all.get(id);
    if (f && !CONTAINERS.has(f.type)) n += 1;
  });
  return n;
}

function updateExportButton(): void {
  const btn = $<HTMLButtonElement>('export');
  btn.disabled = exporting || selected.size === 0;
  if (exporting) return;
  if (!selected.size) {
    setStatus('在画布点选要导出的节点，或在下方勾选');
    return;
  }
  const leaf = leafCount();
  setStatus(
    leaf
      ? `已选 ${selected.size} 个导出目标（含 ${leaf} 个具体元素）`
      : `已选 ${selected.size} 个设计稿`,
  );
}

function collectOptions(): ExportOptions {
  return {
    frameIds: Array.from(selected),
    scale: Number($<HTMLSelectElement>('opt-scale').value),
    format: $<HTMLSelectElement>('opt-format').value as 'PNG' | 'JPG',
    withScreenshot: $<HTMLInputElement>('opt-screenshot').checked,
    includeHidden: $<HTMLInputElement>('opt-hidden').checked,
    includeImageFills: $<HTMLInputElement>('opt-image').checked,
    maxDepth: Number($<HTMLSelectElement>('opt-depth').value),
    includeNestedFrames: $<HTMLInputElement>('opt-nested').checked,
    includePreview: $<HTMLInputElement>('opt-preview').checked,
  };
}

function download(data: Uint8Array, fileName: string): void {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const blob = new Blob([buffer], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

/* ------------------------------ 直传到 Mac 应用 ------------------------------ */

/** 把需求列表灌进下拉。列表没变就不重建 —— 否则上传进度带来的重渲染会把用户的选择弹掉 */
function renderRequirements(items: BridgeRequirementBrief[]): void {
  const select = $<HTMLSelectElement>('mac-requirement');
  // 签名必须把「空列表」和「还没请求过」区分开：两者 join 出来都是空串，
  // 而初值也正是 '' —— 裸 join 会让「Mac 里一个需求都没有」永远渲染不出来。
  const signature = `${items.length}#${items.map((item) => item.id).join('|')}`;
  if (signature === requirementSignature) return;
  requirementSignature = signature;

  const previous = select.value;
  if (!items.length) {
    select.innerHTML = '<option value="">（Mac 应用里还没有需求）</option>';
    return;
  }

  select.innerHTML = items
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · 设计稿 ${item.designCount} · 配对 ${item.pairCount}</option>`,
    )
    .join('');

  if (items.some((item) => item.id === previous)) select.value = previous;
}

function setMacHint(text: string, bad = false): void {
  const hint = $('mac-hint');
  hint.textContent = text;
  hint.className = bad ? 'mac-hint bad' : 'mac-hint';
}

function renderMacState(state: BridgeState): void {
  const dot = $('mac-dot');
  const label = $('mac-state');
  const connect = $<HTMLButtonElement>('mac-connect');
  const reload = $('mac-reload');
  const pipelining = state.phase === 'connecting' || state.phase === 'uploading';

  dot.className = 'mac-dot';

  if (state.phase === 'connecting') {
    dot.classList.add('busy');
    label.textContent = '正在连接…';
    connect.disabled = true;
    connect.textContent = '连接中';
    setMacHint('正在连接 Mac 应用…');
  } else if (state.phase === 'uploading') {
    dot.classList.add('busy');
    label.textContent = `正在发送 ${Math.round((state.progress ?? 0) * 100)}%`;
    connect.disabled = true;
    connect.textContent = '发送中';
    setMacHint('正在把 zip 发送到 Mac 应用，请稍候…');
  } else if (state.phase === 'ready') {
    dot.classList.add('ready');
    label.textContent = `已连接 :${state.port}`;
    connect.disabled = false;
    connect.textContent = '重新连接';
    reload.hidden = false;
    setMacHint('已连接。选好目标需求后点「导出并发送」，设计稿会直接出现在 Mac 应用的这个需求里。');
    renderRequirements(state.requirements);
  } else {
    label.textContent = '未连接';
    connect.disabled = false;
    connect.textContent = '连接';
    reload.hidden = true;
    setMacHint('在 Mac 应用打开「UI 验收投屏」，等顶栏「插件直传」显示为「就绪」后点「连接」。');
  }

  // 错误信息优先于引导文案 —— 它通常就是"为什么连不上"的答案
  if (state.error) {
    dot.className = 'mac-dot bad';
    setMacHint(state.error, true);
  }

  // 上传中不许切输出目标：两套请求会撞在同一个 waiter 槽位上
  $<HTMLInputElement>('target-zip').disabled = pipelining;
  $<HTMLInputElement>('target-mac').disabled = pipelining;
}

bridge.onState = renderMacState;

async function refreshMac(): Promise<boolean> {
  if (macRefresh) return macRefresh;

  macRefresh = (async (): Promise<boolean> => {
    try {
      await bridge.ensureReady(BRIDGE_DEFAULT_PORT);
      renderRequirements(await bridge.listRequirements(BRIDGE_DEFAULT_PORT));
      return true;
    } catch (error) {
      setMacHint((error as Error).message, true);
      return false;
    }
  })().finally(() => {
    macRefresh = null;
  });

  return macRefresh;
}

function applyTarget(): void {
  target = $<HTMLInputElement>('target-mac').checked ? 'mac' : 'zip';
  $('mac-panel').hidden = target !== 'mac';
  // 文案跟着目标走：面板里提示「点导出并发送」，按钮却写「导出 ZIP」会让人找不到
  $('export').textContent = target === 'mac' ? '导出并发送' : '导出 ZIP';
  renderMacState(bridge.getState());
  updateExportButton();

  // 切到直传就顺手连一次；这里失败也不阻塞导出（点发送时还会再试）
  if (target === 'mac') void refreshMac();
}

/** 导出成本很高（截图可能跑几分钟），通道出问题不能白丢 —— 兜底改成下载 */
function fallbackDownload(payload: { data: Uint8Array; fileName: string }): void {
  log('已改为下载 ZIP，需要时手动拖进 Mac 应用即可', 'warn');
  download(payload.data, payload.fileName);
}

async function sendToMac(payload: {
  data: Uint8Array;
  fileName: string;
  frameCount: number;
}): Promise<void> {
  const requirementId = $<HTMLSelectElement>('mac-requirement').value;
  if (!requirementId) {
    log('没有可发送的目标需求：请先连接 Mac 应用，并在「目标需求」里选一个', 'error');
    setStatus('发送失败：未选择目标需求');
    fallbackDownload(payload);
    return;
  }

  const conflict = $<HTMLSelectElement>('mac-conflict').value as BridgeConflictPolicy;

  try {
    setStatus('正在发送到 Mac 应用…');
    const result = await bridge.upload({
      requirementId,
      fileName: payload.fileName,
      bytes: payload.data,
      conflict,
    });

    if (result.fatal) {
      log(`Mac 应用拒绝了这个包：${result.fatal}`, 'error');
      setStatus('发送失败：Mac 应用拒绝了这个包');
      fallbackDownload(payload);
      return;
    }

    const MARK: Record<string, string> = { imported: '✓', replaced: '↻', skipped: '＝', failed: '✕' };
    for (const frame of result.frames) {
      const level = frame.status === 'failed' ? 'error' : frame.status === 'skipped' ? 'warn' : 'info';
      log(
        `${MARK[frame.status] ?? '·'} ${frame.name} — ${frame.nodeCount} 个节点（${frame.status}${
          frame.reason ? `：${frame.reason}` : ''
        }）`,
        level,
      );
    }

    const count = (status: string): number =>
      result.frames.filter((frame) => frame.status === status).length;
    setStatus(
      `已发送到 Mac 应用：新增 ${count('imported')}、覆盖 ${count('replaced')}、跳过 ${count('skipped')}`,
    );
    send({ type: 'NOTIFY', message: `已发送到 Mac 应用：${result.frames.length} 个导出目标` });
  } catch (error) {
    log((error as Error).message, 'error');
    setStatus('发送失败，已改为下载 ZIP');
    fallbackDownload(payload);
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

function granularity(): SelectionGranularity {
  return $<HTMLSelectElement>('opt-granularity').value as SelectionGranularity;
}

$('refresh').onclick = () => {
  send({ type: 'SCAN', includeNestedFrames: $<HTMLInputElement>('opt-nested').checked, granularity: granularity() });
  setStatus('扫描中…');
};

$<HTMLInputElement>('opt-nested').onchange = () => {
  send({ type: 'SCAN', includeNestedFrames: $<HTMLInputElement>('opt-nested').checked, granularity: granularity() });
};

$<HTMLSelectElement>('opt-granularity').onchange = () => {
  if (granularity() === 'element') setStatus('粒度已切换：导出点中的元素本身');
  else setStatus('粒度已切换：导出元素所属的最近容器');
};

$<HTMLInputElement>('opt-follow').onchange = () => {
  if (followCanvas() && selectionFrames.length) {
    const hit = applySelection(selectionFrames.map((f) => f.id));
    if (hit) setStatus(`已按画布选择勾选 ${hit} 个节点`);
  }
};

$('select-all').onclick = () => {
  pages.forEach((p) => p.frames.forEach((f) => selected.add(f.id)));
  render();
};

$('select-none').onclick = () => {
  selected.clear();
  render();
};

$('use-selection').onclick = () => {
  if (!selectionFrames.length) {
    setStatus('画布里还没有选中节点，先在画布点一个图层（可以是任意层级的元素）');
    return;
  }
  const hit = applySelection(selectionFrames.map((f) => f.id));
  setStatus(`已按画布选择勾选 ${hit} 个节点`);
};

$('export').onclick = () => {
  if (!selected.size) return;
  exporting = true;
  updateExportButton();
  $('bar').style.width = '0%';
  $('log').innerHTML = '';
  send({ type: 'EXPORT', options: collectOptions() });
};

// 「输出目标」两个单选 + 面板里的两个按钮。
// 少了这几行，点「直接发送到 Mac 应用」只是浏览器把单选框勾上，
// mac-panel 的 hidden 永远摘不掉 —— 需求下拉也就永远不出现。
$<HTMLInputElement>('target-zip').onchange = applyTarget;
$<HTMLInputElement>('target-mac').onchange = applyTarget;
$('mac-connect').onclick = () => void refreshMac();
$('mac-reload').onclick = () => void refreshMac();

window.onmessage = (event: MessageEvent): void => {
  const msg = event.data?.pluginMessage as PluginToUIMessage | undefined;
  if (!msg) return;

  switch (msg.type) {
    case 'SCAN_RESULT': {
      pages = msg.pages;
      selectionFrames = msg.selection ?? [];
      $('file-name').textContent = msg.fileName || '未命名文件';
      if (msg.error) log(`扫描失败：${msg.error}`, 'error');
      // 扫描后保留仍然存在的选中项：扫描列表 + 当前选区里的元素都要算
      const alive = new Set(pages.flatMap((p) => p.frames.map((f) => f.id)));
      selectionFrames.forEach((f) => alive.add(f.id));
      Array.from(selected).forEach((id) => {
        if (!alive.has(id)) selected.delete(id);
      });
      if (followCanvas() && selectionFrames.length) {
        const hit = applySelection(selectionFrames.map((f) => f.id));
        if (hit) setStatus(`已按画布选择勾选 ${hit} 个节点`);
      }
      break;
    }
    case 'SELECTION_CHANGED': {
      selectionFrames = msg.frames;
      if (!followCanvas()) {
        render();
        break;
      }
      if (msg.frames.length) {
        const hit = applySelection(msg.frames.map((f) => f.id));
        setStatus(`画布选择已同步：勾选 ${hit} 个节点`);
      } else {
        // 画布取消选择 → 只清空「当前选区」分组，保留手动勾选
        render();
        if (msg.rawCount > 0) setStatus('选中的图层无法作为导出目标');
      }
      break;
    }
    case 'EXPORT_PROGRESS': {
      const pct = msg.total ? Math.round((msg.current / msg.total) * 100) : 0;
      $('bar').style.width = `${pct}%`;
      setStatus(`${msg.label}（${msg.current}/${msg.total}）`);
      break;
    }
    case 'EXPORT_DONE': {
      $('bar').style.width = '100%';
      exporting = false;
      updateExportButton();

      // 直传模式下 zip 不再落盘：产物直接在内存里发给 Mac 应用。
      // 需要注意的是 code.ts 完全不用改 —— zip 字节流本来就经 EXPORT_DONE 送到 UI 了。
      if (target === 'mac') {
        void sendToMac(msg);
        break;
      }

      download(msg.data, msg.fileName);
      setStatus(`导出完成：${msg.frameCount} 个导出目标，${(msg.bytes / 1024 / 1024).toFixed(2)} MB`);
      log(`已生成 ${msg.fileName}`, 'info');
      break;
    }
    case 'EXPORT_ERROR': {
      exporting = false;
      updateExportButton();
      log(msg.message, 'error');
      setStatus('导出失败，请查看日志');
      break;
    }
    case 'LOG':
      log(msg.message, msg.level);
      break;
    default:
      break;
  }
};

applyTarget();
send({ type: 'SCAN', includeNestedFrames: false, granularity: granularity() });
