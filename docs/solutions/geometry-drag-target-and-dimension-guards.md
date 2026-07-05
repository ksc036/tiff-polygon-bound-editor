# Geometry Drag Targets And Dimension Guards

For point-editing UIs, separate hit testing from drag updates. Use nearest-point lookup only to choose the target at pointer-down time, then move that stable point id or index for the rest of the drag. Re-running nearest lookup on every pointer move can switch targets mid-drag when the pointer crosses closer to another vertex.

Geometry clamping helpers must defend against unknown or invalid dimensions. If width or height is `0`, `null`, `undefined`, or non-finite, avoid producing negative coordinates such as `-1`; either return the original point or clamp that axis to `0` only when a positive image extent is known.

Apply this check before wiring geometry helpers into canvas drag interactions.
