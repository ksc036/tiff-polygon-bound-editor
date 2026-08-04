# Crop Workflows Need Explicit State Invariants

Crop editors with templates must model the saved crop, visible draft, and owner template as distinct state. Size-lock eligibility should compare source and crop dimensions at both presentation and mutation boundaries; disabling a mode button alone is not a sufficient invariant.

Actions should submit the visible reviewed draft, while discard restores every coupled state value, including clearing an unsaved template. Async mutations must also cancel any active pointer interaction when they start and reject new pointer edits while busy, otherwise an old drag can resume after the response and overwrite server-confirmed state.

Presentational controls need explicit capability props and native `disabled` behavior. Passing an enabled button a no-op callback hides an ownership rule from users and weakens component-level tests.
