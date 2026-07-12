# Heatmap Display Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Heat Map mode fade only the original TIFF, suppress boundary editing overlays and mutations, and place the density legend in the side panel.

**Architecture:** Preserve the existing two-canvas stage and move opacity ownership from `HeatmapOverlay` to the raw TIFF canvas in `App`. Treat Heat Map as a read-only inspection mode for bounds while retaining pointer movement for cell tooltips. Keep the legend in the existing Heatmap panel so it never occupies image pixels.

**Tech Stack:** React 18, HTML canvas, CSS, Vitest, Testing Library, jsdom

## Global Constraints

- Heatmap colors render at full opacity.
- `Original opacity` applies only in Heat Map, defaults to `0.5`, accepts `0..1`, and persists under a new localStorage key.
- Original, Mask, and Fiber QC rendering remain unchanged.
- Heat Map cannot show or mutate points, polygons, ROI bands, or migration vectors.
- Point and ROI editor state returns unchanged after leaving Heat Map.
- The density legend lives inside `Heatmap controls` and outside `image-stage`.
- Do not add dependencies or change server APIs.

---

### Task 1: Render Heatmap Cells at Full Opacity

**Files:**
- Modify: `src/components/HeatmapOverlay.test.jsx:40-119`
- Modify: `src/components/HeatmapOverlay.jsx:11-42`

**Interfaces:**
- Consumes: `HeatmapOverlay({ heatmap, metric, calibration, comparison, pointer })`
- Produces: a heatmap canvas that always draws with `context.globalAlpha = 1`

- [ ] **Step 1: Write the failing test**

Remove the `opacity` prop from every component render. Initialize the mocked context with `globalAlpha: 0.25`, then assert:

```jsx
expect(context.globalAlpha).toBe(1);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run src/components/HeatmapOverlay.test.jsx
```

Expected: FAIL because the current component assigns the absent `opacity` prop to `globalAlpha`.

- [ ] **Step 3: Implement the minimal renderer change**

Apply these exact line replacements:

```diff
-export default function HeatmapOverlay({ heatmap, metric, calibration, comparison, opacity, pointer }) {
+export default function HeatmapOverlay({ heatmap, metric, calibration, comparison, pointer }) {

 context.imageSmoothingEnabled = false;
+context.globalAlpha = 1;
 context.clearRect(0, 0, heatmap.width, heatmap.height);

-context.globalAlpha = opacity;

-}, [calibration, comparison, heatmap, metric, opacity, range.max, range.min]);
+}, [calibration, comparison, heatmap, metric, range.max, range.min]);
```

- [ ] **Step 4: Verify GREEN**

Run `npx vitest run src/components/HeatmapOverlay.test.jsx`.

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/HeatmapOverlay.jsx src/components/HeatmapOverlay.test.jsx
git commit -m "fix: keep heatmap colors fully opaque"
```

---

### Task 2: Control Original Opacity and Relocate the Legend

**Files:**
- Modify: `src/App.test.jsx:1080-1290`
- Modify: `src/styles.test.js:4-23`
- Modify: `src/App.jsx:31-55,158-180,355-362,1209-1270,1527-1578`
- Modify: `src/styles.css:359-417,594-643`

**Interfaces:**
- Consumes: `readStoredOpacity(key, fallback)` and the current heatmap metric/range state
- Produces: `heatmapOriginalOpacity: number`, stored as `raw16-editor-heatmap-original-opacity`
- Produces: `Original opacity` control and a horizontal side-panel legend

- [ ] **Step 1: Write failing opacity tests**

```jsx
test("controls only the original TIFF opacity while Heat Map is active", async () => {
  mockApi();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
  const rawCanvas = screen.getByLabelText("raw16 image");
  const heatmapCanvas = await screen.findByLabelText("heatmap overlay");
  expect(screen.getByLabelText("Original opacity")).toHaveValue("0.5");
  expect(rawCanvas).toHaveStyle({ opacity: "0.5" });
  fireEvent.change(screen.getByLabelText("Original opacity"), { target: { value: "0" } });
  expect(rawCanvas).toHaveStyle({ opacity: "0" });
  expect(heatmapCanvas).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Original" }));
  expect(rawCanvas).toHaveStyle({ opacity: "1" });
});

test("restores persisted Heat Map original opacity after remount", async () => {
  mockApi();
  const first = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
  fireEvent.change(screen.getByLabelText("Original opacity"), { target: { value: "0.35" } });
  first.unmount();
  mockApi();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
  expect(screen.getByLabelText("Original opacity")).toHaveValue("0.35");
});
```

- [ ] **Step 2: Write failing legend placement and CSS tests**

```jsx
const controls = screen.getByLabelText("Heatmap controls");
const stage = screen.getByTestId("image-stage");
expect(within(controls).getByLabelText("heatmap color legend")).toBeInTheDocument();
expect(within(stage).queryByLabelText("heatmap color legend")).not.toBeInTheDocument();
```

```js
const legendRule = css.match(/\.heatmap-legend\s*\{[^}]+\}/)?.[0] ?? "";
expect(legendRule).not.toContain("position: absolute");
expect(legendRule).toContain("grid-template-columns");
```

- [ ] **Step 3: Verify RED**

Run `npx vitest run src/App.test.jsx src/styles.test.js`.

Expected: FAIL because `Original opacity` is absent and the legend is inside the stage with absolute positioning.

- [ ] **Step 4: Implement opacity state and canvas isolation**

```jsx
const HEATMAP_ORIGINAL_OPACITY_KEY = "raw16-editor-heatmap-original-opacity";

const [heatmapOriginalOpacity, setHeatmapOriginalOpacity] = useState(() =>
  readStoredOpacity(HEATMAP_ORIGINAL_OPACITY_KEY, 0.5),
);

useEffect(() => {
  localStorage.setItem(HEATMAP_ORIGINAL_OPACITY_KEY, String(heatmapOriginalOpacity));
}, [heatmapOriginalOpacity]);
```

Apply `style={{ opacity: imageLayer === "heatmap" ? heatmapOriginalOpacity : 1 }}` to the raw TIFF canvas. Remove the `opacity` prop from `HeatmapOverlay`.

- [ ] **Step 5: Replace the control and move the existing legend JSX**

```jsx
<label htmlFor="heatmap-original-opacity">
  Original opacity
  <input
    id="heatmap-original-opacity"
    type="range"
    min="0"
    max="1"
    step="0.05"
    value={heatmapOriginalOpacity}
    onChange={(event) => setHeatmapOriginalOpacity(Number(event.target.value))}
  />
</label>
```

Move the complete `heatmap color legend` block below `heatmap-display-actions` and before `heatmap-view-state`. Preserve the current/comparison values and accessible maximum-zero-minimum order.

- [ ] **Step 6: Convert the legend to a horizontal panel scale**

```css
.heatmap-legend {
  display: grid;
  grid-template-columns: minmax(54px, auto) minmax(0, 1fr) minmax(54px, auto);
  align-items: center;
  gap: 7px;
  width: 100%;
  color: #c6d0d9;
  font-size: 0.7rem;
  line-height: 1.1;
  pointer-events: none;
}

.heatmap-legend-scale {
  position: relative;
  width: 100%;
  height: 12px;
}

.heatmap-legend-scale i {
  position: absolute;
  inset: 0;
  border: 1px solid rgba(255, 255, 255, 0.28);
  background: linear-gradient(to right, #000004, #57106e 25%, #bc3754 50%, #f98e09 75%, #fcffa4);
}
```

Use blue-white-red from left to right for comparison and position `.heatmap-legend-zero` at `left: 50%` below the bar.

- [ ] **Step 7: Verify GREEN and commit**

Run `npx vitest run src/App.test.jsx src/styles.test.js`.

Expected: all App and CSS tests pass.

```bash
git add src/App.jsx src/App.test.jsx src/styles.css src/styles.test.js
git commit -m "feat: control Heat Map background visibility"
```

---

### Task 3: Make Heat Map Read-Only for Bounds

**Files:**
- Modify: `src/App.test.jsx:520-620,1520-1820`
- Modify: `src/App.jsx:550-574,660-675,893-922,1459-1497,1579-1687`

**Interfaces:**
- Consumes: `imageLayer`
- Produces: navigation and heatmap hover in Heat Map with every bounds mutation path disabled

- [ ] **Step 1: Write the failing visibility test**

```jsx
expect(await screen.findByLabelText("Bounds overlay")).toBeInTheDocument();
expect(screen.getByLabelText("Point opacity")).toBeInTheDocument();
expect(screen.getByLabelText("Show ROI")).toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: "Heat Map" }));
expect(screen.queryByLabelText("Bounds overlay")).not.toBeInTheDocument();
expect(screen.queryByLabelText("Point opacity")).not.toBeInTheDocument();
expect(screen.queryByLabelText("Show ROI")).not.toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: "Original" }));
expect(screen.getByLabelText("Bounds overlay")).toBeInTheDocument();
```

- [ ] **Step 2: Write the failing mutation test**

Record `screen.getAllByLabelText(/^Vertex /).length`, enter Heat Map, and set the stage rectangle with:

```jsx
const stage = screen.getByTestId("image-stage");
vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
  left: 0,
  top: 0,
  right: 100,
  bottom: 80,
  width: 100,
  height: 80,
  x: 0,
  y: 0,
  toJSON: () => {},
});
```

Move and click at `(30, 30)`, then dispatch `KeyP`, `KeyD`, and `KeyM`. Assert `Clean` remains visible. Return to Original and assert the vertex count is unchanged.

- [ ] **Step 3: Verify RED**

Run `npx vitest run src/App.test.jsx`.

Expected: FAIL because editor controls/SVG are visible and click/keyboard handlers still mutate bounds.

- [ ] **Step 4: Guard all Heat Map mutation paths**

Keep ArrowLeft/ArrowRight navigation. Add `imageLayer !== "heatmap"` to the `KeyP`, `KeyD`, and `KeyM` branches. In `handleStagePointerMove`, mutate a dragged point only when `dragPoint && imageLayer !== "heatmap"`. Start `handleStageClick` with:

```jsx
if (!hasActiveImageDimensions || imageLayer === "heatmap") return;
```

- [ ] **Step 5: Hide editor controls and the complete bounds SVG**

Wrap `Point opacity` and `Show ROI` with `imageLayer !== "heatmap"`. Change the SVG condition to:

```jsx
activeImage && hasActiveImageDimensions && bounds && imageLayer !== "heatmap"
```

Do not alter the existing SVG children, point-order data, group visibility state, or `showRoiOverlay` state.

- [ ] **Step 6: Verify GREEN and commit**

Run `npx vitest run src/App.test.jsx`.

Expected: all App tests pass.

```bash
git add src/App.jsx src/App.test.jsx
git commit -m "fix: isolate Heat Map from boundary editing"
```

---

### Task 4: Regression and Visual Verification

**Files:**
- Verify: `src/App.jsx`
- Verify: `src/components/HeatmapOverlay.jsx`
- Verify: `src/styles.css`

**Interfaces:**
- Consumes: Tasks 1-3
- Produces: a tested build and one browser screenshot

- [ ] **Step 1: Run all automated checks**

```bash
npx vitest run --exclude '.worktrees/**'
npm run build
git diff --check
```

Expected: every test passes, Vite exits `0`, and the diff check has no output.

- [ ] **Step 2: Restart and check the server**

Restart the process with `PORT=52931 node server/index.js`, then verify `curl http://localhost:52931/` returns HTTP `200`.

- [ ] **Step 3: Verify in the in-app browser**

Open a generated heatmap and check 50% default original visibility, 0% original visibility, full heatmap color, hover tooltip, absent bounds/ROI/vector overlays, horizontal side-panel legend, and restoration in Original mode. Capture one screenshot at partial original opacity.

- [ ] **Step 4: Review final scope**

```bash
git status --short --branch
git diff --stat HEAD~3..HEAD
git log --oneline -4
```

Expected: only planned client, test, CSS, spec, and plan files are tracked.
