import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import { loadAnalysis, recalculateAnalysis } from "./analysisService.js";
import { createStorage } from "./storage.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "polygon-bound-analysis-service-"));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeImage(rootDir, folderName, imageName = "frame001.tif") {
  const imageDir = path.join(rootDir, folderName, "image");
  await mkdir(imageDir, { recursive: true });
  await sharp(Buffer.from([0, 1, 2, 3]), { raw: { width: 2, height: 2, channels: 1 } })
    .tiff({ compression: "none" })
    .toFile(path.join(imageDir, imageName));
}

async function writeMask(rootDir, folderName, fileName, { width = 8, height = 8, foreground = [[1, 1]] } = {}) {
  const pixels = new Uint8Array(width * height);
  for (const [x, y] of foreground) {
    pixels[y * width + x] = 255;
  }

  const maskDir = path.join(rootDir, folderName, "mask");
  await mkdir(maskDir, { recursive: true });
  const output = sharp(pixels, { raw: { width, height, channels: 1 } });
  const filePath = path.join(maskDir, fileName);

  if (/\.png$/i.test(fileName)) {
    await output.png().toFile(filePath);
  } else {
    await output.tiff({ compression: "none" }).toFile(filePath);
  }

  return filePath;
}

async function writeBounds(rootDir, folderName, bounds) {
  const boundDir = path.join(rootDir, folderName, "bound");
  await mkdir(boundDir, { recursive: true });
  await writeFile(path.join(boundDir, `${folderName}.bounds.json`), `${JSON.stringify(bounds, null, 2)}\n`);
}

function squareGroup(id = "cell") {
  return {
    id,
    name: "Cell",
    color: "#44aa99",
    points: [
      { id: `${id}-1`, x: 2, y: 2 },
      { id: `${id}-2`, x: 4, y: 2 },
      { id: `${id}-3`, x: 4, y: 4 },
      { id: `${id}-4`, x: 2, y: 4 },
    ],
  };
}

function boundsPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    imageFolder: "selected-stack-sequence_T01",
    imageFile: "frame001.tif",
    width: 8,
    height: 8,
    groups: [squareGroup()],
    ...overrides,
  };
}

async function setupStorage() {
  const rootDir = await createTempRoot();
  const folderName = "selected-stack-sequence_T01";
  await writeImage(rootDir, folderName);
  const storage = createStorage({ initialRoot: rootDir });

  return { rootDir, folderName, storage };
}

async function expectRejectCode(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

function metric(overrides = {}) {
  return {
    bandId: null,
    roiAreaPx: 0,
    skeletonPixelCount: 0,
    skeletonLengthPx: null,
    density: null,
    coverage: null,
    globalAlignment: null,
    globalOrientationDeg: null,
    radialNormalAlignment: null,
    tangentialAlignment: null,
    orientationDispersion: null,
    endpointCount: 0,
    branchpointCount: 0,
    empty: true,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe("recalculateAnalysis", () => {
  test("selects mask source by basename PNG, sorted PNG, basename TIFF, then sorted TIFF", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeBounds(rootDir, folderName, boundsPayload());
    await writeMask(rootDir, folderName, "aaa-first.png");
    await writeMask(rootDir, folderName, "frame001.png");
    await writeMask(rootDir, folderName, "frame001.tif");
    await writeMask(rootDir, folderName, "zzz-last.tiff");

    await expect(recalculateAnalysis(storage, folderName)).resolves.toMatchObject({
      analysis: { maskSource: { file: "frame001.png" } },
      hasAnalysis: true,
    });

    await unlink(path.join(rootDir, folderName, "mask", "frame001.png"));
    await expect(recalculateAnalysis(storage, folderName)).resolves.toMatchObject({
      analysis: { maskSource: { file: "aaa-first.png" } },
      hasAnalysis: true,
    });

    await unlink(path.join(rootDir, folderName, "mask", "aaa-first.png"));
    await expect(recalculateAnalysis(storage, folderName)).resolves.toMatchObject({
      analysis: { maskSource: { file: "frame001.tif" } },
      hasAnalysis: true,
    });

    await unlink(path.join(rootDir, folderName, "mask", "frame001.tif"));
    await expect(recalculateAnalysis(storage, folderName)).resolves.toMatchObject({
      analysis: { maskSource: { file: "zzz-last.tiff" } },
      hasAnalysis: true,
    });
  });

  test("creates skeleton and analysis files with metrics for a simple square boundary and mask", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeBounds(rootDir, folderName, boundsPayload());
    const maskPath = await writeMask(rootDir, folderName, "frame001.png", {
      foreground: [
        [3, 1],
        [3, 2],
        [3, 5],
      ],
    });

    const result = await recalculateAnalysis(storage, folderName, {
      roiBands: [
        { id: "near", label: "Near", fromPx: 0, toPx: 2 },
        { id: "mid", label: "Mid", fromPx: 2, toPx: 4 },
        { id: "far", label: "Far", fromPx: 4, toPx: 6 },
      ],
    });

    expect(result.hasAnalysis).toBe(true);
    expect(result.analysis).toMatchObject({
      schemaVersion: 1,
      imageFolder: folderName,
      imageFile: "frame001.tif",
      boundsFile: `${folderName}.bounds.json`,
      maskSource: { file: "frame001.png", format: "png", width: 8, height: 8, mtimeMs: expect.any(Number) },
      skeletonFile: `${folderName}.skeleton.png`,
      roiBands: [
        { id: "near", label: "Near", fromPx: 0, toPx: 2 },
        { id: "mid", label: "Mid", fromPx: 2, toPx: 4 },
        { id: "far", label: "Far", fromPx: 4, toPx: 6 },
      ],
      groups: [
        {
          groupId: "cell",
          groupName: "Cell",
          color: "#44aa99",
          bands: {
            near: expect.objectContaining({ bandId: "near", skeletonPixelCount: expect.any(Number) }),
            mid: expect.objectContaining({ bandId: "mid" }),
            far: expect.objectContaining({ bandId: "far" }),
          },
          allBands: expect.objectContaining({ skeletonPixelCount: expect.any(Number) }),
        },
      ],
      imageSummary: expect.objectContaining({
        skeletonPixelCount: expect.any(Number),
        roiAreaPx: expect.any(Number),
      }),
      warnings: [],
    });
    const maskStat = await stat(maskPath);
    expect(result.analysis.maskSource.mtimeMs).toBeCloseTo(maskStat.mtimeMs, 3);
    expect(Date.parse(result.analysis.updatedAt)).not.toBeNaN();
    expect(result.analysis.groups[0].allBands.skeletonPixelCount).toBeGreaterThan(0);
    expect(result.analysis.imageSummary.skeletonPixelCount).toBe(result.analysis.groups[0].allBands.skeletonPixelCount);

    const { skeletonPath, analysisPath } = storage.imagePaths(folderName);
    await expect(access(skeletonPath)).resolves.toBeUndefined();
    await expect(JSON.parse(await readFile(analysisPath, "utf8"))).toEqual(result.analysis);
  });

  test("prefers PNG over TIF and falls back to TIF when PNG is missing", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeBounds(rootDir, folderName, boundsPayload());
    await writeMask(rootDir, folderName, "frame001.png");
    await writeMask(rootDir, folderName, "frame001.tif");

    await expect(recalculateAnalysis(storage, folderName)).resolves.toMatchObject({
      analysis: { maskSource: { file: "frame001.png" } },
    });

    await unlink(path.join(rootDir, folderName, "mask", "frame001.png"));
    await expect(recalculateAnalysis(storage, folderName)).resolves.toMatchObject({
      analysis: { maskSource: { file: "frame001.tif" } },
    });
  });

  test("rejects missing bounds without using the empty default payload", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeMask(rootDir, folderName, "frame001.png");

    await expectRejectCode(recalculateAnalysis(storage, folderName), "MISSING_BOUNDS");
  });

  test("rejects missing mask safely", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeBounds(rootDir, folderName, boundsPayload());

    await expectRejectCode(recalculateAnalysis(storage, folderName), "MISSING_MASK");
  });

  test("rejects invalid ROI bands safely before writing analysis", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeBounds(rootDir, folderName, boundsPayload());
    await writeMask(rootDir, folderName, "frame001.png");

    await expectRejectCode(
      recalculateAnalysis(storage, folderName, {
        roiBands: [
          { id: "near", label: "Near", fromPx: 0, toPx: 2 },
          { id: "far", label: "Far", fromPx: 2, toPx: 4 },
          { id: "mid", label: "Mid", fromPx: 4, toPx: 6 },
        ],
      }),
      "INVALID_ROI_BANDS",
    );
    await expect(access(storage.imagePaths(folderName).analysisPath)).rejects.toThrow();
  });

  test("rejects mask and bounds dimension mismatch safely", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeBounds(rootDir, folderName, boundsPayload({ width: 7, height: 8 }));
    await writeMask(rootDir, folderName, "frame001.png", { width: 8, height: 8 });

    await expectRejectCode(recalculateAnalysis(storage, folderName), "DIMENSION_MISMATCH");
  });

  test("uses mask dimensions when saved bounds width and height are null", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeBounds(rootDir, folderName, boundsPayload({ width: null, height: null }));
    await writeMask(rootDir, folderName, "frame001.png", { width: 8, height: 8 });

    await expect(recalculateAnalysis(storage, folderName)).resolves.toMatchObject({
      analysis: { imageSummary: expect.objectContaining({ width: 8, height: 8 }) },
      hasAnalysis: true,
    });
  });

  test("rejects boundary groups with fewer than three points and self intersections", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeMask(rootDir, folderName, "frame001.png");
    await writeBounds(
      rootDir,
      folderName,
      boundsPayload({
        groups: [{ id: "line", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
      }),
    );
    await expectRejectCode(recalculateAnalysis(storage, folderName), "INVALID_BOUNDS");

    await writeBounds(
      rootDir,
      folderName,
      boundsPayload({
        groups: [
          {
            id: "bow-tie",
            points: [
              { x: 1, y: 1 },
              { x: 5, y: 5 },
              { x: 1, y: 5 },
              { x: 5, y: 1 },
            ],
          },
        ],
      }),
    );
    await expectRejectCode(recalculateAnalysis(storage, folderName), "INVALID_BOUNDS");
  });

  test("rejects any malformed saved group instead of silently filtering it out", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeMask(rootDir, folderName, "frame001.png");
    await writeBounds(
      rootDir,
      folderName,
      boundsPayload({
        groups: [
          squareGroup("cell"),
          { id: "line", name: "Line", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
        ],
      }),
    );
    await expectRejectCode(recalculateAnalysis(storage, folderName), "INVALID_BOUNDS");

    await writeBounds(
      rootDir,
      folderName,
      boundsPayload({
        groups: [squareGroup("duplicate"), squareGroup("duplicate")],
      }),
    );
    await expectRejectCode(recalculateAnalysis(storage, folderName), "INVALID_BOUNDS");

    await writeBounds(
      rootDir,
      folderName,
      boundsPayload({
        groups: [{ name: "Missing id", points: squareGroup("missing").points }],
      }),
    );
    await expectRejectCode(recalculateAnalysis(storage, folderName), "INVALID_BOUNDS");
  });

  test("loads saved analysis through a public DTO sanitizer", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    const { analysisDir, analysisPath } = storage.imagePaths(folderName);
    const saved = {
      schemaVersion: 1,
      imageFolder: path.join(rootDir, folderName),
      imageFile: path.join(rootDir, folderName, "image", "frame001.tif"),
      boundsFile: path.join(rootDir, folderName, "bound", `${folderName}.bounds.json`),
      maskSource: {
        file: path.join(rootDir, folderName, "mask", "frame001.png"),
        format: "png",
        width: 8,
        height: 8,
        mtimeMs: 123.45,
        path: path.join(rootDir, folderName, "mask", "frame001.png"),
      },
      skeletonFile: path.join(rootDir, folderName, "Skeletonize", `${folderName}.skeleton.png`),
      skeletonPath: path.join(rootDir, folderName, "Skeletonize", `${folderName}.skeleton.png`),
      roiBands: [
        { id: "near", label: "Near", fromPx: 0, toPx: 2 },
        { id: "mid", label: "Mid", fromPx: 2, toPx: 4 },
        { id: "far", label: "Far", fromPx: 4, toPx: 6 },
      ],
      groups: [
        {
          groupId: "cell",
          groupName: "Cell",
          color: null,
          bands: { near: metric({ bandId: "near" }) },
          allBands: metric(),
          absolutePath: path.join(rootDir, "leak"),
        },
      ],
      imageSummary: { ...metric(), width: 8, height: 8, bands: { near: metric({ bandId: "near" }) } },
      warnings: ["safe warning", path.join(rootDir, "leaky-warning")],
      updatedAt: "2026-07-05T00:00:00.000Z",
      arbitrary: "stale",
    };
    await mkdir(analysisDir, { recursive: true });
    await writeFile(analysisPath, JSON.stringify(saved));

    const result = await loadAnalysis(storage, folderName);

    expect(result.hasAnalysis).toBe(true);
    expect(result.analysis).toEqual({
      schemaVersion: 1,
      imageFolder: folderName,
      imageFile: "frame001.tif",
      boundsFile: `${folderName}.bounds.json`,
      maskSource: {
        file: "frame001.png",
        format: "png",
        width: 8,
        height: 8,
        mtimeMs: 123.45,
      },
      skeletonFile: `${folderName}.skeleton.png`,
      roiBands: saved.roiBands,
      groups: [
        {
          groupId: "cell",
          groupName: "Cell",
          color: null,
          bands: { near: metric({ bandId: "near" }) },
          allBands: metric(),
        },
      ],
      imageSummary: saved.imageSummary,
      warnings: ["safe warning"],
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain(rootDir);
    expect(JSON.stringify(result)).not.toContain("arbitrary");
  });

  test("rejects unrecoverably malformed saved analysis shape", async () => {
    const { folderName, storage } = await setupStorage();
    const { analysisDir, analysisPath } = storage.imagePaths(folderName);
    await mkdir(analysisDir, { recursive: true });
    await writeFile(analysisPath, JSON.stringify({ schemaVersion: 1, groups: "not an array" }));

    await expectRejectCode(loadAnalysis(storage, folderName), "INVALID_ANALYSIS");
  });

  test("writes skeleton through a temp path and leaves existing skeleton untouched when the writer fails", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    const paths = storage.imagePaths(folderName);
    await writeBounds(rootDir, folderName, boundsPayload());
    await writeMask(rootDir, folderName, "frame001.png");
    await mkdir(paths.skeletonDir, { recursive: true });
    await writeFile(paths.skeletonPath, "existing skeleton");

    await expectRejectCode(
      recalculateAnalysis(storage, folderName, {
        writeSkeleton: async (outputPath) => {
          expect(outputPath).toMatch(/\.tmp-/);
          await writeFile(outputPath, "partial skeleton");
          throw new Error("writer failed");
        },
      }),
      "CALCULATION_FAILED",
    );

    await expect(readFile(paths.skeletonPath, "utf8")).resolves.toBe("existing skeleton");
    await expect(readdir(paths.skeletonDir)).resolves.toEqual([`${folderName}.skeleton.png`]);
  });

  test("leaves no skeleton temp files after successful recalculation", async () => {
    const { rootDir, folderName, storage } = await setupStorage();
    await writeBounds(rootDir, folderName, boundsPayload());
    await writeMask(rootDir, folderName, "frame001.png");

    await recalculateAnalysis(storage, folderName);

    await expect(readdir(storage.imagePaths(folderName).skeletonDir)).resolves.toEqual([`${folderName}.skeleton.png`]);
  });
});
