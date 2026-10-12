/**
 * Node 侧入口（含 I/O）—— 供 Electron 主进程 / 服务端导入。
 *
 * ⚠️ 这里的一切都可能用到 `node:fs` / `node:child_process` / `pngjs`，
 * **绝不能**从 `src/index.ts`（纯核心）再导出一次：`pnpm core:isolated`
 * 会静态断言「纯核心不得 import node:* / electron / pngjs」，一旦回填就会红。
 *
 * 两个入口的分工：
 *   `@ui-inspector/ai-acceptance`       → 纯核心（L0–L3 + 像素数学），零平台依赖
 *   `@ui-inspector/ai-acceptance/node`  → 本文件，加文件读取 / PNG 解码 / HTTP reviewer
 */

export * from './loadBundle.ts';
export * from './fromWorkspace.ts';
export * from './pngSampler.ts';
export * from './openaiReviewer.ts';
