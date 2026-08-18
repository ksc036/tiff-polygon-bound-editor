# Task 2 Report

## Scope

Implemented Task 2 of the inference source-preview plan in the `inference-mask-setting` worktree, keeping the change narrowly focused on completed-only review control regression coverage.

## Initial TDD Result

1. Added a regression test for a selected waiting source with no completed images.
2. Ran the focused Vitest target for the new test.
3. Observed that the new test passed immediately because Task 1's `activeImage` / `activeCompleteImage` split already keeps review-only controls gated to completed images.
4. Made no production-code changes because the existing implementation already satisfied the requirement.

## Review Findings Addressed

Review feedback identified a missing transition case: the original Task 2 regression only covered a waiting-only dataset, not the state change from an already selected completed image with a visible overlay into a waiting image row.

That transition exposed a real bug:

- `Generate masks` stayed enabled after selecting a waiting source when another completed image still existed in the list.

## Fix Round 1 TDD Result

1. Added a transition regression starting from a completed image with the binary overlay visible.
2. Clicked a waiting source in the test and asserted:
   - the raw TIFF remained visible,
   - threshold and generation controls were unavailable,
   - ROI controls were absent,
   - no stale overlay remained rendered,
   - no overlay request was issued for the waiting image.
3. Ran the focused test and observed the expected failure: `Generate masks` was still enabled.
4. Applied the minimal implementation fix by binding mask-generation availability to `activeCompleteImage` instead of `completeImages.length`.
5. Re-ran focused and full verification successfully.

## Changes

- Updated `src/InferencePage.jsx`
  - Disabled `Generate masks` unless the selected row is a completed source.
  - Guarded `handleGenerateMasks` against waiting/non-complete selections.

- Updated `src/InferencePage.test.jsx`
  - Added coverage asserting that a waiting-only selection keeps:
    - `Threshold` disabled
    - `Set other thresholds from reference` disabled
    - `Generate masks` disabled
    - completed-image navigation disabled
    - ROI controls absent
  - Added a completed-to-waiting transition regression that verifies review controls clear and stale overlays are neither shown nor requested for waiting rows.

## Verification

- Focused:
  - `npx vitest run src/InferencePage.test.jsx -t "keeps threshold and mask actions unavailable for a selected waiting source"`
  - `npx vitest run src/InferencePage.test.jsx -t "(keeps threshold and mask actions unavailable for a selected waiting source|clears completed-only review controls and stale overlay when switching from a completed source to waiting)"`
- Full:
  - `npm test`
  - `npm run build`

All verification passed on August 17, 2026.

## Outcome

Task 2 is complete with the missing transition regression covered and the completed-only mask-generation guard fixed. `activeCompleteImage` now consistently controls review-only actions, including the generate-masks path during completed-to-waiting transitions.

## Concerns

None.
