import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createStorage } from "./storage.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "polygon-bound-storage-"));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeImage(rootDir, folderName, imageName = "frame.tif") {
  const imageDir = path.join(rootDir, folderName, "image");
  await mkdir(imageDir, { recursive: true });
  await writeFile(path.join(imageDir, imageName), "tiff placeholder");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe("createStorage", () => {
  test("scans name_Txx folders in numeric order", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T10", "zeta.tif");
    await writeImage(rootDir, "other-stack_T01", "only.tiff");
    await writeImage(rootDir, "selected-stack-sequence_T02", "beta.tif");
    await writeImage(rootDir, "selected-stack-sequence_T1", "alpha.tiff");
    await mkdir(path.join(rootDir, "selected-stack-sequence_T03", "image"), { recursive: true });
    await writeFile(path.join(rootDir, "selected-stack-sequence_T03", "image", "ignored.png"), "not a tif");
    await writeImage(rootDir, "selected-stack-sequence_T02_extra", "ignored.tif");

    const storage = createStorage({ initialRoot: rootDir });

    await expect(storage.scanImages()).resolves.toMatchObject([
      { id: "other-stack_T01", imageFolder: "other-stack_T01", imageFile: "only.tiff" },
      { id: "selected-stack-sequence_T1", imageFolder: "selected-stack-sequence_T1", imageFile: "alpha.tiff" },
      { id: "selected-stack-sequence_T02", imageFolder: "selected-stack-sequence_T02", imageFile: "beta.tif" },
      { id: "selected-stack-sequence_T10", imageFolder: "selected-stack-sequence_T10", imageFile: "zeta.tif" },
    ]);
  });

  test("returns public image records without absolute path fields", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });

    const scannedImage = (await storage.scanImages())[0];
    const fetchedImage = storage.getImage("selected-stack-sequence_T01");

    expect(scannedImage).toEqual({
      id: "selected-stack-sequence_T01",
      imageFolder: "selected-stack-sequence_T01",
      imageFile: "frame001.tif",
    });
    expect(fetchedImage).toEqual(scannedImage);
    expect(storage.imagePaths("selected-stack-sequence_T01")).toMatchObject({
      folderPath: path.join(rootDir, "selected-stack-sequence_T01"),
      imageDir: path.join(rootDir, "selected-stack-sequence_T01", "image"),
      imagePath: path.join(rootDir, "selected-stack-sequence_T01", "image", "frame001.tif"),
      maskDir: path.join(rootDir, "selected-stack-sequence_T01", "mask"),
      skeletonDir: path.join(rootDir, "selected-stack-sequence_T01", "Skeletonize"),
      analysisDir: path.join(rootDir, "selected-stack-sequence_T01", "analysis"),
      skeletonPath: path.join(rootDir, "selected-stack-sequence_T01", "Skeletonize", "selected-stack-sequence_T01.skeleton.png"),
      analysisPath: path.join(rootDir, "selected-stack-sequence_T01", "analysis", "selected-stack-sequence_T01.analysis.json"),
    });
  });

  test("rejects roots with no image sequence folders", async () => {
    const rootDir = await createTempRoot();
    await mkdir(path.join(rootDir, "not-a-sequence", "image"), { recursive: true });
    await writeFile(path.join(rootDir, "not-a-sequence", "image", "frame.tif"), "tiff placeholder");
    const storage = createStorage();

    expect(() => storage.setRoot(rootDir)).toThrow(/no image sequence folders/i);
  });

  test("rejects relative and nonexistent roots", async () => {
    const storage = createStorage();

    expect(() => storage.setRoot("relative-root")).toThrow(/absolute path/i);
    expect(() => storage.setRoot(path.join(tmpdir(), "missing-polygon-bound-storage-root"))).toThrow(/does not exist/i);
  });

  test("loads missing bounds as empty groups", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });

    await expect(storage.loadBounds("selected-stack-sequence_T01")).resolves.toEqual({
      schemaVersion: 1,
      imageFolder: "selected-stack-sequence_T01",
      imageFile: "frame001.tif",
      width: null,
      height: null,
      connectionMode: "input-order-cycle",
      groups: [],
    });
  });

  test("saves bounds atomically under the T folder bound directory", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });

    const saved = await storage.saveBounds("selected-stack-sequence_T01", {
      width: 640,
      height: 480,
      connectionMode: "input-order-cycle",
      groups: [{ id: "group-1", points: [{ id: "point-1", x: 1, y: 2 }] }],
    });

    const boundsDir = path.join(rootDir, "selected-stack-sequence_T01", "bound");
    const boundsPath = path.join(boundsDir, "selected-stack-sequence_T01.bounds.json");
    await expect(readJson(boundsPath)).resolves.toEqual(saved);
    await expect(readdir(boundsDir)).resolves.toEqual(["selected-stack-sequence_T01.bounds.json"]);
    expect(saved).toMatchObject({
      schemaVersion: 1,
      imageFolder: "selected-stack-sequence_T01",
      imageFile: "frame001.tif",
      width: 640,
      height: 480,
      connectionMode: "input-order-cycle",
      groups: [{ id: "group-1", points: [{ id: "point-1", x: 1, y: 2 }] }],
    });
    expect(Date.parse(saved.updatedAt)).not.toBeNaN();
  });

  test("concurrent saves use collision-resistant temp names", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const now = vi.spyOn(Date, "now").mockReturnValue(123);

    try {
      await expect(
        Promise.all([
          storage.saveBounds("selected-stack-sequence_T01", { groups: [{ id: "first", points: [] }] }),
          storage.saveBounds("selected-stack-sequence_T01", { groups: [{ id: "second", points: [] }] }),
        ]),
      ).resolves.toHaveLength(2);
    } finally {
      now.mockRestore();
    }

    await expect(readdir(path.join(rootDir, "selected-stack-sequence_T01", "bound"))).resolves.toEqual([
      "selected-stack-sequence_T01.bounds.json",
    ]);
  });

  test("loads existing bounds for saved-bound review", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const saved = await storage.saveBounds("selected-stack-sequence_T01", {
      width: 10,
      height: 20,
      groups: [{ id: "saved-group", points: [] }],
    });

    await expect(storage.loadBounds("selected-stack-sequence_T01")).resolves.toEqual(saved);
  });

  test("loads missing analysis as null", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });

    await expect(storage.loadAnalysis("selected-stack-sequence_T01")).resolves.toBeNull();
  });

  test("saves analysis atomically under the T folder analysis directory", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const analysis = {
      schemaVersion: 1,
      imageFolder: "selected-stack-sequence_T01",
      imageFile: "frame001.tif",
      groups: [],
      imageSummary: { skeletonPixelCount: 0 },
    };

    const saved = await storage.saveAnalysis("selected-stack-sequence_T01", analysis);

    const analysisDir = path.join(rootDir, "selected-stack-sequence_T01", "analysis");
    const analysisPath = path.join(analysisDir, "selected-stack-sequence_T01.analysis.json");
    await expect(readJson(analysisPath)).resolves.toEqual(saved);
    await expect(storage.loadAnalysis("selected-stack-sequence_T01")).resolves.toEqual(saved);
    await expect(readdir(analysisDir)).resolves.toEqual(["selected-stack-sequence_T01.analysis.json"]);
    expect(saved).toMatchObject({
      ...analysis,
      imageFolder: "selected-stack-sequence_T01",
      imageFile: "frame001.tif",
    });
    expect(Date.parse(saved.updatedAt)).not.toBeNaN();
  });

  test("wraps invalid bounds JSON with image context", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const { boundDir, boundsPath } = storage.imagePaths("selected-stack-sequence_T01");
    await mkdir(boundDir, { recursive: true });
    await writeFile(boundsPath, "{invalid json");

    await expect(storage.loadBounds("selected-stack-sequence_T01")).rejects.toThrow(
      /Invalid bounds JSON for selected-stack-sequence_T01/i,
    );
  });

  test("imports previous bounds without saving current image bounds", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    await writeImage(rootDir, "selected-stack-sequence_T02", "frame002.tif");
    const storage = createStorage({ initialRoot: rootDir });
    await storage.saveBounds("selected-stack-sequence_T01", {
      width: 100,
      height: 200,
      groups: [{ id: "previous-group", points: [{ x: 4, y: 5 }] }],
    });

    const imported = await storage.importPreviousBounds("selected-stack-sequence_T02");

    expect(imported).toMatchObject({
      schemaVersion: 1,
      imageFolder: "selected-stack-sequence_T02",
      imageFile: "frame002.tif",
      sourceImageFolder: "selected-stack-sequence_T01",
      width: 100,
      height: 200,
      groups: [{ id: "previous-group", points: [{ x: 4, y: 5 }] }],
    });
    await expect(
      readFile(path.join(rootDir, "selected-stack-sequence_T02", "bound", "selected-stack-sequence_T02.bounds.json")),
    ).rejects.toThrow();
  });

  test("rejects path traversal ids by resolving through scan results", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });

    expect(() => storage.getImage("../selected-stack-sequence_T01")).toThrow(/unknown image/i);
    expect(() => storage.imagePaths("../selected-stack-sequence_T01")).toThrow(/unknown image/i);
    await expect(storage.loadBounds("../selected-stack-sequence_T01")).rejects.toThrow(/unknown image/i);
    await expect(storage.saveBounds("../selected-stack-sequence_T01", { groups: [] })).rejects.toThrow(/unknown image/i);
  });

  test("selectRootWithFinder validates and sets selected roots", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const selectRoot = vi.fn(async () => rootDir);
    const storage = createStorage({ selectRoot });

    await expect(storage.selectRootWithFinder()).resolves.toBe(rootDir);

    expect(selectRoot).toHaveBeenCalledOnce();
    expect(storage.getRoot()).toBe(rootDir);
  });

  test("persists last valid root through dataDir and new instance loads it", async () => {
    const rootDir = await createTempRoot();
    const dataDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const firstStorage = createStorage({ dataDir });

    firstStorage.setRoot(rootDir);
    const secondStorage = createStorage({ dataDir });

    expect(secondStorage.getRoot()).toBe(rootDir);
    await expect(secondStorage.scanImages()).resolves.toEqual([
      { id: "selected-stack-sequence_T01", imageFolder: "selected-stack-sequence_T01", imageFile: "frame001.tif" },
    ]);
  });

  test("ignores persisted invalid root safely", async () => {
    const rootDir = await createTempRoot();
    const dataDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    createStorage({ dataDir }).setRoot(rootDir);
    await rm(rootDir, { recursive: true, force: true });

    const storage = createStorage({ dataDir });

    expect(storage.getRoot()).toBeNull();
    await expect(storage.scanImages()).rejects.toThrow(/root has not been set/i);
  });
});
