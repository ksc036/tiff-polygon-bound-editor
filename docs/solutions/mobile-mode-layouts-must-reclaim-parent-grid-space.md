# Mobile Mode Layouts Must Reclaim Parent Grid Space

## Context

The heatmap report had responsive dimensions and overflow guards, but it still collapsed on a mobile viewport because the parent stage grid reserved fixed-height rows for the analysis splitter and panel.

## Lesson

Responsive sizing must be verified through the full ancestor layout, not only on the component being added. A child cannot use available viewport space when a parent grid has already assigned that space to secondary controls.

## Applied Rule

When a mode changes the primary stage composition, add a mode class at the owning layout boundary. At each responsive breakpoint, verify the parent's row allocation, the rendered primary-content dimensions, and overflow. Add tests for the mode-specific parent selectors as well as the child component styles.
