# Bottom Panels Must Reduce Stage Viewport Budget

When adding controls below an image editor stage, reduce any viewport-derived
stage height budget by the new bottom panel height. Otherwise the main image can
still fit its old calculation while the new controls render below the visible
viewport, which browser tests catch only after real layout is exercised.
