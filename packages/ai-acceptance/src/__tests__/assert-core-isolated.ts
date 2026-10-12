/**
 * 纯核心隔离断言
 *
 *   node --experimental-strip-types src/__tests__/assert-core-isolated.ts
 *
 * 约定（对齐 packages/inspector-protocol）：`src/index.ts` 导出的一切都必须是
 * **零平台依赖的纯 TS**，这样 Web / Electron 渲染层 / 浏览器里的复用才成立。
 * node:* / electron / pngjs 只允许出现在 `src/node/` 与 `src/cli.ts`。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;

/** 允许触碰平台能力的文件（相对 src/） */
const ALLOWED = ['cli.ts', `node${sep}index.ts`, `node${sep}loadBundle.ts`, `node${sep}fromWorkspace.ts`, `node${sep}pngSampler.ts`, `node${sep}openaiReviewer.ts`, `__tests__${sep}run.ts`, `__tests__${sep}assert-core-isolated.ts`, `__tests__${sep}probe_l0_l1.ts`, `__tests__${sep}probe_regions.ts`, `__tests__${sep}probe_pixels.ts`];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const PLATFORM = [
  { re: /from\s+['"]node:/, label: 'node:* import' },
  { re: /from\s+['"]electron['"]/, label: 'electron import' },
  { re: /from\s+['"]pngjs['"]/, label: 'pngjs import' },
  { re: /require\(\s*['"]node:/, label: 'node:* require' },
  { re: /from\s+['"](fs|path|os|child_process|http|https)['"]/, label: '裸 node 模块 import' },
];

const files = walk(ROOT);
const violations: string[] = [];
const scanned: string[] = [];

for (const f of files) {
  const rel = relative(ROOT, f);
  if (ALLOWED.includes(rel)) continue;
  scanned.push(rel);
  const src = readFileSync(f, 'utf8');
  for (const p of PLATFORM) {
    if (p.re.test(src)) violations.push(`${rel}: ${p.label}`);
  }
}

console.log(`扫描纯核心文件 ${scanned.length} 个（白名单外）：`);
for (const f of scanned.sort()) console.log(`  · src/${f}`);

if (violations.length) {
  console.error('\n✗ 纯核心出现了平台依赖（应移到 src/node/ 或 src/cli.ts）：');
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}

console.log('\n✓ 纯核心零平台依赖（node / electron / pngjs 均未越界）');
