/**
 * 人工标注（ground truth）：**事实**，不是**输入**。
 *
 * ## 为什么单独一套模型，而不是复用 `NodeMapping`
 *
 * `NodeMapping` 是**给引擎的输入** —— 里面的 `anchors` 会被当成已确认锚点直接生效、
 * `ignoredDesignNodeIds` 会把节点从 missing 里摘掉。它是「我想要引擎怎么算」。
 *
 * 标注是**引擎算得对不对的答案**。如果把它塞进 `NodeMapping`，会立刻产生两个后果：
 *   1. 你标一句「这条引擎配错了」，引擎下次就把这句当锚点用了 —— 标注在改写被标注的对象，
 *      之后无论跑多少轮，都再也不可能观察到「不改标注时引擎会怎样」。
 *   2. 精度/召回的分母（可匹配节点总数）与被比较的答案出自同一份文件，自证循环。
 *
 * 所以：独立的模型、独立的文件、独立的 IPC 通道。**标注永不被引擎读取**，
 * 它只被导出、只被人工分析。
 *
 * ## 节点 id 一律归一化
 *
 * 与 `NodeMapping` 同规矩：`design:xxx` / `app:xxx`。理由见 `aiAcceptance.toCanonicalId` ——
 * 两侧原始 id 空间互不相干，不加前缀放进同一个集合会撞。**并且**这里还有一层：画布上
 * 的两侧原始 id 分别由 `verify.ts` 的 `DesignNode.id` 与 `AppNode.nodeId` 承载，
 * 但只要有人写错一侧，标注就会静默失效（导出里那一半是空的），
 * 而不是报一个错让问题浮出来。
 */

import type { CanonicalKind, Salience } from './aiAcceptance';
import type { Rect } from './verify';

/**
 * 一条标注的判定。
 *
 * 刻意只有三种，且**互斥** —— 标注要的是「答案」，不是「置信度」。
 * 任何拿不准的节点，正确答案是**不标**（不进任何 pair），不是标一个 `uncertain`：
 * 后者会在统计时被当成第四种事实，而它其实只是「没答案」。
 *
 * | 判定 | 含义 | 它是什么证据 |
 * |---|---|---|
 * | `matched` | 这两组节点是同**一个** UI 元素 | 召回的分母；引擎没配上 = 漏 |
 * | `no-counterpart` | 这组节点**在另一侧不该存在** | 判定「引擎把它们配给了别处」= 误配 |
 * | `ignore` | 这组节点不参与验收（动态文案 / 骨架屏 / 调试浮层） | 不算分，但导出后能解释「为什么这里没人标」 |
 */
export type GroundTruthVerdict = 'matched' | 'no-counterpart' | 'ignore';

/**
 * 这条标注是怎么来的。
 *
 * `engine-prefill` 存在的唯一理由是**必须能被统计时摘出去**：
 * 「从引擎结论预填、然后只改错的那几条」是最省力的标注方式，但那几十条没被改动的
 * 预填项其实是**引擎自己的答案**。如果它们与人工确认的混在一起算准确率，
 * 只会得到一条趋近 100% 的曲线，且完全看不出引擎的真实水平。
 *
 * 所以：预填项照样保留（它们是很好的草稿），但带着这个标记 —— 分析时按来源分开算。
 */
export type GroundTruthPairOrigin = 'human' | 'engine-prefill';

/**
 * 一组已标注的节点。
 *
 * `designNodeIds` 与 `appNodeIds` **都可以是多元素**，也可以只有一侧：
 *   - 两侧都有 + `matched` → 一个 1:1 / 1:N / N:1 / N:M 的匹配事实。
 *   - 只有一侧 + `no-counterpart` → 「设计有、App 没有」或「App 多出来了」。
 *   - `ignore` → 通常只有一侧，但允许两侧。
 *
 * 空集合（两侧都空）是**非法**的，由写入侧拒绝 —— 一条什么都不指的「标注」只会在
 * 统计里占一行，看不出任何问题。
 */
export interface GroundTruthPair {
  /** 由节点集合 + 判定确定性派生（见渲染层 `pairKeyOf`），同集合重复标注 = 覆盖而非新增 */
  id: string;
  designNodeIds: string[];
  appNodeIds: string[];
  verdict: GroundTruthVerdict;
  /** 缺省视为 `human`（老文件里没有这个字段，它们当初就是人点出来的） */
  origin?: GroundTruthPairOrigin;
  /** 人工备注（「这行字是运营配的」「这个浮层只在登录后出现」） */
  note?: string;
  createdAt: string;
}

export interface GroundTruth {
  version: '1.0.0';
  pairId: string;
  pairs: GroundTruthPair[];
  updatedAt: string;
}

export interface SaveGroundTruthInput {
  pairId: string;
  groundTruth: Omit<GroundTruth, 'pairId' | 'updatedAt'>;
}

// ---------- 导出产物（交给 AI / 人工分析的那份自足 JSON） ----------

/** 导出里单个节点的可读描述。字段是「读得懂」优先，不是「齐全」优先 */
export interface GroundTruthNodeRef {
  canonicalId: string;
  /** 人可读名：设计侧取图层名，App 侧取类名 + 文本片段 */
  label: string;
  /** 归一化后的文本；无文本为 null */
  text: string | null;
  rect: Rect;
  salience: Salience;
  kind: CanonicalKind;
  depth: number;
  parentId: string | null;
  visible: boolean;
  clipped: boolean;
}

/**
 * 引擎在这条标注上的表现。
 *
 * 六种取值刻意覆盖「对」「半对」「找到了但没敢确认」「明确相反」「压根没配」「谈不上」——
 * 只有三档（对/错/没配）会把「引擎把设计 A 配到了 App B（另一个元素）」
 * 和「引擎干脆没动它」混在一起，而这两种的修法完全不同。
 */
export type EngineAgreement =
  /** 引擎的结论与标注一致 */
  | 'agrees'
  /** 有一部分对上了（例如 N:M 里只配上了两个） */
  | 'partial'
  /**
   * 引擎**找到了**这条对应，但只给到 `ambiguous`（候选，未被规则自动确认）。
   *
   * ⚠️ 为什么必须与 `missed` 分开：`ambiguous` 在工具里是**会被展示给人看的候选**，
   * 也就是说引擎已经把这条从「没发现」推进到了「待复核」。把它算成 `missed`，
   * 会让「新增一个只产出候选的层」（例如 L3c 校准定位）的收益在数字上完全消失 ——
   * 层本身有效，指标却一动不动，然后就会去改一个本来就对的东西。
   */
  | 'weak'
  /** 引擎的结论与标注**明确相反**（标 matched 却配给了别人 / 标 no-counterpart 却认为存在） */
  | 'contradicts'
  /** 标注说该存在，引擎一个都没配上 */
  | 'missed'
  /** `ignore` 标注：不对引擎提要求 */
  | 'unknown';

export interface GroundTruthEngineNodeStatus {
  canonicalId: string;
  status: 'matched' | 'ambiguous' | 'missing' | 'extra' | 'ignored' | 'unknown';
  origin?: string;
  confidence?: number;
  /** 引擎把它配给了对侧的谁（`matched` 时非空，可含多个 = 1:N 聚合） */
  partners: string[];
}

export interface GroundTruthPairGeometry {
  /** 该组节点各自的包围盒（多节点时取并集；无节点为 null） */
  designUnion: Rect | null;
  appUnion: Rect | null;
  /** 两个包围盒的 IoU；任一侧为 null 时为 null。**这不是判据，是让读的人估算偏差的参考** */
  iou: number | null;
  /** 中心点偏移（像素）。正值 = 设计侧更靠右 / 更靠下 */
  centerDelta: { dx: number; dy: number } | null;
  sizeDelta: { dw: number; dh: number } | null;
}

export interface GroundTruthPairExport {
  id: string;
  verdict: GroundTruthVerdict;
  /** 缺省视为 `human` */
  origin?: GroundTruthPairOrigin;
  note?: string;
  createdAt: string;
  /** 集合形状，字面计数，如 `1:1` / `1:3` / `0:2`（只有一侧的标注） */
  shape: string;
  /**
   * 标注里点到、但在这份导出数据里**已不存在**的节点。
   *
   * 非空即表示这条标注部分失效 —— 重新导入设计稿后 Figma 图层 id 会变，
   * 而旧标注仍指着老 id。**不能静默丢掉**：那样这一侧的 `design` 会凭空变空，
   * 读的人只会看到「N:M 变成了 0:M」，误以为当初就只标了一侧。
   */
  unresolvedNodeIds: string[];
  design: GroundTruthNodeRef[];
  app: GroundTruthNodeRef[];
  geometry: GroundTruthPairGeometry;
  text: {
    designTexts: string[];
    appTexts: string[];
    /** 两侧文本集合完全相等（空集也算相等，但 `bothEmpty` 会一并给出以便区分） */
    equal: boolean;
    bothEmpty: boolean;
  };
  engine: {
    agreement: EngineAgreement;
    designStatuses: GroundTruthEngineNodeStatus[];
    appStatuses: GroundTruthEngineNodeStatus[];
    /** 与本组节点相交的引擎 match id，便于回查 */
    matchIds: string[];
  };
}

/** 可匹配节点清单里的一个节点 = 可读描述 + 「它在标注里被怎么判的」 */
export interface GroundTruthUniverseNode extends GroundTruthNodeRef {
  /** null = 未标注。有值 = 该节点所属标注的判定 */
  annotated: GroundTruthVerdict | null;
  /**
   * 该节点是否**完整落在画布/视口内**。
   *
   * ⚠️ 为什么必须有这个字段：App 截图是**视口**，不是整页。实测这一对里
   * `universe.app` 344 个 required 节点中只有 **173** 个落在 360×792 的视口内 ——
   * 另外 171 个在折叠线以下（y 一直到 1989）。人不可能标注看不见的东西，
   * 所以拿全量当分母算召回，会把 171 个「根本没有正确答案可比」的节点算成引擎漏检，
   * 覆盖率被系统性低估（实测 22.4% ↔ 真实 44%，差一倍）。
   *
   * 设计稿侧反过来：它是整页渲染，438 个 required 里 421 个都在画布内 ——
   * 两侧**刻意不对称**，正因为一边是整页、一边是视口。
   *
   * 判据用「矩形完整包含」（而不是「有交集」）：被折叠线切掉一半的元素，
   * 人能看到的只是残缺的一角，标它与否都不算错 —— 单独用 `clipped` 区分。
   */
  inViewport: boolean;
}

export interface GroundTruthEngineSummary {
  designNodeCount: number;
  appNodeCount: number;
  matchedCount: number;
  missingCount: number;
  extraCount: number;
  ambiguousCount: number;
}

export interface GroundTruthExportMetrics {
  annotatedPairs: number;
  matched: number;
  noCounterpart: number;
  ignore: number;
  /**
   * 其中「由引擎结论预填、未被人工改动」的条数。
   *
   * 这几条**不是独立证据**（它们就是引擎自己的答案），算准确率时必须按 `agreementHuman`
   * 分开看。放在同一份统计里会把引擎水平刷成接近满分，且从数字上看不出原因。
   */
  prefilledPairs: number;
  /** 全部标注项的一致性与**仅人工确认项**的一致性。决策看后者 */
  agreement: Record<EngineAgreement, number>;
  agreementHuman: Record<EngineAgreement, number>;
  /** 标注覆盖到的节点数（去重前） */
  designNodeCount: number;
  appNodeCount: number;
  /** 标注覆盖到的**可匹配节点**占该侧可匹配节点的比例。分母与口径见 `universe` */
  designCoverage: number;
  appCoverage: number;
  universe: { design: number; app: number };
  /**
   * 视口内的分母与覆盖率。
   *
   * ⚠️ **判断引擎水平要看这一组，不是上面那组**。App 截图是视口，
   * 视口外的节点人根本标不到（这一对里 344 个 required 有 171 个在视口外），
   * 拿全量当分母会把它们算成引擎漏检。两组都给是为了能看清这个差值本身 ——
   * 差值大就说明「按全量算的召回」不可信。
   */
  universeViewport: { design: number; app: number };
  designCoverageViewport: number;
  appCoverageViewport: number;
  engine: {
    summary: GroundTruthEngineSummary;
    statusCounts: Record<string, number>;
  };
}

/** 引擎匹配的精简形态（完整形态在配对调试包里） */
export interface GroundTruthEngineMatch {
  id: string;
  status: string;
  relation: string;
  origin?: string;
  designNodeIds: string[];
  appNodeIds: string[];
  confidence: number;
}

export interface GroundTruthExportBundle {
  kind: 'ui-acceptance-ground-truth';
  version: 1;
  exportedAt: string;
  requirement: { id: string; name: string };
  pair: { id: string; designName: string; appName: string };
  /** 导出时的画布尺寸，供按比例换算像素与比例（两侧坐标系已归一到各自顶宽） */
  canvas: {
    design: { width: number; height: number };
    app: { width: number; height: number };
  };
  metrics: GroundTruthExportMetrics;
  pairs: GroundTruthPairExport[];
  /**
   * 两侧**可匹配节点**全量（已按引擎同一口径过滤掉零尺寸 / 布局透传 / 视口外），
   * 每个节点带上它被标注成了什么。
   *
   * 为什么必须给全量而不是只给标注过的：精度可以只看标注，**召回必须知道分母**。
   * 只看标注过的那几十条，「引擎漏了多少」这个问题永远算不出来 —— 被漏掉的那些
   * 恰恰就是没被标注的那些（标注时人本来就会优先标看得懂的、对得上的）。
   */
  universe: {
    design: GroundTruthUniverseNode[];
    app: GroundTruthUniverseNode[];
  };
  /**
   * 这次比对**实际喂给引擎的人工输入**。
   *
   * 必须给出来：如果 `anchors > 0`，引擎的准确率里就有人工锚点的功劳，
   * 拿它当「引擎自己的水平」会系统性高估 —— 而这一点在 numbers 里完全看不出来。
   */
  mapping: {
    anchors: number;
    ignoredDesignNodes: number;
    ignoredAppNodes: number;
    manualMatches: number;
  } | null;
  engine: {
    summary: GroundTruthEngineSummary;
    statusCounts: Record<string, number>;
    totalMatches: number;
    matches: GroundTruthEngineMatch[];
  };
}

export interface ExportGroundTruthInput {
  requirementId: string;
  pairId: string;
}

export interface ExportGroundTruthResult {
  /** 落盘绝对路径 */
  file: string;
  bytes: number;
  pairCount: number;
  /** 各判定计数，供导出后立刻回显「这次标了什么」 */
  verdictCounts: Record<GroundTruthVerdict, number>;
  agreementCounts: Record<EngineAgreement, number>;
}
