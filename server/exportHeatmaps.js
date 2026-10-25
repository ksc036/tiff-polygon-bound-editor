import sharp from "sharp";
import { loadImageHeatmap } from "./heatmapService.js";
import {
  buildHeatmapDifference,
  differenceColor,
  heatmapCompatibilityError,
  heatmapDisplayRange,
  heatmapDisplayValue,
  infernoColor,
} from "../src/lib/heatmap.js";
import {
  formatHeatmapFigureNumber,
  formatHeatmapFigureRange,
  heatmapAxisTickValues,
  heatmapCalibrationText,
  heatmapFigureText,
  heatmapScaleTickValues,
} from "../shared/heatmapFigure.js";
import { runSharpWithSignal } from "./sharpRender.js";
import { EXPORT_NO_DATA_COLOR, exportCalibrationSnapshot } from "./exportCalibration.js";
import { DEFAULT_HEATMAP_CELL_SIZES } from "../shared/heatmapSettings.js";

export const EXPORT_CELL_SIZES = DEFAULT_HEATMAP_CELL_SIZES;
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
const MAX_GRID_DISPLAY_SIZE = 4096;
const COLOR_BAR_WIDTH = 28;
const COLOR_BAR_GAP = 56;
const COLOR_BAR_HEIGHT = 300;
const MAX_PATH_COMMANDS = 1_024;
const TITLE_MAX_WIDTH = 800;
const SUBTITLE_MAX_WIDTH = 860;

export async function collectSavedHeatmaps({ storage, images, cellSizes = EXPORT_CELL_SIZES }) {
  const sources = new Map();

  for (const image of images) {
    for (const cellSize of cellSizes) {
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

export function planHeatmapFigures({
  images,
  sources,
  cellSizes = EXPORT_CELL_SIZES,
  calibration,
  estimatedCollagenColorMax,
}) {
  calibration = exportCalibrationSnapshot(calibration).model;
  const figures = [];
  const reportEntries = [];
  const comparisonCandidates = [];

  for (const image of images) {
    for (const cellSize of cellSizes) {
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
        figures.push(createAbsoluteFigure({
          image,
          heatmap: source.heatmap,
          cellSize,
          metric,
          calibration,
          estimatedCollagenColorMax,
        }));
      }
    }
  }

  for (let index = 1; index < images.length; index += 1) {
    const currentImage = images[index];
    const previousImage = images[index - 1];

    for (const cellSize of cellSizes) {
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
          collagenDensityMax: estimatedCollagenColorMax,
          model: calibration,
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
            estimatedCollagenColorMax,
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
    const maxAbs = comparisonMaxAbs.get(key) ?? 0;
    figure.colorRange = maxAbs === 0
      ? { min: 0, max: 0 }
      : { min: -maxAbs, max: maxAbs };
    figures.push(figure);
  }

  return { figures, reportEntries };
}

export async function planSavedHeatmapFigures({
  storage,
  images,
  cellSizes = EXPORT_CELL_SIZES,
  calibration,
  estimatedCollagenColorMax,
  loadHeatmap = loadImageHeatmap,
  signal,
}) {
  calibration = exportCalibrationSnapshot(calibration).model;
  const figures = [];
  const reportEntries = [];
  const availability = new Map();

  for (const image of images) {
    for (const cellSize of cellSizes) {
      throwIfPlanningAborted(signal);
      const key = sourceKey(image.id, cellSize);
      try {
        const heatmap = await loadHeatmap(storage, image.id, cellSize);
        availability.set(key, {
          status: "Included",
          metadata: heatmapFigureMetadata(heatmap),
        });
        for (const metric of EXPORT_METRICS) {
          figures.push(createAbsoluteDescriptor({
            image,
            heatmap,
            cellSize,
            metric,
            calibration,
            estimatedCollagenColorMax,
          }));
        }
      } catch (error) {
        throwIfPlanningAborted(signal);
        const source = { status: "Skipped", reason: heatmapSkipReason(error) };
        availability.set(key, source);
        for (const metric of EXPORT_METRICS) {
          reportEntries.push(skippedReportEntry({
            kind: "absolute",
            metric,
            image,
            cellSize,
            reason: source.reason,
          }));
        }
      }
    }
  }

  const comparisonMaxAbs = new Map();
  for (let index = 1; index < images.length; index += 1) {
    const currentImage = images[index];
    const previousImage = images[index - 1];

    for (const cellSize of cellSizes) {
      throwIfPlanningAborted(signal);
      const currentSource = availability.get(sourceKey(currentImage.id, cellSize));
      const previousSource = availability.get(sourceKey(previousImage.id, cellSize));
      const sourceReason = comparisonSourceReason(currentSource, previousSource);
      let currentHeatmap;
      let previousHeatmap;
      let compatibilityError = null;

      if (!sourceReason) {
        try {
          currentHeatmap = await loadHeatmap(storage, currentImage.id, cellSize);
          previousHeatmap = await loadHeatmap(storage, previousImage.id, cellSize);
          compatibilityError = heatmapCompatibilityError(currentHeatmap, previousHeatmap);
        } catch (error) {
          throwIfPlanningAborted(signal);
          compatibilityError = heatmapSkipReason(error);
        }
      }

      for (const metric of EXPORT_METRICS) {
        if (sourceReason || compatibilityError) {
          reportEntries.push(skippedReportEntry({
            kind: "comparison",
            metric,
            image: currentImage,
            previousImage,
            cellSize,
            reason: sourceReason ?? compatibilityError,
          }));
          continue;
        }

        const descriptor = createComparisonDescriptor({
          currentImage,
          previousImage,
          heatmap: currentHeatmap,
          cellSize,
          metric,
          calibration,
          estimatedCollagenColorMax,
        });
        const rangeKey = `${metric}:${descriptor.cellWidth}`;
        const maxAbs = comparisonMaxAbsFor({
          current: currentHeatmap,
          previous: previousHeatmap,
          metric,
          calibration,
          estimatedCollagenColorMax,
        });
        comparisonMaxAbs.set(
          rangeKey,
          Math.max(comparisonMaxAbs.get(rangeKey) ?? 0, maxAbs),
        );
        descriptor.comparisonRangeKey = rangeKey;
        figures.push(descriptor);
      }
    }
  }

  for (const figure of figures) {
    if (figure.kind !== "comparison") continue;
    const maxAbs = comparisonMaxAbs.get(figure.comparisonRangeKey) ?? 0;
    figure.colorRange = maxAbs === 0
      ? { min: 0, max: 0 }
      : { min: -maxAbs, max: maxAbs };
    delete figure.comparisonRangeKey;
  }

  return { figures, reportEntries };
}

export async function hydrateHeatmapFigure(
  figure,
  { storage, loadHeatmap = loadImageHeatmap, signal } = {},
) {
  throwIfPlanningAborted(signal);
  const current = await loadHeatmap(storage, figure.currentImageId, figure.sourceCellSize);
  throwIfPlanningAborted(signal);

  if (figure.kind === "absolute") {
    return {
      ...figure,
      ...heatmapFigureMetadata(current),
      values: current.cells.map((cell) =>
        heatmapDisplayValue(cell, figure.metric, figure.estimatedCollagenMax, figure.calibration)
      ),
    };
  }

  const previous = await loadHeatmap(storage, figure.previousImageId, figure.sourceCellSize);
  throwIfPlanningAborted(signal);
  const compatibilityError = heatmapCompatibilityError(current, previous);
  if (compatibilityError) throw new Error(compatibilityError);

  return {
    ...figure,
    ...heatmapFigureMetadata(current),
    values: comparisonValues({
      current,
      previous,
      metric: figure.metric,
      calibration: figure.calibration,
      estimatedCollagenMax: figure.estimatedCollagenMax,
    }),
  };
}

export function buildHeatmapFigureSvg(figure, { gridImageHref = null } = {}) {
  const { columns, rows, gridWidth, gridHeight, xEdges, yEdges, hasGeometry } = figureGridLayout(figure);
  const gridX = CANVAS_MARGIN + 58;
  const { min, max } = figure.colorRange;
  const isComparison = figure.kind === "comparison";
  const noComparisonData = isComparison && !figure.values?.some(Number.isFinite);
  const figureText = heatmapFigureText({
    currentImage: figure.currentImage,
    previousImage: figure.previousImage,
    metric: figure.metric,
    metricLabel: figure.metricLabel,
    metricUnit: figure.unit,
    cellWidth: figure.cellWidth,
    cellHeight: figure.cellHeight,
    columns,
    rows,
    min,
    max,
    comparison: isComparison,
    calibration: figure.calibration,
  });
  const title = figureTitle(figure, { includeRange: isComparison && !noComparisonData });
  const titleLines = [
    ...figureText.titleLines.flatMap((line) => wrapSvgText(line, TITLE_MAX_WIDTH, 18, true)),
    ...wrapSvgText(figureText.detailLine, TITLE_MAX_WIDTH, 18, true),
    ...(isComparison
      ? wrapSvgText(noComparisonData ? "No data" : `Range ${formatHeatmapFigureRange(min, max, { signed: true })}`, TITLE_MAX_WIDTH, 18, true)
      : []),
  ];
  const calibrationLines = wrapSvgText(
    figure.metric === "pixel-density" ? "" : heatmapCalibrationText(figure.calibration),
    SUBTITLE_MAX_WIDTH,
    14,
  );
  const titleStartY = 42;
  const calibrationStartY = titleStartY + titleLines.length * 24 + 4;
  const rangeY = calibrationStartY + calibrationLines.length * 20 + 8;
  const gridY = rangeY + 52;
  const colorBarX = gridX + gridWidth + COLOR_BAR_GAP;
  const colorBarY = Math.max(gridY, gridY + Math.floor((gridHeight - COLOR_BAR_HEIGHT) / 2));
  const width = Math.max(960, colorBarX + COLOR_BAR_WIDTH + 152);
  const height = Math.max(520, Math.max(gridY + gridHeight + 104, colorBarY + COLOR_BAR_HEIGHT + 90));
  const colorBarLabel = figureText.colorBarLabel;
  const emptyCellFill = EXPORT_NO_DATA_COLOR;
  const cellElements = gridImageHref
    ? `<image href="${gridImageHref}" x="${gridX}" y="${gridY}" width="${gridWidth}" height="${gridHeight}" preserveAspectRatio="none" image-rendering="pixelated"/>`
    : buildGridCellPaths({
        figure,
        columns,
        rows,
        gridX,
        gridY,
        xEdges,
        yEdges,
        isComparison,
        min,
        max,
      });

  const titleElements = titleLines
    .map((line, index) => `<text class="title" data-role="title-line" x="${CANVAS_MARGIN}" y="${titleStartY + index * 24}">${escapeXml(line)}</text>`)
    .join("");
  const calibrationElements = calibrationLines
    .map((line, index) => `<text class="subtitle" x="${CANVAS_MARGIN}" y="${calibrationStartY + index * 20}">${escapeXml(line)}</text>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-current-image="${escapeXml(figure.currentImage)}"${figure.previousImage ? ` data-previous-image="${escapeXml(figure.previousImage)}"` : ""}>
  <title>${escapeXml(title)}</title>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <style>text { font-family: Arial, sans-serif; fill: #111827; } .title { font-size: 18px; font-weight: 700; } .subtitle { font-size: 14px; } .axis { font-size: 13px; font-weight: 700; } .tick { font-size: 12px; } .range { font-size: 12px; }</style>
  ${titleElements}
  ${calibrationElements}
  <text class="range" x="${CANVAS_MARGIN}" y="${rangeY}">${escapeXml(noComparisonData ? "Color range: No data" : figureText.rangeLine)}</text>
  <rect x="${gridX}" y="${gridY}" width="${gridWidth}" height="${gridHeight}" fill="${emptyCellFill}" shape-rendering="crispEdges"/>
  <g shape-rendering="crispEdges">${cellElements}</g>
  <rect x="${gridX}" y="${gridY}" width="${gridWidth}" height="${gridHeight}" fill="none" stroke="#111827" stroke-width="1" shape-rendering="crispEdges"/>
  ${axisTicks({ gridX, gridY, gridWidth, gridHeight, columns, rows, xEdges, yEdges, hasGeometry })}
  <text class="axis" x="${gridX + gridWidth / 2}" y="${gridY + gridHeight + 62}" text-anchor="middle">Grid X</text>
  <text class="axis" x="${gridX - 48}" y="${gridY + gridHeight / 2}" text-anchor="middle" transform="rotate(-90 ${gridX - 48} ${gridY + gridHeight / 2})">Grid Y</text>
  <g data-role="color-bar">
    ${colorBar({ isComparison, min, max, x: colorBarX, y: colorBarY, noData: noComparisonData })}
    <text class="axis" x="${colorBarX + COLOR_BAR_WIDTH / 2}" y="${colorBarY - 14}" text-anchor="middle">Scale</text>
    <text class="subtitle" x="${colorBarX + COLOR_BAR_WIDTH / 2}" y="${colorBarY + COLOR_BAR_HEIGHT + 50}" text-anchor="middle">${escapeXml(colorBarLabel)}</text>
    <rect x="${colorBarX}" y="${colorBarY + COLOR_BAR_HEIGHT + 62}" width="12" height="12" fill="${EXPORT_NO_DATA_COLOR}"/>
    <text class="tick" x="${colorBarX + 18}" y="${colorBarY + COLOR_BAR_HEIGHT + 73}">No data</text>
  </g>
</svg>`;
}

export async function renderHeatmapFigure(figure, { signal } = {}) {
  const gridImageHref = await heatmapGridDataUrl(figure, { signal });
  const pipeline = sharp(Buffer.from(buildHeatmapFigureSvg(figure, { gridImageHref })))
    .png({ compressionLevel: 9, adaptiveFiltering: true });
  return runSharpWithSignal(pipeline, () => pipeline.toBuffer(), signal);
}

function createAbsoluteFigure({
  image,
  heatmap,
  cellSize,
  metric,
  calibration,
  estimatedCollagenColorMax,
}) {
  const displayRange = heatmapDisplayRange(metric, estimatedCollagenColorMax);
  const details = METRIC_DETAILS[metric];
  const currentImage = imageLabel(image);

  return {
    kind: "absolute",
    metric,
    metricLabel: details.label,
    unit: displayRange.unit || details.fallbackUnit,
    currentImage,
    previousImage: null,
    ...heatmapFigureMetadata(heatmap),
    values: heatmap.cells.map((cell) => heatmapDisplayValue(cell, metric, estimatedCollagenColorMax, calibration)),
    colorRange: { min: displayRange.min, max: displayRange.max },
    calibration,
    estimatedCollagenMax: estimatedCollagenColorMax,
    archiveName: `${currentImage}_cell_${cellSize}px_${details.archiveName}.png`,
  };
}

function createComparisonFigure({
  currentImage,
  previousImage,
  heatmap,
  cellSize,
  metric,
  calibration,
  difference,
  estimatedCollagenColorMax,
}) {
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
    ...heatmapFigureMetadata(heatmap),
    values: difference.values,
    colorRange: null,
    calibration,
    estimatedCollagenMax: estimatedCollagenColorMax,
    archiveName: `${currentLabel}_cell_${cellSize}px_${details.archiveName}_vs_${previousLabel}.png`,
  };
}

function createAbsoluteDescriptor({
  image,
  heatmap,
  cellSize,
  metric,
  calibration,
  estimatedCollagenColorMax,
}) {
  const displayRange = heatmapDisplayRange(metric, estimatedCollagenColorMax);
  const details = METRIC_DETAILS[metric];
  const currentImage = imageLabel(image);
  return {
    kind: "absolute",
    metric,
    metricLabel: details.label,
    unit: displayRange.unit || details.fallbackUnit,
    currentImage,
    currentImageId: image.id,
    previousImage: null,
    previousImageId: null,
    sourceCellSize: cellSize,
    ...heatmapFigureMetadata(heatmap),
    colorRange: { min: displayRange.min, max: displayRange.max },
    calibration,
    estimatedCollagenMax: estimatedCollagenColorMax,
    archiveName: `${currentImage}_cell_${cellSize}px_${details.archiveName}.png`,
  };
}

function createComparisonDescriptor({
  currentImage,
  previousImage,
  heatmap,
  cellSize,
  metric,
  calibration,
  estimatedCollagenColorMax,
}) {
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
    currentImageId: currentImage.id,
    previousImage: previousLabel,
    previousImageId: previousImage.id,
    sourceCellSize: cellSize,
    ...heatmapFigureMetadata(heatmap),
    colorRange: null,
    calibration,
    estimatedCollagenMax: estimatedCollagenColorMax,
    archiveName: `${currentLabel}_cell_${cellSize}px_${details.archiveName}_vs_${previousLabel}.png`,
  };
}

export function heatmapFigureMetadata(heatmap) {
  // A rectangular grid needs only its first row and column, not a copy of every cell.
  const x = cellAxisEdges(heatmap, heatmap.columns, 1, "x", "width");
  const y = cellAxisEdges(heatmap, heatmap.rows, heatmap.columns, "y", "height");
  return {
    schemaVersion: heatmap.schemaVersion,
    gridAlignment: heatmap.gridAlignment,
    width: heatmap.width,
    height: heatmap.height,
    cellWidth: heatmap.cellWidth,
    cellHeight: heatmap.cellHeight,
    columns: heatmap.columns,
    rows: heatmap.rows,
    gridAxes: x && y ? { x, y } : undefined,
  };
}

function cellAxisEdges(heatmap, count, stride, position, size) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const edges = [0];
  for (let index = 0; index < count; index += 1) {
    const cell = heatmap.cells?.[index * stride];
    if (!cell || cell[position] !== edges[index] || !Number.isFinite(cell[size]) || cell[size] <= 0) return null;
    edges.push(cell[position] + cell[size]);
  }
  return edges;
}

function validAxisEdges(edges, count) {
  return Array.isArray(edges) && edges.length === count + 1 && edges[0] === 0 &&
    edges.every((edge, index) => Number.isFinite(edge) && (index === 0 || edge > edges[index - 1]));
}

function figureGridLayout(figure) {
  const columns = positiveInteger(figure.columns);
  const rows = positiveInteger(figure.rows);
  const hasGeometry = validAxisEdges(figure.gridAxes?.x, columns) &&
    validAxisEdges(figure.gridAxes?.y, rows) &&
    Number.isFinite(figure.cellWidth) && figure.cellWidth > 0 &&
    Number.isFinite(figure.cellHeight) && figure.cellHeight > 0;
  const x = hasGeometry ? figure.gridAxes.x.map((edge) => edge / figure.cellWidth)
    : Array.from({ length: columns + 1 }, (_, index) => index);
  const y = hasGeometry ? figure.gridAxes.y.map((edge) => edge / figure.cellHeight)
    : Array.from({ length: rows + 1 }, (_, index) => index);
  const requestedCellSize = Number.isFinite(Number(figure.cellDisplaySize))
    ? Math.max(Number(figure.cellDisplaySize), 0.25) : CELL_DISPLAY_SIZE;
  const cellSize = Math.min(requestedCellSize, MAX_GRID_DISPLAY_SIZE / Math.max(x[columns], y[rows]));
  const xEdges = x.map((edge) => edge * cellSize);
  const yEdges = y.map((edge) => edge * cellSize);
  return {
    columns, rows, hasGeometry, xEdges, yEdges,
    gridWidth: xEdges[columns], gridHeight: yEdges[rows],
  };
}

function comparisonMaxAbsFor({ current, previous, metric, estimatedCollagenColorMax, calibration }) {
  let maximum = 0;
  for (let index = 0; index < current.cells.length; index += 1) {
    const currentValue = heatmapDisplayValue(current.cells[index], metric, estimatedCollagenColorMax, calibration);
    const previousValue = heatmapDisplayValue(previous.cells[index], metric, estimatedCollagenColorMax, calibration);
    if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) continue;
    maximum = Math.max(maximum, Math.abs(cleanDifference(currentValue - previousValue)));
  }
  return maximum;
}

function comparisonValues({ current, previous, metric, estimatedCollagenMax, calibration }) {
  return current.cells.map((cell, index) => {
    const currentValue = heatmapDisplayValue(cell, metric, estimatedCollagenMax, calibration);
    const previousValue = heatmapDisplayValue(previous.cells[index], metric, estimatedCollagenMax, calibration);
    return Number.isFinite(currentValue) && Number.isFinite(previousValue)
      ? cleanDifference(currentValue - previousValue)
      : null;
  });
}

function cleanDifference(value) {
  return Number(value.toPrecision(15));
}

function throwIfPlanningAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Heatmap export planning aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
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
  return includeRange
    ? `${title} | Range ${formatHeatmapFigureRange(figure.colorRange.min, figure.colorRange.max, { signed: true })}`
    : title;
}

function wrapSvgText(value, maxWidth, fontSize, bold = false) {
  const lines = [];
  let remaining = String(value);
  while (estimatedSvgTextWidth(remaining, fontSize, bold) > maxWidth) {
    let fitLength = 0;
    let lastWhitespace = -1;
    for (const character of remaining) {
      const nextLength = fitLength + character.length;
      if (estimatedSvgTextWidth(remaining.slice(0, nextLength), fontSize, bold) > maxWidth) {
        break;
      }
      fitLength = nextLength;
      if (/\s/u.test(character)) lastWhitespace = fitLength - character.length;
    }
    const splitAt = lastWhitespace > 0 ? lastWhitespace : Math.max(fitLength, 1);
    lines.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}

function estimatedSvgTextWidth(value, fontSize, bold) {
  let emWidth = 0;
  for (const character of String(value)) {
    if (/\s/u.test(character)) {
      emWidth += 0.34;
    } else if (/[WM@#%&]/u.test(character)) {
      emWidth += 0.96;
    } else if (/[A-Z]/u.test(character)) {
      emWidth += 0.72;
    } else if (/[ilI1.,:;'|!]/u.test(character)) {
      emWidth += 0.32;
    } else if (character.codePointAt(0) > 0x7f) {
      emWidth += 1;
    } else {
      emWidth += 0.58;
    }
  }
  return emWidth * fontSize * (bold ? 1.06 : 1);
}

function buildGridCellPaths({
  figure,
  columns,
  rows,
  gridX,
  gridY,
  xEdges,
  yEdges,
  isComparison,
  min,
  max,
}) {
  const pathsByFill = new Map();

  for (let row = 0; row < rows; row += 1) {
    let runFill = null;
    let runStart = 0;
    for (let column = 0; column <= columns; column += 1) {
      const index = row * columns + column;
      const value = column < columns ? figure.values?.[index] ?? null : null;
      const fill = value === null
        ? null
        : heatmapValueColor({ value, isComparison, min, max });
      if (fill === runFill) continue;
      if (runFill !== null) {
        const commands = pathsByFill.get(runFill) ?? [];
        const runWidth = xEdges[column] - xEdges[runStart];
        const rowHeight = yEdges[row + 1] - yEdges[row];
        commands.push(
          `M${gridX + xEdges[runStart]} ${gridY + yEdges[row]}h${runWidth}v${rowHeight}h-${runWidth}z`,
        );
        pathsByFill.set(runFill, commands);
      }
      runFill = fill;
      runStart = column;
    }
  }

  return [...pathsByFill]
    .flatMap(([fill, commands]) => chunked(commands, MAX_PATH_COMMANDS)
      .map((chunk) => `<path fill="${fill}" d="${chunk.join("")}"/>`))
    .join("");
}

async function heatmapGridDataUrl(figure, { signal } = {}) {
  const { columns, rows, gridWidth, gridHeight, xEdges, yEdges, hasGeometry } = figureGridLayout(figure);
  // Sample at display resolution, never at source-image resolution (at most 4096^2 RGB pixels).
  const width = Math.max(1, Math.min(MAX_GRID_DISPLAY_SIZE, Math.ceil(hasGeometry ? gridWidth : Math.min(columns, gridWidth))));
  const height = Math.max(1, Math.min(MAX_GRID_DISPLAY_SIZE, Math.ceil(hasGeometry ? gridHeight : Math.min(rows, gridHeight))));
  const columnIndices = rasterAxisIndices(xEdges, width);
  const rowIndices = rasterAxisIndices(yEdges, height);
  const { min, max } = figure.colorRange;
  const isComparison = figure.kind === "comparison";
  const emptyFill = EXPORT_NO_DATA_COLOR;
  const pixels = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    throwIfPlanningAborted(signal);
    const rowOffset = y * width * 3;
    if (y > 0 && rowIndices[y] === rowIndices[y - 1]) {
      pixels.copy(pixels, rowOffset, rowOffset - width * 3, rowOffset);
      continue;
    }
    let lastColumn = -1;
    let channels;
    for (let x = 0; x < width; x += 1) {
      const column = columnIndices[x];
      if (column !== lastColumn) {
        const value = figure.values?.[rowIndices[y] * columns + column] ?? null;
        channels = hexColorChannels(value === null ? emptyFill : heatmapValueColor({ value, isComparison, min, max }));
        lastColumn = column;
      }
      const offset = rowOffset + x * 3;
      pixels[offset] = channels[0];
      pixels[offset + 1] = channels[1];
      pixels[offset + 2] = channels[2];
    }
  }

  const pipeline = sharp(pixels, {
    raw: { width, height, channels: 3 },
  }).png({ compressionLevel: 9, adaptiveFiltering: true });
  const png = await runSharpWithSignal(pipeline, () => pipeline.toBuffer(), signal);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function rasterAxisIndices(edges, length) {
  const indices = new Uint32Array(length);
  const scale = edges[edges.length - 1] / length;
  let cell = 0;
  for (let pixel = 0; pixel < length; pixel += 1) {
    const center = (pixel + 0.5) * scale;
    while (cell < edges.length - 2 && center >= edges[cell + 1]) cell += 1;
    indices[pixel] = cell;
  }
  return indices;
}

function heatmapValueColor({ value, isComparison, min, max }) {
  return isComparison
    ? differenceColor(value, Math.max(Math.abs(min), Math.abs(max)))
    : infernoColor(value, min, max);
}

function hexColorChannels(value) {
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function chunked(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function axisTicks({ gridX, gridY, gridWidth, gridHeight, columns, rows, xEdges, yEdges, hasGeometry }) {
  const ticks = [];
  const columnTicks = heatmapAxisTickValues(columns);
  const rowTicks = heatmapAxisTickValues(rows);
  for (let index = 0; index < columnTicks.length; index += 1) {
    const ratio = index / (columnTicks.length - 1);
    const column = columnTicks[index];
    const row = rowTicks[index];
    const x = gridX + (hasGeometry ? (xEdges[column] + xEdges[column + 1]) / 2 : gridWidth * ratio);
    const y = gridY + (hasGeometry ? (yEdges[row] + yEdges[row + 1]) / 2 : gridHeight * ratio);
    ticks.push(`<line x1="${x}" y1="${gridY + gridHeight}" x2="${x}" y2="${gridY + gridHeight + 6}" stroke="#111827"/>`);
    ticks.push(`<text class="tick" x="${x}" y="${gridY + gridHeight + 23}" text-anchor="middle">${column}</text>`);
    ticks.push(`<line x1="${gridX - 6}" y1="${y}" x2="${gridX}" y2="${y}" stroke="#111827"/>`);
    ticks.push(`<text class="tick" x="${gridX - 12}" y="${y + 4}" text-anchor="end">${row}</text>`);
  }
  return ticks.join("");
}

function colorBar({ isComparison, min, max, x, y, noData = false }) {
  if (noData) {
    return `<rect x="${x}" y="${y}" width="${COLOR_BAR_WIDTH}" height="${COLOR_BAR_HEIGHT}" fill="${EXPORT_NO_DATA_COLOR}" stroke="#111827"/>`;
  }
  const steps = 64;
  const parts = [];
  for (let index = 0; index < steps; index += 1) {
    const ratio = index / (steps - 1);
    const value = max - (max - min) * ratio;
    const fill = isComparison ? differenceColor(value, Math.max(Math.abs(min), Math.abs(max))) : infernoColor(value, min, max);
    parts.push(`<rect x="${x}" y="${y + ratio * COLOR_BAR_HEIGHT}" width="${COLOR_BAR_WIDTH}" height="${COLOR_BAR_HEIGHT / steps + 1}" fill="${fill}"/>`);
  }
  parts.push(`<rect x="${x}" y="${y}" width="${COLOR_BAR_WIDTH}" height="${COLOR_BAR_HEIGHT}" fill="none" stroke="#111827"/>`);
  const scaleTicks = heatmapScaleTickValues(min, max);
  for (let index = 0; index < scaleTicks.length; index += 1) {
    const ratio = index / (scaleTicks.length - 1);
    const value = scaleTicks[index];
    const tickY = y + ratio * COLOR_BAR_HEIGHT;
    parts.push(`<line x1="${x + COLOR_BAR_WIDTH}" y1="${tickY}" x2="${x + COLOR_BAR_WIDTH + 6}" y2="${tickY}" stroke="#111827"/>`);
    parts.push(`<text class="tick" x="${x + COLOR_BAR_WIDTH + 11}" y="${tickY + 4}">${escapeXml(formatHeatmapFigureNumber(value))}</text>`);
  }
  return parts.join("");
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
