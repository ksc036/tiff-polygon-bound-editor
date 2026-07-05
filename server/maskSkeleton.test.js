import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import { readBinaryMask, thinBinaryMask, writeSkeletonPng } from "./maskSkeleton.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "polygon-bound-mask-skeleton-"));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeRawImage(imagePath, { width, height, channels, pixels }) {
  await sharp(Buffer.from(pixels), { raw: { width, height, channels } }).toFile(imagePath);
}

function foregroundCount(binary) {
  return binary.data.reduce((sum, value) => sum + value, 0);
}

function isSingleConnectedComponent(binary) {
  const firstForeground = binary.data.findIndex((value) => value === 1);
  if (firstForeground === -1) {
    return false;
  }

  const visited = new Set([firstForeground]);
  const queue = [firstForeground];
  while (queue.length > 0) {
    const index = queue.shift();
    const x = index % binary.width;
    const y = Math.floor(index / binary.width);
    const neighbors = [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ];

    for (const [neighborX, neighborY] of neighbors) {
      if (neighborX < 0 || neighborX >= binary.width || neighborY < 0 || neighborY >= binary.height) {
        continue;
      }

      const neighborIndex = neighborY * binary.width + neighborX;
      if (binary.data[neighborIndex] === 1 && !visited.has(neighborIndex)) {
        visited.add(neighborIndex);
        queue.push(neighborIndex);
      }
    }
  }

  return visited.size === foregroundCount(binary);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe("readBinaryMask", () => {
  test("treats any non-alpha RGB channel as foreground", async () => {
    const rootDir = await createTempRoot();
    const maskPath = path.join(rootDir, "rgb-mask.png");
    await writeRawImage(maskPath, {
      width: 4,
      height: 1,
      channels: 3,
      pixels: [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0],
    });

    const mask = await readBinaryMask(maskPath);

    expect(mask).toEqual({
      data: new Uint8Array([1, 1, 1, 0]),
      width: 4,
      height: 1,
    });
  });

  test("does not treat alpha-only RGBA pixels as foreground", async () => {
    const rootDir = await createTempRoot();
    const maskPath = path.join(rootDir, "rgba-mask.png");
    await writeRawImage(maskPath, {
      width: 4,
      height: 1,
      channels: 4,
      pixels: [0, 0, 0, 255, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 6, 255],
    });

    const mask = await readBinaryMask(maskPath);

    expect([...mask.data]).toEqual([0, 0, 1, 1]);
    expect(mask.width).toBe(4);
    expect(mask.height).toBe(1);
  });

  test("treats transparent colored RGBA pixels as foreground but ignores alpha-only pixels", async () => {
    const rootDir = await createTempRoot();
    const maskPath = path.join(rootDir, "transparent-colored-mask.png");
    await writeRawImage(maskPath, {
      width: 4,
      height: 1,
      channels: 4,
      pixels: [9, 0, 0, 0, 0, 8, 0, 0, 0, 0, 7, 0, 0, 0, 0, 255],
    });

    const mask = await readBinaryMask(maskPath);

    expect([...mask.data]).toEqual([1, 1, 1, 0]);
    expect(mask.width).toBe(4);
    expect(mask.height).toBe(1);
  });

  test("treats nonzero grayscale TIF pixels as foreground", async () => {
    const rootDir = await createTempRoot();
    const maskPath = path.join(rootDir, "grey-mask.tif");
    await sharp(Buffer.from([0, 12, 0, 255, 1, 0]), { raw: { width: 3, height: 2, channels: 1 } })
      .tiff({ compression: "none" })
      .toFile(maskPath);

    const mask = await readBinaryMask(maskPath);

    expect([...mask.data]).toEqual([0, 1, 0, 1, 1, 0]);
    expect(mask.width).toBe(3);
    expect(mask.height).toBe(2);
  });
});

describe("thinBinaryMask", () => {
  test("rejects non-positive dimensions", () => {
    expect(() => thinBinaryMask({ data: new Uint8Array(), width: 0, height: 0 })).toThrow(
      "Binary image width and height must be positive.",
    );
  });

  test("thins a thick line while preserving component connectivity", () => {
    const thickLine = {
      width: 7,
      height: 5,
      data: new Uint8Array([
        0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0,
        0, 1, 1, 1, 1, 1, 0,
        0, 1, 1, 1, 1, 1, 0,
        0, 0, 0, 0, 0, 0, 0,
      ]),
    };

    const skeleton = thinBinaryMask(thickLine);

    expect(skeleton.width).toBe(7);
    expect(skeleton.height).toBe(5);
    expect(foregroundCount(skeleton)).toBeLessThan(foregroundCount(thickLine));
    expect(foregroundCount(skeleton)).toBeGreaterThan(0);
    expect(isSingleConnectedComponent(skeleton)).toBe(true);
    expect([...thinBinaryMask(thickLine).data]).toEqual([...skeleton.data]);
  });

  test("thins a foreground rectangle that touches the image border", () => {
    const borderRectangle = {
      width: 5,
      height: 5,
      data: new Uint8Array([
        1, 1, 1, 1, 1,
        1, 1, 1, 1, 1,
        1, 1, 1, 1, 1,
        1, 1, 1, 1, 1,
        1, 1, 1, 1, 1,
      ]),
    };

    const skeleton = thinBinaryMask(borderRectangle);

    expect(skeleton.width).toBe(5);
    expect(skeleton.height).toBe(5);
    expect(foregroundCount(skeleton)).toBeLessThan(foregroundCount(borderRectangle));
    expect(foregroundCount(skeleton)).toBeGreaterThan(0);
    expect(isSingleConnectedComponent(skeleton)).toBe(true);
  });

  test("preserves at least one pixel for a tiny all-foreground mask", () => {
    const tinyBlock = {
      width: 2,
      height: 2,
      data: new Uint8Array([
        1, 1,
        1, 1,
      ]),
    };

    const skeleton = thinBinaryMask(tinyBlock);

    expect(skeleton.width).toBe(2);
    expect(skeleton.height).toBe(2);
    expect(foregroundCount(skeleton)).toBeGreaterThan(0);
    expect(isSingleConnectedComponent(skeleton)).toBe(true);
  });

  test("preserves at least one pixel for a tiny component at an image border", () => {
    const cornerBlock = {
      width: 3,
      height: 3,
      data: new Uint8Array([
        0, 0, 0,
        0, 1, 1,
        0, 1, 1,
      ]),
    };

    const skeleton = thinBinaryMask(cornerBlock);

    expect(skeleton.width).toBe(3);
    expect(skeleton.height).toBe(3);
    expect(foregroundCount(skeleton)).toBeGreaterThan(0);
    expect(isSingleConnectedComponent(skeleton)).toBe(true);
  });
});

describe("writeSkeletonPng", () => {
  test("writes background as 0 and foreground as 255", async () => {
    const rootDir = await createTempRoot();
    const outputPath = path.join(rootDir, "nested", "skeleton.png");

    await writeSkeletonPng(outputPath, {
      width: 3,
      height: 2,
      data: new Uint8Array([0, 1, 0, 1, 1, 0]),
    });

    const { data, info } = await sharp(outputPath).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(3);
    expect(info.height).toBe(2);
    expect(info.channels).toBe(1);
    expect([...data]).toEqual([0, 255, 0, 255, 255, 0]);
  });
});
