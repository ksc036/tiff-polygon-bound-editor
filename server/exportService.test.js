import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import sharp from "sharp";
import unzipper from "unzipper";
import { afterEach, expect, test, vi } from "vitest";
import { generateHeatmapBatch } from "./heatmapService.js";
import { createStorage } from "./storage.js";
import {
  ExportError,
  datasetExportDirectory,
  datasetExportFilename,
  safeArchiveSegment,
  validateExportCalibration,
  writeDatasetZip,
} from "./exportService.js";

const tempRoots = [];

async function createTempRoot(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function openWorkbookEntry(archive, suffix) {
  const entry = archive.files.find((file) => file.path.endsWith(suffix));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await entry.buffer());
  return workbook;
}

async function exportFixtureArchive(fixture) {
  const output = new PassThrough();
  const zipPromise = collectStream(output);
  const writePromise = writeDatasetZip({
    storage: fixture.storage,
    output,
    calibration: { slope: 0.1, intercept: 0 },
  });
  const archive = await unzipper.Open.buffer(await zipPromise);
  await writePromise;
  return archive;
}

function analysisMetrics(maskPixelCount, areaPx) {
  return {
    roiAreaPx: areaPx,
    maskPixelCount,
    density: maskPixelCount / areaPx,
    globalAlignment: 0.8,
    globalOrientationDeg: 10,
    circularVariance: 0.2,
    radialNormalAlignment: null,
    tangentialAlignment: null,
    migrationAlignment: null,
    orientationDispersion: 0.2,
    empty: false,
  };
}

async function writeExportBundle(rootDir, imageFolder, maskPixelCount, { width = 40, height = 40 } = {}) {
  const folderPath = path.join(rootDir, imageFolder);
  const imageDir = path.join(folderPath, "image");
  const maskDir = path.join(folderPath, "mask");
  const boundDir = path.join(folderPath, "bound");
  const analysisDir = path.join(folderPath, "analysis");
  await Promise.all([
    mkdir(imageDir, { recursive: true }),
    mkdir(maskDir, { recursive: true }),
    mkdir(boundDir, { recursive: true }),
    mkdir(analysisDir, { recursive: true }),
  ]);

  const imageFile = `${imageFolder}.tif`;
  const maskFile = `${imageFolder}.png`;
  const areaPx = width * height;
  const imageBytes = await sharp(Buffer.alloc(areaPx, 128), {
    raw: { width, height, channels: 1 },
  }).tiff().toBuffer();
  const mask = Buffer.alloc(areaPx, 0);
  mask.fill(255, 0, maskPixelCount);
  await writeFile(path.join(imageDir, imageFile), imageBytes);
  const maskPath = path.join(maskDir, maskFile);
  await sharp(mask, { raw: { width, height, channels: 1 } }).png().toFile(maskPath);
  const maskMetadata = await stat(maskPath);

  const bounds = {
    schemaVersion: 1,
    imageFolder,
    imageFile,
    width,
    height,
    groups: [{
      id: "whole",
      name: "Whole image",
      color: "#22c55e",
      analysisMode: "inside",
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: width - 1, y: 0 },
        { id: "p3", x: width - 1, y: height - 1 },
        { id: "p4", x: 0, y: height - 1 },
      ],
    }],
  };
  const analysis = {
    schemaVersion: 5,
    imageFolder,
    imageFile,
    maskSource: {
      file: maskFile,
      format: "png",
      width,
      height,
      mtimeMs: maskMetadata.mtimeMs,
    },
    roiBands: [],
    groups: [{
      groupId: "whole",
      groupName: "Whole image",
      analysisMode: "inside",
      area: analysisMetrics(maskPixelCount, areaPx),
    }],
    updatedAt: "2026-07-27T01:00:00.000Z",
  };
  await writeFile(path.join(boundDir, `${imageFolder}.bounds.json`), JSON.stringify(bounds));
  await writeFile(path.join(analysisDir, `${imageFolder}.analysis.json`), JSON.stringify(analysis));
  return { imageBytes, maskBytes: await readFile(maskPath) };
}

async function createExportFixture({ imageFolders, heatmapSizes, dimensionsByImage = {} }) {
  const parent = await createTempRoot("dataset-export-");
  const rootDir = path.join(parent, "fixture");
  await mkdir(rootDir);
  const originalTiffBytes = {};
  const originalMaskBytes = {};
  for (let index = 0; index < imageFolders.length; index += 1) {
    const imageFolder = imageFolders[index];
    const sourceBytes = await writeExportBundle(
      rootDir,
      imageFolder,
      200 + index * 200,
      dimensionsByImage[imageFolder],
    );
    originalTiffBytes[imageFolder] = sourceBytes.imageBytes;
    originalMaskBytes[imageFolder] = sourceBytes.maskBytes;
  }
  await generateHeatmapBatch({ rootPath: rootDir, cellSizes: [20, 50, 100] });
  for (const imageFolder of imageFolders) {
    for (const cellSize of [20, 50, 100]) {
      if (!heatmapSizes[imageFolder].includes(cellSize)) {
        await rm(path.join(rootDir, imageFolder, "heatmap", `${cellSize}x${cellSize}`), {
          recursive: true,
          force: true,
        });
      }
    }
  }
  return {
    rootDir,
    originalTiffBytes,
    originalMaskBytes,
    storage: createStorage({ initialRoot: rootDir }),
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("validates calibration and creates deterministic safe names", () => {
  expect(validateExportCalibration({ slope: 0.069676956982087, intercept: 0.067893820336777 })).toEqual({
    slope: 0.069676956982087,
    intercept: 0.067893820336777,
  });
  expect(() => validateExportCalibration({ slope: 0, intercept: 1 })).toThrow("non-zero");
  expect(datasetExportFilename("/data/Study A", new Date("2026-07-27T01:02:03Z"))).toBe(
    "Study_A_export_20260727-010203.zip",
  );
  expect(datasetExportDirectory("/data/Study A")).toBe("Study_A_export");
  expect(() => safeArchiveSegment("../outside")).toThrow("archive");
  expect(safeArchiveSegment("T:01")).toBe("T:01");
  expect(safeArchiveSegment("Study:")).toBe("Study:");
});

test("wraps storage discovery failures without exposing host paths", async () => {
  const rootPath = "/private/clinical-data/Study A";
  const storage = {
    getRoot: () => rootPath,
    scanImages: async () => {
      throw new Error(`Storage root has no image folders: ${rootPath}`);
    },
  };

  await expect(writeDatasetZip({
    storage,
    output: new PassThrough(),
    calibration: { slope: 0.1, intercept: 0 },
  })).rejects.toMatchObject({
    name: "ExportError",
    code: "EXPORT_FAILED",
    message: "Dataset export failed.",
  });

  try {
    await writeDatasetZip({
      storage,
      output: new PassThrough(),
      calibration: { slope: 0.1, intercept: 0 },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ExportError);
    expect(error.message).not.toContain(rootPath);
    expect(error.cause).toBeUndefined();
  }
});

test("exports every file from one captured root when the active root switches during startup", async () => {
  const parent = await createTempRoot("dataset-root-snapshot-");
  const firstRoot = path.join(parent, "first-dataset");
  const secondRoot = path.join(parent, "second-dataset");
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
  await writeExportBundle(firstRoot, "T01", 100);
  await writeExportBundle(secondRoot, "T01", 200);
  const firstImagePath = path.join(firstRoot, "T01", "image", "T01.tif");
  const secondImagePath = path.join(secondRoot, "T01", "image", "T01.tif");
  await sharp(Buffer.alloc(40 * 40, 32), {
    raw: { width: 40, height: 40, channels: 1 },
  }).tiff().toFile(firstImagePath);
  await sharp(Buffer.alloc(40 * 40, 224), {
    raw: { width: 40, height: 40, channels: 1 },
  }).tiff().toFile(secondImagePath);
  const firstBytes = await readFile(firstImagePath);
  const storage = createStorage({ initialRoot: firstRoot });
  const getRoot = storage.getRoot;
  storage.getRoot = () => {
    const captured = getRoot();
    storage.setRoot(secondRoot);
    return captured;
  };

  const output = new PassThrough();
  const zipPromise = collectStream(output);
  const writePromise = writeDatasetZip({
    storage,
    output,
    calibration: { slope: 0.1, intercept: 0 },
  });
  const archive = await unzipper.Open.buffer(await zipPromise);
  await writePromise;

  const tiff = archive.files.find(
    (file) => file.path === "first_dataset_export/T01/image/T01.tif",
  );
  expect(tiff).toBeDefined();
  expect(await tiff.buffer()).toEqual(firstBytes);
});

test("streams source bytes, reports missing artifacts, and never leaks host paths", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01", "T02"],
    heatmapSizes: { T01: [20, 50, 100], T02: [20, 50] },
  });
  const output = new PassThrough();
  const zipPromise = collectStream(output);
  const writePromise = writeDatasetZip({
    storage: fixture.storage,
    output,
    calibration: { slope: 0.1, intercept: 0 },
    autoSavedImageId: "T02",
    maxImagePixels: 1_000_000,
    now: () => new Date("2026-07-27T01:02:03Z"),
  });
  const zipBuffer = await zipPromise;
  await writePromise;

  const archive = await unzipper.Open.buffer(zipBuffer);
  const names = archive.files.map((file) => file.path);
  expect(names).toContain("fixture_export/T01/image/T01.tif");
  expect(names).toContain("fixture_export/T01/mask/T01.png");
  expect(names).toContain("fixture_export/T01/roi/T01_ROI_overview.png");
  expect(names).toContain("fixture_export/T01/heatmap/20x20/T01_cell_20px_pixel_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/20x20/T01_cell_20px_collagen_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/50x50/T01_cell_50px_pixel_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/50x50/T01_cell_50px_collagen_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/100x100/T01_cell_100px_pixel_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/100x100/T01_cell_100px_collagen_density.png");
  expect(names).toContain("fixture_export/T02/heatmap/20x20/T02_cell_20px_pixel_density_vs_T01.png");
  expect(names).toContain("fixture_export/T02/heatmap/20x20/T02_cell_20px_collagen_density_vs_T01.png");
  expect(names.some((name) => name.includes("/T01_cell_") && name.includes("_vs_"))).toBe(false);
  expect(names.some((name) => name.includes("/100x100/") && name.includes("T02"))).toBe(false);
  expect(names.some((name) => name.endsWith(".bounds.json") || name.endsWith(".analysis.json"))).toBe(false);
  expect(names.join("\n")).not.toContain(fixture.rootDir);

  const tiff = archive.files.find((file) => file.path === "fixture_export/T01/image/T01.tif");
  expect(await tiff.buffer()).toEqual(fixture.originalTiffBytes.T01);
  const mask = archive.files.find((file) => file.path === "fixture_export/T01/mask/T01.png");
  expect(await mask.buffer()).toEqual(fixture.originalMaskBytes.T01);

  const workbook = await openWorkbookEntry(archive, "/T02_statistics.xlsx");
  const reportMessages = workbook.getWorksheet("Export Report").getColumn(4).values;
  expect(reportMessages).toContain("Current bounds auto-saved before export");
  expect(reportMessages).toContain("Recalculate analysis if the auto-saved boundary geometry changed");
  expect(reportMessages).toContain("T02 Pixel Density heatmap skipped: Saved heatmap is missing.");
  expect(JSON.stringify(workbook.worksheets.map((sheet) => sheet.getSheetValues()))).not.toContain(fixture.rootDir);
});

test("keeps saved heatmaps after file times change and skips incompatible adjacent grids", async () => {
  const copiedFixture = await createExportFixture({
    imageFolders: ["T01", "T02"],
    heatmapSizes: { T01: [20, 50, 100], T02: [20, 50, 100] },
  });
  const copiedMaskPath = path.join(copiedFixture.rootDir, "T02", "mask", "T02.png");
  const copiedMaskStat = await stat(copiedMaskPath);
  const changedTime = new Date(copiedMaskStat.mtimeMs + 2_000);
  await utimes(copiedMaskPath, changedTime, changedTime);
  const copiedOutput = new PassThrough();
  const copiedZipPromise = collectStream(copiedOutput);
  const copiedWritePromise = writeDatasetZip({
    storage: copiedFixture.storage,
    output: copiedOutput,
    calibration: { slope: 0.1, intercept: 0 },
  });
  const copiedArchive = await unzipper.Open.buffer(await copiedZipPromise);
  await copiedWritePromise;
  expect(copiedArchive.files.some((file) => file.path.endsWith("/T02_statistics.xlsx"))).toBe(true);
  expect(copiedArchive.files.some((file) => file.path.includes("/T02/heatmap/"))).toBe(true);

  const incompatibleFixture = await createExportFixture({
    imageFolders: ["T01", "T02"],
    heatmapSizes: { T01: [20, 50, 100], T02: [20, 50, 100] },
    dimensionsByImage: { T02: { width: 60, height: 40 } },
  });
  const incompatibleOutput = new PassThrough();
  const incompatibleZipPromise = collectStream(incompatibleOutput);
  const incompatibleWritePromise = writeDatasetZip({
    storage: incompatibleFixture.storage,
    output: incompatibleOutput,
    calibration: { slope: 0.1, intercept: 0 },
  });
  const incompatibleArchive = await unzipper.Open.buffer(await incompatibleZipPromise);
  await incompatibleWritePromise;
  expect(incompatibleArchive.files.some((file) => file.path.includes("_vs_T01.png"))).toBe(false);
  expect(incompatibleArchive.files.some((file) => file.path.endsWith("/T02_statistics.xlsx"))).toBe(true);
});

test("keeps sources, ROI, and workbook when analysis is missing", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  await rm(path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json"));
  const output = new PassThrough();
  const zipPromise = collectStream(output);
  const writePromise = writeDatasetZip({
    storage: fixture.storage,
    output,
    calibration: { slope: 0.1, intercept: 0 },
  });
  const archive = await unzipper.Open.buffer(await zipPromise);
  await writePromise;

  const names = archive.files.map((file) => file.path);
  expect(names).toContain("fixture_export/T01/image/T01.tif");
  expect(names).toContain("fixture_export/T01/mask/T01.png");
  expect(names).toContain("fixture_export/T01/roi/T01_ROI_overview.png");
  expect(names).toContain("fixture_export/T01/statistics/T01_statistics.xlsx");

  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");
  const report = workbook.getWorksheet("Export Report");
  expect(report.getColumn(2).values).toContain("Skipped");
  expect(report.getColumn(4).values).toContain("Saved analysis is missing or invalid.");
});

test("accepts null band ids used by saved aggregate and inside metrics", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  analysis.groups[0].area.bandId = null;
  await writeFile(analysisPath, JSON.stringify(analysis));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");
  const reportMessages = workbook.getWorksheet("Export Report").getColumn(4).values;

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(2);
  expect(reportMessages).toContain("Saved analysis loaded for export.");
});

test("ignores saved image folder and file metadata when exporting bounds and analysis", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const boundsPath = path.join(fixture.rootDir, "T01", "bound", "T01.bounds.json");
  const bounds = JSON.parse(await readFile(boundsPath, "utf8"));
  await writeFile(boundsPath, JSON.stringify({ ...bounds, imageFolder: "old-folder", imageFile: "old-file.tif" }));

  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  await writeFile(analysisPath, JSON.stringify({ ...analysis, imageFolder: "old-folder", imageFile: "old-file.tif" }));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");
  const reportMessages = workbook.getWorksheet("Export Report").getColumn(4).values;

  expect(archive.files.some((file) => file.path.includes("/roi/T01_ROI_overview.png"))).toBe(true);
  expect(reportMessages).toContain("Saved bounds loaded for export.");
  expect(reportMessages).toContain("Saved analysis loaded for export.");
});

test("reports semantically invalid bounds and analysis without rendering ROI", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  await writeFile(
    path.join(fixture.rootDir, "T01", "bound", "T01.bounds.json"),
    JSON.stringify({
      schemaVersion: 1,
      imageFolder: "T01",
      imageFile: "T01.tif",
      width: 40,
      height: 40,
      groups: [{ id: "broken", points: [] }],
    }),
  );
  await writeFile(
    path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json"),
    JSON.stringify({ schemaVersion: 5, imageFolder: "T01", imageFile: "T01.tif", groups: "broken" }),
  );
  const output = new PassThrough();
  const zipPromise = collectStream(output);
  const writePromise = writeDatasetZip({
    storage: fixture.storage,
    output,
    calibration: { slope: 0.1, intercept: 0 },
  });
  const archive = await unzipper.Open.buffer(await zipPromise);
  await writePromise;

  expect(archive.files.some((file) => file.path.includes("/roi/"))).toBe(false);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");
  const reportMessages = workbook.getWorksheet("Export Report").getColumn(4).values;
  expect(reportMessages).toContain("Saved bounds are missing or invalid.");
  expect(reportMessages).toContain("Saved analysis is missing or invalid.");
  expect(reportMessages).not.toContain("Saved bounds loaded for export.");
  expect(reportMessages).not.toContain("Saved analysis loaded for export.");
});

test.each([
  {
    name: "self-intersecting polygon",
    mutate: (savedBounds) => ({
      ...savedBounds,
      groups: [{
        ...savedBounds.groups[0],
        points: [
          { x: 2, y: 2 },
          { x: 30, y: 30 },
          { x: 2, y: 30 },
          { x: 30, y: 2 },
        ],
      }],
    }),
  },
  {
    name: "unknown analysis mode",
    mutate: (savedBounds) => ({
      ...savedBounds,
      groups: [{ ...savedBounds.groups[0], analysisMode: "sideways" }],
    }),
  },
])("rejects bounds with a $name", async ({ mutate }) => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const boundsPath = path.join(fixture.rootDir, "T01", "bound", "T01.bounds.json");
  await writeFile(boundsPath, JSON.stringify(mutate(JSON.parse(await readFile(boundsPath, "utf8")))));

  const archive = await exportFixtureArchive(fixture);

  expect(archive.files.some((file) => file.path.includes("/roi/"))).toBe(false);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");
  const reportMessages = workbook.getWorksheet("Export Report").getColumn(4).values;
  expect(reportMessages).toContain("Saved bounds are missing or invalid.");
  expect(reportMessages).not.toContain("Saved bounds loaded for export.");
});

test.each([
  {
    name: "inside group without area metrics",
    group: {
      groupId: "whole",
      groupName: "Whole image",
      analysisMode: "inside",
    },
  },
  {
    name: "outside group without every required band",
    group: {
      groupId: "whole",
      groupName: "Whole image",
      analysisMode: "outside",
      bands: { near: analysisMetrics(10, 100) },
      allBands: analysisMetrics(10, 100),
    },
  },
])("rejects analysis with an $name", async ({ group }) => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  await writeFile(analysisPath, JSON.stringify({ ...analysis, groups: [group] }));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");
  const reportMessages = workbook.getWorksheet("Export Report").getColumn(4).values;
  expect(reportMessages).toContain("Saved analysis is missing or invalid.");
  expect(reportMessages).not.toContain("Saved analysis loaded for export.");
});

test("skips analysis with an Excel formula object instead of passing it to the workbook", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  analysis.groups[0].area.density = {
    formula: 'HYPERLINK("https://example.invalid","open")',
    result: "open",
  };
  await writeFile(analysisPath, JSON.stringify(analysis));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(1);
  const reportMessages = workbook.getWorksheet("Export Report").getColumn(4).values;
  expect(reportMessages).toContain("Saved analysis is missing or invalid.");
  expect(JSON.stringify(workbook.worksheets.map((sheet) => sheet.getSheetValues()))).not.toContain("HYPERLINK");
});

test("skips analysis with an out-of-domain metric number", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  analysis.groups[0].area.roiAreaPx = -1;
  await writeFile(analysisPath, JSON.stringify(analysis));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(1);
  expect(workbook.getWorksheet("Export Report").getColumn(4).values).toContain(
    "Saved analysis is missing or invalid.",
  );
});

test("skips saved analysis when current bounds changed the group from inside to outside", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const boundsPath = path.join(fixture.rootDir, "T01", "bound", "T01.bounds.json");
  const bounds = JSON.parse(await readFile(boundsPath, "utf8"));
  bounds.groups[0] = {
    ...bounds.groups[0],
    analysisMode: "outside",
    roiLimits: { near: 5, mid: 10, far: 15 },
  };
  await writeFile(boundsPath, JSON.stringify(bounds));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(1);
  const reportMessages = workbook.getWorksheet("Export Report").getColumn(4).values;
  expect(reportMessages).toContain("Saved analysis is stale or incompatible with current bounds or mask.");
  expect(reportMessages).not.toContain("Saved analysis loaded for export.");
});

test("rejects schema-5 analysis without mask provenance", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  delete analysis.maskSource;
  await writeFile(analysisPath, JSON.stringify(analysis));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(1);
  expect(workbook.getWorksheet("Export Report").getColumn(4).values).toContain(
    "Saved analysis is missing or invalid.",
  );
});

test("keeps saved analysis when copying the selected mask changes only its file mtime", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const maskPath = path.join(fixture.rootDir, "T01", "mask", "T01.png");
  const maskMetadata = await stat(maskPath);
  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  analysis.maskSource = {
    file: "T01.png",
    format: "png",
    width: 40,
    height: 40,
    mtimeMs: maskMetadata.mtimeMs,
  };
  await writeFile(analysisPath, JSON.stringify(analysis));
  const changedTime = new Date(maskMetadata.mtimeMs + 2_000);
  await utimes(maskPath, changedTime, changedTime);

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(2);
  expect(workbook.getWorksheet("Export Report").getColumn(4).values).toContain("Saved analysis loaded for export.");
});

test("keeps saved analysis when copying bounds changes only its file mtime", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const boundsPath = path.join(fixture.rootDir, "T01", "bound", "T01.bounds.json");
  const analysisMetadata = await stat(analysisPath);
  const changedTime = new Date(analysisMetadata.mtimeMs + 2_000);
  await utimes(boundsPath, changedTime, changedTime);

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(2);
  expect(workbook.getWorksheet("Export Report").getColumn(4).values).toContain("Saved analysis loaded for export.");
});

test("keeps saved analysis regardless of recorded timestamp order", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const boundsPath = path.join(fixture.rootDir, "T01", "bound", "T01.bounds.json");
  const bounds = JSON.parse(await readFile(boundsPath, "utf8"));
  bounds.updatedAt = "2026-07-27T02:00:00.000Z";
  await writeFile(boundsPath, JSON.stringify(bounds));
  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  analysis.updatedAt = "2026-07-27T01:00:00.000Z";
  await writeFile(analysisPath, JSON.stringify(analysis));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(2);
  expect(workbook.getWorksheet("Export Report").getColumn(4).values).toContain("Saved analysis loaded for export.");
});

test("keeps saved analysis when audit time fields are malformed", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  analysis.updatedAt = "copied-without-original-clock";
  analysis.maskSource.mtimeMs = "not-a-time";
  await writeFile(analysisPath, JSON.stringify(analysis));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(2);
  expect(workbook.getWorksheet("Export Report").getColumn(4).values).toContain("Saved analysis loaded for export.");
});

test("skips outside analysis whose saved per-group ROI bands differ from current limits", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const boundsPath = path.join(fixture.rootDir, "T01", "bound", "T01.bounds.json");
  const bounds = JSON.parse(await readFile(boundsPath, "utf8"));
  bounds.groups[0] = {
    ...bounds.groups[0],
    analysisMode: "outside",
    roiLimits: { near: 5, mid: 10, far: 15 },
  };
  await writeFile(boundsPath, JSON.stringify(bounds));

  const analysisPath = path.join(fixture.rootDir, "T01", "analysis", "T01.analysis.json");
  const metric = analysisMetrics(10, 100);
  const analysis = {
    schemaVersion: 5,
    imageFolder: "T01",
    imageFile: "T01.tif",
    maskSource: {
      file: "T01.png",
      format: "png",
      width: 40,
      height: 40,
      mtimeMs: (await stat(path.join(fixture.rootDir, "T01", "mask", "T01.png"))).mtimeMs,
    },
    roiBands: [
      { id: "near", label: "Near", fromPx: 0, toPx: 5 },
      { id: "mid", label: "Mid", fromPx: 5, toPx: 10 },
      { id: "far", label: "Far", fromPx: 10, toPx: 15 },
    ],
    groups: [{
      groupId: "whole",
      groupName: "Whole image",
      analysisMode: "outside",
      roiBands: [
        { id: "near", label: "Near", fromPx: 0, toPx: 4 },
        { id: "mid", label: "Mid", fromPx: 4, toPx: 9 },
        { id: "far", label: "Far", fromPx: 9, toPx: 14 },
      ],
      bands: { near: metric, mid: metric, far: metric },
      allBands: metric,
    }],
    updatedAt: new Date().toISOString(),
  };
  await writeFile(analysisPath, JSON.stringify(analysis));

  const archive = await exportFixtureArchive(fixture);
  const workbook = await openWorkbookEntry(archive, "/T01_statistics.xlsx");

  expect(workbook.getWorksheet("ROI Statistics").rowCount).toBe(1);
  expect(workbook.getWorksheet("Export Report").getColumn(4).values).toContain(
    "Saved analysis is stale or incompatible with current bounds or mask.",
  );
});

test("uses a safe text fallback when workbook generation fails", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01"],
    heatmapSizes: { T01: [20, 50, 100] },
  });
  const xlsxPrototype = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx);
  const writeBuffer = vi.spyOn(xlsxPrototype, "writeBuffer").mockRejectedValue(
    new Error(`/private/secret/${fixture.rootDir}`),
  );
  const output = new PassThrough();
  const zipPromise = collectStream(output);

  try {
    const writePromise = writeDatasetZip({
      storage: fixture.storage,
      output,
      calibration: { slope: 0.1, intercept: 0 },
    });
    const archive = await unzipper.Open.buffer(await zipPromise);
    await writePromise;
    const fallback = archive.files.find((file) =>
      file.path === "fixture_export/T01/statistics/T01_statistics_error.txt"
    );
    expect(fallback).toBeDefined();
    const text = (await fallback.buffer()).toString("utf8");
    expect(text).toContain("workbook generation failed");
    expect(text).not.toContain(fixture.rootDir);
    expect(archive.files.some((file) => file.path.endsWith(".xlsx"))).toBe(false);
  } finally {
    writeBuffer.mockRestore();
  }
});

test("aborts active archive output on signal cancellation", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01", "T02"],
    heatmapSizes: { T01: [20, 50, 100], T02: [20, 50, 100] },
  });
  const controller = new AbortController();
  const output = new PassThrough();
  output.resume();
  const firstChunk = new Promise((resolve) => output.once("data", resolve));
  const writePromise = writeDatasetZip({
    storage: fixture.storage,
    output,
    calibration: { slope: 0.1, intercept: 0 },
    signal: controller.signal,
  });
  await firstChunk;
  controller.abort();

  await expect(writePromise).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  expect(output.destroyed).toBe(true);
});

test("aborts promptly when image scanning stays pending", async () => {
  const storage = {
    getRoot: () => "/data/fixture",
    scanImages: () => new Promise(() => {}),
  };
  const controller = new AbortController();
  const writePromise = writeDatasetZip({
    storage,
    output: new PassThrough(),
    calibration: { slope: 0.1, intercept: 0 },
    signal: controller.signal,
  });
  controller.abort();

  await expect(Promise.race([
    writePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Export did not abort promptly.")), 100)),
  ])).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
});
