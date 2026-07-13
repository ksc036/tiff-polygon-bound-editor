# Heat Map Overlay Visual-Debug Report

## Scope

Implemented the Task 4 layer-order correction at baseline `ab7d55283f450d77784bb8ea53ebd5a0c9653490`.

- In Heat Map mode only, the raw TIFF canvas now has `heatmap-original-overlay` and is composited at `z-index: 2` above `.heatmap-overlay` (`z-index: 1`).
- The raw TIFF remains non-interactive while it is the top visual layer.
- Other image modes retain the existing raw-canvas classes, z-index, and opacity behavior.
- No active-group metadata or approved Heat Map isolation behavior changed.

## RED

Added the requested regression assertions before changing production code:

1. `src/App.test.jsx` requires the raw canvas to receive `heatmap-original-overlay` only while Heat Map is active, and to lose it after returning to Original.
2. `src/styles.test.js` requires `.raw-canvas.heatmap-original-overlay` to use `z-index: 2` while `.heatmap-overlay` remains at `z-index: 1`.

Command run:

```sh
npx vitest run src/App.test.jsx src/styles.test.js
```

The new App assertion failed because the received class list was only `raw-canvas`. The new style assertion failed because no matching rule existed. The command also discovered nested worktree tests, which is why all subsequent checks used the required `--exclude '.worktrees/**'` option.

## GREEN

Applied the minimal implementation:

- `src/App.jsx`: append the Heat Map-only class to the raw canvas.
- `src/styles.css`: add `z-index: 2` and `pointer-events: none` for that class.

Focused verification:

```sh
npx vitest run --exclude '.worktrees/**' src/App.test.jsx src/styles.test.js
```

Result: 2 test files passed, 73 tests passed.

## Runtime And Visual Verification

- The requested server endpoint returned HTTP `200` at `http://localhost:52931/`.
- A disposable 64x48 TIFF/mask fixture outside the repository generated three Heat Map sizes successfully.
- In Heat Map mode, browser inspection confirmed the raw canvas class was `raw-canvas heatmap-original-overlay`, its computed opacity was `0.5`, its computed `z-index` was `2`, and its computed `pointer-events` was `none`.
- The heatmap canvas computed `z-index` was `1`.
- A browser screenshot at the default 50% original opacity showed the blended image and Heat Map isolation (no editable bounds/ROI/vector overlays).

The App regression test also verifies the slider changes raw TIFF opacity to `0`, retains the visible heatmap, and restores raw opacity to `1` in Original mode.

## Full Verification

```sh
npx vitest run --exclude '.worktrees/**'
npm run build
git diff --check
```

Results:

- Full suite: 15 test files passed, 232 tests passed.
- Build: Vite production build completed successfully; 33 modules transformed.
- Diff check: completed with no output.

## Documentation And Learning

- Updated `docs/superpowers/specs/2026-07-12-heatmap-display-overlay-design.md` to state that the original TIFF is composited above the Heat Map.
- Added `docs/solutions/opaque-overlays-can-hide-adjustable-underlays.md` because the visual investigation exposed the reusable assumption that an adjustable underlay remains meaningful beneath an opaque, full-coverage overlay. `ce-compound` is unavailable in this environment.

## Self-Review

- The class is applied only when `imageLayer === "heatmap"`.
- Existing Mask and Fiber QC z-index rules are unchanged.
- The Heat Map tooltip remains above both canvases at its existing `z-index: 5`.
- Changes are limited to the requested App, tests, CSS, design spec, learning note, and this report.

## Concerns

None. The temporary visual fixture is outside the repository and is not part of the change set.

## Final-Review Fix Evidence

### RED

Added tests before changing production JSX for comparison legend order and for the Mask/Fiber QC raw-canvas cascade contract. Also extended the Heat Map opacity test to assert slider bounds and the `1` endpoint, and extended the CSS assertion for the non-interactive original overlay.

```sh
npx vitest run --exclude '.worktrees/**' src/App.test.jsx src/styles.test.js
```

Result: 2 files run; `src/styles.test.js` passed (5 tests) and `src/App.test.jsx` failed 3 assertions (69 tests, 3 failed). Mask and Fiber QC both received `style="opacity: 1;"`; the comparison legend DOM order was `comparison maximum`, `comparison zero`, `comparison minimum` instead of min-to-max.

### GREEN

Changed the legend JSX to render `min`/`-maxAbs` on the left and `max`/`+maxAbs` on the right. Changed the raw canvas to provide inline opacity only when `imageLayer === "heatmap"`; Original, Mask, and Fiber QC use the CSS cascade. The original-mode assertion checks the removed inline opacity property because React may retain an empty `style` attribute after a style transition.

```sh
npx vitest run --exclude '.worktrees/**' src/App.test.jsx src/styles.test.js
```

Result: 2 files passed, 74 tests passed.

### Full Verification

```sh
npx vitest run --exclude '.worktrees/**'
npm run build
git diff --check
```

Results:

- Full suite: 15 test files passed, 233 tests passed.
- Build: Vite `v6.4.3` completed successfully; 33 modules transformed; built in 391ms.
- Diff check: completed with no output.

### Self-Review

- Horizontal legends now match their left-to-right gradients in both regular and comparison modes: min/negative, zero, max/positive.
- Mask and Fiber QC retain `.hidden-layer` with no inline opacity declaration, so its `opacity: 0` rule continues to win if preview images fail.
- Inline opacity remains available for all Heat Map slider values, including `1` and `0`; Original returns to its base CSS opacity.
- `.raw-canvas.heatmap-original-overlay` retains `pointer-events: none`, now protected by the CSS test.
- No server API, server code, or prior Heat Map isolation behavior changed.
- Added durable notes: `docs/solutions/legend-label-order-must-match-gradient-direction.md` and `docs/solutions/inline-opacity-must-not-override-hidden-layer-state.md` because `ce-compound` is unavailable.

## Comparison Legend Spacing Fix

### RED

Added a focused CSS contract test requiring comparison mode to reserve 14px below the legend while keeping the color scale 12px high.

```sh
npx vitest run src/styles.test.js
```

Result: the root `src/styles.test.js` suite failed the new assertion because `.heatmap-legend.difference` did not reserve any bottom space. The command also discovered the existing worktree test suite; that unrelated suite passed.

### GREEN

Added comparison-only bottom padding to the legend. The absolutely positioned zero label now occupies reserved visual space before the following status line, while `.heatmap-legend-scale` remains 12px high.

```sh
npx vitest run --exclude '.worktrees/**' src/styles.test.js
```

Result: 1 test file passed, 6 tests passed.

### Documentation

Added `docs/solutions/absolutely-positioned-legend-labels-need-reserved-layout-space.md` because `ce-compound` is unavailable. It records that absolutely positioned labels require explicit parent layout space and an independent scale-height contract.

### Commit And Final Verification

Committed as `d4a43e8 fix: reserve comparison legend label space`.

Committed files:

- `src/styles.css`
- `src/styles.test.js`
- `docs/solutions/absolutely-positioned-legend-labels-need-reserved-layout-space.md`

The append-only `.superpowers/sdd/heatmap-display-task-4-report.md` update remains local because `.superpowers/sdd/` is ignored.

Fresh post-commit verification:

```sh
npx vitest run --exclude '.worktrees/**'
npm run build
git diff --check HEAD^ HEAD
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:52931/
```

Results: 15 test files passed with 234 tests, Vite built 33 modules successfully, diff check produced no output, and the restarted server returned HTTP 200.

## Large Heatmap Comparison Aggregation Fix

### RED

Added a focused regression using 200,000 cells, with the largest cleaned delta in the final cell. The test failed on the spread-based implementation because expanding the finite deltas into `Math.max` exceeded the runtime argument limit.

```sh
npx vitest run --exclude '.worktrees/**' src/lib/heatmap.test.js
```

Result: 1 test file ran; 11 tests passed and 1 test failed with `RangeError: Maximum call stack size exceeded` at `src/lib/heatmap.js:80:63`.

### GREEN

Replaced the spread-based maximum with a single-pass accumulator inside the existing delta map. Only finite cleaned deltas update `maxAbs`, and the final aggregate still uses `cleanFloatingPoint`.

```sh
npx vitest run --exclude '.worktrees/**' src/lib/heatmap.test.js
```

Result: 1 test file passed; 12 tests passed.

### Self-Review

- The regression stays below the supported 1,000,000-cell ceiling while exceeding the argument-expansion limit.
- Finite and non-finite delta handling remains unchanged, including overflowed non-finite deltas being excluded from `maxAbs`.
- Existing floating-point cleanup remains applied to each delta and to the final maximum.
- No DTO validation or unrelated code was changed.
- Added `docs/solutions/large-array-aggregations-must-not-use-spread.md` because `ce-compound` is unavailable.

### Concerns

None.
