/**
 * 自定义协议 `sm-asset://`：把 workspace 内的文件供给渲染层。
 *
 * 为什么要自定义协议，而不是「主进程读文件 + 返回 data URL」：
 *   - 图片走原生 `<img src>`，由 Chromium 缓存，避免每次重渲染都 base64 重传
 *   - 单张整屏截图 750×1734 PNG 约 0.5~1MB，base64 还要 ×1.33
 *
 * ⚠️ 时序（Electron 硬性要求，弄反会静默失效）：
 *   - `registerSchemesAsPrivileged` 必须在 **app.whenReady() 之前**（本模块顶层即执行）
 *   - `protocol.handle` 必须在 **app.whenReady() 之后**
 *
 * URL 形态：`sm-asset://asset/<requirementId>/<design|app>/<assetId>/<fileName>`
 */

import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { appSnapshotDir, assertInside, designAssetDir, isSafeSegment, workspaceRoot } from './store/paths';

export const SM_ASSET_SCHEME = 'sm-asset';

/** 供图允许的后缀（白名单，避免协议被用来读任意文件） */
const ALLOWED_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
};

// ⚠️ 必须在 app ready 之前执行
protocol.registerSchemesAsPrivileged([
  {
    scheme: SM_ASSET_SCHEME,
    privileges: {
      // 当标准 scheme，URL 解析（host/pathname）才正常
      standard: true,
      // 视为可信源：dev 下页面是 http://localhost，引用自定义协议时不触发降级拦截
      secure: true,
      // 双保险：即便 CSP 漏配也不拦（verify.html 的 CSP 仍已显式放行 sm-asset:）
      bypassCSP: true,
      corsEnabled: true,
      supportFetchAPI: true,
      stream: false,
    },
  },
]);

/** 构造渲染层可直接用的图片 URL */
export function assetUrl(
  requirementId: string,
  kind: 'design' | 'app',
  assetId: string,
  fileName: string,
): string {
  return `${SM_ASSET_SCHEME}://asset/${encodeURIComponent(requirementId)}/${kind}/${encodeURIComponent(assetId)}/${encodeURIComponent(fileName)}`;
}

function notFound(message: string): Response {
  return new Response(message, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export interface ResolvedAsset {
  absolutePath: string;
  contentType: string;
}

/**
 * 原始 URL 里是否出现了 `..` 路径段。
 *
 * ⚠️ 这个检查必须在 `new URL()` **之前**做，因为 WHATWG URL 解析器会把
 * `/../../etc/design/x/screenshot.png` 规范化成 `/etc/design/x/screenshot.png` ——
 * 规范化之后再也看不出上跳痕迹，反而是「悄悄变成另一个 requirementId」，
 * 段数校验和 isSafeSegment 都拦不住（`etc` / `x` 都是合法段）。
 * 实际不会越界（assertInside 仍是硬兜底），但语义上必须直接拒绝。
 *
 * 只匹配完整的 `..` 段，不会误伤 `a..b.png` 这类文件名。
 */
const TRAVERSAL_SEGMENT = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

/**
 * 把 `sm-asset://` URL 解析成 workspace 内的真实文件路径。
 *
 * 抽成纯函数（不碰 session / protocol），因为这是**唯一的安全边界** ——
 * 必须能被单独测试：绝对路径、`..` 上跳、百分号编码绕过都要挡在外面。
 *
 * 返回 null 表示非法请求，由调用方回 404（不回具体原因，避免探测）。
 */
export function resolveAssetRequest(url: string): ResolvedAsset | null {
  if (TRAVERSAL_SEGMENT.test(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'asset') return null;

  const segments = parsed.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  if (segments.length !== 4) return null;
  const [requirementId, kind, assetId, fileName] = segments as [string, string, string, string];

  if (kind !== 'design' && kind !== 'app') return null;
  // 逐段校验：拦 `..`、路径分隔符、空段
  if (![requirementId, assetId, fileName].every(isSafeSegment)) return null;

  const contentType = ALLOWED_EXT[path.extname(fileName).toLowerCase()];
  if (!contentType) return null;

  try {
    const dir =
      kind === 'design'
        ? designAssetDir(requirementId, assetId)
        : appSnapshotDir(requirementId, assetId);
    // 再兜一道：目录推导本身也可能被非常规 id 影响
    const absolutePath = assertInside(workspaceRoot(), path.join(dir, fileName));
    return { absolutePath, contentType };
  } catch {
    return null;
  }
}

/** 在 whenReady 之后调用 */
export function installSmAssetProtocol(): void {
  protocol.handle(SM_ASSET_SCHEME, async (request) => {
    const resolved = resolveAssetRequest(request.url);
    if (!resolved) return notFound('资源不存在');

    try {
      const bytes = await readFile(resolved.absolutePath);
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': resolved.contentType,
          // 覆盖导入时 assetId 会复用、文件内容会变 → 必须禁用缓存，否则显示旧图
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return notFound('资源不存在');
    }
  });
}
