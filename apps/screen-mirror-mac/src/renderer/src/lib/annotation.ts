import type { VerifySource } from '@shared/verify';

export type AnnotationTool = 'picker' | 'rect' | 'arrow';

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface RasterAnnotation {
  id: string;
  kind: Exclude<AnnotationTool, 'picker'>;
  source: VerifySource;
  start: AnnotationPoint;
  end: AnnotationPoint;
}

export interface ColorSample {
  source: VerifySource;
  color: string;
  point: AnnotationPoint;
}

/**
 * 一组标注里用过的最大序号（`annotation-7` → 7）。
 *
 * 标注要从**配对会话**里恢复回来（切 tab / 切配对不该把画好的标注丢掉），而画标注时
 * 序号是靠一个组件内计数器递增的 —— 那个计数器随组件重建归零，恢复回来的
 * `annotation-1..n` 与新建的就会**撞 id**（React key 重复 → 列表错位）。
 * 所以计数器不能从 0 起，要从「已经用过的最大号」起。
 *
 * 认不出的 id（非 `annotation-N` 形状）当 0 处理：它只是计数器的参照，不影响标注本身。
 */
export function annotationSeq(list: readonly RasterAnnotation[]): number {
  let max = 0;
  for (const item of list) {
    const digits = /(\d+)\s*$/.exec(item.id);
    if (!digits) continue;
    const value = Number(digits[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}
