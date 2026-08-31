import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createStorage } from "./storage.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rename: vi.fn((...args) => actual.rename(...args)),
    rm: vi.fn((...args) => actual.rm(...args)),
  };
});

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "polygon-bound-storage-"));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeImage(rootDir, folderName, imageName = "frame.tif") {
  const imageDir = path.join(rootDir, folderName, "image");
  const maskDir = path.join(rootDir, folderName, "mask");
  await mkdir(imageDir, { recursive: true });
  await mkdir(maskDir, { recursive: true });
  await writeFile(path.join(imageDir, imageName), "tiff placeholder");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe("createStorage", () => {
  test("scans folders with image directories in name order", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "zeta", "zeta.tif");
    await writeImage(rootDir, "alpha sample", "alpha.tiff");
    await writeImage(rootDir, "middle", "middle.tif");
    await mkdir(path.join(rootDir, "image-only", "image"), { recursive: true });
    await writeFile(path.join(rootDir, "image-only", "image", "image-only.tif"), "tiff placeholder");
    await mkdir(path.join(rootDir, "not-a-tiff", "image"), { recursive: true });
    await mkdir(path.join(rootDir, "not-a-tiff", "mask"), { recursive: true });
    await writeFile(path.join(rootDir, "not-a-tiff", "image", "ignored.png"), "not a tif");

    const storage = createStorage({ initialRoot: rootDir });

    await expect(storage.scanImages()).resolves.toMatchObject([
      { id: "alpha sample", imageFolder: "alpha sample", imageFile: "alpha.tiff" },
      { id: "image-only", imageFolder: "image-only", imageFile: "image-only.tif" },
      { id: "middle", imageFolder: "middle", imageFile: "middle.tif" },
      { id: "zeta", imageFolder: "zeta", imageFile: "zeta.tif" },
    ]);
  });

  test("scans an image-only timestamp folder before any mask exists", async () => {
    const rootDir = await createTempRoot();
    await mkdir(path.join(rootDir, "T01", "image"), { recursive: true });
    await writeFile(path.join(rootDir, "T01", "image", "frame.tif"), "tiff placeholder");

    await expect(createStorage({ initialRoot: rootDir }).scanImages()).resolves.toMatchObject([
      { id: "T01", imageFile: "frame.tif" },
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

  test("resolves private subimage paths without exposing them in image DTOs", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });

    expect(storage.getImage("selected-stack-sequence_T01")).toEqual({
      id: "selected-stack-sequence_T01",
      imageFolder: "selected-stack-sequence_T01",
      imageFile: "frame001.tif",
    });
    expect(storage.imagePaths("selected-stack-sequence_T01")).toMatchObject({
      subimageDir: path.join(rootDir, "selected-stack-sequence_T01", "subimage"),
      subimagePath: path.join(rootDir, "selected-stack-sequence_T01", "subimage", "frame001.tif"),
      subimageCropPath: path.join(rootDir, "selected-stack-sequence_T01", "subimage", "crop.json"),
    });
  });

  test("keeps an export snapshot bound to its original root after the active root changes", async () => {
    const firstRoot = await createTempRoot();
    const secondRoot = await createTempRoot();
    await writeImage(firstRoot, "shared-id", "first.tif");
    await writeImage(secondRoot, "shared-id", "second.tif");
    const storage = createStorage({ initialRoot: firstRoot });

    const snapshot = storage.createSnapshot();
    storage.setRoot(secondRoot);

    expect(snapshot.getRoot()).toBe(firstRoot);
    await expect(snapshot.scanImages()).resolves.toEqual([
      { id: "shared-id", imageFolder: "shared-id", imageFile: "first.tif" },
    ]);
    expect(snapshot.getImage("shared-id").imageFile).toBe("first.tif");
    expect(snapshot.imagePaths("shared-id").imagePath).toBe(
      path.join(firstRoot, "shared-id", "image", "first.tif"),
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.saveSubimageCrop).toBeUndefined();
  });

  test("creates a frozen Subimage mutation context bound to one root with narrow write access", async () => {
    const firstRoot = await createTempRoot();
    const secondRoot = await createTempRoot();
    await writeImage(firstRoot, "shared-id", "frame.tif");
    await writeImage(secondRoot, "shared-id", "frame.tif");
    const storage = createStorage({ initialRoot: firstRoot });

    expect(storage.createSubimageMutationContext).toBeTypeOf("function");
    const context = storage.createSubimageMutationContext();
    storage.setRoot(secondRoot);

    expect(Object.isFrozen(context)).toBe(true);
    expect(context.setRoot).toBeUndefined();
    expect(context.saveBounds).toBeUndefined();
    expect(context.saveAnalysis).toBeUndefined();
    expect(context.saveSubimageCrop).toBeTypeOf("function");
    expect(context.imagePaths("shared-id").subimageCropPath).toBe(
      path.join(firstRoot, "shared-id", "subimage", "crop.json"),
    );

    await context.saveSubimageCrop("shared-id", {
      sourceWidth: 8,
      sourceHeight: 8,
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      aspectRatio: 1,
    });

    await expect(readJson(path.join(firstRoot, "shared-id", "subimage", "crop.json"))).resolves.toMatchObject({
      width: 4,
      height: 4,
    });
    await expect(readFile(path.join(secondRoot, "shared-id", "subimage", "crop.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("serializes crop saves across Subimage mutation contexts so the later invocation wins", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const firstContext = storage.createSubimageMutationContext();
    const secondContext = storage.createSubimageMutationContext();

    const saved = await Promise.all([
      firstContext.saveSubimageCrop("selected-stack-sequence_T01", {
        marker: "first",
        samples: Array.from({ length: 25_000 }, (_, index) => index),
      }),
      secondContext.saveSubimageCrop("selected-stack-sequence_T01", { marker: "second" }),
    ]);

    expect(saved).toHaveLength(2);
    const subimageDir = storage.imagePaths("selected-stack-sequence_T01").subimageDir;
    await expect(readdir(subimageDir)).resolves.toEqual(["crop.json"]);
    const finalCrop = await readJson(path.join(subimageDir, "crop.json"));
    expect(finalCrop.marker).toBe("second");
    expect(finalCrop.samples).toBeUndefined();
  });

  test.skipIf(process.platform !== "win32")(
    "normalizes Windows destination aliases before serializing crop saves",
    async () => {
      const rootDir = await createTempRoot();
      await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
      const storage = createStorage({ initialRoot: rootDir });
      const firstContext = storage.createSubimageMutationContext();
      const aliasedRoot = `${path.dirname(rootDir).toUpperCase()}${path.sep}unused${path.sep}..${path.sep}${path.basename(rootDir).toUpperCase()}`;
      storage.setRoot(aliasedRoot);
      const secondContext = storage.createSubimageMutationContext();

      await Promise.all([
        firstContext.saveSubimageCrop("selected-stack-sequence_T01", {
          marker: "first",
          samples: Array.from({ length: 25_000 }, (_, index) => index),
        }),
        secondContext.saveSubimageCrop("selected-stack-sequence_T01", { marker: "second" }),
      ]);

      const subimageDir = path.join(rootDir, "selected-stack-sequence_T01", "subimage");
      await expect(readdir(subimageDir)).resolves.toEqual(["crop.json"]);
      const finalCrop = await readJson(path.join(subimageDir, "crop.json"));
      expect(finalCrop.marker).toBe("second");
      expect(finalCrop.samples).toBeUndefined();
    },
  );

  test("rejects roots with no folders containing TIFF images", async () => {
    const rootDir = await createTempRoot();
    await mkdir(path.join(rootDir, "not-ready", "image"), { recursive: true });
    await writeFile(path.join(rootDir, "not-ready", "image", "frame.png"), "not a tif");
    const storage = createStorage();

    expect(() => storage.setRoot(rootDir)).toThrow(/no image folders/i);
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
      width: 640,
      height: 480,
      connectionMode: "input-order-cycle",
      groups: [{ id: "group-1", points: [{ id: "point-1", x: 1, y: 2 }] }],
    });
    expect(saved).not.toHaveProperty("imageFolder");
    expect(saved).not.toHaveProperty("imageFile");
    expect(Date.parse(saved.updatedAt)).not.toBeNaN();
  });

  test("ignores legacy image identity metadata when loading bounds", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const { boundDir, boundsPath } = storage.imagePaths("selected-stack-sequence_T01");
    await mkdir(boundDir, { recursive: true });
    await writeFile(boundsPath, JSON.stringify({
      schemaVersion: 1,
      imageFolder: "old-location",
      imageFile: "old-name.tif",
      width: 10,
      height: 20,
      connectionMode: "input-order-cycle",
      groups: [],
    }));

    await expect(storage.loadBounds("selected-stack-sequence_T01")).resolves.toEqual({
      schemaVersion: 1,
      width: 10,
      height: 20,
      connectionMode: "input-order-cycle",
      groups: [],
    });
  });

  test("serializes concurrent bounds saves so the later invocation wins", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const firstGroups = [{
      id: "first",
      points: Array.from({ length: 25_000 }, (_, index) => ({ id: `point-${index}`, x: index, y: index })),
    }];
    const secondGroups = [{ id: "second", points: [] }];

    const saved = await Promise.all([
      storage.saveBounds("selected-stack-sequence_T01", { groups: firstGroups }),
      storage.saveBounds("selected-stack-sequence_T01", { groups: secondGroups }),
    ]);

    expect(saved).toHaveLength(2);
    const boundsDir = path.join(rootDir, "selected-stack-sequence_T01", "bound");
    await expect(readdir(boundsDir)).resolves.toEqual([
      "selected-stack-sequence_T01.bounds.json",
    ]);
    const finalBounds = await readJson(path.join(boundsDir, "selected-stack-sequence_T01.bounds.json"));
    expect(finalBounds.groups).toHaveLength(1);
    expect(finalBounds.groups[0]?.id).toBe("second");
  });

  test("continues a destination queue after the preceding save fails", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });

    const results = await Promise.allSettled([
      storage.saveBounds("selected-stack-sequence_T01", {
        groups: [{ id: "invalid", value: 1n }],
      }),
      storage.saveBounds("selected-stack-sequence_T01", {
        groups: [{ id: "recovered", points: [] }],
      }),
    ]);

    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    const boundsDir = path.join(rootDir, "selected-stack-sequence_T01", "bound");
    await expect(readdir(boundsDir)).resolves.toEqual(["selected-stack-sequence_T01.bounds.json"]);
    const finalBounds = await readJson(path.join(boundsDir, "selected-stack-sequence_T01.bounds.json"));
    expect(finalBounds.groups).toEqual([{ id: "recovered", points: [] }]);
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
      imageSummary: { maskPixelCount: 0 },
    };

    const saved = await storage.saveAnalysis("selected-stack-sequence_T01", analysis);

    const analysisDir = path.join(rootDir, "selected-stack-sequence_T01", "analysis");
    const analysisPath = path.join(analysisDir, "selected-stack-sequence_T01.analysis.json");
    await expect(readJson(analysisPath)).resolves.toEqual(saved);
    await expect(storage.loadAnalysis("selected-stack-sequence_T01")).resolves.toEqual(saved);
    await expect(readdir(analysisDir)).resolves.toEqual(["selected-stack-sequence_T01.analysis.json"]);
    expect(saved).toMatchObject({
      schemaVersion: 1,
      groups: [],
      imageSummary: { maskPixelCount: 0 },
    });
    expect(saved).not.toHaveProperty("imageFolder");
    expect(saved).not.toHaveProperty("imageFile");
    expect(Date.parse(saved.updatedAt)).not.toBeNaN();
  });

  test("preserves the original atomic write error when temp cleanup also fails", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const renameError = new Error("rename failed");
    const cleanupError = new Error("cleanup failed");
    const actualFs = await vi.importActual("node:fs/promises");
    const renameMock = vi.mocked(fsPromises.rename);
    const rmMock = vi.mocked(fsPromises.rm);
    renameMock.mockRejectedValueOnce(renameError);
    rmMock.mockRejectedValueOnce(cleanupError);

    try {
      await expect(
        storage.saveBounds("selected-stack-sequence_T01", { groups: [] }),
      ).rejects.toBe(renameError);
    } finally {
      renameMock.mockImplementation((...args) => actualFs.rename(...args));
      rmMock.mockImplementation((...args) => actualFs.rm(...args));
    }
  });

  test("serializes concurrent analysis saves so the later invocation wins", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const firstGroups = Array.from({ length: 25_000 }, (_, index) => ({ id: `group-${index}`, points: [] }));
    const secondGroups = [{ id: "second", points: [] }];

    const saved = await Promise.all([
      storage.saveAnalysis("selected-stack-sequence_T01", { groups: firstGroups }),
      storage.saveAnalysis("selected-stack-sequence_T01", { groups: secondGroups }),
    ]);

    expect(saved).toHaveLength(2);
    const analysisDir = path.join(rootDir, "selected-stack-sequence_T01", "analysis");
    await expect(readdir(analysisDir)).resolves.toEqual([
      "selected-stack-sequence_T01.analysis.json",
    ]);
    const finalAnalysis = await readJson(path.join(analysisDir, "selected-stack-sequence_T01.analysis.json"));
    expect(finalAnalysis.groups).toHaveLength(1);
    expect(finalAnalysis.groups[0]?.id).toBe("second");
  });

  test("loads a missing subimage crop as null and saves crop JSON atomically", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });

    await expect(storage.loadSubimageCrop("selected-stack-sequence_T01")).resolves.toBeNull();
    const saved = await storage.saveSubimageCrop("selected-stack-sequence_T01", {
      sourceWidth: 1008,
      sourceHeight: 1008,
      x: 120,
      y: 80,
      width: 400,
      height: 400,
      aspectRatio: 1,
    });

    await expect(readJson(storage.imagePaths("selected-stack-sequence_T01").subimageCropPath)).resolves.toEqual(saved);
    expect(saved).toMatchObject({
      schemaVersion: 1,
      x: 120,
      y: 80,
      width: 400,
      height: 400,
    });
    expect(saved).not.toHaveProperty("imageFolder");
    expect(saved).not.toHaveProperty("imageFile");
    expect(Date.parse(saved.updatedAt)).not.toBeNaN();
    await expect(readdir(storage.imagePaths("selected-stack-sequence_T01").subimageDir)).resolves.toEqual(["crop.json"]);
  });

  test("wraps malformed subimage crop JSON with image context", async () => {
    const rootDir = await createTempRoot();
    await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
    const storage = createStorage({ initialRoot: rootDir });
    const { subimageDir, subimageCropPath } = storage.imagePaths("selected-stack-sequence_T01");
    await mkdir(subimageDir, { recursive: true });
    await writeFile(subimageCropPath, "{broken json");

    await expect(storage.loadSubimageCrop("selected-stack-sequence_T01")).rejects.toThrow(
      /Invalid subimage crop JSON for selected-stack-sequence_T01/i,
    );
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
    await expect(storage.loadSubimageCrop("../selected-stack-sequence_T01")).rejects.toThrow(/unknown image/i);
    await expect(storage.saveSubimageCrop("../selected-stack-sequence_T01", {})).rejects.toThrow(/unknown image/i);
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
