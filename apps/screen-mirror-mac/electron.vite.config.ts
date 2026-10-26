import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// ESM 下没有 __dirname，用 import.meta.url 推导
const here = dirname(fileURLToPath(import.meta.url));
const r = (...p: string[]): string => resolve(here, ...p);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@ui-inspector/protocol'] })],
    resolve: {
      alias: { '@shared': r('src/types') },
    },
    build: {
      outDir: r('out/main'),
      rollupOptions: {
        input: { index: r('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@ui-inspector/protocol'] })],
    resolve: {
      alias: { '@shared': r('src/types') },
    },
    build: {
      outDir: r('out/preload'),
      rollupOptions: {
        input: { index: r('src/preload/index.ts') },
        // 固定产物名：package.json 为 type=module，electron-vite 默认输出 .mjs。
        // 显式钉住，避免升级 electron-vite 后扩展名变化导致主进程找不到 preload。
        output: { entryFileNames: 'index.mjs' },
      },
    },
  },
  renderer: {
    root: r('src/renderer'),
    resolve: {
      alias: {
        '@': r('src/renderer/src'),
        '@shared': r('src/types'),
      },
    },
    plugins: [react()],
    build: {
      outDir: r('out/renderer'),
      rollupOptions: {
        input: {
          index: r('src/renderer/index.html'),
          verify: r('src/renderer/verify.html'),
        },
      },
    },
  },
});
