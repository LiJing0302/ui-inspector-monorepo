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
    public boolean textRedacted;
    public String participation;
    public boolean clickable;
    public boolean enabled;
    public boolean clipsToBounds;
    public float alpha;
    public float z;
    public float elevation;

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
        map.putBoolean("textRedacted", textRedacted);
        map.putString("participation", participation);
        WritableMap state = Arguments.createMap();
        state.putBoolean("visible", visible);
        state.putBoolean("attached", attached);
        state.putBoolean("hasVisualContent", hasVisualContent);
        state.putBoolean("layoutOnly", layoutOnly);
        state.putBoolean("clipped", clipped);
        state.putBoolean("zeroSize", zeroSize);
        state.putBoolean("hiddenByAncestor", hiddenByAncestor);
        state.putBoolean("outsideVisibleRect", outsideVisibleRect);
        state.putString("participation", participation);
        map.putMap("state", state);
        map.putBoolean("clickable", clickable);
        map.putBoolean("enabled", enabled);
        map.putBoolean("clipsToBounds", clipsToBounds);
        map.putDouble("alpha", alpha);
        map.putDouble("z", z);
        map.putDouble("elevation", elevation);
        return map;
    }

    /**
     * Appends this node as a JSON object. A trailing comma is always written, so the caller must
     * drop the last character before closing the surrounding object.
     */
    public void writeJson(StringBuilder out) {
        out.append('{');
        Json.writeString(out, "nodeId", nodeId);
        Json.writeString(out, "treePath", treePath);
        Json.writeString(out, "parentId", parentId);
        Json.writeString(out, "className", className);
        Json.writeString(out, "resourceName", resourceName);
        Json.writeString(out, "contentDescription", contentDescription);
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
        Json.writeBoolean(out, "textRedacted", textRedacted);
        Json.writeString(out, "participation", participation);
        out.append("\"state\":{");
        Json.writeBoolean(out, "visible", visible);
        Json.writeBoolean(out, "attached", attached);
        Json.writeBoolean(out, "hasVisualContent", hasVisualContent);
        Json.writeBoolean(out, "layoutOnly", layoutOnly);
        Json.writeBoolean(out, "clipped", clipped);
        Json.writeBoolean(out, "zeroSize", zeroSize);
        Json.writeBoolean(out, "hiddenByAncestor", hiddenByAncestor);
        Json.writeBoolean(out, "outsideVisibleRect", outsideVisibleRect);
        Json.writeString(out, "participation", participation);
        out.setLength(out.length() - 1);
        out.append("},");
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
