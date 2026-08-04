# Subimage Batch Errors Need HTTP Canonicalization

Service error text is an implementation detail, even when the service already
uses stable error codes. At the HTTP boundary, format every batch failure from
its stable `code`, retain only the public `imageFolder` and `code`, and never
forward the service `message` directly.

This lets the API maintain contracts that differ from service wording. For
example, a `DIMENSION_MISMATCH` batch failure must return `Source dimensions do
not match the template.` even when the preflight service describes the mismatch
as being against another batch image. Preserve dedicated safe messages for
root-scoped failures such as `BATCH_SCAN_FAILED`, including `imageFolder: null`.

Test the complete HTTP body for each documented batch failure contract and add
a path-leak assertion. This catches both accidental wording drift and unsafe
future service errors before they reach clients.
