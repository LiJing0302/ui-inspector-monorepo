package com.reactnative.uiacceptance;

import androidx.annotation.Nullable;

/**
 * Minimal JSON writer used by the recorder. Every write method appends a trailing comma so
 * callers can emit fields in a straight line and drop the last comma before closing the object.
 */
final class Json {

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private Json() {
    }

    static void writeString(StringBuilder out, String key, @Nullable String value) {
        out.append('"').append(key).append("\":");
        writeQuoted(out, value);
        out.append(',');
    }

    static void writeQuoted(StringBuilder out, @Nullable String value) {
        if (value == null) {
            out.append("null");
            return;
        }
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                case '\b':
                    out.append("\\b");
                    break;
                case '\f':
                    out.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        out.append("\\u00")
                                .append(HEX[(c >> 4) & 0xF])
                                .append(HEX[c & 0xF]);
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
    }

    static void writeInt(StringBuilder out, String key, int value) {
        out.append('"').append(key).append("\":").append(value).append(',');
    }

    static void writeLong(StringBuilder out, String key, long value) {
        out.append('"').append(key).append("\":").append(value).append(',');
    }

    static void writeBoolean(StringBuilder out, String key, boolean value) {
        out.append('"').append(key).append("\":").append(value).append(',');
    }

    static void writeDouble(StringBuilder out, String key, double value) {
        // NaN and Infinity are not valid JSON, so they are collapsed to zero.
        double safe = (Double.isNaN(value) || Double.isInfinite(value)) ? 0d : value;
        out.append('"').append(key).append("\":").append(safe).append(',');
    }

    /**
     * 可空数值：{@code null} 写成 JSON {@code null}，而不是 0。
     *
     * <p>为什么要单独一个方法：「没读到」和「就是 0」在这里差别很大 —— 圆角 0 是直角，
     * 行高 null 是「RN 没设行高」（TextView 会用字体自带的行距）。两者写成同一个 0，
     * 面板上就没法区分「设计稿要求直角」和「这版 SDK 还没采到圆角」。
     */
    static void writeDoubleOrNull(StringBuilder out, String key, @Nullable Double value) {
        if (value == null) {
            writeNull(out, key);
            return;
        }
        writeDouble(out, key, value);
    }

    /**
     * 开一个嵌套对象。配套 {@link #writeObjectEnd}：中间的字段照常用各 write* 方法写，
     * 它们各自带的尾逗号由 writeObjectEnd 收掉。
     */
    static void writeObjectStart(StringBuilder out, String key) {
        out.append('"').append(key).append("\":{");
    }

    static void writeObjectEnd(StringBuilder out) {
        out.setLength(out.length() - 1);
        out.append("},");
    }

    static void writeNull(StringBuilder out, String key) {
        out.append('"').append(key).append("\":null,");
    }
}
