import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  aggregateSkeletonMetrics,
  assignOutwardRoiPixels,
  buildSkeletonSamples,
  polygonSelfIntersects,
  validateRoiBands,
} from "./analysisGeometry.js";
import { readBinaryMask, thinBinaryMask, writeSkeletonPng } from "./maskSkeleton.js";

const SCHEMA_VERSION = 1;
const REQUIRED_BAND_IDS = ["near", "mid", "far"];
const METRIC_FIELDS = [
  "bandId",
  "roiAreaPx",
  "skeletonPixelCount",
  "skeletonLengthPx",
  "density",
  "coverage",
  "globalAlignment",
  "globalOrientationDeg",
  "radialNormalAlignment",
  "tangentialAlignment",
  "orientationDispersion",
  "endpointCount",
  "branchpointCount",
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

async function selectMaskSource(image, maskDir) {
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

function validateBoundsPayload(bounds) {
  if (!bounds || typeof bounds !== "object" || !Array.isArray(bounds.groups)) {
    throw analysisError("INVALID_BOUNDS", "Saved bounds are invalid.");
  }

  if (bounds.groups.length === 0) {
    throw analysisError("INVALID_BOUNDS", "Saved bounds must include at least one polygon group.");
  }

  const ids = new Set();
  for (const group of bounds.groups) {
    if (
      !isPlainObject(group) ||
      typeof group.id !== "string" ||
      group.id.length === 0 ||
      ids.has(group.id) ||
      !isOptionalString(group.name) ||
      !isOptionalString(group.color) ||
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

  return bounds.groups;
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

function buildGroupAnalyses({ groups, assignments, samples }) {
  return groups.map((group) => {
    const groupAssignments = filterAssignments(assignments, group.id ?? null);
    const groupSamples = filterSamples(samples, group.id ?? null);
    const metrics = aggregateSkeletonMetrics({
      assignments: groupAssignments,
      samples: groupSamples,
    });

    return {
      groupId: group.id,
      groupName: group.name ?? null,
      color: group.color ?? null,
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
    !Number.isFinite(value.height) ||
    typeof value.mtimeMs !== "number" ||
    !Number.isFinite(value.mtimeMs)
  ) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  return {
    file: path.basename(file),
    format: value.format,
    width: value.width,
    height: value.height,
    mtimeMs: value.mtimeMs,
  };
}

function sanitizeGroupAnalysis(value) {
  if (!isPlainObject(value) || typeof value.groupId !== "string" || !isPlainObject(value.bands) || !isPlainObject(value.allBands)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  return {
    groupId: value.groupId,
    groupName: typeof value.groupName === "string" ? value.groupName : null,
    color: typeof value.color === "string" ? value.color : null,
    bands: sanitizeBands(value.bands),
    allBands: sanitizeMetric(value.allBands),
  };
}

function sanitizeRoiBands(value) {
  try {
    return validateRoiBands(value);
  } catch (error) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.", 422, error);
  }
}

function sanitizeAnalysis(analysis) {
  if (!isPlainObject(analysis) || !Array.isArray(analysis.groups)) {
    throw analysisError("INVALID_ANALYSIS", "Saved analysis JSON is invalid.");
  }

  return {
    schemaVersion: analysis.schemaVersion ?? SCHEMA_VERSION,
    imageFolder: typeof analysis.imageFolder === "string" ? path.basename(analysis.imageFolder) : analysis.imageFolder,
    imageFile: typeof analysis.imageFile === "string" ? path.basename(analysis.imageFile) : analysis.imageFile,
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
  const tempPath = `${outputPath}.tmp-${randomUUID()}`;

  try {
    await writeSkeleton(tempPath, skeleton);
    await rename(tempPath, outputPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function buildAnalysis({ image, paths, bounds, maskSource, skeleton, roiBands, groups }) {
  let assignments;
  let samples;
  let imageMetrics;

  try {
    assignments = assignOutwardRoiPixels({
      width: skeleton.width,
      height: skeleton.height,
      groups,
      roiBands,
    });
    samples = buildSkeletonSamples({
      skeleton: skeleton.data,
      width: skeleton.width,
      height: skeleton.height,
      assignments,
    });
    imageMetrics = aggregateSkeletonMetrics({ assignments, samples });
  } catch (error) {
    throw analysisError("CALCULATION_FAILED", "Unable to calculate analysis metrics.", 422, error);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    imageFolder: image.imageFolder,
    imageFile: image.imageFile,
    boundsFile: path.basename(paths.boundsPath),
    maskSource: sourceForJson(maskSource),
    skeletonFile: path.basename(paths.skeletonPath),
    roiBands,
    groups: buildGroupAnalyses({ groups, assignments, samples }),
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
  return { analysis: analysis === null ? null : sanitizeAnalysis(analysis), hasAnalysis: analysis !== null };
}

export async function recalculateAnalysis(storage, id, { roiBands, maxImagePixels, writeSkeleton = writeSkeletonPng } = {}) {
  const image = storage.getImage(id);
  const paths = storage.imagePaths(id);
  let normalizedBands;
  try {
    normalizedBands = validateRoiBands(roiBands);
  } catch (error) {
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

  const groups = validateBoundsPayload(bounds);
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
    image,
    paths,
    bounds,
    maskSource: maskSourceWithDimensions,
    skeleton,
    roiBands: normalizedBands,
    groups,
  });

  return {
    analysis: await storage.saveAnalysis(id, analysis),
    hasAnalysis: true,
  };
}
