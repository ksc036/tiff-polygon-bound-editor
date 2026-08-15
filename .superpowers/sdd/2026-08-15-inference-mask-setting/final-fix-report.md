# Final Review Fix Report

## Scope

Resolved the four final review findings without changing the inference workflow beyond the requested persistence ordering, root isolation, overlay validity, and threshold-grid semantics.

## Delivered

### 1. Save Before Mask Generation

- `Generate masks` now awaits the active threshold persistence promise.
- Generation does not start when threshold validation or persistence fails.
- The existing shared save-promise path is reused, so blur and generate cannot issue competing saves.

Regression coverage holds the threshold PUT open and asserts generation has not started, then separately returns a failed save and asserts generation remains aborted.

### 2. Root-Isolated Transient State

- All typed and picker root routes now pass through the inference service root-change guard.
- Root changes return `409 JOB_IN_PROGRESS` while inference is active.
- A successful root change clears transient jobs and source states.
- Source state is keyed by the full root-derived image path rather than an id that can collide across roots.
- Jobs retain an internal root identity; job lookup rejects jobs outside the current root, while the internal path is omitted from public responses.
- Jobs process the source list captured for their starting root.
- The page disables root editing and both root actions during an active job.
- A server-confirmed root change resets image selection, review, ROI selection, raw image, overlay, job status, and action messages before loading the new root.

Regression coverage switches between two roots containing the same timestamp folder and filename, proving that the shared opaque id does not carry failed source state, completed jobs, review values, or ROI selection into the next root. API tests cover both typed and picker aliases.

### 3. Overlay Identity and Invalidation

- Overlay state now stores `rootPath`, `imageId`, and normalized `threshold` beside the blob URL.
- Rendering requires all three identity fields to match the active review.
- Threshold and source handlers invalidate the overlay synchronously.
- Existing effect cleanup continues to revoke replaced and unmounted object URLs.

Regression coverage delays replacement overlay responses and verifies that the previous overlay disappears immediately after both threshold and source changes.

### 4. One Threshold Grid

- UI and service normalize valid thresholds to the nearest `0.001` with the same rule.
- The normalized value is used for UI display, threshold persistence, review metrics, overlay requests/rendering, reference-derived settings, and generated masks.
- Existing valid off-grid settings are normalized when loaded, so review and mask semantics cannot diverge even before the file is saved again.

Regression coverage sends `0.1236` through service persistence and verifies `0.124` in the saved settings, review metrics, overlay pixels, and generated mask pixels. UI coverage verifies `0.7236` becomes `0.724` for both the request body and overlay query.

## TDD Evidence

Initial focused red run:

```text
Test Files  3 failed (3)
Tests       10 failed | 93 passed (103)
```

The failures directly covered the absent root guard/reset, off-grid normalization, save-before-generate ordering, save-failure abort, overlay invalidation, root-state reset, and active-job root controls.

Final focused run:

```text
Test Files  3 passed (3)
Tests       105 passed (105)
```

Command:

```bash
npm test -- server/inferenceService.test.js server/app.test.js src/InferencePage.test.jsx
```

## Full Verification

```bash
npm test
```

Result: 30 test files passed; 508 tests passed.

```bash
npm run build
```

Result: Vite production build succeeded with 41 modules transformed.

## Files Changed

- `server/app.js`
- `server/app.test.js`
- `server/inferenceService.js`
- `server/inferenceService.test.js`
- `src/InferencePage.jsx`
- `src/InferencePage.test.jsx`
- `docs/solutions/ui-bugs/async-review-responses-must-match-active-selection.md`
- `.superpowers/sdd/2026-08-15-inference-mask-setting/final-fix-report.md`

## Compound Fallback

`ce-compound` was unavailable in the environment. Per the repository instruction fallback, the existing async inference review learning was updated with the reusable root identity, overlay identity, dependent-save, and threshold-normalization rules.
