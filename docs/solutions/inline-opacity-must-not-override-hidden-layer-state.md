# Inline Opacity Must Not Override Hidden Layer State

## Context

The raw canvas set inline `opacity: 1` outside Heat Map mode. That declaration outranked `.raw-canvas.hidden-layer { opacity: 0 }`, so the raw TIFF could remain visible in Mask and Fiber QC if a preview layer failed.

## Rule

Apply inline opacity only while a mode owns that visual control. Let other modes use the base and state-class cascade, and test hidden modes for the absence of an inline opacity declaration as well as the hidden-layer CSS rule.
