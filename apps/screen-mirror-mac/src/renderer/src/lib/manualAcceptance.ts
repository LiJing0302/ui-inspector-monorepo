import type { AppNode, DesignNode, Rect } from '@shared/verify';
import { buildCompareFields, type AppAlignContext, type CompareValue } from './comparison';

export type ManualStatus = 'consistent' | 'reference' | 'discrepancy' | 'insufficient' | 'not-applicable';
export const manualStatusLabel: Record<ManualStatus, string> = {
  consistent: '数值一致', reference: '仅供参考', discrepancy: '存在偏差', insufficient: '信息不足',
  'not-applicable': '无需比较',
};
export interface ManualField {
  label: string;
  design: CompareValue;
  target: CompareValue;
  actual: CompareValue;
  status: ManualStatus;
  reason: string;
  /** Physical values are diagnostics, never independently rounded measurements. */
  physical?: string;
  sources?: { design?: PropertySources; app?: PropertySources };
}
export interface PropertySources {
  state: 'resolved' | 'ambiguous';
  reason: string;
  candidates: { id: string; name: string; value: CompareValue; ignored?: boolean }[];
}
/** Display only explicit values; zero is a value, absence and uncertainty are not. */
export const hasExplicitValue = (value: CompareValue): boolean => value.state === 'value'
  && value.text.trim() !== '' && (!value.numbers || value.numbers.every(Number.isFinite));
/** A conflicting summary has no single value, but its collected layer values are still displayable. */
export const hasPropertyValue = (value: CompareValue, sources?: PropertySources): boolean => hasExplicitValue(value)
  || (sources?.state === 'ambiguous' && sources.candidates.some(c => !c.ignored && hasExplicitValue(c.value)));
export const visibleManualFields = (fields: ManualField[]): ManualField[] =>
  fields.filter(field => hasPropertyValue(field.design, field.sources?.design) || hasPropertyValue(field.actual, field.sources?.app));

export const roundManualNumber = (value: number): number => Number(value.toFixed(2));
const num = (value: number): string => roundManualNumber(value).toString();
const missing = (text: string): CompareValue => ({ text, key: '', state: 'unavailable' });
export const formatManualNumbers = (values: number[], unit = ''): string => {
  const rounded = values.map(roundManualNumber);
  const folded = rounded.every((n) => n === rounded[0]) ? rounded.slice(0, 1) : rounded;
  return folded.map(num).join(' / ') + (unit ? ` ${unit}` : '');
};
const valueOf = (values: number[], unit = ''): CompareValue => {
  const text = formatManualNumbers(values, unit);
  return { text, key: text, state: 'value', numbers: values };
};
export const logicalUnit = (align?: AppAlignContext): string => align?.platform === 'ios' ? 'pt'
  : align?.platform === 'android' ? 'dp' : align?.acceptanceContext?.logicalUnit ?? '逻辑单位';

const manualLengths = new Set(['宽度', '高度', '圆角', '描边宽度', '字号', '行高', '字距',
  '左边距离', '右边距离', '上边距离', '下边距离', '水平间距', '垂直间距']);
export const isManualLength = (label: string): boolean => manualLengths.has(label);
/** Same width alignment as the canvas; device page width remains the acceptance target basis. */
export function designAlignedScale(align?: AppAlignContext): number | undefined {
  if (!align || !Number.isFinite(align.designWidth) || align.designWidth <= 0
    || !Number.isFinite(align.appWidth) || align.appWidth <= 0) return undefined;
  const scale = align.designWidth / align.appWidth;
  return Number.isFinite(scale) && scale > 0 ? scale : undefined;
}
/** Presentation only. Never feed the projected values back into comparison or grouping. */
export function displayLengthValue(value: CompareValue, scale?: number): CompareValue {
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0 || !hasExplicitValue(value)
    || !value.numbers?.length) return value;
  const projected = value.numbers.map(n => n * scale);
  return projected.every(Number.isFinite) ? valueOf(projected, 'px') : missing('无法换算');
}

/** Page width is environment metadata, never a declared SDK adaptation policy. */
export const devicePageWidth = (align?: AppAlignContext): number | undefined => align?.devicePageWidth ?? align?.appWidth;
export function targetBasis(align?: AppAlignContext): string {
  const width = devicePageWidth(align);
  return `设计原值 × 设备页面宽度 ${width === undefined ? '未采集' : num(width)} ${logicalUnit(align)} ÷ 设计稿宽度 ${align ? num(align.designWidth) : '未采集'} px`;
}

/** Platform acceptance convention: all length targets use the same design-to-page width ratio. */
export function lengthField(
  label: string, design: number[] | undefined, actual: number[] | undefined,
  align?: AppAlignContext, unavailableReason?: string,
): ManualField {
  const unit = logicalUnit(align);
  const field: ManualField = {
    label, design: design ? valueOf(design, 'px') : missing('无数值要求'),
    target: missing('缺少页面尺寸'), actual: actual ? valueOf(actual, unit) : missing('未采集'),
    status: 'insufficient', reason: '',
  };
  const density = align?.pixelRatio;
  if (actual && density && Number.isFinite(density) && density > 0) field.physical = valueOf(actual.map((v) => v * density), 'px').text;
  if (!design) { field.target = missing('无数值要求'); field.reason = '设计未提供可比较的数值要求'; return field; }
  const width = devicePageWidth(align);
  if (!align || !Number.isFinite(align.designWidth) || align.designWidth <= 0
    || width === undefined || !Number.isFinite(width) || width <= 0) {
    field.reason = '缺少有效的设计稿宽度或设备页面逻辑宽度，无法计算预期值'; return field;
  }
  const expected = design.map((v) => v * width / align.designWidth);
  if (!expected.every(Number.isFinite)) { field.reason = '设计数值无效'; return field; }
  field.target = valueOf(expected, unit);
  field.reason = targetBasis(align);
  // Dynamic geometry and font environment affect comparison confidence, never the target calculation.
  if (unavailableReason) { field.reason += `；${unavailableReason}，应有值仅作设计比例参考`; return field; }
  if (!actual || actual.length !== expected.length) { field.reason += '；缺少完整的运行时属性，无法比较'; return field; }
  const delta = Math.max(...expected.map((v, i) => Math.abs(v - actual[i])));
  // Ignore only floating-point arithmetic noise, never a logical/physical pixel allowance.
  const equal = expected.every((value, i) => Math.abs(value - actual[i]) <=
    Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(actual[i])) * 8);
  field.status = equal ? 'consistent' : 'discrepancy';
  if (field.status === 'discrepancy') field.reason += `；最大差值 ${num(delta)} ${unit}`;
  return field;
}

const one = (v: unknown): number[] | undefined => typeof v === 'number' && Number.isFinite(v) ? [v] : undefined;
const slots = (v: number | number[] | null | undefined): number[] | undefined =>
  typeof v === 'number' ? [v, v, v, v] : Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) ? v : undefined;

/** A stored strokeWeight is configuration, not evidence of an enabled stroke paint. */
export function designStroke(node: DesignNode): {
  state: 'present' | 'none' | 'unknown'; width: CompareValue; widths?: number[]; reason: string;
} {
  const transparent = (color?: string): boolean => !!color && /^#[0-9a-f]{8}$/i.test(color) && color.slice(-2) === '00';
  const paints = node.strokes?.filter(paint => paint.visible !== false && paint.opacity !== 0
    && !transparent(paint.color) && !(paint.type.startsWith('GRADIENT') && paint.gradientStops?.length
      && paint.gradientStops.every(stop => transparent(stop.color))));
  if (node.opacity === 0 || (paints ? paints.length === 0 : node.hasFill === false)) {
    return { state: 'none', width: { text: '无描边', key: '', state: 'empty' },
      reason: '此节点没有生效的描边；保留的描边宽度配置不作为数值验收要求，仍需人工核对 App 是否多出描边' };
  }
  if (!paints) return { state: 'unknown', width: missing('未确认'), reason: '缺少描边 paint 信息，不能仅凭宽度配置确认存在描边' };
  const widths = slots(node.strokeWeight);
  const complete = widths?.every(v => Number.isFinite(v) && v >= 0) ? widths : undefined;
  return { state: 'present', widths: complete, width: complete ? valueOf(complete, 'px') : missing('未确认'),
    reason: complete ? '已启用描边，按设计宽度计算应有值' : '已启用描边，但缺少完整有效的描边宽度' };
}
export const runtimeCorners = (app: AppNode): number[] | undefined => {
  const v = app.style?.borderRadius;
  if (v == null) return undefined;
  const values = [v.topLeft, v.topRight, v.bottomRight, v.bottomLeft];
  return values.every((n): n is number => typeof n === 'number' && Number.isFinite(n)) ? values : undefined;
};
/** Acceptance convention only: an absent radius has the same effect as design radius zero.
 * Keep partial samples unknown and never manufacture a runtime measurement. */
const runtimeCornersUnset = (app: AppNode): boolean => {
  if (app.style?.borderRadiusIncomplete) return false;
  const v = app.style?.borderRadius;
  return v == null || [v.topLeft, v.topRight, v.bottomRight, v.bottomLeft].every(n => n == null);
};
export const runtimeBorderWidths = (app: AppNode): number[] | undefined => {
  const v = app.style?.borderWidth;
  if (v == null) return undefined;
  const values = [v.top, v.right, v.bottom, v.left];
  return values.every((n): n is number => typeof n === 'number' && Number.isFinite(n)) ? values : undefined;
};

/** Runtime geometry is recovered from the retained native rectangle with the native density. */
export function runtimeRect(app: AppNode, align?: AppAlignContext): Rect {
  if (app.pixelRect && align?.pixelRatio) {
    const d = align.pixelRatio;
    return { x: app.pixelRect.x / d, y: app.pixelRect.y / d, width: app.pixelRect.width / d, height: app.pixelRect.height / d };
  }
  return app;
}

export function buildManualFields(design: DesignNode, app: AppNode, align?: AppAlignContext): ManualField[] {
  const rect = runtimeRect(app, align);
  const stroke = designStroke(design);
  const dimensions: Record<string, { design?: number[]; actual?: number[] }> = {
    宽度: { design: one(design.rect.width), actual: one(rect.width) },
    高度: { design: one(design.rect.height), actual: one(rect.height) },
    圆角: { design: slots(design.cornerRadius), actual: runtimeCorners(app) },
    描边宽度: { design: stroke.widths, actual: runtimeBorderWidths(app) },
    字号: { design: one(design.text?.fontSize), actual: one(app.textStyle?.fontSize) },
    行高: { design: one(design.text?.lineHeight), actual: one(app.textStyle?.lineHeight) },
    字距: { design: one(design.text?.letterSpacing), actual: one(app.textStyle?.letterSpacing) },
  };
  return buildCompareFields(design, app, 1).map((field): ManualField => {
    // Figma TEXT fills paint glyphs, while the App fill column reads box backgroundColor.
    // Keep the glyph paint in the original node and text color; never compare it as a background.
    if (field.label === '填充' && design.type === 'TEXT') {
      field = { ...field, design: { text: '', key: '', state: 'empty' } };
    }
    if (field.label === '描边色' && stroke.state !== 'present') {
      const value = stroke.state === 'none' ? stroke.width : missing('未确认');
      return { label: field.label, design: value, target: value, actual: field.app,
        status: stroke.state === 'none' ? 'not-applicable' : 'insufficient', reason: stroke.reason };
    }
    const length = dimensions[field.label];
    if (length) {
      let reason: string | undefined;
      let layoutNote: string | undefined;
      const axis = field.label === '宽度' ? 'Horizontal' : field.label === '高度' ? 'Vertical' : null;
      const sizing = axis === 'Horizontal' ? design.layoutSizingHorizontal : design.layoutSizingVertical;
      if (axis && (sizing === 'HUG' || sizing === 'FILL')) layoutNote = sizing === 'HUG' ? '设计尺寸随内容变化，按当前设计框比较' : '设计尺寸随容器变化，按当前设计框比较';
      const constraint = axis === 'Horizontal' ? design.constraints?.horizontal : design.constraints?.vertical;
      if (axis && (constraint === 'STRETCH' || constraint === 'SCALE')) layoutNote = '设计尺寸随约束变化，按当前设计框比较';
      if (axis && design.text?.textAutoResize && design.text.textAutoResize !== 'NONE'
        && (axis === 'Vertical' || design.text.textAutoResize === 'WIDTH_AND_HEIGHT')) reason = '随文本内容变化';
      if (axis && (design.rectEstimated || design.rotation)) reason = '设计框需人工确认';
      if (field.group === '文本' && align?.acceptanceContext && Math.abs(align.acceptanceContext.fontScale - 1) > 1e-4) reason = '字体缩放需人工确认';
      const result = lengthField(field.label, length.design, length.actual, align, reason);
      if (field.label === '圆角' && length.design?.every(v => v === 0) && runtimeCornersUnset(app)) {
        result.target = valueOf(length.design, logicalUnit(align));
        result.status = 'consistent';
        result.reason = '设计圆角为 0，App 未设置圆角，按无圆角效果判为一致；未补写 App 实测值';
      }
      if (layoutNote) result.reason += `；${layoutNote}`;
      if (axis && (design.type === 'TEXT' || typeof app.text === 'string')) {
        result.status = 'reference';
        result.reason = '文本节点宽高仅展示数值供参考；换行、截断、位置和占位范围请通过节点叠图检查';
      }
      if (field.label === '描边宽度' && !stroke.widths) {
        result.design = stroke.width; result.target = stroke.width;
        result.status = stroke.state === 'none' ? 'not-applicable' : 'insufficient'; result.reason = stroke.reason;
      }
      return result;
    }
    const paints = field.label === '填充' && design.type !== 'TEXT' ? design.fills : field.label === '描边色' ? design.strokes : undefined;
    const visible = paints?.filter((paint) => paint.visible !== false);
    const simplePaint = !visible || visible.length === 0 || (visible.length === 1 && visible[0].type === 'SOLID');
    // A native linear gradient is now a first-class SDK property. It is comparable when
    // Figma has exactly one linear gradient and the App side captured at least two stops;
    // images, radial/multi-paint composites, and incomplete gradients remain review-only.
    const linearGradient = field.label === '填充' && design.type !== 'TEXT'
      && visible?.length === 1 && visible[0].type === 'GRADIENT_LINEAR'
      && app.style?.gradient?.colors?.length !== undefined && app.style.gradient.colors.length >= 2;
    const comparable = field.comparable !== false && (simplePaint || linearGradient)
      && field.design.state !== 'unavailable' && field.app.state !== 'unavailable';
    const equal = field.label === '内容' ? field.design.text === field.app.text : field.design.key === field.app.key;
    return { label: field.label, design: field.design, target: field.design, actual: field.app,
      status: !comparable ? 'insufficient' : equal ? 'consistent' : 'discrepancy',
      reason: comparable ? '按原始属性比较；外观仍需人工检查' : '属性未采集或不适用' };
  });
}

export interface SpacingSample { selected: Rect; other: Rect; selectedId?: string; otherId?: string }
function spacingValues(sample?: SpacingSample): Map<string, number> {
  if (!sample) return new Map();
  const { selected: a, other: b } = sample;
  const contains = (outer: Rect, inner: Rect): boolean => inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  if (contains(a, b) || contains(b, a)) {
    const [outer, inner] = contains(a, b) ? [a, b] : [b, a];
    return new Map([
      ['左边距离', inner.x - outer.x], ['右边距离', outer.x + outer.width - inner.x - inner.width],
      ['上边距离', inner.y - outer.y], ['下边距离', outer.y + outer.height - inner.y - inner.height],
    ]);
  }
  const x = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
  const y = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
  return new Map([...(x >= -1e-6 ? [['水平间距', Math.max(0, x)] as [string, number]] : []),
    ...(y >= -1e-6 ? [['垂直间距', Math.max(0, y)] as [string, number]] : [])]);
}
export function buildSpacingFields(design: SpacingSample | undefined, app: SpacingSample | undefined, align?: AppAlignContext): ManualField[] {
  const d = spacingValues(design), a = spacingValues(app);
  // Preserve a zero gap and report overlap as a negative gap. Drawing thresholds must never hide a failed measurement.
  if (app) for (const [label, axis] of [['水平间距', 'x'], ['垂直间距', 'y']] as const) {
    if (d.has(label) && !a.has(label)) {
      const { selected: s, other: o } = app;
      const size = axis === 'x' ? 'width' : 'height';
      a.set(label, Math.max(s[axis], o[axis]) - Math.min(s[axis] + s[size], o[axis] + o[size]));
    }
  }
  return [...new Set([...d.keys(), ...a.keys()])].map((label) => {
    const field = lengthField(label, one(d.get(label)), one(a.get(label)),
      align);
    if (design && app && d.has(label) && a.has(label)) {
      const relation = (sample: SpacingSample): boolean => label === '水平间距' ? sample.selected.x < sample.other.x
        : label === '垂直间距' ? sample.selected.y < sample.other.y
          : sample.selected.width >= sample.other.width && sample.selected.height >= sample.other.height;
      if (relation(design) !== relation(app)) {
        field.status = 'insufficient';
        field.reason = '两侧选中元素与测距元素的相对位置或包含关系不同，请核对对应边';
      }
    }
    return field;
  });
}

export function manualEvidence(fields: ManualField[], align?: AppAlignContext): string {
  const scale = designAlignedScale(align);
  return [
    `人工元素验收（${logicalUnit(align)}；SDK ${align?.sdkVersion ?? '未记录'}）`,
    ...(scale === undefined ? [] : [`显示口径：对齐设计稿的 px；App 原始逻辑值 × ${scale}（设计稿宽 ÷ 截图逻辑宽），不取整`,
      ...fields.filter(field => isManualLength(field.label)).map(field =>
        `${field.label}对齐显示：设计 ${field.design.text} → 应有 ${displayLengthValue(field.target, scale).text} → App ${displayLengthValue(field.actual, scale).text}`)]),
    ...fields.map((field) => `${field.label}：设计 ${field.design.text} → 应有 ${field.target.text} → 实测 ${field.actual.text}；${manualStatusLabel[field.status]}（${field.reason}）`),
    ...fields.filter(field => field.sources).map(field => `${field.label}属性来源：${JSON.stringify(field.sources)}`),
    `预期值口径：${targetBasis(align)}；连续逻辑值，不按密度取整，不读取 SDK 适配规则`,
    align?.acceptanceContext ? `采集环境（不作为预期值规则）：${JSON.stringify(align.acceptanceContext)}` : '未附加 SDK 验收上下文（不影响预期值计算）',
  ].join('\n');
}
