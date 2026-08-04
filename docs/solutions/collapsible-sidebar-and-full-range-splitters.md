# Collapsible Sidebars and Full-Range Splitters

## Context

The editor needed a collapsible Groups sidebar and a bottom analysis splitter that could move to the bottom edge. The current layout had no sidebar state or toggle, and an arbitrary `120px` minimum prevented the splitter from reaching the bottom.

## Rules

- Keep a collapsed panel's reopen control outside the panel so it remains reachable.
- Return the collapsed grid column to the primary editor instead of only hiding the panel contents.
- Set splitter limits from the requested usable range. If the handle must reach the bottom, permit a zero-height content pane while keeping the handle visible.
- Verify layout behavior in a real browser by checking both state and resulting element dimensions.
