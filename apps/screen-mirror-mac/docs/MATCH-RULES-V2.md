# 节点匹配规则 v2 · 锚点优先

> 状态：**规格草案，已在真实导出包上原型验证**
> 适用范围：`src/main/acceptance/core.ts#matchDocuments` 及其替代方案
> 样本：`盲盒抽奖 / 10年管家开通前`（design 609 节点，app 527 节点）

---

## 0. 为什么必须换规则

### 0.1 现状实测

同一份数据，当前引擎输出：

| 指标 | 值 |
|---|---|
| matched | **0** |
| ambiguous | 5 |
| missing | 604 |
| extra | 522 |

### 0.2 根因：树形不对齐 + 同层下探

`matchDocuments` 的下探是**逐层同步**的 —— `visit(designNode.childIds, appNode.childIds)`（`core.ts:495-544`）。这要求两棵树的深度结构一致，而实测**根本不一致**：

| | design（Figma） | app（Android View） |
|---|---|---|
| 节点数 | 609 | 527 |
| 最大深度 | **11** | **33** |
| 有文本的节点 | 105 | 102 |
| 内容节点所在深度 | d2 ~ d7 | d24 ~ d29 |

**已锁定的 45 对文本锚点，深度偏移实测分布：**

```
app深度 − design深度 = { 12×1, 13×4, 19×2, 21×3, 22×12, 23×22, 24×26, 25×2, 26×11 }
```

偏移量在 **+12 ~ +26 之间浮动且不固定** —— 这从数据上直接否掉了「同层比较」和「固定深度偏移校正」两条路。

偏移为什么浮动：App 侧在真实内容之前有约 20 层框架包装，且**分叉点与 design 不一致**。

```
   d0  DecorView                 required  hasVisualContent=true
   d1  LinearLayout              透传
   d2  FrameLayout               透传
   d3  FitWindowsLinearLayout    透传（此处分叉：ViewStub(0x0) + 导航栏 + 内容）
   d4  ContentFrameLayout        透传
   d5  ReactSurfaceView          透传（分叉）
   d6  RNGestureHandlerRootView  透传（分叉）
   d7  EdgeToEdgeReactViewGroup  透传
   d8  SafeAreaProvider          透传
   d9  ReactViewGroup            透传（分叉）
   d10 ScreenStack               透传
   d11 ScreensCoordinatorLayout  透传（分叉）
   d12 Screen                    透传（分叉）
   d13 ScreenContentWrapper      required  10 个子节点（导航器 chrome，高度全为 0）
   d14~d20                        透传
   d21 ReactViewGroup            required（分叉）
   d22 HMRefreshRefreshing       透传
   d23 ReactScrollView           透传
   d24 ReactViewGroup 360×2091   透传
   d25 ReactViewGroup 360×1078   透传（40 子）
   ── 真正的页面内容从这里才开始 ──
   d26~d33                       内容
```

### 0.3 同层下探的实际后果

根对 `design:1755:12353 (10 子) ↔ app:sdk:0 (2 子)` 的六特征分解：

| 特征 | 权重 | 得分 | 加权 |
|---|---|---|---|
| geometry | 0.28 | 0.7335 | 0.2054 |
| **structure** | **0.18** | **0.2000** | **0.0360** |
| relation | 0.16 | 0.8333 | 0.1333 |
| visual | 0.16 | 1.0000 | 0.1600 |
| kind | 0.12 | 1.0000 | 0.1200 |
| content | 0.10 | 0.5000 | 0.0500 |
| | | **合计** | **0.7047** |

- `structure = 0.2` 来自 `1 − |10−2|/10` —— 两侧根节点的**分叉数**本来就不同（App 根是 `[全屏 LinearLayout, 18px 导航栏]`）。这是宿主框架决定的，不是缺陷。
- 即使 `structure` 满分，总分 = 0.7047 + 0.18×0.8 = **0.8487**，**仍差 0.0013 到不了 0.85 的自动确认线**。几何分母取 `设计宽+高 = 1636`，而设计稿是整页长图 1261、App 快照是单屏 792，仅高度差就吃掉 0.2665 的 geometry 分。
- 结果：根对永远停在 `ambiguous`（confidence 封顶 0.84），下探两三层后撞死在包装层上，整棵子树退化成 missing/extra。

### 0.4 但数据本身是好的

把两侧节点做**全量一对一**配对（不依赖树形），同样的打分函数：

| | 结果 |
|---|---|
| 能配成 | **453 对** |
| 其中 ≥ 0.85 | **151 对** |
| 105 个 design 文本节点里，App 全树存在 ≥0.85 对应者 | **67 个** |
| ……存在 ≥0.38（匹配阈值）对应者 | **105 / 105** |

真对应节点的几何分接近 **1.000**（缩放校准是准的）。**问题从来不是数据，是"怎么找到它"。**

---

## 1. 新规则总纲

用**锚点**建立局部对应，再用**锚定扩散**把对应关系铺到容器与布局层。**不使用树形位置，不使用固定深度偏移。**

```
L1 意义分类  ── 把「有意义的元素」和「无意义嵌套」分开
   ↓
L2 锚点提取  ── 文本 / 图形 建立高可信的一对一
   ↓
L3 锚定扩散  ── 祖先投票 + 兄弟分配，把一对扩成一片
   ↓
L4 意义过滤  ── 只对有意义的节点判 missing / extra
```

核心原则：

1. **先相信内容，再相信位置。** 文本完全相等比「同一层第 3 个」强得多。
2. **位置只用来消歧，不用来约束层级。** 深度偏移 12~26 且不固定，任何层级先验都会误伤。
3. **无意义的嵌套既不该被匹配，也不该被判缺失。**

---

## 2. L1 · 意义分类（salience）

每个节点归入四类之一：`text` / `graphic` / `box` / `layout`。

### 2.1 关键定义：透传包装（filler）

> **filler** = 自身不绘制任何像素 **且** 只有一个有效子节点 **且** 子节点矩形 ≈ 自身矩形（容差 2px）

`layout` = filler 或无子节点的纯容器。**只有 filler / layout 会被排除在 missing / extra 之外。**

```ts
// 有效子节点：排除 ignored、零尺寸
const effective = children.filter(c => c.participation !== 'ignored' && c.width > 0 && c.height > 0)
const isFiller = !selfDraws(node)
              && effective.length === 1
              && sameRect(effective[0], node, 2)   // 容差 2px
```

`selfDraws(node)` 分侧定义：

| 侧 | 判据 |
|---|---|
| design | `hasFill \|\| strokes?.length \|\| effects?.length` |
| app | `hasVisualContent` |

### 2.2 四类判定

| 类 | design | app |
|---|---|---|
| `text` | `text.characters` 非空 | `text` 非空 |
| `graphic` | `type ∈ {VECTOR, ELLIPSE, LINE, BOOLEAN_OPERATION, STAR, POLYGON}`，或有填充的叶子 `RECTANGLE` | `isImage \|\| isSvg \|\| isGradient` |
| `box` | 有子节点 且 不是 filler | 有子节点 且 不是 filler |
| `layout` | filler 或无子节点 | 同 |

### 2.3 ⚠️ 这里踩过的坑（必读）

第一版我用「**无视觉内容**」当 layout 判据，结果：

| 判据 | design 分类 | app 分类 | 祖先投票结果 |
|---|---|---|---|
| 无视觉内容 | box 19 / layout 206 | box **18** / layout **319** | ❌ 全部锚点投票给树根 |
| **透传包装** | box 178 / layout 47 | box **146** / layout **191** | ✅ 收敛到正确容器（38 票，geo 0.916） |

用「无视觉内容」判时，App 侧 319/527 被划成 layout —— 于是「找最近的 box 祖先」在 App 侧一步就跳到根节点，45 个锚点全部投票给 `sdk:0`。

**结论：判定依据必须是「是否产生分支」，不是「是否画像素」。** 一个 360×792 的全屏透明容器与一个 40px 的图标容器，对匹配的价值完全不同。

---

## 3. L2 · 锚点提取

### 3.1 文本锚点（最强，confidence 1.0）

**归一化**（必须全部做，缺一不可）：

```ts
1. 去掉零宽字符：\u200b \u200c \u200d \ufeff \u2060   // App 侧实测存在，如 "Caba\u200bs\u200ba..."
2. \u00a0 → 空格
3. \s+ 折叠为单个空格，首尾 trim
4. 大小写统一（可配置，见 profile.text.caseSensitive）
```

**锁定规则：**

| 情形 | 处理 | 实测 |
|---|---|---|
| 两侧各只有 1 个相同文本 | 直接锁定，confidence **1.0** | **40 对** |
| 任一侧重复 | 几何消歧：候选对中取 `geo ≥ 0.85` 且一对一 | **5 对** |
| 凑不齐唯一对应 | 保留为 ambiguous，进人工/AI 仲裁 | — |

实测文本锚点质量：**45 对全部正确**，其中 40 对为零歧义。

**文本资源盘点（design 105 / app 102）：**

| | 种类数 |
|---|---|
| 两侧共有 | 43 种（覆盖 design 45 节点、app 47 节点） |
| 仅 design | 35 种 |
| 仅 app | 38 种 |
| 共有中两侧都唯一 | **40 种** |
| 共有中任一侧重复 | 3 种（`自营`、`更多`、`福利天天领`） |

### 3.2 ⚠️ 文本切分粒度不一致（必须支持 N:M）

实测反例：

| design | app |
|---|---|
| `10年包修` + `&` + `10年免费上门检测`（3 个 TEXT 节点） | `10年包修 & 10年免费上门检测`（1 个 ReactTextView） |

这是两侧文本只有 43 种交集的主因之一。**规则必须支持「同一父下相邻文本拼接后比对」**：

```
1↔1  完全相等                    → 锁定（现行）
N↔1  design 同父相邻 N 个文本拼接 == app 单个文本  → 锁定，confidence 0.9
1↔N  对称处理                    → 同上
```

### 3.3 图形锚点

`graphic ↔ graphic`，靠几何 + 尺寸比例建立，**不依赖父链**（父链此时还不可信）。

---

## 4. L3 · 锚定扩散

这是把 45 对（7.4%）扩成整页的关键，也是「基于纯文本做兄弟元素、父元素的锚定对比」的落地。

### 4.1 祖先投票

对每个已锁锚点 `(d, a)`：

1. 沿 design 侧取祖先链，**过滤掉 `layout`**，只留 `box` / `graphic`；
2. 沿 app 侧同样处理；
3. 对 design 链上的每个祖先 `Da`，在 app 链上找几何最佳且未被占用的祖先 `Aa`：

```ts
score = geo(Da, Aa) * (Da.salience === Aa.salience ? 1.0 : 0.7)
```

4. 得分 ≥ 0.55 则记一票给 `(Da, Aa)`。

**锁定条件：票数 ≥ 2 且平均几何分 ≥ 0.6。**

实测投票结果（修正分类后）：

| 票数 | 平均 geo | design | app |
|---|---|---|---|
| **38** | **0.916** | d0 `375×1261`（页面根） | a26 `375×1123` |
| **35** | 0.580 | d1 `351×1866`（主内容区） | a25 `375×2178` |
| **32** | 0.723 | d2 `351×728` | a24 `375×806` |
| 7 | 0.733 | d0 `375×1261` | a2 `375×825`（子树内重复，被更高票压制）|
| 5 | 0.916 | d5 `302×48` | a27 `351×122` |

高票项立刻指向真正的页面容器 —— 而当前引擎连根对都判不出来。

### 4.2 兄弟分配

容器对锁定后，在其子节点上做一对一分配：

```
rows = design 子节点中未锁 且 salience ∈ {box, graphic}
cols = app    子节点中未锁 且 salience ∈ {box, graphic}
score(r, c) = geo(r, c) * (r.salience === c.salience ? 1.0 : 0.6)
→ 匈牙利算法求最大权分配（沿用现有 maximizeAssignment）
```

分配结果递归下去，直到分数低于阈值。

实测收敛样例：

| design | app | 判定 |
|---|---|---|
| d6 `54×48` ×5 | a28 `55×48` / `50×48` / `38×48` ×4 | ✅ 5 个服务入口图标 |
| d3 `172×290` | a27 `172×291` | ✅ 商品卡 |
| d4 `148×100` | a28 `147×14` | ⚠️ 高度差 86px，需收紧阈值 |

### 4.3 三级置信度

| 来源 | confidence | 含义 |
|---|---|---|
| 文本唯一锚点 | 1.0 | 可直接当既成事实 |
| 文本消歧 / N:M 聚合 | 0.85 ~ 0.99 | 自动确认 |
| 祖先投票 / 兄弟分配 | 0.6 ~ 0.94 | **默认进 ambiguous，需人工过目** |

**关键：扩散产物不能自动升级为 matched。** 它们是"合理推断"，不是"事实"。这保留了当前引擎「AI 只能确认不能改判」的性质。

---

## 5. L4 · 意义过滤（消除假阴性）

只有 `text` / `graphic` / `box` 参与 missing / extra 判定。

### 5.1 实测脏数据

| 问题 | 数量 | 后果 |
|---|---|---|
| design `required` 且零尺寸 | **36** | 恒定 missing |
| design `required` 且坐标离谱（\|x\| 或 \|y\| > 1000） | **110** | 恒定 missing，如 `design:1755:12465/12466` 在 `x = -3301` |
| app `required` 且零尺寸 | 1 | — |

Figma 里放在画板外的组件实例被采进来并标成 `required` —— 而 `required` 是**唯一允许被判缺失**的档位（PLAN 的硬约束）。这些节点永远不可能在 App 侧找到对应，会稳定产出 P1 假阴性。

**处理：** 零尺寸或越界的 `required` 降级为 `optional`，或直接 `ignored`。判定放在归一化阶段，不要留在匹配阶段。

### 5.2 App 侧 filler 不判 extra

包装链上的节点（预计 191 个）不参与 extra 统计。否则每页固定产出上百条 extra 噪声，而 `extra` 当前是 P2 issue —— 只要有一条 issue 结论就出不了 `pass`。

---

## 6. 必须先修的 SDK 缺陷

新规则对「有意义元素」的识别精度要求很高，但底层信号当前不可靠。

### P0 · Fresco 图片被误判为「无视觉内容」

`NodeCollector.hasVisualContent()`（`NodeCollector.java:273-276`）：

```java
if (view instanceof ImageView) {
    Drawable drawable = ((ImageView) view).getDrawable();
    return drawable != null && drawable.getAlpha() > 0;
}
```

`FastImageViewWithUrl`（react-native-fast-image）继承 `GenericDraweeView` → `ImageView`，但 **Fresco 走 DraweeHierarchy，不调 `setImageDrawable`**，`getDrawable()` 恒为 `null`。

实测后果：

| | 数量 |
|---|---|
| `isImage=true` 但 `hasVisualContent=false` | **19** |
| 全部是 `FastImageViewWithUrl` | 19 |
| 含 360×288 首屏大图（面积合计 **1.59 屏**） | — |
| 被连带标成 `layoutOnly=true` | 19 |

对照：`isImage=true` 且 `hasVisualContent=true` 的有 33 个（走 `setImageDrawable` 的 RN Image）—— 说明**同一类语义元素被分成了两拨**。

**修法：** `isImageHostView(view)` 为真时直接返回 `true`，不要依赖 `getDrawable()`。

### P1 · `layoutOnly = !hasVisualContent` 这个等式不成立

`NodeCollector.java:197`。语义上 `layoutOnly` 应该是「无绘制 **且** 无分支」，现在等于「无绘制」。后果：`ReactScrollView`（360×774，1 个子）、`ScreenContentStack` 等承载布局语义的容器被归为 layoutOnly。

按新规则的 filler 定义重算，App 侧 layoutOnly 应从 311 降到 191。

### P1 · 透传包装没有直接标记

规则需要「单子 + 同框」这个判据，但 SDK 已经知道 rect 与子节点数 —— 建议在 `NativeNode` 上直接输出 `passThrough: boolean`，避免每次匹配都重算，也让 debug 导出可读。

---

## 7. 原型验证结果

在真实导出包上实现 L1-L3（Python 原型，算法与上面一致）：

| | 现状引擎 | 原型 v2 |
|---|---|---|
| matched | 0 | — |
| 锁定对（含高可信锚点） | — | **83（13.6%）** |
| ambiguous | 5 | — |
| missing | 604 | — |
| extra | 522 | — |

按来源拆分：文本锚点 45 + 容器对 8 + 递归下推 30。

**已验证正确的收敛：** 页面根容器（geo 0.916）、主内容区、5 个服务入口图标、商品卡网格。

**覆盖率仍低（13.6%），原因：**

1. N:M 文本聚合没实现 —— design 的 35 种「独有文本」里有相当部分是切分粒度差异，不是真的对不上；
2. 兄弟分配的阈值（0.65）偏松，出现 `148×100 ↔ 147×14` 这类高度严重不符的配对；
3. 只有 45 个文本锚点做种子，扩散的起点太少。

---

## 8. 实施顺序建议

| 序 | 事项 | 理由 | 触及 |
|---|---|---|---|
| **P0** | 修 Fresco `hasVisualContent` | 不修则 `graphic` 锚点少 19 个、含首屏大图 | `NodeCollector.java` |
| **P0** | 归一化阶段清理 design 脏节点（36 零尺寸 + 110 越界） | 消除恒定假阴性，独立于匹配规则 | `canonicalizeDesign` |
| **P1** | L1 意义分类（含 filler 判定） | 后两步的地基，且是本次最大的坑 | `core.ts` 新增 |
| **P1** | L2 文本锚点 + N:M 聚合 | 最高信噪比的信号 | `core.ts` |
| **P1** | L3 祖先投票 + 兄弟分配 | 覆盖率放大器 | `core.ts` |
| **P2** | L4 意义过滤接入 verdict | 与 `evaluateReadiness` 的 P1 问题一并收敛 | `service.ts` |

**注意：** 新规则不改变裁决层（`evaluateAcceptance`）与 AI 仲裁的定位 —— 仍然只有规则能判定，AI 只能在 ambiguous 上确认。变的是「规则怎么产生候选」。

---

## 附：复现原型

原型脚本仅用于验证，未入库。复现需要一份 `debug-exports/*.json`：

```bash
# 1. 在 Mac app 里对某个配对点「导出数据」
# 2. 用导出包跑统计
python3 /tmp/uii/proto3.py
```
