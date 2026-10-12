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
     * <p>第 4 个参数是**已经算好的** {@code layoutOnly}（= 无绘制 **且** 无分支，判据在
     * {@link NodeCollector#isPassThrough}），不再是 {@code hasVisualContent}。
     * 这里刻意不自己从 {@code hasVisualContent} 反推：那需要知道子节点数，而那是
     * {@code View} 的属性 —— 一旦在这个纯函数里猜，就又回到「透明容器一律算布局」
     * 的老毛病上（实测 App 侧会多划走 120 个真正承载结构的容器）。
     *
     * <p>顺序是有意的：{@code 未附着 > 隐藏 > 零尺寸且是布局 > 纯布局 > 必需}。
     * 注意「零尺寸**但不是**布局」会落到 {@code required}：尺寸为 0 却要画东西、或者还要
     * 往外分发内容，本身就是该被看见的异常，不该被静默降级。
     */
    public static String participationOf(
            boolean attached,
            boolean visible,
            boolean zeroSize,
            boolean layoutOnly
    ) {
        if (!attached) {
            return UNAVAILABLE;
        }
        if (!visible) {
            return OPTIONAL;
        }
        if (zeroSize && layoutOnly) {
            return IGNORED;
        }
        if (layoutOnly) {
            return CONTEXT;
        }
        return REQUIRED;
    }

    /**
     * Computes the state that must be passed to a child during tree collection.
     *
     * <p>Android exposes alpha and visibility on each View independently. A hidden parent can
     * therefore have a child whose own {@code visible} flag is still true. The child is hidden
     * from the page whenever either an ancestor was already hidden or the current View itself is
     * hidden.
     */
    public static boolean childHiddenByAncestor(boolean ancestorHidden, boolean currentVisible) {
        return ancestorHidden || !currentVisible;
    }

    // ───────────────────────── 有效可见矩形（裁剪链） ─────────────────────────
    //
    // 背景（2026-09-20 实测，价格数字轮）：平台的 getGlobalVisibleRect() 对**绘制期裁剪**无感。
    // RN 的 overflow:hidden 是在 ViewGroup.draw() 里 clipRect 出来的，没有走 clipChildren、
    // 也没有改 scroll，所以 ViewGroup.getChildVisibleRect() 那套完全看不见它。结果是一个
    // 13×28 的 TextView 在 30 行候选里只有 1 行真绘制，其余 29 行照样报「完整可见」——
    // **子节点比它自己的裁剪窗口更可见，几何上不可能**。
    //
    // 于是这里自己沿祖先链算一遍：窗口从 decorView 矩形出发，谁 overflow 裁剪谁就把窗口收紧成
    // 自己的**有效**矩形（而不是自己的布局矩形 —— 它自己也可能已经被更上层裁过）。三个函数都是
    // 纯几何、纯函数，可在纯 JVM 里断言（见 CollectPolicyTest#effectiveVisibleRect）。

    /**
     * 有效可见矩形 = **自身布局矩形 ∩ 继承来的裁剪窗口**。
     *
     * <p>它是「这块区域还会不会被画出来」的几何答案，也是本次改动的核心产物。刻意**不**在这里
     * 叠加 {@code visible / hiddenByAncestor / alpha}：那些是「元素自身是否可见」的语义，已经由
     * {@link #participationOf} 那条链负责。两者混在一起会让「被祖先裁掉」与「自己被隐藏」变成
     * 同一个字段，而它们在报告里要给出完全不同的结论（前者是采集噪音，后者是页面状态）。
     *
     * @param out             结果写进这个对象（允许与 {@code own} 同一个实例）
     * @param own             自身布局矩形（窗口坐标系，已减窗口原点）
     * @param inheritedWindow 祖先裁剪链给出的窗口；{@code null} 表示不受限
     * @return 结果是否非空
     */
    public static boolean effectiveVisibleRect(IntRect out, IntRect own, IntRect inheritedWindow) {
        out.copyFrom(own);
        if (inheritedWindow != null) {
            out.left = Math.max(out.left, inheritedWindow.left);
            out.top = Math.max(out.top, inheritedWindow.top);
            out.right = Math.min(out.right, inheritedWindow.right);
            out.bottom = Math.min(out.bottom, inheritedWindow.bottom);
        }
        return !out.isEmpty();
    }

    /**
     * 传给**子节点**的裁剪窗口。
     *
     * <p>自身裁剪时收紧成自己的有效矩形；不裁剪时原样继承 —— 子节点合法地溢出父节点是真实存在
     * 的布局（气泡、徽标、绝对定位的浮层、动画起始态），一旦一律按父节点矩形裁剪，那些元素会
     * 整批变成「屏幕上没有像素」的假阴性。
     *
     * <p>⚠️ 判据必须与 JS 侧 {@code getUiAcceptanceVisibleRect}（overlay / 点选用它）保持一致：
     * 两处都只看 {@code clipsToBounds}。同一份快照在两个进程里算出不同答案，症状只会是
     * 「画布上框了一个、点选又选不到」，比直接报错难查得多。
     *
     * @return 子节点的窗口（可能是 {@code inheritedWindow} 本身，也可能是 {@code ownEffective}）
     */
    public static IntRect clipWindowForChildren(
            boolean clipsToBounds,
            IntRect ownEffective,
            IntRect inheritedWindow
    ) {
        return clipsToBounds ? ownEffective : inheritedWindow;
    }

    /**
     * 有效矩形比自身矩形小（含被裁没）：这个节点「有一部分像素被祖先剪掉了」。
     *
     * <p>与平台字段 {@code clipped} 不是一回事：{@code clipped} 只反映
     * {@code getGlobalVisibleRect} 与自身矩形的差，对绘制期裁剪恒为 false。
     *
     * <p>自身没有面积时返回 false —— 零尺寸是 {@code zeroSize} 的事，不该混进裁剪结论。
     */
    public static boolean isClippedByAncestor(IntRect own, IntRect effective) {
        if (own.isEmpty()) {
            return false;
        }
        return effective.left > own.left
                || effective.top > own.top
                || effective.right < own.right
                || effective.bottom < own.bottom;
    }

    /**
     * 自身有面积、有效矩形却没有面积：屏幕上没有它的**任何**像素。
     *
     * <p>这就是那 29 行数字轮候选行的判据，也是门禁该剔除的那一类。
     */
    public static boolean isClippedOut(IntRect own, IntRect effective) {
        return !own.isEmpty() && effective.isEmpty();
    }

    /**
     * 判定「子节点刚好铺满父节点」的容差（px）。
     *
     * <p>2px 是取整误差的量级：RN 的布局按 dp 算完再取整成 px，父子之间差 1px 很常见；
     * 而真正的内边距最小也有 2px 以上。放大到 4px 会把「padding 2 的容器」也算成透传，
     * 而那些容器在验收里是有意义的盒子。
     */
    public static final int PASS_THROUGH_TOLERANCE = 2;

    /**
     * 「透传包装」：自身不绘制像素，且**恰好装着一个占满自身的有效子节点**。
     *
     * <p>它在屏幕上完全不存在（像素全部来自那个子节点），只是框架塞在中间的壳：RN 的
     * {@code SafeAreaProvider} / {@code ScreenStack} / {@code ScreenContentWrapper} 等
     * 约 20 层都是这一类。验收里它们既不该被匹配、也不该被判缺失 —— 判据就是这一步。
     *
     * <p>为什么自绘就不算透传：一个 360×792 的透明壳和一张同样大小的卡片底色，对匹配的价值
     * 完全不同 —— 前者是通道，后者是一个元素。只看「有没有子节点」会把两者混为一谈。
     *
     * <p>⚠️ 判据必须与 Mac 侧 {@code core.canonicalize} 的 filler 定义逐字一致
     * （容差同为 2px、同样忽略隐藏与零尺寸子节点），否则同一次采集在两侧会得出不同的
     * 「有意义元素」集合，而那种分叉只会在匹配率上体现出来，很难查。
     *
     * @param visible              自身可见（隐藏节点不参与，它不是通道而是没画）
     * @param hasVisualContent     自身能画出像素
     * @param effectiveChildCount  有效子节点个数（可见且非零尺寸）
     * @param deltaLeft            唯一有效子节点相对自身的 left 偏移
     * @param deltaTop             唯一有效子节点相对自身的 top 偏移
     * @param deltaWidth           唯一有效子节点与自身的宽度差
     * @param deltaHeight          唯一有效子节点与自身的高度差
     */
    public static boolean isPassThrough(
            boolean visible,
            boolean hasVisualContent,
            int effectiveChildCount,
            int deltaLeft,
            int deltaTop,
            int deltaWidth,
            int deltaHeight
    ) {
        if (!visible || hasVisualContent) {
            return false;
        }
        // 有效子节点不是恰好 1 个（0 个 = 空容器、≥2 个 = 在分发内容）都不是通道
        if (effectiveChildCount != 1) {
            return false;
        }
        return Math.abs(deltaLeft) <= PASS_THROUGH_TOLERANCE
                && Math.abs(deltaTop) <= PASS_THROUGH_TOLERANCE
                && Math.abs(deltaWidth) <= PASS_THROUGH_TOLERANCE
                && Math.abs(deltaHeight) <= PASS_THROUGH_TOLERANCE;
    }

    /**
     * 「纯布局」：验收里不该被当成独立元素，也不该被判缺失的中间层。
     *
     * <p>= 自身不绘制 **且**（透传 **或** 没有任何有效子节点）。
     *
     * <p>⚠️ 这里**不能**写成 {@code !hasVisualContent}。那个等式把「有分支的透明容器」
     * 也划成了布局：{@code ReactScrollView}（360×774、一个占满自身的滚动内容不算）、
     * {@code ScreenContentStack} 这类承载页面结构的容器全被划走 —— 实测 App 侧会多划走
     * 120 个真正有结构的节点，Mac 侧于是既不匹配它们、也不认为它们该有结论。
     * 一个透明容器是否有意义，取决于**它分不分发内容**，不取决于它画不画像素。
     */
    public static boolean isLayoutOnly(
            boolean hasVisualContent,
            boolean passThrough,
            int effectiveChildCount
    ) {
        if (hasVisualContent) {
            return false;
        }
        return passThrough || effectiveChildCount == 0;
    }

    // ─────────────────── 样式取值（背景 / 边框 / 圆角 / 字体） ───────────────────
    //
    // 2026-09-22 新增。拆出来的理由与上面那几条一样：错了很贵，而且**错了不容易看出来**。
    // 一个 #ffe5e5e5 少写一位在面板上照样是浅灰，只有和设计稿并排看才发现对不上；
    // 字号少乘一个 fontScale 也只会在「系统字体被调大过」的机器上偏，本地永远复现不了。
    // 这几行全是纯函数，javac + java 就能钉住（见 CollectPolicyTest#styleFormatting）。

    private static final char[] HEX_DIGITS = "0123456789abcdef".toCharArray();

    /** RN 没给出数值字重时的兜底（{@code CustomStyleSpan.getWeight()} 返回 -1 就是这种情况）。 */
    public static final int DEFAULT_FONT_WEIGHT = 400;
    /** typeface 报了粗体、但 RN 没给出数值时的兜底。 */
    public static final int BOLD_FONT_WEIGHT = 700;

    /**
     * ARGB 整数 → {@code #rrggbb}（不透明）或 {@code #aarrggbb}（带 alpha）。与 Mac 侧
     * {@code Swatch} 认的格式一致：8 位即带 alpha，CSS 直接支持。
     *
     * <p>完全透明（alpha = 0）返回 {@code null}：RN 里「颜色设成 transparent」与「根本没设颜色」
     * 在屏幕上没有区别，面板上多给一行 {@code #00000000} 只会让人以为这里有背景。
     *
     * <p>{@code null} 入参原样返回 —— {@code BackgroundStyleApplicator} 的 getter 用 null 表示
     * 「没设」，那不是黑色，不能兜底成 {@code #000000}。
     */
    public static String formatColor(Integer argb) {
        if (argb == null) {
            return null;
        }
        int value = argb;
        int alpha = (value >>> 24) & 0xFF;
        if (alpha == 0) {
            return null;
        }
        char[] out = new char[alpha == 0xFF ? 7 : 9];
        out[0] = '#';
        int at = 1;
        if (alpha != 0xFF) {
            out[at++] = HEX_DIGITS[(alpha >> 4) & 0xF];
            out[at++] = HEX_DIGITS[alpha & 0xF];
        }
        for (int shift = 20; shift >= 0; shift -= 4) {
            out[at++] = HEX_DIGITS[(value >> shift) & 0xF];
        }
        return new String(out);
    }

    /**
     * 文字颜色的取值优先级：**span 上的色优先于 {@code TextView} 自身的色**。
     *
     * <p>为什么：RN 里 {@code <Text style={{color}}>} 是把 {@code ForegroundColorSpan} 挂在
     * 文本上，**不碰 {@code TextView.setTextColor}**。所以 {@code getCurrentTextColor()} 读到的
     * 往往是系统默认色 ——实测 vivo V2454A 上一整页 257 个文本节点全报同一个
     * {@code #8a000000}（默认 54% 黑），而同一张截图里的笔画实际有 {@code #111111} /
     * {@code #f54238} / {@code #249a3a} 等十几种（2026-10-07）。
     *
     * <p>为什么取第一个而不是「最后一个覆盖」：一段文本里多个 span 各带颜色时，我们只报首个。
     * 它与 {@code TextView} 自身的色同为「这个节点大致是什么色」这个级别的结论，
     * 不该假装知道得更细 —— 要逐段颜色得另开一个字段，那是另一个结论。
     *
     * <p>{@code spanColor} 传 {@code null} 表示这段文本上没有颜色 span（走 {@code setTextColor}）。
     */
    public static Integer pickTextColor(Integer spanColor, Integer viewColor) {
        return spanColor != null ? spanColor : viewColor;
    }

    /**
     * px → 逻辑值（dp），保留两位小数。
     *
     * <p>传 {@code scaledDensity}（= density × fontScale）进来得到的就是「sp 的逻辑值」：
     * RN 的 fontSize / lineHeight / letterSpacing 都经过 {@code PixelUtil.toPixelFromSP} 放大过，
     * 直接显示 {@code getTextSize()} 会把系统字体缩放一起算进字号里 —— 同一份设计稿在两台
     * 字体设置不同的手机上会显示出两个字号，而验收同学看到的就是「App 字号写错了」。
     *
     * <p>密度非正 / 入参非有限时返回 0：宁可给出一个明显的 0，也不要让 NaN 一路流到 JSON
     * （{@code Json} 会把 NaN 静默写成 0，等于把「算不出来」伪装成「就是 0」）。
     */
    public static double logicalFromPx(float px, float density) {
        if (!(density > 0f) || Float.isNaN(px) || Float.isInfinite(px)) {
            return 0d;
        }
        return round2(px / density);
    }

    /**
     * 圆角半径（dp）。
     *
     * <p>RN 的 {@code borderRadius} 既可以是数字（dp）也可以是百分比。百分比在 RN 内部按**每个轴
     * 的边长**分别解析（非正方形上解析出来是个椭圆弧），而快照里只放得下一个数 —— 这里按短边
     * 折算成一个代表值。它是**给人看的近似**，不参与绘制：面板只回答「圆角多大」。
     */
    public static double radiusInDp(boolean percent, float value, int width, int height) {
        if (!percent) {
            return round2(value);
        }
        int base = Math.max(0, Math.min(width, height));
        return round2(value / 100d * base);
    }

    /**
     * 圆角半径（dp）—— 值来自**自绘视图**的私有字段时走这里（调用方见 {@code ViewStyleReader}）。
     *
     * <p>与 {@link #radiusInDp} 的唯一区别：**入参是 px，必须先除密度**。第三方自绘库在 setter 里
     * 做过 {@code PixelUtil.toPixelFromDIP}（那是给 {@code Canvas.drawPath} 用的），字段里存的是像素；
     * 而面板要回答的是「开发写的是多少 dp」。忘了这一步的症状很好认：3 倍密度机上 12dp 的圆角
     * 会显示成 36 —— 比没有值更容易让人相信工具坏了。
     *
     * <p>值为 0 时返回 {@code null} 而不是 0：自绘库的字段默认就是全 0（= 这个视图没有圆角），
     * 而快照里 {@code null} 与 {@code 0} 是两件事 —— 前者「没读到」（面板整行不画）、
     * 后者「读了且确定没有」（面板画 {@code —}）。负数与 NaN 一并按「没读到」处理。
     *
     * @param pxRadii   自绘库的 8 元素数组，{@code Path.addRoundRect} 口径（每角 X/Y 各一份）
     * @param evenIndex 该角在数组里的下标，**必须是偶数**（0/2/4/6 = 左上/右上/右下/左下）
     * @param density   {@code DisplayMetrics.density}，与库 setter 用的是同一个值才会精确还原
     */
    public static Double radiusFromRoundRectPx(float[] pxRadii, int evenIndex, float density) {
        if (pxRadii == null || evenIndex < 0 || evenIndex >= pxRadii.length) {
            return null;
        }
        float px = pxRadii[evenIndex];
        if (!(px > 0f)) {
            return null;
        }
        return logicalFromPx(px, density);
    }

    /**
     * 字重的最终数值（100–900）。
     *
     * <p>优先信 RN 自己解析出来的数值：{@code CustomStyleSpan.getWeight()} 把 {@code 'bold'} 解析成
     * 700、{@code 'normal'} 成 400、{@code '600'} 成 600；**没给值时返回 -1**，那时只能从 typeface
     * 的粗体位反推。这一档会把 500/600 一律显示成 400 或 700 —— 但那已经是 View 上仅剩的线索，
     * 而且这一档本来就是少数（RN 的 {@code <Text>} 默认不带 fontWeight）。
     */
    public static int fontWeightOf(int rnWeight, boolean bold) {
        if (rnWeight >= 100 && rnWeight <= 900) {
            return rnWeight;
        }
        return bold ? BOLD_FONT_WEIGHT : DEFAULT_FONT_WEIGHT;
    }

    /**
     * 保留两位小数。
     *
     * <p>样式值全部走它：RN 的 `pxToDp` 会给出 `1.0000001` 这种浮点噪声，直接进面板比没有值
     * 更糟 —— 验收同学看到「边框 1.0000001」只会怀疑工具坏了。
     */
    public static double round2(double value) {
        return Math.round(value * 100d) / 100d;
    }

    public static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }
    public static long clamp(long value, long min, long max) {
        return Math.max(min, Math.min(value, max));
    }
}
