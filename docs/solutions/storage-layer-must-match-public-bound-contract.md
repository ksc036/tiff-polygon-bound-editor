# Storage Layer Must Match Public Bound Contract

When an API rejects legacy enum values or malformed DTO fields, keep direct storage tests and storage defaults aligned with that public contract. Otherwise lower-level tests can keep obsolete assumptions alive after the user-facing path has already moved on.

For polygon bounds, `connectionMode` is always saved as `input-order-cycle`; legacy or imported values may be read for review, but any new save path should normalize before writing.
