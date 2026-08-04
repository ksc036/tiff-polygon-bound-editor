import { randomUUID } from "node:crypto";
import {
  access as defaultAccess,
  copyFile as defaultCopyFile,
  mkdir as defaultMkdir,
  rename as defaultRename,
  rm as defaultRm,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { resolveMaxImagePixels } from "./imageProcessing.js";

export class SubimageError extends Error {
  constructor(code, message, { status = 422, details = null, cause } = {}) {
    super(message, { cause });
    this.name = "SubimageError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function sharpInputOptions(maxImagePixels) {
  return { limitInputPixels: resolveMaxImagePixels(maxImagePixels) };
}

async function defaultRenderCropTiff({ sourcePath, tempPath, crop, maxImagePixels }) {
  await sharp(sourcePath, sharpInputOptions(maxImagePixels))
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .toColourspace("grey16")
    .tiff({ compression: "lzw" })
    .toFile(tempPath);
}

function dependencies(options = {}) {
  return {
    access: defaultAccess,
    copyFile: defaultCopyFile,
    mkdir: defaultMkdir,
    rename: defaultRename,
    rm: defaultRm,
    renderCropTiff: defaultRenderCropTiff,
    ...options.__testDependencies,
  };
}

function isMissingFile(error) {
  return error?.code === "ENOENT";
}

async function fileExists(filePath, deps, { errorCode = "INVALID_SAVED_CROP", errorMessage = "Unable to inspect saved subimage TIFF." } = {}) {
  try {
    await deps.access(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw new SubimageError(errorCode, errorMessage, { cause: error });
  }
}

async function cleanupTemporaryFiles(deps, ...filePaths) {
  await Promise.all(filePaths.map(async (filePath) => {
    try {
      await deps.rm(filePath, { force: true });
    } catch {
      // Cleanup must not replace the result of the crop operation.
    }
  }));
}

export function validateCrop(crop, source) {
  const fields = ["sourceWidth", "sourceHeight", "x", "y", "width", "height"];
  const candidate = {
    sourceWidth: crop?.sourceWidth ?? source?.width,
    sourceHeight: crop?.sourceHeight ?? source?.height,
    x: crop?.x,
    y: crop?.y,
    width: crop?.width,
    height: crop?.height,
  };
  if (fields.some((field) => !Number.isInteger(candidate[field]))) {
    throw new SubimageError("INVALID_CROP", "Crop fields must be integers.", { status: 400 });
  }
  if (candidate.sourceWidth !== source.width || candidate.sourceHeight !== source.height) {
    throw new SubimageError("DIMENSION_MISMATCH", "Crop source dimensions do not match the image.");
  }
  if (
    candidate.width <= 0 || candidate.height <= 0 || candidate.x < 0 || candidate.y < 0 ||
    candidate.x + candidate.width > source.width || candidate.y + candidate.height > source.height
  ) {
    throw new SubimageError("INVALID_CROP", "Crop is outside the source image.", { status: 400 });
  }
  const ratioErrorPx = Math.abs(candidate.height - (candidate.width * source.height) / source.width);
  if (ratioErrorPx > 1) {
    throw new SubimageError("ASPECT_RATIO_MISMATCH", "Crop aspect ratio does not match the source image.", { status: 400 });
  }
  return { ...candidate, aspectRatio: source.width / source.height };
}

async function readSupportedSource(imagePath, options = {}) {
  const deps = dependencies(options);

  try {
    await deps.access(imagePath);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new SubimageError("MISSING_SOURCE", "Source image is unavailable.", { status: 404, cause: error });
    }
    throw new SubimageError("SOURCE_READ_FAILED", "Unable to read the source image.", { cause: error });
  }

  let metadata;
  try {
    metadata = await sharp(imagePath, sharpInputOptions(options.maxImagePixels)).metadata();
  } catch (error) {
    throw new SubimageError("UNSUPPORTED_SOURCE", "Source image must be a 16-bit grayscale TIFF.", { cause: error });
  }

  if (
    metadata.format !== "tiff" || metadata.depth !== "ushort" || metadata.space !== "grey16" ||
    metadata.channels !== 1 || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)
  ) {
    throw new SubimageError("UNSUPPORTED_SOURCE", "Source image must be a 16-bit grayscale TIFF.");
  }

  return { width: metadata.width, height: metadata.height };
}

async function validateOutputMetadata(outputPath, crop, options = {}, errorCode = "INVALID_SAVED_CROP") {
  const deps = dependencies(options);
  if (!(await fileExists(outputPath, deps, { errorCode }))) {
    throw new SubimageError("MISSING_SAVED_TIFF", "Saved subimage TIFF is unavailable.", { status: 404 });
  }

  let metadata;
  try {
    metadata = await sharp(outputPath, sharpInputOptions(options.maxImagePixels)).metadata();
  } catch (error) {
    throw new SubimageError(errorCode, "Saved subimage TIFF is invalid.", { cause: error });
  }

  if (
    metadata.format !== "tiff" || metadata.width !== crop.width || metadata.height !== crop.height ||
    metadata.depth !== "ushort" || metadata.space !== "grey16" || metadata.channels !== 1
  ) {
    throw new SubimageError(errorCode, "Saved subimage TIFF is invalid.");
  }
}

function validateSavedCrop(crop, image, source) {
  if (
    !crop || typeof crop !== "object" || crop.schemaVersion !== 1 ||
    crop.imageFolder !== image.imageFolder || crop.imageFile !== image.imageFile ||
    typeof crop.updatedAt !== "string" || Number.isNaN(Date.parse(crop.updatedAt))
  ) {
    throw new SubimageError("INVALID_SAVED_CROP", "Saved crop metadata is invalid.");
  }

  try {
    const normalized = validateCrop(crop, source);
    if (crop.aspectRatio !== normalized.aspectRatio) {
      throw new Error("Saved crop aspect ratio does not match.");
    }
    return normalized;
  } catch (error) {
    if (error instanceof SubimageError && error.code === "INVALID_SAVED_CROP") throw error;
    throw new SubimageError("INVALID_SAVED_CROP", "Saved crop metadata is invalid.", { cause: error });
  }
}

async function restoreTiff({ paths, hadPriorTiff, backupPath, deps }) {
  if (hadPriorTiff) {
    await deps.rm(paths.subimagePath, { force: true });
    await deps.rename(backupPath, paths.subimagePath);
    return;
  }
  await deps.rm(paths.subimagePath, { force: true });
}

function batchFailure(image, error, fallback) {
  if (error instanceof SubimageError) {
    return { imageFolder: image.imageFolder, code: error.code, message: error.message };
  }
  return { imageFolder: image.imageFolder, ...fallback };
}

function emptyBatchResult(operation) {
  return {
    operation,
    status: "complete",
    code: null,
    created: [],
    preserved: [],
    replaced: [],
    failed: [],
  };
}

function finalizeBatch(result) {
  if (result.failed.length > 0) {
    result.status = "partial";
    result.code = "PARTIAL_BATCH";
  }
  return result;
}

async function preflightBatch(storage, templateCrop, operation, options) {
  let images;
  try {
    images = await storage.scanImages();
  } catch (error) {
    throw new SubimageError("BATCH_PREFLIGHT_FAILED", "Subimage batch preflight failed.", {
      status: 422,
      details: {
        failures: [{
          imageFolder: null,
          code: "BATCH_SCAN_FAILED",
          message: "Unable to scan source images.",
        }],
      },
      cause: error,
    });
  }
  const failures = [];
  const plannedImages = [];
  let baselineSource = null;

  for (const image of images) {
    const paths = storage.imagePaths(image.id);
    let source;
    try {
      source = await readSupportedSource(paths.imagePath, options);
    } catch (error) {
      failures.push(batchFailure(image, error, {
        code: "SOURCE_READ_FAILED",
        message: "Unable to read the source image.",
      }));
      continue;
    }

    const dimensionsMatchBaseline = !baselineSource || (
      source.width === baselineSource.width && source.height === baselineSource.height
    );
    baselineSource ??= source;
    if (!dimensionsMatchBaseline) {
      failures.push({
        imageFolder: image.imageFolder,
        code: "DIMENSION_MISMATCH",
        message: "Source image dimensions do not match the batch.",
      });
    }

    try {
      validateCrop(templateCrop, source);
    } catch (error) {
      if (dimensionsMatchBaseline || error.code !== "DIMENSION_MISMATCH") {
        failures.push(batchFailure(image, error, {
          code: "INVALID_CROP",
          message: "Crop fields must be integers.",
        }));
      }
      continue;
    }

    if (!dimensionsMatchBaseline) continue;

    if (operation === "create-missing") {
      try {
        const saved = await loadSubimage(storage, image.id, options);
        plannedImages.push({ image, action: saved.hasSubimage ? "preserved" : "created" });
      } catch (error) {
        failures.push(batchFailure(image, error, {
          code: "INVALID_SAVED_CROP",
          message: "Saved crop metadata is invalid.",
        }));
      }
    } else {
      plannedImages.push({ image, action: "replaced" });
    }
  }

  if (failures.length > 0) {
    throw new SubimageError("BATCH_PREFLIGHT_FAILED", "Subimage batch preflight failed.", {
      status: 422,
      details: { failures },
    });
  }

  return plannedImages;
}

async function runBatch(storage, templateCrop, operation, options = {}) {
  const plannedImages = await preflightBatch(storage, templateCrop, operation, options);
  const result = emptyBatchResult(operation);

  for (const { image, action } of plannedImages) {
    if (action === "preserved") {
      result.preserved.push(image.imageFolder);
      continue;
    }

    try {
      await saveSubimage(storage, image.id, templateCrop, options);
      result[action].push(image.imageFolder);
    } catch {
      result.failed.push({
        imageFolder: image.imageFolder,
        code: "WRITE_FAILED",
        message: "Unable to save subimage.",
      });
    }
  }

  return finalizeBatch(result);
}

export async function loadSubimage(storage, id, options = {}) {
  const paths = storage.imagePaths(id);
  const deps = dependencies(options);
  let crop;

  try {
    crop = await storage.loadSubimageCrop(id);
  } catch (error) {
    throw new SubimageError("INVALID_SAVED_CROP", "Saved crop metadata is invalid.", { cause: error });
  }

  const tiffExists = await fileExists(paths.subimagePath, deps);
  if (!crop && !tiffExists) return { hasSubimage: false, crop: null };
  if (!crop) {
    throw new SubimageError("INVALID_SAVED_CROP", "Saved subimage files are incomplete.");
  }
  if (!tiffExists) {
    throw new SubimageError("MISSING_SAVED_TIFF", "Saved subimage TIFF is unavailable.", { status: 404 });
  }

  const source = await readSupportedSource(paths.imagePath, options);
  const normalized = validateSavedCrop(crop, storage.getImage(id), source);
  await validateOutputMetadata(paths.subimagePath, normalized, options);
  return { hasSubimage: true, crop: normalized };
}

export async function saveSubimage(storage, id, crop, options = {}) {
  const paths = storage.imagePaths(id);
  const image = storage.getImage(id);
  const deps = dependencies(options);
  const source = await readSupportedSource(paths.imagePath, options);
  const normalized = validateCrop(crop, source);
  const token = randomUUID();
  const tempTiffPath = path.join(paths.subimageDir, `.${image.imageFile}.render-${token}.tif.tmp`);
  const backupPath = path.join(paths.subimageDir, `.${image.imageFile}.backup-${token}.tif`);
  let hadPriorTiff = false;
  let backupCreated = false;
  let tiffReplaced = false;

  try {
    try {
      await deps.mkdir(paths.subimageDir, { recursive: true });
      await deps.renderCropTiff({
        sourcePath: paths.imagePath,
        tempPath: tempTiffPath,
        crop: normalized,
        maxImagePixels: options.maxImagePixels,
      });
      await validateOutputMetadata(tempTiffPath, normalized, options, "CROP_RENDER_FAILED");
    } catch (error) {
      if (error instanceof SubimageError && error.code === "CROP_RENDER_FAILED") throw error;
      throw new SubimageError("CROP_RENDER_FAILED", "Unable to render subimage TIFF.", { cause: error });
    }

    try {
      hadPriorTiff = await fileExists(paths.subimagePath, deps, { errorCode: "CROP_SAVE_FAILED" });
      if (hadPriorTiff) {
        await deps.copyFile(paths.subimagePath, backupPath);
        backupCreated = true;
      }
      await deps.rename(tempTiffPath, paths.subimagePath);
      tiffReplaced = true;
    } catch (error) {
      try {
        if (backupCreated && tiffReplaced) await restoreTiff({ paths, hadPriorTiff, backupPath, deps });
      } catch (rollbackError) {
        throw new SubimageError("CROP_ROLLBACK_FAILED", "Unable to restore the prior subimage TIFF.", { cause: rollbackError });
      }
      throw new SubimageError("CROP_SAVE_FAILED", "Unable to replace subimage TIFF.", { cause: error });
    }

    try {
      const savedCrop = await storage.saveSubimageCrop(id, normalized);
      return { crop: savedCrop };
    } catch (error) {
      try {
        await restoreTiff({ paths, hadPriorTiff, backupPath, deps });
        backupCreated = false;
      } catch (rollbackError) {
        throw new SubimageError("CROP_ROLLBACK_FAILED", "Unable to restore the prior subimage TIFF.", { cause: rollbackError });
      }
      throw new SubimageError("CROP_SAVE_FAILED", "Unable to save subimage crop metadata.", { cause: error });
    }
  } finally {
    await cleanupTemporaryFiles(deps, tempTiffPath, backupPath);
  }
}

export function createMissingSubimages(storage, templateCrop, options = {}) {
  return runBatch(storage, templateCrop, "create-missing", options);
}

export function replaceAllSubimages(storage, templateCrop, options = {}) {
  return runBatch(storage, templateCrop, "replace-all", options);
}
