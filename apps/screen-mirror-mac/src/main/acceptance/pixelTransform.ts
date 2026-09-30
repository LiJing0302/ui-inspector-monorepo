/**
 * 契约的**哈希与校验**层。投影数学不在这里 —— 它在 `@shared/pixelTransform`
 * （`src/types/pixelTransform.ts`）。
 *
 * 2026-09-29 拆分的唯一原因：渲染层的节点信息面板要展示「Figma 节点投影后的物理像素」，
 * 而 sha256 走 `node:crypto`，进不了浏览器包。于是把纯数学下沉到 `src/types/`
 * （`@shared`，两套 tsconfig 都 include、三个构建都配了别名），本文件只留：
 *   · `createPixelTransformContract` —— 几何 + 哈希；
 *   · `pixelTransformRejectionReasons` —— 与当前采集逐字段比（含哈希）；
 * 并把共享层的函数**原样再导出**，于是 `core.ts` / `groundTruthExport.ts` /
 * `debugExport.ts` / 三个诊断脚本的 import 一行都不用改。
 *
 * ⚠️ 投影函数仍然只有一份实现。这里若出现第二份 `Math.round(x * ratio)`,
 * 就是方案明令禁止的那种分叉 —— 面板与报告会给出不同数字。
 *
 * 2026-09-29：契约新增 `hostProfile`（宿主取整档位）。它既是**身份字段**（进哈希、参与
 * 逐字段校验），也是**投影的入参**（`projectDesignEdgesByProfile` 按它分发）——
 * 一份档位不同的契约算出来的期望值属于另一个坐标系，必须判为不可比对。
 */

import { createHash } from 'node:crypto';

import type { PixelTransformContract, PixelTransformGeometry } from '../../types/acceptance';
import {
  PIXEL_COORDINATE_ORIGIN,
  PIXEL_SNAP_PROFILE,
  PIXEL_TRANSFORM_VERSION,
  PIXEL_VIEWPORT_SOURCE,
} from '../../types/acceptance';
import {
  PIXEL_HOST_PROFILE_DEFAULT,
  PIXEL_HOST_PROFILES,
  PIXEL_TRANSFORM_MISMATCH,
  designToAppPixelScale,
  isPixelHostProfile,
  pixelTransformGeometry,
  projectDesignEdgesByProfile,
  projectDesignEdgesToAppPixels,
  projectDesignRectByProfile,
  projectDesignRectToAppPixels,
  projectDesignValueToAppPixels,
  projectDesignValueToLogical,
  snapPhysical,
  toPixelHostProfile,
} from '../../types/pixelTransform';
import type { PixelEdges, PixelHostProfile, PixelTransformContext } from '../../types/pixelTransform';

export {
  PIXEL_HOST_PROFILE_DEFAULT,
  PIXEL_HOST_PROFILES,
  PIXEL_TRANSFORM_MISMATCH,
  designToAppPixelScale,
  isPixelHostProfile,
  pixelTransformGeometry,
  projectDesignEdgesByProfile,
  projectDesignEdgesToAppPixels,
  projectDesignRectByProfile,
  projectDesignRectToAppPixels,
  projectDesignValueToAppPixels,
  projectDesignValueToLogical,
  snapPhysical,
  toPixelHostProfile,
};
export type { PixelEdges, PixelHostProfile, PixelTransformContext };

/**
 * 哈希载荷 = **显式字段序数组**，不是 `JSON.stringify(对象)`。
 *
 * 对象键序取决于构造 / 解析时的插入顺序：同一个契约经过一次「parse → 改个无关字段 →
 * stringify」往返就可能换序，于是哈希对不上、几何被误判成不可判定。数组把顺序写死在
 * 代码里，这条偶发失败路径就没了。
 */
function contractPayload(contract: PixelTransformGeometry): string {
  return JSON.stringify([
    contract.version,
    contract.basisWidth,
    contract.viewportWidth,
    contract.viewportSource,
    contract.pixelWidth,
    contract.pixelRatio,
    contract.snapProfile,
    contract.coordinateOrigin,
    // `hostProfile` 追加在**末尾**（2026-09-29）。加字段本身必然改哈希 —— 那正是我们要的：
    // 档位不同的契约属于另一套坐标系。放在末尾只是为了「版本升级时对照两版载荷」好读。
    contract.hostProfile,
  ]);
}

function hashOf(contract: PixelTransformGeometry): string {
  return `sha256:${createHash('sha256').update(contractPayload(contract)).digest('hex')}`;
}

/**
 * 用一次采集的上下文构造契约（几何 + 哈希）。
 *
 * 上下文不完整时返回 `null` —— 调用方据此把几何结果记为**不可判定**，而不是
 * 「扩大 epsilon 让结果看起来通过」。哈希的**顺序**由本文件的 `contractPayload` 定，
 * 几何的**取值**由 `@shared/pixelTransform#pixelTransformGeometry` 定，两处都不是第二份实现。
 */
export function createPixelTransformContract(input: PixelTransformContext): PixelTransformContract | null {
  const geometry = pixelTransformGeometry(input);
  if (!geometry) return null;
  return { ...geometry, hash: hashOf(geometry) };
}

/**
 * 校验一份**外来**契约（从报告 / 调试包 / 真值包 `JSON.parse` 回来的那份）与当前这次
 * 采集是否同一套规则。返回逐字段的原因码数组：空数组 = 通过。
 *
 * 为什么要校验而不是直接信：契约的用途就是让「期望值按什么算」可追溯。一份版本或
 * snap 档位不同的契约，算出来的期望值属于另一个坐标系 —— 拿它去比，得到的是一批
 * 看着很合理、其实毫无意义的红。方案 A4 / A5 要求这种情形报**不可判定**，不是 FAIL。
 */
export function pixelTransformRejectionReasons(
  contract: PixelTransformContract | null | undefined,
  expected: PixelTransformContext,
): string[] {
  if (!contract) return ['PIXEL_TRANSFORM_MISSING'];
  const reasons: string[] = [];
  // 身份字段：对着常量比。类型上是 string，就是为了让「不相等」可表示（见类型定义处的注释）。
  if (contract.version !== PIXEL_TRANSFORM_VERSION) reasons.push('PIXEL_TRANSFORM_VERSION');
  if (contract.viewportSource !== PIXEL_VIEWPORT_SOURCE) reasons.push('PIXEL_TRANSFORM_VIEWPORT_SOURCE');
  if (contract.snapProfile !== PIXEL_SNAP_PROFILE) reasons.push('PIXEL_TRANSFORM_SNAP_PROFILE');
  if (contract.coordinateOrigin !== PIXEL_COORDINATE_ORIGIN) reasons.push('PIXEL_TRANSFORM_COORDINATE_ORIGIN');
  // 宿主档位：与本次采集解析出来的档位比。档位不同 ⇒ 期望值的**算法**不同（宽高是按属性投影
  // 还是按边界相减），同一份快照能算出差 1px 的两套期望值 —— 这种「看着合理其实无意义」的
  // 红正是契约机制要拦下来的东西。
  if (contract.hostProfile !== expected.hostProfile) reasons.push('PIXEL_TRANSFORM_HOST_PROFILE');
  // 数值字段：用 `!==` 而不是容差比较。两端都是同一条算式的产物，相等的就该逐位相等；
  // 放宽只会让「基准宽差 0.5」这种真错漏过去。
  if (contract.basisWidth !== expected.basisWidth) reasons.push('PIXEL_TRANSFORM_BASIS_WIDTH');
  if (contract.viewportWidth !== expected.viewportWidth) reasons.push('PIXEL_TRANSFORM_VIEWPORT_WIDTH');
  if (contract.pixelWidth !== expected.pixelWidth) reasons.push('PIXEL_TRANSFORM_PIXEL_WIDTH');
  const expectedRatio = expected.pixelWidth / expected.viewportWidth;
  // 只有这一个用容差：它是除法的产物，不同实现路径（先乘后除 / 先除后乘）可能有末位差，
  // 而它本身不参与投影（投影直接用 pixelWidth），差个末位不影响结论。
  if (!Number.isFinite(contract.pixelRatio) || Math.abs(contract.pixelRatio - expectedRatio) > 1e-9) {
    reasons.push('PIXEL_TRANSFORM_PIXEL_RATIO');
  }
  const { hash, ...payload } = contract;
  if (hash !== hashOf(payload)) reasons.push('PIXEL_TRANSFORM_HASH');
  return reasons;
}

/** `pixelTransformRejectionReasons` 的布尔形态（需要类型收窄时用） */
export function isPixelTransformContractValid(
  contract: PixelTransformContract | null | undefined,
  expected: PixelTransformContext,
): contract is PixelTransformContract {
  return pixelTransformRejectionReasons(contract, expected).length === 0;
}
