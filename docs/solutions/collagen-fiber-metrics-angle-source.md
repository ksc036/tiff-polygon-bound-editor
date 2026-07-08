# Collagen Fiber Metrics Angle Source

When comparing local collagen alignment calculations to `uw-loci/collagen-fiber-metrics`, do not conflate axial circular statistics with the source of each angle sample.

`collagen-fiber-metrics` converts a centerline mask into individual centerline coordinate sequences, sorts each line, builds a `LineString`, splits it by `seg_length`, computes segment angles from fragment endpoints with `atan2(dy, dx)`, and summarizes those angles with circular statistics over a 180-degree period. A local implementation that estimates each skeleton pixel orientation from its 8-neighborhood may use the same doubled-angle or axial circular math, but it is not the same angle extraction method.
