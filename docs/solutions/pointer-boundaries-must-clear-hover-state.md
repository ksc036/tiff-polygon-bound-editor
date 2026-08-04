# Pointer Boundaries Must Clear Hover State

## Context

The heatmap correctly rejected pointer coordinates outside its plot, but an existing tooltip remained visible after the pointer moved from a cell to a report title, axis, or color scale.

## Lesson

A failed pointer-coordinate conversion is a state transition, not a no-op. When the pointer leaves an interactive coordinate space, clear transient hover state before returning.

## Applied Rule

Test pointer boundaries in sequence: first create an active hover inside the plot, then move to a non-plot annotation and assert that the tooltip disappears. A test that visits the annotation before any hover cannot detect stale state.
