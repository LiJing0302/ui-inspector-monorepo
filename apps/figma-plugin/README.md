# 设计稿节点导出（Figma Plugin）

按导出单元批量导出 **节点 Schema + 截图**，用于在验收平台上把 Figma 节点框渲染到对应截图上，与 App 真实节点做位置、尺寸、文案、配色的自动对比。

**导出单元可以是任意节点**：既可以是整屏设计稿（Frame / Component / Section），也可以是精确到某个元素（一个 TEXT、一个 RECTANGLE、一个 INSTANCE）——在画布上点谁就导出谁。

## 它做什么

一次导出得到一个 zip：

```
xxx-nodes-2026-09-11-11-20.zip
├── manifest.json                 # 所有导出单元的索引（类型、路径、尺寸、截图/schema 路径）
├── README.md                     # 字段说明与对比建议（随产物一起给到验收平台）
├── index.html                    # 可视化预览：截图 + 节点框叠加，解压后双击打开
├── screenshots/
│   ├── 首页.png                  # 整屏设计稿截图（像素尺寸 = 设计稿尺寸 × 倍率）
│   └── Header-标题.png           # 精确到元素时的截图（文件名带父级前缀，避免同名撞车）
└── schema/
    ├── 首页.json                 # 该设计稿的完整节点树
    └── Header-标题.json          # 元素自身的 schema（rect 归零，absRect 保留页面坐标）
```

`manifest.frames[]` 每一项都带 `type` 与 `path`，元素级导出时用来消歧同名节点：

```json
{ "id": "1:23", "name": "标题", "type": "TEXT", "path": "Section A/首页/Header/标题",
  "pageId": "0:1", "pageName": "页面 1", "width": 200, "height": 28,
  "screenshot": "screenshots/Header-标题.png", "schemaFile": "schema/Header-标题.json", "nodeCount": 1 }
```

每个 Schema 节点包含：`id / name / type / path / rect / absRect / fills / strokes / effects / cornerRadius / text / layout / component / children`，足够做 UI 自动验收。

## 安装（开发模式）

1. `npm install`
2. `npm run build`（或 `npm run watch` 开发时热构建）
3. Figma 桌面端 → 顶部菜单 **Plugins → Development → Import plugin from manifest…**
4. 选择本项目的 `manifest.json`
5. 之后在 **Plugins → Development** 里即可运行

> 产物在 `dist/`：`code.js`（插件主线程）+ `ui.html`（界面）。manifest 指向这两个文件，不要手改它们的位置。

## 使用

1. 打开插件，自动扫描当前文件的所有页面与设计稿；
2. 选择要导出的对象，两种方式任选：
   - **画布点选**（推荐）：在画布点任意节点，插件列表顶部的「当前选区」会实时同步并自动勾选。默认粒度是**导出点中的元素本身**（一个 TEXT 就导出这个 TEXT）；想导出整屏时，把「点选粒度」切成「向上归到所属的 Frame / Component」。
   - **手动勾选**：在列表里按页面勾选设计稿，或用「使用当前选区」一次性同步；
3. 设置导出选项：
   - **截图倍率** 1x / 2x / 3x（推荐 2x，兼顾清晰度与体积）
   - **图片格式** PNG / JPG
   - **节点层级上限**：层级过深时裁剪，避免 Schema 过大
   - **包含隐藏节点**：默认关闭（线上也渲染不出来，没必要参与对比）
   - **包含图片填充的 imageHash**：需要回填图片资源时打开
   - **附带 index.html 可视化预览**：默认打开
4. 点「导出 ZIP」，浏览器/桌面端会下载 zip 文件。

## 坐标约定（对接验收平台时重点看这里）

- `rect`：**相对于本次导出单元根节点左上角**，单位是**设计稿 px**（没有乘倍率）。导出单元是某个元素时，它的 `rect` 恒为 `(0,0,w,h)`；
- `absRect`：Figma 页面绝对坐标，用于跨导出单元定位（元素级导出时仍保留原页面坐标）；
- 渲染到截图上时：**截图像素坐标 = rect × manifest.exportScale**。

渲染示例（浏览器 / Node 通用）：

```js
const { manifest, frames } = await loadExport();      // 读 manifest.json + schema/*.json
const scale = manifest.exportScale;                   // 例如 2

for (const node of walk(schema.tree)) {
  const { x, y, width, height } = node.rect;
  drawBox({
    left: x * scale,
    top: y * scale,
    width: width * scale,
    height: height * scale,
    label: `${node.name} · ${node.type}`,
  });
}
```

## 层级关系（Schema 是完整节点树，不是平铺列表）

每个 `schema/*.json` 的 `tree` 就是根节点自身，子节点递归挂在 `children` 上，层级信息有三处冗余表达：

| 表达方式 | 字段 | 说明 |
| --- | --- | --- |
| 嵌套结构 | `children[]` | 最直接的父子关系，递归即可遍历 |
| 层级深度 | `depth` | 根节点为 0，逐层 +1 |
| 路径字符串 | `path` | `首页/Header/标题`，**以导出单元根节点为起点**（不含外层 Section） |

```json
{
  "rootType": "FRAME", "rootPath": "Section A/首页",
  "tree": {
    "name": "首页", "type": "FRAME", "depth": 0, "path": "首页",
    "rect": { "x": 0, "y": 0, "width": 375, "height": 812 },
    "children": [
      { "name": "Header", "type": "FRAME", "depth": 1, "path": "首页/Header",
        "rect": { "x": 0, "y": 0, "width": 375, "height": 88 },
        "children": [
          { "name": "标题", "type": "TEXT", "depth": 2, "path": "首页/Header/标题",
            "rect": { "x": 16, "y": 20, "width": 200, "height": 28 } }
        ] }
    ]
  }
}
```

三个容易踩的点：

1. **`rect` 是相对导出单元根节点的，不是相对父节点的**。要算相对父节点的偏移，用子节点 rect 减父节点 rect：

   ```js
   const offsetX = child.rect.x - parent.rect.x;   // 而不是 child.rect.x
   ```

2. **`path` 的起点与 `manifest.frames[].path` 不同**：前者从导出单元自身开始（`首页/Header/标题`），后者是页面级全路径（`Section A/首页/Header/标题`）。两个都对，只是坐标系不同。
3. **层级可能被裁剪**：设了「节点层级上限」会截断子树；默认跳过隐藏节点会让被隐藏层级的子节点**上提到可见祖先**下（因为跳过的节点不进树）。做层级断言时要考虑这两点。

## 与 HTML DOM 渲染对齐（叠放 / 命中 / 裁剪）

Figma 与 DOM 的层级**可以对齐**，但要处理三件事，缺一件就会出现「HTML 里点得到、Figma 里点不到」：

| 维度 | Figma 的真实行为 | DOM 侧要怎么做 |
| --- | --- | --- |
| 叠放顺序 | `children` 是 **back-to-front**：索引 0 最底层，最后一项最上层（官方定义） | 按 `children` 数组顺序依次渲染，不要排序；`index` 字段就是这个序号（跳过隐藏节点时**不压缩**，保证 z 序不错位） |
| 点击命中 | 只对**有像素**的区域命中：无填充无描边的图层在画布上点不到 | 给 `hasFill === false` 的节点设 `pointer-events: none` |
| 裁剪 | 父容器开 `clipsContent` 后，溢出部分既看不见也点不中 | 父容器 `overflow: hidden`；`clipped === true` 的节点表示它在 Figma 里已被裁掉 |

产物里的 `index / hasFill / clipped` 三个字段就是为此准备的，随包的 `index.html` 已按这套规则渲染（工具栏「按填充命中（对齐 Figma）」默认开启；被裁剪的框显示为虚线并淡化，鼠标悬停会提示原因）。

**在 Figma 里点不到某个元素时**，不用跟画布死磕，三种绕法：

1. **在图层面板里选**（推荐）—— 面板选择不受遮挡影响，插件的「跟随画布选择」照样能同步到它；
2. **Cmd / Ctrl + 点击** —— Figma 会在重叠的图层之间穿透切换。

## 与 App 节点对比的建议

| 维度 | Figma 字段 | 建议容差 |
| --- | --- | --- |
| 位置 | `rect.x / rect.y` | ±1px |
| 尺寸 | `rect.width / rect.height` | ±1px |
| 文案 | `text.characters` | 精确匹配（去首尾空格） |
| 字号 | `text.fontSize` | ±0.5px |
| 颜色 | `fills[0].color` / `text.color`（`#RRGGBBAA`） | 每通道 ±2 |
| 圆角 | `cornerRadius` | ±1px |
| 组件 | `component.mainComponentName` | 精确匹配 |

匹配策略建议：`path + type` 做粗匹配 → `rect` 校验 → 逐字段比对。

## 目录结构

```
src/
├── shared/types.ts        # Schema 与插件通信协议的类型定义
├── plugin/
│   ├── code.ts            # 插件主线程：扫描、截图、序列化、打 zip
│   ├── serialize.ts       # Figma 节点 → Schema（颜色/文本/布局/组件信息）
│   └── preview.ts         # 生成产物里的 index.html 可视化预览
└── ui/
    ├── ui.html / ui.ts / ui.css   # 插件界面
scripts/smoke.mjs          # 用 mock Figma API 跑全流程的冒烟测试
build.mjs                  # esbuild 构建（UI 内联成单文件 ui.html）
```

## 开发

```bash
npm run build      # 构建
npm run watch      # 监听构建
npm run typecheck  # tsc --noEmit
node scripts/smoke.mjs   # 冒烟测试：跑通全流程并校验产物，输出样例到 .smoke-out/
```

冒烟测试会用 mock 的 Figma API 生成一份真实可用的样例产物（含 PNG 截图），
打开 `.smoke-out/index.html` 就能看到「截图 + 节点框叠加」的效果。
