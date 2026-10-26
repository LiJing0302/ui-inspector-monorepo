# RN UI 验收的源码与属性来源追踪评估

日期：2026-10-15。依据：当前仓库源码和一次实际 Babel 转换验证。本文回答可行性与 source map 的作用，不代表已经实现下面的扩展，也不代表完成真机验证。

## 结论

**现有 SDK 不能保证“每个元素的每个属性都精确对应到源码实现”；增加普通 source map 也不能单独实现这个目标。**

当前已有 Android 开发态的“部分原生元素 → JSX 文件与行列”定位基础。要做到属性级解释，需要在此基础上建立“声明位置、实际生效的覆盖、计算输入与结果、原生布局结果”之间的对应关系。对有明确插桩和采集支持的场景可以提供精确证据；对任意第三方自绘、原生默认值、动画、父子布局等所有场景，不能承诺都有唯一的源码行。

## 1. 当前能力由什么证明

| 能力 | 当前证据 | 结论 |
|---|---|---|
| JSX 源码标记 | `packages/react-native-ui-acceptance/babel-plugin-ui-inspector.js` 的 `JSXElement` visitor，读取 AST 的 `loc`，生成 `sourceId`，写入 `nativeID` | 已有编译期标记，不依赖 bundle source map |
| 原生元素读取标记 | Android `SourceMarker.fromView()` 与 `NodeCollector` 中的 `node.source` | Android SDK 已有元素到 JSX 的映射基础 |
| 编辑器定位 | `apps/vscode-extension/src/extension.ts` 的 `openSource()` | 按相对文件和行列打开并选中源码；不是逐属性定位 |
| 标记覆盖范围 | Babel 插件只识别特定 `react-native` 导入；跳过不满足条件的 View 和显式 nativeID；后续展开 props 可覆盖标记 | 不能称为每个元素都有源码 |
| iOS 同等定位 | `src/inspector.ts` 的 `start()` 明确要求 `Platform.OS === 'android'` | 当前实时源码定位未覆盖 iOS |
| 属性来源协议 | `packages/inspector-protocol/src/index.ts` 的 `SourceRef` 只包含文件、范围、标识和角色 | 没有属性声明位置、覆盖链和计算依赖 |
| 上传快照保留映射 | Mac `src/types/acceptance.ts` 的 `normalizeSdkSnapshot()` 逐字段构造 AppNode；`verify.ts` 的 AppNode 未声明源码字段 | 当前归一化后的验收节点没有保留 SDK 的 `source` / `nativeTag` |

实时 Inspector 与上传验收是不同数据路径：前者通过 WebSocket 传 `InspectorNode`，后者经 `normalizeSdkSnapshot()` 再保存 `output.nodes` 到 `nodes.json`。不能以实时路径有源码定位来证明离线验收快照也已有该能力。

### 本次实际转换验证

使用仓库安装的 `@babel/core` 运行当前插件，转换包含以下情况的内存源码：

- `View testID="card" style={[s.card, {borderRadius: 12}]}`：注入 JSX 级源码标记，未注入 `borderRadius` 声明来源或样式覆盖信息。
- `View style={{padding: 16}}`：外层 View 未被注入源码标记，内部 Text 有标记。
- 显式 `nativeID="business-id"`：原值保留，没有 Inspector 标记。
- `Text {...props}`：Inspector 标记在展开 props 前；展开对象如果提供 nativeID，仍可覆盖它。

验证证明的是本插件当前的编译行为；未运行设备、VS Code 联调或 release 构建验证。

## 2. source map 能做什么

普通 JavaScript source map 建立的是“转换/压缩后的代码位置 → 原始 TS/TSX 代码位置”的对应关系。

- 当前 Babel 插件直接记录原始 AST 行列，基本 JSX 定位没有接入 `.map` 文件的硬性前提。若插件运行在其他源码转换之后，则还需确认记录的位置是否仍属于用户原始文件。
- 如果未来依赖 bundle 堆栈或运行时生成位置来定位原始源码，或者支持压缩包/预编译依赖，可以按需要接入 Metro/Hermes 对应构建的映射产物。
- source map 不会自动告诉平台：某个元素的 style 数组哪一项生效、动态 props 当时是什么、token 从哪里来、`w()` 如何换算、布局为什么把某个宽度压缩。

**如果把“源码映射”泛指元素/属性与源码建立关联，那确实需要；但它比常规 bundle source map 多一层运行时语义和依赖追踪。**

## 3. 为什么运行时属性不能直接反推出唯一源码

```tsx
const styles = StyleSheet.create({
  card: { borderRadius: 8 },
});

<View style={[styles.card, props.style, { borderRadius: w(12) }]} />
```

对这个圆角，完整解释至少包含：

1. 当前实例对应哪个 JSX，外部 props 来自哪个调用位置。
2. 基础样式的 `8` 被后面的项覆盖；实际生效声明是 `w(12)`。
3. `w` 的函数定义、设计基准、这次设备参数和实际返回值。
4. RN 传到原生绘制层的解析值，以及该组件是否有四角回退、自绘或曲线限制。

现有 SDK 主要提供第 4 项的部分结果，已有标记提供第 1 项的部分位置。仅看圆角最终数值，不能恢复第 2、3 项。

宽度与间距更复杂：`flex: 1` 没有对应某个固定 width 字面量；两个元素间距可能同时受到父 padding、子 margin、gap、justifyContent 和内容尺寸影响。因此应记录多个相关声明和布局依赖，而不是强行定位到唯一一行。

同样，元素与 Figma 节点的对应关系是另一条映射。源码行列不自动产生 Figma nodeId；需要人工配对或组件/token 等显式关联，不能让 source map 代替这条关系。

## 4. 推荐的工程推进顺序

1. **贯通已有元素定位。** 上传协议、归一化、落盘和验收页保留有效 SourceRef；记录快照所属源码构建与内容版本，避免代码已修改、旧行号却仍被当作准确位置。项目根路径 hash 不能代替代码版本。实例身份还需区分同一个 JSX 生成的多行列表项，并考虑虚拟列表复用与快照时点。
2. **增加属性声明映射。** 扩展 Babel 插件记录内联 style、受支持的 StyleSheet 声明、JSX props 的属性范围；通过绑定解析关联到真正引用的定义。为包装组件/第三方组件提供适配机制，不能仅靠 RN 导入白名单覆盖所有 UI。
3. **记录实际生效过程。** 采集与当前原生快照对应的已提交实例属性，按实际 RN 行为记录样式覆盖、条件选择及受支持的 token/适配函数输入输出。不要重复执行用户的表达式或假定 render 求值一定已提交；动画尤其可能在独立 UI 运行时更新，需要对应通道。
4. **关联声明与布局结果。** 保留原生采集；让父布局、文字、变换、自绘等结果带有依赖与证据状态。无法可靠解释时显示“布局推导”“第三方内部实现”或“来源不可用”，不猜测来源。
5. **按定位输入决定是否使用 source map。** 直接插桩记录原始源码范围时，它是可选补充；当输入只有生成代码位置或压缩堆栈时，需要对应 bundle、source map 和准确构建身份。它始终不能替代属性追踪。

这些追踪应优先放在开发/验收构建，保持运行语义不变。当前插件特意避免为了定位强行保留所有原生 View，因为这会改变 RN 的视图扁平化与命中行为；扩大覆盖时仍需处理这个约束。

## 5. 验收面板应该呈现的证据

每个属性可展示：设计要求、源码声明/表达式、实际生效项、适配或计算结果、原生实测，以及来源状态。

“源码声明追踪”帮助解释实现；“与设计要求比较”决定是否符合验收。二者不能合并：开发代码即使被完全追溯，也可能本身就写错。

建议对“精确对应”制定可验证的覆盖矩阵：平台、属性、样式写法、组件类型、动态/动画情况、实时/离线。只有支持且证据完整的格子承诺精确定位；不以一个简单内联样式样例证明全量覆盖。
