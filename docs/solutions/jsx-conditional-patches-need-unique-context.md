# JSX Conditional Patches Need Unique Context

## Context

When adding a Heat Map-only conditional around a repeated JSX `button` pattern, a broad patch anchor matched an unrelated group-display control and left an unmatched conditional expression.

## Lesson

For repeated JSX structures, anchor a patch on the nearest unique semantic attribute or surrounding section instead of a generic opening tag. Immediately inspect the diff and run the focused transform/test command before adding more changes.

## Applied Rule

Use a unique `aria-label`, `className`, or enclosing section when patching conditional UI controls. Treat a transform error after a patch as evidence to inspect the exact changed region before attempting another edit.
