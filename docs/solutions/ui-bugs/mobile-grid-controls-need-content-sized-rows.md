---
title: Mobile Grid Controls Need Content-Sized Rows
date: 2026-08-15
category: ui-bugs
module: Responsive application layouts
problem_type: ui_bug
component: frontend_layout
symptoms:
  - A mobile control panel is clipped to a short grid row while its footer appears immediately below it.
  - Desktop layout tests pass even though controls are unreachable at a narrow viewport.
root_cause: layout_constraint
resolution_type: code_fix
severity: medium
tags: [css-grid, responsive-layout, mobile, browser-testing]
---

# Mobile Grid Controls Need Content-Sized Rows

## Problem

A desktop application grid was collapsed to one column for mobile, but its controls row used `auto` while the panel retained `overflow: auto` and inherited a constrained application height. The browser assigned the row too little space, clipped the controls, and placed the footer before the panel's full content.

## Solution

Use an explicit content-sized row for controls and let that panel participate in page scrolling at the mobile breakpoint:

```css
.page {
  grid-template-rows: auto auto minmax(420px, 60vh) max-content auto;
  overflow: auto;
}

.controls {
  overflow: visible;
}
```

Keep internal scrolling on desktop, where the viewport-height application shell intentionally constrains side panels.

## Prevention

- Verify narrow layouts in a real browser after the production build.
- Compare each panel's bounding height with its `scrollHeight`.
- Assert that controls end before the footer begins and that document width does not exceed viewport width.
- Add a focused style regression test for the mobile grid row and overflow contract.
