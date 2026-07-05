# Mask ROI Preview Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users switch the editor view between the original TIFF and selected mask, and toggle a visible ROI band overlay on top of the image.

**Architecture:** Add server-rendered PNG preview endpoints so the browser does not duplicate mask decoding or ROI geometry. The React editor keeps the existing raw16 canvas and layers mask/ROI images above it with explicit controls in the existing toolbar.

**Tech Stack:** Express, Sharp, React, Vitest, Testing Library.

---

### Task 1: Server Preview PNG Endpoints

**Files:**
- Create: `server/previewLayers.js`
- Modify: `server/analysisService.js`
- Modify: `server/app.js`
- Test: `server/app.test.js`

- [ ] **Step 1: Write failing endpoint tests**

Add tests proving:

```js
const maskResponse = await request(app, `/api/images/${folderName}/mask-preview`);
expect(maskResponse.status).toBe(200);
expect(maskResponse.headers.get("content-type")).toContain("image/png");
expect(maskResponse.headers.get("x-mask-file")).toBe("frame001.png");

const roiResponse = await jsonRequest(app, `/api/images/${folderName}/roi-overlay`, {
  method: "POST",
  body: { bounds: validBounds(folderName), roiBands },
});
expect(roiResponse.status).toBe(200);
expect(roiResponse.headers.get("content-type")).toContain("image/png");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- server/app.test.js`

Expected: FAIL because `/mask-preview` and `/roi-overlay` do not exist.

- [ ] **Step 3: Implement preview generation**

Create `server/previewLayers.js` with:

```js
export async function createMaskPreview(storage, id, { maxImagePixels } = {}) {
  // Select the same mask source used by analysis, read it as binary mask,
  // write a black/white PNG buffer, and return headers.
}

export async function createRoiOverlay(storage, id, { bounds, roiBands, maxImagePixels } = {}) {
  // Resolve dimensions, assign outward ROI pixels, and render transparent
  // RGBA bands for near/mid/far.
}
```

Expose the analysis mask selector from `server/analysisService.js`, then wire both functions into `server/app.js`.

- [ ] **Step 4: Run endpoint tests**

Run: `npm test -- server/app.test.js`

Expected: PASS.

### Task 2: Editor Layer Controls

**Files:**
- Modify: `src/App.test.jsx`
- Modify: `src/App.jsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Write failing UI tests**

Add tests proving:

```jsx
expect(screen.getByRole("button", { name: "Original" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Mask" })).toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: "Mask" }));
expect(await screen.findByAltText("mask preview")).toHaveAttribute("src", "/api/images/scan-a/mask-preview");

expect(screen.getByLabelText(/show roi/i)).toBeChecked();
await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
  "/api/images/scan-a/roi-overlay",
  expect.objectContaining({ method: "POST" }),
));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/App.test.jsx`

Expected: FAIL because the controls and overlay image do not exist.

- [ ] **Step 3: Implement controls and layered rendering**

Add `imageLayer`, `showRoiOverlay`, and `roiOverlayUrl` state. Keep the raw16 canvas mounted for coordinate mapping, show a mask `<img>` when `imageLayer === "mask"`, and fetch the ROI overlay as a blob object URL whenever the active image, current bounds, ROI limits, or overlay toggle changes.

- [ ] **Step 4: Style controls and overlays**

Use the existing dark toolbar style: segmented buttons for Original/Mask, checkbox for ROI, absolute positioned mask/ROI images with `pointer-events: none`.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- server/app.test.js src/App.test.jsx`

Expected: PASS.

### Task 3: Verification And Push

**Files:**
- Existing changed files only.

- [ ] **Step 1: Full verification**

Run:

```bash
npm test
npm run build
```

Expected: all tests pass and Vite build exits 0.

- [ ] **Step 2: Browser verification**

Run the server against `/Users/ksc/Downloads/selected-stack-sequence`, open the app, and verify that Original/Mask switching and ROI overlay visibility work without layout overlap.

- [ ] **Step 3: Commit and push**

Run:

```bash
git add docs/superpowers/plans/2026-07-05-mask-roi-preview-layers.md server src
git commit -m "feat: add mask and roi preview layers"
git push
```
