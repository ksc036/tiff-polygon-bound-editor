# Root Dataset ZIP Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the redundant saved-bound loader with a streamed dataset ZIP export containing source files, labeled ROI overviews, fixed-size absolute and previous-image heatmaps, and one linked Excel workbook per image.

**Architecture:** Pure shared helpers own ROI identifiers and analysis-row normalization so the editor, ROI renderer, and workbook cannot disagree. Focused server modules render heatmaps and ROI reports with Sharp, build workbooks with ExcelJS, and stream entries through Archiver without creating an export directory or buffering the complete ZIP. The React toolbar auto-saves dirty bounds, posts the active calibration, downloads the response, and displays the same ROI IDs and colors used in exported artifacts.

**Tech Stack:** Node.js ESM, Express 4, React 18, Sharp 0.35, Archiver 8, ExcelJS 4.4, SVG-to-PNG rendering, Vitest, Testing Library, Unzipper 0.12 for ZIP integration tests.

## Global Constraints

- Export every image returned by `storage.scanImages()` in its existing natural sort order.
- Preserve each image folder name below one `<root-name>_export/` archive directory.
- Include the original TIFF and selected source mask unchanged; do not create a plain origin PNG.
- Export one origin-plus-ROI overview and one workbook per image when source data permits.
- Export only saved Heatmaps with cell sizes `20x20`, `50x50`, and `100x100` source pixels.
- Render Pixel Density at `0..1` and Estimated Collagen Density at `0..3 mg/ml` with the existing Inferno palette.
- Render current-minus-previous comparisons for compatible adjacent images with one shared symmetric range per metric and cell size.
- Use group array order for `G01`, `G02`, and ROI suffixes `N`, `M`, `F`, `A`, and `I`.
- Auto-save only dirty bounds for the active image; never recalculate or overwrite analysis, masks, skeletons, or saved Heatmap JSON.
- Missing, stale, invalid, or incompatible artifacts skip only that artifact and are recorded in the image workbook.
- Never expose absolute host paths in ZIP entries, filenames, workbook cells, links, or public errors.
- Stream the ZIP response and stop rendering/archive work when the client disconnects.
- Keep current uncommitted changes in `src/styles.css` and `src/styles.test.js`; do not revert or overwrite their Compare Previous/Original opacity layout fix.

---

## File Map

- Create `shared/analysisRows.js`: canonical group IDs, ROI IDs, colors, distance labels, and normalized analysis rows.
- Create `shared/analysisRows.test.js`: identifier and inside/outside row contract tests.
- Create `server/exportHeatmaps.js`: fixed-size Heatmap loading plan, shared comparison ranges, SVG report layout, and PNG rendering.
- Create `server/exportHeatmaps.test.js`: absolute/comparison value, range, title, unit, and PNG tests.
- Create `server/exportRoiOverview.js`: normalized TIFF background, ROI fills/boundaries/labels, legend, and PNG rendering.
- Create `server/exportRoiOverview.test.js`: ROI label/legend/no-handle and image output tests.
- Create `server/exportWorkbook.js`: five-sheet per-image workbook and fallback text report.
- Create `server/exportWorkbook.test.js`: numeric cells, colors, links, filters, definitions, and report tests.
- Create `server/exportService.js`: source discovery, partial-success records, safe archive paths, and sequential ZIP streaming.
- Create `server/exportService.test.js`: archive layout, byte identity, fixed sizes, comparisons, skips, and path safety tests.
- Modify `server/app.js`: validate `POST /api/export`, set ZIP headers, and connect cancellation.
- Modify `server/app.test.js`: endpoint validation and streamed ZIP integration tests.
- Modify `package.json` and `package-lock.json`: add Archiver, ExcelJS, and test-only Unzipper.
- Modify `src/App.jsx`: remove saved-bound loader, add export download flow, consume canonical analysis rows, and show ROI IDs/colors.
- Modify `src/App.test.jsx`: toolbar, save-before-export, calibration, download, duplicate prevention, error, and ROI identity tests.
- Modify `src/styles.css`: export button state and compact ROI ID/swatch/overlay label styling while preserving existing edits.
- Modify `src/styles.test.js`: retain current layout assertions and add selectors required by the new UI.

---

### Task 1: Canonical ROI Identity and Analysis Rows

**Files:**
- Create: `shared/analysisRows.js`
- Create: `shared/analysisRows.test.js`

**Interfaces:**
- Consumes: saved bounds groups and analysis groups in existing storage order.
- Produces:
  - `groupDisplayId(groupIndex: number): string`
  - `roiDisplayId({ groupIndex, analysisMode, bandId }): string`
  - `buildAnalysisRows(analysis, bounds): AnalysisRow[]`
  - `AnalysisRow` fields `{ id, roiId, sourceGroupId, groupId, groupName, groupColor, analysisMode, modeLabel, bandId, bandLabel, fromPx, toPx, metrics }`, where `sourceGroupId` is the saved internal ID used by visibility maps and `groupId` is the displayed `Gxx` ID.

- [ ] **Step 1: Write the failing identity and row tests**

```js
import { describe, expect, test } from "vitest";
import { buildAnalysisRows, groupDisplayId, roiDisplayId } from "./analysisRows.js";

describe("ROI export identities", () => {
  test("uses stable zero-padded group order and mode suffixes", () => {
    expect(groupDisplayId(0)).toBe("G01");
    expect(groupDisplayId(11)).toBe("G12");
    expect(roiDisplayId({ groupIndex: 0, analysisMode: "outside", bandId: "near" })).toBe("G01-N");
    expect(roiDisplayId({ groupIndex: 0, analysisMode: "outside", bandId: "all" })).toBe("G01-A");
    expect(roiDisplayId({ groupIndex: 1, analysisMode: "inside", bandId: "inside" })).toBe("G02-I");
  });

  test("joins analysis groups to saved names, colors, and distance bands", () => {
    const bounds = {
      groups: [
        { id: "outer", name: "Cell edge", color: "#22c55e" },
        { id: "whole", name: "Whole image", color: "#ef4444", analysisMode: "inside" },
      ],
    };
    const analysis = {
      roiBands: [
        { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
        { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
        { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
      ],
      groups: [
        {
          groupId: "outer",
          groupName: "stale name",
          analysisMode: "outside",
          bands: { near: { roiAreaPx: 10 }, mid: { roiAreaPx: 20 }, far: { roiAreaPx: 30 } },
          allBands: { roiAreaPx: 60 },
        },
        { groupId: "whole", analysisMode: "inside", area: { roiAreaPx: 100 } },
      ],
    };

    expect(buildAnalysisRows(analysis, bounds)).toEqual([
      expect.objectContaining({
        roiId: "G01-N",
        sourceGroupId: "outer",
        groupId: "G01",
        groupName: "Cell edge",
        groupColor: "#22c55e",
        bandId: "near",
        fromPx: 0,
        toPx: 20,
      }),
      expect.objectContaining({ roiId: "G01-M", bandId: "mid" }),
      expect.objectContaining({ roiId: "G01-F", bandId: "far" }),
      expect.objectContaining({ roiId: "G01-A", bandId: "all", fromPx: 0, toPx: 100 }),
      expect.objectContaining({
        roiId: "G02-I",
        groupId: "G02",
        groupName: "Whole image",
        groupColor: "#ef4444",
        bandId: "inside",
      }),
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run shared/analysisRows.test.js`

Expected: FAIL because `shared/analysisRows.js` does not exist.

- [ ] **Step 3: Implement the canonical mapping**

```js
const ROI_SUFFIXES = Object.freeze({
  near: "N",
  mid: "M",
  far: "F",
  all: "A",
  inside: "I",
});

export function groupDisplayId(groupIndex) {
  if (!Number.isSafeInteger(groupIndex) || groupIndex < 0) {
    throw new TypeError("Group index must be a non-negative integer.");
  }
  return `G${String(groupIndex + 1).padStart(2, "0")}`;
}

export function roiDisplayId({ groupIndex, analysisMode, bandId }) {
  const normalizedBand = analysisMode === "inside" ? "inside" : bandId;
  const suffix = ROI_SUFFIXES[normalizedBand];
  if (!suffix) {
    throw new TypeError(`Unknown ROI band: ${normalizedBand}`);
  }
  return `${groupDisplayId(groupIndex)}-${suffix}`;
}
```

Implement `buildAnalysisRows` by indexing `bounds.groups` by saved `id`, iterating `analysis.groups`, and resolving each analysis group back to its saved index. Emit outside rows in exact `near`, `mid`, `far`, `all` order and inside rows as one `inside` row. Preserve the original ID as `sourceGroupId`; use bounds name/color first, analysis name second, and `#94a3b8` only when no saved color exists. For `all`, use the first band `fromPx` and last band `toPx`; for inside, keep both distances `null`. Ignore an analysis group that has no matching saved bounds group; `exportService` records that mismatch as a workbook warning.

- [ ] **Step 4: Run the focused test and full shared/client helper tests**

Run: `npx vitest run shared/analysisRows.test.js src/lib/heatmap.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add shared/analysisRows.js shared/analysisRows.test.js
git commit -m "feat: define canonical ROI export identities"
```

### Task 2: Fixed-Size Heatmap Export Planning and Rendering

**Files:**
- Create: `server/exportHeatmaps.js`
- Create: `server/exportHeatmaps.test.js`

**Interfaces:**
- Consumes:
  - `loadImageHeatmap(storage, imageId, cellSize)`
  - existing `heatmapMetricValue`, `heatmapCompatibilityError`, `buildHeatmapDifference`, `heatmapDisplayRange`, `infernoColor`, and `differenceColor` from `src/lib/heatmap.js`
  - calibration `{ slope: number, intercept: number }`.
- Produces:
  - `EXPORT_CELL_SIZES = [20, 50, 100]`
  - `EXPORT_METRICS = ["pixel-density", "estimated-collagen-density"]`
  - `collectSavedHeatmaps({ storage, images }): Promise<Map<string, HeatmapSourceRecord>>`
  - `planHeatmapFigures({ images, sources, calibration }): { figures, reportEntries }`
  - `buildHeatmapFigureSvg(figure): string`
  - `renderHeatmapFigure(figure): Promise<Buffer>`.

- [ ] **Step 1: Write failing planning and rendering tests**

```js
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import {
  EXPORT_CELL_SIZES,
  buildHeatmapFigureSvg,
  planHeatmapFigures,
  renderHeatmapFigure,
} from "./exportHeatmaps.js";

const calibration = { slope: 0.1, intercept: 0 };

function map(imageFolder, values, cellSize = 20) {
  return {
    imageFolder,
    width: 40,
    height: 20,
    cellWidth: cellSize,
    cellHeight: cellSize,
    columns: 2,
    rows: 1,
    cells: values.map((pixelDensity, column) => ({
      row: 0,
      column,
      x: column * cellSize,
      y: 0,
      width: cellSize,
      height: cellSize,
      areaPx: cellSize * cellSize,
      maskPixelCount: pixelDensity * cellSize * cellSize,
      pixelDensity,
    })),
  };
}

test("fixes export sizes and computes current-minus-previous shared ranges", () => {
  expect(EXPORT_CELL_SIZES).toEqual([20, 50, 100]);
  const images = [{ id: "T01", imageFolder: "T01" }, { id: "T02", imageFolder: "T02" }, { id: "T03", imageFolder: "T03" }];
  const sources = new Map([
    ["T01:20", { status: "Included", heatmap: map("T01", [0.1, 0.2]) }],
    ["T02:20", { status: "Included", heatmap: map("T02", [0.4, 0.1]) }],
    ["T03:20", { status: "Included", heatmap: map("T03", [0.6, 0.5]) }],
  ]);

  const plan = planHeatmapFigures({ images, sources, calibration });
  const pixelComparisons = plan.figures.filter(
    (figure) => figure.kind === "comparison" && figure.metric === "pixel-density",
  );

  expect(pixelComparisons.map((figure) => figure.values)).toEqual([[0.3, -0.1], [0.2, 0.4]]);
  expect(pixelComparisons.map((figure) => figure.colorRange)).toEqual([
    { min: -0.4, max: 0.4 },
    { min: -0.4, max: 0.4 },
  ]);
  expect(plan.figures.some((figure) => figure.currentImage === "T01" && figure.kind === "comparison")).toBe(false);
});

test("renders a report PNG with title, axes, range, unit, and color bar", async () => {
  const figure = {
    kind: "absolute",
    metric: "estimated-collagen-density",
    metricLabel: "Estimated Collagen Density",
    unit: "mg/ml",
    currentImage: "T01",
    previousImage: null,
    cellWidth: 20,
    cellHeight: 20,
    columns: 2,
    rows: 1,
    values: [1, 2],
    colorRange: { min: 0, max: 3 },
    calibration,
  };
  const svg = buildHeatmapFigureSvg(figure);
  expect(svg).toContain("T01 | Estimated Collagen Density | Cell 20x20 px | Grid 2x1");
  expect(svg).toContain("Calibration: Pixel Density = 0.1 * Collagen Density + 0");
  expect(svg).toContain("Grid X");
  expect(svg).toContain("Grid Y");
  expect(svg).toContain("Estimated Collagen Density (mg/ml)");
  expect(svg).toContain('data-role="color-bar"');

  const metadata = await sharp(await renderHeatmapFigure(figure)).metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBeGreaterThan(700);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run server/exportHeatmaps.test.js`

Expected: FAIL because `server/exportHeatmaps.js` does not exist.

- [ ] **Step 3: Implement source collection and two-pass planning**

```js
export const EXPORT_CELL_SIZES = Object.freeze([20, 50, 100]);
export const EXPORT_METRICS = Object.freeze(["pixel-density", "estimated-collagen-density"]);

export async function collectSavedHeatmaps({ storage, images }) {
  const sources = new Map();
  for (const image of images) {
    for (const cellSize of EXPORT_CELL_SIZES) {
      const key = `${image.id}:${cellSize}`;
      try {
        sources.set(key, {
          status: "Included",
          heatmap: await loadImageHeatmap(storage, image.id, cellSize),
        });
      } catch (error) {
        sources.set(key, {
          status: "Skipped",
          reason: heatmapSkipReason(error),
        });
      }
    }
  }
  return sources;
}
```

In `planHeatmapFigures`, first add absolute figures for every included map and both metrics. Then compare each image only with `images[index - 1]`, reject maps using `heatmapCompatibilityError`, and calculate deltas with `buildHeatmapDifference`. Store all comparison candidates before finding the largest finite absolute delta by `${metric}:${cellSize}`. In a second pass, assign the same `{ min: -maxAbs, max: maxAbs }` to every candidate in that set; use `maxAbs = 1` only when every delta is exactly zero so the color scale remains valid. Emit a `Skipped` report row for every missing/stale/invalid absolute map and each impossible comparison.

- [ ] **Step 4: Implement deterministic standalone SVG and PNG rendering**

Use a white canvas with fixed margins, a minimum `24px` cell display size, no smoothing, five numeric ticks, and a right-side color bar outside the grid. Escape every interpolated label. Absolute cells use `infernoColor(value, min, max)`; comparisons use `differenceColor(value, maxAbs)`. The title must name current and previous images for comparisons and must include the signed range. Every report includes `Calibration: Pixel Density = <a> * Collagen Density + <b>` below the title. Render the SVG with:

```js
export async function renderHeatmapFigure(figure) {
  return sharp(Buffer.from(buildHeatmapFigureSvg(figure)))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}
```

Set figure `archiveName` to one of:

```text
<image>_cell_<size>px_pixel_density.png
<image>_cell_<size>px_collagen_density.png
<image>_cell_<size>px_pixel_density_vs_<previous>.png
<image>_cell_<size>px_collagen_density_vs_<previous>.png
```

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run server/exportHeatmaps.test.js src/lib/heatmap.test.js`

Expected: PASS with exact subtraction direction and shared ranges.

- [ ] **Step 6: Commit Task 2**

```bash
git add server/exportHeatmaps.js server/exportHeatmaps.test.js
git commit -m "feat: render fixed-size heatmap reports"
```

### Task 3: Labeled ROI Overview Rendering

**Files:**
- Create: `server/exportRoiOverview.js`
- Create: `server/exportRoiOverview.test.js`

**Interfaces:**
- Consumes:
  - TIFF path
  - saved bounds
  - canonical `groupDisplayId` and `roiDisplayId`
  - existing ROI band derivation semantics (`near`, `mid`, `far` are disjoint outward regions).
- Produces:
  - `buildRoiOverviewSvg({ width, height, normalizedImageDataUrl, bounds }): string`
  - `renderRoiOverview({ imagePath, bounds, maxImagePixels }): Promise<Buffer>`.

- [ ] **Step 1: Write failing ROI report tests**

```js
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
  expect(svg).not.toContain('data-role="point-handle"');
});

test("normalizes a TIFF and renders image plus right legend", async () => {
  const imagePath = await writeTestTiff({ width: 80, height: 60 });
  const output = await renderRoiOverview({ imagePath, bounds, maxImagePixels: 1_000_000 });
  const metadata = await sharp(output).metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBeGreaterThan(metadata.height);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run server/exportRoiOverview.test.js`

Expected: FAIL because `server/exportRoiOverview.js` does not exist.

- [ ] **Step 3: Implement normalized background and report SVG**

Read the TIFF with Sharp, enforce `width * height <= maxImagePixels` when configured, normalize to 8-bit grayscale, and embed the result as a PNG data URL. Validate every polygon has at least three finite in-bounds points.

For inside groups, draw a semi-transparent polygon fill, group-color boundary, and `Gxx-I` label at the polygon centroid. For outside groups, use an SVG mask that excludes the polygon interior and draw cumulative stroked polygon paths from far to near so visible bands remain disjoint. Put `Gxx-N`, `Gxx-M`, and `Gxx-F` along an outward ray from the centroid through the first point at each band's midpoint. Draw `<group>-A` only in the legend and describe it as `0-<far> px union`.

Use a `360px` right legend with one group section containing ID, name, color swatch, mode, and each ROI distance. The renderer contains no circles or point IDs:

```js
export async function renderRoiOverview({ imagePath, bounds, maxImagePixels }) {
  const source = sharp(imagePath, { limitInputPixels: maxImagePixels || true });
  const metadata = await source.metadata();
  validateRoiBounds(bounds, metadata.width, metadata.height);
  const normalized = await source.clone().greyscale().normalize().png().toBuffer();
  const svg = buildRoiOverviewSvg({
    width: metadata.width,
    height: metadata.height,
    normalizedImageDataUrl: `data:image/png;base64,${normalized.toString("base64")}`,
    bounds,
  });
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}
```

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run server/exportRoiOverview.test.js server/previewLayers.test.js`

Expected: PASS without changing interactive preview behavior.

- [ ] **Step 5: Commit Task 3**

```bash
git add server/exportRoiOverview.js server/exportRoiOverview.test.js
git commit -m "feat: render labeled ROI overview reports"
```

### Task 4: Per-Image Excel Workbook

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/exportWorkbook.js`
- Create: `server/exportWorkbook.test.js`

**Interfaces:**
- Consumes:
  - `buildAnalysisRows(analysis, bounds)`
  - image/source metadata
  - calibration
  - Heatmap Index entries and Export Report entries produced by Tasks 2, 3, and 5.
- Produces:
  - `createImageWorkbook(input): Promise<Buffer>`, where `input` is `{ image, dimensions, sourceFiles, bounds, analysis, calibration, autoSavedBounds, roiEntry, heatmapEntries, reportEntries, exportedAt }`
  - `workbookFailureText({ imageFolder, error }): Buffer`.

- [ ] **Step 1: Install the structured workbook dependency**

Run: `npm install exceljs@^4.4.0`

Expected: `exceljs` appears under runtime `dependencies` and the lockfile resolves version `4.4.x`.

- [ ] **Step 2: Write the failing workbook contract tests**

```js
import ExcelJS from "exceljs";
import { expect, test } from "vitest";
import { createImageWorkbook } from "./exportWorkbook.js";

function workbookInput() {
  return {
    image: { id: "T01", imageFolder: "T01", imageFile: "T01.tif" },
    dimensions: { width: 100, height: 80 },
    sourceFiles: {
      image: { file: "T01.tif", mtimeMs: 1_721_000_000_000 },
      mask: { file: "T01.png", mtimeMs: 1_721_000_000_100 },
      bounds: { file: "T01.bounds.json", mtimeMs: 1_721_000_000_200 },
      analysis: { file: "T01.analysis.json", mtimeMs: 1_721_000_000_300 },
    },
    bounds: {
      groups: [{ id: "cell", name: "Cell", color: "#22c55e", analysisMode: "outside" }],
    },
    analysis: {
      roiBands: [{ id: "near", label: "가까움", fromPx: 0, toPx: 20 }],
      groups: [{
        groupId: "cell",
        groupName: "Cell",
        analysisMode: "outside",
        bands: {
          near: {
            roiAreaPx: 200,
            maskPixelCount: 50,
            density: 0.25,
            globalAlignment: 0.8,
            radialNormalAlignment: 0.4,
            tangentialAlignment: -0.4,
            migrationAlignment: 0.6,
            empty: false,
          },
        },
      }],
    },
    calibration: { slope: 0.1, intercept: 0 },
    autoSavedBounds: true,
    roiEntry: { status: "Included", path: "roi/T01_ROI_overview.png" },
    heatmapEntries: [{
      cellWidth: 20,
      cellHeight: 20,
      columns: 5,
      rows: 4,
      metric: "Pixel Density",
      currentImage: "T01",
      previousImage: null,
      colorMin: 0,
      colorMax: 1,
      unit: "ratio",
      status: "Included",
      path: "heatmap/20x20/T01_cell_20px_pixel_density.png",
      reason: "",
    }],
    reportEntries: [{ status: "Warning", artifact: "Analysis", message: "Bounds were auto-saved before export." }],
    exportedAt: new Date("2026-07-27T01:02:03Z"),
  };
}

test("writes five linked sheets with numeric ROI values and group colors", async () => {
  const buffer = await createImageWorkbook(workbookInput());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
    "ROI Statistics",
    "Image Summary",
    "Metric Definitions",
    "Heatmap Index",
    "Export Report",
  ]);

  const roi = workbook.getWorksheet("ROI Statistics");
  expect(roi.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  expect(roi.autoFilter).toEqual({ from: "A1", to: "R2" });
  expect(roi.getCell("A2").value).toBe("G01-N");
  expect(roi.getCell("I2").value).toBe(200);
  expect(roi.getCell("J2").value).toBe(50);
  expect(roi.getCell("K2").value).toBe(0.25);
  expect(roi.getCell("A2").fill.fgColor.argb).toBe("FF22C55E");
  expect(roi.getCell("R2").value).toEqual({
    text: "Open ROI overview",
    hyperlink: "../roi/T01_ROI_overview.png",
  });

  const heatmaps = workbook.getWorksheet("Heatmap Index");
  expect(heatmaps.getCell("L2").value).toEqual({
    text: "Open PNG",
    hyperlink: "../heatmap/20x20/T01_cell_20px_pixel_density.png",
  });
});
```

- [ ] **Step 3: Implement workbook sheets and formats**

Build the exact 18 ROI Statistics columns from the approved spec. Keep measurements as numeric values, blank undefined alignment values, use `0.0000` for densities/alignment, `0` for pixel counts/areas, and `0.00` for distance fields. Apply the group color to ROI ID, Group ID, and Group Color cells with a contrast-aware font. Freeze row 1, set auto-filter through column `R`, and use widths between 12 and 38 characters.

The other sheets must contain:

```js
const METRIC_DEFINITIONS = [
  ["Pixel Density", "mask pixels / ROI area pixels", "0 to 1", "ratio"],
  ["Estimated Collagen Density", "(Pixel Density - b) / a", "calibration-derived", "mg/ml"],
  ["ROI Alignment", "nematic order of all fiber segment angles in the ROI", "0 random to 1 aligned", "unitless"],
  ["Radial Alignment", "mean cos(2(theta - boundary-normal angle))", "-1 circumferential to 1 radial", "unitless"],
  ["Circumferential Alignment", "negative radial alignment", "-1 radial to 1 circumferential", "unitless"],
  ["Migration Axis Alignment", "mean cos(2(theta - migration-axis angle))", "-1 perpendicular to 1 parallel", "unitless"],
];
```

`Image Summary` records filenames, dimensions, counts, timestamps, calibration, and auto-save status without absolute paths. `Heatmap Index` records every generated/skipped requested figure. `Export Report` records timestamp, calibration, and every `Included`, `Skipped`, or `Warning` event. `workbookFailureText` returns UTF-8 text containing only image folder, safe error category, and recovery guidance.

- [ ] **Step 4: Run focused workbook tests**

Run: `npx vitest run server/exportWorkbook.test.js shared/analysisRows.test.js`

Expected: PASS and generated buffers reopen with ExcelJS.

- [ ] **Step 5: Commit Task 4**

```bash
git add package.json package-lock.json server/exportWorkbook.js server/exportWorkbook.test.js
git commit -m "feat: generate linked image statistics workbooks"
```

### Task 5: Partial-Success ZIP Orchestration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/exportService.js`
- Create: `server/exportService.test.js`

**Interfaces:**
- Consumes:
  - Tasks 2-4 renderers
  - `storage.getRoot()`, `storage.scanImages()`, `storage.imagePaths(id)`, `storage.loadBounds(id)`, and `storage.loadAnalysis(id)`
  - `selectMaskSource(image, maskDir)` from `analysisService.js`.
- Produces:
  - `ExportError`
  - `validateExportCalibration(value): { slope, intercept }`
  - `datasetExportFilename(rootPath, date): string`
  - `datasetExportDirectory(rootPath): string`
  - `safeArchiveSegment(value): string`
  - `writeDatasetZip({ storage, output, calibration, autoSavedImageId, maxImagePixels, now, signal }): Promise<void>`.

- [ ] **Step 1: Install ZIP runtime and test reader dependencies**

Run: `npm install archiver@^8.0.0 && npm install --save-dev unzipper@^0.12.5`

Expected: `archiver` is a runtime dependency, `unzipper` is a dev dependency, and the lockfile is updated.

- [ ] **Step 2: Write failing safety, layout, and partial-success tests**

```js
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import unzipper from "unzipper";
import { afterEach, expect, test } from "vitest";
import { generateHeatmapBatch } from "./heatmapService.js";
import { createStorage } from "./storage.js";
import {
  datasetExportDirectory,
  datasetExportFilename,
  safeArchiveSegment,
  validateExportCalibration,
  writeDatasetZip,
} from "./exportService.js";

const tempRoots = [];

async function createTempRoot(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function analysisMetrics(maskPixelCount, areaPx) {
  return {
    roiAreaPx: areaPx,
    maskPixelCount,
    density: maskPixelCount / areaPx,
    globalAlignment: 0.8,
    globalOrientationDeg: 10,
    circularVariance: 0.2,
    radialNormalAlignment: null,
    tangentialAlignment: null,
    migrationAlignment: null,
    orientationDispersion: 0.2,
    empty: false,
  };
}

async function writeExportBundle(rootDir, imageFolder, maskPixelCount, { width = 40, height = 40 } = {}) {
  const folderPath = path.join(rootDir, imageFolder);
  const imageDir = path.join(folderPath, "image");
  const maskDir = path.join(folderPath, "mask");
  const boundDir = path.join(folderPath, "bound");
  const analysisDir = path.join(folderPath, "analysis");
  await Promise.all([
    mkdir(imageDir, { recursive: true }),
    mkdir(maskDir, { recursive: true }),
    mkdir(boundDir, { recursive: true }),
    mkdir(analysisDir, { recursive: true }),
  ]);

  const imageFile = `${imageFolder}.tif`;
  const maskFile = `${imageFolder}.png`;
  const areaPx = width * height;
  const imageBytes = await sharp(Buffer.alloc(areaPx, 128), {
    raw: { width, height, channels: 1 },
  }).tiff().toBuffer();
  const mask = Buffer.alloc(areaPx, 0);
  mask.fill(255, 0, maskPixelCount);
  await writeFile(path.join(imageDir, imageFile), imageBytes);
  const maskPath = path.join(maskDir, maskFile);
  await sharp(mask, { raw: { width, height, channels: 1 } }).png().toFile(maskPath);

  const bounds = {
    schemaVersion: 1,
    imageFolder,
    imageFile,
    width,
    height,
    groups: [{
      id: "whole",
      name: "Whole image",
      color: "#22c55e",
      analysisMode: "inside",
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: width - 1, y: 0 },
        { id: "p3", x: width - 1, y: height - 1 },
        { id: "p4", x: 0, y: height - 1 },
      ],
    }],
  };
  const analysis = {
    schemaVersion: 5,
    imageFolder,
    imageFile,
    roiBands: [],
    groups: [{
      groupId: "whole",
      groupName: "Whole image",
      analysisMode: "inside",
      area: analysisMetrics(maskPixelCount, areaPx),
    }],
    updatedAt: "2026-07-27T01:00:00.000Z",
  };
  await writeFile(path.join(boundDir, `${imageFolder}.bounds.json`), JSON.stringify(bounds));
  await writeFile(path.join(analysisDir, `${imageFolder}.analysis.json`), JSON.stringify(analysis));
  return { imageBytes, maskBytes: await readFile(maskPath) };
}

async function createExportFixture({ imageFolders, heatmapSizes, dimensionsByImage = {} }) {
  const parent = await createTempRoot("dataset-export-");
  const rootDir = path.join(parent, "fixture");
  await mkdir(rootDir);
  const originalTiffBytes = {};
  const originalMaskBytes = {};
  for (let index = 0; index < imageFolders.length; index += 1) {
    const imageFolder = imageFolders[index];
    const sourceBytes = await writeExportBundle(
      rootDir,
      imageFolder,
      200 + index * 200,
      dimensionsByImage[imageFolder],
    );
    originalTiffBytes[imageFolder] = sourceBytes.imageBytes;
    originalMaskBytes[imageFolder] = sourceBytes.maskBytes;
  }
  await generateHeatmapBatch({ rootPath: rootDir, cellSizes: [20, 50, 100] });
  for (const imageFolder of imageFolders) {
    for (const cellSize of [20, 50, 100]) {
      if (!heatmapSizes[imageFolder].includes(cellSize)) {
        await rm(path.join(rootDir, imageFolder, "heatmap", `${cellSize}x${cellSize}`), {
          recursive: true,
          force: true,
        });
      }
    }
  }
  return {
    rootDir,
    originalTiffBytes,
    originalMaskBytes,
    storage: createStorage({ initialRoot: rootDir }),
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("validates calibration and creates deterministic safe names", () => {
  expect(validateExportCalibration({ slope: 0.069676956982087, intercept: 0.067893820336777 })).toEqual({
    slope: 0.069676956982087,
    intercept: 0.067893820336777,
  });
  expect(() => validateExportCalibration({ slope: 0, intercept: 1 })).toThrow("non-zero");
  expect(datasetExportFilename("/data/Study A", new Date("2026-07-27T01:02:03Z"))).toBe(
    "Study_A_export_20260727-010203.zip",
  );
  expect(datasetExportDirectory("/data/Study A")).toBe("Study_A_export");
  expect(() => safeArchiveSegment("../outside")).toThrow("archive");
});

test("streams source bytes, reports missing artifacts, and never leaks host paths", async () => {
  const fixture = await createExportFixture({
    imageFolders: ["T01", "T02"],
    heatmapSizes: { T01: [20, 50, 100], T02: [20, 50] },
  });
  const output = new PassThrough();
  const zipPromise = collectStream(output);
  const writePromise = writeDatasetZip({
    storage: fixture.storage,
    output,
    calibration: { slope: 0.1, intercept: 0 },
    autoSavedImageId: "T02",
    maxImagePixels: 1_000_000,
    now: () => new Date("2026-07-27T01:02:03Z"),
  });
  const zipBuffer = await zipPromise;
  await writePromise;

  const archive = await unzipper.Open.buffer(zipBuffer);
  const names = archive.files.map((file) => file.path);
  expect(names).toContain("fixture_export/T01/image/T01.tif");
  expect(names).toContain("fixture_export/T01/mask/T01.png");
  expect(names).toContain("fixture_export/T01/roi/T01_ROI_overview.png");
  expect(names).toContain("fixture_export/T01/heatmap/20x20/T01_cell_20px_pixel_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/20x20/T01_cell_20px_collagen_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/50x50/T01_cell_50px_pixel_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/50x50/T01_cell_50px_collagen_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/100x100/T01_cell_100px_pixel_density.png");
  expect(names).toContain("fixture_export/T01/heatmap/100x100/T01_cell_100px_collagen_density.png");
  expect(names).toContain("fixture_export/T02/heatmap/20x20/T02_cell_20px_pixel_density_vs_T01.png");
  expect(names).toContain("fixture_export/T02/heatmap/20x20/T02_cell_20px_collagen_density_vs_T01.png");
  expect(names.some((name) => name.includes("/T01_cell_") && name.includes("_vs_"))).toBe(false);
  expect(names.some((name) => name.includes("/100x100/") && name.includes("T02"))).toBe(false);
  expect(names.some((name) => name.endsWith(".bounds.json") || name.endsWith(".analysis.json"))).toBe(false);
  expect(names.join("\n")).not.toContain(fixture.rootDir);

  const tiff = archive.files.find((file) => file.path === "fixture_export/T01/image/T01.tif");
  expect(await tiff.buffer()).toEqual(fixture.originalTiffBytes.T01);
  const mask = archive.files.find((file) => file.path === "fixture_export/T01/mask/T01.png");
  expect(await mask.buffer()).toEqual(fixture.originalMaskBytes.T01);
});

test("keeps the ZIP usable when saved heatmaps are stale or adjacent grids are incompatible", async () => {
  const staleFixture = await createExportFixture({
    imageFolders: ["T01", "T02"],
    heatmapSizes: { T01: [20, 50, 100], T02: [20, 50, 100] },
  });
  const staleMaskPath = path.join(staleFixture.rootDir, "T02", "mask", "T02.png");
  const staleMaskStat = await stat(staleMaskPath);
  const changedTime = new Date(staleMaskStat.mtimeMs + 2_000);
  await utimes(staleMaskPath, changedTime, changedTime);
  const staleOutput = new PassThrough();
  const staleZipPromise = collectStream(staleOutput);
  const staleWritePromise = writeDatasetZip({
    storage: staleFixture.storage,
    output: staleOutput,
    calibration: { slope: 0.1, intercept: 0 },
  });
  const staleArchive = await unzipper.Open.buffer(await staleZipPromise);
  await staleWritePromise;
  expect(staleArchive.files.some((file) => file.path.endsWith("/T02_statistics.xlsx"))).toBe(true);
  expect(staleArchive.files.some((file) => file.path.includes("/T02/heatmap/"))).toBe(false);

  const incompatibleFixture = await createExportFixture({
    imageFolders: ["T01", "T02"],
    heatmapSizes: { T01: [20, 50, 100], T02: [20, 50, 100] },
    dimensionsByImage: { T02: { width: 60, height: 40 } },
  });
  const incompatibleOutput = new PassThrough();
  const incompatibleZipPromise = collectStream(incompatibleOutput);
  const incompatibleWritePromise = writeDatasetZip({
    storage: incompatibleFixture.storage,
    output: incompatibleOutput,
    calibration: { slope: 0.1, intercept: 0 },
  });
  const incompatibleArchive = await unzipper.Open.buffer(await incompatibleZipPromise);
  await incompatibleWritePromise;
  expect(incompatibleArchive.files.some((file) => file.path.includes("_vs_T01.png"))).toBe(false);
  expect(incompatibleArchive.files.some((file) => file.path.endsWith("/T02_statistics.xlsx"))).toBe(true);
});
```

- [ ] **Step 3: Implement source collection and safe entry naming**

Reject archive segments that are empty, `.`/`..`, contain `/`, `\`, NUL, or normalize outside their parent. Sanitize only the generated top-level export name and download filename by replacing non-alphanumeric Unicode-safe filename characters with `_`; preserve validated storage image folder and source basenames.

For every image, build an `ImageExportRecord` with source names/timestamps, bounds, analysis, mask selection, Heatmap sources, report entries, and `autoSavedBounds`. Catch each source read independently. A missing analysis still yields source TIFF/mask, ROI when bounds are valid, and a workbook. When `image.id === autoSavedImageId`, add both `Included / Bounds / Current bounds auto-saved before export` and `Warning / Analysis / Saved analysis may predate the auto-saved bounds` to that image's Export Report without attempting recalculation. Compare bounds group IDs to analysis group IDs and add a warning for each unmatched analysis group.

- [ ] **Step 4: Implement sequential archive streaming**

Create one Archiver instance with `{ zlib: { level: 9 } }`, pipe it to `output`, and append:

1. original TIFF with `archive.file(imagePath, { name })`;
2. selected mask with `archive.file(maskPath, { name })`;
3. ROI PNG buffer when renderable;
4. each absolute/comparison Heatmap PNG buffer from the global plan;
5. workbook buffer, or `<image>_statistics_error.txt` when workbook creation fails.

Render one PNG at a time. `appendBufferAndWait` and `appendPathAndWait` must wait for Archiver's matching `entry` event before the loop advances, preventing a whole-root queue of TIFF/PNG/Workbook buffers and streams. Do not construct the ZIP as one Buffer. On `signal.abort`, call `archive.abort()` and destroy any active renderer stream. Resolve only after the output `finished` promise:

```js
function waitForArchiveEntry(archive, name) {
  return new Promise((resolve, reject) => {
    const onEntry = (entry) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
    };
    archive.on("entry", onEntry);
    archive.on("error", onError);
  });
}

async function appendBufferAndWait(archive, buffer, name) {
  const entered = waitForArchiveEntry(archive, name);
  archive.append(buffer, { name });
  await entered;
}

async function appendPathAndWait(archive, filePath, name) {
  const entered = waitForArchiveEntry(archive, name);
  archive.file(filePath, { name });
  await entered;
}
```

The service entry point is:

```js
export async function writeDatasetZip({ storage, output, calibration, autoSavedImageId = null, maxImagePixels, now = () => new Date(), signal }) {
  const checkedCalibration = validateExportCalibration(calibration);
  const rootPath = storage.getRoot();
  if (!rootPath) throw new ExportError("ROOT_UNSET", "Storage root has not been set.", 400);
  const images = await storage.scanImages();
  const sources = await collectSavedHeatmaps({ storage, images });
  const plan = planHeatmapFigures({ images, sources, calibration: checkedCalibration });
  const archive = archiver("zip", { zlib: { level: 9 } });
  const closed = finished(output);
  archive.pipe(output);
  attachAbort(signal, archive, output);
  await appendDatasetEntries({ archive, storage, images, sources, plan, calibration: checkedCalibration, autoSavedImageId, maxImagePixels, now });
  await archive.finalize();
  await closed;
}
```

- [ ] **Step 5: Run focused ZIP tests**

Run: `npx vitest run server/exportService.test.js server/exportHeatmaps.test.js server/exportRoiOverview.test.js server/exportWorkbook.test.js`

Expected: PASS; ZIP extraction shows only relative paths, byte-identical source files, fixed `20x20`, `50x50`, `100x100` folders, and recorded skips.

- [ ] **Step 6: Commit Task 5**

```bash
git add package.json package-lock.json server/exportService.js server/exportService.test.js
git commit -m "feat: stream partial-success dataset exports"
```

### Task 6: Export HTTP Endpoint

**Files:**
- Modify: `server/app.js:1-120,158-420`
- Modify: `server/app.test.js`

**Interfaces:**
- Consumes: Task 5 `validateExportCalibration`, `datasetExportFilename`, `writeDatasetZip`, and `ExportError`.
- Produces: `POST /api/export` accepting:

```json
{
  "calibration": {
    "slope": 0.069676956982087,
    "intercept": 0.067893820336777
  },
  "autoSavedImageId": "selected-stack-sequence_T16"
}
```

- [ ] **Step 1: Write failing endpoint tests**

```js
test("streams a named ZIP for the active root", async () => {
  const appRoot = await createTempRoot();
  const imageRoot = await createTempRoot();
  await writeImage(imageRoot, "T01", "frame001.tif");
  await writeMask(imageRoot, "T01", "frame001.png");
  await writeBounds(imageRoot, "T01", validBounds("T01", "frame001.tif"));
  const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
    method: "POST",
    body: {
      calibration: { slope: 0.069676956982087, intercept: 0.067893820336777 },
      autoSavedImageId: "T01",
    },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("content-disposition")).toMatch(
    /^attachment; filename=".+_export_\d{8}-\d{6}\.zip"$/,
  );
  const archive = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
  expect(archive.files.some((file) => file.path.endsWith("/statistics/T01_statistics.xlsx"))).toBe(true);
});

test.each([
  { slope: 0, intercept: 1 },
  { slope: null, intercept: 1 },
])("rejects invalid calibration before streaming", async (calibration) => {
  const appRoot = await createTempRoot();
  const imageRoot = await createTempRoot();
  await writeImage(imageRoot, "T01", "frame001.tif");
  const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });
  const response = await jsonRequest(app, "/api/export", { method: "POST", body: { calibration } });
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/json");
});

test("rejects export before streaming when no root is active", async () => {
  const appRoot = await createTempRoot();
  const response = await jsonRequest(createApp({ rootDir: appRoot }), "/api/export", {
    method: "POST",
    body: { calibration: { slope: 0.1, intercept: 0 } },
  });
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "Storage root has not been set." });
});
```

- [ ] **Step 2: Run the endpoint tests and verify RED**

Run: `npx vitest run server/app.test.js -t "ZIP|calibration"`

Expected: FAIL with `404` because `/api/export` is not registered.

- [ ] **Step 3: Implement validation, headers, streaming, and cancellation**

Register the route before static frontend fallback. Validate root and calibration before setting headers. Confirm `autoSavedImageId` is `null` or an existing image ID. Create an `AbortController`; abort only on `request.aborted` or a premature response `close`, not after a normal `finish`.

```js
app.post("/api/export", async (request, response, next) => {
  try {
    const calibration = validateExportCalibration(request.body?.calibration);
    const rootPath = imageStorage.getRoot();
    if (!rootPath) throw new ExportError("ROOT_UNSET", "Storage root has not been set.", 400);
    const now = new Date();
    const filename = datasetExportFilename(rootPath, now);
    const autoSavedImageId = request.body?.autoSavedImageId ?? null;
    if (autoSavedImageId !== null && typeof autoSavedImageId !== "string") {
      throw new ExportError("INVALID_IMAGE", "Export image id is invalid.", 400);
    }
    if (autoSavedImageId) imageStorage.getImage(autoSavedImageId);

    response.status(200);
    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const abortController = new AbortController();
    request.once("aborted", () => abortController.abort());
    response.once("close", () => {
      if (!response.writableFinished) abortController.abort();
    });

    await writeDatasetZip({
      storage: imageStorage,
      output: response,
      calibration,
      autoSavedImageId,
      maxImagePixels,
      now: () => now,
      signal: abortController.signal,
    });
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    next(error);
  }
});
```

Add `ExportError` handling to `safeErrorResponse` with fixed messages for unset root, invalid calibration, invalid image ID, and export preparation failure.

- [ ] **Step 4: Run server integration tests**

Run: `npx vitest run server/app.test.js server/exportService.test.js`

Expected: PASS for valid ZIP, safe validation errors, and partial artifacts.

- [ ] **Step 5: Commit Task 6**

```bash
git add server/app.js server/app.test.js
git commit -m "feat: expose streamed dataset ZIP endpoint"
```

### Task 7: Toolbar Download Flow and Save-Before-Export

**Files:**
- Modify: `src/App.jsx:1-260,1100-1170`
- Modify: `src/App.test.jsx`
- Modify: `src/styles.css`
- Modify: `src/styles.test.js`

**Interfaces:**
- Consumes: `POST /api/export` from Task 6 and existing bounds save API.
- Produces: `Download as ZIP` UI with `Preparing ZIP...`, dirty-save ordering, filename-aware browser download, and safe error feedback.

- [ ] **Step 1: Extend the client API mock and write failing toolbar tests**

```js
test("replaces Load saved bound and downloads the named ZIP", async () => {
  const { fetchMock } = mockApi({
    exportResponse: new Response(new Blob(["zip"]), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="study_export_20260727-090000.zip"',
      },
    }),
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  URL.createObjectURL.mockReturnValueOnce("blob:export");
  render(<App />);
  expect(await screen.findByRole("button", { name: "Download as ZIP" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Load saved bound" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Download as ZIP" }));

  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  const exportCall = fetchMock.mock.calls.find(([url]) => url === "/api/export");
  expect(JSON.parse(exportCall[1].body)).toEqual({
    calibration: {
      slope: 0.069676956982087,
      intercept: 0.067893820336777,
    },
    autoSavedImageId: null,
  });
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export"));
});

test("saves dirty bounds before exporting and blocks duplicate clicks", async () => {
  const { fetchMock, releaseExport } = mockApi({ delayedExport: true });
  render(<App />);
  await screen.findByRole("button", { name: "Saved Tissue" });
  fireEvent.click(screen.getByRole("button", { name: "Inside area" }));
  const button = screen.getByRole("button", { name: "Download as ZIP" });
  await userEvent.click(button);

  await waitFor(() => expect(button).toHaveTextContent("Preparing ZIP..."));
  expect(button).toBeDisabled();
  const saveIndex = fetchMock.mock.calls.findIndex(
    ([url, options]) => url === "/api/images/scan-a/bounds" && options?.method === "PUT",
  );
  const exportIndex = fetchMock.mock.calls.findIndex(([url]) => url === "/api/export");
  expect(saveIndex).toBeGreaterThanOrEqual(0);
  expect(exportIndex).toBeGreaterThan(saveIndex);
  expect(JSON.parse(fetchMock.mock.calls[exportIndex][1].body).autoSavedImageId).toBe("scan-a");

  await userEvent.click(button);
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/export")).toHaveLength(1);
  releaseExport(
    new Response(new Blob(["zip"]), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="study_export.zip"',
      },
    }),
  );
});
```

- [ ] **Step 2: Run focused client tests and verify RED**

Run: `npx vitest run src/App.test.jsx -t "ZIP|dirty bounds"`

Expected: FAIL because the new button and handler do not exist.

- [ ] **Step 3: Implement save-return semantics and download flow**

Extend the existing `mockApi` options with `exportResponse` and `delayedExport`. Create `const exportDeferred = delayedExport ? deferred() : null` before `fetchMock`; handle `POST /api/export` by returning `exportResponse`, `exportDeferred.promise`, or a default ZIP `Response`; and return `releaseExport: (response) => exportDeferred?.resolve(response)` with the existing mock result.

Refactor the existing save operation into `saveCurrentBounds()` that returns the saved payload and clears `dirty`; keep `handleSave` as its UI wrapper. Add `exporting` state and:

```js
async function responseError(response, fallback) {
  try {
    const payload = await response.json();
    return typeof payload?.error === "string" ? payload.error : fallback;
  } catch {
    return fallback;
  }
}

function responseFilename(contentDisposition) {
  const extended = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = contentDisposition?.match(/filename="([^"]+)"/i)?.[1];
  let candidate = quoted;
  if (extended) {
    try {
      candidate = decodeURIComponent(extended);
    } catch {
      return "dataset_export.zip";
    }
  }
  if (!candidate || pathBasename(candidate) !== candidate || !candidate.toLowerCase().endsWith(".zip")) {
    return "dataset_export.zip";
  }
  return candidate;
}

function pathBasename(value) {
  return value.split(/[\\/]/).at(-1);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function handleDownloadZip() {
  if (exporting || !rootPath) return;
  setExporting(true);
  setStatus("");
  try {
    let autoSavedImageId = null;
    if (dirty && activeImage) {
      await saveCurrentBounds();
      autoSavedImageId = activeImage.id;
    }
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        calibration: {
          slope: Number(densityCalibration.slope),
          intercept: Number(densityCalibration.intercept),
        },
        autoSavedImageId,
      }),
    });
    if (!response.ok) throw new Error(await responseError(response, "Export failed."));
    const blob = await response.blob();
    downloadBlob(blob, responseFilename(response.headers.get("content-disposition")));
  } catch (error) {
    setStatus(error.message);
  } finally {
    setExporting(false);
  }
}
```

`responseFilename` accepts only a quoted or `filename*=UTF-8''` basename ending in `.zip`, otherwise returns `dataset_export.zip`. `downloadBlob` creates a hidden anchor, clicks it, removes it, and revokes the object URL in a `setTimeout(..., 0)`.

Remove the `Load saved bound` button and its click-only handler, but retain automatic bound loading in `loadImage`. Keep `Save` and `Import previous bound` where they are. Show `Download as ZIP` for every image layer, disabled when root is absent or export is active.

- [ ] **Step 4: Preserve layout changes and style compact export state**

Add only narrowly scoped selectors for `.export-button`, `.roi-id`, and `.group-color-swatch`. Preserve the existing uncommitted Compare Previous/Original opacity rules and their tests. Do not change viewer sizing, bottom-panel resizing, Heatmap controls, or image opacity controls.

- [ ] **Step 5: Run client and CSS tests**

Run: `npx vitest run src/App.test.jsx src/styles.test.js`

Expected: PASS for save order, duplicate prevention, filename, error reset, and existing Heatmap control layout.

- [ ] **Step 6: Commit Task 7**

Review `git diff -- src/styles.css src/styles.test.js` before staging so the existing layout fix remains intact and is not accidentally reverted.

```bash
git add src/App.jsx src/App.test.jsx src/styles.css src/styles.test.js
git commit -m "feat: download dataset ZIP from the editor"
```

### Task 8: Matching ROI IDs and Colors in Editor, Overlay, and Statistics

**Files:**
- Modify: `src/App.jsx:1160-1390,1880-2010,2120-2215`
- Modify: `src/App.test.jsx`
- Modify: `src/styles.css`
- Modify: `src/styles.test.js`

**Interfaces:**
- Consumes: Task 1 `groupDisplayId`, `roiDisplayId`, and `buildAnalysisRows`.
- Produces: group list IDs/swatches, overlay labels, and statistics ROI ID/color cells that match exported images/workbooks.

- [ ] **Step 1: Write failing cross-surface identity tests**

```js
test("shows the same group and ROI identities with saved colors", async () => {
  const mixedBounds = {
    ...savedBounds,
    groups: [
      { ...savedBounds.groups[0], id: "outer", name: "Cell edge", color: "#22c55e", analysisMode: "outside" },
      {
        id: "whole",
        name: "Whole image",
        color: "#ef4444",
        analysisMode: "inside",
        points: [
          { id: "q1", x: 0, y: 0 },
          { id: "q2", x: 99, y: 0 },
          { id: "q3", x: 99, y: 79 },
          { id: "q4", x: 0, y: 79 },
        ],
      },
    ],
  };
  const mixedAnalysis = {
    ...savedAnalysis,
    groups: [
      { ...savedAnalysis.groups[0], groupId: "outer", groupName: "Cell edge" },
      {
        groupId: "whole",
        groupName: "Whole image",
        analysisMode: "inside",
        area: {
          roiAreaPx: 8_000,
          maskPixelCount: 2_000,
          density: 0.25,
          globalAlignment: 0.7,
          radialNormalAlignment: null,
          tangentialAlignment: null,
          migrationAlignment: null,
          empty: false,
        },
      },
    ],
  };
  mockApi({
    boundsQueue: [mixedBounds],
    analysisResponse: { analysis: mixedAnalysis, hasAnalysis: true },
  });
  render(<App />);

  expect(await screen.findByText("G01")).toHaveAttribute("data-group-color", "#22c55e");
  expect(screen.getByText("G02")).toHaveAttribute("data-group-color", "#ef4444");
  expect(screen.getByRole("cell", { name: "G01-N" })).toHaveAttribute("data-group-color", "#22c55e");
  expect(screen.getByRole("cell", { name: "G01-A" })).toHaveAttribute("data-group-color", "#22c55e");
  expect(screen.getByRole("cell", { name: "G02-I" })).toHaveAttribute("data-group-color", "#ef4444");
});

test("labels visible ROI bands without rendering the all-band union twice", async () => {
  const outsideBounds = {
    ...savedBounds,
    groups: [{ ...savedBounds.groups[0], id: "outer", color: "#22c55e", analysisMode: "outside" }],
  };
  const outsideAnalysis = {
    ...savedAnalysis,
    groups: [{ ...savedAnalysis.groups[0], groupId: "outer" }],
  };
  mockApi({
    boundsQueue: [outsideBounds],
    analysisResponse: { analysis: outsideAnalysis, hasAnalysis: true },
  });
  render(<App />);
  expect(await screen.findByLabelText("ROI ID G01-N")).toBeVisible();
  expect(screen.getByLabelText("ROI ID G01-M")).toBeVisible();
  expect(screen.getByLabelText("ROI ID G01-F")).toBeVisible();
  expect(screen.queryByLabelText("ROI ID G01-A")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/App.test.jsx -t "ROI identities|visible ROI bands"`

Expected: FAIL because the editor still uses internal group IDs and the old local `analysisRows`.

- [ ] **Step 3: Replace local row assembly and display canonical IDs**

Import Task 1 helpers and delete the local `analysisRows` function. Call `buildAnalysisRows(analysis, bounds)` so stats rows contain `roiId`, display group ID, saved color, and distance fields. Continue passing `row.sourceGroupId` to `groupVisible`/`groupDisplayVisible`; never key draw or statistics visibility maps by `Gxx`.

In the group list, map with `groupIndex` and render:

```jsx
<span
  className="group-color-swatch"
  style={{ "--group-color": group.color }}
  aria-label={`${groupDisplayId(groupIndex)} color ${group.color}`}
/>
<span className="roi-id" data-group-color={group.color}>
  {groupDisplayId(groupIndex)}
</span>
```

Add a `ROI ID` column before Group in the statistics table. Render the same swatch and `row.roiId`, with `data-group-color={row.groupColor}` on the cell.

- [ ] **Step 4: Add overlay labels tied to current display visibility**

For inside groups, put `Gxx-I` at the polygon centroid. For outside groups, derive visible `near`, `mid`, and `far` bands from that group's client-side ROI limits and place each label along the outward centroid-to-first-point ray at the band's midpoint. Render labels only when that group draw visibility is on and the app is not in Heat Map mode. Do not render `<group>-A` as another shape because it is the union of the three visible bands.

Use SVG `<text>` with a dark halo via `paintOrder: "stroke"`, `strokeWidth: 3`, and `aria-label={`ROI ID ${roiId}`}`. Set `pointerEvents="none"` so point editing and dragging remain unchanged.

- [ ] **Step 5: Run client, stylesheet, and full automated suites**

Run: `npx vitest run src/App.test.jsx src/styles.test.js`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

Run: `npm run build`

Expected: Vite production build exits `0`.

- [ ] **Step 6: Commit Task 8**

```bash
git add src/App.jsx src/App.test.jsx src/styles.css src/styles.test.js
git commit -m "feat: align ROI identities across editor exports"
```

## Final Verification

- [ ] Start the app using the existing server command and open the active local URL.
- [ ] Select a real multi-image root containing saved `20x20`, `50x50`, and `100x100` Heatmap JSON where available.
- [ ] Confirm group list, overlay, and statistics use matching `Gxx-*` labels and saved colors.
- [ ] Modify one boundary point, click `Download as ZIP`, and confirm the bounds PUT finishes before the export POST.
- [ ] Extract the ZIP and confirm original TIFF/mask bytes open, no absolute paths appear, and no bounds/analysis/Heatmap JSON is copied.
- [ ] Open ROI overview PNGs and verify background, disjoint outside bands, inside areas, labels, saved colors, and right legend.
- [ ] Open absolute Heatmaps for all valid `20x20`, `50x50`, and `100x100` sizes and verify titles, Grid X/Y, unblurred cells, and unobstructed right color bars.
- [ ] Verify the first image has no comparison PNG and every later compatible image compares to its immediate predecessor with the same metric-size range.
- [ ] Open each workbook in Excel and verify five sheets, numeric cells, filters, group colors, relative links, calibration, and missing/stale artifact reports.
- [ ] Run `git status --short` and confirm only intentional changes remain.
