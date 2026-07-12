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

export function estimateHeatmapCollagenDensity(pixelDensity, calibration) {
  const slope = calibrationNumber(calibration?.slope);
  const intercept = calibrationNumber(calibration?.intercept);

  if (!Number.isFinite(pixelDensity) || !Number.isFinite(slope) || !Number.isFinite(intercept) || slope === 0) {
    return null;
  }

  return (pixelDensity - intercept) / slope;
}

export function heatmapMetricValue(cell, metric, calibration) {
  if (metric === "pixel-density") {
    return cell?.pixelDensity;
  }

  if (metric === "estimated-collagen-density" || metric === "collagen-density") {
    return estimateHeatmapCollagenDensity(cell?.pixelDensity, calibration);
  }

  return null;
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

  return null;
}

export function buildHeatmapDifference({ current, previous, metric, calibration }) {
  const compatibilityError = heatmapCompatibilityError(current, previous);
  if (compatibilityError) {
    throw new Error(compatibilityError);
  }

  const currentValues = current.cells.map((cell) => heatmapMetricValue(cell, metric, calibration));
  const previousValues = previous.cells.map((cell) => heatmapMetricValue(cell, metric, calibration));
  const values = currentValues.map((value, index) => cleanFloatingPoint(value - previousValues[index]));

  return {
    currentValues,
    previousValues,
    values,
    maxAbs: cleanFloatingPoint(Math.max(0, ...values.map((value) => Math.abs(value)))),
  };
}

export function heatmapDisplayRange(metric) {
  if (metric === "estimated-collagen-density" || metric === "collagen-density") {
    return { min: 0, max: 3, unit: "mg/ml" };
  }

  return { min: 0, max: 1, unit: "" };
}

export function infernoColor(value, min, max) {
  const normalized = normalizeColorValue(value, min, max);
  return colorFromStops(INFERNO_STOPS, normalized);
}

export function differenceColor(value, maxAbs) {
  if (!Number.isFinite(maxAbs) || maxAbs <= 0 || !Number.isFinite(value)) {
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

  const column = Math.floor(point.x / heatmap.cellWidth);
  const row = Math.floor(point.y / heatmap.cellHeight);
  return heatmap.cells[row * heatmap.columns + column] ?? null;
}

function calibrationNumber(value) {
  if (String(value ?? "").trim() === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
