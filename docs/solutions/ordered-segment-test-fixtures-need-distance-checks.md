# Ordered Segment Test Fixtures Need Distance Checks

When testing polygon segment insertion, verify fixture points against the actual
point-to-segment distance before treating them as "near" or "far." Closed-cycle
polygons include the final-to-first segment, so visually central points may sit
directly on that closing segment and accidentally defeat a threshold test.
