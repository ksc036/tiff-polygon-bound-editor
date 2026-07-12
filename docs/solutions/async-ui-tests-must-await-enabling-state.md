# Async UI Tests Must Await Enabling State

## Context

A folder-selection test clicked Generate immediately after clicking an async Finder action. The mocked response was already resolved, but React had not yet committed the selected path, so Generate was still disabled and the test observed no request.

## Rule

When one async interaction enables a later control, await a visible result of the first interaction before using the second control. Prefer the user-facing state that proves readiness, such as the selected path or an enabled button, instead of flushing promises or adding timing delays.

```jsx
fireEvent.click(screen.getByRole("button", { name: "Choose heatmap folder" }));
await screen.findByText("/selected/heatmap-root");
fireEvent.click(screen.getByRole("button", { name: "Generate Heatmaps" }));
```

This keeps the test aligned with the real UI transition and avoids making production controls less strict just to satisfy test timing.
