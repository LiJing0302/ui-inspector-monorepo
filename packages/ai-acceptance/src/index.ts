/**
 * @ui-inspector/ai-acceptance —— SAMA（结构锚定 + 分区 VLM 语义评审）
 *
 * 分层：
 *   L0 整形        shapeBoth()          —— 噪声剔除 / 归一化 / 固定层分离
 *   L1 对齐        alignAnchors()       —— 锚点保序拟合（PAVA），不是常量平移
 *   L2 分区        buildRegionSlices()  —— 区域切片 + 编号清单 + 规则初判
 *   L2' VLM        RegionReviewer       —— 三段式 Prompt + 编号回引门禁
 *   L3 合成        adjudicate()         —— 按 category 分权裁决
 *   M4 像素        runPixelChecks()     —— 颜色 / 圆角（App 盒样式覆盖率仅 9%）
 *
 * 纯核心（本文件导出的一切）**不依赖 node / electron**；I/O 在 `src/node/`、CLI 在 `src/cli.ts`。
 */

export * from './types.ts';

export { stripInvisible, toHalfWidth, normalizeText, textKey, digitMask, sameShapeDifferentValue, isNumericLike, detectDynamic, concatEquivalent, findConcatRun, BUILTIN_DYNAMIC_PATTERNS } from './text.ts';

export { parseColor, toHex, composite, rgbToLab, deltaE2000, deltaEHex, type Rgb, type Lab } from './color.ts';

export { shapeSide, shapeBoth, markDesignFixedByText, type ShapedBoth, type ShapeContext } from './l0.ts';

export {
  auditSide,
  auditClean,
  renderCleanAudit,
  TIER_RISK,
  type CleanAudit,
  type CleanRisk,
  type SideAudit,
  type TierAudit,
} from './clean-audit.ts';

export {
  buildMergedView,
  STACK_TOLERANCE,
  type MergeInput,
  type MergeKind,
  type MergeStats,
  type MergedNode,
} from './merge-view.ts';

export {
  isotonicNonDecreasing,
  buildProjector,
  alignAnchors,
  type Projection,
  type Projector,
  type AlignOptions,
  type AlignOutput,
} from './l1.ts';

export { buildRegionSlices, isPlaceholder, type RegionBuildArgs, type RegionBuildResult } from './l2.ts';

export {
  buildRegionPrompt,
  validateReview,
  MockRegionReviewer,
  type RegionPrompt,
  type MockReviewerOptions,
} from './reviewer.ts';

export { adjudicate, authorityOf, type AdjudicateArgs, type AdjudicationResult } from './l3.ts';

export {
  runPixelChecks,
  measureFillColor,
  measureCornerRadius,
  cropImage,
  type Sampler,
  type PixelThresholds,
  type PixelCheckInput,
  type PixelCheckContext,
} from './pixel.ts';

export { runAcceptance, type RunOptions, type RunResult } from './harness.ts';

export {
  createDefaultProfile,
  createBundleProfile2026_09_30,
  defaultDynamicPatterns,
  DEFAULT_NOISE_TEXTS,
  DEFAULT_CHROME_PATTERNS,
  BUNDLE_2026_09_30_REGIONS,
} from './profile.ts';

export { renderMarkdownReport } from './report.ts';
