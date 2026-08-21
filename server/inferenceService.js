import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { polygonSelfIntersects } from "./analysisGeometry.js";
import { readGrey16RawFromImage, resolveMaxImagePixels } from "./imageProcessing.js";
import {
  closestThreshold,
  createProbabilityOverlayPng,
  parseProbabilityNpy,
  probabilityMetrics,
  writeThresholdMaskPng,
} from "./probabilityMap.js";

const DEFAULT_THRESHOLD = 0.5;
const THRESHOLD_GRID = 1000;

export class InferenceError extends Error {
  constructor(code, message, { status = 422, cause } = {}) {
    super(message, { cause });
    this.name = "InferenceError";
    this.code = code;
    this.status = status;
  }
}

function inferenceError(code, message, status, cause) {
  return new InferenceError(code, message, { status, cause });
}

function isTiff(fileName) {
  return /\.tiff?$/i.test(fileName);
}

function compareNames(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function inferenceId(timestampFolder, imageFile) {
  return Buffer.from(JSON.stringify([timestampFolder, imageFile])).toString("base64url");
}

function ensureRootPath(rootPath) {
  if (!rootPath || !path.isAbsolute(rootPath)) {
    throw inferenceError("INVALID_ROOT", "Inference root must be an absolute directory.", 400);
  }
  return rootPath;
}

export async function scanInferenceImages(rootPath) {
  const root = ensureRootPath(rootPath);
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    throw inferenceError("INVALID_ROOT", "Inference root must be an existing directory.", 400, error);
  }
  if (!rootStat.isDirectory()) {
    throw inferenceError("INVALID_ROOT", "Inference root must be an existing directory.", 400);
  }

  const timestampEntries = await readdir(root, { withFileTypes: true });
  const images = [];
  for (const entry of timestampEntries.filter((candidate) => candidate.isDirectory()).sort((left, right) => compareNames(left.name, right.name))) {
    const timestampFolder = entry.name;
    const timestampPath = path.join(root, timestampFolder);
    const imageDir = path.join(timestampPath, "image");
    let imageEntries;
    try {
      imageEntries = await readdir(imageDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }

    for (const imageEntry of imageEntries.filter((candidate) => candidate.isFile() && isTiff(candidate.name)).sort((left, right) => compareNames(left.name, right.name))) {
      const imageFile = imageEntry.name;
      const probabilityMapsDir = path.join(timestampPath, "probability-maps");
      images.push({
        id: inferenceId(timestampFolder, imageFile),
        timestampFolder,
        imageFile,
        imagePath: path.join(imageDir, imageFile),
        probabilityMapsDir,
        mapPath: path.join(probabilityMapsDir, `${imageFile}.probability.npy`),
        settingsPath: path.join(probabilityMapsDir, `${imageFile}.mask-setting.json`),
        cellBoundariesPath: path.join(timestampPath, "cell boundary", `${imageFile}.cell-boundaries.json`),
        maskPath: path.join(timestampPath, "mask", `${imageFile}.png`),
      });
    }
  }
  return images;
}

function validThreshold(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalizeThreshold(value) {
  return validThreshold(value) ? Math.round(value * THRESHOLD_GRID) / THRESHOLD_GRID : null;
}

function objectPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeMessage(error) {
  return error instanceof InferenceError ? error.message : "Unable to run model inference.";
}

function cleanSettings(image, value = {}) {
  return {
    schemaVersion: 1,
    timestampFolder: image.timestampFolder,
    imageFile: image.imageFile,
    threshold: normalizeThreshold(value.threshold) ?? DEFAULT_THRESHOLD,
    referenceId: typeof value.referenceId === "string" ? value.referenceId : null,
    targetAreaFraction: validThreshold(value.targetAreaFraction) ? value.targetAreaFraction : null,
    roiGroupId: typeof value.roiGroupId === "string" ? value.roiGroupId : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

async function writeAtomically(filePath, bytes) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.tmp-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function validPoint(point) {
  return point && typeof point === "object" && typeof point.x === "number" && Number.isFinite(point.x) &&
    typeof point.y === "number" && Number.isFinite(point.y);
}

function validPolygon(group, width, height) {
  if (!group || typeof group.id !== "string" || !Array.isArray(group.points) || group.points.length < 3 ||
      !group.points.every(validPoint) || polygonSelfIntersects(group.points)) {
    return null;
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  return group.points.map(({ x, y }) => ({ x, y }));
}

function validRectangle(rectangle, width, height) {
  if (!rectangle || typeof rectangle !== "object") return null;
  const { x, y, width: rectangleWidth, height: rectangleHeight } = rectangle;
  if (![x, y, rectangleWidth, rectangleHeight].every(Number.isInteger) ||
      x < 0 || y < 0 || rectangleWidth <= 0 || rectangleHeight <= 0 ||
      x + rectangleWidth > width || y + rectangleHeight > height) {
    return null;
  }
  return { x, y, width: rectangleWidth, height: rectangleHeight };
}

function emptyCellBoundaries(width, height) {
  return {
    schemaVersion: 1,
    width,
    height,
    connectionMode: "input-order-cycle",
    groups: [],
  };
}

function cleanCellBoundaries(value, width, height) {
  const payload = objectPayload(value);
  if (!Array.isArray(payload.groups)) {
    throw inferenceError("INVALID_CELL_BOUNDARIES", "Cell boundaries must include groups.", 400);
  }

  const ids = new Set();
  const groups = payload.groups.map((group, index) => {
    if (!group || typeof group !== "object" || typeof group.id !== "string" || !group.id || ids.has(group.id) ||
        !Array.isArray(group.points)) {
      throw inferenceError("INVALID_CELL_BOUNDARIES", "Cell boundary groups are invalid.", 400);
    }
    ids.add(group.id);
    const pointIds = new Set();
    const points = group.points.map((point) => {
      if (!point || typeof point.id !== "string" || !point.id || pointIds.has(point.id) || !validPoint(point) ||
          point.x < 0 || point.y < 0 || point.x > width || point.y > height) {
        throw inferenceError("INVALID_CELL_BOUNDARIES", "Cell boundary points are invalid.", 400);
      }
      pointIds.add(point.id);
      return { id: point.id, x: point.x, y: point.y };
    });
    return {
      id: group.id,
      name: typeof group.name === "string" && group.name.trim() ? group.name : `Boundary ${index + 1}`,
      color: typeof group.color === "string" ? group.color : "#e11d48",
      visible: group.visible !== false,
      points,
    };
  });

  return { ...emptyCellBoundaries(width, height), groups };
}

function cellBoundaryPolygons(bounds, width, height) {
  return (bounds?.groups ?? []).map((group) => validPolygon(group, width, height)).filter(Boolean);
}

function polygonForRectangle({ x, y, width, height }) {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function sourceDimensions(imagePath, maxImagePixels) {
  return sharp(imagePath, { limitInputPixels: resolveMaxImagePixels(maxImagePixels) })
    .metadata()
    .then((metadata) => {
      if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width <= 0 || metadata.height <= 0) {
        throw inferenceError("INVALID_SOURCE", "Unable to read source image dimensions.", 422);
      }
      return { width: metadata.width, height: metadata.height };
    })
    .catch((error) => {
      if (error instanceof InferenceError) throw error;
      throw inferenceError("INVALID_SOURCE", "Unable to read source image dimensions.", 422, error);
    });
}

function normalizedServerUrl(serverUrl) {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol.");
    return url;
  } catch (error) {
    throw inferenceError("INVALID_SERVER_URL", "Model server URL must be a valid HTTP URL.", 400, error);
  }
}

export function createInferenceService({ storage, fetchImpl = globalThis.fetch, maxImagePixels } = {}) {
  if (!storage || typeof storage.getRoot !== "function" || typeof storage.loadBounds !== "function") {
    throw new TypeError("Inference service requires storage root and bounds access.");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Inference service requires fetch.");
  }

  const jobs = new Map();
  const sourceStates = new Map();
  let activeJobId = null;

  async function images() {
    const rootPath = storage.getRoot();
    if (!rootPath) throw inferenceError("ROOT_UNSET", "Storage root has not been set.", 400);
    return scanInferenceImages(rootPath);
  }

  async function imageFor(id) {
    const image = (await images()).find((candidate) => candidate.id === id);
    if (!image) throw inferenceError("IMAGE_NOT_FOUND", "Inference image not found.", 404);
    return image;
  }

  async function loadMap(image) {
    let bytes;
    try {
      bytes = await readFile(image.mapPath);
    } catch (error) {
      if (error.code === "ENOENT") throw inferenceError("MISSING_PROBABILITY_MAP", "Probability map does not exist.", 404, error);
      throw inferenceError("INVALID_PROBABILITY_MAP", "Saved probability map is invalid.", 422, error);
    }

    let map;
    try {
      map = parseProbabilityNpy(bytes);
    } catch (error) {
      throw inferenceError("INVALID_PROBABILITY_MAP", "Saved probability map is invalid.", 422, error);
    }
    const dimensions = await sourceDimensions(image.imagePath, maxImagePixels);
    if (map.width !== dimensions.width || map.height !== dimensions.height) {
      throw inferenceError("DIMENSION_MISMATCH", "Probability map dimensions do not match the source image.", 422);
    }
    return map;
  }

  async function loadSourceRaw16(id) {
    const image = await imageFor(id);
    try {
      return await readGrey16RawFromImage(image.imagePath, { maxImagePixels });
    } catch (error) {
      throw inferenceError("INVALID_SOURCE", "Unable to read source image.", 422, error);
    }
  }

  async function hasCompleteMap(image) {
    try {
      await loadMap(image);
      return true;
    } catch {
      return false;
    }
  }

  async function loadSettings(image, { persistDefault = false } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(image.settingsPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw inferenceError("INVALID_SETTINGS", "Saved threshold settings are invalid.", 422, error);
      }
      const settings = cleanSettings(image);
      if (persistDefault) await writeSettings(image, settings);
      return settings;
    }

    if (!parsed || typeof parsed !== "object" || !validThreshold(parsed.threshold)) {
      throw inferenceError("INVALID_SETTINGS", "Saved threshold settings are invalid.", 422);
    }
    return cleanSettings(image, parsed);
  }

  async function writeSettings(image, settings) {
    const payload = { ...cleanSettings(image, settings), updatedAt: new Date().toISOString() };
    await writeAtomically(image.settingsPath, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  async function polygonForTimestamp(timestampFolder, roiGroupId, width, height) {
    if (!roiGroupId) return null;
    let bounds;
    try {
      bounds = await storage.loadBounds(timestampFolder);
    } catch {
      return null;
    }
    if (!bounds || bounds.width !== width || bounds.height !== height || !Array.isArray(bounds.groups)) return null;
    return validPolygon(bounds.groups.find((group) => group?.id === roiGroupId), width, height);
  }

  async function selectableGroups(timestampFolder, width, height) {
    let bounds;
    try {
      bounds = await storage.loadBounds(timestampFolder);
    } catch {
      return [];
    }
    if (!bounds || bounds.width !== width || bounds.height !== height || !Array.isArray(bounds.groups)) return [];
    return bounds.groups
      .filter((group) => validPolygon(group, width, height))
      .map((group) => ({ id: group.id, name: typeof group.name === "string" ? group.name : null, color: typeof group.color === "string" ? group.color : null }));
  }

  async function requestProbabilityMap(image, serverUrl) {
    let sourceBytes;
    try {
      sourceBytes = await readFile(image.imagePath);
    } catch (error) {
      throw inferenceError("SOURCE_READ_FAILED", "Unable to read source image.", 422, error);
    }
    const form = new FormData();
    form.append("file", new Blob([sourceBytes], { type: "image/tiff" }), image.imageFile);
    let response;
    try {
      response = await fetchImpl(new URL("/v1/inference/probability-map", serverUrl), {
        method: "POST",
        headers: { Accept: "application/x-npy" },
        body: form,
      });
    } catch (error) {
      throw inferenceError("MODEL_REQUEST_FAILED", "Model inference failed.", 502, error);
    }
    if (!response?.ok) throw inferenceError("MODEL_REQUEST_FAILED", "Model inference failed.", 502);
    if (response.headers?.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/x-npy") {
      throw inferenceError("INVALID_RESPONSE_TYPE", "Model response must be an NPY file.", 502);
    }

    let bytes;
    let map;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
      map = parseProbabilityNpy(bytes);
    } catch (error) {
      throw inferenceError("INVALID_PROBABILITY_MAP", "Model probability map is invalid.", 502, error);
    }
    const dimensions = await sourceDimensions(image.imagePath, maxImagePixels);
    if (map.width !== dimensions.width || map.height !== dimensions.height) {
      throw inferenceError("DIMENSION_MISMATCH", "Model probability map dimensions do not match the source image.", 502);
    }
    return { bytes, map };
  }

  async function listImages() {
    const scanned = await images();
    return Promise.all(scanned.map(async (image) => {
      const transient = sourceStates.get(image.imagePath);
      const status = transient?.status === "sending"
        ? "sending"
        : transient?.status === "failed"
          ? "failed"
          : await hasCompleteMap(image)
            ? "complete"
            : "waiting";
      return { ...image, status, ...(transient?.message ? { message: transient.message } : {}) };
    }));
  }

  async function saveThreshold(id, payload = {}) {
    const { threshold, referenceId, targetAreaFraction, roiGroupId } = objectPayload(payload);
    const normalizedThreshold = normalizeThreshold(threshold);
    if (normalizedThreshold === null) {
      throw inferenceError("INVALID_THRESHOLD", "Threshold must be between 0 and 1.", 400);
    }
    if (referenceId !== undefined && referenceId !== null && typeof referenceId !== "string") {
      throw inferenceError("INVALID_REFERENCE", "Reference image is invalid.", 400);
    }
    if (targetAreaFraction !== undefined && targetAreaFraction !== null && !validThreshold(targetAreaFraction)) {
      throw inferenceError("INVALID_TARGET_FRACTION", "Target area fraction must be between 0 and 1.", 400);
    }
    if (roiGroupId !== undefined && roiGroupId !== null && typeof roiGroupId !== "string") {
      throw inferenceError("INVALID_ROI", "ROI group is invalid.", 400);
    }
    const image = await imageFor(id);
    const previous = await loadSettings(image);
    return writeSettings(image, {
      ...previous,
      threshold: normalizedThreshold,
      ...(referenceId !== undefined ? { referenceId } : {}),
      ...(targetAreaFraction !== undefined ? { targetAreaFraction } : {}),
      ...(roiGroupId !== undefined ? { roiGroupId } : {}),
    });
  }

  async function loadCellBoundariesForImage(image, width, height) {
    let saved;
    try {
      saved = JSON.parse(await readFile(image.cellBoundariesPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return emptyCellBoundaries(width, height);
      throw inferenceError("INVALID_CELL_BOUNDARIES", "Saved cell boundaries are invalid.", 422, error);
    }
    try {
      return cleanCellBoundaries(saved, width, height);
    } catch (error) {
      if (error instanceof InferenceError) {
        throw inferenceError("INVALID_CELL_BOUNDARIES", "Saved cell boundaries are invalid.", 422, error);
      }
      throw error;
    }
  }

  async function loadCellBoundaries(id) {
    const image = await imageFor(id);
    const dimensions = await sourceDimensions(image.imagePath, maxImagePixels);
    return loadCellBoundariesForImage(image, dimensions.width, dimensions.height);
  }

  async function saveCellBoundaries(id, payload) {
    const image = await imageFor(id);
    const dimensions = await sourceDimensions(image.imagePath, maxImagePixels);
    const bounds = cleanCellBoundaries(payload, dimensions.width, dimensions.height);
    await writeAtomically(image.cellBoundariesPath, `${JSON.stringify(bounds, null, 2)}\n`);
    return bounds;
  }

  async function loadReview(id, options = {}) {
    const image = await imageFor(id);
    const map = await loadMap(image);
    const settings = await loadSettings(image, { persistDefault: true });
    const requestOptions = objectPayload(options);
    const { roiGroupId } = requestOptions;
    const hasRectangle = Object.prototype.hasOwnProperty.call(requestOptions, "roi");
    const rectangle = hasRectangle ? validRectangle(requestOptions.roi, map.width, map.height) : null;
    if (hasRectangle && requestOptions.roi !== null && !rectangle) {
      throw inferenceError("INVALID_ROI", "ROI rectangle must be inside the image.", 400);
    }
    // Inference uses only its own common rectangle. Legacy group support remains
    // available to direct API callers that explicitly pass roiGroupId.
    const selectedRoiGroupId = !hasRectangle && typeof roiGroupId === "string" ? roiGroupId : null;
    const polygon = rectangle
      ? polygonForRectangle(rectangle)
      : await polygonForTimestamp(image.timestampFolder, selectedRoiGroupId, map.width, map.height);
    const cellBoundaries = await loadCellBoundariesForImage(image, map.width, map.height);
    const excludedPolygons = cellBoundaryPolygons(cellBoundaries, map.width, map.height);
    const wholeImage = probabilityMetrics({ probabilityMap: map, threshold: settings.threshold, excludedPolygons });
    return {
      id: image.id,
      timestampFolder: image.timestampFolder,
      imageFile: image.imageFile,
      width: map.width,
      height: map.height,
      threshold: settings.threshold,
      settings,
      map,
      wholeImage,
      cellBoundaries,
      groups: await selectableGroups(image.timestampFolder, map.width, map.height),
      polygon,
      roi: polygon
        ? {
          ...(rectangle ? { rectangle } : { groupId: selectedRoiGroupId }),
          metrics: probabilityMetrics({ probabilityMap: map, threshold: settings.threshold, polygon, rectangle, excludedPolygons }),
        }
        : null,
    };
  }

  async function applyReferenceThresholds(payload = {}) {
    const requestPayload = objectPayload(payload);
    const { referenceId, roiGroupId = null } = requestPayload;
    if (typeof referenceId !== "string" || (roiGroupId !== null && typeof roiGroupId !== "string")) {
      throw inferenceError("INVALID_REFERENCE", "Reference image is invalid.", 400);
    }
    const referenceImage = await imageFor(referenceId);
    const referenceMap = await loadMap(referenceImage);
    const referenceSettings = await loadSettings(referenceImage, { persistDefault: true });
    const hasRectangle = Object.prototype.hasOwnProperty.call(requestPayload, "roi");
    const rectangle = hasRectangle ? validRectangle(requestPayload.roi, referenceMap.width, referenceMap.height) : null;
    if (hasRectangle && requestPayload.roi !== null && !rectangle) {
      throw inferenceError("INVALID_ROI", "ROI rectangle must be inside the image.", 400);
    }
    const referencePolygon = rectangle
      ? polygonForRectangle(rectangle)
      : await polygonForTimestamp(referenceImage.timestampFolder, hasRectangle ? null : roiGroupId, referenceMap.width, referenceMap.height);
    const referenceCellBounds = await loadCellBoundariesForImage(referenceImage, referenceMap.width, referenceMap.height);
    const referenceExcludedPolygons = cellBoundaryPolygons(referenceCellBounds, referenceMap.width, referenceMap.height);
    const targetAreaFraction = probabilityMetrics({
      probabilityMap: referenceMap,
      threshold: referenceSettings.threshold,
      polygon: referencePolygon,
      rectangle,
      excludedPolygons: referenceExcludedPolygons,
    }).areaFraction;
    let updated = 0;
    for (const image of await listImages()) {
      if (image.id === referenceId || image.status !== "complete") continue;
      const map = await loadMap(image);
      const targetRectangle = rectangle ? validRectangle(rectangle, map.width, map.height) : null;
      if (rectangle && !targetRectangle) {
        throw inferenceError("INVALID_ROI", "ROI rectangle does not fit every image.", 400);
      }
      const polygon = targetRectangle
        ? polygonForRectangle(targetRectangle)
        : await polygonForTimestamp(image.timestampFolder, hasRectangle ? null : roiGroupId, map.width, map.height);
      const cellBounds = await loadCellBoundariesForImage(image, map.width, map.height);
      const { threshold } = closestThreshold({
        probabilityMap: map,
        targetFraction: targetAreaFraction,
        polygon,
        rectangle: targetRectangle,
        excludedPolygons: cellBoundaryPolygons(cellBounds, map.width, map.height),
      });
      await saveThreshold(image.id, {
        threshold,
        referenceId,
        targetAreaFraction,
        roiGroupId: hasRectangle ? null : polygon ? roiGroupId : null,
      });
      updated += 1;
    }
    return {
      updated,
      targetAreaFraction,
      ...(rectangle ? { roi: rectangle } : { roiGroupId: referencePolygon ? roiGroupId : null }),
    };
  }

  async function createOverlay(id, { threshold } = {}) {
    const normalizedThreshold = normalizeThreshold(threshold);
    if (normalizedThreshold === null) {
      throw inferenceError("INVALID_THRESHOLD", "Threshold must be between 0 and 1.", 400);
    }
    const image = await imageFor(id);
    const map = await loadMap(image);
    const cellBounds = await loadCellBoundariesForImage(image, map.width, map.height);
    return createProbabilityOverlayPng({
      probabilityMap: map,
      threshold: normalizedThreshold,
      excludedPolygons: cellBoundaryPolygons(cellBounds, map.width, map.height),
    });
  }

  async function generateMasks() {
    const result = { completed: 0, failed: 0 };
    for (const image of await listImages()) {
      if (image.status !== "complete") continue;
      try {
        const [map, settings] = await Promise.all([
          loadMap(image),
          loadSettings(image, { persistDefault: true }),
        ]);
        await mkdir(path.dirname(image.maskPath), { recursive: true });
        const cellBounds = await loadCellBoundariesForImage(image, map.width, map.height);
        await writeThresholdMaskPng(image.maskPath, {
          probabilityMap: map,
          threshold: settings.threshold,
          excludedPolygons: cellBoundaryPolygons(cellBounds, map.width, map.height),
        });
        result.completed += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  async function runJob(job, serverUrl, scannedImages) {
    for (const image of scannedImages) {
      sourceStates.set(image.imagePath, { status: "sending" });
      try {
        const { bytes } = await requestProbabilityMap(image, serverUrl);
        await writeAtomically(image.mapPath, bytes);
        sourceStates.set(image.imagePath, { status: "complete" });
        job.completed += 1;
      } catch (error) {
        sourceStates.set(image.imagePath, { status: "failed", message: safeMessage(error) });
        job.failed += 1;
      }
    }
    job.status = job.failed > 0 ? "partial" : "complete";
    job.finishedAt = new Date().toISOString();
  }

  function publicJob(job) {
    const { rootPath: _rootPath, ...publicFields } = job;
    return publicFields;
  }

  function startJob({ serverUrl } = {}) {
    if (activeJobId) {
      throw inferenceError("JOB_IN_PROGRESS", "Inference is already running.", 409);
    }
    const normalizedUrl = normalizedServerUrl(serverUrl);
    const rootPath = storage.getRoot();
    if (!rootPath) throw inferenceError("ROOT_UNSET", "Storage root has not been set.", 400);
    const job = {
      id: randomUUID(),
      status: "running",
      total: 0,
      completed: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      rootPath,
    };
    jobs.set(job.id, job);
    activeJobId = job.id;
    void images().then((scanned) => {
      job.total = scanned.length;
      return runJob(job, normalizedUrl, scanned);
    }).catch((error) => {
      job.status = "failed";
      job.failed = Math.max(job.failed, 1);
      job.message = safeMessage(error);
      job.finishedAt = new Date().toISOString();
    }).finally(() => {
      if (activeJobId === job.id) activeJobId = null;
    });
    return publicJob(job);
  }

  function getJob(jobId) {
    const job = jobs.get(jobId);
    if (!job || job.rootPath !== storage.getRoot()) {
      throw inferenceError("JOB_NOT_FOUND", "Inference job not found.", 404);
    }
    return publicJob(job);
  }

  async function changeRoot(change) {
    if (activeJobId) {
      throw inferenceError("JOB_IN_PROGRESS", "Inference is already running.", 409);
    }
    const previousRoot = storage.getRoot();
    const result = await change();
    if (storage.getRoot() !== previousRoot) {
      jobs.clear();
      sourceStates.clear();
    }
    return result;
  }

  return {
    listImages,
    changeRoot,
    startJob,
    getJob,
    loadSourceRaw16,
    loadReview,
    loadCellBoundaries,
    saveCellBoundaries,
    saveThreshold,
    applyReferenceThresholds,
    createOverlay,
    generateMasks,
  };
}
