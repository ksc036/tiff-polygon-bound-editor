import { access, readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createHeatmapDataExport } from "./exportHeatmapData.js";

function grid(count = 1) {
  return { schemaVersion: 1, imageFolder: "T01", width: count, height: 1,
    cellWidth: 1, cellHeight: 1, columns: count, rows: 1,
    cells: Array.from({ length: count }, (_, column) => ({ row: 0, column, x: column, y: 0,
      width: 1, height: 1, areaPx: 1, maskPixelCount: 0, pixelDensity: 0 })) };
}

test("grid export preserves chunk boundaries and snapshots each image without modifying its source", async () => {
  const source = grid(513);
  const before = structuredClone(source);
  const data = await createHeatmapDataExport({ cellSizes: [1], calibration: { modelId: "high-density", revision: 2 }, colorMax: 8 });
  let outputPath;
  try {
    await data.appendImage({ cellSize: 1, image: { id: "T01", imageFile: "T01.tif" }, source });
    expect(source).toEqual(before);
    source.cells[256].pixelDensity = 1;
    await data.appendImage({ cellSize: 1, image: { id: "T02", imageFile: "T02.tif" }, source: grid(2) });
    expect(data.hasImage(1, "T01")).toBe(true);
    const files = await data.finalize();
    expect(files.map((file) => file.name)).toEqual(["1x1.json"]);
    outputPath = files[0].path;
    const json = JSON.parse(await readFile(outputPath, "utf8"));
    expect(json.images.map((image) => image.id)).toEqual(["T01", "T02"]);
    expect(json.calibration).toMatchObject({ modelId: "high-density", revision: 2, colorMax: 8 });
    expect(json.images[0].cells).toHaveLength(513);
    expect(json.images[0].cells[256]).toMatchObject({ column: 256, x: 256, pixelDensity: 0, displayValue: 0 });
    expect(json.images[0].cells[512]).toMatchObject({ column: 512, x: 512 });
  } finally {
    await data.dispose();
  }
  await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("grid export distinguishes no-data cells from unavailable images", async () => {
  const source = grid();
  source.cells[0] = { ...source.cells[0], pixelDensity: null, empty: true };
  const data = await createHeatmapDataExport({ cellSizes: [1, 2], calibration: { modelId: "low-density" }, colorMax: 3 });
  try {
    await data.appendImage({ cellSize: 1, image: { id: "T01" }, source });
    await data.appendImage({ cellSize: 1, image: { id: "T02" }, reason: "Saved heatmap is missing." });
    const files = await data.finalize();
    const json = JSON.parse(await readFile(files[0].path, "utf8"));
    expect(json.images[0].cells[0]).toMatchObject({ estimatedCollagenDensity: null,
      heatmapValue: null, displayValue: null, displayColor: "#80858b", concentrationStatus: "no-data" });
    expect(json.images[1]).toMatchObject({ id: "T02", status: "unavailable", reason: "Saved heatmap is missing.", cells: [] });
    expect(JSON.parse(await readFile(files[1].path, "utf8")).images).toEqual([]);
  } finally {
    await data.dispose();
  }
});

test("cancelling grid export interrupts serialization and releases its temporary files", async () => {
  const controller = new AbortController();
  const data = await createHeatmapDataExport({ cellSizes: [1], calibration: { modelId: "high-density" },
    colorMax: 8, signal: controller.signal });
  try {
    const writing = data.appendImage({ cellSize: 1, image: { id: "T01" }, source: grid(10_000) });
    controller.abort();
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    expect(data.hasImage(1, "T01")).toBe(false);
    await expect(data.finalize()).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    await data.dispose();
  }
});
