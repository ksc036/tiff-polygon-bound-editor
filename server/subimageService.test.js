import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import { createStorage } from "./storage.js";
import {
  SubimageError,
  createMissingSubimages,
  loadSubimage,
  replaceAllSubimages,
  saveSubimage,
  validateCrop,
} from "./subimageService.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "subimage-service-"));
  tempRoots.push(rootDir);
  return rootDir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

function uint16Tiff({ width, height, pixels }) {
  const entryCount = 9;
  const ifdOffset = 8;
  const dataOffset = ifdOffset + 2 + entryCount * 12 + 4;
  const buffer = Buffer.alloc(dataOffset + pixels.length * 2);
  let offset = 0;
  buffer.write("II", offset, "ascii");
  offset += 2;
  buffer.writeUInt16LE(42, offset);
  offset += 2;
  buffer.writeUInt32LE(ifdOffset, offset);
  offset = ifdOffset;
  buffer.writeUInt16LE(entryCount, offset);
  offset += 2;

  const writeEntry = (tag, type, count, value) => {
    buffer.writeUInt16LE(tag, offset);
    buffer.writeUInt16LE(type, offset + 2);
    buffer.writeUInt32LE(count, offset + 4);
    if (type === 3 && count === 1) buffer.writeUInt16LE(value, offset + 8);
    else buffer.writeUInt32LE(value, offset + 8);
    offset += 12;
  };

  writeEntry(256, 4, 1, width);
  writeEntry(257, 4, 1, height);
  writeEntry(258, 3, 1, 16);
  writeEntry(259, 3, 1, 1);
  writeEntry(262, 3, 1, 1);
  writeEntry(273, 4, 1, dataOffset);
  writeEntry(277, 3, 1, 1);
  writeEntry(278, 4, 1, height);
  writeEntry(279, 4, 1, pixels.length * 2);
  buffer.writeUInt32LE(0, offset);
  pixels.forEach((value, index) => buffer.writeUInt16LE(value, dataOffset + index * 2));
  return buffer;
}

async function writeGrey16Tiff(rootDir, folderName, width, height, pixels) {
  const imageDir = path.join(rootDir, folderName, "image");
  const maskDir = path.join(rootDir, folderName, "mask");
  await mkdir(imageDir, { recursive: true });
  await mkdir(maskDir, { recursive: true });
  await writeFile(path.join(imageDir, `${folderName}.tif`), uint16Tiff({ width, height, pixels }));
}

function squareCrop({ x, y }) {
  return { sourceWidth: 8, sourceHeight: 8, x, y, width: 4, height: 4 };
}

async function createThreeImageRoot({ width, height, thirdSize = { width, height } }) {
  const rootDir = await createTempRoot();
  const sizes = [{ width, height }, { width, height }, thirdSize];
  for (const [index, size] of sizes.entries()) {
    const folderName = `T0${index + 1}`;
    const pixels = Array.from(
      { length: size.width * size.height },
      (_, pixelIndex) => pixelIndex + index * 100,
    );
    await writeGrey16Tiff(rootDir, folderName, size.width, size.height, pixels);
  }
  return rootDir;
}

async function writeUnsupportedTiff(rootDir, folderName, input, transform = (image) => image) {
  const imageDir = path.join(rootDir, folderName, "image");
  const maskDir = path.join(rootDir, folderName, "mask");
  await mkdir(imageDir, { recursive: true });
  await mkdir(maskDir, { recursive: true });
  await transform(sharp(input)).tiff({ compression: "none" }).toFile(path.join(imageDir, `${folderName}.tif`));
}

describe("validateCrop", () => {
  test.each([
    [{ x: 0.5, y: 0, width: 4, height: 4 }, "INVALID_CROP"],
    [{ x: 0, y: 0, width: 0, height: 4 }, "INVALID_CROP"],
    [{ x: 7, y: 0, width: 4, height: 4 }, "INVALID_CROP"],
    [{ x: 0, y: 0, width: 4, height: 2 }, "ASPECT_RATIO_MISMATCH"],
  ])("rejects invalid crop %#", (crop, code) => {
    expect(() => validateCrop(crop, { width: 8, height: 8 })).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});

describe("saveSubimage", () => {
  test("writes an exact ushort grey16 crop and commits JSON last", async () => {
    const rootDir = await createTempRoot();
    const pixels = Array.from({ length: 64 }, (_, index) => index * 997);
    await writeGrey16Tiff(rootDir, "T01", 8, 8, pixels);
    const storage = createStorage({ initialRoot: rootDir });

    const result = await saveSubimage(storage, "T01", {
      sourceWidth: 8,
      sourceHeight: 8,
      x: 2,
      y: 1,
      width: 4,
      height: 4,
    });

    const { data, info } = await sharp(storage.imagePaths("T01").subimagePath)
      .toColourspace("grey16")
      .raw({ depth: "ushort" })
      .toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 4, height: 4, channels: 1, depth: "ushort" });
    expect([...new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)]).toEqual([
      10 * 997, 11 * 997, 12 * 997, 13 * 997,
      18 * 997, 19 * 997, 20 * 997, 21 * 997,
      26 * 997, 27 * 997, 28 * 997, 29 * 997,
      34 * 997, 35 * 997, 36 * 997, 37 * 997,
    ]);
    await expect(storage.loadSubimageCrop("T01")).resolves.toEqual(result.crop);
  });

  test("rejects an 8-bit TIFF source", async () => {
    const rootDir = await createTempRoot();
    await writeUnsupportedTiff(rootDir, "T01", {
      create: { width: 8, height: 8, channels: 3, background: { r: 80, g: 80, b: 80 } },
    }, (image) => image.greyscale());
    const storage = createStorage({ initialRoot: rootDir });

    await expect(saveSubimage(storage, "T01", {
      sourceWidth: 8, sourceHeight: 8, x: 0, y: 0, width: 8, height: 8,
    })).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  });

  test("rejects an RGB TIFF source", async () => {
    const rootDir = await createTempRoot();
    await writeUnsupportedTiff(rootDir, "T01", {
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    });
    const storage = createStorage({ initialRoot: rootDir });

    await expect(saveSubimage(storage, "T01", {
      sourceWidth: 8, sourceHeight: 8, x: 0, y: 0, width: 8, height: 8,
    })).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  });

  test("does not commit TIFF or JSON when crop rendering fails", async () => {
    const rootDir = await createTempRoot();
    await writeGrey16Tiff(rootDir, "T01", 8, 8, Array.from({ length: 64 }, (_, index) => index));
    const storage = createStorage({ initialRoot: rootDir });
    const paths = storage.imagePaths("T01");

    await expect(saveSubimage(storage, "T01", {
      sourceWidth: 8, sourceHeight: 8, x: 2, y: 2, width: 4, height: 4,
    }, {
      __testDependencies: {
        async renderCropTiff() {
          throw new Error("simulated render failure");
        },
      },
    })).rejects.toMatchObject({ code: "CROP_RENDER_FAILED" });

    await expect(access(paths.subimagePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.subimageCropPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps a successful save committed when temporary cleanup fails", async () => {
    const rootDir = await createTempRoot();
    await writeGrey16Tiff(rootDir, "T01", 8, 8, Array.from({ length: 64 }, (_, index) => index));
    const storage = createStorage({ initialRoot: rootDir });

    await expect(saveSubimage(storage, "T01", {
      sourceWidth: 8, sourceHeight: 8, x: 2, y: 2, width: 4, height: 4,
    }, {
      __testDependencies: {
        async rm() {
          throw Object.assign(new Error("simulated cleanup failure"), { code: "EACCES" });
        },
      },
    })).resolves.toMatchObject({ crop: { x: 2, y: 2, width: 4, height: 4 } });

    await expect(storage.loadSubimageCrop("T01")).resolves.toMatchObject({ x: 2, y: 2, width: 4, height: 4 });
    await expect(access(storage.imagePaths("T01").subimagePath)).resolves.toBeUndefined();
  });

  test("keeps the render failure when temporary cleanup fails", async () => {
    const rootDir = await createTempRoot();
    await writeGrey16Tiff(rootDir, "T01", 8, 8, Array.from({ length: 64 }, (_, index) => index));
    const storage = createStorage({ initialRoot: rootDir });

    await expect(saveSubimage(storage, "T01", {
      sourceWidth: 8, sourceHeight: 8, x: 2, y: 2, width: 4, height: 4,
    }, {
      __testDependencies: {
        async renderCropTiff() {
          throw new Error("simulated render failure");
        },
        async rm() {
          throw Object.assign(new Error("simulated cleanup failure"), { code: "EACCES" });
        },
      },
    })).rejects.toMatchObject({ code: "CROP_RENDER_FAILED" });
  });

  test("restores the prior TIFF and JSON when JSON persistence fails", async () => {
    const rootDir = await createTempRoot();
    await writeGrey16Tiff(rootDir, "T01", 8, 8, Array.from({ length: 64 }, (_, index) => index * 997));
    const storage = createStorage({ initialRoot: rootDir });
    await saveSubimage(storage, "T01", {
      sourceWidth: 8, sourceHeight: 8, x: 0, y: 0, width: 4, height: 4,
    });
    const paths = storage.imagePaths("T01");
    const priorTiff = await readFile(paths.subimagePath);
    const priorCrop = await readFile(paths.subimageCropPath);
    const saveSubimageCrop = storage.saveSubimageCrop;
    storage.saveSubimageCrop = async () => {
      throw new Error("simulated crop JSON failure");
    };

    await expect(saveSubimage(storage, "T01", {
      sourceWidth: 8, sourceHeight: 8, x: 4, y: 4, width: 4, height: 4,
    })).rejects.toMatchObject({ code: "CROP_SAVE_FAILED" });

    expect(await readFile(paths.subimagePath)).toEqual(priorTiff);
    expect(await readFile(paths.subimageCropPath)).toEqual(priorCrop);
    await expect(loadSubimage(storage, "T01")).resolves.toEqual({
      hasSubimage: true,
      crop: {
        sourceWidth: 8,
        sourceHeight: 8,
        x: 0,
        y: 0,
        width: 4,
        height: 4,
        aspectRatio: 1,
      },
    });
    storage.saveSubimageCrop = saveSubimageCrop;
  });

  test("keeps the prior saved pair when creating its TIFF backup fails", async () => {
    const rootDir = await createTempRoot();
    await writeGrey16Tiff(rootDir, "T01", 8, 8, Array.from({ length: 64 }, (_, index) => index * 997));
    const storage = createStorage({ initialRoot: rootDir });
    await saveSubimage(storage, "T01", {
      sourceWidth: 8, sourceHeight: 8, x: 0, y: 0, width: 4, height: 4,
    });
    const paths = storage.imagePaths("T01");
    const priorTiff = await readFile(paths.subimagePath);
    const priorCrop = await readFile(paths.subimageCropPath);

    await expect(saveSubimage(storage, "T01", {
      sourceWidth: 8, sourceHeight: 8, x: 4, y: 4, width: 4, height: 4,
    }, {
      __testDependencies: {
        async copyFile(sourcePath, backupPath) {
          await writeFile(backupPath, await readFile(sourcePath));
          throw new Error("simulated backup failure");
        },
      },
    })).rejects.toMatchObject({ code: "CROP_SAVE_FAILED" });

    expect(await readFile(paths.subimagePath)).toEqual(priorTiff);
    expect(await readFile(paths.subimageCropPath)).toEqual(priorCrop);
    await expect(readdir(paths.subimageDir)).resolves.toEqual(["T01.tif", "crop.json"]);
  });
});

test("loadSubimage reports an absent saved pair", async () => {
  const rootDir = await createTempRoot();
  await writeGrey16Tiff(rootDir, "T01", 8, 8, Array.from({ length: 64 }, (_, index) => index));
  const storage = createStorage({ initialRoot: rootDir });

  await expect(loadSubimage(storage, "T01")).resolves.toEqual({ hasSubimage: false, crop: null });
});

test("loadSubimage maps a saved TIFF access failure without exposing filesystem details", async () => {
  const rootDir = await createTempRoot();
  await writeGrey16Tiff(rootDir, "T01", 8, 8, Array.from({ length: 64 }, (_, index) => index));
  const storage = createStorage({ initialRoot: rootDir });
  await saveSubimage(storage, "T01", {
    sourceWidth: 8, sourceHeight: 8, x: 0, y: 0, width: 4, height: 4,
  });

  const error = await loadSubimage(storage, "T01", {
    __testDependencies: {
      async access() {
        throw Object.assign(new Error("/private/secret/saved-subimage.tif"), { code: "EACCES" });
      },
    },
  }).catch((caught) => caught);

  expect(error).toMatchObject({
    name: "SubimageError",
    code: "INVALID_SAVED_CROP",
    status: 422,
    details: null,
  });
  expect(error.message).not.toContain("/private/secret");
});

test("SubimageError carries the public error contract", () => {
  const error = new SubimageError("INVALID_CROP", "Invalid crop.", { status: 400, details: { x: 1 } });

  expect(error).toMatchObject({
    name: "SubimageError",
    code: "INVALID_CROP",
    status: 400,
    details: { x: 1 },
  });
});

test("create-missing preserves valid crops and creates only absent crops", async () => {
  const rootDir = await createThreeImageRoot({ width: 8, height: 8 });
  const storage = createStorage({ initialRoot: rootDir });
  await saveSubimage(storage, "T02", squareCrop({ x: 1, y: 1 }));
  const preservedTiff = await readFile(storage.imagePaths("T02").subimagePath);
  const preservedJson = await readFile(storage.imagePaths("T02").subimageCropPath);

  const result = await createMissingSubimages(storage, squareCrop({ x: 2, y: 2 }));

  expect(result).toEqual({
    operation: "create-missing",
    status: "complete",
    code: null,
    created: ["T01", "T03"],
    preserved: ["T02"],
    replaced: [],
    failed: [],
  });
  await expect(readFile(storage.imagePaths("T02").subimagePath)).resolves.toEqual(preservedTiff);
  await expect(readFile(storage.imagePaths("T02").subimageCropPath)).resolves.toEqual(preservedJson);
});

test("dimension mismatch fails preflight before any subimage directory is written", async () => {
  const rootDir = await createThreeImageRoot({
    width: 8,
    height: 8,
    thirdSize: { width: 10, height: 10 },
  });
  const storage = createStorage({ initialRoot: rootDir });

  await expect(createMissingSubimages(storage, squareCrop({ x: 2, y: 2 }))).rejects.toMatchObject({
    code: "BATCH_PREFLIGHT_FAILED",
    details: { failures: [expect.objectContaining({ imageFolder: "T03", code: "DIMENSION_MISMATCH" })] },
  });
  for (const image of await storage.scanImages()) {
    await expect(access(storage.imagePaths(image.id).subimageDir)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("mixed source dimensions fail preflight when the template omits source dimensions", async () => {
  const rootDir = await createThreeImageRoot({
    width: 8,
    height: 8,
    thirdSize: { width: 10, height: 10 },
  });
  const storage = createStorage({ initialRoot: rootDir });

  await expect(createMissingSubimages(storage, { x: 2, y: 2, width: 4, height: 4 })).rejects.toMatchObject({
    code: "BATCH_PREFLIGHT_FAILED",
    details: { failures: [expect.objectContaining({ imageFolder: "T03", code: "DIMENSION_MISMATCH" })] },
  });
  for (const image of await storage.scanImages()) {
    await expect(access(storage.imagePaths(image.id).subimageDir)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("normalizes scan failures without exposing the storage root", async () => {
  const rootDir = await createThreeImageRoot({ width: 8, height: 8 });
  const storage = createStorage({ initialRoot: rootDir });
  await rm(rootDir, { recursive: true, force: true });

  const error = await createMissingSubimages(storage, squareCrop({ x: 2, y: 2 })).catch((caught) => caught);

  expect(error).toMatchObject({
    name: "SubimageError",
    code: "BATCH_PREFLIGHT_FAILED",
    status: 422,
    details: {
      failures: [{ imageFolder: null, code: "BATCH_SCAN_FAILED", message: "Unable to scan source images." }],
    },
  });
  expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(rootDir);
});

test("create-missing rejects incomplete and malformed saved pairs during preflight", async () => {
  const rootDir = await createThreeImageRoot({ width: 8, height: 8 });
  const storage = createStorage({ initialRoot: rootDir });
  const incompletePaths = storage.imagePaths("T02");
  const malformedPaths = storage.imagePaths("T03");
  await mkdir(incompletePaths.subimageDir, { recursive: true });
  await writeFile(incompletePaths.subimagePath, "lone TIFF");
  await mkdir(malformedPaths.subimageDir, { recursive: true });
  await writeFile(malformedPaths.subimageCropPath, "{broken json");

  const error = await createMissingSubimages(storage, squareCrop({ x: 2, y: 2 })).catch((caught) => caught);

  expect(error).toMatchObject({
    code: "BATCH_PREFLIGHT_FAILED",
    details: {
      failures: [
        expect.objectContaining({ imageFolder: "T02", code: "INVALID_SAVED_CROP" }),
        expect.objectContaining({ imageFolder: "T03", code: "INVALID_SAVED_CROP" }),
      ],
    },
  });
  expect(error.message).not.toContain(rootDir);
  await expect(access(storage.imagePaths("T01").subimageDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("replace-all rewrites every valid image with the new template", async () => {
  const rootDir = await createThreeImageRoot({ width: 8, height: 8 });
  const storage = createStorage({ initialRoot: rootDir });
  await createMissingSubimages(storage, squareCrop({ x: 0, y: 0 }));

  const result = await replaceAllSubimages(storage, squareCrop({ x: 3, y: 2 }));

  expect(result).toMatchObject({
    operation: "replace-all",
    status: "complete",
    code: null,
    replaced: ["T01", "T02", "T03"],
    created: [],
    preserved: [],
    failed: [],
  });
  for (const image of await storage.scanImages()) {
    await expect(storage.loadSubimageCrop(image.id)).resolves.toMatchObject({
      x: 3,
      y: 2,
      width: 4,
      height: 4,
    });
  }
});

test("reports a runtime partial batch and preserves the failed image pair", async () => {
  const rootDir = await createThreeImageRoot({ width: 8, height: 8 });
  const storage = createStorage({ initialRoot: rootDir });
  await createMissingSubimages(storage, squareCrop({ x: 0, y: 0 }));
  const oldTiff = await readFile(storage.imagePaths("T02").subimagePath);
  const oldJson = await readFile(storage.imagePaths("T02").subimageCropPath);

  const failingStorage = {
    ...storage,
    async saveSubimageCrop(id, crop) {
      if (id === "T02") throw new Error("simulated crop JSON write failure");
      return storage.saveSubimageCrop(id, crop);
    },
  };
  const result = await replaceAllSubimages(failingStorage, squareCrop({ x: 2, y: 2 }));

  expect(result).toMatchObject({
    status: "partial",
    code: "PARTIAL_BATCH",
    replaced: ["T01", "T03"],
    failed: [{ imageFolder: "T02", code: "WRITE_FAILED", message: "Unable to save subimage." }],
  });
  await expect(readFile(storage.imagePaths("T02").subimagePath)).resolves.toEqual(oldTiff);
  await expect(readFile(storage.imagePaths("T02").subimageCropPath)).resolves.toEqual(oldJson);
});
