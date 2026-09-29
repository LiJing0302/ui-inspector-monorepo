package com.reactnative.uiacceptance;

import androidx.annotation.Nullable;

import android.net.Uri;
import android.view.View;

/** Source metadata encoded by the Babel plugin into React Native's nativeID view tag. */
public final class SourceMarker {

    public static final String PREFIX = "__uii_v1|";
    private static int nativeIdTagResourceId;

    public final String projectRootHash;
    public final String sourceId;
    public final int startLine;
    public final int startColumn;
    public final int endLine;
    public final int endColumn;
    public final String role;
    public final String displayName;
    public final String relativePath;

    private SourceMarker(
            String projectRootHash,
            String sourceId,
            int startLine,
            int startColumn,
            int endLine,
            int endColumn,
            String role,
            String displayName,
            String relativePath
    ) {
        this.projectRootHash = projectRootHash;
        this.sourceId = sourceId;
        this.startLine = startLine;
        this.startColumn = startColumn;
        this.endLine = endLine;
        this.endColumn = endColumn;
        this.role = role;
        this.displayName = displayName;
        this.relativePath = relativePath;
    }

    @Nullable
    public static SourceMarker parse(@Nullable Object value) {
        if (!(value instanceof String) || !((String) value).startsWith(PREFIX)) return null;
        String[] fields = ((String) value).substring(PREFIX.length()).split("\\|", -1);
        if (fields.length != 9) return null;
        try {
            int startLine = Integer.parseInt(fields[2]);
            int startColumn = Integer.parseInt(fields[3]);
            int endLine = Integer.parseInt(fields[4]);
            int endColumn = Integer.parseInt(fields[5]);
            if (fields[0].isEmpty() || fields[1].isEmpty() || startLine <= 0 || startColumn <= 0 ||
                    endLine <= 0 || endColumn <= 0) return null;
            return new SourceMarker(
                    fields[0],
                    fields[1],
                    startLine,
                    startColumn,
                    endLine,
                    endColumn,
                    fields[6],
                    decode(fields[7]),
                    decode(fields[8])
            );
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    @Nullable
    public static SourceMarker fromView(View view) {
        if (nativeIdTagResourceId == 0) {
            nativeIdTagResourceId = view.getResources().getIdentifier(
                    "view_tag_native_id",
                    "id",
                    view.getContext().getPackageName()
            );
        }
        return nativeIdTagResourceId == 0 ? null : parse(view.getTag(nativeIdTagResourceId));
    }

    public boolean contains(int line, int column) {
        boolean afterStart = line > startLine || (line == startLine && column >= startColumn);
        boolean beforeEnd = line < endLine || (line == endLine && column <= endColumn);
        return afterStart && beforeEnd;
    }

    private static String decode(String value) {
        return Uri.decode(value);
    }
}
