---
title: Implementation plans need executable test examples
date: 2026-08-03
last_updated: 2026-08-03
category: workflow-issues
module: Implementation planning
problem_type: workflow_issue
component: brief_system
severity: medium
applies_when:
  - A plan provides exact test and implementation snippets for test-driven work
tags:
  - implementation-plans
  - test-driven-development
  - executable-examples
---

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

## Cross-Check Literal Assertions

Executable examples can still contradict each other. A source-contract test may require a contiguous substring while the supplied implementation inserts a newline or equivalent formatting between those tokens. Both snippets look valid independently, but a literal transcription cannot reach GREEN.

Before dispatch, apply each exact implementation snippet to a scratch copy and run the plan's exact test command. At minimum, compare every source-text assertion against the supplied source verbatim, including whitespace-sensitive strings and regular expressions. Resolve mismatches in the plan rather than leaving the implementer to choose which "exact" value wins.
