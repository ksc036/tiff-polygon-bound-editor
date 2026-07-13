import { describe, expect, test } from "vitest";

import {
  buildHeatmapDifference,
  differenceColor,
  estimateHeatmapCollagenDensity,
  heatmapCellAtPoint,
  heatmapCompatibilityError,
  heatmapDisplayRange,
  heatmapMetricValue,
  infernoColor,
} from "./heatmap.js";

const calibration = { slope: 0.1, intercept: 0.05 };

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
  test("uses the existing calibration formula", () => {
    expect(estimateHeatmapCollagenDensity(0.2, calibration)).toBeCloseTo(1.5);
    expect(estimateHeatmapCollagenDensity(0.2, { slope: "0.1", intercept: "0.05" })).toBeCloseTo(1.5);
  });

  test("returns null for invalid calibration inputs", () => {
    expect(estimateHeatmapCollagenDensity(0.2, { slope: 0, intercept: 0.05 })).toBeNull();
    expect(estimateHeatmapCollagenDensity(Number.NaN, calibration)).toBeNull();
  });

  test("reads raw and estimated metric values without rescaling", () => {
    const cell = { pixelDensity: 0.2 };

    expect(heatmapMetricValue(cell, "pixel-density", calibration)).toBe(0.2);
    expect(heatmapMetricValue(cell, "estimated-collagen-density", calibration)).toBeCloseTo(1.5);
  });

  test("calculates signed previous-image changes without rescaling values", () => {
    const current = heatmapWithDensities([0.2, 0.1]);
    const previous = heatmapWithDensities([0.05, 0.3]);

    expect(buildHeatmapDifference({ current, previous, metric: "pixel-density", calibration })).toEqual({
      currentValues: [0.2, 0.1],
      previousValues: [0.05, 0.3],
      values: [0.15, -0.2],
      maxAbs: 0.2,
    });
  });

  test("preserves unavailable estimated values for zero-slope calibration", () => {
    const current = heatmapWithDensities([0.2, 0.1]);
    const previous = heatmapWithDensities([0.05, 0.3]);

    expect(
      buildHeatmapDifference({
        current,
        previous,
        metric: "estimated-collagen-density",
        calibration: { slope: 0, intercept: 0.05 },
      }),
    ).toEqual({
      currentValues: [null, null],
      previousValues: [null, null],
      values: [null, null],
      maxAbs: 0,
    });
  });

  test("preserves unavailable estimated values for non-numeric calibration", () => {
    const current = heatmapWithDensities([0.2]);
    const previous = heatmapWithDensities([0.05]);

    expect(
      buildHeatmapDifference({
        current,
        previous,
        metric: "estimated-collagen-density",
        calibration: { slope: "not-a-number", intercept: "0.05" },
      }),
    ).toEqual({
      currentValues: [null],
      previousValues: [null],
      values: [null],
      maxAbs: 0,
    });
  });

  test("only includes finite deltas in maxAbs", () => {
    const current = heatmapWithDensities([0.2, Number.NaN]);
    const previous = heatmapWithDensities([0.1, 0.3]);

    expect(buildHeatmapDifference({ current, previous, metric: "pixel-density", calibration })).toEqual({
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

    expect(buildHeatmapDifference({ current, previous, metric: "pixel-density", calibration }).maxAbs).toBe(0.8);
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
    expect(differenceColor(null, 1)).toBe("#f8fafc");
    expect(differenceColor(Number.NaN, 1)).toBe("#f8fafc");
  });

  test("provides metric display ranges", () => {
    expect(heatmapDisplayRange("pixel-density")).toEqual({ min: 0, max: 1, unit: "" });
    expect(heatmapDisplayRange("estimated-collagen-density")).toEqual({ min: 0, max: 3, unit: "mg/ml" });
  });

  test("resolves cells at image coordinates including partial edge cells", () => {
    const map = heatmap({ width: 12, height: 9, cellWidth: 5, cellHeight: 5, columns: 3, rows: 2 });

    expect(heatmapCellAtPoint(map, { x: 11, y: 8 })).toMatchObject({ row: 1, column: 2, width: 2, height: 4 });
    expect(heatmapCellAtPoint(map, { x: 12, y: 8 })).toBeNull();
    expect(heatmapCellAtPoint(map, { x: -1, y: 0 })).toBeNull();
  });
});
