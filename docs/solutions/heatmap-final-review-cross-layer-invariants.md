# Heatmap Final-Review Cross-Layer Invariants

Heatmap workflows need the same safety invariants at generation, persistence, and rendering boundaries:

- Enforce cell-count budgets before allocating or iterating cells, and repeat the limit at the client API boundary.
- Bracket mask decoding with file snapshots and compare `dev`, `ino`, `size`, and `mtimeMs` so pixels cannot be paired with different metadata.
- Keep durable user preferences separate from transient loaded data and errors; a failed comparison load should not disable future retries.
- Draw large static grids in a canvas effect whose dependencies contain only visual inputs, never pointer-only tooltip state.
- Give related async actions a shared request identity and let only the latest request update data, errors, or loading state.
