import { toRenderNode, type AppNode, type DesignNode, type VerifySource } from '@shared/verify';
import { buildManualFields, designAlignedScale, isManualLength, roundManualNumber, type ManualField, type PropertySources } from './manualAcceptance';
import type { AppAlignContext, CompareValue } from './comparison';
import { participatesInStack, sameStackBounds, stackOf } from './stack';

export interface InspectionGroup<T> { anchor: T; members: T[] }
export interface InspectionGroups { design?: InspectionGroup<DesignNode>; app?: InspectionGroup<AppNode> }
export type InspectionScope = 'element' | 'layer';
export interface ResolvedProperty<T> {
  label: string;
  value: CompareValue;
  owner: T;
  sources: PropertySources;
}
const unavailable = (text = '未采集'): CompareValue => ({ text, key: '', state: 'unavailable' });
// Neutral counterparts only let the existing formatter read one real node's properties.
// They never become selected nodes, group members, comparison owners or issue targets.
const emptyDesign: DesignNode = { id: '', name: '', type: 'FRAME', path: '', depth: 0,
  parentId: null, visible: true, rect: { x: 0, y: 0, width: 0, height: 0 } };
const emptyApp: AppNode = { nodeId: '', parentId: null, className: '', depth: 0, index: 0,
  x: 0, y: 0, width: 0, height: 0, visibleX: 0, visibleY: 0, visibleWidth: 0, visibleHeight: 0,
  scrollX: 0, scrollY: 0, visible: true, enabled: true, clickable: false, alpha: 1, z: 0, elevation: 0,
  clipsToBounds: false, isImage: false, isSvg: false, isGradient: false, hasVisualContent: false,
  resourceName: null, contentDescription: null, text: null, textStyle: null, style: null };
const order = ['宽度', '高度', '内容', '字体', '字号', '字重', '行高', '字距', '颜色', '辅助描述', '填充', '描边色', '描边宽度', '圆角'];
const textLabels = new Set(['内容', '字体', '字号', '字重', '行高', '字距', '颜色', '辅助描述']);
const geometry = (label: string): boolean => label === '宽度' || label === '高度';
const idOf = (source: VerifySource, node: DesignNode | AppNode): string => source === 'design' ? (node as DesignNode).id : (node as AppNode).nodeId;
const nameOf = (source: VerifySource, node: DesignNode | AppNode): string => source === 'design'
  ? (node as DesignNode).name || (node as DesignNode).type : (node as AppNode).className.split('.').pop() || (node as AppNode).className;

/** Both sides require exact bounds; anchors always remain real selected nodes. */
export function inspectDesign(anchor: DesignNode, nodes: readonly DesignNode[]): InspectionGroup<DesignNode> {
  const ids = new Set(stackOf(nodes.map(n => toRenderNode(n, 'design')), anchor.id).map(n => n.id));
  return { anchor, members: ids.size > 1 ? nodes.filter(n => ids.has(n.id)) : [anchor] };
}
export function inspectApp(anchor: AppNode, nodes: readonly AppNode[]): InspectionGroup<AppNode> {
  const rendered = nodes.map(n => toRenderNode(n, 'app'));
  const target = rendered.find(n => n.id === anchor.nodeId);
  if (!target || !participatesInStack(target)) return { anchor, members: [anchor] };
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const siblings = new Map<string | null, typeof rendered>();
  const candidates = rendered.filter(n => participatesInStack(n) && sameStackBounds(n, target));
  for (const n of candidates) {
    const list = siblings.get(n.parentId) ?? [];
    list.push(n); siblings.set(n.parentId, list);
  }
  // Android and iOS use the same geometric inspection group. Sibling and direct
  // parent/child links connect exact-bound nodes regardless of paint, clipping or
  // child count. Group membership never proves that their properties can merge.
  const links = new Map<string, string[]>();
  const candidateIds = new Set(candidates.map(n => n.id));
  for (const child of candidates) {
    if (child.parentId === null || !candidateIds.has(child.parentId)) continue;
    links.set(child.parentId, [...(links.get(child.parentId) ?? []), child.id]);
    links.set(child.id, [...(links.get(child.id) ?? []), child.parentId]);
  }
  const ids = new Set<string>(), pending = [anchor.nodeId];
  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const peers = siblings.get(byId.get(id)!.parentId) ?? [];
    pending.push(...(links.get(id) ?? []), ...peers.map(n => n.id).filter(id => !ids.has(id)));
  }
  return { anchor, members: ids.size > 1 ? nodes.filter(n => ids.has(n.nodeId)) : [anchor] };
}
export function inspectionKey<T extends DesignNode | AppNode>(source: VerifySource, group: InspectionGroup<T>): string {
  return JSON.stringify([source, group.members.map(n => idOf(source, n)).sort()]);
}

function knownBoxShell(source: VerifySource, node: DesignNode | AppNode): boolean {
  if (source === 'app') {
    const n = node as AppNode;
    const emptyStyle = n.style === null || (n.style !== undefined && Object.keys(n.style).length === 0);
    return emptyStyle && n.hasVisualContent === false && !n.clipsToBounds && !n.isImage && !n.isSvg && !n.isGradient;
  }
  const n = node as DesignNode;
  const clipsKnownAbsent = !['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'].includes(n.type)
    || n.layout?.clipsContent === false;
  return Array.isArray(n.fills) && !n.fills.some(p => p.visible !== false)
    && Array.isArray(n.strokes) && !n.strokes.some(p => p.visible !== false)
    && n.type !== 'TEXT' && !n.text && Array.isArray(n.effects) && !n.effects.some(e => e.visible !== false) && clipsKnownAbsent
    && (n.cornerRadius === undefined || (Array.isArray(n.cornerRadius) ? n.cornerRadius.every(v => v === 0) : n.cornerRadius === 0));
}
function knownNonText(source: VerifySource, node: DesignNode | AppNode): boolean {
  if (source === 'design') return (node as DesignNode).type !== 'TEXT' && !(node as DesignNode).text;
  const n = node as AppNode;
  return n.textStyle === null && n.text === null && !n.contentDescription;
}
function knownAbsentProperty(source: VerifySource, node: DesignNode | AppNode, label: string): boolean {
  if (textLabels.has(label)) return knownNonText(source, node);
  // Figma GROUP 只组织子节点，不具有自身圆角；缺少该字段并非采集不完整。
  if (source === 'design' && label === '圆角' && (node as DesignNode).type === 'GROUP'
    && (node as DesignNode).cornerRadius === undefined) return true;
  if (knownBoxShell(source, node)) return true;
  if (source === 'app' && label === '填充') {
    const n = node as AppNode;
    // A collected radius/clipping wrapper can lack a fill without being an empty
    // box. Keep its radius in the radius candidates; it must not hide a gradient.
    return n.style !== undefined && n.hasVisualContent === false && n.alpha === 1
      && !n.isImage && !n.isSvg && !n.isGradient
      && n.style?.backgroundColor == null && n.style?.gradient == null;
  }
  return false;
}
const signature = (value?: CompareValue, scale = 1): string => JSON.stringify(value?.numbers
  ? ['numbers', value.numbers.map(n => roundManualNumber(n * scale))] : [value?.state, value?.key, value?.text]);

export function resolveProperties<T extends DesignNode | AppNode>(
  source: VerifySource, group: InspectionGroup<T>, align?: AppAlignContext, scope: InspectionScope = 'element',
): ResolvedProperty<T>[] {
  const members = scope === 'layer' ? [group.anchor] : group.members;
  const maps = members.map(node => new Map((source === 'design'
    ? buildManualFields(node as DesignNode, emptyApp, align)
    : buildManualFields(emptyDesign, node as AppNode, align)).map(field => [field.label, source === 'design' ? field.design : field.actual])));
  const labels = order.filter(label => maps.some(map => map.has(label)));
  const multi = members.length > 1;
  // 多层属性按面板显示精度比较；App 长度先对齐设计稿坐标，再保留两位小数。
  const displayScale = source === 'app' ? designAlignedScale(align) ?? 1 : 1;
  const propertySignature = (label: string, value?: CompareValue): string =>
    signature(value, isManualLength(label) ? displayScale : 1);
  return labels.map(label => {
    const candidates = members.map((node, index) => ({ node, value: maps[index].get(label) ?? unavailable(),
      id: idOf(source, node), name: nameOf(source, node),
      ignored: multi && !geometry(label) && knownAbsentProperty(source, node, label),
    }));
    const anchorIndex = members.findIndex(n => idOf(source, n) === idOf(source, group.anchor));
    const active = geometry(label) ? [candidates[anchorIndex]] : candidates.filter(c => !c.ignored);
    // Keep unknown candidates as blockers, but use a real provider for formatting.
    // A box anchor can lack all optional text rows present on a different member.
    const provider = active.find(c => c.value.state !== 'unavailable')
      ?? active.find(c => maps[members.indexOf(c.node)].has(label));
    const owner = provider?.node ?? group.anchor;
    let value = provider?.value ?? maps[anchorIndex].get(label) ?? unavailable();
    let reason = '';
    if (multi && !geometry(label) && active.length) {
      if (active.some(c => c.value.state === 'unavailable')) reason = '有相关图层未采集此属性，无法确认汇总值';
      else if (new Set(active.map(c => propertySignature(label, c.value))).size > 1) reason = '相关图层的属性值不同，不能按叠放顺序取值';
      // Text properties travel with their content; border color and width travel together.
      const bundle = textLabels.has(label) ? [...textLabels] : label === '描边色' || label === '描边宽度' ? ['描边色', '描边宽度'] : [];
      if (active.length > 1 && bundle.length && new Set(active.map(c => {
        const map = maps[members.indexOf(c.node)];
        return JSON.stringify(bundle.map(key => propertySignature(key, map.get(key))));
      })).size > 1) reason = textLabels.has(label) ? '文本内容与字体属性来自不同图层，需逐层确认' : '描边颜色与宽度需来自同一绘制层，不能跨层拼接';
      if (label === '填充') {
        // A transparent shell does not add another paint. One collected gradient can
        // supply the element's fill just like one solid fill, including alpha stops.
        // Several painted/unknown layers still require checking their composite.
        const singleFill = active.length === 1;
        const uncertain = active.some(c => {
          if (source === 'design') {
            const n = c.node as DesignNode;
            return (n.opacity !== undefined && n.opacity !== 1)
              || (n.blendMode !== undefined && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH')
              || n.fills?.some(p => p.visible !== false && ((p.type !== 'SOLID'
                && !(singleFill && p.type === 'GRADIENT_LINEAR' && (p.gradientStops?.length ?? 0) >= 2))
                || (p.opacity !== undefined && p.opacity !== 1)
                || (p.blendMode !== undefined && p.blendMode !== 'NORMAL')
                || !!(p.color && /^#[0-9a-f]{8}$/i.test(p.color) && p.color.slice(-2).toLowerCase() !== 'ff')));
          }
          const n = c.node as AppNode, color = n.style?.backgroundColor;
          const collectedGradient = n.style?.gradient?.type === 'linear' && (n.style.gradient.colors.length >= 2);
          return n.isImage || n.isSvg || (n.isGradient && !(singleFill && collectedGradient)) || (n.alpha !== undefined && n.alpha !== 1)
            || !!(color && /^#[0-9a-f]{8}$/i.test(color) && color.slice(1, 3).toLowerCase() !== 'ff');
        });
        if (uncertain) reason = '多层填充涉及透明度或自绘内容，需检查叠加外观';
      }
      if (reason) value = unavailable('多层待确认');
    }
    return { label, value, owner, sources: { state: reason ? 'ambiguous' : 'resolved', reason,
      candidates: (geometry(label) ? [candidates[anchorIndex]] : candidates).map(({ node: _node, ...candidate }) => candidate) } };
  });
}

export function buildInspectionFields(groups: InspectionGroups, align?: AppAlignContext,
  scopes: Partial<Record<VerifySource, InspectionScope>> = {}): ManualField[] {
  if (!groups.design || !groups.app) return [];
  const designs = resolveProperties('design', groups.design, align, scopes.design);
  const apps = resolveProperties('app', groups.app, align, scopes.app);
  return order.filter(label => designs.some(f => f.label === label) || apps.some(f => f.label === label)).map(label => {
    const d = designs.find(f => f.label === label), a = apps.find(f => f.label === label);
    // Compare each property on its real owner nodes; never construct a merged AppNode/DesignNode.
    const field = buildManualFields(d?.owner ?? groups.design!.anchor, a?.owner ?? groups.app!.anchor, align).find(f => f.label === label)!;
    const result = { ...field, sources: { design: d?.sources, app: a?.sources } };
    if (d?.sources.state === 'ambiguous') {
      result.design = d.value; result.target = unavailable('多层待确认');
    }
    if (a?.sources.state === 'ambiguous') { result.actual = a.value; delete result.physical; }
    if (d?.sources.state === 'ambiguous' || a?.sources.state === 'ambiguous') {
      result.status = 'insufficient'; result.reason = [d?.sources.reason, a?.sources.reason].filter(Boolean).join('；');
    }
    return result;
  });
}

export function inspectionEvidence(groups: InspectionGroups, scopes: Partial<Record<VerifySource, InspectionScope>> = {}): string {
  return '检查范围：' + JSON.stringify(Object.fromEntries((['design', 'app'] as const).flatMap(source => {
    const group = groups[source];
    return group ? [[source, { anchorId: idOf(source, group.anchor), scope: scopes[source] ?? 'element',
      memberIds: group.members.map(n => idOf(source, n)) }]] : [];
  })));
}
