package com.reactnative.uiacceptance;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.MotionEvent;
import android.view.View;

import androidx.annotation.NonNull;

import java.util.ArrayList;
import java.util.List;

/** Native overlay used by the inspector so highlights stay in the same pixel space as scrcpy. */
final class InspectorOverlayView extends View {
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final List<View> views = new ArrayList<>();

    InspectorOverlayView(@NonNull Context context) {
        super(context);
        setWillNotDraw(false);
        setClickable(false);
        setFocusable(false);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        fillPaint.setStyle(Paint.Style.FILL);
        fillPaint.setColor(Color.argb(64, 37, 99, 235));
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setColor(Color.rgb(37, 99, 235));
        strokePaint.setStrokeWidth(2f);
    }

    void setViews(@NonNull List<View> value) {
        views.clear();
        views.addAll(value);
        invalidate();
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        return false;
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        return false;
    }

    @Override
    protected void onDraw(@NonNull Canvas canvas) {
        super.onDraw(canvas);
        int[] overlayLocation = new int[2];
        getLocationOnScreen(overlayLocation);
        for (View view : views) {
            if (view.getParent() == null || view.getVisibility() != View.VISIBLE || view.getWidth() <= 0 || view.getHeight() <= 0) continue;
            int[] location = new int[2];
            view.getLocationOnScreen(location);
            RectF rect = new RectF(
                    location[0] - overlayLocation[0],
                    location[1] - overlayLocation[1],
                    location[0] - overlayLocation[0] + view.getWidth(),
                    location[1] - overlayLocation[1] + view.getHeight()
            );
            canvas.drawRect(rect, fillPaint);
            canvas.drawRect(rect, strokePaint);
        }
        if (!views.isEmpty()) postInvalidateDelayed(250L);
    }
}
