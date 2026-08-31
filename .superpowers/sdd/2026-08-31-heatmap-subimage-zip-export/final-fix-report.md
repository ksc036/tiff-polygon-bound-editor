# Final Review Fix Report

## Scope

- Validate every saved estimated-collagen heatmap against the current source TIFF dimensions before planning absolute or comparison exports.
- Make estimated heatmap rasterization and original-preview normalization cooperatively cancellable by real external abort events.
- Keep ZIP continuation, sanitized reporting, cache safety, and existing UI semantics unchanged.

## Root Causes

1. `planEstimatedHeatmapAssets` trusted the saved heatmap `width` and `height`; no current TIFF dimensions reached the planner.
2. `renderEstimatedHeatmapAsset` and `normalizedPixelsFor` polled `signal.aborted` inside synchronous loops without yielding to the Node event loop, so an HTTP abort event could not update the signal until every pixel had been traversed.

## TDD Evidence

### RED: stale saved heatmap dimensions

Command:

```text
npm test -- server/exportHeatmapAssets.test.js server/exportService.test.js
```

Observed before production changes:

```text
Test Files  2 failed (2)
Tests       2 failed | 61 passed (63)

planner: expected no descriptor involving T02, received descriptors involving T02
integration: expected T02/heatmap/20x20/full.png to be absent, but it was present
```

The fixtures used internally valid saved heatmaps at `120x20` while planner metadata reported a current `121x20` TIFF, and an integration fixture generated valid `40x40` heatmaps before replacing the T02 TIFF with a valid `60x40` TIFF.

### GREEN: stale saved heatmap dimensions

Command:

```text
npm test -- server/exportHeatmapAssets.test.js server/exportService.test.js
```

Observed after the dimension-validation implementation and stage-specific abort-test adjustment:

```text
Test Files  2 passed (2)
Tests       63 passed (63)
```

The integration test verifies that T01 exports continue, all T02 absolute/subimage and dependent comparison artifacts are absent, T02 statistics remain in the ZIP, and 12 workbook rows are `Skipped` with the sanitized reason `Saved heatmap dimensions do not match the current TIFF.`

### RED: externally delivered loop cancellation

Command:

```text
npm test -- server/exportHeatmapAssets.test.js server/exportRasterAssets.test.js
```

Observed before asynchronous chunking:

```text
Test Files  2 failed (2)
Tests       2 failed | 49 passed (51)

heatmap samples: expected <= 4096, received 1000000
raster reads:    expected <= 4096, received 1000000
```

Both tests scheduled `AbortController.abort()` through `setImmediate`, proving the synchronous loops traversed the entire controlled source before Node could deliver the abort event.

### GREEN: externally delivered loop cancellation and retry

Command:

```text
npm test -- server/exportHeatmapAssets.test.js server/exportRasterAssets.test.js
```

Observed after asynchronous chunking:

```text
Test Files  2 passed (2)
Tests       51 passed (51)
```

Each loop now yields every 4,096 pixels and checks the signal before and after the yield. The tests verify bounded early termination, then retry the same source without a signal and require a complete PNG plus a full fresh source traversal, proving no partial cache was published.

## Implementation

- Added an abort-aware TIFF metadata reader that validates positive safe dimensions and `maxImagePixels`.
- Collected per-image source dimensions from actual TIFF paths with recoverable, sanitized failure entries and passed them into the heatmap planner.
- Required current dimensions in planning; unavailable dimensions and saved/current mismatches skip both absolute artifacts and all dependent comparisons.
- Converted heatmap pixel rasterization and raster normalization to asynchronous 4,096-pixel chunks using `setImmediate` yields.
- Propagated `await` through normalized Sharp pipeline creation and retained cache writes only after complete successful work.
- Added direct coverage for missing TIFF dimensions, TIFF metadata pixel limits, pre-abort behavior, stale ZIP continuation/reporting, external abort delivery, successful retry, and Sharp listener cleanup.

## Final Verification

Focused server suites:

```text
npm test -- server/exportRasterAssets.test.js server/exportHeatmapAssets.test.js server/exportService.test.js
Test Files  3 passed (3)
Tests       87 passed (87)
```

Standard parallel full-suite runs consistently exposed one pre-existing Windows filesystem race outside this change:

```text
npm test
Test Files  1 failed | 36 passed (37)
Tests       1 failed | 623 passed (624)
Failure     server/storage.test.js concurrent save rename -> EPERM
```

The failing storage suite passed independently:

```text
npm test -- server/storage.test.js
Test Files  1 passed (1)
Tests       23 passed (23)
```

The full suite passed with one Vitest worker, removing the Windows cross-suite file-lock contention:

```text
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1
Test Files  37 passed (37)
Tests       624 passed (624)
```

Production build:

```text
npm run build
48 modules transformed
Build completed successfully in 706ms
```

Repository checks before the report/commit:

```text
git diff --check
exit 0; no whitespace errors

git status --short
only the six scoped server production/test files were modified
```

Known test output: existing jsdom download tests emit `Not implemented: navigation (except hash changes)` warnings without failures.
