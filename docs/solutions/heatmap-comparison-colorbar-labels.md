# Heatmap Comparison Color-Bar Labels

## Context

Absolute and comparison Heatmaps use different color semantics. Reusing an absolute metric label for a signed current-minus-previous color bar makes the exported report ambiguous.

## Guidance

Keep comparison color-bar labels in the renderer, where the figure `kind` is available. Use exactly `Delta Pixel Density` for pixel-density comparisons and `Delta Collagen Density (mg/ml)` for estimated-collagen-density comparisons. Keep absolute color-bar labels unchanged.

## Prevention

Regression tests should render planned comparison figures and assert both exact color-bar labels, rather than only checking planner metadata.
