package com.reactnative.uiacceptance;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.text.method.PasswordTransformationMethod;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.uimanager.BackgroundStyleApplicator;
import com.facebook.react.uimanager.ReactOverflowView;
import com.facebook.react.uimanager.style.LogicalEdge;

import java.util.ArrayList;
import java.util.List;

/**
 * Walks Android's View tree and returns a platform-neutral node list.
 *
 * <p>One instance keeps two scratch buffers that are reused for every node, so a full tree walk
 * does not allocate per node. Instances are cheap and are not thread safe.
 */
public final class NodeCollector {

    private final int[] locationScratch = new int[2];
    private final Rect visibleRectScratch = new Rect();

    /**
     * 窗口左上角在屏幕中的位置。
     *
     * <p>{@code getLocationOnScreen} 给的是**屏幕**坐标，而帧盒（{@code snapshot.windowWidth/Height}）
     * 与 SDK 截出的 PNG 都是**窗口**尺寸。两者差一个窗口原点：非 edge-to-edge 的窗口从状态栏下方开始，
     * 于是整棵节点树会整体下移一条状态栏的高度 —— 在验收画布上表现为「节点层与底图错位」，
     * 而那种错位看起来像开发写歪了，非常难查。
     *
     * <p>所以这里统一减掉原点，让节点坐标与截图同处**窗口**空间。edge-to-edge 的窗口
     * 原点本就是 (0,0)，此处的减法退化成空操作。
     *
     * <p>注意 {@code clipped} 的判定用的是「可见矩形 vs 节点矩形」的相对比较，
     * 两者同减一个原点不改变结论。
     */
    private int originX;
    private int originY;
    private final int[] originScratch = new int[2];

    public List<NativeNode> collect(
            @NonNull Activity activity,
            @NonNull CollectOptions options,
            @Nullable View excludedView
    ) {
        List<NativeNode> nodes = new ArrayList<>();
        View root = activity.getWindow().getDecorView();
        applyWindowOrigin(root);
        collectView(root, null, "0", 0, 0, nodes, options, excludedView, new CollectStats());
        return nodes;
    }

    public CollectResult collectDetailed(
            @NonNull Activity activity,
            @NonNull CollectOptions options,
            @Nullable View excludedView
    ) {
        List<NativeNode> nodes = new ArrayList<>();
        CollectStats stats = new CollectStats();
        View root = activity.getWindow().getDecorView();
        applyWindowOrigin(root);
        collectView(root, null, "0", 0, 0, nodes, options, excludedView, stats);
        return new CollectResult(nodes, stats.actualDepth, stats.depthLimitReached, stats.nodeLimitReached);
    }

    private void applyWindowOrigin(@NonNull View decorView) {
        decorView.getLocationOnScreen(originScratch);
        originX = originScratch[0];
        originY = originScratch[1];
    }

    private void collectView(
            View view,
            @Nullable String parentId,
            @NonNull String treePath,
            int depth,
            int index,
            List<NativeNode> nodes,
            CollectOptions options,
            @Nullable View excludedView,
            @NonNull CollectStats stats
    ) {
        if (view == excludedView) {
            return;
        }
        if (nodes.size() >= options.maxNodes) {
            stats.nodeLimitReached = true;
            return;
        }
        if (depth > options.maxDepth) {
            stats.depthLimitReached = true;
            return;
        }

        stats.actualDepth = Math.max(stats.actualDepth, depth);

        boolean visible = view.getVisibility() == View.VISIBLE && view.getAlpha() > 0.001f && view.isShown();
        int width = view.getWidth();
        int height = view.getHeight();
        boolean skipSelf = CollectPolicy.skipSelf(
                options.includeInvisible,
                options.includeZeroSize,
                visible,
                width,
                height
        );

        if (skipSelf && !options.descendIntoSkipped) {
            // 轻量档（Overlay）：过滤即整棵子树跳过 —— 一个 GONE 的大子树不值得白跑几千次遍历
            return;
        }

        view.getLocationOnScreen(locationScratch);
        boolean hasVisibleRect = view.getGlobalVisibleRect(visibleRectScratch);

        // 跳过自身时，子树必须挂到**最近的已输出祖先**上。
        // 否则 parentId 会指向一个不存在的节点，Mac 侧的 validateTree 会直接拒收整棵树。
        String effectiveParentId = parentId;

        if (!skipSelf) {
            NativeNode node = new NativeNode();
            node.nodeId = createNodeId(view);
            node.treePath = treePath;
            node.parentId = parentId;
            node.depth = depth;
            node.index = index;
            node.siblingCount = view.getParent() instanceof ViewGroup
                    ? ((ViewGroup) view.getParent()).getChildCount()
                    : 1;
            node.className = view.getClass().getName();
            node.resourceName = getResourceName(view);
            node.x = locationScratch[0] - originX;
            node.y = locationScratch[1] - originY;
            node.width = width;
            node.height = height;
            node.hasVisibleRect = hasVisibleRect;
            if (hasVisibleRect) {
                // 可见矩形与上面的 x/y 同减窗口原点：`clipped` 判定是两者的相对比较，
                // 同减一个常量不影响结论，但让整棵树与窗口尺寸的截图对齐。
                node.visibleX = visibleRectScratch.left - originX;
                node.visibleY = visibleRectScratch.top - originY;
                node.visibleWidth = visibleRectScratch.width();
                node.visibleHeight = visibleRectScratch.height();
            }
            node.visible = visible;
            node.attached = view.isAttachedToWindow();
            node.isSvg = isSvgHostView(view);
            node.isImage = isImageHostView(view);
            node.isGradient = isGradientHostView(view);
            node.hasVisualContent = hasVisualContent(view);
            node.alpha = view.getAlpha();
            node.clickable = view.isClickable();
            node.enabled = view.isEnabled();
            node.scrollX = view.getScrollX();
            node.scrollY = view.getScrollY();
            node.z = view.getZ();
            node.elevation = view.getElevation();
            node.clipsToBounds = clipsToBounds(view);
            node.contentDescription = view.getContentDescription() == null
                    ? null
                    : view.getContentDescription().toString();
            node.zeroSize = width <= 0 || height <= 0;
            node.outsideVisibleRect = !hasVisibleRect && width > 0 && height > 0;
            node.clipped = hasVisibleRect && (
                    visibleRectScratch.left != locationScratch[0]
                            || visibleRectScratch.top != locationScratch[1]
                            || visibleRectScratch.width() != width
                            || visibleRectScratch.height() != height
            );
            node.hiddenByAncestor = !visible && hasHiddenAncestor(view);

            if (options.includeText && view instanceof TextView) {
                CharSequence text = ((TextView) view).getText();
                if (isSensitiveTextView((TextView) view)) {
                    node.textRedacted = text != null && text.length() > 0;
                    node.text = null;
                } else {
                    node.text = text == null ? null : text.toString();
                }
            }
            // layoutOnly 只看「自身有没有像素」：透明容器仍有层级与裁剪价值，
            // 但不该被当成一个需要视觉验收的元素。
            node.layoutOnly = !node.hasVisualContent;
            node.participation = CollectPolicy.participationOf(
                    node.attached,
                    node.visible,
                    node.zeroSize,
                    node.hasVisualContent
            );
            nodes.add(node);
            effectiveParentId = node.nodeId;
        }

        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int childIndex = 0; childIndex < group.getChildCount(); childIndex++) {
                collectView(
                        group.getChildAt(childIndex),
                        effectiveParentId,
                        treePath + "/" + childIndex,
                        depth + 1,
                        childIndex,
                        nodes,
                        options,
                        excludedView,
                        stats
                );
                if (nodes.size() >= options.maxNodes && childIndex + 1 < group.getChildCount()) {
                    stats.nodeLimitReached = true;
                    break;
                }
            }
        }
    }

    /**
     * 节点在验收流程里的参与度由 {@link CollectPolicy#participationOf} 决定 —— 那段判定
     * 不碰 View，所以拆出去了，好在纯 JVM 里断言。
     */
    private boolean hasHiddenAncestor(View view) {
        View parent = view.getParent() instanceof View ? (View) view.getParent() : null;
        while (parent != null) {
            if (parent.getVisibility() != View.VISIBLE || parent.getAlpha() <= 0.001f) {
                return true;
            }
            parent = parent.getParent() instanceof View ? (View) parent.getParent() : null;
        }
        return false;
    }

    private boolean isSensitiveTextView(TextView view) {
        return CollectPolicy.isSensitiveText(
                view.getTransformationMethod() instanceof PasswordTransformationMethod,
                view.getInputType()
        );
    }

    /**
     * Reports whether the node itself can paint visible content. Transparent layout containers are
     * kept in the snapshot for hierarchy and clipping, but should not become opaque overlay fills.
     */
    private boolean hasVisualContent(View view) {
        if (view.getVisibility() != View.VISIBLE || view.getAlpha() <= 0.001f) {
            return false;
        }

        if (isSvgHostView(view) || isGradientHostView(view)) {
            return true;
        }

        if (view instanceof TextView) {
            TextView textView = (TextView) view;
            CharSequence text = textView.getText();
            return text != null
                    && text.length() > 0
                    && Color.alpha(textView.getCurrentTextColor()) > 0;
        }

        if (view instanceof ImageView) {
            Drawable drawable = ((ImageView) view).getDrawable();
            return drawable != null && drawable.getAlpha() > 0;
        }

        Drawable background = view.getBackground();

        Integer backgroundColor = BackgroundStyleApplicator.getBackgroundColor(view);
        if (backgroundColor != null && Color.alpha(backgroundColor) > 0) {
            return true;
        }

        for (LogicalEdge edge : LogicalEdge.values()) {
            Float borderWidth = BackgroundStyleApplicator.getBorderWidth(view, edge);
            Integer borderColor = BackgroundStyleApplicator.getBorderColor(view, edge);

            if (borderWidth != null
                    && borderWidth > 0.001f
                    && borderColor != null
                    && Color.alpha(borderColor) > 0) {
                return true;
            }
        }

        return background != null
                && background.getAlpha() > 0
                && background.getOpacity() != android.graphics.PixelFormat.TRANSPARENT;
    }

    private boolean isSvgHostView(View view) {
        String className = view.getClass().getName();
        return "com.horcrux.svg.SvgView".equals(className)
                || className.endsWith(".RNSVGSvgView");
    }

    private boolean isImageHostView(View view) {
        return view instanceof ImageView;
    }

    private boolean isGradientHostView(View view) {
        return "com.BV.LinearGradient.LinearGradientView".equals(view.getClass().getName());
    }

    /**
     * React Native applies overflow clipping while drawing the ViewGroup's canvas. It does not
     * necessarily update Android's ViewGroup.clipChildren, so both forms of clipping are needed
     * when calculating the visible native-node rectangle.
     */
    private boolean clipsToBounds(View view) {
        if (!(view instanceof ViewGroup)) {
            return false;
        }
        if (((ViewGroup) view).getClipChildren()) {
            return true;
        }
        if (view instanceof ReactOverflowView) {
            String overflow = ((ReactOverflowView) view).getOverflow();
            return "hidden".equals(overflow) || "scroll".equals(overflow);
        }
        return false;
    }

    /**
     * Identity hash is stable for the lifetime of the view, which makes it usable for comparing two
     * frames inside one session. It must not be persisted across sessions, and it carries no
     * semantic meaning, so the recorder pairs it with a React layer id once that lands.
     */
    private String createNodeId(View view) {
        return "view:" + Integer.toHexString(System.identityHashCode(view));
    }

    @Nullable
    private String getResourceName(View view) {
        int viewId = view.getId();
        if (viewId == View.NO_ID || viewId == 0) {
            return null;
        }
        try {
            return view.getResources().getResourceEntryName(viewId);
        } catch (Exception ignored) {
            return null;
        }
    }

    /**
     * 旧档位 / Overlay 用：隐藏、零尺寸、文本都不收，且过滤即剪枝。
     *
     * <p>{@code config == null} 时给的是 {@link CollectOptions#legacyDefaults()} —— 注意这**不是**
     * 验收档。设备端 Overlay 一直在调它，把这里的默认值改成验收档会让 Overlay 突然去遍历整棵隐藏
     * 子树，帧率白掉一半；验收采集的默认值由 {@link #acceptanceOptionsFrom} 负责。
     */
    public static CollectOptions optionsFrom(@Nullable ReadableMap config) {
        if (config == null) {
            return CollectOptions.legacyDefaults();
        }
        return new CollectOptions(
                CollectOptions.PROFILE_LEGACY,
                getBoolean(config, "showOverlay", true),
                getBoolean(config, "showLabels", false),
                getBoolean(config, "includeInvisible", false),
                getBoolean(config, "includeZeroSize", false),
                getBoolean(config, "includeText", false),
                false,
                CollectPolicy.clamp(
                        getInt(config, "maxDepth", CollectOptions.DEFAULT_MAX_DEPTH),
                        0,
                        CollectOptions.ACCEPTANCE_MAX_DEPTH
                ),
                CollectPolicy.clamp(
                        getInt(config, "maxNodes", CollectOptions.DEFAULT_MAX_NODES),
                        1,
                        CollectOptions.ACCEPTANCE_MAX_NODES
                ),
                CollectPolicy.clamp(
                        getLong(config, "refreshIntervalMs", CollectOptions.DEFAULT_REFRESH_INTERVAL_MS),
                        100L,
                        2000L
                )
        );
    }

    /**
     * 验收全量档。{@code config == null} 时就是 {@link CollectOptions#acceptanceDefaults()}。
     *
     * <p>三个 include 开关允许调用方收紧，但 {@code descendIntoSkipped} 固定为 true：
     * 它是「零尺寸父节点外溢的可见子节点也要收」这条需求的唯一承载，不能被配置关掉 ——
     * 一旦关掉，被过滤容器的整棵子树会静默消失，而 Mac 侧只能看到「节点少了」，
     * 却看不出是采集侧剪掉的还是 App 真的没画。
     */
    public static CollectOptions acceptanceOptionsFrom(@Nullable ReadableMap config) {
        if (config == null) {
            return CollectOptions.acceptanceDefaults();
        }
        return new CollectOptions(
                CollectOptions.PROFILE_ACCEPTANCE_FULL,
                false,
                false,
                getBoolean(config, "includeInvisible", true),
                getBoolean(config, "includeZeroSize", true),
                getBoolean(config, "includeText", true),
                true,
                CollectPolicy.clamp(
                        getInt(config, "maxDepth", CollectOptions.ACCEPTANCE_MAX_DEPTH),
                        0,
                        CollectOptions.ACCEPTANCE_MAX_DEPTH
                ),
                CollectPolicy.clamp(
                        getInt(config, "maxNodes", CollectOptions.ACCEPTANCE_MAX_NODES),
                        1,
                        CollectOptions.ACCEPTANCE_MAX_NODES
                ),
                CollectOptions.DEFAULT_REFRESH_INTERVAL_MS
        );
    }

    private static boolean getBoolean(ReadableMap map, String key, boolean fallback) {
        return map.hasKey(key) && !map.isNull(key) ? map.getBoolean(key) : fallback;
    }

    private static int getInt(ReadableMap map, String key, int fallback) {
        return map.hasKey(key) && !map.isNull(key) ? map.getInt(key) : fallback;
    }

    private static long getLong(ReadableMap map, String key, long fallback) {
        return map.hasKey(key) && !map.isNull(key) ? (long) map.getDouble(key) : fallback;
    }

    public static final class CollectResult {
        public final List<NativeNode> nodes;
        public final int actualDepth;
        public final boolean depthLimitReached;
        public final boolean nodeLimitReached;

        CollectResult(
                List<NativeNode> nodes,
                int actualDepth,
                boolean depthLimitReached,
                boolean nodeLimitReached
        ) {
            this.nodes = nodes;
            this.actualDepth = actualDepth;
            this.depthLimitReached = depthLimitReached;
            this.nodeLimitReached = nodeLimitReached;
        }
    }

    private static final class CollectStats {
        int actualDepth;
        boolean depthLimitReached;
        boolean nodeLimitReached;
    }
}
