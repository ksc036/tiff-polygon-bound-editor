# ROI Overlay Label Placement

## Context

ROI labels are visual annotations, but their coordinates still need to respect the image coordinate system and polygon geometry. A centroid-to-vertex ray can leave the image immediately when a polygon touches an edge, and it can enter the wrong region for concave shapes.

## Rule

For outside ROI labels:

1. Prefer the existing centroid-to-first-point ray only when every band label is within the padded image bounds and remains strictly outside the polygon.
2. Otherwise derive candidate rays from edge midpoints and winding-aware outward normals.
3. Select a complete valid ray when possible, or choose a valid exterior candidate independently for each band.
4. Validate every candidate with structured point-in-polygon checks and the padded image interval. Do not clamp a failed coordinate because clamping can place the label back inside the polygon.

For compact group rows, assign explicit classes to the color swatch, display ID, name, summary, and state. Do not use positional selectors such as `nth-child` once identity elements are added.

## Regression Coverage

- Edge-touching outside polygon labels remain in bounds and exterior.
- Concave polygon labels remain exterior.
- Draw-off removes labels immediately.
- Group row layout uses named roles and truncates the group name.
