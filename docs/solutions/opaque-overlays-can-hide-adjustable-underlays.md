# Opaque Overlays Can Hide Adjustable Underlays

## Context

The Heat Map viewer exposed an opacity control that changed the raw TIFF canvas, but the TIFF was stacked below a fully opaque, full-coverage heatmap canvas. The control state changed without producing a visible difference.

## Rule

An opacity control on an underlay cannot be visually effective beneath an opaque overlay that covers the same pixels. For blend controls, verify both the intended layer order and rendered pixels at `0`, partial, and `1` opacity.

## Practice

Treat DOM bounds and state updates as insufficient visual evidence for layered rendering. Test stacking explicitly in CSS or component tests, then confirm the visual result in a browser with representative opacity values.
