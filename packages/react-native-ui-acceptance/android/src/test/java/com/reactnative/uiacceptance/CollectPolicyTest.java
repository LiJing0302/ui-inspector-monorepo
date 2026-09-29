package com.reactnative.uiacceptance;

import java.util.ArrayList;
import java.util.List;

/**
 * {@link CollectPolicy} / {@link CollectOptions} 的单元测试。
 *
 * <p>覆盖 PLAN「十、测试与验收标准 · SDK 测试」里**在采集策略层可判定**的那些条目：
 * 隐藏节点保留、隐藏父节点的子树保留、零尺寸父节点的溢出子节点保留、文本默认采集、
 * Overlay 开关、截断上限、透明容器仍保留、敏感输入脱敏。
 *
 * <p><b>刻意不引 JUnit</b>：这个仓库没有 gradle wrapper，也没声明 junit 依赖 ——
 * 库模块只能被宿主 App（MallApp）构建，引了 JUnit 也跑不起来，只会多一个没人执行的配置。
 * 这里用最笨的 main() + 计数器，{@code javac + java} 就能跑（scripts/test-collect-policy.sh）。
 * 将来若要接 CI，把这些 {@code check(...)} 换成断言库的调用即可，命名已经是它的形状。
 *
 * <p><b>刻意不覆盖</b>：{@code optionsFrom} / {@code acceptanceOptionsFrom} 里解析
 * {@code ReadableMap} 的那几行 —— 那需要 RN 的类在 classpath 上，会把这个「零依赖 3 秒
 * 测试」变成「得先凑齐 aar 的测试」。它们本身只是读字段 + {@link CollectPolicy#clamp}，
 * 真正有产品语义的**默认值**全部落在 {@link CollectOptions} 里，已被下面断言。
 *
 * <p>断言的写法偏「说人话」而不是「测实现」：每条都写清**错了会怎样**，
 * 因为这几行判定出错时不会抛异常，只会让验收结论静默走偏。
 */
public final class CollectPolicyTest {

    private static int passed;
    private static final List<String> failures = new ArrayList<>();

    private static void check(String label, boolean ok) {
        if (ok) {
            passed++;
        } else {
            failures.add(label);
        }
    }

    private static void eq(String label, Object actual, Object expected) {
        boolean ok = actual == null ? expected == null : actual.equals(expected);
        if (ok) {
            passed++;
        } else {
            failures.add(label + "（期望 " + expected + "，实际 " + actual + "）");
        }
    }

    private static void eqInt(String label, int actual, int expected) {
        if (actual == expected) {
            passed++;
        } else {
            failures.add(label + "（期望 " + expected + "，实际 " + actual + "）");
        }
    }

    private static void eqLong(String label, long actual, long expected) {
        if (actual == expected) {
            passed++;
        } else {
            failures.add(label + "（期望 " + expected + "，实际 " + actual + "）");
        }
    }

    public static void main(String[] args) {
        acceptanceProfile();
        legacyAndRecordingProfiles();
        skipSelfFiltering();
        participation();
        passThroughAndLayout();
        ancestorVisibility();
        effectiveVisibleRect();
        sensitiveText();
        styleFormatting();
        clamping();
        crossProcessNaming();
        report();
    }

    /** Ancestor visibility is cumulative even when a child reports visible=true by itself. */
    private static void ancestorVisibility() {
        check("祖先可见：当前节点可见时不隐藏子树",
                !CollectPolicy.childHiddenByAncestor(false, true));
        check("祖先隐藏：当前节点可见时子节点仍视为被祖先隐藏",
                CollectPolicy.childHiddenByAncestor(true, true));
        check("当前节点隐藏：子节点继承隐藏状态",
                CollectPolicy.childHiddenByAncestor(false, false));
        check("多层祖先隐藏：隐藏状态不能被中间节点清除",
                CollectPolicy.childHiddenByAncestor(
                        CollectPolicy.childHiddenByAncestor(true, true),
                        true));
    }

    /** PLAN「二.1 验收采集默认全量」。 */
    private static void acceptanceProfile() {
        CollectOptions options = CollectOptions.acceptanceDefaults();

        eq("验收档：档位名必须是 acceptance-full（Mac 侧上传校验只认它）",
                options.profileName, CollectOptions.PROFILE_ACCEPTANCE_FULL);
        check("验收档：默认收隐藏节点（否则 GONE 掉的一整块在验收里凭空消失）",
                options.includeInvisible);
        check("验收档：默认收零尺寸节点", options.includeZeroSize);
        check("验收档：默认收文本（文案验收的全部依据）", options.includeText);
        check("验收档：被过滤节点仍继续遍历子树（零尺寸父节点外溢的可见子节点全靠它）",
                options.descendIntoSkipped);
        check("验收档：不在用户屏幕上画 overlay", !options.showOverlay);
        check("验收档：isAcceptanceProfile() 为真", options.isAcceptanceProfile());

        eqInt("验收档：maxDepth 取上限 128", options.maxDepth, CollectOptions.ACCEPTANCE_MAX_DEPTH);
        eqInt("验收档：maxNodes 取上限 30000", options.maxNodes, CollectOptions.ACCEPTANCE_MAX_NODES);

        // 三个「全收」开关是并列的，任何一个漏了都会让某一类节点整批消失。
        // 用一条断言把「这个档位是三个 true」钉住，避免将来加档位时复制粘贴掉一个。
        int included = (options.includeInvisible ? 1 : 0)
                + (options.includeZeroSize ? 1 : 0)
                + (options.includeText ? 1 : 0);
        eqInt("验收档：隐藏 / 零尺寸 / 文本三项必须同时为真（3 个 true）", included, 3);
    }

    /** 旧档（Overlay）与录制档：诉求与验收档相反，必须是**两套默认值**。 */
    private static void legacyAndRecordingProfiles() {
        CollectOptions legacy = CollectOptions.legacyDefaults();
        eq("旧档：档位名 = legacy", legacy.profileName, CollectOptions.PROFILE_LEGACY);
        check("旧档：默认不收隐藏节点", !legacy.includeInvisible);
        check("旧档：默认不收零尺寸节点", !legacy.includeZeroSize);
        check("旧档：默认不收文本", !legacy.includeText);
        check("旧档：过滤即剪枝（不为一个 GONE 的大子树白跑几千次遍历）", !legacy.descendIntoSkipped);
        check("旧档：默认显示 overlay", legacy.showOverlay);
        check("旧档：isAcceptanceProfile() 为假 —— 旧数据不能被当成验收输入上传",
                !legacy.isAcceptanceProfile());

        CollectOptions recording = CollectOptions.recordingDefaults(true, 64, 10000);
        eq("录制档：档位名 = recording", recording.profileName, CollectOptions.PROFILE_RECORDING);
        check("录制档：不收隐藏节点 —— 剪枝口径要和 Overlay 一致，耗时才有可比性",
                !recording.includeInvisible && !recording.descendIntoSkipped);
        check("录制档：includeText 由调用方决定，原样透传", recording.includeText);
        eqInt("录制档：maxDepth 原样透传", recording.maxDepth, 64);
        eqInt("录制档：maxNodes 原样透传", recording.maxNodes, 10000);
        check("录制档：不属于验收档，不能走上传通道", !recording.isAcceptanceProfile());
        check("录制档：不画 overlay", !recording.showOverlay);

        // 两套默认值必须真的不同 —— 合并过一次就会让 Overlay 掉帧、或让验收丢节点。
        check("档位：验收档与旧档在「全收 + 剪枝」上必须相反",
                CollectOptions.acceptanceDefaults().includeInvisible
                        != CollectOptions.legacyDefaults().includeInvisible);
    }

    /** PLAN「二.2 节点不删除，只标记状态」的前置：过滤只判自身，不牵连子树。 */
    private static void skipSelfFiltering() {
        // 验收档：什么都不过滤
        check("过滤·验收档：隐藏节点不被过滤（保留 = 结构化信息不丢）",
                !CollectPolicy.skipSelf(true, true, false, 100, 100));
        check("过滤·验收档：零尺寸节点不被过滤",
                !CollectPolicy.skipSelf(true, true, true, 0, 0));

        // 旧档：隐藏 / 零尺寸都过滤
        check("过滤·旧档：隐藏节点被过滤",
                CollectPolicy.skipSelf(false, false, false, 100, 100));
        check("过滤·旧档：宽度为 0 被过滤",
                CollectPolicy.skipSelf(false, false, true, 0, 100));
        check("过滤·旧档：高度为 0 被过滤",
                CollectPolicy.skipSelf(false, false, true, 100, 0));
        check("过滤·旧档：可见且非零尺寸的节点不被过滤",
                !CollectPolicy.skipSelf(false, false, true, 100, 100));

        // 「可见但零尺寸」在旧档下会被过滤 —— 这正是「被过滤的父节点」的来源，
        // 它的子树走不走由 descendIntoSkipped 决定，是另一个决策。
        CollectOptions legacy = CollectOptions.legacyDefaults();
        CollectOptions acceptance = CollectOptions.acceptanceDefaults();
        check("过滤：同一个「可见但零尺寸」节点，旧档剪枝、验收档保留",
                CollectPolicy.skipSelf(legacy.includeInvisible, legacy.includeZeroSize, true, 0, 50)
                        && !CollectPolicy.skipSelf(acceptance.includeInvisible, acceptance.includeZeroSize, true, 0, 50));
    }

    /** PLAN「五.3 复合组件不折叠子节点」与「七.1 结构」都吃这里的分类。 */
    private static void participation() {
        // 第 4 个参数是 layoutOnly（= 无绘制 **且** 无分支），不是 hasVisualContent。
        // 两者的区别正是本轮修的东西：透明但承载结构的容器（ReactScrollView 等）
        // 以前因为「没有像素」被判成 context，于是 Mac 侧既不找它、也不算它是结构。
        eq("参与度·未附着 → unavailable（不能拿去判缺失）",
                CollectPolicy.participationOf(false, true, false, false), CollectPolicy.UNAVAILABLE);
        eq("参与度·隐藏 → optional（只保留结构，不做视觉判定）",
                CollectPolicy.participationOf(true, false, false, false), CollectPolicy.OPTIONAL);
        eq("参与度·零尺寸且是布局 → ignored（透明占位，不是缺失）",
                CollectPolicy.participationOf(true, true, true, true), CollectPolicy.IGNORED);
        eq("参与度·纯布局（透传 / 无分支）→ context（App 明明画了，只是没有像素；报 missing 是假阴性）",
                CollectPolicy.participationOf(true, true, false, true), CollectPolicy.CONTEXT);
        eq("参与度·有内容或承载结构 → required（唯一允许被判缺失的档）",
                CollectPolicy.participationOf(true, true, false, false), CollectPolicy.REQUIRED);

        // 边界：零尺寸**但不是**布局（自己在画、或者在分发内容）→ 不降级。
        // 尺寸为 0 却还要画东西本身就是异常，该被看见，而不是被静默归进「透明占位」。
        eq("参与度·零尺寸但有内容/有分支 → required（不静默降级成 ignored）",
                CollectPolicy.participationOf(true, true, true, false), CollectPolicy.REQUIRED);

        // 优先级：未附着 > 隐藏 > 零尺寸 > 纯布局。顺序错了会出现
        // 「一个也没附着、还隐藏着的容器」被报成 required，然后被判缺失。
        eq("参与度·优先序：未附着且隐藏 → unavailable（不是 optional）",
                CollectPolicy.participationOf(false, false, true, true), CollectPolicy.UNAVAILABLE);
        eq("参与度·优先序：隐藏且零尺寸 → optional（不是 ignored）",
                CollectPolicy.participationOf(true, false, true, true), CollectPolicy.OPTIONAL);

        String[] nonRequired = {
                CollectPolicy.UNAVAILABLE,
                CollectPolicy.OPTIONAL,
                CollectPolicy.IGNORED,
                CollectPolicy.CONTEXT,
        };
        boolean distinct = true;
        for (int i = 0; i < nonRequired.length; i++) {
            for (int j = i + 1; j < nonRequired.length; j++) {
                if (nonRequired[i].equals(nonRequired[j])) {
                    distinct = false;
                }
            }
        }
        check("参与度：四个「不可判缺失」档位互不相同（Mac 侧要分别给不同提示）", distinct);
        check("参与度：required 与四个非 required 档位都不同",
                !CollectPolicy.REQUIRED.equals(CollectPolicy.UNAVAILABLE)
                        && !CollectPolicy.REQUIRED.equals(CollectPolicy.OPTIONAL)
                        && !CollectPolicy.REQUIRED.equals(CollectPolicy.IGNORED)
                        && !CollectPolicy.REQUIRED.equals(CollectPolicy.CONTEXT));
    }

    /**
     * 「透传包装」与「纯布局」：同一枚硬币的两面，直接决定 Mac 侧认定哪些节点有意义。
     *
     * <p>判错的代价是**双向**的：判宽了，App 侧会冒出一堆「多出来的节点」；判严了，
     * 真正承载结构的容器（滚动区、内容栈）会被当成透明壳略过，于是设计稿里的整块内容
     * 判不出来 —— 而两种症状在报告里都只是「数字不对」，没有报错。
     */
    private static void passThroughAndLayout() {
        // —— 透传：不画像素 + 恰好一个铺满自身的有效子节点 ——
        check("透传：透明 + 单子 + 同框 → 是通道（SafeAreaProvider / ScreenStack 这类壳）",
                CollectPolicy.isPassThrough(true, false, 1, 0, 0, 0, 0));
        check("透传：父子差 2px（取整误差内）仍算同框",
                CollectPolicy.isPassThrough(true, false, 1, 1, -2, 2, -1));

        // 反证：这些都不是通道，全判成通道会让 App 侧的真实元素成片消失
        check("透传·反证：自身画像素 → 不是通道（那是卡片底色，是一个元素）",
                !CollectPolicy.isPassThrough(true, true, 1, 0, 0, 0, 0));
        check("透传·反证：两个有效子节点 → 不是通道（它在给它们分发位置）",
                !CollectPolicy.isPassThrough(true, false, 2, 0, 0, 0, 0));
        check("透传·反证：没有有效子节点 → 不是通道（空容器是占位，不是通道）",
                !CollectPolicy.isPassThrough(true, false, 0, 0, 0, 0, 0));
        check("透传·反证：子节点比自身小 20px → 不是通道（那是有内边距的盒子）",
                !CollectPolicy.isPassThrough(true, false, 1, 10, 10, -20, -20));
        check("透传·反证：子节点比自身大（可滚动内容）→ 不是通道",
                !CollectPolicy.isPassThrough(true, false, 1, 0, 0, 0, 400));
        check("透传·反证：隐藏节点 → 不是通道（它不是通道，是没画）",
                !CollectPolicy.isPassThrough(false, false, 1, 0, 0, 0, 0));

        // —— 纯布局 = 不绘制 且（透传 或 无有效子节点）——
        check("纯布局：透传包装 → 是", CollectPolicy.isLayoutOnly(false, true, 1));
        check("纯布局：空容器 → 是", CollectPolicy.isLayoutOnly(false, false, 0));
        // 这一条就是本轮修的等式。旧规则 `layoutOnly = !hasVisualContent` 会把它判成纯布局，
        // 于是 ReactScrollView（360×774、一个子）这类容器在 Mac 侧既不被匹配、也不被当成结构。
        check("纯布局·反证：透明但有两个子节点 → 不是（它承载结构，实测 App 侧这类有 120 个）",
                !CollectPolicy.isLayoutOnly(false, false, 2));
        check("纯布局·反证：透明但有一个非铺满的子节点 → 不是（内边距盒子）",
                !CollectPolicy.isLayoutOnly(false, false, 1));
        check("纯布局·反证：自己绘制 → 不是", !CollectPolicy.isLayoutOnly(true, false, 0));

        // 三个值串起来看：一份「透明 + 单子 + 同框」的壳，应该是纯布局，
        // 而它的 participation 落到 context（既不该被匹配，也不该被判缺失）。
        boolean passThrough = CollectPolicy.isPassThrough(true, false, 1, 0, 0, 0, 0);
        boolean layoutOnly = CollectPolicy.isLayoutOnly(false, passThrough, 1);
        eq("串联：透明壳 → layoutOnly → participation=context",
                CollectPolicy.participationOf(true, true, false, layoutOnly), CollectPolicy.CONTEXT);

        // 反过来：同样的盒子，只要它多装了一个子节点，就该被当成结构（required）。
        boolean branchLayout = CollectPolicy.isLayoutOnly(false, false, 2);
        eq("串联：透明但分发内容的容器 → participation=required",
                CollectPolicy.participationOf(true, true, false, branchLayout), CollectPolicy.REQUIRED);
    }

    /**
     * 有效可见矩形（祖先裁剪链）。
     *
     * <p>这一组断言的直接来源是 2026-09-20 的实测：价格数字轮（number-flow）3 列 × 30 个候选行，
     * 每行是一个 13×28dp 的 TextView，只有落在 28dp 裁剪窗口里的那一行真绘制 —— 而平台的
     * {@code getGlobalVisibleRect} 给 90 行**全部**报了「完整可见」，于是 76 个零像素元素混进了
     * 标注集合，画布上就是一片「不可见元素被框出来」。
     *
     * <p>判错的方向是单向的：漏判 → 伪元素进匹配矩阵；误判 → 真实元素被丢掉。
     * 所以下面既有正例也有反例。
     */
    private static void effectiveVisibleRect() {
        IntRect own = new IntRect();
        IntRect window = new IntRect();
        IntRect effective = new IntRect();

        // —— 没有窗口：原样返回 ——
        own.set(10, 20, 110, 70);
        check("有效矩形·不受限：窗口为 null 时仍非空",
                CollectPolicy.effectiveVisibleRect(effective, own, null));
        check("有效矩形·不受限：结果与自身矩形逐字段一致", effective.sameAs(own));
        check("有效矩形·不受限：不算被祖先裁剪",
                !CollectPolicy.isClippedByAncestor(own, effective));

        // —— 窗口裁掉一部分：只保留交集，且**不是**自身矩形 ——
        window.set(0, 0, 60, 200);
        check("有效矩形·部分重叠：仍非空", CollectPolicy.effectiveVisibleRect(effective, own, window));
        eqInt("有效矩形·部分重叠：left 取自身（10 > 窗口的 0）", effective.left, 10);
        eqInt("有效矩形·部分重叠：right 取窗口（60 < 自身的 110）", effective.right, 60);
        check("有效矩形·部分重叠：判为被祖先裁剪",
                CollectPolicy.isClippedByAncestor(own, effective));
        check("有效矩形·部分重叠：还有面积，不算 clippedOut",
                !CollectPolicy.isClippedOut(own, effective));

        // —— 完全在窗口外：裁没。这就是那 29 行数字轮的处境 ——
        window.set(0, 0, 200, 10);
        check("有效矩形·完全在窗口外：结果为 EMPTY",
                !CollectPolicy.effectiveVisibleRect(effective, own, window));
        check("有效矩形·完全在窗口外：clippedOut=true（屏幕上没有它的任何像素）",
                CollectPolicy.isClippedOut(own, effective));
        check("有效矩形·完全在窗口外：clippedByAncestor 同时为真（它是被裁小的特例）",
                CollectPolicy.isClippedByAncestor(own, effective));

        // —— 零尺寸节点：不算裁剪结论，那是 zeroSize 的事 ——
        IntRect zero = new IntRect();
        zero.set(30, 40, 30, 40);
        check("有效矩形·零尺寸：结果为空",
                !CollectPolicy.effectiveVisibleRect(effective, zero, null));
        check("有效矩形·零尺寸：不报 clippedOut（否则报告里两个原因会互相打架）",
                !CollectPolicy.isClippedOut(zero, effective));
        check("有效矩形·零尺寸：不报 clippedByAncestor",
                !CollectPolicy.isClippedByAncestor(zero, effective));

        // —— 「空窗口」与「null 窗口」是两件事，不能混 ——
        window.set(0, 0, 0, 0);
        check("有效矩形·空窗口：受限于空窗口的节点判为无像素（≠ 不受限）",
                !CollectPolicy.effectiveVisibleRect(effective, own, window)
                        && CollectPolicy.isClippedOut(own, effective));

        // —— 窗口怎么往子节点传 ——
        IntRect parentLayout = new IntRect();
        parentLayout.set(0, 0, 360, 792);
        IntRect parentEffective = new IntRect();
        parentEffective.set(30, 400, 43, 428);
        check("裁剪链·裁剪容器：子节点窗口收紧成自己的有效矩形",
                CollectPolicy.clipWindowForChildren(true, parentEffective, parentLayout) == parentEffective);
        check("裁剪链·不裁剪容器：子节点原样继承窗口 —— 溢出父节点是合法布局（气泡 / 徽标 / 浮层），"
                        + "一律按父节点矩形裁剪会造出一批假阴性",
                CollectPolicy.clipWindowForChildren(false, parentEffective, parentLayout) == parentLayout);
        check("裁剪链·不裁剪且无窗口：子节点仍然不受限（null 不能被当成空窗口）",
                CollectPolicy.clipWindowForChildren(false, parentEffective, null) == null);
        check("裁剪链·容器自身也被裁过：子节点拿到的是收窄后的矩形（子节点不可能比容器露得更多）",
                CollectPolicy.clipWindowForChildren(true, parentEffective, parentLayout).sameAs(parentEffective));

        numberWheelScenario();
    }

    /** 实测场景重放：一列价格数字轮里 30 个候选行只有 1 行真绘制。 */
    private static void numberWheelScenario() {
        IntRect window = new IntRect();
        window.set(30, 400, 43, 428); // 28dp 高的裁剪窗口
        IntRect row = new IntRect();
        IntRect effective = new IntRect();

        int kept = 0;
        int clippedOut = 0;
        boolean alwaysFullRect = true;
        for (int i = 0; i < 30; i++) {
            int top = 400 + (i - 15) * 56; // 行距 56px，窗口正对第 15 行
            row.set(30, top, 43, top + 28);
            if (CollectPolicy.effectiveVisibleRect(effective, row, window)) {
                kept++;
            }
            if (CollectPolicy.isClippedOut(row, effective)) {
                clippedOut++;
            }
            // 平台口径下这 30 行**全部**是「完整可见」（rect 与 getGlobalVisibleRect 一致），
            // 这正是它们能混过门禁的原因：有效矩形只能由 SDK 自己沿祖先链算。
            alwaysFullRect &= row.width() == 13 && row.height() == 28;
        }
        eqInt("数字轮：30 个候选行里只有窗口内的 1 行被保留", kept, 1);
        eqInt("数字轮：其余 29 行全部判为 clippedOut", clippedOut, 29);
        check("数字轮：这些行的自身矩形始终是完整的 13×28（平台口径看不出异常）", alwaysFullRect);
    }

    /** PLAN「三.3 文本安全」：敏感输入正确脱敏。 */
    private static void sensitiveText() {
        check("脱敏：PasswordTransformationMethod 命中（RN secureTextEntry 走这条）",
                CollectPolicy.isSensitiveText(true, 0));
        check("脱敏：inputType 为标准密码",
                CollectPolicy.isSensitiveText(false, CollectPolicy.TYPE_TEXT_VARIATION_PASSWORD));
        check("脱敏：inputType 为可见密码（用户看得见，快照里仍不该留）",
                CollectPolicy.isSensitiveText(false, CollectPolicy.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD));
        check("脱敏：inputType 为 Web 密码",
                CollectPolicy.isSensitiveText(false, CollectPolicy.TYPE_TEXT_VARIATION_WEB_PASSWORD));

        // 只比 variation 段：其他 flag 位（多行、自动纠正…）不能把普通输入框变成敏感框，
        // 也不能把敏感框放过去。
        check("脱敏：只比较 variation 段，其他 flag 位不影响判定",
                CollectPolicy.isSensitiveText(
                        false,
                        CollectPolicy.TYPE_TEXT_VARIATION_PASSWORD | 0x00010000));

        // 反证：普通文本必须能通过。全判真等于把所有文案都抹掉 —— 比漏脱敏更难发现，
        // 因为验收画布上只会显示「没有文本」，看起来像设计稿本来就没写字。
        check("脱敏·反证：普通单行文本不被误判", !CollectPolicy.isSensitiveText(false, 0x00000001));
        check("脱敏·反证：普通多行文本不被误判", !CollectPolicy.isSensitiveText(false, 0x00020001));
        check("脱敏·反证：完全没有 inputType 的 TextView 不被误判",
                !CollectPolicy.isSensitiveText(false, 0));
    }

    /** 上限钳制：截断必须是显式状态，但首先得有个不会被撑爆的上限。 */
    private static void clamping() {
        eqInt("钳制·int：超过上限取上限", CollectPolicy.clamp(9999, 0, 128), 128);
        eqInt("钳制·int：低于下限取下限", CollectPolicy.clamp(-5, 0, 128), 0);
        eqInt("钳制·int：区间内原样返回", CollectPolicy.clamp(64, 0, 128), 64);
        eqLong("钳制·long：超过上限取上限", CollectPolicy.clamp(999999L, 100L, 2000L), 2000L);
        eqLong("钳制·long：低于下限取下限", CollectPolicy.clamp(1L, 100L, 2000L), 100L);

        // maxNodes 的下限是 1 而不是 0：0 个节点会让 Mac 侧把「什么都没采到」当成
        // 「页面真的是空的」，然后一路判到 pass。
        eqInt("钳制·int：节点数下限为 1（0 会被读成「页面是空的」）",
                CollectPolicy.clamp(0, 1, CollectOptions.ACCEPTANCE_MAX_NODES), 1);

        // 一个手滑的 maxNodes 不应该能把设备端拖死
        eqInt("钳制：验收档上限确实是 30000（再大也会被压回来）",
                CollectPolicy.clamp(1000000, 1, CollectOptions.ACCEPTANCE_MAX_NODES),
                CollectOptions.ACCEPTANCE_MAX_NODES);
    }

    /**
     * 档位名是**跨进程契约**：Java 侧写进 {@code snapshot.collection.profile}，
     * JS 侧与 Mac 侧按同一个字符串校验。改一个字不会编译报错，只会让上传在运行时被拒。
     */
    private static void crossProcessNaming() {
        eq("契约：验收档位名 = acceptance-full（改它会静默拒收上传）",
                CollectOptions.PROFILE_ACCEPTANCE_FULL, "acceptance-full");
        eq("契约：旧档位名 = legacy", CollectOptions.PROFILE_LEGACY, "legacy");
        eq("契约：录制档位名 = recording", CollectOptions.PROFILE_RECORDING, "recording");

        // 参与度字符串同样进 snapshot，Mac 侧按值分派
        eq("契约：参与度字符串", CollectPolicy.REQUIRED, "required");
        eq("契约：参与度字符串", CollectPolicy.CONTEXT, "context");
        eq("契约：参与度字符串", CollectPolicy.IGNORED, "ignored");
        eq("契约：参与度字符串", CollectPolicy.OPTIONAL, "optional");
        eq("契约：参与度字符串", CollectPolicy.UNAVAILABLE, "unavailable");
    }

    /**
     * 样式取值（背景 / 边框 / 圆角 / 字体，2026-09-22）。
     *
     * <p>这一组是全套断言里**唯一一类「错了看不出来」**的：颜色少写一位在面板上照样是
     * 那个色系，字号差一个 fontScale 只会在「系统字体被调大过」的手机上偏，圆角百分比
     * 折算错更只是个小数字。它们都不会抛异常、不会报错，只会让验收结论静默走偏 ——
     * 而它们又都只是纯算术，纯 JVM 几毫秒就能钉死。
     */
    private static void styleFormatting() {
        // —— 颜色：ARGB → #rrggbb / #aarrggbb ——
        eq("颜色·不透明：写成 6 位 hex", CollectPolicy.formatColor(0xFFE8542E), "#e8542e");
        eq("颜色·带 alpha：写成 8 位 aarrggbb（与 Figma 的 8 位 hex 同一口径）",
                CollectPolicy.formatColor(0x80E8542E), "#80e8542e");
        eq("颜色·完全透明：不给颜色 —— RN 里「设成 transparent」与「没设」在屏幕上没区别，"
                        + "报一行 #00000000 只会让人以为这里有背景",
                CollectPolicy.formatColor(0x00E8542E), null);
        eq("颜色·没设：null 原样透传，不能兜底成黑色",
                CollectPolicy.formatColor((Integer) null), null);
        eq("颜色·纯黑是有效值，不能被当成「没设」",
                CollectPolicy.formatColor(0xFF000000), "#000000");
        eq("颜色·分量必须补满两位（少补一位会解析成完全不同的颜色）",
                CollectPolicy.formatColor(0xFF0A0B0C), "#0a0b0c");
        eq("颜色·低 alpha 也要写满两位", CollectPolicy.formatColor(0x05000000), "#05000000");

        // —— px → dp（字号 / 行高 / 字距都靠它）——
        eq("字号·fontScale = 1：3 倍密度下 42px 就是 14dp",
                CollectPolicy.logicalFromPx(42f, 3f), 14d);
        // RN 用 toPixelFromSP 放大：14dp × 3 × 1.3 = 54.6px。回算必须得到 14 ——
        // 直接上报 54.6 的话，验收同学会看到「App 字号 54.6」，而设计稿写的是 14。
        eq("字号·fontScale = 1.3：同一段文本的 px 变了，回算出的 dp 必须不变",
                CollectPolicy.logicalFromPx(54.6f, 3.9f), 14d);
        eq("字号·除数为 0：返回 0，而不是 Infinity / NaN（NaN 会被 JSON 静默写成 0，"
                        + "等于把「算不出来」伪装成「就是 0」）",
                CollectPolicy.logicalFromPx(42f, 0f), 0d);
        eq("字号·入参是 NaN：返回 0", CollectPolicy.logicalFromPx(Float.NaN, 3f), 0d);
        eq("字号·保留两位：浮点噪声不进面板（验收同学看到 13.888889 只会怀疑工具坏了）",
                CollectPolicy.logicalFromPx(41.6667f, 3f), 13.89d);

        // —— 圆角 ——
        eq("圆角·绝对值就是 dp（RN 的 POINT 本来就是 dp，不要再除一次密度）",
                CollectPolicy.radiusInDp(false, 8f, 100, 100), 8d);
        eq("圆角·百分比按短边折算（80×60 的盒子上 50% = 30）",
                CollectPolicy.radiusInDp(true, 50f, 80, 60), 30d);
        eq("圆角·零尺寸节点上不炸、也不返回负数",
                CollectPolicy.radiusInDp(true, 50f, 0, 0), 0d);
        eq("圆角·绝对值也要收敛浮点噪声", CollectPolicy.radiusInDp(false, 7.9999f, 10, 10), 8d);

        // —— 圆角·自绘视图旁路：值来自第三方库的私有字段（px），见 radiusFromRoundRectPx ——
        // 这一档存在的理由：有的库自己用 Canvas 画圆角，值不在 RN 的 drawable 里，
        // 只能从私有字段反射读（8 元素、px）。下标与 ViewStyleReader.CORNER_ORDER 的对应关系
        // 在那边（需要 android.view.View，纯 JVM 测不了）；这里只锁「换算」这一半。
        float[] selfDrawn = {84f, 84f, 84f, 84f, 84f, 84f, 84f, 84f};
        eq("圆角·自绘视图：字段是 px，3 倍密度下 84px 回算成 28dp"
                        + "（漏了除密度，3 倍机上 12dp 的圆角会显示成 36）",
                CollectPolicy.radiusFromRoundRectPx(selfDrawn, 0, 3f), 28d);
        eq("圆角·自绘视图：只取偶数下标（addRoundRect 口径每角 X/Y 各一份）——"
                        + "第 2 个角是下标 2 而不是 1，取错会把 X/Y 当成相邻角",
                CollectPolicy.radiusFromRoundRectPx(
                        new float[]{0f, 0f, 60f, 60f, 0f, 0f, 0f, 0f}, 2, 3f), 20d);
        eq("圆角·自绘视图：库的字段默认就是全 0（= 没设圆角），要报 null 而不是 0 ——"
                        + "面板对「没读到」和「读了且确定没有」画法不同",
                CollectPolicy.radiusFromRoundRectPx(
                        new float[]{0f, 0f, 0f, 0f, 0f, 0f, 0f, 0f}, 0, 3f), null);
        eq("圆角·自绘视图：负数按没读到处理（不能让负半径流进面板）",
                CollectPolicy.radiusFromRoundRectPx(
                        new float[]{-3f, -3f, 0f, 0f, 0f, 0f, 0f, 0f}, 0, 3f), null);
        eq("圆角·自绘视图：数组比预期短也不能越界崩（库换口径时宁可少一行圆角）",
                CollectPolicy.radiusFromRoundRectPx(new float[]{12f, 12f}, 2, 3f), null);
        eq("圆角·自绘视图：反射没取到字段（null）时安全返回，不能抛",
                CollectPolicy.radiusFromRoundRectPx(null, 0, 3f), null);
        eq("圆角·自绘视图：密度为 0 时返回 0 而不是 Infinity"
                        + "（Json 会把 NaN 静默写成 0，等于把「算不出来」伪装成「就是 0」）",
                CollectPolicy.radiusFromRoundRectPx(selfDrawn, 0, 0f), 0d);

        // —— 字重 ——
        eqInt("字重·RN 给了数值就信它（600 不能被压成 700，否则设计稿上的 Semibold 对不上）",
                CollectPolicy.fontWeightOf(600, false), 600);
        eqInt("字重·RN 把 'bold' 解析成 700，原样带出", CollectPolicy.fontWeightOf(700, true), 700);
        eqInt("字重·RN 没给数值（-1）但 typeface 是粗体 → 700",
                CollectPolicy.fontWeightOf(-1, true), 700);
        eqInt("字重·RN 没给数值且 typeface 不粗 → 400",
                CollectPolicy.fontWeightOf(-1, false), 400);
        eqInt("字重·越界值也不能漏出 100–900 之外（面板上「字重 0」比没有更糟）",
                CollectPolicy.fontWeightOf(0, false), 400);
        eqInt("字重·越界值（大于 900）同样兜底", CollectPolicy.fontWeightOf(1000, true), 700);
    }

    private static void report() {
        if (!failures.isEmpty()) {
            System.out.println("SOME FAILED  passed=" + passed + " failed=" + failures.size());
            for (String failure : failures) {
                System.out.println("  x " + failure);
            }
            System.exit(1);
        }
        System.out.println("ALL PASS  passed=" + passed);
    }
}
