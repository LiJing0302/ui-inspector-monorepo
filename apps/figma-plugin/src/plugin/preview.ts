/**
 * 生成 zip 产物中的 index.html —— 解压后直接双击打开，
 * 即可看到「设计稿截图 + Figma 节点框叠加」的效果，用来人工核对验收平台的渲染结果。
 * 数据全部内联，无外部依赖、无需联网。
 */
export const PREVIEW_FILE_NAME = 'index.html';

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font: 12px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif;
  color: #1f2328; background: #f6f7f9; overflow: hidden;
}
#app { display: flex; height: 100vh; }
.panel { background: #fff; border-right: 1px solid #e5e7eb; display: flex; flex-direction: column; min-width: 0; }
#sidebar { width: 300px; }
#inspector { width: 320px; border-right: none; border-left: 1px solid #e5e7eb; }
.panel-head {
  padding: 10px 12px; font-weight: 600; border-bottom: 1px solid #e5e7eb;
  display: flex; align-items: center; gap: 8px; background: #fbfbfc; flex: none;
}
.panel-body { overflow: auto; flex: 1; padding: 6px 0; }
#main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#toolbar {
  flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px solid #e5e7eb; background: #fff;
}
#toolbar label { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
select, input[type=text], button {
  font: inherit; padding: 3px 6px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; color: #1f2328;
}
button { cursor: pointer; }
button:hover { background: #f3f4f6; }
#canvas-wrap { flex: 1; overflow: auto; padding: 20px; display: flex; justify-content: center; align-items: flex-start; }
#holder { position: relative; flex: none; }
#stage { position: relative; transform-origin: top left; box-shadow: 0 2px 16px rgba(0,0,0,.12); flex: none; }
#shot { display: block; width: 100%; height: 100%; }
#overlay { position: absolute; inset: 0; }
.box { position: absolute; pointer-events: auto; cursor: pointer; }
/* 无填充节点：Figma 画布点不中它，对齐后这里也不接收点击（仍可从左侧树选中） */
.box.nofill { pointer-events: none; cursor: default; }
/* 超出 clipsContent 祖先的节点：Figma 中被裁掉，用虚线 + 淡化提示 */
.box.clipped { border-style: dashed !important; opacity: .45; }
.box:hover { outline: 1px dashed #2563eb; background: rgba(37,99,235,.10); }
.box.nofill:hover { outline: none; background: transparent; }
.box.selected { outline: 2px solid #2563eb; background: rgba(37,99,235,.14); }
.box.hidden-type { display: none; }
#tooltip {
  position: fixed; z-index: 99; pointer-events: none; background: #1f2328; color: #fff;
  padding: 4px 8px; border-radius: 5px; font-size: 11px; max-width: 320px; display: none; white-space: pre-wrap;
}
.tree-row {
  display: flex; align-items: center; gap: 4px; padding: 2px 8px; cursor: pointer; white-space: nowrap;
}
.tree-row:hover { background: #f0f4ff; }
.tree-row.selected { background: #dbeafe; }
.tree-row .caret { width: 12px; flex: none; color: #6b7280; }
.tree-row .nm { overflow: hidden; text-overflow: ellipsis; }
.tree-row .ty { color: #8b949e; font-size: 10px; flex: none; }
.dim { color: #8b949e; }
.kv { display: grid; grid-template-columns: 96px 1fr; gap: 2px 8px; padding: 8px 12px; border-bottom: 1px solid #f0f1f3; }
.kv .k { color: #6b7280; }
.kv .v { word-break: break-all; }
pre.json { margin: 0; padding: 10px 12px; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
.badge { font-size: 10px; padding: 1px 5px; border-radius: 999px; background: #eef2ff; color: #4338ca; }
.warn { padding: 8px 12px; color: #92400e; background: #fffbeb; border-bottom: 1px solid #fde68a; }
`;

export function renderPreviewHtml(dataJson: string): string {
  // 避免 JSON 中出现的 </script> 提前闭合脚本块
  const safeJson = dataJson.replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>设计稿节点预览 · Figma Node Schema</title>
<style>${CSS}</style>
</head>
<body>
<div id="app">
  <aside class="panel" id="sidebar">
    <div class="panel-head">设计稿 <span class="dim" id="frame-count"></span></div>
    <div class="panel-body" id="frame-list"></div>
    <div class="panel-head" style="border-top:1px solid #e5e7eb">节点树</div>
    <div class="panel-body" id="tree" style="flex:2"></div>
  </aside>

  <div id="main">
    <div id="toolbar">
      <label>缩放
        <select id="zoom">
          <option value="fit">适应宽度</option>
          <option value="0.25">25%</option>
          <option value="0.5">50%</option>
          <option value="0.75">75%</option>
          <option value="1" selected>100%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
        </select>
      </label>
      <label><input type="checkbox" id="show-boxes" checked /> 显示节点框</label>
      <label><input type="checkbox" id="show-fill" /> 显示色块</label>
      <label title="Figma 只对有填充/描边的区域做点击命中，无填充的节点在画布上点不到。勾选后预览页同样点不到它们，以此对齐"><input type="checkbox" id="hit-fill" checked /> 按填充命中（对齐 Figma）</label>
      <label>层级
        <select id="depth">
          <option value="0" selected>全部</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="6">6</option>
        </select>
      </label>
      <label>类型
        <select id="type-filter"><option value="">全部</option></select>
      </label>
      <label>截图不透明度 <input type="range" id="shot-opacity" min="0" max="100" value="100" /></label>
      <label><input type="text" id="search" placeholder="搜索节点名 / id" style="width:150px" /></label>
    </div>
    <div id="canvas-wrap">
      <div id="holder">
        <div id="stage">
          <img id="shot" alt="设计稿截图" />
          <div id="overlay"></div>
        </div>
      </div>
    </div>
  </div>

  <aside class="panel" id="inspector">
    <div class="panel-head">节点属性</div>
    <div class="panel-body" id="props"></div>
  </aside>
</div>
<div id="tooltip"></div>

<script>
window.__DATA__ = ${safeJson};
(function () {
  var DATA = window.__DATA__;
  var frames = DATA.frames || [];
  var current = null;
  var flatNodes = [];
  var selectedId = null;
  var MAX_BOXES = 4000;

  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), shot = $('shot'), overlay = $('overlay'), tooltip = $('tooltip'), holder = $('holder');

  function fmt(n) { return Math.round(n * 100) / 100; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function typeColor(t) {
    if (t === 'TEXT') return '#2563eb';
    if (t === 'FRAME' || t === 'COMPONENT' || t === 'INSTANCE' || t === 'COMPONENT_SET') return '#16a34a';
    if (t === 'RECTANGLE' || t === 'ELLIPSE' || t === 'VECTOR' || t === 'LINE' || t === 'STAR' || t === 'POLYGON') return '#db2777';
    if (t === 'GROUP') return '#ea580c';
    return '#6b7280';
  }

  /* ---------------- 设计稿列表 ---------------- */
  function renderFrameList() {
    $('frame-count').textContent = '(' + frames.length + ')';
    var html = frames.map(function (f, i) {
      return '<div class="tree-row" data-idx="' + i + '">' +
        '<span class="nm">' + esc(f.meta.pageName) + ' / ' + esc(f.meta.name) + '</span>' +
        '<span class="ty">' + fmt(f.meta.width) + '×' + fmt(f.meta.height) + '</span></div>';
    }).join('');
    $('frame-list').innerHTML = html;
    Array.prototype.forEach.call($('frame-list').children, function (el) {
      el.onclick = function () { selectFrame(Number(el.dataset.idx)); };
    });
  }

  /* ---------------- 节点树 ---------------- */
  function renderTree(filter) {
    if (!current) { $('tree').innerHTML = ''; return; }
    var root = current.schema.tree;
    var rows = [];
    (function walk(node, depth) {
      var hit = !filter || matches(node, filter);
      // 命中自身、或子孙命中（保留祖先链路）时才渲染这一行
      if (hit || hasMatch(node, filter)) {
        rows.push('<div class="tree-row" data-id="' + node.id + '" style="padding-left:' + (6 + depth * 12) + 'px">' +
          (node.children && node.children.length ? '<span class="caret">▸</span>' : '<span class="caret"></span>') +
          '<span class="nm" title="' + esc(node.path) + '">' + esc(node.name || '(未命名)') + '</span>' +
          '<span class="ty">' + node.type + '</span></div>');
      }
      if (node.children) node.children.forEach(function (c) { walk(c, depth + 1); });
    })(root, 0);
    $('tree').innerHTML = rows.slice(0, 4000).join('');
    Array.prototype.forEach.call($('tree').children, function (el) {
      el.onclick = function () { selectNode(el.dataset.id); };
      el.onmouseenter = function (e) { showTip(e, byId(el.dataset.id)); };
      el.onmousemove = function (e) { moveTip(e); };
      el.onmouseleave = hideTip;
    });
  }
  function matches(node, filter) {
    if (!filter) return true;
    var name = (node.name || '').toLowerCase();
    var id = (node.id || '').toLowerCase();
    return name.indexOf(filter) >= 0 || id.indexOf(filter) >= 0;
  }
  function hasMatch(node, filter) {
    if (!filter || !node.children) return false;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if ((c.name && c.name.toLowerCase().indexOf(filter) >= 0) || hasMatch(c, filter)) return true;
    }
    return false;
  }
  var idMap = {};
  function byId(id) { return idMap[id]; }

  /* ---------------- 画布 ---------------- */
  function flatten(node, out, depth) {
    out.push(node);
    if (node.children) for (var i = 0; i < node.children.length; i++) flatten(node.children[i], out, depth + 1);
    return out;
  }

  function selectFrame(idx) {
    current = frames[idx];
    if (!current) return;
    var meta = current.meta, schema = current.schema;
    stage.style.width = schema.width + 'px';
    stage.style.height = schema.height + 'px';
    stage.style.background = schema.backgroundColor || '#fff';
    shot.src = meta.screenshot;
    flatNodes = flatten(schema.tree, [], 0);
    idMap = {};
    flatNodes.forEach(function (n) { idMap[n.id] = n; });

    var types = {};
    flatNodes.forEach(function (n) { types[n.type] = (types[n.type] || 0) + 1; });
    $('type-filter').innerHTML = '<option value="">全部</option>' + Object.keys(types).sort()
      .map(function (t) { return '<option value="' + t + '">' + t + ' (' + types[t] + ')</option>'; }).join('');

    Array.prototype.forEach.call($('frame-list').children, function (el, i) {
      el.classList.toggle('selected', i === idx);
    });
    selectedId = null;
    drawBoxes();
    renderTree($('search').value.trim().toLowerCase());
    applyZoom();
    renderProps(schema.tree);
  }

  function drawBoxes() {
    var showBoxes = $('show-boxes').checked;
    var showFill = $('show-fill').checked;
    var hitFill = $('hit-fill').checked;
    var maxDepth = Number($('depth').value);
    var type = $('type-filter').value;
    if (!current) return;
    var parts = [];
    var n = 0;
    for (var i = 0; i < flatNodes.length; i++) {
      var node = flatNodes[i];
      if (maxDepth && node.depth > maxDepth) continue;
      if (type && node.type !== type) continue;
      if (node === current.schema.tree) continue;
      n++;
      if (!showBoxes || n > MAX_BOXES) continue;
      var r = node.rect || { x: 0, y: 0, width: 0, height: 0 };
      var style = 'left:' + r.x + 'px;top:' + r.y + 'px;width:' + Math.max(r.width, 0) + 'px;height:' + Math.max(r.height, 0) + 'px;';
      var fill = showFill && node.fills && node.fills[0] && node.fills[0].color ? node.fills[0].color : 'transparent';
      style += 'background:' + fill + ';border:1px solid ' + typeColor(node.type) + ';';
      var cls = 'box';
      if (hitFill && node.hasFill === false) cls += ' nofill';
      if (node.clipped) cls += ' clipped';
      parts.push('<div class="' + cls + '" data-id="' + node.id + '" style="' + style + '"></div>');
    }
    overlay.innerHTML = parts.join('') + (n > MAX_BOXES
      ? '<div class="warn" style="position:absolute;left:0;top:0">节点过多，仅渲染前 ' + MAX_BOXES + ' 个框（共 ' + n + ' 个），请提高层级过滤</div>'
      : '');
    Array.prototype.forEach.call(overlay.querySelectorAll('.box'), function (el) {
      el.onclick = function (e) { e.stopPropagation(); selectNode(el.dataset.id); };
      el.onmouseenter = function (e) { showTip(e, byId(el.dataset.id)); };
      el.onmousemove = moveTip;
      el.onmouseleave = hideTip;
    });
    if (selectedId) highlight(selectedId);
  }

  function applyZoom() {
    if (!current) return;
    var v = $('zoom').value;
    var w = current.schema.width, h = current.schema.height;
    var z = v === 'fit' ? Math.min(1, ($('canvas-wrap').clientWidth - 48) / (w || 1)) : Number(v);
    stage.style.transform = 'scale(' + z + ')';
    // 用 holder 撑开真实占位，保证 transform 之后滚动区域与居中都正确
    holder.style.width = (w * z) + 'px';
    holder.style.height = (h * z) + 'px';
    $('canvas-wrap').style.justifyContent = 'center';
  }

  function selectNode(id) {
    selectedId = id;
    highlight(id);
    renderProps(byId(id));
    Array.prototype.forEach.call($('tree').children, function (el) {
      el.classList.toggle('selected', el.dataset.id === id);
    });
  }

  function highlight(id) {
    Array.prototype.forEach.call(overlay.querySelectorAll('.box'), function (el) {
      el.classList.toggle('selected', el.dataset.id === id);
    });
  }

  function renderProps(node) {
    if (!node) { $('props').innerHTML = ''; return; }
    var r = node.rect || {};
    var rows = [
      ['名称', node.name], ['类型', node.type], ['id', node.id], ['路径', node.path],
      ['位置', 'x=' + fmt(r.x) + '  y=' + fmt(r.y)],
      ['尺寸', fmt(r.width) + ' × ' + fmt(r.height)],
      ['可见', node.visible === false ? 'false' : 'true']
    ];
    if (node.text) {
      rows.push(['文案', node.text.characters]);
      if (node.text.fontSize) rows.push(['字号', node.text.fontSize + 'px']);
      if (node.text.color) rows.push(['文字色', node.text.color]);
      if (node.text.fontFamily) rows.push(['字体', node.text.fontFamily + ' ' + (node.text.fontStyle || '')]);
    }
    if (node.fills && node.fills.length) rows.push(['填充', node.fills.map(function (f) { return f.color || f.type; }).join(', ')]);
    if (node.cornerRadius !== undefined) rows.push(['圆角', String(node.cornerRadius)]);
    if (node.opacity !== undefined) rows.push(['透明度', node.opacity]);
    if (node.rotation) rows.push(['旋转', node.rotation + '°']);
    if (node.component) rows.push(['组件', node.component.kind + (node.component.mainComponentName ? ' · ' + node.component.mainComponentName : '')]);
    $('props').innerHTML = rows.map(function (kv) {
      return '<div class="kv"><div class="k">' + esc(kv[0]) + '</div><div class="v">' + esc(kv[1]) + '</div></div>';
    }).join('') + '<pre class="json">' + esc(JSON.stringify(node, null, 2)) + '</pre>';
  }

  /* ---------------- tooltip ---------------- */
  function showTip(e, node) {
    if (!node) return;
    var r = node.rect || {};
    var flags = [];
    if (node.hasFill === false) flags.push('无填充：Figma 画布点不中');
    if (node.clipped) flags.push('超出容器裁剪：Figma 中不可见');
    tooltip.textContent = node.name + ' · ' + node.type + '\\n' +
      fmt(r.x) + ', ' + fmt(r.y) + '  ' + fmt(r.width) + '×' + fmt(r.height) + '\\n' + node.path +
      (flags.length ? '\\n⚠ ' + flags.join(' / ') : '');
    tooltip.style.display = 'block';
    moveTip(e);
  }
  function moveTip(e) {
    tooltip.style.left = (e.clientX + 12) + 'px';
    tooltip.style.top = (e.clientY + 12) + 'px';
  }
  function hideTip() { tooltip.style.display = 'none'; }

  /* ---------------- 事件 ---------------- */
  ['show-boxes', 'show-fill', 'hit-fill', 'depth', 'type-filter'].forEach(function (id) {
    $(id).onchange = drawBoxes;
  });
  $('zoom').onchange = applyZoom;
  $('shot-opacity').oninput = function () { shot.style.opacity = Number(this.value) / 100; };
  $('search').oninput = function () { renderTree(this.value.trim().toLowerCase()); };
  window.addEventListener('resize', function () { if ($('zoom').value === 'fit') applyZoom(); });

  renderFrameList();
  if (frames.length) selectFrame(0);
})();
</script>
</body>
</html>`;
}
