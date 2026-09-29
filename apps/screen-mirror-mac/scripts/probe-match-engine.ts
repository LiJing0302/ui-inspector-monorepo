/**
 * 离线跑一遍匹配引擎，输入是一份 `debug-exports/*.json`（Mac app 里点「导出」得到）。
 *
 * 为什么要有它：验收报告只会告诉你「匹配了几条」，而核查规则改动**必须**看中间量 ——
 * 意义类别分布、参与度分布、每一条锁定配对的来源（文本锚点 / 祖先投票 / 兄弟分配）、
 * 以及配错的那几条长什么样。在 app 里反复点「运行验收 → 导出 → 打开 JSON」一次要几分钟，
 * 而这里改完规则 1 秒就能看到结果。
 *
 * 用法：
 *   npm run probe:match -- "<导出包路径>"
 */

import { readFileSync } from 'node:fs';

import { canonicalizeApp, canonicalizeDesign, diagnoseMatching, matchDocuments } from '../src/main/acceptance/core';
import type { MatchTrace } from '../src/main/acceptance/core';
import type { AppNode, AppSnapshotMeta, DesignAssetMeta, DesignNode } from '../src/types/verify';
import type { CanonicalDocument, NodeMatch } from '../src/types/aiAcceptance';

interface Bundle {
  design: { asset: DesignAssetMeta; rawNodes?: DesignNode[] };
  app: { snapshot: AppSnapshotMeta };
  rawNodes: { design: DesignNode[]; app: AppNode[] };
  requirement: { name: string };
  statusCounts: Record<string, number>;
}

const file = process.argv[2];
if (!file) {
  console.error('用法：npm run probe:match -- "<debug-exports/*.json 路径>"');
  process.exit(1);
}

const bundle = JSON.parse(readFileSync(file, 'utf8')) as Bundle;
const designNodes = bundle.rawNodes.design;
const appNodes = bundle.rawNodes.app;
const designDocument = canonicalizeDesign(designNodes, bundle.design.asset.width, bundle.design.asset.height);
const appDocument = canonicalizeApp(appNodes, bundle.app.snapshot.width, bundle.app.snapshot.height);
const trace: MatchTrace = { scopedDesign: new Set(), scopedApp: new Set() };
const matches = matchDocuments(designDocument, appDocument, undefined, trace);

const designLabel = new Map(designNodes.map((node) => [`design:${node.id}`, node.text?.characters?.trim() || node.name || node.type]));
const appLabel = new Map(appNodes.map((node) => {
  const text = node.text?.trim();
  return [`app:${node.nodeId}`, [node.className.split('.').pop(), text ? `“${text.slice(0, 18)}”` : null].filter(Boolean).join(' ')];
}));

function countBy<T>(items: readonly T[], pick: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function describe(match: NodeMatch): string {
  const design = match.designNodeIds
    .map((id) => {
      const node = designDocument.nodes.find((item) => item.canonicalId === id);
      return `${designLabel.get(id) ?? id} ${node ? `${node.rect.width}×${node.rect.height}` : ''}`;
    })
    .join(' + ');
  const app = match.appNodeIds
    .map((id) => {
      const node = appDocument.nodes.find((item) => item.canonicalId === id);
      return `${appLabel.get(id) ?? id} ${node ? `${node.rect.width}×${node.rect.height}` : ''}`;
    })
    .join(' + ');
  return `${match.status.padEnd(9)} ${(match.origin ?? '—').padEnd(20)} ${match.confidence.toFixed(3)}  ${design}  ↔  ${app}`;
}

const statusCounts = countBy(matches, (match) => match.status);
const originCounts = countBy(matches.filter((match) => match.status === 'matched' || match.status === 'ambiguous'), (match) => match.origin ?? 'unknown');

const designRequired = designDocument.nodes.filter((node) => node.participation === 'required');
const matchedDesign = new Set(matches.flatMap((match) => (match.status === 'matched' || match.status === 'ambiguous') ? match.designNodeIds : []));
const appMatched = new Set(matches.flatMap((match) => (match.status === 'matched' || match.status === 'ambiguous') ? match.appNodeIds : []));

console.log(`样本：${bundle.requirement?.name ?? ''} / ${bundle.design.asset.name}`);
console.log(`节点：design ${designDocument.nodes.length}（${designDocument.width}×${designDocument.height}）  app ${appDocument.nodes.length}（${appDocument.width}×${appDocument.height}）`);
console.log('');
console.log('意义类别 salience  design / app');
for (const key of ['text', 'graphic', 'box', 'layout']) {
  const designCount = (designDocument.nodes as CanonicalDocument['nodes']).filter((node) => node.salience === key).length;
  const appCount = (appDocument.nodes as CanonicalDocument['nodes']).filter((node) => node.salience === key).length;
  console.log(`  ${key.padEnd(9)} ${String(designCount).padStart(4)} / ${String(appCount).padStart(4)}`);
}
console.log('');
console.log('参与度 participation  design / app');
for (const key of ['required', 'context', 'optional', 'ignored', 'unavailable']) {
  const designCount = designDocument.nodes.filter((node) => node.participation === key).length;
  const appCount = appDocument.nodes.filter((node) => node.participation === key).length;
  if (designCount === 0 && appCount === 0) continue;
  console.log(`  ${key.padEnd(11)} ${String(designCount).padStart(4)} / ${String(appCount).padStart(4)}`);
}
console.log('');
console.log('匹配状态（旧引擎导出包里的 statusCounts 可对照）');
for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${status.padEnd(10)} ${String(count).padStart(4)}`);
}
console.log('');
console.log('锁定配对的来源');
for (const [origin, count] of Object.entries(originCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${origin.padEnd(20)} ${String(count).padStart(4)}`);
}
console.log('');
console.log(`覆盖率：design required ${designRequired.length} 个，配到 ${designRequired.filter((node) => matchedDesign.has(node.canonicalId)).length} 个`
  + `（${((designRequired.filter((node) => matchedDesign.has(node.canonicalId)).length / Math.max(1, designRequired.length)) * 100).toFixed(1)}%）`);
console.log(`        app required ${appDocument.nodes.filter((node) => node.participation === 'required').length} 个，配到 ${appDocument.nodes.filter((node) => node.participation === 'required' && appMatched.has(node.canonicalId)).length} 个`);
console.log('');

const diagnosis = diagnoseMatching(designDocument, appDocument, matches, trace);
console.log('归宿表（覆盖率按 required 档算 — 旧口径「匹配对数 / 节点并集」已被它取代）');
const renderResolve = (
  label: string,
  table: ReturnType<typeof diagnoseMatching>['resolve']['design'],
): void => {
  const resolved = table.required.matched + table.required.ambiguous;
  const rate = table.required.total === 0 ? '—' : `${((resolved / table.required.total) * 100).toFixed(1)}%`;
  console.log(`  ${label} total ${table.total} / required ${table.required.total}`);
  console.log(
    `        归宿 matched ${table.required.matched} · ambiguous ${table.required.ambiguous}`
    + ` · 未消化 ${table.required.unresolved}（其中**静默丢失** ${table.required.outOfScope}） → ${rate}`,
  );
};
renderResolve('design', diagnosis.resolve.design);
renderResolve('app   ', diagnosis.resolve.app);
console.log('');
console.log(`根：design ${diagnosis.designRootIds.join(',')}  app ${diagnosis.appRootIds.join(',')}`);

const locks = matches.filter((match) => match.status === 'matched' || match.status === 'ambiguous');
if (process.argv.includes('--list')) {
  console.log('');
  console.log(`全部锁定配对（${locks.length} 条）：`);
  for (const match of locks) console.log(`  ${describe(match)}`);
} else {
  console.log('');
  console.log('前 40 条锁定配对（加 --list 看全部）：');
  for (const match of locks.slice(0, 40)) console.log(`  ${describe(match)}`);
}
