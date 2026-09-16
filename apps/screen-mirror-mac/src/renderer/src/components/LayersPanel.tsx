import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildNodeTree, flattenVisibleTree, type NodeKind, type RenderNode, type VerifySource } from '@shared/verify';

/** 列表里的选中项：只需要「哪一帧的哪个节点」，原始节点由调用方按 id 找回 */
export interface LayerSelection {
  source: VerifySource;
  id: string;
}

interface LayersPanelProps {
  designNodes: RenderNode[];
  appNodes: RenderNode[];
  /** 当前选中（画布点击或本列表点击产生）。列表据此高亮，并自动滚动到可见 */
  selection: LayerSelection | null;
  /** 点击图层行：选中该节点**并聚焦画布**（与画布内点击的区别就在这里） */
  onPick: (node: RenderNode) => void;
}

/** 折叠集合的初值：空集合 = 全部展开（对齐 Figma 的默认行为） */
const NOTHING_COLLAPSED: ReadonlySet<string> = new Set<string>();

/**
 * 折叠键要带来源前缀：设计稿 id（Figma 的 `1:23`）与截图 nodeId（端上 dump 的路径）
 * 是两个独立的 id 空间，理论上可能撞。撞了的后果是「在设计稿折叠一层，
 * 切到截图发现它也折着」—— 很难复现、更难定位，直接用前缀消灭掉。
 */
const rowKey = (source: VerifySource, id: string): string => `${source}:${id}`;

/** 类型图标：Figma 的 frame / 文本 / 图片三种，颜色继承 currentColor */
const KindIcon: React.FC<{ kind: NodeKind }> = ({ kind }) => {
  if (kind === 'text') {
    return (
      <svg className="layer-icon" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path
          d="M2 2.2h8M6 2.2v7.6M4.4 9.8h3.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'image') {
    return (
      <svg className="layer-icon" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <rect
          x="1.4"
          y="2"
          width="9.2"
          height="8"
          rx="1.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
        />
        <circle cx="4.3" cy="4.7" r=".9" fill="currentColor" />
        <path
          d="M2.1 9.4 5 6.7l1.9 1.7 1.5-1.3 1.4 1.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
        />
      </svg>
    );
  }
  // container：Figma 的 frame 图标就是一个「井」字
  return (
    <svg className="layer-icon" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path
        d="M3.6 1.2v9.6M8.4 1.2v9.6M1.2 3.6h9.6M1.2 8.4h9.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
};

interface LayerRowProps {
  node: RenderNode;
  depth: number;
  /** 是否有子节点（决定要不要画折叠箭头） */
  hasChildren: boolean;
  /** 展开中（仅 hasChildren 时有意义） */
  open: boolean;
  active: boolean;
  /** 命中当前搜索（关键词为空时恒为 false） */
  hit: boolean;
  onPick: (node: RenderNode) => void;
  onToggle: (key: string) => void;
}

/**
 * 单行图层。
 *
 * `React.memo` 在这里不是锦上添花：一帧 300+ 节点，选中态一变就会重渲染整张列表；
 * 没有 memo 时每次点击都要重建几百个行元素（含内联 SVG），在高倍率下会看得到卡顿。
 * 代价是 props 必须稳定 —— `onPick` / `onToggle` 由父级 useCallback 固定，
 * 行内不接收任何「每次渲染都新建」的对象。
 */
const LayerRow = React.memo(function LayerRow({
  node,
  depth,
  hasChildren,
  open,
  active,
  hit,
  onPick,
  onToggle,
}: LayerRowProps) {
  const key = rowKey(node.source, node.id);
  const className = [
    'layer-row',
    active ? 'active' : '',
    hit ? 'hit' : '',
    node.clipped || !node.visible ? 'dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      data-layer-key={key}
      // 缩进只影响本行内边距，不参与树结构 —— 层级靠视觉表达，DOM 保持扁平，
      // 否则 300+ 节点的嵌套会带来无谓的样式重算
      style={{ paddingLeft: 6 + depth * 12 }}
      title={`${node.label}\n${node.path}`}
      onClick={() => onPick(node)}
    >
      <button
        type="button"
        className={`layer-twist${hasChildren ? '' : ' leaf'}${open ? ' open' : ''}`}
        tabIndex={-1}
        aria-label={open ? '折叠' : '展开'}
        onClick={(event) => {
          // 折叠箭头只做折叠，不能顺带触发「选中 + 聚焦」
          event.stopPropagation();
          onToggle(key);
        }}
      >
        ▸
      </button>
      <KindIcon kind={node.kind} />
      <span className="layer-name">{node.label}</span>
    </div>
  );
});

/**
 * 图层列表（对齐 Figma 左侧的 Layers 面板）。
 *
 * 与画布是**双向**关系：
 *  - 点行 → 选中该节点并让画布聚焦到它（`onPick`，由 CanvasBoard 组合两者）；
 *  - 画布上点节点 → 本列表展开其祖先链、高亮并滚动到可见。
 *
 * 两侧各是一棵独立的树（设计稿 / 截图），用顶部切换。之所以不做成「两棵树拼在一起」：
 * 同一个页面的两级结构是两套坐标系（Frame 内 vs 屏幕内），拼成一棵树会让人误以为
 * 节点之间有父子关系 —— 而它们之间只有「配对」这一层人为关系。
 *
 * ⚠️ 树结构必须来自 `buildNodeTree`（与画布共用）：列表自己按 parentId 拼一遍树，
 * 一旦遇到 parentId 指向缺失节点这类脏数据，两边对「谁是根」的判断就会分叉。
 */
const LayersPanel: React.FC<LayersPanelProps> = ({
  designNodes,
  appNodes,
  selection,
  onPick,
}) => {
  const [source, setSource] = useState<VerifySource>('design');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NOTHING_COLLAPSED);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const nodes = source === 'design' ? designNodes : appNodes;
  const tree = useMemo(() => buildNodeTree(nodes), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  /**
   * 搜索结果。`null` = 没在搜索（不是「零命中」）—— 这两者必须分得开：
   * 空关键词时若返回空集合，每一行都要白算一次匹配，而且「0 个结果」会跟着关键词一起闪。
   *
   * 匹配范围是**全部节点**（`nodes`，即 Figma 的 DFS 前序）而不是当前可见行 `rows`：
   * 命中若藏在折叠的分支里，选到它时会由下面那条「展开祖先」的 effect 自动展开，
   * 于是「搜到了却因为折叠而搜不到」这种自相矛盾的结果不会出现。
   */
  const matched = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return null;
    const ids = new Set<string>();
    const order: RenderNode[] = [];
    for (const node of nodes) {
      if (node.label.toLowerCase().includes(keyword)) {
        ids.add(node.id);
        order.push(node);
      }
    }
    return { ids, order };
  }, [nodes, query]);

  // 画布上选中了另一侧的节点时跟随切换 —— 否则高亮落在看不见的那个 tab 里，
  // 表现成「点了画布，图层面板毫无反应」。手动切 tab 不受影响（选中源没变就不触发）。
  useEffect(() => {
    if (selection) setSource(selection.source);
  }, [selection]);

  /** 祖先链（含自身所在层级之上的全部父节点），用于选中时自动展开 */
  const ancestorsOf = useCallback(
    (nodeId: string): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();
      let current = byId.get(nodeId)?.parentId ?? null;
      while (current && !seen.has(current)) {
        seen.add(current);
        out.push(rowKey(source, current));
        current = byId.get(current)?.parentId ?? null;
      }
      return out;
    },
    [byId, source],
  );

  // 选中项若藏在折叠的分支里，先把祖先展开，否则「滚动到可见」根本找不到那一行
  useEffect(() => {
    if (!selection || selection.source !== source) return;
    const ancestors = ancestorsOf(selection.id);
    if (ancestors.length === 0) return;
    setCollapsed((prev) => {
      if (!ancestors.some((key) => prev.has(key))) return prev;
      const next = new Set(prev);
      for (const key of ancestors) next.delete(key);
      return next;
    });
  }, [ancestorsOf, selection, source]);

  const handleToggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * 可见行（折叠的分支整棵跳过，兄弟保持导出数组原序 = Figma 面板的顺序）。
   * 拉平逻辑与判定分开放在 `flattenVisibleTree`：那是纯函数，冒烟测试能直接断言
   * 顺序与深度；写在这里就只能靠肉眼 review 一颗 300 节点的树。
   */
  const rows = useMemo(
    () => flattenVisibleTree(tree, (node) => collapsed.has(rowKey(source, node.id))),
    [collapsed, source, tree],
  );

  // 选中变化后滚动到可见。放在独立 effect 里、依赖 collapsed：祖先展开会触发一次
  // 重渲染，第一次找不到行是正常的，展开后这次才生效。
  useEffect(() => {
    if (!selection || selection.source !== source) return;
    const key = rowKey(selection.source, selection.id);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-layer-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [collapsed, selection, source]);

  /**
   * 搜索时**默认选中第一个命中**（并因此让画布聚焦到它、把折叠的祖先展开）。
   *
   * ⚠️ 依赖里刻意只有「第一个命中的 id」：把 `nodes` / `onPick` 也放进来，父级每次
   * 重渲染导致的数组 identity 变化都会重跑一次，于是「用户输入完关键词后点了另一行」
   * 会被硬拽回第一个命中 —— 表现成列表自己乱跳。用 id 而不是 query 还有个好处：
   * 继续输入但第一个命中没变时（比如 `收` → `收藏`）不会重复聚焦一次画布。
   */
  const firstMatchId = matched?.order[0]?.id ?? null;
  useEffect(() => {
    if (!query.trim() || !firstMatchId) return;
    const first = nodes.find((node) => node.id === firstMatchId);
    if (first) onPick(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMatchId]);

  const active = selection && selection.source === source ? selection.id : null;

  return (
    <aside className={`layers-panel${open ? '' : ' collapsed'}`}>
      <div className="layers-header">
        {/* 收起态也保留标题（与展开态一样横排）：只剩一个箭头时，那条窄条看不出是「图层」。
            收起时下面整块内容（来源切换 + 树）都不渲染，所以这条 header 就是全部。 */}
        <span className="layers-title">图层</span>
        <button
          type="button"
          className="layers-toggle"
          title={open ? '收起图层列表' : '展开图层列表'}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '«' : '»'}
        </button>
      </div>

      {open && (
        <>
          {/* 搜索：按图层名**高亮**（不过滤）—— 过滤会把命中项从它所属的层级里抠出来，
              用户就不知道「这一层在谁下面」了，而层级正是这个面板存在的理由。 */}
          <div className="layers-search">
            <input
              className="layers-search-input"
              value={query}
              placeholder="搜索图层名"
              aria-label="搜索图层名"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Esc 在画布上是「上移一层」，输入框里只该是「清空搜索」
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                setQuery('');
              }}
            />
            {query.trim() !== '' && (
              <>
                {/* 光秃秃一个数字会被读成别的东西（比如节点总数），带上单位；
                    零命中写成「无匹配」而不是「0」，否则分不清是没搜到还是还没搜 */}
                <span className="layers-search-count">
                  {(matched?.order.length ?? 0) > 0 ? `${matched?.order.length} 个` : '无匹配'}
                </span>
                <button
                  type="button"
                  className="layers-search-clear"
                  title="清除搜索"
                  onClick={() => setQuery('')}
                >
                  ×
                </button>
              </>
            )}
          </div>

          <div className="layers-sources">
            {(['design', 'app'] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={`layers-source${source === item ? ' active' : ''}`}
                onClick={() => setSource(item)}
              >
                {item === 'design' ? '设计稿' : '截图'}
                <span className="count">
                  {(item === 'design' ? designNodes : appNodes).length}
                </span>
              </button>
            ))}
          </div>

          <div className="layers-tree" ref={listRef}>
            {rows.length === 0 ? (
              <div className="layers-empty">这一侧没有节点数据</div>
            ) : (
              rows.map((row) => (
                <LayerRow
                  key={rowKey(row.node.source, row.node.id)}
                  node={row.node}
                  depth={row.depth}
                  hasChildren={row.hasChildren}
                  open={row.open}
                  active={row.node.id === active}
                  hit={matched?.ids.has(row.node.id) ?? false}
                  onPick={onPick}
                  onToggle={handleToggle}
                />
              ))
            )}
          </div>
        </>
      )}
    </aside>
  );
};

export default LayersPanel;
