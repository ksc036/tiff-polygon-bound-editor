# Inference Service Contract Boundaries

Probability-map inference has four independent persistence and protocol boundaries that must be validated before derived artifacts are accepted.

- Require a successful response to declare `Content-Type: application/x-npy` before reading its body, and send `Accept: application/x-npy` with the multipart request.
- Permit only one active inference job per service instance so requests and probability-map writes remain globally sequential.
- Include the full source filename in derived filenames. `sample.tif` and `sample.tiff` must produce different map, settings, and mask paths.
- Create default threshold settings only when the settings file is absent. Invalid JSON is persisted user state and must surface `INVALID_SETTINGS` without replacement.
- Treat a request-only ROI selection as review state, never as a settings mutation; use persisted settings only when no selection is supplied. Normalize valid JSON null or scalar inference mutation bodies at the service boundary so they produce stable validation codes, while keeping permissive parsing scoped to inference routes.

Regression tests should cover each boundary directly, including an incorrectly labelled successful response, concurrent starts with a held request, matching `.tif`/`.tiff` stems, and byte-for-byte preservation of malformed settings.
