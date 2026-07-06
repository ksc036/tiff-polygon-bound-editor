# ROI Performance Tests Need Observable Contracts

## Context

While optimizing ROI calculation, the first planned test tried to prove that far-away pixels are not assigned to any ROI band. That behavior was already true before the optimization because pixels beyond the far band were filtered after a full-image scan.

## Lesson

Performance work needs a testable contract that exposes the optimization boundary, not only the final behavior. For ROI scan reductions, test the derived scan window directly, then separately assert that assignment semantics stay the same for representative pixels.

## Applied Rule

When changing an algorithm from full-image scanning to bounded scanning:

- Add a focused helper or instrumentation that makes the scanned domain observable.
- Write a failing test against that contract before changing the loop.
- Keep a behavior-preservation test for nearest-group and band assignment.
