# Local ROI Preview Must Preserve UI Contracts

## Context

Moving ROI preview from server-rendered PNG overlays to client-rendered SVG made range adjustment fast, but it also collapsed near/mid/far visual encoding into the active group color. The ROI number inputs also treated an empty draft value as `0`, so clearing a field before typing could produce values like `030`.

## Lesson

When replacing server-rendered UI with local client rendering, preserve the original visual semantics and input editing behavior. Fast local preview should not weaken band readability or make numeric editing awkward.

## Applied Rule

- Keep ROI band colors independent from group colors: near red, mid amber, far blue.
- Numeric inputs that users edit manually need an empty draft state.
- Convert draft values to validated numbers only when deriving bands or submitting calculations.
