import { describe, expect, test } from "vitest";

import {
  buildHeatmapDifference,
  differenceColor,
  estimateHeatmapCollagenDensity,
  heatmapCellAtPoint,
  heatmapCompatibilityError,
  heatmapDisplayRange,
  heatmapDisplayValue,
  heatmapMetricValue,
  infernoColor,
} from "./heatmap.js";
import { pixelDensityFromCollagenDensity } from "../../shared/collagenDensity.js";

test("uses the selected calibration without capping finite comparisons", () => {
  const current = heatmapWithDensities([pixelDensityFromCollagenDensity(12, "high-density"), 0.3, 0]);
  const previous = heatmapWithDensities([pixelDensityFromCollagenDensity(10, "high-density"), 0.1, 0]);
  current.cells[2].areaPx = 0;
  expect(heatmapMetricValue(current.cells[0], "collagen-density", 3, "high-density")).toBeCloseTo(12);
  expect(heatmapDisplayValue(current.cells[1], "collagen-density", 3, "high-density")).toBe(3);
  expect(heatmapDisplayValue(current.cells[2], "collagen-density", 3, "high-density")).toBeNull();
  const result = buildHeatmapDifference({ current, previous, metric: "collagen-density", collagenDensityMax: 3, model: "high-density" });
  expect(result.values[0]).toBeCloseTo(2);
  expect(result.values[1]).toBeCloseTo(1.5007161093);
  expect(result.values[2]).toBeNull();
  expect(heatmapMetricValue({ pixelDensity: 0.1 }, "collagen-density", 8, "low-density")).toBeCloseTo(1.5395741158);
});

test.each([3, 8, 10])("uses Max %s for out-of-model comparison cells while preserving missing data", (maximum) => {
  const current = heatmapWithDensities([0.1087, 0, 0.2, null, 0.2, 0.2]);
  const previous = heatmapWithDensities([0, 0.2, 0.1087, 0.2, 0.2, null]);
  current.cells[4].areaPx = 0;

  const result = buildHeatmapDifference({ current, previous, metric: "estimated-collagen-density",
    collagenDensityMax: maximum, model: "low-density" });

  expect(result.currentValues).toEqual([maximum, 0, maximum, null, null, maximum]);
  expect(result.previousValues).toEqual([0, maximum, maximum, maximum, maximum, null]);
  expect(result.values).toEqual([maximum, -maximum, 0, null, null, null]);
  expect(result.maxAbs).toBe(maximum);
});

test.each([-0.1, 1.2, null, undefined, NaN, Infinity])("invalid AF %s is no data for both metrics", (pixelDensity) => {
  for (const metric of ["pixel-density", "collagen-density"]) {
    expect(heatmapMetricValue({ pixelDensity }, metric)).toBeNull();
    expect(heatmapDisplayValue({ pixelDensity }, metric)).toBeNull();
  }
});

test("empty cells are distinct from true zero cells for both metrics", () => {
  for (const metric of ["pixel-density", "collagen-density"]) {
    expect(heatmapMetricValue({ pixelDensity: 0, areaPx: 0 }, metric)).toBeNull();
    expect(heatmapMetricValue({ pixelDensity: 0, areaPx: 1 }, metric)).toBe(0);
  }
});

function heatmap(overrides = {}) {
  const width = overrides.width ?? 10;
  const height = overrides.height ?? 10;
  const cellWidth = overrides.cellWidth ?? 5;
  const cellHeight = overrides.cellHeight ?? 5;
  const columns = overrides.columns ?? Math.ceil(width / cellWidth);
  const rows = overrides.rows ?? Math.ceil(height / cellHeight);
  const cells = overrides.cells ?? Array.from({ length: rows * columns }, (_, index) => ({
    row: Math.floor(index / columns),
    column: index % columns,
    x: (index % columns) * cellWidth,
    y: Math.floor(index / columns) * cellHeight,
    width: Math.min(cellWidth, width - (index % columns) * cellWidth),
    height: Math.min(cellHeight, height - Math.floor(index / columns) * cellHeight),
    pixelDensity: 0,
  }));

  return { width, height, cellWidth, cellHeight, columns, rows, cells, ...overrides };
}

function heatmapWithDensities(values) {
  return heatmap({
    width: values.length,
    height: 1,
    cellWidth: 1,
    cellHeight: 1,
    columns: values.length,
    rows: 1,
    cells: values.map((pixelDensity, column) => ({
      row: 0,
      column,
      x: column,
      y: 0,
      width: 1,
      height: 1,
      pixelDensity,
    })),
  });
}

describe("heatmap calculations", () => {
  test("uses the default High density model", () => {
    expect(estimateHeatmapCollagenDensity(0.1)).toBeCloseTo(1.4992838907);
  });

  test("saturates values outside the displayed model range", () => {
    expect(estimateHeatmapCollagenDensity(0.5)).toBeNull();
    expect(estimateHeatmapCollagenDensity(0.5, 10)).toBeNull();
    expect(estimateHeatmapCollagenDensity(Number.NaN)).toBeNull();
  });

  test("reads raw and estimated metric values without rescaling", () => {
    const cell = { pixelDensity: 0.1 };

    expect(heatmapMetricValue(cell, "pixel-density")).toBe(0.1);
    expect(heatmapMetricValue(cell, "estimated-collagen-density")).toBeCloseTo(1.4992838907);
  });

  test("calculates signed previous-image changes without rescaling values", () => {
    const current = heatmapWithDensities([0.2, 0.1]);
    const previous = heatmapWithDensities([0.05, 0.3]);

    expect(buildHeatmapDifference({ current, previous, metric: "pixel-density" })).toEqual({
      currentValues: [0.2, 0.1],
      previousValues: [0.05, 0.3],
      values: [0.15, -0.2],
      maxAbs: 0.2,
    });
  });

  test("saturates estimated values outside the one-phase display range", () => {
    const current = heatmapWithDensities([0.2, 0.5]);
    const previous = heatmapWithDensities([0.05, 0.3]);

    expect(
      buildHeatmapDifference({
        current,
        previous,
        metric: "estimated-collagen-density",
      }),
    ).toMatchObject({
      currentValues: [expect.any(Number), 8],
      previousValues: [expect.any(Number), 8],
      values: [expect.any(Number), 0],
    });
  });

  test("only includes finite deltas in maxAbs", () => {
    const current = heatmapWithDensities([0.2, Number.NaN]);
    const previous = heatmapWithDensities([0.1, 0.3]);

    expect(buildHeatmapDifference({ current, previous, metric: "pixel-density" })).toEqual({
      currentValues: [0.2, null],
      previousValues: [0.1, 0.3],
      values: [0.1, null],
      maxAbs: 0.1,
    });
  });

  test("calculates maxAbs for a large heatmap without spreading arguments", () => {
    const cellCount = 200_000;
    const current = heatmapWithDensities(Array.from({ length: cellCount }, (_, index) => (index === cellCount - 1 ? 0.9 : 0.2)));
    const previous = heatmapWithDensities(Array.from({ length: cellCount }, () => 0.1));

    expect(buildHeatmapDifference({ current, previous, metric: "pixel-density" }).maxAbs).toBe(0.8);
  });

  test("rejects incompatible dimensions and cell sizes", () => {
    expect(heatmapCompatibilityError(heatmap({ width: 10 }), heatmap({ width: 11 }))).toMatch(/dimensions/i);
    expect(heatmapCompatibilityError(heatmap({ cellWidth: 5 }), heatmap({ cellWidth: 10 }))).toMatch(/cell size/i);
    expect(heatmapCompatibilityError(heatmap({ rows: 2 }), heatmap({ rows: 1 }))).toMatch(/rows/i);
    expect(heatmapCompatibilityError(heatmap({ cells: [] }), heatmap())).toMatch(/cell count/i);
    expect(heatmapCompatibilityError(heatmap(), heatmap())).toBeNull();
  });

  test("uses inferno and zero-centered diverging endpoints", () => {
    expect(infernoColor(0, 0, 1)).toBe("#000004");
    expect(infernoColor(1, 0, 1)).toBe("#fcffa4");
    expect(infernoColor(-1, 0, 1)).toBe("#000004");
    expect(infernoColor(2, 0, 1)).toBe("#fcffa4");
    expect(differenceColor(-1, 1)).toBe("#2563eb");
    expect(differenceColor(0, 1)).toBe("#f8fafc");
    expect(differenceColor(1, 1)).toBe("#dc2626");
    expect(differenceColor(null, 1)).toBe("#80858b");
    expect(differenceColor(Number.NaN, 1)).toBe("#80858b");
  });

  test("provides metric display ranges", () => {
    expect(heatmapDisplayRange("pixel-density")).toEqual({ min: 0, max: 1, unit: "" });
    expect(heatmapDisplayRange("estimated-collagen-density")).toEqual({ min: 0, max: 8, unit: "mg/ml" });
    expect(heatmapDisplayRange("estimated-collagen-density", 4)).toEqual({ min: 0, max: 4, unit: "mg/ml" });
  });

  test("uses the requested maximum for estimated-density comparisons", () => {
    const current = heatmapWithDensities([0.5]);
    const previous = heatmapWithDensities([0.2]);

    expect(buildHeatmapDifference({
      current,
      previous,
      metric: "estimated-collagen-density",
      collagenDensityMax: 10,
    })).toMatchObject({
      currentValues: [10],
    });
  });

  test("resolves cells at image coordinates including partial edge cells", () => {
    const map = heatmap({ width: 12, height: 9, cellWidth: 5, cellHeight: 5, columns: 3, rows: 2 });

    expect(heatmapCellAtPoint(map, { x: 11, y: 8 })).toMatchObject({ row: 1, column: 2, width: 2, height: 4 });
    expect(heatmapCellAtPoint(map, { x: 12, y: 8 })).toBeNull();
    expect(heatmapCellAtPoint(map, { x: -1, y: 0 })).toBeNull();
  });

  test("resolves centered cells on both axes at exact and fractional image coordinates", () => {
    const starts = [0, 1, 5, 9];
    const sizes = [1, 4, 4, 1];
    const map = heatmap({ width: 10, height: 10, cellWidth: 4, cellHeight: 4,
      gridAlignment: "center", columns: 4, rows: 4,
      cells: starts.flatMap((y, row) => starts.map((x, column) => ({
        row, column, x, y, width: sizes[column], height: sizes[row], pixelDensity: 0,
      }))) });
    expect(heatmapCellAtPoint(map, { x: 0.9, y: 0.9 })).toMatchObject({ row: 0, column: 0, width: 1, height: 1 });
    expect(heatmapCellAtPoint(map, { x: 1, y: 1 })).toMatchObject({ row: 1, column: 1 });
    expect(heatmapCellAtPoint(map, { x: 4.9, y: 5 })).toMatchObject({ row: 2, column: 1 });
    expect(heatmapCellAtPoint(map, { x: 9, y: 9 })).toMatchObject({ row: 3, column: 3, width: 1, height: 1 });
    expect(heatmapCellAtPoint(map, { x: 10, y: 9 })).toBeNull();
  });

  test("rejects comparisons with different cell coordinates even when counts and sizes match", () => {
    const current = heatmap();
    const previous = heatmap({ cells: current.cells.map((cell, index) => index === 0 ? { ...cell, x: 1 } : cell) });
    expect(heatmapCompatibilityError(current, previous)).toMatch(/grid alignment/i);
    expect(() => buildHeatmapDifference({ current, previous, metric: "pixel-density" })).toThrow(/grid alignment/i);
  });
});
