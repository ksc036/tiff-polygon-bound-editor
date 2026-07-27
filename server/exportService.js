import { stat } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { ZipArchive } from "archiver";
import { selectMaskSource } from "./analysisService.js";
import { polygonSelfIntersects } from "./analysisGeometry.js";
import {
  collectSavedHeatmaps,
  planHeatmapFigures,
  renderHeatmapFigure,
} from "./exportHeatmaps.js";
import { renderRoiOverview } from "./exportRoiOverview.js";
import { createImageWorkbook, workbookFailureText } from "./exportWorkbook.js";

const ANALYSIS_MODES = new Set(["outside", "inside"]);
const REQUIRED_BAND_IDS = ["near", "mid", "far"];

export class ExportError extends Error {
  constructor(code, message, status = 500, { cause } = {}) {
    super(message, { cause });
    this.name = "ExportError";
    this.code = code;
    this.status = status;
  }
}

export function validateExportCalibration(value) {
  const slope = value?.slope;
  const intercept = value?.intercept;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    throw new ExportError("INVALID_CALIBRATION", "Calibration values must be finite numbers.", 400);
  }
  if (slope === 0) {
    throw new ExportError("INVALID_CALIBRATION", "Calibration slope must be non-zero.", 400);
  }
  return { slope, intercept };
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
  calibration,
  autoSavedImageId = null,
  maxImagePixels,
  now = () => new Date(),
  signal,
}) {
  const checkedCalibration = validateExportCalibration(calibration);
  const rootPath = storage?.getRoot?.();
  if (!rootPath) {
    throw new ExportError("ROOT_UNSET", "Storage root has not been set.", 400);
  }
  throwIfAborted(signal);

  let images;
  let rootDirectory;
  let exportedAt;
  let records;
  try {
    images = await raceWithSignal(storage.scanImages(), signal);
    rootDirectory = safeArchiveSegment(datasetExportDirectory(rootPath));
    exportedAt = validExportDate(now());
    const sources = await raceWithSignal(collectSavedHeatmaps({ storage, images }), signal);
    const plan = planHeatmapFigures({ images, sources, calibration: checkedCalibration });
    records = await raceWithSignal(
      collectImageExportRecords({
        storage,
        images,
        plan,
        autoSavedImageId,
        signal,
      }),
      signal,
    );
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
      calibration: checkedCalibration,
      exportedAt,
      maxImagePixels,
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

async function collectImageExportRecords({ storage, images, plan, autoSavedImageId, signal }) {
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
      reportEntries,
      autoSavedBounds: image.id === autoSavedImageId,
      figures: plan.figures.filter((figure) => figure.currentImage === imageFolder),
    };

    record.imageSource = await sourceFileRecord(paths.imagePath, imageFile);
    record.sourceFiles.image = publicSourceFile(record.imageSource, imageFile);

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
      record.bounds = validateSavedBounds(await storage.loadBounds(image.id), image);
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
      record.analysis = validateSavedAnalysis(await storage.loadAnalysis(image.id), image);
      const metadata = await stat(paths.analysisPath);
      const analysisFile = safeArchiveSegment(path.basename(paths.analysisPath));
      record.sourceFiles.analysis = { file: analysisFile, mtimeMs: metadata.mtimeMs };
      reportEntries.push(report("Included", "Analysis", "Saved analysis loaded for export."));
    } catch {
      record.analysis = null;
      reportEntries.push(report("Skipped", "Analysis", "Saved analysis is missing or invalid."));
    }

    if (record.autoSavedBounds) {
      reportEntries.push(report("Included", "Bounds", "Current bounds auto-saved before export"));
      reportEntries.push(report("Warning", "Analysis", "Saved analysis may predate the auto-saved bounds"));
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

async function appendDatasetEntries({
  archive,
  rootDirectory,
  records,
  calibration,
  exportedAt,
  maxImagePixels,
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

async function appendHeatmapEntry({ archive, base, record, figure, abortState }) {
  const folder = `${figure.cellWidth}x${figure.cellHeight}`;
  const archiveFile = safeArchiveSegment(figure.archiveName);
  const relativePath = `heatmap/${folder}/${archiveFile}`;

  try {
    const buffer = await abortState.render(
      renderHeatmapFigure(figure, { signal: abortState.signal }),
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

function validateSavedBounds(value, image) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 1 ||
    value.imageFolder !== image.imageFolder ||
    value.imageFile !== image.imageFile ||
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

function validateSavedAnalysis(value, image) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 5 ||
    value.imageFolder !== image.imageFolder ||
    value.imageFile !== image.imageFile ||
    !Array.isArray(value.groups) ||
    value.groups.length === 0
  ) {
    throw new TypeError("Invalid saved analysis.");
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

    if (group.analysisMode === "inside") {
      if (!isPlainObject(group.area)) throw new TypeError("Invalid saved analysis.");
      continue;
    }

    if (
      !isPlainObject(group.bands) ||
      REQUIRED_BAND_IDS.some((bandId) => !isPlainObject(group.bands[bandId])) ||
      !isPlainObject(group.allBands)
    ) {
      throw new TypeError("Invalid saved analysis.");
    }
  }
  return value;
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
  return new ExportError("EXPORT_FAILED", "Dataset export failed.", 500, { cause: error });
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
