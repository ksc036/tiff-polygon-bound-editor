import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readGrey16RawFromImage } from "./imageProcessing.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "polygon-bound-image-processing-"));
  tempRoots.push(rootDir);
  return rootDir;
}

function uint16Tiff({ width, height, pixels, description = null }) {
  const entryCount = description ? 10 : 9;
  const ifdOffset = 8;
  const dataOffset = ifdOffset + 2 + entryCount * 12 + 4;
  const descriptionBuffer = description ? Buffer.from(`${description}\0`, "utf8") : null;
  const descriptionOffset = dataOffset + pixels.length * 2;
  const buffer = Buffer.alloc(descriptionOffset + (descriptionBuffer?.length ?? 0));
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
    if (type === 3 && count === 1) {
      buffer.writeUInt16LE(value, offset + 8);
    } else {
      buffer.writeUInt32LE(value, offset + 8);
    }
    offset += 12;
  };

  writeEntry(256, 4, 1, width);
  writeEntry(257, 4, 1, height);
  writeEntry(258, 3, 1, 16);
  writeEntry(259, 3, 1, 1);
  writeEntry(262, 3, 1, 1);
  if (descriptionBuffer) {
    writeEntry(270, 2, descriptionBuffer.length, descriptionOffset);
  }
  writeEntry(273, 4, 1, dataOffset);
  writeEntry(277, 3, 1, 1);
  writeEntry(278, 4, 1, height);
  writeEntry(279, 4, 1, pixels.length * 2);
  buffer.writeUInt32LE(0, offset);

  pixels.forEach((value, index) => buffer.writeUInt16LE(value, dataOffset + index * 2));
  descriptionBuffer?.copy(buffer, descriptionOffset);

  return buffer;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe("readGrey16RawFromImage", () => {
  test("returns raw uint16 little-endian pixels with dimensions and display range", async () => {
    const rootDir = await createTempRoot();
    const imagePath = path.join(rootDir, "frame.tif");
    await writeFile(imagePath, uint16Tiff({ width: 3, height: 2, pixels: [42, 65535, 7, 1000, 4096, 128] }));

    const raw = await readGrey16RawFromImage(imagePath);

    expect(raw.width).toBe(3);
    expect(raw.height).toBe(2);
    expect(raw.min).toBe(7);
    expect(raw.max).toBe(65535);
    expect([...new Uint16Array(raw.buffer.buffer, raw.buffer.byteOffset, raw.buffer.byteLength / 2)]).toEqual([
      42,
      65535,
      7,
      1000,
      4096,
      128,
    ]);
  });

  test("prefers ImageJ metadata min and max over pixel display range", async () => {
    const rootDir = await createTempRoot();
    const imagePath = path.join(rootDir, "frame.tif");
    await writeFile(
      imagePath,
      uint16Tiff({
        width: 2,
        height: 2,
        pixels: [10, 20, 30, 40],
        description: "ImageJ=1.54f\nmin=123.5\nmax=456.75\n",
      }),
    );

    const raw = await readGrey16RawFromImage(imagePath);

    expect(raw.min).toBe(123.5);
    expect(raw.max).toBe(456.75);
  });
});
