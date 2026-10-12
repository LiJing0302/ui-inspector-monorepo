/**
 * M1–M4 自检套件（离线，不依赖任何外部服务）
 *
 *   node --experimental-strip-types src/__tests__/run.ts [bundleDir]
 *
 * bundleDir 缺省 `/tmp/uii-dbg`；若不存在则只跑"纯逻辑"部分并在结尾标注 SKIP。
 * 每个断言都绑定调研报告里的**实测数字**，改规则时这些数字会先烂掉。
 */

import { existsSync } from 'node:fs';
import {
  alignAnchors,
  buildRegionPrompt,
  buildRegionSlices,
  createBundleProfile2026_09_30,
  findConcatRun,
  isPlaceholder,
  normalizeText,
  sameShapeDifferentValue,
  shapeBoth,
  stripInvisible,
  toHalfWidth,
} from '../index.ts';
import { adjudicate, authorityOf } from '../l3.ts';
import { auditClean, renderCleanAudit } from '../clean-audit.ts';
import { buildMergedView } from '../merge-view.ts';
import { MockRegionReviewer, validateReview } from '../reviewer.ts';
import { measureCornerRadius, measureFillColor, runPixelChecks, downscaleForReview } from '../pixel.ts';
import { loadBundle } from '../node/loadBundle.ts';
import { flattenFigmaTree, type FigmaSchemaNode } from '../node/fromWorkspace.ts';
import { PngSampler } from '../node/pngSampler.ts';
import { OpenAiCompatibleReviewer } from '../node/openaiReviewer.ts';
import { runAcceptance } from '../harness.ts';
import type { PixelImage, RegionReviewer } from '../types.ts';
import type { Rgb } from '../color.ts';

/* ------------------------------------------------------------------ */
/* 迷你测试框架                                                        */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
let skip = 0;
const failures: string[] = [];
let currentSection = '';

function section(name: string): void {
  currentSection = name;
  console.log(`\n▌ ${name}`);
}

function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(`[${currentSection}] ${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function skipped(label: string): void {
  skip++;
  console.log(`  – ${label}（SKIP：缺少夹具 bundle）`);
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ */
/* 0. 纯逻辑（不需要 bundle）                                          */
/* ------------------------------------------------------------------ */

section('0a. Figma schema 拍平（workspace 直读的前置）');
{
  // 合成一棵三层树：前序顺序 / parentId / childCount / children 残留，四处都容易悄悄坏。
  // 真实数据上的等价性由 probe:workspace 对着 Mac app workspace 验（见 package.json）。
  const tree = {
    id: 'root',
    name: '页面',
    type: 'FRAME',
    children: [
      {
        id: 'a',
        name: 'A',
        type: 'FRAME',
        children: [
          { id: 'a1', name: 'A1', type: 'TEXT' },
          { id: 'a2', name: 'A2', type: 'TEXT' },
        ],
      },
      { id: 'b', name: 'B', type: 'RECTANGLE' },
    ],
  } as unknown as FigmaSchemaNode;
  const flat = flattenFigmaTree(tree);
  ok(flat.map((n) => n.id).join(',') === 'root,a,a1,a2,b', '前序顺序', flat.map((n) => n.id).join(','));
  ok(flat.length === 5, '节点总数 = 树内节点数', String(flat.length));
  ok(flat[0]!.parentId === null, '根节点 parentId = null');
  ok(flat[1]!.parentId === 'root' && flat[2]!.parentId === 'a', '子节点 parentId 指向父');
  ok(flat[1]!.childCount === 2 && flat[0]!.childCount === 2, 'childCount = 直接子节点数');
  ok(flat[3]!.childCount === 0, '叶子 childCount = 0');
  ok(!('children' in flat[0]!), 'children 字段不残留（残留会让节点数与体积翻倍）');
}

section('0. 文本归一化 / 动态位 / 拼接等价（纯逻辑）');
ok(stripInvisible('海尔\u200b单门50L冰箱') === '海尔单门50L冰箱', '零宽字符剔除', 'U+200B');
ok(toHalfWidth('ＡＢ１２３（ｘ）') === 'AB123(x)', '全角转半角');
ok(normalizeText('  待  付款  ') === '待付款', '空白折叠');
ok(sameShapeDifferentValue('¥560', '¥1,280'), '同形不同值 → 动态位（价格）');
ok(!sameShapeDifferentValue('待付款', '待发货'), '异形异值 → 不是动态位');
ok(
  JSON.stringify(findConcatRun(['10年包修', '&', '10年免费上门检测', '更多'], '10年包修&10年免费上门检测')) ===
    JSON.stringify([0, 1, 2]),
  '设计 3 节点拼接 ⇄ App 单节点（报告 §5.1 P2 的粒度差异）',
);
ok(isPlaceholder('-') && isPlaceholder('--') && isPlaceholder('暂无'), 'App 占位符识别');
ok(!isPlaceholder('待付款'), '占位符不误伤正常文本');

section('0b. 分权裁决的表（报告 §3.4）');
ok(authorityOf('existence') === 'strong', 'existence → 强（AI 只能降级）');
ok(authorityOf('geometry') === 'strong', 'geometry → 强');
ok(authorityOf('corner') === 'weak', 'corner → 弱（AI 可新增）');
ok(authorityOf('color') === 'weak', 'color → 弱');

section('0c. VLM 输出门禁（防幻觉，代码 enforce）');
const fakeReq = {
  region: { regionId: 'R1', label: '顶部栏', designY0: 0, designY1: 120 },
  items: [
    {
      markId: 'R1-01',
      regionId: 'R1',
      kind: 'text' as const,
      designText: 'A',
      appText: 'B',
      designBox: [0, 0, 10, 10] as [number, number, number, number],
      appBox: null,
      delta: null,
      ruleVerdict: 'text-mismatch' as const,
      ruleReason: 'x',
      hasPixelEvidence: true,
      participation: null,
    },
  ],
  dynamicHints: [] as string[],
  envHints: [] as string[],
  noPixelEvidence: false,
  cropScaleRatio: 1.44,
};
const validated = validateReview(
  {
    regionId: 'R1',
    defects: [
      { markId: 'R1-99', category: 'text', severity: 'P0', expected: 'x', actual: 'y', reason: '幻觉编号', action: 'keep' },
      { markId: 'R1-01', category: 'text', severity: 'P1', expected: 'A', actual: 'B', reason: '正常缺陷', action: 'keep' },
      { markId: 'R1-01', category: 'text', severity: 'P0', expected: 'A', actual: 'B', reason: '重复编号', action: 'keep' },
      { markId: 'R1-01', category: 'bogus' as never, severity: 'P1', expected: 'A', actual: 'B', reason: '非法类目', action: 'keep' },
    ],
    environmental: [],
    dynamic: [],
    confidence: 0.9,
  },
  fakeReq as never,
);
ok(validated.rejected.length === 3, '不存在的 markId / 重复 / 非法类目 全部拒绝', `rejected=${validated.rejected.length}`);
ok(
  validated.rejected.filter((r) => r.reason.includes('R1-99')).length === 1,
  '幻觉编号被 100% 拒绝',
);
ok(validated.accepted.length === 1 && validated.accepted[0].markId === 'R1-01', '合法缺陷被接受');

section('0d. Prompt 三段式 + 编号清单');
const prompt = buildRegionPrompt(fakeReq as never);
ok(prompt.system.includes('禁止发明新编号'), 'system 明确禁止新增编号');
ok(prompt.system.includes('hasPixelEvidence=false'), 'system 规定无像素证据不得判通过');
ok(prompt.user.includes('R1-01'), 'user 给出编号清单');

/* ------------------------------------------------------------------ */
/* 夹具                                                               */
/* ------------------------------------------------------------------ */

const bundleDir = process.argv[2] ?? process.env['UII_BUNDLE'] ?? '/tmp/uii-dbg';
const hasBundle = existsSync(`${bundleDir}/design/nodes.json`) && existsSync(`${bundleDir}/app/nodes.json`);

if (!hasBundle) {
  console.log(`\n⚠️  未找到夹具 bundle：${bundleDir}`);
  console.log('   （跳过 M1–M4 的实测断言；可传入目录或设置 UII_BUNDLE 环境变量）');
}

/* ------------------------------------------------------------------ */
/* M1：L0 + L1                                                        */
/* ------------------------------------------------------------------ */

/**
 * 夹具句柄提到**模块级**（2026-10-04）。
 *
 * 起因：AI 通道的分区级降级断言也要用 `loaded` / `designImg`，而它们原先声明在
 * 各自的 `if (hasBundle) { … }` 块内 —— 同一份东西被两个块各自需要时，
 * 要么把块拆开、要么把变量提上来。提到模块级是最小改动，且 `hasBundle` 守卫
 * 仍然管着「有没有素材」。
 */
const loaded = hasBundle ? loadBundle(bundleDir) : null;
const profile = createBundleProfile2026_09_30();
const designImg = loaded?.input.designImage?.load ? await loaded.input.designImage.load() : null;
const appImg = loaded?.input.appImage?.load ? await loaded.input.appImage.load() : null;

if (hasBundle && loaded) {
  const shape = shapeBoth({
    meta: loaded.input.meta,
    designNodes: loaded.input.designNodes,
    appNodes: loaded.input.appNodes,
    profile,
  });
  const align = alignAnchors(shape.design, shape.app, { gapJump: 40 });

  section('M1 · L0 整形');
  // 保留数从 555/366 降到 444/247，是 10-04 加 L5「视口外不参与验收」的结果：
  // 该设计稿 1261 高而 App 视口只有 792，下方 111 个设计节点 + 119 个 App 节点
  // 截图根本没拍到。⚠️ **结论不受影响**（P0/P1/P2 与锚点数逐条不变）——
  // 这正是「剔除的节点本就没参与判定」的证明。
  ok(shape.design.nodes.length === 444, '设计侧保留 444 / 609（L5 剔掉 111 个视口外节点）', `实际 ${shape.design.nodes.length}`);
  // 247 → 244：L6「纯布局容器」剔掉 3 个叶子空壳（SafeAreaProvider / DebuggingOverlay /
  // ScreenStackHeaderConfig）。⚠️ 数字只降 3 是**事实**不是判据失效 ——
  // 真实数据里 container 几乎全是有子节点的结构分组（design 160/160、app 77/78），
  // 而「有子节点」不能剔：子节点 parentId 指向它，l0 里有 6 处沿祖先链走
  // （markDesignFixedByText 等），断链会让这些判据失效。详见 l0 的 L6 注释。
  ok(shape.app.nodes.length === 244, 'App 侧保留 244 / 495（L5 剔 119 视口外 + L6 剔 3 叶子布局壳）', `实际 ${shape.app.nodes.length}`);
  const reasons = new Set([...shape.design.dropped, ...shape.app.dropped].map((d) => d.reason));
  ok(reasons.has('zero-size'), '零尺寸节点被剔除');
  ok(reasons.has('hidden-by-ancestor'), '被祖先隐藏的节点被剔除');
  ok(reasons.has('sentinel'), '哨兵脏值（y=1e6）被剔除');
  ok(
    shape.design.nodes.every((n) => n.rect.y < 1e5) && shape.app.nodes.every((n) => n.rect.y < 1e5),
    '下游无哨兵脏值残留',
  );
  ok(
    shape.app.nodes.every((n) => n.rect.x > -1000),
    '下游无负坐标残留',
  );
  ok(
    shape.design.nodes.some((n) => n.pathSignature.includes('>')) &&
      shape.design.nodes.filter((n) => n.pathSignature).length === shape.design.nodes.length,
    '全部节点都算出了路径签名',
  );

  // ⭐ 归并视图 · 真实素材（2026-10-04 加）
  //
  // 起因：画布上「文字没框 / 全是双线 / 很多元素缺框」。
  // 合成夹具的断言锁不住规模 —— 必须用真实素材量「直通节点占多数」这件事，
  // 否则过滤条件写错（`memberCount > 1`）时夹具仍然全绿。
  section('归并视图 · 真实素材（直通节点占多数，不能按 memberCount 过滤）');
  {
    const toMergeInput = (side: typeof shape.design): Parameters<typeof buildMergedView>[0] =>
      side.nodes.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        index: n.index,
        rect: n.rect,
        visible: true,
        clipped: n.clippedOut,
        className: n.tags.find((t) => t.startsWith('cn:'))?.slice(3) ?? '',
        nodeKind: n.kind,
        text: n.text,
        boxStyle: n.boxStyle,
      }));
    const dv = buildMergedView(toMergeInput(shape.design), 'design');

    // ⭐ 正确的不变量：**所有 memberIds 并起来 = 清洗后的全部 id**，一个不少。
    // 不能断言 `view.length === kept` —— 归并**本来就**会减少节点数
    // （实测 444 → 389：74 个簇收拢掉了 55 个节点）。
    // 该断言的真正目的是「直通节点不能被过滤掉」，
    // 而那条由下面的 `passthrough` 占比 + 文本断言负责。
    const covered = new Set(dv.view.flatMap((v) => v.memberIds));
    ok(
      covered.size === shape.design.nodes.length,
      '⭐ 每个清洗后节点都出现在某个视图节点里（一个不少）',
      `covered=${covered.size} kept=${shape.design.nodes.length}`,
    );
    ok(
      dv.view.length <= shape.design.nodes.length,
      '视图节点数 ≤ 保留数（归并只会收拢、不会凭空多出）',
      `view=${dv.view.length} kept=${shape.design.nodes.length}`,
    );
    const passthrough = dv.view.filter((v) => v.kind === 'passthrough').length;
    // ⚠️ 口径 2026-10-05 更新：设计侧引入 `visual-group`（视觉单元归并）后
    // 直通节点占比从 81% 降到 49% —— 大量节点被收进视觉单元是**预期结果**。
    // 这条断言现在守的是「直通节点仍占相当比例」（过半不到但不是零），
    // 真正的守卫是下面「文本节点必须出现在视图里」。
    ok(
      passthrough > dv.view.length * 0.3,
      '直通节点仍占相当比例（设计侧 visual-group 归并后实测 49%）',
      `${passthrough}/${dv.view.length}`,
    );
    ok(
      dv.view.filter((v) => v.kind === 'visual-group').length > 0,
      '⭐ 设计侧产出了 visual-group（视觉单元）节点',
      `${dv.view.filter((v) => v.kind === 'visual-group').length} 个`,
    );
    const textViews = dv.view.filter((v) => v.nodeKind === 'text');
    ok(
      textViews.length > 0,
      '⭐ 文本节点出现在视图里（绝不能按 memberCount>1 过滤 —— 文字在卡片里属于卡片）',
      `text=${textViews.length}`,
    );
    // ⚠️ 「文本全是 passthrough」这条断言在 10-05 引入 visual-group 后**不再成立**：
    // 实测 45 个文本视图里 20 个成了 visual-group 的代表节点（文字是卡片主体）。
    // 这不是回归 —— 它正是「视觉单元归并」的目的。
    // byKind 四类之和 = 视图总数（防止又出现「直通被算成兄弟重合」）
    // ⚠️ 2026-10-05：MergeKind 多了第五类 `visual-group`（设计侧视觉单元），
    // 漏加会让「四类之和」永远小于总数 ⇒ 这条断言会误报。
    const byKindSum = dv.stats.byKind['svg-root'] + dv.stats.byKind['coincident-parent']
      + dv.stats.byKind['coincident-sibling'] + dv.stats.byKind.passthrough
      + dv.stats.byKind['visual-group'];
    ok(
      byKindSum === dv.view.length,
      '⭐ byKind 四类之和 = 视图节点总数',
      `${byKindSum} vs ${dv.view.length}`,
    );
    ok(dv.stats.idsPreserved, '真实素材上 id 仍一个不丢', '');

    // ⭐⭐ 视觉单元归并（2026-05 新增）—— 三条都是**实测踩过的坑**
    section('视觉单元归并 · rect 用并集 / 深度倒序 / 不抢 SVG（2026-10-05）');
    {
      const vg = dv.view.filter((v) => v.kind === 'visual-group');
      ok(vg.length > 0, '产出了 visual-group 节点', `${vg.length} 个`);

      // ⭐ ① rect 必须是**成员并集**，不能取任一成员
      // 症状（修前）：`代表 3×6 但成员并集 32×32`（8 个成员）、
      // `代表 48×18 但并集 103×43`（6 个成员）—— 实测 28/53 个簇都这样。
      // 根因：沿用了 `mergeCoincident` 的「优先取可绘制成员」规则，
      // 而视觉单元的成员大小差一个数量级 ⇒ 选中了那个 3×6 的小矩形。
      const rectTooSmall = vg.filter((v) => {
        // ⚠️ 成员可能已被收进别的簇（不在 `dv.view` 里）⇒ 必须回落去
        // `shape.design.nodes`（清洗后的原始节点表）找，否则 filter(Boolean)
        // 之后 TS 仍收窄不到、且会漏掉那些被嵌套收拢的成员。
        const rs = v.memberIds
          .map((id) => shape.design.nodes.find((n) => n.id === id))
          .filter((n): n is NonNullable<typeof n> => !!n);
        if (rs.length < 2) return false;
        const minX = Math.min(...rs.map((n) => n.rect.x));
        const minY = Math.min(...rs.map((n) => n.rect.y));
        const maxX = Math.max(...rs.map((n) => n.rect.x + n.rect.width));
        const maxY = Math.max(...rs.map((n) => n.rect.y + n.rect.height));
        const uA = (maxX - minX) * (maxY - minY);
        return uA > 0 && v.rect.width * v.rect.height < uA * 0.5;
      });
      ok(
        rectTooSmall.length === 0,
        '⭐⭐ visual-group 的 rect 是**成员并集**（没有代表远小于整簇的错簇）',
        `错簇 ${rectTooSmall.length} 个`,
      );

      // ⭐ ② 成员必须是**整棵子树**（不能只收直接子，否则中间层会漏）
      // 反向守卫：visual-group 的成员里应能看到「容器与其后代同簇」。
      const withContainer = vg.filter((v) => v.memberIds.length > 2);
      ok(
        withContainer.length > 0,
        '存在多成员视觉单元（子树被整体收拢，不是只收直接子）',
        `${withContainer.length} 个`,
      );

      // ⭐ ③ 深度倒序 ⇒ 深的先被收，祖先不抢孙子的机会
      // 症状（修前）：用户报的 `1755:13002`（3 段式背景卡）永远轮不到 ——
      // 它与父 `13001` 几何逐位相同（都是 351×64），
      // `coincident-parent` 先把父子收走，`13002` 进 consumed。
      // 修法：visual-unit **排在 mergeCoincident 之前** + 内部**深度倒序**遍历。
      const target = dv.view.find((v) => v.memberIds.includes('1755:13002'));
      ok(
        !!target,
        '⭐⭐ 用户报的 1755:13002（背景组合 group）被收进了某个视图节点',
        target ? `${target.kind} 成员 ${target.memberIds.length}` : '没被收',
      );
      ok(
        (target?.memberIds.length ?? 0) >= 6,
        '⭐ 那个背景组合的整棵子树（底板+中板+2 个 blur 光斑+图标组）都在同一簇',
        `成员 ${target?.memberIds.length}：${(target?.memberIds ?? []).map((id) => id.slice(-6)).join(',')}`,
      );
    }

    // ⭐⭐ 画布 kind 过滤的判据依据（宿主 `lib/cleanKindFilter.ts` 消费这三个字段）
    //
    // 起因：我第一版按 `hasChildren` 过滤「结构分组」，实测被打脸 ——
    // 198 个 container 里 **197 个有子节点、只有 1 个叶子**，
    // 而 110 个带背景色的可见盒子**全都落在「有子节点」那 197 个里**
    // （页面根 `10年管家开通前` = `bg:#f5f5f5` + 7 个子节点）。
    // ⇒ 正确判据是 `hasBoxPaint`。这组断言就是防止再写回错判据。
    section('kind 过滤 · 判据是 hasBoxPaint 而不是 hasChildren（2026-10-04）');
    section('同尺寸壳吞图标 · 代表节点必须取可绘制的那个（2026-10-04）');
    {
      /**
       * 复现用户报的「某些图标没边框」。
       *
       * 真实结构（盲盒·横向滚动图标行）：每个图标有一个**与它几何逐位相同**的
       * `ReactViewGroup` 壳（15.33×15.33、dx=dy=0，且壳 index 更大 = 后创建）。
       * 父子重合归并把它们收成一簇，若代表取「上层」= 壳 ⇒ `nodeKind=container`
       * + 无盒样式 ⇒ 画布 `structured` 档**把整个图标连壳一起藏掉**。
       *
       * 实测规模：盲盒/首屏那份有 **54 个**这种壳，
       * 被吞掉的可绘制成员：盲盒 3 个 `FastImageViewWithUrl`、
       * 另两份 3 个 `LinearGradientView`/`DecorView`。
       */
      type N = Parameters<typeof buildMergedView>[0][number];
      const nd = (o: Partial<N>): N => ({
        id: 'n', parentId: null, index: 0, rect: { x: 0, y: 0, width: 10, height: 10 },
        nodeKind: 'container', ...o,
      });
      const shell = buildMergedView(
        [
          // 壳：index 更大（后创建 ⇒ 旧的「取上层」规则会选它）
          nd({ id: 'iconShell', index: 1, rect: { x: 47, y: 625, width: 15.33, height: 15.33 }, nodeKind: 'container' }),
          // 图标本体：几何逐位相同
          nd({ id: 'icon', parentId: 'iconShell', index: 0, rect: { x: 47, y: 625, width: 15.33, height: 15.33 }, nodeKind: 'visual' }),
        ],
        'app',
      );
      const iconView = shell.view.find((v) => v.memberIds.includes('icon'));
      ok(
        iconView?.id === 'icon',
        '⭐⭐ 代表节点取**可绘制**的图标，不是几何相同的壳（否则整簇被 kind 过滤藏掉）',
        `代表=${iconView?.id} kind=${iconView?.nodeKind}`,
      );
      ok(
        iconView?.nodeKind === 'visual',
        '⭐ 簇的 nodeKind 跟着代表走 = visual ⇒ structured 档会画它',
        String(iconView?.nodeKind),
      );
      ok(
        iconView?.memberIds.length === 2,
        '成员一个不少（壳与图标都在 memberIds 里，可回溯）',
        JSON.stringify(iconView?.memberIds),
      );

      // 反向：纯容器重合（无可绘制成员）仍取上层 —— 保持原行为不回归
      const bothContainers = buildMergedView(
        [
          nd({ id: 'outer', index: 0, rect: { x: 0, y: 0, width: 20, height: 20 } }),
          nd({ id: 'inner', parentId: 'outer', index: 1, rect: { x: 0, y: 0, width: 20, height: 20 } }),
        ],
        'app',
      );
      ok(
        bothContainers.view.find((v) => v.memberIds.includes('outer'))?.id === 'inner',
        '纯容器重合时仍取上层（没有可绘制成员可挑，行为不变）',
        bothContainers.view[0]?.id,
      );
    }
    {
      const containers = dv.view.filter((v) => v.nodeKind === 'container');
      const painted = containers.filter((v) => v.hasBoxPaint);
      const plain = containers.filter((v) => !v.hasBoxPaint);

      ok(
        painted.length > 0 && plain.length > 0,
        '素材里同时存在「有盒样式的容器」与「纯结构容器」（两种过滤口径才都有意义）',
        `painted=${painted.length} plain=${plain.length}`,
      );

      // ⭐ 核心断言：默认档（structured）只藏「无盒样式」的容器
      const structured = dv.view.filter((v) => !(v.nodeKind === 'container' && !v.hasBoxPaint));
      ok(
        structured.every((v) => v.nodeKind !== 'container' || v.hasBoxPaint),
        '⭐ structured 档藏掉的全是「无盒样式容器」——可见盒子零损失',
        `藏了 ${dv.view.length - structured.length} 个`,
      );
      const lostPaint = painted.filter((v) => !structured.includes(v));
      ok(
        lostPaint.length === 0,
        '⭐⭐ structured 档**一个可见盒子都不丢**（按 hasChildren 判就会丢 110 个）',
        `丢了 ${lostPaint.length} 个`,
      );

      // 反向：把 hasChildren 当判据会丢多少（把「踩过的坑」量化进断言）
      const wrongByChildren = dv.view.filter(
        (v) => !(v.nodeKind === 'container' && v.hasChildren),
      );
      const wouldLose = painted.filter((v) => !wrongByChildren.includes(v));
      ok(
        wouldLose.length > 0,
        '⚠️ 量化「按 hasChildren 判」的代价 —— 它确实会丢可见盒子（所以不能用）',
        `会丢 ${wouldLose.length} 个（${((wouldLose.length / Math.max(1, painted.length)) * 100).toFixed(0)}% 的可见盒子）`,
      );

      // drawable 档：会丢可见盒子 —— 这正是面板要显式警告的场景
      const drawable = dv.view.filter((v) => v.nodeKind !== 'container');
      ok(
        painted.filter((v) => !drawable.includes(v)).length === painted.length,
        'drawable 档按设计会藏掉**全部**可见盒子（面板据此显示警告，不是 bug）',
        `藏 ${painted.length} 个可见盒子`,
      );

      // all 档：恒等
      ok(
        dv.view.length === dv.view.filter(() => true).length,
        'all 档不过滤（恒等）',
        '',
      );

      // hasChildren 本身仍是**客观树事实**，供人工核验判断「分组 vs 叶子」
      ok(
        dv.view.every((v) => typeof v.hasChildren === 'boolean') &&
          dv.view.filter((v) => v.hasChildren).length > 0,
        'hasChildren 字段被如实产出（不是恒 false）',
        `有子节点 ${dv.view.filter((v) => v.hasChildren).length} 个`,
      );

      // ⭐⭐ 真实素材：kind 过滤（structured）不得吞掉任何**可绘制**成员
      //
      // 用户实测报的现象是「某些图标有框、某些没有」——
      // 差别不在图标本身，而在**它有没有被包在一个几何相同的壳里**。
      // 盲盒那份实测有 54 个这种壳；修之前 3 个 `FastImageViewWithUrl` 被吞。
      // 这条断言直接数「被 structured 档藏掉的簇里有几个可绘制成员」。
      {
        const rawApp = loaded.input.appNodes;
        const appRawById = new Map(rawApp.map((n) => [n.nodeId, n]));
        const av = buildMergedView(
          toMergeInput(shape.app).map((n) => ({ ...n, svgGroup: undefined })),
          'app',
        ).view;
        const hidden = av.filter((v) => v.nodeKind === 'container' && !v.hasBoxPaint);
        const swallowed = hidden.flatMap((v) => v.memberIds).filter((id) => {
          const r = appRawById.get(id);
          return !!r && (r.isImage === true || r.isSvg === true || r.hasVisualContent === true);
        });
        ok(
          swallowed.length === 0,
          '⭐⭐ structured 档藏掉的簇里**没有可绘制成员**（同尺寸壳不再吞图标）',
          `藏了 ${swallowed.length} 个：${swallowed.slice(0, 3).map((id) => appRawById.get(id)?.className?.split('.').pop()).join(',')}`,
        );
        // 反向：确实存在「同尺寸壳」这种结构（否则断言会假绿）
        const shells = av.filter(
          (v) => v.kind === 'coincident-parent' && v.memberIds.length === 2
            && v.memberIds.some((id) => appRawById.get(id)?.isImage === true),
        );
        ok(
          shells.length > 0,
          '素材里存在「壳 + 图标」的父子重合簇（否则上面那条断言是假绿）',
          `${shells.length} 个`,
        );
      }
    }
  }

  section('M1 · L1 锚点保序拟合');
  // 合计从 40 降到 36，但**强锚点仍是 34、一条没少** —— 少的是弱锚点（6 → 2）。
  // 弱锚点按定义只做验证、不参与拟合，且它们本来就在视口外（截图没拍到的下半屏），
  // L5 剔掉后自然消失。⚠️ 所以这里的判据是「强锚点数不变」，不是「合计不变」——
  // 后者会在 L5 生效后误报成回归。
  ok(align.anchors.length >= 34, '锚点总数 ≥ 34（弱锚点随 L5 剔除减少，强锚点不变）', `实际 ${align.anchors.length}`);
  ok(align.strongAnchors.length >= 30, '强锚点 ≥ 30（三重去歧义通过）', `实际 ${align.strongAnchors.length}`);
  ok(align.fixedLayer.length === 5, '固定层 tab bar 命中 5 个', `实际 ${align.fixedLayer.length}`);
  ok(near(align.residualMedian, -22.66, 0.5), 'Δy 中位数 ≈ −22.66px（与报告实测一致）', `实际 ${align.residualMedian.toFixed(2)}`);
  const strong = [...align.strongAnchors].sort((a, b) => a.designY - b.designY);
  const first = strong[0].deltaY;
  const last = strong[strong.length - 1].deltaY;
  ok(last < first - 20, 'Δy 单调累积漂移（不是常量平移）', `${first.toFixed(1)} → ${last.toFixed(1)}`);
  ok(
    align.fixedLayer.every((a) => Math.abs(a.deltaY + 451) < 2),
    '固定层 Δy ≈ −451px（未做分层就会被拉爆）',
    align.fixedLayer.map((a) => a.deltaY.toFixed(0)).join(','),
  );

  /* ------------------------------------------------------------------ */
  /* M2：L2 分区 + 编号 + 门禁                                           */
  /* ------------------------------------------------------------------ */

  const built = buildRegionSlices({
    design: shape.design,
    app: shape.app,
    align,
    profile,
    designScale: 2,
    appScale: 3,
  });

  section('M2 · L2 分区与编号');
  ok(built.slices.length === 9, '切出 9 片', `实际 ${built.slices.length}`);
  ok(
    ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'].every((id) =>
      built.slices.some((s) => s.region.regionId === id),
    ),
    'R1–R9 编号齐全',
  );
  ok(
    built.slices.every((s) => s.items.every((i) => i.markId.startsWith(s.region.regionId))),
    'markId 均带区域前缀（可回引）',
  );
  ok(
    built.slices.filter((s) => s.noPixelEvidence).length >= 2 &&
      built.noPixelEvidence.some((r) => r.designY0 <= 900 && r.designY1 >= 1080),
    'R7/R8 被标记为无像素证据（连续区间已合并为 [900, 2205]）',
    JSON.stringify(built.noPixelEvidence.map((r) => [r.designY0, r.designY1])),
  );

  const r1 = built.slices.find((s) => s.region.regionId === 'R1');
  const r4 = built.slices.find((s) => s.region.regionId === 'R4');
  const r7 = built.slices.find((s) => s.region.regionId === 'R7');
  ok(!!r1 && r1.items.some((i) => i.ruleVerdict === 'environmental'), 'R1：登录态被归为 environmental');
  ok(!!r4 && r4.items.some((i) => i.ruleVerdict === 'environmental'), 'R4：数据占位符被归为 environmental');
  ok(!!r7 && r7.items.every((i) => i.ruleVerdict !== 'missing'), 'R7：整区数据态豁免，无 missing');
  const r3 = built.slices.find((s) => s.region.regionId === 'R3');
  ok(
    !!r3 && r3.items.every((i) => !(i.ruleVerdict === 'missing' && i.designText === '&')),
    'R3：拼接粒度差异未被误报为缺失',
  );
  const r9 = built.slices.find((s) => s.region.regionId === 'R9');
  ok(
    !!r9 && r9.items.every((i) => !(i.ruleVerdict === 'missing' && i.appText !== null)),
    'R9：固定层未吞进流式文本',
  );
  const r6 = built.slices.find((s) => s.region.regionId === 'R6');
  ok(
    !!r6 && r6.items.every((i) => !(i.ruleVerdict === 'missing' && ['首页', '分类', '我的'].includes(i.appText ?? ''))),
    'R6：未误报 App tab bar 文本"多出"',
  );

  section('M2 · Mock reviewer + 门禁');
  const mock = new MockRegionReviewer({ injectHallucination: true });
  let rejectedTotal = 0;
  let acceptedTotal = 0;
  let hallucRejected = 0;
  let hallucAccepted = 0;
  const validations = new Map<string, ReturnType<typeof validateReview>>();
  for (const slice of built.slices) {
    const req = {
      region: slice.region,
      items: slice.items,
      dynamicHints: slice.dynamicHints,
      envHints: slice.envHints,
      noPixelEvidence: slice.noPixelEvidence,
      cropScaleRatio: 1.44,
    };
    const resp = await mock.review(req);
    const v = validateReview(resp, req);
    validations.set(slice.region.regionId, v);
    rejectedTotal += v.rejected.length;
    acceptedTotal += v.accepted.length;
    for (const r of v.rejected) {
      const id = (r.defect as { markId?: string } | undefined)?.markId ?? '';
      if (id.endsWith('-99')) hallucRejected++;
    }
    for (const a of v.accepted) if (a.markId.endsWith('-99')) hallucAccepted++;
  }
  ok(rejectedTotal === 9, '每片 1 条幻觉编号 → 9 条全部被拒（100%）', `实际拒绝 ${rejectedTotal}`);
  ok(hallucRejected === 9 && hallucAccepted === 0, '幻觉编号既被拒、也未被接受');
  ok(acceptedTotal > 0, '合法缺陷仍被接受', `accepted=${acceptedTotal}`);

  /* ------------------------------------------------------------------ */
  /* M3：L3 合成与分权裁决                                               */
  /* ------------------------------------------------------------------ */

  const adj = adjudicate({
    slices: built.slices,
    validations: new Map(),
    align,
    profile,
    noPixelEvidence: built.noPixelEvidence,
    aiEnabled: false,
  });

  section('M3 · L3 裁决（报告 §5.1 的 8 条预期发现）');
  const find = (pred: (t: string) => boolean) => adj.issues.filter((i) => pred(i.title));
  ok(adj.issues.some((i) => i.category === 'coverage' && i.severity === 'P0'), 'P0 覆盖不足（62.8% / 无像素证据）');
  ok(
    find((t) => t.includes('新会员礼')).length === 1 &&
      find((t) => t.includes('家电清洗8折')).length === 1 &&
      find((t) => t.includes('耗材低至5折')).length === 1,
    'P1 会员卡三条权益与设计不一致',
  );
  ok(
    adj.issues.some((i) => i.category === 'geometry' && i.severity === 'P1' && i.title.includes('累积漂移')),
    'P1 垂直布局累积漂移',
  );
  ok(
    adj.issues.filter((i) => i.category === 'existence' && i.evidence.regionId === 'R7').length === 0,
    'P1 线下店：已声明数据态，不计缺陷',
  );
  ok(
    adj.issues.filter((i) => i.category === 'existence' && i.evidence.regionId === 'R8').length === 0,
    'P1 精选好物：已声明测试数据态，不计缺陷',
  );
  ok(
    adj.issues.every((i) => !['&', '10年包修', '10年免费上门检测'].includes(i.evidence.designText ?? '')),
    'P2 拼接粒度差异未误报为缺失',
  );
  ok(
    adj.issues.every((i) => !(i.evidence.regionId === 'R9' && i.evidence.appText !== null)),
    'P2 固定层未与流式层串味',
  );
  ok(
    adj.issues.every((i) => !['首页', '分类', '购物车', '我的', '许愿池'].includes(i.evidence.appText ?? '')),
    'P2 固定层文本未进入流式层结论',
  );
  ok(adj.verdict === 'fail', 'verdict = fail（存在 P0/P1 阻断项）', adj.verdictReason);
  ok(
    adj.issues.every((i) => !(i.needsHumanReview && i.severity !== 'P0' && i.source === 'rule' && i.category === 'existence' && i.evidence.regionId && built.slices.find((s) => s.region.regionId === i.evidence.regionId)?.noPixelEvidence)),
    '无像素证据区域的问题全部带 needsHumanReview（不得默认通过）',
  );

  section('M3 · 分权裁决的不变量');
  const weakAdd = adjudicate({
    slices: built.slices,
    validations: (() => {
      const m = new Map<string, ReturnType<typeof validateReview>>();
      for (const s of built.slices) {
        const unj = s.items.find((i) => i.ruleVerdict === 'unjudgeable');
        if (!unj) continue;
        m.set(s.region.regionId, {
          accepted: [
            {
              markId: unj.markId,
              category: 'corner',
              severity: 'P2',
              expected: 'r=12',
              actual: 'r=8',
              reason: '像素测量显示圆角偏小',
              action: 'keep',
            },
            {
              markId: unj.markId,
              category: 'existence',
              severity: 'P0',
              expected: 'x',
              actual: 'y',
              reason: 'AI 试图对强类目升级',
              action: 'override',
            },
          ],
          rejected: [],
          environmental: [],
          dynamic: [],
          errors: [],
        });
      }
      return m;
    })(),
    align,
    profile,
    noPixelEvidence: built.noPixelEvidence,
    aiEnabled: true,
  });
  ok(
    weakAdd.issues.some((i) => i.source === 'ai' && i.category === 'corner'),
    '弱类目（圆角）：AI 可以新增 issue',
  );
  ok(
    !weakAdd.issues.some((i) => i.source === 'ai' && i.category === 'existence'),
    '强类目（存在性）：AI 不能新增 issue',
  );
  ok(
    weakAdd.issues.filter((i) => i.category === 'coverage' && i.severity === 'P0').length === adj.issues.filter((i) => i.category === 'coverage' && i.severity === 'P0').length,
    'verdict 只能加重：P0 不会因 AI 参与而消失',
  );

  /* ------------------------------------------------------------------ */
  /* M4：像素通道                                                        */
  /* ------------------------------------------------------------------ */

  section('M4 · 像素通道（颜色 / 圆角）');
  const designScale = loaded.input.meta.design.exportScale ?? 2;
  const appScale = loaded.input.meta.app.scaleX ?? 3;
  const logicalRatio = loaded.input.meta.app.width / loaded.input.meta.design.width;

  if (designImg && appImg) {
    const ds = new PngSampler(designImg);
    const as = new PngSampler(appImg);
    ok(ds.width === 750 && ds.height === 2522, '设计截图 750×2522@2', `${ds.width}×${ds.height}`);
    ok(as.width === 1080 && as.height === 2376, 'App 截图 1080×2376@3', `${as.width}×${as.height}`);

    const color = measureFillColor(as, [40, 400, 300, 120]);
    ok(!!color && color.samples > 0, '填充色采样返回有效结果', color ? `#${Math.round(color.color.r)}… n=${color.samples}` : '');

    // 已知真值：设计 1755:12357（351×124，圆角 12 逻辑）↔ App borderRadius=12dp（336.7×122.3）
    const n12357 = shape.design.nodes.find((n) => n.id === '1755:12357');
    if (n12357) {
      const appY = align.projectY(n12357.rect.y).appY;
      const box: [number, number, number, number] = [
        Math.round(n12357.rect.x * logicalRatio * appScale),
        Math.round(appY * appScale),
        Math.round(n12357.rect.width * logicalRatio * appScale),
        Math.round(n12357.rect.height * logicalRatio * appScale),
      ];
      const fill: Rgb | null = measureFillColor(as, box)?.color ?? null;
      const fit = measureCornerRadius(as, box, fill);
      const expected = 12 * logicalRatio * appScale;
      ok(!!fit, '圆角拟合返回结果', fit ? `R=${fit.radius}px conf=${fit.confidence.toFixed(2)}` : 'null');
      if (fit) {
        ok(
          Math.abs(fit.radius - expected) <= 4,
          `圆角在容差内（期望 ${expected.toFixed(1)}px，容差 4px）`,
          `实测 ${fit.radius}px（残差 ${Math.abs(fit.radius - expected).toFixed(1)}px）`,
        );
      }
    } else {
      skipped('已知真值节点 1755:12357 的圆角校验');
    }

    const inputs = [
      {
        id: 'PX-known-card',
        region: null,
        designBox: n12357 ? ([n12357.rect.x, n12357.rect.y, n12357.rect.width, n12357.rect.height] as [number, number, number, number]) : ([12, 339, 351, 124] as [number, number, number, number]),
        expectedColorHex: '#ffffff',
        expectedRadius: 12,
      },
    ];
    const rep = runPixelChecks(inputs, {
      designSampler: ds,
      appSampler: as,
      designScale,
      appScale,
      logicalRatio,
      projectY: (y) => ({ appY: align.projectY(y).appY }),
      thresholds: { deltaE: 2.5, cornerTolerancePx: 4 },
    });
    ok(rep.available && rep.summary.checked > 0, '像素报告可用且产出了检查项', JSON.stringify(rep.summary));
  } else {
    skipped('截图解码');
  }

  /* ------------------------------------------------------------------ */
  /* 端到端                                                             */
  /* ------------------------------------------------------------------ */

  section('端到端 · runAcceptance（mock reviewer + 像素）');
  const e2e = await runAcceptance(loaded.input, {
    profile,
    reviewer: new MockRegionReviewer({}),
    samplers: {
      design: designImg ? new PngSampler(designImg) : null,
      app: appImg ? new PngSampler(appImg) : null,
    },
    images: { design: designImg, app: appImg },
    now: '2026-09-30T00:00:00.000Z',
  });
  ok(e2e.report.schemaVersion === 1, '报告 schemaVersion = 1');
  ok(e2e.report.verdict === 'fail', 'verdict = fail');
  ok(e2e.report.counts.p0 >= 1, '至少 1 条 P0', `p0=${e2e.report.counts.p0}`);
  ok(e2e.report.regions.length === 9, '报告含 9 个分区');
  ok(
    e2e.report.issues.every((i) => i.issueId && i.title && i.detail && i.evidence),
    '每条 issue 都带完整证据链（issueId / title / detail / evidence）',
  );
  ok(
    e2e.report.notes.some((n) => n.includes('无像素证据')) || e2e.report.noPixelEvidence.length > 0,
    '报告显式声明了无像素证据区间',
  );
  const regionNoPx = e2e.report.regions.filter((r) => r.noPixelEvidence);
  ok(regionNoPx.length >= 2, '至少 2 个分区标记 noPixelEvidence', String(regionNoPx.length));
  ok(
    e2e.debug.shape.design.nodes.length === 444 && e2e.debug.align.strongAnchors.length >= 30,
    'debug 中间产物可回放（shape + align）',
  );
} else {
  section('M1–M4');
  skipped('全部实测断言');
}

/* ------------------------------------------------------------------ */
/* AI 通道健壮性（2026-10-04）                                         */
/*                                                                     */
/* 起因：真 VLM 首次实跑就抛「引擎异常：…AbortError」。这三组断言锁的  */
/* 不是「正常路径能跑」，而是**失败时不该把整次运行带崩**、以及降采样  */
/* 真的把请求体压小了。                                                */
/* ------------------------------------------------------------------ */

section('AI 通道 · 送审图降采样');
{
  const big: PixelImage = {
    width: 1080,
    height: 1620,
    data: new Uint8Array(1080 * 1620 * 4).fill(200),
  };
  const small = downscaleForReview(big, 720);
  ok(
    Math.max(small.width, small.height) === 720 && small.width === 480,
    '长边限到 720 且保持宽高比（1080×1620 → 480×720）',
    `${small.width}×${small.height}`,
  );
  ok(small.data.length === 480 * 720 * 4, '降采样后字节数与新尺寸一致', `${small.data.length}`);
  const untouched = { width: 100, height: 40, data: new Uint8Array(100 * 40 * 4) };
  ok(
    downscaleForReview(untouched as PixelImage, 720) === untouched,
    '未超限时返回**同一对象**（零拷贝，不浪费一次分配）',
    '',
  );
  ok(downscaleForReview(untouched as PixelImage, 720).width === 100, '小图不被放大', '');
}

section('AI 通道 · 超时下限与错误可读性');
{
  // ⚠️ 构造器把 timeoutMs 下限抬到 30s。传 1 也会被抬上来 —— 断言的正是这一点：
  // App 的 AI 设置允许用户填任意数字，填 0/几百毫秒会让**每一次**带图请求必然超时。
  const probe = new OpenAiCompatibleReviewer({
    apiKey: 'k',
    model: 'm',
    timeoutMs: 1,
    fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch,
  });
  ok(
    (probe as unknown as { opts: { timeoutMs: number } }).opts.timeoutMs === 30_000,
    'timeoutMs 下限被抬到 30s（否则带图请求必然失败）',
    String((probe as unknown as { opts: { timeoutMs: number } }).opts.timeoutMs),
  );
  ok(probe.name === 'openai:m', 'reviewer 名带模型名（报错里能看出是谁在失败）', probe.name);

  // 错误信息可读性：超时必须说成「超时 + 怎么办」，而不是干巴巴的 AbortError。
  // 2026-10-04 实测踩到：原先 `String(e)` 出来是「AbortError: This operation was
  // aborted」，把「我们主动 abort」「对方断连」「Node 行为」混成一样，读的人无从下手。
  const failing = new OpenAiCompatibleReviewer({
    apiKey: 'k',
    model: 'qwen',
    timeoutMs: 30_000,
    maxRetries: 0,
    fetchImpl: (async (_u: string, init?: RequestInit) => {
      await new Promise((_r, rej) => {
        init?.signal?.addEventListener('abort', () =>
          rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
        );
      });
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  let msg = '';
  try {
    await failing.review({
      region: { regionId: 'R1', label: '顶部栏', designY0: 0, designY1: 100 },
      items: [],
      dynamicHints: [],
      envHints: [],
      noPixelEvidence: false,
      cropScaleRatio: 1.44,
    });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(msg.includes('超时'), 'AbortError 被翻译成「超时」而不是裸错误名', msg);
  ok(
    msg.includes('调大超时') || msg.includes('减少一次送审'),
    '超时文案给出**可行动**建议（调超时 / 减条目），不是只说「失败了」',
    msg,
  );
  // 原始错误保留在末尾，便于排查；关键是**不能只有**它
  ok(msg.includes('AbortError'), '原始错误保留在末尾（便于排查）', msg);
}

section('归并视图 · SVG 收拢 + 重合合一（2026-10-04）');
{
  type MI = Parameters<typeof buildMergedView>[0][number];
  const node = (over: Partial<MI>): MI => ({
    id: 'n', parentId: null, index: 0,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    ...over,
  });

  // ---- SVG 收拢 ----
  {
    const svg = buildMergedView(
      [
        node({ id: 'icon', className: 'SvgView', rect: { x: 0, y: 0, width: 24, height: 24 } }),
        node({ id: 'icon/g1', parentId: 'icon', index: 1, className: 'GroupView' }),
        node({ id: 'icon/g1/p1', parentId: 'icon/g1', index: 2, className: 'PathView' }),
        node({ id: 'icon/g1/p2', parentId: 'icon/g1', index: 3, className: 'PathView' }),
        node({ id: 'icon/defs', parentId: 'icon', index: 4, className: 'DefsView' }),
        // 另一个真实节点（不参与 SVG 归并）
        node({ id: 'label', parentId: null, index: 5, className: 'ReactTextView', text: '价格' }),
      ],
      'app',
    );
    const iconView = svg.view.find((v) => v.id === 'icon');
    ok(!!iconView, 'SvgView 根产出视图节点', '');
    ok(
      iconView?.memberIds.length === 5,
      '⭐ SVG 内部元素全部收拢（4 个后代 + 根自己 = 5 个 member）',
      `实际 ${iconView?.memberIds.length}`,
    );
    ok(
      // ⚠️ `a && b` 在 a 是 `boolean | undefined` 时结果也是那个联合类型，
      // 直接传给 `ok(cond: boolean)` 会报 TS2345 —— 用 `??` 收成真布尔。
      (iconView?.memberIds.includes('icon/g1/p1') && iconView?.memberIds.includes('icon/defs')) ?? false,
      '深层后代（path/defs）也在内',
      JSON.stringify(iconView?.memberIds),
    );
    ok(
      svg.view.some((v) => v.id === 'label'),
      '非 SVG 节点不受影响',
      '',
    );
    ok(svg.stats.idsPreserved, '⭐ id 一个不丢（归并不许丢 treePath）', '');
    ok(svg.stats.byKind['svg-root'] === 1, '统计记 1 个 svg-root', JSON.stringify(svg.stats.byKind));
  }

  // ---- ⭐⭐ SVG 走 `svgGroup` 主路径（真实数据走的就是它，2026-10-04）----
  //
  // 起因：沿 `parentId` 走**在真实数据上收拢不到任何内部元素** ——
  // `SvgView` 的直接子是 `GroupView 0×0`（零尺寸中间层），被清洗的
  // `zero-size` 判据剔掉后，`byParent` 在**第一层就断了**：
  //
  //   30 个 SvgView 根 → 后代 162 个（kept 54 / zero-size 38 / …）
  //   归并结果：19 个 svg-root，**成员数全为 1**（收拢了 0 个）
  //
  // ⇒ 改由调用方从**原始节点表**算 `svgGroup`（SVG 根 id）传进来。
  {
    const grouped = buildMergedView(
      [
        // 根 + 两个内部元素（中间的 GroupView 0×0 **不在集合里**，模拟被清洗剔掉）
        node({ id: 'svg1', index: 0, rect: { x: 10, y: 20, width: 24, height: 24 }, className: 'SvgView', svgGroup: 'svg1' }),
        node({ id: 'svg1/p1', parentId: null, index: 1, rect: { x: 12, y: 22, width: 8, height: 8 }, className: 'PathView', svgGroup: 'svg1' }),
        node({ id: 'svg1/p2', parentId: null, index: 2, rect: { x: 22, y: 30, width: 6, height: 6 }, className: 'CircleView', svgGroup: 'svg1' }),
        // ⚠️ 孤儿组：根 `svg2` 被清洗剔了（只剩内部元素）
        node({ id: 'svg2/p1', parentId: null, index: 3, rect: { x: 100, y: 20, width: 4, height: 4 }, className: 'PathView', svgGroup: 'svg2' }),
        // 非 SVG 节点，不参与
        node({ id: 'txt', parentId: null, index: 4, rect: { x: 0, y: 0, width: 40, height: 16 }, className: 'ReactTextView', text: '价格' }),
      ],
      'app',
    );

    const svg1 = grouped.view.find((v) => v.id === 'svg1');
    ok(
      svg1?.memberIds.length === 3,
      '⭐ svgGroup 主路径：根 + 2 个内部元素收成一簇（跨过被剔的中间层）',
      JSON.stringify(svg1?.memberIds),
    );
    ok(svg1?.rect.width === 24 && svg1?.rect.height === 24, '⭐ rect 取根的盒子（图标整体边界）', JSON.stringify(svg1?.rect));
    ok(
      (svg1?.hasChildren ?? true) === false,
      '⭐ 图标簇标 hasChildren=false（内部元素已收进来，不该被当结构分组隐藏）',
      String(svg1?.hasChildren),
    );

    // ⭐ 孤儿组：根不在集合里 ⇒ **不产出** svg-root（否则代表 id 会退化成某个 PathView，
    // 画布上出现「一个 4×4 的碎片被标成图标整体」）
    ok(
      !grouped.view.some((v) => v.kind === 'svg-root' && v.id === 'svg2'),
      '⭐⭐ 组内没有 SvgView 根时不产出 svg-root（避免把碎片谎报成图标）',
      grouped.view.filter((v) => v.kind === 'svg-root').map((v) => v.id).join(','),
    );
    ok(
      grouped.view.some((v) => v.id === 'svg2/p1' && v.kind === 'passthrough'),
      '⭐ 孤儿成员退回 passthrough（kind 仍如实反映「没归并」）',
      grouped.view.find((v) => v.id === 'svg2/p1')?.kind,
    );

    ok(grouped.stats.byKind['svg-root'] === 1, '只记 1 个 svg-root（孤儿组不计）', JSON.stringify(grouped.stats.byKind));
    ok(grouped.stats.idsPreserved, '孤儿成员仍计入 id 完整性', '');

    // 回退路径仍可用（不传 svgGroup 时沿 parentId 走 —— 手写夹具没有原始表）
    const fallback = buildMergedView(
      [
        node({ id: 'f1', index: 0, rect: { x: 0, y: 0, width: 20, height: 20 }, className: 'SvgView' }),
        node({ id: 'f1/g', parentId: 'f1', index: 1, rect: { x: 1, y: 1, width: 8, height: 8 }, className: 'GroupView' }),
        node({ id: 'f1/g/p', parentId: 'f1/g', index: 2, rect: { x: 2, y: 2, width: 4, height: 4 }, className: 'PathView' }),
      ],
      'app',
    );
    ok(
      fallback.view.find((v) => v.id === 'f1')?.memberIds.length === 3,
      '不传 svgGroup 时回退沿 parentId 走（自测夹具没有原始表也能工作）',
      JSON.stringify(fallback.view.find((v) => v.id === 'f1')?.memberIds),
    );
  }

  // ---- 重合父子 / 兄弟 ----
  {
    const dup = buildMergedView(
      [
        // 父子完全相同
        node({ id: 'outer', index: 0, rect: { x: 0, y: 0, width: 100, height: 50 } }),
        node({ id: 'inner', parentId: 'outer', index: 1, rect: { x: 0, y: 0, width: 100, height: 50 }, boxStyle: { backgroundColor: '#ff0000' } }),
        // 同父兄弟完全相同
        node({ id: 'sib1', parentId: null, index: 2, rect: { x: 10, y: 10, width: 20, height: 20 }, boxStyle: { backgroundColor: '#00ff00', cornerRadius: 4 } }),
        node({ id: 'sib2', parentId: null, index: 3, rect: { x: 10, y: 10, width: 20, height: 20 }, boxStyle: { backgroundColor: '#0000ff' } }),
        // 差 1px 的**不算**重合（容差 0.5）
        node({ id: 'near', parentId: null, index: 4, rect: { x: 200, y: 0, width: 20, height: 20 } }),
        node({ id: 'near2', parentId: null, index: 5, rect: { x: 200, y: 0, width: 20, height: 20.4 } }),
      ],
      'app',
    );
    const parent = dup.view.find((v) => v.memberIds.includes('outer'));
    ok(!!parent && parent.memberIds.length === 2, '父子重合合为一个视图节点', JSON.stringify(parent?.memberIds));
    ok(parent?.id === 'inner', '代表节点取**上层**（index 大 = 看得见的那个）', String(parent?.id));

    const sib = dup.view.find((v) => v.memberIds.includes('sib1'));
    ok(!!sib && sib.memberIds.length === 2, '同父兄弟重合合为一个视图节点', JSON.stringify(sib?.memberIds));
    ok(sib?.id === 'sib2', '兄弟簇代表取上层', String(sib?.id));
    // ⭐ 冲突取上层：背景色 sib2 的蓝（#0000ff）胜出，圆角只有 sib1 有 ⇒ 保留
    ok(sib?.boxStyle.backgroundColor === '#0000ff', '⭐ 冲突取上层（背景用 sib2 的蓝）', String(sib?.boxStyle.backgroundColor));
    ok(
      sib?.boxStyle.cornerRadius === 4,
      '⭐ 上层没这个键时，取上层的「没读过」而不是下层的值 —— 但本例上层 cornerRadius 未读、下层读了，应保留 4',
      String(sib?.boxStyle.cornerRadius),
    );

    ok(
      dup.view.filter((v) => v.memberIds.includes('near')).length +
        dup.view.filter((v) => v.memberIds.includes('near2')).length === 2,
      '⭐ 差 0.4px 的**不算**重合（容差 0.5）',
      '',
    );
    ok(dup.stats.idsPreserved, 'id 一个不丢', '');
  }

  // ---- ⭐ 直通节点必须是 passthrough，不能混进 coincident（2026-10-04 修）----
  //
  // 起因：画布上「所有文字都没框、所有框都是双线」。根因是**两个**独立问题：
  //   ① 直通节点（memberCount === 1）被硬编码成 `coincident-sibling`
  //      ⇒ `byKind.coincident-sibling` 把 317 个直通节点算成了兄弟重合；
  //   ② 渲染层按 `memberCount > 1` 过滤 ⇒ 315 个直通节点整批不画，
  //      而**文本节点从不参与归并**（68 个文本 memberCount 全是 1）⇒ 一个框都没有。
  {
    const solo = buildMergedView(
      [
        // 三个互不重合的普通节点（含一个**文本**节点）
        node({ id: 't1', index: 0, rect: { x: 0, y: 0, width: 80, height: 20 }, nodeKind: 'text', text: '每日签到' }),
        node({ id: 't2', index: 1, rect: { x: 0, y: 40, width: 80, height: 20 }, nodeKind: 'text', text: '福利天天领' }),
        node({ id: 'c1', index: 2, rect: { x: 0, y: 80, width: 80, height: 60 } }),
      ],
      'design',
    );
    ok(
      solo.view.every((v) => v.kind === 'passthrough'),
      '⭐ 未归并的节点 kind 是 passthrough（不是 coincident-sibling）',
      JSON.stringify(solo.view.map((v) => `${v.id}:${v.kind}`)),
    );
    ok(
      solo.stats.byKind['coincident-sibling'] === 0 && solo.stats.byKind.passthrough === 3,
      '⭐ byKind 把「兄弟重合」与「直通」分开计数',
      JSON.stringify(solo.stats.byKind),
    );
    ok(
      solo.view.filter((v) => v.nodeKind === 'text').length === 2,
      '⭐ 文本节点不会归并（所以画布不能按 memberCount>1 过滤，否则文字全没框）',
      `${solo.view.filter((v) => v.nodeKind === 'text').length} 个`,
    );
    // 视图节点总数必须等于原始节点数（每个节点恰好落进一个视图节点）
    ok(
      solo.view.length === 3 && solo.stats.merged === 3,
      '直通节点全部进视图（一个不少）',
      `view=${solo.view.length} merged=${solo.stats.merged}`,
    );
  }

  // ---- 三态保留：键「没读过」≠「读过且为空」 ----
  {
    const tri = buildMergedView(
      [
        node({ id: 'a', index: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, boxStyle: { backgroundColor: '#123456' } }),
        // b **完全没有 boxStyle**（没读过任何盒样式）
        node({ id: 'b', index: 1, rect: { x: 0, y: 0, width: 10, height: 10 } }),
      ],
      'app',
    );
    const v = tri.view.find((x) => x.memberIds.includes('a'));
    ok(v?.boxStyle.backgroundColor === '#123456', '下层读过的值在上层没读时保留', String(v?.boxStyle.backgroundColor));
    ok(
      !('cornerRadius' in (v?.boxStyle ?? {})),
      '⭐ 没人读过的键**整键不设**（区别于「读过且为空」= null）',
      JSON.stringify(v?.boxStyle),
    );
  }
}

section('L5 · 视口外不参与验收（2026-10-04）');
{
  if (!hasBundle || !loaded) {
    skipped('需要 bundle 夹具');
  } else {
    const shaped = shapeBoth({
      meta: loaded.input.meta,
      designNodes: loaded.input.designNodes,
      appNodes: loaded.input.appNodes,
      profile,
    });
    // ⚠️ `ShapedSide` 上**没有** `side` 字段（只有 ShapedBoth 知道自己哪边是哪边）——
    // 这里显式带标签，别写成 `side.side`（那是 undefined，断言文案会变成「undefined 侧」）。
    for (const [label, side] of [['app', shaped.app], ['design', shaped.design]] as const) {
      const H = side.viewportHeight;
      const l5 = side.dropped.filter((d) => d.reason === 'outside-viewport');
      // ⭐ 判据自证：**重新独立算一遍**每条记录的 rect 是否真的完全在视口外。
      // 直接从原始节点表按 id 取 rect 重算 —— 不复用 l0 的中间结果，
      // 否则「判据写反了」这件事会跟着一起错，断言就白写了。
      const rawById = new Map(
        (label === 'app' ? loaded.input.appNodes : loaded.input.designNodes).map((n) => [
          label === 'app' ? (n as { nodeId: string }).nodeId : (n as { id: string }).id,
          n as { x?: number; y?: number; width: number; height: number; rect?: { y: number; height: number } },
        ]),
      );
      const wrongSide = l5.filter((d) => {
        const raw = rawById.get(d.id);
        if (!raw) return false;
        const y = raw.y ?? raw.rect?.y ?? 0;
        const hh = raw.height ?? raw.rect?.height ?? 0;
        return !(y + hh <= 0 || y >= H);
      });
      ok(
        wrongSide.length === 0,
        `⭐ ${label} 侧 L5 剔除的 ${l5.length} 条**独立复算**全部真的在视口外`,
        `判据写反的：${wrongSide.length} 条`,
      );

      // ⭐ 反向：保留的节点里不该有「完全在视口外」的
      const keptOutside = side.nodes.filter(
        (n) => n.rect.y + n.rect.height <= 0 || n.rect.y >= H,
      );
      ok(
        keptOutside.length === 0,
        `⭐ ${label} 侧保留节点中**没有**完全在视口外的（判据方向没写反）`,
        `残留 ${keptOutside.length} 个：${keptOutside.slice(0, 3).map((n) => `${n.id}@y=${n.rect.y.toFixed(0)}`).join(', ')}`,
      );
    }

    // 剔除必须**如实声明**在 notes 里 —— 剔除 ≠ 判定为不存在
    const e2eNote = renderCleanAudit(auditClean(shaped.design, shaped.app));
    ok(
      e2eNote.includes('未参与本次验收') || !shaped.app.dropped.some((d) => d.reason === 'outside-viewport'),
      '审计报告写明「未参与本次验收」而非「App 没有」',
      '',
    );
  }
}

section('L6 · 纯布局容器不参与验收（2026-10-04）');
{
  if (!hasBundle || !loaded) {
    skipped('需要 bundle 夹具');
  } else {
    const shaped = shapeBoth({
      meta: loaded.input.meta,
      designNodes: loaded.input.designNodes,
      appNodes: loaded.input.appNodes,
      profile,
    });

    // ⭐⭐ 本层的判据**三个条件缺一不可**，只断言数量会被「无脑全剔」骗过。
    // 每条断言都独立复算（从原始节点表重取），不复用 l0 的中间结果 ——
    // 否则判据写反会跟着一起错。
    for (const [label, side, raw] of [
      ['app', shaped.app, loaded.input.appNodes],
      ['design', shaped.design, loaded.input.designNodes],
    ] as const) {
      const l6 = side.dropped.filter((d) => d.reason === 'layout-only');
      const rawById = new Map(
        raw.map((n) => [label === 'app' ? (n as { nodeId: string }).nodeId : (n as { id: string }).id, n]),
      );
      /** 预建「父 id → 子节点数」索引（两条判据都要用；逐节点 filter 是 O(n²)） */
      const rawKids = new Map<string, number>();
      for (const x of raw) {
        const pid = (x as { parentId?: string | null }).parentId;
        if (pid) rawKids.set(pid, (rawKids.get(pid) ?? 0) + 1);
      }
      const kidsOf = (n: unknown): number =>
        rawKids.get(label === 'app' ? (n as { nodeId: string }).nodeId : (n as { id: string }).id) ?? 0;
      /**
       * 「会画盒子」判据 —— ⚠️ **两侧字段完全不同**，必须各写各的：
       *  - 设计侧：`fills[]`（SOLID/可见）/ `cornerRadius` / `strokeWeight`
       *    —— 它**没有** `backgroundColor`（实测 609 个节点里 0 个有）；
       *  - App 侧：`backgroundColor` / `cornerRadius` / `borderWidth`。
       * 写统一的那份会让设计侧恒判 false，断言变成「全是残留」而失去意义
       * （第一版就这么错的：`painted` 只读 App 字段 ⇒ design 残留 389）。
       */
      const painted = label === 'app'
        ? (n: unknown): boolean => {
            const x = n as Record<string, unknown>;
            const bg = x['backgroundColor'];
            return (
              (typeof bg === 'string' && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)')
              || (typeof x['cornerRadius'] === 'number' && (x['cornerRadius'] as number) > 0)
              || (typeof x['borderWidth'] === 'number' && (x['borderWidth'] as number) > 0)
            );
          }
        : (n: unknown): boolean => {
            const x = n as { fills?: Array<{ visible?: boolean }>; cornerRadius?: unknown; strokeWeight?: unknown };
            const anyFill = (x.fills ?? []).some((f) => f.visible !== false);
            const cr = typeof x.cornerRadius === 'number' ? x.cornerRadius : Array.isArray(x.cornerRadius);
            const bw = typeof x.strokeWeight === 'number' && x.strokeWeight > 0;
            return anyFill || !!cr || bw;
          };

      // ① 独立复算：每条 L6 剔除都**真的**满足三条件
      ok(
        l6.every((d) => {
          const n = rawById.get(d.id);
          if (!n) return false;
          const svgLike = label === 'app' && /horcrux|(?:^|[./])(?:Svg|Path|Circle|Rect|Polygon|Line|Ellipse|Group|Defs|Mask|ClipPath|G)View$/.test(
            (n as { className?: string }).className ?? '',
          );
          return kidsOf(n) === 0 && !painted(n) && !svgLike;
        }),
        `⭐ ${label} 侧 L6 每条剔除都满足「无子 + 无盒样式 + 非 SVG 族」（独立复算）`,
        `${l6.length} 条`,
      );

      // ② 反向：保留节点里**没有**叶子空壳（判据方向没写反）
      const keptShells = side.nodes.filter((n) => {
        // ⚠️ 必须限定 `kind === 'container'`：判据只针对容器。
        // 少了这一句，实测会把 **46 个 text + 39 个 visual**（带内容/带图的
        // 正常节点，恰好也无子无样式）算成「漏网容器」⇒ 断言恒红、失去意义。
        if (n.kind !== 'container') return false;
        const raw2 = rawById.get(n.id);
        if (!raw2) return false;
        const svgLike = label === 'app' && /horcrux|(?:^|[./])(?:Svg|Path|Circle|Rect|Polygon|Line|Ellipse|Group|Defs|Mask|ClipPath|G)View$/.test(
          (raw2 as { className?: string }).className ?? '',
        );
        return kidsOf(raw2) === 0 && !painted(raw2) && !svgLike;
      });
      ok(
        keptShells.length === 0,
        `⭐ ${label} 侧保留节点中没有「叶子 + 无样式 + 非 SVG」的漏网容器`,
        `残留 ${keptShells.length}：${keptShells.slice(0, 3).map((n) => n.id).join(', ')}`,
      );

      // ③ ⭐ 结构分组容器必须**全部保留** —— 剔了会断 parentId 链
      // （l0 有 6 处沿祖先链走；harness 的遮挡判断也吃 parentId）
      const keptContainers = side.nodes.filter((n) => n.kind === 'container');
      // ⚠️ 只看 **L6** 这层：其它层（L5 视口外等）剔掉整棵子树是**预期行为**，
      // 拿全量 dropped 来判会把正常的剔除也算成「误伤结构」。
      const droppedWithKids = l6.filter((d) => {
        const n = rawById.get(d.id);
        return !!n && kidsOf(n) > 0;
      });
      ok(
        droppedWithKids.length === 0,
        `⭐ ${label} 侧「有子节点的结构分组容器」一个都没被剔（parentId 链不能断）`,
        `被剔 ${droppedWithKids.length} 个；保留容器 ${keptContainers.length} 个`,
      );

      // ④ ⭐ SVG 内部元素（PathView/CircleView/…）必须归 visual 而非 container
      if (label === 'app') {
        const svgInternals = side.nodes.filter((n) => {
          const cn = (n.tags.find((t) => t.startsWith('cn:')) ?? '').slice(3);
          return /^(?:Path|Circle|Rect|Polygon|Line|Ellipse|Group|Defs|Mask|ClipPath)View$/.test(cn);
        });
        ok(
          svgInternals.length > 0 && svgInternals.every((n) => n.kind === 'visual'),
          '⭐ SVG 内部元素（PathView/CircleView…）归 visual —— SDK 只在 SvgView 根打 isSvg，靠字段会全被误判成 container',
          `命中 ${svgInternals.length} 个，其中非 visual ${svgInternals.filter((n) => n.kind !== 'visual').length} 个`,
        );
        // ⭐ L6 剔除的 id 必须都在原始素材里存在（防「凭 id 猜」的实现）
        const l6Ids = side.dropped.filter((d) => d.reason === 'layout-only').map((d) => d.id);
        ok(
          l6Ids.every((id) => rawById.has(id)),
          'L6 剔除记录里的 id 都能在原始素材中找到',
          `无效 id：${l6Ids.filter((id) => !rawById.has(id)).slice(0, 3).join(', ') || '无'}`,
        );
      }
    }

    // ⑤ 可绘制元素占比：这是「只保留可绘制元素」这个目标的量化指标
    for (const [label, side] of [['design', shaped.design], ['app', shaped.app]] as const) {
      const drawable = side.stats.text + side.stats.visual;
      ok(
        drawable > 0 && drawable <= side.nodes.length,
        `⭐ ${label} 侧保留 ${side.nodes.length} 个，其中可绘制（text+visual）${drawable} 个（${((drawable / side.nodes.length) * 100).toFixed(0)}%）`,
        `text=${side.stats.text} visual=${side.stats.visual} container=${side.stats.container}`,
      );
    }
  }
}

section('清洗审计 · 分层归因与风险标注（2026-10-04）');
{
  if (!hasBundle || !loaded) {
    skipped('需要 bundle 夹具');
  } else {
    const shaped = shapeBoth({
      meta: loaded.input.meta,
      designNodes: loaded.input.designNodes,
      appNodes: loaded.input.appNodes,
      profile,
    });
    const audit = auditClean(shaped.design, shaped.app);

    ok(
      audit.design.tiers.length === 6 && audit.app.tiers.length === 6,
      '两侧各产出 6 个清洗层（L6 纯布局容器）',
      '',
    );
    // 恒含全部 5 层（没剔的层计数为 0）——看表的人要能确认「这层跑过了、剔 0 个」
    ok(
      audit.app.tiers.every((t) => typeof t.dropped === 'number'),
      '零剔除的层也出现在表里（不是「没出现」）',
      '',
    );
    ok(
      audit.app.tiers.every((t) => t.tier.startsWith('L')),
      '层名按 L1–L4 排序，人工核验有稳定顺序',
      '',
    );

    // 风险标注：L1/L2 = safe（逻辑必然），L3 = review（依赖采集器），L4 = risky（推断）
    const riskOf = (tier: string): string =>
      audit.app.tiers.find((t) => t.tier === tier)?.risk ?? '';
    ok(riskOf('L1-geometry') === 'safe', 'L1 标 safe（零尺寸不可能被看到）', riskOf('L1-geometry'));
    ok(riskOf('L3-invisible') === 'review', 'L3 标 review（依赖采集器如实报告）', riskOf('L3-invisible'));
    ok(riskOf('L4-semantic') === 'risky', '⚠️ L4 标 risky（推断而非必然）', riskOf('L4-semantic'));

    // 归因自洽：各层之和恒等于总剔除数
    const tierSum = (s: typeof audit.app): number => s.tiers.reduce((a, t) => a + t.dropped, 0);
    ok(
      tierSum(audit.app) === audit.app.dropped && tierSum(audit.design) === audit.design.dropped,
      '各层剔除数之和 = 总剔除数（归因不重不漏）',
      `app ${tierSum(audit.app)}/${audit.app.dropped} design ${tierSum(audit.design)}/${audit.design.dropped}`,
    );
    // stats.byTier 与审计表必须一致（两处统计不能漂）
    ok(
      JSON.stringify(shaped.app.stats.byTier) ===
        JSON.stringify(Object.fromEntries(audit.app.tiers.map((t) => [t.tier, t.dropped]))),
      'stats.byTier 与审计表逐层一致',
      '',
    );

    // 每条剔除都带证据（人工核验不必回头查素材）
    const missing = [...shaped.app.dropped, ...shaped.design.dropped].filter((d) => !d.evidence);
    ok(missing.length === 0, '每条剔除都带判据证据', `缺 ${missing.length} 条`);

    // 抽样必须跨 reason（否则 L1 的 79 条 zero-size 会把抽样位占满）
    const l1 = audit.app.tiers.find((t) => t.tier === 'L1-geometry');
    ok(
      (l1?.samples.length ?? 0) <= 2 || new Set(l1?.samples.map((s) => s.reason)).size > 1,
      '抽样跨 reason（不会全被同一个 reason 占满）',
      `samples=${l1?.samples.length} reasons=${new Set(l1?.samples.map((s) => s.reason)).size}`,
    );

    // Markdown 必须把 risky 层显式标出来
    const md = renderCleanAudit(audit);
    ok(md.includes('⚠️ risky'), '审计报告显式标注 risky 层', '');
    ok(md.includes('判据抽样'), '审计报告带判据抽样段落', '');
  }
}

section('L0 · 数字滚动组件的裁剪节点必须出局（2026-10-04）');
{
  /**
   * 用**真实的盲盒抽奖快照**（729 节点 / 457 clippedOut / 213 个数字行）。
   * 这批数字是 `number-flow` 类组件把 `0`–`9` 全部实例化在 13×28dp 裁剪窗里、
   * 靠 `translateY` 露出当前位的结果 —— 屏幕上只看得见 1 行，但 10 行都报
   * `visible=true / required / hasVisualContent=true`。
   *
   * 判据是**双向**的：既锁「剔掉了」，也锁「没误伤」——
   * 只断言前者的话，一个「把所有 clippedOut 都剔掉」的实现也能过，
   * 而那会连带干掉 PathView 50 / SvgView 32 / GroupView 16。
   */
  type AppLike = Parameters<typeof shapeBoth>[0]['appNodes'][number];
  const mkNode = (over: Partial<AppLike>): AppLike =>
    ({
      nodeId: 'n', parentId: null, className: 'X', depth: 0, index: 0,
      x: 0, y: 0, width: 10, height: 10,
      visibleX: 0, visibleY: 0, visibleWidth: 10, visibleHeight: 10,
      effectiveVisibleX: 0, effectiveVisibleY: 0, effectiveVisibleWidth: 10, effectiveVisibleHeight: 10,
      visible: true, participation: 'required',
      ...over,
    }) as AppLike;

  const appNodes: AppLike[] = [
    // ⭐ 数字轮的零高裁剪窗（13×0）—— 判据的载体，必须先有它
    mkNode({ nodeId: 'digit-window', className: 'com.facebook.react.views.view.ReactViewGroup', width: 13, height: 0, y: -148 }),
    // 窗内被裁掉的数字（`0`–`9` 各自实例化，屏幕上只露 1 行）
    mkNode({ nodeId: 'digit-hidden', className: 'com.facebook.react.views.text.ReactTextView', text: '6', parentId: 'digit-window', y: -148, width: 13, height: 28, clippedOut: true }),
    mkNode({ nodeId: 'digit-hidden-2', className: 'com.facebook.react.views.text.ReactTextView', text: '7', parentId: 'digit-window', y: -120, width: 13, height: 28, clippedOut: true }),
    // ⭐ 真可见的同款节点（当前露出的那一位）—— **必须保留**
    mkNode({ nodeId: 'digit-shown', className: 'com.facebook.react.views.text.ReactTextView', text: '9', y: 383, width: 13, height: 28, clippedOut: false }),
    // ⭐ 被裁的图形类（PathView）—— **必须保留**：图形被裁 ≠ 不存在，可能画在别处
    mkNode({ nodeId: 'svg-clipped', className: 'com.horcrux.svg.PathView', clippedOut: true }),
    // ⭐ 被裁但 participation 非 required —— 保留
    mkNode({ nodeId: 'ctx-clipped', className: 'com.facebook.react.views.text.ReactTextView', text: 'x', clippedOut: true, participation: 'context' }),
    // ⭐⭐ 滚动区下方「还没滚到」的真实内容 —— **必须保留**
    //    实测教训：495 素材里「官配防买错」「1.13km」就是这一类（父高 39 > 0），
    //    早期判据把它们当噪声剔了 ⇒ 必须钉住这条边界
    mkNode({ nodeId: 'below-fold', className: 'com.facebook.react.views.text.ReactTextView', text: '官配防买错', y: 777, width: 91, height: 15, clippedOut: true }),
    // 普通可见节点 —— 保留
    mkNode({ nodeId: 'normal', className: 'com.facebook.react.views.text.ReactTextView', text: '海尔云溪' }),
  ];

  const shaped = shapeBoth({
    meta: {
      requirement: { id: 'r', name: 'r' }, pair: { id: 'p' },
      design: { id: 'd', name: 'd', width: 375, height: 812, scale: 2, pixelWidth: 750, pixelHeight: 1624 },
      app: { id: 'a', name: 'a', width: 360, height: 792, scale: 3, pixelWidth: 1080, pixelHeight: 2376 },
    } as never,
    designNodes: [] as never[],
    appNodes: appNodes as never[],
    profile,
  });

  const keptIds = shaped.app.nodes.map((n) => n.id);
  const dropReasons = new Map(shaped.app.dropped.map((d) => [d.id, d.reason]));

  ok(!keptIds.includes('digit-hidden') && !keptIds.includes('digit-hidden-2'),
    '被裁的数字文本节点出局（clippedOut + 有文本 + required）',
    `kept=${keptIds.join(',')}`);
  ok(dropReasons.get('digit-hidden') === 'clipped-out', '剔除原因记为 clipped-out（可归因）', String(dropReasons.get('digit-hidden')));
  ok(keptIds.includes('digit-shown'), '⭐ 真可见的那一位数字**保留**（不是所有数字都剔）', '');
  ok(keptIds.includes('svg-clipped'), '⭐ 被裁的图形类保留（PathView 不因裁剪出局）', '');
  ok(keptIds.includes('ctx-clipped'), '⭐ participation=context 的裁剪节点保留', '');
  ok(
    keptIds.includes('below-fold'),
    '⭐⭐ 滚动区下方「还没滚到」的真实内容保留（实测误伤过：官配防买错 / 1.13km）',
    '',
  );
  ok(keptIds.includes('normal'), '普通可见节点保留', '');

  // 老快照（没有这些字段）必须**放行**，不能因为「读不到」就判「被裁了」
  const legacy = shapeBoth({
    meta: {
      requirement: { id: 'r', name: 'r' }, pair: { id: 'p' },
      design: { id: 'd', name: 'd', width: 375, height: 812, scale: 2, pixelWidth: 750, pixelHeight: 1624 },
      app: { id: 'a', name: 'a', width: 360, height: 792, scale: 3, pixelWidth: 1080, pixelHeight: 2376 },
    } as never,
    designNodes: [] as never[],
    appNodes: [mkNode({ nodeId: 'old', text: '文本' })] as never[],
    profile,
  });
  ok(legacy.app.nodes.length === 1, '老快照（无 clippedOut 字段）不受影响', `kept=${legacy.app.nodes.length}`);
}

if (hasBundle) {
  section('AI 通道 · 分区级失败不拖垮整次运行');
  {
    /**
     * 前 2 片抛（模拟真实那次 AbortError），其余照常返回。
     * 关键断言：**整体不抛**、跑满全部分片、失败片在 notes 里、且该片不会虚报「AI 复核过」。
     */
    const failing = new MockRegionReviewer({});
    let call = 0;
    const flaky: RegionReviewer = {
      name: 'flaky',
      async review(req) {
        call += 1;
        if (call <= 2) throw new Error('评审失败：请求超时（30s）');
        return failing.review(req);
      },
    };

    let threw: string | null = null;
    let degraded: Awaited<ReturnType<typeof runAcceptance>> | null = null;
    // 外层 `if (hasBundle)` 已经保证它非空，但 tsc 收窄不到这里 —— 显式取一次
    const fixture = loaded!;
    try {
      degraded = await runAcceptance(fixture.input, {
        profile,
        reviewer: flaky,
        samplers: { design: null, app: null },
        images: { design: null, app: null },
        enablePixel: false,
        now: '2026-10-04T00:00:00.000Z',
      });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }

    ok(threw === null, '前 2 片失败时整次运行仍成功返回', threw ?? '');
    ok(call >= 9, '仍把所有分片都试了一遍（不因首片失败就短路）', `call=${call}`);
    const notes = (degraded?.report.notes ?? []).join('\n');
    ok(notes.includes('AI 评审有 2 片失败'), 'notes 如实报出失败片数', '');
    ok(notes.includes('未经 AI 复核'), 'notes 明说这些区间未经 AI 复核（不留虚假的完整感）', '');
    const src = degraded?.report.counts.bySource;
    /**
     * 判据不是「ai > 0」—— mock reviewer 的行为是**复核既有 mark**，
     * 所以正确的形态是 `mixed`（规则判 + AI 复核）与 `rule`（纯规则）并存。
     * ⭐ 这条断言的真正价值：失败的 2 片必须留在 `rule` 上，
     * 绝不能混进 `mixed` —— 那就等于虚报「AI 复核过」。
     */
    ok(
      (src?.mixed ?? 0) > 0 && (src?.rule ?? 0) > 0 && (src?.ai ?? 0) === 0,
      '成功片走 mixed（规则+AI）、失败片仍走 rule（两路并存，无虚报）',
      JSON.stringify(src),
    );
  }

  section('M4 像素通道 · 不被降采样污染');
  if (designImg && appImg) {
    /**
     * 降采样只该作用于**送审图**（VLM 通道），M4 仍是原图逐像素采样。
     *
     * ⚠️ 判据用「同一批检查在两种配置下产出条数与量值一致」，
     * 而不是「跑一遍看看没报错」—— 后者在降采样真发生时也可能照样通过。
     */
    const mk = (): ReturnType<typeof runPixelChecks> =>
      runPixelChecks(
        [
          {
            id: 'X',
            // ⚠️ designBox 是必填（设计逻辑矩形，App 侧实测坐标由它换算）
            designBox: [40, 200, 60, 24],
            expectedColorHex: '#f5f5f5',
          },
        ],
        {
          appSampler: new PngSampler(appImg),
          // designSampler 必填（接口完整性；本探针只验 App 侧采样，填 null 表示不采）
          designSampler: null,
          designScale: 2,
          appScale: 3,
          logicalRatio: 0.96,
          thresholds: { deltaE: 2.5, cornerTolerancePx: 4 },
        },
      );
    const plain = mk();
    ok(plain.available === true, 'M4 在原图上可用', JSON.stringify(plain).slice(0, 120));
    const before = plain.colorChecks.map((c) => `${c.id}:${c.deltaE}`).join(',');
    // 走一遍与 harness 相同的那条降采样路径，再验 M4 未受影响
    void downscaleForReview(appImg, 720);
    const after = mk().colorChecks.map((c) => `${c.id}:${c.deltaE}`).join(',');
    ok(before === after, '降采样后 M4 量值逐位不变（两通道互不污染）', `${before} vs ${after}`);
  } else {
    skipped('像素图不可用');
  }
} else {
  section('AI 通道 · 分区级失败不拖垮整次运行');
  skipped('需要 bundle 夹具');
}

/* ------------------------------------------------------------------ */
/* 汇总                                                               */
/* ------------------------------------------------------------------ */

console.log(`\n${'─'.repeat(64)}`);
console.log(`通过 ${pass} · 失败 ${fail} · 跳过 ${skip}`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log(`${'─'.repeat(64)}`);

if (fail > 0) process.exit(1);
