/**
 * 标注（ground truth）的纯逻辑：待配对组、配对键、预填、汇总。
 *
 * 不碰 DOM、不碰 React、不发 IPC —— 与 `lib/selection` 同一种写法，
 * 冒烟测试可以直接喂数组断言。组件里只负责「把用户的手势翻译成一次调用」。
 *
 * ## 一个关键取舍：待配对组是**数组**，不是 { design, app }
 *
 * 直觉写法是 `{ designId: string | null, appId: string | null }`（左边一个、右边一个），
 * 但真实数据里 1:N / N:M 是**常态**而不是例外：实测「好礼兑不停」这类聚合文本，
 * 设计稿一侧是 3 个文本节点、App 一侧是 1 个。用双槽表达不了，只能退化成「多标几次」，
 * 而每多标一次就多一条本该是同一组的记录 —— 导出的 `shape` 全是 `1:1`，
 * 我拿到的答案就再也看不出哪些其实是一个元素。
 *
 * 所以待配对组就是一个 `string[]`，由**用户点几下**决定它有几个人。
 * 组内混着两侧的 id 是正常的，`designIdsOf` / `appIdsOf` 负责在提交时拆开。
 *
 * ## 为什么配对键里要带 verdict
 *
 * 同一批节点可能先被标成 `matched`、后来发现对侧是空的，改成 `no-counterpart`。
 * 如果键只由节点集合派生，改判会**命中同一条记录并原地覆盖**——听起来正好，
 * 但那样「设计有 App 无」这条证据就把「曾经匹配过」这件事抹掉了，而两者是**
 * 不同的事实**（一个是漏实现，一个是实现错了）。带上 verdict 让两种判定并存，
 * 汇总时也数得清。
 */

import type { GroundTruthPair, GroundTruthPairOrigin, GroundTruthVerdict } from '@shared/groundTruth';
import { fromCanonicalId } from '@shared/aiAcceptance';

/** 待配对组：一串 canonicalId，允许两侧混装、允许任意个数 */
export type PendingGroup = readonly string[];

/**
 * 把一次点击落成「加入 / 移出待配对组」。
 *
 * 点已经在组里的节点 = 移出（第二下撤销），这是唯一不需要额外按钮的纠错方式 ——
 * 点错了要能随手改掉，而不是去面板里找那一行的删除键。
 *
 * 新加的**追加在末尾**而不是插入前面：面板按点击顺序显示，用户才能看出
 * 「我刚才点的是这个」。
 */
export function togglePending(pending: PendingGroup, id: string): string[] {
  const at = pending.indexOf(id);
  if (at >= 0) return pending.filter((item) => item !== id);
  return [...pending, id];
}

export interface PendingCounts {
  design: number;
  app: number;
}

export function pendingCounts(pending: PendingGroup): PendingCounts {
  let design = 0;
  let app = 0;
  for (const id of pending) {
    const parsed = fromCanonicalId(id);
    if (parsed?.source === 'design') design += 1;
    else if (parsed?.source === 'app') app += 1;
  }
  return { design, app };
}

/** 待配对组里属于某一侧的 id（保持点击顺序，导出时人能对上自己刚才的动作） */
export function sideIdsOf(pending: PendingGroup, source: 'design' | 'app'): string[] {
  return pending.filter((id) => fromCanonicalId(id)?.source === source);
}

/**
 * 判定能不能提交，以及**不能提交的原因**。
 *
 * 返回原因而不是布尔：按钮的禁用态只能表达「不能」，而人更需要知道「还差什么」——
 * 「配对了但只点了设计稿」是最常见的一种，这时禁用按钮不加说明，看起来就是坏了。
 */
export function submitBlocker(
  pending: PendingGroup,
  verdict: GroundTruthVerdict,
): string | null {
  const counts = pendingCounts(pending);
  const total = counts.design + counts.app;
  if (total === 0) return '先在画布上点选节点';
  // ⚠️ 拿到 id 但认不出来源的（既不是 design: 也不是 app:）不该静默混进去，
  // 它们会导致「导出里这一侧少一个节点」，而原因只在远处的一次改写里
  if (total !== pending.length) return '有节点 id 无法识别来源，请清空重选';
  if (verdict === 'matched') {
    if (counts.design === 0) return '「配对」需要两侧都有节点，现在只点了 App 侧';
    if (counts.app === 0) return '「配对」需要两侧都有节点，现在只点了设计稿侧';
  }
  return null;
}

/**
 * 32 位 FNV-1a。用它把节点集合折成一个短 id。
 *
 * 两轮不同偏移量拼起来（≈64 位）而不是一轮：单轮 32 位在几百条标注量级上虽然也够用，
 * 但一旦撞了，表现是**两条标注被静默合并**——`upsertPair` 会认为它们是同一条。
 * 这种错不会报任何错，只会让「我明明标了 200 条、导出只有 199 条」变得无法解释。
 */
function fnv1a(input: string, offset: number): string {
  let hash = offset;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function digest(input: string): string {
  return `${fnv1a(input, 0x811c9dc5)}${fnv1a(input, 0x01000193)}`;
}

/**
 * 一条标注的稳定键。
 *
 * 节点集合**排序后**参与计算：同一次标注里点选的先后顺序是随手产生的，
 * 让它影响 id 会让「先点设计再点 App」与「先点 App 再点设计」变成两条记录。
 */
export function pairKeyOf(
  designNodeIds: readonly string[],
  appNodeIds: readonly string[],
  verdict: GroundTruthVerdict,
): string {
  const design = [...designNodeIds].sort().join(',');
  const app = [...appNodeIds].sort().join(',');
  return `gt-${digest(`${verdict}|${design}|${app}`)}`;
}

export interface BuildPairOptions {
  origin?: GroundTruthPairOrigin;
  note?: string;
  /** 注入时间以便测试；缺省取当前时刻 */
  now?: Date;
}

/**
 * 由待配对组造一条标注。
 *
 * **合法性判定直接复用 `submitBlocker`**，而不是在这里再写一遍「matched 要两侧都有」：
 * 那样规则就有两份，而两份规则最常见的结果是「按钮能点、记录造不出来」——
 * 一个没有报错、也没有产出的点击，比直接拒绝难查得多。
 * 复用之后 UI 用它解释「为什么不能点」，这里用它拒绝，两边不可能不一致。
 */
export function buildPair(
  pending: PendingGroup,
  verdict: GroundTruthVerdict,
  options: BuildPairOptions = {},
): GroundTruthPair | null {
  if (submitBlocker(pending, verdict) !== null) return null;
  const designNodeIds = sideIdsOf(pending, 'design');
  const appNodeIds = sideIdsOf(pending, 'app');
  const createdAt = (options.now ?? new Date()).toISOString();
  return {
    id: pairKeyOf(designNodeIds, appNodeIds, verdict),
    designNodeIds,
    appNodeIds,
    verdict,
    origin: options.origin ?? 'human',
    ...(options.note ? { note: options.note } : {}),
    createdAt,
  };
}

/**
 * 写入一条标注：同键**整条替换**（而不是合并数组）。
 *
 * 替换是刻意的。合并会让「我重新点了一遍、想去掉多点的那个节点」变成不可能 ——
 * 少点一个节点产生的是**新的键**，旧的还在，于是两套记录同时存在，
 * 汇总时两个都不是答案。
 *
 * 新记录排在最前：列表按「最近标的在上面」显示，刚标完那一条不用往下翻。
 */
export function upsertPair(pairs: readonly GroundTruthPair[], pair: GroundTruthPair): GroundTruthPair[] {
  return [pair, ...pairs.filter((item) => item.id !== pair.id)];
}

export function removePair(pairs: readonly GroundTruthPair[], id: string): GroundTruthPair[] {
  return pairs.filter((item) => item.id !== id);
}

/** 某一侧已经出现在任何一条标注里的节点（切到别的标注时避免重复劳动） */
export function annotatedIds(pairs: readonly GroundTruthPair[]): Set<string> {
  const set = new Set<string>();
  for (const pair of pairs) {
    for (const id of pair.designNodeIds) set.add(id);
    for (const id of pair.appNodeIds) set.add(id);
  }
  return set;
}

/** 找某个节点所属的标注（选中它时，面板要能亮出「它已经属于哪一条」） */
export function pairOfNode(
  pairs: readonly GroundTruthPair[],
  canonicalId: string,
): GroundTruthPair | null {
  return (
    pairs.find(
      (pair) => pair.designNodeIds.includes(canonicalId) || pair.appNodeIds.includes(canonicalId),
    ) ?? null
  );
}

export const VERDICT_LABELS: Record<GroundTruthVerdict, string> = {
  matched: '配对',
  'no-counterpart': '另一侧不存在',
  ignore: '不参与验收',
};

export function verdictLabel(verdict: GroundTruthVerdict): string {
  return VERDICT_LABELS[verdict];
}

/**
 * 一条标注的**方向性**描述。`verdict` 只说「另一侧不存在」，但人不该自己去数
 * 「不存在」是缺了还是多了 —— 那是这一整件事唯一要看的结论。
 */
export function pairDirection(pair: GroundTruthPair): string {
  const design = pair.designNodeIds.length;
  const app = pair.appNodeIds.length;
  if (pair.verdict === 'matched') return `${design} 设计 ↔ ${app} App`;
  if (pair.verdict === 'ignore') return design + app > 0 ? `忽略 ${design} 设计 / ${app} App` : '忽略';
  if (design > 0 && app === 0) return `${design} 个设计稿元素在 App 侧不存在（疑似漏实现）`;
  if (app > 0 && design === 0) return `${app} 个 App 元素在设计稿里没有（疑似多出来）`;
  return `${design} 设计 / ${app} App 两侧都标为不存在`;
}

export interface GroundTruthDigest {
  total: number;
  matched: number;
  noCounterpart: number;
  ignore: number;
  /** 由引擎结论预填、人还没改过的条数 —— 面板要把这个数单独亮出来 */
  prefilled: number;
  designNodes: number;
  appNodes: number;
  /** 有备注的条数（提醒「还有几条等着解释」） */
  noted: number;
}

export function summarize(pairs: readonly GroundTruthPair[]): GroundTruthDigest {
  const digest: GroundTruthDigest = {
    total: pairs.length,
    matched: 0,
    noCounterpart: 0,
    ignore: 0,
    prefilled: 0,
    designNodes: 0,
    appNodes: 0,
    noted: 0,
  };
  for (const pair of pairs) {
    if (pair.verdict === 'matched') digest.matched += 1;
    else if (pair.verdict === 'no-counterpart') digest.noCounterpart += 1;
    else digest.ignore += 1;
    if (pair.origin === 'engine-prefill') digest.prefilled += 1;
    digest.designNodes += pair.designNodeIds.length;
    digest.appNodes += pair.appNodeIds.length;
    if (pair.note && pair.note.length > 0) digest.noted += 1;
  }
  return digest;
}

/** `prefillFromMatches` 需要的最小形状。直接用 `NodeMatch` 会把这个纯函数模块拖进引擎类型 */
export interface PrefillMatch {
  status: string;
  designNodeIds: readonly string[];
  appNodeIds: readonly string[];
}

export interface PrefillResult {
  pairs: GroundTruthPair[];
  /** 因为已经存在同键标注而跳过的条数（重复点预填不该造成任何变化） */
  skipped: number;
}

/**
 * 从引擎结论预填 `matched` 项，作为标注草稿。
 *
 * ## 只预填 `matched`，**不预填 missing / extra**
 *
 * `missing` / `extra` 是引擎对**缺陷**的主张，而它们恰恰是这个引擎噪声最大的一档：
 * 实测一份真实导出里，App 侧 527 个节点只有 123 个承载视觉结果，其余是视口外 /
 * 布局透传 / 零尺寸 —— 机械预填会一口气生成几百条「疑似漏实现」，
 * 而人真正要判断的只是其中十几条。把噪声铺满画布，等于让人先去删两百条垃圾，
 * 比手点还慢。
 *
 * 更要紧的是**方向**：`matched` 是引擎有信心的部分，预填它是在替人省「把对的东西
 * 写下来」这份重复劳动，人只需去改错的那几条；而 missing / extra 是引擎没底气的部分，
 * 预填等于把它的判断当既定事实塞进答案里。
 *
 * ## 预填项一律带 `engine-prefill` 标记
 *
 * 它们**不是独立证据**（就是引擎自己的输出）。导出时按来源分开统计，
 * 否则「预填 + 只改错的」会得到一条接近 100% 的准确率曲线，且从数字上看不出原因。
 */
export function prefillFromMatches(
  matches: readonly PrefillMatch[],
  existing: readonly GroundTruthPair[] = [],
  options: { now?: Date } = {},
): PrefillResult {
  const taken = new Set(existing.map((pair) => pair.id));
  const pairs: GroundTruthPair[] = [];
  let skipped = 0;
  for (const match of matches) {
    if (match.status !== 'matched') continue;
    if (match.designNodeIds.length === 0 || match.appNodeIds.length === 0) continue;
    const pair = buildPair([...match.designNodeIds, ...match.appNodeIds], 'matched', {
      origin: 'engine-prefill',
      ...(options.now ? { now: options.now } : {}),
    });
    if (!pair) continue;
    if (taken.has(pair.id)) {
      skipped += 1;
      continue;
    }
    taken.add(pair.id);
    pairs.push(pair);
  }
  return { pairs, skipped };
}
