/**
 * 把「人工标注真值」和「引擎离线重放」对起来跑，直接输出配对级 P/R/F1。
 *
 * ## 为什么必须有它
 *
 * 在这之前，改引擎规则只能看**聚合总数**（matched 从 48 变 54），而总数可以完全不变
 * 但错的全换一批 —— 没有真值就永远不知道自己是变好还是变坏。有了它，改完规则 1 秒
 * 就能看到「漏配 42 → 9」这种读数，而不是「去 app 里点一遍验收再肉眼比对」。
 *
 * ## 两个输入
 *
 *   1. `debug-exports/*.json` —— 含**原始节点全量**（`rawNodes`），重放引擎必须用它
 *      （真值包里的 `universe` 只有 required 节点，喂回引擎等于换了输入）。
 *   2. `ground-truth-exports/*.json` —— 人工答案。
 *
 * 两个文件必须是**同一个配对**。不校验的话，拿 A 页的真值去评 B 页的结论会得到
 * 一个看起来很正常、其实毫无意义的数字。
 *
 * ## 口径
 *
 * 判定复用 `agreement.ts` 的 `agreementOf`（与标注包导出**同一份实现**）。
 * `weak` = 引擎给到了候选但没自动确认 —— 这条在工具里是会被展示给人看的，
 * 所以它**不算漏配**，但也不算配上了。
 *
 * 用法：
 *   npm run replay:gt -- "<debug-exports/*.json>" "<ground-truth-exports/*.json>" [--list]
 */

import { readFileSync } from 'node:fs';

import { canonicalizeApp, canonicalizeDesign, matchDocuments } from '../src/main/acceptance/core';
import { buildPageDocument, matchNodesWithinRegions, matchRegions } from '../src/main/acceptance/regions';
import { agreementOf, buildEngineIndex, statusOf } from '../src/main/acceptance/agreement';
import { pixelTransformRejectionReasons, toPixelHostProfile } from '../src/main/acceptance/pixelTransform';
import type { PixelTransformContract } from '../src/types/acceptance';
import type { AppNode, DesignNode } from '../src/types/verify';
import type {
  GroundTruthEngineNodeStatus,
  GroundTruthExportBundle,
  GroundTruthPair,
  GroundTruthPairExport,
} from '../src/types/groundTruth';

interface DebugBundle {
  requirement: { id: string; name: string };
  pair: { id: string };
  design: { asset: { id: string; name: string; width: number; height: number; screenshotFile?: string } };
  app: {
    snapshot: {
      id: string;
      label?: string;
      width: number;
      height: number;
      pixelWidth?: number;
      pixelHeight?: number;
      screenshotFile?: string;
      /**
       * 宿主取整档位（2026-09-29 加，调试包 v4 起）。
       * v3 及更早的包没有这个字段 → `toPixelHostProfile` 落默认档，并**在下一步触发契约
       * 版本不匹配告警**（包里的契约是 `-v1`）—— 旧包的几何是「一律按边界投影」算的，
       * 不能与新规则的结果直接混比较。
       */
      hostProfile?: string;
    };
  };
  /** v3 起的配对调试包自带变换契约 */
  pixelTransform?: { contract?: PixelTransformContract | null } | null;
  rawNodes: { design: DesignNode[]; app: AppNode[] };
}

const [debugPath, truthPath] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const listAll = process.argv.includes('--list');

/** 标注里的节点至少要在重放文档里存在这么多比例，否则判定为「不是同一批数据」 */
const NODE_OVERLAP_FLOOR = 0.8;

if (!debugPath || !truthPath) {
  console.error('用法：npm run replay:gt -- "<debug-exports/*.json>" "<ground-truth-exports/*.json>" [--list]');
  process.exit(1);
}

const debug = JSON.parse(readFileSync(debugPath, 'utf8')) as DebugBundle;
const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as GroundTruthExportBundle;

const designDocument = canonicalizeDesign(debug.rawNodes.design, debug.design.asset.width, debug.design.asset.height);
// ⚠️ 必须把截图的**物理像素**宽高一起传进去。漏传的话 `appDocument.pixelWidth` 永远是
// undefined，这份文档就与实时链路里那份不是同一个东西了 —— 像素类结论会整体静默降级成
// 「不可判定」，而重放脚本恰恰是用来判断「引擎这次跑得对不对」的，静默降级会给出假的「没问题」。
const appDocument = canonicalizeApp(
  debug.rawNodes.app,
  debug.app.snapshot.width,
  debug.app.snapshot.height,
  debug.app.snapshot.pixelWidth,
  debug.app.snapshot.pixelHeight,
  // 宿主档位同样要传：漏了它，重放出来的 `CanonicalDocument` 就与实时链路那份不同
  // （几何期望值的宽高算法差一档），而差异只在「设计值 × 倍率非整数」的节点上显现 ——
  // 正是最难靠肉眼发现的那种。
  toPixelHostProfile(debug.app.snapshot.hostProfile),
);

/*
 * 校验调试包里的变换契约与快照上下文是否同一套规则。
 *
 * ⚠️ 只告警、**不终止**：本脚本的产物是匹配质量（P/R/F1），与坐标空间无关 —— 因为契约不一致
 * 就整体退出，等于把一份仍然可用的匹配评估拒之门外。但告警不能省：调试包里的几何字段若被
 * 下游当成像素真值使用，读的人必须知道它是按哪套规则算出来的。
 */
const declaredTransform = debug.pixelTransform?.contract ?? null;
const transformContext = debug.app.snapshot.pixelWidth
  ? {
    basisWidth: designDocument.width,
    viewportWidth: debug.app.snapshot.width,
    pixelWidth: debug.app.snapshot.pixelWidth,
    hostProfile: toPixelHostProfile(debug.app.snapshot.hostProfile),
  }
  : null;
const transformReasons = declaredTransform && transformContext
  ? pixelTransformRejectionReasons(declaredTransform, transformContext)
  : [];
if (transformReasons.length > 0) {
  console.error(
    `⚠️ 变换契约与快照上下文不匹配（${transformReasons.join(' / ')}）：调试包由另一版规则产出，`
    + '其中的像素类结论不可直接与本次比较。',
  );
}

/*
 * 同一配对校验 —— 拿 A 页的真值评 B 页的结论，会得到一个看着正常、其实毫无意义的数字。
 *
 * ⚠️ 判据用**节点集重合度**而不是 `pair.id`：实测两次导出之间重新导入过设计稿，
 * pairId 会变，但节点是同一批 —— 用 id 卡会把一份完全可用的数据拒之门外。
 * 反过来，id 相同也不代表能比（同一 pair 可以重新采集出完全不同的 App 快照），
 * 所以「节点还在不在」才是真正要问的问题。
 */
const compareNodeSets = (label: string, annotatedIds: readonly string[], documentIds: ReadonlySet<string>): number => {
  if (annotatedIds.length === 0) return 1;
  const kept = annotatedIds.filter((id) => documentIds.has(id)).length;
  const ratio = kept / annotatedIds.length;
  if (ratio < NODE_OVERLAP_FLOOR) {
    console.error(`${label} 节点重合度过低：${kept}/${annotatedIds.length} = ${(ratio * 100).toFixed(1)}%`
      + `（低于 ${NODE_OVERLAP_FLOOR * 100}% 视为不是同一批数据）`);
    process.exit(2);
  }
  return ratio;
};

const designIds = new Set(designDocument.nodes.map((node) => node.canonicalId));
const appIds = new Set(appDocument.nodes.map((node) => node.canonicalId));
const designOverlap = compareNodeSets('设计稿', truth.universe.design.map((node) => node.canonicalId), designIds);
const appOverlap = compareNodeSets('App', truth.universe.app.map((node) => node.canonicalId), appIds);

const designPage = buildPageDocument(designDocument, { file: debug.design.asset.screenshotFile ?? '' }, appDocument);
const appPage = buildPageDocument(appDocument, { file: debug.app.snapshot.screenshotFile ?? '' }, designDocument);
const regionMatches = matchRegions(designPage, appPage);
const matches = matchNodesWithinRegions({
  design: designPage,
  app: appPage,
  regionMatches,
  baseMatches: matchDocuments(designDocument, appDocument),
});
const engineIndex = buildEngineIndex(matches);

const designById = new Map(designDocument.nodes.map((node) => [node.canonicalId, node]));
const appById = new Map(appDocument.nodes.map((node) => [node.canonicalId, node]));

function countBy<T>(items: readonly T[], pick: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function labelOf(id: string): string {
  const design = designById.get(id);
  if (design) return `${design.content.rawText ?? design.kind} ${design.rect.width}×${design.rect.height}`;
  const app = appById.get(id);
  if (app) return `${app.content.rawText ?? app.kind} ${app.rect.width}×${app.rect.height}`;
  return '(已不存在的节点)';
}

/**
 * 导出包里的配对是**烘开**的形态（`design` / `app` 是节点对象数组，便于人读），
 * 而判定函数吃的是**存储形态**（`designNodeIds` / `appNodeIds`）。这里做一次投影。
 *
 * ⚠️ 不直接把导出形态喂给判定函数：那需要判定函数同时认识两种形态，
 * 于是「标注包里这一条是什么」会有两处实现 —— 而它正是所有数字的来源。
 */
function toStoredPair(pair: GroundTruthPairExport): GroundTruthPair {
  return {
    id: pair.id,
    designNodeIds: pair.design.map((node) => node.canonicalId),
    appNodeIds: pair.app.map((node) => node.canonicalId),
    verdict: pair.verdict,
    ...(pair.origin ? { origin: pair.origin } : {}),
    ...(pair.note ? { note: pair.note } : {}),
    createdAt: pair.createdAt,
  };
}

const rows = truth.pairs.map((exported) => {
  const pair = toStoredPair(exported);
  const designStatuses = pair.designNodeIds.map((id) => statusOf(engineIndex, id));
  const appStatuses = pair.appNodeIds.map((id) => statusOf(engineIndex, id));
  return { pair, exported, designStatuses, appStatuses, agreement: agreementOf(pair, designStatuses, appStatuses) };
});

const agreementCounts = countBy(rows, (row) => row.agreement);
const originCounts = countBy(
  rows.filter((row) => row.agreement !== 'missed' && row.agreement !== 'unknown'),
  (row) => [...row.designStatuses, ...row.appStatuses].find((status) => status.status !== 'missing' && status.status !== 'extra')?.origin ?? '—',
);
const lockOriginCounts = countBy(
  matches.filter((match) => match.status === 'matched' || match.status === 'ambiguous'),
  (match) => match.origin ?? 'unknown',
);

const total = rows.length;
const agrees = agreementCounts.agrees ?? 0;
const weak = agreementCounts.weak ?? 0;
const partial = agreementCounts.partial ?? 0;
const contradicts = agreementCounts.contradicts ?? 0;
const missed = agreementCounts.missed ?? 0;
/** 「命中」= 完全一致 + 部分命中 + 已给候选：三者都意味着引擎**找到了**这条对应 */
const found = agrees + weak + partial;

console.log(`配对：${truth.requirement.name} / ${truth.pair.designName}`);
console.log(`节点：design ${designDocument.nodes.length}（${designDocument.width}×${designDocument.height}）`
  + `  app ${appDocument.nodes.length}（${appDocument.width}×${appDocument.height}）`);
console.log(`区域：design ${designPage.regions.length} / app ${appPage.regions.length}`
  + ` / matched ${regionMatches.filter((item) => item.status === 'matched').length}`
  + ` / ambiguous ${regionMatches.filter((item) => item.status === 'ambiguous').length}`);
if (process.argv.includes('--regions')) {
  console.log('设计区域：', designPage.regions.map((item) => `${item.role}@${item.rect.x},${item.rect.y},${item.rect.width}x${item.rect.height}`).join(' | '));
  console.log('App 区域：', appPage.regions.map((item) => `${item.role}@${item.rect.x},${item.rect.y},${item.rect.width}x${item.rect.height}`).join(' | '));
  console.log('区域匹配：', regionMatches.filter((item) => item.appRegionIds.length > 0).map((item) => {
    const designRegion = designPage.regions.find((region) => region.id === item.designRegionIds[0]);
    const appRegion = appPage.regions.find((region) => region.id === item.appRegionIds[0]);
    return `${designRegion?.role}@${designRegion?.rect.y} -> ${appRegion?.role}@${appRegion?.rect.y} ${item.status}/${item.confidence.toFixed(3)}`;
  }).join(' | '));
}
console.log(`数据校验：标注节点在重放文档中的重合度 design ${(designOverlap * 100).toFixed(1)}%`
  + ` / app ${(appOverlap * 100).toFixed(1)}%`
  + `（pairId ${debug.pair?.id === truth.pair?.id ? '一致' : '不同，已按节点集校验'}）`);
console.log('');
console.log(`人工标注 ${total} 对 —— 引擎表现：`);
for (const key of ['agrees', 'weak', 'partial', 'contradicts', 'missed', 'unknown'] as const) {
  const count = agreementCounts[key] ?? 0;
  console.log(`  ${key.padEnd(11)} ${String(count).padStart(4)}  ${total === 0 ? '' : `${((count / total) * 100).toFixed(1)}%`}`);
}
console.log('');
console.log('配对级指标（把 weak 计入「找到了」，contradicts 计入「配错」）：');
console.log(`  召回 found/total      ${found}/${total} = ${total === 0 ? '—' : ((found / total) * 100).toFixed(1)}%`);
console.log(`  完全一致 agrees/total  ${agrees}/${total} = ${total === 0 ? '—' : ((agrees / total) * 100).toFixed(1)}%`);
console.log(`  配错 contradicts      ${contradicts}`);
console.log(`  漏配 missed           ${missed}`);
console.log('');
console.log('引擎全量锁定配对的来源（与真值无关，看的是引擎把力气花在哪）：');
for (const [origin, count] of Object.entries(lockOriginCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${origin.padEnd(22)} ${String(count).padStart(4)}`);
}
console.log('');
console.log('命中的那些是靠哪一层命中的：');
for (const [origin, count] of Object.entries(originCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${origin.padEnd(22)} ${String(count).padStart(4)}`);
}

const show = (title: string, keys: readonly string[]): void => {
  const selected = rows.filter((row) => keys.includes(row.agreement));
  if (selected.length === 0) return;
  console.log('');
  console.log(`${title}（${selected.length} 条${listAll ? '' : '，只列前 25'}）：`);
  for (const row of listAll ? selected : selected.slice(0, 25)) {
    const design = row.pair.designNodeIds.map(labelOf).join(' + ') || '—';
    const app = row.pair.appNodeIds.map(labelOf).join(' + ') || '—';
    const all = [...row.designStatuses, ...row.appStatuses];
    const expected = new Set([...row.pair.designNodeIds, ...row.pair.appNodeIds]);
    /**
     * 挑出**真正解释这条判定**的那个状态。
     *
     * ⚠️ 不能退化成「第一条带 origin 的」：一条 `contradicts` 是别的层把节点配走造成的，
     * 而 L3c 可能同时对这个节点挂着一个无害的候选 —— 于是报告会把「扣扳机的层」显示成 L3c，
     * 排查时就会去改一个本来没错的层。诊断工具指错方向比不指更糟。
     */
    const explain = (): GroundTruthEngineNodeStatus | undefined => {
      if (row.agreement === 'contradicts') {
        return all.find(
          (item) => item.status === 'matched' && item.partners.some((partner) => !expected.has(partner)),
        );
      }
      if (row.agreement === 'weak') {
        return all.find(
          (item) => item.status === 'ambiguous' && item.partners.some((partner) => expected.has(partner)),
        );
      }
      return all.find((item) => item.origin && item.status !== 'missing' && item.status !== 'extra') ?? all[0];
    };
    const status = explain();
    // 带上置信度：判断「这条是靠什么分数被自动确认的」只能看它，光看 origin 不够
    const score = status?.confidence == null ? '' : ` (${status.confidence})`;
    console.log(`  [${row.exported.shape}] ${String(status?.origin ?? '—').padEnd(20)}${score.padEnd(8)} ${design}  ↔  ${app}`);
  }
};

show('漏配 missed（召回缺口）', ['missed']);
show('已给候选 weak（在待复核列表里）', ['weak']);
show('配错 contradicts（方向性错误，最该先修）', ['contradicts']);
show('部分命中 partial', ['partial']);
