# Heatmap and Subimage ZIP Export Design

## Context

The root page already starts a dataset ZIP download by posting to `/api/export`. The client only saves the returned blob; the server snapshots the selected dataset and streams the ZIP through `writeDatasetZip`. The existing export includes source files, masks, boundaries, analysis data, ROI figures, saved heatmap figures, and per-image workbooks.

The heatmap stage has already been reduced to the bordered heatmap box without a title, filename, grid, axes, or attached scale. This design does not change that stage presentation. It extends the existing ZIP and adds a separate on-screen scale while preserving the current heatmap metric selector.

## Goals

- Preserve the current `/api/export` request and streaming ZIP architecture.
- Preserve every existing ZIP entry and add original, Subimage, heatmap, comparison, scale, and metadata outputs.
- Keep both Pixel Density and Estimated Collagen Density available in the interactive heatmap UI.
- Export only Estimated Collagen Density heatmaps and comparisons in the ZIP.
- Pair comparisons in image order as current minus previous, beginning with the second image.
- Produce full-image and independently cropped Subimage comparisons.
- Keep heatmap images and scale images separate.
- Record skipped outputs and their reasons without failing the whole ZIP when continuation is possible.

## Non-goals

- No new export endpoint or browser-side ZIP builder.
- No change to heatmap generation or inference.
- No removal of existing mask, boundary, analysis, ROI, or workbook exports.
- No title, filename, grid, axes, or scale added back to the heatmap image stage.
- No Pixel Density heatmap files in the new ZIP output set.

## Architecture

The client continues to call `POST /api/export` and download the response as a blob. The server continues to create a storage snapshot, scan images in the existing dataset order, and stream archive entries as they are rendered.

The export implementation will extend the existing planning and rendering units instead of introducing a parallel exporter:

- The export planner discovers source images, saved Subimages, and saved heatmaps for cell sizes 20, 50, and 100.
- Shared collagen-density conversion and color functions remain the single source of truth for client and server rendering.
- Focused renderers produce original previews, Subimage annotations and crops, heatmap-only images, comparison images, and scale-only images.
- The archive writer appends each completed buffer immediately so the full dataset is not accumulated in memory.
- A dataset report records dimensions, coordinates, included outputs, warnings, and skip reasons.

## Interactive Heatmap UI

The existing `Pixel Density` and `Estimated Collagen Density` metric buttons remain available and continue to control only the interactive display. Cell-size selection, `Compare Previous`, and `Original opacity` also remain.

A separate scale panel is added using the service's existing panel, typography, spacing, and control styles. It is not placed inside or immediately attached to the heatmap box.

- Pixel Density display: Inferno scale from 0 to 1.
- Estimated Collagen Density display: Inferno scale from 0 to 8 mg/ml.
- Compare display: blue-white-red diverging scale from `-M` through 0 to `+M`, where `M` is the current pair's maximum absolute difference.

The scale panel follows the currently selected interactive metric and comparison state. Existing heatmap-stage cleanup remains unchanged.

## ZIP Layout

All current archive entries remain. The following entries are added under each existing image folder:

```text
<image>/
  original/
    original_16bit.tif
    original_8bit.png
    original_with_subimage.png
  subimage/
    subimage_16bit.tif
    subimage_8bit.png
    dimensions.csv
  heatmap/
    20x20/full.png
    20x20/subimage.png
    50x50/full.png
    50x50/subimage.png
    100x100/full.png
    100x100/subimage.png
  compare/
    20x20/full_current_minus_previous.png
    20x20/subimage_current_minus_previous.png
    50x50/full_current_minus_previous.png
    50x50/subimage_current_minus_previous.png
    100x100/full_current_minus_previous.png
    100x100/subimage_current_minus_previous.png
```

Dataset-level additions are:

```text
<dataset>_export/
  scales/
    estimated_collagen_density.png
    comparison_20x20.png
    comparison_50x50.png
    comparison_100x100.png
  export_report.xlsx
```

Comparison files are absent from the first image folder by design. Missing optional inputs may also make individual entries absent; the report explains every such omission.

## Original and Subimage Rendering

The original 16-bit TIFF is copied without changing sample values. The original 8-bit PNG uses a per-image display transform:

```text
displayMin = percentile(source pixels, 1.0)
displayMax = percentile(source pixels, 99.8)
output = clip((pixel - displayMin) / (displayMax - displayMin), 0, 1)
```

Degenerate ranges use a deterministic fallback that avoids division by zero. The annotated original uses the same display transform and draws only the saved Subimage rectangle. Cell boundaries and other overlays are not drawn.

The Subimage TIFF is the saved 16-bit crop. The Subimage PNG uses the same display range as its parent original so the annotated original and crop have matching brightness. `dimensions.csv` records source width and height, crop x and y, crop width and height, and output filenames. The same fields are included in `export_report.xlsx`.

## Heatmap Rendering

For ZIP output, every valid saved cell value is converted from Pixel Density with the shared fixed inverse calibration and clamped to 0 through 8 mg/ml. The heatmap color is Inferno over that fixed range. Invalid or excluded cells use the existing no-data treatment and do not display a cell boundary.

Each heatmap-only PNG has the same width and height as its source image. A heatmap cell's value fills its covered source-pixel rectangle, including truncated cells at the right and bottom edges. The Subimage heatmap is cropped from this source-coordinate density raster using the saved Subimage rectangle, so its dimensions exactly equal the saved crop dimensions.

The absolute scale is exported once as `estimated_collagen_density.png`; it is never composited into a heatmap PNG.

## Comparison Rendering

Images use the existing dataset order. For index `i > 0`, comparisons calculate image `i` minus image `i - 1`. The first image has no comparison and this is treated as normal, not as an error.

Full-image comparison requires compatible source dimensions, heatmap cell sizes, rows, columns, and cell counts. Its values are current Estimated Collagen Density minus previous Estimated Collagen Density at corresponding source positions.

Subimage comparison uses each image's own saved crop coordinates. The current and previous density rasters are cropped independently, then compared by relative crop position. A Subimage comparison is generated only when both crops exist and their widths and heights match. Crop coordinates do not need to match.

Comparison colors use blue for decreases, white for zero, and red for increases. ZIP comparisons share a symmetric `-M` to `+M` range for each cell size across the complete exported dataset, allowing like-for-like visual comparison. One separate scale PNG is exported per cell size.

## Error Handling

Recoverable per-image or per-output failures do not abort the ZIP:

- Missing Subimage: include original and full heatmap outputs; skip Subimage outputs.
- Different Subimage dimensions: include individual Subimages; skip only that Subimage comparison.
- Missing or invalid heatmap: skip that cell size and dependent comparisons.
- Incompatible full-image dimensions or heatmap grids: skip the affected full comparison.
- Render failure for one derived file: skip that file and continue when its dependencies permit.

`export_report.xlsx` records image, cell size where relevant, output kind, status, and a specific reason. The first image's lack of comparison is recorded as not applicable rather than a warning.

Fatal errors remain limited to conditions where a valid archive cannot continue, including an unset or invalid root, snapshot failure, archive stream failure, or request cancellation.

## Testing

Client tests verify that both metric buttons remain, that the detached scale follows metric and comparison state, and that existing heatmap controls and the cleaned stage remain intact.

Shared conversion tests verify inverse-calibration values, clamping to 0 through 8 mg/ml, absolute colors, and diverging comparison colors.

Renderer tests verify:

- Original preview normalization and degenerate-range behavior.
- Annotated rectangle placement without boundary overlays.
- Exact TIFF and PNG dimensions for originals and Subimages.
- Full and Subimage heatmap dimensions and representative colors.
- Separate scale dimensions, labels, ranges, and colors.
- Current-minus-previous ordering.
- Independent Subimage coordinates with equal-sized crop comparison.
- Correct skips for mismatched crops and incompatible heatmaps.

ZIP integration tests inspect the generated archive for expected paths, TIFF/PNG dimensions, CSV fields, workbook rows, preserved legacy entries, and recorded skip reasons. The full test suite and production build must pass, followed by browser verification of the root-page heatmap controls, detached scale, and an actual ZIP download.

## Acceptance Criteria

- The existing Download as ZIP button downloads one archive through `/api/export`.
- Existing ZIP contents remain available.
- Every available image has the agreed original and Subimage files and dimensions metadata.
- Available 20, 50, and 100 heatmaps export full and Subimage Estimated Collagen Density PNGs without embedded scales.
- Every eligible image after the first has full and Subimage current-minus-previous comparison PNGs.
- Scale PNGs are separate and correspond exactly to exported colors and ranges.
- Interactive Pixel Density and Estimated Collagen Density selection remains unchanged except for the added detached scale panel.
- Recoverable omissions are explained in the report and do not prevent download.
