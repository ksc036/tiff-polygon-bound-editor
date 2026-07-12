# Heatmap Display Overlay Design

## Goal

Make the Heat Map layer easier to inspect by controlling the visibility of the original TIFF instead of fading the analytical heatmap, removing editing overlays from this viewing mode, and moving the color legend outside the image stage.

## Confirmed Behavior

- The Heat Map color canvas is always rendered at full opacity.
- A Heat Map-only `Original opacity` control changes the opacity of the TIFF canvas composited above the heatmap.
- The default original opacity is `0.5` and the selected value persists in `localStorage`.
- Setting original opacity to `0` hides the TIFF completely and leaves only the heatmap visible.
- Original, Mask, and Fiber QC modes are unaffected by the Heat Map original-opacity value.
- Heat Map mode does not show or edit points, polygon boundaries, ROI bands, or migration vectors.
- Existing bounds and visibility settings remain unchanged and return when the user leaves Heat Map mode.
- The heatmap color legend is rendered in the `Heatmap display` side panel rather than over the image.

## Considered Approaches

### Separate Layer Opacity (Selected)

Keep the TIFF and heatmap as separate canvases. Apply opacity only to the TIFF canvas composited above the heatmap while Heat Map is active. This matches the existing layered renderer, updates instantly, and does not require recalculating heatmap pixels.

### Client-Side Canvas Composition

Redraw the TIFF and heatmap into one canvas whenever opacity changes. This adds redraw coordination and couples hover and comparison behavior to image composition without improving the result.

### Server-Side Composition

Generate blended preview images on the server. This would add network latency, create unnecessary derived files, and prevent immediate opacity adjustment.

## UI Design

The existing Heat Map contextual panel keeps metric, cell-size, and comparison controls. Its opacity row changes from `Heatmap opacity` to `Original opacity` and uses a `0%..100%` range.

The color legend moves below the opacity row in the same contextual panel. It remains horizontal and shows the same range:

- current Pixel Density: `0..1`;
- current Estimated Collagen Density: `0..3 mg/ml`;
- comparison: symmetric `-maxAbs..+maxAbs` with zero marked at the midpoint.

The image stage contains only the TIFF composited above the heatmap canvas while Heat Map is active. The legend no longer covers image pixels.

## Interaction Rules

- Stage pointer movement still drives heatmap cell tooltips.
- Stage clicks and point-editing shortcuts do not add, delete, move, or drag polygon points while Heat Map is active.
- Bound, ROI, point, and migration-vector SVG elements are not mounted in Heat Map mode.
- Switching back to another layer restores the existing editor behavior without changing saved or unsaved bound data.
- The `Point opacity` and `Show ROI` controls are hidden while Heat Map is active because they have no visible effect in that mode.

## State and Persistence

Introduce a dedicated Heat Map original-opacity state and storage key. Do not reuse the old heatmap-opacity key because the meaning is inverted. The renderer applies this value only as an inline opacity on the raw TIFF canvas when `imageLayer === "heatmap"`; in that mode the TIFF is stacked above the heatmap. Otherwise raw TIFF opacity is `1` and retains its existing layer order.

The heatmap canvas no longer receives a configurable opacity prop. Its cell colors are drawn with full alpha. Invalid Estimated Collagen Density calibration still clears the heatmap canvas as before.

## Component Changes

- `src/App.jsx`: own and persist original-opacity state, conditionally disable editing behavior, hide editor-only controls and SVG overlays in Heat Map mode, and render the legend in the side panel.
- `src/components/HeatmapOverlay.jsx`: remove the opacity prop and render heatmap cells at full alpha.
- `src/styles.css`: style the panel legend and remove stage-overlay legend positioning.
- Client tests: cover opacity isolation, overlay suppression, edit blocking, legend placement, and state restoration.

## Error Handling

This change does not alter heatmap loading or calculation errors. If heatmap data is unavailable, the original TIFF remains visible at the selected original opacity and the existing status message explains the missing data. The side-panel legend remains tied to Heat Map mode and does not intercept stage interaction.

## Testing

Tests must verify:

- the Heat Map slider changes only TIFF canvas opacity;
- the heatmap canvas is rendered at full alpha;
- `0%` original opacity leaves the heatmap layer visible;
- TIFF opacity returns to full when leaving Heat Map mode;
- bounds, points, ROI bands, and migration vectors are absent in Heat Map mode;
- stage clicks and point-editing commands cannot mutate bounds in Heat Map mode;
- editor overlays and behavior return after switching back;
- the legend is inside `Heatmap display` and absent from the image stage;
- existing current and previous-comparison legend values remain correct.
