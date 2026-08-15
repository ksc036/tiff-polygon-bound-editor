# Inference Mask Setting Design

## Purpose

Add `/inferencePage`, a separate workflow for creating binary collagen masks from
per-pixel U-Net++ probability maps. It uses the existing dataset root convention:

```text
<root>/<timestamp>/image/<source>.tif
```

The source image is read-only. Inference creates only new derived files under the
same timestamp folder.

## Stored Files

For every image, the application may create:

```text
<root>/<timestamp>/
  image/<source>.tif                       # never modified
  probability-maps/<source>.probability.npy
  probability-maps/<source>.mask-setting.json
  mask/<source>.png                        # generated only by Generate masks
```

`<source>` is the source file stem. A probability map is a NumPy `.npy` file
containing one C-order `float32` array of shape `[imageHeight, imageWidth]`.
Every value is normalized collagen probability in the inclusive range `[0, 1]`.

The mask-setting JSON stores only threshold/provenance state needed to reopen the
workflow (schema version, source identity, threshold, reference image identity,
area fraction target, and updated time). It never changes the TIFF source.

## Inference Service Contract

The eventual model server exposes one endpoint:

```http
POST /v1/inference/probability-map
Content-Type: multipart/form-data

file: <source TIFF>
```

On success it returns the `.npy` bytes directly:

```http
200 OK
Content-Type: application/x-npy
```

The returned array must have the source image's exact width and height, `float32`
dtype, C-order layout, and values within `[0, 1]`. An error response is JSON with
an `error` message and a non-2xx status.

The browser never calls the model server directly. The local application backend
uploads each source image sequentially, validates the response, and writes it to
the timestamp's `probability-maps` folder. This avoids browser CORS restrictions
and lets the client observe durable progress.

## Root Scan And Progress

The inference root scan accepts timestamp folders with an `image` directory and
at least one TIFF image. Unlike the analysis root scan, a `mask` directory is not
required before inference.

Each discovered image has one of these client-visible states:

| State | Meaning |
| --- | --- |
| Waiting | No saved probability map and no active job. |
| Sending | The sequential backend job is uploading or waiting for the model response. |
| Complete | A valid, dimension-matched probability map is saved. |
| Failed | The last request failed; its reason is shown and it can be retried. |

Existing valid probability maps are considered complete when a root is reopened.

## Threshold Workflow

1. Select any complete image. Its initial threshold is `0.5` unless its saved
   mask-setting JSON provides a prior threshold.
2. Adjust the selected image's threshold while viewing the source image plus its
   thresholded mask overlay. Show Area Fraction for the whole image and, when a
   saved polygon ROI exists for that image, for the selected ROI.
3. The user explicitly fixes this selected image as the reference. Threshold
   adjustment alone does not change any other image.
4. The user presses **Set other thresholds from reference**. For every other
   complete image, select a threshold in `[0, 1]` whose area fraction is nearest
   to the reference target:
   - use the same saved ROI geometry when the reference has a valid ROI;
   - otherwise use whole-image area fraction.
5. Each suggested threshold remains individually editable. A later manual edit
   changes only that image. The batch action may be run again from a different
   reference image when the user deliberately requests it.

For deterministic results, threshold matching uses an inclusive 0.001 step grid
and chooses the lower threshold if two candidates have the same absolute error.
The resulting per-image thresholds are persisted in their own mask-setting JSON.

## Visual Review And Generation

The page provides previous/next navigation over complete images, preserving the
current overlay and threshold view. This is a review stage; it does not write a
mask merely because the slider moved.

**Generate masks** applies each image's current persisted threshold to its saved
probability map, writes a binary PNG at `mask/<source>.png`, and reports per-image
success or failure. Generated masks use foreground value 255 and background value
0, match the original image dimensions, and are compatible with the existing
analysis and heatmap paths.

## Page Layout

- Top bar: root path, folder picker, model server URL, and sequential inference
  action/status.
- Left list: naturally sorted timestamp/image rows with Waiting, Sending,
  Complete, or Failed status.
- Main stage: raw source image with the thresholded mask overlay; ROI boundary is
  shown only when it is used for area-fraction matching.
- Right controls: threshold, whole-image Area Fraction, optional ROI Area
  Fraction, reference marker, and the explicit batch-threshold action.
- Footer: previous/next review controls and Generate masks summary/action.

## Boundaries And Failure Rules

- Missing or invalid bounds never block whole-image thresholding or mask
  generation; they simply disable ROI matching for that image.
- A response with an unsupported `.npy` schema, wrong dimensions, non-float32
  dtype, non-finite values, or values outside `[0, 1]` is rejected and not saved.
- An existing probability map is overwritten only after a fresh successful model
  response has passed validation.
- Batch inference continues after a per-image failure and records failures for
  retry.
