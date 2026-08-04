# Task 5 Report: Source-Aspect Crop Geometry

## Scope

Implemented the pure client crop geometry module and its Vitest coverage:

- `createAspectLockedCrop(start, current, imageSize)` creates a deterministic integer crop using inclusive pointer spans and the source aspect ratio.
- `moveCropBy(crop, delta, imageSize)` rounds movement deltas, clamps movement to source bounds, preserves crop dimensions, and returns the original object for no-op movement.
- `cropContainsPoint(crop, point)` uses half-open crop bounds.
- `cropFitsImage(crop, imageSize)` validates source dimensions and crop bounds.
- `sameCrop(left, right)` compares only source dimensions and crop geometry, ignoring metadata.

## TDD Evidence

1. Wrote the geometry tests first.
2. Ran `npm test -- src/lib/subimageCrop.test.js` and confirmed RED because `subimageCrop.js` did not exist.
3. Implemented the minimal pure module.
4. Corrected one added test that used pointer coordinates outside the declared source image; the production behavior was not changed.
5. Re-ran focused tests successfully.

## Coverage

The 11 focused tests cover all four drag quadrants, inclusive spans, aspect-constrained sizing, non-square source rounding, invalid inputs, movement clamping, fractional delta rounding, no-op object identity, half-open containment, image bounds, and metadata-insensitive equality.

## Verification

- Focused: `npm test -- src/lib/subimageCrop.test.js` passed, 11/11 tests.
- Full: `npm test` ran 398 tests across 25 files; 397 passed. One pre-existing/unrelated `server/exportService.test.js` test timed out at the default 5-second limit: `keeps the ZIP usable when saved heatmaps are stale or adjacent grids are incompatible`.

## Self-Review

Reviewed numeric edge cases around inclusive-to-half-open conversion, integer rounding, source-bound clamping, invalid dimensions, and fractional movement. Reviewed object identity and confirmed only no-op movement returns the original crop reference; changing movement returns a new object without mutating the input.
