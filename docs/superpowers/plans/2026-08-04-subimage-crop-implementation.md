# Fixed-Aspect Subimage Crop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Subimage mode that creates one same-size, source-aspect TIFF crop for every image, then lets the user drag and explicitly save a distinct crop position per image.

**Architecture:** Extend storage with subimage paths and atomic crop-JSON persistence, and add a focused server service for TIFF validation, lossless 16-bit extraction, and batch preflight/orchestration. Keep crop geometry in a pure client module, render the crop with small presentational components, and integrate request/state/pointer coordination into the existing `App` without coupling it to polygon bounds or analysis state.

**Tech Stack:** Node.js ESM, Express 4, Sharp 0.35, React 18, SVG/CSS, Vitest 2, Testing Library.

## Global Constraints

- The source contract is single-channel 16-bit grayscale TIFF: `depth: ushort`, `space: grey16`, `channels: 1`.
- Every source image in one batch must have identical pixel dimensions; a mismatch stops preflight before any write.
- Crops use integer source-image pixels, remain fully in bounds, and match `sourceWidth / sourceHeight` within one pixel of integer rounding.
- Initial batch creation uses the same `x`, `y`, `width`, and `height` for every image.
- After batch creation, crop `width` and `height` are locked; each image may change only `x` and `y` by mouse drag.
- Pointer movement changes client preview only; only explicit `Save subimage` writes the active image.
- `Create all subimages` preserves every valid existing crop and creates missing crops only.
- `Replace all subimages` requires a newly drawn crop and explicit destructive confirmation before rewriting every image.
- Store output as `image-folder/subimage/<source filename>` plus `image-folder/subimage/crop.json`; JSON is the saved-crop commit marker.
- Preserve exact grayscale 16-bit pixel values; do not resize, normalize, or crop masks and skeleton images.
- Add `Subimage` beside `Original`, `Mask`, `Fiber QC`, and `Heat Map`; hide bounds, ROI, migration, and Heat Map presentation layers in Subimage mode.
- Use mouse drag only for crop selection and position changes; add no keyboard or on-screen nudge controls.
- Warn before discarding a dirty Subimage draft during image navigation, root replacement, Find root, layer exit, browser reload, or browser close.
- The first image in filename order owns the batch template; do not create a root-level template file.
- Do not include subimages in the existing Download as ZIP output.
- Add no runtime dependency.

---

## File Map

**Create**

- `server/subimageService.js`: crop/source validation, TIFF extraction, saved-pair inspection, single-image save, and batch orchestration.
- `server/subimageService.test.js`: real 16-bit TIFF service tests, exact raw-pixel assertions, batch preflight, preservation, replacement, and partial failures.
- `src/lib/subimageCrop.js`: pure crop selection, movement, bounds, aspect, and equality functions.
- `src/lib/subimageCrop.test.js`: all drag quadrants, integer rounding, clamping, locked-size movement, and dirty comparisons.
- `src/components/SubimageOverlay.jsx`: darkened outside area and crop outline rendered in source-image coordinates.
- `src/components/SubimageOverlay.test.jsx`: accessible overlay geometry and empty-state rendering.
- `src/components/SubimagePanel.jsx`: contextual controls, read-only coordinates, busy/disabled states, and batch summaries.
- `src/components/SubimagePanel.test.jsx`: first-image ownership, action states, replacement flow, and result rendering.

**Modify**

- `server/storage.js:147-286`: add `subimageDir`, output TIFF path, crop JSON path, and atomic JSON load/save methods.
- `server/storage.test.js:52-76,194-240,272-277`: verify paths, missing/invalid JSON, atomic writes, identity fields, and path traversal rejection.
- `server/app.js:1-113,318-460`: map safe Subimage errors and expose four Subimage endpoints.
- `server/app.test.js:1-100,760-940`: exercise route payloads, safe errors, current-image writes, and batch results.
- `src/App.jsx:111-190,256-616,703-721,923-952,1182-1365,1530-2010`: add Subimage state/loading/actions, unified discard guards, pointer routing, contextual controls, and overlay visibility rules.
- `src/App.test.jsx:1-520,1320-1420,2460-end`: extend the fetch fixture and verify Subimage workflows, stale responses, no-write dragging, and navigation guards.
- `src/styles.css:133-260,560-635,864-900`: style the contextual panel and darkened crop overlay without changing the existing editor palette.
- `src/styles.test.js:1-136`: lock overlay stacking, pointer behavior, and compact panel layout.
- `README.md`: document the Subimage output contract and explicit-save workflow.

---

### Task 1: Subimage Storage Contract

**Files:**
- Modify: `server/storage.js:147-286`
- Test: `server/storage.test.js:52-76,194-240,272-277`

**Interfaces:**
- Produces: `storage.imagePaths(id).subimageDir: string`.
- Produces: `storage.imagePaths(id).subimagePath: string`, always ending in the source TIFF filename.
- Produces: `storage.imagePaths(id).subimageCropPath: string`, always ending in `subimage/crop.json`.
- Produces: `storage.loadSubimageCrop(id): Promise<object | null>`; missing JSON returns `null`, malformed JSON throws an image-contextual error.
- Produces: `storage.saveSubimageCrop(id, crop): Promise<object>`; writes identity fields and `updatedAt` by unique temporary file plus rename.
- Preserves: public image DTOs contain no absolute filesystem paths.

- [ ] **Step 1: Write failing storage tests**

Add these cases to `server/storage.test.js`:

```js
test("resolves private subimage paths without exposing them in image DTOs", async () => {
  const rootDir = await createTempRoot();
  await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
  const storage = createStorage({ initialRoot: rootDir });

  expect(storage.getImage("selected-stack-sequence_T01")).toEqual({
    id: "selected-stack-sequence_T01",
    imageFolder: "selected-stack-sequence_T01",
    imageFile: "frame001.tif",
  });
  expect(storage.imagePaths("selected-stack-sequence_T01")).toMatchObject({
    subimageDir: path.join(rootDir, "selected-stack-sequence_T01", "subimage"),
    subimagePath: path.join(rootDir, "selected-stack-sequence_T01", "subimage", "frame001.tif"),
    subimageCropPath: path.join(rootDir, "selected-stack-sequence_T01", "subimage", "crop.json"),
  });
});

test("loads a missing subimage crop as null and saves crop JSON atomically", async () => {
  const rootDir = await createTempRoot();
  await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
  const storage = createStorage({ initialRoot: rootDir });

  await expect(storage.loadSubimageCrop("selected-stack-sequence_T01")).resolves.toBeNull();
  const saved = await storage.saveSubimageCrop("selected-stack-sequence_T01", {
    sourceWidth: 1008,
    sourceHeight: 1008,
    x: 120,
    y: 80,
    width: 400,
    height: 400,
    aspectRatio: 1,
  });

  await expect(readJson(storage.imagePaths("selected-stack-sequence_T01").subimageCropPath)).resolves.toEqual(saved);
  expect(saved).toMatchObject({
    schemaVersion: 1,
    imageFolder: "selected-stack-sequence_T01",
    imageFile: "frame001.tif",
    x: 120,
    y: 80,
    width: 400,
    height: 400,
  });
  expect(Date.parse(saved.updatedAt)).not.toBeNaN();
  await expect(readdir(storage.imagePaths("selected-stack-sequence_T01").subimageDir)).resolves.toEqual(["crop.json"]);
});

test("wraps malformed subimage crop JSON with image context", async () => {
  const rootDir = await createTempRoot();
  await writeImage(rootDir, "selected-stack-sequence_T01", "frame001.tif");
  const storage = createStorage({ initialRoot: rootDir });
  const { subimageDir, subimageCropPath } = storage.imagePaths("selected-stack-sequence_T01");
  await mkdir(subimageDir, { recursive: true });
  await writeFile(subimageCropPath, "{broken json");

  await expect(storage.loadSubimageCrop("selected-stack-sequence_T01")).rejects.toThrow(
    /Invalid subimage crop JSON for selected-stack-sequence_T01/i,
  );
});
```

Extend the existing traversal test with calls to `loadSubimageCrop` and `saveSubimageCrop` using `../selected-stack-sequence_T01`.

- [ ] **Step 2: Run the storage tests and verify RED**

Run:

```bash
npm test -- server/storage.test.js
```

Expected: FAIL because the three paths and two storage methods do not exist.

- [ ] **Step 3: Implement paths and atomic crop JSON persistence**

In `imagePaths`, add:

```js
const subimageDir = path.join(image.folderPath, "subimage");

return {
  folderPath: image.folderPath,
  imageDir: image.imageDir,
  imagePath: image.imagePath,
  boundDir,
  boundsPath: path.join(boundDir, `${image.imageFolder}.bounds.json`),
  maskDir,
  skeletonDir,
  analysisDir,
  heatmapDir,
  subimageDir,
  subimagePath: path.join(subimageDir, image.imageFile),
  subimageCropPath: path.join(subimageDir, "crop.json"),
  skeletonPath: path.join(skeletonDir, `${image.imageFolder}.skeleton.png`),
  analysisPath: path.join(analysisDir, `${image.imageFolder}.analysis.json`),
};
```

Add storage methods with the same temporary-file discipline as bounds and analysis:

```js
async function loadSubimageCrop(id) {
  const image = resolveImage(id);
  const { subimageCropPath } = imagePaths(image);

  try {
    return JSON.parse(await readFile(subimageCropPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid subimage crop JSON for ${image.imageFolder}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

async function saveSubimageCrop(id, crop) {
  const image = resolveImage(id);
  const { subimageDir, subimageCropPath } = imagePaths(image);
  const payload = {
    ...crop,
    schemaVersion: 1,
    imageFolder: image.imageFolder,
    imageFile: image.imageFile,
    updatedAt: new Date().toISOString(),
  };
  const tempPath = path.join(subimageDir, `.crop-${randomUUID()}.json.tmp`);

  await mkdir(subimageDir, { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(tempPath, subimageCropPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return payload;
}
```

Import `rm`, expose both methods from `createStorage`, and include read-only `loadSubimageCrop` in `createSnapshot`; do not expose `saveSubimageCrop` through snapshots.

- [ ] **Step 4: Run the storage tests and verify GREEN**

Run:

```bash
npm test -- server/storage.test.js
```

Expected: all storage tests pass and temporary files are absent after success.

- [ ] **Step 5: Commit Task 1**

```bash
git add server/storage.js server/storage.test.js
git commit -m "feat: add subimage storage contract"
```

---

### Task 2: Validated 16-bit TIFF Crop Service

**Files:**
- Create: `server/subimageService.js`
- Create: `server/subimageService.test.js`

**Interfaces:**
- Produces: `SubimageError extends Error` with `code`, `status`, and optional `details`.
- Produces: `validateCrop(crop, source): CropGeometry`.
- Produces: `loadSubimage(storage, id, options?): Promise<{ hasSubimage, crop }>`.
- Produces: `saveSubimage(storage, id, crop, options?): Promise<{ crop }>`.
- `options` accepts `{ maxImagePixels, __testDependencies }`; injection keys are `access`, `copyFile`, `mkdir`, `rename`, `rm`, and `renderCropTiff({ sourcePath, tempPath, crop, maxImagePixels }): Promise<void>`.
- Consumes: Task 1 `imagePaths`, `loadSubimageCrop`, and `saveSubimageCrop`.

The geometry and saved payload shapes are fixed for all later tasks:

```ts
type CropGeometry = {
  sourceWidth: number;
  sourceHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio: number;
};

type SavedCrop = CropGeometry & {
  schemaVersion: 1;
  imageFolder: string;
  imageFile: string;
  updatedAt: string;
};
```

- [ ] **Step 1: Write failing validation and TIFF-preservation tests**

Create `server/subimageService.test.js` with a real TIFF helper:

```js
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import { createStorage } from "./storage.js";
import {
  SubimageError,
  loadSubimage,
  saveSubimage,
  validateCrop,
} from "./subimageService.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "subimage-service-"));
  tempRoots.push(rootDir);
  return rootDir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

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

async function writeGrey16Tiff(rootDir, folderName, width, height, pixels) {
  const imageDir = path.join(rootDir, folderName, "image");
  const maskDir = path.join(rootDir, folderName, "mask");
  await mkdir(imageDir, { recursive: true });
  await mkdir(maskDir, { recursive: true });
  await writeFile(path.join(imageDir, `${folderName}.tif`), uint16Tiff({ width, height, pixels }));
}
```

Add exact validation assertions:

```js
test.each([
  [{ x: 0.5, y: 0, width: 4, height: 4 }, "INVALID_CROP"],
  [{ x: 0, y: 0, width: 0, height: 4 }, "INVALID_CROP"],
  [{ x: 7, y: 0, width: 4, height: 4 }, "INVALID_CROP"],
  [{ x: 0, y: 0, width: 4, height: 2 }, "ASPECT_RATIO_MISMATCH"],
])("rejects invalid crop %#", (crop, code) => {
  expect(() => validateCrop(crop, { width: 8, height: 8 })).toThrowError(
    expect.objectContaining({ code }),
  );
});

test("writes an exact ushort grey16 crop and commits JSON last", async () => {
  const rootDir = await createTempRoot();
  const pixels = Array.from({ length: 64 }, (_, index) => index * 997);
  await writeGrey16Tiff(rootDir, "T01", 8, 8, pixels);
  const storage = createStorage({ initialRoot: rootDir });

  const result = await saveSubimage(storage, "T01", {
    sourceWidth: 8,
    sourceHeight: 8,
    x: 2,
    y: 1,
    width: 4,
    height: 4,
  });

  const { data, info } = await sharp(storage.imagePaths("T01").subimagePath)
    .toColourspace("grey16")
    .raw({ depth: "ushort" })
    .toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 4, height: 4, channels: 1, depth: "ushort" });
  expect([...new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)]).toEqual([
    10 * 997, 11 * 997, 12 * 997, 13 * 997,
    18 * 997, 19 * 997, 20 * 997, 21 * 997,
    26 * 997, 27 * 997, 28 * 997, 29 * 997,
    34 * 997, 35 * 997, 36 * 997, 37 * 997,
  ]);
  await expect(storage.loadSubimageCrop("T01")).resolves.toEqual(result.crop);
});
```

Add cases that reject an 8-bit TIFF and an RGB TIFF with `UNSUPPORTED_SOURCE`. Add this no-prior-output render failure assertion:

```js
test("does not commit TIFF or JSON when crop rendering fails", async () => {
  const rootDir = await createTempRoot();
  await writeGrey16Tiff(rootDir, "T01", 8, 8, Array.from({ length: 64 }, (_, index) => index));
  const storage = createStorage({ initialRoot: rootDir });
  const paths = storage.imagePaths("T01");

  await expect(saveSubimage(storage, "T01", {
    sourceWidth: 8, sourceHeight: 8, x: 2, y: 2, width: 4, height: 4,
  }, {
    __testDependencies: {
      async renderCropTiff() {
        throw new Error("simulated render failure");
      },
    },
  })).rejects.toMatchObject({ code: "CROP_RENDER_FAILED" });

  await expect(access(paths.subimagePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(paths.subimageCropPath)).rejects.toMatchObject({ code: "ENOENT" });
});
```

Also save one valid prior pair, wrap `storage.saveSubimageCrop` so it throws, and assert a second save leaves the prior TIFF and JSON byte-for-byte unchanged.

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
npm test -- server/subimageService.test.js
```

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement error and crop/source validation**

Create `server/subimageService.js` with stable errors and strict cross-multiplied aspect validation:

```js
export class SubimageError extends Error {
  constructor(code, message, { status = 422, details = null, cause } = {}) {
    super(message, { cause });
    this.name = "SubimageError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function validateCrop(crop, source) {
  const fields = ["sourceWidth", "sourceHeight", "x", "y", "width", "height"];
  const candidate = {
    sourceWidth: crop?.sourceWidth ?? source?.width,
    sourceHeight: crop?.sourceHeight ?? source?.height,
    x: crop?.x,
    y: crop?.y,
    width: crop?.width,
    height: crop?.height,
  };
  if (fields.some((field) => !Number.isInteger(candidate[field]))) {
    throw new SubimageError("INVALID_CROP", "Crop fields must be integers.", { status: 400 });
  }
  if (candidate.sourceWidth !== source.width || candidate.sourceHeight !== source.height) {
    throw new SubimageError("DIMENSION_MISMATCH", "Crop source dimensions do not match the image.");
  }
  if (
    candidate.width <= 0 || candidate.height <= 0 || candidate.x < 0 || candidate.y < 0 ||
    candidate.x + candidate.width > source.width || candidate.y + candidate.height > source.height
  ) {
    throw new SubimageError("INVALID_CROP", "Crop is outside the source image.", { status: 400 });
  }
  const ratioErrorPx = Math.abs(candidate.height - (candidate.width * source.height) / source.width);
  if (ratioErrorPx > 1) {
    throw new SubimageError("ASPECT_RATIO_MISMATCH", "Crop aspect ratio does not match the source image.", { status: 400 });
  }
  return { ...candidate, aspectRatio: source.width / source.height };
}
```

Implement `readSupportedSource` using `sharp(imagePath, { limitInputPixels: maxImagePixels }).metadata()`. Require `format === "tiff"`, `depth === "ushort"`, `space === "grey16"`, and `channels === 1`; map missing files to `MISSING_SOURCE` and incompatible metadata to `UNSUPPORTED_SOURCE`.

- [ ] **Step 4: Implement staged TIFF rendering and saved-pair validation**

Implement the default `renderCropTiff` dependency with this exact Sharp chain so the output remains one-channel 16-bit grayscale:

```js
await sharp(paths.imagePath, sharpInputOptions(maxImagePixels))
  .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
  .toColourspace("grey16")
  .tiff({ compression: "lzw" })
  .toFile(tempTiffPath);
```

Then read temporary output metadata and require its width, height, `ushort`, `grey16`, and one channel before replacement. Preserve an existing TIFF via a unique backup; restore that backup, or remove the newly committed TIFF when no previous TIFF existed, if `saveSubimageCrop` fails. Always remove temporary files in `finally`.

Implement saved-pair inspection with these states:

```js
export async function loadSubimage(storage, id, options = {}) {
  const paths = storage.imagePaths(id);
  const crop = await storage.loadSubimageCrop(id);
  const tiffExists = await fileExists(paths.subimagePath);
  if (!crop && !tiffExists) return { hasSubimage: false, crop: null };
  if (!crop || !tiffExists) {
    throw new SubimageError("INVALID_SAVED_CROP", "Saved subimage files are incomplete.");
  }
  const source = await readSupportedSource(paths.imagePath, options);
  const normalized = validateSavedCrop(crop, storage.getImage(id), source);
  await validateOutputMetadata(paths.subimagePath, normalized, options);
  return { hasSubimage: true, crop: normalized };
}
```

`validateSavedCrop` must also match `schemaVersion`, `imageFolder`, and `imageFile`. Malformed JSON from storage is wrapped as `INVALID_SAVED_CROP`; missing/mismatched TIFF uses `MISSING_SAVED_TIFF` or `INVALID_SAVED_CROP` without exposing host paths or Sharp internals.

- [ ] **Step 5: Run service tests and verify GREEN**

Run:

```bash
npm test -- server/subimageService.test.js server/storage.test.js
```

Expected: both files pass; the extracted raw values exactly match the source region and failed saves preserve prior bytes.

- [ ] **Step 6: Commit Task 2**

```bash
git add server/subimageService.js server/subimageService.test.js
git commit -m "feat: preserve grey16 pixels in subimage crops"
```

---

### Task 3: Preflighted Create-Missing and Replace-All Batches

**Files:**
- Modify: `server/subimageService.js`
- Test: `server/subimageService.test.js`

**Interfaces:**
- Produces: `createMissingSubimages(storage, templateCrop, options?): Promise<BatchResult>`.
- Produces: `replaceAllSubimages(storage, templateCrop, options?): Promise<BatchResult>`.
- Produces: preflight errors with code `BATCH_PREFLIGHT_FAILED` and `details.failures`.
- Consumes: Task 2 source validation, crop validation, saved-pair inspection, and single-image save.

```ts
type BatchResult = {
  operation: "create-missing" | "replace-all";
  status: "complete" | "partial";
  code: null | "PARTIAL_BATCH";
  created: string[];
  preserved: string[];
  replaced: string[];
  failed: Array<{ imageFolder: string; code: string; message: string }>;
};
```

- [ ] **Step 1: Write failing create-missing tests**

Replace the existing service import with the full Task 3 export list, then add helpers and tests using three same-size TIFF folders in filename order:

```js
import {
  SubimageError,
  createMissingSubimages,
  loadSubimage,
  replaceAllSubimages,
  saveSubimage,
  validateCrop,
} from "./subimageService.js";

function squareCrop({ x, y }) {
  return { sourceWidth: 8, sourceHeight: 8, x, y, width: 4, height: 4 };
}

async function createThreeImageRoot({ width, height, thirdSize = { width, height } }) {
  const rootDir = await createTempRoot();
  const sizes = [{ width, height }, { width, height }, thirdSize];
  for (const [index, size] of sizes.entries()) {
    const folderName = `T0${index + 1}`;
    const pixels = Array.from({ length: size.width * size.height }, (_, pixelIndex) => pixelIndex + index * 100);
    await writeGrey16Tiff(rootDir, folderName, size.width, size.height, pixels);
  }
  return rootDir;
}

test("create-missing preserves valid crops and creates only absent crops", async () => {
  const rootDir = await createThreeImageRoot({ width: 8, height: 8 });
  const storage = createStorage({ initialRoot: rootDir });
  await saveSubimage(storage, "T02", squareCrop({ x: 1, y: 1 }));
  const preservedTiff = await readFile(storage.imagePaths("T02").subimagePath);
  const preservedJson = await readFile(storage.imagePaths("T02").subimageCropPath);

  const result = await createMissingSubimages(storage, squareCrop({ x: 2, y: 2 }));

  expect(result).toEqual({
    operation: "create-missing",
    status: "complete",
    code: null,
    created: ["T01", "T03"],
    preserved: ["T02"],
    replaced: [],
    failed: [],
  });
  await expect(readFile(storage.imagePaths("T02").subimagePath)).resolves.toEqual(preservedTiff);
  await expect(readFile(storage.imagePaths("T02").subimageCropPath)).resolves.toEqual(preservedJson);
});

test("dimension mismatch fails preflight before any subimage directory is written", async () => {
  const rootDir = await createThreeImageRoot({ width: 8, height: 8, thirdSize: { width: 10, height: 10 } });
  const storage = createStorage({ initialRoot: rootDir });

  await expect(createMissingSubimages(storage, squareCrop({ x: 2, y: 2 }))).rejects.toMatchObject({
    code: "BATCH_PREFLIGHT_FAILED",
    details: { failures: [expect.objectContaining({ imageFolder: "T03", code: "DIMENSION_MISMATCH" })] },
  });
  for (const image of await storage.scanImages()) {
    await expect(access(storage.imagePaths(image.id).subimageDir)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
```

Add a case where a lone TIFF or malformed `crop.json` makes create-missing preflight fail instead of silently overwriting it.

- [ ] **Step 2: Write failing replace-all and partial-failure tests**

Add:

```js
test("replace-all rewrites every valid image with the new template", async () => {
  const rootDir = await createThreeImageRoot({ width: 8, height: 8 });
  const storage = createStorage({ initialRoot: rootDir });
  await createMissingSubimages(storage, squareCrop({ x: 0, y: 0 }));

  const result = await replaceAllSubimages(storage, squareCrop({ x: 3, y: 2 }));

  expect(result).toMatchObject({
    operation: "replace-all",
    status: "complete",
    replaced: ["T01", "T02", "T03"],
    created: [],
    preserved: [],
    failed: [],
  });
  for (const image of await storage.scanImages()) {
    await expect(storage.loadSubimageCrop(image.id)).resolves.toMatchObject({ x: 3, y: 2, width: 4, height: 4 });
  }
});

test("reports a runtime partial batch and preserves the failed image pair", async () => {
  const rootDir = await createThreeImageRoot({ width: 8, height: 8 });
  const storage = createStorage({ initialRoot: rootDir });
  await createMissingSubimages(storage, squareCrop({ x: 0, y: 0 }));
  const oldTiff = await readFile(storage.imagePaths("T02").subimagePath);
  const oldJson = await readFile(storage.imagePaths("T02").subimageCropPath);

  const failingStorage = {
    ...storage,
    async saveSubimageCrop(id, crop) {
      if (id === "T02") throw new Error("simulated crop JSON write failure");
      return storage.saveSubimageCrop(id, crop);
    },
  };
  const result = await replaceAllSubimages(failingStorage, squareCrop({ x: 2, y: 2 }));

  expect(result).toMatchObject({
    status: "partial",
    code: "PARTIAL_BATCH",
    replaced: ["T01", "T03"],
    failed: [{ imageFolder: "T02", code: "WRITE_FAILED", message: "Unable to save subimage." }],
  });
  await expect(readFile(storage.imagePaths("T02").subimagePath)).resolves.toEqual(oldTiff);
  await expect(readFile(storage.imagePaths("T02").subimageCropPath)).resolves.toEqual(oldJson);
});
```

- [ ] **Step 3: Run batch tests and verify RED**

Run:

```bash
npm test -- server/subimageService.test.js
```

Expected: FAIL because the batch exports do not exist.

- [ ] **Step 4: Implement one complete preflight before writes**

Implement a private `preflightBatch` that calls `storage.scanImages()` for filename order, validates every source TIFF, validates the template against every image, and checks existing saved pairs for create-missing. Accumulate all failures and throw once:

```js
if (failures.length > 0) {
  throw new SubimageError("BATCH_PREFLIGHT_FAILED", "Subimage batch preflight failed.", {
    status: 422,
    details: { failures },
  });
}
```

Create-missing classifications are exact:

- neither TIFF nor JSON exists: `missing`;
- both exist and validate: `preserved`;
- only one exists or either is invalid: preflight failure.

Replace-all validates only source TIFFs and the new template because all subimage artifacts are intentionally replaced.

- [ ] **Step 5: Implement sequential batch execution and result accounting**

After successful preflight, process images in scanned order and continue after per-image runtime failures:

```js
function emptyBatchResult(operation) {
  return {
    operation,
    status: "complete",
    code: null,
    created: [],
    preserved: [],
    replaced: [],
    failed: [],
  };
}

function finalizeBatch(result) {
  if (result.failed.length > 0) {
    result.status = "partial";
    result.code = "PARTIAL_BATCH";
  }
  return result;
}
```

Call the Task 2 single-image save for each missing or replace target, and convert errors to `{ imageFolder, code, message }` with the fixed public message `Unable to save subimage.` for unexpected filesystem/Sharp failures.

- [ ] **Step 6: Run service tests and verify GREEN**

Run:

```bash
npm test -- server/subimageService.test.js server/storage.test.js
```

Expected: all tests pass; preflight mismatch creates no subimage directory, valid existing pairs are byte-identical, and partial results name the failed folder.

- [ ] **Step 7: Commit Task 3**

```bash
git add server/subimageService.js server/subimageService.test.js
git commit -m "feat: add preflighted subimage batches"
```

---

### Task 4: Subimage HTTP API and Safe Errors

**Files:**
- Modify: `server/app.js:1-113,318-460`
- Test: `server/app.test.js:1-100,760-940`

**Interfaces:**
- Produces: `GET /api/images/:id/subimage` returning `{ hasSubimage, crop }`.
- Produces: `PUT /api/images/:id/subimage` accepting `{ crop }` and returning `{ crop }`.
- Produces: `POST /api/subimages/create-missing` accepting `{ templateCrop }` and returning `BatchResult`.
- Produces: `POST /api/subimages/replace-all` accepting `{ templateCrop }` and returning `BatchResult`.
- Produces: safe error body `{ error, code, failures? }` for `SubimageError`.
- Consumes: all Task 2 and Task 3 service exports.

- [ ] **Step 1: Write failing API route tests**

Add route tests to `server/app.test.js`:

```js
test("loads missing subimage state and saves the active image crop", async () => {
  const appRoot = await createTempRoot();
  const imageRoot = await createTempRoot();
  await writeImage(imageRoot, "T01", "frame001.tif", [100, 200, 300, 400]);
  const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

  const missing = await jsonRequest(app, "/api/images/T01/subimage");
  expect(missing.status).toBe(200);
  await expect(missing.json()).resolves.toEqual({ hasSubimage: false, crop: null });

  const saved = await jsonRequest(app, "/api/images/T01/subimage", {
    method: "PUT",
    body: { crop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
  });
  expect(saved.status).toBe(200);
  await expect(saved.json()).resolves.toMatchObject({ crop: { imageFolder: "T01", width: 2, height: 2 } });
});

test("returns a safe coded response for an invalid crop", async () => {
  const appRoot = await createTempRoot();
  const imageRoot = await createTempRoot();
  await writeImage(imageRoot, "T01", "frame001.tif", [100, 200, 300, 400]);

  const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/images/T01/subimage", {
    method: "PUT",
    body: { crop: { sourceWidth: 2, sourceHeight: 2, x: 2, y: 0, width: 2, height: 2 } },
  });

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "Invalid subimage crop.", code: "INVALID_CROP" });
});
```

Add create-missing and replace-all tests asserting ordered folder lists. Add a dimension-preflight test asserting status 422 and:

```js
{
  error: "Subimage batch preflight failed.",
  code: "BATCH_PREFLIGHT_FAILED",
  failures: [{ imageFolder: "T02", code: "DIMENSION_MISMATCH", message: "Source dimensions do not match the template." }],
}
```

Add an unknown-ID test asserting the existing 404 `Image not found.` behavior.

- [ ] **Step 2: Run API tests and verify RED**

Run:

```bash
npm test -- server/app.test.js
```

Expected: the four new endpoints return 404 before route implementation.

- [ ] **Step 3: Add safe error mapping**

Import the four service functions and `SubimageError`. Add a fixed map inside `safeErrorResponse`:

```js
if (error instanceof SubimageError) {
  const messages = {
    MISSING_SOURCE: "Source TIFF is missing.",
    UNSUPPORTED_SOURCE: "Source TIFF must be single-channel 16-bit grayscale.",
    DIMENSION_MISMATCH: "Source image dimensions do not match.",
    INVALID_CROP: "Invalid subimage crop.",
    ASPECT_RATIO_MISMATCH: "Subimage crop must match the source aspect ratio.",
    INVALID_SAVED_CROP: "Saved subimage metadata is invalid.",
    MISSING_SAVED_TIFF: "Saved subimage TIFF is missing.",
    CROP_RENDER_FAILED: "Unable to render subimage TIFF.",
    WRITE_FAILED: "Unable to save subimage.",
    BATCH_PREFLIGHT_FAILED: "Subimage batch preflight failed.",
  };
  return {
    status: error.status,
    body: {
      error: messages[error.code] ?? "Unable to process subimage.",
      code: error.code,
      ...(Array.isArray(error.details?.failures) ? { failures: error.details.failures } : {}),
    },
  };
}
```

- [ ] **Step 4: Add the four routes**

Register these routes before static serving:

```js
app.get("/api/images/:id/subimage", asyncRoute(async (request, response) => {
  response.json(await loadSubimage(imageStorage, request.params.id, { maxImagePixels }));
}));

app.put("/api/images/:id/subimage", asyncRoute(async (request, response) => {
  response.json(await saveSubimage(imageStorage, request.params.id, request.body?.crop, { maxImagePixels }));
}));

app.post("/api/subimages/create-missing", asyncRoute(async (request, response) => {
  response.json(await createMissingSubimages(imageStorage, request.body?.templateCrop, { maxImagePixels }));
}));

app.post("/api/subimages/replace-all", asyncRoute(async (request, response) => {
  response.json(await replaceAllSubimages(imageStorage, request.body?.templateCrop, { maxImagePixels }));
}));
```

Do not add subimage files to `/api/export` or `createSnapshot` write capabilities.

- [ ] **Step 5: Run server tests and verify GREEN**

Run:

```bash
npm test -- server/app.test.js server/subimageService.test.js server/storage.test.js
```

Expected: all tests pass; failures expose stable codes and folder names but no local paths or Sharp/libvips text.

- [ ] **Step 6: Commit Task 4**

```bash
git add server/app.js server/app.test.js
git commit -m "feat: expose subimage crop APIs"
```

---

### Task 5: Source-Aspect Crop Geometry

**Files:**
- Create: `src/lib/subimageCrop.js`
- Create: `src/lib/subimageCrop.test.js`

**Interfaces:**
- Produces: `createAspectLockedCrop(start, current, imageSize): Crop | null`.
- Produces: `moveCropBy(crop, delta, imageSize): Crop`.
- Produces: `cropContainsPoint(crop, point): boolean`.
- Produces: `sameCrop(left, right): boolean` comparing source dimensions and `x/y/width/height` only.
- Produces: `cropFitsImage(crop, imageSize): boolean`.
- Consumes: integer pixel-center points from existing `eventToImagePoint`.

Client crop shape sent to the server is:

```ts
type Crop = {
  sourceWidth: number;
  sourceHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
```

- [ ] **Step 1: Write failing geometry tests**

Create `src/lib/subimageCrop.test.js`:

```js
import { describe, expect, test } from "vitest";
import {
  createAspectLockedCrop,
  cropContainsPoint,
  cropFitsImage,
  moveCropBy,
  sameCrop,
} from "./subimageCrop.js";

describe("subimage crop geometry", () => {
  test.each([
    [{ x: 20, y: 20 }, { x: 59, y: 49 }, { x: 20, y: 20, width: 40, height: 30 }],
    [{ x: 59, y: 49 }, { x: 20, y: 20 }, { x: 20, y: 20, width: 40, height: 30 }],
    [{ x: 59, y: 20 }, { x: 20, y: 49 }, { x: 20, y: 20, width: 40, height: 30 }],
    [{ x: 20, y: 49 }, { x: 59, y: 20 }, { x: 20, y: 20, width: 40, height: 30 }],
  ])("locks a 4:3 selection in every drag quadrant", (start, current, expected) => {
    expect(createAspectLockedCrop(start, current, { width: 100, height: 75 })).toEqual({
      sourceWidth: 100,
      sourceHeight: 75,
      ...expected,
    });
  });

  test("uses the largest source-aspect rectangle inside the pointer extent", () => {
    expect(createAspectLockedCrop({ x: 0, y: 0 }, { x: 79, y: 39 }, { width: 100, height: 75 })).toEqual({
      sourceWidth: 100,
      sourceHeight: 75,
      x: 0,
      y: 0,
      width: 53,
      height: 40,
    });
  });

  test("moves a locked crop without resizing and clamps it inside the image", () => {
    const crop = { sourceWidth: 100, sourceHeight: 75, x: 20, y: 10, width: 40, height: 30 };
    expect(moveCropBy(crop, { x: 80, y: -40 }, { width: 100, height: 75 })).toEqual({
      ...crop,
      x: 60,
      y: 0,
    });
  });

  test("uses half-open crop bounds and ignores server metadata in dirty equality", () => {
    const crop = { sourceWidth: 100, sourceHeight: 75, x: 20, y: 10, width: 40, height: 30 };
    expect(cropContainsPoint(crop, { x: 20, y: 10 })).toBe(true);
    expect(cropContainsPoint(crop, { x: 60, y: 40 })).toBe(false);
    expect(cropFitsImage(crop, { width: 100, height: 75 })).toBe(true);
    expect(sameCrop(crop, { ...crop, updatedAt: "2026-08-04T00:00:00.000Z" })).toBe(true);
    expect(sameCrop(crop, { ...crop, x: 21 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run geometry tests and verify RED**

Run:

```bash
npm test -- src/lib/subimageCrop.test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic integer crop selection**

Use inclusive pointer spans, then scale the source dimensions and round the derived size:

```js
export function createAspectLockedCrop(start, current, imageSize) {
  if (!validImageSize(imageSize) || !validPoint(start) || !validPoint(current)) return null;
  const directionX = current.x >= start.x ? 1 : -1;
  const directionY = current.y >= start.y ? 1 : -1;
  const spanWidth = Math.abs(current.x - start.x) + 1;
  const spanHeight = Math.abs(current.y - start.y) + 1;
  const scale = Math.min(spanWidth / imageSize.width, spanHeight / imageSize.height);
  if (!(scale > 0)) return null;

  let width = Math.max(1, Math.floor(imageSize.width * scale));
  let height = Math.max(1, Math.round((width * imageSize.height) / imageSize.width));
  while (height > spanHeight && width > 1) {
    width -= 1;
    height = Math.max(1, Math.round((width * imageSize.height) / imageSize.width));
  }
  if (width > spanWidth || height > spanHeight) return null;

  const x = directionX > 0 ? start.x : start.x - width + 1;
  const y = directionY > 0 ? start.y : start.y - height + 1;
  return {
    sourceWidth: imageSize.width,
    sourceHeight: imageSize.height,
    x: clamp(x, 0, imageSize.width - width),
    y: clamp(y, 0, imageSize.height - height),
    width,
    height,
  };
}
```

Keep all helpers pure. `moveCropBy` rounds deltas, clamps `x` to `0..sourceWidth-width` and `y` to `0..sourceHeight-height`, and returns the original object when nothing changes.

- [ ] **Step 4: Run geometry tests and verify GREEN**

Run:

```bash
npm test -- src/lib/subimageCrop.test.js
```

Expected: all drag-direction, aspect, containment, clamp, and equality tests pass.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/lib/subimageCrop.js src/lib/subimageCrop.test.js
git commit -m "feat: add fixed-aspect crop geometry"
```

---

### Task 6: Subimage Overlay and Contextual Panel

**Files:**
- Create: `src/components/SubimageOverlay.jsx`
- Create: `src/components/SubimageOverlay.test.jsx`
- Create: `src/components/SubimagePanel.jsx`
- Create: `src/components/SubimagePanel.test.jsx`
- Modify: `src/styles.css:133-260,560-635,864-900`
- Test: `src/styles.test.js:1-136`

**Interfaces:**
- Produces: `<SubimageOverlay crop imageWidth imageHeight />`.
- Produces: `<SubimagePanel activeImageName templateOwnerName isTemplateOwner hasSubimage crop dirty mode busy error result canCreateMissing canSave canReplace onSetCrop onCreateMissing onSave onStartReplace onApplyReplace onCancelReplace />`.
- `mode` is exactly `"idle" | "select-initial" | "select-replacement" | "confirm-replacement"`.
- `busy` is exactly `null | "loading" | "saving" | "create-missing" | "replace-all"`.
- `result` consumes the Task 3 `BatchResult` unchanged.

- [ ] **Step 1: Write failing overlay tests**

Create `src/components/SubimageOverlay.test.jsx`:

```jsx
/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import SubimageOverlay from "./SubimageOverlay.jsx";

test("renders an even-odd outside shade and exact crop outline", () => {
  render(<SubimageOverlay crop={{ x: 20, y: 10, width: 40, height: 30 }} imageWidth={100} imageHeight={75} />);
  expect(screen.getByLabelText("Subimage crop overlay")).toHaveAttribute("viewBox", "0 0 100 75");
  expect(screen.getByTestId("subimage-outside-shade")).toHaveAttribute("fill-rule", "evenodd");
  expect(screen.getByLabelText("Crop x 20 y 10 width 40 height 30")).toHaveAttribute("width", "40");
});

test("renders no overlay without a valid crop", () => {
  const { container } = render(<SubimageOverlay crop={null} imageWidth={100} imageHeight={75} />);
  expect(container).toBeEmptyDOMElement();
});
```

- [ ] **Step 2: Write failing panel tests**

Create `src/components/SubimagePanel.test.jsx` and assert:

```jsx
/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import SubimagePanel from "./SubimagePanel.jsx";

const handlers = {
  onSetCrop: vi.fn(),
  onCreateMissing: vi.fn(),
  onSave: vi.fn(),
  onStartReplace: vi.fn(),
  onApplyReplace: vi.fn(),
  onCancelReplace: vi.fn(),
};

render(
  <SubimagePanel
    activeImageName="T01"
    templateOwnerName="T01"
    isTemplateOwner
    hasSubimage={false}
    crop={{ sourceWidth: 100, sourceHeight: 75, x: 20, y: 10, width: 40, height: 30 }}
    dirty
    mode="idle"
    busy={null}
    error=""
    result={null}
    canCreateMissing
    canSave={false}
    canReplace={false}
    onSetCrop={handlers.onSetCrop}
    onCreateMissing={handlers.onCreateMissing}
    onSave={handlers.onSave}
    onStartReplace={handlers.onStartReplace}
    onApplyReplace={handlers.onApplyReplace}
    onCancelReplace={handlers.onCancelReplace}
  />,
);

expect(screen.getByRole("heading", { name: "Subimage" })).toBeInTheDocument();
expect(screen.getByText("T01")).toBeInTheDocument();
expect(screen.getByText("x 20")).toBeInTheDocument();
expect(screen.getByText("40 x 30 px")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Create all subimages" })).toBeEnabled();
expect(screen.getByRole("button", { name: "Save subimage" })).toBeDisabled();
```

Add cases for a later image showing `Template: T01` with Create All disabled, a dirty locked crop enabling Save, replacement mode exposing `Apply replacement` and `Cancel replacement`, busy state disabling every action, and partial batch output listing completed and failed folder names.

- [ ] **Step 3: Run component tests and verify RED**

Run:

```bash
npm test -- src/components/SubimageOverlay.test.jsx src/components/SubimagePanel.test.jsx
```

Expected: FAIL because both components do not exist.

- [ ] **Step 4: Implement the presentational components**

Render the overlay as a pointer-transparent SVG:

```jsx
export default function SubimageOverlay({ crop, imageWidth, imageHeight }) {
  if (!crop || !imageWidth || !imageHeight) return null;
  const inner = `M ${crop.x} ${crop.y} H ${crop.x + crop.width} V ${crop.y + crop.height} H ${crop.x} Z`;
  const outer = `M 0 0 H ${imageWidth} V ${imageHeight} H 0 Z`;
  return (
    <svg className="subimage-overlay" viewBox={`0 0 ${imageWidth} ${imageHeight}`} aria-label="Subimage crop overlay">
      <path data-testid="subimage-outside-shade" d={`${outer} ${inner}`} fillRule="evenodd" />
      <rect
        aria-label={`Crop x ${crop.x} y ${crop.y} width ${crop.width} height ${crop.height}`}
        className="subimage-crop-outline"
        x={crop.x}
        y={crop.y}
        width={crop.width}
        height={crop.height}
      />
    </svg>
  );
}
```

Keep `SubimagePanel` free of fetch/state logic. It calls callbacks only, uses `canCreateMissing`, `canSave`, `canReplace`, and `busy` to set native `disabled`, renders coordinates as read-only text, and renders batch arrays in scanned order. `Apply replacement` is present only in `confirm-replacement` mode.

- [ ] **Step 5: Add compact panel and overlay CSS plus CSS guards**

Add these stacking and interaction rules:

```css
.subimage-overlay {
  position: absolute;
  inset: 0;
  z-index: 4;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.subimage-overlay [data-testid="subimage-outside-shade"] {
  fill: rgba(0, 0, 0, 0.62);
}

.subimage-crop-outline {
  fill: none;
  stroke: #22c55e;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.subimage-controls,
.subimage-fields,
.subimage-actions,
.subimage-batch-result {
  display: grid;
  gap: 8px;
  min-width: 0;
}
```

Add a `styles.test.js` case asserting `z-index: 4`, `pointer-events: none`, outside alpha, and a single-column `.subimage-actions` grid so controls do not compete for horizontal space.

- [ ] **Step 6: Run component and CSS tests and verify GREEN**

Run:

```bash
npm test -- src/components/SubimageOverlay.test.jsx src/components/SubimagePanel.test.jsx src/styles.test.js
```

Expected: all component semantics and stacking/layout tests pass.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/components/SubimageOverlay.jsx src/components/SubimageOverlay.test.jsx src/components/SubimagePanel.jsx src/components/SubimagePanel.test.jsx src/styles.css src/styles.test.js
git commit -m "feat: add subimage crop controls"
```

---

### Task 7: App Workflow, Pointer Dragging, and Dirty Guards

**Files:**
- Modify: `src/App.jsx:111-230,256-616,703-721,923-952,1182-1365,1530-2010`
- Test: `src/App.test.jsx:1-520,1320-1420,2460-end`

**Interfaces:**
- Consumes: Task 4 endpoints, Task 5 geometry functions, and Task 6 components.
- Produces: `Subimage` layer behavior with no polygon mutation.
- Produces: request state scoped by active root and image, using `subimageRequestRef` stale-response guards.
- Produces: interaction state `{ kind: "select" | "move", start, startCrop? }` and replacement state from Task 6 `mode`.
- Preserves: existing bounds `dirty` state independently from derived `subimageDirty`.

- [ ] **Step 1: Extend the App fetch fixture and write failing layer tests**

In `mockApi`, add GET/PUT and batch branches with overridable `subimageResponse`, `saveSubimageResponse`, `createSubimagesResponse`, and `replaceSubimagesResponse` callbacks. Add same-dimension fixtures so the client workflow reflects the server batch contract:

```js
const savedSubimage = {
  schemaVersion: 1,
  imageFolder: "plate-a",
  imageFile: "a.tif",
  sourceWidth: 100,
  sourceHeight: 80,
  x: 10,
  y: 8,
  width: 50,
  height: 40,
  aspectRatio: 1.25,
  updatedAt: "2026-08-04T00:00:00.000Z",
};

const subimageImages = images.map((image) => ({ ...image, width: 100, height: 80 }));
```

Each Subimage App test initializes:

```js
const { fetchMock } = mockApi({
  rootImages: subimageImages,
  rawDimensionsById: { "scan-a": [100, 80], "scan-b": [100, 80] },
  subimageResponse: (imageId) => jsonResponse(
    imageId === "scan-a"
      ? { hasSubimage: true, crop: savedSubimage }
      : { hasSubimage: false, crop: null },
  ),
});
```

Test that selecting Subimage:

```jsx
fireEvent.click(screen.getByRole("button", { name: "Subimage" }));
await screen.findByRole("heading", { name: "Subimage" });

expect(screen.getByLabelText("raw16 image")).not.toHaveClass("hidden-layer");
expect(screen.getByLabelText("Subimage crop overlay")).toBeInTheDocument();
expect(screen.queryByLabelText("Bounds overlay")).not.toBeInTheDocument();
expect(screen.queryByLabelText("Point order")).not.toBeInTheDocument();
expect(screen.queryByLabelText("Heatmap report")).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
expect(screen.getByRole("button", { name: "Save subimage" })).toBeInTheDocument();
```

Press `p`, `d`, and `m` while in Subimage mode and assert bounds and status do not change.

- [ ] **Step 2: Write failing initial-selection and no-write drag tests**

Use a 1000x800 mocked canvas/content rectangle for the 100x80 image. On the first image:

```js
fireEvent.click(screen.getByRole("button", { name: "Set crop area" }));
const stage = screen.getByTestId("image-stage");
const canvas = screen.getByLabelText("raw16 image");
vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
  left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800,
});

fireEvent.pointerDown(stage, { clientX: 100, clientY: 80, pointerId: 1 });
fireEvent.pointerMove(stage, { clientX: 600, clientY: 480, pointerId: 1 });
fireEvent.pointerUp(stage, { clientX: 600, clientY: 480, pointerId: 1 });

expect(screen.getByText("50 x 40 px")).toBeInTheDocument();
expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/subimage"), expect.objectContaining({ method: "PUT" }));
expect(screen.getByRole("button", { name: "Create all subimages" })).toBeEnabled();
```

Add a locked-crop movement test: drag from inside the crop beyond the top-right edge, assert width/height remain `50 x 40`, `x` becomes 50 and `y` becomes 0, and no PUT occurs until `Save subimage` is clicked. Then assert PUT body contains only the current image's draft.

- [ ] **Step 3: Write failing batch, reload, and stale-response tests**

Add tests that:

- click Create All and assert POST `/api/subimages/create-missing` with the first-image template;
- show created/preserved/failed folder names from the response;
- navigate to the second image and load its distinct saved `x/y`;
- start Replace All from the second image, draw a new crop, cancel `window.confirm`, and assert no POST;
- approve confirmation and assert POST `/api/subimages/replace-all`, then lock the returned active crop;
- resolve the first image's deferred GET after navigation to the second image and assert it cannot replace the second image's crop.

The stale test must key the response against both request sequence and active image ID. Set it up with the existing `deferred()` helper:

```js
const firstSubimageDeferred = deferred();
mockApi({
  rootImages: subimageImages,
  rawDimensionsById: { "scan-a": [100, 80], "scan-b": [100, 80] },
  subimageResponse: (imageId) => imageId === "scan-a"
    ? firstSubimageDeferred.promise
    : jsonResponse({ hasSubimage: true, crop: { ...savedSubimage, imageFolder: "plate-b", imageFile: "b.tif", x: 30 } }),
});

expect(screen.getByText("x 30")).toBeInTheDocument();
firstSubimageDeferred.resolve(jsonResponse({ hasSubimage: true, crop: savedSubimage }));
await act(async () => firstSubimageDeferred.promise);
expect(screen.getByText("x 30")).toBeInTheDocument();
expect(screen.queryByText("x 10")).not.toBeInTheDocument();
```

- [ ] **Step 4: Write failing dirty-transition tests**

After moving a crop without saving, assert confirmation blocks and then permits each transition:

- Prev/Next button and ArrowLeft/ArrowRight;
- `Set root` form submission;
- `Find root`;
- leaving Subimage for Original;
- `beforeunload` with `event.defaultPrevented === true`; the handler must also assign `event.returnValue = ""` for browsers that require the legacy signal.

Also set bounds dirty before entering Subimage, save a Subimage crop, and assert bounds still reports unsaved. This proves the two dirty states do not overwrite each other.

- [ ] **Step 5: Run App tests and verify RED**

Run:

```bash
npm test -- src/App.test.jsx
```

Expected: new Subimage controls and behavior are absent.

- [ ] **Step 6: Add isolated Subimage state and loading**

Import the Task 5 helpers and Task 6 components. Add state:

```js
const subimageRequestRef = useRef(0);
const [savedSubimageCrop, setSavedSubimageCrop] = useState(null);
const [subimageDraft, setSubimageDraft] = useState(null);
const [subimageTemplateCrop, setSubimageTemplateCrop] = useState(null);
const [subimageMode, setSubimageMode] = useState("idle");
const [subimageInteraction, setSubimageInteraction] = useState(null);
const [subimageBusy, setSubimageBusy] = useState(null);
const [subimageError, setSubimageError] = useState("");
const [subimageBatchResult, setSubimageBatchResult] = useState(null);
```

Derive:

```js
const subimageDirty = Boolean(subimageDraft) && !sameCrop(subimageDraft, savedSubimageCrop);
const isBoundsLayer = imageLayer !== "heatmap" && imageLayer !== "subimage";
const isTemplateOwner = activeIndex === 0;
const subimageSizeLocked = Boolean(subimageTemplateCrop) && subimageMode === "idle";
const canCreateMissing = isTemplateOwner && Boolean(subimageTemplateCrop);
const canSaveSubimage = subimageSizeLocked && subimageDirty && (Boolean(savedSubimageCrop) || !isTemplateOwner);
const canReplaceSubimages = Boolean(subimageTemplateCrop) && subimageMode === "idle";
```

When `imageLayer === "subimage"`, load the active image and first image crop with a request token. A valid first-image crop initializes `subimageTemplateCrop`. Active saved crop wins; otherwise a fitting template becomes the active unsaved draft. On root replacement, increment the request ref and clear all Subimage state before loading the new root.

- [ ] **Step 7: Implement explicit save and batch actions**

Use `readJsonResponse` for all requests. The current-image save body is exact:

```js
body: JSON.stringify({ crop: subimageDraft })
```

On save success, set both saved and draft from `payload.crop`; if `activeIndex === 0`, update the retained template too. On failure, keep the draft and show the safe server message.

When the first-image initial selection ends, set both `subimageDraft` and `subimageTemplateCrop` to the selected rectangle and return to `idle`; `Set crop area` can arm another initial selection before batch creation. Create-missing posts `{ templateCrop: subimageTemplateCrop }` and is enabled only for index 0 with a valid draft/template. After a complete or partial batch response, reload `GET /api/images/:id/subimage` for the active image; use that server payload for saved/draft state when the active folder succeeded and keep the draft when it failed. Replace flow is:

1. `onStartReplace`: set mode to `select-replacement` without changing saved state.
2. Pointer draw: set the candidate draft and mode `confirm-replacement`.
3. `onApplyReplace`: call `window.confirm("Replace all saved subimages with this crop?")`.
4. On approval POST `{ templateCrop: subimageDraft }`.
5. On success reload the active image's GET endpoint, then set template, saved active crop, and draft from that server-normalized crop; set mode `idle`.
6. `onCancelReplace`: restore `savedSubimageCrop` as draft and set mode `idle`.

- [ ] **Step 8: Route stage pointer events through Subimage interaction**

Add `onPointerDown={handleStagePointerDown}`. In Subimage mode:

- pointer down in armed selection starts `{ kind: "select", start }`;
- pointer down inside a locked crop starts `{ kind: "move", start, startCrop: subimageDraft }`;
- pointer move calls `createAspectLockedCrop` for selection or `moveCropBy(startCrop, pointer-start, imageSize)` for movement;
- pointer up/cancel ends the interaction;
- stage click returns before polygon point insertion;
- pointer movement never calls fetch;
- selection and movement use `imageContentRect(canvasRef.current, event.currentTarget)` and `eventToImagePoint(..., { allowOutside: true })` while dragging.

Only `isBoundsLayer` may run polygon keyboard shortcuts, point movement, point insertion, bounds overlays, ROI overlays, point opacity controls, point-order panel, top-toolbar bounds Save, or Import Previous Bound.

- [ ] **Step 9: Add contextual rendering and transition guards**

Add the fifth segmented-control button:

```jsx
<button type="button" aria-pressed={imageLayer === "subimage"} onClick={() => handleImageLayerSelect("subimage")}>
  Subimage
</button>
```

Render `SubimagePanel` as the complete left-panel body when active, keep the raw canvas visible for `original` and `subimage`, and render `SubimageOverlay` after the raw canvas. Do not render bounds SVG, mask, skeleton, Heat Map report, points, ROI, or migration layers in Subimage mode.

Replace the current navigation/root confirmation with:

```js
const confirmNavigationDiscard = useCallback(() => {
  if (!dirty && !subimageDirty) return true;
  const subject = dirty && subimageDirty
    ? "bounds and subimage changes"
    : subimageDirty ? "subimage changes" : "bound changes";
  return window.confirm(`Discard unsaved ${subject}?`);
}, [dirty, subimageDirty]);
```

Use it for navigation and both root actions. For layer changes, ask only when leaving Subimage with `subimageDirty`; cancellation keeps the current layer. Add a `beforeunload` effect only while `subimageDirty` is true. Confirmed discard resets the Subimage draft from saved state before proceeding.

- [ ] **Step 10: Run client tests and verify GREEN**

Run:

```bash
npm test -- src/lib/subimageCrop.test.js src/components/SubimageOverlay.test.jsx src/components/SubimagePanel.test.jsx src/App.test.jsx src/styles.test.js
```

Expected: all Subimage geometry, display, API coordination, stale-response, and dirty-transition tests pass; existing polygon and Heat Map tests remain green.

- [ ] **Step 11: Commit Task 7**

```bash
git add src/App.jsx src/App.test.jsx
git commit -m "feat: integrate draggable subimage workflow"
```

---

### Task 8: Documentation and End-to-End TIFF Verification

**Files:**
- Modify: `README.md`
- Verify: all production and test files from Tasks 1-7

**Interfaces:**
- Documents: `subimage/<source filename>` and `subimage/crop.json` ownership.
- Documents: first-image template, create-missing preservation, mouse-only position edits, explicit save, and replace-all confirmation.
- Verifies: exact TIFF metadata and raw pixel equality against an actual source region.

- [ ] **Step 1: Add the user-facing workflow and folder contract to README**

Add a concise `Subimage crops` section containing this structure:

```text
image-folder/
  image/original.tif
  subimage/original.tif
  subimage/crop.json
```

State that the first filename-ordered image defines the common crop size and initial position, `Create all subimages` leaves valid prior crops unchanged, per-image drag remains local until `Save subimage`, and `Replace all subimages` is destructive only after confirmation. State explicitly that output remains unresized, single-channel 16-bit grayscale TIFF and is not included in Download as ZIP.

- [ ] **Step 2: Run the complete automated suite**

Run:

```bash
npm test
npm run build
```

Expected: every Vitest file passes and Vite production build exits 0 without warnings introduced by Subimage code.

- [ ] **Step 3: Start the production server and verify the browser workflow**

Run:

```bash
npm run server
```

Open `http://localhost:3000`, set the root to a real same-dimension TIFF sequence, and verify in this exact order:

1. Enter Subimage on the first image and draw a source-aspect crop in each drag direction.
2. Run Create All and confirm every image gets the same crop dimensions and initial coordinates.
3. Navigate in filename order, drag one crop, and verify no disk timestamp changes before Save Subimage.
4. Save that image and verify only its TIFF and JSON timestamps change.
5. Reload and confirm each saved position is restored.
6. Start Replace All from a later image, cancel confirmation, and verify no file changes.
7. Repeat and approve; verify every image uses the new template.
8. Make a draft dirty and verify image, root, layer, and reload warnings.

- [ ] **Step 4: Verify real output metadata and raw pixel identity**

For one saved `crop.json`, run this Node check against the current T56 fixture:

```bash
SOURCE_TIFF="/Users/ksc/Documents/imageSegmentationUsingPen/image/selected pixel/230809.122410.col cell mmp inhibit.102.FB.A2.T100P04/selected-stack-sequence_T56/image/selected-stack-sequence_T56.tif" \
CROP_JSON="/Users/ksc/Documents/imageSegmentationUsingPen/image/selected pixel/230809.122410.col cell mmp inhibit.102.FB.A2.T100P04/selected-stack-sequence_T56/subimage/crop.json" \
OUTPUT_TIFF="/Users/ksc/Documents/imageSegmentationUsingPen/image/selected pixel/230809.122410.col cell mmp inhibit.102.FB.A2.T100P04/selected-stack-sequence_T56/subimage/selected-stack-sequence_T56.tif" \
node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const crop = JSON.parse(await readFile(process.env.CROP_JSON, "utf8"));
const source = await sharp(process.env.SOURCE_TIFF).toColourspace("grey16").raw({ depth: "ushort" }).toBuffer({ resolveWithObject: true });
const output = await sharp(process.env.OUTPUT_TIFF).toColourspace("grey16").raw({ depth: "ushort" }).toBuffer({ resolveWithObject: true });
const sourcePixels = new Uint16Array(source.data.buffer, source.data.byteOffset, source.data.byteLength / 2);
const outputPixels = new Uint16Array(output.data.buffer, output.data.byteOffset, output.data.byteLength / 2);
const expected = [];
for (let y = crop.y; y < crop.y + crop.height; y += 1) {
  for (let x = crop.x; x < crop.x + crop.width; x += 1) expected.push(sourcePixels[y * crop.sourceWidth + x]);
}
const exact = expected.length === outputPixels.length && expected.every((value, index) => value === outputPixels[index]);
console.log(JSON.stringify({ source: source.info, output: output.info, crop, exact }, null, 2));
if (!exact || output.info.depth !== "ushort" || output.info.channels !== 1) process.exit(1);
NODE
```

Expected: `exact` is `true`; output width/height equal crop width/height; output depth is `ushort`; output channels is `1`.

- [ ] **Step 5: Confirm unrelated export behavior remains unchanged**

Run Download as ZIP once and inspect the archive listing:

```bash
EXPORT_ZIP="$(find "$HOME/Downloads" -name '*_export_*.zip' -type f -print | sort | tail -1)"
unzip -l "$EXPORT_ZIP" | rg "subimage|statistics|heatmap"
```

Expected: statistics and heatmap export entries remain present, and no `subimage/` entry appears.

- [ ] **Step 6: Commit Task 8**

```bash
git add README.md
git commit -m "docs: explain subimage crop workflow"
```

---

## Final Verification Gate

- [ ] Confirm `git status --short` contains no generated TIFF, JSON, ZIP, `dist`, or temporary files.
- [ ] Run `npm test` one final time.
- [ ] Run `npm run build` one final time.
- [ ] Inspect `git diff origin/main...HEAD --stat` and confirm changes are limited to the files in this plan plus the approved design and plan documents.
- [ ] Confirm the implementation satisfies every success criterion in `docs/superpowers/specs/2026-08-04-subimage-crop-design.md`.
