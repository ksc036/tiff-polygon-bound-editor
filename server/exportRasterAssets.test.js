import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSubimageDimensionsCsv,
  percentileDisplayRange,
  readExportImageDimensions,
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
  test("derives P1 and P99.8 from a 16-bit histogram without sorting the raster", async () => {
    const pixels = Uint16Array.from([300, 0, 65535, 100, 200]);
    const range = await percentileDisplayRange(pixels);

    expect(range.displayMin).toBeCloseTo(4);
    expect(range.displayMax).toBeCloseTo(65013.12);
    expect([...pixels]).toEqual([300, 0, 65535, 100, 200]);
  });

  test("uses a one-level fallback for a constant raster", async () => {
    expect(await percentileDisplayRange(Uint16Array.from([4096, 4096, 4096]))).toEqual({
      displayMin: 4096,
      displayMax: 4097,
    });
  });

  test("keeps a one-level fallback at the saturated grey16 boundary", async () => {
    expect(await percentileDisplayRange(Uint16Array.from([65535, 65535]))).toEqual({
      displayMin: 65534,
      displayMax: 65535,
    });
  });

  test("yields so an external abort stops histogram scanning without poisoning later calculations", async () => {
    const source = Array.from({ length: 10_000 }, (_, index) => index);
    const controller = new AbortController();
    let pixelReads = 0;
    const pixels = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          pixelReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const aborted = new Promise((resolve) => {
      setImmediate(() => {
        controller.abort();
        resolve();
      });
    });
    const calculation = Promise.resolve(percentileDisplayRange(pixels, { signal: controller.signal }));

    await aborted;
    await expect(calculation).rejects.toThrow("Raster export aborted.");
    expect(pixelReads).toBeLessThanOrEqual(4_096);

    const completed = await percentileDisplayRange(source);
    expect(completed.displayMin).toBeCloseTo(99.99);
    expect(completed.displayMax).toBeCloseTo(9_979.002);
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

  test("cancels the active source decode and detaches its abort listener", async () => {
    const rootDir = await createTempRoot();
    const imagePath = path.join(rootDir, "source.tif");
    const pixelCount = 256 * 256;
    await writeFile(imagePath, uint16Tiff({
      width: 256,
      height: 256,
      pixels: Uint16Array.from({ length: pixelCount }, (_, index) => index),
    }));
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

    const reading = readExportRaster({
      imagePath,
      maxImagePixels: pixelCount,
      signal: controller.signal,
    });
    controller.abort();

    await expect(reading).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("detaches the source decode abort listener after success", async () => {
    const rootDir = await createTempRoot();
    const imagePath = path.join(rootDir, "source.tif");
    await writeFile(imagePath, uint16Tiff({ width: 2, height: 1, pixels: [0, 65535] }));
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

    await readExportRaster({ imagePath, maxImagePixels: 2, signal: controller.signal });

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("readExportImageDimensions", () => {
  test("reads current TIFF dimensions within the configured pixel limit", async () => {
    const rootDir = await createTempRoot();
    const imagePath = path.join(rootDir, "source.tif");
    await writeFile(imagePath, uint16Tiff({ width: 3, height: 2, pixels: [0, 1, 2, 3, 4, 5] }));

    await expect(readExportImageDimensions({ imagePath, maxImagePixels: 6 })).resolves.toEqual({
      width: 3,
      height: 2,
    });
  });

  test("rejects TIFF dimensions above the configured pixel limit", async () => {
    const rootDir = await createTempRoot();
    const imagePath = path.join(rootDir, "source.tif");
    await writeFile(imagePath, uint16Tiff({ width: 3, height: 2, pixels: [0, 1, 2, 3, 4, 5] }));

    await expect(readExportImageDimensions({ imagePath, maxImagePixels: 5 })).rejects.toThrow();
  });

  test("rejects a pre-aborted metadata read", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(readExportImageDimensions({
      imagePath: "unused.tif",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  });
});

test.each([
  ["original", (raster, crop, signal) => renderOriginalPreview(raster, { signal })],
  ["annotated original", (raster, crop, signal) => renderAnnotatedOriginal(raster, crop, { signal })],
  ["Subimage", (raster, crop, signal) => renderSubimagePreview(raster, crop, { signal })],
])("rejects a pre-aborted %s PNG render", async (_name, render) => {
  const controller = new AbortController();
  controller.abort();

  await expect(render(
    fixtureRaster(6, 4),
    { sourceWidth: 6, sourceHeight: 4, x: 1, y: 1, width: 2, height: 2 },
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
});

test("yields so an external abort stops normalization without caching partial pixels", async () => {
  const controller = new AbortController();
  const width = 1_000;
  const height = 1_000;
  const pixelCount = width * height;
  const sourcePixels = Uint16Array.from({ length: pixelCount }, (_, index) => index % 65_536);
  let reads = 0;
  const pixels = new Proxy(sourcePixels, {
    get(target, property) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        reads += 1;
      }
      return Reflect.get(target, property, target);
    },
  });
  const raster = {
    width,
    height,
    pixels,
    displayMin: 0,
    displayMax: 65_535,
  };
  const aborted = new Promise((resolve) => {
    setImmediate(() => {
      controller.abort();
      resolve();
    });
  });

  const rendering = renderOriginalPreview(raster, { signal: controller.signal });
  await aborted;
  await expect(rendering).rejects.toMatchObject({
    name: "AbortError",
    code: "ABORT_ERR",
  });
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThanOrEqual(4_096);

  reads = 0;
  const retry = await sharp(await renderOriginalPreview(raster)).metadata();
  expect(retry).toMatchObject({ width, height, format: "png" });
  expect(reads).toBe(pixelCount);
});

test("cancels an active Subimage Sharp pipeline and detaches its abort listener", async () => {
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
  const rendering = renderSubimagePreview(
    fixtureRaster(256, 256),
    { sourceWidth: 256, sourceHeight: 256, x: 0, y: 0, width: 256, height: 256 },
    { signal: controller.signal },
  );
  await sharpStage;
  controller.abort();

  await expect(rendering).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
});

test("detaches the original preview abort listener after success", async () => {
  const controller = new AbortController();
  const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

  await renderOriginalPreview(fixtureRaster(2, 2), { signal: controller.signal });

  expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
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
  const displayRange = await percentileDisplayRange(new Uint16Array(6).fill(4096));
  const constant = {
    width: 3,
    height: 2,
    pixels: new Uint16Array(6).fill(4096),
    ...displayRange,
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
