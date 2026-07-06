import { describe, expect, test } from "vitest";

import {
  aggregateSkeletonMetrics,
  assignOutwardRoiPixels,
  buildSkeletonSamples,
  countSkeletonTopology,
  polygonSelfIntersects,
  roiScanWindows,
  validateRoiBands,
} from "./analysisGeometry.js";

const defaultBands = [
  { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
  { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
  { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
];

function expectInvalidBands(payload) {
  expect(() => validateRoiBands(payload)).toThrow(/roi bands/i);
}

function square(id, minX, minY, maxX, maxY) {
  return {
    id,
    points: [
      { id: `${id}-1`, x: minX, y: minY },
      { id: `${id}-2`, x: maxX, y: minY },
      { id: `${id}-3`, x: maxX, y: maxY },
      { id: `${id}-4`, x: minX, y: maxY },
    ],
  };
}

describe("analysis geometry", () => {
  test("validateRoiBands accepts default contiguous bands and rejects invalid payloads", () => {
    expect(validateRoiBands()).toEqual(defaultBands);
    expect(validateRoiBands(defaultBands)).toEqual(defaultBands);
    expect(
      validateRoiBands([
        { id: "near", fromPx: 0, toPx: 20 },
        { id: "mid", fromPx: 20, toPx: 50 },
        { id: "far", fromPx: 50, toPx: 100 },
      ]),
    ).toEqual(defaultBands);

    expectInvalidBands([]);
    expectInvalidBands([
      { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
      { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
    ]);
    expectInvalidBands([
      { id: "near", label: "가까움", minPx: 0, maxPx: 20 },
      { id: "mid", label: "중간", minPx: 20, maxPx: 50 },
      { id: "far", label: "멀리", minPx: 50, maxPx: 100 },
    ]);
    expectInvalidBands([
      { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
      { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
      { id: "far", label: "멀리", fromPx: 50 },
    ]);
    expectInvalidBands([
      { id: "near", label: "가까움", fromPx: -1, toPx: 20 },
      { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
      { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
    ]);
    expectInvalidBands([
      { id: "near", label: "가까움", fromPx: 0, toPx: Number.POSITIVE_INFINITY },
      { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
      { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
    ]);
    expectInvalidBands([
      { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
      { id: "mid", label: "중간", fromPx: 21, toPx: 50 },
      { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
    ]);
    expectInvalidBands([
      { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
      { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
      { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
    ]);
  });

  test("assignOutwardRoiPixels excludes interiors and assigns each outside pixel to one nearest group and band", () => {
    const groups = [square("left", 1, 1, 3, 3), square("right", 6, 1, 8, 3)];
    const roiBands = [
      { id: "near", label: "가까움", fromPx: 0, toPx: 1.1 },
      { id: "mid", label: "중간", fromPx: 1.1, toPx: 3 },
      { id: "far", label: "멀리", fromPx: 3, toPx: 4 },
    ];

    const assignments = assignOutwardRoiPixels({ width: 10, height: 5, groups, roiBands });

    expect(assignments.has("2,2")).toBe(false);
    expect(assignments.has("7,2")).toBe(false);
    expect(assignments.get("0,2")).toMatchObject({
      groupId: "left",
      bandId: "near",
      distancePx: 1,
      boundaryPoint: { x: 1, y: 2 },
      tangent: { x: 0, y: 1 },
      outwardNormal: { x: -1, y: 0 },
    });
    expect(assignments.get("4,2")).toMatchObject({
      groupId: "left",
      bandId: "near",
    });
    expect(assignments.get("5,2")).toMatchObject({
      groupId: "right",
      bandId: "near",
    });
    expect(assignments.get("0,0")).toMatchObject({
      groupId: "left",
      bandId: "mid",
    });
    expect(assignments.get("9,4")).toMatchObject({
      groupId: "right",
      bandId: "mid",
    });
    expect(assignments.size).toBe(new Set(assignments.keys()).size);
  });

  test("assignOutwardRoiPixels assigns polygon boundary pixels to the near band at distance zero", () => {
    const assignments = assignOutwardRoiPixels({
      width: 5,
      height: 5,
      groups: [square("cell", 1, 1, 3, 3)],
      roiBands: [
        { id: "near", label: "가까움", fromPx: 0, toPx: 1 },
        { id: "mid", label: "중간", fromPx: 1, toPx: 2 },
        { id: "far", label: "멀리", fromPx: 2, toPx: 3 },
      ],
    });

    expect(assignments.get("2,1")).toMatchObject({
      groupId: "cell",
      bandId: "near",
      distancePx: 0,
      boundaryPoint: { x: 2, y: 1 },
    });
    expect(assignments.has("2,2")).toBe(false);
  });

  test("roiScanWindows expands each polygon by the max ROI distance", () => {
    expect(
      roiScanWindows({
        width: 100,
        height: 100,
        groups: [square("cell", 40, 40, 45, 45)],
        roiBands: [
          { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
          { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
          { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
        ],
      }),
    ).toEqual([{ groupId: "cell", minX: 34, maxX: 51, minY: 34, maxY: 51 }]);
  });

  test("assignOutwardRoiPixels preserves assignments when using max-distance scan windows", () => {
    const assignments = assignOutwardRoiPixels({
      width: 100,
      height: 100,
      groups: [square("cell", 40, 40, 45, 45)],
      roiBands: [
        { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
        { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
        { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
      ],
    });

    expect(assignments.has("0,0")).toBe(false);
    expect(assignments.get("39,42")).toMatchObject({ groupId: "cell", bandId: "near" });
    expect(assignments.get("34,42")).toMatchObject({ groupId: "cell", bandId: "far" });
  });

  test("polygonSelfIntersects detects bow-tie self intersections", () => {
    expect(
      polygonSelfIntersects([
        { x: 0, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
        { x: 4, y: 0 },
      ]),
    ).toBe(true);

    expect(
      polygonSelfIntersects([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ]),
    ).toBe(false);
  });

  test("polygonSelfIntersects accepts duplicate closing points and assignment normalizes them", () => {
    const closedSquare = {
      id: "closed",
      points: [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
        { x: 3, y: 3 },
        { x: 1, y: 3 },
        { x: 1, y: 1 },
      ],
    };

    expect(polygonSelfIntersects(closedSquare.points)).toBe(false);

    const assignments = assignOutwardRoiPixels({
      width: 5,
      height: 5,
      groups: [closedSquare],
      roiBands: [
        { id: "near", label: "가까움", fromPx: 0, toPx: 1 },
        { id: "mid", label: "중간", fromPx: 1, toPx: 2 },
        { id: "far", label: "멀리", fromPx: 2, toPx: 3 },
      ],
    });

    expect(assignments.get("2,1")).toMatchObject({
      groupId: "closed",
      bandId: "near",
      distancePx: 0,
    });
  });

  test("countSkeletonTopology counts endpoints and branchpoints from 8-neighborhood skeleton pixels", () => {
    const pixels = new Set(["3,2", "3,3", "2,4", "4,4"]);

    expect(countSkeletonTopology(pixels)).toEqual({
      endpointCount: 3,
      branchpointCount: 1,
    });
  });

  test("aggregateSkeletonMetrics distinguishes radial and tangential skeletons and computes shared metrics", () => {
    const group = square("cell", 4, 3, 6, 7);
    const roiBands = [
      { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
      { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
      { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
    ];
    const assignments = assignOutwardRoiPixels({ width: 11, height: 11, groups: [group], roiBands });
    const radialSkeleton = new Set(["5,0", "5,1", "5,2"]);
    const tangentialSkeleton = new Set(["3,4", "3,5", "3,6"]);

    const radialMetrics = aggregateSkeletonMetrics({
      assignments,
      samples: buildSkeletonSamples({ skeleton: radialSkeleton, width: 11, height: 11, assignments }),
    });
    const tangentialMetrics = aggregateSkeletonMetrics({
      assignments,
      samples: buildSkeletonSamples({ skeleton: tangentialSkeleton, width: 11, height: 11, assignments }),
    });

    expect(radialMetrics.overall.roiAreaPx).toBe(assignments.size);
    expect(radialMetrics.overall.skeletonPixelCount).toBe(3);
    expect(radialMetrics.overall.skeletonLengthPx).toBeCloseTo(2);
    expect(radialMetrics.overall.density).toBeCloseTo(2 / assignments.size);
    expect(radialMetrics.overall.coverage).toBeCloseTo(3 / assignments.size);
    expect(radialMetrics.overall.globalAlignment).toBeCloseTo(1);
    expect(radialMetrics.overall.globalOrientationDeg).toBeCloseTo(90);
    expect(radialMetrics.overall.radialNormalAlignment).toBeGreaterThan(0.95);
    expect(radialMetrics.overall.tangentialAlignment).toBeLessThan(0.1);
    expect(radialMetrics.overall.empty).toBe(false);

    expect(tangentialMetrics.overall.globalAlignment).toBeCloseTo(1);
    expect(tangentialMetrics.overall.globalOrientationDeg).toBeCloseTo(90);
    expect(tangentialMetrics.overall.radialNormalAlignment).toBeLessThan(0.1);
    expect(tangentialMetrics.overall.tangentialAlignment).toBeGreaterThan(0.95);
  });

  test("aggregateSkeletonMetrics allocates cross-band skeleton edges to both endpoint bands", () => {
    const group = square("cell", 4, 3, 6, 7);
    const roiBands = [
      { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
      { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
      { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
    ];
    const assignments = assignOutwardRoiPixels({ width: 11, height: 11, groups: [group], roiBands });
    const samples = buildSkeletonSamples({ skeleton: new Set(["5,1", "5,2", "5,3"]), width: 11, height: 11, assignments });

    expect(samples.map((sample) => [sample.x, sample.y, sample.bandId])).toEqual([
      [5, 1, "mid"],
      [5, 2, "near"],
      [5, 3, "near"],
    ]);

    const metrics = aggregateSkeletonMetrics({ assignments, samples });

    expect(metrics.overall.skeletonLengthPx).toBeCloseTo(2);
    expect(metrics.bands.near.skeletonLengthPx).toBeCloseTo(1.5);
    expect(metrics.bands.mid.skeletonLengthPx).toBeCloseTo(0.5);
    expect(metrics.bands.far.skeletonLengthPx).toBeNull();
    expect(metrics.bands.near.skeletonLengthPx + metrics.bands.mid.skeletonLengthPx).toBeCloseTo(
      metrics.overall.skeletonLengthPx,
    );
  });

  test("aggregateSkeletonMetrics counts isolated assigned skeleton pixels without fabricating orientation metrics", () => {
    const group = square("cell", 4, 3, 6, 7);
    const roiBands = [
      { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
      { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
      { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
    ];
    const assignments = assignOutwardRoiPixels({ width: 11, height: 11, groups: [group], roiBands });
    const samples = buildSkeletonSamples({ skeleton: new Set(["5,0"]), width: 11, height: 11, assignments });
    const metrics = aggregateSkeletonMetrics({ assignments, samples });

    expect(samples).toEqual([
      expect.objectContaining({
        x: 5,
        y: 0,
        orientation: null,
        neighborCount: 0,
      }),
    ]);
    expect(metrics.overall.roiAreaPx).toBe(assignments.size);
    expect(metrics.overall.skeletonPixelCount).toBe(1);
    expect(metrics.overall.skeletonLengthPx).toBe(0);
    expect(metrics.overall.density).toBe(0);
    expect(metrics.overall.coverage).toBeCloseTo(1 / assignments.size);
    expect(metrics.overall.globalAlignment).toBeNull();
    expect(metrics.overall.globalOrientationDeg).toBeNull();
    expect(metrics.overall.radialNormalAlignment).toBeNull();
    expect(metrics.overall.tangentialAlignment).toBeNull();
    expect(metrics.overall.orientationDispersion).toBeNull();
    expect(metrics.overall.empty).toBe(false);
  });

  test("buildSkeletonSamples accepts a skeleton image object with data and dimensions", () => {
    const group = square("cell", 4, 3, 6, 7);
    const roiBands = [
      { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
      { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
      { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
    ];
    const assignments = assignOutwardRoiPixels({ width: 11, height: 11, groups: [group], roiBands });
    const skeleton = { data: new Uint8Array(11 * 11), width: 11, height: 11 };
    skeleton.data[1 * 11 + 5] = 1;
    skeleton.data[2 * 11 + 5] = 1;

    expect(buildSkeletonSamples({ skeleton, assignments }).map((sample) => [sample.x, sample.y])).toEqual([
      [5, 1],
      [5, 2],
    ]);
  });
});
