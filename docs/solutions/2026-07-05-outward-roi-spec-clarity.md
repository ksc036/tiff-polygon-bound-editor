# Outward ROI Analysis Spec Clarity

When specifying or implementing boundary-based ROI analysis, define these
details before coding:

- Outward ROI assignment must be exclusive across groups for both area pixels
  and skeleton pixels. Exclude pixels inside any saved cell polygon, then assign
  each remaining eligible pixel to the nearest boundary group and distance band.
- ROI bands should be contiguous in the payload. For the three-band MVP, derive
  ranges from editable upper limits so `near`, `mid`, and `far` cannot overlap
  or leave gaps.
- Mask foreground detection should not assume the first color channel. Treat any
  non-zero non-alpha channel as foreground for RGB/RGBA masks.
- Boundary normals must not depend on polygon winding. Choose the segment normal
  whose small offset lands outside the polygon, with a sample-vector fallback for
  ambiguous cases.
