/**
 * SAMA 接线冒烟 —— 在纯 Node 里跑一次**宿主适配层**（`src/main/acceptance/sama.ts`）。
 *
 *   npm run probe:sama                          # 已知良好样本 + 默认 workspace 根
 *   npm run probe:sama -- pair=<pairId>         # 指定配对
 *   npm run probe:sama -- root=<workspace 根>    # 指定 workspace（默认 ~/Library/.../workspace）
 *   npm run probe:sama -- engine=mock           # 走 mock reviewer 分支
 *   npm run probe:sama -- template=bundle       # 走手工 R1–R9 分区口径
 *   npm run probe:sama -- ref=<cli-report.json> # 额外与 CLI 报告逐项对表（同构证明）
 *
 * ⚠️ 默认配对用的是**写死的已知良好样本**（`测试验收 / 10年管家开通前`），
 * **不是** index 里第一个。原因：`index.json` 的顺序不表达「哪个配对是对的」——
 * 实测第一个配对是「盲盒抽奖」的错配快照（App 685 节点 / 402×874，强锚点只剩 1），
 * 跑出来 119 条 P1 全是错配噪音。拿它当默认，冒烟输出会像「引擎坏了」，
 * 而真正该暴露的是「这个配对本身不匹配」。样本被删时自动退回 index 第一个并打印提示。
 *
 * ## 它验证什么，不验证什么
 *
 * 验证：宿主适配层的**全部分支** —— 读 workspace 素材、按引擎选择装配 reviewer、
 * 解码两侧截图做像素采样、编排 L0→L3、把结果收敛成可跨 IPC 的纯数据。
 * 这条路径与 IPC 里跑的是**同一个函数**（`runSamaAcceptance`），
 * 差别只有 `workspaceRoot` 从哪来 —— 这里用包自带的 `defaultWorkspaceRoot()`
 * （`~/Library/Application Support/screen-mirror-mac/workspace`），
 * Electron 侧用 `app.getPath('userData')/workspace`，两者实测指向同一个目录。
 *
 * 不验证：Electron 的 IPC 通道本身（`verify:sama-run` 的注册与 preload 暴露）。
 * 那部分靠 `npm run typecheck`（node + web 两侧）+ `electron-vite build`
 * （产物里含引擎代码、无 external 泄漏）覆盖。
 *
 * ## 判据是「同构」，不是「没抛异常」
 *
 * 接线错了最典型的表现不是崩溃，而是**结构完整但数字归零**（分区空、像素不可用、
 * issue 一条不剩）。所以下面每一项都在卡「产出与 CLI 侧同构」：
 * ① 结构不空；② 三个维度的计数都是同一批 issue 的投影，必须两两闭合；
 * ③ verdict 必须能由 issues 复算出来（复刻 `l3.ts` 的三分支）；
 * ④ 每条 issue 的证据链完好（面板要展示，缺了就是空卡片）；
 * ⑤ 像素通道可用且明细自洽。
 *
 * ⚠️ **不要写「这个样本应该有 N 个 X」这类样本相关的断言。**
 * 曾经把 `noPixelEvidence >= 2` 抄进来 —— 那是 `packages/ai-acceptance/src/__tests__/run.ts`
 * 里**合成夹具**的不变量（夹具把 App 快照裁到 y≈900，才人为造出 2 片无像素证据区间）；
 * 真实 workspace 配对（App 快照 360×792）压根不该有。样本一换就误报，且会掩盖真问题
 * （把「没识别出」和「本来就没有」混为一谈）。要卡具体数字，用 `ref=` 对表。
 *
 * ## 为什么要 `--packages=external`
 *
 * `pngjs` 是 CJS（内部 `require('util')`）。esbuild 把它打进 ESM 产物后会生成
 * `__require` 垫片，运行时抛 `Dynamic require of "util" is not supported`。
 * 而它又**只**存在于 `packages/ai-acceptance/node_modules` —— 从 `.smoke/` 目录
 * 反向解析不到，所以单加 `--external:pngjs` 也救不回来（运行时 MODULE_NOT_FOUND）。
 * `--packages=external` 让 Node 用**自己的**加载器处理 `@ui-inspector/ai-acceptance/node`
 * （符号链接 → 真实路径 → 从包里解析 pngjs，同时命中 Node 的类型擦除），
 * 这与包自己的 `node --experimental-strip-types src/cli.ts` 是同一条加载路径。
 * （`--alias` 在 external 判定**之前**生效，所以 `@shared/*` 仍被正确内联 —— 已实测。）
 *
 * ⚠️ 曾经写过一个「用 Electron 跑」的版本，用来连 IPC 一起验 —— 结论是**跑不通，
 * 且与本次接线无关**：这个 Electron 版本（30.5.1 / 内置 Node 20.16）下，
 * ESM 主进程里 `import { app } from 'electron'` 直接 `SyntaxError:
 * does not provide an export named 'app'`。用最小复现（一个只有 5 行的
 * `main: index.mjs`）和**本仓库自己的构建产物**（`out/main/index.js`）都复现了同一个错 ——
 * 也就是说 `apps/screen-mirror-mac` 现在这条 ESM 主进程路径是坏的，
 * 日常只能靠 `electron-vite dev`。等那条路修好，这个探针可以再补上 Electron 侧。
 */

import { readFileSync } from 'node:fs';

import { defaultWorkspaceRoot, listWorkspacePairs } from '@ui-inspector/ai-acceptance/node';

import { runSamaAcceptance } from '../src/main/acceptance/sama';
import type { AcceptanceReport } from '@ui-inspector/ai-acceptance';

/**
 * 默认配对 —— 「测试验收 / 10年管家开通前」。
 *
 * 判据是**对齐要成立**（34 个强锚点、Δy 中位数 −22.66px），这样一旦输出里的数字
 * 变了，是接线/引擎的问题；换成错配样本则分不清「引擎坏了」还是「这两份素材本来就对不上」。
 * 样本不在了就退回 index 第一个（并打印提示），不因为写死而直接失败。
 */
const KNOWN_GOOD_PAIR_ID = 'a8f487d5-67e8-4ca4-bd60-952e0a01293c';

function argValue(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

/** 同一批 issue 在某个维度上的投影之和 —— 用来验计数闭合。 */
function sumOf(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/**
 * 与 CLI 报告对表。
 *
 * 只比**可复现的量**：尺寸/口径、锚点、分区、计数、像素汇总、判定。
 * 不比 `generatedAt` / `durationMs`（每次不同），也不比 `issues` 全量
 * （顺序与 issueId 编号在两侧可能不同，那是实现细节）。
 */
function compareWithRef(report: AcceptanceReport, ref: AcceptanceReport): string[] {
  const diffs: string[] = [];
  const eq = (label: string, a: unknown, b: unknown): void => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) diffs.push(`${label}：宿主 ${sa} ≠ CLI ${sb}`);
  };

  eq('input', report.input, ref.input);
  eq('alignment.strongAnchors', report.alignment.strongAnchors, ref.alignment.strongAnchors);
  eq('alignment.residualMedian', report.alignment.residualMedian, ref.alignment.residualMedian);
  eq('regions.length', report.regions.length, ref.regions.length);
  eq('noPixelEvidence.length', report.noPixelEvidence.length, ref.noPixelEvidence.length);
  eq('counts', report.counts, ref.counts);
  eq('issues.length', report.issues.length, ref.issues.length);
  eq('verdict', report.verdict, ref.verdict);
  eq('pixel.summary', report.pixel?.summary, ref.pixel?.summary);
  eq('pixel.available', report.pixel?.available, ref.pixel?.available);
  return diffs;
}

async function main(): Promise<number> {
  const root = argValue('root') ?? defaultWorkspaceRoot();
  const engine = (argValue('engine') ?? 'rules') as 'rules' | 'mock' | 'ai';
  const template = (argValue('template') ?? 'default') as 'default' | 'bundle';
  const refPath = argValue('ref');

  // 配对优先级：命令行 > 已知良好样本（还在 index 里才用）> index 第一个。
  // 写死 UUID 会在配对重建后失效，所以每一步都有退路 —— 但退路要**说出来**，
  // 否则「退到了错配样本」和「引擎坏了」在输出上长得一样。
  let pairId = argValue('pair');
  let pairNote = '命令行指定';
  if (!pairId) {
    let available: string[] = [];
    try {
      available = listWorkspacePairs(root).map((p) => p.pairId);
    } catch {
      available = [];
    }
    if (available.includes(KNOWN_GOOD_PAIR_ID)) {
      pairId = KNOWN_GOOD_PAIR_ID;
      pairNote = '已知良好样本';
    } else if (available.length > 0) {
      pairId = available[0];
      pairNote = `已知样本不在 workspace，退回 index 第一个（共 ${available.length} 个配对，不一定对齐）`;
    } else {
      pairId = KNOWN_GOOD_PAIR_ID;
      pairNote = 'workspace 里读不到配对列表，硬着头皮试已知样本';
    }
  }

  console.log(`[probe:sama] workspace = ${root}`);
  console.log(`[probe:sama] pairId    = ${pairId} · engine = ${engine}`);
  console.log(`[probe:sama] 配对来源   = ${pairNote} · 分区口径 = ${template}`);

  const result = await runSamaAcceptance({ pairId, engine, template }, { workspaceRoot: root });

  if (!result.ok) {
    console.error(`[probe:sama] ✗ ${result.kind}：${result.error}`);
    return 1;
  }

  const { report, markdown } = result;
  console.log(`[probe:sama] 引擎       = ${result.engineUsed}${result.engineNote ? `（${result.engineNote}）` : ''}`);
  console.log(`[probe:sama] verdict    = ${report.verdict} —— ${report.verdictReason}`);
  console.log(
    `[probe:sama] 计数       = P0 ${report.counts.p0} / P1 ${report.counts.p1} / P2 ${report.counts.p2}` +
      `（强 ${report.counts.byAuthority.strong} · 弱 ${report.counts.byAuthority.weak}）· issue 共 ${report.issues.length} 条`,
  );
  console.log(
    `[probe:sama] 输入       = 设计 ${report.input.design.width}×${report.input.design.height}` +
      ` / ${report.input.design.nodes} 节点 · App ${report.input.app.width}×${report.input.app.height}` +
      ` / ${report.input.app.nodes} 节点 · 物理比 ${report.input.pixelRatio} · 逻辑比 ${report.input.logicalRatio}`,
  );
  console.log(
    `[probe:sama] 对齐       = 强锚点 ${report.alignment.strongAnchors} + 固定层 ${report.alignment.fixedLayerAnchors}` +
      ` · Δy 中位数 ${report.alignment.residualMedian}px · 拟合段 ${report.alignment.segments.length}`,
  );
  console.log(
    `[probe:sama] 分区       = ${report.regions.length} 个，其中无像素证据 ${report.regions.filter((r) => r.noPixelEvidence).length} 个` +
      `（区间已合并为 ${report.noPixelEvidence.length} 段）`,
  );
  console.log(
    `[probe:sama] 像素       = ${
      report.pixel?.available
        ? `检查 ${report.pixel.summary.checked} 项，失败 ${report.pixel.summary.failed} 项`
        : `不可用（${report.pixel?.reason ?? '未启用'}）`
    }`,
  );
  console.log(`[probe:sama] markdown   = ${markdown.length} 字符 · 耗时 ${result.durationMs}ms`);

  /* ------------------------------------------------------------------ */
  /* 判据：逐项卡「结构不空 + 计数闭合 + 判定可复算 + 证据链完好」        */
  /* ------------------------------------------------------------------ */

  const problems: string[] = [];
  const check = (ok: boolean, label: string, detail = ''): void => {
    if (!ok) problems.push(detail ? `${label}（${detail}）` : label);
  };

  // ① 结构不空
  check(report.schemaVersion === 1, `schemaVersion=${report.schemaVersion}`);
  check(report.regions.length >= 1, '分区为空');
  check(report.alignment.strongAnchors > 0, '没有强锚点（对齐没跑起来，或这一对素材本身就不匹配）', `强锚点 ${report.alignment.strongAnchors}`);
  check(
    report.alignment.anchors === report.alignment.strongAnchors + report.alignment.weakAnchors,
    '锚点分档不闭合',
    `${report.alignment.anchors} ≠ ${report.alignment.strongAnchors} + ${report.alignment.weakAnchors}`,
  );
  check(
    report.input.design.width > 0 && report.input.app.width > 0 && report.input.pixelRatio > 0,
    '输入尺寸或尺度比异常',
  );

  // ② 计数闭合：三个维度都是同一批 issue 的投影
  const total = report.issues.length;
  check(report.counts.p0 + report.counts.p1 + report.counts.p2 === total, '严重度计数 ≠ issue 总数', `${report.counts.p0}+${report.counts.p1}+${report.counts.p2} ≠ ${total}`);
  check(sumOf(report.counts.byCategory) === total, '类目计数 ≠ issue 总数', `${sumOf(report.counts.byCategory)} ≠ ${total}`);
  check(sumOf(report.counts.bySource) === total, '来源计数 ≠ issue 总数', `${sumOf(report.counts.bySource)} ≠ ${total}`);
  check(
    report.counts.byAuthority.strong + report.counts.byAuthority.weak === total,
    '权威分档 ≠ issue 总数',
    `${report.counts.byAuthority.strong}+${report.counts.byAuthority.weak} ≠ ${total}`,
  );

  // ③ 判定可复算（复刻 l3.ts：有 P0/P1 → fail；否则有 issue → review；再否则 pass）
  const blocking = report.counts.p0 + report.counts.p1;
  if (blocking > 0) {
    check(report.verdict === 'fail', `有 ${blocking} 条 P0/P1 却判 ${report.verdict}`);
  } else if (total > 0) {
    check(report.verdict !== 'fail', '无 P0/P1 却判 fail');
  } else {
    check(report.verdict === 'pass', `无 issue 却判 ${report.verdict}`);
  }

  // ④ 证据链完好（面板要据此渲染，缺字段就是空卡片）
  const broken = report.issues.filter((i) => !i.issueId || !i.title || !i.category || !i.severity || !i.source || !i.evidence);
  check(broken.length === 0, `${broken.length} 条 issue 证据链不完整（缺 issueId/title/category/severity/source/evidence）`);

  // ⑤ 像素通道可用且明细自洽（两侧素材都在 workspace 里，不该解码失败）
  check(!!report.pixel, '像素通道结果缺失');
  check(report.pixel?.available === true, '像素通道不可用（截图应能解码）', report.pixel?.reason ?? '');
  check(
    (report.pixel?.summary.checked ?? 0) === (report.pixel?.colorChecks.length ?? 0) + (report.pixel?.cornerChecks.length ?? 0),
    '像素检查项计数 ≠ 明细条数',
  );
  check(
    (report.pixel?.summary.failed ?? 0) <= (report.pixel?.summary.checked ?? 0),
    '像素失败数 > 检查数',
  );

  // ⑥ 覆盖风险：标记了无像素证据的分区 → 合并后的区间数不该变多；而只要有一条就必须 fail
  const flaggedRegions = report.regions.filter((r) => r.noPixelEvidence).length;
  check(report.noPixelEvidence.length <= flaggedRegions, '合并后的无像素证据区间数 > 被标记的分区数');
  check(report.noPixelEvidence.length === 0 || report.verdict === 'fail', '存在无像素证据区间却未判 fail（严禁默认通过）');

  // ⑦ 引擎 / 口径分支：选了谁就得是谁；降级必须带说明
  if (engine === 'rules') check(result.engineUsed === 'rules', `engine=rules 却走了 ${result.engineUsed}`);
  if (engine === 'mock') check(result.engineUsed === 'mock', `engine=mock 却走了 ${result.engineUsed}`);
  if (engine === 'ai' && result.engineUsed !== 'ai') check(!!result.engineNote, 'AI 引擎降级但未给出原因');
  // 口径是否真的传到了 profile 工厂：bundle 是手工 R1–R9，被忽略就会退化成整页单区。
  // 这条是**接线判据**，不是样本数字 —— 只要口径生效就不可能只有 1 个分区。
  if (template === 'bundle') {
    check(report.regions.length > 1, `template=bundle 却只切出 ${report.regions.length} 个分区（口径没传到位？）`);
  }
  check(result.durationMs >= 0, `durationMs=${result.durationMs}`);

  // ⑧ Markdown 报告同构（面板的「导出」按钮直接落盘这一段文本）
  check(markdown.length > 500, 'markdown 报告过短');
  check(markdown.includes(report.verdict), 'markdown 未包含 verdict');
  check(markdown.includes('|'), 'markdown 未生成表格');

  // ⑨ 可选：与 CLI 报告逐项对表 —— 这是「宿主 ≡ CLI」的直接证据
  if (refPath) {
    let ref: AcceptanceReport;
    try {
      ref = JSON.parse(readFileSync(refPath, 'utf8')) as AcceptanceReport;
    } catch (error) {
      problems.push(`ref 读取失败（${refPath}）：${error instanceof Error ? error.message : String(error)}`);
      ref = report;
    }
    const diffs = compareWithRef(report, ref);
    check(diffs.length === 0, '与 CLI 报告不一致', diffs.join('；'));
    console.log(`[probe:sama] ref        = ${refPath}（${diffs.length === 0 ? '与 CLI 逐项一致' : `${diffs.length} 处不一致`}）`);
  }

  if (problems.length) {
    console.error(`[probe:sama] ✗ ${problems.join('；')}`);
    return 1;
  }
  console.log('[probe:sama] ✓ 接线通过');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[probe:sama] ✗ 异常：', error);
    process.exit(1);
  });
