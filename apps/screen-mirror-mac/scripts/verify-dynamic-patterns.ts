/**
 * §7.3 验证脚本：dynamicPatterns 故障注入。
 *
 * 门禁（对应计划 7.3 验收）：
 *  1. "12:00"→"12:05" 只出 P2 DYNAMIC_CONTENT，不阻断 verdict（verdict ≠ fail）。
 *  2. "确认"→"取消" 仍判 P1 TEXT_MISMATCH。
 *  3. "¥1,299"→"¥1,399"（同 pattern 但数值变）判 P1 —— 豁免格式位，不豁免数值。
 *  4. "¥1,299"→"¥ 1,299"（纯格式变化）判 P2 DYNAMIC_CONTENT。
 *  5. 非法正则在配置规范化时直接抛错（fail fast），不进入验收流程。
 *  6. isDynamicOnlyChange 单元判定：相对时间 / 数量级换算 / 骨架不等。
 *
 * 用法：
 *   esbuild scripts/verify-dynamic-patterns.ts --bundle --platform=node --format=esm \
 *     --outfile=.smoke/verify-dynamic-patterns.mjs --log-level=warning && node .smoke/verify-dynamic-patterns.mjs
 */
import {
  canonicalizeApp,
  canonicalizeDesign,
  compileDynamicPatterns,
  evaluateAcceptance,
  isDynamicOnlyChange,
} from '../src/main/acceptance/core';
import type { AppNode, DesignNode } from '../src/types/verify';
import type { AcceptanceIssue, NodeMatch } from '../src/types/aiAcceptance';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function d(id: string, text: string): DesignNode {
  return {
    id, name: id, type: 'TEXT', path: id, depth: 1, visible: true,
    rect: { x: 10, y: 10, width: 100, height: 20 },
    text: { characters: text }, parentId: 'root',
  } as unknown as DesignNode;
}
function a(nodeId: string, text: string): AppNode {
  return {
    nodeId, parentId: 'root', className: 'TextView', depth: 1, index: 0,
    x: 10, y: 10, width: 100, height: 20,
    visibleX: 10, visibleY: 10, visibleWidth: 100, visibleHeight: 20,
    scrollX: 0, scrollY: 0, visible: true, enabled: true, text,
  } as unknown as AppNode;
}
function rootD(): DesignNode {
  return {
    id: 'root', name: 'root', type: 'FRAME', path: 'root', depth: 0, visible: true,
    rect: { x: 0, y: 0, width: 375, height: 800 }, parentId: null,
  } as unknown as DesignNode;
}
function rootA(): AppNode {
  return {
    nodeId: 'root', parentId: null, className: 'RootView', depth: 0, index: 0,
    x: 0, y: 0, width: 375, height: 800,
    visibleX: 0, visibleY: 0, visibleWidth: 375, visibleHeight: 800,
    scrollX: 0, scrollY: 0, visible: true, enabled: true,
  } as unknown as AppNode;
}

const EVIDENCE = { geometry: 0, structure: 0, relation: 0, visual: 0, content: 0, kind: 0 };
const QUALITY = {
  profile: 'acceptance-full', requestedMaxDepth: 10, requestedMaxNodes: 1000,
  actualDepth: 2, actualNodeCount: 2, depthLimitReached: false, nodeLimitReached: false,
  hiddenNodesIncluded: false, zeroSizeNodesIncluded: false, textIncluded: true, excludedNodes: [],
};

/** 构造一对文本节点的差分输入，直接测 evaluateAcceptance 的文本分支（故障注入）。 */
function diffText(designText: string, appText: string): { issues: AcceptanceIssue[]; verdict: string } {
  const design = canonicalizeDesign([rootD(), d('t', designText)], 375, 800);
  const app = canonicalizeApp([rootA(), a('u', appText)], 375, 800);
  const matches: NodeMatch[] = [{
    id: 'm1', designNodeIds: ['design:t'], appNodeIds: ['app:u'],
    relation: 'one_to_one', source: 'rule', ruleScore: 1, confidence: 1, margin: 1,
    evidence: EVIDENCE, status: 'matched',
  }];
  const result = evaluateAcceptance({
    design, app, matches, source: 'sdk', coordinateValid: true, collectionQuality: QUALITY,
  });
  const textIssues = result.issues.filter((i) => i.check === 'text');
  return { issues: textIssues, verdict: result.verdict };
}

console.log('== 故障注入：差分阶段 ==');
{
  const { issues, verdict } = diffText('12:00', '12:05');
  check('时间变化只出 1 条 issue', issues.length === 1, `got ${issues.length}`);
  check('时间变化判 P2', issues[0]?.severity === 'P2', `got ${issues[0]?.severity}`);
  check('时间变化 reason=DYNAMIC_CONTENT', issues[0]?.reasonCodes.includes('DYNAMIC_CONTENT') === true,
    JSON.stringify(issues[0]?.reasonCodes));
  check('时间变化不阻断 verdict（≠fail）', verdict !== 'fail', `got ${verdict}`);
}
{
  const { issues, verdict } = diffText('确认', '取消');
  check('普通文案变化判 P1', issues[0]?.severity === 'P1', `got ${issues[0]?.severity}`);
  check('普通文案 reason=TEXT_MISMATCH', issues[0]?.reasonCodes.includes('TEXT_MISMATCH') === true);
  check('普通文案变化 verdict=fail', verdict === 'fail', `got ${verdict}`);
}
{
  const { issues } = diffText('¥1,299', '¥1,399');
  check('价格数值变化判 P1（不豁免数值）', issues[0]?.severity === 'P1', `got ${issues[0]?.severity}`);
  check('价格数值变化 reason=TEXT_MISMATCH', issues[0]?.reasonCodes.includes('TEXT_MISMATCH') === true);
}
{
  const { issues } = diffText('¥1,299', '¥ 1,299');
  check('价格格式变化判 P2（豁免格式位）', issues[0]?.severity === 'P2', `got ${issues[0]?.severity}`);
  check('价格格式变化 reason=DYNAMIC_CONTENT', issues[0]?.reasonCodes.includes('DYNAMIC_CONTENT') === true);
}
{
  const { issues } = diffText('3天前', '5天前');
  check('相对时间变化判 P2', issues[0]?.severity === 'P2', `got ${issues[0]?.severity}`);
}
{
  const { issues } = diffText('1.2万', '12000');
  check('数量级换算（1.2万→12000）判 P2', issues[0]?.severity === 'P2', `got ${issues[0]?.severity}`);
}
{
  const { issues } = diffText('5千', '6千');
  check('数量数值变化判 P1', issues[0]?.severity === 'P1', `got ${issues[0]?.severity}`);
}
{
  const { issues } = diffText('12:00', '12:00');
  check('完全相同无 issue', issues.length === 0, `got ${issues.length}`);
}

console.log('== isDynamicOnlyChange 单元 ==');
{
  const patterns = compileDynamicPatterns([
    { name: 'DATETIME', pattern: '\\d{1,2}:\\d{2}', valueDynamic: true },
    { name: 'PRICE', pattern: '[¥￥$]\\s?[\\d,]+', valueDynamic: false },
  ]);
  check('骨架不等不豁免', isDynamicOnlyChange('价格：¥100', '原价：¥100', patterns) === false);
  check('设计侧没命中不豁免', isDynamicOnlyChange('免费', '¥100', patterns) === false);
  check('多片段时间都变仍豁免', isDynamicOnlyChange('9:00-18:00', '9:05-18:05', patterns) === true);
  check('多片段价格其一数值变不豁免', isDynamicOnlyChange('¥100~¥200', '¥100~¥250', patterns) === false);
}

console.log('== fail fast：非法正则 ==');
{
  let threw = false;
  let message = '';
  try {
    evaluateAcceptance({
      design: canonicalizeDesign([rootD()], 375, 800),
      app: canonicalizeApp([rootA()], 375, 800),
      matches: [], source: 'sdk', coordinateValid: true,
      profile: {
        text: { exact: true, normalizeWhitespace: true, caseSensitive: true, dynamicPatterns: ['([invalid'] },
      },
    });
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  check('非法正则在配置规范化时抛错', threw, 'no throw');
  check('错误信息指明 dynamicPatterns', message.includes('dynamicPatterns'), message.slice(0, 80));
}

if (failures > 0) {
  console.log(`\n${failures} 项未通过`);
  process.exit(1);
} else {
  console.log('\n全部通过');
}
