# Inference Source Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the selected source TIFF before inference and let users select original, overlay, or mask-only stage modes.

**Architecture:** Keep `activeImageId` as the selection for every inference row, not only completed rows. Use the existing raw16 endpoint for the selected source regardless of status; keep review, threshold, and binary-overlay loading restricted to completed sources. A local `stageView` state determines which already-loaded layers are visible.

**Tech Stack:** React, Vitest, Testing Library, existing Express raw16 and overlay endpoints.

## Global Constraints

- Reuse opaque inference image IDs and the existing `/raw16` and `/overlay` endpoints.
- Do not request or display a probability-map overlay before an image has `complete` status.
- `Original`, `Overlay`, and `Mask` are explicit user-selected buttons.
- Do not alter threshold, ROI, propagation, or mask-generation semantics.

---

### Task 1: Make source selection and stage modes independent from inference completion

**Files:**
- Modify: `src/InferencePage.jsx:45-275,485-525`
- Test: `src/InferencePage.test.jsx`

**Interfaces:**
- Consumes: `images: Array<{ id: string, status: string }>` and `GET /api/inference/images/:id/raw16`.
- Produces: `activeImageId` for any listed image, `activeCompleteImage` for completed-only controls, and `stageView: "original" | "overlay" | "mask"`.

- [ ] **Step 1: Write the failing tests**

```jsx
test("renders a waiting source TIFF immediately after selection", async () => {
  mockInferenceApi({ images: [{ id: "waiting-a", timestampFolder: "001", imageFile: "waiting.tif", status: "waiting" }] });
  render(<InferencePage />);
  await waitFor(() => expect(screen.getByLabelText("Original source image")).toHaveAttribute("width", "2"));
});

test("switches completed sources among original overlay and mask-only views", async () => {
  mockInferenceApi({ images: [baseImages[1]] });
  render(<InferencePage />);
  await screen.findByAltText("Binary mask overlay");
  fireEvent.click(screen.getByRole("button", { name: "Original" }));
  expect(screen.queryByAltText("Binary mask overlay")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Mask" }));
  expect(screen.getByAltText("Binary mask")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/InferencePage.test.jsx`

Expected: FAIL because waiting rows are disabled and no stage-mode buttons or mask-only rendering exist.

- [ ] **Step 3: Write minimal implementation**

```jsx
const [stageView, setStageView] = useState("overlay");
const activeImage = useMemo(
  () => images.find((image) => image.id === activeImageId) ?? null,
  [activeImageId, images],
);
const activeCompleteImage = activeImage?.status === "complete" ? activeImage : null;
```

Load raw16 using `activeImage` instead of `activeCompleteImage`. Keep review and overlay fetches behind `activeCompleteImage`. Render the canvas in `original` and `overlay`, the existing overlay image in `overlay`, and that image alone with `alt="Binary mask"` in `mask`. Waiting and failed sources retain the canvas in `overlay`, while `mask` displays an unavailable message.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/InferencePage.test.jsx`

Expected: PASS, including the new waiting-source and stage-switch cases.

- [ ] **Step 5: Commit**

```bash
git add src/InferencePage.jsx src/InferencePage.test.jsx
git commit -m "feat: preview inference sources before completion"
```

### Task 2: Keep probability-map controls completed-only

**Files:**
- Modify: `src/InferencePage.test.jsx`
- Test: `src/InferencePage.test.jsx`

**Interfaces:**
- Consumes: `activeImage` and `activeCompleteImage` produced by Task 1.
- Produces: regression coverage that a waiting source remains selectable without enabling probability-map controls.

- [ ] **Step 1: Write the failing test**

```jsx
test("keeps threshold and mask actions unavailable for a selected waiting source", async () => {
  mockInferenceApi({ images: [{ id: "waiting-a", timestampFolder: "001", imageFile: "waiting.tif", status: "waiting" }] });
  render(<InferencePage />);
  await screen.findByLabelText("Original source image");
  expect(screen.getByLabelText("Threshold")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Generate masks" })).toBeDisabled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/InferencePage.test.jsx`

Expected: FAIL if a waiting source accidentally enables probability-map-only actions.

- [ ] **Step 3: Write minimal implementation**

Keep every completed-only control bound to `activeCompleteImage`; disable `Generate masks` when `completeImages.length === 0`, and leave threshold, ROI, propagation, and review navigation unavailable when no completed source is selected.

- [ ] **Step 4: Run focused and full verification**

Run: `npx vitest run src/InferencePage.test.jsx && npm test && npm run build`

Expected: all focused tests, full test suite, and Vite production build pass.

- [ ] **Step 5: Commit**

```bash
git add src/InferencePage.test.jsx src/InferencePage.jsx
git commit -m "test: protect incomplete inference review controls"
```
