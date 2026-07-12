# Persist preset values with preset selection

## Context

A configurable UI preset has two independent pieces of state: which preset is selected and the numeric value assigned to each preset. Persisting only the selected label can make the next image or session request a different server artifact than the one generated with edited values.

For the heatmap viewer, changing Small from `5x5` to `7x7` must affect both batch output (`heatmap/7x7/`) and subsequent viewer requests.

## Rule

When a preset controls generated artifact names or server requests, keep one validated preset configuration as the source of truth. Persist both the preset mapping and the selected preset, and derive generation paths, request parameters, and labels from that mapping.

```js
const heatmapPresets = {
  small: 7,
  medium: 10,
  large: 20,
};

const selectedCellSize = heatmapPresets[selectedPreset];
```

Do not duplicate default numbers in separate batch and viewer state. Test an edited preset across generation, image navigation, and reload.
