# Subimage Final-Review Invariants

Subimage mutation workflows need explicit invariants across storage and UI state:

- Capture a narrow, immutable, request-scoped write context before the first asynchronous boundary when files are selected through a mutable root. Every lookup, read, scan, and write in that operation must use the captured context so related artifacts cannot be split across roots.
- Model draft existence separately from a committed size lock. A user may redraw an initial template until persisted data establishes the lock; later partial successes must preserve it even if the unsaved owner draft is discarded.
- After a partial batch, a retained client template should rehydrate a failed owner's missing draft when it fits, while a saved active crop remains authoritative.
- Require evidence that a confirmation flow produced a new candidate. Entering a replacement mode or receiving pointer down/up without valid geometry must never make an unchanged saved value eligible for confirmation.
