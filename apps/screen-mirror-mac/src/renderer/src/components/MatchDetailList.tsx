import React, { useCallback, useMemo, useState } from 'react';

import type { NodeMatch } from '@shared/aiAcceptance';

/**
 * 六特征的展示顺序与中文名，**按权重降序**。
 *
 * 权重来自 `main/acceptance/core.ts`：geometry .28 / structure .18 / relation .16 /
 * visual .16 / kind .12 / content .10。按权重大小排而不是按类型分组 ——
 * 「这个节点为什么没被判 matched」的答案通常就在最上面那一两条里，
 * 排在前面就不用先把六个数都读一遍再自己比大小。
 */
const EVIDENCE_ROWS: ReadonlyArray<{ key: keyof NodeMatch['evidence']; label: string }> = [
  { key: 'geometry', label: '几何' },
  { key: 'structure', label: '结构' },
  { key: 'relation', label: '关系' },
  { key: 'visual', label: '视觉' },
  { key: 'kind', label: '类型' },
  { key: 'content', label: '内容' },
];

const SOURCE_LABEL: Record<NodeMatch['source'], string> = {
  rule: '规则',
  ai: 'AI',
  manual: '人工',
  mixed: '混合',
};

/** 行内没有位置放状态文字，但状态必须能被**读出来**（颜色只是辅助）—— 走 title 与 aria。 */
const STATUS_LABEL: Record<NodeMatch['status'], string> = {
  matched: '已匹配',
  ambiguous: '待确认',
  missing: '缺失',
  extra: '多余',
  ignored: '已忽略',
};

const RELATION_LABEL: Record<NodeMatch['relation'], string> = {
  one_to_one: '一对一',
  one_to_many: '一对多',
  many_to_one: '多对一',
  missing: '缺失',
  extra: '多余',
  ambiguous: '歧义',
};

type FilterKey = 'all' | NodeMatch['status'];

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'matched', label: '已匹配' },
  { key: 'ambiguous', label: '待确认' },
  { key: 'missing', label: '缺失' },
  { key: 'extra', label: '多余' },
];

/** 一次多渲染多少条。上限是采集端的 30000 节点，匹配对可能上千，不能一次全铺进 DOM。 */
const VISIBLE_STEP = 40;

interface MatchDetailListProps {
  matches: NodeMatch[];
  /**
   * `design:12` / `app:34` → 人能读的名字。
   *
   * 由 `CanvasBoard` 注入而不是在这里查节点表：节点表（`designById` / `appById`）是画布的
   * 状态，本组件只该知道「怎么显示」，不该知道「去哪找」。
   * 拿不到名字时回退到原始 id，不抛错 —— 匹配结果引用了已被删除的节点是可能的。
   */
  nodeLabel: (canonicalId: string) => string;
  /**
   * 当前在画布上高亮着的那一条（`NodeMatch.id`）。
   *
   * 这个组件只负责**显示**选中态 —— 高亮的真实状态在 `CanvasBoard`，它才是
   * 「画布上要亮哪些框」的持有者。回灌一个 key 而不是在这里存一份 selected：
   * 同一件事存两份，取消高亮（再点一次）时就会有一处忘了清。
   */
  activeKey: string | null;
  /**
   * 点条目 = 在画布上把这条匹配涉及的两侧节点**整组高亮**（不移动视口）。
   * `id` 一并传出去，画布回灌的 `activeKey` 才能指回这是哪一行。
   */
  onFocusMatch: (designNodeIds: string[], appNodeIds: string[], matchId?: string | null) => void;
  onConfirmMatch: (match: NodeMatch) => void;
  onIgnoreMatch: (match: NodeMatch) => void;
}

/**
 * 「匹配明细」列表 —— 把 `AcceptanceResult.matches` 完整铺开。
 *
 * 为什么需要它：这套引擎每对匹配都算了六特征分、与次优候选的差距（`margin`）、
 * 候选榜（`alternatives`）和判定来源（`source`），但在它之前，界面上只有五个汇总计数
 * 与一个「待确认」列表 —— 前者看不出是哪个节点，后者只显示 id 与总分。
 * 于是「它为什么把这俩判成一对」这个问题，在工具里没有答案，只能去读代码。
 *
 * 三条刻意的取舍：
 *  1. **点条目 = 在画布上高亮这一对，不是展开**。排查时的第一反应是「在哪」，
 *     而不是「多少分」—— 而且高亮**只画框、不动视口**（理由见 `lib/matchFocus`）。
 *     展开退到行尾一个独立按钮，两者不会误触。
 *     高亮的是**两侧全部节点**而不只是「一条对应一个」：成组匹配（文本聚合后的 N:M）
 *     里同组的每个节点都要框出来，否则「这一组是不是都对上了」根本没法看。
 *     再点同一条即取消 —— 列表里没有清除按钮，靠这一下收回去。
 *  2. **默认收起**。六特征 + 候选榜一次铺开会让列表长到没法扫；而绝大多数条目
 *     并不需要看依据（分数已经说明问题）。只有存疑的那些才值得展开。
 *  3. **缺失 / 多余也在同一张表里**，只是有一侧为空。分开列会让人以为它们是
 *     「另一类东西」，其实它们就是匹配在这一侧的结论。
 */
const MatchDetailList: React.FC<MatchDetailListProps> = ({
  matches,
  nodeLabel,
  activeKey,
  onFocusMatch,
  onConfirmMatch,
  onIgnoreMatch,
}) => {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [visible, setVisible] = useState(VISIBLE_STEP);

  const counts = useMemo(() => {
    const map = new Map<FilterKey, number>([['all', matches.length]]);
    for (const item of matches) map.set(item.status, (map.get(item.status) ?? 0) + 1);
    return map;
  }, [matches]);

  const filtered = useMemo(
    () => (filter === 'all' ? matches : matches.filter((item) => item.status === filter)),
    [filter, matches],
  );

  const toggle = useCallback((id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const pickFilter = useCallback((key: FilterKey): void => {
    setFilter(key);
    // 换筛选条件后沿用上一次的展开量没有意义（列表整个变了），回到第一屏
    setVisible(VISIBLE_STEP);
  }, []);

  const join = useCallback(
    (ids: string[]): string => (ids.length === 0 ? '—' : ids.map(nodeLabel).join(' + ')),
    [nodeLabel],
  );

  if (matches.length === 0) {
    return <div className="acceptance-empty">本次运行没有产生匹配记录</div>;
  }

  const shown = filtered.slice(0, visible);
  const rest = filtered.length - shown.length;

  return (
    <div className="acceptance-md">
      <div className="acceptance-md-filters">
        {FILTERS.map((item) => {
          const count = counts.get(item.key) ?? 0;
          return (
            <button
              key={item.key}
              type="button"
              className={`acceptance-md-filter${filter === item.key ? ' active' : ''}`}
              // 计数为 0 的档位仍然保留但置灰：直接隐藏会让筛选条的长度随数据跳动，
              // 而「这一趟没有缺失」本身就是要看的信息。
              disabled={count === 0 && item.key !== 'all'}
              onClick={() => pickFilter(item.key)}
            >
              {item.label}
              <span className="acceptance-md-filter-num">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="acceptance-empty">这一类下没有条目</div>
      ) : (
        <ul className="acceptance-md-list">
          {shown.map((item) => {
            const open = expanded.has(item.id);
            const hasActions = item.status === 'ambiguous';
            const active = activeKey === item.id;
            return (
              <li
                key={item.id}
                className={`acceptance-md-row ${item.status}${active ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="acceptance-md-main"
                  aria-pressed={active}
                  title={
                    active
                      ? `${STATUS_LABEL[item.status]} · 已高亮，再点一次取消`
                      : `${STATUS_LABEL[item.status]} · 点击在画布上高亮这一对的全部节点`
                  }
                  onClick={() => onFocusMatch(item.designNodeIds, item.appNodeIds, item.id)}
                >
                  <span className={`acceptance-md-dot ${item.status}`} />
                  <span className="acceptance-md-pair">
                    <span className="acceptance-md-design">{join(item.designNodeIds)}</span>
                    <span className="acceptance-md-arrow">↔</span>
                    <span className="acceptance-md-app">{join(item.appNodeIds)}</span>
                  </span>
                  <span className="acceptance-md-score">{item.ruleScore.toFixed(2)}</span>
                </button>

                <button
                  type="button"
                  className={`acceptance-md-toggle${open ? ' open' : ''}`}
                  aria-expanded={open}
                  aria-label={open ? '收起匹配依据' : '展开匹配依据'}
                  onClick={() => toggle(item.id)}
                >
                  ▾
                </button>

                {open && (
                  <div className="acceptance-md-body">
                    <div className="acceptance-md-evidence">
                      {EVIDENCE_ROWS.map((row) => {
                        const value = item.evidence[row.key] ?? 0;
                        const width = Math.max(0, Math.min(1, value)) * 100;
                        return (
                          <div className="acceptance-md-ev" key={row.key}>
                            <span className="acceptance-md-ev-label">{row.label}</span>
                            <span className="acceptance-md-ev-track">
                              <span
                                className={`acceptance-md-ev-fill${value < 0.5 ? ' weak' : ''}`}
                                style={{ width: `${width}%` }}
                              />
                            </span>
                            <span className="acceptance-md-ev-num">{value.toFixed(2)}</span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="acceptance-md-meta">
                      {/*
                        `margin` = 当前匹配分 − **同一设计节点下最强的那个竞争候选**的分。
                        它**可以是负数**：匈牙利算法求的是全局最大权匹配，为了全局最优
                        会牺牲单行 —— 某个设计节点拿到的 App 节点未必是它自己的最高分。
                        负数因此在界面上要看得见（那是「这一对是被算法牺牲的」的信号），
                        文案也不能写成「次优」，否则负值会显得像 bug。
                      */}
                      <span
                        title="当前匹配分减去同一设计节点下最强竞争候选的分；为负表示有更强的候选，但它被全局最优分给了别的设计节点"
                      >
                        对最强候选{' '}
                        <b className={item.margin < 0 ? 'negative' : ''}>{item.margin.toFixed(2)}</b>
                      </span>
                      <span>
                        置信度 <b>{item.confidence.toFixed(2)}</b>
                      </span>
                      <span>
                        {RELATION_LABEL[item.relation]} · {SOURCE_LABEL[item.source]}
                        {typeof item.aiScore === 'number' && ` · AI ${item.aiScore.toFixed(2)}`}
                      </span>
                    </div>

                    {(item.alternatives?.length ?? 0) > 0 && (
                      <div className="acceptance-md-cands">
                        <span className="acceptance-md-cands-title">候选</span>
                        <span className="acceptance-md-cands-list">
                          {item.alternatives?.map((candidate, index) => (
                            <span className="acceptance-md-cand" key={`${candidate.appNodeId}-${index}`}>
                              {nodeLabel(candidate.appNodeId)}
                              <b>{candidate.score.toFixed(2)}</b>
                            </span>
                          ))}
                        </span>
                      </div>
                    )}

                    {hasActions && (
                      <div className="acceptance-md-actions">
                        <button type="button" className="btn tiny" onClick={() => onConfirmMatch(item)}>
                          确认
                        </button>
                        <button type="button" className="btn tiny" onClick={() => onIgnoreMatch(item)}>
                          忽略
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {rest > 0 && (
        <button
          type="button"
          className="acceptance-md-more"
          onClick={() => setVisible((current) => current + VISIBLE_STEP)}
        >
          还有 {rest} 条，展开更多
        </button>
      )}
    </div>
  );
};

export default MatchDetailList;
