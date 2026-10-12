/**
 * Harness —— 把 L0→L3（+M4 像素）串成一次完整验收
 *
 * 四个阶段的输入输出都是纯数据，方便：
 *   - 离线跑（无 AI key 也能出报告）；
 *   - 单测逐段替换（例如用 mock reviewer、用夹具 sampler）。
 */

import type {
  AcceptanceInput,
  AcceptanceProfile,
  AcceptanceReport,
  BundleSideMeta,
  Issue,
  PixelImage,
  RegionReviewRequest,
  RegionReviewResponse,
  RegionReviewer,
  ReviewValidation,
  RuleVerdict,
  Verdict,
} from './types.ts';
import { shapeBoth } from './l0.ts';
import { alignAnchors, type AlignOutput } from './l1.ts';
import { buildRegionSlices } from './l2.ts';
import { validateReview } from './reviewer.ts';
import { adjudicate } from './l3.ts';
import { cropImage, alphaOfHex, downscaleForReview, runPixelChecks, type PixelCheckInput, type Sampler } from './pixel.ts';
import { createDefaultProfile } from './profile.ts';

export interface RunOptions {
  profile?: AcceptanceProfile;
  /** VLM 通道；不传则只跑确定性部分 */
  reviewer?: RegionReviewer | null;
  /** 像素通道：需要两侧的像素采样器（Node 侧由 pngSampler 提供） */
  samplers?: { design?: Sampler | null; app?: Sampler | null };
  /** 像素通道输入；不传则按设计节点的圆角/填充自动推导 */
  pixelChecks?: PixelCheckInput[];
  /** 是否把裁切图塞进 reviewer 请求（需要 images） */
  images?: { design?: PixelImage | null; app?: PixelImage | null };
  /** 是否启用像素通道（默认 true；无 sampler 时自动跳过） */
  enablePixel?: boolean;
  /** 覆盖生成时间（测试用） */
  now?: string;
  /** 每片最多自动推导多少个像素检查项 */
  maxAutoPixelChecks?: number;
  /**
   * 送 VLM 的裁切图长边上限（px），超出则最近邻降采样。
   *
   * ⚠️ **只作用于 VLM 通道的 `designCrop` / `appCrop`**，与 M4 像素通道无关
   * —— 后者要逐像素真色，降采样会把 ΔE00 判据改掉。
   * 传 0 / 负数 = 不降采样（保持原尺寸）。
   */
  reviewMaxEdge?: number;
}

export interface RunResult {
  report: AcceptanceReport;
  /** 中间产物，方便调试 / 二次分析 */
  debug: {
    shape: ReturnType<typeof shapeBoth>;
    align: AlignOutput;
    slices: ReturnType<typeof buildRegionSlices>['slices'];
    validations: Map<string, ReviewValidation>;
    rawReviews: RegionReviewResponse[];
  };
}

/** 解析物理像素宽：优先 pixelWidth，缺失时用 逻辑宽 × 缩放比 兜底 */
function resolvePixelWidth(side: BundleSideMeta): number {
  if (typeof side.pixelWidth === 'number' && side.pixelWidth > 0) return side.pixelWidth;
  const scale = side.scale ?? side.exportScale ?? side.scaleX ?? 1;
  return side.width * scale;
}

export async function runAcceptance(input: AcceptanceInput, opts: RunOptions = {}): Promise<RunResult> {
  const profile = opts.profile ?? createDefaultProfile();

  /* ---------------- L0 ---------------- */
  const shape = shapeBoth({
    meta: input.meta,
    designNodes: input.designNodes,
    appNodes: input.appNodes,
    profile,
  });

  /* ---------------- L1 ---------------- */
  const align = alignAnchors(shape.design, shape.app, {
    gapJump: profile.thresholds?.gapJump ?? 40,
  });

  /* ---------------- L2 ---------------- */
  const designScale = input.meta.design.exportScale ?? input.meta.design.scale ?? 1;
  const appScale = input.meta.app.scaleX ?? input.meta.app.scale ?? input.meta.app.exportScale ?? 1;

  const built = buildRegionSlices({
    design: shape.design,
    app: shape.app,
    align,
    profile,
    designScale,
    appScale,
  });

  /* ---------------- L2' VLM ---------------- */
  const validations = new Map<string, ReviewValidation>();
  const rawReviews: RegionReviewResponse[] = [];
  /** 分区级评审失败（网络/超时/模型返回异常）。不阻断运行，但要如实报出去 */
  const reviewFailures: Array<{ regionId: string; label: string; reason: string }> = [];

  if (opts.reviewer) {
    // 物理像素宽优先取 meta.pixelWidth；缺失时用逻辑宽 × 缩放比兜底
    const designPxW = resolvePixelWidth(input.meta.design);
    const appPxW = resolvePixelWidth(input.meta.app);
    const cropScaleRatio =
      designPxW > 0 && appPxW > 0 ? Math.round((appPxW / designPxW) * 1000) / 1000 : null;

    /**
     * 送审图统一过一次降采样。**默认 720px**：
     * 真实样本实测 R8（设计 y 1080–2205 那一片）按原尺寸 base64 约 2.2MB，
     * 单次请求就带着 2.2MB 图片 —— 这是超时最主要的诱因，而降采样后 ~0.6MB，
     * 判读价值不变（VLM 看的是布局与观感）。
     */
    const reviewMaxEdge = opts.reviewMaxEdge === 0 ? 0 : opts.reviewMaxEdge ?? 720;
    const forReview = (img: PixelImage): PixelImage =>
      reviewMaxEdge > 0 ? downscaleForReview(img, reviewMaxEdge) : img;

    for (const slice of built.slices) {
      const req: RegionReviewRequest = {
        region: slice.region,
        items: slice.items,
        dynamicHints: slice.dynamicHints,
        envHints: slice.envHints,
        noPixelEvidence: slice.noPixelEvidence,
        cropScaleRatio,
        designCrop: opts.images?.design
          ? forReview(cropImage(opts.images.design, slice.designCropPx))
          : undefined,
        appCrop:
          opts.images?.app && slice.appCropPx
            ? forReview(cropImage(opts.images.app, slice.appCropPx))
            : undefined,
      };

      /**
       * ⚠️ 单片失败**不许**让整次运行失败（2026-10-04 修「引擎异常：…评审失败」）。
       *
       * 原来这里是裸 `await`：9 个分区串行，第 1 个超时/断连就整条抛出去，
       * 用户看到的是「引擎异常」—— 而此时**后面 8 片根本没试**，
       * 已经跑出来的那部分结论也一并丢了。VLM 走网络，本就该按「降级」而不是「崩」处理。
       *
       * ⇒ 失败记进 `reviewFailures`，继续跑完其余分区；
       *   该区间的 `validations` 留空 ⇒ L3 拿不到 AI 复核，issue 的 `source` 停在 `rule`，
       *   **不会出现「AI 复核过」的假象**（这是最要紧的一条：宁可少判，不可虚报）。
       *   失败原因最终写进 `notes`，用户看得见「哪几片没审成、为什么」。
       */
      try {
        const resp = await opts.reviewer.review(req);
        rawReviews.push(resp);
        validations.set(slice.region.regionId, validateReview(resp, req));
      } catch (e) {
        reviewFailures.push({
          regionId: slice.region.regionId,
          label: slice.region.label,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /* ---------------- M4 像素 ---------------- */
  const enablePixel = opts.enablePixel !== false;
  const pixelInputs = enablePixel
    ? (opts.pixelChecks ?? autoPixelChecks(shape.design, opts.maxAutoPixelChecks ?? 24))
    : [];

  const logicalRatio = input.meta.app.width > 0 ? input.meta.app.width / input.meta.design.width : 1;
  const pixel = enablePixel
    ? runPixelChecks(pixelInputs, {
        designSampler: opts.samplers?.design ?? null,
        appSampler: opts.samplers?.app ?? null,
        designScale,
        appScale,
        logicalRatio,
        projectY: (y) => {
          const p = align.projectY(y);
          // 只有落在有效拟合区间内的预测才参与像素采样（区间外是外推，不可信）
          if (p.appY < 0 || p.appY > 4000) return null;
          return { appY: p.appY };
        },
        thresholds: {
          deltaE: profile.thresholds?.deltaE ?? 2.5,
          cornerTolerancePx: profile.thresholds?.cornerTolerancePx ?? 4,
        },
      })
    : undefined;

  /* ---------------- L3 ---------------- */
  const adj = adjudicate({
    slices: built.slices,
    validations,
    align,
    profile,
    noPixelEvidence: built.noPixelEvidence,
    pixel,
    aiEnabled: !!opts.reviewer,
  });

  /* ---------------- 报告 ---------------- */
  const report: AcceptanceReport = {
    schemaVersion: 1,
    generatedAt: opts.now ?? new Date().toISOString(),
    requirement: {
      id: input.meta.requirement?.id ?? null,
      name: input.meta.requirement?.name ?? null,
    },
    input: {
      design: {
        width: input.meta.design.width,
        height: input.meta.design.height,
        pixelWidth: input.meta.design.pixelWidth ?? 0,
        pixelHeight: input.meta.design.pixelHeight ?? 0,
        scale: designScale,
        nodes: input.designNodes.length,
      },
      app: {
        width: input.meta.app.width,
        height: input.meta.app.height,
        pixelWidth: input.meta.app.pixelWidth ?? 0,
        pixelHeight: input.meta.app.pixelHeight ?? 0,
        scale: appScale,
        nodes: input.appNodes.length,
      },
      pixelRatio:
        input.meta.design.pixelWidth && input.meta.app.pixelWidth
          ? Math.round((input.meta.app.pixelWidth / input.meta.design.pixelWidth) * 10000) / 10000
          : 0,
      logicalRatio: Math.round(logicalRatio * 10000) / 10000,
    },
    shaping: { design: shape.design.stats, app: shape.app.stats },
    alignment: {
      anchors: align.anchors.length,
      strongAnchors: align.strongAnchors.length,
      weakAnchors: align.weakAnchors.length,
      fixedLayerAnchors: align.fixedLayer.length,
      residualMedian: round2(align.residualMedian),
      residualP90: round2(align.residualP90),
      within3: align.within3,
      gaps: align.gaps,
      segments: align.segments,
      method: 'PAVA isotonic regression + piecewise-linear interpolation (design.y → app.y)',
    },
    regions: built.slices.map((s) => {
      const verdicts: Partial<Record<RuleVerdict, number>> = {};
      for (const it of s.items) verdicts[it.ruleVerdict] = (verdicts[it.ruleVerdict] ?? 0) + 1;
      const v = validations.get(s.region.regionId);
      return {
        regionId: s.region.regionId,
        label: s.region.label,
        designY: [s.region.designY0, s.region.designY1] as [number, number],
        items: s.items.length,
        ruleVerdicts: verdicts,
        noPixelEvidence: s.noPixelEvidence,
        pixelCoverage: s.pixelCoverage,
        reviewerUsed: !!v,
        rejectedDefects: v?.rejected.length ?? 0,
      };
    }),
    noPixelEvidence: built.noPixelEvidence,
    issues: adj.issues,
    verdict: adj.verdict,
    verdictReason: adj.verdictReason,
    counts: adj.counts,
    pixel,
    notes: buildNotes(profile, align, built.designYLimit, adj.issues, reviewFailures, shape),
  };

  return { report, debug: { shape, align, slices: built.slices, validations, rawReviews } };
}

/* --------------------------------------------------------------------------- */

function autoPixelChecks(design: ReturnType<typeof shapeBoth>['design'], max: number): PixelCheckInput[] {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const coveredByLaterSibling = (n: (typeof design.nodes)[number]): boolean => {
    if (!n.parentId) return false;
    const parent = byId.get(n.parentId);
    if (!parent) return false;
    const area = n.rect.width * n.rect.height;
    if (area <= 0) return false;
    for (const sib of design.nodes) {
      if (sib.parentId !== n.parentId || sib.id === n.id) continue;
      if (sib.orderInParent <= n.orderInParent) continue; // 只认后画的兄弟（叠在上面）
      const ox = Math.max(0, Math.min(n.rect.x + n.rect.width, sib.rect.x + sib.rect.width) - Math.max(n.rect.x, sib.rect.x));
      const oy = Math.max(0, Math.min(n.rect.y + n.rect.height, sib.rect.y + sib.rect.height) - Math.max(n.rect.y, sib.rect.y));
      if (ox * oy >= area * 0.85) return true;
    }
    return false;
  };

  const cands: Array<{ n: (typeof design.nodes)[number]; area: number }> = [];
  for (const n of design.nodes) {
    // 必须是**截图覆盖到**、且**有可视盒样式**的容器/图形节点。
    // 排除 text：设计 TEXT 节点的 fill 是"文字颜色"而不是背景色，拿它去采背景必然 ΔE 爆炸（实测踩过）。
    if (!n.inPixels) continue;
    if (n.kind === 'text') continue;
    const bs = n.boxStyle;
    if (!bs) continue;
    const radius = bs.cornerRadius ?? 0;
    const color = bs.fillType === 'SOLID' ? bs.backgroundColor : null;
    if (radius <= 0 && !color) continue;
    // 半透明填充的合成底色不可知 → 采到的值无法与期望比（实测：装饰性 16% 淡紫椭圆 ΔE=4.4 假阳性）
    if (color && alphaOfHex(color) < 0.9 && radius <= 0) continue;
    // 被后画的兄弟（如覆盖在上面的渐变层）遮住的垫底矩形不计（实测：13005 灰底被渐变盖住）
    if (coveredByLaterSibling(n)) continue;
    if (n.rect.width < 12 || n.rect.height < 12) continue;
    cands.push({ n, area: n.rect.width * n.rect.height });
  }
  // 面积大的优先：采样点更多、抗锯齿影响更小（小图标在投影漂移下极易采偏）
  cands.sort((a, b) => b.area - a.area);
  return cands.slice(0, max).map(({ n }) => {
    const bs = n.boxStyle;
    const radius = bs?.cornerRadius ?? 0;
    const rawColor = bs?.fillType === 'SOLID' ? (bs.backgroundColor ?? null) : null;
    const color = rawColor && alphaOfHex(rawColor) >= 0.9 ? rawColor : null;
    return {
      id: `PX-${n.id}`,
      region: null,
      designBox: [n.rect.x, n.rect.y, n.rect.width, n.rect.height] as [number, number, number, number],
      expectedColorHex: color,
      expectedRadius: radius > 0 ? radius : null,
    };
  });
}

function buildNotes(
  profile: AcceptanceProfile,
  align: AlignOutput,
  designYLimit: number,
  issues: Issue[],
  reviewFailures: Array<{ regionId: string; label: string; reason: string }> = [],
  shape?: ReturnType<typeof shapeBoth>,
): string[] {
  const notes: string[] = [];
  notes.push(`验收前提（profile=${profile.name}）：`);
  for (const p of profile.preconditions ?? []) notes.push(`  · ${p}`);
  notes.push(
    `对齐口径：强锚点 ${align.strongAnchors.length} 组（流式层）+ ${align.fixedLayer.length} 组（固定层）；` +
      `Δy 中位数 ${align.residualMedian.toFixed(2)}px；有效拟合区间 [${align.usableRange.designY0.toFixed(0)}, ${align.usableRange.designY1.toFixed(0)}]；` +
      `App 截图像素覆盖到设计 y≈${designYLimit.toFixed(0)}。`,
  );
  const coverage = issues.filter((i) => i.category === 'coverage');
  if (coverage.length) {
    notes.push(`覆盖不足项 ${coverage.length} 条：这些区间**没有像素证据**，禁止判通过（已按 P0 输出）。`);
  }
  /**
   * L5（视口外）必须在这里显式声明。
   *
   * ⚠️ 不写的话「App 没有这些内容」会被读成结论 —— 而事实是
   * 「这些内容存在，只是截图没拍到、这次不参与验收」。这两句话对使用者的含义完全不同：
   * 前者是「要改 App」，后者是「要补截图」。
   */
  for (const [sideName, side] of [['App', shape?.app], ['设计稿', shape?.design]] as const) {
    const outside = side?.dropped.filter((d) => d.reason === 'outside-viewport').length ?? 0;
    if (outside > 0) {
      notes.push(
        `${sideName} 侧有 ${outside} 个节点完全在视口外，**未参与本次验收**` +
          `（它们真实存在，只是截图未覆盖）。若该页是长页面，需补滚动分段截图。`,
      );
    }
  }
  /**
   * 分区级失败必须出现在 notes 里 —— 否则就是「悄悄少审了几片」。
   *
   * ⚠️ 这段话是用户唯一能知道「AI 其实没审到这块」的途径：
   * 这些分区的 `validations` 是空的 ⇒ issue 的 `source` 停在 `rule`，
   * 报告里**不会**出现「AI 复核」字样，光看结论表看不出缺席。
   */
  if (reviewFailures.length) {
    notes.push(
      `⚠️ AI 评审有 ${reviewFailures.length} 片失败（其余分区照常出结论）：` +
      `${reviewFailures.map((f) => `${f.regionId} ${f.label}`).join('、')}。` +
      `这些区间的结论**未经 AI 复核**，只来自确定性规则通道。`,
    );
    for (const f of reviewFailures) notes.push(`  · ${f.regionId} ${f.label}：${f.reason}`);
  }
  return notes;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export type { Verdict };
