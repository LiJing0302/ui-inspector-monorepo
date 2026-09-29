package com.reactnative.uiacceptance;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;

/**
 * A single node captured from the Android view tree.
 *
 * <p>The bridge representation is used by {@code capture()} and the on-device overlay. The JSON
 * representation is used by the recorder, which writes frames straight to disk and never crosses
 * the bridge with a full snapshot.
 */
public final class NativeNode {

    public String nodeId;
    public String treePath;
    public String parentId;
    public String className;
    public String resourceName;
    public String contentDescription;
    public int nativeTag;
    public SourceMarker source;
    public String text;
    public int depth;
    public int index;
    public int siblingCount;
    public int x;
    public int y;
    public int width;
    public int height;
    public boolean hasVisibleRect;
    public int visibleX;
    public int visibleY;
    public int visibleWidth;
    public int visibleHeight;
    /**
     * 沿**祖先裁剪链**求交之后的有效可见矩形 —— 「这块区域还会不会被画出来」的几何答案。
     *
     * <p>与上面那组 {@code visible*} 的区别是本次改动的全部要点：{@code visible*} 来自平台的
     * {@code getGlobalVisibleRect()}，它对 RN 的 {@code overflow:hidden}（在 {@code ViewGroup.draw()}
     * 里 clipRect 出来的绘制期裁剪）完全无感，会把被裁掉的行报成完整可见；这一组是自己沿祖先链
     * 逐层求交算出来的，实测能把价格数字轮那 29/30 行候选正确判掉。
     *
     * <p>不是每个节点都有：零尺寸节点与整块被裁没的节点都是 {@code hasEffectiveVisibleRect=false}，
     * 调用方需要配合 {@link #clippedOut} 区分「没有面积」和「被裁掉了」。
     */
    public boolean hasEffectiveVisibleRect;
    public int effectiveVisibleX;
    public int effectiveVisibleY;
    public int effectiveVisibleWidth;
    public int effectiveVisibleHeight;
    /**
     * 自身矩形被祖先裁剪链裁小（含裁没）。
     *
     * <p>与平台字段 {@link #clipped} 不是一回事：{@code clipped} 只反映平台可见矩形与自身矩形的差，
     * 对绘制期裁剪恒为 false（这正是那批噪音元素漏过门禁的原因）。
     */
    public boolean clippedByAncestor;
    /**
     * 自身有面积、有效可见矩形却没有面积：屏幕上没有它的**任何**像素。
     *
     * <p>验收输入门禁最该剔除的一类。
     */
    public boolean clippedOut;
    public int scrollX;
    public int scrollY;
    public boolean visible;
    public boolean attached;
    public boolean hasVisualContent;
    public boolean isSvg;
    public boolean isImage;
    public boolean isGradient;
    public boolean zeroSize;
    public boolean hiddenByAncestor;
    public boolean outsideVisibleRect;
    public boolean clipped;
    public boolean layoutOnly;
    /**
     * 透传包装：自身不绘制，且恰好装着一个占满自身的有效子节点（判据见
     * {@code NodeCollector.isPassThrough}）。
     *
     * <p>SDK 直接把结论带出来，而不是让 Mac 侧每次匹配都重算一遍：它需要「有效子节点数」
     * 与「子节点矩形」，那两样只有采集时能一眼拿到；同时它也让调试导出可读 ——
     * 「为什么这个节点没被匹配」在导出里就是一行 {@code passThrough: true}。
     */
    public boolean passThrough;
    public boolean textRedacted;
    public String participation;
    public boolean clickable;
    public boolean enabled;
    public boolean clipsToBounds;
    public float alpha;
    public float z;
    public float elevation;
    /**
     * 盒样式：背景色 / 边框 / 圆角。**没有一样值得上报时是 {@code null}**（绝大多数布局容器）。
     *
     * <p>为什么这些字段值得进快照：验收同学在画布上点一个元素，问的是「它长得对不对」——
     * 尺寸、文案、字体、背景、边框。前四样以前就能答，后两样（背景与边框）在 2026-09-22 之前
     * 快照里一概没有，于是面板上永远是「—」，只能靠人眼看截图。
     *
     * <p>取值全部在 {@link ViewStyleReader}：那需要 RN 的类，而 {@link NativeNode} 只是个 DTO。
     */
    public BoxStyle style;
    /**
     * 文本样式：字号 / 字重 / 字体 / 行高 / 字距 / 颜色。**非文本节点是 {@code null}**。
     *
     * <p>内容（{@link #text}）与样式分开：内容受 {@code includeText} 与脱敏控制，样式不受 ——
     * 一个密码框的字号该被看见，它的密码不该。
     */
    public TextStyle textStyle;

    /** 四边 / 四角的序号。顺序就是 {@link #EDGE_KEYS} / {@link #CORNER_KEYS} 的顺序。 */
    public static final int EDGE_TOP = 0;
    public static final int EDGE_RIGHT = 1;
    public static final int EDGE_BOTTOM = 2;
    public static final int EDGE_LEFT = 3;

    private static final String[] EDGE_KEYS = {"top", "right", "bottom", "left"};
    private static final String[] CORNER_KEYS = {"topLeft", "topRight", "bottomRight", "bottomLeft"};

    /**
     * 盒样式。
     *
     * <p>长度单位统一是 **dp**（逻辑像素），与快照里的几何字段（px）**不同**：几何是
     * 「屏幕上占了多少像素」，必须原样保留才能和截图对齐；而样式要回答的是「开发写的那个数
     * 是多少」—— 开发写的 `borderWidth: 1` 就是 1，不该因为机型密度变成 2.75。
     *
     * <p>RN 的三个 getter 恰好都返回 dp（`getBorderWidth` 内部 `pxToDp`、
     * `getBorderRadius` 的 POINT 是 dp），只有字体那几项需要自己从 px 回算（见 {@link TextStyle}）。
     */
    public static final class BoxStyle {
        /** `#rrggbb` 或 `#aarrggbb`；{@code null} = 没设背景色（或完全透明）。 */
        public String backgroundColor;
        /** `solid` / `dashed` / `dotted`；{@code null} = 没有边框（样式无意义时不报）。 */
        public String borderStyle;
        /** 四边宽度（dp），下标见 {@link #EDGE_TOP} 等；{@code null} 元素 = 这一边没有边框。 */
        public final Double[] borderWidths = new Double[4];
        /** 四边颜色，`#rrggbb`；{@code null} 元素 = 这一边没读到颜色。 */
        public final String[] borderColors = new String[4];
        /** 四角半径（dp），顺序 左上 / 右上 / 右下 / 左下；{@code null} 元素 = 没读到。 */
        public final Double[] radii = new Double[4];

        /** 有没有任何一项值得写进快照。全空时调用方写 {@code null}，别写一个空对象。 */
        public boolean isEmpty() {
            if (backgroundColor != null || borderStyle != null) {
                return false;
            }
            for (int i = 0; i < 4; i++) {
                if (borderWidths[i] != null || borderColors[i] != null || radii[i] != null) {
                    return false;
                }
            }
            return true;
        }

        public WritableMap toWritableMap() {
            WritableMap map = Arguments.createMap();
            map.putString("backgroundColor", backgroundColor);
            map.putString("borderStyle", borderStyle);
            map.putMap("borderWidth", doublesToMap(EDGE_KEYS, borderWidths));
            map.putMap("borderColor", stringsToMap(EDGE_KEYS, borderColors));
            map.putMap("borderRadius", doublesToMap(CORNER_KEYS, radii));
            return map;
        }

        void writeJson(StringBuilder out, String key) {
            Json.writeObjectStart(out, key);
            Json.writeString(out, "backgroundColor", backgroundColor);
            Json.writeString(out, "borderStyle", borderStyle);
            writeDoubles(out, "borderWidth", EDGE_KEYS, borderWidths);
            writeStrings(out, "borderColor", EDGE_KEYS, borderColors);
            writeDoubles(out, "borderRadius", CORNER_KEYS, radii);
            Json.writeObjectEnd(out);
        }
    }

    /**
     * 文本样式。长度单位统一是 **dp / sp 的逻辑值** —— 即「开发在 style 里写的数字」。
     *
     * <p>⚠️ 关键在 {@code fontSize} / {@code lineHeight} / {@code letterSpacing} 三个值的回算：
     * RN 用 {@code PixelUtil.toPixelFromSP} 把 dp 乘上 {@code density × fontScale} 之后才交给
     * TextView，所以 {@code getTextSize()} 里**裹着用户的系统字体缩放**。直接上报它，
     * 同一份设计稿在「系统字体调大过」的手机上会显示出更大的字号，而验收同学看到的结论是
     * 「App 字号写错了」。这里统一除以 {@code scaledDensity} 还原成设计稿口径。
     *
     * <p>已知近似：{@code allowFontScaling={false}} 的文本 RN 只用 density 换算，这时除以
     * scaledDensity 会差一个 fontScale（字体缩放为 1 的机器上无差别）。RN 没有把
     * allowFontScaling 暴露到 View 上，要精确只能让 RN 侧一起改 —— 影响面很小，先记在这里。
     */
    public static final class TextStyle {
        /** 字号（dp）。 */
        public double fontSize;
        /** 字重 100–900，取值见 {@code CollectPolicy.fontWeightOf}。 */
        public int fontWeight;
        /** `normal` / `italic`。 */
        public String fontStyle;
        /** RN 的 fontFamily 字符串（如 `PingFang SC`）；{@code null} = 没设。 */
        public String fontFamily;
        /** 行高（dp）；{@code null} = RN 没设行高（TextView 用字体自带行距）。 */
        public Double lineHeight;
        /** 字距（dp）；{@code null} = 没设。不写 0：否则每一行文本都白占一个「字距 0」。 */
        public Double letterSpacing;
        /** 文字颜色，`#rrggbb` / `#aarrggbb`。 */
        public String color;

        public WritableMap toWritableMap() {
            WritableMap map = Arguments.createMap();
            map.putDouble("fontSize", fontSize);
            map.putInt("fontWeight", fontWeight);
            map.putString("fontStyle", fontStyle);
            map.putString("fontFamily", fontFamily);
            putNullable(map, "lineHeight", lineHeight);
            putNullable(map, "letterSpacing", letterSpacing);
            map.putString("color", color);
            return map;
        }

        void writeJson(StringBuilder out, String key) {
            Json.writeObjectStart(out, key);
            Json.writeDouble(out, "fontSize", fontSize);
            Json.writeInt(out, "fontWeight", fontWeight);
            Json.writeString(out, "fontStyle", fontStyle);
            Json.writeString(out, "fontFamily", fontFamily);
            Json.writeDoubleOrNull(out, "lineHeight", lineHeight);
            Json.writeDoubleOrNull(out, "letterSpacing", letterSpacing);
            Json.writeString(out, "color", color);
            Json.writeObjectEnd(out);
        }
    }

    private static WritableMap doublesToMap(String[] keys, Double[] values) {
        WritableMap map = Arguments.createMap();
        for (int i = 0; i < keys.length; i++) {
            putNullable(map, keys[i], values[i]);
        }
        return map;
    }

    private static WritableMap stringsToMap(String[] keys, String[] values) {
        WritableMap map = Arguments.createMap();
        for (int i = 0; i < keys.length; i++) {
            map.putString(keys[i], values[i]);
        }
        return map;
    }

    /**
     * 可空数值进 WritableMap。
     *
     * <p>RN 的 {@code putDouble(key, null)} 在部分实现上会抛（要的是显式 null 语义），
     * 所以统一走 {@code putNull} ——「没读到」与「就是 0」在面板上要显示成两件事。
     */
    private static void putNullable(WritableMap map, String key, Double value) {
        if (value == null) {
            map.putNull(key);
        } else {
            map.putDouble(key, value);
        }
    }

    private static void writeDoubles(StringBuilder out, String key, String[] names, Double[] values) {
        Json.writeObjectStart(out, key);
        for (int i = 0; i < names.length; i++) {
            Json.writeDoubleOrNull(out, names[i], values[i]);
        }
        Json.writeObjectEnd(out);
    }

    private static void writeStrings(StringBuilder out, String key, String[] names, String[] values) {
        Json.writeObjectStart(out, key);
        for (int i = 0; i < names.length; i++) {
            Json.writeString(out, names[i], values[i]);
        }
        Json.writeObjectEnd(out);
    }

    public WritableMap toWritableMap() {
        WritableMap map = Arguments.createMap();
        map.putString("nodeId", nodeId);
        map.putString("treePath", treePath);
        if (parentId == null) {
            map.putNull("parentId");
        } else {
            map.putString("parentId", parentId);
        }
        map.putString("className", className);
        if (resourceName == null) {
            map.putNull("resourceName");
        } else {
            map.putString("resourceName", resourceName);
        }
        if (contentDescription == null) {
            map.putNull("contentDescription");
        } else {
            map.putString("contentDescription", contentDescription);
        }
        map.putInt("nativeTag", nativeTag);
        if (source == null) {
            map.putNull("source");
        } else {
            WritableMap sourceMap = Arguments.createMap();
            sourceMap.putString("projectRootHash", source.projectRootHash);
            sourceMap.putString("sourceId", source.sourceId);
            sourceMap.putString("relativePath", source.relativePath);
            sourceMap.putInt("startLine", source.startLine);
            sourceMap.putInt("startColumn", source.startColumn);
            sourceMap.putInt("endLine", source.endLine);
            sourceMap.putInt("endColumn", source.endColumn);
            sourceMap.putString("displayName", source.displayName);
            sourceMap.putString("role", source.role);
            map.putMap("source", sourceMap);
        }
        if (text == null) {
            map.putNull("text");
        } else {
            map.putString("text", text);
        }
        map.putInt("depth", depth);
        map.putInt("index", index);
        map.putInt("siblingCount", siblingCount);
        map.putInt("x", x);
        map.putInt("y", y);
        map.putInt("width", width);
        map.putInt("height", height);
        if (hasVisibleRect) {
            map.putInt("visibleX", visibleX);
            map.putInt("visibleY", visibleY);
            map.putInt("visibleWidth", visibleWidth);
            map.putInt("visibleHeight", visibleHeight);
        } else {
            map.putNull("visibleX");
            map.putNull("visibleY");
            map.putNull("visibleWidth");
            map.putNull("visibleHeight");
        }
        if (hasEffectiveVisibleRect) {
            map.putInt("effectiveVisibleX", effectiveVisibleX);
            map.putInt("effectiveVisibleY", effectiveVisibleY);
            map.putInt("effectiveVisibleWidth", effectiveVisibleWidth);
            map.putInt("effectiveVisibleHeight", effectiveVisibleHeight);
        } else {
            map.putNull("effectiveVisibleX");
            map.putNull("effectiveVisibleY");
            map.putNull("effectiveVisibleWidth");
            map.putNull("effectiveVisibleHeight");
        }
        map.putInt("scrollX", scrollX);
        map.putInt("scrollY", scrollY);
        map.putBoolean("visible", visible);
        map.putBoolean("attached", attached);
        map.putBoolean("hasVisualContent", hasVisualContent);
        map.putBoolean("isSvg", isSvg);
        map.putBoolean("isImage", isImage);
        map.putBoolean("isGradient", isGradient);
        map.putBoolean("zeroSize", zeroSize);
        map.putBoolean("hiddenByAncestor", hiddenByAncestor);
        map.putBoolean("outsideVisibleRect", outsideVisibleRect);
        map.putBoolean("clipped", clipped);
        map.putBoolean("layoutOnly", layoutOnly);
        map.putBoolean("passThrough", passThrough);
        map.putBoolean("textRedacted", textRedacted);
        map.putString("participation", participation);
        WritableMap state = Arguments.createMap();
        state.putBoolean("visible", visible);
        state.putBoolean("attached", attached);
        state.putBoolean("hasVisualContent", hasVisualContent);
        state.putBoolean("layoutOnly", layoutOnly);
        state.putBoolean("passThrough", passThrough);
        state.putBoolean("clipped", clipped);
        state.putBoolean("clippedByAncestor", clippedByAncestor);
        state.putBoolean("clippedOut", clippedOut);
        state.putBoolean("zeroSize", zeroSize);
        state.putBoolean("hiddenByAncestor", hiddenByAncestor);
        state.putBoolean("outsideVisibleRect", outsideVisibleRect);
        state.putString("participation", participation);
        map.putMap("state", state);
        map.putBoolean("clippedByAncestor", clippedByAncestor);
        map.putBoolean("clippedOut", clippedOut);
        map.putBoolean("clickable", clickable);
        map.putBoolean("enabled", enabled);
        map.putBoolean("clipsToBounds", clipsToBounds);
        map.putDouble("alpha", alpha);
        map.putDouble("z", z);
        map.putDouble("elevation", elevation);
        // 样式（背景 / 边框 / 圆角 / 字体）。两条独立的可空通道：盒样式几乎只对「你看得见的
        // 那个盒子」有值，文本样式只对 TextView 有值，各自 null 掉比塞一个空对象更好读。
        if (style == null || style.isEmpty()) {
            map.putNull("style");
        } else {
            map.putMap("style", style.toWritableMap());
        }
        if (textStyle == null) {
            map.putNull("textStyle");
        } else {
            map.putMap("textStyle", textStyle.toWritableMap());
        }
        return map;
    }

    /**
     * Appends this node as a JSON object. A trailing comma is always written, so the caller must
     * drop the last character before closing the surrounding object.
     *
     * <p>⚠️ **这里刻意不写 {@link #style} / {@link #textStyle}**，与 {@link #toWritableMap} 不是
     * 漏改：这个方法只服务录制器（{@code FrameRecorder}），它按帧连续落盘、一份文件里同一棵树
     * 要写几百遍，而样式字段对「一次全树遍历要多久」这个问题毫无贡献 —— 加上去只会让每帧的
     * 体积涨近一半，把测量工具变成一个 I/O 测量工具。样式走**验收通道**（{@code capture()} →
     * {@code toWritableMap}），那里一份快照只写一次。
     *
     * <p>反过来说：如果哪天真有人要读录制文件里的样式，请改这个方法而不是在别处补解析 ——
     * 两个序列化器对同一个 DTO 给出不同答案，是比体积更难查的问题。
     */
    public void writeJson(StringBuilder out) {
        out.append('{');
        Json.writeString(out, "nodeId", nodeId);
        Json.writeString(out, "treePath", treePath);
        Json.writeString(out, "parentId", parentId);
        Json.writeString(out, "className", className);
        Json.writeString(out, "resourceName", resourceName);
        Json.writeString(out, "contentDescription", contentDescription);
        Json.writeInt(out, "nativeTag", nativeTag);
        Json.writeString(out, "text", text);
        Json.writeInt(out, "depth", depth);
        Json.writeInt(out, "index", index);
        Json.writeInt(out, "siblingCount", siblingCount);
        Json.writeInt(out, "x", x);
        Json.writeInt(out, "y", y);
        Json.writeInt(out, "width", width);
        Json.writeInt(out, "height", height);
        if (hasVisibleRect) {
            Json.writeInt(out, "visibleX", visibleX);
            Json.writeInt(out, "visibleY", visibleY);
            Json.writeInt(out, "visibleWidth", visibleWidth);
            Json.writeInt(out, "visibleHeight", visibleHeight);
        } else {
            Json.writeNull(out, "visibleX");
            Json.writeNull(out, "visibleY");
            Json.writeNull(out, "visibleWidth");
            Json.writeNull(out, "visibleHeight");
        }
        if (hasEffectiveVisibleRect) {
            Json.writeInt(out, "effectiveVisibleX", effectiveVisibleX);
            Json.writeInt(out, "effectiveVisibleY", effectiveVisibleY);
            Json.writeInt(out, "effectiveVisibleWidth", effectiveVisibleWidth);
            Json.writeInt(out, "effectiveVisibleHeight", effectiveVisibleHeight);
        } else {
            Json.writeNull(out, "effectiveVisibleX");
            Json.writeNull(out, "effectiveVisibleY");
            Json.writeNull(out, "effectiveVisibleWidth");
            Json.writeNull(out, "effectiveVisibleHeight");
        }
        Json.writeInt(out, "scrollX", scrollX);
        Json.writeInt(out, "scrollY", scrollY);
        Json.writeBoolean(out, "visible", visible);
        Json.writeBoolean(out, "attached", attached);
        Json.writeBoolean(out, "hasVisualContent", hasVisualContent);
        Json.writeBoolean(out, "isSvg", isSvg);
        Json.writeBoolean(out, "isImage", isImage);
        Json.writeBoolean(out, "isGradient", isGradient);
        Json.writeBoolean(out, "zeroSize", zeroSize);
        Json.writeBoolean(out, "hiddenByAncestor", hiddenByAncestor);
        Json.writeBoolean(out, "outsideVisibleRect", outsideVisibleRect);
        Json.writeBoolean(out, "clipped", clipped);
        Json.writeBoolean(out, "layoutOnly", layoutOnly);
        Json.writeBoolean(out, "passThrough", passThrough);
        Json.writeBoolean(out, "textRedacted", textRedacted);
        Json.writeString(out, "participation", participation);
        out.append("\"state\":{");
        Json.writeBoolean(out, "visible", visible);
        Json.writeBoolean(out, "attached", attached);
        Json.writeBoolean(out, "hasVisualContent", hasVisualContent);
        Json.writeBoolean(out, "layoutOnly", layoutOnly);
        Json.writeBoolean(out, "passThrough", passThrough);
        Json.writeBoolean(out, "clipped", clipped);
        Json.writeBoolean(out, "clippedByAncestor", clippedByAncestor);
        Json.writeBoolean(out, "clippedOut", clippedOut);
        Json.writeBoolean(out, "zeroSize", zeroSize);
        Json.writeBoolean(out, "hiddenByAncestor", hiddenByAncestor);
        Json.writeBoolean(out, "outsideVisibleRect", outsideVisibleRect);
        Json.writeString(out, "participation", participation);
        out.setLength(out.length() - 1);
        out.append("},");
        Json.writeBoolean(out, "clippedByAncestor", clippedByAncestor);
        Json.writeBoolean(out, "clippedOut", clippedOut);
        Json.writeBoolean(out, "clickable", clickable);
        Json.writeBoolean(out, "enabled", enabled);
        Json.writeBoolean(out, "clipsToBounds", clipsToBounds);
        Json.writeDouble(out, "alpha", alpha);
        Json.writeDouble(out, "z", z);
        Json.writeDouble(out, "elevation", elevation);
        out.setLength(out.length() - 1);
        out.append('}');
    }
}
