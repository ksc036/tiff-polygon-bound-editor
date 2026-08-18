---
title: Probability map primitives need format and image-library contract tests
category: knowledge
---

## Context

Task 1 added strict NumPy probability-map parsing and Sharp PNG output.

## Guidance

Test both NumPy header-length variants and assert the parsed `fortran_order` value directly: a header value of `False` must remain false. Validate exact byte length and normalized float values before exposing the map. For one-channel PNG assertions with Sharp, explicitly call `.greyscale().raw()` when decoding because Sharp's default raw decode expands grayscale PNGs to RGB channels.

## Why This Matters

These format-library boundaries can otherwise produce tests that fail for incidental decoding behavior or silently accept data with the wrong memory layout.

For a 0.001 threshold grid, assign each value to `floor(value * 1000)` and evaluate every grid candidate, including empty bins. Rounding values or skipping empty candidates changes the meaning of `value >= threshold` and can miss a valid zero-fraction threshold.
