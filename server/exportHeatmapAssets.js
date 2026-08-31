import { constants as bufferConstants } from "node:buffer";
import sharp from "sharp";
import { COLLAGEN_DENSITY_DISPLAY_MAX } from "../shared/collagenDensity.js";
import {
  differenceColor,
  heatmapCompatibilityError,
  heatmapMetricValue,
  infernoColor,
} from "../src/lib/heatmap.js";
import { loadImageHeatmap } from "./heatmapService.js";
import { resolveMaxImagePixels } from "./imageProcessing.js";
import { runSharpWithSignal } from "./sharpRender.js";

export const ESTIMATED_HEATMAP_CELL_SIZES = Object.freeze([20, 50, 100]);

const METRIC = "estimated-collagen-density";
const METRIC_LABEL = "Estimated Collagen Density";
const UNIT = "mg/ml";
const RGB_CHANNELS = 3;
const RENDER_ABORT_CHECK_INTERVAL = 4_096;
const ABSOLUTE_SCALE_LAYOUT = Object.freeze({
  width: 220,
  height: 360,
  barX: 28,
  barY: 40,
  barWidth: 32,
  barHeight: 280,
});
const COMPARISON_SCALE_LAYOUT = Object.freeze({
  width: 440,
  height: 150,
  barX: 40,
  barY: 48,
  barWidth: 360,
  barHeight: 32,
});

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function yieldAfterRenderChunk(signal) {
  throwIfAborted(signal);
  await yieldToEventLoop();
  throwIfAborted(signal);
}

export async function planEstimatedHeatmapAssets({
  storage,
  images,
  cropsByImage = new Map(),
  sourceDimensionsByImage = new Map(),
  loadHeatmap = loadImageHeatmap,
  signal,
}) {
  const descriptors = [];
  const comparisonDescriptors = [];
  const reportEntries = [];
  const availability = new Map();
  const ranges = new Map(ESTIMATED_HEATMAP_CELL_SIZES.map((cellSize) => [cellSize, 0]));

  for (const image of images) {
    const crop = cropFor(cropsByImage, image);
    for (const cellSize of ESTIMATED_HEATMAP_CELL_SIZES) {
      throwIfAborted(signal);
      try {
        const source = await loadHeatmap(storage, image.id, cellSize);
        throwIfAborted(signal);
        const sourceDimensionReason = currentSourceDimensionReason(
          dimensionsFor(sourceDimensionsByImage, image),
          source,
        );
        if (sourceDimensionReason) {
          availability.set(sourceKey(image.id, cellSize), {
            status: "Skipped",
            reason: sourceDimensionReason,
          });
          reportEntries.push(skippedReportEntry({
            kind: "absolute-full",
            image,
            cellSize,
            reason: sourceDimensionReason,
          }));
          reportEntries.push(skippedReportEntry({
            kind: "absolute-subimage",
            image,
            cellSize,
            reason: sourceDimensionReason,
          }));
          continue;
        }
        availability.set(sourceKey(image.id, cellSize), { status: "Included" });
        descriptors.push(absoluteDescriptor({ image, source, cellSize, crop: null }));
        const cropReason = absoluteSubimageReason(crop, source);
        if (!cropReason) {
          descriptors.push(absoluteDescriptor({ image, source, cellSize, crop }));
        } else {
          reportEntries.push(skippedReportEntry({
            kind: "absolute-subimage",
            image,
            cellSize,
            reason: cropReason,
          }));
        }
      } catch (error) {
        rethrowAbort(error, signal);
        const reason = heatmapSkipReason(error);
        availability.set(sourceKey(image.id, cellSize), { status: "Skipped", reason });
        reportEntries.push(skippedReportEntry({
          kind: "absolute-full",
          image,
          cellSize,
          reason,
        }));
        reportEntries.push(skippedReportEntry({
          kind: "absolute-subimage",
          image,
          cellSize,
          reason,
        }));
      }
    }
  }

  for (let index = 1; index < images.length; index += 1) {
    const currentImage = images[index];
    const previousImage = images[index - 1];
    const currentCrop = cropFor(cropsByImage, currentImage);
    const previousCrop = cropFor(cropsByImage, previousImage);

    for (const cellSize of ESTIMATED_HEATMAP_CELL_SIZES) {
      throwIfAborted(signal);
      const currentAvailability = availability.get(sourceKey(currentImage.id, cellSize));
      const previousAvailability = availability.get(sourceKey(previousImage.id, cellSize));
      const unavailableReason = comparisonSourceReason(currentAvailability, previousAvailability);
      if (unavailableReason) {
        reportEntries.push(skippedReportEntry({
          kind: "comparison-full",
          image: currentImage,
          previousImage,
          cellSize,
          reason: unavailableReason,
        }));
        reportEntries.push(skippedReportEntry({
          kind: "comparison-subimage",
          image: currentImage,
          previousImage,
          cellSize,
          reason: unavailableReason,
        }));
        continue;
      }

      let current;
      let previous;
      try {
        current = await loadHeatmap(storage, currentImage.id, cellSize);
        throwIfAborted(signal);
        previous = await loadHeatmap(storage, previousImage.id, cellSize);
        throwIfAborted(signal);
      } catch (error) {
        rethrowAbort(error, signal);
        const reason = heatmapSkipReason(error);
        reportEntries.push(skippedReportEntry({
          kind: "comparison-full",
          image: currentImage,
          previousImage,
          cellSize,
          reason,
        }));
        reportEntries.push(skippedReportEntry({
          kind: "comparison-subimage",
          image: currentImage,
          previousImage,
          cellSize,
          reason,
        }));
        continue;
      }

      const currentValues = densityValues(current);
      const previousValues = densityValues(previous);
      const compatibilityError = heatmapCompatibilityError(current, previous);
      if (compatibilityError) {
        reportEntries.push(skippedReportEntry({
          kind: "comparison-full",
          image: currentImage,
          previousImage,
          cellSize,
          reason: compatibilityError,
        }));
      } else {
        comparisonDescriptors.push(comparisonDescriptor({
          kind: "comparison-full",
          currentImage,
          previousImage,
          source: current,
          cellSize,
          currentCrop: null,
          previousCrop: null,
        }));
        ranges.set(cellSize, Math.max(
          ranges.get(cellSize),
          fullComparisonMaxAbs(currentValues, previousValues),
        ));
      }

      const cropReason = subimageComparisonReason({
        currentCrop,
        previousCrop,
        current,
        previous,
      });
      if (cropReason) {
        reportEntries.push(skippedReportEntry({
          kind: "comparison-subimage",
          image: currentImage,
          previousImage,
          cellSize,
          reason: cropReason,
        }));
      } else {
        comparisonDescriptors.push(comparisonDescriptor({
          kind: "comparison-subimage",
          currentImage,
          previousImage,
          source: current,
          cellSize,
          currentCrop,
          previousCrop,
        }));
        ranges.set(cellSize, Math.max(
          ranges.get(cellSize),
          subimageComparisonMaxAbs({
            current,
            previous,
            currentCrop,
            previousCrop,
            currentValues,
            previousValues,
          }),
        ));
      }
    }
  }

  for (const descriptor of comparisonDescriptors) {
    const maxAbs = ranges.get(descriptor.sourceCellSize) ?? 0;
    descriptors.push({
      ...descriptor,
      maxAbs,
      colorRange: maxAbs === 0 ? { min: 0, max: 0 } : { min: -maxAbs, max: maxAbs },
    });
  }

  return { descriptors, ranges, reportEntries };
}

export async function hydrateEstimatedHeatmapAsset(
  descriptor,
  { storage, loadHeatmap = loadImageHeatmap, signal } = {},
) {
  throwIfAborted(signal);
  const current = await loadHeatmap(storage, descriptor.currentImageId, descriptor.sourceCellSize);
  throwIfAborted(signal);
  const currentCrop = descriptor.currentCrop ?? fullCrop(current);
  const currentValues = densityValues(current);

  if (!descriptor.kind.startsWith("comparison")) {
    const valueAt = boundedValueAt(
      descriptor.width,
      descriptor.height,
      (x, y) => densityAt(current, currentValues, currentCrop.x + x, currentCrop.y + y),
    );
    return {
      ...descriptor,
      isComparison: false,
      values: compactDensityValues(current, currentCrop, currentValues),
      valueAt,
    };
  }

  const previous = await loadHeatmap(storage, descriptor.previousImageId, descriptor.sourceCellSize);
  throwIfAborted(signal);
  const previousCrop = descriptor.previousCrop ?? fullCrop(previous);
  const previousValues = densityValues(previous);
  if (descriptor.kind === "comparison-full") {
    const compatibilityError = heatmapCompatibilityError(current, previous);
    if (compatibilityError) throw new Error(compatibilityError);
  }

  const comparison = (x, y) => comparisonAt({
    current,
    previous,
    currentCrop,
    previousCrop,
    currentValues,
    previousValues,
    x,
    y,
  });
  return {
    ...descriptor,
    isComparison: true,
    values: descriptor.kind === "comparison-full"
      ? fullComparisonValues(currentValues, previousValues)
      : compactComparisonValues({
        current,
        previous,
        currentCrop,
        previousCrop,
        currentValues,
        previousValues,
      }),
    valueAt: boundedValueAt(descriptor.width, descriptor.height, comparison),
  };
}

export async function renderEstimatedHeatmapAsset(asset, { signal, maxImagePixels } = {}) {
  throwIfAborted(signal);
  const width = positiveSafeInteger(asset?.width, "Heatmap asset width");
  const height = positiveSafeInteger(asset?.height, "Heatmap asset height");
  if (typeof asset?.valueAt !== "function") {
    throw new TypeError("Heatmap asset valueAt must be a function.");
  }

  const pixelCount = safeAllocationProduct(width, height);
  const pixelLimit = resolveMaxImagePixels(maxImagePixels);
  if (pixelCount > pixelLimit) {
    throw new RangeError("Heatmap asset exceeds the configured maximum image pixel count.");
  }
  const byteLength = safeAllocationProduct(pixelCount, RGB_CHANNELS);
  if (byteLength > bufferConstants.MAX_LENGTH) {
    throw new RangeError("Heatmap asset dimensions exceed safe allocation limits.");
  }

  throwIfAborted(signal);
  const pixels = Buffer.alloc(byteLength);
  const isComparison = asset.isComparison ?? asset.kind?.startsWith("comparison");
  const colorCache = new Map();
  for (let index = 0; index < pixelCount; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const value = asset.valueAt(x, y);
    const key = Number.isFinite(value) ? value : "no-data";
    let color = colorCache.get(key);
    if (!color) {
      color = hexChannels(isComparison
        ? differenceColor(value, asset.maxAbs)
        : infernoColor(value, 0, COLLAGEN_DENSITY_DISPLAY_MAX));
      colorCache.set(key, color);
    }
    writeRgb(pixels, index, color);
    if ((index + 1) % RENDER_ABORT_CHECK_INTERVAL === 0) {
      await yieldAfterRenderChunk(signal);
    }
  }

  throwIfAborted(signal);
  const pipeline = sharp(pixels, {
    raw: { width, height, channels: RGB_CHANNELS },
    limitInputPixels: pixelLimit,
  }).png({ compressionLevel: 9, adaptiveFiltering: true });
  return runSharpWithSignal(pipeline, () => pipeline.toBuffer(), signal);
}

export async function renderHeatmapScaleAsset(input = {}) {
  const isComparison = input.kind === "comparison" || input.isComparison === true;
  const layout = isComparison ? COMPARISON_SCALE_LAYOUT : ABSOLUTE_SCALE_LAYOUT;
  const pixels = Buffer.alloc(layout.width * layout.height * 3, 255);
  const maxAbs = Number.isFinite(input.maxAbs) && input.maxAbs > 0 ? input.maxAbs : 0;

  if (isComparison) {
    for (let offset = 0; offset < layout.barWidth; offset += 1) {
      const half = layout.barWidth / 2;
      const value = offset < half
        ? -maxAbs * (1 - offset / (half - 1))
        : maxAbs * ((offset - half) / (half - 1));
      const color = hexChannels(differenceColor(value, maxAbs));
      for (let y = layout.barY; y < layout.barY + layout.barHeight; y += 1) {
        writeRgb(pixels, y * layout.width + layout.barX + offset, color);
      }
    }
  } else {
    for (let offset = 0; offset < layout.barHeight; offset += 1) {
      const value = COLLAGEN_DENSITY_DISPLAY_MAX * (1 - offset / (layout.barHeight - 1));
      const color = hexChannels(infernoColor(value, 0, COLLAGEN_DENSITY_DISPLAY_MAX));
      for (let x = layout.barX; x < layout.barX + layout.barWidth; x += 1) {
        writeRgb(pixels, (layout.barY + offset) * layout.width + x, color);
      }
    }
  }

  const labels = scaleLabelsSvg({ isComparison, maxAbs, cellSize: input.cellSize, layout });
  return sharp(pixels, { raw: { width: layout.width, height: layout.height, channels: 3 } })
    .composite([{ input: Buffer.from(labels) }])
    .removeAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

function absoluteDescriptor({ image, source, cellSize, crop }) {
  return {
    kind: crop ? "absolute-subimage" : "absolute-full",
    metric: METRIC,
    metricLabel: METRIC_LABEL,
    unit: UNIT,
    currentImage: imageLabel(image),
    currentImageId: image.id,
    previousImage: null,
    previousImageId: null,
    sourceCellSize: cellSize,
    cellSize,
    width: crop?.width ?? source.width,
    height: crop?.height ?? source.height,
    currentCrop: crop ? { ...crop } : null,
    previousCrop: null,
    colorRange: { min: 0, max: COLLAGEN_DENSITY_DISPLAY_MAX },
    ...heatmapMetadata(source),
  };
}

function comparisonDescriptor({
  kind,
  currentImage,
  previousImage,
  source,
  cellSize,
  currentCrop,
  previousCrop,
}) {
  return {
    kind,
    metric: METRIC,
    metricLabel: METRIC_LABEL,
    unit: UNIT,
    currentImage: imageLabel(currentImage),
    currentImageId: currentImage.id,
    previousImage: imageLabel(previousImage),
    previousImageId: previousImage.id,
    sourceCellSize: cellSize,
    cellSize,
    width: currentCrop?.width ?? source.width,
    height: currentCrop?.height ?? source.height,
    currentCrop: currentCrop ? { ...currentCrop } : null,
    previousCrop: previousCrop ? { ...previousCrop } : null,
    ...heatmapMetadata(source),
  };
}

function heatmapMetadata(source) {
  return {
    sourceWidth: source.width,
    sourceHeight: source.height,
    cellWidth: source.cellWidth,
    cellHeight: source.cellHeight,
    columns: source.columns,
    rows: source.rows,
  };
}

function densityValues(source) {
  return source.cells.map((cell) => heatmapMetricValue(cell, METRIC));
}

function compactDensityValues(source, crop, densityByCell = densityValues(source)) {
  const sampled = [];
  const xOffsets = sourceBoundaryOffsets(source, crop, "x", "width", "cellWidth");
  const yOffsets = sourceBoundaryOffsets(source, crop, "y", "height", "cellHeight");
  for (const y of yOffsets) {
    for (const x of xOffsets) {
      sampled.push(densityAt(source, densityByCell, crop.x + x, crop.y + y));
    }
  }
  return sampled;
}

function compactComparisonValues({
  current,
  previous,
  currentCrop,
  previousCrop,
  currentValues = densityValues(current),
  previousValues = densityValues(previous),
}) {
  const { xOffsets, yOffsets } = comparisonBoundaryOffsets({
    current,
    previous,
    currentCrop,
    previousCrop,
  });
  const values = [];
  for (const y of yOffsets) {
    for (const x of xOffsets) {
      values.push(comparisonAt({
        current,
        previous,
        currentCrop,
        previousCrop,
        currentValues,
        previousValues,
        x,
        y,
      }));
    }
  }
  return values;
}

function fullComparisonValues(currentValues, previousValues) {
  return currentValues.map((value, index) => finiteDifference(value, previousValues[index]));
}

function fullComparisonMaxAbs(currentValues, previousValues) {
  return finiteMaxAbs(fullComparisonValues(currentValues, previousValues));
}

function subimageComparisonMaxAbs(input) {
  return finiteMaxAbs(compactComparisonValues(input));
}

function comparisonBoundaryOffsets({ current, previous, currentCrop, previousCrop }) {
  return {
    xOffsets: mergeOffsets(
      sourceBoundaryOffsets(current, currentCrop, "x", "width", "cellWidth"),
      sourceBoundaryOffsets(previous, previousCrop, "x", "width", "cellWidth"),
    ),
    yOffsets: mergeOffsets(
      sourceBoundaryOffsets(current, currentCrop, "y", "height", "cellHeight"),
      sourceBoundaryOffsets(previous, previousCrop, "y", "height", "cellHeight"),
    ),
  };
}

function sourceBoundaryOffsets(source, crop, positionKey, lengthKey, cellSizeKey) {
  const offsets = [0];
  const start = crop[positionKey];
  const length = crop[lengthKey];
  const cellSize = source[cellSizeKey];
  for (
    let boundary = (Math.floor(start / cellSize) + 1) * cellSize;
    boundary < start + length;
    boundary += cellSize
  ) {
    offsets.push(boundary - start);
  }
  return offsets;
}

function mergeOffsets(left, right) {
  return [...new Set([...left, ...right])].sort((a, b) => a - b);
}

function densityAt(source, densityByCell, x, y) {
  if (
    !Number.isFinite(x) || !Number.isFinite(y) ||
    x < 0 || y < 0 || x >= source.width || y >= source.height
  ) {
    return null;
  }
  const column = Math.floor(x / source.cellWidth);
  const row = Math.floor(y / source.cellHeight);
  return densityByCell[row * source.columns + column] ?? null;
}

function comparisonAt({
  current,
  previous,
  currentCrop,
  previousCrop,
  currentValues,
  previousValues,
  x,
  y,
}) {
  return finiteDifference(
    densityAt(current, currentValues, currentCrop.x + x, currentCrop.y + y),
    densityAt(previous, previousValues, previousCrop.x + x, previousCrop.y + y),
  );
}

function finiteDifference(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous)
    ? Number((current - previous).toPrecision(15))
    : null;
}

function finiteMaxAbs(values) {
  let maximum = 0;
  for (const value of values) {
    if (Number.isFinite(value)) maximum = Math.max(maximum, Math.abs(value));
  }
  return maximum;
}

function boundedValueAt(width, height, valueAt) {
  return (x, y) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
      return null;
    }
    return valueAt(x, y);
  };
}

function fullCrop(source) {
  return { x: 0, y: 0, width: source.width, height: source.height };
}

function cropFor(cropsByImage, image) {
  if (cropsByImage instanceof Map) {
    return cropsByImage.get(image.id) ?? cropsByImage.get(imageLabel(image)) ?? null;
  }
  return cropsByImage?.[image.id] ?? cropsByImage?.[imageLabel(image)] ?? null;
}

function dimensionsFor(sourceDimensionsByImage, image) {
  if (sourceDimensionsByImage instanceof Map) {
    return sourceDimensionsByImage.get(image.id) ?? sourceDimensionsByImage.get(imageLabel(image)) ?? null;
  }
  return sourceDimensionsByImage?.[image.id] ?? sourceDimensionsByImage?.[imageLabel(image)] ?? null;
}

function currentSourceDimensionReason(dimensions, source) {
  if (!dimensions) return "Current TIFF dimensions are unavailable for heatmap validation.";
  if (dimensions.status === "Skipped") {
    return dimensions.reason ?? "Current TIFF dimensions are unavailable for heatmap validation.";
  }
  if (dimensions.width !== source.width || dimensions.height !== source.height) {
    return "Saved heatmap dimensions do not match the current TIFF.";
  }
  return null;
}

function absoluteSubimageReason(crop, source) {
  if (!crop) return "Saved Subimage is unavailable.";
  if (!isCropValidForHeatmap(crop, source)) {
    return "Saved Subimage crop is invalid for this heatmap.";
  }
  return null;
}

function subimageComparisonReason({ currentCrop, previousCrop, current, previous }) {
  if (!currentCrop && !previousCrop) return "Current and previous Subimages are unavailable.";
  if (!currentCrop) return "Current Subimage is unavailable.";
  if (!previousCrop) return "Previous Subimage is unavailable.";
  if (!isCropValidForHeatmap(currentCrop, current)) {
    return "Current Subimage crop is invalid for its heatmap.";
  }
  if (!isCropValidForHeatmap(previousCrop, previous)) {
    return "Previous Subimage crop is invalid for its heatmap.";
  }
  if (currentCrop.width !== previousCrop.width || currentCrop.height !== previousCrop.height) {
    return "Subimage dimensions do not match previous image.";
  }
  return null;
}

function isCropValidForHeatmap(crop, source) {
  const fields = ["sourceWidth", "sourceHeight", "x", "y", "width", "height"];
  if (!crop || fields.some((field) => !Number.isInteger(crop[field]))) return false;
  if (crop.sourceWidth <= 0 || crop.sourceHeight <= 0 || crop.width <= 0 || crop.height <= 0) {
    return false;
  }
  if (crop.x < 0 || crop.y < 0) return false;
  if (crop.sourceWidth !== source.width || crop.sourceHeight !== source.height) return false;
  if (crop.width > source.width || crop.height > source.height) return false;
  return crop.x <= source.width - crop.width && crop.y <= source.height - crop.height;
}

function skippedReportEntry({ kind, image, previousImage = null, cellSize, reason }) {
  const currentImage = imageLabel(image);
  const previousLabel = previousImage ? imageLabel(previousImage) : null;
  return {
    status: "Skipped",
    artifact: "Heatmap",
    kind,
    metric: METRIC,
    currentImage,
    previousImage: previousLabel,
    sourceCellSize: cellSize,
    cellSize,
    reason,
    message: `${currentImage}${previousLabel ? ` vs ${previousLabel}` : ""} ${kind} skipped: ${reason}`,
  };
}

function comparisonSourceReason(current, previous) {
  if (current?.status === "Included" && previous?.status === "Included") return null;
  if (current?.status !== "Included" && previous?.status !== "Included") {
    return `Current heatmap unavailable: ${current?.reason ?? "Saved heatmap is unavailable."} Previous heatmap unavailable: ${previous?.reason ?? "Saved heatmap is unavailable."}`;
  }
  if (current?.status !== "Included") {
    return `Current heatmap unavailable: ${current?.reason ?? "Saved heatmap is unavailable."}`;
  }
  return `Previous heatmap unavailable: ${previous?.reason ?? "Saved heatmap is unavailable."}`;
}

function heatmapSkipReason(error) {
  const reasons = {
    MISSING_HEATMAP: "Saved heatmap is missing.",
    STALE_HEATMAP: "Saved heatmap is stale.",
    INVALID_HEATMAP: "Saved heatmap is invalid.",
  };
  return reasons[error?.code] ?? "Saved heatmap is unavailable.";
}

function rethrowAbort(error, signal) {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
  throwIfAborted(signal);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Heatmap asset operation aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function sourceKey(imageId, cellSize) {
  return `${imageId}:${cellSize}`;
}

function imageLabel(image) {
  return String(image?.imageFolder ?? image?.id ?? "image");
}

function scaleLabelsSvg({ isComparison, maxAbs, cellSize, layout }) {
  if (isComparison) {
    const centerX = layout.barX + layout.barWidth / 2;
    const rightX = layout.barX + layout.barWidth;
    const title = Number.isFinite(cellSize)
      ? `Estimated Collagen Density Difference - ${cellSize}x${cellSize} px`
      : "Estimated Collagen Density Difference";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
  <style>text { font-family: Arial, sans-serif; fill: #111827; } .title { font-size: 13px; font-weight: 700; } .tick { font-size: 12px; }</style>
  <text class="title" x="${layout.width / 2}" y="20" text-anchor="middle">${title}</text>
  <text class="tick" x="${layout.barX}" y="100" text-anchor="middle">-${formatScaleNumber(maxAbs)}</text>
  <text class="tick" x="${centerX}" y="100" text-anchor="middle">0</text>
  <text class="tick" x="${rightX}" y="100" text-anchor="middle">+${formatScaleNumber(maxAbs)}</text>
  <text class="title" x="${layout.width / 2}" y="128" text-anchor="middle">mg/ml</text>
</svg>`;
  }

  const rightX = layout.barX + layout.barWidth + 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
  <style>text { font-family: Arial, sans-serif; fill: #111827; } .title { font-size: 13px; font-weight: 700; } .tick { font-size: 12px; }</style>
  <text class="title" x="${layout.width / 2}" y="20" text-anchor="middle">Estimated Collagen Density</text>
  <text class="tick" x="${rightX}" y="44">8</text>
  <text class="tick" x="${rightX}" y="184">4</text>
  <text class="tick" x="${rightX}" y="320">0</text>
  <text class="title" x="${layout.width / 2}" y="348" text-anchor="middle">mg/ml</text>
</svg>`;
}

function formatScaleNumber(value) {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(6)).toString();
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function safeAllocationProduct(left, right) {
  if (left > Number.MAX_SAFE_INTEGER / right) {
    throw new RangeError("Heatmap asset dimensions exceed safe allocation limits.");
  }
  return left * right;
}

function hexChannels(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function writeRgb(pixels, pixelIndex, color) {
  const offset = pixelIndex * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}
