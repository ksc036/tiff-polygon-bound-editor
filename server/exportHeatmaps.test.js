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

const calibration = { id: "high-density" };

function centeredMap(imageFolder = "T01", extent = 10) {
  const edges = [0, 1, 5, 9, extent];
  return {
    schemaVersion: 2,
    gridAlignment: "center",
    imageFolder,
    width: extent,
    height: extent,
    cellWidth: 4,
    cellHeight: 4,
    columns: 4,
    rows: 4,
    cells: Array.from({ length: 16 }, (_, index) => {
      const row = Math.floor(index / 4);
      const column = index % 4;
      const width = edges[column + 1] - edges[column];
      const height = edges[row + 1] - edges[row];
      return {
        row, column, x: edges[column], y: edges[row], width, height,
        areaPx: width * height,
        pixelDensity: row === 1 && column === 1 ? 1 : 0,
      };
    }),
  };
}

function gridBounds(svg) {
  const match = svg.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="none" stroke="#111827" stroke-width="1"/);
  return match.slice(1).map(Number);
}

async function expectCenteredPixels(figure) {
  const [x, y, width, height] = gridBounds(buildHeatmapFigureSvg(figure));
  expect([width, height]).toEqual([60, 60]);
  const png = await renderHeatmapFigure(figure);
  expect((await sharp(png).metadata()).format).toBe("png");
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (dx, dy) => [...data.subarray(((y + dy) * info.width + x + dx) * 3, ((y + dy) * info.width + x + dx) * 3 + 3)];
  expect(pixel(3, 12)).toEqual([0, 0, 4]);
  expect(pixel(12, 3)).toEqual([0, 0, 4]);
  expect(pixel(12, 12)).toEqual([252, 255, 164]);
  expect(pixel(27, 27)).toEqual([252, 255, 164]);
  expect(pixel(33, 12)).toEqual([0, 0, 4]);
  expect(pixel(12, 33)).toEqual([0, 0, 4]);
}

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
  test.each([10, 11])("preserves centered partial-cell SVG geometry on both %i-pixel axes", (extent) => {
    const heatmap = centeredMap("T01", extent);
    const { figures } = planHeatmapFigures({
      images: [{ id: "T01" }],
      sources: new Map([["T01:4", { status: "Included", heatmap }]]),
      cellSizes: [4], calibration,
    });
    const figure = figures[0];
    const svg = buildHeatmapFigureSvg(figure);
    const [x, y, width, height] = gridBounds(svg);
    expect([width, height]).toEqual([extent * 6, extent * 6]);
    expect(svg).toContain(`M${x + 6} ${y + 6}h24v24h-24z`);
    expect(svg).toContain(`M${x} ${y + 54}h${extent * 6}v${(extent - 9) * 6}h-${extent * 6}z`);
    expect(figure).toMatchObject({ schemaVersion: 2, gridAlignment: "center", width: extent, height: extent });
  });

  test("renders actual centered cell boundaries in the embedded PNG", async () => {
    const { figures } = planHeatmapFigures({
      images: [{ id: "T01" }],
      sources: new Map([["T01:4", { status: "Included", heatmap: centeredMap() }]]),
      cellSizes: [4], calibration,
    });
    await expectCenteredPixels(figures[0]);
  });

  test("retains centered geometry through saved descriptors and hydration for both figure kinds", async () => {
    const loadHeatmap = async (_storage, id) => centeredMap(id);
    const { figures } = await planSavedHeatmapFigures({
      images: [{ id: "T01" }, { id: "T02" }],
      cellSizes: [4], calibration, loadHeatmap,
    });
    for (const descriptor of figures) {
      expect(descriptor).toMatchObject({ schemaVersion: 2, gridAlignment: "center", width: 10, height: 10 });
      expect(descriptor).not.toHaveProperty("cells");
      expect(descriptor).not.toHaveProperty("values");
      const hydrated = await hydrateHeatmapFigure(JSON.parse(JSON.stringify(descriptor)), { loadHeatmap });
      expect(gridBounds(buildHeatmapFigureSvg(hydrated)).slice(2)).toEqual([60, 60]);
      if (hydrated.kind === "absolute" && hydrated.metric === "pixel-density") {
        await expectCenteredPixels(hydrated);
      }
    }
  });

  test("uses top-left v1 cell geometry but keeps uniform fallback for figures without geometry", () => {
    const heatmap = map("T01", [0, 1], 4);
    Object.assign(heatmap, { schemaVersion: 1, width: 6, height: 4 });
    heatmap.cells[1].width = 2;
    const { figures } = planHeatmapFigures({
      images: [{ id: "T01" }],
      sources: new Map([["T01:4", { status: "Included", heatmap }]]),
      cellSizes: [4], calibration,
    });
    const [x, y, width, height] = gridBounds(buildHeatmapFigureSvg(figures[0]));
    expect([width, height]).toEqual([36, 24]);
    expect(buildHeatmapFigureSvg(figures[0])).toContain(`M${x + 24} ${y}h12v24h-12z`);
    const { gridAxes, ...uniform } = figures[0];
    expect(gridBounds(buildHeatmapFigureSvg(uniform)).slice(2)).toEqual([48, 24]);
  });

  test("preserves Max-substitution comparisons in eager and saved centered plans", async () => {
    const previous = centeredMap("T01");
    const current = centeredMap("T02");
    previous.cells[0].pixelDensity = 0;
    current.cells[0].pixelDensity = 0.5;
    previous.cells[1].pixelDensity = 0.5;
    current.cells[1].pixelDensity = 0;
    previous.cells[2].pixelDensity = 0.5;
    current.cells[2].pixelDensity = 0.5;
    current.cells[3].areaPx = 0;
    const images = [{ id: "T01" }, { id: "T02" }];
    const heatmaps = new Map([["T01", previous], ["T02", current]]);
    const options = { images, cellSizes: [4], calibration, estimatedCollagenColorMax: 8 };
    const loadHeatmap = async (_storage, id) => heatmaps.get(id);
    const eager = planHeatmapFigures({
      ...options,
      sources: new Map([...heatmaps].map(([id, heatmap]) => [`${id}:4`, { status: "Included", heatmap }])),
    });
    const saved = await planSavedHeatmapFigures({ ...options, loadHeatmap });
    for (const plan of [eager, saved]) {
      let figure = plan.figures.find((item) => item.kind === "comparison" && item.metric === "estimated-collagen-density");
      if (!figure.values) figure = await hydrateHeatmapFigure(figure, { loadHeatmap });
      expect(figure.values.slice(0, 4)).toEqual([8, -8, 0, null]);
      expect(figure.colorRange).toEqual({ min: -8, max: 8 });
      expect(gridBounds(buildHeatmapFigureSvg(figure)).slice(2)).toEqual([60, 60]);
    }
  });

  test("checks actual cell layout before planning or hydrating comparisons", async () => {
    const heatmaps = new Map([["T01", centeredMap("T01")], ["T02", centeredMap("T02")]]);
    const options = { images: [{ id: "T01" }, { id: "T02" }], cellSizes: [4], calibration };
    const loadHeatmap = async (_storage, id) => heatmaps.get(id);
    const compatible = await planSavedHeatmapFigures({ ...options, loadHeatmap });
    const descriptor = compatible.figures.find((figure) => figure.kind === "comparison");
    // An interior cell catches planners that compare only axis summaries or dimensions.
    heatmaps.get("T02").cells[5].x += 1;
    const eager = planHeatmapFigures({
      ...options,
      sources: new Map([...heatmaps].map(([id, heatmap]) => [`${id}:4`, { status: "Included", heatmap }])),
    });
    const saved = await planSavedHeatmapFigures({ ...options, loadHeatmap });
    for (const plan of [eager, saved]) {
      expect(plan.figures.filter((figure) => figure.kind === "comparison")).toEqual([]);
      expect(plan.reportEntries.filter((entry) => entry.kind === "comparison")).toHaveLength(2);
      expect(plan.reportEntries.every((entry) => entry.reason.includes("grid alignment"))).toBe(true);
    }
    await expect(hydrateHeatmapFigure(descriptor, { loadHeatmap })).rejects.toThrow("grid alignment");
  });

  test("bounds the geometry raster by display size even for enormous source dimensions", async () => {
    const heatmap = centeredMap();
    const multiplier = 10_000_000;
    for (const key of ["width", "height", "cellWidth", "cellHeight"]) heatmap[key] *= multiplier;
    for (const cell of heatmap.cells) {
      for (const key of ["x", "y", "width", "height"]) cell[key] *= multiplier;
    }
    const { figures } = planHeatmapFigures({
      images: [{ id: "T01" }],
      sources: new Map([["T01:4", { status: "Included", heatmap }]]),
      cellSizes: [4], calibration,
    });
    const figure = { ...figures[0], cellDisplaySize: 100_000 };
    expect(gridBounds(buildHeatmapFigureSvg(figure)).slice(2)).toEqual([4096, 4096]);
    const png = await renderHeatmapFigure(figure);
    const metadata = await sharp(png).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBeLessThan(4600);
    expect(metadata.height).toBeLessThan(4600);
  }, 30_000);

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

  test("uses a custom color maximum only for absolute estimated-density figures", () => {
    const images = [{ id: "T01", imageFolder: "T01" }, { id: "T02", imageFolder: "T02" }];
    const sources = new Map([
      ["T01:20", { status: "Included", heatmap: map("T01", [0.1, 0.2]) }],
      ["T02:20", { status: "Included", heatmap: map("T02", [0.2, 0.3]) }],
    ]);

    const plan = planHeatmapFigures({
      images,
      sources,
      calibration,
      estimatedCollagenColorMax: 4,
    });
    const absolute = plan.figures.find(
      (figure) => figure.kind === "absolute" && figure.metric === "estimated-collagen-density",
    );
    const comparison = plan.figures.find(
      (figure) => figure.kind === "comparison" && figure.metric === "estimated-collagen-density",
    );

    expect(absolute.colorRange).toEqual({ min: 0, max: 4 });
    expect(comparison.colorRange).toEqual({
      min: -comparison.colorRange.max,
      max: comparison.colorRange.max,
    });
    expect(comparison.colorRange.max).not.toBe(4);
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
      calibration,
    };

    const svg = buildHeatmapFigureSvg(figure);
    const tickLabels = [...svg.matchAll(/<text class="tick"[^>]*>([^<]+)<\/text>/g)]
      .map((match) => match[1]);

    expect(tickLabels).toEqual([
      "0", "0", "2", "2", "4", "4", "6", "6", "8", "8",
      "0.5", "0.25", "0", "-0.25", "-0.5", "No data",
    ]);
    expect(svg).not.toContain("Density model:");
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
    expect(svg).toContain("Density model: Area Fraction = 0.2631 - 0.2431 * exp(-0.2662 * Collagen Density)");
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
