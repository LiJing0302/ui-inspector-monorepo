#!/usr/bin/env node
/**
 * ai-acceptance CLI —— 离线跑一次验收
 *
 *   node --experimental-strip-types src/cli.ts <bundle.zip|bundleDir> \
 *     [--out report.json] [--md report.md] \
 *     [--ai] [--reviewer mock|openai] [--ai-model gpt-4o] [--ai-base-url ...] [--ai-key ...] \
 *     [--no-pixel] [--profile default|bundle] [--quiet]
 *
 * 无 AI key 也能跑：确定性通道（L0/L1/L2/L3 + M4 像素）不依赖任何外部服务。
 */

import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadBundle, cleanupBundle } from './node/loadBundle.ts';
import {
  defaultWorkspaceRoot,
  listWorkspacePairs,
  loadFromWorkspace,
  WorkspaceInputError,
} from './node/fromWorkspace.ts';
import { PngSampler } from './node/pngSampler.ts';
import { OpenAiCompatibleReviewer } from './node/openaiReviewer.ts';
import { MockRegionReviewer } from './reviewer.ts';
import { runAcceptance } from './harness.ts';
import { renderMarkdownReport } from './report.ts';
import { auditClean, renderCleanAudit } from './clean-audit.ts';
import { createBundleProfile2026_09_30, createDefaultProfile } from './profile.ts';
import type { PixelImage, RegionReviewer } from './types.ts';

interface Args {
  bundle: string;
  /** 走 Mac app workspace 直读（免导出、免搬运） */
  wsRoot: string | null;
  /** 仅列出 workspace 里的需求 / 配对，不跑验收 */
  list: boolean;
  req: string | null;
  design: string | null;
  pair: string | null;
  out: string | null;
  md: string | null;
  ai: boolean;
  reviewer: 'mock' | 'openai';
  aiModel: string;
  aiBaseUrl: string;
  aiKey: string | null;
  pixel: boolean;
  profile: 'default' | 'bundle';
  quiet: boolean;
  /** mock reviewer：是否演练"AI 可新增弱类目 issue"通道（默认关，避免刷屏） */
  mockWeak: boolean;
  /** mock reviewer：是否注入一条幻觉 markId（默认关） */
  mockHallucination: boolean;
  /**
   * 清洗审计（人工核验卡点①）。
   * `true` = 打到 stdout；给字符串 = 写进那个 .md 文件。
   */
  cleanAudit: boolean | string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    bundle: '',
    wsRoot: null,
    list: false,
    req: null,
    design: null,
    pair: null,
    out: null,
    md: null,
    ai: false,
    reviewer: 'mock',
    aiModel: process.env['AI_MODEL'] ?? 'gpt-4o',
    aiBaseUrl: process.env['AI_BASE_URL'] ?? 'https://api.openai.com/v1',
    aiKey: process.env['AI_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? null,
    pixel: true,
    profile: 'default',
    quiet: false,
    mockWeak: false,
    mockHallucination: false,
    cleanAudit: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case '--ws':
        a.wsRoot = defaultWorkspaceRoot();
        break;
      case '--ws-root':
        a.wsRoot = argv[++i] ?? defaultWorkspaceRoot();
        break;
      case '--list':
        a.list = true;
        break;
      case '--req':
        a.req = argv[++i] ?? null;
        break;
      case '--design':
        a.design = argv[++i] ?? null;
        break;
      case '--pair':
        a.pair = argv[++i] ?? null;
        break;
      case '--out':
        a.out = argv[++i] ?? null;
        break;
      case '--md':
        a.md = argv[++i] ?? null;
        break;
      case '--ai':
        a.ai = true;
        break;
      case '--reviewer':
        a.reviewer = (argv[++i] as Args['reviewer']) ?? 'mock';
        break;
      case '--ai-model':
        a.aiModel = argv[++i] ?? a.aiModel;
        break;
      case '--ai-base-url':
        a.aiBaseUrl = argv[++i] ?? a.aiBaseUrl;
        break;
      case '--ai-key':
        a.aiKey = argv[++i] ?? a.aiKey;
        break;
      case '--no-pixel':
        a.pixel = false;
        break;
      case '--profile':
        a.profile = (argv[++i] as Args['profile']) ?? 'default';
        break;
      case '--quiet':
        a.quiet = true;
        break;
      case '--mock-weak':
        a.mockWeak = true;
        a.ai = true;
        break;
      case '--mock-hallucination':
        a.mockHallucination = true;
        a.ai = true;
        break;
      case '--clean-audit':
        // ⚠️ 不传值 = 打到 stdout；`--clean-audit=x.md` 写文件。
        // 用「下一个 token 不以 -- 开头」判断，而不是固定取 argv[i+1] ——
        // 后者会把下一个选项当成文件名。
        a.cleanAudit = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (t && !t.startsWith('--') && !a.bundle) a.bundle = t;
        break;
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`ai-acceptance —— SAMA 离线 AI 验收

用法（两种入口，选一个）：
  A. 直读 Mac app workspace（日常用这条，免导出）
     node --experimental-strip-types src/cli.ts --list
     node --experimental-strip-types src/cli.ts --req <需求名> [--design <设计稿名>] [选项]

  B. 吃已导出的 debug bundle
     node --experimental-strip-types src/cli.ts <bundle.zip|bundleDir> [选项]

workspace 选项：
  --list                 列出 workspace 里的需求 / 配对（含 pairId），不跑验收
  --req <名字|id>        需求名或 id（子串匹配）
  --design <名字>        设计稿名（一个需求下有多页时用它定位）
  --pair <pairId>        直接按配对 id 跑（优先级最高）
  --ws-root <path>       指定 workspace 根（默认 macOS 固定位置，
                         也可用环境变量 SCREEN_MIRROR_WORKSPACE）

选项：
  --out <file.json>      输出机器可读报告
  --md  <file.md>        输出 Markdown 报告
  --ai                   启用 AI 分区评审通道
  --reviewer mock|openai （默认 mock）
  --ai-model <name>      OpenAI 兼容模型名（默认 gpt-4o）
  --ai-base-url <url>    默认 https://api.openai.com/v1
  --ai-key <key>         也可用环境变量 AI_API_KEY / OPENAI_API_KEY
  --no-pixel             关闭像素通道（M4）
  --profile default|bundle  默认 default；bundle 会载入样本的 9 分区与前提声明
  --mock-weak            仅 mock：演练"AI 可新增弱类目（颜色/圆角）issue"通道
  --mock-hallucination   仅 mock：每片注入 1 条幻觉 markId，验证 100% 被拒
  --clean-audit [file]   节点清洗审计（人工核验卡点①）：逐层列出剔了什么/为什么/剩什么。
                         不带 file 打到 stdout。L4 语义噪声层标为 risky，需逐条核对
  --quiet                只输出结论
`);
}

/** `--list`：把 workspace 里的需求 / 配对摊开，顺带给出可直接复制的命令 */
function printWorkspacePairs(root: string): void {
  const pairs = listWorkspacePairs(root);
  console.log(`workspace: ${root}`);
  if (pairs.length === 0) {
    console.log('（没有任何需求 / 配对 —— 先在 Mac app 里建需求并配对）');
    return;
  }
  let lastReq = '';
  for (const p of pairs) {
    if (p.requirementName !== lastReq) {
      lastReq = p.requirementName;
      console.log(`\n▸ ${p.requirementName}  (${p.requirementId})`);
    }
    console.log(
      `    · ${p.designName.padEnd(24, ' ')} ↔ ${p.appLabel.padEnd(22, ' ')}` +
        ` 节点 ${p.designNodeCount}/${p.appNodeCount}  ${p.pairId}`,
    );
  }
  console.log(`\n跑某一条：pnpm --filter @ui-inspector/ai-acceptance accept -- --pair <pairId>`);
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));

  // 入口判定：给了任何 workspace 选择条件，就走直读模式（不必再写 --ws）
  const useWs = a.wsRoot !== null || a.req !== null || a.design !== null || a.pair !== null;

  if (a.list) {
    printWorkspacePairs(a.wsRoot ?? defaultWorkspaceRoot());
    return;
  }
  if (!useWs && !a.bundle) {
    printHelp();
    process.exit(1);
  }

  const loaded = useWs
    ? loadFromWorkspace(a.wsRoot ?? defaultWorkspaceRoot(), {
        requirement: a.req ?? undefined,
        design: a.design ?? undefined,
        pairId: a.pair ?? undefined,
      })
    : loadBundle(a.bundle);
  const profile = a.profile === 'bundle' ? createBundleProfile2026_09_30() : createDefaultProfile();

  // ---- 像素通道：解码两张截图（M4） ----
  let designImg: PixelImage | null = null;
  let appImg: PixelImage | null = null;
  if (a.pixel) {
    try {
      designImg = loaded.input.designImage?.load ? await loaded.input.designImage.load() : null;
      appImg = loaded.input.appImage?.load ? await loaded.input.appImage.load() : null;
    } catch (e) {
      if (!a.quiet) console.error(`[warn] 截图解码失败，像素通道跳过：${String(e)}`);
    }
  }

  // ---- AI 通道 ----
  let reviewer: RegionReviewer | null = null;
  if (a.ai) {
    if (a.reviewer === 'openai') {
      if (!a.aiKey) {
        console.error('未提供 AI key（--ai-key 或 AI_API_KEY），已回退到 mock reviewer');
        reviewer = new MockRegionReviewer({ addWeakCategoryIssues: a.mockWeak, injectHallucination: a.mockHallucination });
      } else {
        reviewer = new OpenAiCompatibleReviewer({ apiKey: a.aiKey, model: a.aiModel, baseUrl: a.aiBaseUrl });
      }
    } else {
      reviewer = new MockRegionReviewer({ addWeakCategoryIssues: a.mockWeak, injectHallucination: a.mockHallucination });
    }
  }

  const { report, debug } = await runAcceptance(loaded.input, {
    profile,
    reviewer,
    enablePixel: a.pixel,
    samplers: {
      design: designImg ? new PngSampler(designImg) : null,
      app: appImg ? new PngSampler(appImg) : null,
    },
    images: { design: designImg, app: appImg },
  });

  if (a.out) {
    writeFileSync(a.out, JSON.stringify(report, null, 2));
    if (!a.quiet) console.log(`✔ JSON 报告：${a.out}`);
  }
  if (a.md) {
    writeFileSync(a.md, renderMarkdownReport(report));
    if (!a.quiet) console.log(`✔ Markdown 报告：${a.md}`);
  }

  // ---- 清洗审计（人工核验卡点①）----
  // ⚠️ 走 `runAcceptance` 的 debug 产物而不是自己再跑一遍 shapeBoth：
  // 自己跑会得到**第二份**清洗结果，而报告用的是第一份 —— 两者一旦有差异，
  // 审计就与结论对不上（正是「同一份数据放两处必然不同步」那条铁律）。
  if (a.cleanAudit) {
    const audit = auditClean(debug.shape.design, debug.shape.app);
    const md = renderCleanAudit(audit);
    if (a.cleanAudit !== true) {
      writeFileSync(a.cleanAudit, md);
      if (!a.quiet) console.log(`✔ 清洗审计：${a.cleanAudit}`);
    } else {
      console.log(md);
    }
    if (audit.warnings.length && !a.quiet) {
      console.log('');
      console.log('⚠️ 清洗告警：');
      for (const w of audit.warnings) console.log(`  · ${w}`);
    }
  }

  if (!a.quiet) {
    const sourceLabel = useWs
      ? `workspace  ${loaded.input.meta.requirement?.name ?? ''} / ${String(loaded.input.meta.design['name'] ?? '')}`
      : basename(a.bundle);
    console.log('');
    console.log(`bundle      : ${sourceLabel}`);
    console.log(
      `尺寸        : design ${report.input.design.width}×${report.input.design.height}@${report.input.design.scale}  ` +
        `app ${report.input.app.width}×${report.input.app.height}@${report.input.app.scale}  ` +
        `(k=${report.input.pixelRatio}, 逻辑比=${report.input.logicalRatio})`,
    );
    console.log(
      `L0          : design 保留 ${report.shaping.design.kept}/${report.shaping.design.total}  ` +
        `app 保留 ${report.shaping.app.kept}/${report.shaping.app.total}`,
    );
    console.log(
      `L1          : 强锚点 ${report.alignment.strongAnchors}（固定层 ${report.alignment.fixedLayerAnchors}），` +
        `Δy 中位数 ${report.alignment.residualMedian}px`,
    );
    console.log(
      `L2          : ${report.regions.length} 片，无像素证据 ${report.regions.filter((r) => r.noPixelEvidence).length} 片`,
    );
    console.log(`issues      : P0=${report.counts.p0} P1=${report.counts.p1} P2=${report.counts.p2}`);
    if (report.pixel?.available) {
      console.log(`M4 像素     : 检查 ${report.pixel.summary.checked} 项，失败 ${report.pixel.summary.failed} 项`);
    }
    console.log('');
  }
  console.log(`verdict     : ${report.verdict.toUpperCase()}`);
  console.log(`reason      : ${report.verdictReason}`);

  cleanupBundle(loaded);
}

main().catch((e) => {
  // 「选错了 / 不存在」是日常动作，只打 message；真异常才打堆栈。
  if (e instanceof WorkspaceInputError) {
    console.error(`\n✗ ${e.message}\n`);
    process.exit(2);
  }
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
