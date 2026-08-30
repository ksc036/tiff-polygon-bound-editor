import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import { mapGrey16PixelsTo8Bit } from "./exportOriginal8BitBatch.js";

const temporaryRoots = [];

function makeGrey16Tiff(width, height, values) {
  const tags = [
    [256, 4, width],
    [257, 4, height],
    [258, 3, 16],
    [259, 3, 1],
    [262, 3, 1],
    [273, 4, 0],
    [277, 3, 1],
    [278, 4, height],
    [279, 4, values.length * 2],
    [284, 3, 1],
    [339, 3, 1],
  ];
  const pixelOffset = 8 + 2 + tags.length * 12 + 4;
  tags[5][2] = pixelOffset;
  const output = Buffer.alloc(pixelOffset + values.length * 2);
  output.write("II", 0, "ascii");
  output.writeUInt16LE(42, 2);
  output.writeUInt32LE(8, 4);
  output.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, value], index) => {
    const offset = 10 + index * 12;
    output.writeUInt16LE(tag, offset);
    output.writeUInt16LE(type, offset + 2);
    output.writeUInt32LE(1, offset + 4);
    if (type === 3) output.writeUInt16LE(value, offset + 8);
    else output.writeUInt32LE(value, offset + 8);
  });
  values.forEach((value, index) => output.writeUInt16LE(value, pixelOffset + index * 2));
  return output;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("original TIFF 8-bit PNG batch export", () => {
  test("maps a fixed display range with clipping and rounding", () => {
    const result = mapGrey16PixelsTo8Bit(Uint16Array.from([100, 200, 250, 300, 400]), 200, 300);
    expect([...result]).toEqual([0, 0, 128, 255, 255]);
  });

  test("writes common, auto, and red mask-overlay PNG files next to the TIFF", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "original-8bit-png-"));
    temporaryRoots.push(root);
    const imageFolder = "sample_T01";
    const originDir = path.join(root, imageFolder, "origin");
    const maskDir = path.join(root, imageFolder, "mask");
    await mkdir(originDir, { recursive: true });
    await mkdir(maskDir, { recursive: true });

    const values = [
      1000, 1250, 1500, 1750,
      2000, 2250, 2500, 2750,
      3000, 3250, 3500, 3750,
      4000, 3000, 2000, 1000,
    ];
    const sourcePath = path.join(originDir, `${imageFolder}.tif`);
    await writeFile(sourcePath, makeGrey16Tiff(4, 4, values));
    const maskPixels = Buffer.from([
      0, 0, 255, 0,
      0, 0, 0, 0,
      255, 0, 0, 0,
      255, 0, 0, 0,
    ]);
    await sharp(maskPixels, { raw: { width: 4, height: 4, channels: 1 } })
      .png()
      .toFile(path.join(maskDir, `${imageFolder}_mask.png`));

    const command = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "server", "exportOriginal8BitBatch.js"),
        root,
        "1500",
        "3500",
        "4",
        "4",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(command.status, command.stderr || command.stdout).toBe(0);

    const records = JSON.parse(command.stdout);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      width: 4,
      height: 4,
      rawPixelMin: 1000,
      rawPixelMax: 4000,
      commonDisplayMin: 1500,
      commonDisplayMax: 3500,
      maskOverlayPngRelativePath: path.join(
        imageFolder,
        "origin",
        `${imageFolder}_8bit_common_min1500_max3500_mask_overlay.png`,
      ),
    });

    const commonPath = path.join(originDir, `${imageFolder}_8bit_common_min1500_max3500.png`);
    const autoPath = path.join(originDir, `${imageFolder}_8bit_auto.png`);
    const maskOverlayPath = path.join(
      originDir,
      `${imageFolder}_8bit_common_min1500_max3500_mask_overlay.png`,
    );
    const commonMetadata = await sharp(commonPath).metadata();
    const autoMetadata = await sharp(autoPath).metadata();
    const maskOverlayMetadata = await sharp(maskOverlayPath).metadata();
    expect([commonMetadata.width, commonMetadata.height, commonMetadata.depth]).toEqual([4, 4, "uchar"]);
    expect([autoMetadata.width, autoMetadata.height, autoMetadata.depth]).toEqual([4, 4, "uchar"]);
    expect([
      maskOverlayMetadata.width,
      maskOverlayMetadata.height,
      maskOverlayMetadata.depth,
      maskOverlayMetadata.channels,
    ]).toEqual([4, 4, "uchar", 3]);

    const commonPixels = await sharp(commonPath).raw().toBuffer({ resolveWithObject: true });
    const autoPixels = await sharp(autoPath).raw().toBuffer({ resolveWithObject: true });
    const commonAt = (index) => commonPixels.data[index * commonPixels.info.channels];
    expect([commonAt(0), commonAt(2), commonAt(10), commonAt(12)])
      .toEqual([0, 0, 255, 255]);
    expect([Math.min(...autoPixels.data), Math.max(...autoPixels.data)]).toEqual([0, 255]);

    const overlayPixels = await sharp(maskOverlayPath).raw().toBuffer({ resolveWithObject: true });
    const overlayAt = (index) => {
      const start = index * overlayPixels.info.channels;
      return [...overlayPixels.data.subarray(start, start + 3)];
    };
    expect(overlayAt(0)).toEqual([0, 0, 0]);
    expect(overlayAt(2)).toEqual([102, 0, 0]);
    expect(overlayAt(8)).toEqual([217, 115, 115]);
    expect(overlayAt(12)).toEqual([255, 153, 153]);

    const sourceAfter = await readFile(sourcePath);
    expect(sourceAfter.length).toBeGreaterThan(0);
  }, 30_000);
});
