import { stat } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { ZipArchive } from "archiver";
import { selectMaskSource } from "./analysisService.js";
import { polygonSelfIntersects } from "./analysisGeometry.js";
import {
  hydrateHeatmapFigure,
  planSavedHeatmapFigures,
  renderHeatmapFigure,
} from "./exportHeatmaps.js";
import {
  ESTIMATED_HEATMAP_CELL_SIZES,
  hydrateEstimatedHeatmapAsset,
  planEstimatedHeatmapAssets,
  renderEstimatedHeatmapAsset,
  renderHeatmapScaleAsset,
} from "./exportHeatmapAssets.js";
import {
  createSubimageDimensionsCsv,
  readExportImageDimensions,
  readExportRaster,
  renderAnnotatedOriginal,
  renderMaskOverlay,
  renderMaskSubimage,
  renderOriginalPreview,
  renderSubimagePreview,
} from "./exportRasterAssets.js";
import { createDatasetExportWorkbook } from "./exportDatasetWorkbook.js";
import { renderRoiOverview } from "./exportRoiOverview.js";
import { createImageWorkbook, workbookFailureText } from "./exportWorkbook.js";
import { loadSubimage } from "./subimageService.js";
import { readBinaryMask } from "./maskSkeleton.js";
import {
  COLLAGEN_DENSITY_COLOR_MAX_MAX,
  COLLAGEN_DENSITY_DISPLAY_MAX,
  COLLAGEN_DENSITY_MODEL,
  isCollagenDensityColorMax,
} from "../shared/collagenDensity.js";

const ANALYSIS_MODES = new Set(["outside", "inside"]);
const REQUIRED_BAND_IDS = ["near", "mid", "far"];
const METRIC_FIELDS = new Set([
  "bandId",
  "roiAreaPx",
  "maskPixelCount",
  "density",
  "globalAlignment",
  "globalOrientationDeg",
  "circularVariance",
  "radialNormalAlignment",
  "tangentialAlignment",
  "migrationAlignment",
  "orientationDispersion",
  "empty",
]);
const NUMERIC_METRIC_FIELDS = new Set([
  "roiAreaPx",
  "maskPixelCount",
  "density",
  "globalAlignment",
  "globalOrientationDeg",
  "circularVariance",
  "radialNormalAlignment",
  "tangentialAlignment",
  "migrationAlignment",
  "orientationDispersion",
]);
const DEFAULT_ROI_LIMITS = Object.freeze({ near: 20, mid: 50, far: 100 });
const HEATMAP_COMPATIBILITY_REASONS = new Set([
  "Heatmaps have incompatible dimensions.",
  "Heatmaps have incompatible cell sizes.",
  "Heatmaps have incompatible rows.",
  "Heatmaps have incompatible columns.",
  "Heatmaps have incompatible cell count.",
]);

class StaleAnalysisError extends Error {
  constructor() {
    super("Saved analysis is stale or incompatible.");
    this.name = "StaleAnalysisError";
  }
}

export class ExportError extends Error {
  constructor(code, message, status = 500, { cause } = {}) {
    super(message, { cause });
    this.name = "ExportError";
    this.code = code;
    this.status = status;
  }
}

export function densityModelForExport() {
  return COLLAGEN_DENSITY_MODEL;
}

export function safeArchiveSegment(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.normalize(value) !== value
  ) {
    throw new ExportError("INVALID_ARCHIVE_PATH", "Invalid archive path segment.", 400);
  }
  return value;
}

export function datasetExportDirectory(rootPath) {
  const rootName = path.basename(path.resolve(String(rootPath ?? "")));
  const sanitized = rootName.normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "_");
  return `${sanitized || "dataset"}_export`;
}

export function datasetExportFilename(rootPath, date) {
  const timestamp = exportTimestamp(date);
  return `${datasetExportDirectory(rootPath)}_${timestamp}.zip`;
}

export async function writeDatasetZip({
  storage,
  output,
  autoSavedImageId = null,
  estimatedCollagenColorMax = COLLAGEN_DENSITY_DISPLAY_MAX,
  maxImagePixels,
  now = () => new Date(),
  signal,
}) {
  if (!isCollagenDensityColorMax(estimatedCollagenColorMax)) {
    throw new ExportError(
      "INVALID_COLOR_MAX",
      `Estimated collagen color max must be between 0.1 and ${COLLAGEN_DENSITY_COLOR_MAX_MAX} mg/ml.`,
      400,
    );
  }
  const densityModel = densityModelForExport();
  const exportStorage = storage?.createSnapshot?.() ?? storage;
  const rootPath = exportStorage?.getRoot?.();
  if (!rootPath) {
    throw new ExportError("ROOT_UNSET", "Storage root has not been set.", 400);
  }
  throwIfAborted(signal);

  let images;
  let rootDirectory;
  let exportedAt;
  let records;
  let estimatedHeatmapRanges;
  try {
    images = await raceWithSignal(exportStorage.scanImages(), signal);
    rootDirectory = safeArchiveSegment(datasetExportDirectory(rootPath));
    exportedAt = validExportDate(now());
    const legacyHeatmapPlan = await raceWithSignal(
      planSavedHeatmapFigures({
        storage: exportStorage,
        images,
        calibration: densityModel,
        estimatedCollagenColorMax,
        signal,
      }),
      signal,
    );
    records = await raceWithSignal(
      collectImageExportRecords({
        storage: exportStorage,
        images,
        plan: legacyHeatmapPlan,
        autoSavedImageId,
        maxImagePixels,
        signal,
      }),
      signal,
    );
    const cropsByImage = new Map(
      records
        .filter((record) => record.subimage.status === "Included")
        .map((record) => [record.image.id, record.subimage.crop]),
    );
    const sourceDimensionsByImage = await collectSourceDimensionsByImage(records, {
      maxImagePixels,
      signal,
    });
    const estimatedHeatmapPlan = await raceWithSignal(
      planEstimatedHeatmapAssets({
        storage: exportStorage,
        images,
        cropsByImage,
        sourceDimensionsByImage,
        estimatedCollagenColorMax,
        signal,
      }),
      signal,
    );
    attachEstimatedHeatmapPlan(records, estimatedHeatmapPlan);
    estimatedHeatmapRanges = estimatedHeatmapPlan.ranges;
  } catch (error) {
    throw publicExportError(error, signal);
  }

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const outputFinished = finished(output);
  const abortState = attachAbort(signal, archive, output);
  outputFinished.catch((error) => abortState.fail(error, { destroyOutput: false }));

  try {
    archive.pipe(output);
    await appendDatasetEntries({
      archive,
      rootDirectory,
      records,
      calibration: densityModel,
      exportedAt,
      maxImagePixels,
      estimatedHeatmapRanges,
      estimatedCollagenColorMax,
      storage: exportStorage,
      abortState,
    });
    throwIfAborted(signal);
    await archive.finalize();
    await outputFinished;
  } catch (error) {
    archive.abort();
    if (!output.destroyed) output.destroy();
    await outputFinished.catch(() => {});
    throw publicExportError(error, signal);
  } finally {
    abortState.detach();
  }
}

async function collectSourceDimensionsByImage(records, { maxImagePixels, signal }) {
  const dimensionsByImage = new Map();
  const unavailableReason = "Current TIFF dimensions are unavailable for heatmap validation.";

  for (const record of records) {
    throwIfAborted(signal);
    if (!record.imageSource?.path) {
      dimensionsByImage.set(record.image.id, { status: "Skipped", reason: unavailableReason });
      continue;
    }
    try {
      const dimensions = await raceWithSignal(readExportImageDimensions({
        imagePath: record.imageSource.path,
        maxImagePixels,
        signal,
      }), signal);
      dimensionsByImage.set(record.image.id, { status: "Included", ...dimensions });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAborted(signal);
      dimensionsByImage.set(record.image.id, { status: "Skipped", reason: unavailableReason });
    }
  }

  return dimensionsByImage;
}

async function collectImageExportRecords({
  storage,
  images,
  plan,
  autoSavedImageId,
  maxImagePixels,
  signal,
}) {
  const records = [];

  for (const image of images) {
    throwIfAborted(signal);
    const imageFolder = safeArchiveSegment(image.imageFolder ?? image.id);
    const imageFile = safeArchiveSegment(image.imageFile);
    const paths = storage.imagePaths(image.id);
    const reportEntries = [];
    const record = {
      image,
      imageFolder,
      imageSource: null,
      maskSource: null,
      bounds: null,
      analysis: null,
      dimensions: {},
      sourceFiles: {},
      roiEntry: null,
      heatmapEntries: [],
      subimage: null,
      estimatedHeatmapAssets: [],
      derivedEntries: [],
      reportEntries,
      autoSavedBounds: image.id === autoSavedImageId,
      figures: plan.figures.filter((figure) => figure.currentImage === imageFolder),
    };

    record.imageSource = await sourceFileRecord(paths.imagePath, imageFile);
    record.sourceFiles.image = publicSourceFile(record.imageSource, imageFile);

    try {
      const loadedSubimage = await raceWithSignal(
        loadSubimage(storage, image.id, { maxImagePixels }),
        signal,
      );
      record.subimage = loadedSubimage.hasSubimage
        ? {
            status: "Included",
            crop: loadedSubimage.crop,
            sourcePath: paths.subimagePath,
            path: `${imageFolder}/subimage/subimage_16bit.tif`,
          }
        : { status: "Skipped", reason: "Saved Subimage is unavailable." };
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAborted(signal);
      record.subimage = {
        status: "Skipped",
        reason: "Saved Subimage is missing or invalid.",
      };
    }

    try {
      const selectedMask = await selectMaskSource(image, paths.maskDir);
      if (selectedMask) {
        const maskFile = safeArchiveSegment(selectedMask.file);
        record.maskSource = await sourceFileRecord(selectedMask.path, maskFile);
        record.sourceFiles.mask = publicSourceFile(record.maskSource, maskFile);
      }
    } catch {
      record.maskSource = null;
    }

    if (!record.maskSource) {
      reportEntries.push(report("Skipped", "Mask", "Selected source mask is unavailable."));
    }

    try {
      record.bounds = validateSavedBounds(await storage.loadBounds(image.id));
      const metadata = await stat(paths.boundsPath);
      const boundsFile = safeArchiveSegment(path.basename(paths.boundsPath));
      record.sourceFiles.bounds = { file: boundsFile, mtimeMs: metadata.mtimeMs };
      record.dimensions = dimensionsFrom(record.bounds);
      reportEntries.push(report("Included", "Bounds", "Saved bounds loaded for export."));
    } catch {
      record.bounds = null;
      reportEntries.push(report("Skipped", "Bounds", "Saved bounds are missing or invalid."));
    }

    try {
      record.analysis = validateSavedAnalysis(await storage.loadAnalysis(image.id));
      const metadata = await stat(paths.analysisPath);
      assertSavedAnalysisCurrent({
        analysis: record.analysis,
        bounds: record.bounds,
        maskSource: record.maskSource,
      });
      const analysisFile = safeArchiveSegment(path.basename(paths.analysisPath));
      record.sourceFiles.analysis = { file: analysisFile, mtimeMs: metadata.mtimeMs };
      reportEntries.push(report("Included", "Analysis", "Saved analysis loaded for export."));
    } catch (error) {
      record.analysis = null;
      reportEntries.push(
        report(
          "Skipped",
          "Analysis",
          error instanceof StaleAnalysisError
            ? "Saved analysis is stale or incompatible with current bounds or mask."
            : "Saved analysis is missing or invalid.",
        ),
      );
    }

    if (record.autoSavedBounds) {
      reportEntries.push(report("Included", "Bounds", "Current bounds auto-saved before export"));
      reportEntries.push(report("Warning", "Analysis", "Recalculate analysis if the auto-saved boundary geometry changed"));
    }

    appendUnmatchedAnalysisWarnings(record);
    for (const entry of plan.reportEntries) {
      if (entry.currentImage !== imageFolder) continue;
      record.heatmapEntries.push({ ...entry });
      reportEntries.push(report("Skipped", "Heatmap", entry.message ?? entry.reason));
    }
    records.push(record);
  }

  return records;
}

function attachEstimatedHeatmapPlan(records, plan) {
  const recordsByImage = new Map(records.map((record) => [record.imageFolder, record]));

  for (const descriptor of plan.descriptors) {
    recordsByImage.get(descriptor.currentImage)?.estimatedHeatmapAssets.push(descriptor);
  }

  for (const entry of plan.reportEntries) {
    const record = recordsByImage.get(entry.currentImage);
    if (!record) continue;
    record.derivedEntries.push(estimatedHeatmapDerivedEntry(entry, {
      status: "Skipped",
      reason: entry.reason ?? "Estimated heatmap is unavailable.",
    }));
  }

  const firstRecord = records[0];
  if (!firstRecord) return;
  for (const cellSize of ESTIMATED_HEATMAP_CELL_SIZES) {
    for (const kind of ["comparison-full", "comparison-subimage"]) {
      firstRecord.derivedEntries.push(estimatedHeatmapDerivedEntry({
        kind,
        currentImage: firstRecord.imageFolder,
        previousImage: null,
        sourceCellSize: cellSize,
      }, {
        status: "Not applicable",
        reason: "First image has no previous image.",
      }));
    }
  }
}

async function appendDatasetEntries({
  archive,
  rootDirectory,
  records,
  calibration,
  exportedAt,
  maxImagePixels,
  estimatedHeatmapRanges,
  estimatedCollagenColorMax,
  storage,
  abortState,
}) {
  for (const record of records) {
    abortState.throwIfAborted();
    const base = [rootDirectory, record.imageFolder];

    if (record.imageSource) {
      const name = archiveName(...base, "image", record.imageSource.file);
      try {
        await appendPathAndWait(archive, record.imageSource.path, name, abortState);
        record.reportEntries.push(report("Included", "Image", "Original TIFF included."));
      } catch (error) {
        if (isAbortError(error)) throw error;
        abortState.throwIfAborted();
        record.reportEntries.push(report("Skipped", "Image", "Original TIFF could not be included."));
      }
    } else {
      record.reportEntries.push(report("Skipped", "Image", "Original TIFF is unavailable."));
    }

    await appendDerivedRasterEntries({
      archive,
      base,
      record,
      maxImagePixels,
      abortState,
    });

    if (record.maskSource) {
      const name = archiveName(...base, "mask", record.maskSource.file);
      try {
        await appendPathAndWait(archive, record.maskSource.path, name, abortState);
        record.reportEntries.push(report("Included", "Mask", "Selected source mask included."));
      } catch (error) {
        if (isAbortError(error)) throw error;
        abortState.throwIfAborted();
        record.reportEntries.push(report("Skipped", "Mask", "Selected source mask could not be included."));
      }
    }

    await appendRoiEntry({
      archive,
      base,
      record,
      maxImagePixels,
      abortState,
    });

    for (const figure of record.figures) {
      await appendHeatmapEntry({
        archive,
        base,
        record,
        figure,
        storage,
        abortState,
      });
    }

    for (const asset of record.estimatedHeatmapAssets) {
      await appendEstimatedHeatmapEntry({
        archive,
        base,
        record,
        asset,
        storage,
        maxImagePixels,
        abortState,
      });
    }

    await appendWorkbookEntry({
      archive,
      base,
      record,
      calibration,
      exportedAt,
    abortState,
  });
}

  const scaleEntries = await appendEstimatedHeatmapScales({
    archive,
    rootDirectory,
    ranges: estimatedHeatmapRanges,
    estimatedCollagenColorMax,
    abortState,
  });
  await appendDatasetWorkbookEntry({
    archive,
    rootDirectory,
    records,
    scaleEntries,
    exportedAt,
    abortState,
  });
}

async function appendDerivedRasterEntries({ archive, base, record, maxImagePixels, abortState }) {
  const validatedCrop = record.subimage.status === "Included" ? record.subimage.crop : null;
  await appendDerivedPathEntry({
    archive,
    record,
    sourcePath: record.imageSource?.path,
    archivePath: archiveName(...base, "original", "original_16bit.tif"),
    publicPath: `${record.imageFolder}/original/original_16bit.tif`,
    artifact: "Original 16-bit TIFF",
    unavailableReason: "Original TIFF is unavailable.",
    failureReason: "Original TIFF could not be included.",
    abortState,
  });
  const subimageTiffEntry = await appendDerivedPathEntry({
    archive,
    record,
    sourcePath: record.subimage.status === "Included" ? record.subimage.sourcePath : null,
    archivePath: archiveName(...base, "subimage", "subimage_16bit.tif"),
    publicPath: `${record.imageFolder}/subimage/subimage_16bit.tif`,
    artifact: "Subimage 16-bit TIFF",
    unavailableReason: record.subimage.reason ?? "Saved Subimage is unavailable.",
    failureReason: "Saved Subimage TIFF could not be included.",
    abortState,
  });
  if (record.subimage.status === "Included" && subimageTiffEntry.status === "Skipped") {
    const { path: _includedPath, ...validatedSubimage } = record.subimage;
    record.subimage = {
      ...validatedSubimage,
      status: "Skipped",
      reason: subimageTiffEntry.reason,
    };
  }

  let raster = null;
  let rasterReason = null;
  if (!record.imageSource) {
    rasterReason = "Original TIFF is unavailable for preview rendering.";
  } else {
    try {
      raster = await abortState.race(readExportRaster({
        imagePath: record.imageSource.path,
        maxImagePixels,
        signal: abortState.signal,
      }));
    } catch (error) {
      if (isAbortError(error)) throw error;
      abortState.throwIfAborted();
      rasterReason = "Original TIFF could not be read for preview rendering.";
    }
  }

  if (raster) {
    await appendDerivedBufferEntry({
      archive,
      record,
      render: () => renderOriginalPreview(raster, { signal: abortState.signal }),
      archivePath: archiveName(...base, "original", "original_8bit.png"),
      publicPath: `${record.imageFolder}/original/original_8bit.png`,
      artifact: "Original 8-bit preview",
      failureReason: "Original preview could not be rendered.",
      abortState,
    });
  } else {
    recordDerivedEntry(record, {
      status: "Skipped",
      artifact: "Original 8-bit preview",
      reason: rasterReason,
    });
  }

  let mask = null;
  let maskReason = null;
  if (!record.maskSource) {
    maskReason = "Selected source mask is unavailable for derived image rendering.";
  } else {
    try {
      mask = await abortState.race(readBinaryMask(record.maskSource.path, { maxImagePixels }));
      const expectedWidth = raster?.width ?? validatedCrop?.sourceWidth;
      const expectedHeight = raster?.height ?? validatedCrop?.sourceHeight;
      if (expectedWidth && (mask.width !== expectedWidth || mask.height !== expectedHeight)) {
        mask = null;
        maskReason = "Selected source mask dimensions do not match the original image.";
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      abortState.throwIfAborted();
      maskReason = "Selected source mask could not be read for derived image rendering.";
    }
  }

  if (raster && mask) {
    await appendDerivedBufferEntry({
      archive,
      record,
      render: () => renderMaskOverlay(raster, mask, { signal: abortState.signal }),
      archivePath: archiveName(...base, "original", "original_with_mask_overlay.png"),
      publicPath: `${record.imageFolder}/original/original_with_mask_overlay.png`,
      artifact: "Original with mask overlay",
      failureReason: "Original mask overlay could not be rendered.",
      abortState,
    });
  } else {
    recordDerivedEntry(record, {
      status: "Skipped",
      artifact: "Original with mask overlay",
      reason: raster ? maskReason : rasterReason,
    });
  }

  const crop = validatedCrop;
  const subimageReason = record.subimage.reason ?? "Saved Subimage is unavailable.";
  if (raster && crop) {
    await appendDerivedBufferEntry({
      archive,
      record,
      render: () => renderAnnotatedOriginal(raster, crop, { signal: abortState.signal }),
      archivePath: archiveName(...base, "original", "original_with_subimage.png"),
      publicPath: `${record.imageFolder}/original/original_with_subimage.png`,
      artifact: "Annotated original",
      failureReason: "Annotated original could not be rendered.",
      abortState,
    });
    await appendDerivedBufferEntry({
      archive,
      record,
      render: () => renderSubimagePreview(raster, crop, { signal: abortState.signal }),
      archivePath: archiveName(...base, "subimage", "subimage_8bit.png"),
      publicPath: `${record.imageFolder}/subimage/subimage_8bit.png`,
      artifact: "Subimage 8-bit preview",
      failureReason: "Subimage preview could not be rendered.",
      abortState,
    });
  } else {
    const reason = crop ? rasterReason : subimageReason;
    recordDerivedEntry(record, { status: "Skipped", artifact: "Annotated original", reason });
    recordDerivedEntry(record, { status: "Skipped", artifact: "Subimage 8-bit preview", reason });
  }

  if (mask && crop) {
    await appendDerivedBufferEntry({
      archive,
      record,
      render: () => renderMaskSubimage(mask, crop, { signal: abortState.signal }),
      archivePath: archiveName(...base, "mask", "subimage_mask.png"),
      publicPath: `${record.imageFolder}/mask/subimage_mask.png`,
      artifact: "Subimage mask",
      failureReason: "Subimage mask could not be rendered.",
      abortState,
    });
  } else {
    recordDerivedEntry(record, {
      status: "Skipped",
      artifact: "Subimage mask",
      reason: crop ? maskReason : subimageReason,
    });
  }

  if (raster && mask && crop) {
    await appendDerivedBufferEntry({
      archive,
      record,
      render: () => renderMaskOverlay(raster, mask, { crop, signal: abortState.signal }),
      archivePath: archiveName(...base, "subimage", "subimage_with_mask_overlay.png"),
      publicPath: `${record.imageFolder}/subimage/subimage_with_mask_overlay.png`,
      artifact: "Subimage with mask overlay",
      failureReason: "Subimage mask overlay could not be rendered.",
      abortState,
    });
  } else {
    recordDerivedEntry(record, {
      status: "Skipped",
      artifact: "Subimage with mask overlay",
      reason: !raster ? rasterReason : !mask ? maskReason : subimageReason,
    });
  }

  if (crop) {
    await appendDerivedBufferEntry({
      archive,
      record,
      render: () => createSubimageDimensionsCsv({
        imageFolder: record.imageFolder,
        source: raster ?? { width: crop.sourceWidth, height: crop.sourceHeight },
        crop,
      }),
      archivePath: archiveName(...base, "subimage", "dimensions.csv"),
      publicPath: `${record.imageFolder}/subimage/dimensions.csv`,
      artifact: "Subimage dimensions",
      failureReason: "Subimage dimensions CSV could not be created.",
      abortState,
    });
  } else {
    recordDerivedEntry(record, {
      status: "Skipped",
      artifact: "Subimage dimensions",
      reason: subimageReason,
    });
  }

  raster = null;
}

async function appendDerivedPathEntry({
  archive,
  record,
  sourcePath,
  archivePath,
  publicPath,
  artifact,
  unavailableReason,
  failureReason,
  abortState,
}) {
  if (!sourcePath) {
    const entry = { status: "Skipped", artifact, reason: unavailableReason };
    recordDerivedEntry(record, entry);
    return entry;
  }
  try {
    await appendPathAndWait(archive, sourcePath, archivePath, abortState);
    const entry = { status: "Included", artifact, path: publicPath };
    recordDerivedEntry(record, entry);
    return entry;
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    const entry = { status: "Skipped", artifact, reason: failureReason };
    recordDerivedEntry(record, entry);
    return entry;
  }
}

async function appendDerivedBufferEntry({
  archive,
  record,
  render,
  archivePath,
  publicPath,
  artifact,
  failureReason,
  abortState,
}) {
  try {
    const buffer = await abortState.render(Promise.resolve().then(render));
    await appendBufferAndWait(archive, buffer, archivePath, abortState);
    recordDerivedEntry(record, { status: "Included", artifact, path: publicPath });
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    recordDerivedEntry(record, { status: "Skipped", artifact, reason: failureReason });
  }
}

async function appendEstimatedHeatmapEntry({
  archive,
  base,
  record,
  asset,
  storage,
  maxImagePixels,
  abortState,
}) {
  const relativeSegments = estimatedHeatmapRelativeSegments(asset);
  const publicPath = [record.imageFolder, ...relativeSegments].join("/");
  let hydrated;

  try {
    hydrated = await abortState.race(hydrateEstimatedHeatmapAsset(asset, {
      storage,
      signal: abortState.signal,
    }));
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    record.derivedEntries.push(estimatedHeatmapDerivedEntry(asset, {
      status: "Skipped",
      reason: estimatedHeatmapHydrationReason(error),
    }));
    return;
  }

  let buffer;
  try {
    buffer = await abortState.render(renderEstimatedHeatmapAsset(hydrated, {
      signal: abortState.signal,
      maxImagePixels,
    }));
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    record.derivedEntries.push(estimatedHeatmapDerivedEntry(asset, {
      status: "Skipped",
      reason: "Estimated heatmap could not be rendered.",
    }));
    return;
  }

  try {
    await appendBufferAndWait(
      archive,
      buffer,
      archiveName(...base, ...relativeSegments),
      abortState,
    );
    record.derivedEntries.push(estimatedHeatmapDerivedEntry(asset, {
      status: "Included",
      path: publicPath,
    }));
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    record.derivedEntries.push(estimatedHeatmapDerivedEntry(asset, {
      status: "Skipped",
      reason: "Estimated heatmap could not be included.",
    }));
    return;
  }

  await appendEstimatedHeatmapRoiEntry({
    archive,
    base,
    record,
    asset,
    hydrated,
    maxImagePixels,
    abortState,
  });
}

async function appendEstimatedHeatmapRoiEntry({
  archive,
  base,
  record,
  asset,
  hydrated,
  maxImagePixels,
  abortState,
}) {
  const relativeSegments = estimatedHeatmapRoiRelativeSegments(asset);
  if (!relativeSegments) return;
  const roi = record.subimage.status === "Included" ? record.subimage.crop : null;
  if (!roi) {
    record.derivedEntries.push(estimatedHeatmapRoiDerivedEntry(asset, {
      status: "Skipped",
      reason: record.subimage.reason ?? "Saved Subimage is unavailable.",
    }));
    return;
  }

  try {
    const buffer = await abortState.render(renderEstimatedHeatmapAsset(hydrated, {
      signal: abortState.signal,
      maxImagePixels,
      roi,
    }));
    await appendBufferAndWait(
      archive,
      buffer,
      archiveName(...base, ...relativeSegments),
      abortState,
    );
    record.derivedEntries.push(estimatedHeatmapRoiDerivedEntry(asset, {
      status: "Included",
      path: [record.imageFolder, ...relativeSegments].join("/"),
    }));
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    record.derivedEntries.push(estimatedHeatmapRoiDerivedEntry(asset, {
      status: "Skipped",
      reason: "ROI-marked heatmap could not be rendered.",
    }));
  }
}

async function appendEstimatedHeatmapScales({
  archive,
  rootDirectory,
  ranges,
  estimatedCollagenColorMax,
  abortState,
}) {
  const definitions = [
    {
      input: { kind: "absolute", estimatedCollagenColorMax },
      artifact: "Estimated Density scale",
      file: "estimated_collagen_density.png",
      path: "scales/estimated_collagen_density.png",
    },
    ...ESTIMATED_HEATMAP_CELL_SIZES.map((cellSize) => ({
      input: { kind: "comparison", cellSize, maxAbs: ranges?.get(cellSize) ?? 0 },
      artifact: "Comparison scale",
      cellSize,
      file: `comparison_${cellSize}x${cellSize}.png`,
      path: `scales/comparison_${cellSize}x${cellSize}.png`,
    })),
  ];
  const entries = [];

  for (const definition of definitions) {
    try {
      const buffer = await abortState.render(renderHeatmapScaleAsset(definition.input));
      await appendBufferAndWait(
        archive,
        buffer,
        archiveName(rootDirectory, "scales", definition.file),
        abortState,
      );
      entries.push({
        status: "Included",
        artifact: definition.artifact,
        cellSize: definition.cellSize,
        path: definition.path,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      abortState.throwIfAborted();
      entries.push({
        status: "Skipped",
        artifact: definition.artifact,
        cellSize: definition.cellSize,
        reason: "Heatmap scale could not be rendered.",
      });
    }
  }
  return entries;
}

async function appendDatasetWorkbookEntry({
  archive,
  rootDirectory,
  records,
  scaleEntries,
  exportedAt,
  abortState,
}) {
  try {
    const buffer = await abortState.race(createDatasetExportWorkbook({
      records,
      scaleEntries,
      exportedAt,
    }));
    await appendBufferAndWait(
      archive,
      buffer,
      archiveName(rootDirectory, "export_report.xlsx"),
      abortState,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    const fallback = workbookFailureText({ imageFolder: "dataset", error });
    await appendBufferAndWait(
      archive,
      fallback,
      archiveName(rootDirectory, "export_report_error.txt"),
      abortState,
    );
  }
}

function estimatedHeatmapRelativeSegments(asset) {
  const folder = `${asset.sourceCellSize}x${asset.sourceCellSize}`;
  const paths = {
    "absolute-full": ["heatmap", folder, "full.png"],
    "absolute-subimage": ["heatmap", folder, "subimage.png"],
    "comparison-full": ["compare", folder, "full_current_minus_previous.png"],
    "comparison-subimage": ["compare", folder, "subimage_current_minus_previous.png"],
  };
  return paths[asset.kind];
}

function estimatedHeatmapRoiRelativeSegments(asset) {
  const folder = `${asset.sourceCellSize}x${asset.sourceCellSize}`;
  const paths = {
    "absolute-full": ["heatmap", folder, "full_with_subimage.png"],
    "comparison-full": ["compare", folder, "full_with_subimage_current_minus_previous.png"],
  };
  return paths[asset.kind] ?? null;
}

function estimatedHeatmapDerivedEntry(asset, details) {
  const artifacts = {
    "absolute-full": "Full heatmap",
    "absolute-subimage": "Subimage heatmap",
    "comparison-full": "Full comparison",
    "comparison-subimage": "Subimage comparison",
  };
  return {
    ...details,
    artifact: artifacts[asset.kind] ?? "Estimated heatmap",
    currentImage: asset.currentImage,
    previousImage: asset.previousImage ?? null,
    sourceCellSize: asset.sourceCellSize,
    cellSize: asset.cellSize ?? asset.sourceCellSize,
  };
}

function estimatedHeatmapRoiDerivedEntry(asset, details) {
  const artifacts = {
    "absolute-full": "Full heatmap with Subimage ROI",
    "comparison-full": "Full comparison with Subimage ROI",
  };
  return {
    ...details,
    artifact: artifacts[asset.kind] ?? "ROI-marked heatmap",
    currentImage: asset.currentImage,
    previousImage: asset.previousImage ?? null,
    sourceCellSize: asset.sourceCellSize,
    cellSize: asset.cellSize ?? asset.sourceCellSize,
  };
}

function estimatedHeatmapHydrationReason(error) {
  const reasonsByCode = {
    MISSING_HEATMAP: "Saved heatmap is missing.",
    STALE_HEATMAP: "Saved heatmap is stale.",
    INVALID_HEATMAP: "Saved heatmap is invalid.",
  };
  if (reasonsByCode[error?.code]) return reasonsByCode[error.code];
  if (HEATMAP_COMPATIBILITY_REASONS.has(error?.message)) return error.message;
  return "Saved heatmap is unavailable.";
}

function recordDerivedEntry(record, details) {
  record.derivedEntries.push({
    ...details,
    currentImage: record.imageFolder,
    previousImage: null,
  });
}

async function appendRoiEntry({ archive, base, record, maxImagePixels, abortState }) {
  const relativePath = `roi/${record.imageFolder}_ROI_overview.png`;
  const skipped = (reason) => {
    record.roiEntry = { status: "Skipped", reason };
    record.reportEntries.push(report("Skipped", "ROI", reason));
  };

  if (!record.imageSource || !record.bounds) {
    skipped("ROI overview requires a readable source image and valid saved bounds.");
    return;
  }

  try {
    const buffer = await abortState.render(
      renderRoiOverview({
        imagePath: record.imageSource.path,
        bounds: record.bounds,
        maxImagePixels,
        signal: abortState.signal,
      }),
    );
    await appendBufferAndWait(
      archive,
      buffer,
      archiveName(...base, "roi", `${record.imageFolder}_ROI_overview.png`),
      abortState,
    );
    record.roiEntry = { status: "Included", path: relativePath };
    record.reportEntries.push(report("Included", "ROI", "ROI overview included."));
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    skipped("ROI overview could not be rendered.");
  }
}

async function appendHeatmapEntry({ archive, base, record, figure, storage, abortState }) {
  const folder = `${figure.cellWidth}x${figure.cellHeight}`;
  const archiveFile = safeArchiveSegment(figure.archiveName);
  const relativePath = `heatmap/${folder}/${archiveFile}`;

  try {
    const hydratedFigure = await abortState.race(
      hydrateHeatmapFigure(figure, {
        storage,
        signal: abortState.signal,
      }),
    );
    const buffer = await abortState.render(
      renderHeatmapFigure(hydratedFigure, { signal: abortState.signal }),
    );
    await appendBufferAndWait(
      archive,
      buffer,
      archiveName(...base, "heatmap", folder, archiveFile),
      abortState,
    );
    record.heatmapEntries.push(heatmapEntry(figure, {
      status: "Included",
      path: relativePath,
    }));
    record.reportEntries.push(
      report("Included", "Heatmap", `${figure.metricLabel} heatmap included.`),
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    const reason = "Heatmap figure could not be rendered.";
    record.heatmapEntries.push(heatmapEntry(figure, { status: "Skipped", reason }));
    record.reportEntries.push(report("Skipped", "Heatmap", reason));
  }
}

async function appendWorkbookEntry({
  archive,
  base,
  record,
  calibration,
  exportedAt,
  abortState,
}) {
  const workbookFile = `${record.imageFolder}_statistics.xlsx`;
  record.reportEntries.push(report("Included", "Workbook", "Workbook generated."));

  try {
    const buffer = await abortState.race(createImageWorkbook({
      image: record.image,
      dimensions: record.dimensions,
      sourceFiles: record.sourceFiles,
      bounds: record.bounds,
      analysis: record.analysis,
      calibration,
      autoSavedBounds: record.autoSavedBounds,
      roiEntry: record.roiEntry,
      heatmapEntries: record.heatmapEntries,
      reportEntries: record.reportEntries,
      exportedAt,
    }));
    await appendBufferAndWait(
      archive,
      buffer,
      archiveName(...base, "statistics", workbookFile),
      abortState,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    abortState.throwIfAborted();
    record.reportEntries.pop();
    const fallback = workbookFailureText({ imageFolder: record.imageFolder, error });
    await appendBufferAndWait(
      archive,
      fallback,
      archiveName(...base, "statistics", `${record.imageFolder}_statistics_error.txt`),
      abortState,
    );
  }
}

function appendUnmatchedAnalysisWarnings(record) {
  const boundsIds = new Set(
    Array.isArray(record.bounds?.groups)
      ? record.bounds.groups.map((group) => group?.id).filter((id) => typeof id === "string")
      : [],
  );
  const analysisGroups = Array.isArray(record.analysis?.groups) ? record.analysis.groups : [];
  for (const group of analysisGroups) {
    if (boundsIds.has(group?.groupId)) continue;
    record.reportEntries.push(
      report("Warning", "Analysis", "Saved analysis contains a group without matching bounds."),
    );
  }
}

function heatmapEntry(figure, details) {
  return {
    ...details,
    metric: figure.metricLabel,
    currentImage: figure.currentImage,
    previousImage: figure.previousImage,
    cellWidth: figure.cellWidth,
    cellHeight: figure.cellHeight,
    columns: figure.columns,
    rows: figure.rows,
    colorMin: figure.colorRange?.min,
    colorMax: figure.colorRange?.max,
    unit: figure.unit,
  };
}

function report(status, artifact, message) {
  return { status, artifact, message };
}

async function sourceFileRecord(filePath, file) {
  try {
    const metadata = await stat(filePath);
    return { file, path: filePath, mtimeMs: metadata.mtimeMs };
  } catch {
    return null;
  }
}

function publicSourceFile(source, fallbackFile) {
  return source
    ? { file: source.file, mtimeMs: source.mtimeMs }
    : { file: fallbackFile, mtimeMs: null };
}

function dimensionsFrom(bounds) {
  return {
    width: Number.isSafeInteger(bounds?.width) && bounds.width > 0 ? bounds.width : null,
    height: Number.isSafeInteger(bounds?.height) && bounds.height > 0 ? bounds.height : null,
  };
}

function validateSavedBounds(value) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.width) ||
    value.width <= 0 ||
    !Number.isSafeInteger(value.height) ||
    value.height <= 0 ||
    !Array.isArray(value.groups) ||
    value.groups.length === 0
  ) {
    throw new TypeError("Invalid saved bounds.");
  }

  const ids = new Set();
  for (const group of value.groups) {
    if (
      !isPlainObject(group) ||
      typeof group.id !== "string" ||
      group.id.length === 0 ||
      ids.has(group.id) ||
      (group.name !== undefined && typeof group.name !== "string") ||
      (group.color !== undefined && typeof group.color !== "string") ||
      !ANALYSIS_MODES.has(group.analysisMode) ||
      !isOptionalMigrationVector(group.migrationVector) ||
      !Array.isArray(group.points) ||
      group.points.length < 3
    ) {
      throw new TypeError("Invalid saved bounds.");
    }
    ids.add(group.id);

    for (const point of group.points) {
      if (
        !isPlainObject(point) ||
        typeof point.x !== "number" ||
        !Number.isFinite(point.x) ||
        typeof point.y !== "number" ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.x >= value.width ||
        point.y < 0 ||
        point.y >= value.height
      ) {
        throw new TypeError("Invalid saved bounds.");
      }
    }
    if (polygonSelfIntersects(group.points)) {
      throw new TypeError("Invalid saved bounds.");
    }
  }

  return value;
}

function validateSavedAnalysis(value) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 5 ||
    !isPlainObject(value.maskSource) ||
    !Array.isArray(value.groups) ||
    value.groups.length === 0
  ) {
    throw new TypeError("Invalid saved analysis.");
  }

  const sanitized = {
    schemaVersion: 5,
    maskSource: sanitizeSavedMaskSource(value.maskSource),
    roiBands: sanitizeSavedRoiBands(value.roiBands ?? []),
    groups: [],
  };
  if (value.boundsFile !== undefined) {
    if (typeof value.boundsFile !== "string") throw new TypeError("Invalid saved analysis.");
    sanitized.boundsFile = value.boundsFile;
  }
  if (value.updatedAt !== undefined) {
    sanitized.updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : null;
  }

  const ids = new Set();
  for (const group of value.groups) {
    if (
      !isPlainObject(group) ||
      typeof group.groupId !== "string" ||
      group.groupId.length === 0 ||
      ids.has(group.groupId) ||
      !ANALYSIS_MODES.has(group.analysisMode)
    ) {
      throw new TypeError("Invalid saved analysis.");
    }
    ids.add(group.groupId);

    const sanitizedGroup = {
      groupId: group.groupId,
      analysisMode: group.analysisMode,
    };
    for (const field of ["groupName", "color"]) {
      if (group[field] !== undefined && group[field] !== null && typeof group[field] !== "string") {
        throw new TypeError("Invalid saved analysis.");
      }
      if (group[field] !== undefined) sanitizedGroup[field] = group[field];
    }
    if (!isOptionalMigrationVector(group.migrationVector)) {
      throw new TypeError("Invalid saved analysis.");
    }
    if (group.migrationVector !== undefined) {
      sanitizedGroup.migrationVector = group.migrationVector === null
        ? null
        : {
            start: { x: group.migrationVector.start.x, y: group.migrationVector.start.y },
            end: { x: group.migrationVector.end.x, y: group.migrationVector.end.y },
          };
    }

    if (group.analysisMode === "inside") {
      if (!isPlainObject(group.area)) throw new TypeError("Invalid saved analysis.");
      sanitizedGroup.area = sanitizeSavedMetric(group.area);
      sanitized.groups.push(sanitizedGroup);
      continue;
    }

    if (
      !isPlainObject(group.bands) ||
      REQUIRED_BAND_IDS.some((bandId) => !isPlainObject(group.bands[bandId])) ||
      !isPlainObject(group.allBands)
    ) {
      throw new TypeError("Invalid saved analysis.");
    }
    if (group.roiBands !== undefined) {
      sanitizedGroup.roiBands = sanitizeSavedRoiBands(group.roiBands);
    }
    sanitizedGroup.bands = Object.fromEntries(
      REQUIRED_BAND_IDS.map((bandId) => [bandId, sanitizeSavedMetric(group.bands[bandId])]),
    );
    sanitizedGroup.allBands = sanitizeSavedMetric(group.allBands);
    sanitized.groups.push(sanitizedGroup);
  }
  return sanitized;
}

function sanitizeSavedMetric(value) {
  if (!isPlainObject(value)) throw new TypeError("Invalid saved analysis.");
  const sanitized = {};
  for (const [field, leaf] of Object.entries(value)) {
    if (!METRIC_FIELDS.has(field)) throw new TypeError("Invalid saved analysis.");
    if (field === "bandId") {
      if (leaf !== null && typeof leaf !== "string") {
        throw new TypeError("Invalid saved analysis.");
      }
      sanitized[field] = leaf;
      continue;
    }
    if (field === "empty") {
      if (typeof leaf !== "boolean") throw new TypeError("Invalid saved analysis.");
      sanitized[field] = leaf;
      continue;
    }
    if (NUMERIC_METRIC_FIELDS.has(field)) {
      if (leaf !== null && (typeof leaf !== "number" || !Number.isFinite(leaf))) {
        throw new TypeError("Invalid saved analysis.");
      }
      if (leaf !== null && !validMetricNumber(field, leaf)) {
        throw new TypeError("Invalid saved analysis.");
      }
      sanitized[field] = leaf;
    }
  }
  return sanitized;
}

function validMetricNumber(field, value) {
  if (field === "roiAreaPx" || field === "maskPixelCount") {
    return Number.isSafeInteger(value) && value >= 0;
  }
  if (
    field === "density" ||
    field === "globalAlignment" ||
    field === "circularVariance" ||
    field === "orientationDispersion"
  ) {
    return value >= -1e-9 && value <= 1 + 1e-9;
  }
  if (
    field === "radialNormalAlignment" ||
    field === "tangentialAlignment" ||
    field === "migrationAlignment"
  ) {
    return value >= -1 - 1e-9 && value <= 1 + 1e-9;
  }
  if (field === "globalOrientationDeg") {
    return value >= -1e-9 && value <= 180 + 1e-9;
  }
  return true;
}

function sanitizeSavedRoiBands(value) {
  if (!Array.isArray(value)) throw new TypeError("Invalid saved analysis.");
  return value.map((band) => {
    if (
      !isPlainObject(band) ||
      !REQUIRED_BAND_IDS.includes(band.id) ||
      typeof band.label !== "string" ||
      typeof band.fromPx !== "number" ||
      !Number.isFinite(band.fromPx) ||
      typeof band.toPx !== "number" ||
      !Number.isFinite(band.toPx) ||
      band.fromPx < 0 ||
      band.toPx <= band.fromPx ||
      Object.keys(band).some((key) => !["id", "label", "fromPx", "toPx"].includes(key))
    ) {
      throw new TypeError("Invalid saved analysis.");
    }
    return { id: band.id, label: band.label, fromPx: band.fromPx, toPx: band.toPx };
  });
}

function sanitizeSavedMaskSource(value) {
  if (
    !isPlainObject(value) ||
    typeof value.file !== "string" ||
    value.file.length === 0 ||
    typeof value.format !== "string" ||
    !Number.isSafeInteger(value.width) ||
    value.width <= 0 ||
    !Number.isSafeInteger(value.height) ||
    value.height <= 0
  ) {
    throw new TypeError("Invalid saved analysis.");
  }
  const sanitized = {
    file: value.file,
    format: value.format,
    width: value.width,
    height: value.height,
  };
  if (typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs)) {
    sanitized.mtimeMs = value.mtimeMs;
  }
  return sanitized;
}

function assertSavedAnalysisCurrent({
  analysis,
  bounds,
  maskSource,
}) {
  if (!bounds || !analysis) throw new StaleAnalysisError();
  if (
    analysis.maskSource &&
    (
      !maskSource ||
      analysis.maskSource.file !== maskSource.file ||
      analysis.maskSource.width !== bounds.width ||
      analysis.maskSource.height !== bounds.height
    )
  ) {
    throw new StaleAnalysisError();
  }

  const boundsGroups = new Map(bounds.groups.map((group) => [group.id, group]));
  if (boundsGroups.size !== analysis.groups.length) throw new StaleAnalysisError();

  for (const analysisGroup of analysis.groups) {
    const boundsGroup = boundsGroups.get(analysisGroup.groupId);
    if (!boundsGroup || boundsGroup.analysisMode !== analysisGroup.analysisMode) {
      throw new StaleAnalysisError();
    }
    if (analysisGroup.analysisMode === "outside") {
      const savedBands = analysisGroup.roiBands?.length
        ? analysisGroup.roiBands
        : analysis.roiBands;
      if (!sameRoiBands(savedBands, roiBandsFromBounds(boundsGroup.roiLimits))) {
        throw new StaleAnalysisError();
      }
    }
  }
}

function roiBandsFromBounds(roiLimits) {
  const near = roiLimit(roiLimits?.near, DEFAULT_ROI_LIMITS.near);
  const mid = Math.max(roiLimit(roiLimits?.mid, DEFAULT_ROI_LIMITS.mid), near + 1);
  const far = Math.max(roiLimit(roiLimits?.far, DEFAULT_ROI_LIMITS.far), mid + 1);
  return [
    { id: "near", fromPx: 0, toPx: near },
    { id: "mid", fromPx: near, toPx: mid },
    { id: "far", fromPx: mid, toPx: far },
  ];
}

function roiLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 ? Math.round(numeric) : fallback;
}

function sameRoiBands(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const actualById = new Map(actual.map((band) => [band.id, band]));
  return expected.every((band) => {
    const candidate = actualById.get(band.id);
    return candidate?.fromPx === band.fromPx && candidate?.toPx === band.toPx;
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFinitePoint(value) {
  return isPlainObject(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y);
}

function isOptionalMigrationVector(value) {
  return value === undefined ||
    value === null ||
    (isPlainObject(value) && isFinitePoint(value.start) && isFinitePoint(value.end));
}

function archiveName(...segments) {
  return segments.map(safeArchiveSegment).join("/");
}

function waitForArchiveEntry(archive, name, abortState) {
  return new Promise((resolve, reject) => {
    const onEntry = (entry) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onWarning = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(abortState?.signal?.reason ?? abortError());
    };
    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
      archive.off("warning", onWarning);
      abortState?.signal?.removeEventListener("abort", onAbort);
    };
    archive.on("entry", onEntry);
    archive.on("error", onError);
    archive.on("warning", onWarning);
    abortState?.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function appendBufferAndWait(archive, buffer, name, abortState) {
  abortState.throwIfAborted();
  const entered = waitForArchiveEntry(archive, name, abortState);
  archive.append(buffer, { name });
  await entered;
}

async function appendPathAndWait(archive, filePath, name, abortState) {
  abortState.throwIfAborted();
  const entered = waitForArchiveEntry(archive, name, abortState);
  archive.file(filePath, { name });
  await entered;
}

function attachAbort(signal, archive, output) {
  const operation = new AbortController();
  let activeRenderer = null;
  let rejectFailure;
  const failed = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  failed.catch(() => {});

  const fail = (error, { destroyOutput = true } = {}) => {
    if (operation.signal.aborted) return;
    operation.abort(error);
    rejectFailure(error);
    activeRenderer?.destroy?.(error);
    archive.abort();
    if (destroyOutput && !output.destroyed) output.destroy(error);
  };

  const onAbort = () => {
    fail(abortError());
  };
  const onArchiveError = (error) => fail(error);

  signal?.addEventListener("abort", onAbort, { once: true });
  archive.on("error", onArchiveError);
  if (signal?.aborted) onAbort();

  return {
    signal: operation.signal,
    fail,
    race: (promise) => Promise.race([promise, failed]),
    render: async (renderer) => {
      activeRenderer = renderer;
      try {
        return await Promise.race([renderer, failed]);
      } finally {
        if (activeRenderer === renderer) activeRenderer = null;
      }
    },
    throwIfAborted: () => {
      if (operation.signal.aborted) throw operation.signal.reason;
    },
    detach: () => {
      signal?.removeEventListener("abort", onAbort);
      archive.off("error", onArchiveError);
    },
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function raceWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function abortError() {
  const error = new Error("Dataset export aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function publicExportError(error, signal) {
  if (isAbortError(error) || signal?.aborted) return abortError();
  if (error instanceof ExportError) return error;
  return new ExportError("EXPORT_FAILED", "Dataset export failed.", 500);
}

function validExportDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ExportError("INVALID_EXPORT_DATE", "Export date must be valid.", 400);
  }
  return date;
}

function exportTimestamp(value) {
  const date = validExportDate(value);
  return date.toISOString().replace(/\D/g, "").slice(0, 14).replace(
    /^(\d{8})(\d{6})$/,
    "$1-$2",
  );
}
