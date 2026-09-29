package com.reactnative.uiacceptance;

/**
 * 与 Android / RN 无关的整数矩形（窗口坐标系，单位 px）。
 *
 * <p>为什么不直接用 {@code android.graphics.Rect}：有效可见矩形那条求交链
 * （{@link CollectPolicy#effectiveVisibleRect}）是**验收输入门禁的判据** —— 它错了既不抛异常也不报错，
 * 只会让「屏幕上根本没有像素」的节点以正常元素的身份混进匹配，最后在验收画布上表现为
 * 「一堆不可见的元素被框了出来」。所以它必须能被 {@code scripts/test-collect-policy.sh}
 * 在纯 JVM 里断言；一旦签名里出现 {@code android.graphics.Rect}，这个测试就得先凑齐
 * android.jar + react-android aar，3 秒的反馈回路立刻变成几分钟。
 *
 * <p><b>可变对象</b>：采集时每层深度复用一个实例（见 {@link NodeCollector} 的槽位数组），
 * 一次全树遍历不会为几何计算分配任何对象。
 *
 * <p>区间语义与 Android 一致：面积 = (right - left) × (bottom - top)，空矩形是
 * {@code right <= left} 或 {@code bottom <= top}。注意「空」不等于「坐标全为 0」——
 * 求交之后的空矩形会保留交点处的坐标。
 */
public final class IntRect {

    public int left;
    public int top;
    public int right;
    public int bottom;

    public void set(int left, int top, int right, int bottom) {
        this.left = left;
        this.top = top;
        this.right = right;
        this.bottom = bottom;
    }

    public void copyFrom(IntRect other) {
        this.left = other.left;
        this.top = other.top;
        this.right = other.right;
        this.bottom = other.bottom;
    }

    /** 零面积或负面积。 */
    public boolean isEmpty() {
        return right <= left || bottom <= top;
    }

    public int width() {
        return right - left;
    }

    public int height() {
        return bottom - top;
    }

    /** 与另一个矩形**完全等价**（含负面积情形下的坐标一致性）。 */
    public boolean sameAs(IntRect other) {
        return left == other.left && top == other.top && right == other.right && bottom == other.bottom;
    }

    @Override
    public String toString() {
        return "(" + left + "," + top + "," + right + "," + bottom + ")";
    }
}
