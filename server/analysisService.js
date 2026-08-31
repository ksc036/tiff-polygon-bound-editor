import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  aggregateRoiMetrics,
  assignInsideRoiPixels,
  assignOutwardRoiPixels,
  buildMaskSamples,
  buildSkeletonSamples,
  polygonSelfIntersects,
  validateRoiBands,
} from "./analysisGeometry.js";
import { readBinaryMask, thinBinaryMask, writeSkeletonPng } from "./maskSkeleton.js";

const SCHEMA_VERSION = 5;
const REQUIRED_BAND_IDS = ["near", "mid", "far"];
const ANALYSIS_MODES = new Set(["outside", "inside"]);
const METRIC_FIELDS = [
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
];

export class AnalysisError extends Error {
  constructor(code, message, { status = 422, cause } = {}) {
    super(message, { cause });
    this.name = "AnalysisError";
    this.code = code;
    this.status = status;
  }
}

function analysisError(code, message, status, cause) {
  return new AnalysisError(code, message, { status, cause });
}

function imageBasename(fileName) {
  return path.basename(fileName).replace(/\.(?:tiff?|png)$/i, "");
}

function isPng(fileName) {
  return /\.png$/i.test(fileName);
}

function isTiff(fileName) {
  return /\.tiff?$/i.test(fileName);
}

async function listMaskFiles(maskDir) {
  try {
    return (await readdir(maskDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function selectMaskSource(image, maskDir) {
  const files = await listMaskFiles(maskDir);
  const basename = imageBasename(image.imageFile);
  const pngs = files.filter(isPng);
  const tiffs = files.filter(isTiff);
  const candidates = [
    pngs.find((fileName) => imageBasename(fileName) === basename),
    pngs[0],
    tiffs.find((fileName) => imageBasename(fileName) === basename),
    tiffs[0],
  ].filter(Boolean);
  const fileName = candidates[0];
  const filePath = fileName ? path.join(maskDir, fileName) : null;
  const fileStat = filePath ? await stat(filePath) : null;

  return fileName
    ? {
        file: fileName,
        path: filePath,
        format: isPng(fileName) ? "png" : "tiff",
        mtimeMs: fileStat.mtimeMs,
      }
    : null;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value) {
  return value === undefined || typeof value === "string";
}

function isFinitePoint(point) {
  return isPlainObject(point) && typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y);
}

function isOptionalMigrationVector(value) {
  return value === undefined || value === null || (isPlainObject(value) && isFinitePoint(value.start) && isFinitePoint(value.end));
}

function normalizeAnalysisMode(value) {
  return value === undefined ? "outside" : value;
}

function validateBoundsPayload(bounds) {
  if (!bounds || typeof bounds !== "object" || !Array.isArray(bounds.groups)) {
    throw analysisError("INVALID_BOUNDS", "Saved bounds are invalid.");
  }

  if (bounds.groups.length === 0) {
    throw analysisError("INVALID_BOUNDS", "Saved bounds must include at least one polygon group.");
  }

  const ids = new Set();
  for (const group of bounds.groups) {
    const analysisMode = normalizeAnalysisMode(group.analysisMode);
    if (
      !isPlainObject(group) ||
      typeof group.id !== "string" ||
      group.id.length === 0 ||
      ids.has(group.id) ||
      !isOptionalString(group.name) ||
      !isOptionalString(group.color) ||
      !isOptionalMigrationVector(group.migrationVector) ||
      !ANALYSIS_MODES.has(analysisMode) ||
      !Array.isArray(group.points) ||
      group.points.length < 3 ||
      !group.points.every(isFinitePoint)
    ) {
      throw analysisError("INVALID_BOUNDS", "Saved bounds are invalid.");
    }

    ids.add(group.id);

    if (polygonSelfIntersects(group.points)) {
      throw analysisError("INVALID_BOUNDS", "Boundary groups must not self-intersect.");
    }
  }

  return bounds.groups.map((group) => ({ ...group, analysisMode: normalizeAnalysisMode(group.analysisMode) }));
}

function resolveDimensions(bounds, mask) {
  const width = bounds.width ?? mask.width;
  const height = bounds.height ?? mask.height;

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    (bounds.width !== null && bounds.width !== undefined && bounds.width !== mask.width) ||
    (bounds.height !== null && bounds.height !== undefined && bounds.height !== mask.height)
  ) {
    throw analysisError("DIMENSION_MISMATCH", "Mask dimensions do not match saved bounds.");
  }

  return { width, height };
}

function filterAssignments(assignments, groupId) {
  return new Map([...assignments].filter(([, assignment]) => assignment.groupId === groupId));
}

function filterSamples(samples, groupId) {
  return samples.filter((sample) => sample.groupId === groupId);
}

function sourceForJson(source) {
  return {
    file: source.file,
    format: source.format,
    width: source.width,
    height: source.height,
    mtimeMs: source.mtimeMs,
  };
}

function buildGroupAnalyses({ groups, outsideAssignments, insideAssignments, maskSamples, skeletonSamples }) {
  return groups.map((group) => {
    const groupAssignments = filterAssignments(
      group.analysisMode === "inside" ? insideAssignments : outsideAssignments,
      group.id ?? null,
    );
    const groupMaskSamples = filterSamples(maskSamples, group.id ?? null);
    const groupSkeletonSamples = filterSamples(skeletonSamples, group.id ?? null);
    const metrics = aggregateRoiMetrics({
      assignments: groupAssignments,
      maskSamples: groupMaskSamples,
      skeletonSamples: groupSkeletonSamples,
      bandIds: group.analysisMode === "inside" ? ["inside"] : REQUIRED_BAND_IDS,
    });

    const base = {
      groupId: group.id,
      groupName: group.name ?? null,
      color: group.color ?? null,
      analysisMode: group.analysisMode,
      migrationVector: group.migrationVector ?? null,
    };

    if (group.analysisMode === "inside") {
      return {
        ...base,
        area: metrics.bands.inside,
      };
    }

    return {
      ...base,
      ...(group.roiBands ? { roiBands: group.roiBands } : {}),
      bands: metrics.bands,
      allBands: metrics.overall,
    };
  });
}

function sanitizeBands(value) {
  if (!isPlainObject(value)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  return Object.fromEntries(
    REQUIRED_BAND_IDS.filter((bandId) => value[bandId] !== undefined).map((bandId) => [bandId, sanitizeMetric(value[bandId])]),
  );
}

function sanitizeMetric(value) {
  if (!isPlainObject(value)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  const metric = {};
  for (const field of METRIC_FIELDS) {
    if (value[field] !== undefined) {
      metric[field] = value[field];
    }
  }

  return metric;
}

function sanitizeMigrationVector(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isPlainObject(value) || !isFinitePoint(value.start) || !isFinitePoint(value.end)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  return {
    start: { x: value.start.x, y: value.start.y },
    end: { x: value.end.x, y: value.end.y },
  };
}

function sanitizeImageSummary(value) {
  if (!isPlainObject(value)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  const summary = sanitizeMetric(value);
  for (const field of ["width", "height", "groupCount"]) {
    if (value[field] !== undefined) {
      summary[field] = value[field];
    }
  }

  if (value.bands !== undefined) {
    summary.bands = sanitizeBands(value.bands);
  }

  return summary;
}

function sanitizeMaskSource(value) {
  if (!isPlainObject(value)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  const file = value.file ?? value.fileName;
  if (
    typeof file !== "string" ||
    typeof value.format !== "string" ||
    typeof value.width !== "number" ||
    !Number.isFinite(value.width) ||
    typeof value.height !== "number" ||
    !Number.isFinite(value.height)
  ) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  const sanitized = {
    file: path.basename(file),
    format: value.format,
    width: value.width,
    height: value.height,
  };
  if (typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs)) {
    sanitized.mtimeMs = value.mtimeMs;
  }
  return sanitized;
}

function sanitizeGroupAnalysis(value) {
  const analysisMode = normalizeAnalysisMode(value?.analysisMode);
  if (!isPlainObject(value) || typeof value.groupId !== "string" || !ANALYSIS_MODES.has(analysisMode)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  const base = {
    groupId: value.groupId,
    groupName: typeof value.groupName === "string" ? value.groupName : null,
    color: typeof value.color === "string" ? value.color : null,
    analysisMode,
    migrationVector: sanitizeMigrationVector(value.migrationVector),
  };

  if (analysisMode === "inside") {
    if (!isPlainObject(value.area)) {
      throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
    }
    return {
      ...base,
      area: sanitizeMetric(value.area),
    };
  }

  if (!isPlainObject(value.bands) || !isPlainObject(value.allBands)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  return {
    ...base,
    ...(value.roiBands === undefined || value.roiBands === null ? {} : { roiBands: sanitizeRoiBands(value.roiBands) }),
    bands: sanitizeBands(value.bands),
    allBands: sanitizeMetric(value.allBands),
  };
}

function mergeAssignments(...assignmentMaps) {
  const merged = new Map();
  for (const assignmentMap of assignmentMaps) {
    for (const [key, assignment] of assignmentMap ?? []) {
      if (!merged.has(key)) {
        merged.set(key, assignment);
      }
    }
  }
  return merged;
}

function sanitizeRoiBands(value) {
  try {
    return validateRoiBands(value);
  } catch (error) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.", 422, error);
  }
}

function normalizeRoiBandsByGroup(value) {
  if (value === undefined || value === null) {
    return new Map();
  }

  if (!isPlainObject(value)) {
    throw analysisError("INVALID_ROI_BANDS", "Invalid ROI bands.", 400);
  }

  const bandsByGroup = new Map();
  for (const [groupId, groupBands] of Object.entries(value)) {
    try {
      bandsByGroup.set(groupId, validateRoiBands(groupBands));
    } catch (error) {
      throw analysisError("INVALID_ROI_BANDS", "Invalid ROI bands.", 400, error);
    }
  }

  return bandsByGroup;
}

function applyGroupRoiBands(groups, roiBandsByGroup) {
  return groups.map((group) =>
    group.analysisMode === "outside" && roiBandsByGroup.has(group.id)
      ? { ...group, roiBands: roiBandsByGroup.get(group.id) }
      : group,
  );
}

function sanitizeAnalysis(analysis) {
  if (!isPlainObject(analysis) || !Array.isArray(analysis.groups)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  return {
    schemaVersion: analysis.schemaVersion ?? SCHEMA_VERSION,
    boundsFile: typeof analysis.boundsFile === "string" ? path.basename(analysis.boundsFile) : analysis.boundsFile,
    maskSource: sanitizeMaskSource(analysis.maskSource),
    skeletonFile: typeof analysis.skeletonFile === "string" ? path.basename(analysis.skeletonFile) : analysis.skeletonFile,
    roiBands: sanitizeRoiBands(analysis.roiBands),
    groups: analysis.groups.map(sanitizeGroupAnalysis),
    imageSummary: sanitizeImageSummary(analysis.imageSummary),
    warnings: Array.isArray(analysis.warnings)
      ? analysis.warnings.filter((warning) => typeof warning === "string" && !path.isAbsolute(warning))
      : [],
    updatedAt: typeof analysis.updatedAt === "string" ? analysis.updatedAt : null,
  };
}

async function writeSkeletonAtomically(outputPath, skeleton, writeSkeleton) {
  const tempPath = path.join(path.dirname(outputPath), `.skeleton-${randomUUID()}.tmp.png`);

  try {
    await writeSkeleton(tempPath, skeleton);
    await rename(tempPath, outputPath);
    const skeletonDir = path.dirname(outputPath);
    const outputKey = path.resolve(outputPath).toLocaleLowerCase();
    const entries = await readdir(skeletonDir, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && /\.(?:png|tiff?)$/i.test(entry.name))
      .map((entry) => path.join(skeletonDir, entry.name))
      .filter((filePath) => path.resolve(filePath).toLocaleLowerCase() !== outputKey)
      .map((filePath) => rm(filePath, { force: true })));
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function buildAnalysis({ paths, bounds, maskSource, mask, skeleton, roiBands, groups }) {
  let outsideAssignments;
  let insideAssignments;
  let assignments;
  let maskSamples;
  let skeletonSamples;
  let imageMetrics;

  try {
    const outsideGroups = groups.filter((group) => group.analysisMode === "outside");
    const insideGroups = groups.filter((group) => group.analysisMode === "inside");
    outsideAssignments = assignOutwardRoiPixels({
      width: skeleton.width,
      height: skeleton.height,
      groups: outsideGroups,
      roiBands,
    });
    insideAssignments = assignInsideRoiPixels({
      width: skeleton.width,
      height: skeleton.height,
      groups: insideGroups,
    });
    assignments = mergeAssignments(outsideAssignments, insideAssignments);
    const outsideMaskSamples = buildMaskSamples({
      mask: mask.data,
      width: mask.width,
      height: mask.height,
      assignments: outsideAssignments,
    });
    const insideMaskSamples = buildMaskSamples({
      mask: mask.data,
      width: mask.width,
      height: mask.height,
      assignments: insideAssignments,
    });
    const outsideSkeletonSamples = buildSkeletonSamples({
      skeleton: skeleton.data,
      width: skeleton.width,
      height: skeleton.height,
      assignments: outsideAssignments,
    });
    const insideSkeletonSamples = buildSkeletonSamples({
      skeleton: skeleton.data,
      width: skeleton.width,
      height: skeleton.height,
      assignments: insideAssignments,
    });
    maskSamples = [...outsideMaskSamples, ...insideMaskSamples];
    skeletonSamples = [...outsideSkeletonSamples, ...insideSkeletonSamples];
    imageMetrics = aggregateRoiMetrics({
      assignments,
      maskSamples: buildMaskSamples({
        mask: mask.data,
        width: mask.width,
        height: mask.height,
        assignments,
      }),
      skeletonSamples: buildSkeletonSamples({
        skeleton: skeleton.data,
        width: skeleton.width,
        height: skeleton.height,
        assignments,
      }),
    });
  } catch (error) {
    throw analysisError("CALCULATION_FAILED", "Unable to calculate analysis metrics.", 422, error);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    boundsFile: path.basename(paths.boundsPath),
    maskSource: sourceForJson(maskSource),
    skeletonFile: path.basename(paths.skeletonPath),
    roiBands,
    groups: buildGroupAnalyses({ groups, outsideAssignments, insideAssignments, maskSamples, skeletonSamples }),
    imageSummary: {
      width: skeleton.width,
      height: skeleton.height,
      groupCount: groups.length,
      ...imageMetrics.overall,
      bands: imageMetrics.bands,
    },
    warnings: [],
  };
}

export async function loadAnalysis(storage, id) {
  const analysis = await storage.loadAnalysis(id);
  if (analysis === null || analysis.schemaVersion !== SCHEMA_VERSION) {
    return { analysis: null, hasAnalysis: false };
  }

  return { analysis: sanitizeAnalysis(analysis), hasAnalysis: true };
}

export async function recalculateAnalysis(storage, id, { roiBands, roiBandsByGroup, maxImagePixels, writeSkeleton = writeSkeletonPng } = {}) {
  const image = storage.getImage(id);
  const paths = storage.imagePaths(id);
  let normalizedBands;
  let normalizedBandsByGroup;
  try {
    normalizedBands = validateRoiBands(roiBands);
    normalizedBandsByGroup = normalizeRoiBandsByGroup(roiBandsByGroup);
  } catch (error) {
    if (error instanceof AnalysisError) {
      throw error;
    }
    throw analysisError("INVALID_ROI_BANDS", "Invalid ROI bands.", 400, error);
  }

  if (!existsSync(paths.boundsPath)) {
    throw analysisError("MISSING_BOUNDS", "Saved bounds are required before analysis.", 409);
  }

  let bounds;
  try {
    bounds = await storage.loadBounds(id);
  } catch (error) {
    if (/invalid bounds json/i.test(error.message)) {
      throw analysisError("CORRUPT_BOUNDS", "Saved bounds JSON is invalid.", 422, error);
    }

    throw error;
  }

  const groups = applyGroupRoiBands(validateBoundsPayload(bounds), normalizedBandsByGroup);
  const maskSource = await selectMaskSource(image, paths.maskDir);
  if (!maskSource) {
    throw analysisError("MISSING_MASK", "Mask image is required before analysis.", 409);
  }

  let mask;
  try {
    mask = await readBinaryMask(maskSource.path, { maxImagePixels });
  } catch (error) {
    throw analysisError("UNREADABLE_MASK", "Unable to read mask image.", 422, error);
  }

  resolveDimensions(bounds, mask);
  const maskSourceWithDimensions = {
    ...maskSource,
    width: mask.width,
    height: mask.height,
  };

  let skeleton;
  try {
    skeleton = thinBinaryMask(mask);
    await writeSkeletonAtomically(paths.skeletonPath, skeleton, writeSkeleton);
  } catch (error) {
    throw analysisError("CALCULATION_FAILED", "Unable to calculate analysis metrics.", 422, error);
  }

  const analysis = buildAnalysis({
    paths,
    bounds,
    maskSource: maskSourceWithDimensions,
    mask,
    skeleton,
    roiBands: normalizedBands,
    groups,
  });

  return {
    analysis: await storage.saveAnalysis(id, analysis),
    hasAnalysis: true,
  };
}
