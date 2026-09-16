package com.reactnative.uiacceptance;

/**
 * 一次节点采集的档位与上限。
 *
 * <p>和 {@link CollectPolicy} 一样，刻意**不依赖 Android / RN**，所以可以在纯 JVM 里构造和
 * 断言（{@code scripts/test-collect-policy.sh}）。
 *
 * <p>从 {@code NodeCollector.Options} 搬出来就是为了这件事：「验收档到底收不收隐藏节点」
 * 应该由一条断言回答，而不是靠人核对 10 个位置参数的顺序。这个类的构造器上一次加参数时，
 * FrameRecorder 的调用点就没跟上、直接编译不过 —— 位置参数本身就是漏改的温床，所以
 * 调用点请一律优先用 {@link #acceptanceDefaults()} / {@link #legacyDefaults()} 这种具名工厂。
 *
 * <p>解析 {@code ReadableMap} 的入口留在 {@link NodeCollector}（那需要 RN 的类），
 * 但**默认值在这里** —— 默认值才是产品语义，覆盖只是例外。
 */
public final class CollectOptions {

    /** 验收全量档。Mac 侧的上传校验只认这个名字，其余一律拒收。 */
    public static final String PROFILE_ACCEPTANCE_FULL = "acceptance-full";
    /** 旧档位：被过滤的节点连同整棵子树一起跳过。Overlay 用它。 */
    public static final String PROFILE_LEGACY = "legacy";
    /** 录制档：只服务于 M0 的耗时测量，不进验收流程。 */
    public static final String PROFILE_RECORDING = "recording";

    public static final int DEFAULT_MAX_DEPTH = 64;
    public static final int DEFAULT_MAX_NODES = 10000;
    public static final long DEFAULT_REFRESH_INTERVAL_MS = 250L;

    /**
     * 验收档上限。真实样本 310 节点 / 深度 7，128 / 30000 是给长列表留的余量。
     *
     * <p>同时也是**所有档位覆盖值的硬上限**：调用方传更大的数会被 clamp 到这里，
     * 免得一个手滑的 {@code maxNodes: 1000000} 把设备端拖死。
     */
    public static final int ACCEPTANCE_MAX_DEPTH = 128;
    public static final int ACCEPTANCE_MAX_NODES = 30000;

    /** 采集档位名。写进 {@code snapshot.collection.profile}，Mac 侧据此拒绝非全量档位。 */
    public final String profileName;
    public final boolean showOverlay;
    public final boolean showLabels;
    public final boolean includeInvisible;
    public final boolean includeZeroSize;
    public final boolean includeText;
    /**
     * 被 includeInvisible / includeZeroSize 过滤掉的节点，是否**继续遍历其子树**。
     *
     * <p>为什么必须是独立开关：验收采集要的是「零尺寸父节点外溢的可见子节点」，
     * 而 Overlay 要的是「别为一个 GONE 的大子树白跑几千次遍历」—— 两者诉求相反，
     * 共用一个布尔值必然要牺牲一边。
     */
    public final boolean descendIntoSkipped;
    public final int maxDepth;
    public final int maxNodes;
    public final long refreshIntervalMs;

    /** 参数顺序与字段声明一致。调用点优先用具名工厂，别手搓这 10 个参数。 */
    public CollectOptions(
            String profileName,
            boolean showOverlay,
            boolean showLabels,
            boolean includeInvisible,
            boolean includeZeroSize,
            boolean includeText,
            boolean descendIntoSkipped,
            int maxDepth,
            int maxNodes,
            long refreshIntervalMs
    ) {
        this.profileName = profileName;
        this.showOverlay = showOverlay;
        this.showLabels = showLabels;
        this.includeInvisible = includeInvisible;
        this.includeZeroSize = includeZeroSize;
        this.includeText = includeText;
        this.descendIntoSkipped = descendIntoSkipped;
        this.maxDepth = maxDepth;
        this.maxNodes = maxNodes;
        this.refreshIntervalMs = refreshIntervalMs;
    }

    /** 旧档默认值：隐藏 / 零尺寸 / 文本都不收，且过滤即剪枝。设备端 Overlay 用它。 */
    public static CollectOptions legacyDefaults() {
        return new CollectOptions(
                PROFILE_LEGACY,
                true,
                false,
                false,
                false,
                false,
                false,
                DEFAULT_MAX_DEPTH,
                DEFAULT_MAX_NODES,
                DEFAULT_REFRESH_INTERVAL_MS
        );
    }

    /**
     * 验收全量档：隐藏 / 零尺寸 / 文本全收，且**被过滤的节点不阻断子树**。
     *
     * <p>最后一条是这次改动的关键：零尺寸父节点外面溢出着可见子节点是真实存在的布局
     * （绝对定位、动画起始态、测量用容器），一旦剪枝就把它们整片丢掉，而它们恰恰是
     * 验收最该看的 —— 过滤的是容器，不是容器里的东西。
     *
     * <p>Overlay 开关保持关：验收采集只取节点树，不该在用户屏幕上留下任何东西。
     */
    public static CollectOptions acceptanceDefaults() {
        return new CollectOptions(
                PROFILE_ACCEPTANCE_FULL,
                false,
                false,
                true,
                true,
                true,
                true,
                ACCEPTANCE_MAX_DEPTH,
                ACCEPTANCE_MAX_NODES,
                DEFAULT_REFRESH_INTERVAL_MS
        );
    }

    /**
     * 录制档：只服务于 M0 的耗时测量（「一次全树遍历到底要多久」），不进验收流程。
     *
     * <p>所以它和旧档一样剪枝、不收隐藏节点 —— 只有剪枝口径和 Overlay 一致，
     * 测出来的耗时才有可比性。
     */
    public static CollectOptions recordingDefaults(boolean includeText, int maxDepth, int maxNodes) {
        return new CollectOptions(
                PROFILE_RECORDING,
                false,
                false,
                false,
                false,
                includeText,
                false,
                maxDepth,
                maxNodes,
                DEFAULT_REFRESH_INTERVAL_MS
        );
    }

    /** 是不是全量验收档。上传前 SDK 侧和 Mac 侧各查一次，两边判据必须同源。 */
    public boolean isAcceptanceProfile() {
        return PROFILE_ACCEPTANCE_FULL.equals(profileName);
    }
}
