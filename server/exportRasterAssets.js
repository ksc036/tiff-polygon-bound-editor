import sharp from "sharp";
import { readGrey16RawFromImage } from "./imageProcessing.js";

const MAX_GREY16 = 65_535;
const normalizedPixelsByRaster = new WeakMap();
const originalPreviewByRaster = new WeakMap();

function valueAtRank(histogram, rank) {
  let count = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    count += histogram[value];
    if (rank < count) return value;
  }
  return MAX_GREY16;
}

function percentileFromHistogram(histogram, length, fraction) {
  const position = (length - 1) * fraction;
  const lowerRank = Math.floor(position);
  const upperRank = Math.ceil(position);
  const lower = valueAtRank(histogram, lowerRank);
  if (lowerRank === upperRank) return lower;
  const upper = valueAtRank(histogram, upperRank);
  const weight = position - lowerRank;
  return lower * (1 - weight) + upper * weight;
}

export function percentileDisplayRange(pixels) {
  const histogram = new Uint32Array(65_536);
  for (const value of pixels) histogram[value] += 1;
  const displayMin = percentileFromHistogram(histogram, pixels.length, 0.01);
  const rawMax = percentileFromHistogram(histogram, pixels.length, 0.998);
  if (rawMax > displayMin) return { displayMin, displayMax: rawMax };
  return displayMin < MAX_GREY16
    ? { displayMin, displayMax: displayMin + 1 }
    : { displayMin: MAX_GREY16 - 1, displayMax: MAX_GREY16 };
}

export async function readExportRaster({ imagePath, maxImagePixels }) {
  const raw = await readGrey16RawFromImage(imagePath, { maxImagePixels });
  const pixels = new Uint16Array(raw.buffer.buffer, raw.buffer.byteOffset, raw.buffer.byteLength / 2);
  return { width: raw.width, height: raw.height, pixels, ...percentileDisplayRange(pixels) };
}

function normalizedPixelsFor(raster) {
  const cached = normalizedPixelsByRaster.get(raster);
  if (cached) return cached;

  const normalized = Buffer.alloc(raster.pixels.length);
  const range = raster.displayMax - raster.displayMin;
  for (let index = 0; index < raster.pixels.length; index += 1) {
    const fraction = Math.min(Math.max((raster.pixels[index] - raster.displayMin) / range, 0), 1);
    normalized[index] = Math.round(fraction * 255);
  }
  normalizedPixelsByRaster.set(raster, normalized);
  return normalized;
}

function sharpFromNormalizedRaster(raster) {
  return sharp(normalizedPixelsFor(raster), {
    raw: {
      width: raster.width,
      height: raster.height,
      channels: 1,
    },
  });
}

export function renderOriginalPreview(raster) {
  const cached = originalPreviewByRaster.get(raster);
  if (cached) return cached;

  const preview = sharpFromNormalizedRaster(raster)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  originalPreviewByRaster.set(raster, preview);
  return preview;
}

export async function renderAnnotatedOriginal(raster, crop) {
  const right = crop.x + crop.width - 0.5;
  const bottom = crop.y + crop.height - 0.5;
  const rectangleMarkup = crop.width === 1 || crop.height === 1
    ? `<rect x="${crop.x}" y="${crop.y}" width="${crop.width}" height="${crop.height}" fill="#ff0000"/>`
    : `<path d="M ${crop.x + 0.5} ${crop.y + 0.5} H ${right} V ${bottom} H ${crop.x + 0.5} Z" fill="none" stroke="#ff0000" stroke-width="1" shape-rendering="crispEdges"/>`;
  const rectangle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${raster.width}" height="${raster.height}" viewBox="0 0 ${raster.width} ${raster.height}">
  ${rectangleMarkup}
</svg>`);

  return sharp(await renderOriginalPreview(raster))
    .composite([{ input: rectangle }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

export function renderSubimagePreview(raster, crop) {
  return sharpFromNormalizedRaster(raster)
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
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
