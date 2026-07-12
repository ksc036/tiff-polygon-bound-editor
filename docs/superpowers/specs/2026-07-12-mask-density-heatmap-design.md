# Mask Density Heatmap Design

## Goal

Add precomputed collagen-mask heatmaps to the boundary editor. A user can choose a folder in Finder, generate heatmap data recursively for every image bundle below it, and inspect current or previous-image-difference heatmaps in the existing image workspace.

## Confirmed Behavior

- The source is the selected binary collagen mask, using the same foreground interpretation and mask selection rules as ROI analysis.
- Heatmap size means pixel cell size, not a fixed number of rows and columns.
- The default presets are Small `5x5 px`, Medium `10x10 px`, and Large `20x20 px`.
- Preset values can be edited before a batch generation run.
- Edited preset values are persisted in `localStorage` and drive both batch generation and viewer requests. For example, changing Small to `7x7 px` writes and loads `heatmap/7x7/`.
- The selected viewing size persists when navigating between images. A user viewing `20x20` continues viewing `20x20` on the next image.
- The display can switch between Pixel Density and Estimated Collagen Density.
- From the second image onward, the display can compare the current image with the immediately previous image in the app's sorted image order.
- The first image only supports the current heatmap because it has no previous image.

## Reference Notebook Behavior

The design follows `Heatmap_density_v1_ipynb` for the primary heatmap presentation:

- compute foreground occupancy per cell;
- render with an `inferno`-style continuous color map;
- use nearest-neighbor rendering so grid cells remain visually discrete;
- show a color legend and the active metric range.

`HH_heatmap_diff_v3.ipynb` provides the previous-image comparison concept. The app keeps raw signed differences instead of min-max rescaling each pair, so magnitudes remain meaningful. A diverging blue-white-red scale replaces `inferno` for signed differences because it distinguishes decreases, no change, and increases.

The app intentionally fixes two notebook edge cases:

- right and bottom remainder pixels are included in partial edge cells;
- row/column ordering works for rectangular images and does not transpose the heatmap.

## Heatmap Calculation

For a cell covering pixel region `C`:

```text
maskPixelCount(C) = number of foreground mask pixels in C
areaPx(C)         = actual number of image pixels in C
pixelDensity(C)   = maskPixelCount(C) / areaPx(C)
```

For image width `W`, height `H`, and cell size `SxS`:

```text
columns = ceil(W / S)
rows    = ceil(H / S)
```

Interior cells are `SxS`. Right and bottom edge cells use their actual smaller dimensions, and their density denominator is their actual area.

Estimated Collagen Density is derived on the client from the same editable calibration already used by the statistics table. If Pixel Density is `y`:

```text
x = (y - b) / a

default a = 0.069676956982087
default b = 0.067893820336777
unit      = mg/ml
```

The server stores Pixel Density only. Changing `a` or `b` immediately updates the estimated heatmap without regenerating files.

## Saved Data

Each image bundle keeps `heatmap` beside its existing `image`, `mask`, and `bound` directories:

```text
sample-folder/
├── image/
├── mask/
├── bound/
└── heatmap/
    ├── 5x5/
    │   └── sample-folder.heatmap.json
    ├── 10x10/
    │   └── sample-folder.heatmap.json
    └── 20x20/
        └── sample-folder.heatmap.json
```

Each JSON document contains:

```json
{
  "schemaVersion": 1,
  "imageFolder": "sample-folder",
  "maskSource": {
    "file": "frame001.png",
    "mtimeMs": 0,
    "size": 0
  },
  "width": 1008,
  "height": 1008,
  "cellWidth": 20,
  "cellHeight": 20,
  "columns": 51,
  "rows": 51,
  "cells": [
    {
      "row": 0,
      "column": 0,
      "x": 0,
      "y": 0,
      "width": 20,
      "height": 20,
      "areaPx": 400,
      "maskPixelCount": 64,
      "pixelDensity": 0.16
    }
  ],
  "updatedAt": "2026-07-12T00:00:00.000Z"
}
```

Writes use a temporary file followed by atomic replacement so an interrupted run does not leave valid-looking partial JSON.

## Batch Generation

The Heatmap controls include a `Choose Folder` action that opens Finder in the same manner as `Find Root`. This heatmap target is separate from the image-viewing root.

`Generate Heatmaps` recursively searches the selected folder. A directory is an image bundle when it contains sibling `image` and `mask` directories. For every bundle with a readable selected mask, the server generates all three configured cell sizes and overwrites the matching JSON files.

The operation reports:

- discovered image bundles;
- completed bundles and generated files;
- skipped bundles with no usable mask;
- failed bundles with safe, relative error details.

One failure does not stop other bundles. Generated responses and saved JSON never expose absolute server paths.

## Viewer UI

The existing layer control becomes:

```text
Origin | Mask | Fiber QC | Heat Map
```

Heat Map renders the original image with a translucent heatmap overlay. Its controls are visible only while Heat Map is active:

- metric: `Pixel Density` or `Estimated Collagen Density`;
- cell size: `Small`, `Medium`, or `Large`, with the current pixel size in each label;
- display: `Current` or `Compare Previous` when a previous image exists;
- opacity control;
- vertical color legend showing metric, unit, and active range.

The three preset values, selected metric, selected preset, and opacity are persisted in `localStorage`. Compare Previous remains active while navigating during the current session, except on the first image where Current is forced.

Hovering a cell shows:

- row and column;
- mask pixels and actual cell area;
- Pixel Density;
- Estimated Collagen Density using the current `a` and `b` values;
- previous and signed change values when comparison is active.

### Current Heatmap Color

- Pixel Density uses an `inferno` scale with fixed range `0..1`.
- Estimated Collagen Density uses an `inferno` scale with display range `0..3 mg/ml`, matching the density notebook presentation.
- Values outside the display range use the nearest endpoint color, while hover shows the unmodified calculated value.
- No interpolation is applied between cells.

### Previous-Image Difference

For every cell at the same row and column:

```text
pixelDensityDelta = current.pixelDensity - previous.pixelDensity
estimatedDelta    = currentEstimated - previousEstimated
```

The client computes differences from the two saved JSON documents; no difference files are saved. A symmetric blue-white-red legend is centered at zero. Its endpoints are `-maxAbs..+maxAbs`, where `maxAbs` is the largest absolute cell difference in the current pair. Hover always shows the unscaled signed value.

Comparison is unavailable when:

- the active image is first in sorted order;
- either image lacks heatmap data for the selected cell size;
- image dimensions, cell dimensions, rows, or columns differ;
- either saved JSON document is malformed or stale relative to its source mask.

The UI states the specific reason and keeps the current heatmap available.

## Server Interfaces

The server adds focused heatmap operations:

- select a batch target folder through Finder;
- recursively generate all requested cell sizes under that target;
- load one saved heatmap for an app image and cell size.

All cell-size inputs must be positive safe integers within a bounded server limit. Duplicate preset sizes are calculated once. Invalid target folders, unreadable masks, malformed saved data, and unsupported dimensions return safe public errors.

## Component Boundaries

- `server/maskHeatmap.js`: pure grid calculation, validation, saved DTO validation, and JSON serialization helpers.
- `server/heatmapService.js`: mask selection, recursive bundle discovery, atomic persistence, batch summaries, and image heatmap loading.
- `server/app.js`: HTTP routes and safe response mapping only.
- `src/lib/heatmap.js`: color mapping, estimated-density conversion, previous-image compatibility checks, and signed difference calculation.
- `src/App.jsx`: viewer state, fetch orchestration, controls, hover state, and integration with the existing stage.
- `src/styles.css`: controls, legend, overlay cells, tooltip, loading, empty, and error states using the existing design system.

## Error and Loading States

- Batch generation disables repeated submission, shows `Generating...` while the request is active, and shows completed, skipped, and failed counts after the response.
- Missing heatmap data shows a concise empty state with the selected cell size and does not hide the original image.
- Switching image, metric, or size cancels or ignores stale client responses.
- Invalid calibration disables the Estimated mode color calculation and explains that `a` must be a non-zero number and `b` must be numeric.
- Heatmap failures do not change bounds, analysis results, group visibility, or the current image root.

## Testing

Server unit tests cover:

- exact density values for full and partial edge cells;
- rectangular image row/column ordering;
- mask-source metadata and JSON schema;
- three default preset directories and filenames;
- editable and duplicate preset sizes;
- recursive bundle discovery;
- atomic writes and continuation after one bundle fails;
- safe loading and stale-mask detection.

API tests cover folder selection, batch request validation, batch summaries, saved heatmap loading, missing data, malformed data, and safe path handling.

Client unit and integration tests cover:

- the Heat Map layer and contextual controls;
- `5x5`, `10x10`, and `20x20` defaults;
- cell-size persistence across image navigation;
- Pixel Density and Estimated Collagen Density conversion using current calibration;
- `inferno` endpoint mapping and fixed current ranges;
- previous-image signed differences and symmetric range calculation;
- first-image comparison absence and incompatible-data messages;
- stale-response protection and cell hover values.

Visual verification checks desktop and constrained-height layouts, overlay alignment with the rendered image content rectangle, readable color legends, and preservation of existing Origin, Mask, Fiber QC, ROI, point, and group interactions.

## Non-Goals

- The first release does not save rendered PNG heatmaps; JSON is the source and the client renders the overlay.
- The first release does not save previous-image difference files.
- The first release does not compare arbitrary non-adjacent images.
- The first release does not change ROI analysis calculations or skeleton-based orientation metrics.
