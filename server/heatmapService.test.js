import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, test } from "vitest";
import { generateHeatmapBatch, loadImageHeatmap } from "./heatmapService.js";
import { createStorage } from "./storage.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "heatmap-service-"));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeBundle(rootDir, folderName, { width, height }) {
  const folderPath = path.join(rootDir, folderName);
  const imageDir = path.join(folderPath, "image");
  const maskDir = path.join(folderPath, "mask");
  const imageName = `${path.basename(folderName)}.tif`;
  await mkdir(imageDir, { recursive: true });
  await mkdir(maskDir, { recursive: true });
  await writeFile(path.join(imageDir, imageName), "tiff placeholder");
  await sharp(Buffer.alloc(width * height, 255), { raw: { width, height, channels: 1 } }).png().toFile(path.join(maskDir, `${path.basename(folderName)}.png`));
}

async function writeUnreadableBundle(rootDir, folderName) {
  const folderPath = path.join(rootDir, folderName);
  const imageDir = path.join(folderPath, "image");
  const maskDir = path.join(folderPath, "mask");
  await mkdir(imageDir, { recursive: true });
  await mkdir(maskDir, { recursive: true });
  await writeFile(path.join(imageDir, `${folderName}.tif`), "tiff placeholder");
  await writeFile(path.join(maskDir, `${folderName}.png`), "not an image");
}

async function setupStorageWithSavedHeatmap() {
  const rootDir = await createTempRoot();
  await writeBundle(rootDir, "sample-a", { width: 2, height: 2 });
  await generateHeatmapBatch({ rootPath: rootDir, cellSizes: [5] });
  return createStorage({ initialRoot: rootDir });
}

async function touchMask(maskDir) {
  const maskPath = path.join(maskDir, "sample-a.png");
  const metadata = await stat(maskPath);
  const nextTime = new Date(metadata.mtimeMs + 1_000);
  await utimes(maskPath, nextTime, nextTime);
}

function savedHeatmapPath(storage, id, cellSize) {
  const image = storage.getImage(id);
  return path.join(storage.imagePaths(id).heatmapDir, `${cellSize}x${cellSize}`, `${image.imageFolder}.heatmap.json`);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

test("recursively writes each unique preset beside image and mask folders", async () => {
  const rootDir = await createTempRoot();
  await writeBundle(rootDir, "experiment/day-1/sample-a", { width: 5, height: 3 });

  const result = await generateHeatmapBatch({ rootPath: rootDir, cellSizes: [5, 10, 20, 5] });

  expect(result).toMatchObject({ discovered: 1, completed: 1, skipped: 0, failed: 0, generatedFiles: 3 });
  for (const size of [5, 10, 20]) {
    const saved = JSON.parse(
      await readFile(path.join(rootDir, "experiment/day-1/sample-a", "heatmap", `${size}x${size}`, "sample-a.heatmap.json")),
    );
    expect(saved).toMatchObject({ imageFolder: "sample-a", cellWidth: size, cellHeight: size });
  }
});

test("continues after an unreadable bundle and returns relative failures", async () => {
  const rootDir = await createTempRoot();
  await writeBundle(rootDir, "good", { width: 2, height: 2 });
  await writeUnreadableBundle(rootDir, "bad");

  const result = await generateHeatmapBatch({ rootPath: rootDir, cellSizes: [5] });

  expect(result.completed).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.failures[0].imageFolder).toBe("bad");
  expect(JSON.stringify(result)).not.toContain(rootDir);
});

test("continues when a descendant cannot be listed and keeps that failure relative", async () => {
  const rootDir = await createTempRoot();
  const blockedDir = path.join(rootDir, "blocked");
  await writeBundle(rootDir, "good", { width: 2, height: 2 });
  await mkdir(blockedDir);

  const result = await generateHeatmapBatch({
    rootPath: rootDir,
    cellSizes: [5],
    __testDependencies: {
      readdir: async (directory, options) => {
        if (directory === blockedDir) {
          throw new Error(`cannot list ${blockedDir}`);
        }
        return readdir(directory, options);
      },
    },
  });

  expect(result).toMatchObject({ discovered: 1, completed: 1, failed: 1 });
  expect(result.failures).toContainEqual(expect.objectContaining({ imageFolder: "blocked" }));
  expect(JSON.stringify(result)).not.toContain(rootDir);
});

test("removes atomic temporary files after an injected rename failure", async () => {
  const rootDir = await createTempRoot();
  await writeBundle(rootDir, "sample-a", { width: 2, height: 2 });

  const result = await generateHeatmapBatch({
    rootPath: rootDir,
    cellSizes: [5],
    __testDependencies: {
      rename: async () => {
        throw new Error("rename failed");
      },
    },
  });

  expect(result).toMatchObject({ completed: 0, failed: 1, generatedFiles: 0 });
  await expect(readdir(path.join(rootDir, "sample-a", "heatmap", "5x5"))).resolves.toEqual([]);
});

test("fails a bundle when the mask snapshot changes during decode", async () => {
  const rootDir = await createTempRoot();
  await writeBundle(rootDir, "sample-a", { width: 2, height: 2 });
  const maskPath = path.join(rootDir, "sample-a", "mask", "sample-a.png");
  const actualStats = await stat(maskPath);
  let snapshot = 0;

  const result = await generateHeatmapBatch({
    rootPath: rootDir,
    cellSizes: [5],
    __testDependencies: {
      stat: async (filePath) => {
        expect(filePath).toBe(maskPath);
        snapshot += 1;
        return snapshot === 1
          ? actualStats
          : { ...actualStats, ino: actualStats.ino + 1 };
      },
    },
  });

  expect(snapshot).toBe(2);
  expect(result).toMatchObject({ completed: 0, failed: 1, generatedFiles: 0 });
  expect(result.failures).toEqual([
    {
      imageFolder: "sample-a",
      code: "MASK_CHANGED",
      message: "Mask source changed during heatmap generation.",
    },
  ]);
});

test("loads current image heatmaps and rejects stale mask metadata", async () => {
  const storage = await setupStorageWithSavedHeatmap();

  await expect(loadImageHeatmap(storage, "sample-a", 5)).resolves.toMatchObject({ cellWidth: 5 });
  await touchMask(storage.imagePaths("sample-a").maskDir);
  await expect(loadImageHeatmap(storage, "sample-a", 5)).rejects.toMatchObject({ code: "STALE_HEATMAP" });
});

test("rejects saved heatmaps missing mask source metadata as invalid", async () => {
  const storage = await setupStorageWithSavedHeatmap();
  const filePath = savedHeatmapPath(storage, "sample-a", 5);
  const saved = JSON.parse(await readFile(filePath, "utf8"));
  delete saved.maskSource.size;
  await writeFile(filePath, JSON.stringify(saved));

  await expect(loadImageHeatmap(storage, "sample-a", 5)).rejects.toMatchObject({ code: "INVALID_HEATMAP" });
});

test("rejects saved heatmaps with wrongly typed mask source metadata as invalid", async () => {
  const storage = await setupStorageWithSavedHeatmap();
  const filePath = savedHeatmapPath(storage, "sample-a", 5);
  const saved = JSON.parse(await readFile(filePath, "utf8"));
  saved.maskSource.mtimeMs = "not-a-time";
  await writeFile(filePath, JSON.stringify(saved));

  await expect(loadImageHeatmap(storage, "sample-a", 5)).rejects.toMatchObject({ code: "INVALID_HEATMAP" });
});
