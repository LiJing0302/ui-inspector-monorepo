# 验证清单 — v2 匹配引擎 + SDK 采集修复

> 覆盖本轮改动：`core.ts` 匹配引擎（锚点优先五层，新增 **L3c 锚点校准定位** +
> 尺寸失配项 + 同盒孪生规则）、`NodeCollector.java` / `CollectPolicy.java`
> 采集判定、`debugExport.ts` 诊断口径、**人工标注（ground truth）点选配对 + 导出**
> （`types/groundTruth.ts`、`acceptance/groundTruthExport.ts`、`acceptance/agreement.ts`、
> `lib/calibration.ts`、`CanvasBoard` 标注模式、`CalibrationPanel`）、
> **真值闭环重放**（`scripts/replay-ground-truth.ts`）。
>
> **核心原则：前三层回答「改动有没有破坏什么」，第四层才回答「改动有没有起作用」。**
> 前三层是白盒（可离线、可复现），第四层是黑盒（要真机 + 新采集）。

---

## 0. 最小验证集

改动很小、只想确认没砸东西，跑这三条就够：

```bash
# ① 五端类型 + inspector bridge
pnpm check:all

# ② Java 编译 + 采集策略测试  ⚠️ check:all 覆盖不到 Java，必须单独跑
cd packages/react-native-ui-acceptance && npm run check

# ③ 匹配引擎（零缺陷镜像夹具 + L3c 夹具与其两个负控）
cd apps/screen-mirror-mac && env -u ELECTRON_RUN_AS_NODE npm run test:verify-smoke

# ④ 改过引擎的判据/阈值/坐标 -> 必须再跑真值闭环，否则改了规则也不知道是变好还是变坏
cd apps/screen-mirror-mac && npm run replay:gt -- "<debug-exports/*.json>" "<ground-truth-exports/*.json>"
```

**判定线：全绿；③ 额外要求 `missing = 0 / extra = 0`；④ 的 `contradicts` 不得上升。**

---

## 1. 分层矩阵

| 层 | 验证什么 | 命令 | 判定线 | 需要真机 |
|---|---|---|---|---|
| **L1** 编译 | 五端 TS + Java 语法 | `pnpm check:all` + RN `npm run check` | 全绿 | 否 |
| **L2** 引擎逻辑 | 引擎在两棵同构树上守恒 + L3c 的两条负控 | `test:verify-smoke` | **592 通过 / 1 失败** | 否 |
| **L3** 真实数据·旧包 | 引擎在真实节点的归宿率 | `probe:match` | 静默丢失不再上升 | 否 |
| **L3b** 真值闭环 | 引擎结论 vs 人工标注的配对级 P/R | `replay:gt` | found ≥ 74% 且 `contradicts` 不上升 | 否 |
| **L4** SDK 修复效果 | 图片误判是否真被修掉 | 重打 tgz → MallApp 重编 → 采集 | app `graphic` 明显 > 115 | **是** |
| **L5** 端到端 UI | 面板可用、不再「匹配 0」 | Mac 界面操作 | 有候选榜、能确认/忽略 | **是** |
| **L6** 人工标注 | 点选配对能落盘、导出 JSON 自足 | Mac 界面操作 + 看导出文件 | 三条硬约束（`0b` 自动断言）+ 导出含 `agreementHuman` + 两套视口分母 | **是** |

---

## 2. 逐层操作

### L1 · 编译

```bash
cd /Users/lijing/Documents/ui-inspector-monorepo
pnpm check:all                      # protocol → mac → figma → rn → vscode → inspector smoke
cd packages/react-native-ui-acceptance && npm run check   # compile-check(javac) + CollectPolicyTest
```

**为什么必须单独跑 `npm run check`**：`pnpm check:all` 里的 `check:rn` 只是
`tsc --noEmit --skipLibCheck`——RN 包的 TS 壳。**Java 一行都不在覆盖范围内**。
`compile-check.sh` 是脱离 gradle 的 javac，`test` 跑 `CollectPolicyTest`（80 条断言，
本轮新增 15 条：透传判定 / layoutOnly 等式 / 参与度优先序 / Drawee 判定）。

**实测耗时**：`pnpm check:all` 约 **7 秒**，`compile-check.sh` 约 3 秒 —— 都不属于「耗时命令」，
不用犹豫，随手就跑。

未跑成的原因通常是 classpath 拼不出来（缺 `android.jar` 或 gradle 缓存里的 `react-android` aar）——
脚本的报错信息会直说要什么。

### L2 · 引擎逻辑（最重要的白盒）

```bash
cd apps/screen-mirror-mac
env -u ELECTRON_RUN_AS_NODE npm run test:verify-smoke
```

🔴 **`env -u ELECTRON_RUN_AS_NODE` 不能省**。本机该变量已置位，不清掉 Electron 会退化成纯 node
模式，`app` 模块直接不可用，跑出来是一堆无关报错。

🔴 **冒烟走 esbuild 打包，不做类型检查 —— 它全绿不代表类型干净。** 这两件事必须分开跑：
冒烟验的是**行为**，`tsc` 验的是**类型**。踩过一次：`ResolveTable` 只改了实现没同步接口，
冒烟照绿（531/1 一点没变），`check:all` 一跑冒 5 个错。**改完 `core.ts` 两样都要跑。**

夹具是**零缺陷对照物**：两侧同构镜像树（310 节点），本该零 missing / 零 extra。
所以最该盯的不是总数，是这两行：

```
matched + ambiguous === 节点总数     ← 守恒（每个节点恰好归属一条 match）
missing = 0 / extra = 0              ← 无漏配
```

**预期：592 通过 / 1 失败。** 那 1 条是 renderer 的命中闸门
（`填充被显式隐藏的图层仍被命中 2/8`），**相对于 HEAD 就是失败的**，与匹配引擎无关。

（计数沿革：531 → 541 是为「匹配高亮组」新增的 10 条断言，它们直接对 `lib/matchFocus.ts`
跑行为、不是源码正则 —— 所以 `test:verify-smoke` 的 esbuild 命令当时补了
`--alias:@shared=./src/types`，否则那个模块 import 的 `@shared/aiAcceptance` 解析不了、
整个冒烟起不来。541 → 566 是为**人工标注**新增的 25 条 `0b` 分节断言；
`0b` 刻意排在**真实样本检查之前** —— 它全是纯函数与源码结构断言，不需要样本，
样本缺失时也照样跑。566 → 592 是本轮为 **L3c** 新增的 26 条：`0b` 16 条
（一致性六档判定 / 视口分母 / L3c 的接入点与「只许产出候选」结构守卫），
`12.15` 10 条（L3c 夹具的正例 + **两条负控** + 标定契约的纯函数断言）。
⚠️ `12.15` 排在 `12.2 门禁` 之前、且需要真实样本（它在样本闸门之后）。）

### L3b · 真值闭环（改引擎判据后**必跑**）

```bash
cd apps/screen-mirror-mac
npm run replay:gt -- \
  "/Users/lijing/Library/Application Support/screen-mirror-mac/workspace/debug-exports/盲盒抽奖-10年管家开通前-2026-09-16_10-57-40.json" \
  "/Users/lijing/Library/Application Support/screen-mirror-mac/workspace/ground-truth-exports/盲盒抽奖-10年管家开通前-ground-truth-2026-09-17_13-42-38.json"
```

**为什么必须有它**：`probe:match` 只看**聚合总数**，而总数可以完全不变、错的全换一批。
没有真值，改完规则永远不知道自己是变好还是变坏。典型如第一版 L3c：`matched` 涨了、
`contradicts` 却没变，看起来是净赚 —— 实则是把「设计 A 配到了 App Z」从 `missed`
搬进了 `ambiguous` 的错对象里，**只有按配对对照人工答案才看得出来**。

**判定线**：`contradicts` 不得上升；`found`（agrees + weak + partial）不得下降。
两个方向都动的时候，以 `contradicts` 为先 —— 它是方向性错误，修法与漏配完全相反。

⚠️ **单样本调参是禁止的。** 这条闭环把「改一行看一次结果」的成本降到 2 秒，
于是很容易对着这 78 对把阈值一点点拧到最优 —— 那是过拟合，换一页就废。
门槛只允许由**结构性事实**推出（量纲、几何、可解释的物理量），
不允许由「这样改这一页更准」推出。见 `CALIBRATION_DISTANCE_MARGIN` 的注释。

### L3 · 真实数据（旧导出包，秒级）

```bash
cd apps/screen-mirror-mac
npm run probe:match -- "/Users/lijing/Library/Application Support/screen-mirror-mac/workspace/debug-exports/盲盒抽奖-10年管家开通前-2026-09-16_10-57-40.json"
```

基线（本轮改动后的实测值，用于对比后续改动）：

```
意义类别 salience   text 105/102   graphic 264/115   box 191/130   layout 49/180
参与度              required 438/344   context 22/131   ignored 149/45
状态                matched 49   ambiguous 99   missing 454   extra 379
来源                calibrated-position 67 · text-anchor 40 · sibling 29 · ancestor-vote 8
                    · text-disambiguated 3 · text-aggregate 1

design required 438 → matched 49 · ambiguous 89 · 未消化 300（静默丢失 233）→ 31.5%
app    required 344 → matched 48 · ambiguous 96 · 未消化 200（静默丢失  90）→ 41.9%
```

**看什么**：`静默丢失`（outOfScope）是**从未进过任何分配矩阵**的节点数——扩散链断在哪儿全靠它。
低覆盖率**不是打分太严**，是祖先容器没锁上、整棵子树没被考虑过。

⚠️ 这两行现在是 L3c 的效果读数，别当成与上一版同口径的历史值。L3c 之前是
`design 未消化 368（静默丢失 310）→ 16.0%` / `app 未消化 267（静默丢失 145）→ 22.4%`：
**静默丢失 design −77、app −55，覆盖率翻倍** —— 这正是「队列排空后补一层、
且新锁的容器继续下推」的收益所在（少了任何一半，收益都会掉回去）。

⚠️ **这个包采集于 SDK 图片判定修复之前**，所以它只能验引擎，**验不了 L4**。

### L3c · 锚点校准定位（本轮新增的那一层）

**它解决的是什么**：实测 42 个漏配对里，「父容器已经被配成一对」的有 **0** 个 ——
L3a 要祖先、L3b 要容器，两层同时空转。而 `dr`／`ar`（根）已经被锁上了，
说明证据不是不够，是**类型不对**：树结构在这类节点上没有可用的证据。

**它的证据是什么**：用 L2 已锁定的**文本锚点对**拟合 `App y → 设计稿 y` 的分段线性映射，
再在「校准后的位置 + 尺寸」上做双向最近邻。三条硬约束：

| 约束 | 值 | 为什么 |
|---|---|---|
| 采样只取文本类来源 | 排除 `ancestor-vote` / `sibling` | 拿待检验的结论去校准检验标准，错的越多校准越自洽 |
| 样本数 ≥ 4 且跨度 ≥ 64px | 不满足返回 `null` | 退化 = 不做校准；硬猜比不工作更糟 |
| 合计距离 ≤ 28px 且次优 ≥ 1.6× | 像素量纲 | 分数挤在 0.85~1.0，用分数差当门槛永远达不到 |

**它只产出 `ambiguous`**：几何推断不是既成事实。一旦让它产出 `matched`，
「离得近」就拥有了与「文案完全相等」同等的自动确认权。

**两个容易漏掉的实现细节（都踩过）**：

1. **必须排在 L3b 队列排空的那一刻、且仍在循环条件里**。放到循环之后，
   本层新锁的容器就只停在它自己那一层，里面整棵子树仍然漏配 ——
   `12.15` 的正例就是靠这条才会连带把 `dIconIn` 也消化掉。
2. **距离必须算尺寸，不能只算中心**。设计稿的「32×32 图标 Frame」与它内部
   「20.6×27.5 的矢量」对同一个 App ImageView 的**中心距离几乎相等**，
   谁赢只取决于遍历顺序 —— 实测 16 例里 10 例选中了真值的**子孙节点**。
   加上尺寸失配后两者立刻分开（位置 2.4/1.4 打平，合计 2.5 vs 17.1）。

**已知的、还没解决的缺口**（别当成 bug 反复查）：

| 缺口 | 实测 | 为什么还没动 |
|---|---|---|
| **底部锚定元素** | 5 对（底栏图标，残差 ~240px） | 设计底栏贴帧的底、App 底栏贴视口的底 → 两侧不是同一个坐标系。需要「按锚比较」的第二套标定，见 `GROUND-TRUTH-SHEET.md` 的 T1b |
| **同盒孪生的设计侧** | 2–4 对 | 设计稿里 `GROUP 162×40` 与它的子 `RECTANGLE 162×40` 完全同盒，人随手点了内层。两侧盒子一致，几何上无法区分；且人点的内层是叶子，App 的子节点就没有容器可下推了 —— **引擎选外层在结构上更自洽**，倾向保留现状 |
| **校准的局部误差** | 8 对（差一位配到隔壁兄弟） | 分段线性只由文本锚点撑起来，图标行所在的高度没有锚点。要更高精度得加局部标定，属新工程 |


⚠️ 另外，`app graphic 115 vs design 264` 这个缺口**不要**当成「SDK 还没修好」的证据 ——
后续实测证明 SDK 修复后它**仍然是 115**（理由见 L4 的「被证伪的预期」）。那只是两侧图形语义的天然差异。

### L4 · SDK 修复的真实效果 ★ 唯一需要新采集的一层

```bash
# ① 重打 SDK 包（改的是 Java，必须重打）
cd packages/react-native-ui-acceptance && npm pack

# ② 装进 MallApp 并**原生重建**（热更新 / JS reload 不够：Java 变了）
#    gradle assembleDebug —— 这一步通过本身就是 Java 改动的第一道验收
#    （compile-check.sh 只做 javac，不验证运行时行为）

# ③ 手机上：粘贴配对串 → 点悬浮按钮上传
#    配对串在 Mac 验收页面上，形如 smacceptance://<ip>:23458?token=<hex>
#    ⚠️ 上传前藏掉 App 自带的调试浮层，否则会被当成「设计稿没有的元素」

# ④ Mac：验收页面点「开始接收」（等待窗口 3 分钟）→ 收到 → 「运行验收」→ 「导出」

# ⑤ 拿新导出包跑同一份探针
npm run probe:match -- "<新导出包路径>"
```

**判定指标 —— 看 `rawNodes.app` 的原始字段，不是 canonicalize 之后的 salience 分布：**

| 指标（`rawNodes.app`） | 修复前 | 实测 2026-09-17 | 结论 |
|---|---|---|---|
| `layoutOnly=true` | 311 | **178** | ✓ 等式修复生效（预告 191，实测更低） |
| `participation=required` | 216 | **345** | ✓ 承载结构的容器不再被划成 context |
| `participation=ignored` | 74 | **45** | ✓ 不再被误降级 |
| `hasVisualContent=true` | 216 | **235** | ✓ +19，Fresco 图片恢复 |

133 个节点的属性变化按 className 归因：`ReactViewGroup` 61 · `GroupView` 42 ·
**`FastImageViewWithUrl` 19** · 其余 11。**19 正好等于此前诊断出的 Fresco 误判数。**

⚠️ **一条被证伪的预期（别再照它判断）**：不要期待「canonicalize 后的 `app graphic` 上升、
`app layout` 下降」。实测两者**一动不动**（115 / 180）。因为 `core.ts` 的 salience 是**纯几何自算**：

```
salience = textPresent ? 'text'
         : 无有效子 ? (selfDraws || graphicKind ? 'graphic' : 'layout')
         : passThrough ? 'layout' : 'box'
```

它**不读** SDK 的 `layoutOnly` / `participation` —— 所以那两项修复对**匹配结果的影响是 0**。
数据变准了，但引擎本来就没依赖那两个字段。（`hasVisualContent` 只用在一个叶子/透传分支上，
而 19 个图片靠 `isImage` 早就是 graphic 了。）

**排查要点：SDK 与 Mac 两侧独立演进，改一侧不会自动改变另一侧的结果。**

### L4x · 确认「两侧都真的更新了」

SDK 和 Mac 是**两个进程、两套代码**，只更新一边拿不到完整效果。看导出包就能判：

| 看什么 | 含义 |
|---|---|
| `rawNodes.app[i]` 有 `passThrough` 字段 | SDK 是新版（该字段 09-16 才加入） |
| `documents.design.nodes[0]` 有 `salience` | Mac 是 v2 引擎 |
| `diagnosis` 有 `resolve` | Mac 含归宿表（最新） |
| `statusCounts.matched > 0` | Mac 真的在跑 v2 匹配 |

**实测踩坑**：2026-09-17 那份包里 SDK 数据是新的（133 节点变化为证），但 Mac 仍是 **v1 引擎**
—— 无 `resolve`、无 `salience`、`statusCounts` 里根本没有 `matched` 键（即 0）。
所以界面上看到的还是「匹配 0」，**跟引擎好坏无关，纯粹是 Mac 没跑上新代码**。

⚠️ **不要用轻量 profile 采集**。`uploadBundle` 固定走 `acceptance-full`：轻量档会省掉隐藏节点和文本，
下游一律读成「App 缺失该元素」——这是比漏报更危险的假阴性。

### L5 · 端到端 UI

在 Mac 界面确认四件事：

1. 「运行验收」不再提示匹配 0；
2. 匹配明细面板里每条有**六特征条形图 + 候选榜**；
3. **歧义条目能点「确认 / 忽略」**（本轮给祖先投票产的歧义补过候选，之前那边是死路）；
4. **点匹配明细里的一条 → 画布上两侧节点同时被框出**。这是本轮新增的联动，逐条核对：

   ⚠️ 2026-09-17 起验收面板**不再单列「问题（P0/P1/P2）」**：缺失 / 多余 / 歧义在匹配
   明细里本来就是一行（还带六特征分与候选榜），摊成两处只会让同一批节点出现两次。
   汇总计数（匹配 / 缺失 / 多余 / 歧义 / 未知）仍留在面板顶部，所以「有没有问题」
   依旧在第一屏有答案。`result.issues` 照旧由引擎产出，只是不再铺开显示。

   | 动作 | 应看到 |
   |---|---|
   | 点一条匹配 | 两侧对应节点同时出现**实线青框 + 淡青填充**；列表那一行出现**左侧竖条** |
   | 点一条**成组**匹配（N:M） | 一组里的**每个**节点都出框（不是两侧各一个） |
   | 视口 | **纹丝不动**（高亮不聚焦；视口只在点左侧图层列表某一行时才移过去） |
   | 再点同一条 | 高亮取消，竖条消失 |
   | 点画布上**组外**的节点 | 高亮自动收起，恢复成平时的「对侧框」（紫色点线） |
   | 按 Esc 退到最外层再按一次 / 点右栏的 × | 选中与高亮一起清空 |

   ⚠️ 高亮**故意与「选中」分开**：选中是单值、会被画布点击改掉；高亮是一组、
   只在列表里再点一次才消失。合成一个的话，用户点一下画布想看清楚，刚框出的整组就散了。

   ⚠️ 高亮**也不移动视口**（2026-09-17 的反馈：原先会把视口挪到「节点更多的那一侧」，
   常常就是设计稿，把用户刚摆好的取景抢走）。所以「点了没反应」的正确判读是
   **看画布上有没有青色框**，而不是看视口有没有动；框落在当前视野外就自己平移过去。
   没有任何框 = `result.matches` 里那一条的 `designNodeIds` / `appNodeIds` 为空，
   或者引用的节点在当前配对里一个都找不到（`resolved` < `requested`）。

### L6 · 人工标注（点选配对 + 导出）★ 唯一需要人工操作的层

**目的**：产出 ground truth，用来量引擎的漏配 / 误配，并据此反向优化匹配规则。
它**不是**验收的一部分 —— 标注永不被引擎读取（见下方「为什么必须分家」）。

操作：

```bash
cd apps/screen-mirror-mac
env -u ELECTRON_RUN_AS_NODE npm run dev:verify
```

1. 进「画布验收」→ 工具栏最右点 **标注**（图标 ✎）→ 右栏自动切到「标注」tab；
2. 在画布上点选节点 —— 两侧都可以点，**可以点多个**（1:N / N:M 是常态，不是例外）；
   再点一次同一个节点 = 移出待配对组；
3. 底部操作条出现待配对组（品红框），确认后点 **配对** / **另一侧不存在** / **忽略**
   （快捷键：Esc 清空、Enter 提交为配对）；
4. 标完全部后点 **导出标注** → 记下路径。

导出目录（workspace 根，**不随需求删除**）：

```
~/Library/Application Support/screen-mirror-mac/workspace/ground-truth-exports/
  <需求名>-<设计稿名>-ground-truth-<本地时间戳>.json
```

**判定线**（对着导出的 JSON 看）：

| 字段 | 含义 | 期望 |
|---|---|---|
| `metrics.annotatedPairs` | 本次标了几条 | = 你实际标的数量 |
| `metrics.prefilledPairs` | 其中引擎预填、你没改过的 | 若你用了预填，**这个数必须被单独看待** |
| `metrics.agreementHuman` | **只看人工确认项**的引擎一致性 | 这才是引擎的真实水平 |
| `metrics.universe.design/app` | 可匹配节点总数（召回分母） | 与 `engine.summary.designNodeCount` 口径不同（后者是全部节点） |
| `pairs[].engine.agreement` | 每条标注引擎什么表现 | `agrees` / `partial` / `contradicts` / `missed` |
| `pairs[].unresolvedNodeIds` | 标注里指向已不存在节点的 | 非空 = 重新导入过设计稿，那条标注部分失效 |

三条硬约束（`0b` 分节会自动断言，改动时别绕过去）：

1. **引擎不读标注**。`core.ts` 不含 ground truth；`service.ts` 里 `readGroundTruth`
   只允许出现在 `getGroundTruth`（共 2 处：import + 一次调用）。
   一旦匹配链路读进标注，引擎就开始照着自己被评价的那份答案答题 ——
   此后无论跑多少轮都回不到「不改标注时引擎会怎样」，而这件事从任何数字上都看不出来。
2. **标注与人工映射是两个文件**（`ground-truth-<pairId>.json` vs `mapping-<pairId>.json`）。
   mapping 是喂给引擎的输入（锚点 / 忽略），标注是引擎算得对不对的答案。混在一份里，
   标一句「引擎配错了」会立刻变成引擎的锚点。
3. **一致性判定只有一份实现**，在 `acceptance/groundTruthExport` 里。
   标注面板刻意不显示「引擎对不对」——它要一套「先看配错、再看漏配」的顺序规则，
   面板里再写一份，两边迟早给出两个答案，而它们看起来都像权威。

⚠️ **叠图模式下截图帧不参与点选**（`pointer-events: none`，见 L5 那张表的成因）。
要标 App 节点请切回「全页验收」；操作条上会直接提示这一句。

---

## 3. 已知会红的项（别误判成回归）

| 项 | 状态 | 说明 |
|---|---|---|
| 冒烟 1 条：`填充被显式隐藏的图层仍被命中 2/8` | 🔴 红 | renderer 命中闸门（`hittable` vs `hasFill`），**相对于 HEAD 即失败**，独立议题 |
| L3 的 523 missing / 16.0% 覆盖率 | 🟡 难看但对 | 这是**真实数据的真实现状**，不是 bug。病因已定位为扩散链断 |
| L4 的 `graphic` 数没到 design 水平 | 🟡 正常 | 两侧本来就不是一一对应，看方向不看绝对值 |

---

## 4. 排查入口

| 现象 | 用什么 |
|---|---|
| 想追「某个节点为什么没配上」 | `SM_MATCH_TRACE=1 npm run test:verify-smoke` 打 L3b 队列流动 |
| 想知道「静默丢失」有多少 | `probe:match` 的归宿表（`MatchDiagnosis.resolve`） |
| 想看某条配对的六特征分 | `probe:match --list` 看全部锁定配对 |
| UI 上没有候选可确认 | 检查 `apply()` 的候选兜底是否被绕过 |

类型层面本轮加了 `MatchTrace` / `ResolveTable`（`diagnoseMatching` 签名多了一个可选 trace 参数）——
`pnpm check:mac` 会覆盖到。

---

## 5. 本轮改动 → 应看到的数字变化

| 改动 | 应看到 |
|---|---|
| `punchThrough` 替换 → 成组（`punchThroughPath`） | 镜像夹具 missing/extra **11 → 0** |
| 链中途截断：裁剪而非丢弃 | 同上（两处独立成因） |
| 结构相容硬门控（`box`/`layout` ↔ `graphic` 判 0） | 真实包 `sibling` 来源 **37 → 27**，拒绝 10 对错配 |
| L3b status 按分数判（不再硬编码 ambiguous） | `matched` 从 21 升到 48+；`AUTO_MATCH_THRESHOLD` 不再是死代码 |
| 锚点置信度函数化 | 镜像夹具**不变**（改动刻意做得很轻，最多降 5%，只用于拉开 margin） |
| 归宿表 `resolve` | `probe:match` 多出「静默丢失」一栏 |
| Drawee / `layoutOnly` 修复 | **旧包看不到**，必须 L4 新采集 |
| 人工标注（ground truth 点选 + 导出） | 冒烟 **541 → 566**（`0b` 新增 25 条）；导出 JSON 出现在 `ground-truth-exports/` |
