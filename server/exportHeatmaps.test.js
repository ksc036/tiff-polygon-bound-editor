import sharp from "sharp";
import { describe, expect, test, vi } from "vitest";
import {
  EXPORT_CELL_SIZES,
  buildHeatmapFigureSvg,
  hydrateHeatmapFigure,
  planHeatmapFigures,
  planSavedHeatmapFigures,
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

  test("keeps an all-zero comparison on its true zero range", () => {
    const images = [{ id: "T01", imageFolder: "T01" }, { id: "T02", imageFolder: "T02" }];
    const sources = new Map([
      ["T01:20", { status: "Included", heatmap: map("T01", [0.2, 0.4]) }],
      ["T02:20", { status: "Included", heatmap: map("T02", [0.2, 0.4]) }],
    ]);

    const plan = planHeatmapFigures({ images, sources, calibration });
    const comparison = plan.figures.find(
      (figure) => figure.kind === "comparison" && figure.metric === "pixel-density",
    );

    expect(comparison.colorRange).toEqual({ min: 0, max: 0 });
    const svg = buildHeatmapFigureSvg(comparison);
    expect(svg).toContain("Color range: 0 to 0");
    expect(svg).not.toContain("Color range: -1 to +1");
  });

  test("retains five axis and scale labels with calibration and comparison range", () => {
    const figure = {
      kind: "comparison",
      metric: "pixel-density",
      metricLabel: "Pixel Density",
      unit: "ratio",
      currentImage: "T2",
      previousImage: "T1",
      cellWidth: 20,
      cellHeight: 20,
      columns: 9,
      rows: 9,
      values: Array(81).fill(0),
      colorRange: { min: -0.5, max: 0.5 },
      calibration: { slope: 0.069676956982087, intercept: 0.067893820336777 },
    };

    const svg = buildHeatmapFigureSvg(figure);
    const tickLabels = [...svg.matchAll(/<text class="tick"[^>]*>([^<]+)<\/text>/g)]
      .map((match) => match[1]);

    expect(tickLabels).toEqual([
      "0", "0", "2", "2", "4", "4", "6", "6", "8", "8",
      "0.5", "0.25", "0", "-0.25", "-0.5",
    ]);
    expect(svg).toContain("Calibration: Pixel Density = 0.069677 * Collagen Density + 0.067894");
    expect(svg).toContain("Range -0.5 to +0.5");
    expect(svg).toContain("Color range: -0.5 to +0.5 ratio");
  });

  test("plans shared ranges with lightweight descriptors and reloads only the rendered figure", async () => {
    const images = [
      { id: "T01", imageFolder: "T01" },
      { id: "T02", imageFolder: "T02" },
      { id: "T03", imageFolder: "T03" },
    ];
    const heatmaps = new Map([
      ["T01:20", map("T01", [0.1, 0.2])],
      ["T02:20", map("T02", [0.4, 0.1])],
      ["T03:20", map("T03", [0.6, 0.5])],
    ]);
    const loads = [];
    const loadHeatmap = async (_storage, id, cellSize) => {
      loads.push(`${id}:${cellSize}`);
      const heatmap = heatmaps.get(`${id}:${cellSize}`);
      if (!heatmap) {
        const error = new Error("missing");
        error.code = "MISSING_HEATMAP";
        throw error;
      }
      return heatmap;
    };

    const plan = await planSavedHeatmapFigures({
      storage: {},
      images,
      calibration,
      loadHeatmap,
    });
    const comparison = plan.figures.find(
      (figure) => figure.kind === "comparison" &&
        figure.metric === "pixel-density" &&
        figure.currentImage === "T03",
    );

    expect(plan.figures.every((figure) => !("values" in figure) && !("heatmap" in figure))).toBe(true);
    expect(comparison.colorRange).toEqual({ min: -0.4, max: 0.4 });
    const loadsBeforeHydration = loads.length;

    const hydrated = await hydrateHeatmapFigure(comparison, {
      storage: {},
      loadHeatmap,
    });

    expect(hydrated.values).toEqual([0.2, 0.4]);
    expect(loads.slice(loadsBeforeHydration)).toEqual(["T03:20", "T02:20"]);
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

  test("caps a valid 680 by 680 grid below Sharp's output pixel limit", async () => {
    const figure = {
      kind: "absolute",
      metric: "pixel-density",
      metricLabel: "Pixel Density",
      unit: "ratio",
      currentImage: "T-large",
      previousImage: null,
      cellWidth: 20,
      cellHeight: 20,
      columns: 680,
      rows: 680,
      values: Array(680 * 680).fill(0.5),
      colorRange: { min: 0, max: 1 },
      calibration,
    };

    const svg = buildHeatmapFigureSvg(figure);
    const [, width, height] = svg.match(/<svg[^>]+width="([^"]+)" height="([^"]+)"/) ?? [];
    expect(Number(width) * Number(height)).toBeLessThan(100_000_000);

    const metadata = await sharp(await renderHeatmapFigure(figure)).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width * metadata.height).toBeLessThan(100_000_000);
  }, 30_000);

  test("wraps long current and previous names without dropping their full values", () => {
    const currentImage = `current-${"W".repeat(180)}`;
    const previousImage = `previous-${"W".repeat(180)}`;
    const figure = {
      kind: "comparison",
      metric: "pixel-density",
      metricLabel: "Pixel Density",
      unit: "ratio",
      currentImage,
      previousImage,
      cellWidth: 20,
      cellHeight: 20,
      columns: 2,
      rows: 1,
      values: [0, 0],
      colorRange: { min: 0, max: 0 },
      calibration,
    };

    const svg = buildHeatmapFigureSvg(figure);
    expect(svg).toContain(`data-current-image="${currentImage}"`);
    expect(svg).toContain(`data-previous-image="${previousImage}"`);
    const titleLines = [...svg.matchAll(/data-role="title-line"[^>]*>([^<]*)<\/text>/g)]
      .map((match) => match[1]);
    expect(titleLines.length).toBeGreaterThan(4);
    expect(titleLines.every((line) => line.length <= 80)).toBe(true);
    expect(titleLines.every((line) => line.length <= 52)).toBe(true);
  });

  test("cancels the active Sharp pipeline and detaches its abort listener", async () => {
    const figure = {
      kind: "absolute",
      metric: "pixel-density",
      metricLabel: "Pixel Density",
      unit: "ratio",
      currentImage: "T01",
      previousImage: null,
      cellWidth: 20,
      cellHeight: 20,
      columns: 2,
      rows: 1,
      values: [0.25, 0.75],
      colorRange: { min: 0, max: 1 },
      calibration,
    };
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const rendering = renderHeatmapFigure(figure, { signal: controller.signal });
    controller.abort();

    await expect(rendering).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
