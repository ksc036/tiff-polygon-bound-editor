# Manual Edits Must Use Apply Patch

## Context

While updating schema-version test expectations, a shell rewrite command was used for a simple bulk edit.

## Lesson

Even small manual source or test edits should use `apply_patch` in this workspace. Shell rewrite shortcuts make it easier to change more than intended and bypass the normal patch review shape.

## Applied Rule

Use `apply_patch` for manual code, test, and docs edits. Reserve shell commands for reading, testing, formatting, or generated mechanical output where the command itself is the intended operation.
