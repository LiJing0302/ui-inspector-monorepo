/**
 * §7.1 验证脚本：匹配策略层。
 *
 * 三个门禁（综合了计划 7.1 的验收标准，ground-truth 部分等真实样本包到了再补）：
 *  1. parity   —— 默认/显式 structure-first 与改前行为一致（综合输入 NodeMatch[] 深比较）；
 *  2. geofirst —— geometry-first 能跑完，输出结构合法；
 *  3. conflict —— 构造「几何指 A、结构指 B」的跨层冲突，geometry-first 下必须产出
 *                  ambiguous + 双方候选，而不是后层静默覆盖/丢弃。
 *
 * 用法：
 *   esbuild scripts/verify-match-strategy.ts --bundle --platform=node --format=esm \
 *     --outfile=.smoke/verify-match-strategy.mjs --log-level=warning && node .smoke/verify-match-strategy.mjs [parity|geofirst|conflict|all]
 *   baseline 模式只跑无参调用，用于 git stash 前后对比：
 *     node .smoke/verify-match-strategy.mjs baseline > /tmp/before.json
 */
import { canonicalizeApp, canonicalizeDesign, matchDocuments } from '../src/main/acceptance/core';
import type { AppNode, DesignNode } from '../src/types/verify';
import type { CanonicalDocument, NodeMatch } from '../src/types/aiAcceptance';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ---------- 综合输入 ----------
function d(id: string, parentId: string | null, type: string, x: number, y: number, w: number, h: number, text?: string): DesignNode {
  return {
    id, name: id, type, path: id, depth: parentId ? 1 : 0, visible: true,
    rect: { x, y, width: w, height: h },
    ...(text ? { text: { characters: text } } : {}),
    parentId,
  } as unknown as DesignNode;
}
function a(nodeId: string, parentId: string | null, className: string, x: number, y: number, w: number, h: number, text?: string, extra?: Partial<AppNode>): AppNode {
  return {
    nodeId, parentId, className, depth: parentId ? 1 : 0, index: 0,
    x, y, width: w, height: h,
    visibleX: x, visibleY: y, visibleWidth: w, visibleHeight: h,
    scrollX: 0, scrollY: 0, visible: true, enabled: true,
    ...(text ? { text } : {}),
    ...extra,
  } as unknown as AppNode;
}

function buildParityDocs(): { design: CanonicalDocument; app: CanonicalDocument } {
  const designNodes: DesignNode[] = [
    d('root', null, 'FRAME', 0, 0, 375, 800),
    d('t1', 'root', 'TEXT', 10, 100, 100, 20, 'nav-1'),
    d('t2', 'root', 'TEXT', 10, 200, 100, 20, 'nav-2'),
    d('t3', 'root', 'TEXT', 10, 300, 100, 20, 'nav-3'),
    d('t4', 'root', 'TEXT', 10, 400, 100, 20, 'nav-4'),
    d('card', 'root', 'FRAME', 10, 500, 200, 120),
    d('s1', 'card', 'TEXT', 20, 510, 80, 20, 'item-a'),
    d('s2', 'card', 'TEXT', 20, 545, 80, 20, 'item-b'),
    d('pic', 'root', 'RECTANGLE', 230, 500, 100, 100),
  ];
  const appNodes: AppNode[] = [
    a('root', null, 'RootView', 0, 0, 375, 800),
    a('u1', 'root', 'TextView', 10, 100, 100, 20, 'nav-1'),
    a('u2', 'root', 'TextView', 10, 200, 100, 20, 'nav-2'),
    a('u3', 'root', 'TextView', 10, 300, 100, 20, 'nav-3'),
    a('u4', 'root', 'TextView', 10, 400, 100, 20, 'nav-4'),
    a('card', 'root', 'ViewGroup', 12, 502, 198, 118),
    a('v1', 'card', 'TextView', 20, 510, 80, 20, 'item-a'),
    a('v2', 'card', 'TextView', 20, 545, 80, 20, 'item-b'),
    a('img', 'root', 'ImageView', 232, 502, 98, 98, undefined, { isImage: true }),
  ];
  return {
    design: canonicalizeDesign(designNodes, 375, 800),
    app: canonicalizeApp(appNodes, 375, 800),
  };
}

// ---------- 冲突场景 ----------
// 设计：C_d 容器（0,400,200,100）内有 s1..s3；App：C_a_near(5,402) 更近但与文本锚点无关，
// C_a_far(20,400) 稍远却是 s1..s3 的真正父容器。几何先行会锁 C_d→C_a_near，
// 祖先投票会投 C_d→C_a_far —— 必须仲裁成 ambiguous，不能静默丢弃投票。
function buildConflictDocs(): { design: CanonicalDocument; app: CanonicalDocument } {
  const designNodes: DesignNode[] = [
    d('root', null, 'FRAME', 0, 0, 375, 800),
    d('a1', 'root', 'TEXT', 10, 0, 100, 20, 'a-1'),
    d('a2', 'root', 'TEXT', 10, 100, 100, 20, 'a-2'),
    d('a3', 'root', 'TEXT', 10, 200, 100, 20, 'a-3'),
    d('a4', 'root', 'TEXT', 10, 300, 100, 20, 'a-4'),
    d('cd', 'root', 'FRAME', 0, 400, 200, 100),
    d('s1', 'cd', 'TEXT', 10, 410, 80, 20, 's-1'),
    d('s2', 'cd', 'TEXT', 10, 440, 80, 20, 's-2'),
    d('s3', 'cd', 'TEXT', 10, 470, 80, 20, 's-3'),
  ];
  const appNodes: AppNode[] = [
    a('root', null, 'RootView', 0, 0, 375, 800),
    a('b1', 'root', 'TextView', 10, 0, 100, 20, 'a-1'),
    a('b2', 'root', 'TextView', 10, 100, 100, 20, 'a-2'),
    a('b3', 'root', 'TextView', 10, 200, 100, 20, 'a-3'),
    a('b4', 'root', 'TextView', 10, 300, 100, 20, 'a-4'),
    // 几何诱饵：更近（d≈7），但里面没有文本锚点
    a('c_near', 'root', 'ViewGroup', 5, 402, 200, 100, undefined, { hasVisualContent: true }),
    a('g_near', 'c_near', 'ImageView', 5, 402, 200, 100, undefined, { isImage: true }),
    // 结构真值：稍远（d≈20），是 s1..s3 的父容器
    a('c_far', 'root', 'ViewGroup', 20, 400, 200, 100, undefined, { hasVisualContent: true }),
    a('t1', 'c_far', 'TextView', 30, 410, 80, 20, 's-1'),
    a('t2', 'c_far', 'TextView', 30, 440, 80, 20, 's-2'),
    a('t3', 'c_far', 'TextView', 30, 470, 80, 20, 's-3'),
  ];
  return {
    design: canonicalizeDesign(designNodes, 375, 800),
    app: canonicalizeApp(appNodes, 375, 800),
  };
}

function summarize(matches: NodeMatch[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of matches) out[m.status] = (out[m.status] ?? 0) + 1;
  return out;
}

function stable(matches: NodeMatch[]): string {
  return JSON.stringify(matches.map((m) => ({
    id: m.id, d: m.designNodeIds, a: m.appNodeIds, s: m.status, o: m.origin,
    alt: (m.alternatives ?? []).map((x) => x.appNodeId).sort(),
  })).sort((x, y) => x.id.localeCompare(y.id)));
}

const mode = process.argv[2] ?? 'all';

if (mode === 'baseline' || mode === 'all' || mode === 'parity') {
  console.log('== parity: 默认 vs 显式 structure-first ==');
  const { design, app } = buildParityDocs();
  const base = matchDocuments(design, app);
  const explicit = matchDocuments(design, app, undefined, undefined, { match: { strategy: 'structure-first' } });
  if (mode === 'baseline') {
    console.log(stable(base));
  } else {
    check('structure-first 与默认调用深相等', stable(base) === stable(explicit));
    check('产出非空', base.length > 0, `got ${base.length}`);
    console.log('   status 分布:', JSON.stringify(summarize(base)));
  }
}

if (mode === 'all' || mode === 'geofirst') {
  console.log('== geofirst: geometry-first 可运行 ==');
  const { design, app } = buildParityDocs();
  const matches = matchDocuments(design, app, undefined, undefined, { match: { strategy: 'geometry-first' } });
  check('产出非空', matches.length > 0, `got ${matches.length}`);
  check('origin 含 calibrated-position', matches.some((m) => m.origin === 'calibrated-position'));
  console.log('   status 分布:', JSON.stringify(summarize(matches)));
  console.log('   origin 分布:', JSON.stringify(matches.reduce<Record<string, number>>((acc, m) => {
    const k = m.origin ?? 'none'; acc[k] = (acc[k] ?? 0) + 1; return acc;
  }, {})));
}

if (mode === 'all' || mode === 'conflict') {
  console.log('== conflict: 跨层冲突必须仲裁成 ambiguous ==');
  const { design, app } = buildConflictDocs();
  const matches = matchDocuments(design, app, undefined, undefined, { match: { strategy: 'geometry-first' } });
  const cd = matches.find((m) => m.designNodeIds.includes('design:cd'));
  check('找到 design:cd 的配对', !!cd, JSON.stringify(matches.map((m) => m.designNodeIds)));
  if (cd) {
    console.log(`   design:cd → app: ${cd.appNodeIds.join(',')} status=${cd.status} origin=${cd.origin}`);
    console.log(`   alternatives: ${JSON.stringify((cd.alternatives ?? []).map((x) => x.appNodeId))}`);
    check('status 为 ambiguous（不是静默取其一）', cd.status === 'ambiguous', `got ${cd.status}`);
    const alts = new Set((cd.alternatives ?? []).map((x) => x.appNodeId));
    // alternatives 里必须同时出现几何候选与结构候选
    const hasNear = alts.has('app:c_near') || cd.appNodeIds.includes('app:c_near');
    const hasFar = alts.has('app:c_far') || cd.appNodeIds.includes('app:c_far');
    check('保留几何候选 app:c_near', hasNear, [...alts].join(','));
    check('保留结构候选 app:c_far', hasFar, [...alts].join(','));
  }
  // 对照：structure-first 下同一场景的行为（L3a 先锁，不应触发仲裁）
  const struct = matchDocuments(design, app, undefined, undefined, { match: { strategy: 'structure-first' } });
  const cdS = struct.find((m) => m.designNodeIds.includes('design:cd'));
  console.log(`   [对照] structure-first: design:cd → ${cdS?.appNodeIds.join(',')} status=${cdS?.status} origin=${cdS?.origin}`);
}

if (failures > 0) {
  console.log(`\n${failures} 项未通过`);
  process.exit(1);
} else if (mode !== 'baseline') {
  console.log('\n全部通过');
}
