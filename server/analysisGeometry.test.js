import { describe, expect, test } from "vitest";

import {
  aggregateRoiMetrics,
  assignInsideRoiPixels,
  assignOutwardRoiPixels,
  buildMaskSamples,
  buildSkeletonSamples,
  polygonSelfIntersects,
  roiScanWindows,
  validateRoiBands,
  visitOutwardRoiPixels,
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

  test("visits the same exclusive outward assignments without retaining an assignment map", () => {
    const groups = [square("left", 1, 1, 3, 3), square("right", 6, 1, 8, 3)];
    const roiBands = [
      { id: "near", label: "Near", fromPx: 0, toPx: 1.1 },
      { id: "mid", label: "Mid", fromPx: 1.1, toPx: 3 },
      { id: "far", label: "Far", fromPx: 3, toPx: 4 },
    ];
    const expected = assignOutwardRoiPixels({ width: 10, height: 5, groups, roiBands });
    const visited = new Map();

    const count = visitOutwardRoiPixels({
      width: 10,
      height: 5,
      groups,
      roiBands,
      visit: (x, y, assignment) => visited.set(`${x},${y}`, assignment),
    });

    expect(count).toBe(expected.size);
    expect([...visited.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [key, assignment] of expected) {
      expect(visited.get(key)).toEqual(assignment);
    }
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

  test("assignInsideRoiPixels includes polygon interiors and boundaries without radial vectors", () => {
    const assignments = assignInsideRoiPixels({
      width: 5,
      height: 5,
      groups: [square("cell", 1, 1, 3, 3)],
    });

    expect(assignments.get("1,1")).toMatchObject({
      groupId: "cell",
      bandId: "inside",
    });
    expect(assignments.get("2,2")).toMatchObject({
      groupId: "cell",
      bandId: "inside",
    });
    expect(assignments.has("0,0")).toBe(false);
    expect(assignments.size).toBe(9);
    expect(assignments.get("2,2")).not.toHaveProperty("outwardNormal");
    expect(assignments.get("2,2")).not.toHaveProperty("tangent");

    const maskSamples = buildMaskSamples({
      mask: new Set(["1,1", "2,2", "4,4"]),
      width: 5,
      height: 5,
      assignments,
    });
    const skeletonSamples = buildSkeletonSamples({
      skeleton: new Set(["1,2", "2,2", "3,2"]),
      width: 5,
      height: 5,
      assignments,
    });
    const metrics = aggregateRoiMetrics({
      assignments,
      maskSamples,
      skeletonSamples,
      bandIds: ["inside"],
    });

    expect(metrics.overall.roiAreaPx).toBe(9);
    expect(metrics.overall.maskPixelCount).toBe(2);
    expect(metrics.overall.density).toBeCloseTo(2 / 9);
    expect(metrics.overall.globalAlignment).toBeCloseTo(1);
    expect(metrics.overall.radialNormalAlignment).toBeNull();
    expect(metrics.overall.tangentialAlignment).toBeNull();
    expect(metrics.bands.inside).toMatchObject({
      bandId: "inside",
      roiAreaPx: 9,
      maskPixelCount: 2,
      radialNormalAlignment: null,
      tangentialAlignment: null,
    });
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

  test("aggregateRoiMetrics counts mask pixels for density while skeletons drive orientation", () => {
    const group = square("cell", 4, 3, 6, 7);
    const roiBands = [
      { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
      { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
      { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
    ];
    const assignments = assignOutwardRoiPixels({ width: 11, height: 11, groups: [group], roiBands });
    const maskSamples = buildMaskSamples({
      mask: new Set(["5,0", "5,1", "5,2", "5,5"]),
      width: 11,
      height: 11,
      assignments,
    });
    const radialSkeleton = new Set(["5,0", "5,1", "5,2"]);
    const tangentialSkeleton = new Set(["3,4", "3,5", "3,6"]);

    const radialMetrics = aggregateRoiMetrics({
      assignments,
      maskSamples,
      skeletonSamples: buildSkeletonSamples({ skeleton: radialSkeleton, width: 11, height: 11, assignments }),
    });
    const tangentialMetrics = aggregateRoiMetrics({
      assignments,
      maskSamples,
      skeletonSamples: buildSkeletonSamples({ skeleton: tangentialSkeleton, width: 11, height: 11, assignments }),
    });

    expect(radialMetrics.overall.roiAreaPx).toBe(assignments.size);
    expect(radialMetrics.overall.maskPixelCount).toBe(3);
    expect(radialMetrics.overall.density).toBeCloseTo(3 / assignments.size);
    expect(radialMetrics.overall).not.toHaveProperty("skeletonPixelCount");
    expect(radialMetrics.overall).not.toHaveProperty("skeletonLengthPx");
    expect(radialMetrics.overall).not.toHaveProperty("coverage");
    expect(radialMetrics.overall).not.toHaveProperty("endpointCount");
    expect(radialMetrics.overall).not.toHaveProperty("branchpointCount");
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

  test("buildSkeletonSamples uses ordered centerline segments instead of per-pixel neighbor angles", () => {
    const centerline = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [4, 1],
      [4, 2],
      [4, 3],
    ];
    const assignments = new Map(centerline.map(([x, y]) => [`${x},${y}`, { groupId: "cell", bandId: "near" }]));

    const samples = buildSkeletonSamples({
      skeleton: new Set(centerline.map(([x, y]) => `${x},${y}`)),
      width: 8,
      height: 8,
      assignments,
      segmentLengthPx: 4,
    });

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      x: 2,
      y: 0,
      orientation: { x: 1, y: 0 },
      segmentStart: { x: 0, y: 0 },
      segmentEnd: { x: 4, y: 0 },
      segmentLengthPx: 4,
    });
    expect(samples[1]).toMatchObject({
      x: 4,
      y: 2,
      orientation: { x: 0, y: 1 },
      segmentStart: { x: 4, y: 0 },
      segmentEnd: { x: 4, y: 3 },
      segmentLengthPx: 3,
    });
  });

  test("aggregateRoiMetrics weights circular statistics by centerline segment length", () => {
    const assignments = new Map([
      ["0,0", { groupId: "cell", bandId: "near" }],
      ["1,0", { groupId: "cell", bandId: "near" }],
    ]);
    const skeletonSamples = [
      {
        x: 0,
        y: 0,
        groupId: "cell",
        bandId: "near",
        orientation: { x: 1, y: 0 },
        outwardNormal: { x: 1, y: 0 },
        segmentLengthPx: 4,
      },
      {
        x: 1,
        y: 0,
        groupId: "cell",
        bandId: "near",
        orientation: { x: 0, y: 1 },
        outwardNormal: { x: 1, y: 0 },
        segmentLengthPx: 1,
      },
    ];

    const metrics = aggregateRoiMetrics({ assignments, maskSamples: [], skeletonSamples });

    expect(metrics.overall.globalAlignment).toBeCloseTo(0.6);
    expect(metrics.overall.circularVariance).toBeCloseTo(0.4);
    expect(metrics.overall.radialNormalAlignment).toBeCloseTo(0.6);
  });

  test("local collagen alignment stays high for spatially separated fiber directions", () => {
    const assignments = new Map();
    const skeletonSamples = [
      ...[
        [0, 0],
        [1, 0],
        [2, 0],
      ].map(([x, y]) => ({ x, y, groupId: "cell", bandId: "near", orientation: { x: 1, y: 0 } })),
      ...[
        [80, 0],
        [80, 1],
        [80, 2],
      ].map(([x, y]) => ({ x, y, groupId: "cell", bandId: "near", orientation: { x: 0, y: 1 } })),
      ...[
        [0, 80],
        [1, 80],
        [2, 80],
      ].map(([x, y]) => ({ x, y, groupId: "cell", bandId: "near", orientation: { x: 1, y: 0 } })),
      ...[
        [80, 80],
        [80, 81],
        [80, 82],
      ].map(([x, y]) => ({ x, y, groupId: "cell", bandId: "near", orientation: { x: 0, y: 1 } })),
    ];

    for (const sample of skeletonSamples) {
      assignments.set(`${sample.x},${sample.y}`, { groupId: sample.groupId, bandId: sample.bandId });
    }

    const metrics = aggregateRoiMetrics({ assignments, maskSamples: [], skeletonSamples });

    expect(metrics.overall.globalAlignment).toBeLessThan(0.05);
    expect(metrics.overall.circularVariance).toBeGreaterThan(0.95);
  });

  test("global collagen alignment uses all ROI segment angles without local neighbor threshold", () => {
    const assignments = new Map([
      ["0,0", { groupId: "cell", bandId: "near", outwardNormal: { x: 1, y: 0 } }],
      ["100,100", { groupId: "cell", bandId: "near", outwardNormal: { x: 1, y: 0 } }],
    ]);
    const skeletonSamples = [
      { x: 0, y: 0, groupId: "cell", bandId: "near", orientation: { x: 1, y: 0 }, outwardNormal: { x: 1, y: 0 } },
      { x: 100, y: 100, groupId: "cell", bandId: "near", orientation: { x: 1, y: 0 }, outwardNormal: { x: 1, y: 0 } },
    ];

    const metrics = aggregateRoiMetrics({ assignments, maskSamples: [], skeletonSamples });

    expect(metrics.overall.globalAlignment).toBeCloseTo(1);
    expect(metrics.overall.circularVariance).toBeCloseTo(0);
    expect(metrics.overall.radialNormalAlignment).toBeCloseTo(1);
  });

  test("target angle alignment reports radial tangent and migration relationships on a signed scale", () => {
    const assignments = new Map([
      [
        "0,0",
        {
          groupId: "cell",
          bandId: "near",
          outwardNormal: { x: 1, y: 0 },
          tangent: { x: 0, y: 1 },
          migrationVector: { x: 1, y: 0 },
        },
      ],
      [
        "1,0",
        {
          groupId: "cell",
          bandId: "near",
          outwardNormal: { x: 1, y: 0 },
          tangent: { x: 0, y: 1 },
          migrationVector: { x: 1, y: 0 },
        },
      ],
      [
        "2,0",
        {
          groupId: "cell",
          bandId: "near",
          outwardNormal: { x: 1, y: 0 },
          tangent: { x: 0, y: 1 },
          migrationVector: { x: 1, y: 0 },
        },
      ],
    ]);
    const skeletonSamples = [...assignments].map(([key, assignment]) => {
      const [x, y] = key.split(",").map(Number);
      return {
        x,
        y,
        groupId: assignment.groupId,
        bandId: assignment.bandId,
        orientation: { x: 1, y: 0 },
        outwardNormal: assignment.outwardNormal,
        tangent: assignment.tangent,
        migrationVector: assignment.migrationVector,
      };
    });

    const metrics = aggregateRoiMetrics({ assignments, maskSamples: [], skeletonSamples });

    expect(metrics.overall.radialNormalAlignment).toBeCloseTo(1);
    expect(metrics.overall.tangentialAlignment).toBeCloseTo(-1);
    expect(metrics.overall.migrationAlignment).toBeCloseTo(1);
  });

  test("aggregateRoiMetrics allocates mask density by ROI band", () => {
    const group = square("cell", 4, 3, 6, 7);
    const roiBands = [
      { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
      { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
      { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
    ];
    const assignments = assignOutwardRoiPixels({ width: 11, height: 11, groups: [group], roiBands });
    const maskSamples = buildMaskSamples({ mask: new Set(["5,1", "5,2", "5,3"]), width: 11, height: 11, assignments });

    expect(maskSamples.map((sample) => [sample.x, sample.y, sample.bandId])).toEqual([
      [5, 1, "mid"],
      [5, 2, "near"],
      [5, 3, "near"],
    ]);

    const metrics = aggregateRoiMetrics({ assignments, maskSamples, skeletonSamples: [] });

    expect(metrics.overall.maskPixelCount).toBe(3);
    expect(metrics.bands.near.maskPixelCount).toBe(2);
    expect(metrics.bands.near.density).toBeCloseTo(2 / metrics.bands.near.roiAreaPx);
    expect(metrics.bands.mid.maskPixelCount).toBe(1);
    expect(metrics.bands.mid.density).toBeCloseTo(1 / metrics.bands.mid.roiAreaPx);
    expect(metrics.bands.far.maskPixelCount).toBe(0);
    expect(metrics.bands.far.density).toBe(0);
  });

  test("aggregateRoiMetrics keeps mask occupancy even when skeleton has no orientation", () => {
    const group = square("cell", 4, 3, 6, 7);
    const roiBands = [
      { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
      { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
      { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
    ];
    const assignments = assignOutwardRoiPixels({ width: 11, height: 11, groups: [group], roiBands });
    const maskSamples = buildMaskSamples({ mask: new Set(["5,0"]), width: 11, height: 11, assignments });
    const skeletonSamples = buildSkeletonSamples({ skeleton: new Set(["5,0"]), width: 11, height: 11, assignments });
    const metrics = aggregateRoiMetrics({ assignments, maskSamples, skeletonSamples });

    expect(skeletonSamples).toEqual([
      expect.objectContaining({
        x: 5,
        y: 0,
        orientation: null,
        neighborCount: 0,
      }),
    ]);
    expect(metrics.overall.roiAreaPx).toBe(assignments.size);
    expect(metrics.overall.maskPixelCount).toBe(1);
    expect(metrics.overall.density).toBeCloseTo(1 / assignments.size);
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

    const samples = buildSkeletonSamples({ skeleton, assignments });

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      x: 5,
      y: 2,
      orientation: { x: 0, y: 1 },
      segmentLengthPx: 1,
    });
  });
});
