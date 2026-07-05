import { clampPointToBounds, findNearestPoint } from "./geometry.js";

const GROUP_COLORS = ["#e11d48", "#2563eb", "#16a34a", "#ca8a04", "#9333ea"];

export function createEmptyBounds(image) {
  return {
    schemaVersion: 1,
    imageFolder: image.imageFolder ?? image.folder ?? "",
    imageFile: image.imageFile ?? image.file ?? "",
    width: image.width,
    height: image.height,
    connectionMode: "input-order-cycle",
    groups: [],
    updatedAt: null,
  };
}

export function addGroup(bounds) {
  const groupNumber = nextNumber(bounds.groups, "group-");

  return {
    ...bounds,
    groups: [
      ...bounds.groups,
      {
        id: `group-${groupNumber}`,
        name: `Group ${groupNumber}`,
        color: GROUP_COLORS[(groupNumber - 1) % GROUP_COLORS.length],
        points: [],
      },
    ],
  };
}

export function renameGroup(bounds, groupId, name) {
  return {
    ...bounds,
    groups: bounds.groups.map((group) =>
      group.id === groupId ? { ...group, name } : group,
    ),
  };
}

export function deleteGroup(bounds, groupId) {
  return {
    ...bounds,
    groups: bounds.groups.filter((group) => group.id !== groupId),
  };
}

export function addPoint(bounds, groupId, point, options = {}) {
  const group = bounds.groups.find((candidate) => candidate.id === groupId);
  if (!group) {
    return bounds;
  }

  const pointNumber = nextNumber(group.points, "point-");
  const nextPoint = { id: `point-${pointNumber}`, x: point.x, y: point.y };
  const insertIndex = normalizeInsertIndex(options.insertIndex, group.points.length);
  const nextPoints = [...group.points];
  nextPoints.splice(insertIndex, 0, nextPoint);

  return {
    ...bounds,
    groups: bounds.groups.map((candidate) =>
      candidate.id === groupId
        ? {
            ...candidate,
            points: nextPoints,
          }
        : candidate,
    ),
  };
}

export function deleteNearestPoint(bounds, groupId, pointer) {
  const nearest = findNearestPoint(bounds.groups, groupId, pointer);
  if (!nearest) {
    return bounds;
  }

  return {
    ...bounds,
    groups: bounds.groups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            points: group.points.filter((_, index) => index !== nearest.pointIndex),
          }
        : group,
    ),
  };
}

export function moveNearestPoint(bounds, groupId, pointer) {
  const nearest = findNearestPoint(bounds.groups, groupId, pointer);
  if (!nearest) {
    return bounds;
  }

  return movePoint(bounds, groupId, nearest.point.id, pointer);
}

export function movePoint(bounds, groupId, pointId, pointer) {
  if (!pointer) {
    return bounds;
  }

  const group = bounds.groups.find((candidate) => candidate.id === groupId);
  if (!group || !group.points.some((point) => point.id === pointId)) {
    return bounds;
  }

  return {
    ...bounds,
    groups: bounds.groups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            points: group.points.map((point) =>
              point.id === pointId
                ? { ...point, x: pointer.x, y: pointer.y }
                : point,
            ),
          }
        : group,
    ),
  };
}

export function movePointOrder(bounds, groupId, pointId, direction) {
  const group = bounds.groups.find((candidate) => candidate.id === groupId);
  if (!group) {
    return bounds;
  }

  const currentIndex = group.points.findIndex((point) => point.id === pointId);
  const targetIndex =
    direction === "left" ? currentIndex - 1 : direction === "right" ? currentIndex + 1 : currentIndex;

  if (
    currentIndex < 0 ||
    targetIndex < 0 ||
    targetIndex >= group.points.length ||
    targetIndex === currentIndex
  ) {
    return bounds;
  }

  const nextPoints = [...group.points];
  [nextPoints[currentIndex], nextPoints[targetIndex]] = [
    nextPoints[targetIndex],
    nextPoints[currentIndex],
  ];

  return {
    ...bounds,
    groups: bounds.groups.map((candidate) =>
      candidate.id === groupId ? { ...candidate, points: nextPoints } : candidate,
    ),
  };
}

export function clampBoundsToImage(bounds, width, height) {
  return {
    ...bounds,
    width,
    height,
    groups: bounds.groups.map((group) => ({
      ...group,
      points: group.points.map((point) => clampPointToBounds(point, width, height)),
    })),
  };
}

function nextNumber(items, prefix) {
  const highest = items.reduce((max, item) => {
    if (!item.id.startsWith(prefix)) {
      return max;
    }

    const number = Number(item.id.slice(prefix.length));
    return Number.isInteger(number) && number > max ? number : max;
  }, 0);

  return highest + 1;
}

function normalizeInsertIndex(insertIndex, length) {
  if (!Number.isInteger(insertIndex)) {
    return length;
  }

  return Math.min(Math.max(insertIndex, 0), length);
}
