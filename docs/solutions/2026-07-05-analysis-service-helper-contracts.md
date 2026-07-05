# Analysis Service Helper Contracts

When orchestrating existing image-analysis helpers, verify the exact input shape each helper accepts before wiring modules together. In Task 3, `maskSkeleton.thinBinaryMask` returns a skeleton object with `{ data, width, height }`, while `analysisGeometry.buildSkeletonSamples` expects a pixel collection plus explicit dimensions. Passing the full skeleton object produced empty samples even though the skeleton PNG was valid.

Process rule: for cross-module service code, add at least one integration-style assertion that proves downstream metrics consume the upstream helper output, not just that files were written.

Review follow-up: public analysis JSON needs a dedicated DTO boundary even when the saved file lives under the app-controlled folder. `GET /analysis` must normalize persisted analysis into the approved public shape and strip unknown/internal fields such as absolute paths. For generated artifacts, write to a temp file and rename into place so failed helper writes cannot clobber the previous usable output.

Review follow-up: exported skeleton geometry helpers should either accept the
same `{ data, width, height }` image object produced by skeletonization or fail
with an explicit assertion. Silently treating that object as an indexable pixel
array creates empty samples while preserving apparently valid files.
