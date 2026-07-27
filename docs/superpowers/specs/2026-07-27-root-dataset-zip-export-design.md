# Root Dataset ZIP Export Design

## Goal

Export every image folder under the active root as a readable ZIP dataset that
contains the original TIFF, source mask, an annotated ROI overview, rendered
heatmaps for every saved cell size, and an image-specific Excel workbook.

The exported ROI IDs, colors, and statistics must agree with the identifiers
shown in the application.

## Confirmed Decisions

- Replace the top-toolbar `Load saved bound` button with `Download as ZIP`.
- Export every valid image folder under the active root in storage sort order.
- Preserve each root child folder name inside the ZIP.
- Include the original TIFF only; do not add a separate plain origin PNG.
- Copy the selected source mask in its original file format.
- Generate one combined origin-plus-ROI overview PNG per image.
- Render both Pixel Density and Estimated Collagen Density heatmaps.
- Discover and export every valid saved heatmap size, not only UI presets.
- Add previous-image comparison heatmaps for every image except the first.
- Compare each image with the immediately preceding image in storage sort order.
- Use a shared symmetric comparison range for the same metric and cell size
  across the complete export sequence.
- Put the value scale, ticks, and unit beside every heatmap.
- Generate one Excel workbook per image folder.
- Link ROI images, application statistics, and Excel rows with both stable IDs
  and group colors.
- Auto-save dirty bounds for the current image before starting the export.
- Use available data and record missing, stale, or incompatible artifacts
  instead of failing the whole ZIP.
- Stream the ZIP response without leaving a persistent export folder.

## User Interface

### Toolbar

Remove `Load saved bound`. Saved bounds continue to load automatically when the
active image changes.

Add `Download as ZIP` in the same toolbar area. The button is disabled when no
root is active and while an export is running.

When activated:

1. If the current bounds are dirty, save them through the existing bounds API.
2. Submit the active calibration values and export request to the server.
3. Show `Preparing ZIP...` and disable the button until a response or error.
4. Download the response as
   `<root-name>_export_<YYYYMMDD-HHmmss>.zip`.
5. Restore the normal button state after completion or failure.

If current bounds are saved immediately before export but saved analysis may
have been calculated from an older bounds revision, record a warning in that
image's `Export Report` sheet. Export does not recalculate analysis.

### ROI Identifiers

Assign group IDs from the saved group array order for each image:

- first group: `G01`
- second group: `G02`
- continue with zero-padded sequential numbers

Assign ROI row IDs as follows:

- outside near: `<group>-N`
- outside mid: `<group>-M`
- outside far: `<group>-F`
- outside all bands: `<group>-A`
- inside area: `<group>-I`

Examples are `G01-N`, `G01-A`, and `G02-I`.

Display the group ID and color swatch in the group list. Add `ROI ID` and the
same color swatch to the on-screen statistics table. When ROI display is
enabled, show the corresponding ROI ID labels on the overlay.

## ZIP Layout

The archive contains one top-level export directory followed by the active
root's image folder names:

```text
<root-name>_export/
  <image-folder>/
    image/
      <original-file>.tif
    mask/
      <selected-mask-file>
    roi/
      <image-folder>_ROI_overview.png
    heatmap/
      <cell-width>x<cell-height>/
        <image-folder>_cell_<size>px_pixel_density.png
        <image-folder>_cell_<size>px_collagen_density.png
        <image-folder>_cell_<size>px_pixel_density_vs_<previous>.png
        <image-folder>_cell_<size>px_collagen_density_vs_<previous>.png
    statistics/
      <image-folder>_statistics.xlsx
```

Comparison files are absent for the first image. A comparison file is also
absent when the current and previous saved heatmaps do not have compatible
dimensions, rows, columns, or cell geometry. The workbook records why it was
skipped.

Only requested export artifacts are included. Existing bounds JSON, analysis
JSON, skeleton files, and heatmap JSON remain source data and are not copied
into the ZIP.

## Data Sources

### Original

Copy the storage-selected TIFF without conversion or pixel modification.

### Mask

Use the same mask source selection rule as analysis and heatmap generation.
Copy that source file without conversion.

### Bounds and Analysis

Load saved bounds and saved analysis from the existing storage paths. The
export must not mutate analysis, skeleton, mask, or heatmap files.

### Heatmaps

Discover valid saved heatmap directories under each image's `heatmap` folder.
Validate each JSON payload through the existing heatmap validation rules,
including current mask metadata. Missing, invalid, or stale heatmaps are
skipped and reported.

### Calibration

The request includes the current client values:

```text
Pixel Density = a * Collagen Density + b
Collagen Density = (Pixel Density - b) / a
```

Both values must be finite and `a` must be non-zero. The same calibration is
used for all collagen-density heatmaps and Excel values in one export.

## Heatmap Rendering

Render standalone report PNGs rather than screenshots of the application.

Saved sizes such as `5x5`, `10x10`, and `20x20` describe the width and
height, in source-image pixels, covered by one heatmap cell. They do not
describe the number of rows and columns. The output title records both the
cell size and the resulting grid dimensions.

Every image includes:

- a title with image folder, metric, cell size, and grid columns by rows;
- `Grid X` and `Grid Y` labels;
- discrete unsmoothed cells;
- a color bar to the right;
- numeric ticks, range, metric label, and unit.

### Absolute Maps

Pixel Density:

- value: `maskPixelCount / areaPx`;
- range: `0` to `1`;
- palette: the application's Inferno palette;
- color-bar label: `Pixel Density`.

Estimated Collagen Density:

- value: `(pixelDensity - b) / a`;
- display range: `0` to `3 mg/ml`;
- palette: the application's Inferno palette;
- color-bar label: `Estimated Collagen Density (mg/ml)`.

The rendered title and workbook metadata record the calibration values.

### Previous-Image Comparisons

For every compatible adjacent image pair:

```text
difference = current value - previous value
```

Positive values mean an increase from the previous image; negative values mean
a decrease.

Before rendering comparisons, scan the complete sequence and calculate one
`maxAbs` for each metric and cell size. Every comparison in that metric-size
set uses the same `-maxAbs` to `+maxAbs` range.

Use the application's diverging palette:

- negative: blue;
- zero: white;
- positive: red.

Color-bar labels are `Delta Pixel Density` and
`Delta Collagen Density (mg/ml)`.

The title names the previous image and prints the symmetric range.

## ROI Overview Rendering

Generate one `<image-folder>_ROI_overview.png` per image with valid saved
bounds.

The output contains:

- the TIFF rendered as a display-normalized grayscale background;
- all inside and outside ROI regions in one image;
- semi-transparent ROI fills;
- polygon boundaries drawn with each group's saved color;
- ROI ID labels;
- no editable vertices, point handles, or editor controls;
- a legend to the right of the image.

The legend maps group ID, group name, saved group color, analysis mode, ROI ID,
and outside distance ranges. `<group>-A` is described as the union of near,
mid, and far bands; it does not receive a separate fill.

When image labels would overlap, the image may show the representative group
ID while the right-side legend remains the authoritative mapping.

If bounds are missing or invalid, omit the ROI PNG and record the error in the
workbook.

## Image Workbook

Create `<image-folder>_statistics.xlsx` even when analysis or rendered assets
are incomplete so that every image has an export report.

### ROI Statistics

Write one row for every available analysis ROI. Columns are:

- ROI ID
- Group ID
- Group Name
- Group Color
- Analysis Mode
- ROI Label
- From px
- To px
- Area px
- Mask Pixels
- Pixel Density
- Estimated Collagen Density (mg/ml)
- ROI Alignment
- Radial Alignment
- Circumferential Alignment
- Migration Axis Alignment
- Empty
- ROI Image

Numeric measurements use numeric Excel cells with appropriate number formats.
Freeze the header, enable an auto-filter, size columns for scanning, and apply
the saved group color to the ID/color cells. The ROI Image cell links to the
relative ROI PNG.

For inside groups, radial, circumferential, and migration measurements remain
blank when they are not defined by the analysis contract.

### Image Summary

Record:

- image folder and TIFF file;
- width and height;
- selected mask, bounds, and analysis file names;
- group and ROI counts;
- available source timestamps;
- whether current bounds were auto-saved.

### Metric Definitions

Explain Pixel Density, Estimated Collagen Density, ROI Alignment, Radial
Alignment, Circumferential Alignment, and Migration Axis Alignment, including
their units and interpretation ranges.

### Heatmap Index

Write one row per generated or skipped heatmap with:

- cell width and height in source pixels;
- resulting grid columns and rows;
- metric;
- current image;
- comparison image, if any;
- color minimum and maximum;
- unit;
- status;
- relative PNG link or skip reason.

### Export Report

Record `Included`, `Skipped`, or `Warning` entries for each requested artifact,
including:

- missing or unreadable source files;
- missing or invalid bounds and analysis;
- missing, stale, or invalid heatmaps;
- incompatible previous-image comparisons;
- current bounds auto-save;
- stale-analysis warning after an auto-save;
- calibration values;
- export timestamp.

## Server Architecture

Add isolated modules with narrow responsibilities:

- export orchestration and archive entry naming;
- heatmap discovery, range precomputation, and PNG rendering;
- ROI overview rendering;
- workbook generation.

The export endpoint accepts calibration parameters, validates them, and
streams `application/zip` with a safe `Content-Disposition` filename.

Use structured image, workbook, and ZIP libraries rather than shell commands
or ad hoc binary formatting. Reuse existing storage resolution, mask
selection, heatmap validation, ROI geometry, and metric naming wherever their
contracts match export needs.

## Error Handling and Safety

- Never put absolute host paths into archive entry names or workbook links.
- Normalize archive names and reject path traversal.
- Treat each image as an isolated partial-success unit.
- Do not abort the archive because one image artifact fails.
- Abort before streaming for an unset root or invalid calibration.
- Close archive and renderer resources when the client disconnects.
- Avoid buffering the complete ZIP in server memory.
- Disable duplicate export requests in the client while one is active.
- Do not overwrite any source artifact except the explicitly auto-saved
  current bounds.

If workbook generation for one image fails, include a small text error report
in that image's `statistics` directory so the failure is not silent.

## Testing

### Unit Tests

- safe archive paths and deterministic filenames;
- group and ROI ID mapping;
- workbook sheets, numeric cells, filters, color fills, and relative links;
- absolute heatmap titles, ranges, units, and color bars;
- adjacent comparison ordering and subtraction direction;
- shared comparison ranges by metric and cell size;
- ROI overview labels, legend entries, and omission of point handles;
- partial-success status generation.

### Server Integration Tests

- ZIP contains the expected root and per-image structure;
- original TIFF and mask bytes are copied unchanged;
- every saved valid cell size produces both metrics;
- the first image has no comparison files;
- later images receive compatible previous-image comparisons;
- missing, stale, and incompatible data do not abort the ZIP;
- invalid calibration and unset root return safe errors;
- archive paths never expose absolute filesystem paths.

### Client Tests

- `Load saved bound` is absent;
- `Download as ZIP` appears in the toolbar;
- dirty current bounds are saved before the export request;
- calibration is included in the request;
- the downloaded filename comes from the response;
- loading, duplicate-click prevention, and error states work;
- on-screen ROI IDs and statistics IDs/colors agree.

### Browser Verification

Use a real root with multiple images to verify:

- the ZIP downloads and extracts;
- the directory structure is readable;
- TIFF and mask files open;
- ROI overview IDs match the application and workbook;
- heatmap titles and color bars are unobstructed;
- all available sizes appear;
- comparisons are absent only for the first or incompatible images;
- Excel sheets, numeric cells, filters, colors, and links open correctly.
