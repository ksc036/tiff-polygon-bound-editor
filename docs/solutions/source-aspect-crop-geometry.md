---
problem_type: knowledge
component: client-crop-geometry
---

# Source-Aspect Crop Geometry

Pointer coordinates for source crops are integer pixel centers and must be treated as an inclusive drag extent when deriving a crop. The resulting crop uses integer width and height, while containment remains half-open (`x <= point.x < x + width`). Tests should keep pointer points inside the source image; otherwise clamping can conceal an invalid setup or produce a rectangle larger than the source dimensions.

When moving a crop, round fractional deltas before clamping to the source bounds. Return the original crop object when the rounded, clamped position is unchanged so callers can preserve reference identity for no-op updates. Equality for dirty-state checks should compare only source dimensions and crop coordinates/dimensions, ignoring server metadata.
