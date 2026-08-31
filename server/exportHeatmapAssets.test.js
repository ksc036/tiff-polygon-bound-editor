import sharp from "sharp";
import { describe, expect, test, vi } from "vitest";
import { pixelDensityFromCollagenDensity } from "../shared/collagenDensity.js";
import { differenceColor, infernoColor } from "../src/lib/heatmap.js";
import {
  hydrateEstimatedHeatmapAsset,
  planEstimatedHeatmapAssets,
  renderEstimatedHeatmapAsset,
  renderHeatmapScaleAsset,
} from "./exportHeatmapAssets.js";

const CELL_SIZES = [20, 50, 100];
const METRIC = "estimated-collagen-density";

function heatmap(cellSize, densities, { width = 120, height = 20 } = {}) {
  const columns = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  if (densities.length !== columns * rows) {
    throw new Error(`Expected ${columns * rows} densities for a ${columns}x${rows} heatmap.`);
  }

  return {
    width,
    height,
    cellWidth: cellSize,
    cellHeight: cellSize,
    columns,
    rows,
    cells: densities.map((density, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      return {
        row,
        column,
        x: column * cellSize,
        y: row * cellSize,
        width: Math.min(cellSize, width - column * cellSize),
        height: Math.min(cellSize, height - row * cellSize),
        pixelDensity: pixelDensityFromCollagenDensity(density),
      };
    }),
  };
}

function image(id) {
  return { id, imageFolder: id };
}

function crop(x, { width = 20, height = 20 } = {}) {
  return { sourceWidth: 120, sourceHeight: 20, x, y: 0, width, height };
}

function loaderFor(entries) {
  const sources = new Map(entries);
  return vi.fn(async (_storage, id, cellSize) => {
    const source = sources.get(`${id}:${cellSize}`);
    if (source instanceof Error) throw source;
    if (!source) {
      const error = new Error("missing");
      error.code = "MISSING_HEATMAP";
      throw error;
    }
    return source;
  });
}

function completeSources(ids = ["T01", "T02", "T03"]) {
  return ids.flatMap((id, imageIndex) => CELL_SIZES.map((cellSize) => {
    const columns = Math.ceil(120 / cellSize);
    return [
      `${id}:${cellSize}`,
      heatmap(cellSize, Array.from({ length: columns }, (_, column) => imageIndex + column)),
    ];
  }));
}

function sourceDimensionsFor(images) {
  return new Map(images.map(({ id }) => [id, { width: 120, height: 20 }]));
}

function rgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function pixelAt(decoded, x, y) {
  const offset = (y * decoded.info.width + x) * decoded.info.channels;
  return [...decoded.data.subarray(offset, offset + 3)];
}

describe("estimated collagen heatmap asset planning", () => {
  test("plans lightweight estimated-density assets and current-minus-previous pairs only", async () => {
    const images = [image("T01"), image("T02"), image("T03")];
    const cropsByImage = new Map(images.map(({ id }) => [id, crop(20)]));
    const loadHeatmap = loaderFor(completeSources());

    const plan = await planEstimatedHeatmapAssets({
      storage: {},
      images,
      cropsByImage,
      sourceDimensionsByImage: sourceDimensionsFor(images),
      loadHeatmap,
    });

    expect(plan.descriptors).toHaveLength(30);
    expect(plan.descriptors.every((entry) => entry.metric === METRIC)).toBe(true);
    expect(plan.descriptors.some(
      (entry) => entry.currentImage === "T01" && entry.kind.startsWith("comparison"),
    )).toBe(false);
    expect(plan.descriptors.find(
      (entry) => entry.currentImage === "T02" && entry.kind === "comparison-full",
    )).toMatchObject({ previousImage: "T01", currentImageId: "T02", previousImageId: "T01" });
    expect(plan.descriptors.find(
      (entry) => entry.currentImage === "T03" && entry.kind === "comparison-full",
    )).toMatchObject({ previousImage: "T02", currentImageId: "T03", previousImageId: "T02" });
    expect(plan.descriptors.every((entry) =>
      !("heatmap" in entry) && !("values" in entry) && !("valueAt" in entry)
    )).toBe(true);
    expect(loadHeatmap).toHaveBeenCalledTimes(21);
  });

  test("compares equal-sized crops at independent source coordinates", async () => {
    const current = heatmap(20, [0, 6, 0, 0, 0, 0]);
    const previous = heatmap(20, [2, 0, 0, 0, 0, 0]);
    const loadHeatmap = loaderFor([
      ["T01:20", previous],
      ["T02:20", current],
    ]);
    const descriptor = {
      kind: "comparison-subimage",
      metric: METRIC,
      currentImage: "T02",
      currentImageId: "T02",
      previousImage: "T01",
      previousImageId: "T01",
      sourceCellSize: 20,
      width: 20,
      height: 20,
      currentCrop: crop(20),
      previousCrop: crop(0),
      maxAbs: 4,
    };

    const asset = await hydrateEstimatedHeatmapAsset(descriptor, {
      storage: {},
      loadHeatmap,
    });

    expect(asset.values[0]).toBeCloseTo(4, 10);
    expect(asset.valueAt(0, 0)).toBeCloseTo(4, 10);
    expect(loadHeatmap.mock.calls.map(([, id, cellSize]) => `${id}:${cellSize}`)).toEqual([
      "T02:20",
      "T01:20",
    ]);
  });

  test("skips only Subimage comparisons whose crop dimensions differ", async () => {
    const images = [image("T01"), image("T02")];
    const plan = await planEstimatedHeatmapAssets({
      storage: {},
      images,
      cropsByImage: new Map([
        ["T01", crop(0)],
        ["T02", crop(20, { width: 19 })],
      ]),
      sourceDimensionsByImage: sourceDimensionsFor(images),
      loadHeatmap: loaderFor(completeSources(["T01", "T02"])),
    });

    expect(plan.descriptors.filter((entry) => entry.kind === "comparison-full")).toHaveLength(3);
    expect(plan.descriptors.filter((entry) => entry.kind === "comparison-subimage")).toHaveLength(0);
    expect(plan.reportEntries.filter(
      (entry) => entry.kind === "comparison-subimage" &&
        entry.reason === "Subimage dimensions do not match previous image.",
    )).toHaveLength(3);
  });

  test.each([
    ["non-integer source width", { sourceWidth: 120.5 }],
    ["non-integer source height", { sourceHeight: 20.5 }],
    ["non-integer x", { x: 0.5 }],
    ["non-integer y", { y: 0.5 }],
    ["non-integer width", { width: 19.5 }],
    ["non-integer height", { height: 19.5 }],
    ["non-positive width", { width: 0 }],
    ["non-positive height", { height: 0 }],
    ["mismatched source width", { sourceWidth: 121 }],
    ["mismatched source height", { sourceHeight: 21 }],
    ["horizontal overflow", { x: 110 }],
    ["vertical overflow", { y: 10 }],
  ])("skips absolute Subimage descriptors for %s", async (_name, overrides) => {
    const invalidCrop = { ...crop(0), ...overrides };
    const images = [image("T01")];
    const plan = await planEstimatedHeatmapAssets({
      storage: {},
      images,
      cropsByImage: new Map([["T01", invalidCrop]]),
      sourceDimensionsByImage: sourceDimensionsFor(images),
      loadHeatmap: loaderFor(completeSources(["T01"])),
    });

    expect(plan.descriptors.filter((entry) => entry.kind === "absolute-full")).toHaveLength(3);
    expect(plan.descriptors.filter((entry) => entry.kind === "absolute-subimage")).toHaveLength(0);
    expect(plan.reportEntries.filter((entry) =>
      entry.kind === "absolute-subimage" &&
      entry.reason === "Saved Subimage crop is invalid for this heatmap."
    )).toHaveLength(3);
  });

  test("skips a comparison Subimage when the previous crop belongs to different heatmap dimensions", async () => {
    const images = [image("T01"), image("T02")];
    const plan = await planEstimatedHeatmapAssets({
      storage: {},
      images,
      cropsByImage: new Map([
        ["T01", { ...crop(0), sourceWidth: 121 }],
        ["T02", crop(20)],
      ]),
      sourceDimensionsByImage: sourceDimensionsFor(images),
      loadHeatmap: loaderFor(completeSources(["T01", "T02"])),
    });

    expect(plan.descriptors.filter((entry) => entry.kind === "comparison-full")).toHaveLength(3);
    expect(plan.descriptors.filter((entry) => entry.kind === "comparison-subimage")).toHaveLength(0);
    expect(plan.reportEntries.filter((entry) =>
      entry.kind === "comparison-subimage" &&
      entry.reason === "Previous Subimage crop is invalid for its heatmap."
    )).toHaveLength(3);
    expect(plan.reportEntries.map((entry) => entry.message).join(" ")).not.toContain("121");
  });

  test("missing heatmaps skip their absolute and dependent comparison outputs", async () => {
    const images = [image("T01"), image("T02"), image("T03")];
    const entries = completeSources();
    const missing = new Error("missing");
    missing.code = "MISSING_HEATMAP";
    entries.splice(entries.findIndex(([key]) => key === "T02:50"), 1, ["T02:50", missing]);

    const plan = await planEstimatedHeatmapAssets({
      storage: {},
      images,
      cropsByImage: new Map(images.map(({ id }) => [id, crop(20)])),
      sourceDimensionsByImage: sourceDimensionsFor(images),
      loadHeatmap: loaderFor(entries),
    });

    expect(plan.descriptors.some((entry) =>
      entry.sourceCellSize === 50 &&
      (entry.currentImageId === "T02" || entry.previousImageId === "T02")
    )).toBe(false);
    expect(plan.descriptors.some((entry) =>
      entry.sourceCellSize === 20 && entry.currentImageId === "T02"
    )).toBe(true);
    expect(plan.reportEntries.some((entry) =>
      entry.currentImage === "T02" &&
      entry.sourceCellSize === 50 &&
      entry.reason === "Saved heatmap is missing."
    )).toBe(true);
    expect(plan.reportEntries.filter((entry) =>
      entry.sourceCellSize === 50 && entry.kind.startsWith("comparison")
    )).toHaveLength(4);
  });

  test("skips stale heatmaps and every dependent output when current TIFF dimensions differ", async () => {
    const images = [image("T01"), image("T02")];
    const mismatchReason = "Saved heatmap dimensions do not match the current TIFF.";

    const plan = await planEstimatedHeatmapAssets({
      storage: {},
      images,
      cropsByImage: new Map(images.map(({ id }) => [id, crop(20)])),
      sourceDimensionsByImage: new Map([
        ["T01", { width: 120, height: 20 }],
        ["T02", { width: 121, height: 20 }],
      ]),
      loadHeatmap: loaderFor(completeSources(["T01", "T02"])),
    });

    expect(plan.descriptors.some((entry) =>
      entry.currentImageId === "T02" || entry.previousImageId === "T02"
    )).toBe(false);
    expect(plan.reportEntries.filter((entry) =>
      entry.currentImage === "T02" &&
      entry.kind.startsWith("absolute") &&
      entry.reason === mismatchReason
    )).toHaveLength(6);
    expect(plan.reportEntries.filter((entry) =>
      entry.currentImage === "T02" &&
      entry.kind.startsWith("comparison") &&
      entry.reason.includes(mismatchReason)
    )).toHaveLength(6);
    expect(plan.reportEntries.map((entry) => entry.reason).join(" ")).not.toContain("121");
  });

  test("reports unavailable current TIFF dimensions instead of trusting saved heatmaps", async () => {
    const reason = "Current TIFF dimensions are unavailable for heatmap validation.";
    const plan = await planEstimatedHeatmapAssets({
      storage: {},
      images: [image("T01")],
      loadHeatmap: loaderFor(completeSources(["T01"])),
    });

    expect(plan.descriptors).toHaveLength(0);
    expect(plan.reportEntries).toHaveLength(6);
    expect(plan.reportEntries.every((entry) =>
      entry.status === "Skipped" && entry.reason === reason
    )).toBe(true);
  });

  test("shares per-cell-size comparison ranges across full and Subimage maxima", async () => {
    const images = [image("T01"), image("T02")];
    const loadHeatmap = loaderFor([
      ["T01:20", heatmap(20, [0, 0, 0, 0, 0, 8])],
      ["T02:20", heatmap(20, [1, 0, 0, 0, 0, 7])],
      ["T01:50", heatmap(50, [0, 0, 0])],
      ["T02:50", heatmap(50, [6, 0, 0])],
      ["T01:100", heatmap(100, [0, 8])],
      ["T02:100", heatmap(100, [3, 4])],
    ]);

    const plan = await planEstimatedHeatmapAssets({
      storage: {},
      images,
      cropsByImage: new Map([
        ["T01", crop(0)],
        ["T02", crop(100)],
      ]),
      sourceDimensionsByImage: sourceDimensionsFor(images),
      loadHeatmap,
    });

    expect([...plan.ranges]).toEqual([[20, 7], [50, 6], [100, 4]]);
    for (const descriptor of plan.descriptors.filter((entry) => entry.kind.startsWith("comparison"))) {
      expect(descriptor.maxAbs).toBe(plan.ranges.get(descriptor.sourceCellSize));
    }
  });
});

describe("estimated collagen heatmap asset rendering", () => {
  test("renders a heatmap-only full PNG at source dimensions using collagen density colors", async () => {
    const source = heatmap(1, [0, 4, 8], { width: 3, height: 1 });
    const descriptor = {
      kind: "absolute-full",
      metric: METRIC,
      currentImage: "T01",
      currentImageId: "T01",
      previousImage: null,
      previousImageId: null,
      sourceCellSize: 20,
      width: 3,
      height: 1,
      currentCrop: null,
      colorRange: { min: 0, max: 8 },
    };
    const asset = await hydrateEstimatedHeatmapAsset(descriptor, {
      storage: {},
      loadHeatmap: loaderFor([["T01:20", source]]),
    });

    const decoded = await sharp(await renderEstimatedHeatmapAsset(asset)).raw().toBuffer({
      resolveWithObject: true,
    });

    expect(decoded.info).toMatchObject({ width: 3, height: 1, channels: 3 });
    expect(pixelAt(decoded, 0, 0)).toEqual(rgb(infernoColor(0, 0, 8)));
    expect(pixelAt(decoded, 1, 0)).toEqual(rgb(infernoColor(4, 0, 8)));
    expect(pixelAt(decoded, 2, 0)).toEqual(rgb(infernoColor(8, 0, 8)));
    expect(pixelAt(decoded, 1, 0)).not.toEqual(rgb(infernoColor(source.cells[1].pixelDensity, 0, 8)));
  });

  test("renders a Subimage PNG at exact crop dimensions and source coordinates", async () => {
    const source = heatmap(1, [8, 0, 8, 0, 0, 8, 0, 8], { width: 4, height: 2 });
    const descriptor = {
      kind: "absolute-subimage",
      metric: METRIC,
      currentImage: "T01",
      currentImageId: "T01",
      previousImage: null,
      previousImageId: null,
      sourceCellSize: 20,
      width: 2,
      height: 2,
      currentCrop: { sourceWidth: 4, sourceHeight: 2, x: 1, y: 0, width: 2, height: 2 },
      colorRange: { min: 0, max: 8 },
    };
    const asset = await hydrateEstimatedHeatmapAsset(descriptor, {
      storage: {},
      loadHeatmap: loaderFor([["T01:20", source]]),
    });

    const decoded = await sharp(await renderEstimatedHeatmapAsset(asset)).raw().toBuffer({
      resolveWithObject: true,
    });

    expect(decoded.info).toMatchObject({ width: 2, height: 2, channels: 3 });
    expect(pixelAt(decoded, 0, 0)).toEqual(rgb(infernoColor(0, 0, 8)));
    expect(pixelAt(decoded, 1, 0)).toEqual(rgb(infernoColor(8, 0, 8)));
    expect(pixelAt(decoded, 0, 1)).toEqual(rgb(infernoColor(8, 0, 8)));
    expect(pixelAt(decoded, 1, 1)).toEqual(rgb(infernoColor(0, 0, 8)));
  });

  test("renders comparison pixels with the canonical blue-white-red scale", async () => {
    const values = [-2, 0, 2];
    const asset = {
      kind: "comparison-full",
      metric: METRIC,
      width: 3,
      height: 1,
      isComparison: true,
      maxAbs: 2,
      valueAt: (x) => values[x],
    };

    const decoded = await sharp(await renderEstimatedHeatmapAsset(asset)).raw().toBuffer({
      resolveWithObject: true,
    });

    expect(pixelAt(decoded, 0, 0)).toEqual(rgb(differenceColor(-2, 2)));
    expect(pixelAt(decoded, 1, 0)).toEqual(rgb(differenceColor(0, 2)));
    expect(pixelAt(decoded, 2, 0)).toEqual(rgb(differenceColor(2, 2)));
  });

  test("rejects an asset above the configured image-pixel limit before sampling", async () => {
    const valueAt = vi.fn(() => 0);

    await expect(renderEstimatedHeatmapAsset({
      kind: "absolute-full",
      width: 3,
      height: 2,
      valueAt,
    }, { maxImagePixels: 5 })).rejects.toThrow(
      "Heatmap asset exceeds the configured maximum image pixel count.",
    );
    expect(valueAt).not.toHaveBeenCalled();
  });

  test.each([
    ["width-height product", Number.MAX_SAFE_INTEGER, 2],
    ["RGB byte count", Math.floor(Number.MAX_SAFE_INTEGER / 2), 1],
  ])("rejects an unsafe %s before allocation", async (_name, width, height) => {
    const valueAt = vi.fn(() => 0);

    await expect(renderEstimatedHeatmapAsset({
      kind: "absolute-full",
      width,
      height,
      valueAt,
    }, { maxImagePixels: Number.MAX_SAFE_INTEGER })).rejects.toThrow(
      "Heatmap asset dimensions exceed safe allocation limits.",
    );
    expect(valueAt).not.toHaveBeenCalled();
  });

  test("rejects a pre-aborted render before sampling or allocation", async () => {
    const controller = new AbortController();
    const valueAt = vi.fn(() => 0);
    controller.abort();

    await expect(renderEstimatedHeatmapAsset({
      kind: "absolute-full",
      width: 1,
      height: 1,
      valueAt,
    }, { signal: controller.signal, maxImagePixels: 1 })).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
    });
    expect(valueAt).not.toHaveBeenCalled();
  });

  test("yields so an external abort stops pixel rasterization and a retry renders completely", async () => {
    const controller = new AbortController();
    let samples = 0;
    const width = 1_000;
    const height = 1_000;
    const pixelCount = width * height;
    const valueAt = () => {
      samples += 1;
      return 0;
    };
    const aborted = new Promise((resolve) => {
      setImmediate(() => {
        controller.abort();
        resolve();
      });
    });

    const rendering = renderEstimatedHeatmapAsset({
      kind: "absolute-full",
      width,
      height,
      valueAt,
    }, { signal: controller.signal, maxImagePixels: pixelCount });

    await aborted;
    await expect(rendering).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
    });
    expect(samples).toBeGreaterThan(0);
    expect(samples).toBeLessThanOrEqual(4_096);

    samples = 0;
    const retry = await sharp(await renderEstimatedHeatmapAsset({
      kind: "absolute-full",
      width,
      height,
      valueAt,
    }, { maxImagePixels: pixelCount })).metadata();
    expect(retry).toMatchObject({ width, height, format: "png" });
    expect(samples).toBe(pixelCount);
  });

  test("cancels the active Sharp pipeline and detaches its abort listener", async () => {
    const controller = new AbortController();
    const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
    let resolveSharpStage;
    const sharpStage = new Promise((resolve) => {
      resolveSharpStage = resolve;
    });
    vi.spyOn(controller.signal, "addEventListener").mockImplementation((type, listener, options) => {
      const result = originalAddEventListener(type, listener, options);
      if (type === "abort") resolveSharpStage();
      return result;
    });
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const rendering = renderEstimatedHeatmapAsset({
      kind: "absolute-full",
      width: 256,
      height: 256,
      valueAt: () => 4,
    }, { signal: controller.signal, maxImagePixels: 256 * 256 });
    await sharpStage;
    controller.abort();

    await expect(rendering).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("detaches the Sharp abort listener after a successful encode", async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

    await renderEstimatedHeatmapAsset({
      kind: "absolute-full",
      width: 1,
      height: 1,
      valueAt: () => 4,
    }, { signal: controller.signal, maxImagePixels: 1 });

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("renders a detached vertical absolute scale with fixed metadata and endpoint colors", async () => {
    const decoded = await sharp(await renderHeatmapScaleAsset({ kind: "absolute" })).raw().toBuffer({
      resolveWithObject: true,
    });

    expect(decoded.info).toMatchObject({ width: 220, height: 360, channels: 3 });
    expect(pixelAt(decoded, 28, 40)).toEqual(rgb(infernoColor(8, 0, 8)));
    expect(pixelAt(decoded, 28, 319)).toEqual(rgb(infernoColor(0, 0, 8)));
    expect(pixelAt(decoded, 0, 0)).toEqual([255, 255, 255]);
  });

  test("renders a detached horizontal comparison scale with shared range colors", async () => {
    const decoded = await sharp(await renderHeatmapScaleAsset({
      kind: "comparison",
      cellSize: 20,
      maxAbs: 2,
    })).raw().toBuffer({ resolveWithObject: true });

    expect(decoded.info).toMatchObject({ width: 440, height: 150, channels: 3 });
    expect(pixelAt(decoded, 40, 48)).toEqual(rgb(differenceColor(-2, 2)));
    expect(pixelAt(decoded, 219, 48)).toEqual(rgb(differenceColor(0, 2)));
    expect(pixelAt(decoded, 399, 48)).toEqual(rgb(differenceColor(2, 2)));
    expect(pixelAt(decoded, 0, 0)).toEqual([255, 255, 255]);
  });
});
