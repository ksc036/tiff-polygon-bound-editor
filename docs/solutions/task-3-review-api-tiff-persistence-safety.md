# Task 3 Review: API, TIFF, Persistence, and Safety

When implementing server image APIs, preserve behavior from the reference app when the task names it explicitly. For 16-bit TIFF display ranges, parse ImageJ `ImageDescription` `min=` and `max=` metadata first, then fall back to pixel min/max only when metadata is missing or invalid.

If `dataDir` is threaded through an API, tests should prove it has an effect. Persist app-local settings such as the last valid root only after validation succeeds, and ignore stale persisted roots during startup so a missing external folder cannot crash the app.

Server API errors should be mapped at the boundary. Do not return absolute filesystem paths, user-submitted local paths, or Sharp/libvips internals. Validate request bodies before storage writes so malformed client data cannot become saved JSON.
