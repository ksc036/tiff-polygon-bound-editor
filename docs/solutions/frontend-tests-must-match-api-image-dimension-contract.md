# Frontend Tests Must Match API Image Dimension Contract

When an app reads image dimensions from a secondary endpoint, frontend tests must include records that omit dimensions from the list endpoint. Otherwise tests can pass while production computes pointer coordinates with `undefined` width and height.

For this bound editor, `/api/root` image records only expose identity fields. The authoritative dimensions arrive from `/api/images/:id/raw16` headers, so the UI must merge those dimensions into the active image before coordinate mapping, SVG viewBox rendering, and bounds clamping.
