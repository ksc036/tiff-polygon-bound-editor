# Interactive Heatmap Report View Design

## Goal

Make the in-app Heat Map view use the same report anatomy as the PNG figures
inside Download as ZIP while preserving the interactive behaviors that are only
available in the browser.

The user should see the current image heatmap as a report figure with title,
calibration, range, Grid X/Y axes, ticks, cell grid, and a color bar. The raw TIFF
opacity slider and per-cell hover details must continue to work.

## Scope

This change affects only the client-side Heat Map display. It does not change:

- heatmap JSON files or folder layout;
- the 20, 50, and 100 pixel cell-size presets;
- heatmap generation or comparison calculations;
- Download as ZIP file contents;
- Original, Mask, Fiber QC, bounds, or ROI editing views.

## Chosen Approach

Recreate the exported report layout as an interactive React figure instead of
displaying an exported PNG.

Using the PNG would provide pixel-identical output, but it would remove TIFF
opacity control, cell hover, and immediate client-side calibration updates. The
React figure will use the same labels, ranges, tick policy, colors, and visual
ordering as the export renderer while retaining those interactions.

## Figure Content

The Heat Map stage will show a white report surface containing:

1. `Current: <image name>`.
2. `Previous: <image name>` when Compare Previous is enabled.
3. Metric, cell size, and grid dimensions in the same form as export:
   `<metric> | Cell <width>x<height> px | Grid <columns>x<rows>`.
4. The current calibration equation.
5. `Color range: <minimum> to <maximum> <unit>`.
6. The heatmap plot with a visible outer border and subtle cell boundaries.
7. Five evenly spaced zero-based ticks on Grid X and Grid Y, matching export.
8. A vertical color bar to the right of the plot with five values, `Scale`, and
   the metric label and unit.

For comparison mode, the title names both current and previous images, the
range is symmetric around zero, and the blue-white-red comparison color bar is
used. Absolute mode uses the existing inferno color scale.

The current sidebar color legend will be removed once the report color bar is
available, avoiding duplicate scales.

## Layout

The report is a single responsive figure fitted into the existing image-stage
frame. Its internal layout consists of a header band, Y-axis band, plot, X-axis
band, and right color-bar band.

The plot preserves the heatmap source image coordinate system. The heatmap
canvas and raw TIFF canvas occupy exactly the same plot rectangle. This keeps
cell hover and TIFF overlay registration correct, including partial cells at
the right and bottom image edges.

Report annotations never cover the plot:

- title, calibration, and range remain above it;
- Grid X and Grid Y remain outside it;
- the color bar remains to its right;
- the tooltip may float over the figure but follows the existing pointer-aware
  placement rules.

The figure scales down as one unit when space is limited. Text uses bounded,
responsive container sizing rather than viewport-scaled fonts. The plot remains
the largest area of the figure.

## Rendering And Z-Order

Within the plot, the layers are ordered as follows:

1. heatmap cell colors;
2. raw TIFF using the current Original opacity value;
3. subtle cell boundaries and the plot border;
4. hover tooltip.

This ensures the grid remains visible when TIFF opacity is greater than zero.
All report decoration uses `pointer-events: none`; stage pointer events continue
to resolve coordinates from the raw canvas plot rectangle.

## Shared Presentation Rules

Pure presentation helpers will provide:

- metric label and unit;
- absolute or comparison range;
- current/previous title lines;
- five axis tick values;
- five color-bar tick values;
- calibration text.

The client figure and ZIP export renderer will consume the same helpers where
practical so wording and tick values do not drift. Server-only PNG/SVG rendering
and browser-only layout remain separate.

## State And Data Flow

The report consumes existing state only:

- active image and previous image names;
- loaded heatmap and optional comparison values;
- selected metric and 20/50/100 cell size;
- density calibration slope and intercept;
- Original opacity;
- current image-space pointer.

Changing image, preset, metric, calibration, comparison mode, or opacity updates
the report immediately. Navigating left or right preserves the selected heatmap
preset and metric as it does now.

No additional API request is introduced.

## Empty And Error States

- While a heatmap is loading, the existing status remains visible and the old
  figure is not relabeled as the new image.
- Missing or invalid heatmap data keeps the existing error status and does not
  render misleading axes or a color bar.
- Invalid collagen calibration keeps the plot empty and reports the existing
  calibration error.
- Compare Previous remains unavailable for the first image and retains existing
  compatibility errors for mismatched heatmaps.

## Testing

Component tests will verify:

- absolute and comparison titles;
- calibration and range text;
- five zero-based X/Y ticks;
- five color-bar ticks and correct metric unit;
- inferno and comparison scale selection;
- grid rendering above the raw TIFF layer;
- pointer hover still maps to the correct cell;
- invalid calibration and missing data behavior.

App tests will verify that switching images, cell sizes, metrics, and Compare
Previous updates the report without adding server requests. Style tests will
lock the plot layer order and responsive containment. The full existing test
suite and production build must remain green.

## Acceptance Criteria

- The in-app Heat Map view is immediately recognizable as the same report shown
  in downloaded PNGs.
- Current/previous names, metric, cell size, grid dimensions, calibration,
  range, axes, and color scale agree with Download as ZIP.
- The raw TIFF overlay aligns only with the heatmap plot and respects opacity.
- Cell boundaries remain visible above the TIFF overlay.
- Hover reports the same cell values as before.
- No annotations obscure or resize unpredictably across supported desktop and
  mobile viewport sizes.
