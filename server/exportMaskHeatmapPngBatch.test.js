import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MASK heatmap PNG batch export", () => {
  test("writes app-compatible JSON plus annotated, heatmap-only, original, and colorbar PNGs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mask-heatmap-png-"));
    temporaryRoots.push(root);
    const imageFolder = "sample_T01";
    const bundle = path.join(root, imageFolder);
    await mkdir(path.join(bundle, "image"), { recursive: true });
    await mkdir(path.join(bundle, "mask"), { recursive: true });

    const originalPixels = Buffer.from([
      0, 16, 32, 48,
      64, 80, 96, 112,
      128, 144, 160, 176,
      192, 208, 224, 255,
    ]);
    await sharp(originalPixels, { raw: { width: 4, height: 4, channels: 1 } })
      .tiff()
      .toFile(path.join(bundle, "image", `${imageFolder}.tif`));

    const maskPixels = Buffer.from([
      255, 0, 0, 0,
      255, 0, 0, 0,
      255, 255, 255, 0,
      255, 255, 0, 255,
    ]);
    await sharp(maskPixels, { raw: { width: 4, height: 4, channels: 1 } })
      .png()
      .toFile(path.join(bundle, "mask", `${imageFolder}_mask.png`));

    const command = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "server", "exportMaskHeatmapPngBatch.js"), root, "2"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(command.status, command.stderr || command.stdout).toBe(0);

    const outputDir = path.join(bundle, "heatmap", "2x2");
    const prefix = `${imageFolder}_cell_2px_pixel_density`;
    const payload = JSON.parse(await readFile(path.join(outputDir, `${imageFolder}.heatmap.json`), "utf8"));
    expect(payload).toMatchObject({ width: 4, height: 4, columns: 2, rows: 2 });
    expect(payload.cells.map((cell) => cell.pixelDensity)).toEqual([0.5, 0, 1, 0.5]);

    const annotatedPath = path.join(outputDir, `${prefix}.png`);
    const annotated = await sharp(annotatedPath).metadata();
    const heatmapOnlyPath = path.join(outputDir, `${prefix}_heatmap_only.png`);
    const heatmapOnly = await sharp(heatmapOnlyPath).metadata();
    const original = await sharp(path.join(outputDir, `${prefix}_original.png`)).metadata();
    const colorbarPath = path.join(outputDir, `${prefix}_colorbar.png`);
    const colorbar = await sharp(colorbarPath).metadata();

    expect(annotated.width).toBeGreaterThanOrEqual(960);
    expect(annotated.height).toBeGreaterThanOrEqual(520);
    expect([heatmapOnly.width, heatmapOnly.height]).toEqual([4, 4]);
    expect([original.width, original.height]).toEqual([4, 4]);
    expect([colorbar.width, colorbar.height]).toEqual([180, 390]);

    const heatmapPixels = await sharp(heatmapOnlyPath).raw().toBuffer();
    expect([...heatmapPixels.subarray(0, 3)]).toEqual([188, 55, 84]);
    expect([...heatmapPixels.subarray(2 * 3, 3 * 3)]).toEqual([0, 0, 4]);

    const annotatedPixels = await sharp(annotatedPath).raw().toBuffer({ resolveWithObject: true });
    const annotatedGridOffset = (186 * annotatedPixels.info.width + 142) * annotatedPixels.info.channels;
    expect([...annotatedPixels.data.subarray(annotatedGridOffset, annotatedGridOffset + 3)])
      .toEqual([188, 55, 84]);

    const colorbarPixels = await sharp(colorbarPath).raw().toBuffer({ resolveWithObject: true });
    const topOffset = (35 * colorbarPixels.info.width + 24) * colorbarPixels.info.channels;
    const bottomOffset = (334 * colorbarPixels.info.width + 24) * colorbarPixels.info.channels;
    expect([...colorbarPixels.data.subarray(topOffset, topOffset + 3)]).toEqual([252, 255, 164]);
    expect([...colorbarPixels.data.subarray(bottomOffset, bottomOffset + 3)]).toEqual([0, 0, 4]);
  }, 30_000);
});
