const DEFAULT_ROI_BANDS = [
  { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
  { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
  { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
];

const REQUIRED_BAND_IDS = ["near", "mid", "far"];
const DEFAULT_BAND_LABELS = {
  near: "가까움",
  mid: "중간",
  far: "멀리",
};
const EPSILON = 1e-9;
const DEFAULT_SEGMENT_LENGTH_PX = 4;
const SKELETON_NEIGHBOR_OFFSETS = [
  { dx: -1, dy: -1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
];

function cloneBand(band) {
  return { id: band.id, label: band.label, fromPx: band.fromPx, toPx: band.toPx };
}

function keyFor(x, y) {
  return `${x},${y}`;
}

function parseKey(key) {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

function comparePixelKeys(left, right) {
  const leftPoint = parseKey(left);
  const rightPoint = parseKey(right);
  if (leftPoint.y !== rightPoint.y) {
    return leftPoint.y - rightPoint.y;
  }

  return leftPoint.x - rightPoint.x;
}

function cleanNumber(value) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) <= EPSILON ? rounded : value;
}

function cleanPoint(point) {
  return { x: cleanNumber(point.x), y: cleanNumber(point.y) };
}

function distanceBetween(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function vectorLength(vector) {
  return Math.hypot(vector.x, vector.y);
}

function normalizeVector(vector) {
  const length = vectorLength(vector);
  if (length <= EPSILON) {
    return null;
  }

  return { x: vector.x / length, y: vector.y / length };
}

function canonicalVector(vector) {
  if (!vector) {
    return null;
  }

  if (vector.x < -EPSILON || (Math.abs(vector.x) <= EPSILON && vector.y < -EPSILON)) {
    return cleanVector({ x: -vector.x, y: -vector.y });
  }

  return cleanVector(vector);
}

function cleanVector(vector) {
  return { x: Math.abs(vector.x) <= EPSILON ? 0 : vector.x, y: Math.abs(vector.y) <= EPSILON ? 0 : vector.y };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y;
}

function targetAngleAlignment(axis, targetAxis) {
  const normalizedAxis = canonicalVector(normalizeVector(axis));
  const normalizedTarget = canonicalVector(normalizeVector(targetAxis));
  if (!normalizedAxis || !normalizedTarget) {
    return null;
  }

  const axisDot = dot(normalizedAxis, normalizedTarget);
  return 2 * axisDot * axisDot - 1;
}

function migrationVectorFor(group) {
  const start = group?.migrationVector?.start;
  const end = group?.migrationVector?.end;
  if (!validPoint(start) || !validPoint(end)) {
    return null;
  }

  return canonicalVector(normalizeVector({ x: end.x - start.x, y: end.y - start.y }));
}

function canonicalUndirectedAngle(angle) {
  let degrees = (angle * 180) / Math.PI;
  while (degrees < 0) {
    degrees += 180;
  }
  while (degrees >= 180) {
    degrees -= 180;
  }

  return degrees;
}

function almostEqual(left, right) {
  return Math.abs(left - right) <= EPSILON;
}

function samePoint(left, right) {
  return validPoint(left) && validPoint(right) && almostEqual(left.x, right.x) && almostEqual(left.y, right.y);
}

function pointOnSegment(point, start, end) {
  const cross = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
  if (Math.abs(cross) > EPSILON) {
    return false;
  }

  return (
    point.x >= Math.min(start.x, end.x) - EPSILON &&
    point.x <= Math.max(start.x, end.x) + EPSILON &&
    point.y >= Math.min(start.y, end.y) - EPSILON &&
    point.y <= Math.max(start.y, end.y) + EPSILON
  );
}

function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) <= EPSILON) {
    return 0;
  }

  return value > 0 ? 1 : 2;
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }

  return (
    (o1 === 0 && pointOnSegment(c, a, b)) ||
    (o2 === 0 && pointOnSegment(d, a, b)) ||
    (o3 === 0 && pointOnSegment(a, c, d)) ||
    (o4 === 0 && pointOnSegment(b, c, d))
  );
}

function validPoint(point) {
  return (
    point &&
    typeof point === "object" &&
    !Array.isArray(point) &&
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    typeof point.y === "number" &&
    Number.isFinite(point.y)
  );
}

function polygonPoints(groupOrPoints) {
  return Array.isArray(groupOrPoints) ? groupOrPoints : groupOrPoints?.points;
}

function normalizedPolygonPoints(groupOrPoints) {
  const points = polygonPoints(groupOrPoints);
  if (!Array.isArray(points)) {
    return points;
  }

  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) {
    return points.slice(0, -1);
  }

  return points;
}

function ensurePolygon(group) {
  const points = normalizedPolygonPoints(group);
  if (!Array.isArray(points) || points.length < 3 || !points.every(validPoint) || polygonSelfIntersects(points)) {
    throw new Error("Invalid polygon.");
  }

  return points;
}

function bandForDistance(distancePx, bands) {
  return bands.find((band, index) => {
    const lastBand = index === bands.length - 1;
    return distancePx >= band.fromPx - EPSILON && (distancePx < band.toPx - EPSILON || (lastBand && distancePx <= band.toPx + EPSILON));
  });
}

function projectPointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared <= EPSILON) {
    const distancePx = Math.hypot(point.x - start.x, point.y - start.y);
    return {
      point: { x: start.x, y: start.y },
      distancePx,
      tangent: null,
    };
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const boundaryPoint = {
    x: start.x + t * dx,
    y: start.y + t * dy,
  };

  return {
    point: boundaryPoint,
    distancePx: Math.hypot(point.x - boundaryPoint.x, point.y - boundaryPoint.y),
    tangent: canonicalVector(normalizeVector({ x: dx, y: dy })),
  };
}

function outwardNormalFor(point, boundaryPoint, tangent, polygon) {
  const sampleVector = normalizeVector({
    x: point.x - boundaryPoint.x,
    y: point.y - boundaryPoint.y,
  });

  if (!tangent) {
    return sampleVector ?? { x: 0, y: 0 };
  }

  const candidates = [
    { x: -tangent.y, y: tangent.x },
    { x: tangent.y, y: -tangent.x },
  ];

  for (const candidate of candidates) {
    const probe = {
      x: boundaryPoint.x + candidate.x * 0.01,
      y: boundaryPoint.y + candidate.y * 0.01,
    };
    if (!pointInPolygon(probe, polygon)) {
      return cleanVector(candidate);
    }
  }

  return cleanVector(sampleVector ?? candidates[0]);
}

function sortedGroupTie(left, right) {
  return String(left).localeCompare(String(right));
}

function normalizeAnalysisPolygons(groups) {
  return Array.isArray(groups)
    ? groups
        .filter((group) => Array.isArray(group?.points) && group.points.length >= 3)
        .map((group) => ({ ...group, points: ensurePolygon(group) }))
    : [];
}

function validateImageDimensions(width, height) {
  if (!Number.isInteger(width) || width < 0 || !Number.isInteger(height) || height < 0) {
    throw new Error("Invalid image dimensions.");
  }
}

function maxBandDistance(bands) {
  return Math.max(...bands.map((band) => band.toPx));
}

function polygonBounds(points) {
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      maxX: Math.max(bounds.maxX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

function clampInteger(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function scanWindowsForPolygons(polygons, bands, width, height) {
  if (width === 0 || height === 0) {
    return [];
  }

  const maxDistancePx = maxBandDistance(bands);
  return polygons.map((group) => {
    const bounds = polygonBounds(group.points);
    return {
      groupId: group?.id ?? null,
      minX: clampInteger(Math.floor(bounds.minX - maxDistancePx), 0, width - 1),
      maxX: clampInteger(Math.ceil(bounds.maxX + maxDistancePx), 0, width - 1),
      minY: clampInteger(Math.floor(bounds.minY - maxDistancePx), 0, height - 1),
      maxY: clampInteger(Math.ceil(bounds.maxY + maxDistancePx), 0, height - 1),
    };
  });
}

function collectForegroundPixels(image, width, height) {
  const pixels = new Set();
  const data = image?.data ?? image;
  const resolvedWidth = width ?? image?.width;
  const resolvedHeight = height ?? image?.height;

  if (image instanceof Set) {
    for (const value of image) {
      if (typeof value === "string") {
        pixels.add(value);
      } else if (validPoint(value)) {
        pixels.add(keyFor(value.x, value.y));
      }
    }
    return pixels;
  }

  if (Array.isArray(data)) {
    if (data.every(validPoint)) {
      data.forEach((point) => pixels.add(keyFor(point.x, point.y)));
      return pixels;
    }

    if (resolvedWidth && resolvedHeight && data.length >= resolvedWidth * resolvedHeight) {
      for (let y = 0; y < resolvedHeight; y += 1) {
        for (let x = 0; x < resolvedWidth; x += 1) {
          if (data[y * resolvedWidth + x]) {
            pixels.add(keyFor(x, y));
          }
        }
      }
      return pixels;
    }
  }

  if (data && typeof data === "object" && resolvedWidth && resolvedHeight) {
    for (let y = 0; y < resolvedHeight; y += 1) {
      for (let x = 0; x < resolvedWidth; x += 1) {
        if (data[y * resolvedWidth + x]) {
          pixels.add(keyFor(x, y));
        }
      }
    }
  }

  return pixels;
}

function hasPixel(pixels, x, y) {
  return pixels.has(keyFor(x, y));
}

function skeletonNeighborKeys(point, pixels) {
  return SKELETON_NEIGHBOR_OFFSETS.flatMap(({ dx, dy }) => {
    const x = point.x + dx;
    const y = point.y + dy;
    if (!hasPixel(pixels, x, y)) {
      return [];
    }

    if (dx !== 0 && dy !== 0 && (hasPixel(pixels, point.x + dx, point.y) || hasPixel(pixels, point.x, point.y + dy))) {
      return [];
    }

    return [keyFor(x, y)];
  }).sort(comparePixelKeys);
}

function edgeKey(leftKey, rightKey) {
  return leftKey < rightKey ? `${leftKey}|${rightKey}` : `${rightKey}|${leftKey}`;
}

function buildNeighborMap(pixels) {
  return new Map([...pixels].sort(comparePixelKeys).map((key) => [key, skeletonNeighborKeys(parseKey(key), pixels)]));
}

function traceCenterlinePath(startKey, nextKey, neighborsByKey, visitedEdges) {
  const path = [parseKey(startKey)];
  let previousKey = startKey;
  let currentKey = nextKey;

  visitedEdges.add(edgeKey(previousKey, currentKey));

  while (true) {
    path.push(parseKey(currentKey));
    const neighbors = neighborsByKey.get(currentKey) ?? [];
    if (neighbors.length !== 2) {
      break;
    }

    const nextCandidates = neighbors.filter((neighborKey) => neighborKey !== previousKey);
    if (nextCandidates.length !== 1) {
      break;
    }

    const candidateKey = nextCandidates[0];
    const nextEdgeKey = edgeKey(currentKey, candidateKey);
    if (visitedEdges.has(nextEdgeKey)) {
      break;
    }

    visitedEdges.add(nextEdgeKey);
    previousKey = currentKey;
    currentKey = candidateKey;
  }

  return path;
}

function traceCenterlineCycle(startKey, nextKey, neighborsByKey, visitedEdges) {
  const path = [parseKey(startKey)];
  let previousKey = startKey;
  let currentKey = nextKey;

  visitedEdges.add(edgeKey(previousKey, currentKey));

  while (currentKey !== startKey) {
    path.push(parseKey(currentKey));
    const neighbors = neighborsByKey.get(currentKey) ?? [];
    const nextCandidates = neighbors.filter((neighborKey) => neighborKey !== previousKey);
    if (nextCandidates.length === 0) {
      break;
    }

    const candidateKey = nextCandidates[0];
    const nextEdgeKey = edgeKey(currentKey, candidateKey);
    if (visitedEdges.has(nextEdgeKey)) {
      break;
    }

    visitedEdges.add(nextEdgeKey);
    previousKey = currentKey;
    currentKey = candidateKey;
  }

  if (currentKey === startKey) {
    path.push(parseKey(startKey));
  }

  return path;
}

function buildCenterlinePaths(pixels) {
  const neighborsByKey = buildNeighborMap(pixels);
  const visitedEdges = new Set();
  const paths = [];
  const sortedKeys = [...pixels].sort(comparePixelKeys);

  for (const key of sortedKeys) {
    const neighbors = neighborsByKey.get(key) ?? [];
    if (neighbors.length === 0) {
      paths.push([parseKey(key)]);
      continue;
    }

    if (neighbors.length === 2) {
      continue;
    }

    for (const neighborKey of neighbors) {
      const nextEdgeKey = edgeKey(key, neighborKey);
      if (!visitedEdges.has(nextEdgeKey)) {
        paths.push(traceCenterlinePath(key, neighborKey, neighborsByKey, visitedEdges));
      }
    }
  }

  for (const key of sortedKeys) {
    const neighbors = neighborsByKey.get(key) ?? [];
    for (const neighborKey of neighbors) {
      const nextEdgeKey = edgeKey(key, neighborKey);
      if (!visitedEdges.has(nextEdgeKey)) {
        paths.push(traceCenterlineCycle(key, neighborKey, neighborsByKey, visitedEdges));
      }
    }
  }

  return { paths, neighborsByKey };
}

function pathDistances(path) {
  const distances = [0];
  for (let index = 1; index < path.length; index += 1) {
    distances.push(distances[index - 1] + distanceBetween(path[index - 1], path[index]));
  }

  return distances;
}

function pointAtPathDistance(path, distances, targetDistance) {
  if (targetDistance <= 0) {
    return path[0];
  }

  const totalDistance = distances[distances.length - 1] ?? 0;
  if (targetDistance >= totalDistance) {
    return path[path.length - 1];
  }

  for (let index = 1; index < distances.length; index += 1) {
    if (targetDistance <= distances[index] + EPSILON) {
      const start = path[index - 1];
      const end = path[index];
      const segmentDistance = distances[index] - distances[index - 1];
      const ratio = segmentDistance <= EPSILON ? 0 : (targetDistance - distances[index - 1]) / segmentDistance;
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      };
    }
  }

  return path[path.length - 1];
}

function assignmentNearPoint(point, assignments) {
  const xCandidates = [...new Set([Math.round(point.x), Math.floor(point.x), Math.ceil(point.x)])];
  const yCandidates = [...new Set([Math.round(point.y), Math.floor(point.y), Math.ceil(point.y)])];
  const candidates = [];

  for (const [yIndex, y] of yCandidates.entries()) {
    for (const [xIndex, x] of xCandidates.entries()) {
      const assignment = assignments?.get(keyFor(x, y));
      if (assignment) {
        candidates.push({ x, y, assignment, distancePx: Math.hypot(point.x - x, point.y - y), candidateIndex: yIndex * 3 + xIndex });
      }
    }
  }

  candidates.sort(
    (left, right) => left.distancePx - right.distancePx || left.candidateIndex - right.candidateIndex || left.y - right.y || left.x - right.x,
  );
  return candidates[0] ?? null;
}

function segmentLengthFor(sample) {
  const weight = sample?.segmentLengthPx ?? sample?.weight ?? 1;
  return typeof weight === "number" && Number.isFinite(weight) && weight > EPSILON ? weight : 1;
}

function emptyMetricValues({ roiAreaPx = 0, bandId = null } = {}) {
  return {
    bandId,
    roiAreaPx,
    maskPixelCount: 0,
    density: roiAreaPx > 0 ? 0 : null,
    globalAlignment: null,
    globalOrientationDeg: null,
    circularVariance: null,
    radialNormalAlignment: null,
    tangentialAlignment: null,
    migrationAlignment: null,
    orientationDispersion: null,
    empty: true,
  };
}

export function validateRoiBands(roiBands = DEFAULT_ROI_BANDS) {
  if (!Array.isArray(roiBands) || roiBands.length !== REQUIRED_BAND_IDS.length) {
    throw new Error("Invalid ROI bands.");
  }

  const normalized = roiBands.map((band, index) => {
    if (!band || typeof band !== "object" || Array.isArray(band)) {
      throw new Error("Invalid ROI bands.");
    }

    const expectedId = REQUIRED_BAND_IDS[index];
    if (band.id !== expectedId) {
      throw new Error("Invalid ROI bands.");
    }

    const label = band.label ?? DEFAULT_BAND_LABELS[expectedId];
    if (typeof label !== "string" || label.length === 0) {
      throw new Error("Invalid ROI bands.");
    }

    if (
      typeof band.fromPx !== "number" ||
      !Number.isFinite(band.fromPx) ||
      typeof band.toPx !== "number" ||
      !Number.isFinite(band.toPx) ||
      band.fromPx < 0 ||
      band.toPx <= band.fromPx
    ) {
      throw new Error("Invalid ROI bands.");
    }

    if (index === 0 && !almostEqual(band.fromPx, 0)) {
      throw new Error("Invalid ROI bands.");
    }

    if (index > 0 && !almostEqual(band.fromPx, roiBands[index - 1].toPx)) {
      throw new Error("Invalid ROI bands.");
    }

    return cloneBand({ ...band, label });
  });

  return normalized;
}

export function pointInPolygon(point, polygon) {
  const points = normalizedPolygonPoints(polygon);
  if (!validPoint(point) || !Array.isArray(points) || points.length < 3) {
    return false;
  }

  let inside = false;

  for (let index = 0, previousIndex = points.length - 1; index < points.length; previousIndex = index, index += 1) {
    const current = points[index];
    const previous = points[previousIndex];

    if (pointOnSegment(point, previous, current)) {
      return true;
    }

    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function pointOnPolygonBoundary(point, polygon) {
  const points = normalizedPolygonPoints(polygon);
  if (!validPoint(point) || !Array.isArray(points) || points.length < 3) {
    return false;
  }

  return points.some((start, index) => pointOnSegment(point, start, points[(index + 1) % points.length]));
}

function pointStrictlyInPolygon(point, polygon) {
  return pointInPolygon(point, polygon) && !pointOnPolygonBoundary(point, polygon);
}

export function polygonSelfIntersects(points) {
  const normalizedPoints = normalizedPolygonPoints(points);
  if (!Array.isArray(normalizedPoints) || normalizedPoints.length < 4) {
    return false;
  }

  for (let leftIndex = 0; leftIndex < normalizedPoints.length; leftIndex += 1) {
    const leftStart = normalizedPoints[leftIndex];
    const leftEnd = normalizedPoints[(leftIndex + 1) % normalizedPoints.length];

    for (let rightIndex = leftIndex + 1; rightIndex < normalizedPoints.length; rightIndex += 1) {
      const rightStart = normalizedPoints[rightIndex];
      const rightEnd = normalizedPoints[(rightIndex + 1) % normalizedPoints.length];
      const adjacent =
        rightIndex === leftIndex ||
        rightIndex === leftIndex + 1 ||
        (leftIndex === 0 && rightIndex === normalizedPoints.length - 1);

      if (!adjacent && segmentsIntersect(leftStart, leftEnd, rightStart, rightEnd)) {
        return true;
      }
    }
  }

  return false;
}

export function nearestBoundary(point, group) {
  const points = ensurePolygon(group);
  let nearest = null;

  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const projected = projectPointToSegment(point, start, end);

    if (!nearest || projected.distancePx < nearest.distancePx - EPSILON) {
      const outwardNormal = outwardNormalFor(point, projected.point, projected.tangent, points);
      nearest = {
        groupId: group?.id ?? null,
        distancePx: projected.distancePx,
        boundaryPoint: projected.point,
        tangent: projected.tangent ?? { x: 0, y: 0 },
        outwardNormal,
        segmentIndex: index,
      };
    }
  }

  return nearest;
}

export function roiScanWindows({ width, height, groups, roiBands } = {}) {
  const bands = validateRoiBands(roiBands);
  validateImageDimensions(width, height);
  return scanWindowsForPolygons(normalizeAnalysisPolygons(groups), bands, width, height);
}

export function visitOutwardRoiPixels({ width, height, groups, roiBands, visit } = {}) {
  const bands = validateRoiBands(roiBands);
  validateImageDimensions(width, height);
  if (typeof visit !== "function") {
    throw new TypeError("Outward ROI pixel visitor must be a function.");
  }

  const polygons = normalizeAnalysisPolygons(groups);
  const polygonById = new Map(polygons.map((group) => [group.id, group]));
  const bandsByGroupId = new Map(
    polygons.map((group) => [group.id, validateRoiBands(group.roiBands ?? bands)]),
  );
  if (polygons.length === 0) {
    return 0;
  }

  const windows = polygons.flatMap((group) =>
    scanWindowsForPolygons([group], bandsByGroupId.get(group.id) ?? bands, width, height),
  );
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (const [minX, maxX] of mergedScanlineIntervals(windows, y)) {
      for (let x = minX; x <= maxX; x += 1) {
        const pixel = { x, y };
        if (polygons.some((group) => pointStrictlyInPolygon(pixel, group.points))) {
          continue;
        }

        let nearest = null;
        for (const group of polygons) {
          const candidate = nearestBoundary(pixel, group);
          if (
            !nearest ||
            candidate.distancePx < nearest.distancePx - EPSILON ||
            (almostEqual(candidate.distancePx, nearest.distancePx) &&
              sortedGroupTie(candidate.groupId, nearest.groupId) < 0)
          ) {
            nearest = candidate;
          }
        }

        const band = nearest ? bandForDistance(nearest.distancePx, bandsByGroupId.get(nearest.groupId) ?? bands) : null;
        if (!band) {
          continue;
        }

        visit(x, y, {
          groupId: nearest.groupId,
          bandId: band.id,
          distancePx: nearest.distancePx,
          boundaryPoint: nearest.boundaryPoint,
          tangent: nearest.tangent,
          outwardNormal: nearest.outwardNormal,
          migrationVector: migrationVectorFor(polygonById.get(nearest.groupId)),
        });
        count += 1;
      }
    }
  }

  return count;
}

export function assignOutwardRoiPixels({ width, height, groups, roiBands } = {}) {
  const assignments = new Map();
  visitOutwardRoiPixels({
    width,
    height,
    groups,
    roiBands,
    visit: (x, y, assignment) => assignments.set(keyFor(x, y), assignment),
  });
  return assignments;
}

function mergedScanlineIntervals(windows, y) {
  const intervals = windows
    .filter((window) => y >= window.minY && y <= window.maxY)
    .map((window) => [window.minX, window.maxX])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];

  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (!previous || interval[0] > previous[1] + 1) {
      merged.push([...interval]);
    } else {
      previous[1] = Math.max(previous[1], interval[1]);
    }
  }
  return merged;
}

export function assignInsideRoiPixels({ width, height, groups } = {}) {
  validateImageDimensions(width, height);

  const polygons = normalizeAnalysisPolygons(groups);
  const assignments = new Map();

  if (polygons.length === 0 || width === 0 || height === 0) {
    return assignments;
  }

  for (const group of polygons) {
    const bounds = polygonBounds(group.points);
    const minX = clampInteger(Math.floor(bounds.minX), 0, width - 1);
    const maxX = clampInteger(Math.ceil(bounds.maxX), 0, width - 1);
    const minY = clampInteger(Math.floor(bounds.minY), 0, height - 1);
    const maxY = clampInteger(Math.ceil(bounds.maxY), 0, height - 1);

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const pixel = { x, y };
        if (!pointInPolygon(pixel, group.points)) {
          continue;
        }

        const pixelKey = keyFor(x, y);
        const existing = assignments.get(pixelKey);
        if (existing && sortedGroupTie(existing.groupId, group.id) <= 0) {
          continue;
        }

        assignments.set(pixelKey, {
          groupId: group?.id ?? null,
          bandId: "inside",
          migrationVector: migrationVectorFor(group),
        });
      }
    }
  }

  return assignments;
}

export function buildSkeletonSamples({ skeleton, width, height, assignments, segmentLengthPx = DEFAULT_SEGMENT_LENGTH_PX } = {}) {
  const pixels = collectForegroundPixels(skeleton, width, height);
  const samples = [];
  const resolvedSegmentLength =
    typeof segmentLengthPx === "number" && Number.isFinite(segmentLengthPx) && segmentLengthPx > EPSILON
      ? segmentLengthPx
      : DEFAULT_SEGMENT_LENGTH_PX;
  const { paths, neighborsByKey } = buildCenterlinePaths(pixels);

  for (const path of paths) {
    if (path.length === 1) {
      const point = path[0];
      const pointKey = keyFor(point.x, point.y);
      const assignment = assignments?.get(pointKey);
      if (!assignment) {
        continue;
      }

      samples.push({
        x: point.x,
        y: point.y,
        orientation: null,
        groupId: assignment.groupId,
        bandId: assignment.bandId,
        boundaryPoint: assignment.boundaryPoint,
        tangent: assignment.tangent,
        outwardNormal: assignment.outwardNormal,
        migrationVector: assignment.migrationVector,
        neighborCount: 0,
        segmentLengthPx: 0,
      });
      continue;
    }

    const distances = pathDistances(path);
    const totalLength = distances[distances.length - 1] ?? 0;
    if (totalLength <= EPSILON) {
      continue;
    }

    for (let startDistance = 0; startDistance < totalLength - EPSILON; startDistance += resolvedSegmentLength) {
      const endDistance = Math.min(startDistance + resolvedSegmentLength, totalLength);
      const segmentLength = endDistance - startDistance;
      if (segmentLength <= EPSILON) {
        continue;
      }

      const segmentStart = pointAtPathDistance(path, distances, startDistance);
      const segmentEnd = pointAtPathDistance(path, distances, endDistance);
      const midpoint = pointAtPathDistance(path, distances, startDistance + segmentLength / 2);
      const assignmentCandidate = assignmentNearPoint(midpoint, assignments);
      if (!assignmentCandidate) {
        continue;
      }

      const orientation = canonicalVector(
        normalizeVector({
          x: segmentEnd.x - segmentStart.x,
          y: segmentEnd.y - segmentStart.y,
        }),
      );
      const assignment = assignmentCandidate.assignment;
      const representativeKey = keyFor(assignmentCandidate.x, assignmentCandidate.y);
      const neighborCount = neighborsByKey.get(representativeKey)?.length ?? null;

      samples.push({
        x: assignmentCandidate.x,
        y: assignmentCandidate.y,
        orientation,
        groupId: assignment.groupId,
        bandId: assignment.bandId,
        boundaryPoint: assignment.boundaryPoint,
        tangent: assignment.tangent,
        outwardNormal: assignment.outwardNormal,
        migrationVector: assignment.migrationVector,
        neighborCount,
        segmentStart: cleanPoint(segmentStart),
        segmentEnd: cleanPoint(segmentEnd),
        segmentLengthPx: cleanNumber(segmentLength),
      });
    }
  }

  return samples;
}

export function buildMaskSamples({ mask, width, height, assignments } = {}) {
  const pixels = collectForegroundPixels(mask, width, height);
  const samples = [];

  for (const key of pixels) {
    const assignment = assignments?.get(key);
    if (!assignment) {
      continue;
    }

    const { x, y } = parseKey(key);
    samples.push({
      x,
      y,
      groupId: assignment.groupId,
      bandId: assignment.bandId,
    });
  }

  return samples;
}

export function createEmptyBandMetrics(options = {}) {
  return emptyMetricValues(options);
}

export function aggregateRoiMetrics({ assignments, maskSamples, skeletonSamples, bandIds = REQUIRED_BAND_IDS } = {}) {
  const assignmentList = [...(assignments?.values?.() ?? [])];
  const maskSampleList = Array.isArray(maskSamples) ? maskSamples : [];
  const skeletonSampleList = Array.isArray(skeletonSamples) ? skeletonSamples : [];
  const metricBandIds = Array.isArray(bandIds) ? bandIds : REQUIRED_BAND_IDS;
  const bandArea = new Map(metricBandIds.map((bandId) => [bandId, 0]));
  const maskByBand = new Map(metricBandIds.map((bandId) => [bandId, []]));
  const skeletonByBand = new Map(metricBandIds.map((bandId) => [bandId, []]));

  for (const assignment of assignmentList) {
    bandArea.set(assignment.bandId, (bandArea.get(assignment.bandId) ?? 0) + 1);
  }

  for (const sample of maskSampleList) {
    if (!maskByBand.has(sample.bandId)) {
      maskByBand.set(sample.bandId, []);
    }
    maskByBand.get(sample.bandId).push(sample);
  }

  for (const sample of skeletonSampleList) {
    if (!skeletonByBand.has(sample.bandId)) {
      skeletonByBand.set(sample.bandId, []);
    }
    skeletonByBand.get(sample.bandId).push(sample);
  }

  function metricsFor(nextMaskSamples, nextSkeletonSamples, roiAreaPx, bandId = null) {
    const maskPixelSet = new Set(nextMaskSamples.map((sample) => keyFor(sample.x, sample.y)));
    const maskPixelCount = maskPixelSet.size;
    const orientedSamples = nextSkeletonSamples.filter((sample) => sample.orientation);
    let cos2 = 0;
    let sin2 = 0;
    let radial = 0;
    let tangential = 0;
    let migration = 0;
    let totalOrientationWeight = 0;
    let radialSampleWeight = 0;
    let tangentialSampleWeight = 0;
    let migrationSampleWeight = 0;

    for (const sample of orientedSamples) {
      const weight = segmentLengthFor(sample);
      const angle = Math.atan2(sample.orientation.y, sample.orientation.x);
      cos2 += Math.cos(2 * angle) * weight;
      sin2 += Math.sin(2 * angle) * weight;
      totalOrientationWeight += weight;
      if (sample.outwardNormal) {
        const radialAlignment = targetAngleAlignment(sample.orientation, sample.outwardNormal);
        if (radialAlignment !== null) {
          radial += radialAlignment * weight;
          radialSampleWeight += weight;
        }
      }
      if (sample.tangent) {
        const tangentialAlignment = targetAngleAlignment(sample.orientation, sample.tangent);
        if (tangentialAlignment !== null) {
          tangential += tangentialAlignment * weight;
          tangentialSampleWeight += weight;
        }
      }
      if (sample.migrationVector) {
        const nextMigrationAlignment = targetAngleAlignment(sample.orientation, sample.migrationVector);
        if (nextMigrationAlignment !== null) {
          migration += nextMigrationAlignment * weight;
          migrationSampleWeight += weight;
        }
      }
    }

    const doubledMagnitude = Math.hypot(cos2, sin2);
    const globalAlignment = totalOrientationWeight > 0 ? doubledMagnitude / totalOrientationWeight : null;
    const meanAngle = totalOrientationWeight > 0 ? 0.5 * Math.atan2(sin2, cos2) : null;
    const circularVariance = globalAlignment === null ? null : 1 - globalAlignment;

    return {
      bandId,
      roiAreaPx,
      maskPixelCount,
      density: roiAreaPx > 0 ? maskPixelCount / roiAreaPx : null,
      globalAlignment,
      globalOrientationDeg: meanAngle === null ? null : canonicalUndirectedAngle(meanAngle),
      circularVariance,
      radialNormalAlignment: radialSampleWeight > 0 ? radial / radialSampleWeight : null,
      tangentialAlignment: tangentialSampleWeight > 0 ? tangential / tangentialSampleWeight : null,
      migrationAlignment: migrationSampleWeight > 0 ? migration / migrationSampleWeight : null,
      orientationDispersion: circularVariance,
      empty: maskPixelCount === 0 && nextSkeletonSamples.length === 0,
    };
  }

  return {
    overall: metricsFor(maskSampleList, skeletonSampleList, assignmentList.length),
    bands: Object.fromEntries(
      metricBandIds.map((bandId) => [
        bandId,
        metricsFor(maskByBand.get(bandId) ?? [], skeletonByBand.get(bandId) ?? [], bandArea.get(bandId) ?? 0, bandId),
      ]),
    ),
  };
}
