# Task 4 Report: Client Heatmap Math, Colors, and Comparison

## Status

Implemented and verified.

## RED Evidence

Command:

```text
npx vitest run src/lib/heatmap.test.js
```

Result: failed during test collection because `src/lib/heatmap.js` did not exist. This was the expected failure for the new client contract.

## GREEN Evidence

Focused command:

```text
npx vitest run src/lib/heatmap.test.js
```

Result: `1` test file passed, `8` tests passed.

Root-excluded suite:

```text
npx vitest run --exclude ".worktrees/**"
```

Result: `14` test files passed, `197` tests passed.

Additional verification:

```text
npm run build
git diff --check
```

Both completed successfully.

## Files

- `src/lib/heatmap.js`: added calibration math, metric selection, exact compatibility checks, row-major difference construction, display ranges, inferno/diverging colors, and coordinate-to-cell lookup.
- `src/lib/heatmap.test.js`: added focused contract tests for all public functions and required edge cases.
- `.superpowers/sdd/task-4-report.md`: this report.

## Self-Review

- Raw pixel-density values and signed comparison values remain unscaled; only color interpolation inputs are clamped.
- Compatibility checks compare width, height, cell width, cell height, rows, columns, and cell count.
- Color endpoints match the specified inferno stops and blue-white-red endpoints.
- Partial edge cells are resolved using image bounds and row-major indexing.
- Scope is limited to the requested implementation/tests plus this required report.

## Concerns

None identified for the Task 4 contract. The module intentionally assumes the server's validated closed DTO as specified.

## Review Follow-Up: Invalid Calibration

### RED Evidence

Added regression tests for zero-slope and non-numeric estimated-density calibration, mixed finite/non-finite metric values, and neutral coloring for unavailable deltas.

Command:

```text
npx vitest run src/lib/heatmap.test.js
```

Result before the fix: `3` tests failed. `null - null` produced `0`, and a `NaN` operand produced a `NaN` delta and poisoned `maxAbs`.

### GREEN Evidence

Commands:

```text
npx vitest run src/lib/heatmap.test.js
npx vitest run --exclude ".worktrees/**"
npm run build
git diff --check
```

Results: focused suite `11` tests passed; root-excluded suite `14` files and `200` tests passed; production build passed; diff check passed.

### Review Resolution

- Non-finite metric values are represented as `null`.
- A delta is `null` unless both corresponding metric values are finite.
- `maxAbs` considers only finite deltas and returns `0` when none exist.
- `differenceColor` maps `null` and non-finite values to the neutral midpoint `#f8fafc`.

The requested `ce-compound mode:headless` command was unavailable in this environment, so the fallback durable learning note was written to `docs/solutions/heatmap-invalid-calibration-deltas.md`.
