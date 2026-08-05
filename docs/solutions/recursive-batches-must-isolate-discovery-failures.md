# Recursive batches must isolate discovery failures

## Context

A batch can correctly catch failures while processing each discovered item and still fail globally before processing begins. Recursive directory discovery is itself an error boundary: one unreadable descendant can throw from `readdir` and prevent valid sibling bundles from running.

## Rule

Treat root validation, descendant discovery, and item processing as separate failure classes.

- An unreadable or invalid root may reject the whole request.
- An unreadable descendant is recorded with a safe relative identifier, then sibling traversal continues.
- A discovered item's read or write failure is recorded per item, then the batch continues.
- Never return the raw filesystem error message when it may contain an absolute path.

Atomic persistence needs the same boundary discipline. When write or rename fails, remove the unique temporary file before reporting the item failure. Use injected filesystem operations in tests so discovery and rename failures are deterministic across operating systems.

Persisted structural metadata still needs validation, but time metadata is audit-only. A missing or malformed `size` is invalid saved heatmap data; a missing or malformed `mtimeMs` must not change whether saved measurements load.
