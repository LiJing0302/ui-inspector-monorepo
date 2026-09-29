import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildNodeTree, flattenVisibleTree, type NodeKind, type RenderNode, type VerifySource } from '@shared/verify';

import { useCanvasField, type CanvasScope } from '../hooks/useCanvasSession';

/** 列表里的聚焦目标：只需要「哪一帧的哪个节点」，原始节点由调用方按 id 找回 */
export interface LayerSelection {
  source: VerifySource;
  id: string;
}

/**
 * **两侧各自的选中 id**（`null` = 该侧没选中）。
 *
 * 为什么要按侧分开而不是一个 `LayerSelection`：画布上两侧的选中**互相独立**
 * （在设计稿上选一个、再到截图侧选一个，两个选中框同时在）。只传一个的话，
 * 切到另一棵树的 tab 时那一侧的选中行不亮 —— 而画布上它的框还亮着，
 * 两处对同一件事给出不同答案。
 */
export type LayerSelectionMap = Readonly<Record<VerifySource, string | null>>;

interface LayersPanelProps {
  /**
   * 配对会话的键（见 hooks/useCanvasSession）：本面板的「怎么看这棵树」也按配对记住。
   *
   * 面板本身有一份自己的展开 / 收起 / 看哪一侧的状态，而它随画布一起被卸载
   * （切 tab、切配对都会）。用户的原话是「画布中的操作不是临时的」——
   * 在一个几百节点的树上展开到要看的那个分支，本身就是那次核对的入口，
   * 重进就全折回去等于让人再找一遍。
   */
  scope: CanvasScope;
  designNodes: RenderNode[];
  appNodes: RenderNode[];
  /** 两侧的选中 id：列表按行所属来源取用，高亮互不顶掉 */
  selections: LayerSelectionMap;
  /**
   * **主动侧**那一个选中项（最近一次选中的那一侧）。
   *
   * 与 `selections` 分开是因为它回答的不是「哪几行高亮」，而是「该显示哪棵树 /
   * 该滚到哪一行 / 该展开谁的祖先」—— 这三件事都只能有一个答案，
   * 而两棵树不会同时出现在屏幕上。
   */
  focus: LayerSelection | null;
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
      // 深层级缩进封顶，避免图标与名称被挤出侧栏；完整节点名仍可由原生提示查看。
      style={{ paddingLeft: 8 + Math.min(depth, 8) * 11 }}
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
  scope,
  designNodes,
  appNodes,
  selections,
  focus,
  onPick,
}) => {
  const [source, setSource] = useCanvasField<VerifySource>(scope, 'layersSource', 'design');
  const [collapsed, setCollapsed] = useCanvasField<ReadonlySet<string>>(
    scope,
    'layersCollapsed',
    NOTHING_COLLAPSED,
  );
  const [open, setOpen] = useCanvasField(scope, 'layersOpen', true);
  /**
   * 搜索词**刻意不进会话**：它回答的是「我这一刻在找什么」，不是「我打算怎么看这一页」。
   * 把一次临时搜索跟着配对带到下次进来，只会让人先看到一份被筛过的列表。
   */
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
  //
  // ⚠️ 看的是 `focus`（主动侧）而不是「两侧的选中」：两侧都选中时跟随哪一侧是
  //    有答案的（最近一次选中的那一侧），用集合去触发就会「两边都有 → 反复横跳」。
  useEffect(() => {
    if (focus) setSource(focus.source);
  }, [focus]);

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
    if (!focus || focus.source !== source) return;
    const ancestors = ancestorsOf(focus.id);
    if (ancestors.length === 0) return;
    setCollapsed((prev) => {
      if (!ancestors.some((key) => prev.has(key))) return prev;
      const next = new Set(prev);
      for (const key of ancestors) next.delete(key);
      return next;
    });
  }, [ancestorsOf, focus, source]);

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

  // 选中变化后只滚动图层列表本身，并将目标行置于可视区域中部。
  // 不能用 scrollIntoView：它还会滚动外层页面 / 画布容器，搜索时容易把目标顶到列表边缘。
  // 依赖 collapsed：祖先展开会触发重渲染，首次找不到行时等下一次即可。
  useEffect(() => {
    if (!focus || focus.source !== source) return;
    const key = rowKey(focus.source, focus.id);
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-layer-key="${CSS.escape(key)}"]`);
    if (!list || !row) return;

    const rowTop = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const centeredTop = rowTop - (list.clientHeight - row.offsetHeight) / 2;
    list.scrollTo({ top: Math.max(0, centeredTop), behavior: 'smooth' });
  }, [collapsed, focus, source]);

  /**
   * 搜索时**默认选中第一个命中**（并因此让画布聚焦到它、把折叠的祖先展开）。
   *
   * 只在关键词变化时触发，不依赖 `firstMatchId`：画布点击另一侧节点会切换树的数据源，
   * 那时首个命中 id 也会变化；若把它当依赖，就会用筛选结果覆盖用户刚点的节点。
   * 父级因选中态重渲染也不应重复执行搜索定位。
   */
  const firstMatchId = matched?.order[0]?.id ?? null;
  useEffect(() => {
    if (!query.trim() || !firstMatchId) return;
    const first = nodes.find((node) => node.id === firstMatchId);
    if (first) onPick(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // 高亮按**行所属来源**取：当前 tab 是设计稿就用设计稿那个槽，是截图就用截图那个。
  // 两侧的槽互不影响，所以「在 App 侧选了一个」不会把设计稿那一行的高亮抹掉。
  const active = selections[source];

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
