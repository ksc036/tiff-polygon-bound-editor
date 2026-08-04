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

async function fileExists(filePath, deps) {
  try {
    await deps.access(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
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
  if (!(await fileExists(outputPath, deps))) {
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
      hadPriorTiff = await fileExists(paths.subimagePath, deps);
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
    await Promise.all([
      deps.rm(tempTiffPath, { force: true }),
      deps.rm(backupPath, { force: true }),
    ]);
  }
}
