/** Manual acceptance uses device logical units. Screenshot/export scaling is unrelated. */
export type AcceptanceLength = 'width' | 'height' | 'radius' | 'borderWidth' | 'fontSize' | 'lineHeight' | 'letterSpacing' | 'spacing';
export interface AcceptanceRule {
  scale: 'fixed' | 'width' | 'height' | 'min' | 'unknown';
  /** Applied to a scalar before native layout. No implicit rounding for radii. */
  rounding: 'none' | 'nearest-pixel' | 'logical-integer' | 'pixel-then-integer';
}
export type AcceptanceRules = Partial<Record<AcceptanceLength, AcceptanceRule>>;
export interface AcceptanceDesignContract {
  /** Reference viewport in Figma design units, not the exported PNG dimensions. */
  width: number;
  height: number;
  /** 1 for a 1x design; 2 for a design drawn at 2x. Never use PNG exportScale here. */
  unitsPerPoint: number;
  rules: AcceptanceRules;
}
export interface AcceptanceContext {
  version: 1;
  logicalUnit: 'dp' | 'pt';
  /** Host's actual adaptation viewport, sampled with the capture. */
  viewport: { width: number; height: number };
  pixelRatio: number;
  fontScale: number;
  design?: AcceptanceDesignContract;
}

const lengths: AcceptanceLength[] = ['width', 'height', 'radius', 'borderWidth', 'fontSize', 'lineHeight', 'letterSpacing', 'spacing'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Validate at both integration and upload boundaries; invalid data must not silently become fixed sizing. */
export function validateAcceptanceRules(value: unknown): asserts value is AcceptanceRules {
  if (!object(value)) throw new Error('验收规则必须是对象');
  for (const [key, rule] of Object.entries(value)) {
    if (!lengths.includes(key as AcceptanceLength) || !object(rule)
      || !['fixed', 'width', 'height', 'min', 'unknown'].includes(String(rule.scale))
      || !['none', 'nearest-pixel', 'logical-integer', 'pixel-then-integer'].includes(String(rule.rounding))) {
      throw new Error(`验收规则无效：${key}`);
    }
  }
}

export function validateAcceptanceDesign(value: unknown): asserts value is AcceptanceDesignContract {
  if (!object(value) || !positive(value.width) || !positive(value.height) || !positive(value.unitsPerPoint)) {
    throw new Error('验收设计基准宽高及设计倍率必须为正数');
  }
  validateAcceptanceRules(value.rules);
}

export function validateAcceptanceContext(value: unknown): asserts value is AcceptanceContext {
  if (!object(value) || value.version !== 1 || !['dp', 'pt'].includes(String(value.logicalUnit))
    || !object(value.viewport) || !positive(value.viewport.width) || !positive(value.viewport.height)
    || !positive(value.pixelRatio) || !positive(value.fontScale)) throw new Error('验收上下文无效');
  if (value.design !== undefined) validateAcceptanceDesign(value.design);
}

export function acceptanceTarget(value: number, rule: AcceptanceRule, context: AcceptanceContext): number | null {
  const design = context.design;
  if (!design || !Number.isFinite(value) || rule.scale === 'unknown') return null;
  const sw = context.viewport.width / (design.width / design.unitsPerPoint);
  const sh = context.viewport.height / (design.height / design.unitsPerPoint);
  const factor = rule.scale === 'width' ? sw : rule.scale === 'height' ? sh : rule.scale === 'min' ? Math.min(sw, sh) : 1;
  const logical = value / design.unitsPerPoint * factor;
  const snapped = Math.round(logical * context.pixelRatio) / context.pixelRatio;
  if (rule.rounding === 'nearest-pixel') return snapped;
  if (rule.rounding === 'logical-integer') return Math.round(logical);
  if (rule.rounding === 'pixel-then-integer') return Math.round(snapped);
  return logical;
}
