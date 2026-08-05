# Heatmap Batch Resilience And Metadata Validation

Recursive batch scans must treat unreadable descendants as per-directory failures, not root failures. Continue scanning sibling directories, report only the relative folder identity and a generic message, and reserve root validation errors for the configured root itself.

Persisted heatmap dimensions and cells are part of the saved-file schema. Validate `maskSource.size` as a finite non-negative integer, but treat `maskSource.mtimeMs` and `updatedAt` as optional audit metadata. Never compare saved times with the current mask: copying a dataset changes filesystem times without changing heatmap values. Explicit heatmap generation is the refresh operation.

Atomic-write cleanup needs a deterministic regression test. Keep filesystem failure injection private to the service test seam, inject a failing rename after the temporary file is written, and assert the target directory contains no temporary files.

Request validation belongs at the HTTP boundary, before saved-data loading. For `GET /api/images/:id/heatmap`, validate and normalize `cellSize` with `validateCellSize` in the route; malformed or missing client values return a stable `400` response. Keep `loadImageHeatmap` responsible for persisted heatmap validation so missing and malformed saved files retain their `404` and `422` contracts.
