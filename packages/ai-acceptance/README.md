# @ui-inspector/ai-acceptance

**SAMA —— Structure-Anchored + Multi-region AI review**
离线 AI 验收引擎：纯 TS 核心 + Node CLI，**无 AI key 也能跑出完整报告**。

> 设计依据：`docs/AI-ACCEPTANCE-RESEARCH.md`（基于真实 debug bundle
> `测试验收-10年管家开通前-2026-09-30` 的实测：设计 609 节点 / App 495 节点 / 两张截图）。

---

## 为什么不是"把两张图丢给 VLM 问像不像"

实测结论（报告 §1.2）：

| 实测事实 | 后果 |
|---|---|
| Δy 从 **−2.7 单调漂移到 −42.7**（不是常量平移） | 任何全局平移对齐会制造成片假差异 → 必须**锚点保序拟合** |
| App 截图只覆盖设计高度的 **62.8%**（792 / 1261） | 下半屏"看不见就报通过"→ 必须输出 `noPixelEvidence` 并**禁止 pass** |
| App 侧盒样式覆盖率仅 **9%**（圆角 39 / 背景色 25） | 颜色/圆角**节点树判不了** → 必须走**截图像素测量** |
| 设计 TEXT 的 `name` ≠ 文本内容（31/105 不一致） | 只能读 `text.characters` |
| 设计「10年包修」+「&」+「10年免费上门检测」↔ App 单节点 | 必须先判"拼接等价"，否则误报缺失 |
| 两侧登录态/数据态不同（`186****8865` ↔ `登录/注册`） | 必须**显式声明**环境态，不能指望模型自己判断 |

---

## 分层

```
L0 整形        shapeBoth()          噪声剔除 / 零宽归一化 / 固定层-流式层分离 / 平台 chrome 屏蔽
L1 对齐        alignAnchors()       锚点保序拟合（PAVA 保序回归 + 分段线性插值），残差是结论不是前提
L2 分区        buildRegionSlices()  9 片切片 + Set-of-Mark 反向用（编号来自自造清单）+ 规则初判
L2' VLM        RegionReviewer       三段式 Prompt（环境态→动态位→缺陷）+ 编号强制回引门禁
L3 合成        adjudicate()         按 category 分权裁决
M4 像素        runPixelChecks()     CIEDE2000 比色 + 圆模型最小二乘拟合测圆角（含 #RRGGBBAA 口径修正）
```

**分权裁决表**（报告 §3.4，本方案的核心主张）

| category | 规则侧 | AI 权限 |
|---|---|---|
| 存在性 / 文本 / 几何 | 强（有结构化值） | **只能降级**（P1→P2→ignored） |
| 颜色 / 圆角 / 描边 / 风格 | 弱（节点树 9% 覆盖） | **可独立新增** |
| `verdict` | 唯一 | **只能加重**（fail 不可被改 pass） |

---

## 用法

### A. 日常：直读 Mac app workspace（推荐）

Mac app 的 workspace 里本来就躺着两侧素材与配对表，**不必先「导出调试包」再搬运**：

```
workspace/
  index.json                                  ← 需求 / 设计稿 / App 快照 / 配对表
  requirements/<reqId>/design/<assetId>/{schema.json, screenshot.png}
  requirements/<reqId>/app/<snapshotId>/{nodes.json, screenshot.png}
```

实测等价（2026-10-03，样本「测试验收 / 10年管家开通前」）：同一配对下直读与吃导出包
产出的报告**逐字段完全一致（0 差异）** —— `flatten(schema.json.tree)` 补上
`parentId`/`childCount` 后，与导出包里的 `design/nodes.json` 609/609 节点逐字段相同。

```bash
cd packages/ai-acceptance

# 1) 看有哪些需求 / 配对（打印 pairId）
node --experimental-strip-types src/cli.ts --list

# 2) 按需求名跑（该需求下只有一页时可以直接跑）
node --experimental-strip-types src/cli.ts --req 测试验收 \
  --profile bundle --out /tmp/r.json --md /tmp/r.md

# 该需求下有多页时，用 --design 指定设计稿名（不指定会列出候选让你选）
node --experimental-strip-types src/cli.ts --req 测试验收 --design "10年管家开通前" --profile bundle

# 3) 或直接按配对 id
node --experimental-strip-types src/cli.ts --pair a8f487d5-67e8-4ca4-bd60-952e0a01293c --profile bundle
```

workspace 位置默认取 macOS 固定路径，可用 `SCREEN_MIRROR_WORKSPACE` 或 `--ws-root <path>` 覆盖。

### B. 吃已导出的 debug bundle

```bash
node --experimental-strip-types src/cli.ts <bundle.zip|bundleDir> \
  --profile bundle --out report.json --md report.md
```

### 挂 AI / 像素通道

```bash
# 接真实 OpenAI 兼容 VLM（Qwen2.5-VL / GLM-4.6V / GPT-4o …）；无 key 自动回退 mock
… --ai --reviewer openai --ai-model gpt-4o --ai-key $OPENAI_API_KEY --profile bundle

# 只出结构结论，关掉像素通道（M4）
… --no-pixel

# mock 演练：新增弱类目 issue / 每片注入 1 条幻觉编号验证 100% 被拒
… --mock-weak --mock-hallucination
```

### 自检

```bash
pnpm --filter @ui-inspector/ai-acceptance typecheck       # 类型
pnpm --filter @ui-inspector/ai-acceptance core:isolated   # 纯核心零平台依赖断言
pnpm --filter @ui-inspector/ai-acceptance test:self       # M1–M4 门禁（无需 AI key）
pnpm --filter @ui-inspector/ai-acceptance probe:workspace # 真实 workspace 自洽性
pnpm check:ai-acceptance                                  # 前三条串联（已挂进根 check:all）
```

> Node ≥ 22.22 且带 `--experimental-strip-types` 即可直接跑 TS，**无需构建**。
> 该模式要求相对导入带 `.ts` 后缀（tsconfig 已开 `allowImportingTsExtensions`）。

---

## 契约

`src/index.ts` 导出的一切都是**零平台依赖的纯 TS**（对齐 `packages/inspector-protocol` 的约定），
可以在 Electron 渲染层 / 浏览器里复用。`node:*` / `electron` / `pngjs` 只允许出现在
`src/node/` 与 `src/cli.ts`（由 `pnpm core:isolated` 强制）。

```
src/
  types.ts        规范化数据模型 + 报告契约（624 行）
  text.ts         零宽/全角/空白归一化、数字掩码、动态位、拼接等价
  color.ts        sRGB→Lab、CIEDE2000、alpha 合成
  l0.ts           整形（噪声剔除 / 分层 / 路径签名 / 固定层反标）
  l1.ts           锚点三重去歧义 + PAVA 保序拟合
  l2.ts           分区切片 / 编号清单 / 规则初判 / 环境态豁免
  reviewer.ts     三段式 Prompt + mock + 输出门禁
  l3.ts           分权裁决 + verdict 重算
  pixel.ts        M4 像素通道（纯逻辑，只依赖 Sampler 接口）
  profile.ts      本 bundle 的 9 分区与前提声明
  harness.ts      L0→L3(+M4) 串联
  report.ts       Markdown 渲染
  node/           pngjs 解码、bundle 解包、OpenAI 兼容 VLM 客户端
  cli.ts          命令行入口
  __tests__/      M1–M4 门禁自检 + 纯核心隔离断言 + 三个手工探针
```

---

## 已固化的"实测踩坑"（改代码前先读）

这些都在源码注释里，且有对应断言：

1. **`designBox` 必须用设计逻辑坐标**。写成物理像素会和 `appBox` 差 2 倍 → 每个节点都被判"宽度差 50%"、`Δy=−430px`。
2. **`#RRGGBBAA` 而非 `#AARRGGBB`**（Figma 口径，alpha 在末尾）。按 ARGB 解析 `#e7d1ff66` 会得到墨绿，ΔE 直接炸到 28。
3. **`fill.opacity` 要折进色值 alpha**（`0.4 × 0x66` → 实际 16%）。
4. **固定层判据只看文本节点**。用"含 fixed 节点"判会把 R8 精选好物整区误判为固定区 → `pixelCoverage` 被强制成 1、`noPixelEvidence` 被吞掉。
5. **非固定区必须排除 App 固定层节点**，反之亦然。否则 tab bar 会以"App 多出 首页/分类/…"的形式串进 R6/R9。
6. **App 对齐带必须以投影为主、锚点只用来加宽**。只用"落在本区的锚点"会把带子压成一条线（R2 只剩「立即升级」一个锚点 → 会员卡下半屏的 App 文案全落在带外，误报"App 缺失"）。
7. **Pass C（拼接等价）必须跑在 Pass B（同排配对）之前**，否则「10年包修」先被配成 text-mismatch，App 单节点永远匹配不上。
8. **一个 region 内 `designY` 到 `appY` 的逆映射不可靠**（断点区间会落到错误分支，实测产出 `Δy=−429.9` 的假配对）。成对项要用「设计 y + 相对拟合曲线的局部残差」。
9. ⭐ **`EvidenceChain` 必须带 `designId` / `appId`，不能只有坐标**（2026-10-03 加）。消费侧（Mac app 画布）的节点索引按 id 查，而 `appBox` 是 `toDesignBox` **投影到设计坐标系**的值 —— 拿它画 App 帧会错位，拿坐标反查节点又会张冠李戴（真实快照实测有 19 组几何逐位相同的重合兄弟）。实测命中率 designId 14/14、appId 8/8。
   **结构性 issue（累积漂移 / 对齐断裂 / 无像素证据）与像素通道 issue 必须是 `null`** —— 它们是**区间**结论而非节点结论，给了 id 会让人误以为问题出在某个元素上。消费侧按 `null` 决定要不要显示「在画布上定位」入口。
10. **圆角：不能用"最大内缩"估半径**。抗锯齿会让最深内缩那一行被阈值跳过，系统性低估 15–25%（34.6px 测成 26px）。要用整条弧做**最小二乘圆模型拟合**；背景参考点必须取在**搜索窗之外**，否则框偏移时"背景"就是填充色本身，内缩恒为 0。
11. **低对比度（白卡 `#fff` 叠浅灰页 `#f5f5f5`，逐通道只差 10）**要用自适应阈值，固定阈值 18 会直接测不出形状。
12. **像素 issue 必须落 `merged` 而非 `issues`**（`merged` 在合成段已构建完毕，往 `issues` 追加不会进 counts / issues / verdict）。
13. **低置信圆角测量（< 0.6）不进 issue 列表**，只留在 `report.pixel.cornerChecks` 供人工复核。
14. ⭐⭐ **VLM 通道的四个必守点**（2026-10-04 第一次真模型实跑就全踩了）：

    | # | 坑 | 症状 | 修法 |
    |---|---|---|---|
    | 1 | 逐片调用**裸 `await`** | 9 分区串行，第 1 片超时 → 整次抛「引擎异常」，后面 8 片**根本没试**，已出的结论也一并丢 | `try/catch` 包住，失败记 `reviewFailures` 继续跑完 |
    | 2 | `clearTimeout` 写在 `await fetch` **之后** | HTTP 错误 / JSON 解析失败 / 超时三条路径全跳过它；Node 定时器**持有 AbortController 引用** ⇒ 每次失败泄漏一个悬挂定时器 | 移进 `finally` |
    | 3 | `timeoutMs` 从 App 设置透传但**无下限** | 填 0 / 几百毫秒 → 每次带图请求必然超时 | 构造器 `Math.max(30_000, …)` |
    | 4 | 错误信息直接 `String(e)` | 「AbortError: This operation was aborted」把「我们主动 abort」「对方断连」「Node 行为」混成一句，读的人无从下手 | `describeError()` 翻译成可行动文案 |

    ⚠️ **降级不许虚报**：失败片的 `validations` 留空 ⇒ issue 的 `source` 停在 `rule`，
    **绝不出现「AI 复核过」字样**。而 `source=rule` 时光看结论表**看不出缺席** ——
    所以 `notes` 是唯一告知出口（「⚠️ AI 评审有 N 片失败…未经 AI 复核」）。
    ⚠️ **降采样只喂 VLM 送审图**（`downscaleForReview`），**绝不能改 `cropImage`** ——
    M4 要逐像素真色，降采样会把 ΔE00 判据改掉。最近邻而非双线性：判布局错位不该引入插值造出的中间色。
    实测依据：R8 分区原尺寸 base64 约 **2.2MB**（超时主因），降到长边 720 后 ~0.6MB。

---

## 已知边界（不夸大能力）

- **R8 精选好物（截图外）**：只做结构比对；要真正验收视觉需补**滚动分段截图 + 拼接对齐**。
- **圆角像素测量**：对"叠层复杂 / 低对比度"的卡片仍会失败，当前以**置信度**表达不确定性，
  低于 0.6 直接不进结论。要提升需换"边缘梯度 + 亚像素拟合"或让宿主直接上报 `borderRadius`。
- **颜色测量**：半透明填充（alpha < 0.9）与"被上层渐变遮住的垫底矩形"已自动跳过，因为
  合成底色不可知 —— 这类节点只能靠 VLM 语义判断。
- **mock reviewer 不是模型**：它只按规则初判回声，用来跑通链路与验证门禁；真实召回率取决于所选 VLM。
  报告 §2 的外部证据（XBIDetective 79% acc / 59% recall、GPT-4o GUI-360 grounding 9.4%）说明
  **不要让模型做 grounding** —— 本方案让编号来自自造清单，只让模型做语义判断。
