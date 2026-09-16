package com.reactnative.uiacceptance;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Build;
import android.os.Handler;
import android.util.Base64;
import android.view.PixelCopy;
import android.view.View;

import androidx.annotation.NonNull;

import java.io.ByteArrayOutputStream;

/**
 * 把当前窗口截成一张 PNG。
 *
 * <p>为什么由 SDK 截图，而不是让 Mac 用 adb screencap：
 * 节点树是 SDK 采的、截图原来是 Mac 采的，两条通道各有各的延迟，只能靠 captureId 事后配对。
 * 稍微慢一拍就会得到「节点是这一屏、图是下一屏」——那种错位在验收画布上看起来像「开发写歪了」。
 * 放进同一次调用后，两者天然是同一帧。
 *
 * <p>为什么用 PixelCopy 而不是 {@code decorView.draw(canvas)}：
 * {@code draw()} 走的是软件绘制，拿不到 {@code SurfaceView} / 纹理层的内容，
 * 页面里嵌了视频或地图就会是一块空白，且不会反映硬件合成结果。
 * PixelCopy 读的是合成后的窗口，与用户眼睛看到的一致。代价是它只在 API 26+ 可用，
 * 更低版本退回 {@code draw()}（minSdk 是 24，只影响两个大版本）。
 *
 * <p>尺寸口径：截出来的是**窗口**尺寸，与 {@code NodeCollector} 归一化后的节点坐标同处一个空间
 * （见 {@code NodeCollector} 里对窗口原点的处理）。两者必须同口径，否则画布上节点层与底图会整体错位。
 */
public final class ScreenshotCaptor {

    /**
     * PNG 字节上限，与 Mac 侧 {@code decodeScreenshot} 的 24MB 对齐。
     *
     * <p>在这里就拦下来：让手机上先拿到一条明确的错误，而不是把几 MB 的 base64 传上去之后
     * 被服务端拒收 —— 那时用户已经等了十几秒，却只看到一句「上传失败」。
     */
    private static final int MAX_PNG_BYTES = 24 * 1024 * 1024;

    public interface Callback {
        void onCaptured(@NonNull Bitmap bitmap);

        void onFailed(@NonNull Exception error);
    }

    private ScreenshotCaptor() {
    }

    /**
     * 异步截图。回调一定在 `handler` 所属线程调用，且只会调用其中**一个**方法。
     *
     * <p>不在失败时回退到 {@code draw()}：PixelCopy 失败通常意味着窗口不可见或带
     * {@code FLAG_SECURE}，此时 {@code draw()} 只会产出一张内容不对的图 ——
     * 一张「看起来成功」的错图比一次失败危险得多。
     */
    public static void capture(
            @NonNull Activity activity,
            @NonNull Handler handler,
            @NonNull Callback callback
    ) {
        View decorView = activity.getWindow().getDecorView();
        int width = decorView.getWidth();
        int height = decorView.getHeight();
        if (width <= 0 || height <= 0) {
            callback.onFailed(new IllegalStateException("窗口尺寸为 0，页面还没完成布局"));
            return;
        }

        Bitmap bitmap;
        try {
            bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        } catch (OutOfMemoryError error) {
            callback.onFailed(new IllegalStateException("截图分配内存失败：" + error.getMessage()));
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            try {
                callback.onCaptured(drawWindow(decorView, bitmap));
            } catch (Exception error) {
                callback.onFailed(error);
            }
            return;
        }

        try {
            PixelCopy.request(
                    activity.getWindow(),
                    bitmap,
                    result -> {
                        if (result == PixelCopy.SUCCESS) {
                            callback.onCaptured(bitmap);
                        } else {
                            bitmap.recycle();
                            callback.onFailed(new IllegalStateException("PixelCopy 截图失败，code=" + result));
                        }
                    },
                    handler
            );
        } catch (Exception error) {
            bitmap.recycle();
            callback.onFailed(error);
        }
    }

    /**
     * API 26 以下的退路：软件绘制整个 decorView。
     *
     * <p>先铺一层不透明白底再画。{@code draw()} 不会替我们补背景，
     * 透明像素编码成 PNG 后是「空洞」——叠在设计稿上会露出画布底色，看起来像整页错位。
     */
    private static Bitmap drawWindow(@NonNull View decorView, @NonNull Bitmap target) {
        Canvas canvas = new Canvas(target);
        canvas.drawColor(android.graphics.Color.WHITE);
        decorView.draw(canvas);
        return target;
    }

    /**
     * 编码成标准 base64（{@code NO_WRAP}，不带 {@code data:} 前缀）。
     *
     * <p>Mac 侧对 base64 字母表是**逐字符**校验的（{@code Buffer.from} 会静默丢弃非法字符，
     * 于是「半个字节流」也能解出点东西来）。所以这里必须用 NO_WRAP ——
     * 默认的换行填充会让校验在第一行就失败。
     */
    @NonNull
    public static String toBase64Png(@NonNull Bitmap bitmap) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
            throw new IllegalStateException("PNG 编码失败");
        }
        byte[] bytes = out.toByteArray();
        if (bytes.length == 0) {
            throw new IllegalStateException("PNG 编码结果为空");
        }
        if (bytes.length > MAX_PNG_BYTES) {
            throw new IllegalStateException(
                    "截图 " + bytes.length + " 字节，超过 " + MAX_PNG_BYTES + " 字节上限"
            );
        }
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }
}
