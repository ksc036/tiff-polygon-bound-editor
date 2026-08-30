import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, test, vi } from "vitest";
import { assignOutwardRoiPixels } from "./analysisGeometry.js";
import {
  buildOutsideRoiOverlay,
  buildRoiOverviewSvg,
  MAX_ROI_OVERVIEW_PIXELS,
  OUTSIDE_OVERLAY_ALPHA,
  planRoiOverviewFrame,
  renderRoiOverview,
} from "./exportRoiOverview.js";

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
    tempDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })),
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

const nearbyOutsideBounds = {
  width: 22,
  height: 14,
  groups: [
    {
      id: "a-left",
      name: "Left boundary",
      color: "#22c55e",
      analysisMode: "outside",
      roiLimits: { near: 1, mid: 2, far: 3 },
      points: [
        { x: 4, y: 4 },
        { x: 8, y: 4 },
        { x: 8, y: 8 },
        { x: 4, y: 8 },
      ],
    },
    {
      id: "z-right",
      name: "Right boundary",
      color: "#a855f7",
      analysisMode: "outside",
      roiLimits: { near: 3, mid: 5, far: 7 },
      points: [
        { x: 12, y: 4 },
        { x: 16, y: 4 },
        { x: 16, y: 8 },
        { x: 12, y: 8 },
      ],
    },
  ],
};

const expectedRoiBands = [
  { id: "near", label: "Near", fromPx: 0, toPx: 20 },
  { id: "mid", label: "Mid", fromPx: 20, toPx: 50 },
  { id: "far", label: "Far", fromPx: 50, toPx: 100 },
];

const nearbyGroupsWithBands = [
  {
    ...nearbyOutsideBounds.groups[0],
    roiBands: [
      { id: "near", label: "Near", fromPx: 0, toPx: 1 },
      { id: "mid", label: "Mid", fromPx: 1, toPx: 2 },
      { id: "far", label: "Far", fromPx: 2, toPx: 3 },
    ],
  },
  {
    ...nearbyOutsideBounds.groups[1],
    roiBands: [
      { id: "near", label: "Near", fromPx: 0, toPx: 3 },
      { id: "mid", label: "Mid", fromPx: 3, toPx: 5 },
      { id: "far", label: "Far", fromPx: 5, toPx: 7 },
    ],
  },
];

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
  expect(svg).not.toContain("roi-overview-mask");
  expect(svg).not.toContain('data-role="point-handle"');
  expect(svg).not.toContain("<circle");
});

test("builds exclusive assignment runs when no raster outside overlay is supplied", () => {
  const svg = buildRoiOverviewSvg({
    width: nearbyOutsideBounds.width,
    height: nearbyOutsideBounds.height,
    normalizedImageDataUrl: "data:image/png;base64,AA==",
    bounds: nearbyOutsideBounds,
  });
  const [, imageX, imageY] = svg.match(/<image x="([^"]+)" y="([^"]+)"/) ?? [];
  const farRuns = [...svg.matchAll(/<rect data-role="outside-assignment-run" data-group-id="a-left" data-band-id="far" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="1"/g)];
  const targetX = Number(imageX) + 10;
  const targetY = Number(imageY) + 6;

  expect(svg).toContain('data-role="outside-assignment-runs"');
  expect(svg).not.toContain("roi-overview-mask");
  expect(svg).not.toContain("stroke-opacity");
  expect(
    farRuns.some(([, x, y, width]) => Number(y) === targetY && Number(x) <= targetX && targetX < Number(x) + Number(width)),
  ).toBe(true);
});

test("renders one semi-transparent outside overlay from canonical nearest-group assignments", async () => {
  const assignments = assignOutwardRoiPixels({
    width: nearbyOutsideBounds.width,
    height: nearbyOutsideBounds.height,
    groups: nearbyGroupsWithBands,
    roiBands: expectedRoiBands,
  });
  const overlay = await buildOutsideRoiOverlay({
    width: nearbyOutsideBounds.width,
    height: nearbyOutsideBounds.height,
    bounds: nearbyOutsideBounds,
  });
  const { data, info } = await sharp(overlay).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelAt = (x, y) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels));

  expect(assignments.get("10,6")).toMatchObject({ groupId: "a-left", bandId: "far" });
  expect(pixelAt(10, 6)).toEqual([59, 130, 246, OUTSIDE_OVERLAY_ALPHA]);

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const assignment = assignments.get(`${x},${y}`);
      const pixel = pixelAt(x, y);
      if (!assignment) {
        expect(pixel[3]).toBe(0);
      } else {
        expect(pixel[3]).toBe(OUTSIDE_OVERLAY_ALPHA);
      }
    }
  }

  const svg = buildRoiOverviewSvg({
    width: nearbyOutsideBounds.width,
    height: nearbyOutsideBounds.height,
    normalizedImageDataUrl: "data:image/png;base64,AA==",
    outsideOverlayDataUrl: `data:image/png;base64,${overlay.toString("base64")}`,
    bounds: nearbyOutsideBounds,
  });
  expect(svg).toContain('data-role="outside-overlay"');
  expect(svg).toContain(`data-alpha="${OUTSIDE_OVERLAY_ALPHA}"`);
  expect(svg).not.toContain("roi-overview-mask");
});

test("normalizes a TIFF and renders image plus right legend", async () => {
  const imagePath = await writeTestTiff({ width: 80, height: 60 });
  const output = await renderRoiOverview({ imagePath, bounds, maxImagePixels: 1_000_000 });
  const metadata = await sharp(output).metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBeGreaterThan(metadata.height);
});

test("plans a capped render frame for a 10000 by 10000 source without allocating source-sized pixels", () => {
  const hugeBounds = {
    width: 10_000,
    height: 10_000,
    groups: [{
      id: "outside",
      name: "Large boundary",
      color: "#22c55e",
      analysisMode: "outside",
      roiLimits: { near: 100, mid: 200, far: 300 },
      points: [
        { x: 2_500, y: 2_500 },
        { x: 7_500, y: 2_500 },
        { x: 7_500, y: 7_500 },
        { x: 2_500, y: 7_500 },
      ],
    }],
  };

  const frame = planRoiOverviewFrame({
    width: 10_000,
    height: 10_000,
    bounds: hugeBounds,
  });

  expect(frame.width * frame.height).toBeLessThanOrEqual(MAX_ROI_OVERVIEW_PIXELS);
  expect(frame.width).toBeLessThan(10_000);
  expect(frame.renderBounds.groups[0].points[0]).toEqual({ x: 500, y: 500 });
  expect(frame.renderBounds.groups[0].roiLimits).toEqual({ near: 20, mid: 40, far: 60 });
  expect(frame.legendBounds.groups[0].roiLimits).toEqual({ near: 100, mid: 200, far: 300 });
});

test("scales default outside distances when large-image bounds omit explicit ROI limits", () => {
  const hugeBounds = {
    width: 10_000,
    height: 10_000,
    groups: [{
      id: "outside",
      analysisMode: "outside",
      points: [
        { x: 2_500, y: 2_500 },
        { x: 7_500, y: 2_500 },
        { x: 7_500, y: 7_500 },
        { x: 2_500, y: 7_500 },
      ],
    }],
  };

  const frame = planRoiOverviewFrame({
    width: 10_000,
    height: 10_000,
    bounds: hugeBounds,
  });

  expect(frame.renderBounds.groups[0].roiLimits).toEqual({ near: 4, mid: 10, far: 20 });
  expect(frame.legendBounds.groups[0].roiLimits).toBeUndefined();
});

test("cancels the active Sharp pipeline and detaches its abort listener", async () => {
  const imagePath = await writeTestTiff({ width: 80, height: 60 });
  const controller = new AbortController();
  const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
  const rendering = renderRoiOverview({
    imagePath,
    bounds,
    maxImagePixels: 1_000_000,
    signal: controller.signal,
  });
  controller.abort();

  await expect(rendering).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
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
