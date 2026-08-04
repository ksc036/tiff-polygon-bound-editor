import { describe, expect, test } from "vitest";
import {
  formatHeatmapFigureRange,
  heatmapAxisTickValues,
  heatmapFigureText,
  heatmapScaleTickValues,
} from "./heatmapFigure.js";

describe("heatmap figure presentation", () => {
  test("uses five zero-based ticks for grid axes", () => {
    expect(heatmapAxisTickValues(9)).toEqual([0, 2, 4, 6, 8]);
    expect(heatmapAxisTickValues(1)).toEqual([0, 0, 0, 0, 0]);
  });

  test("uses five top-to-bottom scale ticks", () => {
    expect(heatmapScaleTickValues(-0.5, 0.5)).toEqual([0.5, 0.25, 0, -0.25, -0.5]);
  });

  test("builds export-compatible comparison text", () => {
    expect(heatmapFigureText({
      currentImage: "T2",
      previousImage: "T1",
      metric: "pixel-density",
      metricLabel: "Pixel Density",
      metricUnit: "ratio",
      cellWidth: 20,
      cellHeight: 20,
      columns: 8,
      rows: 6,
      min: -0.5,
      max: 0.5,
      comparison: true,
      calibration: { slope: 0.069676956982087, intercept: 0.067893820336777 },
    })).toMatchObject({
      titleLines: ["Current: T2", "Previous: T1"],
      detailLine: "Pixel Density | Cell 20x20 px | Grid 8x6",
      rangeLine: "Color range: -0.5 to +0.5 ratio",
      colorBarLabel: "Delta Pixel Density",
    });
  });

  test("formats signed ranges like export", () => {
    expect(formatHeatmapFigureRange(-0.5, 0.5, { signed: true })).toBe("-0.5 to +0.5");
  });
});
