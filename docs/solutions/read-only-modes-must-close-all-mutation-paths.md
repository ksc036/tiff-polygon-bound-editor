# Read-Only Modes Must Close All Mutation Paths

## Context

Heat Map hid the editable bounds overlay and its editor controls, but the sidebar still exposed group selection and display controls. Those controls changed `activeGroupId`, hover and migration draft state, plus group draw and stats visibility.

## Rule

Treat a read-only mode as a complete interaction boundary. Enumerate every control, event path, and passive state readout that is inappropriate for the mode, hide or disable those paths and readouts in the read-only mode, and keep permitted read-only controls and status readouts available.

## Regression Test

Use a round-trip test with multiple groups: select a non-default group, establish display state, enter the read-only mode, assert every group selection and display action is absent, then return to the editable mode and assert the selected group and display state are unchanged.
