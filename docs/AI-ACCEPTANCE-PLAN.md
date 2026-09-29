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

## 7. 与技术方案的偏差修复

> 以下 4 项是"当前实现 vs 通用技术方案"的实质性偏差。
> 它们**不依赖拆包**，可在 `apps/screen-mirror-mac` 内直接修，与阶段 1–6 并行推进；
> 修好后随阶段 2/3 一起迁入新包（行为一致性门禁以修复后的版本为基线）。
>
> 行号以当前 `main` 分支为准。
>
> 非目标：CI 接入（`probe:match` 进 GitHub Actions）按决策不做；
> 但"每一步可重复验收"的本地脚本（`check:acceptance`）保留，那是阶段门禁的载体。

### 7.1 匹配策略层：`structure-first` vs `geometry-first`（偏差 1）

**现状**（`acceptance/core.ts`）：
- `matchDocuments()`（:1520）写死顺序：L2 文本锚点（:1634）→ L3a 祖先投票（:1664）→ L3a′ 单根兜底（:1692）→ L3b 兄弟分配（:1714）→ L3c 校准定位（:1750，队列排空才跑一次）。
- 注释（:1752）明示"树结构证据强于几何推断"——与技术方案"几何/特征优先、层级辅助"方向相反。
- L3c 开启门槛硬编码（:862–:913）：L2 至少锁定 4 组文本锚点、纵向铺开 ≥ 64px。

**优化方案**（加策略层，不动各层算法）：
1. `AcceptanceProfile` 新增 `match: { strategy: 'structure-first' | 'geometry-first' }`，
   默认 `'structure-first'`（当前行为冻结，零漂移）。
2. 各匹配层抽成统一签名 `type MatchLayer = (ctx: MatchContext) => LayerResult`，
   `matchDocuments` 只负责按 `strategy` 排调度顺序。
3. `geometry-first` 调度：L2 →（满足 L3c 门槛）L3c 先行锁定几何高置信对 →
   L3a/L3b 只处理剩余未锁定节点。
4. 冲突仲裁：同一 design 节点被两层锁到不同 app 节点时，置为 `ambiguous`
   （`NodeMatch.alternatives` 保留双方候选），**不允许后层静默覆盖前层**。
5. L3c 门槛可配置化：`match.calibration: { minAnchors: 4, minSpreadPx: 64, … }`
   进 profile，替代现在的硬编码常量。

**验收**：
- [ ] `structure-first` 在 ground truth 上的 `NodeMatch[]` 与改前 diff 为空。
- [ ] `geometry-first` 的 missing 数下降，且新增 matched 经人工抽查错误率为 0。
- [ ] 构造冲突样本（结构与几何指向不同候选），结果为 `ambiguous` 而非静默取其一。

### 7.2 图形节点保留修复（偏差 2）

**现状**（`acceptance/core.ts`）：
- salience 分类（:433–:441）：叶子（`effectiveChildIds.length === 0`）且
  `selfDraws || graphicKind` → `graphic`，否则 → `layout`。
- `GRAPHIC_DESIGN_TYPES`（:176–:183）= VECTOR / ELLIPSE / LINE / BOOLEAN_OPERATION / STAR / POLYGON——**没有 RECTANGLE**，
  设计师最常用的圆角矩形/色块全靠 `selfDraws = design.hasFill !== false` 兜底。
- 致命路径：设计师把图片放在 Frame 里（常见画法）→ Frame 有 1 个有效子节点 →
  不是叶子 → `passThrough`（:425–:428，不画像素 + 单子节点 + 铺满）→ **`layout`**，
  整张图片直接退出 missing/extra 统计。App 侧同理：
  `selfDraws = app?.hasVisualContent === true`（:421，严格 true），SDK 不上报就判 false。
- `MATCH-GRAPHIC-GAP.md` 实测：约 90% graphic 节点在进入相似度矩阵前静默丢失。

**优化方案**：
1. 诊断先行：`matchDocuments` 已有 salience 分布统计（:2271–:2273 `countBy`），
   扩展为 `salience × 丢失原因` 矩阵——对每个 design 侧 graphic 节点追踪终点
   （matched / missing / filtered，filtered 的具体 reason），先定位再下刀。
2. `passThrough` 判定加豁免（:425–:428）：唯一子节点是 `graphic` 时，
   父容器判为 `box`（图片容器是结构锚点）而非 `layout`。
3. App 侧 `selfDraws` 降级：`hasVisualContent` 缺失时，用
   `isImage/isSvg/isGradient` 或"可见 + 非零尺寸"作弱证据，不直接判 false。
4. 设计侧核查 `serialize.ts` 里 `hasFill` 的计算是否漏了 paint 类型
   （SOLID 之外的渐变/图片填充是否被正确计入）。

**验收**：
- [ ] 构造"设计师常见画法"样本（Frame 包图片、圆角矩形按钮、图标 Frame），
  graphic 节点 100% 进入匹配（`participation: required`）。
- [ ] `MATCH-GRAPHIC-GAP.md` 样本复测：graphic 的 missing 显著下降，
  且 salience 分布中不再有大批图片被判为 `layout`。
- [ ] 诊断矩阵可回答"每个 graphic 节点去哪了"，作为回归看板长期保留。

### 7.3 动态内容豁免：实现 `dynamicPatterns`（缺失 1）

**现状**：
- `AcceptanceProfile.text.dynamicPatterns: string[]` 在 `DEFAULT_ACCEPTANCE_PROFILE`
  里是空数组（`core.ts`:48），**整个 `acceptance/` 下只有这一处引用**——
  文本差异判定（:2465–:2471）里没有任何动态内容逻辑，
  时间/价格/相对时间变化目前一律判 P1 `TEXT_MISMATCH`。

**优化方案**：
1. Profile 规范化处把 `text.dynamicPatterns: string[]` 编译为 `RegExp[]`，
   非法正则在配置校验时直接抛错（fail fast，不在运行时静默失效）。
2. 差分点（:2465–:2471）`!normalizedTextEqual` 分支内加：
   ```ts
   else if (!normalizedTextEqual(designText, appText)) {
     if (isDynamicOnlyChange(designText, appText, compiledPatterns)) {
       issues.push(issue('text', 'text', 'P2', match, designText, appText, null,
         match.confidence, ['DYNAMIC_CONTENT']));
     } else {
       issues.push(issue('text', 'text', 'P1', match, designText, appText, null,
         match.confidence, ['TEXT_MISMATCH']));
     }
   }
   ```
3. `isDynamicOnlyChange(a, b, patterns)`：a、b 命中**同一个** pattern，
   且 pattern 片段以外的部分完全相等 → true。
4. 内置预设（profile 默认带，用户可增删覆盖）：
   - `DATETIME`：`\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?\s*\d{1,2}:\d{2}(:\d{2})?`
   - `RELATIVE_TIME`：`\d+\s*(秒|分钟|小时|天|周|个月)前|刚刚|昨天|前天`
   - `PRICE`：`[¥￥$]\s?[\d,]+(\.\d{1,2})?`
   - `COUNT`：`[\d,]+(\.\d+)?\s*(万|千|k|w)?`

**验收**（故障注入）：
- [ ] "12:00"→"12:05" 只出 P2 `DYNAMIC_CONTENT`，不阻断 verdict。
- [ ] "确认"→"取消" 仍判 P1 `TEXT_MISMATCH`。
- [ ] "¥1,299"→"¥1,399"（同 pattern 但数值变）：判 P1——pattern 豁免的是**格式位**，
  不是数值本身；数值变化仍是实质差异。
- [ ] 非法正则配置在启动校验时报错，不进入验收流程。

### 7.4 VLM 终裁：从"顾问"升级为"验收官"（缺失 2）

**现状**：
- 最终 `verdict` 由 `service.ts`（:2205–:2207）规则拼出
  （criticalFailure→fail 等）；VLM 只参与 region 判定与节点仲裁。
- 已有基础设施：`AiDecisionRecord.stage` 含 `'visual-review'` 枚举值；
  `ai: { requested, applied }`，`requested && !applied` 时不允许 PASS
  （`core.ts`:2348, :2522–:2536，产出 P2 `ai-arbitration`）。

**优化方案**：在规则差分之后、verdict 落定之前，加最终 adjudication 阶段。
1. `ai/types.ts` 新增协议：
   ```ts
   protocol: 'ui-acceptance-adjudication-ai-v1';
   interface AiAdjudicationRequest {
     runId: string; model: string;
     provisionalVerdict: 'pass' | 'fail' | 'review';
     issues: Array<{ issueId: string; category: string; severity: 'P0'|'P1'|'P2';
                     check: string; expected: unknown; actual: unknown; reasonCodes: string[] }>;
     images: Array<{ issueId: string; dataUrl: string }>; // 差异标注裁切
   }
   interface AiAdjudicationResponse {
     overrides: Array<{ issueId: string; severity?: 'P0'|'P1'|'P2';
                        status?: 'open' | 'ignored'; reasonCodes: string[] }>;
     verdict?: 'pass' | 'review' | 'fail';
     observations: string[];
   }
   ```
2. 硬约束（**代码里 enforce，不靠 prompt 祈祷**）：
   - 只能**降级** severity（P0→P1→P2→ignored），不能升级；
   - `issueId` 不在请求列表中的 override 直接丢弃并记 error（防幻觉新增问题）；
   - 不能把 `fail` 改成 `pass`（fail 必须人看）；
   - P0 不能直降到 `ignored`。
3. 所有 override 写入 `AiDecisionRecord`（`stage: 'visual-review'`），
   `AcceptanceResult` 新增 `adjudication: { applied: boolean; overriddenIssueIds: string[] }`，
   verdict 标注来源（rule / ai / mixed）。

**验收**（mock reviewer）：
- [ ] 正常降级场景：P2 误报被忽略 → `review`→`pass`，`overriddenIssueIds` 可审计。
- [ ] 伪造 `issueId` 的 override 被拒绝并记 error。
- [ ] `fail`→`pass` 的 override 被拒绝，verdict 保持 `fail`。
- [ ] P0→`ignored` 的 override 被拒绝（最多降到 P1）。
- [ ] 未配置 reviewer 时保持现有降级语义（规则结果照常，`ai: { requested: false }`）。
