import { describe, expect, test } from "vitest";

import {
  clampPointToBounds,
  findNearestSegment,
  findNearestPoint,
} from "./geometry.js";

describe("geometry", () => {
  test("finds nearest point across active group points", () => {
    const groups = [
      {
        id: "inactive",
        points: [{ id: "too-close", x: 4, y: 4 }],
      },
      {
        id: "active",
        points: [
          { id: "far", x: 0, y: 0 },
          { id: "near", x: 8, y: 5 },
        ],
      },
    ];

    const nearest = findNearestPoint(groups, "active", { x: 6, y: 5 });

    expect(nearest).toEqual({
      groupId: "active",
      point: { id: "near", x: 8, y: 5 },
      pointIndex: 1,
      distanceSquared: 4,
    });
  });

  test("finds the nearest ordered polygon segment for insertion", () => {
    const points = [
      { id: "point-1", x: 0, y: 0 },
      { id: "point-2", x: 10, y: 0 },
      { id: "point-3", x: 10, y: 10 },
    ];

    const nearest = findNearestSegment(points, { x: 5, y: 1 }, 4);

    expect(nearest).toEqual({
      startPoint: points[0],
      endPoint: points[1],
      startIndex: 0,
      endIndex: 1,
      insertIndex: 1,
      distanceSquared: 1,
    });
  });

  test("uses the closing segment from the last point back to the first", () => {
    const points = [
      { id: "point-1", x: 0, y: 0 },
      { id: "point-2", x: 10, y: 0 },
      { id: "point-3", x: 10, y: 10 },
    ];

    const nearest = findNearestSegment(points, { x: 4, y: 5 }, 4);

    expect(nearest).toMatchObject({
      startPoint: points[2],
      endPoint: points[0],
      startIndex: 2,
      endIndex: 0,
      insertIndex: 3,
      distanceSquared: 0.5,
    });
  });

  test("ignores distant segments outside the insertion threshold", () => {
    const points = [
      { id: "point-1", x: 0, y: 0 },
      { id: "point-2", x: 10, y: 0 },
      { id: "point-3", x: 10, y: 10 },
    ];

    expect(findNearestSegment(points, { x: 5, y: 9 }, 4)).toBeNull();
    expect(findNearestSegment([points[0]], { x: 0, y: 0 }, 4)).toBeNull();
  });

  test("breaks nearest point ties by point id", () => {
    const groups = [
      {
        id: "active",
        points: [
          { id: "point-z", x: 1, y: 0 },
          { id: "point-a", x: -1, y: 0 },
        ],
      },
    ];

    const nearest = findNearestPoint(groups, "active", { x: 0, y: 0 });

    expect(nearest).toEqual({
      groupId: "active",
      point: { id: "point-a", x: -1, y: 0 },
      pointIndex: 1,
      distanceSquared: 1,
    });
  });

  test("returns null without a pointer, group, or points", () => {
    expect(findNearestPoint([], "missing", { x: 0, y: 0 })).toBeNull();
    expect(
      findNearestPoint([{ id: "active", points: [] }], "active", { x: 0, y: 0 }),
    ).toBeNull();
    expect(
      findNearestPoint(
        [{ id: "active", points: [{ id: "point-1", x: 0, y: 0 }] }],
        "active",
        null,
      ),
    ).toBeNull();
  });

  test("clamps invalid dimensions without producing negative coordinates", () => {
    expect(clampPointToBounds({ id: "point-1", x: 4, y: 6 }, 0, 0)).toEqual({
      id: "point-1",
      x: 0,
      y: 0,
    });
    expect(
      clampPointToBounds({ id: "point-2", x: 4, y: 6 }, undefined, Number.NaN),
    ).toEqual({
      id: "point-2",
      x: 0,
      y: 0,
    });
  });
});
