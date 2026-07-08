# Mixed ROI Assignment Samples

When ROI analysis supports multiple assignment modes, do not build group-level
mask or skeleton samples from one merged pixel assignment map.

## Context

The boundary editor now supports:

- `outside` groups that assign pixels by outward distance bands.
- `inside` groups that assign pixels by polygon interior area.

An inside polygon can spatially overlap with the far band of an outside group.
If samples are generated from a merged map, whichever assignment is inserted
first owns the pixel and the other group loses its samples.

## Rule

Generate samples from each mode-specific assignment map first, then concatenate
those samples for group-level filtering. Use a merged map only for image-level
summary semantics where one pixel should be counted once.

This keeps inside density/global alignment independent from outside distance-band
coverage while preserving a single image summary.
