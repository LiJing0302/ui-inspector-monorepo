import { fromCanonicalId } from '@shared/aiAcceptance';
import type { Rect, VerifySource } from '@shared/verify';

/**
 * 「正在核对的那一条匹配」在画布上要画成什么。
 *
 * ## 为什么单独一个模块
 *
 * 这段逻辑有两个容易写错的地方，而它们都不是「查表」那么简单：
 *
 *  1. **一条匹配可能是 N:M 的成组匹配**（文本聚合后 3 个设计文本 ↔ 1 个 App 文本），
 *     所以不能像早期版本那样只取「两侧各第一个能找到的」。取一个的后果是：
 *     画布上只亮一个框，用户以为这条匹配只有一个节点，而实际上旁边那两个同组的
 *     节点根本没被框出来 —— 核对时必然漏看。
 *  2. **两侧节点数未必相等，也可能有一侧整个落空**（匹配引用的节点在当前配对里
 *     不存在：换了截图、或重跑验收后结论过时）。落空不是错误，但要能被**数出来**
 *     并告诉用户，否则「点了没反应」和「点了全亮」在界面上长得一样。
 *
 * ## 为什么**不**返回「该聚焦到哪一侧」
 *
 * 早先这里还返回一个 `focus`（两侧各自的并集矩形，取节点更多的一侧），点列表会把
 * 视口移过去。删掉是因为这三条都不成立：
 *  - 点清单的第一诉求是「这一对在哪」，不是「把视口搬到它们那儿」。设计稿与 App
 *    两帧并排摆着，用户多半已经调好了取景；一点清单就跳走，等于把上一眼的位置丢掉，
 *    还得手动拖回来 —— 「点匹配列表面板会聚焦设计稿」正是被报上来的那条。
 *  - 一条匹配**两侧都有节点**（成组匹配更是两侧各好几个），「聚焦哪一侧」没有正确答案：
 *    挑一侧 = 把另一侧推出视野，而不挑 = 两个并集矩形都算，视口该往哪走说不清。
 *  - 高亮自己就回答了「在哪」：框是青色的、画得出来；落在视野外用户自己平移即可。
 *
 * 于是视口只有一条显式路径：图层列表点某一行（`CanvasBoard.handleFocus`）——
 * 那一击的意图本来就是「过去」，与「在清单上核对」不是同一件事。
 *
 * 放进 lib 而不是内联在 `CanvasBoard` 里：它是纯函数（输入 id 列表 + 查询函数，
 * 输出矩形），可以脱离 React 直接验。`CanvasBoard` 已经有 1000 行，再塞一段
 * 「哪些 id 该出框、落空了几个」进去，下次改判据就要在组件生命周期里读它。
 */

/** 画框只需三样东西：哪一帧、帧内逻辑矩形、是否被祖先裁掉 */
export interface MatchFocusNode {
  source: VerifySource;
  rect: Rect;
  clipped: boolean;
}

export interface MatchFocus {
  /** 要画框的节点，**设计稿在前**（与两侧画布的左→右顺序一致，不按匹配里的顺序） */
  boxes: MatchFocusNode[];
  /** 两侧各自命中到几个节点。任一侧与 `requested` 不符，说明匹配引用了当前配对里没有的节点 */
  resolved: { design: number; app: number };
  /** 传入的 id 总数（两侧），与 `resolved` 对照即可判断是否有落空 */
  requested: { design: number; app: number };
}

export interface MatchFocusInput {
  designIds: readonly string[];
  appIds: readonly string[];
  /**
   * canonicalId → 画框要用的字段。注入而不是直接收 Map：
   * 设计稿与 App 的节点表结构不同（前者 `id`、后者 `nodeId`），
   * 由调用方负责那一层，这里只关心「给我一个 id，还我一个矩形」。
   */
  lookup: (source: VerifySource, id: string) => MatchFocusNode | null;
}

export function planMatchFocus(input: MatchFocusInput): MatchFocus {
  const boxes: MatchFocusNode[] = [];
  const resolved = { design: 0, app: 0 };

  const collect = (canonicalIds: readonly string[], expected: VerifySource): void => {
    for (const canonical of canonicalIds) {
      const parsed = fromCanonicalId(canonical);
      // 前缀与所在数组不符（数据坏了）或解析不出来 → 当作落空，不猜
      if (!parsed || parsed.source !== expected) continue;
      const node = input.lookup(expected, parsed.id);
      if (!node) continue;
      boxes.push(node);
      resolved[expected] += 1;
    }
  };

  // 设计稿先收集：`boxes` 的顺序决定绘制顺序，而绘制顺序影响重叠时的可见性
  collect(input.designIds, 'design');
  collect(input.appIds, 'app');

  return {
    boxes,
    resolved,
    requested: { design: input.designIds.length, app: input.appIds.length },
  };
}
