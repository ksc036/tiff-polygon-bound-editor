# Mode Controls Need A Target

## Context

The boundary editor lets each group choose an analysis mode: outside ROI bands or inside-area analysis. The mode controls were disabled whenever no group was active.

## Lesson

If a user's natural first action is choosing a configuration, the UI should either create/select the object being configured or make the missing prerequisite explicit. Silently disabling the control hides the dependency and makes the setting look broken.

## Applied Rule

For group analysis mode controls, clicking `Inside area` or `Outside ROI` with no active group should create a new group, select it, and apply the chosen mode. Existing active groups should still update in place.
