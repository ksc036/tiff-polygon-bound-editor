import { expect, test } from "vitest";
import {
  buildMaskHeatmapGrid,
  createHeatmapPayload,
  validateCellSize,
  validateHeatmapPayload,
} from "./maskHeatmap.js";

test("includes partial right and bottom cells using actual area", () => {
  const mask = { width: 5, height: 3, data: new Uint8Array(15) };
  mask.data[0] = 1;
  mask.data[4] = 1;
  mask.data[14] = 1;

  const grid = buildMaskHeatmapGrid({ mask, cellSize: 2 });

  expect({ columns: grid.columns, rows: grid.rows }).toEqual({ columns: 3, rows: 2 });
  expect(grid.cells.find((cell) => cell.row === 0 && cell.column === 2)).toMatchObject({
    x: 4,
    y: 0,
    width: 1,
    height: 2,
    areaPx: 2,
    maskPixelCount: 1,
    pixelDensity: 0.5,
  });
  expect(grid.cells.at(-1)).toMatchObject({ width: 1, height: 1, areaPx: 1, pixelDensity: 1 });
});

test("keeps rectangular masks in row-major order", () => {
  const mask = { width: 6, height: 2, data: new Uint8Array(12) };
  mask.data[5] = 1;

  expect(buildMaskHeatmapGrid({ mask, cellSize: 2 }).cells.map((cell) => cell.pixelDensity)).toEqual([
    0,
    0,
    0.25,
  ]);
});

test("rejects invalid cell sizes and malformed saved payloads", () => {
  expect(() => validateCellSize(0)).toThrow("cell size");
  expect(() => validateCellSize(2.5)).toThrow("cell size");
  expect(() => validateHeatmapPayload({ schemaVersion: 1, cells: [] }, { cellSize: 5 })).toThrow(
    "heatmap",
  );
});

test("rejects generated grids above the one-million-cell budget", () => {
  const mask = { width: 1_000_001, height: 1, data: new Uint8Array(1_000_001) };

  expect(() => buildMaskHeatmapGrid({ mask, cellSize: 1 })).toThrow(
    "Heatmap grid exceeds the 1,000,000 cell limit.",
  );
});

test("rejects saved payload dimensions above the one-million-cell budget", () => {
  const payload = {
    schemaVersion: 1,
    imageFolder: "images/sample",
    maskSource: { file: "masks/sample.png" },
    width: 1_000_001,
    height: 1,
    cellWidth: 1,
    cellHeight: 1,
    columns: 1_000_001,
    rows: 1,
    cells: [],
    updatedAt: "2026-07-12T00:00:00.000Z",
  };

  expect(() => validateHeatmapPayload(payload, { cellSize: 1 })).toThrow(
    "Heatmap grid exceeds the 1,000,000 cell limit.",
  );
});

test("creates and validates a relative heatmap payload", () => {
  const payload = createHeatmapPayload({
    imageFolder: "images/sample",
    maskSource: { file: "masks/sample.png", format: "png" },
    mask: { width: 2, height: 1, data: new Uint8Array([1, 0]) },
    cellSize: 1,
    updatedAt: "2026-07-12T00:00:00.000Z",
  });

  expect(payload).toMatchObject({
    schemaVersion: 1,
    imageFolder: "images/sample",
    maskSource: { file: "masks/sample.png" },
    width: 2,
    height: 1,
    cellWidth: 1,
    cellHeight: 1,
    columns: 2,
    rows: 1,
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(validateHeatmapPayload(payload, { cellSize: 1 })).toEqual(payload);
});

test("serializes only public mask source fields and strips path", () => {
  const maskSource = {
    file: "masks/sample.png",
    mtimeMs: 12,
    size: 345,
    format: "png",
    path: "/private/masks/sample.png",
  };
  const payload = createHeatmapPayload({
    imageFolder: "images/sample",
    maskSource,
    mask: { width: 1, height: 1, data: new Uint8Array([1]) },
    cellSize: 1,
    updatedAt: "2026-07-12T00:00:00.000Z",
  });

  expect(payload.maskSource).toEqual({ file: "masks/sample.png", mtimeMs: 12, size: 345 });
  expect(JSON.stringify(payload)).not.toContain("/private/masks/sample.png");
  expect(JSON.stringify(payload)).not.toContain('"format"');

  const validated = validateHeatmapPayload({ ...payload, maskSource }, { cellSize: 1 });
  expect(validated.maskSource).toEqual({ file: "masks/sample.png", mtimeMs: 12, size: 345 });
  expect(JSON.stringify(validated)).not.toContain("/private/masks/sample.png");
  expect(JSON.stringify(validated)).not.toContain('"format"');
});

test("returns a closed public DTO without unknown top-level or cell fields", () => {
  const payload = createHeatmapPayload({
    imageFolder: "images/sample",
    maskSource: { file: "masks/sample.png", mtimeMs: 12, size: 345 },
    mask: { width: 1, height: 1, data: new Uint8Array([1]) },
    cellSize: 1,
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  const validated = validateHeatmapPayload(
    {
      ...payload,
      sourcePath: "/private/mask.png",
      cells: [{ ...payload.cells[0], sourcePath: "/private/cell-mask.png" }],
    },
    { cellSize: 1 },
  );

  expect(validated).toEqual(payload);
  expect(validated).not.toHaveProperty("sourcePath");
  expect(validated.cells[0]).not.toHaveProperty("sourcePath");
});

test.each(["/tmp/mask.png", "C:\\tmp\\mask.png", "\\\\server\\share\\mask.png"])(
  "rejects absolute source metadata: %s",
  (maskFile) => {
    expect(() =>
      createHeatmapPayload({
        imageFolder: "images/sample",
        maskSource: { file: maskFile, format: "png" },
        mask: { width: 1, height: 1, data: new Uint8Array([1]) },
        cellSize: 1,
        updatedAt: "2026-07-12T00:00:00.000Z",
      }),
    ).toThrow("relative");
  },
);

test("rejects payloads with a mismatched expected cell size", () => {
  const payload = createHeatmapPayload({
    imageFolder: "images/sample",
    maskSource: { file: "masks/sample.png", format: "png" },
    mask: { width: 2, height: 2, data: new Uint8Array([1, 0, 0, 1]) },
    cellSize: 1,
    updatedAt: "2026-07-12T00:00:00.000Z",
  });

  expect(() => validateHeatmapPayload(payload, { cellSize: 2 })).toThrow("cell size");
});

test("rejects non-integer grid dimensions and out-of-range density", () => {
  const payload = createHeatmapPayload({
    imageFolder: "images/sample",
    maskSource: { file: "masks/sample.png", format: "png" },
    mask: { width: 1, height: 1, data: new Uint8Array([1]) },
    cellSize: 1,
    updatedAt: "2026-07-12T00:00:00.000Z",
  });

  expect(() => validateHeatmapPayload({ ...payload, columns: "1" }, { cellSize: 1 })).toThrow("columns");
  expect(() =>
    validateHeatmapPayload(
      { ...payload, cells: [{ ...payload.cells[0], pixelDensity: 2 }] },
      { cellSize: 1 },
    ),
  ).toThrow("density");
});

test.each([
  "../private/mask.png",
  "..\\private\\mask.png",
  "images/../../private",
  "images\\..\\..\\private",
  ".",
  "..",
])("rejects traversal in createHeatmapPayload metadata: %s", (pathValue) => {
  expect(() =>
    createHeatmapPayload({
      imageFolder: pathValue,
      maskSource: { file: "masks/sample.png", format: "png" },
      mask: { width: 1, height: 1, data: new Uint8Array([1]) },
      cellSize: 1,
      updatedAt: "2026-07-12T00:00:00.000Z",
    }),
  ).toThrow("relative");

  expect(() =>
    createHeatmapPayload({
      imageFolder: "images/sample",
      maskSource: { file: pathValue, format: "png" },
      mask: { width: 1, height: 1, data: new Uint8Array([1]) },
      cellSize: 1,
      updatedAt: "2026-07-12T00:00:00.000Z",
    }),
  ).toThrow("relative");
});

test("rejects traversal in validateHeatmapPayload metadata", () => {
  const payload = createHeatmapPayload({
    imageFolder: "images/sample",
    maskSource: { file: "masks/sample.png", format: "png" },
    mask: { width: 1, height: 1, data: new Uint8Array([1]) },
    cellSize: 1,
    updatedAt: "2026-07-12T00:00:00.000Z",
  });

  expect(() => validateHeatmapPayload({ ...payload, imageFolder: "images/../../private" }, { cellSize: 1 })).toThrow(
    "relative",
  );
  expect(() =>
    validateHeatmapPayload(
      { ...payload, maskSource: { ...payload.maskSource, file: "masks\\..\\..\\private" } },
      { cellSize: 1 },
    ),
  ).toThrow("relative");
});

test("records timestamps without using their format or presence for payload validity", () => {
  const payload = createHeatmapPayload({
    imageFolder: "images/sample",
    maskSource: { file: "masks/sample.png", format: "png" },
    mask: { width: 1, height: 1, data: new Uint8Array([1]) },
    cellSize: 1,
    updatedAt: "copied-without-original-clock",
  });

  expect(payload.updatedAt).toBe("copied-without-original-clock");
  expect(validateHeatmapPayload(payload, { cellSize: 1 }).updatedAt).toBe("copied-without-original-clock");

  const withoutTimestamp = { ...payload };
  delete withoutTimestamp.updatedAt;
  expect(validateHeatmapPayload(withoutTimestamp, { cellSize: 1 }).updatedAt).toBeNull();
});

test("strips malformed recorded mask times without invalidating heatmap data", () => {
  const payload = createHeatmapPayload({
    imageFolder: "images/sample",
    maskSource: { file: "masks/sample.png", size: 123, mtimeMs: "not-a-time" },
    mask: { width: 1, height: 1, data: new Uint8Array([1]) },
    cellSize: 1,
  });

  expect(payload.maskSource).toEqual({ file: "masks/sample.png", size: 123 });
  expect(validateHeatmapPayload(payload, { cellSize: 1 }).maskSource).toEqual({
    file: "masks/sample.png",
    size: 123,
  });
});
