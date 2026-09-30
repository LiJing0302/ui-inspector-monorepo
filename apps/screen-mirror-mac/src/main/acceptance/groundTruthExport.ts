/**
 * 标注包导出：把「人工点出来的匹配事实」+「引擎在同一批节点上的结论」+「全量可匹配节点」
 * 落成一份**自足** JSON。
 *
 * ## 为什么必须自足
 *
 * 这份文件的唯一读者是拿不到 App 现场的人（或模型）。任何「去看另一个文件才知道某条
 * 为什么算错」的设计都会让它失效 —— 而它本来就是为了替掉「人肉读几百行 match」这件事。
 * 所以节点一律带上可读信息（图层名 / 类名 / 文本 / 矩形 / 层级），而不是只留一串 id。
 *
 * ## 三段结构，各解决一个问题
 *
 *   1. `pairs` —— **答案**。人点过的每一组节点：它是什么形状、几何差多少、文案等不等、
 *      引擎在这批节点上给了什么结论、这个结论与答案一致还是一致相反。
 *      「引擎哪里错了」完全在这一段里就能读出来。
 *   2. `universe` —— **分母**。两侧全部「可匹配节点」（引擎同一口径：`participation=required`），
 *      每个节点标注它被标成了什么。
 *      ⚠️ 没有这一段就**算不出召回**：人标注时天然会先标看得懂、对得上的那些，
 *      被引擎漏掉的那些恰恰最可能没被标注，于是「只看标注」会系统性高估召回。
 *   3. `engine` —— **基线**。同一版引擎在这份数据上的完整匹配结论（含 missing / extra 全量）。
 *      有了它，「这条标注引擎没做到」与「这条标注引擎压根没考虑过」才分得开。
 *
 * ## 引擎基线**不含视觉度量**，这是刻意的
 *
 * 颜色 / pHash / SSIM 属于 `evaluateAcceptance` 那一层（判「长得像不像」），
 * 与「有没有配上」是两件事。这里要回答的是后者，所以基线只取 `matchDocuments` 的结果 ——
 * 它不依赖截图解码，**同一份数据任何时候跑都得到同一个答案**。
 * 混进视觉层反而会让这份文件随截图质量漂移，失去「基线」的意义。
 *
 * ## 但基线**包含人工锚点**
 *
 * `mapping`（人工锚点 / 忽略规则）会照常喂给引擎，因为那才是用户在工具里看到的结论。
 * 代价是准确率里有人工的功劳，所以必须在 `mapping` 字段里把「这次用了几个锚点」写出来 ——
 * 否则「引擎 0.9 准确率」会被当成引擎自己的水平，而它其实是「引擎 + 人给了 12 个锚点」。
 * 单看数字分不出来，这是必须显式写出来的原因。
 */

import type { CanonicalDocument, CanonicalNode } from '../../types/aiAcceptance';
import type {
  ExportGroundTruthInput,
  ExportGroundTruthResult,
  GroundTruthEngineMatch,
  GroundTruthEngineSummary,
  GroundTruthExportBundle,
  GroundTruthNodeRef,
  GroundTruthPairExport,
  GroundTruthPairGeometry,
  GroundTruthUniverseNode,
  GroundTruthVerdict,
} from '../../types/groundTruth';
import type { AppNode, DesignNode, Rect } from '../../types/verify';

import {
  canonicalizeApp,
  canonicalizeDesign,
  countMatchStatuses,
  matchDocuments,
} from './core';
import type { MatchTrace } from './core';
import {
  agreementOf,
  buildEngineIndex,
  emptyAgreementCounts,
  round,
  statusOf,
} from './agreement';
import { exportStamp, safeSegment } from './exportNaming';
import { readGroundTruth, readMapping } from './store';
import { writeFileAtomic } from '../store/atomic';
import { loadAppNodes, loadDesignNodes } from '../store/assets';
import { groundTruthExportsDir } from '../store/paths';
import { getRequirement } from '../store/workspace';
import {
  createPixelTransformContract,
  projectDesignRectByProfile,
  toPixelHostProfile,
} from './pixelTransform';

function rectCenter(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** 多个矩形的并集（多节点标注时两组各取一个盒子）。空集合给 null */
function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: round(minX), y: round(minY), width: round(maxX - minX), height: round(maxY - minY) };
}

function intersectionOverUnion(first: Rect | null, second: Rect | null): number | null {
  if (!first || !second) return null;
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  const overlapWidth = right - left;
  const overlapHeight = bottom - top;
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  const intersection = overlapWidth * overlapHeight;
  const union = first.width * first.height + second.width * second.height - intersection;
  return union > 0 ? round(intersection / union) : null;
}

function designLabel(node: DesignNode): string {
  return node.name?.trim() || node.type || node.id;
}

function appLabel(node: AppNode): string {
  const text = node.text?.trim();
  const label = [node.className, text ? `“${text.slice(0, 20)}”` : null].filter(Boolean).join(' ');
  return label || node.nodeId;
}

function nodeRef(node: CanonicalNode, label: string): GroundTruthNodeRef {
  return {
    canonicalId: node.canonicalId,
    label,
    // 用 rawText 而不是 normalizedText：后者是引擎内部分词用的（去空白 / 压空格），
    // 导出的读者要判断的是「这两处文案是不是同一句」，得看原文。
    text: node.content.rawText ?? null,
    rect: {
      x: round(node.rect.x),
      y: round(node.rect.y),
      width: round(node.rect.width),
      height: round(node.rect.height),
    },
    salience: node.salience,
    kind: node.kind,
    depth: node.depth,
    parentId: node.parentId,
    visible: node.visible,
    clipped: node.clipped,
  };
}


function uniqueSorted(values: readonly (string | null)[]): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (value && value.length > 0) set.add(value);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function geometryOf(
  designRects: readonly Rect[],
  appRects: readonly (Rect | null)[],
  design: CanonicalDocument,
  app: CanonicalDocument,
): GroundTruthPairGeometry {
  const hostProfile = toPixelHostProfile(app.hostProfile);
  const contract = app.pixelWidth
    ? createPixelTransformContract({
      basisWidth: design.width,
      viewportWidth: app.width,
      pixelWidth: app.pixelWidth,
      hostProfile,
    })
    : null;
  const designUnion = contract
    ? unionRect(designRects.map((rect) => projectDesignRectByProfile(rect, contract, hostProfile)))
    : unionRect(designRects);
  const appUnion = contract && appRects.every((rect) => rect !== null)
    ? unionRect(appRects as Rect[])
    : null;
  // 同一个字段在两种情形下单位不同（设计单位 / App 物理像素），必须自报家门。
  const unit: GroundTruthPairGeometry['unit'] = contract ? 'app-pixel' : 'design-unit';
  if (!designUnion || !appUnion) {
    return { unit, designUnion, appUnion, iou: null, centerDelta: null, sizeDelta: null };
  }
  const designCenter = rectCenter(designUnion);
  const appCenter = rectCenter(appUnion);
  return {
    unit,
    designUnion,
    appUnion,
    iou: intersectionOverUnion(designUnion, appUnion),
    // 正值 = 设计侧更靠右 / 更靠下（与 `Rect.x/y` 的直觉一致）
    centerDelta: { dx: round(designCenter.x - appCenter.x), dy: round(designCenter.y - appCenter.y) },
    sizeDelta: {
      dw: round(designUnion.width - appUnion.width),
      dh: round(designUnion.height - appUnion.height),
    },
  };
}

function shapeOf(designCount: number, appCount: number): string {
  return `${designCount}:${appCount}`;
}

function emptyVerdictCounts(): Record<GroundTruthVerdict, number> {
  return { matched: 0, 'no-counterpart': 0, ignore: 0 };
}

/**
 * 组装并落盘一份标注包。
 *
 * 与配对调试包相反，这里**没有任何标注就抛错**而不是导出一份空壳：
 * 文件名写着 ground-truth 却没有一条 ground truth，只会让人以为「导出坏了」，
 * 或者把里面那段「引擎基线」误当成「已经比对过的结论」。
 */
export async function exportGroundTruth(
  input: ExportGroundTruthInput,
): Promise<ExportGroundTruthResult> {
  const requirement = await getRequirement(input.requirementId);
  if (!requirement) throw new Error(`需求不存在：${input.requirementId}`);

  const pair = requirement.pairs.find((item) => item.id === input.pairId);
  if (!pair) throw new Error(`配对不存在：${input.pairId}`);

  const design = requirement.designAssets.find((asset) => asset.id === pair.designAssetId);
  const snapshot = requirement.appSnapshots.find((item) => item.id === pair.appSnapshotId);
  if (!design || !snapshot) throw new Error('配对引用的设计稿或截图已不存在，无法导出');

  const [designNodes, appNodes, groundTruth, mapping] = await Promise.all([
    loadDesignNodes(requirement.id, design),
    loadAppNodes(requirement.id, snapshot),
    readGroundTruth(requirement.id, pair.id),
    readMapping(requirement.id, pair.id),
  ]);

  if (!groundTruth || groundTruth.pairs.length === 0) {
    throw new Error('这个配对还没有任何标注，先在画布上点选出至少一组再导出');
  }

  const designDocument = canonicalizeDesign(designNodes, design.width, design.height);
  const appDocument = canonicalizeApp(
    appNodes,
    snapshot.width,
    snapshot.height,
    snapshot.pixelWidth,
    snapshot.pixelHeight,
  );

  const trace: MatchTrace = { scopedDesign: new Set(), scopedApp: new Set() };
  const matches = matchDocuments(designDocument, appDocument, mapping ?? undefined, trace);
  const engineIndex = buildEngineIndex(matches);

  const designById = new Map(designDocument.nodes.map((node) => [node.canonicalId, node]));
  const appById = new Map(appDocument.nodes.map((node) => [node.canonicalId, node]));
  const designLabels = new Map<string, string>(
    designNodes.map((node) => [`design:${node.id}`, designLabel(node)]),
  );
  const appLabels = new Map<string, string>(
    appNodes.map((node) => [`app:${node.nodeId}`, appLabel(node)]),
  );

  const verdictCounts = emptyVerdictCounts();
  const agreementCounts = emptyAgreementCounts();
  /** 只看人工确认项的分布。**决策看这一份**，理由见 `GroundTruthExportMetrics.prefilledPairs` */
  const agreementHuman = emptyAgreementCounts();
  const annotated = new Map<string, GroundTruthVerdict>();
  const exportPairs: GroundTruthPairExport[] = [];
  let annotatedDesignNodes = 0;
  let annotatedAppNodes = 0;
  let prefilledPairs = 0;

  for (const item of groundTruth.pairs) {
    for (const id of item.designNodeIds) annotated.set(id, item.verdict);
    for (const id of item.appNodeIds) annotated.set(id, item.verdict);
    verdictCounts[item.verdict] += 1;
    // 缺省视为人工：老文件里没有这个字段，而它们当初确实是手点出来的
    const origin = item.origin ?? 'human';
    if (origin === 'engine-prefill') prefilledPairs += 1;

    const unresolvedNodeIds: string[] = [];
    const designRefs: GroundTruthNodeRef[] = [];
    const appRefs: GroundTruthNodeRef[] = [];
    const designRects: Rect[] = [];
    const appRects: (Rect | null)[] = [];

    for (const id of item.designNodeIds) {
      const node = designById.get(id);
      if (!node) {
        unresolvedNodeIds.push(id);
        continue;
      }
      designRefs.push(nodeRef(node, designLabels.get(id) ?? id));
      designRects.push(node.rect);
      annotatedDesignNodes += 1;
    }
    for (const id of item.appNodeIds) {
      const node = appById.get(id);
      if (!node) {
        unresolvedNodeIds.push(id);
        continue;
      }
      appRefs.push(nodeRef(node, appLabels.get(id) ?? id));
      appRects.push(node.pixelRect ?? null);
      annotatedAppNodes += 1;
    }

    const designStatuses = item.designNodeIds.map((id) => statusOf(engineIndex, id));
    const appStatuses = item.appNodeIds.map((id) => statusOf(engineIndex, id));
    const agreement = agreementOf(item, designStatuses, appStatuses);
    agreementCounts[agreement] += 1;
    if (origin === 'human') agreementHuman[agreement] += 1;

    const designSet = new Set(item.designNodeIds);
    const appSet = new Set(item.appNodeIds);
    const matchIds = matches
      .filter(
        (match) =>
          match.designNodeIds.some((id) => designSet.has(id)) ||
          match.appNodeIds.some((id) => appSet.has(id)),
      )
      .map((match) => match.id);

    const designTexts = uniqueSorted(designRefs.map((ref) => ref.text));
    const appTexts = uniqueSorted(appRefs.map((ref) => ref.text));

    exportPairs.push({
      id: item.id,
      verdict: item.verdict,
      origin,
      ...(item.note ? { note: item.note } : {}),
      createdAt: item.createdAt,
      shape: shapeOf(item.designNodeIds.length, item.appNodeIds.length),
      unresolvedNodeIds,
      design: designRefs,
      app: appRefs,
      geometry: geometryOf(designRects, appRects, designDocument, appDocument),
      text: {
        designTexts,
        appTexts,
        equal:
          designTexts.length === appTexts.length &&
          designTexts.every((value, index) => value === appTexts[index]),
        bothEmpty: designTexts.length === 0 && appTexts.length === 0,
      },
      engine: {
        agreement,
        designStatuses,
        appStatuses,
        matchIds,
      },
    });
  }

  const designUniverse = buildUniverse(designDocument, designLabels, annotated, {
    width: design.width,
    height: design.height,
  });
  const appUniverse = buildUniverse(appDocument, appLabels, annotated, {
    width: snapshot.width,
    height: snapshot.height,
  });
  const coveredDesign = designUniverse.filter((node) => node.annotated !== null).length;
  const coveredApp = appUniverse.filter((node) => node.annotated !== null).length;
  const viewportDesign = designUniverse.filter((node) => node.inViewport);
  const viewportApp = appUniverse.filter((node) => node.inViewport);
  const coveredDesignViewport = viewportDesign.filter((node) => node.annotated !== null).length;
  const coveredAppViewport = viewportApp.filter((node) => node.annotated !== null).length;

  const summary: GroundTruthEngineSummary = {
    designNodeCount: designDocument.nodes.length,
    appNodeCount: appDocument.nodes.length,
    matchedCount: matches.filter((match) => match.status === 'matched').length,
    missingCount: matches.filter((match) => match.status === 'missing').length,
    extraCount: matches.filter((match) => match.status === 'extra').length,
    ambiguousCount: matches.filter((match) => match.status === 'ambiguous').length,
  };

  const engineMatches: GroundTruthEngineMatch[] = matches.map((match) => ({
    id: match.id,
    status: match.status,
    relation: match.relation,
    ...(match.origin ? { origin: match.origin } : {}),
    designNodeIds: [...match.designNodeIds],
    appNodeIds: [...match.appNodeIds],
    confidence: round(match.confidence),
  }));

  const bundle: GroundTruthExportBundle = {
    kind: 'ui-acceptance-ground-truth',
    version: 1,
    exportedAt: new Date().toISOString(),
    requirement: { id: requirement.id, name: requirement.name },
    pair: { id: pair.id, designName: design.name, appName: snapshot.label ?? snapshot.id },
    canvas: {
      design: { width: design.width, height: design.height },
      app: { width: snapshot.width, height: snapshot.height },
    },
    metrics: {
      annotatedPairs: exportPairs.length,
      matched: verdictCounts.matched,
      noCounterpart: verdictCounts['no-counterpart'],
      ignore: verdictCounts.ignore,
      prefilledPairs,
      agreement: agreementCounts,
      agreementHuman,
      designNodeCount: annotatedDesignNodes,
      appNodeCount: annotatedAppNodes,
      designCoverage: ratio(coveredDesign, designUniverse.length),
      appCoverage: ratio(coveredApp, appUniverse.length),
      universe: { design: designUniverse.length, app: appUniverse.length },
      // 视口口径：**判断引擎水平看这两个**。App 截图是视口，视口外的节点人标不到，
      // 拿全量当分母会把它们算成引擎漏检（实测 app 344 → 173，覆盖率 22.4% → 44%）。
      universeViewport: { design: viewportDesign.length, app: viewportApp.length },
      designCoverageViewport: ratio(coveredDesignViewport, viewportDesign.length),
      appCoverageViewport: ratio(coveredAppViewport, viewportApp.length),
      engine: { summary, statusCounts: countMatchStatuses(matches) },
    },
    pairs: exportPairs,
    universe: { design: designUniverse, app: appUniverse },
    mapping: mapping
      ? {
          anchors: mapping.anchors.length,
          ignoredDesignNodes: mapping.ignoredDesignNodeIds.length,
          ignoredAppNodes: mapping.ignoredAppNodeIds.length,
          manualMatches: mapping.matches.filter((match) => match.source === 'manual').length,
        }
      : null,
    engine: {
      summary,
      statusCounts: countMatchStatuses(matches),
      totalMatches: matches.length,
      matches: engineMatches,
    },
  };

  const file = `${groundTruthExportsDir()}/${safeSegment(requirement.name, 'requirement')}-${safeSegment(
    design.name,
    'pair',
  )}-ground-truth-${exportStamp()}.json`;
  const payload = `${JSON.stringify(bundle, null, 2)}\n`;
  await writeFileAtomic(file, payload);

  return {
    file,
    bytes: Buffer.byteLength(payload, 'utf8'),
    pairCount: exportPairs.length,
    verdictCounts,
    agreementCounts,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

/**
 * 矩形是否**完整**落在画布 / 视口内。
 *
 * 用「完整包含」而不是「有交集」：被折叠线切掉一半的元素，人能看到的只是残缺的一角，
 * 标它或者不标它都不算错 —— 用「有交集」会把它们算进分母，制造一批无法归因的漏检。
 * 容差 2px 用来吸收圆角、描边、以及两侧取整方式不同带来的边界抖动。
 */
function isInsideViewport(rect: { x: number; y: number; width: number; height: number }, canvas: { width: number; height: number }): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  if (rect.width <= 0 || rect.height <= 0) return false;
  const tolerance = 2;
  return rect.x >= -tolerance
    && rect.y >= -tolerance
    && rect.x + rect.width <= canvas.width + tolerance
    && rect.y + rect.height <= canvas.height + tolerance;
}

/**
 * 可匹配节点清单。
 *
 * 口径是 `participation === 'required'` —— 与引擎判 missing / extra 用的是**同一个字段**
 * （见 `evaluateAcceptance` 里那两处 `participation === 'required'`）。
 * 不能自己另立一套（例如「可见且面积够大」）：分母一旦与引擎的口径错开，
 * 算出来的召回就会把一个口径差当成引擎的漏检，越调越歪。
 *
 * ⚠️ 分母**还要再分一层视口内外**（`inViewport`）。全量口径本身没错 —— 引擎确实会去匹配
 * 视口外的节点（App 树是整页树，设计稿也是整页）—— 错的是拿它当**人工标注**的对照基准：
 * 视口外的节点人标不到，那条分母上永远拿不到正确答案。两个口径都给，差值本身就是信号。
 */
function buildUniverse(
  document: CanonicalDocument,
  labels: ReadonlyMap<string, string>,
  annotated: ReadonlyMap<string, GroundTruthVerdict>,
  canvas: { width: number; height: number },
): GroundTruthUniverseNode[] {
  return document.nodes
    .filter((node) => node.participation === 'required')
    .map((node) => ({
      ...nodeRef(node, labels.get(node.canonicalId) ?? node.canonicalId),
      annotated: annotated.get(node.canonicalId) ?? null,
      inViewport: isInsideViewport(node.rect, canvas),
    }))
    // 按阅读顺序排（上到下、左到右）：这份清单是给人看的，不是给机器查的
    .sort((first, second) => first.rect.y - second.rect.y || first.rect.x - second.rect.x);
}
