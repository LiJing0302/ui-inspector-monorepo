/**
 * 渲染层侧的 sm-asset:// URL 构造。
 *
 * 主进程也有一份（`main/protocol.ts` 的 assetUrl），但主进程那份不便被渲染层引用
 * （会牵入 electron 依赖）。两处都必须与协议约定保持一致：
 *   `sm-asset://asset/<requirementId>/<design|app>/<assetId>/<fileName>`
 * 改协议时必须同时改这两处。
 */

export function designAssetUrl(
  requirementId: string,
  assetId: string,
  fileName: string,
): string {
  return `sm-asset://asset/${encodeURIComponent(requirementId)}/design/${encodeURIComponent(assetId)}/${encodeURIComponent(fileName)}`;
}

export function appSnapshotUrl(
  requirementId: string,
  snapshotId: string,
  fileName: string,
): string {
  return `sm-asset://asset/${encodeURIComponent(requirementId)}/app/${encodeURIComponent(snapshotId)}/${encodeURIComponent(fileName)}`;
}
