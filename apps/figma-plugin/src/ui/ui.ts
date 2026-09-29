import type {
  ExportOptions,
  FrameBrief,
  PluginToUIMessage,
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
/** 当前 Figma 选区解析出的导出目标 */
let selectionFrames: FrameBrief[] = [];
let exporting = false;

const bridge = new BridgeClient();
/** 去重：同一时刻只允许一次"连接 + 取需求列表"，否则两个 waiter 会撞在同一个槽位上 */
let macRefresh: Promise<boolean> | null = null;
/** 上一次渲染过的需求 id 串，用来判断下拉需不需要重建（否则上传进度刷新会把选中项弹掉） */
let requirementSignature = '';

function send(msg: UIToPluginMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

/**
 * 面板里**没有**日志区了：逐帧明细 / 异常堆栈这类「排查时想看、平时嫌吵」的内容
 * 全部转投 DevTools console（Figma 里右键插件 → Inspect 或「插件 → 开发 → 打开控制台」）。
 * 名字用 trace 而不是 log，是为了让后来的人一眼看出「这条不画到界面上」。
 */
function trace(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const print = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  print(`[设计稿节点导出] ${message}`);
}

/** 状态行只放一行：多行内容（典型是异常堆栈）只取首行，其余挂 tooltip 与 console */
function firstLine(text: string, max = 120): string {
  const line = text.split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 状态行是唯一的人可见通道。tone = 'bad' 时染红，并把完整 detail 挂到 tooltip ——
 * 截断的通常正是「为什么失败」，不能就这么丢掉。
 */
function setStatus(text: string, tone: 'info' | 'bad' = 'info', detail?: string): void {
  const el = $('status');
  el.textContent = text;
  el.className = tone === 'bad' ? 'status bad' : 'status';
  el.title = tone === 'bad' && detail && detail !== text ? detail : '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 将 Figma 当前选区设为唯一导出目标 */
function applySelection(ids: string[]): number {
  selected.clear();
  ids.forEach((id) => selected.add(id));
  updateExportButton();
  return selected.size;
}

/** 已勾选里的叶子元素（非容器）数量，用于状态文案 */
function leafCount(): number {
  const all = new Map<string, FrameBrief>();
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
    setStatus('在 Figma 画布或图层面板选择要导出的节点');
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
    withScreenshot: true,
    includeHidden: false,
    includeImageFills: false,
    includeNestedFrames: true,
    includePreview: false,
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

/** 分段控件与下拉注释的文案，和 mac-conflict 这个隐藏 value 一一对应 */
const CONFLICT_NOTE: Record<BridgeConflictPolicy, string> = {
  skip: '保留 Mac 上已有的',
  replace: '用本次导出替换',
};

function setConflict(policy: BridgeConflictPolicy): void {
  $<HTMLInputElement>('mac-conflict').value = policy;

  const skip = $('mac-conflict-skip');
  const replace = $('mac-conflict-replace');
  skip.classList.toggle('on', policy === 'skip');
  replace.classList.toggle('on', policy === 'replace');
  // 极窄面板下右侧注释会被 CSS 收起，把完整语义同时挂到 tooltip 上兜底
  skip.title = `重复页面 · 跳过（${CONFLICT_NOTE.skip}）`;
  replace.title = `重复页面 · 覆盖（${CONFLICT_NOTE.replace}）`;

  $('mac-conflict-note').textContent = CONFLICT_NOTE[policy];
}

/** 把需求列表灌进下拉。列表没变就不重建 —— 否则上传进度带来的重渲染会把用户的选择弹掉 */
function renderRequirements(items: BridgeRequirementBrief[]): void {
  const select = $<HTMLSelectElement>('mac-requirement');
  // 签名必须把「空列表」和「还没请求过」区分开：两者 join 出来都是空串，
  // 而初值也正是 '' —— 裸 join 会让「Mac 里一个需求都没有」永远渲染不出来。
  const signature = `${items.length}#${items.map((item) => item.id).join('|')}`;

  if (signature !== requirementSignature) {
    requirementSignature = signature;

    const previous = select.value;
    select.innerHTML = items.length
      ? items
          .map(
            (item) =>
              `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.designCount} 稿 · ${item.pairCount} 配对</option>`,
          )
          .join('')
      : '<option value="">（Mac 应用里还没有需求）</option>';

    if (items.length && items.some((item) => item.id === previous)) select.value = previous;
  }

  // 每次都要判：否则「导出后会落到这个需求里」会和空白下拉里的「还没有需求」自相矛盾
  if (!items.length) {
    setMacHint('Mac 应用里还没有需求：先在 Mac 应用新建一个需求，再点「刷新需求」');
  }
}

function setMacHint(text: string, bad = false): void {
  const hint = $('mac-hint');
  hint.textContent = text;
  hint.className = bad ? 'mac-hint bad' : 'mac-hint';
}

/** 徽标的色调。一个 class 同时决定圆点、文字和底色，别再各自配一遍 */
type MacTone = 'idle' | 'ok' | 'busy' | 'bad';

function renderMacState(state: BridgeState): void {
  const badge = $('mac-badge');
  const body = $('mac-body');
  const connect = $<HTMLButtonElement>('mac-connect');
  badge.title = `localhost:${state.port}`;

  let tone: MacTone = 'idle';

  if (state.phase === 'connecting') {
    tone = 'busy';
    $('mac-state').textContent = '连接中';
    connect.disabled = true;
    connect.textContent = '连接中';
    // 连接/未连接时不展开字段：没有可选项，摊开只会挤占本来就很窄的面板
    body.hidden = true;
    setMacHint('正在连接 Mac 应用…');
  } else if (state.phase === 'uploading') {
    tone = 'busy';
    $('mac-state').textContent = `发送中 ${Math.round((state.progress ?? 0) * 100)}%`;
    connect.disabled = true;
    connect.textContent = '发送中';
    body.hidden = false;
    setMacHint('正在把 zip 发送到 Mac 应用，请稍候…');
  } else if (state.phase === 'ready') {
    tone = 'ok';
    $('mac-state').textContent = '已连接';
    connect.disabled = false;
    // 「刷新需求」在断开时会自动重连，所以不再需要一个单独的「重新连接」按钮
    connect.textContent = '刷新需求';
    body.hidden = false;
    setMacHint('导出后设计稿会直接落到这个需求里');
    renderRequirements(state.requirements);
  } else {
    $('mac-state').textContent = '未连接';
    connect.disabled = false;
    connect.textContent = '连接';
    body.hidden = true;
    setMacHint('在 Mac 应用打开「UI 验收投屏」，等顶栏「插件直传」显示为「就绪」后点「连接」');
  }

  // 错误信息优先于引导文案 —— 它通常就是"为什么连不上"的答案
  if (state.error) {
    tone = 'bad';
    setMacHint(state.error, true);
  }

  badge.className = `mac-badge ${tone}`;
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

/**
 * 导出成本很高（截图可能跑几分钟），通道出问题不能白丢 —— 兜底改成下载。
 * 状态行是这个界面唯一的出口，所以「失败原因 + 已经替你下载了」必须一起说清楚。
 */
function fallbackDownload(
  payload: { data: Uint8Array; fileName: string },
  reason: string,
): void {
  trace(`发送到 Mac 应用失败，已改为下载 ZIP：${reason}`, 'error');
  setStatus(`发送失败，已改为下载 ZIP：${firstLine(reason)}`, 'bad', reason);
  download(payload.data, payload.fileName);
}

async function sendToMac(payload: {
  data: Uint8Array;
  fileName: string;
  frameCount: number;
}): Promise<void> {
  const requirementId = $<HTMLSelectElement>('mac-requirement').value;
  if (!requirementId) {
    fallbackDownload(payload, '没有选中「目标需求」：请先点「连接」拉取需求列表，再选一个');
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
      fallbackDownload(payload, `Mac 应用拒绝了这个包：${result.fatal}`);
      return;
    }

    const MARK: Record<string, string> = { imported: '✓', replaced: '↻', skipped: '＝', failed: '✕' };
    for (const frame of result.frames) {
      const level = frame.status === 'failed' ? 'error' : frame.status === 'skipped' ? 'warn' : 'info';
      trace(
        `${MARK[frame.status] ?? '·'} ${frame.name} — ${frame.nodeCount} 个节点（${frame.status}${
          frame.reason ? `：${frame.reason}` : ''
        }）`,
        level,
      );
    }

    const count = (status: string): number =>
      result.frames.filter((frame) => frame.status === status).length;
    const failed = result.frames.filter((frame) => frame.status === 'failed');
    const summary = `已发送到 Mac 应用：新增 ${count('imported')}、覆盖 ${count('replaced')}、跳过 ${count('skipped')}`;
    // 汇总是正常态；只要有失败的，就把第一个失败原因顶上来 —— 否则「失败 0」和「有失败」
    // 在状态行上长得一样，用户只能去 console 里翻
    if (failed.length) {
      const reason = failed[0].reason ?? '未提供原因';
      setStatus(`${summary}、失败 ${failed.length}：${firstLine(reason)}`, 'bad', reason);
    } else {
      setStatus(summary);
    }
    send({ type: 'NOTIFY', message: `已发送到 Mac 应用：${result.frames.length} 个导出目标` });
  } catch (error) {
    fallbackDownload(payload, (error as Error).message);
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

function granularity(): 'element' {
  return 'element';
}

/**
 * 进度条默认藏着：空的时候它就是一条 4px 灰线浮在主按钮下面，看着像误画的分隔线。
 * 导出时才出现，跑完再淡出。
 */
let progressTimer = 0;

function showProgress(): void {
  window.clearTimeout(progressTimer);
  $('prog').hidden = false;
  $('bar').style.width = '0%';
}

function hideProgress(delayMs = 0): void {
  window.clearTimeout(progressTimer);
  progressTimer = window.setTimeout(() => {
    $('prog').hidden = true;
  }, delayMs);
}

$('refresh').onclick = () => {
  send({ type: 'SCAN', includeNestedFrames: true, granularity: granularity() });
  setStatus('扫描中…');
};

$('export').onclick = () => {
  if (!selected.size) return;
  exporting = true;
  updateExportButton();
  showProgress();
  send({ type: 'EXPORT', options: collectOptions() });
};

$('mac-connect').onclick = () => void refreshMac();
$('mac-conflict-skip').onclick = () => setConflict('skip');
$('mac-conflict-replace').onclick = () => setConflict('replace');
// 让注释文案和 html 里预设的 .on 保持一致（真源是 mac-conflict 那个隐藏 value）
setConflict('skip');

window.onmessage = (event: MessageEvent): void => {
  const msg = event.data?.pluginMessage as PluginToUIMessage | undefined;
  if (!msg) return;

  switch (msg.type) {
    case 'SCAN_RESULT': {
      selectionFrames = msg.selection ?? [];
      $('file-name').textContent = msg.fileName || '未命名文件';
      if (msg.error) {
        trace(`扫描失败：${msg.error}`, 'error');
        setStatus(`扫描失败：${firstLine(msg.error)}`, 'bad', msg.error);
      }
      if (selectionFrames.length) {
        const hit = applySelection(selectionFrames.map((f) => f.id));
        if (hit) setStatus(`已按画布选择勾选 ${hit} 个节点`);
      } else {
        applySelection([]);
      }
      break;
    }
    case 'SELECTION_CHANGED': {
      selectionFrames = msg.frames;
      if (msg.frames.length) {
        const hit = applySelection(msg.frames.map((f) => f.id));
        setStatus(`画布选择已同步：勾选 ${hit} 个节点`);
      } else {
        applySelection([]);
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
      // 留一拍让人看到"满了"，再收起整条进度条
      hideProgress(600);
      exporting = false;
      updateExportButton();

      void sendToMac(msg);
      break;
    }
    case 'EXPORT_ERROR': {
      exporting = false;
      hideProgress();
      updateExportButton();
      trace(msg.message, 'error');
      // 以前这里是「导出失败，请查看日志」—— 日志区已经没有了，改成直接把原因顶到状态行
      setStatus(`导出失败：${firstLine(msg.message)}`, 'bad', msg.message);
      break;
    }
    case 'LOG':
      // 插件主线程的逐帧日志：面板不画了，但排查时仍然要在同一个 console 里能看到
      trace(msg.message, msg.level);
      break;
    default:
      break;
  }
};

void refreshMac();
send({ type: 'SCAN', includeNestedFrames: true, granularity: granularity() });
