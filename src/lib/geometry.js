export function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distanceSquaredToSegment(point, startPoint, endPoint) {
  const segmentDx = endPoint.x - startPoint.x;
  const segmentDy = endPoint.y - startPoint.y;
  const segmentLengthSquared = segmentDx * segmentDx + segmentDy * segmentDy;

  if (segmentLengthSquared === 0) {
    return distanceSquared(point, startPoint);
  }

  const projection =
    ((point.x - startPoint.x) * segmentDx + (point.y - startPoint.y) * segmentDy) /
    segmentLengthSquared;
  const t = clamp(projection, 0, 1);
  const closestPoint = {
    x: startPoint.x + t * segmentDx,
    y: startPoint.y + t * segmentDy,
  };

  return distanceSquared(point, closestPoint);
}

export function findNearestPoint(groups, activeGroupId, pointer) {
  if (!pointer) {
    return null;
  }

  const group = groups.find((candidate) => candidate.id === activeGroupId);
  if (!group || group.points.length === 0) {
    return null;
  }

  let nearestPoint = group.points[0];
  let nearestIndex = 0;
  let nearestDistance = distanceSquared(pointer, nearestPoint);

  for (let index = 1; index < group.points.length; index += 1) {
    const point = group.points[index];
    const pointDistance = distanceSquared(pointer, point);

    if (
      pointDistance < nearestDistance ||
      (pointDistance === nearestDistance && point.id < nearestPoint.id)
    ) {
      nearestPoint = point;
      nearestIndex = index;
      nearestDistance = pointDistance;
    }
  }

  return {
    groupId: group.id,
    point: nearestPoint,
    pointIndex: nearestIndex,
    distanceSquared: nearestDistance,
  };
}

export function findNearestSegment(points, pointer, maxDistanceSquared = Number.POSITIVE_INFINITY) {
  if (!pointer || points.length < 2) {
    return null;
  }

  const segmentCount = points.length === 2 ? 1 : points.length;
  let nearestSegment = null;

  for (let startIndex = 0; startIndex < segmentCount; startIndex += 1) {
    const endIndex = (startIndex + 1) % points.length;
    const startPoint = points[startIndex];
    const endPoint = points[endIndex];
    const segmentDistanceSquared = distanceSquaredToSegment(pointer, startPoint, endPoint);

    if (
      segmentDistanceSquared <= maxDistanceSquared &&
      (!nearestSegment || segmentDistanceSquared < nearestSegment.distanceSquared)
    ) {
      nearestSegment = {
        startPoint,
        endPoint,
        startIndex,
        endIndex,
        insertIndex: startIndex + 1,
        distanceSquared: segmentDistanceSquared,
      };
    }
  }

  return nearestSegment;
}

export function clampPointToBounds(point, width, height) {
  return {
    ...point,
    x: clamp(point.x, 0, maxCoordinate(width)),
    y: clamp(point.y, 0, maxCoordinate(height)),
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function maxCoordinate(size) {
  return Number.isFinite(size) && size > 0 ? size - 1 : 0;
}
