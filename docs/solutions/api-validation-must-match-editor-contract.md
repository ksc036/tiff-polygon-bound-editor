# API Validation Must Match Editor Contract

When an API persists JSON that frontend helpers will later load, validate the fields those helpers assume are present. Optional-looking ids can still be required if editor code calls methods such as `id.startsWith()` or `id.localeCompare()`.

For bounds JSON, validate dimensions as `null` or finite numbers, require group ids and point ids when groups/points are present, and reject malformed coordinates before writing. A saved file should be safe to load directly into the editor without defensive repair on every render path.

Also separate API error classes at the boundary: client validation errors, missing image/root errors, corrupt saved user data, unreadable image data, and storage/server failures should have distinct safe statuses/messages.
