/**
 * 设计稿坐标 → App 截图物理像素的**唯一**变换实现（纯数学，浏览器安全）。
 *
 * 这个文件存在的理由就是「只实现一份」：验收判定（`src/main/acceptance/core.ts`）、
 * Ground Truth 导出（`groundTruthExport.ts` / `gen-ground-truth-sheet.ts`）、诊断脚本，
 * 以及**渲染层的节点信息面板**全部走这里。以前各处自己乘 `design.width / app.width`，
 * 方向相反、口径各异，同一份数据能算出两个结论 —— 一旦分叉，报告就不可复现，
 * 而且出现「面板说 16、报告说 15」时谁也说不清该信哪个。
 *
 * 规则（与方案文档 §02 逐条对应）：
 *   1. `L = T(d, C)`：设计值经项目同源变换得到逻辑单位；
 *   2. `P = S(L × k)`：逻辑单位乘像素密度后按平台语义 snap 到整数像素格；
 *   3. **宽高由「哪个量」各自 snap，取决于宿主把设计值交给布局的方式** —— 见
 *      `PixelHostProfile` 与 `projectDesignEdgesByProfile` 的长注释（2026-09-29 加）；
 *   4. 最终比较的是**整数物理像素**，不是回算后的 pt / dp 小数。
 *
 * ⚠️ 这里**不许**引入 `node:crypto` / `electron` / `node:fs`：渲染层要 import 它。
 * sha256 那份契约哈希属于主进程 —— 契约类型因此拆成
 * `PixelTransformGeometry`（本文件吃这个）与 `PixelTransformContract`（多一个 `hash`）。
 */
import type { PixelTransformGeometry } from './acceptance';
import {
  PIXEL_COORDINATE_ORIGIN,
  PIXEL_SNAP_PROFILE,
  PIXEL_TRANSFORM_VERSION,
  PIXEL_VIEWPORT_SOURCE,
} from './acceptance';
import type { PixelRect, Rect } from './verify';

/* ------------------------------------------------------------------ *
 * 宿主取整档位（2026-09-29）
 * ------------------------------------------------------------------ */

/**
 * 宿主把「设计值」交给布局引擎时，取整发生在哪一步。
 *
 * 这不是调优参数，是**几何判据的语义本身**：同一个设计矩形，两种档位会算出差 1px 的期望值，
 * 而那种 1px 全部来自「谁先取整」，不代表实现有任何偏差。
 *
 * - `'presnap'`（**默认**，`screenUtils.w()` 型宿主）
 *   宿主先用 `roundToNearestPixel(v × scale)` 把每个长度属性吸附到像素格
 *   （RN 官方 API：`Math.round(v × ratio) / ratio`），布局拿到的已经是整数像素。
 *   于是「左 12 + 宽 351」是**两个各自吸附过的属性**，宽 = `S(351 × k)`。
 *
 * - `'raw'`
 *   宿主把裸比例值（`351 × 屏幕宽/设计宽`）直接交给布局，由布局引擎
 *   （Yoga `roundLayoutResultsToPixelGrid`）**按绝对边界**吸附。
 *   于是「右 = 12 + 351」是被先用到的量，宽 = `S(363 × k) − S(12 × k)`。
 *
 * ⚠️ 判错的代价是不对称的：档位与实际宿主不一致时，**正确实现会被报成差 1px**
 * （单侧投影错，另一侧就是 1px 的假阳性），而且只在「设计值 × 倍率」不是整数时出现。
 * 所以这个值**进契约、进哈希**（`PixelTransformGeometry.hostProfile`）—— 一份档位不同的
 * 契约属于另一个坐标系，必须被判为不可比对，而不是静默拿来比。
 */
export type PixelHostProfile = 'presnap' | 'raw';

/** 全部档位，按「宿主先吸附 → 布局先吸附」排列。UI 做选择器时直接用它，别另抄一份。 */
export const PIXEL_HOST_PROFILES: readonly PixelHostProfile[] = ['presnap', 'raw'];

/**
 * 默认档位。
 *
 * 选 `'presnap'` 而不是 `'raw'`，依据是**实测**而非偏好：目标宿主（MallApp / 海尔商城）
 * 的尺寸工具 `src/utils/screenUtils.ts` 走的是
 * `PixelRatio.roundToNearestPixel(width × scaleWidth)` —— 属性级预吸附。
 * 在 `w(351)` 这个真实案例上，`presnap` 算出 1011、与 SDK 实测 `pixelRect` **逐位吻合**；
 * `raw` 算出 1010，差的那 1px 是工具自己的口径差（详见 2026-09-29 日志「补七」）。
 *
 * ⚠️ 换成别的宿主（裸写设计比例值、交给 Yoga 按边界吸附）时，这个默认值就是错的 ——
 * 那时请在该快照的元数据上显式声明 `hostProfile: 'raw'`，**不要**在这里改全局默认
 * （改了会影响所有项目与历史结论）。
 */
export const PIXEL_HOST_PROFILE_DEFAULT: PixelHostProfile = 'presnap';

/** 类型收窄：外来值（JSON 解析回来的元数据）是否为合法档位 */
export function isPixelHostProfile(value: unknown): value is PixelHostProfile {
  return value === 'presnap' || value === 'raw';
}

/**
 * 把任意外来值规整成合法档位，非法（含 `undefined`）一律落回默认。
 *
 * 存在理由是「元数据来自磁盘」：`index.json` 里那个字段可能是旧版本写的、被手改过的、
 * 或干脆没有。让它在投影前就变成合法值，比让 `undefined` 一路传到判定里再表现成
 * 「两种档位都不是」要好 —— 后者只会得到一批无法解释的红。
 */
export function toPixelHostProfile(value: unknown): PixelHostProfile {
  return isPixelHostProfile(value) ? value : PIXEL_HOST_PROFILE_DEFAULT;
}

/** 一次采集的上下文 —— 描述「期望值按什么算」的三个数 + 宿主档位。契约的构造输入就是它。 */
export interface PixelTransformContext {
  /** 设计稿基准宽度（Figma 帧宽） */
  basisWidth: number;
  /** 本次快照的窗口**逻辑**宽度（SDK 上报的 windowWidth ÷ 密度） */
  viewportWidth: number;
  /** 本次截图的**物理**像素宽度（PNG IHDR 真实值） */
  pixelWidth: number;
  /**
   * 宿主取整档位。**必填**，不给默认值：这是判据语义的一部分，写错的表现是一批安静的
   * 假阳性红，而不是类型错误 —— 所以宁可每个调用点都显式写一遍。
   */
  hostProfile: PixelHostProfile;
}

/** 契约校验失败时逐字段给出的原因码（前缀统一，便于在报告里一眼揪出来） */
export const PIXEL_TRANSFORM_MISMATCH = 'PIXEL_TRANSFORM_MISMATCH';

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * 用一次采集的上下文构造**几何**（九个字段，不含哈希）。
 *
 * 上下文不完整（缺基准宽 / viewport / 截图物理宽）时返回 `null` —— 调用方据此把几何
 * 结果记为**不可判定**，而不是「扩大 epsilon 让结果看起来通过」。
 */
export function pixelTransformGeometry(input: PixelTransformContext): PixelTransformGeometry | null {
  if (!finitePositive(input.basisWidth) || !finitePositive(input.viewportWidth) || !finitePositive(input.pixelWidth)) {
    return null;
  }
  return {
    version: PIXEL_TRANSFORM_VERSION,
    basisWidth: input.basisWidth,
    viewportWidth: input.viewportWidth,
    viewportSource: PIXEL_VIEWPORT_SOURCE,
    pixelWidth: input.pixelWidth,
    pixelRatio: input.pixelWidth / input.viewportWidth,
    snapProfile: PIXEL_SNAP_PROFILE,
    coordinateOrigin: PIXEL_COORDINATE_ORIGIN,
    hostProfile: input.hostProfile,
  };
}

/**
 * snap：把逻辑边界映射到整数像素格。
 *
 * 首期只实现「普通最近整数」，因为这是真实项目用的那一种 —— RN 的
 * `roundLayoutResultsToPixelGrid` 在 iOS（两架构）与 Android 新架构下都按
 * `pointScaleFactor` 做四舍五入。⚠️ Android **旧架构**（`newArchEnabled=false`）的
 * pointScaleFactor 是 0，整段吸附会被跳过 —— 所以 snap 档位的真实维度是「平台 × 架构」，
 * 将来接入旧架构快照时必须新增一个档位，而不是复用这个。
 */
export function snapPhysical(value: number): number {
  return Math.round(value);
}

/** 设计值 → 逻辑单位（pt / dp）：项目 `w()` 的线性段，只用到基准宽与本次 viewport 宽。 */
export function projectDesignValueToLogical(value: number, contract: PixelTransformGeometry): number {
  return (value * contract.viewportWidth) / contract.basisWidth;
}

/**
 * 设计值 → App 物理像素（整数）。
 *
 * 两步刻意分开写，与方案 §02 的 `P = S(L × k, C)` 一一对应；合成的写法读起来像
 * 「一个神秘总系数」，而口径问题上最要紧的恰恰是看清有哪几步、每步用什么数。
 */
export function projectDesignValueToAppPixels(value: number, contract: PixelTransformGeometry): number {
  return snapPhysical(projectDesignValueToLogical(value, contract) * contract.pixelRatio);
}

/**
 * 设计 px → App 物理 px 的总倍率。**只用于展示**（诊断表头「缩放 3.1200」、面板上
 * 「× 2.88」这类算式）。
 *
 * ⚠️ 不要拿它去乘某个 rect 来做判定：`round(x·k) + round(w·k) ≠ round((x+w)·k)`，
 * 逐属性吸附会让宽高与边界推出的宽高差 ±1px。判定必须走 `projectDesignEdgesByProfile`。
 */
export function designToAppPixelScale(contract: PixelTransformGeometry): number {
  return (contract.pixelRatio * contract.viewportWidth) / contract.basisWidth;
}

/** 四条物理像素边界（整数） */
export interface PixelEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 设计稿矩形 → App 物理像素四条边界，**按绝对边界投影**（四条边各自取整、宽高由边相减）。
 *
 * 这是 `'raw'` 档的语义，也是本文件的**底层原语**。判定与所有对外读数请走
 * `projectDesignEdgesByProfile`（它按契约里的档位分发到这里或属性分支）——
 * 直接调本函数等于绕过档位、假定宿主是 raw。
 *
 * 为什么 raw 档不能独立 round 宽高：`S(x·k) + S(w·k)` 不一定等于 `S((x+w)·k)` —— 布局引擎
 * 是按**绝对边界相减**派生尺寸的，实测 7320 样本里 24.8% 差 ±1px。屏幕上最终占据哪些像素
 * 由两条边决定，所以这一档只算边。
 */
export function projectDesignEdgesToAppPixels(rect: Rect, contract: PixelTransformGeometry): PixelEdges {
  return {
    left: projectDesignValueToAppPixels(rect.x, contract),
    top: projectDesignValueToAppPixels(rect.y, contract),
    right: projectDesignValueToAppPixels(rect.x + rect.width, contract),
    bottom: projectDesignValueToAppPixels(rect.y + rect.height, contract),
  };
}

/**
 * 同上的 `Rect` 形态（`'raw'` 档）。`width` / `height` 是**两条边相减的结果**。
 */
export function projectDesignRectToAppPixels(rect: Rect, contract: PixelTransformGeometry): PixelRect {
  const edges = projectDesignEdgesToAppPixels(rect, contract);
  return {
    x: edges.left,
    y: edges.top,
    width: edges.right - edges.left,
    height: edges.bottom - edges.top,
  };
}

/**
 * **分档入口**：设计稿矩形 → App 物理像素四边，按宿主实际取整的位置投影。
 *
 * 两个档位算的是同一件事，只是「先取整哪一个量」不同：
 *
 * ```
 *   presnap（w() 型宿主）        raw（裸值型宿主）
 *   ─────────────────────        ─────────────────
 *   左 = S(x·k)                 左 = S(x·k)          ← 两档恒等
 *   宽 = S(w·k)                 右 = S((x+w)·k)
 *   右 = 左 + 宽                宽 = 右 − 左
 * ```
 *
 * 为什么必须分档：设计稿给的是「左 12 + 宽 351」，`w()` 型宿主照写 `w(12)` + `w(351)` ——
 * 四个数里**根本没有「右边界」这个量**。此时按边界投影等于凭空合成一个没人写过的
 * `x + width = 363` 再取整，于是 `S(363·k) = 1045` 而宿主实得 `S(351·k) = 1011`
 * （`w(351)` 已在属性级吸附过），宽度凭空差 1px。反过来，`raw` 宿主的两条边才是布局真正
 * 吸附的输入，那时属性级投影又会错。
 *
 * ⚠️ 左 / 上两档恒等 —— 这带来一个有用的性质：**纵向与横向的偏移判断与档位无关**，
 * 所以「这批节点整体偏了 4px」这类结论不会因为换档而变化；变的只有宽 / 高（及其推出的右 / 下）。
 */
export function projectDesignEdgesByProfile(
  rect: Rect,
  contract: PixelTransformGeometry,
  profile: PixelHostProfile,
): PixelEdges {
  if (profile === 'raw') return projectDesignEdgesToAppPixels(rect, contract);
  const left = projectDesignValueToAppPixels(rect.x, contract);
  const top = projectDesignValueToAppPixels(rect.y, contract);
  // ⚠️ 宽 / 高走 `projectDesignValueToAppPixels` 这条**单值**出口，不是 `S((x+w)·k) − 左`。
  // 这正是 `w()` 的行为：它对每个属性各调一次 `roundToNearestPixel`，属性之间不相互参照。
  const width = projectDesignValueToAppPixels(rect.width, contract);
  const height = projectDesignValueToAppPixels(rect.height, contract);
  return { left, top, right: left + width, bottom: top + height };
}

/** 分档入口的 `Rect` 形态（`presnap` 下 `width` 就是 `S(w·k)` 本身，不再由边相减推出）。 */
export function projectDesignRectByProfile(
  rect: Rect,
  contract: PixelTransformGeometry,
  profile: PixelHostProfile,
): PixelRect {
  const edges = projectDesignEdgesByProfile(rect, contract, profile);
  return {
    x: edges.left,
    y: edges.top,
    width: edges.right - edges.left,
    height: edges.bottom - edges.top,
  };
}
