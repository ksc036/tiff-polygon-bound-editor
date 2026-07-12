# Implementation plans need executable test examples

## Context

A TDD implementation plan can appear complete while its test steps contain only comments such as `// assert navigation persistence`. That leaves selectors, setup, API expectations, and the actual acceptance condition unresolved until implementation, defeating the plan's role as a precise handoff.

## Rule

Every planned test step must show executable setup, action, and assertion code. Comments may explain why an assertion exists, but they cannot stand in for the assertion.

For UI work, include the concrete accessible selector, event, and observable result:

```js
fireEvent.click(screen.getByRole("button", { name: "Next image" }));

await waitFor(() => {
  expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-b/heatmap?cellSize=20");
});
```

Scan implementation plans for placeholder comments and ellipses before dispatching an implementer.
