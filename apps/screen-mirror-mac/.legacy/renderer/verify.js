// 验收页：基础展示 + DOM 节点层叠加 + 节点点击右侧信息面板
// 当前为 mock 数据，后续接入真实上传

(function () {
  'use strict';

  // ----- Mock 数据 -----
  const MOCK_PAIRS = [
    {
      id: 'pair-1',
      name: '新闻资讯 Feed 流',
      pageNumber: 1,
      issueCount: 0,
      design: {
        width: 375,
        height: 812,
        imageLabel: '设计稿（375×812）',
        nodes: makeDesignNodes('pair-1'),
      },
      app: {
        width: 375,
        height: 812,
        imageLabel: 'App 截图（375×812）',
        nodes: makeAppNodes('pair-1'),
      },
    },
    {
      id: 'pair-2',
      name: '发现页横滑切换卡片',
      pageNumber: 2,
      issueCount: 0,
      design: { width: 375, height: 812, imageLabel: '设计稿（375×812）', nodes: makeDesignNodes('pair-2') },
      app: { width: 375, height: 812, imageLabel: 'App 截图（375×812）', nodes: makeAppNodes('pair-2') },
    },
    {
      id: 'pair-3',
      name: '新闻详情页',
      pageNumber: 3,
      issueCount: 0,
      design: { width: 375, height: 812, imageLabel: '设计稿（375×812）', nodes: makeDesignNodes('pair-3') },
      app: { width: 375, height: 812, imageLabel: 'App 截图（375×812）', nodes: makeAppNodes('pair-3') },
    },
    {
      id: 'pair-4',
      name: '播放列表页',
      pageNumber: 4,
      issueCount: 0,
      design: { width: 375, height: 812, imageLabel: '设计稿（375×812）', nodes: makeDesignNodes('pair-4') },
      app: { width: 375, height: 812, imageLabel: 'App 截图（375×812）', nodes: makeAppNodes('pair-4') },
    },
  ];

  // Figma 风格设计稿节点
  function makeDesignNodes(seed) {
    return [
      { id: `${seed}-d-1`, name: 'StatusBar', type: 'FRAME', x: 0, y: 0, w: 375, h: 44 },
      { id: `${seed}-d-2`, name: 'Text / Member home', type: 'TEXT', x: 24, y: 110, w: 200, h: 32, text: 'Member home', fontSize: 24, fontWeight: 700, color: '#111827' },
      { id: `${seed}-d-3`, name: 'Nav / HOME', type: 'TEXT', x: 24, y: 162, w: 50, h: 18, text: 'HOME', fontSize: 12, fontWeight: 600, color: '#3b82f6' },
      { id: `${seed}-d-4`, name: 'Nav / GUIDES', type: 'TEXT', x: 88, y: 162, w: 60, h: 18, text: 'GUIDES', fontSize: 12, fontWeight: 500, color: '#6b7280' },
      { id: `${seed}-d-5`, name: 'Nav / VIDEOS', type: 'TEXT', x: 162, y: 162, w: 60, h: 18, text: 'VIDEOS', fontSize: 12, fontWeight: 500, color: '#6b7280' },
      { id: `${seed}-d-6`, name: 'Nav / PRESENTATIONS', type: 'TEXT', x: 236, y: 162, w: 110, h: 18, text: 'PRESENTATIONS', fontSize: 12, fontWeight: 500, color: '#6b7280' },
      { id: `${seed}-d-7`, name: 'Text / Recent guides', type: 'TEXT', x: 24, y: 230, w: 160, h: 24, text: 'Recent guides', fontSize: 18, fontWeight: 700, color: '#111827' },
      { id: `${seed}-d-8`, name: 'Text / description', type: 'TEXT', x: 24, y: 262, w: 327, h: 36, text: 'Each5celerisque phaseilus facilisi et sapien, teo, sit pellentesque. Tortor orci, nunc, morbi id proin et ut lectus dolor.', fontSize: 12, fontWeight: 400, color: '#6b7280' },
      { id: `${seed}-d-9`, name: 'Image / card-1', type: 'IMAGE', x: 24, y: 318, w: 156, h: 200, color: '#fb923c' },
      { id: `${seed}-d-10`, name: 'Image / card-2', type: 'IMAGE', x: 195, y: 318, w: 156, h: 200, color: '#a855f7' },
      { id: `${seed}-d-11`, name: 'Text / card-1 title', type: 'TEXT', x: 24, y: 528, w: 156, h: 40, text: 'The great comeback', fontSize: 14, fontWeight: 700, color: '#111827' },
      { id: `${seed}-d-12`, name: 'Text / card-1 body', type: 'TEXT', x: 24, y: 572, w: 156, h: 80, text: 'Amet minim mollit non deserunt ullamco est sit aliqua dolor do amet sint. Velit officia consequat duis enim velit mollit. Exercitation', fontSize: 11, fontWeight: 400, color: '#6b7280' },
      { id: `${seed}-d-13`, name: 'Text / card-2 title', type: 'TEXT', x: 195, y: 528, w: 156, h: 40, text: 'The great sports comeback', fontSize: 14, fontWeight: 700, color: '#111827' },
      { id: `${seed}-d-14`, name: 'Text / card-2 body', type: 'TEXT', x: 195, y: 572, w: 156, h: 80, text: 'Amet minim mollit non deserunt ullamco est sit aliqua dolor do amet sint. Velit officia consequat duis enim velit mollit. Exercitation', fontSize: 11, fontWeight: 400, color: '#6b7280' },
      { id: `${seed}-d-15`, name: 'Button / MORE GUIDES', type: 'TEXT', x: 24, y: 720, w: 160, h: 24, text: 'MORE GUIDES  >', fontSize: 13, fontWeight: 600, color: '#111827' },
      { id: `${seed}-d-16`, name: 'TabBar', type: 'FRAME', x: 0, y: 760, w: 375, h: 52 },
    ];
  }

  // RN/Android 风格节点
  function makeAppNodes(seed) {
    return [
      { id: `${seed}-a-1`, nodeId: 'view:51ebeab', className: 'android.widget.FrameLayout', depth: 0, parentId: null, x: 0, y: 0, w: 375, h: 812, visible: true, clickable: false, text: null, alpha: 1, z: 0 },
      { id: `${seed}-a-2`, nodeId: 'view:7c41a02', className: 'android.view.ViewGroup', depth: 1, parentId: 'view:51ebeab', x: 0, y: 0, w: 375, h: 44, visible: true, clickable: false, text: null, hasVisualContent: false },
      { id: `${seed}-a-3`, nodeId: 'view:8d2f911', className: 'com.facebook.react.views.text.ReactTextView', depth: 2, parentId: 'view:7c41a02', x: 24, y: 108, w: 202, h: 36, visible: true, clickable: false, text: 'Member home', hasVisualContent: true, fontSize: 24, fontWeight: '700', color: '#111111' },
      { id: `${seed}-a-4`, nodeId: 'view:9e3aa12', className: 'com.facebook.react.views.view.ReactViewGroup', depth: 1, parentId: 'view:51ebeab', x: 0, y: 154, w: 375, h: 32, visible: true, clickable: true, text: null, hasVisualContent: false },
      { id: `${seed}-a-5`, nodeId: 'view:1a2b3c4', className: 'ReactTextView', depth: 2, parentId: 'view:9e3aa12', x: 24, y: 160, w: 52, h: 20, visible: true, clickable: true, text: 'HOME', hasVisualContent: true, fontSize: 12, fontWeight: '600', color: '#3b82f6' },
      { id: `${seed}-a-6`, nodeId: 'view:2b3c4d5', className: 'ReactTextView', depth: 2, parentId: 'view:9e3aa12', x: 88, y: 160, w: 62, h: 20, visible: true, clickable: true, text: 'GUIDES', hasVisualContent: true, fontSize: 12, fontWeight: '500', color: '#6b7280' },
      { id: `${seed}-a-7`, nodeId: 'view:3c4d5e6', className: 'ReactTextView', depth: 2, parentId: 'view:9e3aa12', x: 162, y: 160, w: 62, h: 20, visible: true, clickable: true, text: 'VIDEOS', hasVisualContent: true, fontSize: 12, fontWeight: '500', color: '#6b7280' },
      { id: `${seed}-a-8`, nodeId: 'view:4d5e6f7', className: 'ReactTextView', depth: 2, parentId: 'view:9e3aa12', x: 236, y: 160, w: 112, h: 20, visible: true, clickable: true, text: 'PRESENTATIONS', hasVisualContent: true, fontSize: 12, fontWeight: '500', color: '#6b7280' },
      { id: `${seed}-a-9`, nodeId: 'view:5e6f7g8', className: 'ReactTextView', depth: 1, parentId: 'view:51ebeab', x: 24, y: 232, w: 164, h: 26, visible: true, clickable: false, text: 'Recent guides', hasVisualContent: true, fontSize: 18, fontWeight: '700', color: '#111111' },
      { id: `${seed}-a-10`, nodeId: 'view:6f7g8h9', className: 'ReactTextView', depth: 1, parentId: 'view:51ebeab', x: 24, y: 266, w: 327, h: 40, visible: true, clickable: false, text: 'Each5celerisque phaseilus facilisi et sapien, teo, sit pellentesque. Tortor orci, nunc, morbi id proin et ut lectus dolor.', hasVisualContent: true, fontSize: 12, fontWeight: '400', color: '#666666' },
      { id: `${seed}-a-11`, nodeId: 'view:7g8h9i0', className: 'com.facebook.react.views.image.ReactImageView', depth: 1, parentId: 'view:51ebeab', x: 24, y: 320, w: 156, h: 200, visible: true, clickable: true, text: null, hasVisualContent: true, isImage: true, color: '#fb923c' },
      { id: `${seed}-a-12`, nodeId: 'view:8h9i0j1', className: 'com.facebook.react.views.image.ReactImageView', depth: 1, parentId: 'view:51ebeab', x: 195, y: 320, w: 156, h: 200, visible: true, clickable: true, text: null, hasVisualContent: true, isImage: true, color: '#a855f7' },
      { id: `${seed}-a-13`, nodeId: 'view:9i0j1k2', className: 'ReactTextView', depth: 1, parentId: 'view:51ebeab', x: 24, y: 530, w: 156, h: 42, visible: true, clickable: false, text: 'The great comeback', hasVisualContent: true, fontSize: 14, fontWeight: '700', color: '#111111' },
      { id: `${seed}-a-14`, nodeId: 'view:0j1k2l3', className: 'ReactTextView', depth: 1, parentId: 'view:51ebeab', x: 24, y: 576, w: 156, h: 84, visible: true, clickable: false, text: 'Amet minim mollit non deserunt ullamco est sit aliqua dolor do amet sint. Velit officia consequat duis enim velit mollit. Exercitation', hasVisualContent: true, fontSize: 11, fontWeight: '400', color: '#666666' },
      { id: `${seed}-a-15`, nodeId: 'view:1k2l3m4', className: 'ReactTextView', depth: 1, parentId: 'view:51ebeab', x: 195, y: 530, w: 156, h: 42, visible: true, clickable: false, text: 'The great sports comeback', hasVisualContent: true, fontSize: 14, fontWeight: '700', color: '#111111' },
      { id: `${seed}-a-16`, nodeId: 'view:2l3m4n5', className: 'ReactTextView', depth: 1, parentId: 'view:51ebeab', x: 195, y: 576, w: 156, h: 84, visible: true, clickable: false, text: 'Amet minim mollit non deserunt ullamco est sit aliqua dolor do amet sint. Velit officia consequat duis enim velit mollit. Exercitation', hasVisualContent: true, fontSize: 11, fontWeight: '400', color: '#666666' },
      { id: `${seed}-a-17`, nodeId: 'view:3m4n5o6', className: 'ReactTextView', depth: 1, parentId: 'view:51ebeab', x: 24, y: 720, w: 162, h: 26, visible: true, clickable: true, text: 'MORE GUIDES  >', hasVisualContent: true, fontSize: 13, fontWeight: '600', color: '#111111' },
      { id: `${seed}-a-18`, nodeId: 'view:4n5o6p7', className: 'android.view.ViewGroup', depth: 1, parentId: 'view:51ebeab', x: 0, y: 760, w: 375, h: 52, visible: true, clickable: false, text: null, hasVisualContent: false },
    ];
  }

  // ----- State -----
  let currentPairId = 'pair-1';
  let selectedNode = null;          // { source: 'design'|'app', node: {...} }
  let infoSourceTab = 'design';      // 当前右侧信息面板展示的来源

  // ----- DOM refs -----
  const canvasEl = document.getElementById('canvas');
  const designStage = document.getElementById('design-stage');
  const appStage = document.getElementById('app-stage');
  const designNodes = document.getElementById('design-nodes');
  const appNodes = document.getElementById('app-nodes');
  const designImage = document.getElementById('design-image');
  const appImage = document.getElementById('app-image');
  const designDim = document.getElementById('design-dim');
  const appDim = document.getElementById('app-dim');
  const pairNav = document.getElementById('pair-nav');

  const infoEmpty = document.getElementById('info-empty');
  const infoContent = document.getElementById('info-content');
  const infoRows = document.getElementById('info-rows');
  const infoClose = document.getElementById('info-close');

  // ----- 渲染 -----
  function getCurrentPair() {
    return MOCK_PAIRS.find((p) => p.id === currentPairId);
  }

  function renderPair() {
    const pair = getCurrentPair();
    if (!pair) return;

    designDim.textContent = `${pair.design.width}×${pair.design.height}`;
    appDim.textContent = `${pair.app.width}×${pair.app.height}`;
    pairNav.textContent = `${pair.name} (${pair.pageNumber}/${MOCK_PAIRS.length})`;

    designImage.setAttribute('data-placeholder', pair.design.imageLabel);
    appImage.setAttribute('data-placeholder', pair.app.imageLabel);

    renderNodes(designNodes, pair.design.nodes, 'design');
    renderNodes(appNodes, pair.app.nodes, 'app');

    // 切换配对后清空选中
    clearSelection();
  }

  function renderNodes(container, nodes, view) {
    container.innerHTML = '';
    nodes.forEach((node) => {
      const el = document.createElement('div');
      el.className = `node-overlay ${nodeClass(node)}`;
      el.dataset.source = view;
      el.dataset.nodeId = node.id;
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
      el.style.width = node.w + 'px';
      el.style.height = node.h + 'px';
      el.title = node.text || node.name || node.className || node.id;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        selectNode(view, node);
      });
      container.appendChild(el);
    });
  }

  function nodeClass(node) {
    if (node.type === 'TEXT' || node.className?.includes('TextView')) return 'text';
    if (node.type === 'IMAGE' || node.isImage) return 'image';
    return '';
  }

  function selectNode(source, node) {
    selectedNode = { source, node };
    infoSourceTab = source;

    // 高亮当前 source 的节点
    document.querySelectorAll(`.node-overlay[data-source="${source}"]`).forEach((el) => {
      el.classList.toggle('selected', el.dataset.nodeId === node.id);
    });

    // 切换信息面板 pill
    document.querySelectorAll('.src-pill').forEach((pill) => {
      pill.classList.toggle('active', pill.dataset.source === source);
    });

    renderInfo();
  }

  function clearSelection() {
    selectedNode = null;
    document.querySelectorAll('.node-overlay.selected').forEach((el) => el.classList.remove('selected'));
    infoContent.classList.add('hidden');
    infoEmpty.classList.remove('hidden');
  }

  function renderInfo() {
    if (!selectedNode) return;
    infoEmpty.classList.add('hidden');
    infoContent.classList.remove('hidden');

    const node = selectedNode.node;
    const rows = [];

    if (selectedNode.source === 'design') {
      rows.push(['图层 id', node.id]);
      rows.push(['图层名', node.name || '—']);
      rows.push(['类型', node.type || '—']);
      rows.push(['坐标 / 尺寸', `x=${node.x}, y=${node.y}\nw=${node.w}, h=${node.h}`]);
      if (node.text != null) rows.push(['文本', node.text]);
      if (node.fontSize != null) rows.push(['字号', `${node.fontSize}px`]);
      if (node.fontWeight != null) rows.push(['字重', String(node.fontWeight)]);
      if (node.color != null) rows.push(['颜色', node.color]);
    } else {
      rows.push(['id', node.id]);
      rows.push(['nodeId', node.nodeId || '—']);
      rows.push(['className', node.className || '—']);
      rows.push(['depth', String(node.depth ?? '—')]);
      if (node.parentId != null) rows.push(['parentId', node.parentId]);
      rows.push(['坐标 / 尺寸', `x=${node.x}, y=${node.y}\nw=${node.w}, h=${node.h}`]);
      rows.push(['visible', String(node.visible ?? '—')]);
      rows.push(['clickable', String(node.clickable ?? '—')]);
      if (node.alpha != null) rows.push(['alpha', String(node.alpha)]);
      if (node.z != null) rows.push(['z', String(node.z)]);
      if (node.hasVisualContent != null) rows.push(['hasVisualContent', String(node.hasVisualContent)]);
      if (node.isImage != null) rows.push(['isImage', String(node.isImage)]);
      if (node.isSvg != null) rows.push(['isSvg', String(node.isSvg)]);
      if (node.isGradient != null) rows.push(['isGradient', String(node.isGradient)]);
      if (node.text != null) rows.push(['text', node.text]);
      if (node.fontSize != null) rows.push(['fontSize', String(node.fontSize)]);
      if (node.fontWeight != null) rows.push(['fontWeight', String(node.fontWeight)]);
      if (node.color != null) rows.push(['color', node.color]);
    }

    infoRows.innerHTML = '';
    rows.forEach(([key, value]) => {
      const row = document.createElement('div');
      row.className = 'info-row';
      const k = document.createElement('div');
      k.className = 'row-key';
      k.textContent = key;
      const v = document.createElement('div');
      v.className = 'row-val' + (value == null || value === '' ? ' empty' : '');
      v.textContent = value == null || value === '' ? '—' : String(value);
      row.appendChild(k);
      row.appendChild(v);
      infoRows.appendChild(row);
    });
  }

  // ----- 事件绑定 -----
  function bindEvents() {
    // 左侧配对切换
    document.querySelectorAll('.pair-card').forEach((card) => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.pair-card').forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
        currentPairId = card.dataset.pairId;
        renderPair();
      });
    });

    // 信息面板 pill 切换（design / app）
    document.querySelectorAll('.src-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        if (!selectedNode) return;
        infoSourceTab = pill.dataset.source;
        document.querySelectorAll('.src-pill').forEach((p) => p.classList.toggle('active', p === pill));
        // 切到另一个来源时，定位同 source 下的第一个节点作为展示
        const pair = getCurrentPair();
        const candidate = pair[infoSourceTab].nodes.find((n) => n.text || n.type === 'TEXT') || pair[infoSourceTab].nodes[0];
        if (candidate) selectNode(infoSourceTab, candidate);
      });
    });

    // 关闭信息面板
    infoClose.addEventListener('click', clearSelection);

    // 工具栏切换
    document.querySelectorAll('.tool').forEach((tool) => {
      tool.addEventListener('click', () => {
        if (!tool.classList.contains('zoom-control') && !tool.parentElement.classList.contains('zoom-control')) {
          // 简单 active 切换（仅展示，不真正实现各工具功能）
          if (tool.classList.contains('active')) return;
        }
      });
    });
  }

  // ----- Init -----
  renderPair();
  bindEvents();
})();