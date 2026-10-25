import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { resolveMaxImagePixels } from "./imageProcessing.js";
import { sharpPath } from "./sharpPath.js";

const ERROR_MESSAGES = {
  INVALID_PAYLOAD: "Invalid bounds payload.",
  SOURCE_DIMENSION_MISMATCH: "Source image dimensions do not match the bounds.",
  DIMENSION_MISMATCH: "Image dimensions do not match the source image.",
  IMAGE_READ_FAILED: "Unable to read image dimensions.",
  INVALID_BOUNDS: "Saved bounds are invalid.",
};

export class BoundaryBatchError extends Error {
  constructor(code, status = 422) {
    super(ERROR_MESSAGES[code]);
    this.name = "BoundaryBatchError";
    this.status = status;
  }
}

function validOptionalString(value) {
  return value === undefined || typeof value === "string";
}

function validOptionalLink(value) {
  return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

function validFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validOptionalDimension(value) {
  return value === undefined || value === null || validFiniteNumber(value);
}

export function isValidBoundsPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (!validOptionalDimension(payload.width) || !validOptionalDimension(payload.height)) return false;
  if (payload.connectionMode !== undefined && payload.connectionMode !== "input-order-cycle") return false;
  if (!Array.isArray(payload.groups)) return false;

  return payload.groups.every((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return false;
    if (typeof group.id !== "string" || !validOptionalString(group.name) || !validOptionalString(group.color)) return false;
    if (!validOptionalLink(group.sharedBoundaryId)) return false;
    if (!Array.isArray(group.points)) return false;
    return group.points.every((point) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) return false;
      return typeof point.id === "string" && validFiniteNumber(point.x) && validFiniteNumber(point.y);
    });
  });
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

async function imageDimensions(imagePath, maxImagePixels) {
  try {
    const { width, height } = await sharp(sharpPath(imagePath), {
      limitInputPixels: resolveMaxImagePixels(maxImagePixels),
    }).metadata();
    if (!positiveInteger(width) || !positiveInteger(height)) throw new Error("Invalid dimensions");
    return { width, height };
  } catch {
    throw new BoundaryBatchError("IMAGE_READ_FAILED");
  }
}

function validateExistingBounds(bounds) {
  // Legacy saved groups may lack IDs. Preserve them exactly, but never erase malformed data.
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds) || !Array.isArray(bounds.groups)
    || !validOptionalDimension(bounds.width) || !validOptionalDimension(bounds.height)
    || (bounds.connectionMode !== undefined && bounds.connectionMode !== "input-order-cycle")
    || !bounds.groups.every((group) => group && typeof group === "object" && !Array.isArray(group)
      && validOptionalString(group.id) && validOptionalString(group.name) && validOptionalString(group.color)
      && validOptionalLink(group.sharedBoundaryId)
      && Array.isArray(group.points) && group.points.every((point) => point && typeof point === "object"
        && !Array.isArray(point) && validOptionalString(point.id) && validFiniteNumber(point.x) && validFiniteNumber(point.y)))) {
    throw new BoundaryBatchError("INVALID_BOUNDS");
  }
}

function collectIds(groups, usedIds) {
  for (const group of groups) {
    usedIds.add(group.id);
    for (const point of group.points) usedIds.add(point.id);
  }
}

function freshId(usedIds) {
  let id;
  do { id = randomUUID(); } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

function failureMessage(error) {
  if (error instanceof BoundaryBatchError) return error.message;
  if (/invalid bounds json/i.test(error.message)) return "Saved bounds JSON is invalid.";
  return "Unable to update bounds for image.";
}

async function restoreSourceLinks(context, sourceId, bounds, { assignLinks = false } = {}) {
  let stored;
  try {
    stored = await context.loadBounds(sourceId);
    validateExistingBounds(stored);
  } catch (error) {
    // An explicit source save can repair corrupt bounds; targets are never repaired implicitly.
    if (!(error instanceof BoundaryBatchError) && !/invalid bounds json/i.test(error.message)) throw error;
    stored = { groups: [] };
  }
  const links = new Map(stored.groups.map((group) => [group.id, group.sharedBoundaryId]));
  return {
    ...bounds,
    groups: bounds.groups.map((group) => {
      const { sharedBoundaryId: ignoredLink, ...local } = group;
      const link = links.get(group.id) ?? (assignLinks ? randomUUID() : undefined);
      return link === undefined ? local : { ...local, sharedBoundaryId: link };
    }),
  };
}

function linkedGroups(bounds) {
  return new Map(bounds.groups.filter((group) => group.sharedBoundaryId !== undefined)
    .map((group) => [group.sharedBoundaryId, group]));
}

function synchronizeGeometry(existing, sources, usedIds) {
  const idCounts = new Map();
  for (const group of existing.groups) {
    for (const id of [group.id, ...group.points.map((point) => point.id)]) {
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
  }
  collectIds(existing.groups, usedIds);
  return existing.groups.map((group) => {
    const source = sources.get(group.sharedBoundaryId);
    if (!source) return group;
    return {
      ...group,
      points: source.points.map(({ x, y }, index) => {
        const previous = group.points[index];
        const id = typeof previous?.id === "string" && previous.id.length > 0 && idCounts.get(previous.id) === 1
          ? previous.id : freshId(usedIds);
        return { ...previous, id, x, y };
      }),
    };
  });
}

export async function saveBoundsAndSynchronize(storage, sourceId, bounds) {
  if (!isValidBoundsPayload(bounds)) throw new BoundaryBatchError("INVALID_PAYLOAD", 400);
  const sourceBounds = structuredClone(bounds);
  const context = storage.createBoundaryMutationContext();
  return context.serializeBoundaryOperation(async () => {
    const source = context.getImage(sourceId);
    const linked = await restoreSourceLinks(context, source.id, sourceBounds);
    const saved = await context.saveBounds(source.id, linked);
    const result = { bounds: saved, synchronized: [], failed: [] };
    const sources = linkedGroups(saved);
    if (sources.size === 0) return result;

    const images = await context.scanImages();
    const usedIds = new Set();
    collectIds(saved.groups, usedIds);
    for (const image of images) {
      if (image.id === source.id) continue;
      try {
        const existing = await context.loadBounds(image.id);
        validateExistingBounds(existing);
        if (!existing.groups.some((group) => sources.has(group.sharedBoundaryId))) continue;
        await context.updateBounds(image.id, (current) => {
          validateExistingBounds(current);
          return { ...current, groups: synchronizeGeometry(current, sources, usedIds) };
        });
        result.synchronized.push(image.id);
      } catch (error) {
        result.failed.push({ imageId: image.id, message: failureMessage(error) });
      }
    }
    return result;
  });
}

export async function applyBoundsToAll(storage, sourceId, bounds, { maxImagePixels } = {}) {
  if (!isValidBoundsPayload(bounds)
    || [bounds.width, bounds.height].some((value) => value != null && !positiveInteger(value))) {
    throw new BoundaryBatchError("INVALID_PAYLOAD", 400);
  }

  const sourceBounds = structuredClone(bounds);
  const context = storage.createBoundaryMutationContext();
  return context.serializeBoundaryOperation(async () => {
    const images = await context.scanImages();
    const source = context.getImage(sourceId);
    const dimensions = await imageDimensions(context.imagePaths(source.id).imagePath, maxImagePixels);
    if ((sourceBounds.width != null && sourceBounds.width !== dimensions.width)
      || (sourceBounds.height != null && sourceBounds.height !== dimensions.height)) {
      throw new BoundaryBatchError("SOURCE_DIMENSION_MISMATCH");
    }

    const linked = await restoreSourceLinks(context, source.id, sourceBounds, { assignLinks: true });
    const saved = await context.saveBounds(source.id, { ...linked, ...dimensions });
    const result = { bounds: saved, added: [], updated: [], failed: [] };
    if (saved.groups.length === 0) return result;
    const usedIds = new Set();
    collectIds(saved.groups, usedIds);
    const sources = linkedGroups(saved);
    for (const image of images) {
      if (image.id === source.id) continue;
      try {
        const targetDimensions = await imageDimensions(context.imagePaths(image.id).imagePath, maxImagePixels);
        if (targetDimensions.width !== dimensions.width || targetDimensions.height !== dimensions.height) {
          throw new BoundaryBatchError("DIMENSION_MISMATCH");
        }
        let added = false;
        let updated = false;
        await context.updateBounds(image.id, (existing) => {
          validateExistingBounds(existing);
          const existingLinks = linkedGroups(existing);
          updated = existing.groups.some((group) => sources.has(group.sharedBoundaryId));
          const groups = synchronizeGeometry(existing, sources, usedIds);
          for (const sourceGroup of saved.groups) {
            if (existingLinks.has(sourceGroup.sharedBoundaryId)) continue;
            const copy = structuredClone(sourceGroup);
            groups.push({
              ...copy,
              id: freshId(usedIds),
              points: copy.points.map((point) => ({ ...point, id: freshId(usedIds) })),
            });
            added = true;
          }
          return { ...existing, ...dimensions, groups };
        });
        if (added) result.added.push(image.id);
        if (updated) result.updated.push(image.id);
      } catch (error) {
        result.failed.push({ imageId: image.id, message: failureMessage(error) });
      }
    }
    return result;
  });
}
