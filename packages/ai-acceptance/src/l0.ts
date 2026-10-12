/**
 * L0 数据整形 —— 把两侧原始节点树变成可比较的规范化模型
 *
 * 对应报告 §3.1。每一步都绑定实测依据，改规则前先看注释里的数字。
 *
 * 铁律：
 *   1. 设计 TEXT 的 `name` 不是文本内容，只认 `text.characters`（31/105 不一致）；
 *   2. App 文本含零宽字符，必须归一化；
 *   3. 噪声（哨兵 / 隐藏 / 零尺寸 / 负坐标 / 工具浮层）必须先剔除，否则下游全被污染；
 *   4. 固定层（App tab bar）与流式层必须分开，否则 Δy 会被 −451 这类值拉爆。
 */

import type {
  AcceptanceProfile,
  AppNode,
  BundleSideMeta,
  CleanTier,
  DesignNode,
  DropReason,
  DropRecord,
  NodeKind,
  NormNode,
  Rect,
  ShapedSide,
  Side,
  BoxStyle,
  TextStyleDecl,
} from './types.ts';
// ⚠️ `DROP_TIER` 是**值**（不是 type）：清洗层归因的唯一映射，不能在别处再手写一份
import { DROP_TIER } from './types.ts';
import { normalizeText } from './text.ts';

/** 哨兵脏值阈值 */
const SENTINEL_Y = 1e5;
/** 负坐标剔除阈值 */
const NEG_COORD = -1000;

/** 可滚动容器类名（App 固定层判定用） */
const SCROLL_ANCESTOR = /ScrollView|ScrollableHost|RecyclerView|ViewPager/i;

export interface ShapeContext {
  profile: AcceptanceProfile;
  /** 该侧的"截图覆盖高度"（逻辑像素） */
  viewportHeight: number;
}

function emptyRect(): Rect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

function intersect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return emptyRect();
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** 数组型圆角取最大值（Figma 四角不一致时取代表值，并在 tags 里标注 mixed） */
function cornerOf(v: number | number[] | null | undefined): number | null {
  if (v == null) return null;
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return Math.max(...v);
  }
  return v;
}

/* ---------------------------------------------------------------------------
 * 设计侧
 * -------------------------------------------------------------------------*/

function designTextStyle(n: DesignNode): TextStyleDecl | null {
  const t = n.text;
  if (!t) return null;
  return {
    fontSize: t.fontSize ?? null,
    fontWeight: t.fontStyle ?? null,
    fontFamily: t.fontFamily ?? null,
    color: t.color ?? null,
    lineHeight: typeof t.lineHeight === 'number' ? t.lineHeight : null,
    letterSpacing: typeof t.letterSpacing === 'number' ? t.letterSpacing : null,
  };
}

/**
 * 把 `fill.opacity` 折进色值 alpha，产出 `#RRGGBBAA`（**Figma 口径，alpha 在末尾**）。
 *
 * 实测：`{ type:'SOLID', opacity:0.4, color:'#e7d1ff66' }` 的真实不透明度是 0.4×0.4=0.16；
 * 只用色值 alpha 去和截图比，会把"叠加后的浅紫"误判成 ΔE≈10 的颜色偏差。
 */
function withFillOpacity(color: string, opacity: number | undefined): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!m) return color;
  const baseA = m[2] ? parseInt(m[2], 16) / 255 : 1;
  const a = opacity == null ? baseA : baseA * Math.max(0, Math.min(1, opacity));
  if (a >= 0.999) return `#${m[1]}`;
  const aa = Math.max(0, Math.min(255, Math.round(a * 255))).toString(16).padStart(2, '0');
  return `#${m[1]}${aa}`;
}

function designBoxStyle(n: DesignNode): BoxStyle | null {
  const solid = (n.fills ?? []).find((f) => f.type === 'SOLID' && f.visible !== false);
  const anyFill = (n.fills ?? []).find((f) => f.visible !== false);
  const cr = cornerOf(n.cornerRadius);
  const bw = typeof n.strokeWeight === 'number' && n.strokeWeight > 0 ? n.strokeWeight : null;
  const strokeSolid = ((n.strokes ?? []) as Array<Record<string, unknown>>).find(
    (s) => s && s['visible'] !== false && s['color'],
  );
  const borderColor = strokeSolid ? ((strokeSolid['color'] as string) ?? null) : null;
  if (!anyFill && cr == null && bw == null) return null;
  return {
    backgroundColor: solid?.color ? withFillOpacity(solid.color, solid.opacity) : null,
    cornerRadius: cr,
    borderWidth: bw,
    borderColor,
    fillType: anyFill?.type ?? null,
  };
}

function designKind(n: DesignNode): NodeKind {
  if (n.text && normalizeText(n.text.characters)) return 'text';
  if ((n.childCount ?? 0) > 0) return 'container';
  return 'visual';
}

/* ---------------------------------------------------------------------------
 * App 侧
 * -------------------------------------------------------------------------*/

function appBorderWidth(v: unknown): number | null {
  if (typeof v === 'number') return v > 0 ? v : null;
  if (v && typeof v === 'object') {
    const sides = Object.values(v as Record<string, unknown>).filter(
      (x): x is number => typeof x === 'number' && x > 0,
    );
    return sides.length ? Math.max(...sides) : null;
  }
  return null;
}

function appBoxStyle(n: AppNode): BoxStyle | null {
  const s = n.style;
  if (!s) return null;
  const bg = typeof s.backgroundColor === 'string' && s.backgroundColor ? s.backgroundColor : null;
  const cr = cornerOf((s.borderRadius as number | number[] | null | undefined) ?? null);
  const bw = appBorderWidth(s.borderWidth);
  let bc: string | null = null;
  if (typeof s.borderColor === 'string') bc = s.borderColor;
  else if (s.borderColor && typeof s.borderColor === 'object') {
    const first = Object.values(s.borderColor as Record<string, unknown>).find(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    bc = first ?? null;
  }
  if (!bg && cr == null && bw == null) return null;
  return { backgroundColor: bg, cornerRadius: cr, borderWidth: bw, borderColor: bc, fillType: bg ? 'SOLID' : null };
}

function appTextStyle(n: AppNode): TextStyleDecl | null {
  const t = n.textStyle;
  if (!t) return null;
  return {
    fontSize: typeof t.fontSize === 'number' ? t.fontSize : null,
    fontWeight: t.fontWeight ?? null,
    fontFamily: t.fontFamily ?? null,
    color: t.color ?? null,
    lineHeight: typeof t.lineHeight === 'number' ? t.lineHeight : null,
    letterSpacing: typeof t.letterSpacing === 'number' ? t.letterSpacing : null,
  };
}

/**
 * SVG 组件族的类名特征。
 *
 * ## 为什么必须靠类名而不是 `isSvg`
 *
 * SDK 只在 `SvgView` **根节点**上打 `isSvg: true`，内部元素
 * （`PathView` / `CircleView` / `RectView` / `GroupView` / `DefsView` / `MaskView`）
 * **既没有 `isSvg`、也没有 `hasVisualContent`** ——
 * 实测 10年管家那份 495 节点里 `isSvg=true` 只有 30 个（正好是根），
 * 而 horcrux 族共 157 个。
 *
 * ⇒ 后果：127 个**真实矢量图形**被 `appKind` 判成 `container`。
 * 这会让「剔除布局容器」这条清洗判据**把它们一并剔掉**
 * （实测 10年管家 App 侧 135 个 container 里有 54 个是这类误判）。
 *
 * ⚠️ 所以任何「container ⇒ 剔掉」的判据**必须先排除 SVG 族**，
 * 否则等于在剔布局的同时把图标内部的路径也删了。
 */
const SVG_FAMILY = /horcrux|(?:^|[./])(?:Svg|Path|Circle|Rect|Polygon|Line|Ellipse|Group|Defs|Mask|ClipPath|Text|G)View$/;

/** 该节点是否是 SVG 矢量绘制的一部分（根或内部元素都算） */
function isSvgFamily(className: string | undefined): boolean {
  return !!className && SVG_FAMILY.test(className);
}

function appKind(n: AppNode): NodeKind {
  if (n.text && normalizeText(n.text)) return 'text';
  if (n.isImage || n.isSvg || n.isGradient || n.hasVisualContent) return 'visual';
  // ⭐ SVG 内部元素（PathView/CircleView/…）本身**就是**可绘制图形，
  // 必须归 visual，否则会被当布局容器剔掉（见 SVG_FAMILY 注释）。
  if (isSvgFamily(n.className)) return 'visual';
  return 'container';
}

/* ---------------------------------------------------------------------------
 * 主流程
 * -------------------------------------------------------------------------*/

export interface ShapedBoth {
  design: ShapedSide;
  app: ShapedSide;
}

export function shapeSide(
  side: Side,
  designNodes: DesignNode[],
  appNodes: AppNode[],
  meta: BundleSideMeta,
  profile: AcceptanceProfile,
): ShapedSide {
  const W = meta.width;
  const H = meta.height;

  const dropped: DropRecord[] = [];
  const rawDesign = designNodes;
  const rawApp = appNodes;

  const idOf = (n: DesignNode | AppNode): string =>
    side === 'design' ? (n as DesignNode).id : (n as AppNode).nodeId;

  const parentOf = (n: DesignNode | AppNode): string | null => n.parentId ?? null;

  // ---- 1. 建索引 ----
  const byId = new Map<string, DesignNode | AppNode>();
  for (const n of side === 'design' ? rawDesign : rawApp) byId.set(idOf(n), n);

  // ---- 2. 文本取值（只用 characters / text） ----
  const rawTextOf = (n: DesignNode | AppNode): string | null => {
    if (side === 'design') {
      const t = (n as DesignNode).text;
      return t ? (t.characters ?? null) : null;
    }
    const t = (n as AppNode).text;
    return t ?? null;
  };

  // ---- 3. 平台 chrome 判定（沿祖先链查 name/path/className） ----
  const chromePatterns = (profile.chromeNamePatterns ?? ['status\\s*bar', '状态栏']).map(
    (p) => new RegExp(p, 'i'),
  );
  const isChrome = (n: DesignNode | AppNode): boolean => {
    let cur: DesignNode | AppNode | undefined = n;
    let guard = 0;
    while (cur && guard++ < 80) {
      const label =
        side === 'design'
          ? `${(cur as DesignNode).name} ${(cur as DesignNode).path ?? ''}`
          : (cur as AppNode).className;
      if (chromePatterns.some((re) => re.test(label))) return true;
      const pid = parentOf(cur);
      cur = pid ? byId.get(pid) : undefined;
    }
    return false;
  };

  // ---- 4. 噪声名单 ----
  const noiseTextSet = new Set((profile.noiseTexts ?? []).map((t) => normalizeText(t) ?? t));
  const noiseClassSet = new Set(profile.noiseClassNames ?? []);

  const isToolOverlay = (n: DesignNode | AppNode): boolean => {
    const t = normalizeText(rawTextOf(n));
    if (t && noiseTextSet.has(t)) return true;
    if (side === 'app') {
      const cn = (n as AppNode).className;
      for (const c of noiseClassSet) if (cn.includes(c)) return true;
    }
    return false;
  };

  // ---- 5. 逐节点整形 ----
  const kept: NormNode[] = [];

  // ---- 5.0 剔除登记（tier 由 DROP_TIER 唯一映射，不在这里手写） ----
  // ⚠️ `id` 从循环外传入而不是用闭包捕获：`drop` 定义在 for 之前，
  // 闭包里访问不到每次迭代的 `id`（TS18004）。
  const drop = (nodeId: string, reason: DropReason, evidence: string): void => {
    dropped.push({ id: nodeId, reason, tier: DROP_TIER[reason], evidence });
  };

  /**
   * L6「叶子布局壳」判据要用的两个事实，**提前到循环外算一次**。
   *
   * ⚠️ 为什么不直接调 `designBoxStyle` / `appBoxStyle`：它们是纯函数但要走一遍
   * 样式解析，而循环里的 `boxStyle` 变量是在 `kept.push` 之前算好的 ——
   * L6 排在它之后就会拿到 undefined，判据会**静默退化成「都没样式」**，
   * 把该留的容器也剔掉。所以这里预先算好。
   */
  const childCountMap = new Map<string, number>();
  for (const n of side === 'design' ? rawDesign : rawApp) {
    const pid = parentOf(n);
    if (pid) childCountMap.set(pid, (childCountMap.get(pid) ?? 0) + 1);
  }
  const childCountOf = (nodeId: string): number => childCountMap.get(nodeId) ?? 0;

  /** 会画出背景 / 边框 / 圆角的节点 id（任一有 ⇒ 它是「看得见的盒子」） */
  const paintedIds = new Set<string>();
  for (const n of side === 'design' ? rawDesign : rawApp) {
    const bs = side === 'design' ? designBoxStyle(n as DesignNode) : appBoxStyle(n as AppNode);
    if (bs && (bs.backgroundColor || bs.cornerRadius || bs.borderWidth)) paintedIds.add(idOf(n));
  }

  for (const n of side === 'design' ? rawDesign : rawApp) {
    const id = idOf(n);
    const rect: Rect =
      side === 'design'
        ? { ...(n as DesignNode).rect }
        : { x: (n as AppNode).x, y: (n as AppNode).y, width: (n as AppNode).width, height: (n as AppNode).height };
    const textForEvidence = normalizeText(rawTextOf(n));

    // 5.1 哨兵脏值
    if (rect.y >= SENTINEL_Y || rect.x <= NEG_COORD) {
      drop(id, 'sentinel', `y=${rect.y} x=${rect.x}（哨兵阈值 y≥${SENTINEL_Y} / x≤${NEG_COORD}）`);
      continue;
    }
    // 5.2 隐藏
    if (side === 'design' && (n as DesignNode).visible === false) {
      drop(id, 'hidden', '设计稿 visible=false');
      continue;
    }
    if (side === 'app') {
      const an = n as AppNode;
      if (an.visible === false) {
        drop(id, 'hidden', 'App 节点 visible=false');
        continue;
      }
      if (an.hiddenByAncestor) {
        drop(id, 'hidden-by-ancestor', 'App 节点 hiddenByAncestor=true');
        continue;
      }
    }
    // 5.3 零尺寸
    if (rect.width <= 0 || rect.height <= 0) {
      drop(id, 'zero-size', `${rect.width}×${rect.height}（宽或高为 0）`);
      continue;
    }
    // 5.4 工具自身浮层
    if (isToolOverlay(n)) {
      drop(id, 'tool-overlay', `文本/类名命中噪声名单：${JSON.stringify(textForEvidence ?? rawTextOf(n))}`);
      continue;
    }
    // 5.5 平台 chrome（不参与判定，直接出局）
    const chrome = isChrome(n);
    if (chrome) {
      drop(id, 'platform-chrome', `祖先链命中 chrome 模式：${(n as DesignNode).name ?? (n as AppNode).className}`);
      continue;
    }

    // 5.6 可见矩形
    let visibleRect: Rect;
    let inPixels: boolean;
    let clippedOut = false;
    if (side === 'design') {
      visibleRect = intersect(rect, { x: 0, y: 0, width: W, height: H });
      inPixels = visibleRect.width > 0 && visibleRect.height > 0;

      /**
       * 5.6.1d 设计侧视口外（2026-10-04，与 App 侧同一口径）。
       *
       * ⚠️ 实测三份真实素材里**设计侧命中 0 个** —— 稿高（812）正好装得下，
       * 所以这一条在设计侧基本是空转。仍然写在这里的理由：
       * **两侧口径必须一致**。只在 App 侧剔会让「设计有、App 没有」这类判断
       * 在两侧用不同标准，而这类差异恰好是最容易被误报成缺陷的。
       * 将来遇到稿子比视口长（多屏设计稿）时它才真正生效。
       */
      if (rect.y + rect.height <= 0 || rect.y >= H) {
        drop(
          id,
          'outside-viewport',
          rect.y + rect.height <= 0
            ? `完全在画布上方（y=${rect.y.toFixed(0)} + h=${rect.height.toFixed(0)} ≤ 0）`
            : `完全在画布下方（y=${rect.y.toFixed(0)} ≥ 稿高 ${H}）`,
        );
        continue;
      }
    } else {
      const an = n as AppNode;
      const rawForClip = normalizeText(rawTextOf(n));
      clippedOut = !!an.clippedOut || an.effectiveVisibleHeight <= 0 || an.effectiveVisibleWidth <= 0;
      const eff: Rect = {
        x: an.effectiveVisibleX,
        y: an.effectiveVisibleY,
        width: an.effectiveVisibleWidth,
        height: an.effectiveVisibleHeight,
      };
      visibleRect = clippedOut ? emptyRect() : intersect(eff, { x: 0, y: 0, width: W, height: H });
      inPixels = !clippedOut && visibleRect.width > 0 && visibleRect.height > 0;

      /**
       * 5.6.1 数字滚动组件的**零高裁剪窗内的重复文本** ⇒ 出局
       *（2026-10-04 修「价格数字轮没过滤」）。
       *
       * ## 现象
       *
       * 盲盒抽奖那份快照（`appSnapshotId=9fe18d9b…`，729 节点）里，
       * 价格区是 `number-flow` 类组件：把 `0`–`9` 全部实例化，各占一个
       * **13×0 的零高容器**、靠 `translateY` 露出当前位。屏幕上只看得见 1 行，
       * 但这 10 个都报 `visible=true / participation=required / hasVisualContent=true`
       * —— SDK 的 `getGlobalVisibleRect` 对 overflow:hidden 窗口的**子节点失效**
       * （子比父更「可见」，几何上不可能）。
       *
       * 于是设计「黑科技」被配到 App「6」、设计「¥3599」配到「9」，
       * 实测产出 **89 条这类假阳性**（issue 总数 151，其中 102 条 P2 噪声）。
       *
       * ## 判据为什么是「父容器高度 = 0」而不是别的
       *
       * 试过并否掉的几种：
       *  - **只看 `clippedOut`**：该快照 457/729 个都是它，含 `PathView` 50 /
       *    `SvgView` 32 / `FastImageViewWithUrl` 12 等图形类，一刀切会误伤。
       *  - **只看「有文本」**：仍会误伤 495 那份素材里的
       *    「官配防买错」「1.13km」「正品有保障」等 42 个真实内容 ——
       *    它们在 `ReactScrollView`（高 774）下方，是**还没滚到**的下半屏，
       *    不是「被裁掉的噪声」。⚠️ 这条实测教训很关键：
       *    **「没显示」≠「不存在」**，分不清就会把真内容当噪声剔掉。
       *  - **看 `y < 0`**：数字行里只有 6/213 是负 y（其余靠父容器定位），区分不开。
       *  - **看 `effectiveVisible*` 面积 = 0**：这批节点读出来是 `undefined`，
       *    729 个里面积为 0 的有 **0** 个 —— SDK 那条链在这批节点上没产出。
       *
       * 「父容器高度 = 0」是**结构信号**：它说明这行字的定位完全靠父级
       * （零高容器 + 绝对定位/translate），自身不参与布局 ——
       * 数字轮的写法必然如此，而正常内容不会。
       * 实测：盲盒命中 116 个，另外两份素材（495 / 523 节点）**各命中 0 个**。
       *
       * ⚠️ 被判掉的**不只**数字行：同一裁剪窗里还有另外 97 个文本
       * （"新一级能效"、"515*500*530" 等商品参数），它们父高不为 0、
       * 同样是「尚未滚到」的真实内容 —— 所以它们**保留**，
       * 由 `visibleRect` 为空 → `inPixels=false` → 命中「无像素证据」通道
       * （降级为待人工确认），**而不是当成缺陷**。
       */
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      const inZeroHeightWindow =
        !!parent && (parent as { height?: number }).height === 0 && !isChrome(parent as AppNode);
      if (clippedOut && rawForClip && (an as AppNode).participation === 'required' && inZeroHeightWindow) {
        drop(
          id,
          'clipped-out',
          `父容器高度=0（零高裁剪窗）+ clippedOut + required + 文本「${rawForClip}」`,
        );
        continue;
      }

      /**
       * 5.6.2 视口外 ⇒ 不参与验收（2026-10-04 加，L5 层）。
       *
       * ## 为什么上下两侧都剔
       *
       * 验收的证据是 App 截图，而截图只覆盖视口。视口外的节点引擎**无从判定** ——
       * 留在节点集里只会制造假阳性：盲盒那份实测，保留下方 312 个时，
       * 因为 y 映射在「无锚点区」退化成恒等，App 每一行文本都被判成「App 多出文本」。
       *
       * 规模（盲盒 729 节点 / 视口 792）：视口外且有面积 **317** 个 = 上 5 / 下 312。
       *  - 上方 5 个：数字轮往上滚出去的数字（`y = -149…-37`，13×28）
       *  - 下方 312 个：「还没滚到的下半屏」（"官配防买错"「1.13km」…）
       *
       * ## ⚠️ 剔除 ≠ 判定为不存在
       *
       * 那 312 个是**真实存在**的内容，只是不该参与这次验收。所以：
       *  - 报告 `notes` 必须写明「视口外 N 个节点未参与验收」（由 harness 补）；
       *  - 画布清洗可视化里它们仍会被画出来（人要看清「剔了什么」）。
       *
       * ## 为什么放在 `rect` 上判而不是 `visibleRect`
       *
       * `visibleRect` 是「自身 ∩ 视口」，完全在外时它是空矩形 —— 但**空矩形**同时
       * 覆盖了「被裁」与「不在场」两种情况，分不开。而 `rect` 直接判「完全在外」
       * 是一个**纯几何**事实，不依赖采集器是否如实报告裁剪链（那条链在这批节点上
       * 读出来是 `undefined`，见上面 L4 的注释）。
       *
       * ⚠️ 边界用「完全无交集」而非「部分相交」：贴着视口底边、内容被切一半的节点
       * 仍参与验收（它有部分像素证据），只有**一点都看不到**的才剔。
       */
      const aboveViewport = rect.y + rect.height <= 0;
      const belowViewport = rect.y >= H;
      if (aboveViewport || belowViewport) {
        drop(
          id,
          'outside-viewport',
          aboveViewport
            ? `完全在视口上方（y=${rect.y.toFixed(0)} + h=${rect.height.toFixed(0)} ≤ 0，视口高 ${H}）`
            : `完全在视口下方（y=${rect.y.toFixed(0)} ≥ 视口高 ${H}）—— 截图未覆盖，不参与验收`,
        );
        continue;
      }
    }

    const raw = rawTextOf(n);
    const text = normalizeText(raw);
    const kind: NodeKind = side === 'design' ? designKind(n as DesignNode) : appKind(n as AppNode);

    /**
     * 5.7 纯布局容器 ⇒ 出局（2026-10-04 加，L6 层）。
     *
     * ## 目标
     *
     * 「只保留可绘制的元素」—— 容器本身不画任何像素（RN 的 `ViewGroup` /
     * Figma 的 `编组` 只是给子节点定位），把它算进节点集会让画布上多出
     * 一堆无内容的空框，也会给匹配引擎塞进一批「既无文本也无像素」的候选。
     *
     * ## ⚠️ 判据必须是「叶子 + 无盒样式 + 非 SVG 族」，三个条件缺一不可
     *
     * 实测数据（10年管家，App 侧 135 个 container）逐条查过：
     *
     * | 判据 | 会误伤什么 |
     * |---|---|
     * | 只看 `kind === 'container'` | **54 个是 SVG 矢量图形**（`PathView` 64 / `CircleView` 9 / `RectView` 2…）。SDK 只在 `SvgView` **根**上打 `isSvg`，内部元素没这字段 ⇒ 被 `appKind` 误判成 container（已单独修 `appKind`，这里再挡一次） |
     * | container + 无盒样式 | 「无样式 + **有子节点**」的分组容器 **App 73 / 设计 79** 个 —— 它们是真实的结构分组 |
     * | container + 无子节点 | ✅ 实测 App 侧只命中 **3** 个（`SafeAreaProvider` / `DebuggingOverlay` / `ScreenStackHeaderConfig`） |
     *
     * ## ⭐ 为什么必须保留「有子节点」的容器
     *
     * 子节点的 `parentId` 指向它。剔掉父容器后子节点会变成**孤儿**，
     * 而 L3a 祖先投票 / L3b 容器内分配都吃祖先链 —— 链断在那里，
     * 匹配会直接崩。**布局容器是「树结构」，不是「像素」，两者不能一刀切。**
     *
     * 所以这条判据剔的只是**叶子布局壳**：没有子节点（不留后代）、
     * 没有任何盒样式（不画背景/边框/圆角）、不是 SVG 族（那是矢量绘制）。
     * 它删掉之后树结构**完全不受影响** —— 这是能安全剔除的前提。
     *
     * ## 设计侧为什么几乎命中 0 个
     *
     * `designKind` 判 container 的条件是 `childCount > 0`，所以设计侧的 container
     * **天然都有子节点** ⇒ 叶子壳为 0。写上这一条是为了口径一致。
     */
    if (kind === 'container') {
      const childCount = childCountOf(id);
      const hasBoxPaint = paintedIds.has(id);
      const svgLike = side === 'app' && isSvgFamily((n as AppNode).className);
      if (childCount === 0 && !hasBoxPaint && !svgLike) {
        drop(
          id,
          'layout-only',
          side === 'app'
            ? `叶子布局容器（无子节点 + 无背景/边框/圆角）· ${(n as AppNode).className.split('.').pop() ?? ''}`
            : '叶子布局容器（无子节点 + 无背景/边框/圆角）',
        );
        continue;
      }
    }

    const tags: string[] = [];
    if (clippedOut) tags.push('clipped-out');
    if (!inPixels) tags.push('no-pixels');
    if (side === 'app' && (n as AppNode).participation) tags.push(`part:${(n as AppNode).participation}`);
    if (side === 'design' && Array.isArray((n as DesignNode).cornerRadius)) tags.push('corner-mixed');
    // ⭐ 视图归并需要它（2026-10-04）：SVG 归并靠 className 认出 `SvgView` 根。
    // 放 tags 而不新增字段 —— `NormNode` 是引擎与像素通道共用的窄接口，
    // 加字段要同步 `assert-core-isolated` 的依赖面，而 tags 本就是「附加标记」的既定容器。
    // 只记**短名**（`SvgView`）不记全限定名：归并判据要匹配的就是末段，
    // 而全限定名会把 tags 撑大 3 倍（`com.horcrux.svg.SvgView` × 46）。
    if (side === 'app') {
      const short = (n as AppNode).className.split('.').pop() ?? '';
      if (short) tags.push(`cn:${short}`);
    }

    const boxStyle = side === 'design' ? designBoxStyle(n as DesignNode) : appBoxStyle(n as AppNode);
    const textStyle = side === 'design' ? designTextStyle(n as DesignNode) : appTextStyle(n as AppNode);

    kept.push({
      side,
      id,
      parentId: parentOf(n),
      depth: n.depth,
      index: n.index,
      rect,
      visibleRect,
      kind,
      text,
      textRaw: raw,
      hasVisualContent:
        side === 'design'
          ? ((n as DesignNode).fills ?? []).length > 0 || ((n as DesignNode).strokes ?? []).length > 0
          : !!(n as AppNode).hasVisualContent || !!(n as AppNode).isImage || !!(n as AppNode).isSvg || !!(n as AppNode).isGradient,
      isImage: side === 'design' ? ((n as DesignNode).fills ?? []).some((f) => f.type === 'IMAGE') : !!(n as AppNode).isImage,
      isSvg: side === 'design' ? (n as DesignNode).type === 'VECTOR' : !!(n as AppNode).isSvg,
      isGradient: side === 'design' ? ((n as DesignNode).fills ?? []).some((f) => f.type.includes('GRADIENT')) : !!(n as AppNode).isGradient,
      boxStyle,
      textStyle,
      layer: 'flow', // 待 L0 后段重算
      pathSignature: '', // 待后段重算
      orderInParent: n.index,
      clickable: side === 'app' ? !!(n as AppNode).clickable : (n as DesignNode).type === 'INSTANCE',
      participation: side === 'app' ? ((n as AppNode).participation ?? null) : null,
      clippedOut,
      inPixels,
      tags,
    });
  }

  // ---- 6. 路径签名 ----
  const keptById: Map<string, NormNode> = new Map(kept.map((n): [string, NormNode] => [n.id, n]));
  const sigPart = (n: NormNode): string => {
    const raw = byId.get(n.id);
    if (!raw) return '?';
    if (side === 'design') {
      const d = raw as DesignNode;
      return normalizeText(d.name) ?? d.type;
    }
    return (raw as AppNode).className.split('.').pop() ?? '?';
  };
  for (const n of kept) {
    const parts: string[] = [];
    let cur: NormNode | undefined = n;
    let guard = 0;
    while (cur && guard++ < 80) {
      parts.push(sigPart(cur));
      const pid: string | null = cur.parentId;
      cur = pid ? keptById.get(pid) : undefined;
    }
    n.pathSignature = parts.reverse().join('>');
  }

  // ---- 7. 固定层判定 ----
  const layer = detectFixedLayer(side, kept, keptById, byId, H);
  for (const n of kept) n.layer = layer.has(n.id) ? 'fixed' : 'flow';

  // ---- 8. 文档高度 / 统计 ----
  let docHeight = 0;
  for (const n of kept) docHeight = Math.max(docHeight, n.rect.y + n.rect.height);

  const byTier: Record<CleanTier, number> = {
    'L1-geometry': 0,
    'L2-collector': 0,
    'L3-invisible': 0,
    'L4-semantic': 0,
    'L5-viewport': 0,
    'L6-layout': 0,
  };
  for (const d of dropped) byTier[d.tier] += 1;

  const stats: ShapedSide['stats'] = {
    total: (side === 'design' ? rawDesign : rawApp).length,
    kept: kept.length,
    dropped: dropped.length,
    text: kept.filter((n) => n.kind === 'text').length,
    visual: kept.filter((n) => n.kind === 'visual').length,
    container: kept.filter((n) => n.kind === 'container').length,
    chrome: dropped.filter((d) => d.reason === 'platform-chrome').length,
    flow: kept.filter((n) => n.layer === 'flow').length,
    fixed: kept.filter((n) => n.layer === 'fixed').length,
    inPixels: kept.filter((n) => n.inPixels).length,
    clippedOutRequired: kept.filter((n) => n.clippedOut && n.participation === 'required').length,
    byTier,
  };

  return { nodes: kept, dropped, docHeight, viewportHeight: H, viewportWidth: W, stats };
}

/**
 * 固定层判定。
 *
 * App：位于视口底部带（底部 110px）**且祖先链里没有可滚动容器**的节点 → 固定层。
 *   ⚠️ 必须查滚动祖先：服务网格最后一排文字（`更换滤芯` y=762.3）与 tab bar（y=762）
 *   几何上重叠，但前者在 `ReactScrollView` 里、后者不在。只按 y 判会把网格误并入 tab bar。
 *
 * 设计：设计稿里 tab bar 是**文档流底部**的一块内容（y=1213），不是固定覆盖，
 *   因此设计侧只能靠"与 App 固定层文本同集合"反标，才能让两边都退出流式对齐。
 */
function detectFixedLayer(
  side: Side,
  kept: NormNode[],
  keptById: Map<string, NormNode>,
  byId: Map<string, DesignNode | AppNode>,
  viewportHeight: number,
): Set<string> {
  const fixed = new Set<string>();
  const BAND = 110;

  const insideScroll = (n: NormNode): boolean => {
    let cur: NormNode | undefined = n;
    let guard = 0;
    while (cur && guard++ < 80) {
      const raw = byId.get(cur.id);
      if (raw && side === 'app' && SCROLL_ANCESTOR.test((raw as AppNode).className)) return true;
      const pid: string | null = cur.parentId;
      cur = pid ? keptById.get(pid) : undefined;
    }
    return false;
  };

  const bandBottom = side === 'design' ? viewportHeight : viewportHeight;
  const bandTop = bandBottom - BAND;

  // 先收集底部带的文本节点
  const seeds = kept.filter(
    (n) => n.layer === 'flow' && n.text && n.rect.y >= bandTop && n.rect.y <= bandBottom + 20,
  );
  if (seeds.length === 0) return fixed;

  if (side === 'app') {
    for (const n of seeds) {
      if (insideScroll(n)) continue;
      // 标记自身 + 其上直到"底部带容器"的祖先链
      let cur: NormNode | undefined = n;
      let guard = 0;
      while (cur && guard++ < 80) {
        fixed.add(cur.id);
        const pid: string | null = cur.parentId;
        const parent: NormNode | undefined = pid ? keptById.get(pid) : undefined;
        // 容器的底边贴住视口底部 → 认为是固定条本体，继续向上标记会误吞整页
        if (parent && parent.rect.y + parent.rect.height < bandBottom - 6) break;
        cur = parent;
      }
    }
  } else {
    // 设计侧：由调用方在两侧整形后，用 App 固定层文本集合反标。
    // 这里先标出"底部带内的文本节点自身"，稍后由 markDesignFixedByText 用文本集合收敛。
    for (const n of seeds) fixed.add(n.id);
  }

  return fixed;
}

/**
 * 用 App 固定层的文本集合，反标设计侧对应的节点（含其祖先容器）。
 * 必须在两侧都整形完之后调用。
 */
export function markDesignFixedByText(design: ShapedSide, app: ShapedSide): number {
  const appFixedTexts = new Set(
    app.nodes.filter((n) => n.layer === 'fixed' && n.text).map((n) => n.text as string),
  );
  if (appFixedTexts.size === 0) return 0;

  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  let n = 0;
  for (const node of design.nodes) {
    if (node.layer === 'fixed') continue;
    if (!node.text || !appFixedTexts.has(node.text)) continue;
    // 只认靠文档底部的（避免正文里同名的普通文字被误标）
    if (node.rect.y < design.viewportHeight * 0.85) continue;
    node.layer = 'fixed';
    node.tags.push('fixed-by-app-text');
    n++;
    // 祖先容器也标为固定层（tab bar 容器）
    let cur = node.parentId ? byId.get(node.parentId) : undefined;
    let guard = 0;
    while (cur && guard++ < 8) {
      if (cur.rect.y + cur.rect.height >= design.viewportHeight - 4 && cur.rect.height < 140) {
        cur.layer = 'fixed';
        cur.tags.push('fixed-container');
      }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return n;
}

/** 便捷：整形两侧（含设计侧固定层反标） */
export function shapeBoth(input: {
  meta: { design: BundleSideMeta; app: BundleSideMeta };
  designNodes: DesignNode[];
  appNodes: AppNode[];
  profile: AcceptanceProfile;
}): ShapedBoth {
  const design = shapeSide('design', input.designNodes, [], input.meta.design, input.profile);
  const app = shapeSide('app', [], input.appNodes, input.meta.app, input.profile);
  markDesignFixedByText(design, app);

  // 反标后固定层统计要重算
  const recount = (s: ShapedSide) => {
    s.stats.flow = s.nodes.filter((x) => x.layer === 'flow').length;
    s.stats.fixed = s.nodes.filter((x) => x.layer === 'fixed').length;
  };
  recount(design);
  recount(app);

  return { design, app };
}
