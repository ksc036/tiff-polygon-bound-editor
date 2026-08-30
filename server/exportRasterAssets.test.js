import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import {
  createSubimageDimensionsCsv,
  percentileDisplayRange,
  readExportRaster,
  renderAnnotatedOriginal,
  renderOriginalPreview,
  renderSubimagePreview,
} from "./exportRasterAssets.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "export-raster-assets-"));
  tempRoots.push(rootDir);
  return rootDir;
}

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

function fixtureRaster(width, height) {
  return {
    width,
    height,
    pixels: Uint16Array.from({ length: width * height }, (_, index) => index * 100),
    displayMin: 0,
    displayMax: (width * height - 1) * 100,
  };
}

function pixelAt(decoded, x, y) {
  const offset = (y * decoded.info.width + x) * decoded.info.channels;
  return [...decoded.data.subarray(offset, offset + decoded.info.channels)];
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((rootDir) => rm(rootDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })),
  );
});

describe("percentileDisplayRange", () => {
  test("derives P1 and P99.8 from a 16-bit histogram without sorting the raster", () => {
    const pixels = Uint16Array.from([300, 0, 65535, 100, 200]);
    const range = percentileDisplayRange(pixels);

    expect(range.displayMin).toBeCloseTo(4);
    expect(range.displayMax).toBeCloseTo(65013.12);
    expect([...pixels]).toEqual([300, 0, 65535, 100, 200]);
  });

  test("uses a one-level fallback for a constant raster", () => {
    expect(percentileDisplayRange(Uint16Array.from([4096, 4096, 4096]))).toEqual({
      displayMin: 4096,
      displayMax: 4097,
    });
  });

  test("keeps a one-level fallback at the saturated grey16 boundary", () => {
    expect(percentileDisplayRange(Uint16Array.from([65535, 65535]))).toEqual({
      displayMin: 65534,
      displayMax: 65535,
    });
  });
});

describe("readExportRaster", () => {
  test("reads the shared grey16 raster and derives its display range", async () => {
    const rootDir = await createTempRoot();
    const imagePath = path.join(rootDir, "source.tif");
    await writeFile(imagePath, uint16Tiff({ width: 5, height: 1, pixels: [0, 100, 200, 300, 65535] }));

    const raster = await readExportRaster({ imagePath, maxImagePixels: 5 });

    expect(raster).toMatchObject({ width: 5, height: 1, displayMin: 4, displayMax: 65013.12 });
    expect([...raster.pixels]).toEqual([0, 100, 200, 300, 65535]);
  });

  test("passes the configured maximum pixel count to the shared reader", async () => {
    const rootDir = await createTempRoot();
    const imagePath = path.join(rootDir, "source.tif");
    await writeFile(imagePath, uint16Tiff({ width: 3, height: 2, pixels: [0, 1, 2, 3, 4, 5] }));

    await expect(readExportRaster({ imagePath, maxImagePixels: 5 })).rejects.toThrow();
  });
});

test("renders representative normalized pixels", async () => {
  const gradient = {
    width: 3,
    height: 1,
    pixels: Uint16Array.from([0, 50, 100]),
    displayMin: 0,
    displayMax: 100,
  };
  const normalized = await sharp(await renderOriginalPreview(gradient)).greyscale().raw().toBuffer({
    resolveWithObject: true,
  });
  expect(normalized.info).toMatchObject({ width: 3, height: 1, channels: 1 });
  expect([...normalized.data]).toEqual([0, 128, 255]);
});

test("renders a valid constant-raster PNG without dividing by zero", async () => {
  const constant = {
    width: 3,
    height: 2,
    pixels: new Uint16Array(6).fill(4096),
    ...percentileDisplayRange(new Uint16Array(6).fill(4096)),
  };
  const constantPng = await sharp(await renderOriginalPreview(constant)).greyscale().raw().toBuffer({
    resolveWithObject: true,
  });
  expect(constantPng.info).toMatchObject({ width: 3, height: 2, channels: 1 });
  expect([...constantPng.data]).toEqual([0, 0, 0, 0, 0, 0]);
});

test("renders matching parent and Subimage previews", async () => {
  const raster = fixtureRaster(6, 4);
  const crop = { sourceWidth: 6, sourceHeight: 4, x: 2, y: 1, width: 3, height: 2 };
  const subimage = await sharp(await renderSubimagePreview(raster, crop)).greyscale().raw().toBuffer({
    resolveWithObject: true,
  });

  expect([subimage.info.width, subimage.info.height]).toEqual([3, 2]);
  expect([...subimage.data]).toEqual([89, 100, 111, 155, 166, 177]);
});

test("colors exactly the crop perimeter and leaves its interior and surrounding pixels unchanged", async () => {
  const raster = fixtureRaster(7, 7);
  const crop = { sourceWidth: 7, sourceHeight: 7, x: 1, y: 1, width: 5, height: 5 };
  const original = await sharp(await renderOriginalPreview(raster)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const annotated = await sharp(await renderAnnotatedOriginal(raster, crop)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });

  expect([annotated.info.width, annotated.info.height]).toEqual([7, 7]);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const onPerimeter = x >= 1 && x <= 5 && y >= 1 && y <= 5
        && (x === 1 || x === 5 || y === 1 || y === 5);
      expect(pixelAt(annotated, x, y), `pixel ${x},${y}`).toEqual(
        onPerimeter ? [255, 0, 0, 255] : pixelAt(original, x, y),
      );
    }
  }
});

test("marks a valid 1x1 crop with one visible red pixel", async () => {
  const raster = fixtureRaster(4, 3);
  const crop = { sourceWidth: 4, sourceHeight: 3, x: 2, y: 1, width: 1, height: 1 };
  const original = await sharp(await renderOriginalPreview(raster)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const annotated = await sharp(await renderAnnotatedOriginal(raster, crop)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });

  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      expect(pixelAt(annotated, x, y), `pixel ${x},${y}`).toEqual(
        x === crop.x && y === crop.y ? [255, 0, 0, 255] : pixelAt(original, x, y),
      );
    }
  }
});

test("creates deterministic CRLF Subimage dimensions CSV", () => {
  const source = fixtureRaster(6, 4);
  const crop = { sourceWidth: 6, sourceHeight: 4, x: 2, y: 1, width: 3, height: 2 };

  expect(createSubimageDimensionsCsv({ imageFolder: "T01", source, crop }).toString("utf8")).toBe(
    "field,value\r\n"
    + "image_folder,T01\r\n"
    + "source_width,6\r\n"
    + "source_height,4\r\n"
    + "crop_x,2\r\n"
    + "crop_y,1\r\n"
    + "crop_width,3\r\n"
    + "crop_height,2\r\n"
    + "original_16bit_filename,original_16bit.tif\r\n"
    + "original_8bit_filename,original_8bit.png\r\n"
    + "annotated_original_filename,original_with_subimage.png\r\n"
    + "subimage_16bit_filename,subimage_16bit.tif\r\n"
    + "subimage_8bit_filename,subimage_8bit.png\r\n",
  );
});
