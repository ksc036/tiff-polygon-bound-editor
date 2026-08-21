# Inference Rectangle Pixel Bounds

Inference-page ROI rectangles use half-open pixel bounds: include `x <= pixelX < x + width` and `y <= pixelY < y + height`.

Do not reuse polygon point-in-polygon inclusion for these rectangles. Polygon edge handling can include an extra bottom or right pixel row, causing the displayed rectangle and its area-fraction calculation to disagree.
