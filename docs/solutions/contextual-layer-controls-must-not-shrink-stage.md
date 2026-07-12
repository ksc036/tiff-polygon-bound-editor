# Contextual Layer Controls Must Not Shrink the Stage

## Context

Conditional Heat Map controls were rendered inside the stage toolbar. At constrained viewport height, their wrapped rows increased the toolbar height and reduced the same 4:3 image stage from 365x274 to 225x169.

## Rule

Contextual layer controls that can wrap must not participate in the stage-height layout. Place them in an existing scrolling inspector or side panel next to related controls, while keeping only stable layer and global stage controls in the stage toolbar. Do not reserve blank toolbar height or shrink other layers to match.

Add a DOM ownership test that proves the contextual controls are inside the scrolling panel and absent from the stage toolbar; browser measurements remain the final check for stage-size invariance.
