import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, test } from "vitest";
import { buildRoiOverviewSvg, renderRoiOverview } from "./exportRoiOverview.js";

const tempDirectories = [];

async function writeTestTiff({ width, height }) {
  const directory = await mkdtemp(path.join(tmpdir(), "roi-overview-"));
  const imagePath = path.join(directory, "source.tif");
  tempDirectories.push(directory);
  await sharp(Buffer.alloc(width * height, 128), {
    raw: { width, height, channels: 1 },
  }).tiff().toFile(imagePath);
  return imagePath;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const bounds = {
  width: 80,
  height: 60,
  groups: [
    {
      id: "outside",
      name: "Cell boundary",
      color: "#22c55e",
      analysisMode: "outside",
      roiLimits: { near: 10, mid: 20, far: 30 },
      points: [
        { id: "p1", x: 20, y: 15 },
        { id: "p2", x: 60, y: 15 },
        { id: "p3", x: 60, y: 45 },
        { id: "p4", x: 20, y: 45 },
      ],
    },
    {
      id: "inside",
      name: "Whole image",
      color: "#ef4444",
      analysisMode: "inside",
      points: [
        { id: "q1", x: 0, y: 0 },
        { id: "q2", x: 79, y: 0 },
        { id: "q3", x: 79, y: 59 },
        { id: "q4", x: 0, y: 59 },
      ],
    },
  ],
};

test("labels ROI identities and keeps editable handles out of the report", () => {
  const svg = buildRoiOverviewSvg({
    width: 80,
    height: 60,
    normalizedImageDataUrl: "data:image/png;base64,AA==",
    bounds,
  });
  expect(svg).toContain("G01-N");
  expect(svg).toContain("G01-M");
  expect(svg).toContain("G01-F");
  expect(svg).toContain("G01-A");
  expect(svg).toContain("G02-I");
  expect(svg).toContain("Cell boundary");
  expect(svg).toContain("#22c55e");
  expect(svg).toContain("0-30 px union");
  expect(svg).toContain('data-roi-id="G01-N"');
  expect(svg).not.toContain('<g clip-path=');
  expect(svg).not.toContain("stroke-opacity");
  expect(svg).not.toContain('data-role="point-handle"');
  expect(svg).not.toContain("<circle");
});

test("normalizes a TIFF and renders image plus right legend", async () => {
  const imagePath = await writeTestTiff({ width: 80, height: 60 });
  const output = await renderRoiOverview({ imagePath, bounds, maxImagePixels: 1_000_000 });
  const metadata = await sharp(output).metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBeGreaterThan(metadata.height);
});

test("rejects non-finite and out-of-bounds polygon coordinates", async () => {
  const imagePath = await writeTestTiff({ width: 80, height: 60 });
  const invalidBounds = {
    ...bounds,
    groups: [{ ...bounds.groups[0], points: [{ x: 20, y: 15 }, { x: Number.NaN, y: 20 }, { x: 81, y: 30 }] }],
  };

  await expect(renderRoiOverview({ imagePath, bounds: invalidBounds })).rejects.toThrow(/point|bounds|finite/i);
});

test("enforces the configured maximum image-pixel count", async () => {
  const imagePath = await writeTestTiff({ width: 80, height: 60 });

  await expect(renderRoiOverview({ imagePath, bounds, maxImagePixels: 100 })).rejects.toThrow();
});
