# Inference Mask Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/inferencePage` to request U-Net++ probability maps, review and propagate mask thresholds, and generate binary masks without altering source TIFF files.

**Architecture:** Add a focused server probability-map module for strict NumPy `.npy` I/O, threshold statistics, previews, and PNG mask creation. An inference service owns sequential remote model jobs and durable per-image settings; Express exposes it through narrow JSON/image endpoints. A new React page shares the existing raw-16 canvas renderer but has independent list, threshold, overlay, and generation controls, selected by a small path router.

**Tech Stack:** Node.js ESM, Express, native `fetch`/`FormData`, Sharp, React 18, Vite, Vitest, Testing Library.

## Global Constraints

- The source `<timestamp>/image/<source>.tif` is read-only.
- A saved probability map is a C-order NumPy `.npy` `float32` array with shape `[height, width]` and values in `[0, 1]`.
- Store only derived files: `probability-maps/<stem>.probability.npy`, `probability-maps/<stem>.mask-setting.json`, and generated `mask/<stem>.png`.
- Root scanning must accept `image/` even before `mask/` exists; inference independently discovers every TIFF within every timestamp `image/` directory, while all current missing-mask analysis errors remain safe.
- Inference uploads one image at a time to `POST <server-url>/v1/inference/probability-map` using multipart field `file` and expects `application/x-npy`.
- Default threshold is `0.5`; automatic matching uses threshold candidates `0.000` through `1.000` in `0.001` increments and breaks ties toward the lower threshold.
- The reference image is never propagated automatically: only **Set other thresholds from reference** changes other images, and later per-image edits stay local.
- Do not add a client dependency for binary NumPy parsing or a routing library.
- Preserve current root-picker behavior and current `/` editor functionality.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/probabilityMap.js` | Parse and validate `.npy`, calculate fractions, choose thresholds, render overlays, and write binary masks. |
| `server/probabilityMap.test.js` | Unit coverage for binary parsing, validation, matching, and rendered mask values. |
| `server/inferenceService.js` | Independently scan every TIFF per timestamp, execute sequential remote jobs, persist settings, and coordinate map operations. |
| `server/inferenceService.test.js` | Service tests with temporary datasets and injected `fetch`. |
| `server/storage.js` | Permit image-only timestamp folders and expose probability-map paths. |
| `server/storage.test.js` | Assert image-only scan and derived paths without breaking current storage behavior. |
| `server/app.js` | Add inference HTTP routes, safe error mapping, dependency injection, and SPA route fallback. |
| `server/app.test.js` | Exercise inference API contracts, binary responses, model failures, and `/inferencePage` fallback. |
| `src/AppRouter.jsx` | Select the existing editor or the new page from `window.location.pathname`. |
| `src/InferencePage.jsx` | Root/job controls, list navigation, raw canvas, threshold/ROI review, batch proposal, and mask generation UI. |
| `src/InferencePage.test.jsx` | Test page state, explicit propagation, manual edits, navigation, and error presentation with mocked APIs. |
| `src/main.jsx` | Mount `AppRouter` instead of directly mounting `App`. |
| `src/styles.css` | Add scoped inference-page layout and responsive controls without changing editor rules. |

### Task 1: Implement lossless probability-map primitives

**Files:**
- Create: `server/probabilityMap.js`
- Create: `server/probabilityMap.test.js`

**Interfaces:**
- Produces `parseProbabilityNpy(buffer) -> { width, height, data: Float32Array }`.
- Produces `probabilityMetrics({ probabilityMap, threshold, polygon? }) -> { pixelCount, areaPx, areaFraction }`.
- Produces `closestThreshold({ probabilityMap, targetFraction, polygon? }) -> { threshold, areaFraction }`.
- Produces `createProbabilityOverlayPng({ probabilityMap, threshold }) -> Buffer` and `writeThresholdMaskPng(outputPath, { probabilityMap, threshold }) -> Promise<void>`.
- Consumed by `server/inferenceService.js` and `server/app.js`.

- [ ] **Step 1: Write failing parser and metric tests**

```js
test("parses a C-order float32 NPY map and preserves normalized values", () => {
  const parsed = parseProbabilityNpy(npyFixture({ width: 3, height: 2, values: [0, 0.5, 1, 0.25, 0.75, 1] }));
  expect(parsed).toMatchObject({ width: 3, height: 2 });
  expect([...parsed.data]).toEqual([0, 0.5, 1, 0.25, 0.75, 1]);
});

test("counts only probabilities at or above the threshold in a polygon", () => {
  const metrics = probabilityMetrics({ probabilityMap: fixtureMap(), threshold: 0.5, polygon: square(1, 0, 2, 1) });
  expect(metrics).toEqual({ pixelCount: 3, areaPx: 4, areaFraction: 0.75 });
});

test("chooses the lower 0.001-grid threshold when errors are tied", () => {
  expect(closestThreshold({ probabilityMap: fixtureMap(), targetFraction: 0.5 })).toMatchObject({ threshold: 0.5 });
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `npx vitest run --exclude '.worktrees/**' server/probabilityMap.test.js`

Expected: FAIL because `server/probabilityMap.js` does not exist.

- [ ] **Step 3: Implement strict `.npy` parsing and computations**

```js
export function parseProbabilityNpy(buffer) {
  const { header, dataOffset } = parseNpyHeader(buffer);
  if (header.descr !== "<f4" || header.fortran_order !== false || header.shape.length !== 2) {
    throw new ProbabilityMapError("INVALID_PROBABILITY_MAP", "Expected C-order float32 [height, width] NPY data.");
  }
  const [height, width] = header.shape;
  const data = new Float32Array(buffer.buffer, buffer.byteOffset + dataOffset, width * height);
  validateProbabilityValues(data);
  return { width, height, data: Float32Array.from(data) };
}

export function closestThreshold({ probabilityMap, targetFraction, polygon }) {
  const histogram = buildThresholdHistogram(probabilityMap, polygon);
  return chooseClosestFraction(histogram, targetFraction);
}
```

Implement the NumPy v1 and v2 header-length variants, reject trailing or undersized data, reject non-finite/out-of-range values, and use `pointInPolygon` for an optional interior ROI. Build a 1001-bin histogram in one image pass, then compute all candidate fractions by reverse cumulative sum; do not rescan full-resolution pixels 1001 times.

- [ ] **Step 4: Add overlay/mask tests and implement the binary output**

```js
test("writes a 255/0 PNG mask without changing dimensions", async () => {
  await writeThresholdMaskPng(outputPath, { probabilityMap: fixtureMap(), threshold: 0.5 });
  const { data, info } = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 3, height: 2, channels: 1 });
  expect([...data]).toEqual([0, 255, 255, 0, 255, 255]);
});
```

Render overlay as a transparent RGBA PNG where foreground uses a stable, high-contrast red and background alpha is zero. Use Sharp for the final PNG buffer and file write.

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `npx vitest run --exclude '.worktrees/**' server/probabilityMap.test.js`

Expected: PASS with parser rejection, threshold, ROI, overlay, and PNG assertions green.

- [ ] **Step 6: Commit the primitive module**

```bash
git add server/probabilityMap.js server/probabilityMap.test.js
git commit -m "feat: add probability map primitives"
```

### Task 2: Make image-only roots available without changing editor image identity

**Files:**
- Modify: `server/storage.js:13-111,151-181`
- Modify: `server/storage.test.js:12-110`

**Interfaces:**
- Produces root scans that require a timestamp `image/` directory containing a TIFF, not a pre-existing `mask/` directory.
- Consumed by `server/inferenceService.js` and existing editor routes.

- [ ] **Step 1: Write failing storage tests**

```js
test("scans an image-only timestamp folder before any mask exists", async () => {
  await mkdir(path.join(rootDir, "T01", "image"), { recursive: true });
  await writeFile(path.join(rootDir, "T01", "image", "frame.tif"), "tiff placeholder");
  await expect(createStorage({ initialRoot: rootDir }).scanImages()).resolves.toMatchObject([
    { id: "T01", imageFile: "frame.tif" },
  ]);
});

```

- [ ] **Step 2: Run the focused storage test to verify it fails**

Run: `npx vitest run --exclude '.worktrees/**' server/storage.test.js`

Expected: FAIL because the current scan excludes an image-only folder.

- [ ] **Step 3: Implement the minimal storage change**

```js
const imageDir = path.join(folderPath, "image");
if (!existsSync(imageDir) || !statSync(imageDir).isDirectory()) return [];

```

Keep `maskDir` in the returned private paths. Do not create folders merely by scanning. Do not expand the editor's public image DTO into multiple rows when a timestamp contains multiple TIFFs; Task 3 owns per-file inference discovery.

- [ ] **Step 4: Run storage and existing analysis tests**

Run: `npx vitest run --exclude '.worktrees/**' server/storage.test.js server/analysisService.test.js`

Expected: PASS; tests that describe the old image-and-mask requirement are updated to describe image-only roots, while missing masks are still reported by analysis services.

- [ ] **Step 5: Commit the storage contract**

```bash
git add server/storage.js server/storage.test.js
git commit -m "feat: allow image-only inference roots"
```

### Task 3: Build the sequential inference and threshold service

**Files:**
- Create: `server/inferenceService.js`
- Create: `server/inferenceService.test.js`

**Interfaces:**
- Produces `createInferenceService({ storage, fetchImpl, maxImagePixels })` and independent `scanInferenceImages(rootPath)` rows keyed by base64url-encoded `[timestampFolder, imageFile]`.
- Exposes `listImages()`, `startJob({ serverUrl })`, `getJob(jobId)`, `loadReview(id)`, `saveThreshold(id, { threshold, referenceId?, targetAreaFraction?, roiGroupId? })`, `applyReferenceThresholds({ referenceId, roiGroupId? })`, `createOverlay(id, { threshold })`, and `generateMasks()`.
- Uses Task 1 functions and Task 2 root path access.
- Consumed by routes in Task 4.

- [ ] **Step 1: Write failing service tests with an injected model response**

```js
test("runs image requests serially and saves each returned NPY under probability-maps", async () => {
  const calls = [];
  const service = createInferenceService({ storage, fetchImpl: vi.fn(async () => {
    calls.push("request");
    return new Response(npyFixture({ width: 2, height: 2, values: [0, 0.5, 0.75, 1] }), {
      headers: { "content-type": "application/x-npy" },
    });
  }) });
  const job = service.startJob({ serverUrl: "http://model:8080" });
  await waitForJob(service, job.id);
  expect(calls).toHaveLength(2);
  expect((await service.listImages()).map((image) => image.status)).toEqual(["complete", "complete"]);
});

test("discovers every TIFF in one timestamp as independently reviewable sources", async () => {
  await writeTiff(path.join(rootDir, "T01", "image", "a.tif"));
  await writeTiff(path.join(rootDir, "T01", "image", "b.tiff"));
  const rows = await service.listImages();
  expect(rows.filter((row) => row.timestampFolder === "T01").map((row) => row.imageFile)).toEqual(["a.tif", "b.tiff"]);
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
});

test("keeps a manually edited threshold after reference propagation", async () => {
  await service.saveThreshold("T02", { threshold: 0.723 });
  await service.applyReferenceThresholds({ referenceId: "T01" });
  await service.saveThreshold("T02", { threshold: 0.811 });
  expect((await service.loadReview("T02")).threshold).toBe(0.811);
});
```

- [ ] **Step 2: Run the service test to verify it fails**

Run: `npx vitest run --exclude '.worktrees/**' server/inferenceService.test.js`

Expected: FAIL because `server/inferenceService.js` does not exist.

- [ ] **Step 3: Implement scan, safe persistence, and sequential model jobs**

```js
async function requestProbabilityMap(image, serverUrl) {
  const bytes = await readFile(image.imagePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/tiff" }), image.imageFile);
  const response = await fetchImpl(new URL("/v1/inference/probability-map", normalizedServerUrl), {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new InferenceError("MODEL_REQUEST_FAILED", "Model inference failed.", { status: 502 });
  return parseProbabilityNpy(Buffer.from(await response.arrayBuffer()));
}
```

`scanInferenceImages(rootPath)` reads every sorted TIFF in every sorted timestamp `image/` directory and returns records containing a stable opaque ID, timestamp folder, image filename, source path, `probability-maps` directory, map path, settings path, and mask output path. Maintain an in-memory `Map` of jobs with per-source Waiting/Sending/Complete/Failed state, but derive Complete from valid on-disk maps when `listImages()` is called after restart. Start one asynchronous job at a time; catch each source error, record a safe message, then continue. Atomically write returned `.npy` bytes only after parser validation and matching source dimensions. Persist settings JSON atomically with a default threshold of `0.5` when none exists.

- [ ] **Step 4: Implement ROI-aware review, explicit propagation, and generation**

```js
async function applyReferenceThresholds({ referenceId, roiGroupId = null }) {
  const reference = await loadReview(referenceId);
  const target = probabilityMetrics({ probabilityMap: reference.map, threshold: reference.threshold, polygon: reference.polygon }).areaFraction;
  for (const image of await completeImages()) {
    if (image.id === referenceId) continue;
    const polygon = roiGroupId ? await polygonForTimestamp(image.timestampFolder, roiGroupId, image.width, image.height) : null;
    const { threshold } = closestThreshold({ probabilityMap: await loadMap(image.id), targetFraction: target, polygon });
    await saveThreshold(image.id, { threshold, referenceId, targetAreaFraction: target, roiGroupId: polygon ? roiGroupId : null });
  }
}
```

Use a selected group only when it exists, is a valid polygon, and dimensions match the current map; otherwise use whole image for that destination source. `loadReview` returns whole-image metrics, optional ROI metrics, current saved threshold, valid selectable groups, and source dimensions. `generateMasks` processes every complete source TIFF with its current persisted threshold and returns completed/failed counts without changing probability maps.

- [ ] **Step 5: Run service tests to verify success and failures**

Run: `npx vitest run --exclude '.worktrees/**' server/inferenceService.test.js server/probabilityMap.test.js`

Expected: PASS for serial request ordering, HTTP/map validation failures, restart scan, manual settings, explicit reference propagation, ROI fallback, overlay, and generated PNG files.

- [ ] **Step 6: Commit the inference service**

```bash
git add server/inferenceService.js server/inferenceService.test.js
git commit -m "feat: add sequential inference mask service"
```

### Task 4: Expose a safe HTTP contract and deep-link page route

**Files:**
- Modify: `server/app.js:1-360`
- Modify: `server/app.test.js:1-1360`

**Interfaces:**
- `GET /api/inference/images` returns root and one status row for every source TIFF.
- `POST /api/inference/root` and `POST /api/inference/root/select` reuse the existing root setters/picker.
- `POST /api/inference/jobs` starts `{ serverUrl }`; `GET /api/inference/jobs/:jobId` returns progress.
- `GET /api/inference/images/:id/review?roiGroupId=` returns threshold and area fractions.
- `PUT /api/inference/images/:id/threshold` saves one threshold.
- `GET /api/inference/images/:id/overlay?threshold=` returns PNG.
- `POST /api/inference/reference-thresholds` propagates from an explicit reference.
- `POST /api/inference/generate-masks` writes all reviewed masks.
- `/inferencePage` returns the built Vite index like `/`.

- [ ] **Step 1: Write failing app route tests**

```js
test("starts a model job and exposes sending then complete inference rows", async () => {
  const app = createApp({ rootDir: appRoot, initialRoot: imageRoot, fetchImpl });
  const start = await jsonRequest(app, "/api/inference/jobs", { method: "POST", body: { serverUrl: "http://model:8080" } });
  expect(start.status).toBe(202);
  const job = await waitForInferenceJob(app, (await start.json()).job.id);
  expect(job.images.every((image) => image.status === "complete")).toBe(true);
});

test("serves the built SPA entry for /inferencePage", async () => {
  const response = await request(createApp({ rootDir: appRoot }), "/inferencePage");
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toContain("Built app");
});
```

- [ ] **Step 2: Run route tests to verify they fail**

Run: `npx vitest run --exclude '.worktrees/**' server/app.test.js`

Expected: FAIL with missing inference endpoints and a 404 for `/inferencePage`.

- [ ] **Step 3: Wire service construction, validation, and routes**

```js
const inferenceService = createInferenceService({ storage: imageStorage, fetchImpl, maxImagePixels });

app.post("/api/inference/jobs", asyncRoute(async (request, response) => {
  response.status(202).json({ job: inferenceService.startJob({ serverUrl: request.body?.serverUrl }) });
}));
app.put("/api/inference/images/:id/threshold", asyncRoute(async (request, response) => {
  response.json(await inferenceService.saveThreshold(request.params.id, request.body));
}));
```

Inject `fetchImpl = globalThis.fetch` through `createApp` for testability. Extend `safeErrorResponse` with stable inference codes: invalid server URL/threshold/ROI, missing/invalid probability map, model request failure, and mask write failure. Do not reveal source paths or model response bodies in error messages. Make the static fallback `app.get("*", ...)` only after all `/api` routes, preserving the current static file middleware.

- [ ] **Step 4: Run API tests to verify behavior**

Run: `npx vitest run --exclude '.worktrees/**' server/app.test.js server/inferenceService.test.js`

Expected: PASS for root/picker reuse, job polling, review metrics, overlay image headers, threshold persistence, propagation, generation, invalid request validation, and deep-link fallback.

- [ ] **Step 5: Commit the API layer**

```bash
git add server/app.js server/app.test.js
git commit -m "feat: expose inference mask APIs"
```

### Task 5: Add client route and inference review UI

**Files:**
- Create: `src/AppRouter.jsx`
- Create: `src/InferencePage.jsx`
- Create: `src/InferencePage.test.jsx`
- Modify: `src/main.jsx:1-10`

**Interfaces:**
- `AppRouter` renders `InferencePage` only for pathname `/inferencePage`, otherwise renders existing `App`.
- `InferencePage` calls the Task 4 API contract and renders status list, original canvas, binary overlay, metrics, reference action, navigation, and generate action.
- Uses `renderRaw16ToCanvas` from `src/lib/raw16Renderer.js`.

- [ ] **Step 1: Write failing route and review interaction tests**

```jsx
test("shows the selected completed image at threshold 0.5 and reports whole plus ROI area fraction", async () => {
  render(<InferencePage />);
  expect(await screen.findByDisplayValue("0.500")).toBeInTheDocument();
  expect(screen.getByText("Whole image area fraction")).toBeInTheDocument();
  expect(screen.getByText("ROI area fraction")).toBeInTheDocument();
});

test("does not call reference propagation while threshold is edited", async () => {
  render(<InferencePage />);
  await userEvent.clear(await screen.findByLabelText("Threshold"));
  await userEvent.type(screen.getByLabelText("Threshold"), "0.723");
  expect(fetch).not.toHaveBeenCalledWith("/api/inference/reference-thresholds", expect.anything());
  await userEvent.click(screen.getByRole("button", { name: "Set other thresholds from reference" }));
  expect(fetch).toHaveBeenCalledWith("/api/inference/reference-thresholds", expect.anything());
});
```

- [ ] **Step 2: Run client tests to verify they fail**

Run: `npx vitest run --exclude '.worktrees/**' src/InferencePage.test.jsx`

Expected: FAIL because no inference page or route component exists.

- [ ] **Step 3: Implement route selection and page data loading**

```jsx
export default function AppRouter() {
  return window.location.pathname === "/inferencePage" ? <InferencePage /> : <App />;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode><AppRouter /></React.StrictMode>,
);
```

On mount load `/api/inference/images`, hydrate the root field/list, and select the first Complete row. Fetch raw16 image bytes exactly as `App.jsx` does, render with `renderRaw16ToCanvas`, fetch review metrics on selected image/ROI/threshold changes, and set the mask overlay image URL with a threshold query. Revoke any object URLs made for binary fetches during cleanup.

- [ ] **Step 4: Implement explicit controls and durable UI states**

```jsx
<button type="button" onClick={handleSetOtherThresholds} disabled={!activeCompleteImage || propagating}>
  Set other thresholds from reference
</button>
<button type="button" onClick={handleGenerateMasks} disabled={!completeImages.length || generating}>
  Generate masks
</button>
```

Use a numeric threshold field constrained to `0..1` with `0.001` step; on committed change, PUT only the active source TIFF's threshold and reload its review. The reference action posts the selected source TIFF and chosen ROI group (or no group) once. Poll jobs while any row is Sending and stop polling when complete/failed. Previous/next buttons navigate Complete source TIFFs only. Put no point-placement, ROI editing, or analysis controls on this page; show a read-only selectable saved ROI group only when valid groups exist.

- [ ] **Step 5: Run client tests and the legacy App tests**

Run: `npx vitest run --exclude '.worktrees/**' src/InferencePage.test.jsx src/App.test.jsx`

Expected: PASS for root setting, status rendering, server job start/poll state, threshold save, no implicit propagation, explicit propagation, individual override, left/right navigation, mask generation result, and the unchanged editor test suite.

- [ ] **Step 6: Commit the client page**

```bash
git add src/AppRouter.jsx src/InferencePage.jsx src/InferencePage.test.jsx src/main.jsx
git commit -m "feat: add inference mask setting page"
```

### Task 6: Polish the inference-specific layout and verify the complete flow

**Files:**
- Modify: `src/styles.css`
- Modify: `README.md`
- Test: `src/InferencePage.test.jsx`, `server/app.test.js`, full suite

**Interfaces:**
- Produces responsive, page-scoped `inference-*` classes without changing legacy editor layout classes.
- Documents the server endpoint contract and direct route `/inferencePage`.

- [ ] **Step 1: Write failing presentation assertions**

```jsx
test("uses an independent inference layout with status list and review stage", async () => {
  render(<InferencePage />);
  expect(await screen.findByLabelText("Inference image list")).toHaveClass("inference-image-list");
  expect(screen.getByLabelText("Probability review stage")).toHaveClass("inference-stage");
});
```

- [ ] **Step 2: Run the focused client test to verify it fails**

Run: `npx vitest run --exclude '.worktrees/**' src/InferencePage.test.jsx`

Expected: FAIL until the named semantic regions and layout classes exist.

- [ ] **Step 3: Add scoped responsive styles and concise README instructions**

```css
.inference-page { min-height: 100vh; display: grid; grid-template-columns: 280px minmax(0, 1fr) 300px; }
.inference-stage { min-width: 0; display: grid; place-items: center; background: #090d12; }
@media (max-width: 900px) { .inference-page { grid-template-columns: 1fr; } }
```

Use compact operational controls, clear Waiting/Sending/Complete/Failed status chips, stable stage sizing, and a red transparent mask overlay. Keep labels visible and prevent controls from covering the threshold field. Add a README section that defines the multipart model request, `application/x-npy` response, required `[height, width] float32` layout, and the `npm start` plus `/inferencePage` launch URL.

- [ ] **Step 4: Run complete verification**

Run: `npm run build && npx vitest run --exclude '.worktrees/**'`

Expected: build succeeds and all existing plus inference tests pass.

- [ ] **Step 5: Manually verify the built deep link**

Run: `npm run server`

Open: `http://localhost:3000/inferencePage`

Expected: the inference page loads directly, while `http://localhost:3000/` still loads the existing polygon editor.

- [ ] **Step 6: Commit final documentation and styling**

```bash
git add src/styles.css README.md src/InferencePage.test.jsx
git commit -m "docs: describe inference mask workflow"
```

## Plan Self-Review

### Spec Coverage

- Image-only timestamp roots and sorted status rows: Tasks 2, 3, and 5.
- Server-configured sequential inference and durable `.npy` output: Tasks 1, 3, and 4.
- Threshold default, whole/ROI area fractions, and read-only ROI selection: Tasks 1, 3, 4, and 5.
- Explicit reference fixation and explicit batch propagation with manual overrides: Tasks 1, 3, 4, and 5.
- Left/right visual inspection with original/mask overlay: Task 5.
- Mask generation only after explicit command and source immutability: Tasks 1, 3, 4, and 5.
- Deep link, responsive UI, and integration verification: Tasks 4 and 6.

### Placeholder Scan

No `TODO`, `TBD`, vague test instruction, or undefined cross-task interface remains. Every code task has a concrete failing test, command, minimal implementation shape, verification command, and commit step.

### Type Consistency

All later tasks use the Task 1 `probabilityMap` `{ width, height, data: Float32Array }` contract and Task 3 service method names. API routes in Task 4 exactly map to Task 3 methods, while Task 5 calls those same routes.
