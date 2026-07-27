# Export Snapshot, Stale Analysis, and Large Render Safety

## Problem

Dataset export originally read from mutable global storage, accepted shallowly valid
analysis JSON, planned every heatmap in memory, and rendered ROI/heatmap reports at
source-driven dimensions. A root switch could mix datasets, stale analysis could be
presented as current, formula objects could reach ExcelJS, and large valid images
could exceed memory or Sharp pixel limits.

## Durable Rules

1. Capture a read-only storage snapshot before export validation, naming, discovery,
   and file reads. Every stage of one export must use that same snapshot.
2. Treat saved analysis as untrusted input. Rebuild an allow-listed primitive-only
   object before workbook generation, then reject analysis whose groups, modes,
   ROI bands, mask snapshot, or timestamps disagree with current inputs.
3. Preserve partial success. Invalid or stale analysis skips statistics while source,
   ROI, heatmap, and report artifacts continue when independently valid.
4. Plan heatmaps in two bounded passes. Keep only metadata/status descriptors and
   shared comparison maxima; reload one absolute map or one adjacent pair when its
   figure is rendered.
5. Cap report pixels independently from scientific source dimensions. Scale ROI
   geometry and display distances for the overview while retaining original-pixel
   distances in the legend.
6. Use a scanline visitor for large ROI overlays. Do not allocate both a full RGBA
   frame and a string-key assignment map.
7. A zero comparison range is `0..0`, not a fabricated `-1..1`; render it with a
   stable neutral palette.
8. HTTP download names need an ASCII `filename=` fallback and an RFC 5987
   `filename*=UTF-8''...` value for Unicode roots.
9. Validate against the saved schema's real nullable fields, not only synthetic
   fixtures. Aggregate and inside metrics legitimately store `bandId: null`; keep
   the primitive-only boundary while allowing that explicit sentinel.

## Compatibility Note

POSIX folder names that are invalid on Windows are still preserved in ZIP paths.
Changing them requires a documented, collision-resistant name mapping and manifest;
silent sanitization would violate source-directory preservation.

## Verification

Server coverage includes root switching with duplicate image IDs, Korean root names,
formula-object and out-of-domain metric rejection, stale mask/bounds/mode/ROI-band
detection, lightweight heatmap planning, a rendered 680x680 grid, a 10,000x10,000
ROI frame plan, nullable aggregate band IDs, and visitor equivalence with canonical
ROI assignment.
