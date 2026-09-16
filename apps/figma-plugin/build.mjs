import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

fs.mkdirSync(dist, { recursive: true });

/** 1. 插件主线程：code.js（沙箱内运行，无 DOM） */
const codeOptions = {
  entryPoints: [path.join(root, 'src/plugin/code.ts')],
  bundle: true,
  outfile: path.join(dist, 'code.js'),
  target: 'es2019',
  format: 'iife',
  // jszip 在 browser 字段下走 dist/jszip.min.js（不依赖 node 内置模块）
  platform: 'browser',
  mainFields: ['browser', 'module', 'main'],
  define: { global: 'globalThis' },
  logLevel: 'error',
};

/** 2. UI：内联进单个 ui.html */
const uiOptions = {
  entryPoints: [path.join(root, 'src/ui/ui.ts')],
  bundle: true,
  write: false,
  outdir: dist,
  target: 'es2019',
  format: 'iife',
  logLevel: 'error',
};

function emitUiHtml(outputFiles) {
  const js = outputFiles.find((f) => f.path.endsWith('.js'));
  const css = outputFiles.find((f) => f.path.endsWith('.css'));
  if (!js) throw new Error('UI 构建失败：没有产出 js');

  const raw = fs.readFileSync(path.join(root, 'src/ui/ui.html'), 'utf8');
  // 某些 Figma to-code 类工具会往源码里注入 data-page-node-id，构建时统一剥掉
  const template = raw.replace(/\s*data-page-node-id="[^"]*"/g, '');
  const html = template
    .replace('/*__STYLE__*/', () => (css ? css.text : ''))
    .replace('/*__SCRIPT__*/', () => js.text);

  fs.writeFileSync(path.join(dist, 'ui.html'), html);
  console.log(`[build] dist/ui.html  ${(html.length / 1024).toFixed(1)} KB`);
}

async function run() {
  const t0 = Date.now();

  if (watch) {
    const codeCtx = await esbuild.context(codeOptions);
    await codeCtx.watch();
    console.log('[watch] code.js');

    const uiCtx = await esbuild.context(uiOptions);
    let pending = null;
    const rebuildUi = async () => {
      try {
        const r = await uiCtx.rebuild();
        emitUiHtml(r.outputFiles);
      } catch (err) {
        console.error('[watch] UI 构建失败:', err.message);
      }
    };
    await rebuildUi();
    fs.watch(path.join(root, 'src/ui'), { recursive: true }, () => {
      clearTimeout(pending);
      pending = setTimeout(rebuildUi, 80);
    });
    console.log('[watch] ui.html');
    console.log('[watch] 监听中…（Ctrl+C 退出）');
    return;
  }

  await esbuild.build(codeOptions);
  console.log(`[build] dist/code.js  ${(fs.statSync(path.join(dist, 'code.js')).size / 1024).toFixed(1)} KB`);

  const uiResult = await esbuild.build(uiOptions);
  emitUiHtml(uiResult.outputFiles);

  console.log(`[build] 完成，用时 ${Date.now() - t0}ms`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
