export const HEATMAP_FIGURE_TICK_COUNT = 5;

import { collagenDensityModelText } from "./collagenDensity.js";

const TICK_RATIOS = Object.freeze([0, 0.25, 0.5, 0.75, 1]);

export function heatmapAxisTickValues(count) {
  return TICK_RATIOS.map((ratio) => Math.round((count - 1) * ratio));
}

export function heatmapScaleTickValues(min, max) {
  return TICK_RATIOS.map((ratio) => max - (max - min) * ratio);
}

export function formatHeatmapFigureNumber(value) {
  if (!Number.isFinite(Number(value))) return "N/A";
  return String(Number(Number(value).toFixed(6)));
}

export function formatHeatmapFigureRange(min, max, { signed = false } = {}) {
  return `${formatRangeValue(min, signed)} to ${formatRangeValue(max, signed)}`;
}

export function heatmapCalibrationText() {
  return `Density model: ${collagenDensityModelText()}`;
}

export function heatmapFigureText({
  currentImage,
  previousImage = null,
  metric,
  metricLabel,
  metricUnit,
  cellWidth,
  cellHeight,
  columns,
  rows,
  min,
  max,
  comparison = false,
}) {
  return {
    titleLines: [
      `Current: ${currentImage}`,
      ...(previousImage ? [`Previous: ${previousImage}`] : []),
    ],
    detailLine: `${metricLabel} | Cell ${cellWidth}x${cellHeight} px | Grid ${columns}x${rows}`,
    calibrationLine: heatmapCalibrationText(),
    rangeLine: `Color range: ${formatHeatmapFigureRange(min, max, { signed: comparison })}${metricUnit ? ` ${metricUnit}` : ""}`,
    colorBarLabel: comparison
      ? metric === "pixel-density" ? "Delta Pixel Density" : "Delta Collagen Density (mg/ml)"
      : `${metricLabel} (${metricUnit || "ratio"})`,
  };
}

function formatRangeValue(value, signed) {
  const formatted = formatHeatmapFigureNumber(value);
  return signed && Number(value) > 0 ? `+${formatted}` : formatted;
}
