package com.reactnative.uiacceptance;

/**
 * {@link NodeCollector} 里**与 Android 无关**的那部分判定。
 *
 * <p>单独拆出来的唯一目的是**可测**：NodeCollector 自身要读 {@code View} 的属性，编译它需要
 * android.jar + react-android，跑它需要一台设备；而这里全是纯函数，javac + java 就能验证
 * （见 {@code scripts/test-collect-policy.sh}）。
 *
 * <p>值得拆的标准不是「难不难」，而是「错了有多贵」：验收流程里最容易出错、也最贵的三件事
 * —— 这个节点算不算缺失、这个输入框要不要脱敏、这个节点该不该连同子树一起剪掉 —— 都在这里。
 */
public final class CollectPolicy {

    // android.text.InputType 的常量值。刻意**复制字面量而不是 import**：
    // import 会让这个类依赖 android.jar，那就跑不了纯 JVM 测试了。这几个数字是 AOSP 的
    // 稳定 ABI，不会变；真正的取值仍在 NodeCollector 里从 View 读。
    public static final int TYPE_MASK_VARIATION = 0x00000ff0;
    public static final int TYPE_TEXT_VARIATION_PASSWORD = 0x00000080;
    public static final int TYPE_TEXT_VARIATION_VISIBLE_PASSWORD = 0x00000090;
    public static final int TYPE_TEXT_VARIATION_WEB_PASSWORD = 0x000000e0;

    // 节点参与度。Mac 侧据此决定「能不能判它缺失」，字符串值进 snapshot，不能随便改。
    public static final String UNAVAILABLE = "unavailable";
    public static final String OPTIONAL = "optional";
    public static final String IGNORED = "ignored";
    public static final String CONTEXT = "context";
    public static final String REQUIRED = "required";

    private CollectPolicy() {
    }

    /**
     * 该节点**自身**是否应被 includeInvisible / includeZeroSize 过滤掉。
     *
     * <p>只判自身。被过滤之后子树要不要继续走是另一个决策，由
     * {@code CollectOptions.descendIntoSkipped} 决定 —— 两者混在一起曾经导致
     * 「零尺寸父节点外溢的可见子节点被整片丢掉」。
     */
    public static boolean skipSelf(
            boolean includeInvisible,
            boolean includeZeroSize,
            boolean visible,
            int width,
            int height
    ) {
        boolean hiddenFiltered = !includeInvisible && !visible;
        boolean zeroSizeFiltered = !includeZeroSize && (width <= 0 || height <= 0);
        return hiddenFiltered || zeroSizeFiltered;
    }

    /**
     * 密码 / 明确可见的密码 / Web 密码输入框：文本一律不入快照，只留一个「有内容」的标记。
     *
     * <p>{@code passwordTransformation} 与 {@code inputType} 两个来源都要看：RN 的
     * {@code secureTextEntry} 走的是前者，原生 {@code inputType} 走的是后者，只看一个会漏。
     */
    public static boolean isSensitiveText(boolean passwordTransformation, int inputType) {
        if (passwordTransformation) {
            return true;
        }
        int variation = inputType & TYPE_MASK_VARIATION;
        return variation == TYPE_TEXT_VARIATION_PASSWORD
                || variation == TYPE_TEXT_VARIATION_WEB_PASSWORD
                || variation == TYPE_TEXT_VARIATION_VISIBLE_PASSWORD;
    }

    /**
     * 节点在验收流程里的参与度。
     *
     * <p>这一项直接决定 Mac 侧「能不能判它缺失」，而 {@code required} 是唯一允许被判缺失的档：
     * 把透明容器报成 missing 是典型假阴性 —— App 明明画了，只是它没有像素。
     *
     * <p>顺序是有意的：{@code 未附着 > 隐藏 > 零尺寸且无像素 > 纯布局 > 必需}。
     * 注意「零尺寸**但有**像素」会落到 {@code required}：尺寸为 0 却要画东西，本身就是
     * 该被看见的异常，不该被静默降级。
     */
    public static String participationOf(
            boolean attached,
            boolean visible,
            boolean zeroSize,
            boolean hasVisualContent
    ) {
        if (!attached) {
            return UNAVAILABLE;
        }
        if (!visible) {
            return OPTIONAL;
        }
        boolean layoutOnly = !hasVisualContent;
        if (zeroSize && layoutOnly) {
            return IGNORED;
        }
        if (layoutOnly) {
            return CONTEXT;
        }
        return REQUIRED;
    }

    public static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }

    public static long clamp(long value, long min, long max) {
        return Math.max(min, Math.min(value, max));
    }
}
