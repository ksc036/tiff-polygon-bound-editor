---
problem_type: knowledge
component: frontend-interaction-tests
---

# JSDOM Pointer Events Need Coordinate-Bearing Events

When a jsdom test depends on `clientX` or `clientY`, verify that the pointer-event helper actually preserves those coordinates. In environments without a native `PointerEvent`, `fireEvent.pointerMove` can create an event whose coordinates are unavailable to React even though they were supplied by the test.

Dispatch a bubbling `MouseEvent` with a pointer event type and define the required pointer fields (`pointerId` and `pointerType`) on it. This still exercises the real React pointer handler while ensuring coordinate conversion receives the same fields a browser pointer event provides.
