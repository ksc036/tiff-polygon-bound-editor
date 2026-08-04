---
title: Report Axis Ticks Must Share the Plot Containing Block
date: 2026-08-04
category: ui-bugs
module: Heatmap report layout
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - Five axis ticks render at equal-column centers instead of the plot endpoints.
  - Axis endpoints drift from a rectangular plot even when tick percentages are correct.
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [heatmap, report-layout, css-grid, axis-ticks, browser-verification]
---

# Report Axis Ticks Must Share the Plot Containing Block

## Problem

The interactive heatmap report displayed five X and Y labels, but their visual positions did not match the exported figure's `0/25/50/75/100` plot positions. The drift was most visible on a rectangular plot.

## Symptoms

- Five equal CSS grid columns placed X ticks near `10/30/50/70/90%`.
- Giving ticks explicit `0/25/50/75/100%` positions fixed their arithmetic but not their registration when the axis and plot had different containing blocks.
- The Y axis stretched to the report body while the aspect-ratio plot was vertically centered inside it.
- A responsive band such as `clamp(44px, 7%, 70px)` resolved to different pixel widths when reused inside parents with different widths.

## What Didn't Work

- Replacing equal columns with absolutely positioned ticks was incomplete. The percentages were correct, but they were measured against the report body rather than the plot.
- Removing the Y-axis title row stopped one offset but left the Y axis taller than the centered rectangular plot.
- Reusing the same custom-property token for X-axis padding and the plot grid did not guarantee the same pixel value because percentage terms resolve where the property is consumed.

## Solution

Place each axis in a structural wrapper that shares the plot's grid tracks:

```css
.heatmap-report-main,
.heatmap-x-axis-main {
  display: grid;
  grid-template-columns: var(--report-y-band) minmax(0, 1fr);
}
```

The Y axis and plot occupy one intrinsic grid row, so the Y-axis height comes from the plot's aspect ratio. The X tick wrapper occupies the same second column as the plot. Ticks can then use explicit endpoint percentages safely:

```jsx
<span style={{ left: `${(index / (ticks.length - 1)) * 100}%` }} />
```

Keep the grid SVG registered to rectangular canvases with `preserveAspectRatio="none"` when its coordinates are already expressed as percentages of the plot.

## Why This Works

Percentages only align when they use the same coordinate rectangle. Sharing grid tracks makes the plot, X ticks, and Y ticks derive their dimensions from the same containing blocks instead of attempting to duplicate responsive offsets in separate parts of the report.

## Prevention

- Test five tick positions as four intervals: `0/25/50/75/100%`.
- Add a rectangular component fixture; square plots can hide aspect and registration errors.
- In browser verification, compare tick centers and layer rectangles to the plot bounding box at desktop and mobile sizes.
- Treat percentage-bearing custom properties as formulas, not fixed computed lengths; verify the containing block at every use site.

## Related Issues

- [Pointer Alignment Uses Rendered Content Rect](../pointer-alignment-uses-rendered-content-rect.md)
- [Absolutely Positioned Legend Labels Need Reserved Layout Space](../absolutely-positioned-legend-labels-need-reserved-layout-space.md)
