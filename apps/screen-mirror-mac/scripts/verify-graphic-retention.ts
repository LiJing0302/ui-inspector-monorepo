/**
 * §7.2 验证脚本：图形节点保留。
 *
 * 门禁（对应计划 7.2 验收）：
 *  1. designer-habits —— "设计师常见画法"样本：
 *     Frame 包图片 / 圆角矩形按钮 / 图标 Frame，graphic 节点 100% participation=required，
 *     包图片的 Frame 判 box（豁免生效）而非 layout。
 *  2. app-fallback —— App 侧 hasVisualContent 缺失时 isImage/isSvg 弱证据生效；
 *     显式 false 不被覆盖。
 *  3. fate-matrix —— diagnoseMatching 的 salience×终点矩阵能回答"每个 graphic 去哪了"，
 *     本样本里 graphic 行 filtered:unscoped 必须为 0。
 *
 * 用法：
 *   esbuild scripts/verify-graphic-retention.ts --bundle --platform=node --format=esm \
 *     --outfile=.smoke/verify-graphic-retention.mjs --log-level=warning && node .smoke/verify-graphic-retention.mjs [all|designer-habits|app-fallback|fate-matrix]
 */
import {
  canonicalizeApp,
  canonicalizeDesign,
  diagnoseMatching,
  matchDocuments,
} from '../src/main/acceptance/core';
import type { MatchTrace } from '../src/main/acceptance/core';
import type { AppNode, DesignNode } from '../src/types/verify';
import type { CanonicalDocument } from '../src/types/aiAcceptance';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function d(id: string, parentId: string | null, type: string, x: number, y: number, w: number, h: number, extra?: Record<string, unknown>): DesignNode {
  return {
    id, name: id, type, path: id, depth: parentId ? 1 : 0, visible: true,
    rect: { x, y, width: w, height: h },
    parentId,
    ...extra,
  } as unknown as DesignNode;
}
function a(nodeId: string, parentId: string | null, className: string, x: number, y: number, w: number, h: number, extra?: Record<string, unknown>): AppNode {
  return {
    nodeId, parentId, className, depth: parentId ? 1 : 0, index: 0,
    x, y, width: w, height: h,
    visibleX: x, visibleY: y, visibleWidth: w, visibleHeight: h,
    scrollX: 0, scrollY: 0, visible: true, enabled: true,
    ...extra,
  } as unknown as AppNode;
}

function byId(doc: CanonicalDocument, id: string) {
  const node = doc.nodes.find((n) => n.canonicalId === id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

/** 设计师常见画法：Frame 包图片、圆角矩形按钮、图标 Frame，外加文本锚点。 */
function buildDesignerDocs(): { design: CanonicalDocument; app: CanonicalDocument } {
  const designNodes: DesignNode[] = [
    d('root', null, 'FRAME', 0, 0, 375, 800),
    d('t1', 'root', 'TEXT', 10, 20, 100, 20, { text: { characters: 'title' } }),
    d('t2', 'root', 'TEXT', 10, 50, 100, 20, { text: { characters: 'subtitle' } }),
    // 1. Frame 包图片：Frame 无填充，唯一子节点是铺满的 IMAGE
    d('imgwrap', 'root', 'FRAME', 10, 100, 200, 120, { hasFill: false }),
    d('photo', 'imgwrap', 'RECTANGLE', 10, 100, 200, 120, {
      hasFill: true,
      fills: [{ type: 'IMAGE', visible: true, opacity: 1 }],
    }),
    // 2. 圆角矩形按钮：RECTANGLE + 可见填充，有文本子节点 → box（分发内容），必须 required
    d('btn', 'root', 'RECTANGLE', 10, 240, 160, 48, { hasFill: true }),
    d('btnlabel', 'btn', 'TEXT', 20, 252, 100, 20, { text: { characters: 'buy' } }),
    // 2b. 纯色块：无子节点的圆角矩形 → graphic 叶子（GRAPHIC_DESIGN_TYPES 之外，靠 hasFill 兜底）
    d('badge', 'root', 'RECTANGLE', 200, 240, 40, 40, { hasFill: true }),
    // 3. 图标 Frame：无填充 Frame 包 VECTOR
    d('iconwrap', 'root', 'FRAME', 10, 310, 48, 48, { hasFill: false }),
    d('icon', 'iconwrap', 'VECTOR', 10, 310, 48, 48, { hasFill: true }),
  ];
  const appNodes: AppNode[] = [
    a('root', null, 'RootView', 0, 0, 375, 800),
    a('u1', 'root', 'TextView', 10, 20, 100, 20, { text: 'title' }),
    a('u2', 'root', 'TextView', 10, 50, 100, 20, { text: 'subtitle' }),
    // App 侧故意不上报 hasVisualContent：只能靠 isImage 弱证据
    a('imgwrap', 'root', 'ViewGroup', 10, 100, 200, 120),
    a('photo', 'imgwrap', 'ImageView', 10, 100, 200, 120, { isImage: true }),
    a('btn', 'root', 'View', 10, 240, 160, 48, { hasVisualContent: true }),
    a('btnlabel', 'btn', 'TextView', 20, 252, 100, 20, { text: 'buy' }),
    a('badge', 'root', 'View', 200, 240, 40, 40, { hasVisualContent: true }),
    a('iconwrap', 'root', 'ViewGroup', 10, 310, 48, 48),
    a('icon', 'iconwrap', 'ImageView', 10, 310, 48, 48, { isSvg: true }),
  ];
  return {
    design: canonicalizeDesign(designNodes, 375, 800),
    app: canonicalizeApp(appNodes, 375, 800),
  };
}

const mode = process.argv[2] ?? 'all';

if (mode === 'all' || mode === 'designer-habits') {
  console.log('== designer-habits: 常见画法的 graphic 必须保留 ==');
  const { design, app } = buildDesignerDocs();

  // Frame 包图片：父容器豁免为 box（不是 layout），图片本身 graphic
  const imgwrapD = byId(design, 'design:imgwrap');
  check('design imgwrap salience=box（豁免生效）', imgwrapD.salience === 'box', `got ${imgwrapD.salience}`);
  check('design imgwrap participation=required', imgwrapD.participation === 'required', `got ${imgwrapD.participation}`);
  check('design photo salience=graphic', byId(design, 'design:photo').salience === 'graphic');
  check('design photo participation=required', byId(design, 'design:photo').participation === 'required');

  // 圆角矩形按钮：有文本子节点 → box（分发内容），但必须 required（回归：以前就参与匹配）
  check('design btn salience=box', byId(design, 'design:btn').salience === 'box', `got ${byId(design, 'design:btn').salience}`);
  check('design btn participation=required', byId(design, 'design:btn').participation === 'required');
  check('app btn salience=box', byId(app, 'app:btn').salience === 'box', `got ${byId(app, 'app:btn').salience}`);
  // 纯色块：无子节点 + hasFill → graphic 叶子
  check('design badge salience=graphic', byId(design, 'design:badge').salience === 'graphic');
  check('app badge salience=graphic', byId(app, 'app:badge').salience === 'graphic');

  // 图标 Frame：父 box，子 graphic
  const iconwrapD = byId(design, 'design:iconwrap');
  check('design iconwrap salience=box', iconwrapD.salience === 'box', `got ${iconwrapD.salience}`);
  check('design icon salience=graphic', byId(design, 'design:icon').salience === 'graphic');

  // App 侧：父容器同样豁免（hasVisualContent 缺失也不影响豁免——豁免看的是子节点）
  const imgwrapA = byId(app, 'app:imgwrap');
  check('app imgwrap salience=box（豁免生效）', imgwrapA.salience === 'box', `got ${imgwrapA.salience}`);
  check('app imgwrap participation=required', imgwrapA.participation === 'required');
  check('app photo salience=graphic（isImage 弱证据）', byId(app, 'app:photo').salience === 'graphic');
  check('app iconwrap salience=box', byId(app, 'app:iconwrap').salience === 'box', `got ${byId(app, 'app:iconwrap').salience}`);
  check('app icon salience=graphic（isSvg 弱证据）', byId(app, 'app:icon').salience === 'graphic');

  // 全部 graphic 节点 participation=required —— 7.2 验收口径
  for (const doc of [design, app]) {
    const graphics = doc.nodes.filter((n) => n.salience === 'graphic');
    const bad = graphics.filter((n) => n.participation !== 'required');
    check(`${doc.nodes[0]!.source} 侧 ${graphics.length} 个 graphic 全部 required`, bad.length === 0,
      bad.map((n) => `${n.canonicalId}=${n.participation}`).join(','));
  }
}

if (mode === 'all' || mode === 'app-fallback') {
  console.log('== app-fallback: hasVisualContent 缺失时的弱证据 ==');
  // 叶子 ImageView：hasVisualContent 缺失 + isImage → graphic，且 visual.hasVisual=true
  const doc = canonicalizeApp([
    a('root', null, 'RootView', 0, 0, 375, 800),
    a('img', 'root', 'ImageView', 10, 10, 50, 50, { isImage: true }),
    // 显式 false + isImage：SDK 明确说没画，不覆盖（保守）
    a('img2', 'root', 'ImageView', 70, 10, 50, 50, { isImage: true, hasVisualContent: false }),
    // 普通空 View：无任何证据 → layout（回归：不能把 layout 抹掉）
    a('plain', 'root', 'View', 130, 10, 50, 50),
  ], 375, 800);
  const img = byId(doc, 'app:img');
  check('缺失 hasVisualContent + isImage → graphic', img.salience === 'graphic', `got ${img.salience}`);
  check('visual.hasVisual=true（弱证据同步到 visual）', img.visual.hasVisualContent === true);
  const img2 = byId(doc, 'app:img2');
  check('显式 hasVisualContent=false 不被弱证据覆盖', img2.salience === 'graphic' && img2.visual.hasVisualContent === false,
    `salience=${img2.salience} hasVisual=${img2.visual.hasVisualContent}`);
  check('无证据的空 View 仍是 layout（未抹掉区分）', byId(doc, 'app:plain').salience === 'layout',
    `got ${byId(doc, 'app:plain').salience}`);
}

if (mode === 'all' || mode === 'fate-matrix') {
  console.log('== fate-matrix: 诊断矩阵回答"每个 graphic 去哪了" ==');
  const { design, app } = buildDesignerDocs();
  const trace: MatchTrace = { scopedDesign: new Set(), scopedApp: new Set() };
  const matches = matchDocuments(design, app, undefined, trace);
  const diagnosis = diagnoseMatching(design, app, matches, trace);
  const graphicRow = diagnosis.fate.design.graphic;
  console.log('   fate.design.graphic:', JSON.stringify(graphicRow));
  check('矩阵有 graphic 行', !!graphicRow);
  if (graphicRow) {
    check('graphic 行 filtered:unscoped=0（无静默丢失）',
      (graphicRow['filtered:unscoped'] ?? 0) === 0, JSON.stringify(graphicRow));
    check('graphic 行 filtered:ignored=0', (graphicRow['filtered:ignored'] ?? 0) === 0);
  }
  const badFates = diagnosis.graphicFates.filter(
    (g) => g.fate === 'filtered:ignored' || g.fate === 'filtered:unscoped' || g.fate === 'filtered:context',
  );
  check(`graphicFates 明细 ${diagnosis.graphicFates.length} 条无 filtered`, badFates.length === 0,
    badFates.map((g) => `${g.canonicalId}=${g.fate}`).join(','));
  for (const g of diagnosis.graphicFates) {
    console.log(`   - ${g.canonicalId} participation=${g.participation} fate=${g.fate}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} 项未通过`);
  process.exit(1);
} else {
  console.log('\n全部通过');
}
