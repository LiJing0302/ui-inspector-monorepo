/**
 * workspace 目录布局与路径安全。
 *
 * 根目录取 `app.getPath('userData')/workspace`：
 * 打包后可用，且 dev 与正式包天然隔离，不会互相污染。
 *
 * ⚠️ 所有路径推导都在这里，其它模块**不要自己拼路径** ——
 * 否则路径穿越防护（assertInside）会漏掉新的调用点。
 */

import { app } from 'electron';
import path from 'node:path';

/** workspace 根目录（需在 app ready 之后调用） */
export function workspaceRoot(): string {
  return path.join(app.getPath('userData'), 'workspace');
}

/** 全库索引（唯一权威目录） */
export function indexPath(): string {
  return path.join(workspaceRoot(), 'index.json');
}

export function requirementsRoot(): string {
  return path.join(workspaceRoot(), 'requirements');
}

export function requirementDir(requirementId: string): string {
  return path.join(requirementsRoot(), requirementId);
}

/** 设计稿资产目录：meta.json / schema.json / screenshot.png / thumb.png */
export function designAssetDir(requirementId: string, assetId: string): string {
  return path.join(requirementDir(requirementId), 'design', assetId);
}

/** App 快照目录：meta.json / nodes.json / screenshot.png / thumb.png */
export function appSnapshotDir(requirementId: string, snapshotId: string): string {
  return path.join(requirementDir(requirementId), 'app', snapshotId);
}

export function issueDir(requirementId: string, issueId: string): string {
  return path.join(requirementDir(requirementId), 'issues', issueId);
}

export function issueImagePath(requirementId: string, issueId: string, fileName = 'capture.png'): string {
  return path.join(issueDir(requirementId, issueId), fileName);
}

export function reportsDir(requirementId: string): string {
  return path.join(requirementDir(requirementId), 'reports');
}

export function acceptanceReportPath(requirementId: string, runId: string): string {
  return path.join(reportsDir(requirementId), `acceptance-${runId}.json`);
}

export function acceptanceArtifactsDir(requirementId: string, runId: string): string {
  return path.join(reportsDir(requirementId), `acceptance-${runId}-artifacts`);
}

export function acceptanceMappingPath(requirementId: string, pairId: string): string {
  return path.join(reportsDir(requirementId), `mapping-${pairId}.json`);
}

/**
 * 人工标注（ground truth）。
 *
 * 与 `mapping-` 并列放在需求目录下，因为它的主语就是**这一个配对**：
 * 配对没了（素材被删 / 需求被删）标注也就无意义，跟着走是正确语义。
 *
 * 但它与 mapping 有一条关键差别：mapping 是可重建的派生物（丢了重跑一次验收即可），
 * **标注是一次次手点出来的、不可重建**。所以它另有一个耐久出口 ——
 * 导出到 `groundTruthExportsDir()`（workspace 根），那份才是能留下来的东西。
 */
export function acceptanceGroundTruthPath(requirementId: string, pairId: string): string {
  return path.join(reportsDir(requirementId), `ground-truth-${pairId}.json`);
}

/**
 * AI 仲裁配置。
 * 刻意放在 **workspace 根目录**而不是某个需求目录下：它是全局凭据，
 * 不属于任何一次验收；放进需求目录会被随需求一起删除、也会被导出带走。
 */
export function acceptanceAiConfigPath(): string {
  return path.join(workspaceRoot(), 'acceptance-ai.json');
}

/**
 * 节点接收器的长期密钥。
 *
 * 同样放 workspace 根目录，理由与 AI 配置一样（不属于任何需求）。但它比 AI 配置更该稳定：
 * 这个 token 一旦轮换，**手机上配好的连接串就作废了**，而手机上并没有重新配对的入口 ——
 * 只能靠人再抄一遍。所以它只生成一次，之后只读。
 */
export function acceptanceReceiverPath(): string {
  return path.join(workspaceRoot(), 'acceptance-receiver.json');
}

/**
 * 验收调试导出目录。
 *
 * 与 AI 配置同理放在 **workspace 根**而不是需求目录下：它是排查产物、不属于任何
 * 一份验收内容。放进需求目录会随需求一起被删掉 —— 而「需求数据有问题、最需要
 * 这份快照」的时刻，往往就紧挨着一次误删。
 */
export function debugExportsDir(): string {
  return path.join(workspaceRoot(), 'debug-exports');
}

/**
 * 人工标注导出目录。
 *
 * 同样放 workspace 根，但理由与调试导出**不同**：调试导出是「丢了可以再点一次」，
 * 标注导出是**唯一一份不会被需求删除连带抹掉的人工结论**。放在根目录意味着
 * 删需求不会删它 —— 这是刻意的，人工劳动不该被一次清理动作带走。
 */
export function groundTruthExportsDir(): string {
  return path.join(workspaceRoot(), 'ground-truth-exports');
}

/**
 * 校验 `target` 落在 `root` 之内，返回规范化后的绝对路径。
 *
 * 用 `resolve` 后的**前缀 + 分隔符**比对，而不是简单的 startsWith：
 * 否则 `/root/abc-evil` 会被误判为在 `/root/abc` 之内。
 */
export function assertInside(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`路径越界：${target} 不在 ${resolvedRoot} 之内`);
  }
  return resolved;
}

/** 文件名是否安全（不含路径分隔符与上跳） */
export function isSafeSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false;
  if (segment.includes('/') || segment.includes('\\')) return false;
  if (segment.includes('\0')) return false;
  return true;
}
