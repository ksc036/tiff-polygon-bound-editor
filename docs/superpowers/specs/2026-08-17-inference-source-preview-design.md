# Inference Source Preview Design

## Goal

Show each source TIFF as soon as an inference root is loaded. Users can switch the review stage among the original source, source with the thresholded probability-map mask overlaid, and the binary mask alone.

## Interaction

- Every source row is selectable, regardless of its inference status.
- The selected TIFF is loaded through the existing opaque-ID raw16 endpoint and rendered immediately.
- A three-option view control selects `Original`, `Overlay`, or `Mask`.
- `Original` renders only the TIFF.
- `Overlay` renders the TIFF plus the thresholded mask when the source has a valid probability map. While waiting or failed, it renders the TIFF without an overlay and identifies that the probability map is unavailable.
- `Mask` renders only the thresholded binary mask when available. While unavailable, it leaves the stage empty and identifies that the probability map is unavailable.

## State Boundaries

- Source-image selection is independent from probability-map review readiness.
- Threshold, ROI fraction, propagation, and mask generation remain available only for sources whose status is `complete`.
- Existing response identity checks continue to reject stale raw-image, review, overlay, root, and job-poll responses.

## Testing

- Cover a waiting source rendering its raw16 TIFF after selection.
- Cover that view-mode buttons drive original, overlay, and mask-only rendering.
- Cover unavailable probability maps preserving the source in overlay mode and withholding the mask-only image.
- Preserve complete-source review, threshold, and navigation coverage.
