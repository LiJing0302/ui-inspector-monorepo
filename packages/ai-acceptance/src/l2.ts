/**
 * L2 分区评审 —— 切片、编号清单、规则初判
 *
 * 对应报告 §3.3。核心主张：**不把两张整图丢给模型问"一样吗"**，
 * 而是切区域 + 给编号清单，让模型的输出可以被即时校验。
 *
 * 本文件只做确定性部分（切片 / 配对 / 规则初判），VLM 调用在 reviewer.ts。
 */

import type {
  AcceptanceProfile,
  MarkItem,
  NormNode,
  RegionDef,
  RegionSlice,
  RuleVerdict,
  ShapedSide,
} from './types.ts';
import type { AlignOutput } from './l1.ts';
import { detectDynamic, findConcatRun, sameShapeDifferentValue } from './text.ts';

export interface RegionBuildArgs {
  design: ShapedSide;
  app: ShapedSide;
  align: AlignOutput;
  profile: AcceptanceProfile;
  designScale: number;
  appScale: number;
  /** 每片最多产出多少条"盒样式待像素判定"的条目（防爆） */
  maxBoxItemsPerRegion?: number;
}

export interface RegionBuildResult {
  slices: RegionSlice[];
  noPixelEvidence: Array<{ designY0: number; designY1: number; reason: string }>;
  /** App 截图能覆盖到的设计 y 上限（二分求逆投影得到） */
  designYLimit: number;
}

/** 几何容差：同排配对的 Δy 上限（设计逻辑像素） */
const ROW_BAND = 14;

export function buildRegionSlices(args: RegionBuildArgs): RegionBuildResult {
  const { design, app, align, profile, designScale, appScale } = args;
  const maxBox = args.maxBoxItemsPerRegion ?? 8;
  const tol = profile.thresholds?.geometryTolerance ?? 4;

  // 投影逆：App 可视高度对应的设计 y 上限
  const designYLimit = invertProjection(align, app.viewportHeight, design.docHeight);

  const envRules: EnvRule[] = (profile.declaredEnvironmental ?? []).map((r) => ({
    re: r.pattern ? safeRegExp(r.pattern) : null,
    reason: r.reason,
    regions: r.regions && r.regions.length ? new Set(r.regions) : null,
  }));

  const regions = profile.regions ?? autoRegions(design);

  // 锚点索引
  const anchorByDesignId = new Map<string, string>();
  for (const a of [...align.strongAnchors, ...align.fixedLayer]) anchorByDesignId.set(a.designId, a.appId);

  const appById = new Map(app.nodes.map((n) => [n.id, n]));

  const slices: RegionSlice[] = [];
  const noPixelEvidence: RegionBuildResult['noPixelEvidence'] = [];

  for (const region of regions) {
    const inRegion = (n: NormNode): boolean => n.rect.y + n.rect.height > region.designY0 && n.rect.y < region.designY1;

    // 固定层与流式层必须分开：
    //   a) 含 tab bar 的大区间（如 R8 精选好物）**不能**被判为"固定区"，否则 pixelCoverage 被强制为 1、noPixelEvidence 被吞掉（实测踩过）；
    //   b) 判据只看**文本节点**（容器不受 L0 反标影响）：整区文本全部为 fixed 才算固定区。
    const dAll = design.nodes.filter(inRegion);
    const fixedTextsInRegion = dAll.filter((n) => n.kind === 'text' && n.text);
    const isFixedRegion = fixedTextsInRegion.length > 0 && fixedTextsInRegion.every((n) => n.layer === 'fixed');
    const dNodes = isFixedRegion ? dAll : dAll.filter((n) => n.layer !== 'fixed');

    // ---- App 侧对齐带 ----
    const band = appBandForRegion(region, align, isFixedRegion, app.viewportHeight);

    const aNodes = app.nodes.filter((n) => {
      // 固定层区域只比 App 的**固定层**节点；非固定层区域**排除** App 固定层节点。
      // 否则 App 带会顺带吞进 tab bar（表现为 R6 "App 多出 首页/分类/..."）或上一屏流式文本
      // （表现为 R9 "App 多出 收费标准/常见故障/..."）—— 两个方向实测都踩过。
      if (isFixedRegion !== (n.layer === 'fixed')) return false;
      const cy = n.rect.y + n.rect.height / 2;
      return cy >= band.y0 && cy <= band.y1;
    });

    const dTexts = dNodes.filter((n) => n.kind === 'text' && n.text).sort(byPos);
    const aTexts = aNodes.filter((n) => n.kind === 'text' && n.text).sort(byPos);

    const items: MarkItem[] = [];
    const usedApp = new Set<string>();
    const usedDesign = new Set<string>();
    let counter = 0;
    const nextId = () => `${region.regionId}-${String(++counter).padStart(2, '0')}`;

    const mkItem = (
      kind: MarkItem['kind'],
      d: NormNode | null,
      a: NormNode | null,
      verdict: RuleVerdict,
      reason: string,
    ): MarkItem => {
      // ⚠️ designBox 必须是**设计逻辑坐标**（与 appBox 同口径）。
      // 早期写成 `toBox(d.rect, designScale)`（物理像素）→ 与 appBox 差 2 倍，
      // 于是每个节点都被判成"宽度差 50%"、Δy 差 −430px（实测踩过）。
      const designBox = d ? toBox(d.rect, 1) : null;
      const appBox = a ? toDesignBox(a.rect, align, design, tol, appScale, d?.rect.y) : null;
      const delta =
        designBox && appBox
          ? {
              dx: round1(appBox[0] - designBox[0]),
              dy: round1(appBox[1] - designBox[1]),
              dw: round1(appBox[2] - designBox[2]),
              dh: round1(appBox[3] - designBox[3]),
            }
          : null;
      const hasPixelEvidence = !!(d ? d.inPixels : a ? a.inPixels : false);
      return {
        markId: nextId(),
        regionId: region.regionId,
        kind,
        // 原始节点 id 随 mark 一起带走 —— 消费侧的节点索引只按 id 查，
        // 下面的 designBox/appBox 是坐标（且 appBox 已被投影到设计坐标系），
        // 都不能替代 id 来定位节点。见 MarkItem#designId 注释。
        designId: d?.id ?? null,
        appId: a?.id ?? null,
        designText: d?.text ?? null,
        appText: a?.text ?? null,
        designBox,
        appBox,
        delta,
        ruleVerdict: verdict,
        ruleReason: reason,
        hasPixelEvidence,
        participation: a?.participation ?? null,
      };
    };

    // ---- Pass A：锚点直接命中 ----
    for (const d of dTexts) {
      const appId = anchorByDesignId.get(d.id);
      if (!appId) continue;
      const a = appById.get(appId);
      if (!a) continue;
      usedDesign.add(d.id);
      usedApp.add(a.id);
      const item = mkItem('text', d, a, 'ok', '文本锚点命中');
      // 宽度差过大 = 节点粒度差异（实测：设计「专属服务」宽 40 ↔ App 同文本宽 313）
      const dw = item.delta?.dw ?? 0;
      const designW = item.designBox?.[2] ?? 0;
      if (designW > 0 && Math.abs(dw) > designW * 0.5 + 6) {
        item.ruleVerdict = 'geometry-off';
        item.ruleReason = `文本相同但宽度差 ${dw.toFixed(1)}px（设计 ${designW}px）→ 节点粒度/尺寸不一致`;
      }
      items.push(item);
    }

    // ---- Pass C：设计多节点 ↔ App 单节点（拼接等价，粒度差异）----
    // ⚠️ 必须跑在 Pass B 之前。否则设计「10年包修」会先被同排配对判成 text-mismatch，
    // App 单节点「10年包修&10年免费上门检测」就永远匹配不上，退化成「缺失」（实测踩过）。
    {
      const dTextsAll = dTexts.map((n) => n.text as string);
      for (const a of [...aTexts]) {
        if (usedApp.has(a.id)) continue;
        const idxRun = findConcatRun(dTextsAll, a.text ?? '');
        if (!idxRun) continue;
        const runNodes = idxRun.map((i) => dTexts[i]).filter((n) => !usedDesign.has(n.id));
        if (runNodes.length !== idxRun.length) continue; // 有节点已被占用，放弃
        for (const n of runNodes) usedDesign.add(n.id);
        usedApp.add(a.id);
        const joined = runNodes.map((n) => n.text).join('');
        items.push(
          mkItem('text', runNodes[0], a, 'ok', `结构粒度差异（设计 ${runNodes.length} 节点拼接「${joined}」= App 单节点），不判缺失`),
        );
      }
    }

    // ---- Pass B：同排槽位贪心配对 ----
    const dRest = dTexts.filter((n) => !usedDesign.has(n.id));
    const aRest = aTexts.filter((n) => !usedApp.has(n.id));
    const pairs = pairByRow(dRest, aRest, align, app, tol);
    for (const { d, a } of pairs) {
      usedDesign.add(d.id);
      usedApp.add(a.id);
      if (d.text === a.text) {
        const item = mkItem('text', d, a, 'ok', '同排文本一致');
        if (item.delta && Math.abs(item.delta.dy) > tol) {
          item.ruleVerdict = 'geometry-off';
          item.ruleReason = `同排文本一致但局部 Δy=${item.delta.dy}px（容差 ${tol}px）`;
        }
        items.push(item);
        continue;
      }
      const envHit =
        matchEnvRule(a.text ?? '', envRules, region.regionId) ??
        matchEnvRule(d.text ?? '', envRules, region.regionId);
      if (envHit) {
        items.push(mkItem('text', d, a, 'environmental', `环境态：${envHit}`));
        continue;
      }
      if (sameShapeDifferentValue(d.text ?? '', a.text ?? '')) {
        items.push(mkItem('text', d, a, 'dynamic', '格式一致、取值不同（动态位）'));
        continue;
      }
      items.push(mkItem('text', d, a, 'text-mismatch', `文案不一致：设计「${d.text}」↔ App「${a.text}」`));
    }

    // ---- Pass D：剩余 ----
    // 环境态判定顺序：**文本级**（更具体）优先于**区域级**（整区豁免）
    const regionEnv = matchRegionEnv(region.regionId, envRules);
    // App 侧的"占位符"节点（数据未加载时 App 会渲染 `-`）：同排若有占位符，
    // 设计侧那一排的计数/单位（`13`/`张`/`5`/`张`）不应被判为"缺失"——实测这些全是数据态。
    const placeholderRows = aTexts.filter((n) => isPlaceholder(n.text ?? '')).map((n) => n.rect.y);
    const hasPlaceholderInRow = (designY: number): boolean => {
      const p = align.projectY(designY).appY;
      return placeholderRows.some((y) => Math.abs(y - p) <= ROW_BAND);
    };
    for (const d of dTexts) {
      if (usedDesign.has(d.id)) continue;
      usedDesign.add(d.id);
      const envHit = matchEnvRule(d.text ?? '', envRules, region.regionId);
      if (envHit) {
        items.push(mkItem('text', d, null, 'environmental', `环境态：${envHit}`));
        continue;
      }
      if (regionEnv) {
        items.push(mkItem('text', d, null, 'environmental', `区域级环境态声明：${regionEnv}`));
        continue;
      }
      if (hasPlaceholderInRow(d.rect.y)) {
        items.push(mkItem('text', d, null, 'environmental', '环境态：App 同排渲染了占位符（数据未加载），不计差异'));
        continue;
      }
      // 动态位（价格/数量/距离/时间）在**未配对**时也降级为 P2 待确认，而不是判"缺失"
      // —— 报告 §3.3 P2 阶段的要求：先看它是不是动态位，再谈缺陷。
      const dyn = detectDynamic(d.text ?? '', profile.dynamicPatterns);
      if (dyn.length) {
        items.push(mkItem('text', d, null, 'dynamic', `未配对，但形如动态位（${dyn.join('/')}）→ 降级为待确认，不判缺失`));
        continue;
      }
      const pred = align.projectY(d.rect.y);
      const reason = d.inPixels
        ? '设计侧存在、App 侧无对应文本'
        : '设计侧该节点本身就在截图之外，且 App 无对应文本';
      items.push(mkItem('text', d, null, 'missing', `${reason}（预测 App y≈${pred.appY.toFixed(0)}，置信 ${pred.confidence.toFixed(2)}）`));
    }
    for (const a of aTexts) {
      if (usedApp.has(a.id)) continue;
      usedApp.add(a.id);
      const envHit = matchEnvRule(a.text ?? '', envRules, region.regionId);
      if (envHit) {
        items.push(mkItem('text', null, a, 'environmental', `环境态：${envHit}`));
        continue;
      }
      if (regionEnv) {
        items.push(mkItem('text', null, a, 'environmental', `区域级环境态声明：${regionEnv}`));
        continue;
      }
      items.push(mkItem('text', null, a, 'missing', 'App 侧多出该文本，设计稿无对应'));
    }

    // ---- 盒样式待像素判定（颜色/圆角：App 树覆盖率仅 9%）----
    if (maxBox > 0) {
      const dBoxes = dNodes
        .filter((n) => n.boxStyle && (n.boxStyle.cornerRadius ?? 0) > 0 && n.inPixels)
        .sort(byPos)
        .slice(0, maxBox);
      for (const d of dBoxes) {
        items.push(
          mkItem('box', d, null, 'unjudgeable', `设计声明圆角 ${d.boxStyle?.cornerRadius}px / 填充 ${d.boxStyle?.backgroundColor ?? 'n/a'}；App 节点树无盒样式声明 → 需像素通道`),
        );
      }
    }

    // ---- 区域级信号 ----
    const dynamicHints = uniq(
      [...dTexts, ...aTexts]
        .map((n) => n.text as string)
        .filter((t) => detectDynamic(t, profile.dynamicPatterns).length > 0),
    ).slice(0, 12);

    const envHints = uniq(
      [
        ...[...dTexts, ...aTexts]
          .map((n) => n.text as string)
          .filter((t) => matchEnvRule(t, envRules, region.regionId) !== null),
        ...(regionEnv ? [`[整区] ${regionEnv}`] : []),
      ],
    ).slice(0, 12);

    const dRange = region.designY1 - region.designY0;
    const covered = Math.max(0, Math.min(region.designY1, designYLimit) - region.designY0);
    const pixelCoverage = isFixedRegion ? 1 : dRange > 0 ? round2(covered / dRange) : 0;
    const noPx = !isFixedRegion && pixelCoverage <= 0.001;

    if (noPx) {
      noPixelEvidence.push({
        designY0: region.designY0,
        designY1: region.designY1,
        reason: `设计 y∈[${region.designY0}, ${region.designY1}] 在 App 截图中无像素证据（App 截图仅覆盖到设计 y≈${designYLimit.toFixed(0)}）`,
      });
    }

    slices.push({
      region,
      designCropPx: [
        Math.round(0 * designScale),
        Math.round(region.designY0 * designScale),
        Math.round(design.viewportWidth * designScale),
        Math.round((region.designY1 - region.designY0) * designScale),
      ],
      appCropPx: noPx
        ? null
        : [
            0,
            Math.round(band.y0 * appScale),
            Math.round(app.viewportWidth * appScale),
            Math.round((band.y1 - band.y0) * appScale),
          ],
      items,
      dynamicHints,
      envHints,
      noPixelEvidence: noPx,
      pixelCoverage,
    });
  }

  return { slices, noPixelEvidence: mergeRanges(noPixelEvidence), designYLimit };
}

/* --------------------------------------------------------------------------- */

function byPos(a: NormNode, b: NormNode): number {
  return a.rect.y - b.rect.y || a.rect.x - b.rect.x;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

function safeRegExp(p: string): RegExp | null {
  try {
    return new RegExp(p);
  } catch {
    return null;
  }
}

function matchEnvRule(text: string, rules: EnvRule[], regionId?: string): string | null {
  for (const r of rules) {
    if (r.regions && regionId && !r.regions.has(regionId)) continue;
    if (r.re && r.re.test(text)) return r.reason;
  }
  return null;
}

/** 区域级豁免：`regions` 命中且**没有** pattern 的规则 → 该区整区不做逐条文案比对 */
function matchRegionEnv(regionId: string, rules: EnvRule[]): string | null {
  for (const r of rules) {
    if (!r.re && r.regions && r.regions.has(regionId)) return r.reason;
  }
  return null;
}

interface EnvRule {
  re: RegExp | null;
  reason: string;
  regions: Set<string> | null;
}

/** App 侧的"数据未加载"占位符（实测：设计 `13张` ↔ App `-`） */
const PLACEHOLDER = /^(-{1,2}|—{1,2}|--|暂无|loading|加载中)$/i;
export function isPlaceholder(t: string): boolean {
  return PLACEHOLDER.test(t.trim());
}

/** 逻辑矩形 → [x,y,w,h]（物理像素口径，供裁图使用） */
function toBox(r: { x: number; y: number; width: number; height: number }, scale: number): [number, number, number, number] {
  return [Math.round(r.x * scale), Math.round(r.y * scale), Math.round(r.width * scale), Math.round(r.height * scale)];
}

/**
 * App 侧矩形 → **设计逻辑坐标**（用于几何比对）。
 *
 * y 有两套口径：
 *   - **成对项**（已知设计 y）：用「设计 y + (App 实测 y − 拟合预测 y) / 纵向比」，
 *     得到的是**相对拟合曲线的局部残差**，这才是"几何偏差"的语义；
 *   - **仅 App 项**（无设计对应）：只能二分求逆（`invertY`）。
 *     ⚠️ 逆映射在有断点的区间上可能落到错误分支，实测会产出 Δy=−429.9 这种明显假的配对残差。
 *
 * x / w / h 一律按 App→设计 的逻辑比映射（`appToDesignX`，实测 1.0417 = 1/0.96）。
 */
function toDesignBox(
  r: { x: number; y: number; width: number; height: number },
  align: AlignOutput,
  design: ShapedSide,
  tol: number,
  _appScale: number,
  pairDesignY?: number,
): [number, number, number, number] {
  void tol;
  void _appScale;
  const kx = align.appToDesignX;
  const dy =
    pairDesignY !== undefined
      ? pairDesignY + (r.y - align.projectY(pairDesignY).appY) / (kx || 1)
      : invertY(align, r.y, design.docHeight);
  return [round1(r.x * kx + align.xOffset), round1(dy), round1(r.width * kx), round1(r.height * kx)];
}

function invertY(align: AlignOutput, appY: number, docHeight: number): number {
  let lo = 0;
  let hi = docHeight;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (align.projectY(mid).appY < appY) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function invertProjection(align: AlignOutput, appViewportHeight: number, docHeight: number): number {
  return invertY(align, appViewportHeight, docHeight);
}

/**
 * App 侧对齐带。
 *
 * 铁律：**必须以投影为主**。只用"落在本区的强锚点"会把带子压扁成一条线
 * （实测 R2 会员卡只有「立即升级」一个锚点 → 带子 [113,151]，会员卡下半屏的 App 文案
 *  全部落在带外，被误判为"App 缺失"）。锚点只用来把带子**加宽**，不用来定义它。
 */
function appBandForRegion(
  region: RegionDef,
  align: AlignOutput,
  isFixedRegion: boolean,
  appViewportHeight: number,
): { y0: number; y1: number } {
  if (isFixedRegion) {
    return { y0: Math.max(0, appViewportHeight - 90), y1: appViewportHeight };
  }
  const p0 = align.projectY(region.designY0).appY;
  const p1 = align.projectY(region.designY1).appY;
  let y0 = Math.min(p0, p1) - 12;
  let y1 = Math.max(p0, p1) + 12;
  const inBand = align.strongAnchors.filter((a) => a.designY >= region.designY0 && a.designY < region.designY1);
  for (const a of inBand) {
    y0 = Math.min(y0, a.appY - 8);
    y1 = Math.max(y1, a.appY + 22);
  }
  y0 = Math.max(0, y0);
  y1 = Math.min(appViewportHeight, y1);
  if (y1 <= y0 + 4) return { y0: 0, y1: 0 }; // 空带（区域整体在截图之外）
  return { y0, y1 };
}

/** 同排贪心配对：Δy 越小越优先，其次 Δx */
function pairByRow(
  dRest: NormNode[],
  aRest: NormNode[],
  align: AlignOutput,
  app: ShapedSide,
  tol: number,
): Array<{ d: NormNode; a: NormNode }> {
  interface Cand {
    d: NormNode;
    a: NormNode;
    dy: number;
    cost: number;
  }
  const cands: Cand[] = [];
  for (const d of dRest) {
    for (const a of aRest) {
      const aDesignY = align.projectY(d.rect.y).appY;
      const dy = a.rect.y - aDesignY;
      const aDesignX = a.rect.x * align.appToDesignX + align.xOffset;
      const dx = aDesignX - d.rect.x;
      if (Math.abs(dy) > ROW_BAND) continue;
      if (Math.abs(dx) > Math.max(60, d.rect.width)) continue;
      cands.push({ d, a, dy, cost: Math.abs(dy) * 1 + Math.abs(dx) * 0.5 });
    }
  }
  cands.sort((p, q) => p.cost - q.cost);
  const usedD = new Set<string>();
  const usedA = new Set<string>();
  const out: Array<{ d: NormNode; a: NormNode }> = [];
  for (const c of cands) {
    if (usedD.has(c.d.id) || usedA.has(c.a.id)) continue;
    usedD.add(c.d.id);
    usedA.add(c.a.id);
    out.push({ d: c.d, a: c.a });
  }
  void tol;
  void app;
  return out;
}

/** 无 profile 分区时的兜底：按设计稿浅层容器切 8 段 */
function autoRegions(design: ShapedSide): RegionDef[] {
  const tops = design.nodes
    .filter((n) => n.depth <= 2 && n.layer === 'flow' && n.rect.height > 40)
    .sort((a, b) => a.rect.y - b.rect.y);
  const bands: RegionDef[] = [];
  let i = 0;
  for (const t of tops) {
    if (bands.length && bands[bands.length - 1].designY1 >= t.rect.y - 4) continue;
    bands.push({
      regionId: `A${++i}`,
      label: `自动分区 ${i}`,
      designY0: Math.round(t.rect.y),
      designY1: Math.round(t.rect.y + t.rect.height),
    });
  }
  return bands.length ? bands : [{ regionId: 'A1', label: '整页', designY0: 0, designY1: design.docHeight }];
}

function mergeRanges(
  xs: Array<{ designY0: number; designY1: number; reason: string }>,
): Array<{ designY0: number; designY1: number; reason: string }> {
  if (xs.length <= 1) return xs;
  const sorted = [...xs].sort((a, b) => a.designY0 - b.designY0);
  const out: typeof sorted = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && g.designY0 <= last.designY1 + 1) last.designY1 = Math.max(last.designY1, g.designY1);
    else out.push({ ...g });
  }
  return out;
}
