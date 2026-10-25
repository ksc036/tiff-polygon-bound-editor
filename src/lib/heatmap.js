import {
  COLLAGEN_DENSITY_DISPLAY_MAX,
  COLLAGEN_DENSITY_MODEL,
  collagenDensityResult,
  estimateCollagenDensity,
  isCollagenDensityColorMax,
} from "../../shared/collagenDensity.js";
import { heatmapAxisCellIndex } from "../../shared/heatmapGrid.js";

const INFERNO_STOPS = [
  [0, "#000004"],
  [0.25, "#57106e"],
  [0.5, "#bc3754"],
  [0.75, "#f98e09"],
  [1, "#fcffa4"],
];

const DIFFERENCE_BLUE = "#2563eb";
const DIFFERENCE_WHITE = "#f8fafc";
const DIFFERENCE_RED = "#dc2626";
export const HEATMAP_NO_DATA_COLOR = "#80858b";

export function estimateHeatmapCollagenDensity(
  pixelDensity,
  collagenDensityMax = COLLAGEN_DENSITY_DISPLAY_MAX,
  model = COLLAGEN_DENSITY_MODEL,
) {
  return estimateCollagenDensity(pixelDensity, collagenDensityMax, model);
}

export function heatmapMetricValue(cell, metric, collagenDensityMax = COLLAGEN_DENSITY_DISPLAY_MAX, model = COLLAGEN_DENSITY_MODEL) {
  if (cell?.areaPx === 0 || cell?.empty === true) return null;
  if (metric === "pixel-density") {
    return Number.isFinite(cell?.pixelDensity) && cell.pixelDensity >= 0 && cell.pixelDensity <= 1 ? cell.pixelDensity : null;
  }

  if (metric === "estimated-collagen-density" || metric === "collagen-density") {
    return model ? estimateHeatmapCollagenDensity(cell?.pixelDensity, collagenDensityMax, model) : null;
  }

  return null;
}

export function heatmapDisplayValue(cell, metric, collagenDensityMax = COLLAGEN_DENSITY_DISPLAY_MAX, model = COLLAGEN_DENSITY_MODEL) {
  if (metric === "pixel-density") return heatmapMetricValue(cell, metric, collagenDensityMax, model);
  if (!model || (metric !== "collagen-density" && metric !== "estimated-collagen-density")) return null;
  const result = collagenDensityResult(cell?.pixelDensity, model, {
    empty: cell?.areaPx === 0 || cell?.empty === true, colorMax: collagenDensityMax,
  });
  return result.status === "model-range-exceeded"
    ? heatmapDisplayRange(metric, collagenDensityMax).max : result.value;
}

export function heatmapCompatibilityError(current, previous) {
  if (current?.width !== previous?.width || current?.height !== previous?.height) {
    return "Heatmaps have incompatible dimensions.";
  }

  if (current?.cellWidth !== previous?.cellWidth || current?.cellHeight !== previous?.cellHeight) {
    return "Heatmaps have incompatible cell sizes.";
  }

  if (current?.rows !== previous?.rows) {
    return "Heatmaps have incompatible rows.";
  }

  if (current?.columns !== previous?.columns) {
    return "Heatmaps have incompatible columns.";
  }

  if (!Array.isArray(current?.cells) || !Array.isArray(previous?.cells) || current.cells.length !== previous.cells.length) {
    return "Heatmaps have incompatible cell count.";
  }

  if (current.cells.some((cell, index) => ["x", "y", "width", "height"].some(
    (field) => cell?.[field] !== previous.cells[index]?.[field],
  ))) {
    return "Heatmaps have incompatible grid alignment. Regenerate both heatmaps.";
  }

  return null;
}

export function buildHeatmapDifference({
  current,
  previous,
  metric,
  collagenDensityMax = COLLAGEN_DENSITY_DISPLAY_MAX,
  model = COLLAGEN_DENSITY_MODEL,
}) {
  const compatibilityError = heatmapCompatibilityError(current, previous);
  if (compatibilityError) {
    throw new Error(compatibilityError);
  }

  // Out-of-model cells use the selected Max as a comparison substitute, not an inverse estimate.
  const currentValues = current.cells.map((cell) => heatmapDisplayValue(cell, metric, collagenDensityMax, model));
  const previousValues = previous.cells.map((cell) => heatmapDisplayValue(cell, metric, collagenDensityMax, model));
  let maxAbs = 0;
  const values = currentValues.map((value, index) => {
    const previousValue = previousValues[index];
    if (!Number.isFinite(value) || !Number.isFinite(previousValue)) {
      return null;
    }

    const delta = cleanFloatingPoint(value - previousValue);
    if (Number.isFinite(delta)) {
      maxAbs = Math.max(maxAbs, Math.abs(delta));
    }
    return delta;
  });

  return {
    currentValues,
    previousValues,
    values,
    maxAbs: cleanFloatingPoint(maxAbs),
  };
}

export function heatmapDisplayRange(metric, collagenDensityColorMax = COLLAGEN_DENSITY_DISPLAY_MAX) {
  if (metric === "estimated-collagen-density" || metric === "collagen-density") {
    const max = isCollagenDensityColorMax(collagenDensityColorMax)
      ? collagenDensityColorMax
      : COLLAGEN_DENSITY_DISPLAY_MAX;
    return { min: 0, max, unit: "mg/ml" };
  }

  return { min: 0, max: 1, unit: "" };
}

export function heatmapGradientCss() {
  return `linear-gradient(to right, ${INFERNO_STOPS.map(([stop, color]) => `${color} ${stop * 100}%`).join(", ")})`;
}

export function differenceGradientCss() {
  return `linear-gradient(to right, ${DIFFERENCE_BLUE} 0%, ${DIFFERENCE_WHITE} 50%, ${DIFFERENCE_RED} 100%)`;
}

export function infernoColor(value, min, max) {
  if (!Number.isFinite(value)) return HEATMAP_NO_DATA_COLOR;
  const normalized = normalizeColorValue(value, min, max);
  return colorFromStops(INFERNO_STOPS, normalized);
}

export function differenceColor(value, maxAbs) {
  if (!Number.isFinite(value)) return HEATMAP_NO_DATA_COLOR;
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) {
    return DIFFERENCE_WHITE;
  }

  const normalized = Math.min(Math.max(value / maxAbs, -1), 1);
  if (normalized < 0) {
    return interpolateHex(DIFFERENCE_BLUE, DIFFERENCE_WHITE, normalized + 1);
  }
  return interpolateHex(DIFFERENCE_WHITE, DIFFERENCE_RED, normalized);
}

export function heatmapCellAtPoint(heatmap, point) {
  if (
    !point ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= heatmap?.width ||
    point.y >= heatmap?.height
  ) {
    return null;
  }

  const column = heatmapAxisCellIndex(point.x, heatmap.width, heatmap.cellWidth, heatmap.gridAlignment);
  const row = heatmapAxisCellIndex(point.y, heatmap.height, heatmap.cellHeight, heatmap.gridAlignment);
  if (column < 0 || row < 0) return null;
  return heatmap.cells[row * heatmap.columns + column] ?? null;
}

function normalizeColorValue(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return 0;
  }

  return Math.min(Math.max((value - min) / (max - min), 0), 1);
}

function colorFromStops(stops, value) {
  for (let index = 1; index < stops.length; index += 1) {
    const [stop, color] = stops[index];
    if (value <= stop) {
      const [previousStop, previousColor] = stops[index - 1];
      return interpolateHex(previousColor, color, (value - previousStop) / (stop - previousStop));
    }
  }

  return stops[stops.length - 1][1];
}

function interpolateHex(start, end, amount) {
  const startRgb = hexToRgb(start);
  const endRgb = hexToRgb(end);
  const ratio = Math.min(Math.max(amount, 0), 1);
  const channels = startRgb.map((channel, index) => Math.round(channel + (endRgb[index] - channel) * ratio));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function cleanFloatingPoint(value) {
  return Number(value.toPrecision(15));
}
