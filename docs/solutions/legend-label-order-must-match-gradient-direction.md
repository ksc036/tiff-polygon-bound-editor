# Legend Label Order Must Match Gradient Direction

## Context

A horizontal Heat Map legend used a left-to-right low-to-high color gradient while its JSX rendered the maximum label on the left and the minimum label on the right. The comparison ramp also paired blue/decrease with `+maxAbs` and red/increase with `-maxAbs`.

## Rule

Render labels in the same semantic order as the visual scale: minimum or `-maxAbs` on the left, zero in the center when applicable, and maximum or `+maxAbs` on the right. Keep the accessible DOM order aligned with that direction and test it explicitly.
