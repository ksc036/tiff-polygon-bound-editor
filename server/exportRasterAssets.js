import sharp from "sharp";
import { resolveMaxImagePixels } from "./imageProcessing.js";
import { runSharpWithSignal } from "./sharpRender.js";

const MAX_GREY16 = 65_535;
const NORMALIZATION_ABORT_CHECK_INTERVAL = 4_096;
const HISTOGRAM_ABORT_CHECK_INTERVAL = 4_096;
const normalizedPixelsByRaster = new WeakMap();
const originalPreviewByRaster = new WeakMap();

function valueAtRank(histogram, rank, signal) {
  throwIfAborted(signal);
  let count = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    if (value % HISTOGRAM_ABORT_CHECK_INTERVAL === 0) throwIfAborted(signal);
    count += histogram[value];
    if (rank < count) {
      throwIfAborted(signal);
      return value;
    }
  }
  throwIfAborted(signal);
  return MAX_GREY16;
}

function percentileFromHistogram(histogram, length, fraction, signal) {
  throwIfAborted(signal);
  const position = (length - 1) * fraction;
  const lowerRank = Math.floor(position);
  const upperRank = Math.ceil(position);
  const lower = valueAtRank(histogram, lowerRank, signal);
  throwIfAborted(signal);
  if (lowerRank === upperRank) return lower;
  const upper = valueAtRank(histogram, upperRank, signal);
  const weight = position - lowerRank;
  throwIfAborted(signal);
  const percentile = lower * (1 - weight) + upper * weight;
  throwIfAborted(signal);
  return percentile;
}

export function percentileDisplayRange(pixels, { signal } = {}) {
  throwIfAborted(signal);
  const histogram = new Uint32Array(65_536);
  for (let index = 0; index < pixels.length; index += 1) {
    if (index % HISTOGRAM_ABORT_CHECK_INTERVAL === 0) throwIfAborted(signal);
    histogram[pixels[index]] += 1;
  }
  throwIfAborted(signal);
  const displayMin = percentileFromHistogram(histogram, pixels.length, 0.01, signal);
  const rawMax = percentileFromHistogram(histogram, pixels.length, 0.998, signal);
  throwIfAborted(signal);
  if (rawMax > displayMin) return { displayMin, displayMax: rawMax };
  return displayMin < MAX_GREY16
    ? { displayMin, displayMax: displayMin + 1 }
    : { displayMin: MAX_GREY16 - 1, displayMax: MAX_GREY16 };
}

export async function readExportRaster({ imagePath, maxImagePixels, signal }) {
  throwIfAborted(signal);
  const pipeline = sharp(imagePath, {
    limitInputPixels: resolveMaxImagePixels(maxImagePixels),
  })
    .toColourspace("grey16")
    .raw({ depth: "ushort" });
  const { data, info } = await runSharpWithSignal(
    pipeline,
    () => pipeline.toBuffer({ resolveWithObject: true }),
    signal,
  );
  throwIfAborted(signal);
  const pixels = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const displayRange = percentileDisplayRange(pixels, { signal });
  throwIfAborted(signal);
  return { width: info.width, height: info.height, pixels, ...displayRange };
}

function normalizedPixelsFor(raster, signal) {
  throwIfAborted(signal);
  const cached = normalizedPixelsByRaster.get(raster);
  if (cached) return cached;

  const normalized = Buffer.alloc(raster.pixels.length);
  const range = raster.displayMax - raster.displayMin;
  for (let index = 0; index < raster.pixels.length; index += 1) {
    if (index % NORMALIZATION_ABORT_CHECK_INTERVAL === 0) throwIfAborted(signal);
    const fraction = Math.min(Math.max((raster.pixels[index] - raster.displayMin) / range, 0), 1);
    normalized[index] = Math.round(fraction * 255);
  }
  throwIfAborted(signal);
  normalizedPixelsByRaster.set(raster, normalized);
  return normalized;
}

function sharpFromNormalizedRaster(raster, signal) {
  return sharp(normalizedPixelsFor(raster, signal), {
    raw: {
      width: raster.width,
      height: raster.height,
      channels: 1,
    },
  });
}

export async function renderOriginalPreview(raster, { signal } = {}) {
  throwIfAborted(signal);
  const cached = originalPreviewByRaster.get(raster);
  if (cached) return cached;

  const pipeline = sharpFromNormalizedRaster(raster, signal)
    .png({ compressionLevel: 9, adaptiveFiltering: true });
  const preview = await runSharpWithSignal(pipeline, () => pipeline.toBuffer(), signal);
  throwIfAborted(signal);
  originalPreviewByRaster.set(raster, preview);
  return preview;
}

export async function renderAnnotatedOriginal(raster, crop, { signal } = {}) {
  throwIfAborted(signal);
  const right = crop.x + crop.width - 0.5;
  const bottom = crop.y + crop.height - 0.5;
  const rectangleMarkup = crop.width === 1 || crop.height === 1
    ? `<rect x="${crop.x}" y="${crop.y}" width="${crop.width}" height="${crop.height}" fill="#ff0000"/>`
    : `<path d="M ${crop.x + 0.5} ${crop.y + 0.5} H ${right} V ${bottom} H ${crop.x + 0.5} Z" fill="none" stroke="#ff0000" stroke-width="1" shape-rendering="crispEdges"/>`;
  const rectangle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${raster.width}" height="${raster.height}" viewBox="0 0 ${raster.width} ${raster.height}">
  ${rectangleMarkup}
</svg>`);

  const pipeline = sharp(await renderOriginalPreview(raster, { signal }))
    .composite([{ input: rectangle }])
    .png({ compressionLevel: 9, adaptiveFiltering: true });
  return runSharpWithSignal(pipeline, () => pipeline.toBuffer(), signal);
}

export async function renderSubimagePreview(raster, crop, { signal } = {}) {
  throwIfAborted(signal);
  const pipeline = sharpFromNormalizedRaster(raster, signal)
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .png({ compressionLevel: 9, adaptiveFiltering: true });
  return runSharpWithSignal(pipeline, () => pipeline.toBuffer(), signal);
}

function csvValue(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createSubimageDimensionsCsv({ imageFolder, source, crop }) {
  const rows = [
    ["field", "value"],
    ["image_folder", imageFolder],
    ["source_width", source.width],
    ["source_height", source.height],
    ["crop_x", crop.x],
    ["crop_y", crop.y],
    ["crop_width", crop.width],
    ["crop_height", crop.height],
    ["original_16bit_filename", "original_16bit.tif"],
    ["original_8bit_filename", "original_8bit.png"],
    ["annotated_original_filename", "original_with_subimage.png"],
    ["subimage_16bit_filename", "subimage_16bit.tif"],
    ["subimage_8bit_filename", "subimage_8bit.png"],
  ];
  return Buffer.from(`${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`, "utf8");
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Raster export aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}
