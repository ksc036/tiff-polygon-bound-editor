# Layered Overlays Need Separate Errors and Dimension Validation

## Context

A viewer loaded its current heatmap and optional previous heatmap in one `try`/`catch`. When only the previous request failed, the UI mislabeled the current heatmap as unavailable even though current data was valid. It also accepted current heatmaps without checking that their saved dimensions matched the displayed image.

## Rule

Treat required current data and optional comparison data as separate load boundaries with independent request guards, loading states, and errors. A comparison failure must clear only comparison state and leave valid current data visible.

Before accepting any spatial overlay into render state, require its width and height to exactly match the displayed image. Reject mismatches with a specific status while leaving the base image visible. Perform compatibility checks before accepting optional comparison data as well.
