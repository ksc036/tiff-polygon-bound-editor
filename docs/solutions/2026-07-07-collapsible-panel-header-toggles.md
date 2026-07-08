# Collapsible Panels Should Toggle From Their Header

## Context

A request to make the point order and outside ROI settings areas closable was implemented with visible `Hide/Show` buttons inside the panels.

## Lesson

When the user asks for the area itself to fold and unfold, the panel header or containing row should be the toggle target. Adding a separate hide/show button changes the interaction model and adds UI noise.

## Applied Rule

For collapsible editor panels, make the panel heading a full-width toggle with `aria-expanded` and keep explicit hide/show wording out of the visible UI unless the user asks for that control style.
