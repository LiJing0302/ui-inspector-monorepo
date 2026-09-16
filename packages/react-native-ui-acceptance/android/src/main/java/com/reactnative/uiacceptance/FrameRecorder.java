package com.reactnative.uiacceptance;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Display;
import android.view.View;
import android.view.WindowManager;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.ReadableMap;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.Charset;
import java.util.List;
import java.util.UUID;

/**
 * Captures full snapshots at a fixed frame rate and streams them to a JSONL file.
 *
 * <p>This is the M0 recorder: every frame is a full snapshot, which is deliberately wasteful. It
 * exists to answer one question before any incremental work starts - how long does one full tree
 * walk actually take on a real screen. {@code Result.avgCaptureMs} and {@code Result.maxCaptureMs}
 * are the numbers every later decision depends on.
 *
 * <p>Frames never cross the React bridge. Each snapshot is serialised on the calling thread and
 * appended to the file, so recording cost does not scale with bridge traffic.
 */
public final class FrameRecorder {

    private static final String DIRECTORY_NAME = "ui-acceptance";
    private static final int WRITER_BUFFER_BYTES = 1 << 16;
    private static final int FLUSH_EVERY_FRAMES = 10;

    /** Supplies the foreground Activity. The module owns this because only it can read it. */
    public interface ActivityProvider {
        @Nullable
        Activity get();
    }

    public static final class Config {
        public final int fps;
        public final int maxFrames;
        public final boolean includeText;
        public final int maxDepth;
        public final int maxNodes;

        Config(int fps, int maxFrames, boolean includeText, int maxDepth, int maxNodes) {
            this.fps = fps;
            this.maxFrames = maxFrames;
            this.includeText = includeText;
            this.maxDepth = maxDepth;
            this.maxNodes = maxNodes;
        }

        public static Config from(@Nullable ReadableMap config) {
            if (config == null) {
                return new Config(10, 0, false, CollectOptions.DEFAULT_MAX_DEPTH, CollectOptions.DEFAULT_MAX_NODES);
            }
            return new Config(
                    clampInt(readInt(config, "fps", 10), 1, 60),
                    Math.max(0, readInt(config, "maxFrames", 0)),
                    config.hasKey("includeText") && !config.isNull("includeText") && config.getBoolean("includeText"),
                    clampInt(readInt(config, "maxDepth", CollectOptions.DEFAULT_MAX_DEPTH), 0, 128),
                    clampInt(readInt(config, "maxNodes", CollectOptions.DEFAULT_MAX_NODES), 1, 30000)
            );
        }

        private static int readInt(ReadableMap map, String key, int fallback) {
            return map.hasKey(key) && !map.isNull(key) ? map.getInt(key) : fallback;
        }

        private static int clampInt(int value, int min, int max) {
            return Math.max(min, Math.min(value, max));
        }
    }

    public static final class Result {
        public final String path;
        public final int frameCount;
        public final long byteSize;
        public final long durationMs;
        public final double avgCaptureMs;
        public final double maxCaptureMs;

        Result(String path, int frameCount, long byteSize, long durationMs, double avgCaptureMs, double maxCaptureMs) {
            this.path = path;
            this.frameCount = frameCount;
            this.byteSize = byteSize;
            this.durationMs = durationMs;
            this.avgCaptureMs = avgCaptureMs;
            this.maxCaptureMs = maxCaptureMs;
        }
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final NodeCollector collector = new NodeCollector();

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            captureFrame();
        }
    };

    @Nullable
    private ActivityProvider activityProvider;
    @Nullable
    private Config config;
    @Nullable
    private CollectOptions nodeOptions;
    @Nullable
    private File file;
    @Nullable
    private Writer writer;

    private boolean running;
    private int frameIndex;
    private long intervalMs;
    private long startElapsedNanos;
    private long startWallClockMs;
    private long captureNsTotal;
    private long captureNsMax;

    public boolean isRunning() {
        return running;
    }

    public boolean start(@NonNull Context context, @NonNull ActivityProvider provider, @NonNull Config config)
            throws IOException {
        if (running) {
            return false;
        }

        this.activityProvider = provider;
        this.config = config;
        this.nodeOptions = CollectOptions.recordingDefaults(
                config.includeText,
                config.maxDepth,
                config.maxNodes
        );

        File directory = new File(context.getFilesDir(), DIRECTORY_NAME);
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Unable to create recording directory: " + directory.getAbsolutePath());
        }

        this.file = new File(directory, UUID.randomUUID().toString() + ".jsonl");
        this.writer = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(this.file), Charset.forName("UTF-8")),
                WRITER_BUFFER_BYTES
        );

        this.frameIndex = 0;
        this.intervalMs = 1000L / config.fps;
        this.startElapsedNanos = SystemClock.elapsedRealtimeNanos();
        this.startWallClockMs = System.currentTimeMillis();
        this.captureNsTotal = 0L;
        this.captureNsMax = 0L;

        Activity activity = provider.get();
        writeMeta(context, activity);

        this.running = true;
        mainHandler.post(tick);
        return true;
    }

    /**
     * Stops the recorder and closes the file. Returns null when nothing was recording, so callers
     * can distinguish "no session" from "session produced zero frames".
     */
    @Nullable
    public Result finish() {
        if (!running) {
            return null;
        }
        running = false;
        mainHandler.removeCallbacks(tick);

        long durationMs = System.currentTimeMillis() - startWallClockMs;
        Writer currentWriter = writer;
        File currentFile = file;
        writer = null;

        if (currentWriter != null) {
            try {
                currentWriter.flush();
            } catch (IOException ignored) {
                // Keep whatever landed on disk before the failure.
            }
            try {
                currentWriter.close();
            } catch (IOException ignored) {
                // Nothing actionable here, the file is already closed from our side.
            }
        }

        Result result = new Result(
                currentFile == null ? "" : currentFile.getAbsolutePath(),
                frameIndex,
                currentFile == null ? 0L : currentFile.length(),
                durationMs,
                frameIndex == 0 ? 0d : (captureNsTotal / 1_000_000d) / frameIndex,
                captureNsMax / 1_000_000d
        );
        file = null;
        return result;
    }

    private void captureFrame() {
        if (!running) {
            return;
        }

        ActivityProvider provider = activityProvider;
        Activity activity = provider == null ? null : provider.get();
        if (activity == null || activity.getWindow() == null) {
            // No foreground window right now. Skip this slot and stay on schedule.
            scheduleNextFrame();
            return;
        }

        CollectOptions options = nodeOptions;
        if (options == null) {
            finish();
            return;
        }

        long startedNanos = System.nanoTime();
        List<NativeNode> nodes = collector.collect(activity, options, null);
        long captureNanos = System.nanoTime() - startedNanos;

        captureNsTotal += captureNanos;
        if (captureNanos > captureNsMax) {
            captureNsMax = captureNanos;
        }

        try {
            writeFrame(activity, nodes, captureNanos);
        } catch (IOException error) {
            finish();
            return;
        }

        frameIndex++;

        Config currentConfig = config;
        if (currentConfig != null && currentConfig.maxFrames > 0 && frameIndex >= currentConfig.maxFrames) {
            finish();
            return;
        }

        scheduleNextFrame();
    }

    /**
     * Derives the delay from the recording start time rather than chaining off the previous tick,
     * so a slow frame does not push every later frame further out.
     */
    private void scheduleNextFrame() {
        long elapsed = System.currentTimeMillis() - startWallClockMs;
        long target = (frameIndex + 1) * intervalMs;
        mainHandler.postDelayed(tick, Math.max(0L, target - elapsed));
    }

    private void writeMeta(@NonNull Context context, @Nullable Activity activity) throws IOException {
        Writer currentWriter = writer;
        if (currentWriter == null) {
            return;
        }

        StringBuilder out = new StringBuilder(512);
        out.append("{\"type\":4,\"data\":{");
        Json.writeString(out, "format", "ui-acceptance-jsonl-v1");
        Json.writeString(out, "platform", "android");
        Json.writeString(out, "source", "android-view-tree");
        Json.writeLong(out, "startElapsedNanos", startElapsedNanos);
        Json.writeLong(out, "startWallClockMs", startWallClockMs);
        Json.writeInt(out, "targetFps", config == null ? 0 : config.fps);
        Json.writeDouble(out, "density", context.getResources().getDisplayMetrics().density);
        Json.writeDouble(out, "refreshRateHz", readRefreshRateHz(context));
        if (activity != null && activity.getWindow() != null) {
            View decor = activity.getWindow().getDecorView();
            Json.writeInt(out, "windowWidth", decor.getWidth());
            Json.writeInt(out, "windowHeight", decor.getHeight());
        }
        out.setLength(out.length() - 1);
        out.append("}}\n");
        currentWriter.write(out.toString());
    }

    private void writeFrame(@NonNull Activity activity, List<NativeNode> nodes, long captureNanos)
            throws IOException {
        Writer currentWriter = writer;
        if (currentWriter == null) {
            return;
        }

        View decor = activity.getWindow().getDecorView();
        StringBuilder out = new StringBuilder(1 << 14);
        out.append("{\"type\":2,\"frame\":").append(frameIndex)
                .append(",\"elapsedNanos\":").append(SystemClock.elapsedRealtimeNanos() - startElapsedNanos)
                .append(",\"wallClockMs\":").append(System.currentTimeMillis())
                .append(",\"captureMs\":").append(captureNanos / 1_000_000d)
                .append(",\"data\":{");
        Json.writeInt(out, "nodeCount", nodes.size());
        Json.writeInt(out, "windowWidth", decor.getWidth());
        Json.writeInt(out, "windowHeight", decor.getHeight());
        out.append("\"nodes\":[");
        for (int index = 0; index < nodes.size(); index++) {
            if (index > 0) {
                out.append(',');
            }
            nodes.get(index).writeJson(out);
        }
        out.append("]}}\n");
        currentWriter.write(out.toString());

        if (frameIndex % FLUSH_EVERY_FRAMES == 0) {
            currentWriter.flush();
        }
    }

    @SuppressWarnings("deprecation")
    private static float readRefreshRateHz(@NonNull Context context) {
        try {
            WindowManager windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
            if (windowManager == null) {
                return 0f;
            }
            Display display = windowManager.getDefaultDisplay();
            return display == null ? 0f : display.getRefreshRate();
        } catch (Exception ignored) {
            return 0f;
        }
    }
}
