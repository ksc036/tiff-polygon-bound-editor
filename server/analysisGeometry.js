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

function emptyMetricValues({ roiAreaPx = 0, bandId = null } = {}) {
  return {
    bandId,
    roiAreaPx,
    maskPixelCount: 0,
    density: roiAreaPx > 0 ? 0 : null,
    globalAlignment: null,
    globalOrientationDeg: null,
    radialNormalAlignment: null,
    tangentialAlignment: null,
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

export function assignOutwardRoiPixels({ width, height, groups, roiBands } = {}) {
  const bands = validateRoiBands(roiBands);
  validateImageDimensions(width, height);

  const polygons = normalizeAnalysisPolygons(groups);
  const assignments = new Map();

  if (polygons.length === 0) {
    return assignments;
  }

  const visitedPixels = new Set();
  for (const window of scanWindowsForPolygons(polygons, bands, width, height)) {
    for (let y = window.minY; y <= window.maxY; y += 1) {
      for (let x = window.minX; x <= window.maxX; x += 1) {
        const pixelKey = keyFor(x, y);
        if (visitedPixels.has(pixelKey)) {
          continue;
        }
        visitedPixels.add(pixelKey);

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

        const band = nearest ? bandForDistance(nearest.distancePx, bands) : null;
        if (!band) {
          continue;
        }

        assignments.set(pixelKey, {
          groupId: nearest.groupId,
          bandId: band.id,
          distancePx: nearest.distancePx,
          boundaryPoint: nearest.boundaryPoint,
          tangent: nearest.tangent,
          outwardNormal: nearest.outwardNormal,
        });
      }
    }
  }

  return assignments;
}

export function buildSkeletonSamples({ skeleton, width, height, assignments } = {}) {
  const pixels = collectForegroundPixels(skeleton, width, height);
  const samples = [];

  for (const key of pixels) {
    const assignment = assignments?.get(key);
    if (!assignment) {
      continue;
    }

    const { x, y } = parseKey(key);
    let cos2 = 0;
    let sin2 = 0;
    let neighborCount = 0;

    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) {
          continue;
        }

        if (pixels.has(keyFor(x + dx, y + dy))) {
          const angle = Math.atan2(dy, dx);
          cos2 += Math.cos(2 * angle);
          sin2 += Math.sin(2 * angle);
          neighborCount += 1;
        }
      }
    }

    const orientationAngle = neighborCount === 0 ? null : 0.5 * Math.atan2(sin2, cos2);
    const orientation = orientationAngle === null ? null : canonicalVector({ x: Math.cos(orientationAngle), y: Math.sin(orientationAngle) });

    samples.push({
      x,
      y,
      orientation,
      groupId: assignment.groupId,
      bandId: assignment.bandId,
      boundaryPoint: assignment.boundaryPoint,
      tangent: assignment.tangent,
      outwardNormal: assignment.outwardNormal,
      neighborCount,
    });
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

export function aggregateRoiMetrics({ assignments, maskSamples, skeletonSamples } = {}) {
  const assignmentList = [...(assignments?.values?.() ?? [])];
  const maskSampleList = Array.isArray(maskSamples) ? maskSamples : [];
  const skeletonSampleList = Array.isArray(skeletonSamples) ? skeletonSamples : [];
  const bandArea = new Map(REQUIRED_BAND_IDS.map((bandId) => [bandId, 0]));
  const maskByBand = new Map(REQUIRED_BAND_IDS.map((bandId) => [bandId, []]));
  const skeletonByBand = new Map(REQUIRED_BAND_IDS.map((bandId) => [bandId, []]));

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

    for (const sample of orientedSamples) {
      const angle = Math.atan2(sample.orientation.y, sample.orientation.x);
      cos2 += Math.cos(2 * angle);
      sin2 += Math.sin(2 * angle);
      radial += Math.abs(dot(sample.orientation, sample.outwardNormal));
      tangential += Math.abs(dot(sample.orientation, sample.tangent));
    }

    const doubledMagnitude = Math.hypot(cos2, sin2);
    const globalAlignment = orientedSamples.length > 0 ? doubledMagnitude / orientedSamples.length : null;
    const meanAngle = orientedSamples.length > 0 ? 0.5 * Math.atan2(sin2, cos2) : null;

    return {
      bandId,
      roiAreaPx,
      maskPixelCount,
      density: roiAreaPx > 0 ? maskPixelCount / roiAreaPx : null,
      globalAlignment,
      globalOrientationDeg: meanAngle === null ? null : canonicalUndirectedAngle(meanAngle),
      radialNormalAlignment: orientedSamples.length > 0 ? radial / orientedSamples.length : null,
      tangentialAlignment: orientedSamples.length > 0 ? tangential / orientedSamples.length : null,
      orientationDispersion: globalAlignment === null ? null : 1 - globalAlignment,
      empty: maskPixelCount === 0 && nextSkeletonSamples.length === 0,
    };
  }

  return {
    overall: metricsFor(maskSampleList, skeletonSampleList, assignmentList.length),
    bands: Object.fromEntries(
      REQUIRED_BAND_IDS.map((bandId) => [
        bandId,
        metricsFor(maskByBand.get(bandId) ?? [], skeletonByBand.get(bandId) ?? [], bandArea.get(bandId) ?? 0, bandId),
      ]),
    ),
  };
}
