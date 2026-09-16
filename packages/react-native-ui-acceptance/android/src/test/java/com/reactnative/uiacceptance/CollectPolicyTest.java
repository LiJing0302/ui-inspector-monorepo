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
        sensitiveText();
        clamping();
        crossProcessNaming();
        report();
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
        eq("参与度·未附着 → unavailable（不能拿去判缺失）",
                CollectPolicy.participationOf(false, true, false, true), CollectPolicy.UNAVAILABLE);
        eq("参与度·隐藏 → optional（只保留结构，不做视觉判定）",
                CollectPolicy.participationOf(true, false, false, true), CollectPolicy.OPTIONAL);
        eq("参与度·零尺寸且无像素 → ignored（透明占位，不是缺失）",
                CollectPolicy.participationOf(true, true, true, false), CollectPolicy.IGNORED);
        eq("参与度·透明容器 → context（App 明明画了，只是没有像素；报 missing 是假阴性）",
                CollectPolicy.participationOf(true, true, false, false), CollectPolicy.CONTEXT);
        eq("参与度·有像素 → required（唯一允许被判缺失的档）",
                CollectPolicy.participationOf(true, true, false, true), CollectPolicy.REQUIRED);

        // 边界：零尺寸**但有**像素 → 不降级。尺寸为 0 却要画东西本身就是异常，该被看见，
        // 而不是被静默归进「透明占位」。
        eq("参与度·零尺寸但有像素 → required（不静默降级成 ignored）",
                CollectPolicy.participationOf(true, true, true, true), CollectPolicy.REQUIRED);

        // 优先级：未附着 > 隐藏 > 零尺寸 > 纯布局。顺序错了会出现
        // 「一个也没附着、还隐藏着的容器」被报成 required，然后被判缺失。
        eq("参与度·优先序：未附着且隐藏 → unavailable（不是 optional）",
                CollectPolicy.participationOf(false, false, true, false), CollectPolicy.UNAVAILABLE);
        eq("参与度·优先序：隐藏且零尺寸 → optional（不是 ignored）",
                CollectPolicy.participationOf(true, false, true, false), CollectPolicy.OPTIONAL);

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
