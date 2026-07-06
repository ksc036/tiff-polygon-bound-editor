# Outward Boundary ROI Analysis Design

## Summary

Build an image-level analysis workflow on top of saved cell boundary polygons.
Each saved boundary defines outward distance-based ROI bands around the cell.
The app reads the latest binary mask from `mask/`, skeletonizes it into a
`Skeletonize/` folder, computes ROI metrics from the skeleton, and writes one
analysis JSON file under `analysis/` for that image. There is no CSV summary in
the MVP.

The workflow is intentionally recalculation-based: opening an image loads saved
boundary and saved analysis JSON when they exist, while pressing `Recalculate`
always re-reads the current mask file and recomputes skeleton and metrics.

## Confirmed Decisions

- ROI direction: outward from the cell boundary only.
- Default ROI bands, in image pixels:
  - `near` / `가까움`: `0 <= distance < 20`
  - `mid` / `중간`: `20 <= distance < 50`
  - `far` / `멀리`: `50 <= distance < 100`
- ROI band distances are editable by the user before recalculation. In the MVP,
  the UI keeps the three bands contiguous by editing the upper limits
  `20`, `50`, and `100`; the lower limits are derived from the previous band.
- Mask source priority: first use the PNG in `mask/` with the same basename as
  the image; if missing, use the first sorted `mask/*.png`; if no PNG exists,
  use the matching `mask/*.tif` or `mask/*.tiff`, then the first sorted TIFF.
- Save skeletonized mask output to `Txx/Skeletonize/`.
- Save image analysis output to `Txx/analysis/`.
- Save analysis as per-image JSON only.
- Store both radial-normal alignment and tangential alignment.

## Folder Contract

For an image folder such as `selected-stack-sequence_T01/`:

```text
selected-stack-sequence_T01/
  image/
    selected-stack-sequence_T01.tif
  mask/
    selected-stack-sequence_T01.png
    selected-stack-sequence_T01.tif
  bound/
    selected-stack-sequence_T01.bounds.json
  Skeletonize/
    selected-stack-sequence_T01.skeleton.png
  analysis/
    selected-stack-sequence_T01.analysis.json
```

The app creates `Skeletonize/` and `analysis/` on demand.

## Analysis JSON Shape

```json
{
  "schemaVersion": 2,
  "imageFolder": "selected-stack-sequence_T01",
  "imageFile": "selected-stack-sequence_T01.tif",
  "boundsFile": "selected-stack-sequence_T01.bounds.json",
  "maskSource": {
    "file": "selected-stack-sequence_T01.png",
    "format": "png",
    "width": 1008,
    "height": 1008,
    "mtimeMs": 1783230000000
  },
  "skeletonFile": "selected-stack-sequence_T01.skeleton.png",
  "roiBands": [
    { "id": "near", "label": "가까움", "fromPx": 0, "toPx": 20 },
    { "id": "mid", "label": "중간", "fromPx": 20, "toPx": 50 },
    { "id": "far", "label": "멀리", "fromPx": 50, "toPx": 100 }
  ],
  "groups": [
    {
      "groupId": "group-1",
      "groupName": "Group 1",
      "color": "#e11d48",
      "bands": {
        "near": {
          "roiAreaPx": 12035,
          "maskPixelCount": 840,
          "density": 0.0698,
          "globalAlignment": 0.61,
          "globalOrientationDeg": 32.7,
          "radialNormalAlignment": 0.74,
          "tangentialAlignment": 0.26,
          "orientationDispersion": 0.39,
          "empty": false
        }
      },
      "allBands": {
        "roiAreaPx": 50240,
        "maskPixelCount": 2400,
        "density": 0.0478,
        "globalAlignment": 0.57,
        "globalOrientationDeg": 29.3,
        "radialNormalAlignment": 0.69,
        "tangentialAlignment": 0.31,
        "orientationDispersion": 0.43,
        "empty": false
      }
    }
  ],
  "imageSummary": {
    "roiAreaPx": 50240,
    "maskPixelCount": 2400,
    "density": 0.0478,
    "globalAlignment": 0.57,
    "radialNormalAlignment": 0.69,
    "tangentialAlignment": 0.31
  },
  "warnings": [],
  "updatedAt": "2026-07-05T00:00:00.000Z"
}
```

## Metric Definitions

All skeleton orientations are treated as undirected axes: `theta` and
`theta + 180°` are equivalent. Alignment metrics therefore use doubled-angle
orientation statistics.

### ROI Area

`roiAreaPx` is the number of pixels assigned to the band for a boundary group.
A pixel belongs to an outward band when:

1. it is outside the group polygon,
2. its nearest distance to the group polygon boundary falls within the band,
3. it is inside the image bounds.

For multiple boundary groups, ROI area and mask metrics use the same
exclusive assignment rule:

1. exclude pixels that are inside any saved cell polygon,
2. find the nearest boundary group and boundary distance for each remaining
   image pixel,
3. if the distance falls within one of the configured outward bands, assign the
   pixel to that one group and that one band.

This avoids double-counting both ROI area and mask pixels in image-level
summaries. Self-intersecting polygons are invalid for analysis because inside
and outside are ambiguous; boundary editing can still exist, but recalculation
should fail with a safe validation error until the polygon is corrected.

### Mask Pixel Count

`maskPixelCount` is the count of original binary mask foreground pixels assigned
to the ROI. Skeletonized masks are not used for this count.

### Density

`density = maskPixelCount / roiAreaPx`.

If `roiAreaPx` is zero, density is `null`; otherwise a band with no mask pixels
has density `0`.

### Global Alignment

For every skeleton sample with local orientation `theta`, compute:

```text
C = mean(cos(2 * theta))
S = mean(sin(2 * theta))
globalAlignment = sqrt(C*C + S*S)
globalOrientation = 0.5 * atan2(S, C)
```

`globalAlignment` ranges from `0` to `1`. Higher values mean skeleton
orientations inside the ROI are more consistently aligned.

### Radial-Normal And Tangential Alignment

For each skeleton sample:

1. find the nearest segment on the assigned boundary polygon,
2. compute the outward normal of that segment,
3. compute the tangent as the segment direction,
4. compare the local skeleton orientation with each axis.

Because skeleton direction is undirected:

```text
sampleRadial = abs(dot(skeletonUnitAxis, outwardNormalUnitAxis))
sampleTangential = abs(dot(skeletonUnitAxis, tangentUnitAxis))
```

The band metric is the mean of sample values. Both values are stored:

- `radialNormalAlignment`: high when fibers extend outward from the cell
  boundary.
- `tangentialAlignment`: high when fibers follow or wrap around the cell
  boundary.

Outward normal calculation must not depend on polygon winding order. For the
nearest boundary segment, test both perpendicular normals with a small offset
from the nearest point on the segment and choose the normal whose offset lands
outside the group polygon. If the test is ambiguous, fall back to the normalized
vector from the nearest boundary point toward the skeleton sample.

### Orientation Dispersion

`orientationDispersion = 1 - globalAlignment`.

This is stored because it reads naturally as disorder.

### Endpoint And Branchpoint Count

For skeleton foreground pixels, count 8-neighborhood foreground neighbors:

- endpoint: exactly one neighbor
- branchpoint: three or more neighbors

These are supporting structure-complexity metrics, not primary biological
readouts.

## Skeletonization

The server reads the selected mask with `sharp`, converts it to a binary
foreground image, and runs deterministic thinning. The MVP implementation should
use a local Zhang-Suen style thinning algorithm rather than adding a large image
processing dependency.

Foreground rule:

- Grayscale masks: any non-zero value is foreground.
- RGB/RGBA masks: any non-zero non-alpha channel is foreground. This handles
  binary `0/255` masks and future colored masks without relying on a specific
  channel.

The saved skeleton image is an 8-bit PNG:

- foreground skeleton pixels: `255`
- background: `0`

## API Design

### GET `/api/images/:id/analysis`

Loads saved analysis JSON if present.

Response:

```json
{
  "analysis": { "schemaVersion": 2 },
  "hasAnalysis": true
}
```

When no analysis exists, return:

```json
{
  "analysis": null,
  "hasAnalysis": false
}
```

### POST `/api/images/:id/analysis/recalculate`

Recomputes from the current saved boundary and latest mask source.

Request body:

```json
{
  "roiBands": [
    { "id": "near", "label": "가까움", "fromPx": 0, "toPx": 20 },
    { "id": "mid", "label": "중간", "fromPx": 20, "toPx": 50 },
    { "id": "far", "label": "멀리", "fromPx": 50, "toPx": 100 }
  ]
}
```

Validation:

- Require saved bounds to exist and contain at least one group with at least
  three points.
- Require a readable mask source.
- Require mask dimensions to match the boundary coordinate system.
- Require exactly three bands with ids `near`, `mid`, and `far`.
- Require ROI bands to be contiguous, sorted, finite, and `toPx > fromPx`.
- Require `near.fromPx = 0`, `mid.fromPx = near.toPx`, and
  `far.fromPx = mid.toPx`.
- Reject negative distances.
- Reject self-intersecting boundary groups.

Response:

```json
{
  "analysis": { "schemaVersion": 2 },
  "hasAnalysis": true
}
```

## UI Design

Add an analysis panel below or alongside the existing point-order controls,
following the current dense utility UI.

The panel shows:

- saved analysis status: none, loaded, stale, or just recalculated,
- editable ROI controls for `가까움`, `중간`, and `멀리`; the MVP edits the
  three upper limits and derives the lower limits so gaps and overlap are not
  created accidentally,
- `Load analysis` button if the user wants to discard unsaved analysis settings,
- `Recalculate` button that re-reads mask and overwrites skeleton/analysis files,
- compact metric table grouped by boundary group and ROI band,
- selected mask source and skeleton output file name,
- warnings such as missing mask, missing bounds, dimension mismatch, empty ROI,
  or possibly stale analysis.

Opening an image should:

1. load saved boundary as it does today,
2. load saved analysis if it exists,
3. keep the default ROI controls available even when no analysis exists.

Pressing `Recalculate` should not mutate boundary JSON. It should only write:

- `Skeletonize/*.skeleton.png`
- `analysis/*.analysis.json`

## Staleness Rules

Because masks can change, saved analysis includes source metadata:

- mask file name,
- mask modified time,
- bounds file modified time,
- ROI band settings,
- skeleton file name,
- analysis timestamp.

When loading saved analysis, the UI marks it as possibly stale if:

- the saved mask file no longer exists,
- the current mask file differs from the saved mask file,
- the mask modified time is newer than the analysis timestamp,
- the bounds file modified time is newer than the analysis timestamp,
- current ROI controls differ from saved analysis ROI bands.

Staleness should be a warning, not a hard error. The user can press
`Recalculate` to refresh.

## Error Handling

Return safe API errors without absolute filesystem paths or image library
internals.

Suggested statuses:

- `400`: invalid ROI band payload.
- `404`: unknown image id.
- `409`: missing saved boundary or missing mask source.
- `422`: corrupt boundary JSON, unreadable mask, dimension mismatch, or analysis
  calculation failure caused by user data.
- `500`: unexpected server failure.

## Tests

Unit tests:

- ROI band validation accepts default bands and rejects overlap, gaps caused by
  invalid ordering, negative values, and non-finite values.
- Point-in-polygon and distance-to-boundary assignment only includes outward
  pixels.
- Multiple groups assign ROI area and skeleton pixels to the nearest eligible
  boundary group without double counting.
- Skeletonization thins a simple thick line to one-pixel-wide skeleton.
- Endpoint and branchpoint counts match hand-built fixtures.
- Orientation tensor returns high alignment for parallel lines and low alignment
  for mixed orthogonal lines.
- Radial/tangential alignment fixtures distinguish outward rays from boundary
  following arcs.

Storage/API tests:

- `imagePaths()` exposes `Skeletonize/` and `analysis/` paths.
- GET analysis returns `{ analysis: null, hasAnalysis: false }` when missing.
- Recalculate creates both output folders and writes skeleton PNG plus analysis
  JSON.
- Recalculate prefers PNG mask over TIF when both exist.
- Recalculate falls back to TIF when PNG is missing.
- Recalculate rejects missing bounds, missing mask, and dimension mismatch with
  safe errors.

Frontend tests:

- Loading an image fetches saved analysis after saved bounds.
- Analysis controls render default Near/Mid/Far pixel bands.
- Editing ROI upper limits changes the recalculate payload and keeps bands
  contiguous.
- Recalculate button calls the API and displays returned metrics.
- Stale/missing/error states are visible and do not block boundary editing.

## Non-Goals For MVP

- No CSV summary.
- No whole-root batch analysis button.
- No physical unit calibration.
- No chart dashboard beyond a compact metric table.
- No manual skeleton editing.
- No automatic re-analysis on every mask or boundary change.

## Future Extensions

- Batch recalculate for all images with saved boundaries.
- Export summary CSV/TSV across all images.
- Pixel-to-micron calibration and physical-distance ROI bands.
- Overlay ROI bands and skeleton on the image canvas.
- Histograms of local orientation and distance-to-boundary.
- ROI overlap policies for dense multi-cell scenes.
