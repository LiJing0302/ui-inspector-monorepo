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
 * <p>One instance keeps a few scratch buffers (location, platform visible rect, and per-depth geometry
 * slots for the ancestor clip chain) that are reused for every node, so a full tree walk does not
 * allocate per node. Instances are cheap and are not thread safe.
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

    /**
     * 窗口边界（窗口坐标系）。裁剪链的起点：decorView 的矩形，也就是 (0, 0, W, H)。
     *
     * <p>它与快照里的 {@code windowWidth/Height} 取自同一个 View，所以这条边界与截图**同一个
     * 盒子** —— 有效可见矩形永远不会指到截图以外的地方（否则「有没有像素」的本地复核会与它打架）。
     */
    private final IntRect rootWindow = new IntRect();

    /**
     * 每层深度复用的几何槽位：先用深度索引，同一个时刻一层只有一个节点在算（深度优先），
     * 所以一次全树遍历的分配次数是 0。
     *
     * <p>为什么子节点可以**直接持有**父节点的 {@code effectiveSlots} 实例而不必复制：
     * 该槽位在父节点访问期间不会被改写，而父节点的子树跑完之后才会轮到父节点的兄弟，
     * 那时所有子节点都已经算完了。
     */
    private IntRect[] ownSlots = new IntRect[0];
    private IntRect[] effectiveSlots = new IntRect[0];

    /**
     * 字体缩放后的密度（{@code density × fontScale}），一次采集里不变，所以在入口读一次。
     *
     * <p>它是**字号回算**的除数：RN 把 fontSize 乘上它之后才交给 TextView，采集侧要还给
     * 验收同学「开发写的那个数」就得除回去（见 {@link NativeNode.TextStyle}）。
     * 每个 TextView 各去问一遍 {@code Resources} 只是白多几次调用。
     */
    private float scaledDensity = 1f;

    public List<NativeNode> collect(
            @NonNull Activity activity,
            @NonNull CollectOptions options,
            @Nullable View excludedView
    ) {
        List<NativeNode> nodes = new ArrayList<>();
        View root = activity.getWindow().getDecorView();
        prepareWindow(activity);
        collectView(root, null, "0", 0, 0, nodes, options, excludedView, false, rootWindow(), new CollectStats());
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
        prepareWindow(activity);
        collectView(root, null, "0", 0, 0, nodes, options, excludedView, false, rootWindow(), stats);
        return new CollectResult(nodes, stats.actualDepth, stats.depthLimitReached, stats.nodeLimitReached);
    }

    private void prepareWindow(@NonNull Activity activity) {
        View decorView = activity.getWindow().getDecorView();
        decorView.getLocationOnScreen(originScratch);
        originX = originScratch[0];
        originY = originScratch[1];
        rootWindow.set(0, 0, decorView.getWidth(), decorView.getHeight());
        scaledDensity = activity.getResources().getDisplayMetrics().scaledDensity;
    }

    /**
     * 裁剪链的起点。decorView 还没测量出尺寸时返回 {@code null}（= 不受限）而不是一个空矩形：
     * 空窗口会把整棵树判成「屏幕上没有像素」，那会把「采集跑早了」伪装成「页面什么都没画」。
     */
    @Nullable
    private IntRect rootWindow() {
        return rootWindow.isEmpty() ? null : rootWindow;
    }

    private IntRect ownRectSlot(int depth) {
        if (depth >= ownSlots.length) {
            growSlots(depth);
        }
        IntRect slot = ownSlots[depth];
        if (slot == null) {
            slot = new IntRect();
            ownSlots[depth] = slot;
        }
        return slot;
    }

    private IntRect effectiveRectSlot(int depth) {
        if (depth >= effectiveSlots.length) {
            growSlots(depth);
        }
        IntRect slot = effectiveSlots[depth];
        if (slot == null) {
            slot = new IntRect();
            effectiveSlots[depth] = slot;
        }
        return slot;
    }

    private void growSlots(int depth) {
        int size = Math.max(depth + 8, ownSlots.length + 8);
        IntRect[] own = new IntRect[size];
        System.arraycopy(ownSlots, 0, own, 0, ownSlots.length);
        IntRect[] effective = new IntRect[size];
        System.arraycopy(effectiveSlots, 0, effective, 0, effectiveSlots.length);
        ownSlots = own;
        effectiveSlots = effective;
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
            boolean hiddenByAncestor,
            @Nullable IntRect inheritedWindow,
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

        // ── 有效可见矩形：沿祖先裁剪链求交 ──
        //
        // 上面那个 getGlobalVisibleRect() **看不见绘制期裁剪**（详见 CollectPolicy 里那段备注），
        // 所以它会把「被 overflow:hidden 裁掉的行」报成完整可见。这里自己算一遍：
        // 窗口从 decorView 矩形开始逐层收紧，谁裁剪谁就把窗口换成自己的有效矩形。
        // 只用纯几何（不叠加 visible / alpha），保持「被裁掉」与「被隐藏」两件事分开。
        IntRect ownRect = ownRectSlot(depth);
        ownRect.set(
                locationScratch[0] - originX,
                locationScratch[1] - originY,
                locationScratch[0] - originX + width,
                locationScratch[1] - originY + height
        );
        IntRect effectiveRect = effectiveRectSlot(depth);
        boolean hasEffectiveRect = CollectPolicy.effectiveVisibleRect(effectiveRect, ownRect, inheritedWindow);
        // 一次问出来，节点字段与子节点窗口用的是同一个结论（父级可以据此收紧子节点的窗口）
        boolean clipsSelf = clipsToBounds(view);

        // 跳过自身时，子树必须挂到**最近的已输出祖先**上。
        // 否则 parentId 会指向一个不存在的节点，Mac 侧的 validateTree 会直接拒收整棵树。
        String effectiveParentId = parentId;

        if (!skipSelf) {
            // hasVisualContent 会读背景、描边、文本颜色，每节点问一次就够；
            // 下面三个值一起决定 layoutOnly / passThrough（详见 CollectPolicy 的那两个纯函数）。
            boolean hasContent = hasVisualContent(view);
            ChildGeometry childGeometry = measureEffectiveChildren(view);
            boolean passThrough = CollectPolicy.isPassThrough(
                    view.getVisibility() == View.VISIBLE && view.getAlpha() > 0.001f,
                    hasContent,
                    childGeometry.count,
                    childGeometry.deltaLeft,
                    childGeometry.deltaTop,
                    childGeometry.deltaWidth,
                    childGeometry.deltaHeight
            );
            boolean layoutOnly = CollectPolicy.isLayoutOnly(hasContent, passThrough, childGeometry.count);

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
                //
                // ⚠️ 这几个字段是**平台**口径，对 RN 的绘制期裁剪（overflow:hidden）恒等于自身矩形，
                // 不要拿它判「屏幕上有没有像素」。要判那个用下面的 effectiveVisible*。
                node.visibleX = visibleRectScratch.left - originX;
                node.visibleY = visibleRectScratch.top - originY;
                node.visibleWidth = visibleRectScratch.width();
                node.visibleHeight = visibleRectScratch.height();
            }
            node.hasEffectiveVisibleRect = hasEffectiveRect;
            if (hasEffectiveRect) {
                node.effectiveVisibleX = effectiveRect.left;
                node.effectiveVisibleY = effectiveRect.top;
                node.effectiveVisibleWidth = effectiveRect.width();
                node.effectiveVisibleHeight = effectiveRect.height();
            }
            // 裁剪链的结论。与平台 clipped 不同源：clipped 比的是「平台可见矩形 vs 自身矩形」，
            // 这两个比的是「沿祖先链求交后 vs 自身矩形」。
            node.clippedByAncestor = CollectPolicy.isClippedByAncestor(ownRect, effectiveRect);
            node.clippedOut = CollectPolicy.isClippedOut(ownRect, effectiveRect);
            node.visible = visible;
            node.attached = view.isAttachedToWindow();
            node.isSvg = isSvgHostView(view);
            node.isImage = isImageHostView(view);
            node.isGradient = isGradientHostView(view);
            node.hasVisualContent = hasContent;
            node.alpha = view.getAlpha();
            node.clickable = view.isClickable();
            node.enabled = view.isEnabled();
            node.scrollX = view.getScrollX();
            node.scrollY = view.getScrollY();
            node.z = view.getZ();
            node.elevation = view.getElevation();
            node.clipsToBounds = clipsSelf;
            node.contentDescription = view.getContentDescription() == null
                    ? null
                    : view.getContentDescription().toString();
            node.nativeTag = view.getId();
            node.source = SourceMarker.fromView(view);
            node.zeroSize = width <= 0 || height <= 0;
            node.outsideVisibleRect = !hasVisibleRect && width > 0 && height > 0;
            node.clipped = hasVisibleRect && (
                    visibleRectScratch.left != locationScratch[0]
                            || visibleRectScratch.top != locationScratch[1]
                            || visibleRectScratch.width() != width
                            || visibleRectScratch.height() != height
            );
            // Keep the node's own visibility separate from effective visibility. Android's
            // alpha/visibility state is not propagated to descendants: an opacity-0 parent can
            // leave a child reporting visible=true even though that child cannot be seen or
            // interacted with. The Mac app uses this bit to close that gap without losing the
            // original native state.
            node.hiddenByAncestor = hiddenByAncestor;

            if (options.includeText && view instanceof TextView) {
                CharSequence text = ((TextView) view).getText();
                if (isSensitiveTextView((TextView) view)) {
                    node.textRedacted = text != null && text.length() > 0;
                    node.text = null;
                } else {
                    node.text = text == null ? null : text.toString();
                }
            }
            // ── 样式：背景 / 边框 / 圆角 / 字体 ──
            //
            // 这一段的**唯一目的**是让右侧信息面板回答「这个元素长得对不对」：在它之前
            // 快照里只有几何与状态位，验收同学点开 App 侧节点看到的永远是「—」，
            // 只能靠人眼看截图比对颜色和字号。
            //
            // 取值细节全在 ViewStyleReader 里（那里要碰 RN 的内部 drawable 与 span，
            // 与采集策略分开才好维护）。这里只负责挂上去。
            //
            // 注意与上面 includeText 的关系：**样式不受 includeText 影响**。文本内容涉及
            // 隐私（密码框要脱敏、source-inspector 档根本不收），而「这个密码框是 14px 常规体」
            // 不涉及 —— 两件事分开，免得为了脱敏把字号也一起丢掉。
            node.style = ViewStyleReader.readBoxStyle(view);
            if (view instanceof TextView) {
                node.textStyle = ViewStyleReader.readTextStyle((TextView) view, scaledDensity);
            }
            // layoutOnly 的语义是**「这个节点既没画东西、也不分发内容」**，即验收里
            // 不该被当成一个独立元素的中间层。判据放在 CollectPolicy 里，与 Mac 侧
            // `core.canonicalize` 的 salience 逐字对齐。
            //
            // ⚠️ 曾经写成 `!hasVisualContent`，那个等式把「有分支的透明容器」也算成了布局：
            // ReactScrollView（360×774，一个子）、ScreenContentStack 这类承载页面结构的容器
            // 全被划走，Mac 侧于是既找不到它们、也不认为它们是结构（实测 App 侧 layoutOnly
            // 311 个 → 应为 191 个）。
            node.passThrough = passThrough;
            node.layoutOnly = layoutOnly;
            node.participation = CollectPolicy.participationOf(
                    node.attached,
                    node.visible && !node.hiddenByAncestor,
                    node.zeroSize,
                    node.layoutOnly
            );
            nodes.add(node);
            effectiveParentId = node.nodeId;
        }

        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            // 子节点的窗口：自身裁剪时收紧成自己的有效矩形，否则原样继承。
            // 收紧用的必须是**有效**矩形而不是布局矩形 —— 一个自己也只露出一角的裁剪容器，
            // 它的子节点不可能比它露得更多。
            IntRect windowForChildren = CollectPolicy.clipWindowForChildren(clipsSelf, effectiveRect, inheritedWindow);
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
                        CollectPolicy.childHiddenByAncestor(hiddenByAncestor, visible),
                        windowForChildren,
                        stats
                );
                if (nodes.size() >= options.maxNodes && childIndex + 1 < group.getChildCount()) {
                    stats.nodeLimitReached = true;
                    break;
                }
            }
        }
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
            // Fresco 系（react-native-fast-image 的 FastImageViewWithUrl → GenericDraweeView）
            // **不走 ImageView.setImageDrawable** —— 它把图交给 DraweeHierarchy，自己重写绘制。
            // 于是 `getDrawable()` 恒为 null，下面那行 drawable 判定对这些视图永远返回 false。
            //
            // 实测代价（真实快照）：`isImage=true` 却有 19 个节点被判「无视觉内容」，
            // 全部是 FastImageViewWithUrl，其中包含首屏 360×288 的大图（面积合计 1.59 屏）；
            // 而走 setImageDrawable 的 RN Image 有 33 个判定正常 —— 同一类语义元素被劈成两拨，
            // 下游「找图片锚点」直接少一半料。所以这里对 Drawee 宿主视图直接认「有内容」。
            //
            // 为什么还要求非零尺寸：Drawee 视图在图片加载失败 / 还没测量时确实什么都不画，
            // 那时它是纯占位，不该冒充图形元素。
            if (isDraweeHostView(view)) {
                return view.getWidth() > 0 && view.getHeight() > 0;
            }
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

    /**
     * 是不是 Fresco / Drawee 系的图片宿主。
     *
     * <p>沿父类链找类名（而不是 {@code instanceof GenericDraweeView}）：SDK 不该在编译期依赖
     * Fresco 的类 —— 宿主 App 用哪个版本的 Fresco、是否开了自定义 DraweeView 子类，
     * 都不该让这个库编不过。类名匹配能覆盖 `SimpleDraweeView` / `GenericDraweeView`
     * 以及 fast-image 自己那层 `FastImageViewWithUrl`。
     */
    private static boolean isDraweeHostView(View view) {
        Class<?> type = view.getClass();
        while (type != null) {
            String name = type.getName();
            if (name.startsWith("com.facebook.drawee.") || name.endsWith(".FastImageViewWithUrl")) {
                return true;
            }
            type = type.getSuperclass();
        }
        return false;
    }

    /**
     * 数一遍「有效子节点」（可见且非零尺寸），顺便量出**唯一那个**子节点相对自身的位置与尺寸差。
     *
     * <p>被过滤的子节点（隐藏 / 零尺寸）不参与：它们分发不了任何内容，一个只有它们的容器
     * 在屏幕上就是空的 —— 那才是纯占位。
     *
     * <p>用 {@code getLeft()/getTop()} 做**相对父节点**的比较，而不是屏幕坐标：这里问的是
     * 「子节点是否恰好铺满父节点」，那是纯布局问题，局部坐标就够，也不受窗口原点与滚动量影响。
     * 有效子节点不是恰好 1 个时，那几个 delta 没有意义，全部置 0（由 count 拦下）。
     */
    private ChildGeometry measureEffectiveChildren(View view) {
        ChildGeometry geometry = new ChildGeometry();
        if (!(view instanceof ViewGroup)) {
            return geometry;
        }
        ViewGroup group = (ViewGroup) view;
        for (int index = 0; index < group.getChildCount(); index++) {
            View child = group.getChildAt(index);
            if (child.getVisibility() != View.VISIBLE || child.getWidth() <= 0 || child.getHeight() <= 0) {
                continue;
            }
            if (geometry.count == 0) {
                geometry.deltaLeft = child.getLeft();
                geometry.deltaTop = child.getTop();
                geometry.deltaWidth = child.getWidth() - view.getWidth();
                geometry.deltaHeight = child.getHeight() - view.getHeight();
            }
            geometry.count++;
        }
        return geometry;
    }

    /** {@link #measureEffectiveChildren} 的结果；不复用可变对象，因为要跨节点返回值 */
    private static final class ChildGeometry {
        int count;
        int deltaLeft;
        int deltaTop;
        int deltaWidth;
        int deltaHeight;
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
