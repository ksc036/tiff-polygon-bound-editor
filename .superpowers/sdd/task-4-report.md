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
