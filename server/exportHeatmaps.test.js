import sharp from "sharp";
import { describe, expect, test } from "vitest";
import {
  EXPORT_CELL_SIZES,
  buildHeatmapFigureSvg,
  planHeatmapFigures,
  renderHeatmapFigure,
} from "./exportHeatmaps.js";

const calibration = { slope: 0.1, intercept: 0 };

function map(imageFolder, values, cellSize = 20) {
  return {
    imageFolder,
    width: 40,
    height: 20,
    cellWidth: cellSize,
    cellHeight: cellSize,
    columns: 2,
    rows: 1,
    cells: values.map((pixelDensity, column) => ({
      row: 0,
      column,
      x: column * cellSize,
      y: 0,
      width: cellSize,
      height: cellSize,
      areaPx: cellSize * cellSize,
      maskPixelCount: pixelDensity * cellSize * cellSize,
      pixelDensity,
    })),
  };
}

describe("heatmap export", () => {
  test("fixes export sizes and computes current-minus-previous shared ranges", () => {
    expect(EXPORT_CELL_SIZES).toEqual([20, 50, 100]);
    const images = [{ id: "T01", imageFolder: "T01" }, { id: "T02", imageFolder: "T02" }, { id: "T03", imageFolder: "T03" }];
    const sources = new Map([
      ["T01:20", { status: "Included", heatmap: map("T01", [0.1, 0.2]) }],
      ["T02:20", { status: "Included", heatmap: map("T02", [0.4, 0.1]) }],
      ["T03:20", { status: "Included", heatmap: map("T03", [0.6, 0.5]) }],
    ]);

    const plan = planHeatmapFigures({ images, sources, calibration });
    const pixelComparisons = plan.figures.filter(
      (figure) => figure.kind === "comparison" && figure.metric === "pixel-density",
    );

    expect(pixelComparisons.map((figure) => figure.values)).toEqual([[0.3, -0.1], [0.2, 0.4]]);
    expect(pixelComparisons.map((figure) => figure.colorRange)).toEqual([
      { min: -0.4, max: 0.4 },
      { min: -0.4, max: 0.4 },
    ]);
    expect(plan.figures.some((figure) => figure.currentImage === "T01" && figure.kind === "comparison")).toBe(false);
    expect(buildHeatmapFigureSvg(pixelComparisons[0])).toContain(">Delta Pixel Density</text>");
    const collagenComparison = plan.figures.find(
      (figure) => figure.kind === "comparison" && figure.metric === "estimated-collagen-density",
    );
    expect(buildHeatmapFigureSvg(collagenComparison)).toContain("Delta Collagen Density (mg/ml)");
  });

  test("renders a report PNG with title, axes, range, unit, and color bar", async () => {
    const figure = {
      kind: "absolute",
      metric: "estimated-collagen-density",
      metricLabel: "Estimated Collagen Density",
      unit: "mg/ml",
      currentImage: "T01",
      previousImage: null,
      cellWidth: 20,
      cellHeight: 20,
      columns: 2,
      rows: 1,
      values: [1, 2],
      colorRange: { min: 0, max: 3 },
      calibration,
    };
    const svg = buildHeatmapFigureSvg(figure);
    expect(svg).toContain("T01 | Estimated Collagen Density | Cell 20x20 px | Grid 2x1");
    expect(svg).toContain("Calibration: Pixel Density = 0.1 * Collagen Density + 0");
    expect(svg).toContain("Grid X");
    expect(svg).toContain("Grid Y");
    expect(svg).toContain("Estimated Collagen Density (mg/ml)");
    expect(svg).toContain('data-role="color-bar"');

    const metadata = await sharp(await renderHeatmapFigure(figure)).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBeGreaterThan(700);
  });
});
