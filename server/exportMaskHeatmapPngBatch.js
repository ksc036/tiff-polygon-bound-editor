import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { renderHeatmapFigure } from "./exportHeatmaps.js";
import { discoverHeatmapBundles, generateHeatmapBatch } from "./heatmapService.js";
import { readGrey16RawFromImage } from "./imageProcessing.js";
import { infernoColor } from "../src/lib/heatmap.js";

const DEFAULT_CELL_SIZES = Object.freeze([20, 50, 100]);
const DEFAULT_CALIBRATION = Object.freeze({
  slope: 0.069676956982087,
  intercept: 0.067893820336777,
});
const COLORBAR_WIDTH = 180;
const COLORBAR_HEIGHT = 390;
const BAR_X = 24;
const BAR_Y = 35;
const BAR_WIDTH = 28;
const BAR_HEIGHT = 300;

export async function exportMaskHeatmapPngBatch({
  rootPath,
  cellSizes = DEFAULT_CELL_SIZES,
} = {}) {
  const batch = await generateHeatmapBatch({ rootPath, cellSizes });
  const bundles = await discoverHeatmapBundles(rootPath);
  let generatedPngFiles = 0;

  for (const bundle of bundles) {
    for (const cellSize of cellSizes) {
      const outputDir = path.join(bundle.folderPath, "heatmap", `${cellSize}x${cellSize}`);
      const payloadPath = path.join(outputDir, `${bundle.imageFolder}.heatmap.json`);
      let heatmap;
      try {
        heatmap = JSON.parse(await readFile(payloadPath, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }

      const originalPath = await findMatchingOriginal(bundle, heatmap.width, heatmap.height);
      const originalPng = await renderOriginalPng(originalPath);
      const heatmapOnlyPng = await renderHeatmapOnlyPng(heatmap);
      const figure = pixelDensityFigure(bundle.imageFolder, heatmap);
      const annotatedPng = await renderHeatmapFigure(figure);
      const colorbarPng = await renderPixelDensityColorbarPng();
      const prefix = `${bundle.imageFolder}_cell_${cellSize}px_pixel_density`;

      await Promise.all([
        writeFile(path.join(outputDir, `${prefix}.png`), annotatedPng),
        writeFile(path.join(outputDir, `${prefix}_heatmap_only.png`), heatmapOnlyPng),
        writeFile(path.join(outputDir, `${prefix}_original.png`), originalPng),
        writeFile(path.join(outputDir, `${prefix}_colorbar.png`), colorbarPng),
      ]);
      generatedPngFiles += 4;
    }
  }

  return { ...batch, generatedPngFiles };
}

export async function renderHeatmapOnlyPng(heatmap) {
  const width = positiveInteger(heatmap?.width, "width");
  const height = positiveInteger(heatmap?.height, "height");
  const pixels = Buffer.alloc(width * height * 3);

  for (const cell of heatmap.cells ?? []) {
    const color = hexChannels(infernoColor(cell.pixelDensity, 0, 1));
    for (let y = cell.y; y < cell.y + cell.height; y += 1) {
      const start = (y * width + cell.x) * 3;
      const end = start + cell.width * 3;
      pixels.fill(color, start, end);
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

export async function renderOriginalPng(inputPath) {
  const raw = await readGrey16RawFromImage(inputPath);
  const source = new Uint16Array(raw.buffer.buffer, raw.buffer.byteOffset, raw.buffer.byteLength / 2);
  const pixels = Buffer.alloc(raw.width * raw.height);
  const range = raw.max > raw.min ? raw.max - raw.min : 1;

  for (let index = 0; index < pixels.length; index += 1) {
    const normalized = Math.min(Math.max((source[index] - raw.min) / range, 0), 1);
    pixels[index] = Math.round(normalized * 255);
  }

  return sharp(pixels, { raw: { width: raw.width, height: raw.height, channels: 1 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

export async function renderPixelDensityColorbarPng() {
  const bar = [];
  for (let y = 0; y < BAR_HEIGHT; y += 1) {
    const value = 1 - y / (BAR_HEIGHT - 1);
    bar.push(`<rect x="${BAR_X}" y="${BAR_Y + y}" width="${BAR_WIDTH}" height="1" fill="${infernoColor(value, 0, 1)}"/>`);
  }

  const ticks = [1, 0.75, 0.5, 0.25, 0].map((value, index) => {
    const y = BAR_Y + (index / 4) * (BAR_HEIGHT - 1);
    return `<line x1="${BAR_X + BAR_WIDTH}" y1="${y}" x2="${BAR_X + BAR_WIDTH + 6}" y2="${y}" stroke="#111827"/><text class="tick" x="${BAR_X + BAR_WIDTH + 11}" y="${y + 4}">${value}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLORBAR_WIDTH}" height="${COLORBAR_HEIGHT}" viewBox="0 0 ${COLORBAR_WIDTH} ${COLORBAR_HEIGHT}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <style>text { font-family: Arial, sans-serif; fill: #111827; } .axis { font-size: 13px; font-weight: 700; } .tick { font-size: 12px; }</style>
    <text class="axis" x="${BAR_X + BAR_WIDTH / 2}" y="20" text-anchor="middle">Scale</text>
    ${bar.join("")}
    <rect x="${BAR_X - 0.5}" y="${BAR_Y - 0.5}" width="${BAR_WIDTH + 1}" height="${BAR_HEIGHT + 1}" fill="none" stroke="#111827"/>
    ${ticks}
    <text class="axis" x="${COLORBAR_WIDTH / 2}" y="372" text-anchor="middle">Pixel Density (ratio)</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

function pixelDensityFigure(imageFolder, heatmap) {
  return {
    kind: "absolute",
    metric: "pixel-density",
    metricLabel: "Pixel Density",
    unit: "ratio",
    currentImage: imageFolder,
    previousImage: null,
    cellWidth: heatmap.cellWidth,
    cellHeight: heatmap.cellHeight,
    columns: heatmap.columns,
    rows: heatmap.rows,
    values: heatmap.cells.map((cell) => cell.pixelDensity),
    colorRange: { min: 0, max: 1 },
    calibration: DEFAULT_CALIBRATION,
  };
}

async function findMatchingOriginal(bundle, width, height) {
  const directories = [path.join(bundle.folderPath, "origin"), bundle.imageDir];
  const candidates = [];

  for (const directory of directories) {
    try {
      const files = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.tiff?$/i.test(entry.name))
        .map((entry) => path.join(directory, entry.name))
        .sort((left, right) => left.localeCompare(right));
      candidates.push(...files);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  for (const candidate of candidates) {
    const metadata = await sharp(candidate).metadata();
    if (metadata.width === width && metadata.height === height) return candidate;
  }

  throw new Error(`No ${width}x${height} TIFF original found for ${bundle.imageFolder}.`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Heatmap ${label} must be a positive integer.`);
  }
  return value;
}

function hexChannels(hex) {
  return Buffer.from([1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)));
}

async function main() {
  const rootPath = process.argv[2];
  const requestedSizes = process.argv.slice(3);
  const cellSizes = requestedSizes.length ? requestedSizes.map(Number) : DEFAULT_CELL_SIZES;
  const result = await exportMaskHeatmapPngBatch({ rootPath, cellSizes });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
