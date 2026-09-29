package com.reactnative.uiacceptance;

import android.graphics.Typeface;
import android.text.Spanned;
import android.view.View;
import android.widget.TextView;

import androidx.annotation.NonNull;

import com.facebook.react.uimanager.BackgroundStyleApplicator;
import com.facebook.react.uimanager.LengthPercentage;
import com.facebook.react.uimanager.LengthPercentageType;
import com.facebook.react.uimanager.PixelUtil;
import com.facebook.react.uimanager.style.BorderRadiusProp;
import com.facebook.react.uimanager.style.BorderStyle;
import com.facebook.react.uimanager.style.LogicalEdge;
import com.facebook.react.views.text.internal.span.CustomLineHeightSpan;
import com.facebook.react.views.text.internal.span.CustomStyleSpan;

import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 从一个 Android {@code View} 上把**样式**读出来（背景 / 边框 / 圆角 / 圆角 / 字体）。
 *
 * <p>为什么值得单独一个文件：{@code NodeCollector} 已经 600+ 行，而这段代码与它的其余部分
 * 有一个根本区别 —— 它读的全是**别的库的内部状态**（RN 的 drawable 与 span），因此
 * 「哪天 RN 改了什么」的答案永远在这个文件里。放在一个文件里，未来那一次升级失败只会有
 * 一处编译错误，而不是散落在采集逻辑中间的一堆。
 *
 * <h3>取值的来源</h3>
 * <ol>
 *   <li><b>背景 / 边框 / 圆角</b>：{@code BackgroundStyleApplicator} 的官方 getter，
 *       值原本就在 View 上，零猜测。注意 RN 0.81 里 {@code getBorderWidth} 返回的是 **dp**
 *       （内部做过 {@code pxToDp}），{@code getBorderRadius} 的 POINT 也是 dp ——
 *       与快照里的几何字段（px）口径不同。⚠️ 但**圆角的 getter 与 setter 并不对称**：
 *       它是按 key 精确取的，平铺 {@code borderRadius} 落在另一个字段里读不到，
 *       必须自己走一遍回退链（{@link #CORNER_CHAINS_LTR} 有完整说明与实测代价）。</li>
 *   <li><b>自绘视图的圆角</b>：库自己用 Canvas 画的圆角从头到尾不在 drawable 里，只能反射读它的
 *       私有字段 —— 见 {@link #RADIUS_FIELD_BY_CLASS}。这是上一条通道的**兜底**，不是替代：
 *       官方通道只要读到一个角，就不再问旁路。</li>
 *   <li><b>字号 / 文字颜色 / 字距</b>：{@code TextView} 的公开 API。</li>
 *   <li><b>字体族 / 字重 / 行高</b>：只能从 RN 挂在 Spannable 上的 span 里读
 *       （见 {@link #readTextStyle}）。</li>
 * </ol>
 *
 * <h3>为什么不都用 TextView 的公开 API</h3>
 * <p>{@code TextView.getTypeface()} 返回的是**解析后**的 Typeface：它不携带 fontFamily 的名字，
 * 字重也被压成粗/不粗两位。而验收要对照的是设计稿上写的「PingFang SC / Semibold / 行高 20」，
 * 粗/不粗两位答不了。RN 把原始值放在 span 里，这就是必须读 span 的唯一理由。
 *
 * <h3>⚠️ 唯一一处「依赖内部类」的取舍</h3>
 * <p>那两个 span 在 {@code com.facebook.react.views.text.internal.span} 包里，RN 明确标了
 * {@code internal}，跨版本可能改名或搬家。这里选择**直接 import 而不是反射**：改名会让库
 * 编不过，而「编不过」发生在升级 RN 的那一刻、带着明确的类名，比运行期静默读到 null 好查得多。
 * 真到了那一天，要改的也只有这一个文件。
 */
public final class ViewStyleReader {

    /**
     * 四边的读取顺序，与 {@link NativeNode#EDGE_TOP} / {@code EDGE_RIGHT} 等序号严格一致。
     *
     * <p>用 LEFT/RIGHT/TOP/BOTTOM 这四个**物理**边而不是 START/END：RN 的 START/END 是
     * 解析成物理边之后才存进 drawable 的，而快照里的几何已经落在物理坐标上 —— 在 RTL 的
     * 页面上用 START 取值会得到「逻辑正确、画面对不上」的边框。物理边与画面永远一致。
     */
    private static final LogicalEdge[] EDGE_ORDER = {
            LogicalEdge.TOP, LogicalEdge.RIGHT, LogicalEdge.BOTTOM, LogicalEdge.LEFT
    };

    /** 四角的读取顺序：左上 / 右上 / 右下 / 左下。 */
    private static final BorderRadiusProp[] CORNER_ORDER = {
            BorderRadiusProp.BORDER_TOP_LEFT_RADIUS,
            BorderRadiusProp.BORDER_TOP_RIGHT_RADIUS,
            BorderRadiusProp.BORDER_BOTTOM_RIGHT_RADIUS,
            BorderRadiusProp.BORDER_BOTTOM_LEFT_RADIUS,
    };

    /** 小于这个宽度就当没边框（RN 的 dp 换算会留下 1e-7 量级的噪声）。 */
    private static final float BORDER_EPSILON = 0.001f;

    /**
     * 四角半径的**回退链**（顺序同 {@link #CORNER_ORDER}：左上 / 右上 / 右下 / 左下）。
     *
     * <p>⚠️ 这一层不能省。RN 把 13 种半径写法分别存进 {@code BorderRadiusStyle} 的**不同字段**：
     * 平铺的 {@code borderRadius: 12} 落在 {@code uniform}，具名角的
     * {@code borderTopLeftRadius: 12} 落在 {@code topLeft}。而
     * {@code BackgroundStyleApplicator.getBorderRadius(view, prop)} 内部就是
     * {@code style.get(prop)} —— **按 key 精确取，不做任何回退**。
     * 于是「按角直接读」的写法对平铺写法一律得到 null。
     *
     * <p>回退只发生在**绘制用**的 {@code BorderRadiusStyle.resolve(...)} 里
     * （{@code startStart ?: topStart ?: topLeft ?: uniform} 这一串），读取侧必须自己再走一遍。
     * 下面四条链就是照着它的 LTR 分支逐条抄的，改 RN 版本时对着
     * {@code ReactAndroid/.../uimanager/style/BorderRadiusStyle.kt#resolve} 核一遍。
     *
     * <p>实测代价（2026-09-28，宿主 MallApp / react-android 0.81.5-mall）：
     * <ul>
     *   <li>宿主 App 里平铺 {@code borderRadius} 有 1276 处、具名角只有 261 处 —— 约 83% 的圆角
     *       会因此读成 null；
     *   <li>一份 530 节点的安卓快照里只有 12 个节点读得到半径、值全 ≤2dp（那 12 个恰好用的是
     *       具名角写法），界面上所有 8~12dp 的卡片 / 图片圆角**一个都没读到**，
     *       右下面板因此整组不显示（用户报的「有圆角但看不到圆角信息」）。
     * </ul>
     * 用常量而不是下标写字：名字就是语义，写错名字编译期就炸。
     */
    private static final BorderRadiusProp[][] CORNER_CHAINS_LTR = {
            chain(
                    BorderRadiusProp.BORDER_START_START_RADIUS,
                    BorderRadiusProp.BORDER_TOP_START_RADIUS,
                    BorderRadiusProp.BORDER_TOP_LEFT_RADIUS,
                    BorderRadiusProp.BORDER_RADIUS),
            chain(
                    BorderRadiusProp.BORDER_END_START_RADIUS,
                    BorderRadiusProp.BORDER_TOP_END_RADIUS,
                    BorderRadiusProp.BORDER_TOP_RIGHT_RADIUS,
                    BorderRadiusProp.BORDER_RADIUS),
            chain(
                    BorderRadiusProp.BORDER_END_END_RADIUS,
                    BorderRadiusProp.BORDER_BOTTOM_END_RADIUS,
                    BorderRadiusProp.BORDER_BOTTOM_RIGHT_RADIUS,
                    BorderRadiusProp.BORDER_RADIUS),
            chain(
                    BorderRadiusProp.BORDER_START_END_RADIUS,
                    BorderRadiusProp.BORDER_BOTTOM_START_RADIUS,
                    BorderRadiusProp.BORDER_BOTTOM_LEFT_RADIUS,
                    BorderRadiusProp.BORDER_RADIUS),
    };

    private ViewStyleReader() {
    }

    /** 只是为了让链的声明读起来像表达式。 */
    private static BorderRadiusProp[] chain(BorderRadiusProp... props) {
        return props;
    }

    /** RTL 时第 i 个角该用哪条 LTR 链：左上↔右上、右下↔左下。 */
    private static final int[] RTL_CORNER_SOURCE = {1, 0, 3, 2};

    /**
     * 某一角的回退链。RTL 下（且 {@code doLeftAndRightSwapInRTL}，RN 默认 true）就是
     * **左右两角的链对调** —— 与 {@code resolve()} 的 RTL 分支等价（那里把
     * {@code startStart ?: topStart ?: topLeft} 换成了 {@code endStart ?: topEnd ?: topRight}）。
     */
    private static BorderRadiusProp[] cornerChain(int cornerIndex, boolean rtl) {
        return CORNER_CHAINS_LTR[rtl ? RTL_CORNER_SOURCE[cornerIndex] : cornerIndex];
    }

    /**
     * 13 个半径键**一次读齐**：下标 = {@code prop.ordinal()}，回退链在这个数组上走。
     *
     * <p>一次读齐而不是每角现读，是因为一条链最多要看 4 个键、四个角就是 16 次 getter；
     * 读齐只要 13 次，而且把「有哪些写法」摊在一处。
     */
    private static LengthPercentage[] readRadiusProps(View view) {
        BorderRadiusProp[] props = BorderRadiusProp.values();
        LengthPercentage[] values = new LengthPercentage[props.length];
        for (int i = 0; i < props.length; i++) {
            values[i] = BackgroundStyleApplicator.getBorderRadius(view, props[i]);
        }
        return values;
    }

    /** 沿链取第一个有值的项；四写法都没设时返回 {@code null}。 */
    private static LengthPercentage firstPresent(
            LengthPercentage[] radiusByProp, BorderRadiusProp[] chain) {
        for (BorderRadiusProp prop : chain) {
            LengthPercentage radius = radiusByProp[prop.ordinal()];
            if (radius != null) {
                return radius;
            }
        }
        return null;
    }

    /**
     * 自绘视图的圆角旁路表：**类名 → 私有圆角字段名**。
     *
     * <p>为什么需要它：有的第三方 View 不把圆角交给 RN，而是在 Java 里自己用
     * {@code Canvas.drawPath} 画 —— 圆角由库的 JS 组装成一个**自定义 prop**（不是 RN 的
     * {@code borderRadius}），落在 View 的私有字段上。RN 的 drawable 里从头到尾没有这个值，
     * 于是 {@code getBorderRadius} 恒 null，面板那一行永远不出现。
     *
     * <p>实测宿主 App（2026-09-28，MallApp / community-worktree）里这类节点只有一种：
     * {@code react-native-linear-gradient} 的 {@code LinearGradientView}，圆角写在
     * {@code <LinearGradient style={...}>} 上（{@code styles.btnBack.borderRadius = 28}）。
     * 外层那层本该带圆角的 {@code <View>} 已经被 Fabric 打平（{@code borderRadius} 不在
     * {@code ViewShadowNode} 的 formsView 判据里，只有背景/边框/overflow 才算数），
     * 所以它自己就是唯一能问的对象。
     *
     * <p>为什么不直接 {@code import} 那个类：SDK 是给**所有**宿主用的包，import 第三方库会让
     * 不用该库的宿主编不过。所以类名走字符串、字段走反射，认不出来就静默跳过 ——
     * 库升级改了包名或字段名，最坏也只是回到「读不到」，不会崩、更不会报一个假的圆角。
     *
     * <p>字段本身的口径（2026-09-28 逐行核过 {@code LinearGradientView.java}）：
     * <ul>
     *   <li>类型 {@code float[]}、长度 8，顺序是 {@code Path.addRoundRect} 的
     *       {@code [左上x, 左上y, 右上x, 右上y, 右下x, 右下y, 左下x, 左下y]} 口径
     *       ⇒ 取下标 **0/2/4/6** 恰好是左上/右上/右下/左下，与 {@link #CORNER_ORDER} 同序，
     *       不需要重排；
     *   <li>**单位是 px**：setter 里做过 {@code PixelUtil.toPixelFromDIP}，换算见
     *       {@link CollectPolicy#radiusFromRoundRectPx}；
     *   <li>**没有 getter**，只能反射；
     *   <li>字段默认值是全 0（= 这个视图没有圆角），因此「0」按「没读到」处理。
     * </ul>
     *
     * <p>留成表而不是写成 if：将来遇到第二个同类库只多一行，不用改结构。已全量扫过宿主
     * {@code node_modules}，命中 {@code mBorderRadius*} 的第三方只有这一个。
     */
    private static final Map<String, String> RADIUS_FIELD_BY_CLASS = new HashMap<>();

    static {
        RADIUS_FIELD_BY_CLASS.put("com.BV.LinearGradient.LinearGradientView", "mBorderRadii");
    }

    /**
     * 从自绘视图的私有字段里把圆角数组取出来。不是表里的类 / 取不到 / 类型不是 {@code float[]}
     * 时一律返回 {@code null} —— 那是「没读到」（面板少一行），而不是报一个编出来的值。
     *
     * <p>沿父类链找：宿主或库自己包一层子类时，字段仍声明在父类上。
     *
     * <p>catch {@code Exception} 而不是 {@code ReflectiveOperationException}：除了「字段没了」
     * （{@code NoSuchFieldException}），还要挡 {@code SecurityException} 与
     * {@code InaccessibleObjectException}。这类失败**不该让一次采集整体失败** ——
     * 圆角读不到只是少一行，丢掉整份快照是另一回事。
     */
    private static float[] selfDrawnRadii(@NonNull View view) {
        for (Class<?> cls = view.getClass(); cls != null; cls = cls.getSuperclass()) {
            String fieldName = RADIUS_FIELD_BY_CLASS.get(cls.getName());
            if (fieldName == null) {
                continue;
            }
            try {
                Field field = cls.getDeclaredField(fieldName);
                field.setAccessible(true);
                Object value = field.get(view);
                return value instanceof float[] ? (float[]) value : null;
            } catch (Exception e) {
                return null;
            }
        }
        return null;
    }

    /**
     * 读盒样式。**没有一样有值时返回 {@code null}** —— 快照里绝大多数节点（布局容器、
     * 纯文本宿主）都属于这一类，写一个全 null 的对象进 JSON 只是让每份快照白胖一圈。
     */
    public static NativeNode.BoxStyle readBoxStyle(@NonNull View view) {
        NativeNode.BoxStyle style = new NativeNode.BoxStyle();
        style.backgroundColor = CollectPolicy.formatColor(
                BackgroundStyleApplicator.getBackgroundColor(view));

        boolean hasBorder = false;
        for (int i = 0; i < EDGE_ORDER.length; i++) {
            Float width = BackgroundStyleApplicator.getBorderWidth(view, EDGE_ORDER[i]);
            // 写成 !(width > EPSILON) 而不是 width <= EPSILON：后者对 NaN 返回 false，
            // 于是 NaN 会一路混进快照。取反的写法把「null / 0 / NaN」一次挡掉。
            if (width == null || !(width > BORDER_EPSILON)) {
                continue;
            }
            style.borderWidths[i] = CollectPolicy.round2(width);
            // 颜色只在**这一边真的有边框**时才读：RN 的 borderColor 默认值是黑色，
            // 一条 width=0 的边也带着黑色 —— 报出去就等于告诉验收同学「这里有边框」。
            style.borderColors[i] = CollectPolicy.formatColor(
                    BackgroundStyleApplicator.getBorderColor(view, EDGE_ORDER[i]));
            hasBorder = true;
        }

        if (hasBorder) {
            BorderStyle borderStyle = BackgroundStyleApplicator.getBorderStyle(view);
            if (borderStyle != null) {
                // 枚举名直接进快照：SOLID / DASHED / DOTTED 与 RN 的 borderStyle 字符串一一对应，
                // 中间不做映射表 —— 多一层映射就多一个「两边写的不一样」的机会。
                style.borderStyle = borderStyle.name().toLowerCase(Locale.US);
            }
        }

        // ⚠️ 半径键**不能按角直接读**：RN 把「平铺 borderRadius」和「具名角」存在两个不同字段里，
        // 而 getBorderRadius 是按 key 精确取的。必须先读齐 13 个键，再走一遍回退链 —— 见
        // CORNER_CHAINS_LTR 那段说明（不这么做的实测后果：整屏卡片圆角一个都读不到）。
        LengthPercentage[] radiusByProp = readRadiusProps(view);
        boolean rtl = view.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL;
        boolean hasRadius = false;
        for (int i = 0; i < CORNER_ORDER.length; i++) {
            LengthPercentage radius = firstPresent(radiusByProp, cornerChain(i, rtl));
            if (radius == null) {
                continue;
            }
            // ⚠️ LengthPercentage 只暴露 resolve(parentLength)，没有裸值 getter。于是：
            //   · POINT  → resolve 原样返回 dp（parentLength 无关，传 0）
            //   · PERCENT→ resolve(100) 恰好把百分数还原成数值（value / 100 × 100）
            boolean percent = radius.getType() == LengthPercentageType.PERCENT;
            float raw = percent ? radius.resolve(100f) : radius.resolve(0f);
            style.radii[i] = CollectPolicy.radiusInDp(percent, raw, view.getWidth(), view.getHeight());
            hasRadius = true;
        }

        // 上面这条通道整组落空时，再给**自绘视图**一次机会：它的圆角值从没进过 drawable，
        // 只能从库自己的私有字段取（见 RADIUS_FIELD_BY_CLASS 那段）。
        // 顺序是刻意的 —— 官方通道有值就以官方为准，旁路只在它一个角都没读到时才兜底，
        // 免得两种来源互相打架。
        if (!hasRadius) {
            float[] pxRadii = selfDrawnRadii(view);
            if (pxRadii != null) {
                // 用 RN 自己的密度做逆运算，与库 setter 里那次 toPixelFromDIP 严格同源；
                // 换成别的 density 来源（resources / DisplayMetricsHolder）都可能差一点点。
                float density = PixelUtil.toPixelFromDIP(1f);
                for (int i = 0; i < CORNER_ORDER.length; i++) {
                    style.radii[i] = CollectPolicy.radiusFromRoundRectPx(pxRadii, i * 2, density);
                }
            }
        }

        return style.isEmpty() ? null : style;
    }

    /**
     * 读文本样式。
     *
     * @param scaledDensity {@code DisplayMetrics.scaledDensity}（= density × fontScale）。
     *                      字号 / 行高 / 字距三个 px 值都靠它回算成开发写的 dp，
     *                      理由见 {@link NativeNode.TextStyle} 那段备注。
     */
    public static NativeNode.TextStyle readTextStyle(@NonNull TextView view, float scaledDensity) {
        NativeNode.TextStyle style = new NativeNode.TextStyle();

        style.fontSize = CollectPolicy.logicalFromPx(view.getTextSize(), scaledDensity);
        style.color = CollectPolicy.formatColor(view.getCurrentTextColor());

        // 字距走 Paint 而不是 TextView.getLetterSpacing()：后者单位是 **em**，而 RN 写进去的是 px，
        // 两个口径差一个字号倍数。Paint 上的那个是 px，与 fontSize 同一坐标系，可以直接除。
        float spacing = view.getPaint() == null ? 0f : view.getPaint().getLetterSpacing();
        if (spacing != 0f) {
            style.letterSpacing = CollectPolicy.logicalFromPx(spacing, scaledDensity);
        }

        Typeface typeface = view.getTypeface();
        boolean italic = typeface != null && typeface.isItalic();
        boolean bold = typeface != null && typeface.isBold();

        // RN 没给数值字重时 CustomStyleSpan.getWeight() 返回 -1（见 ReactTypefaceUtils.parseFontWeight，
        // 它把 'bold' 解析成 700、'normal' 成 400、其余一律 -1）。所以这里用一个越界的初值当哨兵。
        int spanWeight = -1;
        String fontFamily = null;
        Double lineHeight = null;

        Spanned spanned = spannedOf(view);
        if (spanned != null && spanned.length() > 0) {
            for (CustomStyleSpan span : spanned.getSpans(0, spanned.length(), CustomStyleSpan.class)) {
                if (fontFamily == null && span.getFontFamily() != null) {
                    fontFamily = span.getFontFamily();
                }
                if (spanWeight < 100 || spanWeight > 900) {
                    spanWeight = span.getWeight();
                }
                int spanStyle = span.getStyle();
                // span 上的样式位与 typeface 上的粗斜体位是**两条独立的线索**，取并集：
                // RN 有时只把 weight 放进 span（typeface 那边仍是常规体），有时反过来。
                if ((spanStyle & Typeface.ITALIC) != 0) {
                    italic = true;
                }
                if ((spanStyle & Typeface.BOLD) != 0) {
                    bold = true;
                }
            }
            for (CustomLineHeightSpan span : spanned.getSpans(0, spanned.length(), CustomLineHeightSpan.class)) {
                if (lineHeight == null) {
                    lineHeight = CollectPolicy.logicalFromPx(span.getLineHeight(), scaledDensity);
                }
            }
        }

        style.fontFamily = fontFamily;
        style.fontWeight = CollectPolicy.fontWeightOf(spanWeight, bold);
        style.fontStyle = italic ? "italic" : "normal";
        style.lineHeight = lineHeight;
        return style;
    }

    /**
     * 取承载 span 的文本。
     *
     * <p>用 {@code view.getText()} 而不是 {@code ReactTextView.getSpanned()}：两者拿到的是同一份
     * Spannable（RN 的 {@code setText(ReactTextUpdate)} 就是把它原样转交给
     * {@code TextView.setText(CharSequence)}，字节码里那一步是 0.81.5 上核过的），
     * 但引用 {@code ReactTextView} 这个**类型**会让 javac 必须解析它的父类链 ——
     * 链上第一个非 RN 的类是 androidx 的 {@code AppCompatTextView}，于是本包的
     * {@code compile-check.sh} 就得再拉一串 androidx 依赖进 classpath 才编得过。
     *
     * <p>这个库只被宿主 App 构建，多一个 androidx 依赖本身无害；贵的是**让那个 3 秒的
     * 编译检查脚本变复杂** —— 它存在的全部意义就是「改完一行立刻知道对不对」。
     * 所以这里退一步用公开 API：少一个类型引用，换脚本里不出现第二个 aar 查找循环。
     */
    private static Spanned spannedOf(@NonNull TextView view) {
        CharSequence text = view.getText();
        return text instanceof Spanned ? (Spanned) text : null;
    }
}
