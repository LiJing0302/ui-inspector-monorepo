# UI Inspector Monorepo 完整实施计划

## 1. 目标

在新建的 `/Users/lijing/Documents/ui-inspector-monorepo` 中维护四个协作项目：

1. macOS Electron 投屏与验收应用。
2. Figma 设计稿导出插件。
3. React Native Android 开发期 Inspector SDK。
4. VS Code 源码跳转与反向高亮扩展。

原有项目保留在原路径，迁移采用复制到新 workspace 的方式。原目录不作为 workspace 成员，不建立可写软链接，不运行会修改原目录的 install、build 或格式化命令。

## 2. 目标目录

```text
ui-inspector-monorepo/
├── apps/
│   ├── screen-mirror-mac/
│   ├── figma-plugin/
│   └── vscode-extension/
├── packages/
│   ├── inspector-protocol/
│   └── react-native-ui-acceptance/
├── docs/
├── package.json
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

`apps/*` 是可独立构建和发布的产品；`packages/*` 是可复用包。Mac App、Figma 插件、RN SDK 和 VS Code 扩展不合并为一个运行时。

## 3. 迁移策略

### 3.1 Git 与文件迁移

- 新 workspace 使用新的 Git 仓库，先提交当前骨架。
- 从 `screen-mirror-mac/electron` 迁移 Electron 应用代码，不复制 `node_modules`、`out`、`.smoke` 和本地二进制资源。
- 从 `figma-plugin` 迁移源码、manifest、构建脚本和插件资源，不迁移 `node_modules`、`dist`。
- 从 `react-native-ui-acceptance` 迁移 `src`、Android、iOS、Podspec、测试和文档，不迁移 `node_modules`。
- VS Code 扩展在新 workspace 中创建，不影响原项目。
- 迁移后只在新 workspace 执行 pnpm 命令；原项目仍可继续使用现有 npm 命令。

### 3.2 包管理

- 统一使用 pnpm workspace 和一个根级 `pnpm-lock.yaml`。
- 子项目保留独立 `package.json`、构建脚本和发布边界。
- `react-native-ui-acceptance` 保持独立 npm 包身份和 peer dependency：React、React Native。
- RN App 集成测试必须使用 `pnpm pack` 产生的 `.tgz` 验证真实发布形态，不能只依赖 workspace symlink。
- 采用独立版本号；Inspector 协议版本单独维护，协议变更必须同步升级版本。

## 4. 共享协议包

新增 `@ui-inspector/protocol`，只允许使用纯 TypeScript、无 Node/Electron/VS Code/RN 依赖。

包含：

- `SourceRef`、`InspectorNode`、`InspectorInstance`。
- RN ↔ Mac ↔ VS Code Inspector 消息类型。
- 协议版本、错误码和会话状态。
- source range 包含关系、路径规范化、项目根校验。
- HOC、条件分支、列表实例的 `SourceResolution` 类型。

Figma Bridge 仍可独立使用现有协议；完成迁移后，再把 Mac 与 Figma 插件中重复的 bridge 类型提取到独立包，避免一次迁移同时改变已有 Figma 协议行为。

## 5. React Native SDK

### 源码标记

- 开发构建启用 Babel Inspector 插件。
- 每个 JSX 元素生成原始 TSX source range、`sourceId`、display name 和 role。
- 生产构建移除 Inspector 元数据。
- Metro source map只用于校验 JS 到 TSX 的路径和行列，不作为运行时 View 身份。

### Fiber 与 native View

- SDK 遍历开发期 React Fiber。
- host Fiber 通过 RN UIManager/Fabric 适配器取得 native tag。
- Android NodeCollector 以 native tag 关联真实 View，提供当前 bounds、裁剪、可见性和层级。
- 运行时使用 `instanceId` 区分同一 JSX 位置产生的多个实例。
- native tag、Fiber 和 View 失效时立即清理缓存。

### HOC、条件渲染和列表

- HOC 不产生 View 时跳过，仅保留组件链；产生容器 View 时作为 host 节点。
- 自定义组件没有直接 native tag 时取宿主子树联合区域。
- 条件未挂载分支返回 `not-mounted`，不能使用旧实例。
- `FlatList/map` 同一 sourceId 的多个实例全部返回，带 `key/index`。

### Inspector 通道与高亮

- SDK 通过 WebSocket 连接 Mac。
- 首选 Android ADB reverse，局域网作为备用。
- 手机端使用开发期 overlay 绘制边框、填充、组件名和实例数量。
- Inspector overlay 不参与触控，验收截图时隐藏。

## 6. Mac App

新增 `InspectorBridge`，独立于 Figma `DesignBridge`：

- 仅监听 `127.0.0.1`。
- 支持通过 `UI_INSPECTOR_TOKEN` 对 Mac、RN 和 VS Code 握手鉴权；未配置时仅依赖 `127.0.0.1` 与 ADB reverse，正式发布前补充随机 token 的用户侧 provisioning。
- 维护 RN runtime 与 VS Code extension 两类连接。
- 转发 `pick`、`node-picked`、`highlight-source`、`highlight-result`。
- AndroidScrcpy 启停时建立和清理 ADB reverse。
- 投屏页增加源码检查模式。
- 普通模式继续发送 scrcpy touch；源码检查模式只发送 Inspector pick。
- 坐标转换复用现有视频尺寸计算，处理旋转、缩放和黑边。

## 7. VS Code 扩展

新增 `apps/vscode-extension`：

- `Connect`：连接 Mac InspectorBridge。
- `Enter Source Pick Mode`：进入一次性源码选取模式。
- `Clear Highlight`：清除手机高亮。
- 收到投屏点击后打开 workspace 内文件并选中源码范围。
- 源码选取模式监听下一次编辑器鼠标选区变化并发送文件相对路径、行列。
- 不实现严格 Alt/Option 点击，因为稳定扩展 API 不可靠暴露鼠标修饰键。
- 所有路径必须位于当前 workspace，校验 `projectRootHash`。

## 8. Figma 插件

- 保持 sandbox、manifest、esbuild 构建方式不变。
- 迁移后仍独立输出 `code.js` 和 `ui.html`。
- 先保持现有 Figma bridge 协议不变。
- 第二阶段再抽取 `@ui-inspector/protocol` 中的共享协议定义。
- Figma 插件不能依赖 Electron、Node 专属 API 或 RN SDK。

## 9. VS Code 与 RN 集成测试 fixture

在 workspace 内增加最小 RN fixture 或独立 fixture 仓库引用，覆盖（当前已加入
`packages/react-native-ui-acceptance/fixtures/rn-081`，真机宿主联调仍是待办）：

- `View`、`Text`、`Pressable`、图片。
- 自定义组件和无 UI HOC。
- 添加容器 View 的 HOC。
- 条件渲染和未挂载分支。
- `FlatList` 多实例、`key`、虚拟化。
- 滚动、导航、热更新和重新挂载。

测试必须能证明：

- source range 正确。
- Fiber 到 native tag 正确。
- native tag 到 View bounds 正确。
- 同一 sourceId 的多实例不会互相覆盖。
- 旧实例不会在条件切换后继续高亮。

## 10. CI 与发布

根级 CI 分成独立任务（配置文件见 `.github/workflows/ci.yml`）：

- protocol typecheck/test。
- Mac Electron typecheck/build/smoke。
- Figma typecheck/build。
- RN TypeScript、Android compile-check、测试和 npm pack。
- VS Code extension typecheck/package。

发布产物：

- Mac：electron-builder DMG。
- Figma：插件 dist 包。
- RN：npm tarball/package。
- VS Code：VSIX。

Inspector 协议变更必须先更新协议包，再更新 RN SDK、Mac App 和 VS Code 扩展；Figma bridge 版本独立管理。

## 11. 验收顺序

1. 骨架安装和共享协议包检查通过。
2. Mac、Figma、RN 三个项目在新 workspace 单独构建通过。
3. RN fixture 验证 Fiber/native tag 映射。
4. ADB reverse 与 InspectorBridge 联调。
5. 投屏点击跳转 VS Code。
6. VS Code 选取 JSX 后手机全部对应实例高亮。
7. 验证 HOC、条件渲染、列表、滚动、热更新和断线。
8. 验证原项目目录 Git 状态、文件内容和命令完全未被改变。

## 12. 明确不做

- 第一版不支持 iPhone 反向源码检查。
- 不使用 source map 猜测 Android View。
- 不把四个项目打包成一个运行时。
- 不在原项目目录创建 workspace lockfile 或安装产物。
- 不复制 node_modules、构建产物和本地二进制资源。
