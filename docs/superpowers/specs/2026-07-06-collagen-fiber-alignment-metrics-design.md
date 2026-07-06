# Collagen Fiber Alignment Metrics Design

## Summary

Replace the current ROI-wide `globalAlignment` interpretation with a collagen
fiber oriented metric that better matches heterogeneous and radial fiber
patterns. The new metric should treat skeletonized mask foreground as fiber
centerline evidence, compute local fiber/segment orientations, then summarize
local alignment within each ROI. Radial and tangential alignment should compare
the same local fiber orientations against the nearest boundary normal and
tangent.

This keeps the existing JSON field names where practical, but changes the
meaning of `globalAlignment` from "one global direction for the whole ROI" to
"mean local fiber alignment inside the ROI".

## References

- `uw-loci/collagen-fiber-metrics`: computes centerline-derived fiber features
  from segment angles, segment lengths, circular mean/variance, full fiber
  length, waviness, and intensity. The relevant reference implementation is
  `centerline.py`, especially `single_fiber_feats()` and
  `compute_fiber_feats()`.
- Lee et al., "Local alignment vectors reveal cancer cell-induced ECM fiber
  remodeling dynamics", Scientific Reports 2017:
  https://www.nature.com/articles/srep39498. The paper shows that a global
  alignment vector can understate radially or spatially heterogeneous fiber
  organization because different local directions average out.
- Quinn et al., "Rapid Quantification of 3D Collagen Fiber Alignment and Fiber
  Intersection Correlations with High Sensitivity", PLOS ONE 2015:
  https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0131814.
  This supports pixel-wise orientation detection and alignment quantification
  from orientation distributions.

## Problem With The Current Metric

The current implementation calculates `globalAlignment` by pooling every
skeleton orientation sample in an ROI into a single doubled-angle circular
mean. That is useful for a single straight orientation field, but it is a poor
biological readout when fibers are locally organized but spatially curved,
wrapped around the cell, or radially arranged.

For example, radial fibers around a curved boundary can be highly organized at
each boundary location while still producing a low ROI-wide global vector
magnitude, because the local axes point in many image-space directions. The
user then sees values such as `0.3` despite visually obvious local alignment.

## Confirmed Decisions

- Keep using `mask` pixels for `maskPixelCount` and `density`.
- Keep using skeletonized mask data only for orientation-derived metrics.
- Keep the UI column name `Global` for now, but update hover text to explain
  that it means mean local fiber alignment.
- Keep JSON field names for compatibility:
  - `globalAlignment`
  - `globalOrientationDeg`
  - `radialNormalAlignment`
  - `tangentialAlignment`
  - `orientationDispersion`
- Bump analysis schema so older saved analysis does not silently mix old and
  new metric meanings.
- Inside groups report only `globalAlignment`, `globalOrientationDeg`, and
  `orientationDispersion` among orientation metrics.
- Outside groups report `globalAlignment`, `globalOrientationDeg`,
  `radialNormalAlignment`, `tangentialAlignment`, and `orientationDispersion`.

## Fiber Orientation Model

The implementation will keep the existing skeletonization stage, then build
orientation samples from skeleton foreground pixels. Each orientation sample
represents a local undirected fiber axis.

The first implementation should stay lightweight and local to the current
JavaScript server:

1. collect all skeleton pixels assigned to an ROI,
2. estimate each sample orientation from foreground neighbors in a local window,
3. compute local alignment around each sample from nearby sample orientations,
4. aggregate local values into ROI metrics.

This avoids introducing Python, SciPy, Shapely, or a full CT-FIRE dependency
into the local app, while adopting the same core idea as collagen fiber tools:
orientation distributions and local alignment are the metric source.

## Local Alignment Algorithm

For each oriented skeleton sample `i`:

1. find neighboring oriented samples within a configurable radius `R`,
2. include at least the sample itself,
3. compute doubled-angle circular statistics across that local set:

```text
C_i = mean(cos(2 * theta_j))
S_i = mean(sin(2 * theta_j))
localAlignment_i = sqrt(C_i*C_i + S_i*S_i)
localOrientation_i = 0.5 * atan2(S_i, C_i)
```

`localAlignment_i` ranges from `0` to `1`.

- `1` means the local fibers share a common undirected axis.
- `0` means the local orientations are broadly dispersed.

The ROI `globalAlignment` becomes:

```text
globalAlignment = mean(localAlignment_i)
orientationDispersion = 1 - globalAlignment
```

The ROI `globalOrientationDeg` remains an ROI-wide representative orientation:

```text
globalOrientationDeg = 0.5 * atan2(mean(sin(2 * theta_i)), mean(cos(2 * theta_i)))
```

This representative direction is a helper value only. It should not be used as
the main collagen alignment readout when local directions are heterogeneous.

## Radial And Tangential Alignment Algorithm

For each oriented skeleton sample assigned to an outside ROI:

1. find the nearest boundary segment for that sample,
2. compute the boundary tangent from that segment,
3. compute the outward normal independent of polygon winding,
4. compare the local sample fiber axis against each boundary axis:

```text
sampleRadial = abs(dot(fiberAxis, outwardNormal))
sampleTangential = abs(dot(fiberAxis, tangent))
```

The ROI metrics are the mean of sample values:

```text
radialNormalAlignment = mean(sampleRadial)
tangentialAlignment = mean(sampleTangential)
```

These metrics remain boundary-relative. They do not require all fibers in the
ROI to share a single image-space direction.

## Default Parameters

- Local alignment radius: `25 px`.
- Minimum local neighbor count: `3` oriented samples.
- Samples with fewer than the minimum local neighbors still contribute to
  radial/tangential alignment, but their `localAlignment` should be `null` and
  excluded from `globalAlignment`.
- These values are implementation constants in the MVP. A later UI can expose
  them if the analysis needs tuning per dataset.

## Expected Behavior

- Straight parallel fibers in an ROI should produce high `globalAlignment`.
- Randomly oriented fibers should produce low `globalAlignment`.
- Radially arranged fibers around a boundary should produce high
  `globalAlignment` when local fibers are coherent, even if the representative
  global orientation is weak or unstable.
- Boundary-normal fibers should produce high `radialNormalAlignment` and low
  `tangentialAlignment`.
- Boundary-following fibers should produce low `radialNormalAlignment` and high
  `tangentialAlignment`.
- Inside groups should not show radial or tangent values.

## UI Changes

Metric hover help should clarify the new meaning:

- `Global`: "Mean local fiber alignment in this ROI. Higher means nearby
  skeleton fibers share a common axis, even if the direction changes across the
  ROI."
- `Radial`: "Mean alignment between local fiber axis and the outward boundary
  normal."
- `Tangent`: "Mean alignment between local fiber axis and the nearest boundary
  tangent."

## Testing Strategy

Add geometry tests before implementation:

- parallel local fibers produce high `globalAlignment`,
- random or crossing local fibers produce lower `globalAlignment`,
- radial fibers around a polygon can have high local `globalAlignment` while
  the previous ROI-wide global vector would be low,
- radial and tangential fixtures still separate boundary-normal from
  boundary-following fibers,
- inside groups produce no radial/tangent metric values,
- saved analysis schema changes invalidate older analysis files.

## Out Of Scope

- Full CT-FIRE or Python `collagen-fiber-metrics` integration.
- 3D collagen fiber analysis.
- Manual parameter tuning UI for local radius and neighbor count.
- CSV export.
