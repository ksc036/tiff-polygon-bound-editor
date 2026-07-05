# Outward ROI Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add outward cell-boundary ROI analysis that skeletonizes each image mask, computes near/mid/far metrics, saves per-image JSON, and lets the UI load/recalculate saved analysis.

**Architecture:** Keep analysis logic server-side in small focused modules. `storage` owns folder paths and saved JSON I/O, `analysisGeometry` owns polygon/ROI/orientation math, `maskSkeleton` owns mask reading and thinning, `analysisService` orchestrates validation and output files, and `App.jsx` adds the analysis panel without changing boundary editing behavior.

**Tech Stack:** React 18, Express 4, Vitest, Testing Library, Sharp, Node fs/path APIs.

---

## File Structure

- Create `server/analysisGeometry.js`: pure functions for ROI band validation, point-in-polygon, segment distances, exclusive outward ROI assignment, skeleton topology, local orientation, and metric aggregation.
- Create `server/analysisGeometry.test.js`: unit fixtures for band validation, outward-only pixels, multi-group assignment, topology counts, and alignment metrics.
- Create `server/maskSkeleton.js`: read masks via Sharp, convert any non-zero non-alpha channel to foreground, run Zhang-Suen thinning, and write skeleton PNG.
- Create `server/maskSkeleton.test.js`: generated PNG fixtures for channel handling and skeleton thinning.
- Create `server/analysisService.js`: load saved bounds and mask, validate dimensions/polygons, call skeleton/geometry, write `Skeletonize/*.skeleton.png` and `analysis/*.analysis.json`, and expose saved-analysis loading.
- Create `server/analysisService.test.js`: end-to-end service tests with temp folders.
- Modify `server/storage.js`: add `maskDir`, `skeletonDir`, `analysisDir`, `analysisPath`, and `skeletonPath` to `imagePaths`; add `loadAnalysis` and `saveAnalysis`.
- Modify `server/storage.test.js`: cover new paths and saved analysis loading.
- Modify `server/app.js`: add `GET /api/images/:id/analysis` and `POST /api/images/:id/analysis/recalculate`; map user-data failures to safe 400/409/422 responses.
- Modify `server/app.test.js`: cover API success, missing analysis, invalid bands, missing bounds, mask fallback, and safe errors.
- Modify `src/App.jsx`: add analysis state, ROI limit controls, load saved analysis on image load, recalculate button, stale warnings, and metrics table.
- Modify `src/App.test.jsx`: cover saved analysis load, default ROI controls, recalculate payload, returned metrics, and error state.
- Modify `src/styles.css`: add compact analysis panel styles matching the existing dark utility UI.

## Visual Direction

- Visual thesis: Extend the existing dense dark microscopy editor with a compact analysis workbench that feels like an instrument panel, not a marketing page.
- Content plan: Existing toolbar and editor stay primary; analysis controls sit below the point-order panel with ROI limits, mask/skeleton metadata, recalculate action, warnings, and a table of group/band metrics.
- Interaction plan: Buttons use existing hover/focus states; recalculation shows loading/disabled state; stale/warning chips use the current status-chip language.

### Task 1: Pure ROI Geometry And Metrics

**Files:**
- Create: `server/analysisGeometry.js`
- Create: `server/analysisGeometry.test.js`

- [ ] **Step 1: Write failing tests for ROI band validation**

Create `server/analysisGeometry.test.js` with:

```js
import { describe, expect, test } from "vitest";
import {
  aggregateSkeletonMetrics,
  assignOutwardRoiPixels,
  countSkeletonTopology,
  polygonSelfIntersects,
  validateRoiBands,
} from "./analysisGeometry.js";

const defaultBands = [
  { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
  { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
  { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
];

describe("validateRoiBands", () => {
  test("accepts the default contiguous near mid far bands", () => {
    expect(validateRoiBands(defaultBands)).toEqual(defaultBands);
  });

  test("rejects negative, missing, non-contiguous, and non-finite bands", () => {
    expect(() => validateRoiBands([{ id: "near", fromPx: -1, toPx: 20 }])).toThrow(/near, mid, and far/i);
    expect(() => validateRoiBands([{ id: "near", fromPx: 0, toPx: Number.NaN }, defaultBands[1], defaultBands[2]])).toThrow(/finite/i);
    expect(() => validateRoiBands([defaultBands[0], { ...defaultBands[1], fromPx: 21 }, defaultBands[2]])).toThrow(/contiguous/i);
    expect(() => validateRoiBands([defaultBands[0], defaultBands[2], defaultBands[1]])).toThrow(/near, mid, and far/i);
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- server/analysisGeometry.test.js
```

Expected: FAIL because `server/analysisGeometry.js` does not exist.

- [ ] **Step 3: Implement ROI band validation and polygon helpers**

Create `server/analysisGeometry.js` with exports:

```js
const REQUIRED_BANDS = ["near", "mid", "far"];

export function validateRoiBands(roiBands) {
  if (!Array.isArray(roiBands) || roiBands.length !== 3) {
    throw new Error("ROI bands must contain near, mid, and far.");
  }

  const normalized = roiBands.map((band) => ({
    id: band?.id,
    label: typeof band?.label === "string" && band.label.trim() ? band.label : band?.id,
    fromPx: Number(band?.fromPx),
    toPx: Number(band?.toPx),
  }));

  if (!normalized.every((band, index) => band.id === REQUIRED_BANDS[index])) {
    throw new Error("ROI bands must be ordered near, mid, and far.");
  }

  for (const band of normalized) {
    if (!Number.isFinite(band.fromPx) || !Number.isFinite(band.toPx)) {
      throw new Error("ROI band distances must be finite.");
    }
    if (band.fromPx < 0 || band.toPx < 0) {
      throw new Error("ROI band distances cannot be negative.");
    }
    if (band.toPx <= band.fromPx) {
      throw new Error("ROI band toPx must be greater than fromPx.");
    }
  }

  if (normalized[0].fromPx !== 0 || normalized[1].fromPx !== normalized[0].toPx || normalized[2].fromPx !== normalized[1].toPx) {
    throw new Error("ROI bands must be contiguous from zero.");
  }

  return normalized;
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function polygonSelfIntersects(points) {
  if (!Array.isArray(points) || points.length < 4) return false;
  for (let i = 0; i < points.length; i += 1) {
    const a1 = points[i];
    const a2 = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j += 1) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === points.length - 1)) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % points.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}
```

Then add the remaining functions in later steps.

- [ ] **Step 4: Run tests to verify GREEN for validation**

Run:

```bash
npm test -- server/analysisGeometry.test.js
```

Expected: PASS for validation tests once local helpers such as `segmentsIntersect` are included.

- [ ] **Step 5: Add failing tests for outward assignment and metric aggregation**

Extend `server/analysisGeometry.test.js` with:

```js
describe("assignOutwardRoiPixels", () => {
  test("assigns only pixels outside all polygons to nearest boundary group and band", () => {
    const groups = [
      { id: "cell-a", name: "Cell A", color: "#f00", points: [{ x: 2, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 5 }, { x: 2, y: 5 }] },
      { id: "cell-b", name: "Cell B", color: "#0f0", points: [{ x: 8, y: 2 }, { x: 10, y: 2 }, { x: 10, y: 4 }, { x: 8, y: 4 }] },
    ];

    const assignments = assignOutwardRoiPixels({ width: 14, height: 8, groups, roiBands: [
      { id: "near", label: "가까움", fromPx: 0, toPx: 2 },
      { id: "mid", label: "중간", fromPx: 2, toPx: 4 },
      { id: "far", label: "멀리", fromPx: 4, toPx: 6 },
    ] });

    expect(assignments.get("3,3")).toBeUndefined();
    expect(assignments.get("1,3")).toMatchObject({ groupId: "cell-a", bandId: "near" });
    expect(assignments.get("7,3")).toMatchObject({ groupId: "cell-b", bandId: "near" });
  });

  test("rejects self-intersecting polygons", () => {
    expect(polygonSelfIntersects([{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 1, y: 5 }, { x: 5, y: 1 }])).toBe(true);
  });
});

describe("skeleton metrics", () => {
  test("counts endpoints and branchpoints from 8-neighborhood skeleton pixels", () => {
    const skeleton = new Uint8Array([
      0, 1, 0,
      1, 1, 1,
      0, 1, 0,
    ]);

    expect(countSkeletonTopology({ skeleton, width: 3, height: 3, pixels: [{ x: 1, y: 1 }, { x: 0, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 2 }] })).toEqual({
      endpointCount: 4,
      branchpointCount: 1,
    });
  });

  test("distinguishes radial rays from tangential boundary-following lines", () => {
    const radial = aggregateSkeletonMetrics({
      samples: [{ x: 4, y: 1, theta: -Math.PI / 2, boundaryNormal: { x: 0, y: -1 }, boundaryTangent: { x: 1, y: 0 } }],
      roiAreaPx: 10,
      skeletonLengthPx: 3,
      skeletonPixelCount: 3,
      endpointCount: 2,
      branchpointCount: 0,
    });

    expect(radial.radialNormalAlignment).toBeCloseTo(1);
    expect(radial.tangentialAlignment).toBeCloseTo(0);
    expect(radial.globalAlignment).toBeCloseTo(1);
  });
});
```

- [ ] **Step 6: Implement outward assignment and metric functions**

Add functions to `server/analysisGeometry.js`:

```js
export function assignOutwardRoiPixels({ width, height, groups, roiBands }) {
  const bands = validateRoiBands(roiBands);
  const validGroups = groups.filter((group) => group.points.length >= 3);
  const assignments = new Map();
  const maxDistance = bands[bands.length - 1].toPx;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const point = { x, y };
      if (validGroups.some((group) => pointInPolygon(point, group.points))) continue;

      let nearest = null;
      for (const group of validGroups) {
        const boundary = nearestBoundary(point, group.points);
        if (boundary.distancePx < maxDistance && (!nearest || boundary.distancePx < nearest.distancePx)) {
          nearest = { ...boundary, groupId: group.id };
        }
      }

      if (!nearest) continue;
      const band = bands.find((candidate) => nearest.distancePx >= candidate.fromPx && nearest.distancePx < candidate.toPx);
      if (band) assignments.set(`${x},${y}`, { ...nearest, bandId: band.id });
    }
  }

  return assignments;
}
```

Also implement `nearestBoundary`, winding-independent outward normal selection, `countSkeletonTopology`, `estimateSkeletonLength`, local orientation from neighbor covariance, and `aggregateSkeletonMetrics`.

- [ ] **Step 7: Run tests**

Run:

```bash
npm test -- server/analysisGeometry.test.js
```

Expected: PASS.

### Task 2: Mask Reading, Foreground Conversion, And Skeletonization

**Files:**
- Create: `server/maskSkeleton.js`
- Create: `server/maskSkeleton.test.js`

- [ ] **Step 1: Write failing mask/skeleton tests**

Create `server/maskSkeleton.test.js`:

```js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import { readBinaryMask, thinBinaryMask, writeSkeletonPng } from "./maskSkeleton.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "polygon-mask-skeleton-"));
  tempRoots.push(rootDir);
  return rootDir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe("readBinaryMask", () => {
  test("treats any non-alpha RGB channel as foreground", async () => {
    const rootDir = await createTempRoot();
    const maskPath = path.join(rootDir, "mask.png");
    await sharp(Buffer.from([
      0, 0, 0, 255,
      0, 12, 0, 255,
      0, 0, 9, 255,
      0, 0, 0, 0,
    ]), { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(maskPath);

    const mask = await readBinaryMask(maskPath);

    expect(mask.width).toBe(2);
    expect(mask.height).toBe(2);
    expect([...mask.data]).toEqual([0, 1, 1, 0]);
  });
});

describe("thinBinaryMask", () => {
  test("thins a thick vertical line while preserving connectivity", () => {
    const input = new Uint8Array([
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
    ]);

    const skeleton = thinBinaryMask({ data: input, width: 5, height: 5 });

    const foregroundCount = skeleton.reduce((sum, value) => sum + value, 0);
    expect(foregroundCount).toBeLessThan(15);
    expect(foregroundCount).toBeGreaterThanOrEqual(3);
  });

  test("writes an 8-bit skeleton PNG", async () => {
    const rootDir = await createTempRoot();
    const outputPath = path.join(rootDir, "skeleton.png");
    await writeSkeletonPng(outputPath, { data: new Uint8Array([0, 1, 0, 1]), width: 2, height: 2 });

    const raw = await sharp(outputPath).raw().toBuffer();
    expect([...raw]).toEqual([0, 255, 0, 255]);
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- server/maskSkeleton.test.js
```

Expected: FAIL because `server/maskSkeleton.js` does not exist.

- [ ] **Step 3: Implement mask skeleton module**

Create `server/maskSkeleton.js` with:

```js
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export async function readBinaryMask(maskPath, { maxImagePixels } = {}) {
  const image = sharp(maskPath, { limitInputPixels: maxImagePixels });
  const metadata = await image.metadata();
  const { data, info } = await sharp(maskPath, { limitInputPixels: maxImagePixels })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const binary = new Uint8Array(info.width * info.height);
  for (let i = 0, pixel = 0; i < data.length; i += info.channels, pixel += 1) {
    binary[pixel] = data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0 ? 1 : 0;
  }

  return { data: binary, width: metadata.width ?? info.width, height: metadata.height ?? info.height, format: metadata.format };
}

export function thinBinaryMask(mask) {
  // Implement Zhang-Suen thinning over a copy of mask.data.
}

export async function writeSkeletonPng(outputPath, skeleton) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const bytes = Buffer.from(skeleton.data.map((value) => (value ? 255 : 0)));
  await sharp(bytes, { raw: { width: skeleton.width, height: skeleton.height, channels: 1 } }).png().toFile(outputPath);
}
```

Finish `thinBinaryMask` with the two-subiteration Zhang-Suen rules.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- server/maskSkeleton.test.js
```

Expected: PASS.

### Task 3: Analysis Service, Storage Paths, And API

**Files:**
- Create: `server/analysisService.js`
- Create: `server/analysisService.test.js`
- Modify: `server/storage.js`
- Modify: `server/storage.test.js`
- Modify: `server/app.js`
- Modify: `server/app.test.js`

- [ ] **Step 1: Write failing storage tests**

Add to `server/storage.test.js`:

```js
test("exposes mask, Skeletonize, and analysis paths for each image", async () => {
  const rootDir = await createTempRoot();
  await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
  const storage = createStorage({ initialRoot: rootDir });

  expect(storage.imagePaths("selected-stack-sequence_T01")).toMatchObject({
    maskDir: path.join(rootDir, "selected-stack-sequence_T01", "mask"),
    skeletonDir: path.join(rootDir, "selected-stack-sequence_T01", "Skeletonize"),
    analysisDir: path.join(rootDir, "selected-stack-sequence_T01", "analysis"),
    skeletonPath: path.join(rootDir, "selected-stack-sequence_T01", "Skeletonize", "selected-stack-sequence_T01.skeleton.png"),
    analysisPath: path.join(rootDir, "selected-stack-sequence_T01", "analysis", "selected-stack-sequence_T01.analysis.json"),
  });
});

test("loads missing analysis as null and saves analysis atomically", async () => {
  const rootDir = await createTempRoot();
  await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
  const storage = createStorage({ initialRoot: rootDir });
  await expect(storage.loadAnalysis("selected-stack-sequence_T01")).resolves.toBeNull();

  const analysis = { schemaVersion: 1, imageFolder: "selected-stack-sequence_T01", groups: [] };
  await expect(storage.saveAnalysis("selected-stack-sequence_T01", analysis)).resolves.toEqual(analysis);
  await expect(storage.loadAnalysis("selected-stack-sequence_T01")).resolves.toEqual(analysis);
});
```

- [ ] **Step 2: Run storage tests to verify RED**

Run:

```bash
npm test -- server/storage.test.js
```

Expected: FAIL because new paths and methods do not exist.

- [ ] **Step 3: Implement storage paths and analysis I/O**

Update `server/storage.js`:

```js
function imagePaths(imageOrId) {
  const image = resolveImage(imageOrId);
  const boundDir = path.join(image.folderPath, "bound");
  const maskDir = path.join(image.folderPath, "mask");
  const skeletonDir = path.join(image.folderPath, "Skeletonize");
  const analysisDir = path.join(image.folderPath, "analysis");

  return {
    folderPath: image.folderPath,
    imageDir: image.imageDir,
    imagePath: image.imagePath,
    maskDir,
    boundDir,
    skeletonDir,
    analysisDir,
    boundsPath: path.join(boundDir, `${image.imageFolder}.bounds.json`),
    skeletonPath: path.join(skeletonDir, `${image.imageFolder}.skeleton.png`),
    analysisPath: path.join(analysisDir, `${image.imageFolder}.analysis.json`),
  };
}
```

Add `loadAnalysis(id)` and `saveAnalysis(id, analysis)` mirroring `loadBounds`/`saveBounds`, and return them from `createStorage`.

- [ ] **Step 4: Write failing service/API tests**

Create `server/analysisService.test.js` for `selectMaskSource`, saved analysis loading, and `recalculateAnalysis`.
Add `server/app.test.js` coverage:

```js
test("GET analysis returns null when no saved analysis exists", async () => {
  const appRoot = await createTempRoot();
  const imageRoot = await createTempRoot();
  await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");

  const response = await request(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/images/selected-stack-sequence_T01/analysis");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ analysis: null, hasAnalysis: false });
});

test("POST analysis recalculate rejects invalid ROI bands safely", async () => {
  const appRoot = await createTempRoot();
  const imageRoot = await createTempRoot();
  await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");

  const response = await jsonRequest(
    createApp({ rootDir: appRoot, initialRoot: imageRoot }),
    "/api/images/selected-stack-sequence_T01/analysis/recalculate",
    { method: "POST", body: { roiBands: [{ id: "near", fromPx: 0, toPx: 10 }] } },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Invalid ROI band payload." });
});
```

- [ ] **Step 5: Run service/API tests to verify RED**

Run:

```bash
npm test -- server/analysisService.test.js server/app.test.js
```

Expected: FAIL because service/API do not exist yet.

- [ ] **Step 6: Implement analysis service and API routes**

Create `server/analysisService.js` with exports:

```js
export const DEFAULT_ROI_BANDS = [
  { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
  { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
  { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
];

export async function loadSavedAnalysis(storage, id) {
  const analysis = await storage.loadAnalysis(id);
  return { analysis, hasAnalysis: Boolean(analysis) };
}

export async function recalculateAnalysis(storage, id, { roiBands = DEFAULT_ROI_BANDS, maxImagePixels } = {}) {
  // Validate ROI bands, saved bounds, mask source, dimensions, and polygons.
  // Read mask, skeletonize, write skeleton PNG.
  // Assign outward ROI pixels and aggregate per group/band/allBands/imageSummary.
  // Save analysis JSON through storage.saveAnalysis.
}
```

Implement mask selection priority in `selectMaskSource(paths, imageFile)`: matching basename PNG, first sorted PNG, matching TIFF, first sorted TIFF.

Update `server/app.js`:

```js
app.get("/api/images/:id/analysis", asyncRoute(async (request, response) => {
  response.json(await loadSavedAnalysis(imageStorage, request.params.id));
}));

app.post("/api/images/:id/analysis/recalculate", asyncRoute(async (request, response) => {
  try {
    response.json({ analysis: await recalculateAnalysis(imageStorage, request.params.id, { roiBands: request.body?.roiBands, maxImagePixels }), hasAnalysis: true });
  } catch (error) {
    const safeError = safeAnalysisErrorResponse(error);
    response.status(safeError.status).json(safeError.body);
  }
}));
```

Add safe error mapping for invalid ROI (`400`), missing bounds/mask (`409`), corrupt user data/dimension mismatch (`422`), unknown image (`404`).

- [ ] **Step 7: Run server tests**

Run:

```bash
npm test -- server/analysisGeometry.test.js server/maskSkeleton.test.js server/storage.test.js server/analysisService.test.js server/app.test.js
```

Expected: PASS.

### Task 4: Frontend Analysis Panel And Recalculate Flow

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/App.test.jsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Write failing App tests**

Add tests to `src/App.test.jsx`:

```js
const savedAnalysis = {
  schemaVersion: 1,
  imageFolder: "plate-a",
  imageFile: "a.tif",
  maskSource: { file: "plate-a.png", width: 100, height: 80, mtimeMs: 1000 },
  skeletonFile: "plate-a.skeleton.png",
  roiBands: [
    { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
    { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
    { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
  ],
  groups: [{
    groupId: "group-saved",
    groupName: "Saved Tissue",
    bands: {
      near: { roiAreaPx: 25, skeletonPixelCount: 5, skeletonLengthPx: 6, density: 0.24, coverage: 0.2, globalAlignment: 0.8, radialNormalAlignment: 0.7, tangentialAlignment: 0.3, empty: false },
    },
  }],
  imageSummary: { density: 0.24, globalAlignment: 0.8, radialNormalAlignment: 0.7, tangentialAlignment: 0.3 },
  warnings: [],
  updatedAt: "2026-07-05T00:00:00.000Z",
};

test("loads saved analysis after opening an image", async () => {
  mockApi({ analysisResponse: { analysis: savedAnalysis, hasAnalysis: true } });

  render(<App />);

  expect(await screen.findByText(/analysis loaded/i)).toBeInTheDocument();
  expect(screen.getByText("plate-a.png")).toBeInTheDocument();
  expect(screen.getByText("0.2400")).toBeInTheDocument();
});

test("recalculates analysis with edited contiguous ROI bands", async () => {
  const { fetchMock } = mockApi({ analysisResponse: { analysis: null, hasAnalysis: false }, recalculateAnalysis: savedAnalysis });

  render(<App />);
  await screen.findByRole("button", { name: "Saved Tissue" });
  fireEvent.change(screen.getByLabelText(/가까움 upper/i), { target: { value: "18" } });
  fireEvent.click(screen.getByRole("button", { name: /recalculate/i }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/images/scan-a/analysis/recalculate",
    expect.objectContaining({ method: "POST" }),
  ));
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/images/scan-a/analysis/recalculate");
  expect(JSON.parse(call[1].body).roiBands[0]).toMatchObject({ id: "near", fromPx: 0, toPx: 18 });
});
```

Update `mockApi` to support `/api/images/:id/analysis` and `/api/images/:id/analysis/recalculate`.

- [ ] **Step 2: Run App tests to verify RED**

Run:

```bash
npm test -- src/App.test.jsx
```

Expected: FAIL because analysis UI and fetches do not exist.

- [ ] **Step 3: Implement frontend state and API calls**

In `src/App.jsx`:

- Add `DEFAULT_ROI_LIMITS = { near: 20, mid: 50, far: 100 }`.
- Add state: `analysis`, `hasAnalysis`, `analysisStatus`, `analysisError`, `roiLimits`, `analysisLoading`.
- Add helpers `deriveRoiBands(roiLimits)`, `applyAnalysisRoiBands(analysis)`, `formatMetric(value)`.
- In `loadImage`, after bounds load and before/alongside raw image load, fetch `/api/images/${image.id}/analysis`; when saved analysis exists, set analysis and ROI limits from saved `roiBands`; otherwise keep defaults.
- Add `handleLoadAnalysis()` to reload saved analysis for the active image.
- Add `handleRecalculateAnalysis()` to POST derived bands to `/analysis/recalculate`, set loading state, update returned analysis, and leave boundary JSON untouched.
- Render an analysis panel below point-order controls with ROI upper-limit number inputs, `Load analysis`, `Recalculate`, mask/skeleton metadata, warnings, and metric table.

- [ ] **Step 4: Implement frontend styles**

In `src/styles.css`, add compact styles:

```css
.analysis-panel {
  display: grid;
  gap: 10px;
  padding: 10px 12px;
  border-top: 1px solid #232c36;
  background: #101720;
}

.analysis-toolbar,
.roi-limit-grid,
.analysis-meta,
.analysis-warning-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.analysis-table-wrap {
  overflow: auto;
}

.analysis-table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
}
```

Keep font sizes compact and match existing button/input/chip styling.

- [ ] **Step 5: Run App tests**

Run:

```bash
npm test -- src/App.test.jsx
```

Expected: PASS.

### Task 5: End-To-End Verification, Visual Check, And Commit

**Files:**
- Modify: any files needed to fix integration issues found by tests or visual verification.

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
```

Expected: PASS for all tests in the worktree.

- [ ] **Step 2: Run production build**

Run:

```bash
npm run build
```

Expected: Vite build exits 0.

- [ ] **Step 3: Start server for visual verification**

Run:

```bash
PORT=52897 npm run server
```

Expected: server listens on `http://localhost:52897/`. If the port is busy, use another open port and report it.

- [ ] **Step 4: Verify visually in browser**

Open the app and inspect:

- the analysis panel appears below point order,
- ROI inputs do not overflow on desktop or mobile width,
- `Recalculate` has clear loading/disabled state,
- metric table is scrollable and does not overlap the image,
- existing point editing remains usable.

- [ ] **Step 5: Commit and push**

Run:

```bash
git status -sb
git add server/analysisGeometry.js server/analysisGeometry.test.js server/maskSkeleton.js server/maskSkeleton.test.js server/analysisService.js server/analysisService.test.js server/storage.js server/storage.test.js server/app.js server/app.test.js src/App.jsx src/App.test.jsx src/styles.css docs/superpowers/plans/2026-07-05-outward-roi-analysis-implementation.md
git commit -m "feat: add outward boundary ROI analysis"
git push -u origin feature/outward-roi-analysis
```

Expected: branch push succeeds.

## Self-Review

- Spec coverage: The tasks cover outward-only ROI bands, editable near/mid/far distances, PNG-first mask loading with TIFF fallback, `Skeletonize/` output, `analysis/` JSON output, saved analysis load, manual recalculation, radial/tangential/global/density/coverage/topology metrics, stale warnings, and frontend controls.
- Placeholder scan: No `TBD`, `TODO`, `implement later`, or unbounded “add appropriate” steps remain.
- Type consistency: `roiBands`, `analysis`, `hasAnalysis`, `groups[].bands`, `imageSummary`, `maskSource`, `skeletonFile`, and the near/mid/far ids match the approved spec.
