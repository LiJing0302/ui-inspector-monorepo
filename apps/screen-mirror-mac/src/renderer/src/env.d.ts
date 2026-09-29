/**
 * 渲染层的环境变量类型（Vite / electron-vite 在构建时把 `import.meta.env.*` 静态替换成字面量）。
 *
 * 为什么自己声明、而不是 `/// <reference types="vite/client" />`：那份官方声明会把
 * `*.css` / `*.svg` / `*.png` 等**资源模块**一并注入全局，可能悄悄改变现有导入的类型语义
 * （本项目此前没有任何 `.d.ts`，也没引过它）。这里只用到 `DEV`，就只声明用到的那几个，
 * 改动面最小；将来真要用 `import.meta.glob` 之类，再换成引官方声明。
 *
 * ⚠️ 这个文件**不能出现顶层 import / export**：一旦成了模块，下面的接口就不再是全局声明，
 * `import.meta.env` 会重新变成类型错误。
 */
interface ImportMetaEnv {
  /** 开发态（`npm run dev` / `dev:verify`）。生产构建里被替换成 `false`。 */
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
