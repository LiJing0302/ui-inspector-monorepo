package com.reactnative.uiacceptance;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.uimanager.UIManagerModule;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Native-only layout inspector. It deliberately walks Android's View tree instead of
 * depending on React's JS tree or private Fabric internals.
 */
public class UiAcceptanceModule extends ReactContextBaseJavaModule {

    private static final String MODULE_NAME = "UiAcceptanceModule";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final NodeCollector collector = new NodeCollector();
    private final FrameRecorder recorder = new FrameRecorder();

    private final Runnable overlayRefreshTask = new Runnable() {
        @Override
        public void run() {
            if (overlayView == null) {
                return;
            }
            refreshOverlay();
            mainHandler.postDelayed(this, overlayOptions.refreshIntervalMs);
        }
    };

    /**
     * 三份配置**刻意分开存**：
     * Overlay 走轻量档（跳过隐藏/零尺寸子树、不含文本），验收采集走全量档，
     * 录制走自己的帧率配置。共用一份字段时，改 Overlay 的显示参数会静默削弱验收采集 ——
     * 那种故障不会报错，只会让验收结论少几个节点。
     */
    private CollectOptions overlayOptions = CollectOptions.legacyDefaults();
    private FrameRecorder.Config recordingConfig = FrameRecorder.Config.from(null);
    private BoundsOverlayView overlayView;
    private InspectorOverlayView inspectorOverlayView;

    public UiAcceptanceModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @NonNull
    @Override
    public String getName() {
        return MODULE_NAME;
    }

    @ReactMethod
    public void start(@Nullable ReadableMap config, @NonNull Promise promise) {
        mainHandler.post(() -> {
            try {
                overlayOptions = NodeCollector.optionsFrom(config);
                Activity activity = getCurrentActivity();
                if (activity == null || activity.getWindow() == null) {
                    promise.reject("UI_ACCEPTANCE_NO_ACTIVITY", "No foreground Activity is available");
                    return;
                }

                if (overlayOptions.showOverlay) {
                    attachOverlay(activity);
                    refreshOverlay();
                    mainHandler.removeCallbacks(overlayRefreshTask);
                    mainHandler.postDelayed(overlayRefreshTask, overlayOptions.refreshIntervalMs);
                } else {
                    removeOverlay();
                }
                promise.resolve(true);
            } catch (Exception error) {
                promise.reject("UI_ACCEPTANCE_START_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void stop(@NonNull Promise promise) {
        mainHandler.post(() -> {
            removeOverlay();
            promise.resolve(true);
        });
    }

    /** Resolve React tags on Android and draw their current bounds in native pixel space. */
    @ReactMethod
    public void setInspectorHighlights(@Nullable ReadableArray nativeTags) {
        mainHandler.post(() -> {
            Activity activity = getCurrentActivity();
            if (activity == null || activity.getWindow() == null) return;
            if (nativeTags == null || nativeTags.size() == 0) {
                clearInspectorHighlightsOnMain();
                return;
            }
            View decorView = activity.getWindow().getDecorView();
            if (!(decorView instanceof ViewGroup)) return;
            ViewGroup decor = (ViewGroup) decorView;
            if (inspectorOverlayView == null || inspectorOverlayView.getParent() != decor) {
                clearInspectorHighlightsOnMain();
                inspectorOverlayView = new InspectorOverlayView(activity);
                decor.addView(inspectorOverlayView, new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                ));
            }

            UIManagerModule uiManager = getReactApplicationContext().getNativeModule(UIManagerModule.class);
            if (uiManager == null) return;
            List<View> views = new ArrayList<>();
            for (int index = 0; index < nativeTags.size(); index++) {
                int tag = nativeTags.getInt(index);
                try {
                    View view = uiManager.resolveView(tag);
                    if (view == null || view.getVisibility() != View.VISIBLE || view.getWidth() <= 0 || view.getHeight() <= 0) {
                        continue;
                    }
                    views.add(view);
                } catch (RuntimeException ignored) {
                    // A tag can disappear between a Fiber commit and this main-thread pass.
                }
            }
            inspectorOverlayView.bringToFront();
            inspectorOverlayView.setViews(views);
        });
    }

    @ReactMethod
    public void clearInspectorHighlights() {
        mainHandler.post(this::clearInspectorHighlightsOnMain);
    }

    private void clearInspectorHighlightsOnMain() {
        if (inspectorOverlayView != null) {
            if (inspectorOverlayView.getParent() instanceof ViewGroup) {
                ((ViewGroup) inspectorOverlayView.getParent()).removeView(inspectorOverlayView);
            }
            inspectorOverlayView = null;
        }
    }

    @ReactMethod
    public void capture(@Nullable ReadableMap config, @NonNull Promise promise) {
        mainHandler.post(() -> {
            try {
                Activity activity = getCurrentActivity();
                if (activity == null || activity.getWindow() == null) {
                    promise.reject("UI_ACCEPTANCE_NO_ACTIVITY", "No foreground Activity is available");
                    return;
                }
                promise.resolve(captureSnapshot(activity, captureOptionsFor(config)));
            } catch (Exception error) {
                promise.reject("UI_ACCEPTANCE_CAPTURE_FAILED", error.getMessage(), error);
            }
        });
    }

    /**
     * capture() 的档位选择。
     *
     * <p>默认**一定是验收全量档**：`config == null`、`config` 为空 map、或显式写
     * `profile: "acceptance-full"` 都走全量。只有调用方显式写了一个非全量的 profile，
     * 才退回轻量档 —— 并且在 collection.profile 里如实标成 "legacy"，
     * 让 Mac 侧的门禁能据此拒绝，而不是让一份缺字段的树被当成有效输入。
     *
     * <p>反面教材是「传了不含 profile 的 config 就静默退回轻量档」：
     * 那种写法不会报错，只会让验收结果少几个节点、少一段文本。
     */
    private static CollectOptions captureOptionsFor(@Nullable ReadableMap config) {
        if (config == null) {
            return CollectOptions.acceptanceDefaults();
        }
        if (!config.hasKey("profile") || config.isNull("profile")) {
            return NodeCollector.acceptanceOptionsFrom(config);
        }
        String profile = config.getString("profile");
        return CollectOptions.PROFILE_ACCEPTANCE_FULL.equals(profile)
                ? NodeCollector.acceptanceOptionsFrom(config)
                : NodeCollector.optionsFrom(config);
    }

    /**
     * 一次调用同时拿到**同一帧**的节点树与截图。
     *
     * <p>为什么不做成「先 capture() 再 captureScreenshot()」两个方法：那样调用方必然要发两次
     * JS→Java 的往返，中间还夹着一次 React 渲染。页面在这段时间里翻页、弹窗、跑马灯都可能变化，
     * 于是「节点是这一屏、图是下一屏」——在验收画布上表现为节点层与底图整体错位。
     * 放在一次调用里，两者之间只隔一次 PixelCopy 请求。
     *
     * <p>顺序是**先采树后截图**：PixelCopy 是异步的（请求发出后要等下一帧合成），
     * 而采树是同步的。先同步采树、再发起异步截图，两者各自都最贴近「用户按下按钮的那一刻」。
     *
     * <p>SDK 自己的调试浮层（bounds overlay）在这期间会被隐藏：它画的是节点边框，
     * 落在截图里会变成一堆设计稿上不存在的线，直接被验收判成差异。
     */
    @ReactMethod
    public void captureBundle(@Nullable ReadableMap config, @NonNull Promise promise) {
        mainHandler.post(() -> {
            try {
                Activity activity = getCurrentActivity();
                if (activity == null || activity.getWindow() == null) {
                    promise.reject("UI_ACCEPTANCE_NO_ACTIVITY", "No foreground Activity is available");
                    return;
                }
                CollectOptions options = captureOptionsFor(config);
                runOverlayHidden(() -> {
                    WritableMap snapshot;
                    try {
                        snapshot = captureSnapshot(activity, options);
                    } catch (Exception error) {
                        overlayVisibleAfterCapture();
                        promise.reject("UI_ACCEPTANCE_CAPTURE_FAILED", error.getMessage(), error);
                        return;
                    }

                    ScreenshotCaptor.capture(activity, mainHandler, new ScreenshotCaptor.Callback() {
                        @Override
                        public void onCaptured(@NonNull android.graphics.Bitmap bitmap) {
                            overlayVisibleAfterCapture();
                            WritableMap screenshot = Arguments.createMap();
                            screenshot.putString("mimeType", "image/png");
                            screenshot.putInt("width", bitmap.getWidth());
                            screenshot.putInt("height", bitmap.getHeight());
                            try {
                                screenshot.putString("base64", ScreenshotCaptor.toBase64Png(bitmap));
                            } catch (Exception error) {
                                promise.reject(
                                        "UI_ACCEPTANCE_SCREENSHOT_ENCODE_FAILED",
                                        error.getMessage(),
                                        error
                                );
                                return;
                            } finally {
                                bitmap.recycle();
                            }
                            WritableMap result = Arguments.createMap();
                            result.putMap("snapshot", snapshot);
                            result.putMap("screenshot", screenshot);
                            promise.resolve(result);
                        }

                        @Override
                        public void onFailed(@NonNull Exception error) {
                            overlayVisibleAfterCapture();
                            promise.reject("UI_ACCEPTANCE_SCREENSHOT_FAILED", error.getMessage(), error);
                        }
                    });
                });
            } catch (Exception error) {
                overlayVisibleAfterCapture();
                promise.reject("UI_ACCEPTANCE_CAPTURE_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void startRecording(@Nullable ReadableMap config, @NonNull Promise promise) {
        mainHandler.post(() -> {
            try {
                recordingConfig = FrameRecorder.Config.from(config);
                boolean started = recorder.start(
                        getReactApplicationContext(),
                        this::getCurrentActivity,
                        recordingConfig
                );
                promise.resolve(started);
            } catch (IOException error) {
                promise.reject("UI_ACCEPTANCE_RECORD_IO_FAILED", error.getMessage(), error);
            } catch (Exception error) {
                promise.reject("UI_ACCEPTANCE_RECORD_START_FAILED", error.getMessage(), error);
            }
        });
    }

    @ReactMethod
    public void stopRecording(@NonNull Promise promise) {
        mainHandler.post(() -> {
            FrameRecorder.Result result = recorder.finish();
            if (result == null) {
                promise.reject("UI_ACCEPTANCE_NOT_RECORDING", "No recording is in progress");
                return;
            }
            promise.resolve(resultToWritableMap(result));
        });
    }

    @ReactMethod
    public void isRecording(@NonNull Promise promise) {
        promise.resolve(recorder.isRunning());
    }

    @Override
    public void onCatalystInstanceDestroy() {
        mainHandler.post(() -> {
            recorder.finish();
            removeOverlay();
            clearInspectorHighlightsOnMain();
        });
        super.onCatalystInstanceDestroy();
    }

    private void attachOverlay(Activity activity) {
        View decorView = activity.getWindow().getDecorView();
        if (!(decorView instanceof ViewGroup)) {
            throw new IllegalStateException("Activity decor view is not a ViewGroup");
        }

        ViewGroup decor = (ViewGroup) decorView;
        if (overlayView != null && overlayView.getParent() != decor) {
            removeOverlay();
        }
        if (overlayView == null) {
            overlayView = new BoundsOverlayView(activity);
            overlayView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            decor.addView(overlayView, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
            ));
        }
        overlayView.setOptions(overlayOptions);
        overlayView.bringToFront();
    }

    private void removeOverlay() {
        mainHandler.removeCallbacks(overlayRefreshTask);
        if (overlayView != null) {
            if (overlayView.getParent() instanceof ViewGroup) {
                ((ViewGroup) overlayView.getParent()).removeView(overlayView);
            }
            overlayView = null;
        }
    }

    private void refreshOverlay() {
        Activity activity = getCurrentActivity();
        if (activity == null || activity.getWindow() == null || overlayView == null) {
            return;
        }
        List<NativeNode> nodes = collector.collect(activity, overlayOptions, overlayView);
        overlayView.setNodes(nodes);
    }

    /** {@code captureBundle} 期间是否由我们把调试浮层藏了起来（只有藏过才需要恢复）。 */
    private boolean overlayHiddenForCapture = false;

    /**
     * 在调试浮层不可见的前提下执行一次采集。
     *
     * <p>藏的时机很讲究：改 {@code setVisibility} 只改状态，真正生效要等这一帧走完绘制。
     * 所以这里用**两次** {@code postOnAnimation} —— 第一次落在「INVISIBLE 已被绘制」的那一帧，
     * 第二次才真正开始截图。少等一次的话，PixelCopy 有机会把浮层边框一起合成进去。
     */
    private void runOverlayHidden(@NonNull Runnable action) {
        if (overlayView == null || overlayView.getVisibility() != View.VISIBLE) {
            action.run();
            return;
        }
        overlayView.setVisibility(View.INVISIBLE);
        overlayHiddenForCapture = true;
        overlayView.postOnAnimation(() -> overlayView.postOnAnimation(action));
    }

    /**
     * 恢复调试浮层。
     *
     * <p>放在 Promise 落定之后调用而不是 {@code finally} 里：PixelCopy 的结果是异步回来的，
     * 提前恢复会让「下一帧合成」把浮层重新画回截图里。
     */
    private void overlayVisibleAfterCapture() {
        if (overlayHiddenForCapture && overlayView != null) {
            overlayView.setVisibility(View.VISIBLE);
        }
        overlayHiddenForCapture = false;
    }

    private WritableMap captureSnapshot(Activity activity, CollectOptions captureOptions) {
        long startedNanos = System.nanoTime();
        NodeCollector.CollectResult result = collector.collectDetailed(activity, captureOptions, overlayView);
        List<NativeNode> nodes = result.nodes;
        long captureNanos = System.nanoTime() - startedNanos;

        WritableMap snapshot = Arguments.createMap();
        snapshot.putString("platform", "android");
        snapshot.putString("source", "react-native-ui-acceptance");
        snapshot.putDouble("timestamp", (double) System.currentTimeMillis());
        snapshot.putDouble("captureDurationMs", captureNanos / 1_000_000d);
        snapshot.putInt("nodeCount", nodes.size());
        snapshot.putInt("windowWidth", activity.getWindow().getDecorView().getWidth());
        snapshot.putInt("windowHeight", activity.getWindow().getDecorView().getHeight());
        snapshot.putDouble("density", activity.getResources().getDisplayMetrics().density);
        snapshot.putDouble("densityDpi", activity.getResources().getDisplayMetrics().densityDpi);
        snapshot.putDouble("scaledDensity", activity.getResources().getDisplayMetrics().scaledDensity);
        // 机型与包名以前是 Mac 侧用 adb（dumpsys window）问系统要的。采集改由 SDK 自己上传后
        // adb 整条链路退出验收路径，设备信息只能由采集方如实上报 —— 少了它们，
        // 需求里那堆截图就只能显示成「Android 截图」，无法区分是哪台机器跑的。
        snapshot.putString("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
        snapshot.putString("packageName", activity.getPackageName());

        WritableMap collection = Arguments.createMap();
        collection.putString("profile", captureOptions.profileName);
        collection.putInt("requestedMaxDepth", captureOptions.maxDepth);
        collection.putInt("requestedMaxNodes", captureOptions.maxNodes);
        collection.putInt("actualDepth", result.actualDepth);
        collection.putInt("actualNodeCount", nodes.size());
        collection.putBoolean("depthLimitReached", result.depthLimitReached);
        collection.putBoolean("nodeLimitReached", result.nodeLimitReached);
        collection.putBoolean("hiddenNodesIncluded", captureOptions.includeInvisible);
        collection.putBoolean("zeroSizeNodesIncluded", captureOptions.includeZeroSize);
        collection.putBoolean("textIncluded", captureOptions.includeText);
        WritableArray excluded = Arguments.createArray();
        if (overlayView != null) {
            WritableMap overlay = Arguments.createMap();
            overlay.putString("reason", "sdk-overlay");
            overlay.putInt("count", 1);
            excluded.pushMap(overlay);
        }
        collection.putArray("excludedNodes", excluded);
        snapshot.putMap("collection", collection);

        WritableArray nodeArray = Arguments.createArray();
        for (NativeNode node : nodes) {
            nodeArray.pushMap(node.toWritableMap());
        }
        snapshot.putArray("nodes", nodeArray);
        return snapshot;
    }

    private static WritableMap resultToWritableMap(FrameRecorder.Result result) {
        WritableMap map = Arguments.createMap();
        map.putString("path", result.path);
        map.putInt("frameCount", result.frameCount);
        map.putDouble("byteSize", (double) result.byteSize);
        map.putDouble("durationMs", (double) result.durationMs);
        map.putDouble("avgCaptureMs", result.avgCaptureMs);
        map.putDouble("maxCaptureMs", result.maxCaptureMs);
        return map;
    }

    private static final class BoundsOverlayView extends View {
        private final Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private List<NativeNode> nodes = new ArrayList<>();
        private CollectOptions options = CollectOptions.legacyDefaults();

        BoundsOverlayView(@NonNull android.content.Context context) {
            super(context);
            setWillNotDraw(false);
            setClickable(false);
            setFocusable(false);
            borderPaint.setStyle(Paint.Style.STROKE);
            borderPaint.setStrokeWidth(getResources().getDisplayMetrics().density);
            labelPaint.setStyle(Paint.Style.FILL);
            labelPaint.setTextSize(10 * getResources().getDisplayMetrics().scaledDensity);
            labelPaint.setColor(Color.rgb(20, 20, 20));
        }

        void setOptions(CollectOptions value) {
            options = value;
            invalidate();
        }

        void setNodes(List<NativeNode> value) {
            nodes = value;
            invalidate();
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            super.onDraw(canvas);
            float density = getResources().getDisplayMetrics().density;
            // 节点坐标已由 NodeCollector 归一到**窗口**空间，而本视图是 decorView 的满尺寸子视图，
            // 两者同处一个空间 —— 直接按 node.x 绘制即可。这里再减一次
            // `getLocationOnScreen` 的话，非 edge-to-edge 的机器上整层会被推上去一条状态栏。
            for (NativeNode node : nodes) {
                float left = node.x;
                float top = node.y;
                RectF rect = new RectF(left, top, left + node.width, top + node.height);
                float hue = (node.depth * 37) % 360;
                borderPaint.setColor(Color.HSVToColor(190, new float[]{hue, 0.85f, 0.95f}));
                canvas.drawRect(rect, borderPaint);
                if (options.showLabels && node.width > 16 * density && node.height > 12 * density) {
                    String label = node.className.substring(node.className.lastIndexOf('.') + 1)
                            + " " + node.width + "x" + node.height;
                    canvas.drawText(label, left + 2 * density, top + 11 * density, labelPaint);
                }
            }
        }

        @Override
        public boolean onTouchEvent(android.view.MotionEvent event) {
            return false;
        }
    }
}
