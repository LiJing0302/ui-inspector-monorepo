/**
 * 报告渲染 —— 把 AcceptanceReport 变成人类可读的 Markdown
 */

import type { AcceptanceReport, Issue } from './types.ts';

const SEV_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

export function renderMarkdownReport(r: AcceptanceReport): string {
  const L: string[] = [];
  const verdictIcon = r.verdict === 'pass' ? '✅' : r.verdict === 'fail' ? '❌' : '⚠️';

  L.push(`# AI 验收报告（SAMA）`);
  L.push('');
  L.push(`> 需求：**${r.requirement.name ?? '(未命名)'}**（${r.requirement.id ?? 'n/a'}）`);
  L.push(`> 生成时间：${r.generatedAt}`);
  L.push('');
  L.push(`## ${verdictIcon} 结论：\`${r.verdict}\``);
  L.push('');
  L.push(r.verdictReason);
  L.push('');
  L.push(`| P0 | P1 | P2 | 来源 rule/ai/mixed | 权限 strong/weak |`);
  L.push(`|---|---|---|---|---|`);
  L.push(
    `| **${r.counts.p0}** | **${r.counts.p1}** | **${r.counts.p2}** | ` +
      `${r.counts.bySource.rule}/${r.counts.bySource.ai}/${r.counts.bySource.mixed} | ` +
      `${r.counts.byAuthority.strong}/${r.counts.byAuthority.weak} |`,
  );
  L.push('');

  L.push(`## 1. 输入与口径`);
  L.push('');
  L.push(`| 侧 | 逻辑画布 | 截图物理 | scale | 节点数 |`);
  L.push(`|---|---|---|---|---|`);
  L.push(`| design | ${r.input.design.width}×${r.input.design.height} | ${r.input.design.pixelWidth}×${r.input.design.pixelHeight} | ${r.input.design.scale} | ${r.input.design.nodes} |`);
  L.push(`| app | ${r.input.app.width}×${r.input.app.height} | ${r.input.app.pixelWidth}×${r.input.app.pixelHeight} | ${r.input.app.scale} | ${r.input.app.nodes} |`);
  L.push('');
  L.push(`物理比 k = **${r.input.pixelRatio}**；逻辑比 = **${r.input.logicalRatio}**。`);
  L.push('');

  L.push(`## 2. L0 整形`);
  L.push('');
  L.push(`| 侧 | 总数 | 保留 | 剔除 | 文本 | 有视觉 | 容器 | chrome 剔除 | 流式 | 固定 | 有像素证据 | clippedOut(required) |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const [name, s] of [
    ['design', r.shaping.design],
    ['app', r.shaping.app],
  ] as const) {
    L.push(
      `| ${name} | ${s.total} | ${s.kept} | ${s.dropped} | ${s.text} | ${s.visual} | ${s.container} | ${s.chrome} | ${s.flow} | ${s.fixed} | ${s.inPixels} | ${s.clippedOutRequired} |`,
    );
  }
  L.push('');

  L.push(`## 3. L1 对齐（锚点保序拟合）`);
  L.push('');
  L.push(`- 方法：\`${r.alignment.method}\``);
  L.push(`- 锚点：强 **${r.alignment.strongAnchors}**（流式层）+ **${r.alignment.fixedLayerAnchors}**（固定层），弱 ${r.alignment.weakAnchors}（仅验证）`);
  L.push(`- Δy 中位数 **${r.alignment.residualMedian}px**，|Δy| P90 = ${r.alignment.residualP90}px，|Δy|≤3px 的有 ${r.alignment.within3} 组`);
  L.push('');
  if (r.alignment.gaps.length) {
    L.push(`**低置信 / 断裂区间：**`);
    L.push('');
    L.push(`| 设计 y 区间 | 说明 |`);
    L.push(`|---|---|`);
    for (const g of r.alignment.gaps) L.push(`| [${g.designY0.toFixed(0)}, ${g.designY1.toFixed(0)}] | ${g.note} |`);
    L.push('');
  }

  L.push(`## 4. L2 分区评审`);
  L.push('');
  L.push(`| 区域 | 设计 y | 条目 | 规则初判 | 像素覆盖 | 无像素证据 | AI 复核 | 幻觉被拒 |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const reg of r.regions) {
    const v = Object.entries(reg.ruleVerdicts)
      .map(([k, n]) => `${k}:${n}`)
      .join(' ');
    L.push(
      `| ${reg.regionId} ${reg.label} | [${reg.designY[0]}, ${reg.designY[1]}] | ${reg.items} | ${v || '-'} | ${(reg.pixelCoverage * 100).toFixed(0)}% | ${reg.noPixelEvidence ? '**是**' : '否'} | ${reg.reviewerUsed ? '✓' : '-'} | ${reg.rejectedDefects} |`,
    );
  }
  L.push('');

  if (r.noPixelEvidence.length) {
    L.push(`## 5. ⚠️ 无像素证据区间（严禁判通过）`);
    L.push('');
    for (const n of r.noPixelEvidence) L.push(`- **设计 y∈[${n.designY0}, ${n.designY1}]**：${n.reason}`);
    L.push('');
  }

  L.push(`## 6. Issues（${r.issues.length}）`);
  L.push('');
  const sorted = [...r.issues].sort(
    (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9),
  );
  if (sorted.length === 0) L.push('（无）');
  for (const i of sorted) L.push(renderIssue(i));
  L.push('');

  if (r.pixel) {
    L.push(`## 7. M4 像素通道`);
    L.push('');
    if (!r.pixel.available) {
      L.push(`不可用：${r.pixel.reason}`);
    } else {
      L.push(`阈值：ΔE00 ≤ ${r.pixel.thresholds.deltaE}，圆角 ±${r.pixel.thresholds.cornerTolerancePx}px；检查 ${r.pixel.summary.checked} 项，失败 ${r.pixel.summary.failed} 项。`);
      L.push('');
      if (r.pixel.colorChecks.length) {
        L.push(`| id | 期望 | 实测 | ΔE00 | 结果 |`);
        L.push(`|---|---|---|---|---|`);
        for (const c of r.pixel.colorChecks) L.push(`| ${c.id} | ${c.expectedHex} | ${c.measuredHex} | ${c.deltaE} | ${c.pass ? '✓' : '✗'} |`);
        L.push('');
      }
      if (r.pixel.cornerChecks.length) {
        L.push(`| id | 期望半径(px) | 实测(px) | 结果 | 置信 |`);
        L.push(`|---|---|---|---|---|`);
        for (const c of r.pixel.cornerChecks) L.push(`| ${c.id} | ${c.expectedRadius} | ${c.measuredRadius} | ${c.pass ? '✓' : '✗'} | ${(c.confidence * 100).toFixed(0)}% |`);
        L.push('');
      }
    }
  }

  L.push(`## 8. 验收前提与口径说明`);
  L.push('');
  for (const n of r.notes) L.push(`- ${n}`);

  return L.join('\n');
}

function renderIssue(i: Issue): string {
  const flag = i.needsHumanReview ? ' 🧑‍⚖️待人工确认' : '';
  const lines: string[] = [];
  lines.push(`### \`${i.issueId}\` [${i.severity}] ${i.title}${flag}`);
  lines.push(`- category=\`${i.category}\` source=\`${i.source}\` authority=\`${i.authority}\``);
  lines.push(`- ${i.detail.replace(/\n/g, '\n  ')}`);
  const e = i.evidence;
  const bits: string[] = [];
  if (e.regionId) bits.push(`区域 ${e.regionId}`);
  if (e.markId) bits.push(`markId ${e.markId}`);
  if (e.designText) bits.push(`设计「${e.designText}」`);
  if (e.appText) bits.push(`App「${e.appText}」`);
  if (e.designBox) bits.push(`设计框 ${JSON.stringify(e.designBox)}`);
  if (e.appBox) bits.push(`App 投影框 ${JSON.stringify(e.appBox)}`);
  if (e.ruleVerdict) bits.push(`规则初判 \`${e.ruleVerdict}\``);
  if (e.aiReason) bits.push(`AI：${e.aiReason}`);
  if (bits.length) lines.push(`- 证据链：${bits.join('｜')}`);
  lines.push('');
  return lines.join('\n');
}
