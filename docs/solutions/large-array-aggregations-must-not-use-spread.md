# Large Array Aggregations Must Not Use Spread

## Context

Heatmap comparisons can contain up to 1,000,000 cells. Expanding an array of deltas into `Math.max(...values)` exceeds the JavaScript argument limit and throws a `RangeError` for valid large heatmaps.

## Guidance

Aggregate extrema incrementally while producing or traversing the values. Keep the existing validity rules intact: only finite cleaned deltas contribute to `maxAbs`, while unavailable or non-finite deltas remain unavailable and do not distort the scale.

## Why This Matters

Array spread is convenient for small collections but turns a linear aggregation into a call with one argument per element. A single-pass accumulator has bounded call-stack usage and supports the full heatmap size without changing the result or floating-point cleanup behavior.

## Prevention

For array aggregations over supported large inputs, add a regression test above the runtime argument limit with the expected extremum near the end of the input. Prefer a loop or accumulator inside an existing traversal over `Math.max(...array)`, `Math.min(...array)`, or similar spread-based reductions.
