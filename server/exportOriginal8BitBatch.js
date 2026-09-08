import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { readGrey16RawFromImage } from "./imageProcessing.js";
import { readBinaryMask } from "./maskSkeleton.js";
import { sharpPath } from "./sharpPath.js";

const DEFAULT_COMMON_MIN = 13_350;
const DEFAULT_COMMON_MAX = 13_410;
const DEFAULT_WIDTH = 740;
const DEFAULT_HEIGHT = 740;
const MASK_OVERLAY_COLOR = [255, 0, 0];
const MASK_OVERLAY_OPACITY = 0.4;
const PERCENTILES = [0.001, 0.005, 0.01, 0.02, 0.05, 0.5, 0.95, 0.98, 0.99, 0.995, 0.999];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function mapGrey16PixelsTo8Bit(source, displayMin, displayMax) {
  if (!Number.isFinite(displayMin) || !Number.isFinite(displayMax) || displayMax <= displayMin) {
    throw new Error(`Invalid display range: ${displayMin}..${displayMax}`);
  }

  const pixels = Buffer.alloc(source.length);
  const range = displayMax - displayMin;
  for (let index = 0; index < source.length; index += 1) {
    pixels[index] = Math.round(clamp((source[index] - displayMin) / range, 0, 1) * 255);
  }
  return pixels;
}

function findRawRange(source) {
  let min = 65_535;
  let max = 0;
  for (const value of source) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function percentile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function calculatePercentiles(source) {
  const sorted = Uint16Array.from(source).sort();
  return Object.fromEntries(PERCENTILES.map((fraction) => [
    `p${String(fraction * 100).replace(".", "_")}`,
    Number(percentile(sorted, fraction).toFixed(2)),
  ]));
}

export function blendGrey8WithMask(
  greyPixels,
  maskPixels,
  color = MASK_OVERLAY_COLOR,
  opacity = MASK_OVERLAY_OPACITY,
) {
  if (greyPixels.length !== maskPixels.length) {
    throw new Error("Grey image and mask pixel counts must match.");
  }
  const pixels = Buffer.alloc(greyPixels.length * 3);
  for (let index = 0; index < greyPixels.length; index += 1) {
    const grey = greyPixels[index];
    const offset = index * 3;
    if (!maskPixels[index]) {
      pixels[offset] = grey;
      pixels[offset + 1] = grey;
      pixels[offset + 2] = grey;
      continue;
    }
    pixels[offset] = Math.round(grey * (1 - opacity) + color[0] * opacity);
    pixels[offset + 1] = Math.round(grey * (1 - opacity) + color[1] * opacity);
    pixels[offset + 2] = Math.round(grey * (1 - opacity) + color[2] * opacity);
  }
  return pixels;
}

async function renderGrey8Png(pixels, width, height) {
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function renderRgb8Png(pixels, width, height) {
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function findMaskPath(bundlePath, sourceStem) {
  const maskDir = path.join(bundlePath, "mask");
  let entries;
  try {
    entries = await readdir(maskDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const images = entries
    .filter((entry) => entry.isFile() && /\.(?:png|tiff?)$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  return images.find((entry) => path.basename(entry.name, path.extname(entry.name)) === `${sourceStem}_mask`)?.name
    ?? images.find((entry) => path.basename(entry.name, path.extname(entry.name)) === sourceStem)?.name
    ?? images[0]?.name
    ?? null;
}

async function findSourceTiff(bundlePath, expectedWidth, expectedHeight) {
  for (const childName of ["origin", "image"]) {
    const childPath = path.join(bundlePath, childName);
    let entries;
    try {
      entries = await readdir(childPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    const candidates = entries
      .filter((entry) => entry.isFile() && /\.tiff?$/i.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const candidate of candidates) {
      const candidatePath = path.join(childPath, candidate.name);
      const metadata = await sharp(sharpPath(candidatePath)).metadata();
      if (metadata.width === expectedWidth && metadata.height === expectedHeight) return candidatePath;
    }
  }
  return null;
}

export async function exportOriginal8BitBatch({
  rootPath,
  commonDisplayMin = DEFAULT_COMMON_MIN,
  commonDisplayMax = DEFAULT_COMMON_MAX,
  expectedWidth = DEFAULT_WIDTH,
  expectedHeight = DEFAULT_HEIGHT,
}) {
  const bundles = (await readdir(rootPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const records = [];

  for (const bundle of bundles) {
    const bundlePath = path.join(rootPath, bundle.name);
    const sourcePath = await findSourceTiff(
      bundlePath,
      expectedWidth,
      expectedHeight,
    );
    if (!sourcePath) continue;

    const raw = await readGrey16RawFromImage(sourcePath);
    const source = new Uint16Array(raw.buffer.buffer, raw.buffer.byteOffset, raw.buffer.byteLength / 2);
    const rawRange = findRawRange(source);
    const stem = path.basename(sourcePath, path.extname(sourcePath));
    const commonName = `${stem}_8bit_common_min${commonDisplayMin}_max${commonDisplayMax}.png`;
    const autoName = `${stem}_8bit_auto.png`;
    const maskOverlayName = `${stem}_8bit_common_min${commonDisplayMin}_max${commonDisplayMax}_mask_overlay.png`;
    const commonPath = path.join(path.dirname(sourcePath), commonName);
    const autoPath = path.join(path.dirname(sourcePath), autoName);
    const maskOverlayPath = path.join(path.dirname(sourcePath), maskOverlayName);
    const maskName = await findMaskPath(bundlePath, stem);
    if (!maskName) throw new Error(`Mask image not found for ${bundle.name}`);
    const maskPath = path.join(bundlePath, "mask", maskName);
    const mask = await readBinaryMask(maskPath);
    if (mask.width !== raw.width || mask.height !== raw.height) {
      throw new Error(`Mask dimensions do not match source TIFF for ${bundle.name}`);
    }

    const commonPixels = mapGrey16PixelsTo8Bit(source, commonDisplayMin, commonDisplayMax);
    const autoMax = rawRange.max > rawRange.min ? rawRange.max : rawRange.min + 1;
    const autoPixels = mapGrey16PixelsTo8Bit(source, rawRange.min, autoMax);
    const maskOverlayPixels = blendGrey8WithMask(commonPixels, mask.data);
    await Promise.all([
      writeFile(commonPath, await renderGrey8Png(commonPixels, raw.width, raw.height)),
      writeFile(autoPath, await renderGrey8Png(autoPixels, raw.width, raw.height)),
      writeFile(maskOverlayPath, await renderRgb8Png(maskOverlayPixels, raw.width, raw.height)),
    ]);

    records.push({
      sampleFolder: bundle.name,
      sourceTiffRelativePath: path.relative(rootPath, sourcePath),
      width: raw.width,
      height: raw.height,
      sourceBitDepth: 16,
      rawPixelMin: rawRange.min,
      rawPixelMax: rawRange.max,
      ...calculatePercentiles(source),
      commonDisplayMin,
      commonDisplayMax,
      commonPngRelativePath: path.relative(rootPath, commonPath),
      autoPngRelativePath: path.relative(rootPath, autoPath),
      maskSourceRelativePath: path.relative(rootPath, maskPath),
      maskOverlayColor: "#ff0000",
      maskOverlayOpacity: MASK_OVERLAY_OPACITY,
      maskOverlayPngRelativePath: path.relative(rootPath, maskOverlayPath),
    });
  }

  return records;
}

async function main() {
  const rootPath = process.argv[2];
  if (!rootPath) {
    throw new Error("Usage: node exportOriginal8BitBatch.js <root> [commonMin] [commonMax] [width] [height] [statsJson]");
  }
  const records = await exportOriginal8BitBatch({
    rootPath: path.resolve(rootPath),
    commonDisplayMin: Number(process.argv[3] ?? DEFAULT_COMMON_MIN),
    commonDisplayMax: Number(process.argv[4] ?? DEFAULT_COMMON_MAX),
    expectedWidth: Number(process.argv[5] ?? DEFAULT_WIDTH),
    expectedHeight: Number(process.argv[6] ?? DEFAULT_HEIGHT),
  });
  const json = `${JSON.stringify(records, null, 2)}\n`;
  if (process.argv[7]) await writeFile(path.resolve(process.argv[7]), json, "utf8");
  process.stdout.write(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
