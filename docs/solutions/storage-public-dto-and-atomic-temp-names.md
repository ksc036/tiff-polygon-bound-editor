# Storage Public DTOs And Atomic Temp Names

When a storage layer scans local files, keep internal filesystem paths out of public records returned to API routes. Expose a separate DTO with stable fields such as `id`, `imageFolder`, `imageFile`, sequence metadata, and dimensions. Keep `folderPath`, `imageDir`, `imagePath`, and write paths internal to path-resolution helpers.

For atomic writes, temp filenames need collision resistance. Do not rely only on `process.pid` and `Date.now()`; two saves in the same process and millisecond can collide. Use `crypto.randomUUID()`, `mkdtemp`, or exclusive file creation for temp paths before renaming to the final file.

Apply this check before wiring storage records to HTTP JSON responses or user-triggered save actions.
