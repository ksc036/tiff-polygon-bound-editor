# Mask Density Heatmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Precompute mask Pixel Density grids for selected folder trees and add current, estimated-density, and previous-image-difference heatmap overlays to the existing editor.

**Architecture:** A pure server grid module calculates JSON-ready cells, while a service discovers image bundles, selects masks, writes size-specific JSON atomically, and loads saved heatmaps. The Express app exposes folder selection, batch generation, and per-image loading; pure client helpers handle calibration, compatibility, differences, and color mapping; a focused React overlay component renders the grid while `App` owns persistence, fetching, and controls.

**Tech Stack:** Node.js ESM, Express 4, Sharp, React 18, SVG overlays, CSS, Vitest, Testing Library.

## Global Constraints

- Heatmap size means square pixel cell size; defaults are Small `5x5 px`, Medium `10x10 px`, and Large `20x20 px`.
- Editable preset values persist in `localStorage` and drive both generation folder names and viewer requests.
- Include partial right and bottom edge cells using their actual area; rectangular images must preserve row/column orientation.
- Save JSON only under sibling `heatmap/<size>x<size>/<imageFolder>.heatmap.json`; do not save rendered PNGs or difference files.
- Pixel Density is `maskPixelCount / areaPx`; Estimated Collagen Density is client-only `x = (y - b) / a` with existing defaults `a = 0.069676956982087`, `b = 0.067893820336777`, unit `mg/ml`.
- Current Pixel Density uses fixed `inferno` range `0..1`; current Estimated Collagen Density uses fixed `inferno` display range `0..3 mg/ml`.
- Previous comparison means the immediately previous image in the app's existing natural sort order; signed differences use a symmetric blue-white-red scale centered at zero.
- The first image has no Compare Previous action. Missing, stale, malformed, or incompatible previous data must not hide the current heatmap.
- Reuse the existing selected-mask interpretation, safe public errors, atomic persistence pattern, stage content rectangle, and visual design system.
- Heatmap work must not alter bounds, ROI calculations, skeleton orientation metrics, group visibility, or existing Origin, Mask, and Fiber QC behavior.

---

### Task 1: Pure Mask Grid Calculation and Validation

**Files:**
- Create: `server/maskHeatmap.js`
- Create: `server/maskHeatmap.test.js`

**Interfaces:**
- Consumes: binary mask objects shaped as `{ data: Uint8Array, width: number, height: number }` from `readBinaryMask`.
- Produces: `validateCellSize(value)`, `buildMaskHeatmapGrid({ mask, cellSize })`, `createHeatmapPayload({ imageFolder, maskSource, mask, cellSize, updatedAt })`, and `validateHeatmapPayload(payload, { cellSize })`.

- [ ] **Step 1: Write failing calculation tests**

```js
import { describe, expect, test } from "vitest";
import {
  buildMaskHeatmapGrid,
  createHeatmapPayload,
  validateCellSize,
  validateHeatmapPayload,
} from "./maskHeatmap.js";

test("includes partial right and bottom cells using actual area", () => {
  const mask = { width: 5, height: 3, data: new Uint8Array(15) };
  mask.data[0] = 1;
  mask.data[4] = 1;
  mask.data[14] = 1;

  const grid = buildMaskHeatmapGrid({ mask, cellSize: 2 });

  expect({ columns: grid.columns, rows: grid.rows }).toEqual({ columns: 3, rows: 2 });
  expect(grid.cells.find((cell) => cell.row === 0 && cell.column === 2)).toMatchObject({
    x: 4,
    y: 0,
    width: 1,
    height: 2,
    areaPx: 2,
    maskPixelCount: 1,
    pixelDensity: 0.5,
  });
  expect(grid.cells.at(-1)).toMatchObject({ width: 1, height: 1, areaPx: 1, pixelDensity: 1 });
});

test("keeps rectangular masks in row-major order", () => {
  const mask = { width: 6, height: 2, data: new Uint8Array(12) };
  mask.data[5] = 1;
  expect(buildMaskHeatmapGrid({ mask, cellSize: 2 }).cells.map((cell) => cell.pixelDensity)).toEqual([
    0,
    0,
    0.25,
  ]);
});

test("rejects invalid cell sizes and malformed saved payloads", () => {
  expect(() => validateCellSize(0)).toThrow("cell size");
  expect(() => validateCellSize(2.5)).toThrow("cell size");
  expect(() => validateHeatmapPayload({ schemaVersion: 1, cells: [] }, { cellSize: 5 })).toThrow(
    "heatmap",
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run server/maskHeatmap.test.js`

Expected: FAIL because `server/maskHeatmap.js` does not exist.

- [ ] **Step 3: Implement the minimal pure module**

```js
const SCHEMA_VERSION = 1;
const MAX_CELL_SIZE = 4096;

export function validateCellSize(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CELL_SIZE) {
    throw new Error("Heatmap cell size must be a positive integer no greater than 4096.");
  }
  return parsed;
}

export function buildMaskHeatmapGrid({ mask, cellSize }) {
  const size = validateCellSize(cellSize);
  const columns = Math.ceil(mask.width / size);
  const rows = Math.ceil(mask.height / size);
  const cells = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * size;
      const y = row * size;
      const width = Math.min(size, mask.width - x);
      const height = Math.min(size, mask.height - y);
      let maskPixelCount = 0;
      for (let cellY = y; cellY < y + height; cellY += 1) {
        for (let cellX = x; cellX < x + width; cellX += 1) {
          maskPixelCount += mask.data[cellY * mask.width + cellX] ? 1 : 0;
        }
      }
      const areaPx = width * height;
      cells.push({ row, column, x, y, width, height, areaPx, maskPixelCount, pixelDensity: maskPixelCount / areaPx });
    }
  }

  return { width: mask.width, height: mask.height, cellWidth: size, cellHeight: size, columns, rows, cells };
}
```

Complete `createHeatmapPayload` with `schemaVersion: 1`, source metadata, grid fields, and ISO `updatedAt`. Implement strict DTO validation for dimensions, cell coordinates, counts, density range, and expected cell size without accepting absolute paths.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run server/maskHeatmap.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add server/maskHeatmap.js server/maskHeatmap.test.js
git commit -m "feat: calculate mask density heatmap grids"
```

### Task 2: Recursive Batch Generation and Saved Heatmap Loading

**Files:**
- Create: `server/heatmapService.js`
- Create: `server/heatmapService.test.js`
- Modify: `server/storage.js:144-163`

**Interfaces:**
- Consumes: Task 1 exports, `readBinaryMask(maskPath, options)`, `selectMaskSource(image, maskDir)`, and storage `imagePaths(id)`.
- Produces: `HeatmapError`, `discoverHeatmapBundles(rootPath)`, `generateHeatmapBatch({ rootPath, cellSizes, maxImagePixels })`, and `loadImageHeatmap(storage, id, cellSize)`.

- [ ] **Step 1: Write failing service tests**

```js
test("recursively writes each unique preset beside image and mask folders", async () => {
  await writeBundle(rootDir, "experiment/day-1/sample-a", { width: 5, height: 3 });

  const result = await generateHeatmapBatch({ rootPath: rootDir, cellSizes: [5, 10, 20, 5] });

  expect(result).toMatchObject({ discovered: 1, completed: 1, skipped: 0, failed: 0, generatedFiles: 3 });
  for (const size of [5, 10, 20]) {
    const saved = JSON.parse(
      await readFile(path.join(rootDir, "experiment/day-1/sample-a", "heatmap", `${size}x${size}`, "sample-a.heatmap.json")),
    );
    expect(saved).toMatchObject({ imageFolder: "sample-a", cellWidth: size, cellHeight: size });
  }
});

test("continues after an unreadable bundle and returns relative failures", async () => {
  await writeBundle(rootDir, "good", { width: 2, height: 2 });
  await writeUnreadableBundle(rootDir, "bad");
  const result = await generateHeatmapBatch({ rootPath: rootDir, cellSizes: [5] });
  expect(result.completed).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.failures[0].imageFolder).toBe("bad");
  expect(JSON.stringify(result)).not.toContain(rootDir);
});

test("loads current image heatmaps and rejects stale mask metadata", async () => {
  const storage = await setupStorageWithSavedHeatmap();
  await expect(loadImageHeatmap(storage, "sample-a", 5)).resolves.toMatchObject({ cellWidth: 5 });
  await touchMask(storage.imagePaths("sample-a").maskDir);
  await expect(loadImageHeatmap(storage, "sample-a", 5)).rejects.toMatchObject({ code: "STALE_HEATMAP" });
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run: `npx vitest run server/heatmapService.test.js`

Expected: FAIL because `server/heatmapService.js` does not exist.

- [ ] **Step 3: Implement recursive discovery and atomic persistence**

```js
export async function discoverHeatmapBundles(rootPath) {
  const bundles = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    if (names.has("image") && names.has("mask")) {
      bundles.push({ imageFolder: path.basename(directory), folderPath: directory, maskDir: path.join(directory, "mask") });
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => visit(path.join(directory, entry.name))));
  }
  await visit(validateBatchRoot(rootPath));
  return bundles.sort((left, right) => left.folderPath.localeCompare(right.folderPath, undefined, { numeric: true }));
}
```

For each bundle, use the existing `selectMaskSource` rule, `readBinaryMask`, and `stat` metadata. Deduplicate validated sizes, create `<bundle>/heatmap/<size>x<size>/`, write `.<uuid>.tmp`, then `rename`. Remove a failed temporary file before reporting the bundle failure. Extend `storage.imagePaths` with `heatmapDir: path.join(image.folderPath, "heatmap")` for viewer loading.

`loadImageHeatmap` must validate the saved DTO, compare the selected mask's basename, size, and `mtimeMs`, return public JSON only, and throw `HeatmapError` codes `MISSING_HEATMAP`, `INVALID_HEATMAP`, or `STALE_HEATMAP` with safe statuses.

- [ ] **Step 4: Run service and storage tests and verify GREEN**

Run: `npx vitest run server/heatmapService.test.js server/storage.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add server/heatmapService.js server/heatmapService.test.js server/storage.js
git commit -m "feat: generate heatmaps recursively"
```

### Task 3: Heatmap HTTP API and Finder Selection

**Files:**
- Modify: `server/app.js:1-360`
- Modify: `server/app.test.js:1-780`
- Modify: `server/index.js:9-33`

**Interfaces:**
- Consumes: `generateHeatmapBatch`, `loadImageHeatmap`, and a new optional `selectHeatmapRoot` callback in `createApp`.
- Produces: `POST /api/heatmaps/select-folder`, `POST /api/heatmaps/generate`, and `GET /api/images/:id/heatmap?cellSize=<integer>`.

- [ ] **Step 1: Write failing API tests**

```js
test("selects a heatmap folder without changing the image root", async () => {
  const app = createApp({
    rootDir: appRoot,
    initialRoot: imageRoot,
    selectHeatmapRoot: async () => batchRoot,
  });
  const response = await jsonRequest(app, "/api/heatmaps/select-folder", { method: "POST" });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ rootPath: batchRoot });
  expect((await (await request(app, "/api/root")).json()).rootPath).toBe(imageRoot);
});

test("generates requested preset sizes and returns a safe summary", async () => {
  const response = await jsonRequest(createApp({ rootDir: appRoot }), "/api/heatmaps/generate", {
    method: "POST",
    body: { rootPath: batchRoot, cellSizes: [5, 10, 20] },
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ completed: 1, generatedFiles: 3 });
});

test("loads one saved image heatmap by cell size", async () => {
  const response = await request(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/images/sample-a/heatmap?cellSize=10");
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ heatmap: { cellWidth: 10 } });
});
```

Also assert 400 for missing/invalid sizes, 404 for missing saved data, 409 for stale data, 422 for malformed JSON, cancellation-safe folder errors, and no absolute paths in errors.

- [ ] **Step 2: Run API tests and verify RED**

Run: `npx vitest run server/app.test.js`

Expected: FAIL with 404 responses for new routes.

- [ ] **Step 3: Add routes and safe error mapping**

```js
app.post("/api/heatmaps/select-folder", asyncRoute(async (_request, response) => {
  try {
    response.json({ rootPath: await selectHeatmapRoot() });
  } catch {
    response.status(400).json({ error: "Heatmap folder selection was cancelled or failed." });
  }
}));

app.post("/api/heatmaps/generate", asyncRoute(async (request, response) => {
  response.json(await generateHeatmapBatch({
    rootPath: request.body?.rootPath,
    cellSizes: request.body?.cellSizes,
    maxImagePixels,
  }));
}));

app.get("/api/images/:id/heatmap", asyncRoute(async (request, response) => {
  response.json({ heatmap: await loadImageHeatmap(imageStorage, request.params.id, request.query.cellSize) });
}));
```

Update `chooseFolderWithAppleScript(prompt)` to accept a prompt string. Pass a dedicated `selectHeatmapRoot` callback from `startServer` with `Choose heatmap batch folder`, while preserving the existing root callback and prompt.

- [ ] **Step 4: Run server tests and verify GREEN**

Run: `npx vitest run server/app.test.js server/heatmapService.test.js server/maskHeatmap.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add server/app.js server/app.test.js server/index.js
git commit -m "feat: expose heatmap batch APIs"
```

### Task 4: Client Heatmap Math, Colors, and Comparison

**Files:**
- Create: `src/lib/heatmap.js`
- Create: `src/lib/heatmap.test.js`

**Interfaces:**
- Consumes: public heatmap JSON and calibration `{ slope: string | number, intercept: string | number }`.
- Produces: `estimateHeatmapCollagenDensity`, `heatmapMetricValue`, `heatmapCompatibilityError`, `buildHeatmapDifference`, `heatmapDisplayRange`, `infernoColor`, `differenceColor`, and `heatmapCellAtPoint`.

- [ ] **Step 1: Write failing client math tests**

```js
test("uses the existing calibration formula", () => {
  expect(estimateHeatmapCollagenDensity(0.2, { slope: 0.1, intercept: 0.05 })).toBeCloseTo(1.5);
});

test("calculates signed previous-image changes without rescaling values", () => {
  const current = heatmapWithDensities([0.2, 0.1]);
  const previous = heatmapWithDensities([0.05, 0.3]);
  expect(buildHeatmapDifference({ current, previous, metric: "pixel-density", calibration })).toMatchObject({
    currentValues: [0.2, 0.1],
    previousValues: [0.05, 0.3],
    values: [0.15, -0.2],
    maxAbs: 0.2,
  });
});

test("rejects incompatible dimensions and cell sizes", () => {
  expect(heatmapCompatibilityError(heatmap({ width: 10 }), heatmap({ width: 11 }))).toMatch(/dimensions/i);
  expect(heatmapCompatibilityError(heatmap({ cellWidth: 5 }), heatmap({ cellWidth: 10 }))).toMatch(/cell size/i);
});

test("uses inferno and zero-centered diverging endpoints", () => {
  expect(infernoColor(0, 0, 1)).toBe("#000004");
  expect(infernoColor(1, 0, 1)).toBe("#fcffa4");
  expect(differenceColor(-1, 1)).toBe("#2563eb");
  expect(differenceColor(0, 1)).toBe("#f8fafc");
  expect(differenceColor(1, 1)).toBe("#dc2626");
});
```

- [ ] **Step 2: Run focused client tests and verify RED**

Run: `npx vitest run src/lib/heatmap.test.js`

Expected: FAIL because `src/lib/heatmap.js` does not exist.

- [ ] **Step 3: Implement calibration, compatibility, differences, and color interpolation**

Use fixed inferno stops:

```js
const INFERNO_STOPS = [
  [0, "#000004"],
  [0.25, "#57106e"],
  [0.5, "#bc3754"],
  [0.75, "#f98e09"],
  [1, "#fcffa4"],
];
```

`heatmapDisplayRange("pixel-density")` returns `{ min: 0, max: 1, unit: "" }`; estimated current mode returns `{ min: 0, max: 3, unit: "mg/ml" }`. `buildHeatmapDifference` returns `{ currentValues, previousValues, values, maxAbs }` in cell order. Clamp color interpolation only, never metric or hover values. Compatibility checks exact width, height, cellWidth, cellHeight, rows, columns, and cell count. `heatmapCellAtPoint` resolves row/column from image coordinates and handles partial edge cells.

- [ ] **Step 4: Run focused client tests and verify GREEN**

Run: `npx vitest run src/lib/heatmap.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/lib/heatmap.js src/lib/heatmap.test.js
git commit -m "feat: add heatmap display calculations"
```

### Task 5: Heatmap Viewer, Batch Controls, Persistence, and Visual Verification

**Files:**
- Create: `src/components/HeatmapOverlay.jsx`
- Create: `src/components/HeatmapOverlay.test.jsx`
- Modify: `src/App.jsx:1-1800`
- Modify: `src/App.test.jsx:1-1100`
- Modify: `src/styles.css:264-930`

**Interfaces:**
- Consumes: Task 3 API routes and Task 4 client helpers.
- Produces: a `Heat Map` layer, editable/persisted presets, metric/current-comparison/opacity controls, hover values, color legend, Finder batch panel, and batch summary.

- [ ] **Step 1: Extend the mock API and write failing viewer tests**

Add heatmap fixtures for both images and mock:

```js
if (url === "/api/images/scan-a/heatmap?cellSize=5") {
  return jsonResponse({ heatmap: heatmapA5 });
}
if (url === "/api/images/scan-b/heatmap?cellSize=5") {
  return jsonResponse({ heatmap: heatmapB5 });
}
if (url === "/api/heatmaps/select-folder" && method === "POST") {
  return jsonResponse({ rootPath: "/selected/heatmap-root" });
}
if (url === "/api/heatmaps/generate" && method === "POST") {
  return jsonResponse({ discovered: 2, completed: 2, skipped: 0, failed: 0, generatedFiles: 6, failures: [] });
}
```

Write tests that assert:

```js
test("opens the Heat Map layer with persisted default presets", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
  expect(screen.getByRole("button", { name: /Small 5x5/ })).toHaveAttribute("aria-pressed", "true");
  expect(await screen.findByLabelText("heatmap overlay")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Large 20x20/ }));
  expect(localStorage.getItem("raw16-editor-heatmap-selected-preset")).toBe("large");
});

test("keeps selected cell size when moving to the next image", async () => {
  const { fetchMock } = mockApi();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
  fireEvent.click(screen.getByRole("button", { name: /Large 20x20/ }));
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-b/heatmap?cellSize=20"),
  );
});

test("shows current and estimated metrics using current calibration", async () => {
  mockApi();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
  fireEvent.click(screen.getByRole("button", { name: "Estimated Collagen Density" }));
  expect(await screen.findByLabelText("heatmap color legend")).toHaveTextContent("0");
  expect(screen.getByLabelText("heatmap color legend")).toHaveTextContent("3 mg/ml");
});

test("offers previous comparison only after the first image", async () => {
  const { fetchMock } = mockApi();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
  expect(screen.queryByRole("button", { name: "Compare Previous" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  fireEvent.click(await screen.findByRole("button", { name: "Compare Previous" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-a/heatmap?cellSize=5"),
  );
  expect(await screen.findByText(/Compared with plate-a/)).toBeInTheDocument();
});

test("selects a separate batch folder and generates edited preset sizes", async () => {
  const { fetchMock } = mockApi();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Choose heatmap folder" }));
  const smallInput = screen.getByLabelText("small heatmap cell size");
  fireEvent.change(smallInput, { target: { value: "7" } });
  fireEvent.blur(smallInput);
  fireEvent.click(screen.getByRole("button", { name: "Generate Heatmaps" }));
  await waitFor(() => {
    const call = fetchMock.mock.calls.find(([url, options]) =>
      url === "/api/heatmaps/generate" && options?.method === "POST",
    );
    expect(JSON.parse(call[1].body)).toEqual({
      rootPath: "/selected/heatmap-root",
      cellSizes: [7, 10, 20],
    });
  });
});
```

In `src/components/HeatmapOverlay.test.jsx`, render the component with `pointer={{ x: 1, y: 1 }}` and assert the tooltip includes `Mask pixels 1 / 25`, `Pixel Density 0.0400`, the calibrated `Estimated Collagen Density`, and previous/current/delta values when `comparison` is present.

- [ ] **Step 2: Run the App test and verify RED**

Run: `npx vitest run src/App.test.jsx`

Expected: FAIL because Heat Map controls do not exist.

- [ ] **Step 3: Implement `HeatmapOverlay`**

```jsx
export default function HeatmapOverlay({ heatmap, metric, calibration, comparison, opacity, pointer }) {
  const hovered = heatmapCellAtPoint(heatmap, pointer);
  const hoveredIndex = hovered ? hovered.row * heatmap.columns + hovered.column : -1;
  const range = heatmapDisplayRange(metric);
  const hoveredEstimated = hovered
    ? estimateHeatmapCollagenDensity(hovered.pixelDensity, calibration)
    : null;
  return (
    <>
      <svg className="heatmap-overlay" aria-label="heatmap overlay" viewBox={`0 0 ${heatmap.width} ${heatmap.height}`}>
        {heatmap.cells.map((cell, index) => (
          <rect
            key={`${cell.row}-${cell.column}`}
            x={cell.x}
            y={cell.y}
            width={cell.width}
            height={cell.height}
            fill={comparison ? differenceColor(comparison.values[index], comparison.maxAbs) : infernoColor(heatmapMetricValue(cell, metric, calibration), range.min, range.max)}
            fillOpacity={opacity}
          />
        ))}
      </svg>
      {hovered ? (
        <div className="heatmap-tooltip" role="status">
          <strong>{`Row ${hovered.row + 1}, Column ${hovered.column + 1}`}</strong>
          <span>{`Mask pixels ${hovered.maskPixelCount} / ${hovered.areaPx}`}</span>
          <span>{`Pixel Density ${hovered.pixelDensity.toFixed(4)}`}</span>
          <span>{`Estimated Collagen Density ${hoveredEstimated.toFixed(4)} mg/ml`}</span>
          {comparison ? (
            <span>
              {`Previous ${comparison.previousValues[hoveredIndex].toFixed(4)}, Current ${comparison.currentValues[hoveredIndex].toFixed(4)}, Change ${comparison.values[hoveredIndex].toFixed(4)}`}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
```

Render one rectangle per saved cell with no stroke or interpolation. Keep it below the existing editable boundary SVG, use `pointer-events: none`, and position hover information from image coordinates without changing stage geometry.

- [ ] **Step 4: Integrate heatmap state and contextual viewer controls in `App`**

Add validated localStorage-backed state:

```js
const DEFAULT_HEATMAP_PRESETS = { small: 5, medium: 10, large: 20 };
const [heatmapPresets, setHeatmapPresets] = useState(loadHeatmapPresets);
const [heatmapPreset, setHeatmapPreset] = useState(() => localStorage.getItem(HEATMAP_SELECTED_PRESET_KEY) ?? "small");
const [heatmapMetric, setHeatmapMetric] = useState(() => localStorage.getItem(HEATMAP_METRIC_KEY) ?? "pixel-density");
const [heatmapOpacity, setHeatmapOpacity] = useState(() => readStoredOpacity(HEATMAP_OPACITY_KEY, 0.62));
```

When `imageLayer === "heatmap"`, fetch current `/api/images/:id/heatmap?cellSize=<selected size>`. If comparison is active and `activeIndex > 0`, fetch the previous image's same size. Use the existing request-id pattern so navigation or preset changes ignore stale responses. Keep Original visible for Heat Map, unlike Mask and Fiber QC.

Add `Heat Map` beside existing layer buttons. Contextual controls include metric segmented control, Small/Medium/Large size segmented control, Compare Previous button only when `activeIndex > 0`, opacity range, loading/error text, and vertical legend. Invalid calibration leaves Pixel Density available and shows a concise Estimated error.

- [ ] **Step 5: Add Finder batch controls and persisted editable presets**

Add a compact `Heatmap batch` section in the scrolling side panel:

```jsx
<button type="button" onClick={handleSelectHeatmapFolder}>Choose Folder</button>
{Object.entries(heatmapPresets).map(([preset, value]) => (
  <input
    key={preset}
    aria-label={`${preset} heatmap cell size`}
    type="number"
    min="1"
    max="4096"
    value={value}
    onChange={(event) => updateHeatmapPreset(preset, event.target.value)}
    onBlur={() => commitHeatmapPreset(preset)}
  />
))}
<button type="button" disabled={!heatmapBatchRoot || heatmapBatchLoading} onClick={handleGenerateHeatmaps}>
  {heatmapBatchLoading ? "Generating..." : "Generate Heatmaps"}
</button>
```

Post `{ rootPath: heatmapBatchRoot, cellSizes: Object.values(heatmapPresets) }`. Show discovered, completed, skipped, failed, and generated-file counts after completion. Choosing this folder must not call `/api/root` or change current image/bounds/analysis.

- [ ] **Step 6: Style the overlay, controls, legend, tooltip, and states**

Extend the existing dark utilitarian system. Use an unframed SVG overlay, compact segmented controls, fixed-width color legend, and bounded tooltip. Do not add nested cards or change existing stage dimensions. Ensure `.raw-canvas` remains visible for `original` and `heatmap`, `.heatmap-overlay` fills the exact stage, and boundary/point editing stays above it.

- [ ] **Step 7: Run client tests and verify GREEN**

Run: `npx vitest run src/lib/heatmap.test.js src/App.test.jsx src/styles.test.js`

Expected: PASS without React warnings.

- [ ] **Step 8: Run full verification**

Run: `npx vitest run --exclude ".worktrees/**"`

Expected: all root project tests PASS.

Run: `npm run build`

Expected: Vite production build PASS.

Run: `git diff --check`

Expected: no output and exit 0.

- [ ] **Step 9: Visually verify in the browser**

Start or restart the server on an available local port. Verify Origin, Mask, Fiber QC, and Heat Map on a generated fixture or selected dataset. Check 5/10/20 size switching, Pixel/Estimated switching, previous comparison, hover, legend readability, batch panel, image navigation persistence, and constrained-height layout. Capture one desktop screenshot for the final report.

- [ ] **Step 10: Commit Task 5**

```bash
git add src/components/HeatmapOverlay.jsx src/components/HeatmapOverlay.test.jsx src/App.jsx src/App.test.jsx src/styles.css
git commit -m "feat: add interactive mask heatmap viewer"
```
