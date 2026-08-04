# Task 3 Review: API, TIFF, Persistence, and Safety

When implementing server image APIs, preserve behavior from the reference app when the task names it explicitly. For 16-bit TIFF display ranges, parse ImageJ `ImageDescription` `min=` and `max=` metadata first, then fall back to pixel min/max only when metadata is missing or invalid.

If `dataDir` is threaded through an API, tests should prove it has an effect. Persist app-local settings such as the last valid root only after validation succeeds, and ignore stale persisted roots during startup so a missing external folder cannot crash the app.

Server API errors should be mapped at the boundary. Do not return absolute filesystem paths, user-submitted local paths, or Sharp/libvips internals. Validate request bodies before storage writes so malformed client data cannot become saved JSON.

Batch preflight must establish source-dimension consistency independently of optional template provenance fields. Compare each supported source TIFF against the first valid source before scheduling writes; per-image crop validation alone is insufficient because omitted `sourceWidth` and `sourceHeight` adopt each image's own metadata.

Treat batch discovery as a public-error boundary too. If storage scanning fails before an image folder is available, return the stable batch-preflight error with a root-scoped failure entry and generic message rather than exposing the storage exception.
