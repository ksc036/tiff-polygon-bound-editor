# Collapsed Panels Must Reclaim Stage Space

## Context

Point order and ROI settings were made collapsible, but the image stage kept the same hard-coded height budget, so the toggle did not meaningfully improve vertical workspace.

## Lesson

For editor UIs, hiding panel contents is not enough. Collapse controls must reduce the panel footprint and return that space to the primary canvas or image stage.

## Applied Rule

When adding collapsible bottom panels, connect the open state to both panel compact styling and the stage sizing budget. Test the state-to-layout link, not just the hidden content.
