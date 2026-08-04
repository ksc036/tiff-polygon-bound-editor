# Interactive Heatmap Report View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the in-app Heat Map as the same annotated report figure used by Download as ZIP while preserving raw TIFF opacity and interactive cell hover.

**Architecture:** Extract report labels and tick calculations into a shared pure module consumed by both server export and browser rendering. Add a focused `HeatmapReport` React component that owns report chrome and the plot stack, then integrate it into `App` with a report-aware stage aspect ratio and pointer mapping through the raw canvas plot rectangle.

**Tech Stack:** React 18, Canvas 2D, SVG, CSS Grid, Vitest, Testing Library, Sharp-backed server export.

## Global Constraints

- Keep heatmap JSON, generated folder structure, and API responses unchanged.
- Keep fixed heatmap cell-size presets at exactly 20, 50, and 100 pixels.
- Keep Download as ZIP output content and naming unchanged.
- Display current/previous names, metric, cell size, grid dimensions, calibration, range, Grid X/Y axes, and color scale consistently with export.
- Preserve raw TIFF opacity, cell hover, selected heatmap preset, selected metric, and Compare Previous behavior.
- Keep report annotations outside the heatmap plot; only the hover tooltip may float over the figure.
- Keep Original, Mask, Fiber QC, bounds, and ROI editing behavior unchanged.
- Add no runtime dependency.

---

### Task 1: Shared Heatmap Figure Presentation Rules

**Files:**
- Create: `shared/heatmapFigure.js`
- Create: `shared/heatmapFigure.test.js`
- Modify: `server/exportHeatmaps.js`
- Test: `server/exportHeatmaps.test.js`

**Interfaces:**
- Produces: `HEATMAP_FIGURE_TICK_COUNT = 5`.
- Produces: `heatmapAxisTickValues(count: number): number[]` returning five zero-based tick labels.
- Produces: `heatmapScaleTickValues(min: number, max: number): number[]` returning five vertical values from maximum to minimum.
- Produces: `formatHeatmapFigureNumber(value: number): string` using the export renderer's current six-decimal normalization.
- Produces: `formatHeatmapFigureRange(min, max, { signed }): string`.
- Produces: `heatmapCalibrationText(calibration): string`.
- Produces: `heatmapFigureText(input): { titleLines, detailLine, calibrationLine, rangeLine, colorBarLabel }` for absolute and comparison figures.
- Consumes: existing metric labels and range units supplied by the caller; this module does not calculate heatmap values.

- [ ] **Step 1: Write failing pure-function tests**

Add `shared/heatmapFigure.test.js` with exact behavior:

```js
import { describe, expect, test } from "vitest";
import {
  formatHeatmapFigureRange,
  heatmapAxisTickValues,
  heatmapFigureText,
  heatmapScaleTickValues,
} from "./heatmapFigure.js";

describe("heatmap figure presentation", () => {
  test("uses five zero-based ticks for grid axes", () => {
    expect(heatmapAxisTickValues(9)).toEqual([0, 2, 4, 6, 8]);
    expect(heatmapAxisTickValues(1)).toEqual([0, 0, 0, 0, 0]);
  });

  test("uses five top-to-bottom scale ticks", () => {
    expect(heatmapScaleTickValues(-0.5, 0.5)).toEqual([0.5, 0.25, 0, -0.25, -0.5]);
  });

  test("builds export-compatible comparison text", () => {
    expect(heatmapFigureText({
      currentImage: "T2",
      previousImage: "T1",
      metric: "pixel-density",
      metricLabel: "Pixel Density",
      metricUnit: "ratio",
      cellWidth: 20,
      cellHeight: 20,
      columns: 8,
      rows: 6,
      min: -0.5,
      max: 0.5,
      comparison: true,
      calibration: { slope: 0.069676956982087, intercept: 0.067893820336777 },
    })).toMatchObject({
      titleLines: ["Current: T2", "Previous: T1"],
      detailLine: "Pixel Density | Cell 20x20 px | Grid 8x6",
      rangeLine: "Color range: -0.5 to +0.5 ratio",
      colorBarLabel: "Delta Pixel Density",
    });
  });

  test("formats signed ranges like export", () => {
    expect(formatHeatmapFigureRange(-0.5, 0.5, { signed: true })).toBe("-0.5 to +0.5");
  });
});
```

- [ ] **Step 2: Run the shared test and verify RED**

Run:

```bash
npm test -- shared/heatmapFigure.test.js
```

Expected: FAIL because `shared/heatmapFigure.js` does not exist.

- [ ] **Step 3: Implement the shared presentation module**

Create `shared/heatmapFigure.js` with pure functions. Tick positions use ratios
`[0, 0.25, 0.5, 0.75, 1]`; axis values round `(count - 1) * ratio`, and scale
values calculate `max - (max - min) * ratio`. Comparison labels use `Delta
Pixel Density` or `Delta Collagen Density (mg/ml)` according to the supplied
metric key.

The public text builder signature is:

```js
export function heatmapFigureText({
  currentImage,
  previousImage = null,
  metric,
  metricLabel,
  metricUnit,
  cellWidth,
  cellHeight,
  columns,
  rows,
  min,
  max,
  comparison = false,
  calibration,
}) {
  return {
    titleLines: [
      `Current: ${currentImage}`,
      ...(previousImage ? [`Previous: ${previousImage}`] : []),
    ],
    detailLine: `${metricLabel} | Cell ${cellWidth}x${cellHeight} px | Grid ${columns}x${rows}`,
    calibrationLine: heatmapCalibrationText(calibration),
    rangeLine: `Color range: ${formatHeatmapFigureRange(min, max, { signed: comparison })}${metricUnit ? ` ${metricUnit}` : ""}`,
    colorBarLabel: comparison
      ? metric === "pixel-density" ? "Delta Pixel Density" : "Delta Collagen Density (mg/ml)"
      : `${metricLabel} (${metricUnit || "ratio"})`,
  };
}
```

- [ ] **Step 4: Make ZIP export consume the shared rules**

In `server/exportHeatmaps.js`:

- import the shared tick, range, number, calibration, and text helpers;
- replace the private five-iteration calculations in `axisTicks` and `colorBar`;
- replace private `calibrationText`, `formatRange`, `formatSigned`, and
  `formatNumber` implementations with shared helpers or thin aliases;
- keep SVG dimensions, wrapping, Sharp rendering, archive names, and filenames unchanged.

Update `server/exportHeatmaps.test.js` to assert the existing SVG still contains
the same five axis labels, five scale labels, calibration text, and comparison
range after extraction.

- [ ] **Step 5: Run shared and export tests and verify GREEN**

Run:

```bash
npm test -- shared/heatmapFigure.test.js server/exportHeatmaps.test.js
```

Expected: both test files pass and existing export snapshots/markup assertions remain unchanged.

- [ ] **Step 6: Commit Task 1**

```bash
git add shared/heatmapFigure.js shared/heatmapFigure.test.js server/exportHeatmaps.js server/exportHeatmaps.test.js
git commit -m "refactor: share heatmap report presentation rules"
```

---

### Task 2: Interactive Heatmap Report Component

**Files:**
- Create: `src/components/HeatmapReport.jsx`
- Create: `src/components/HeatmapReport.test.jsx`
- Modify: `src/components/HeatmapOverlay.jsx`
- Modify: `src/components/HeatmapOverlay.test.jsx`

**Interfaces:**
- Consumes: all Task 1 helpers from `shared/heatmapFigure.js`.
- Produces: `HeatmapReport` with props:

```ts
{
  heatmap,
  metric,
  calibration,
  comparison,
  pointer,
  currentImageName,
  previousImageName,
  originalCanvasRef,
  originalOpacity
}
```

- Produces: plot element labeled `heatmap report plot`; this is the coordinate rectangle used for heatmap, TIFF, grid, and pointer hover.
- Preserves: `HeatmapOverlay` canvas and tooltip behavior.

- [ ] **Step 1: Write failing report component tests**

Create `src/components/HeatmapReport.test.jsx` using the existing 10x5 two-cell
heatmap fixture and Canvas 2D mock. Assert:

```jsx
render(
  <HeatmapReport
    heatmap={heatmap}
    metric="pixel-density"
    calibration={{ slope: 0.1, intercept: 0.01 }}
    comparison={null}
    pointer={{ x: 1, y: 1 }}
    currentImageName="scan-a"
    previousImageName={null}
    originalCanvasRef={{ current: null }}
    originalOpacity={0.5}
  />,
);

expect(screen.getByText("Current: scan-a")).toBeInTheDocument();
expect(screen.getByText("Pixel Density | Cell 5x5 px | Grid 2x1")).toBeInTheDocument();
expect(screen.getByText("Grid X")).toBeInTheDocument();
expect(screen.getByText("Grid Y")).toBeInTheDocument();
expect(screen.getAllByTestId("heatmap-x-tick")).toHaveLength(5);
expect(screen.getAllByTestId("heatmap-y-tick")).toHaveLength(5);
expect(screen.getAllByTestId("heatmap-scale-tick")).toHaveLength(5);
expect(screen.getByLabelText("heatmap cell grid")).toBeInTheDocument();
expect(screen.getByLabelText("heatmap original image")).toHaveStyle({ opacity: "0.5" });
expect(screen.getByRole("status")).toHaveTextContent("Row 1, Column 1");
```

Add a comparison case asserting current and previous lines, signed range,
blue-white-red scale class, and `Delta Pixel Density`.

- [ ] **Step 2: Run the report test and verify RED**

Run:

```bash
npm test -- src/components/HeatmapReport.test.jsx
```

Expected: FAIL because `HeatmapReport.jsx` does not exist.

- [ ] **Step 3: Implement the semantic report structure**

Create `HeatmapReport.jsx`:

```jsx
export default function HeatmapReport(props) {
  const range = props.comparison
    ? { min: -props.comparison.maxAbs, max: props.comparison.maxAbs, unit: heatmapDisplayRange(props.metric).unit }
    : heatmapDisplayRange(props.metric);
  const text = heatmapFigureText({
    currentImage: props.currentImageName,
    previousImage: props.comparison ? props.previousImageName : null,
    metric: props.metric,
    metricLabel: props.metric === "pixel-density" ? "Pixel Density" : "Estimated Collagen Density",
    metricUnit: range.unit,
    cellWidth: props.heatmap.cellWidth,
    cellHeight: props.heatmap.cellHeight,
    columns: props.heatmap.columns,
    rows: props.heatmap.rows,
    min: range.min,
    max: range.max,
    comparison: Boolean(props.comparison),
    calibration: props.calibration,
  });
  const xTicks = heatmapAxisTickValues(props.heatmap.columns);
  const yTicks = heatmapAxisTickValues(props.heatmap.rows);
  const scaleTicks = heatmapScaleTickValues(range.min, range.max);

  return (
    <figure className="heatmap-report" aria-label="heatmap report">
      <figcaption className="heatmap-report-header">
        {text.titleLines.map((line) => <strong key={line}>{line}</strong>)}
        <span>{text.detailLine}</span>
        <span>{text.calibrationLine}</span>
        <span>{text.rangeLine}</span>
      </figcaption>
      <div className="heatmap-report-body">
        <div className="heatmap-y-axis" aria-label="Grid Y axis">
          <span className="heatmap-axis-title">Grid Y</span>
          {yTicks.map((value, index) => (
            <span key={`${value}-${index}`} data-testid="heatmap-y-tick">{value}</span>
          ))}
        </div>
        <div className="heatmap-report-plot" aria-label="heatmap report plot">
          <HeatmapOverlay
            heatmap={props.heatmap}
            metric={props.metric}
            comparison={props.comparison}
            pointer={props.pointer}
          />
          <canvas
            ref={props.originalCanvasRef}
            className="raw-canvas heatmap-original-overlay"
            aria-label="heatmap original image"
            style={{ opacity: props.originalOpacity }}
          />
          <svg className="heatmap-cell-grid" aria-label="heatmap cell grid">
            {gridLines(props.heatmap).map((line) => (
              <line key={line.key} {...line.attributes} />
            ))}
          </svg>
        </div>
        <div className="heatmap-color-scale">
          <div
            className={props.comparison ? "heatmap-scale difference" : "heatmap-scale absolute"}
            aria-label={text.colorBarLabel}
          />
          <div className="heatmap-scale-ticks">
            {scaleTicks.map((value) => (
              <span key={value} data-testid="heatmap-scale-tick">
                {formatHeatmapFigureNumber(value)}
              </span>
            ))}
          </div>
          <span className="heatmap-scale-label">{text.colorBarLabel}</span>
        </div>
      </div>
      <div className="heatmap-x-axis" aria-label="Grid X axis">
        <span className="heatmap-axis-title">Grid X</span>
        {xTicks.map((value, index) => (
          <span key={`${value}-${index}`} data-testid="heatmap-x-tick">{value}</span>
        ))}
      </div>
    </figure>
  );
}
```

Render the raw TIFF canvas and existing `HeatmapOverlay` inside a
`position: relative` plot. Add an SVG grid with one vertical line for every
unique cell `x`, one horizontal line for every unique cell `y`, plus right and
bottom image edges. Use the heatmap's actual image-space positions so partial
edge cells stay registered. Implement `gridLines(heatmap)` in the same file as
a pure local helper returning `{ key, attributes }` entries with percentage
coordinates and an SVG `viewBox="0 0 100 100"`; export it only for its focused
unit test.

- [ ] **Step 4: Preserve hover redraw behavior**

Keep static heatmap coloring in `HeatmapOverlay`'s existing `useLayoutEffect`.
Pointer-only rerenders must not redraw cells. The tooltip becomes positioned
relative to `heatmap-report-plot`, but its value text and pointer-aware left/right
and above/below behavior remain unchanged.

Update `HeatmapOverlay.test.jsx` only where the new containing component changes
queries; retain the assertion that pointer-only updates do not call `fillRect`.

- [ ] **Step 5: Run component tests and verify GREEN**

Run:

```bash
npm test -- src/components/HeatmapReport.test.jsx src/components/HeatmapOverlay.test.jsx
```

Expected: report and overlay tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/components/HeatmapReport.jsx src/components/HeatmapReport.test.jsx src/components/HeatmapOverlay.jsx src/components/HeatmapOverlay.test.jsx
git commit -m "feat: add interactive heatmap report figure"
```

---

### Task 3: App Integration, Responsive Layout, And Visual Verification

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/App.test.jsx`
- Modify: `src/styles.css`
- Modify: `src/styles.test.js`
- Modify: `src/lib/stageFit.js`
- Modify: `src/lib/stageFit.test.js`

**Interfaces:**
- Consumes: `HeatmapReport` from Task 2.
- Produces: `heatmapReportAspect({ columns, rows, imageAspect }): number` in `src/lib/stageFit.js`.
- Preserves: `imageContentRect(canvasRef.current, event.currentTarget)` as pointer coordinate source.

- [ ] **Step 1: Write failing stage-fit tests**

Extend `src/lib/stageFit.test.js`:

```js
test("includes report header, axes, and scale around a square heatmap", () => {
  const aspect = heatmapReportAspect({ columns: 100, rows: 100, imageAspect: 1 });
  expect(aspect).toBeGreaterThan(1);
  expect(aspect).toBeLessThan(1.5);
});

test("keeps wide and tall plots bounded", () => {
  expect(heatmapReportAspect({ columns: 100, rows: 50, imageAspect: 2 })).toBeGreaterThan(1.5);
  expect(heatmapReportAspect({ columns: 50, rows: 100, imageAspect: 0.5 })).toBeLessThan(1);
});
```

Use explicit virtual report bands in the implementation: header `160`, left
axis `70`, right scale `190`, bottom axis `72`, and plot height `min(rows * 12,
1200)`. Plot width is `plot height * imageAspect`. Return total width divided by
total height. These values keep the plot dominant without viewport-font scaling.

- [ ] **Step 2: Write failing App and style tests**

Extend `src/App.test.jsx` to click Heat Map and assert:

- `heatmap report` appears after data loads;
- current folder/image name is present;
- changing Small 20x20 to Medium 50x50 updates Cell and Grid text;
- Compare Previous adds the previous name and delta scale;
- the old `heatmap color legend` sidebar element is absent;
- the raw canvas is inside `heatmap report plot` and keeps the selected opacity;
- moving over the report header does not create a cell tooltip;
- moving over the plot still reports the correct row and column;
- no ROI/bounds overlay appears in Heat Map mode.

Extend `src/styles.test.js` to require this order:

```css
.heatmap-overlay { z-index: 1; }
.raw-canvas.heatmap-original-overlay { z-index: 2; }
.heatmap-cell-grid { z-index: 3; pointer-events: none; }
.heatmap-tooltip { z-index: 5; }
```

Also assert `.heatmap-report` has bounded width/height, `.heatmap-report-plot`
uses `overflow: hidden`, and report text permits wrapping without overlap.

- [ ] **Step 3: Run App/style/stage tests and verify RED**

Run:

```bash
npm test -- src/App.test.jsx src/styles.test.js src/lib/stageFit.test.js
```

Expected: FAIL because App still renders the old overlay and sidebar legend.

- [ ] **Step 4: Integrate the report into App**

In `src/App.jsx`:

- import `HeatmapReport` and `heatmapReportAspect`;
- derive `activeStageAspect` from the report helper only when Heat Map data is loaded;
- make the ResizeObserver stage fit depend on `activeStageAspect`;
- render the raw canvas inside `HeatmapReport` in Heat Map mode and in its old
  position for every other mode;
- add `imageLayer` to the raw-canvas drawing effect so a newly mounted canvas is
  rendered immediately after layer changes;
- pass current and previous display names, calibration, comparison, pointer,
  canvas ref, and opacity to the report;
- remove the old sidebar `heatmap-legend` block;
- retain heatmap controls, loading/error status, presets, Compare Previous, and
  Original opacity controls.

Pointer conversion remains:

```js
eventToImagePoint(event, activeImage, {
  contentRect: imageContentRect(canvasRef.current, event.currentTarget),
});
```

The raw canvas is now exactly the report plot rectangle, so events over title,
axes, or color bar return `null` while plot events map correctly.

- [ ] **Step 5: Add responsive report styling**

In `src/styles.css`:

- give `.image-stage.heatmap-report-stage` a white report background;
- make `.heatmap-report` fill the stage using a constrained grid layout;
- use compact header type, zero negative letter spacing, and wrapping lines;
- reserve fixed responsive bands for Y axis, plot, and color bar;
- keep the plot at the source image aspect and center it;
- render the vertical inferno or difference gradient outside the plot;
- render grid lines in translucent white/black contrast so they remain visible
  over both dark and light cells;
- use media queries to narrow, not remove, axes and color bar on mobile;
- ensure every report decoration has `pointer-events: none`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm test -- shared/heatmapFigure.test.js src/components/HeatmapReport.test.jsx src/components/HeatmapOverlay.test.jsx src/lib/stageFit.test.js src/styles.test.js src/App.test.jsx server/exportHeatmaps.test.js
```

Expected: all focused tests pass.

- [ ] **Step 7: Run full automated verification**

Run:

```bash
npm test -- --exclude '.worktrees/**'
npm run build
git diff --check
```

Expected: all tests pass, Vite production build succeeds, and diff check emits no output.

- [ ] **Step 8: Verify visually in the browser**

Start the server and Vite client on free ports. Inspect at minimum:

- desktop `1440x900`;
- compact desktop `1024x768`;
- mobile `390x844`.

For each viewport verify:

- report title and calibration do not overlap;
- plot remains the largest report area;
- Grid X/Y labels and five ticks are readable;
- the color bar remains outside the plot;
- TIFF opacity changes only the plot;
- cell grid remains visible at 20, 50, and 100 pixel presets;
- hover targets the expected cell;
- comparison title/range/scale update without hiding opacity controls;
- Prev/Next retains the chosen preset and report layout.

Capture screenshots for desktop absolute, desktop comparison, and mobile
absolute views. Check the browser console for errors and the canvas for nonblank
pixels.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/App.jsx src/App.test.jsx src/styles.css src/styles.test.js src/lib/stageFit.js src/lib/stageFit.test.js
git commit -m "feat: show heatmaps as interactive reports"
```

---

### Task 4: Final Review And Delivery

**Files:**
- Review: all files changed since `origin/main`
- Modify only if review finds a concrete defect.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: merge-ready branch with reviewed behavior and green verification.

- [ ] **Step 1: Request a whole-branch code review**

Review `origin/main...HEAD` for:

- export/client text or tick drift;
- report geometry and pointer-coordinate errors;
- canvas remount/redraw regressions;
- comparison range/unit mistakes;
- accessibility and responsive overflow;
- missing tests from the acceptance criteria.

- [ ] **Step 2: Fix Critical and Important findings with focused RED/GREEN tests**

For each valid finding, add the smallest failing test, implement the correction,
rerun the focused test, and request scoped re-review. Do not bundle unrelated
refactors.

- [ ] **Step 3: Re-run final verification**

```bash
npm test -- --exclude '.worktrees/**'
npm run build
git diff --check
git status --short --branch
```

Expected: all tests and build pass; only intentional branch commits differ from `origin/main`.

- [ ] **Step 4: Finish the branch**

Use `superpowers:finishing-a-development-branch` to offer local merge, PR, or
keep-as-is. Do not push or merge without the user's selected integration option.
