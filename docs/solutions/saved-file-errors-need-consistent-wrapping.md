# Saved File Errors Need Consistent Wrapping

When saved user data can be read through multiple API paths, wrap parse and schema failures consistently at the storage boundary. Fixing `loadBounds()` is not enough if `importPreviousBounds()` reads and parses the same file directly.

Use shared helpers for reading saved JSON files so corrupt saved bounds, missing files, and schema issues map to the same safe API status/messages regardless of whether the user is reviewing the current image or importing from the previous image.
