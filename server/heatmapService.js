import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { selectMaskSource } from "./analysisService.js";
import { createHeatmapPayload, validateCellSize, validateHeatmapPayload } from "./maskHeatmap.js";
import { readBinaryMask } from "./maskSkeleton.js";

export class HeatmapError extends Error {
  constructor(code, message, { status = 422, cause } = {}) {
    super(message, { cause });
    this.name = "HeatmapError";
    this.code = code;
    this.status = status;
  }
}

function heatmapError(code, message, status, cause) {
  return new HeatmapError(code, message, { status, cause });
}

function validateBatchRoot(rootPath) {
  if (!rootPath || !path.isAbsolute(rootPath) || !existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw heatmapError("INVALID_ROOT", "Heatmap batch root must be an existing absolute directory.", 400);
  }
  return rootPath;
}

function validatedCellSizes(cellSizes) {
  if (!Array.isArray(cellSizes) || cellSizes.length === 0) {
    throw heatmapError("INVALID_CELL_SIZE", "At least one heatmap cell size is required.", 400);
  }

  try {
    return [...new Set(cellSizes.map(validateCellSize))];
  } catch (error) {
    throw heatmapError("INVALID_CELL_SIZE", "Heatmap cell sizes must be valid positive integers.", 400, error);
  }
}

function imageFileFromEntries(entries) {
  return entries
    .filter((entry) => entry.isFile() && /\.tiff?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))[0] ?? "";
}

async function bundleImage(bundle) {
  return {
    imageFolder: bundle.imageFolder,
    imageFile: imageFileFromEntries(await readdir(bundle.imageDir, { withFileTypes: true })),
  };
}

function heatmapPath({ heatmapDir, imageFolder, cellSize }) {
  return path.join(heatmapDir, `${cellSize}x${cellSize}`, `${imageFolder}.heatmap.json`);
}

function publicFailure(imageFolder, error) {
  return {
    imageFolder,
    code: error instanceof HeatmapError ? error.code : "UNREADABLE_MASK",
    message: error instanceof HeatmapError ? error.message : "Unable to generate heatmap.",
  };
}

async function writeHeatmapAtomically(filePath, payload) {
  const outputDir = path.dirname(filePath);
  const tempPath = path.join(outputDir, `.${randomUUID()}.tmp`);

  await mkdir(outputDir, { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function discoverHeatmapBundles(rootPath) {
  const bundles = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    if (names.has("image") && names.has("mask")) {
      bundles.push({
        imageFolder: path.basename(directory),
        folderPath: directory,
        imageDir: path.join(directory, "image"),
        maskDir: path.join(directory, "mask"),
      });
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => visit(path.join(directory, entry.name))));
  }

  await visit(validateBatchRoot(rootPath));
  return bundles.sort((left, right) => left.folderPath.localeCompare(right.folderPath, undefined, { numeric: true }));
}

export async function generateHeatmapBatch({ rootPath, cellSizes, maxImagePixels } = {}) {
  const sizes = validatedCellSizes(cellSizes);
  const bundles = await discoverHeatmapBundles(rootPath);
  const result = { discovered: bundles.length, completed: 0, skipped: 0, failed: 0, generatedFiles: 0, failures: [] };

  for (const bundle of bundles) {
    try {
      const image = await bundleImage(bundle);
      const maskSource = await selectMaskSource(image, bundle.maskDir);
      if (!maskSource) {
        result.skipped += 1;
        continue;
      }

      const [mask, maskStats] = await Promise.all([
        readBinaryMask(maskSource.path, { maxImagePixels }),
        stat(maskSource.path),
      ]);
      const sourceMetadata = { file: maskSource.file, mtimeMs: maskStats.mtimeMs, size: maskStats.size };

      for (const cellSize of sizes) {
        const payload = createHeatmapPayload({ imageFolder: bundle.imageFolder, maskSource: sourceMetadata, mask, cellSize });
        await writeHeatmapAtomically(
          heatmapPath({ heatmapDir: path.join(bundle.folderPath, "heatmap"), imageFolder: bundle.imageFolder, cellSize }),
          payload,
        );
        result.generatedFiles += 1;
      }
      result.completed += 1;
    } catch (error) {
      result.failed += 1;
      result.failures.push(publicFailure(bundle.imageFolder, error));
    }
  }

  return result;
}

function savedHeatmapError(code, message, status, cause) {
  return heatmapError(code, message, status, cause);
}

export async function loadImageHeatmap(storage, id, cellSize) {
  let size;
  try {
    size = validateCellSize(cellSize);
  } catch (error) {
    throw savedHeatmapError("INVALID_HEATMAP", "Saved heatmap is invalid.", 422, error);
  }

  const image = storage.getImage(id);
  const paths = storage.imagePaths(id);
  const savedPath = heatmapPath({ heatmapDir: paths.heatmapDir, imageFolder: image.imageFolder, cellSize: size });
  let payload;

  try {
    payload = JSON.parse(await readFile(savedPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw savedHeatmapError("MISSING_HEATMAP", "Saved heatmap does not exist.", 404, error);
    }
    throw savedHeatmapError("INVALID_HEATMAP", "Saved heatmap is invalid.", 422, error);
  }

  let heatmap;
  try {
    heatmap = validateHeatmapPayload(payload, { cellSize: size });
    if (heatmap.imageFolder !== image.imageFolder) {
      throw new Error("Saved heatmap image does not match.");
    }
  } catch (error) {
    throw savedHeatmapError("INVALID_HEATMAP", "Saved heatmap is invalid.", 422, error);
  }

  let currentSource;
  try {
    currentSource = await selectMaskSource(image, paths.maskDir);
    if (!currentSource) {
      throw new Error("Mask source is unavailable.");
    }
    const metadata = await stat(currentSource.path);
    if (
      heatmap.maskSource.file !== currentSource.file ||
      heatmap.maskSource.size !== metadata.size ||
      heatmap.maskSource.mtimeMs !== metadata.mtimeMs
    ) {
      throw new Error("Mask source metadata changed.");
    }
  } catch (error) {
    throw savedHeatmapError("STALE_HEATMAP", "Saved heatmap is stale.", 409, error);
  }

  return heatmap;
}
