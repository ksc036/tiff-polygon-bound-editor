export const DEFAULT_HEATMAP_PRESETS = Object.freeze({ small: 20, medium: 50, large: 100 });
export const DEFAULT_HEATMAP_CELL_SIZES = Object.freeze(Object.values(DEFAULT_HEATMAP_PRESETS));
export const MAX_HEATMAP_CELL_SIZE = 4096;

export function isHeatmapCellSize(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_HEATMAP_CELL_SIZE;
}
