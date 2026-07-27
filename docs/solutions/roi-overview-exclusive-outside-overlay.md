# ROI Overview Outside Overlay Ownership

The ROI overview report must derive its outside-region pixels from
`assignOutwardRoiPixels`, using the same group-specific bands as analysis.

Drawing one masked SVG stroke set for each group is incorrect when expanded
regions overlap: a pixel can be painted more than once and its displayed color
can diverge from the group and band that own it in statistics. Build one RGBA
overlay from the assignment map instead. Write each assigned pixel once with a
semi-transparent alpha, then composite that PNG above the normalized source.

Keep polygon boundaries and labels in SVG. The `Gxx-A` union remains
legend-only.

The synchronous `buildRoiOverviewSvg` fallback follows the same ownership
rule. It must not restore independent cumulative polygon strokes when no PNG
overlay URL is supplied. Convert the assignment map into contiguous per-row
rectangles grouped by group and band, with the same semi-transparent fill.
This keeps the builder compatible and inspectable without creating one SVG
element per pixel.
