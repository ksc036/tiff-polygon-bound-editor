# ROI preview strokes must scale with the image

## Context

Outside ROI preview bands are rendered as SVG polygon strokes. The `strokeWidth` value is intentionally computed in image pixels, for example `band.toPx * 2`, so that an outside band of 20 px represents 20 source-image pixels.

Using `vector-effect: non-scaling-stroke` on those bands made the stroke width behave like screen pixels instead. After the image stage became responsive and the displayed image size changed, polygon geometry scaled correctly but outside ROI band thickness no longer matched the image-coordinate distance.

## Rule

Do not use non-scaling SVG strokes for ROI distance bands. ROI preview strokes must scale with the SVG viewBox so they remain accurate in source-image coordinates.
