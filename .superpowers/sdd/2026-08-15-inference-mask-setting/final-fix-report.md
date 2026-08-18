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

## Residual Re-review Fix

### Stale Image-list Response Guard

The final scoped re-review found that an in-flight `GET /api/inference/images` could resolve after a root switch and call `confirmActiveRoot()` with the old payload root. That restored the prior root path, rows, and selection-driven review state despite the new root already being active.

The page now:

- Invalidates outstanding image-list requests when a root switch begins.
- Rejects image-list responses while a root change is pending.
- Captures the confirmed root, root generation, and monotonically increasing list request ID for every request.
- Applies a response only when all captured identities still match and the payload root matches the captured confirmed root.
- Invalidates concurrent requests again whenever the confirmed root identity changes.

The regression holds the second, polling-driven old-root image-list response, switches to `/new/root`, confirms the new row, releases the old response, and verifies that neither `/data/inference` nor the old row returns.

### Residual TDD Evidence

Red result before implementation:

```text
Test Files  1 failed (1)
Tests       1 failed | 22 passed (23)
```

The failure showed the root input reverting from `/new/root` to `/data/inference` after releasing the held response.

Final focused page result:

```text
Test Files  1 passed (1)
Tests       23 passed (23)
```

Affected server result:

```text
Test Files  2 passed (2)
Tests       83 passed (83)
```

Full verification:

```text
Test Files  30 passed (30)
Tests       509 passed (509)
```

The Vite production build also succeeded with 41 modules transformed.

### Residual Files Changed

- `src/InferencePage.jsx`
- `src/InferencePage.test.jsx`
- `docs/solutions/ui-bugs/async-review-responses-must-match-active-selection.md`
- `.superpowers/sdd/2026-08-15-inference-mask-setting/final-fix-report.md`

`ce-compound` remained unavailable, so the existing async review learning was extended with the list-request generation rule and delayed old-root polling regression pattern.

## P2 Stale List-error Residual

### Finding

The fulfilled image-list path checked request and root identity, but `fetch()` or `readJsonResponse()` could reject before reaching that check. Initial and polling callers caught the stale rejection while mounted and rendered its message on the newly selected root.

### Fix

- Reused one request-authority predicate for both fulfilled and rejected image-list requests.
- Stale failures now resolve as ignored before caller error handlers run.
- Failures from the latest request for the current confirmed root are rethrown unchanged, preserving existing error behavior.

The regression holds an old-root polling request, switches to `/new/root`, rejects the old request, and verifies that the new root and row remain active without an alert.

### TDD Evidence

Red result:

```text
Test Files  1 failed (1)
Tests       1 failed | 23 passed (24)
```

The failure rendered `Old root image list failed.` after the new root was active.

Final page result:

```text
Test Files  1 passed (1)
Tests       24 passed (24)
```

Full verification:

```text
Test Files  30 passed (30)
Tests       510 passed (510)
```

The Vite production build succeeded with 41 modules transformed.

### Files Changed

- `src/InferencePage.jsx`
- `src/InferencePage.test.jsx`
- `docs/solutions/ui-bugs/async-review-responses-must-match-active-selection.md`
- `.superpowers/sdd/2026-08-15-inference-mask-setting/final-fix-report.md`

`ce-compound` remained unavailable, so the existing async review learning now records that request identity must guard both fulfilled payloads and rejected promises.

## P2 Stale Job-poll Continuation Residual

### Finding

An old-root `pollJob()` could receive a job response, publish that job, and then wait on its image-list refresh. If a root switch invalidated the refresh, `loadImages()` correctly returned an ignored result, but the parent poll continuation still published the old terminal message or scheduled another old-root poll.

### Fix

- Captured the confirmed root path and root generation once when a polling chain starts.
- Rechecked that immutable polling context before fetching, after the job response, after the image refresh, in error handling, and before terminal messaging or recursive scheduling.
- Passed the same context into every scheduled poll so a later root cannot adopt an earlier polling chain.
- Preserved normal active-root polling behavior.

The regression holds the image-list refresh initiated by a completed old-root job poll, switches to `/new/root`, rejects the held refresh, and verifies that no old terminal message appears and no further old-job poll is scheduled.

### TDD Evidence

Red result:

```text
Test Files  1 failed (1)
Tests       1 failed | 24 passed (25)
```

The failure showed `Inference complete: 1 complete, 0 failed` on the new root after releasing the held old-root refresh.

Final page result:

```text
Test Files  1 passed (1)
Tests       25 passed (25)
```

Full verification:

```text
Test Files  30 passed (30)
Tests       511 passed (511)
```

The Vite production build succeeded with 41 modules transformed.

### Files Changed

- `src/InferencePage.jsx`
- `src/InferencePage.test.jsx`
- `docs/solutions/ui-bugs/async-review-responses-must-match-active-selection.md`
- `.superpowers/sdd/2026-08-15-inference-mask-setting/final-fix-report.md`

`ce-compound` remained unavailable, so the durable async review note now records that parent polling continuations must retain and recheck the same root authority after every awaited child operation.
