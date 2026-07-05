# Outward ROI Analysis Spec Clarity

When specifying or implementing boundary-based ROI analysis, define these
details before coding:

- Outward ROI assignment must be exclusive across groups for both area pixels
  and skeleton pixels. Exclude pixels inside any saved cell polygon, then assign
  each remaining eligible pixel to the nearest boundary group and distance band.
  The exclusion is strict-inside only: pixels exactly on the polygon boundary
  remain eligible for the near band at distance 0.
- Saved polygon rings may include a duplicate closing point equal to the first
  point. Normalize that closing point away before self-intersection checks and
  boundary traversal.
- ROI bands should be contiguous in the payload. For the three-band MVP, derive
  ranges from editable upper limits so `near`, `mid`, and `far` cannot overlap
  or leave gaps. The analysis API shape is `id`, `label`, `fromPx`, and `toPx`;
  avoid internal-only names like `minPx`/`maxPx` in normalized or persisted band
  payloads. Approved default labels are exactly `near: 가까움`, `mid: 중간`, and
  `far: 멀리`.
- Skeleton density is length-based: `skeletonLengthPx / roiAreaPx`. Coverage is
  the pixel-count ratio: `skeletonPixelCount / roiAreaPx`.
- Per-band skeleton length must preserve edges crossing ROI band boundaries.
  Allocate same-band edges fully to that band, and split cross-band edge length
  equally between endpoint bands; overall length still counts each edge once.
- ROI-assigned skeleton pixels must count even when isolated. If a skeleton
  pixel has no neighbors, include it in `skeletonPixelCount` and coverage, but
  leave orientation-dependent metrics null instead of inventing an orientation.
- Mask foreground detection should not assume the first color channel. Treat any
  non-zero non-alpha channel as foreground for RGB/RGBA masks.
- Boundary normals must not depend on polygon winding. Choose the segment normal
  whose small offset lands outside the polygon, with a sample-vector fallback for
  ambiguous cases. Once a perpendicular is verified as outside, do not flip it
  toward the sample vector afterward; that can turn a correct outside normal into
  an inside-facing one.
- Skeleton topology tests that claim 8-neighborhood behavior need fixtures that
  account for diagonal adjacency. A plus-shaped one-pixel junction makes the arms
  diagonal neighbors of each other, so use separated prongs when the expected
  endpoint count matters.
- Skeletonization must handle foreground touching image borders. Pad masks with
  a zero border, or otherwise treat out-of-bounds neighbors as background, before
  thinning and crop the result back afterward.
- Mask alpha semantics are deliberate: alpha alone is ignored, but a transparent
  pixel with non-zero RGB values is foreground because foreground is based on
  non-alpha channels.
- When adding another fixed-height panel to the editor shell, recalculate the
  viewport height budget for the image stage. The image-stage `max-height`
  cannot keep using the previous toolbar-only subtraction, or new lower controls
  may be pushed below the first viewport even though no elements overlap.
- The same budget check must include toolbar wrapping. Adding segmented controls
  or status chips can turn a one-row toolbar into two rows at 1280px width, so
  browser verification should inspect `documentElement.scrollHeight` against the
  viewport after every editor toolbar change.
