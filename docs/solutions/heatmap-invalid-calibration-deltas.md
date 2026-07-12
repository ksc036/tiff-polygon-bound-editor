# Heatmap Comparisons Must Preserve Invalid Metric Values

## Context

Client heatmap calibration can make estimated metric values unavailable, for example when the slope is zero or calibration input is non-numeric.

## Guidance

Represent unavailable metric values as `null`. Before subtracting two comparison values, require both operands to be finite; otherwise emit a `null` delta. Compute `maxAbs` from finite deltas only, using `0` when no finite deltas exist. Color helpers should map unavailable values to the neutral midpoint without fabricating raw metric data.

## Why This Matters

JavaScript arithmetic coerces `null` to `0`, so subtracting unavailable values can silently create false valid changes and distort the comparison scale.

## Prevention

Keep regression tests for zero-slope calibration, non-numeric calibration, mixed finite/non-finite cells, an all-unavailable comparison, and neutral coloring for `null` or non-finite deltas.
