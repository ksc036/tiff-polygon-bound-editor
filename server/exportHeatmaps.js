import sharp from "sharp";
import { loadImageHeatmap } from "./heatmapService.js";
import {
  buildHeatmapDifference,
  differenceColor,
  heatmapCompatibilityError,
  heatmapDisplayRange,
  heatmapMetricValue,
  infernoColor,
} from "../src/lib/heatmap.js";
import { runSharpWithSignal } from "./sharpRender.js";

export const EXPORT_CELL_SIZES = Object.freeze([20, 50, 100]);
export const EXPORT_METRICS = Object.freeze(["pixel-density", "estimated-collagen-density"]);

const METRIC_DETAILS = Object.freeze({
  "pixel-density": { label: "Pixel Density", archiveName: "pixel_density", fallbackUnit: "ratio" },
  "estimated-collagen-density": {
    label: "Estimated Collagen Density",
    archiveName: "collagen_density",
    fallbackUnit: "mg/ml",
  },
});

const CANVAS_MARGIN = 72;
const CELL_DISPLAY_SIZE = 24;
const COLOR_BAR_WIDTH = 28;
const COLOR_BAR_GAP = 56;
const COLOR_BAR_HEIGHT = 300;

export async function collectSavedHeatmaps({ storage, images }) {
  const sources = new Map();

  for (const image of images) {
    for (const cellSize of EXPORT_CELL_SIZES) {
      const key = sourceKey(image.id, cellSize);
      try {
        sources.set(key, {
          status: "Included",
          heatmap: await loadImageHeatmap(storage, image.id, cellSize),
        });
      } catch (error) {
        sources.set(key, {
          status: "Skipped",
          reason: heatmapSkipReason(error),
        });
      }
    }
  }

  return sources;
}

export function planHeatmapFigures({ images, sources, calibration }) {
  const figures = [];
  const reportEntries = [];
  const comparisonCandidates = [];

  for (const image of images) {
    for (const cellSize of EXPORT_CELL_SIZES) {
      const source = sources.get(sourceKey(image.id, cellSize));
      if (source?.status !== "Included") {
        for (const metric of EXPORT_METRICS) {
          reportEntries.push(
            skippedReportEntry({
              kind: "absolute",
              metric,
              image,
              cellSize,
              reason: source?.reason ?? "Saved heatmap is unavailable.",
            }),
          );
        }
        continue;
      }

      for (const metric of EXPORT_METRICS) {
        figures.push(createAbsoluteFigure({ image, heatmap: source.heatmap, cellSize, metric, calibration }));
      }
    }
  }

  for (let index = 1; index < images.length; index += 1) {
    const currentImage = images[index];
    const previousImage = images[index - 1];

    for (const cellSize of EXPORT_CELL_SIZES) {
      const currentSource = sources.get(sourceKey(currentImage.id, cellSize));
      const previousSource = sources.get(sourceKey(previousImage.id, cellSize));
      const sourceReason = comparisonSourceReason(currentSource, previousSource);
      const compatibilityError = sourceReason
        ? null
        : heatmapCompatibilityError(currentSource.heatmap, previousSource.heatmap);

      for (const metric of EXPORT_METRICS) {
        if (sourceReason || compatibilityError) {
          reportEntries.push(
            skippedReportEntry({
              kind: "comparison",
              metric,
              image: currentImage,
              previousImage,
              cellSize,
              reason: sourceReason ?? compatibilityError,
            }),
          );
          continue;
        }

        const difference = buildHeatmapDifference({
          current: currentSource.heatmap,
          previous: previousSource.heatmap,
          metric,
          calibration,
        });
        comparisonCandidates.push(
          createComparisonFigure({
            currentImage,
            previousImage,
            heatmap: currentSource.heatmap,
            cellSize,
            metric,
            calibration,
            difference,
          }),
        );
      }
    }
  }

  const comparisonMaxAbs = new Map();
  for (const figure of comparisonCandidates) {
    const key = `${figure.metric}:${figure.cellWidth}`;
    const previousMax = comparisonMaxAbs.get(key) ?? 0;
    comparisonMaxAbs.set(key, Math.max(previousMax, finiteMaxAbs(figure.values)));
  }

  for (const figure of comparisonCandidates) {
    const key = `${figure.metric}:${figure.cellWidth}`;
    const maxAbs = comparisonMaxAbs.get(key) || 1;
    figure.colorRange = { min: -maxAbs, max: maxAbs };
    figures.push(figure);
  }

  return { figures, reportEntries };
}

export function buildHeatmapFigureSvg(figure) {
  const columns = positiveInteger(figure.columns);
  const rows = positiveInteger(figure.rows);
  const cellSize = Math.max(CELL_DISPLAY_SIZE, Number(figure.cellDisplaySize) || 0);
  const gridWidth = columns * cellSize;
  const gridHeight = rows * cellSize;
  const gridX = CANVAS_MARGIN + 58;
  const gridY = 150;
  const colorBarX = gridX + gridWidth + COLOR_BAR_GAP;
  const colorBarY = Math.max(gridY, gridY + Math.floor((gridHeight - COLOR_BAR_HEIGHT) / 2));
  const width = Math.max(760, colorBarX + COLOR_BAR_WIDTH + 152);
  const height = Math.max(520, Math.max(gridY + gridHeight + 104, colorBarY + COLOR_BAR_HEIGHT + 62));
  const { min, max } = figure.colorRange;
  const isComparison = figure.kind === "comparison";
  const title = figureTitle(figure, { includeRange: isComparison });
  const calibration = calibrationText(figure.calibration);
  const colorBarLabel = isComparison
    ? comparisonColorBarLabel(figure.metric)
    : `${figure.metricLabel} (${figure.unit || "ratio"})`;
  const cellElements = Array.from({ length: rows * columns }, (_, index) => {
    const value = figure.values?.[index] ?? null;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const fill = isComparison ? differenceColor(value, Math.max(Math.abs(min), Math.abs(max))) : infernoColor(value, min, max);
    return `<rect x="${gridX + column * cellSize}" y="${gridY + row * cellSize}" width="${cellSize}" height="${cellSize}" fill="${fill}"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <style>text { font-family: Arial, sans-serif; fill: #111827; } .title { font-size: 18px; font-weight: 700; } .subtitle { font-size: 14px; } .axis { font-size: 13px; font-weight: 700; } .tick { font-size: 12px; } .range { font-size: 12px; }</style>
  <text class="title" x="${CANVAS_MARGIN}" y="42">${escapeXml(title)}</text>
  <text class="subtitle" x="${CANVAS_MARGIN}" y="70">${escapeXml(calibration)}</text>
  <text class="range" x="${CANVAS_MARGIN}" y="98">${escapeXml(`Color range: ${formatRange(min, max, isComparison)}${figure.unit ? ` ${figure.unit}` : ""}`)}</text>
  <g shape-rendering="crispEdges">${cellElements}</g>
  <rect x="${gridX}" y="${gridY}" width="${gridWidth}" height="${gridHeight}" fill="none" stroke="#111827" stroke-width="1" shape-rendering="crispEdges"/>
  ${axisTicks({ gridX, gridY, gridWidth, gridHeight, columns, rows, cellSize })}
  <text class="axis" x="${gridX + gridWidth / 2}" y="${gridY + gridHeight + 62}" text-anchor="middle">Grid X</text>
  <text class="axis" x="${gridX - 48}" y="${gridY + gridHeight / 2}" text-anchor="middle" transform="rotate(-90 ${gridX - 48} ${gridY + gridHeight / 2})">Grid Y</text>
  <g data-role="color-bar">
    ${colorBar({ isComparison, min, max, x: colorBarX, y: colorBarY })}
    <text class="axis" x="${colorBarX + COLOR_BAR_WIDTH / 2}" y="${colorBarY - 14}" text-anchor="middle">Scale</text>
    <text class="subtitle" x="${colorBarX + COLOR_BAR_WIDTH / 2}" y="${colorBarY + COLOR_BAR_HEIGHT + 50}" text-anchor="middle">${escapeXml(colorBarLabel)}</text>
  </g>
</svg>`;
}

export async function renderHeatmapFigure(figure, { signal } = {}) {
  const pipeline = sharp(Buffer.from(buildHeatmapFigureSvg(figure)))
    .png({ compressionLevel: 9, adaptiveFiltering: true });
  return runSharpWithSignal(pipeline, () => pipeline.toBuffer(), signal);
}

function createAbsoluteFigure({ image, heatmap, cellSize, metric, calibration }) {
  const displayRange = heatmapDisplayRange(metric);
  const details = METRIC_DETAILS[metric];
  const currentImage = imageLabel(image);

  return {
    kind: "absolute",
    metric,
    metricLabel: details.label,
    unit: displayRange.unit || details.fallbackUnit,
    currentImage,
    previousImage: null,
    cellWidth: heatmap.cellWidth,
    cellHeight: heatmap.cellHeight,
    columns: heatmap.columns,
    rows: heatmap.rows,
    values: heatmap.cells.map((cell) => heatmapMetricValue(cell, metric, calibration)),
    colorRange: { min: displayRange.min, max: displayRange.max },
    calibration,
    archiveName: `${currentImage}_cell_${cellSize}px_${details.archiveName}.png`,
  };
}

function createComparisonFigure({ currentImage, previousImage, heatmap, cellSize, metric, calibration, difference }) {
  const details = METRIC_DETAILS[metric];
  const currentLabel = imageLabel(currentImage);
  const previousLabel = imageLabel(previousImage);
  const displayRange = heatmapDisplayRange(metric);

  return {
    kind: "comparison",
    metric,
    metricLabel: details.label,
    unit: displayRange.unit || details.fallbackUnit,
    currentImage: currentLabel,
    previousImage: previousLabel,
    cellWidth: heatmap.cellWidth,
    cellHeight: heatmap.cellHeight,
    columns: heatmap.columns,
    rows: heatmap.rows,
    values: difference.values,
    colorRange: null,
    calibration,
    archiveName: `${currentLabel}_cell_${cellSize}px_${details.archiveName}_vs_${previousLabel}.png`,
  };
}

function skippedReportEntry({ kind, metric, image, previousImage = null, cellSize, reason }) {
  const details = METRIC_DETAILS[metric];
  const currentImage = imageLabel(image);
  const previousLabel = previousImage ? imageLabel(previousImage) : null;
  const figureLabel = kind === "comparison" ? `${currentImage} vs ${previousLabel}` : currentImage;

  return {
    status: "Skipped",
    artifact: "Heatmap",
    kind,
    metric: details.label,
    currentImage,
    previousImage: previousLabel,
    cellWidth: cellSize,
    cellHeight: cellSize,
    reason,
    message: `${figureLabel} ${details.label} heatmap skipped: ${reason}`,
  };
}

function comparisonSourceReason(currentSource, previousSource) {
  if (currentSource?.status === "Included" && previousSource?.status === "Included") return null;
  if (currentSource?.status !== "Included" && previousSource?.status !== "Included") {
    return `Current heatmap unavailable: ${currentSource?.reason ?? "Saved heatmap is unavailable."} Previous heatmap unavailable: ${previousSource?.reason ?? "Saved heatmap is unavailable."}`;
  }
  if (currentSource?.status !== "Included") return `Current heatmap unavailable: ${currentSource?.reason ?? "Saved heatmap is unavailable."}`;
  return `Previous heatmap unavailable: ${previousSource?.reason ?? "Saved heatmap is unavailable."}`;
}

function heatmapSkipReason(error) {
  const reasons = {
    MISSING_HEATMAP: "Saved heatmap is missing.",
    STALE_HEATMAP: "Saved heatmap is stale.",
    INVALID_HEATMAP: "Saved heatmap is invalid.",
  };
  return reasons[error?.code] ?? "Saved heatmap is unavailable.";
}

function sourceKey(imageId, cellSize) {
  return `${imageId}:${cellSize}`;
}

function imageLabel(image) {
  return String(image?.imageFolder ?? image?.id ?? "image");
}

function finiteMaxAbs(values) {
  let maxAbs = 0;
  for (const value of values ?? []) {
    if (Number.isFinite(value)) maxAbs = Math.max(maxAbs, Math.abs(value));
  }
  return maxAbs;
}

function figureTitle(figure, { includeRange }) {
  const comparison = figure.previousImage ? `${figure.currentImage} vs ${figure.previousImage}` : figure.currentImage;
  const title = `${comparison} | ${figure.metricLabel} | Cell ${figure.cellWidth}x${figure.cellHeight} px | Grid ${figure.columns}x${figure.rows}`;
  return includeRange ? `${title} | Range ${formatRange(figure.colorRange.min, figure.colorRange.max, true)}` : title;
}

function comparisonColorBarLabel(metric) {
  return metric === "pixel-density" ? "Delta Pixel Density" : "Delta Collagen Density (mg/ml)";
}

function calibrationText(calibration) {
  return `Calibration: Pixel Density = ${formatNumber(calibration?.slope)} * Collagen Density + ${formatNumber(calibration?.intercept)}`;
}

function axisTicks({ gridX, gridY, gridWidth, gridHeight, columns, rows, cellSize }) {
  const ticks = [];
  for (let index = 0; index < 5; index += 1) {
    const ratio = index / 4;
    const x = gridX + gridWidth * ratio;
    const y = gridY + gridHeight * ratio;
    const column = Math.round((columns - 1) * ratio);
    const row = Math.round((rows - 1) * ratio);
    ticks.push(`<line x1="${x}" y1="${gridY + gridHeight}" x2="${x}" y2="${gridY + gridHeight + 6}" stroke="#111827"/>`);
    ticks.push(`<text class="tick" x="${x}" y="${gridY + gridHeight + 23}" text-anchor="middle">${column}</text>`);
    ticks.push(`<line x1="${gridX - 6}" y1="${y}" x2="${gridX}" y2="${y}" stroke="#111827"/>`);
    ticks.push(`<text class="tick" x="${gridX - 12}" y="${y + 4}" text-anchor="end">${row}</text>`);
  }
  return ticks.join("");
}

function colorBar({ isComparison, min, max, x, y }) {
  const steps = 64;
  const parts = [];
  for (let index = 0; index < steps; index += 1) {
    const ratio = index / (steps - 1);
    const value = max - (max - min) * ratio;
    const fill = isComparison ? differenceColor(value, Math.max(Math.abs(min), Math.abs(max))) : infernoColor(value, min, max);
    parts.push(`<rect x="${x}" y="${y + ratio * COLOR_BAR_HEIGHT}" width="${COLOR_BAR_WIDTH}" height="${COLOR_BAR_HEIGHT / steps + 1}" fill="${fill}"/>`);
  }
  parts.push(`<rect x="${x}" y="${y}" width="${COLOR_BAR_WIDTH}" height="${COLOR_BAR_HEIGHT}" fill="none" stroke="#111827"/>`);
  for (let index = 0; index < 5; index += 1) {
    const ratio = index / 4;
    const value = max - (max - min) * ratio;
    const tickY = y + ratio * COLOR_BAR_HEIGHT;
    parts.push(`<line x1="${x + COLOR_BAR_WIDTH}" y1="${tickY}" x2="${x + COLOR_BAR_WIDTH + 6}" y2="${tickY}" stroke="#111827"/>`);
    parts.push(`<text class="tick" x="${x + COLOR_BAR_WIDTH + 11}" y="${tickY + 4}">${escapeXml(formatNumber(value))}</text>`);
  }
  return parts.join("");
}

function formatRange(min, max, signed) {
  return `${signed ? formatSigned(min) : formatNumber(min)} to ${signed ? formatSigned(max) : formatNumber(max)}`;
}

function formatSigned(value) {
  const formatted = formatNumber(value);
  return Number(value) > 0 ? `+${formatted}` : formatted;
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "N/A";
  return String(Number(Number(value).toFixed(6)));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
