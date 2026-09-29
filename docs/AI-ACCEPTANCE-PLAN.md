# AI 自动化验收执行计划：`packages/acceptance-engine`

> 本计划是《UI 自动化验收技术方案》（通用版）在本仓库的落地版本。
> 通用方案的 7 个阶段在本项目**都有对应实现**，缺的不是能力，而是**形态**：
> 验收引擎（~9500 行）目前耦合在 Electron 主进程（`apps/screen-mirror-mac/src/main/acceptance/`），
> 无法独立测试、独立发布，也无法被 CI / 服务端 / CLI 调用。
>
> 本计划的目标：把引擎抽成独立 package `packages/acceptance-engine`
> （纯 TS、零 Electron/Node 依赖，对标 `packages/inspector-protocol` 的约束），
> Electron 侧只保留 IPC、编排与 AI 配置管理。

## 1. 通用方案 → 项目现状映射

| 通用方案阶段 | 项目现状 | 代码位置 | 状态 |
|---|---|---|---|
| 数据采集 | Figma 插件导出 `FrameSchema`（schema + 截图 zip）；RN SDK 采集原生节点树 | `apps/figma-plugin`、`packages/react-native-ui-acceptance` | ✅ 已有 |
| 坐标归一化 | design → app 像素投影（含滚动视口校准） | `acceptance/pixelTransform.ts` | ✅ 已有 |
| 节点匹配 | v2 引擎：L2 文本锚点 → L3a 祖先投票 → L3b 兄弟分配 → L3c 校准定位 | `acceptance/core.ts`（2612 行） | ✅ 已有 |
| 规则差分 | `AcceptanceIssue`（structure/layout/text/color/asset/visual/process × P0/P1/P2）+ `AcceptanceProfile` 阈值 | `core.ts`、`visuals.ts`（DeltaE/pHash/SSIM） | ✅ 已有 |
| 可视化标注 | 差异框编号标注图 | `acceptance/annotation.ts` | ✅ 已有 |
| VLM 评审 | OpenAI-compatible `/chat/completions` 调用（可配 endpoint/key，缺省优雅降级）+ AI 区域分割/节点匹配协议 | `acceptance/ai.ts`（1392 行） | ✅ 已有 |
| 报告与回归 | `AcceptanceResult`、ground truth 导出、probe 复现 | `service.ts`、`groundTruthExport.ts`、`scripts/probe-match-engine.ts` | ✅ 已有 |

**关键类型现状**（迁移时原样保留语义）：

- 设计稿侧：`SchemaNode`（`apps/figma-plugin/src/shared/types.ts`）——`id/name/type(FRAME/TEXT/RECTANGLE/INSTANCE…)/path/rect(设计稿px)/fills/text/layout`
- App 侧：`AppNode`（`apps/screen-mirror-mac/src/types/verify.ts`）——原生节点快照
- 规范层：`CanonicalNode`（`src/types/aiAcceptance.ts`）——`canonicalId`（`design:`/`app:` 前缀消歧）、`salience: text|graphic|box|layout`（L1 意义类别）、`participation`、`geometry/structure/content/visual` 四组特征
- 匹配结果：`NodeMatch`（含 `origin: text-anchor|ancestor-vote|sibling|calibrated-position|ai…`，排查时回答"这条凭什么"）
- 差异：`AcceptanceIssue`（`category × severity(P0/P1/P2)`，`expected/actual/delta`）
- 视觉度量：`MatchVisualMetrics`（CIEDE2000 `colorDeltaE`、`pHashDistance`、`ssim`，缺省 = 特征不可用 ≠ 差）

## 2. 包设计

### 2.1 基本信息

- 包名：`@ui-inspector/acceptance-engine`，独立版本号（从 `0.1.0` 起）
- 约束：**纯 TypeScript，零 Node/Electron/VS Code/RN 依赖**（与 `@ui-inspector/protocol` 同级约束）
- 输入输出全部 JSON 可序列化（方便 CI、服务端、CLI 调用）
- AI 调用只依赖 `AiReviewer` 接口，不绑死模型；OpenAI-compatible 实现作为默认 `reviewer`

### 2.2 目录结构

```text
packages/acceptance-engine/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts            # 公开 API 出口
    ├── types.ts            # CanonicalNode / NodeMatch / AcceptanceIssue /
    │                       #   AcceptanceResult / AcceptanceProfile / …
    │                       #  （自 screen-mirror-mac/src/types/aiAcceptance.ts
    │                       #    + types/verify.ts 的 AppNode/DesignNode/Rect 迁移，去 Electron 化）
    ├── adapters/
    │   ├── figma.ts        # FrameSchema/SchemaNode → CanonicalDocument
    │   └── app.ts          # AppNode 快照 → CanonicalDocument
    ├── match/              # 匹配引擎 v2（L2/L3a/L3b/L3c），自 core.ts 迁移
    │   ├── anchors.ts      # L2 文本锚点
    │   ├── container.ts    # L3a 祖先投票
    │   ├── sibling.ts      # L3b 兄弟分配
    │   └── calibrated.ts   # L3c 校准定位
    ├── diff/               # 规则差分：AcceptanceIssue 生成 + Profile 阈值
    ├── visuals.ts          # DeltaE / pHash / SSIM（自 visuals.ts 迁移）
    ├── pixel.ts            # design→app 像素投影（自 pixelTransform.ts 迁移）
    ├── annotate.ts         # 差异标注图（自 annotation.ts 迁移）
    └── ai/
        ├── types.ts        # AiReviewer 接口 + 评审协议类型
        └── reviewer.ts     # OpenAI-compatible 默认实现（自 ai.ts 迁移的调用层）
```

### 2.3 公开 API（v1 冻结）

```ts
// 规范化
canonicalize(design: FrameSchema, app: AppSnapshot): { design: CanonicalDocument; app: CanonicalDocument };
// 匹配
match(design: CanonicalDocument, app: CanonicalDocument, profile?: AcceptanceProfile): NodeMatch[];
// 规则差分
diff(matches: NodeMatch[], ctx: DiffContext, profile?: AcceptanceProfile): AcceptanceIssue[];
// 一站式
runAcceptance(input: AcceptanceInput, profile?: AcceptanceProfile, reviewer?: AiReviewer): Promise<AcceptanceResult>;
```

`AcceptanceResult` / `NodeMatch` / `AcceptanceIssue` 的字段语义冻结为 v1 契约，
后续字段变更必须升级包版本号（与 inspector-protocol 的版本纪律一致）。

## 3. 分阶段执行

> **阶段门禁铁律**：上一阶段验收不通过，不进入下一阶段。
> 匹配算法本身**不重写**（v2 引擎行为冻结），各阶段只做搬迁 + 行为一致性验证。

### 阶段 0：盘点与接口冻结

- 目标：明确"搬什么、留什么"。
- 工作：
  - 逐文件标注 `acceptance/` 下 12 个文件的纯度：`pure`（纯函数，可直接搬）/ `electron-bound`（依赖 IPC/store/截图 IO，留在 app 侧）。
  - 初判：`core.ts`（匹配/差分核）、`visuals.ts`、`pixelTransform.ts`、`annotation.ts`（标注）为 pure；
    `service.ts`（编排/IPC）、`store.ts`、`debugExport.ts`（写文件）为 electron-bound，需拆分。
  - 冻结 2.3 的公开 API 与 v1 类型契约。
- 验收：
  - [ ] 输出《模块纯度清单》并评审通过（每处 `electron-bound` 判定有理由）。
  - [ ] 公开 API 列表经评审冻结，写入本计划 2.3。

### 阶段 1：建包与类型迁移

- 目标：包骨架可 typecheck，类型单源。
- 工作：
  - 新建 `packages/acceptance-engine`（package.json / tsconfig / README，见本包目录）。
  - 迁移 `src/types/aiAcceptance.ts` 核心类型 + `types/verify.ts` 的 `AppNode/DesignNode/Rect/PixelRect`，剥离 Electron 引用。
  - 实现 `adapters/figma.ts`：`SchemaNode.type`（FRAME/TEXT/RECTANGLE/INSTANCE…）→ `CanonicalKind`（text/image/icon/control/container/unknown）
    + `salience`（text/graphic/box/layout）映射；`rect`（设计稿 px）直通。
  - 实现 `adapters/app.ts`：`AppNode` → `CanonicalDocument`。
- 验收：
  - [ ] `pnpm --filter @ui-inspector/acceptance-engine typecheck` 通过。
  - [ ] round-trip 测试：真实 `FrameSchema` JSON → `CanonicalDocument` → 关键字段（节点数、文本集合、根尺寸）与源一致。
  - [ ] `salience` 分类抽查：`MATCH-GRAPHIC-GAP.md` 样本中 graphic 类节点不再被误判为 layout（回归该文档 R1 结论）。

### 阶段 2：匹配引擎迁移（最硬的骨头）

- 目标：v2 引擎整体搬迁，行为零漂移。
- 工作：
  - 按 L2/L3a/L3b/L3c 拆分子模块迁入 `src/match/`（拆分只动文件边界，不动算法）。
  - 包内提供等价于 `probe:match` 的复现入口（CLI 或 API），输入为 figma 导出包。
- 验收（**行为一致性门禁**）：
  - [ ] 用 `docs/GROUND-TRUTH-SHEET.md` 的标注样本跑迁移前后 diff：`NodeMatch[]`（id 对、relation、status、origin）**完全一致**。
  - [ ] 用 `MATCH-GRAPHIC-GAP.md` 的样本复现：79 条锁定（matched 48 / ambiguous 31）的分布一致。
  - [ ] `SM_MATCH_TRACE=1` 日志关键行一致（抽查）。

### 阶段 3：规则差分迁移

- 目标：差分判定搬迁，分级零漂移。
- 工作：
  - 迁移 `AcceptanceIssue` 生成逻辑、`AcceptanceProfile` 默认阈值（positionTolerance 2 / sizeTolerance 2 / DeltaE 等，见 `DEFAULT_ACCEPTANCE_PROFILE`）。
  - 迁移 `visuals.ts`（DeltaE/pHash/SSIM）。
- 验收：
  - [ ] **故障注入测试**：构造含已知问题的样本页（文本错误、位置偏移 +8px、色差 DeltaE>5、缺失元素、新增元素），迁移前后 `AcceptanceIssue[]` 的 `category × severity` 完全一致。
  - [ ] `MatchVisualMetrics` 缺省语义保留：不可用特征计入 unknown，不判为缺陷。

### 阶段 4：标注与报告迁移

- 目标：可视化产物可复现。
- 工作：
  - 迁移 `annotation.ts`（差异框编号标注）、诊断导出（纯数据部分）。
- 验收：
  - [ ] 同一输入产出的标注图**像素一致**（哈希比对）。
  - [ ] `AcceptanceResult.summary`（matched/missing/extra/ambiguous/unknown 计数）与迁移前一致。

### 阶段 5：AI 评审抽象

- 目标：VLM 评审成为可插拔接口，Electron 只管配置。
- 工作：
  - 定义 `AiReviewer` 接口：`review(diffs: AcceptanceIssue[], images: AnnotatedImage[]): Promise<ReviewResult>`；
    `ai/types.ts` 收容现有 AI 协议类型（region segmentation / region-node match 等）。
  - `ai/reviewer.ts`：OpenAI-compatible 默认实现（自 `ai.ts` 迁移调用层，endpoint/key 经参数注入，不再读文件/env）。
  - app 侧保留：AI 配置的存储与校验（endpoint/key）、`useAi` 开关、`AiDecisionRecord` 落盘。
- 验收：
  - [ ] mock reviewer 跑通全链路：`runAcceptance(..., reviewer: mock)` 产出 `verdict` 且 `ai.applied=true`。
  - [ ] 未配置 reviewer 时优雅降级：规则结果照常输出，`ai: { requested: false }`，不抛错（对应 `ai.ts` 现有降级语义）。
  - [ ] prompt 模板版本化（`promptVersion` 进 `AiDecisionRecord`），可回放。

### 阶段 6：接回 Electron 与 CI

- 目标：app 切到新包，全链路回归。
- 工作：
  - `apps/screen-mirror-mac` 依赖 `@ui-inspector/acceptance-engine`；`service.ts` 变薄（只做 IPC/编排/截图 IO，引擎调用委托给包）。
  - 原 `acceptance/` 下已迁移模块标记为 deprecated（保留一个版本周期再删除，避免外部脚本引用断裂）。
  - 根 `package.json` 增加 `check:acceptance`（包 typecheck + 阶段 2/3 的一致性测试），并入 `check:all`。
  - `TODO.md` 增加本计划跟踪项。
- 验收：
  - [ ] `pnpm check:all` 全绿。
  - [ ] Mac app 手工跑一次完整验收（design→app）：报告 `verdict` 与迁移前一致。
  - [ ] `pnpm --filter @ui-inspector/acceptance-engine pack` 干跑通过（npm 包形态可用）。

## 4. 风险与应对

| 风险 | 应对 |
|---|---|
| 搬迁引入行为漂移 | 阶段 2/3/4 的一致性门禁（ground truth diff、故障注入、像素哈希）是硬门槛 |
| `service.ts` 与引擎耦合过深，拆不动 | 阶段 0 纯度清单先行；拆不动的部分允许包内保留 `node/` 子目录（纯 Node IO），但禁止依赖 Electron |
| AI 评审 mock 与真实模型行为差异 | prompt 版本化 + `AiDecisionRecord` 回放；真实模型只做抽样复核，不进门禁 |
| 类型循环依赖（types ↔ adapters） | 类型先行：阶段 1 先冻结 `types.ts`，后续只加不改 |

## 5. 与通用技术方案的关系

- 通用版《UI 自动化验收技术方案》（PDF）保留为**方法论参考**；本计划是**本仓库的执行版本**，两者阶段一一对应（见第 1 节映射表）。
- 通用版中的阈值建议值（如 4px）以本仓库 `DEFAULT_ACCEPTANCE_PROFILE`（2px）为准——以实测 ground truth 为准，不以文档为准。

## 6. 里程碑

- M1（阶段 0+1）：包骨架 + 类型单源，`typecheck` 通过
- M2（阶段 2+3）：引擎与差分迁移，一致性门禁全过
- M3（阶段 4+5）：标注与 AI 抽象，mock 全链路通过
- M4（阶段 6）：app 接回，`check:all` 全绿，TODO 关闭
