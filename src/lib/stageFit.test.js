import { describe, expect, test } from "vitest";
import { fitAspectToBox, heatmapReportAspect } from "./stageFit.js";

describe("fitAspectToBox", () => {
  test("uses all available width when width limits the image", () => {
    expect(fitAspectToBox({ boxWidth: 600, boxHeight: 800, aspectRatio: 4 / 3 })).toEqual({
      width: 600,
      height: 450,
    });
  });

  test("uses all available height when height limits the image", () => {
    expect(fitAspectToBox({ boxWidth: 1200, boxHeight: 600, aspectRatio: 4 / 3 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  test("returns null when dimensions are not measurable", () => {
    expect(fitAspectToBox({ boxWidth: 0, boxHeight: 600, aspectRatio: 4 / 3 })).toBeNull();
    expect(fitAspectToBox({ boxWidth: 600, boxHeight: 600, aspectRatio: 0 })).toBeNull();
  });
});

describe("heatmapReportAspect", () => {
  test("includes report header, axes, and scale around a square heatmap", () => {
    const aspect = heatmapReportAspect({ columns: 100, rows: 100, imageAspect: 1 });
    expect(aspect).toBeGreaterThan(1);
    expect(aspect).toBeLessThan(1.5);
  });

  test("keeps wide and tall plots bounded", () => {
    expect(heatmapReportAspect({ columns: 100, rows: 50, imageAspect: 2 })).toBeGreaterThan(1.5);
    expect(heatmapReportAspect({ columns: 50, rows: 100, imageAspect: 0.5 })).toBeLessThan(1);
  });
});
