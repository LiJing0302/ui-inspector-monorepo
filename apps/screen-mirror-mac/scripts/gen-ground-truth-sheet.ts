/**
 * 生成「对照关系标注草稿」—— 供人工填写 ground truth 的审阅表。
 *
 * 为什么需要它：匹配引擎的参数（阈值、证据权重、折叠判据、槽位容差）目前全是拍出来的，
 * 每次改动只能看"总数变没变"这个极弱信号 —— 总数可以完全不变，但错的全换了一批。
 * 有一份小规模真值，才能算出 precision / recall / F1，迭代才有方向。
 *
 * 设计原则（**不要改成全量逐节点对照**）：
 *   - 两侧"节点"不在同一层抽象上（设计 609 节点里 381 自绘；App 527 里只有 123 承载视觉结果），
 *     逐节点对照等于要求人在两种语言间逐词翻译。
 *   - 采集状态会变（本样本 App 未登录、设计登录），标出来的逐节点对照换个采集就废一半。
 *   - 视口外的内容没有"正确答案"，只有"截不到"。本样本设计 194/609 在 App 可见折叠线以下。
 *   - 边际收益递减：前 30 个锚点定住大部分参数，第 300 个只多 0.1%。
 *
 * 产出的四个层次，对应四类可计算的优化动作：
 *   T1 高置信锚点        → 阈值标定（正/负例分数分布取最大 F1 切点）+ 证据权重拟合
 *   T2a 重复文案         → 几何消歧准确率；决定是否必须引入同序约束
 *   T2b 同形兄弟         → 最坏情况错误率（位置互换型假匹配）
 *   T2c 槽位冲突         → 口径判据 + 同槽位几何容差
 *   T2d 行序可疑         → 顺序一致性约束的收益上限
 *   T3 区块级合成关系    → **唯一能验证「可绘制单元折叠」规则的数据**（覆盖率天花板的来源）
 *
 * 用法：node scripts/gen-ground-truth-sheet.ts <导出包.json> <输出.md>
 *      （经 esbuild 打包后运行，见 package.json 的 gt:sheet）
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { canonicalizeApp, canonicalizeDesign } from '../src/main/acceptance/core';
import { createPixelTransformContract, projectDesignRectToAppPixels } from '../src/main/acceptance/pixelTransform';
import type { AppNode, DesignNode } from '../src/types/verify';

interface Bundle {
  design: { asset: { width: number; height: number } };
  app: { snapshot: { width: number; height: number; pixelWidth?: number; pixelHeight?: number } };
  rawNodes: { design: DesignNode[]; app: AppNode[] };
}

const bundle = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Bundle;
const designRaw = bundle.rawNodes.design;
const appRaw = bundle.rawNodes.app;
const designDoc = canonicalizeDesign(designRaw, bundle.design.asset.width, bundle.design.asset.height);
const appDoc = canonicalizeApp(
  appRaw,
  bundle.app.snapshot.width,
  bundle.app.snapshot.height,
  bundle.app.snapshot.pixelWidth,
  bundle.app.snapshot.pixelHeight,
);
const transform = bundle.app.snapshot.pixelWidth
  ? createPixelTransformContract({
    basisWidth: designDoc.width,
    viewportWidth: bundle.app.snapshot.width,
    pixelWidth: bundle.app.snapshot.pixelWidth,
  })
  : null;
const appPixelRect = (node: AppNode) => node.pixelRect ?? {
  x: node.x * (transform?.pixelRatio ?? 1),
  y: node.y * (transform?.pixelRatio ?? 1),
  width: node.width * (transform?.pixelRatio ?? 1),
  height: node.height * (transform?.pixelRatio ?? 1),
};
const designPixelRect = (node: DesignNode) => transform
  ? projectDesignRectToAppPixels(node.rect, transform)
  : node.rect;
const scale = transform
  ? transform.viewportWidth * transform.pixelRatio / transform.basisWidth
  : designDoc.width / appDoc.width;
/** 自动确认锚点的纵向容差。**只用来分拣，不是判据** —— 超出的不丢弃，单独列出来给人看。 */
const ANCHOR_MAX_OFFSET_PX = 12;

const out: string[] = [];
const w = (s = ''): void => { out.push(s); };
const tail2 = (p: string | undefined): string => {
  if (!p) return '—';
  return p.split('/').map((s) => s.trim()).filter(Boolean).slice(-2).join('/');
};
const appLabel = (n: AppNode): string => {
  const cls = n.className.split('.').pop() ?? n.className;
  return `${cls}${n.text ? ` "${n.text.slice(0, 16)}"` : ''}`;
};
/** 「数据型」文案：值会随账号/商品数据漂移，当锚点或当 required 都会稳定产出假 missing。 */
const isData = (s: string): boolean =>
  /^[¥￥$]?\s*[\d,.]+$/.test(s) || /^\d+$/.test(s) || /\*\*\*\*/.test(s) ||
  /^[A-Z0-9-]{8,}$/i.test(s.replace(/[\s\u200b]/g, '')) || s.length > 14 || /^(标题|测试)/.test(s);

// ------------------------------------------------------------------ 索引
const designTexts = designRaw.filter((n) => n.type === 'TEXT' && (n.text?.characters ?? '').trim());
const appTexts = appRaw.filter((n) => n.visible && (n.text ?? '').trim() && n.width > 0);
const dByChars = new Map<string, DesignNode[]>();
for (const n of designTexts) {
  const c = n.text!.characters!.trim();
  dByChars.set(c, [...(dByChars.get(c) ?? []), n]);
}
const aByChars = new Map<string, AppNode[]>();
for (const n of appTexts) {
  const c = n.text!.trim();
  aByChars.set(c, [...(aByChars.get(c) ?? []), n]);
}
const byParent = new Map<string, DesignNode[]>();
for (const n of designRaw) if (n.parentId) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n]);

// ------------------------------------------------------------------ T1 高置信锚点
//
// 两条通道分开收：`anchors` 是敢自动确认的；`offsetRejected` 是「两侧文案都唯一、但纵向
// 差得远」的 —— 不丢，因为它们本身就是证据：本样本里被刷掉的恰好是底部 tab（设计底栏贴
// 1261 帧的底、App 底栏贴 792 视口的底，Δy=419）。把这类单独列出来，才能在真值确认后
// 反过来标定「按锚比较」的规则，而不是当成解析失败扔掉。
interface Anchor { chars: string; d: DesignNode; a: AppNode; dx: number; dy: number }
const anchors: Anchor[] = [];
const offsetRejected: Anchor[] = [];
for (const [chars, dl] of dByChars) {
  const al = aByChars.get(chars);
  // 非数据型 + 两侧都唯一。这是硬门槛，和偏移无关。
  if (!al || dl.length !== 1 || al.length !== 1 || isData(chars) || chars.length <= 2) continue;
  const d = dl[0]!;
  const a = al[0]!;
  const projected = designPixelRect(d);
  const actual = appPixelRect(a);
  const dx = projected.x - actual.x;
  const dy = projected.y - actual.y;
  (Math.abs(dy) > ANCHOR_MAX_OFFSET_PX ? offsetRejected : anchors).push({ chars, d, a, dx, dy });
}
anchors.sort((x, y) => x.d.rect.y - y.d.rect.y || x.d.rect.x - y.d.rect.x);
offsetRejected.sort((x, y) => Math.abs(y.dy) - Math.abs(x.dy));

// ------------------------------------------------------------------ T2a 重复文案
const dupDesign = [...dByChars.entries()]
  .filter(([c, l]) => l.length > 1 && !isData(c))
  .sort((a, b) => b[1].length - a[1].length);

// ------------------------------------------------------------------ T2b 同形兄弟
interface ShapeGroup { parent: string; type: string; size: string; members: DesignNode[] }
const shapeGroups: ShapeGroup[] = [];
for (const [parent, kids] of byParent) {
  const m = new Map<string, DesignNode[]>();
  for (const k of kids) {
    if (k.type === 'TEXT' || k.rect.width <= 0) continue;
    const key = `${k.type}|${Math.round(k.rect.width)}×${Math.round(k.rect.height)}`;
    m.set(key, [...(m.get(key) ?? []), k]);
  }
  for (const [key, members] of m) {
    if (members.length < 2) continue;
    const [type, size] = key.split('|') as [string, string];
    shapeGroups.push({ parent, type, size, members: members.slice().sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x) });
  }
}

// ------------------------------------------------------------------ T2c 槽位冲突
interface SlotCand { d: DesignNode; a: AppNode; dText: string; aText: string }
const SLOT_TOLERANCE_PX = 14; // 拍的值，等 T2c 的真值回来标定
const slotCands: SlotCand[] = [];
for (const d of designTexts) {
  const t = d.text!.characters!.trim();
  if (!isData(t) || aByChars.has(t)) continue;
  const projected = designPixelRect(d);
  const cx = projected.x + projected.width / 2;
  const cy = projected.y + projected.height / 2;
  let best: { n: AppNode; dist: number } | null = null;
  for (const a of appTexts) {
    if (!isData(a.text!.trim())) continue;
    const appRect = appPixelRect(a);
    const dist = Math.hypot(appRect.x + appRect.width / 2 - cx, appRect.y + appRect.height / 2 - cy);
    if (dist > SLOT_TOLERANCE_PX) continue;
    if (!best || dist < best.dist) best = { n: a, dist };
  }
  if (best) slotCands.push({ d, a: best.n, dText: t, aText: best.n.text!.trim() });
}
slotCands.sort((x, y) => x.d.rect.y - y.d.rect.y);

// ------------------------------------------------------------------ T2d 行序可疑
interface RowItem { chars: string; ax: number }
const orderSuspect: Array<{ parent: string; design: string[]; app: string[] }> = [];
for (const [parent, kids] of byParent) {
  const items: RowItem[] = [];
  for (const k of kids) {
    if (k.type !== 'TEXT') continue;
    const c = (k.text?.characters ?? '').trim();
    if (!c || isData(c) || c.length <= 2) continue;
    const al = aByChars.get(c);
    if (!al || al.length !== 1) continue;
    items.push({ chars: c, ax: al[0]!.x });
  }
  if (items.length < 3) continue;
  const designOrder = kids
    .filter((k) => k.type === 'TEXT' && items.some((i) => i.chars === (k.text?.characters ?? '').trim()))
    .sort((a, b) => a.rect.x - b.rect.x)
    .map((k) => k.text!.characters!.trim());
  const appOrder = [...items].sort((x, y) => x.ax - y.ax).map((i) => i.chars);
  if (designOrder.join('>') !== appOrder.join('>')) {
    orderSuspect.push({ parent, design: designOrder, app: appOrder });
  }
}

// ------------------------------------------------------------------ T3 区块
interface Block { design: DesignNode; app: AppNode; dKids: DesignNode[]; aKids: AppNode[] }
const blocks: Block[] = [];
for (const d of designRaw) {
  const kids = designRaw.filter((n) => n.parentId === d.id && n.rect.width > 0);
  if (kids.length < 4 || d.rect.width < 100 || d.rect.height < 40) continue;
  const projected = designPixelRect(d);
  const cx = projected.x + projected.width / 2;
  const cy = projected.y + projected.height / 2;
  let best: { n: AppNode; dist: number } | null = null;
  for (const a of appRaw) {
    if (!a.visible || a.width <= 0) continue;
    const appRect = appPixelRect(a);
    const dist = Math.hypot(appRect.x + appRect.width / 2 - cx, appRect.y + appRect.height / 2 - cy);
    if (dist > 40) continue;
    if (!best || dist < best.dist) best = { n: a, dist };
  }
  if (!best) continue;
  const chosen = best.n;
  blocks.push({
    design: d,
    app: chosen,
    dKids: kids,
    aKids: appRaw.filter((n) => n.parentId === chosen.nodeId && n.width > 0 && n.height > 0),
  });
}
blocks.sort((x, y) => y.dKids.length - x.dKids.length);

// ------------------------------------------------------------------ 输出
w('# 对照关系标注草稿');
w();
w(`> 设计 ${designRaw.length} 节点（${designDoc.width}×${designDoc.height}） · App ${appRaw.length} 节点（${appDoc.width}×${appDoc.height}） · 缩放 ${scale.toFixed(4)}`);
w();

w('## T1 · 已自动解出的高置信锚点（只需挑出不认同的）');
w();
w(`${anchors.length} 对。判据：文案非数据型 + 两侧都唯一 + 纵向偏移 ≤${ANCHOR_MAX_OFFSET_PX}px。`);
w();
w('| # | 文案 | 设计节点 | 位置 | App 位置 | 类 | Δx | Δy | 有问题？ |');
w('|---|---|---|---|---|---|---|---|---|');
anchors.forEach((a, i) => {
  w(`| ${i + 1} | ${a.chars} | \`${a.d.id}\` | (${a.d.rect.x.toFixed(0)},${a.d.rect.y.toFixed(0)}) | (${a.a.x.toFixed(0)},${a.a.y.toFixed(0)}) | ${a.a.className.split('.').pop() ?? ''} | ${a.dx.toFixed(1)} | ${a.dy.toFixed(1)} | |`);
});
w();

if (offsetRejected.length > 0) {
  w('### T1b · 文案两侧唯一、但纵向差得远（**没被丢掉，请确认它们确实是同一元件**）');
  w();
  w('这一组本身就是证据：如果不是解析错误，就说明**它们的纵向位置不能直接比** ——');
  w('本样本里是底部 tab（设计底栏贴 1261 帧的底、App 底栏贴 792 视口的底）。真值确认后，');
  w('才能反过来标定「按锚（Top/Bottom）比较」的规则，而不是把它当成失败案例扔掉。');
  w();
  w('| # | 文案 | 设计节点 | 位置 | App 位置 | Δx | Δy | 是否同一元件？ |');
  w('|---|---|---|---|---|---|---|---|');
  offsetRejected.forEach((a, i) => {
    w(`| ${i + 1} | ${a.chars} | \`${a.d.id}\` | (${a.d.rect.x.toFixed(0)},${a.d.rect.y.toFixed(0)}) | (${a.a.x.toFixed(0)},${a.a.y.toFixed(0)}) | ${a.dx.toFixed(1)} | ${a.dy.toFixed(1)} | |`);
  });
  w();
}

w('## T2a · 重复文案：请指定"哪个对哪个"');
w();
w(`${dupDesign.length} 组。两侧都不唯一，算法无法自行判定 —— 这是歧义的唯一来源。`);
w();
for (const [chars, dl] of dupDesign) {
  const al = aByChars.get(chars) ?? [];
  w(`### \`${chars}\` — 设计 ${dl.length} 个 → App ${al.length} 个`);
  w();
  w('| | 设计节点 | 位置 | 尺寸 | | App 节点 | 位置 | 类 |');
  w('|---|---|---|---|---|---|---|---|');
  for (let i = 0; i < Math.max(dl.length, al.length); i++) {
    const d = dl[i];
    const a = al[i];
    w(`| ${i + 1} | ${d ? `\`${d.id}\`` : ''} | ${d ? `(${d.rect.x.toFixed(0)},${d.rect.y.toFixed(0)})` : ''} | ${d ? `${d.rect.width.toFixed(0)}×${d.rect.height.toFixed(0)}` : ''} | ↔ | ${a ? `\`${a.nodeId}\`` : ''} | ${a ? `(${a.x.toFixed(0)},${a.y.toFixed(0)})` : ''} | ${a ? (a.className.split('.').pop() ?? '') : ''} |`);
  }
  w();
  w('**你的答案**（例：1→A、2→B、3→无对应）：');
  w();
}

w('## T2b · 同形兄弟（同父、同类型、同尺寸）—— 请确认行序是否一致');
w();
w(`${shapeGroups.length} 组，列出前 12 组。这是"位置互换"型假匹配的温床。`);
w();
for (const g of shapeGroups.slice(0, 12)) {
  w(`- 父 \`${g.parent}\` · ${g.type} ${g.size} × ${g.members.length}：${g.members.map((m, i) => `${i + 1}=\`${m.id}\`@(${m.rect.x.toFixed(0)},${m.rect.y.toFixed(0)})`).join(' · ')}`);
  w('  **你的答案**：');
  w();
}

w('## T2c · 槽位冲突（决定"假 missing"能消掉多少）');
w();
w(`${slotCands.length} 组：设计侧是数据型文案、App 侧同名不存在，但**对齐位置上有另一个数据型文案**。`);
w(`判定"是同一内容槽"的几何容差当前用 ${SLOT_TOLERANCE_PX}px（拍的值，用这批真值标定）。`);
w();
w('| # | 设计 | 位置 | | App 同槽位 | 位置 | 判定 |');
w('|---|---|---|---|---|---|---|');
slotCands.forEach((s, i) => {
  w(`| ${i + 1} | ${'`'}${s.dText}${'`'} | (${s.d.rect.x.toFixed(0)},${s.d.rect.y.toFixed(0)}) | ↔ | ${'`'}${s.aText}${'`'} | (${s.a.x.toFixed(0)},${s.a.y.toFixed(0)}) | |`);
});
w();

w('## T2d · 行序可疑（"位置互换"型假匹配的温床）');
w();
if (orderSuspect.length === 0) {
  w('（无：所有含 ≥3 个稳定文案的行，两侧左右次序一致）');
} else {
  for (const r of orderSuspect) {
    w(`- 父 \`${r.parent}\``);
    w(`  - 设计次序：${r.design.join(' → ')}`);
    w(`  - App 次序：${r.app.join(' → ')}`);
    w('  **你的答案**：');
    w();
  }
}
w();

w('## T3 · 区块级对照（校准"几个节点合成一个元件"）');
w();
w(`${blocks.length} 个候选区块，列出前 10。**这是唯一能验证「可绘制单元折叠」规则的数据** ——`);
w('覆盖率的天花板卡在这里（矢量图形设计 176 个 ↔ App 57 个）。');
w();
for (const b of blocks.slice(0, 10)) {
  w(`### 设计 \`${b.design.id}\` ${tail2(b.design.path)} — ${b.design.rect.width.toFixed(0)}×${b.design.rect.height.toFixed(0)} @(${b.design.rect.x.toFixed(0)},${b.design.rect.y.toFixed(0)})`);
  w(`App 候选 \`${b.app.nodeId}\` ${appLabel(b.app)} — ${b.app.width.toFixed(0)}×${b.app.height.toFixed(0)} @(${b.app.x.toFixed(0)},${b.app.y.toFixed(0)})`);
  w();
  w(`**设计子节点 ${b.dKids.length} 个**：`);
  for (const k of b.dKids) {
    w(`- \`${k.id}\` ${k.type} ${k.rect.width.toFixed(0)}×${k.rect.height.toFixed(0)} @(${k.rect.x.toFixed(0)},${k.rect.y.toFixed(0)})${k.text?.characters ? ` "${k.text.characters.slice(0, 18)}"` : ''}`);
  }
  w(`**App 子节点 ${b.aKids.length} 个**：`);
  for (const k of b.aKids.slice(0, 14)) {
    w(`- \`${k.nodeId}\` ${appLabel(k)} ${k.width.toFixed(0)}×${k.height.toFixed(0)} @(${k.x.toFixed(0)},${k.y.toFixed(0)})`);
  }
  w();
  w('**你的答案**（例：设计 3 个 Vector → App `SvgView` 1 个）：');
  w();
}

writeFileSync(process.argv[3]!, out.join('\n'), 'utf8');
console.log(`已写出 ${process.argv[3]}`);
console.log(`T1 ${anchors.length}（T1b 偏移超限 ${offsetRejected.length}） · T2a ${dupDesign.length} 组 · T2b ${shapeGroups.length} 组 · T2c ${slotCands.length} 组 · T2d ${orderSuspect.length} 组 · T3 ${blocks.length} 个`);
