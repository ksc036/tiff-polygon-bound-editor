---
title: Verify nearest-neighbor fixture distances before asserting order
date: 2026-07-03
tags:
  - tdd
  - geometry
  - tests
---

# Verify nearest-neighbor fixture distances before asserting order

When writing TDD fixtures for nearest-neighbor geometry, calculate the squared
distances between each expected step before encoding the asserted order. A
visually plausible path can still be wrong if another candidate is slightly
closer.

In Task 4, the first geometry test expected point `c` after point `b`, but
point `d` had the smaller squared distance from `b`. The implementation
correctly followed the nearest-neighbor rule, while the test fixture encoded a
wrong assumption.

Use fixture coordinates where each expected nearest step is obvious by squared
distance, or include a quick distance check in the test-writing notes.
