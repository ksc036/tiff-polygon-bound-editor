# Heatmap Batch Resilience And Metadata Validation

Recursive batch scans must treat unreadable descendants as per-directory failures, not root failures. Continue scanning sibling directories, report only the relative folder identity and a generic message, and reserve root validation errors for the configured root itself.

Persisted heatmap metadata is part of the saved-file schema. Validate `maskSource.size` as a finite non-negative integer and `maskSource.mtimeMs` as a finite non-negative number before comparing either field with the current mask. Malformed saved values are `INVALID_HEATMAP`; only well-formed metadata that differs from the current selected mask is `STALE_HEATMAP`.

Atomic-write cleanup needs a deterministic regression test. Keep filesystem failure injection private to the service test seam, inject a failing rename after the temporary file is written, and assert the target directory contains no temporary files.
