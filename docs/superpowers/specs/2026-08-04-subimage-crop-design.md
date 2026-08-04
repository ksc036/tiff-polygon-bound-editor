# Fixed-Aspect Subimage Crop Design

## Goal

Add a Subimage workflow to the existing TIFF sequence editor. A user defines one crop rectangle on the first image, creates matching subimages for the sequence, and can then adjust only the crop position for each image. Saved crops must preserve the original TIFF's 16-bit grayscale pixels without resizing or normalization.

## Scope

This feature will:

- add a `Subimage` image-layer mode;
- constrain the crop rectangle to the source image's aspect ratio;
- create the same crop size and initial pixel position for every image;
- allow per-image position changes by mouse drag only;
- write one cropped TIFF and one coordinate JSON file under each image folder;
- preserve existing per-image crops when creating missing crops;
- support explicitly replacing all crops with a newly selected template;
- warn before discarding an unsaved position change.

This feature will not:

- crop masks or skeleton images;
- resize cropped pixels to a fixed output resolution;
- support source images with differing dimensions in one batch;
- support per-image crop sizes;
- add subimages to the existing dataset ZIP export;
- add keyboard or on-screen nudge controls.

## Storage Contract

For an image folder containing `image/original.tif`, the feature owns:

```text
root/
  image-folder/
    image/
      original.tif
    subimage/
      original.tif
      crop.json
```

The cropped TIFF keeps the source filename. `crop.json` uses this schema:

```json
{
  "schemaVersion": 1,
  "imageFolder": "image-folder",
  "imageFile": "original.tif",
  "sourceWidth": 1008,
  "sourceHeight": 1008,
  "x": 120,
  "y": 80,
  "width": 400,
  "height": 400,
  "aspectRatio": 1,
  "updatedAt": "2026-08-04T00:00:00.000Z"
}
```

Coordinates and dimensions are integer source-image pixels. The crop must satisfy all of these rules:

- `width > 0` and `height > 0`;
- `x >= 0` and `y >= 0`;
- `x + width <= sourceWidth`;
- `y + height <= sourceHeight`;
- the crop ratio matches `sourceWidth / sourceHeight` within the one-pixel rounding needed for integer dimensions.

The JSON is the commit marker for a saved subimage. A TIFF without valid matching JSON is not reported as a saved crop.

## Server Architecture

Add a focused subimage service responsible for metadata validation, TIFF extraction, and batch orchestration. Extend the storage layer only with subimage paths and JSON persistence helpers; keep image processing out of storage.

### TIFF Processing

The supported source contract is the existing dataset format: single-channel 16-bit grayscale TIFF (`depth: ushort`, `space: grey16`, `channels: 1`). Other source formats fail validation and are not converted silently.

The crop pipeline is:

```text
source TIFF
  -> Sharp extract({ left, top, width, height })
  -> toColourspace("grey16")
  -> TIFF with lossless LZW compression
  -> output metadata validation
  -> atomic file replacement
```

This exact pipeline was checked against a current 1008x1008 source TIFF. The output remained `ushort / grey16 / 1 channel`, and the raw crop bytes matched the same source region exactly.

The service writes to a unique temporary TIFF in the destination directory. It verifies the temporary output's dimensions, depth, colour space, and channel count before renaming it to the source filename under `subimage/`. It then writes `crop.json` through a unique temporary file and renames the JSON last.

### API

`GET /api/images/:id/subimage`

- returns `{ hasSubimage: false, crop: null }` when no valid crop is saved;
- returns `{ hasSubimage: true, crop }` when TIFF and JSON are valid and consistent;
- reports invalid JSON or a missing/mismatched TIFF as a safe validation error.

`PUT /api/images/:id/subimage`

- accepts `{ crop }`;
- validates the active image, source metadata, bounds, and aspect ratio;
- replaces only the current image's cropped TIFF and JSON;
- returns the server-normalized crop payload.

`POST /api/subimages/create-missing`

- accepts `{ templateCrop }` from the first image;
- preflights every source image before writing;
- requires every source to have the template source dimensions and supported TIFF metadata;
- stops without creating files if any image fails preflight;
- preserves every valid existing subimage;
- creates only missing subimages with the same integer `x`, `y`, `width`, and `height`;
- returns created, preserved, and failed image-folder lists.

`POST /api/subimages/replace-all`

- accepts `{ templateCrop }` after a client confirmation;
- performs the same full preflight as create-missing;
- rewrites every image's cropped TIFF and JSON;
- returns replaced and failed image-folder lists.

Normal per-image writes are atomic. Batch processing is atomic per image, not across the whole root. Preflight failures cause no writes. A later filesystem failure can produce a partial batch; the response identifies completed and failed folders, and existing files for a failed image remain untouched whenever replacement did not complete.

## Client State

Keep Subimage state separate from polygon bounds and analysis state:

- saved crop for the active image;
- editable crop draft;
- root template crop;
- selection mode for drawing a new rectangle;
- size-lock state;
- loading, saving, batch-processing, and error states;
- dirty state derived from saved crop versus draft.

Loading a new image requests its saved crop. A valid saved crop becomes both the saved value and draft. When no crop exists and a template is available, the template is shown as an unsaved draft. When neither exists, the stage waits for `Set crop area`.

The first image in the root's existing filename order owns the batch template. The template is not stored in a separate root-level file: it is initialized from that first image's saved crop and retained in client state while the root is active. Creating or redrawing the initial template is available only while the first image is active. Replacing all crops may start from any active image; after replacement, every image, including the first, contains the new template crop.

Stale responses from a previously active image or root must not replace current Subimage state.

## User Interface

Add `Subimage` to the existing image-layer segmented control:

```text
Original | Mask | Fiber QC | Heat Map | Subimage
```

In Subimage mode, the stage shows the full original image. A mask darkens everything outside the crop rectangle while the selected region remains at normal brightness. A visible rectangle outlines the crop. Polygon points, ROI bands, migration vectors, and Heat Map presentation layers are not rendered in this mode.

The left panel becomes a Subimage control surface, following the existing Heat Map contextual-panel pattern. It shows:

- active image and saved/missing/dirty state;
- crop coordinates and dimensions as read-only values;
- `Set crop area`;
- `Create all subimages`;
- `Save subimage`;
- `Replace all subimages`.

Buttons are disabled while their required state is unavailable or while a request is running. Batch results show counts and image-folder names for created, preserved, replaced, and failed items.

`Create all subimages` is enabled only on the first image in filename order with a valid template draft. On later images, the panel identifies the first image as the template owner rather than offering a second template.

## Crop Interaction

### Initial Template

1. The user opens the first image and enters Subimage mode.
2. The user clicks `Set crop area`.
3. The next pointer drag defines a rectangle from the drag origin toward the pointer.
4. The rectangle is continuously constrained to the source image's aspect ratio.
5. The rectangle is clamped to the rendered image content and converted to integer source pixels.
6. The user may click `Set crop area` again and redraw before batch creation.
7. `Create all subimages` sends this rectangle as the template.
8. After successful creation, crop size is locked.

The aspect constraint uses the largest rectangle of the source aspect ratio that fits between the drag origin, pointer direction, and image edges. Integer rounding must keep the final rectangle inside the source image.

### Per-Image Position

After creation, the user drags from inside the crop rectangle to move the whole rectangle. Width and height never change. Pointer movement is mapped through the rendered image content rectangle to source pixels. The final position is clamped so the crop stays entirely inside the source image.

Dragging changes only the client draft. `Save subimage` sends the draft to the current-image endpoint and replaces that image's TIFF and JSON. No server writes occur during pointer movement.

### Replacing the Template

`Replace all subimages` starts a new-template flow:

1. the current size lock is temporarily released;
2. the user draws a new source-aspect rectangle;
3. the client shows an explicit destructive confirmation;
4. approval sends the new template to the replace-all endpoint;
5. success loads the active image's new saved crop and locks size again;
6. cancellation leaves every saved crop unchanged.

## Navigation and Unsaved Work

If the Subimage draft is dirty, the app asks for confirmation before:

- moving to the previous or next image;
- changing the root;
- using Find root;
- leaving Subimage mode;
- closing or reloading the browser page.

Confirming discards only the unsaved draft and proceeds. Cancelling leaves the active image and draft unchanged. Polygon-bound dirty state and Subimage dirty state remain independent and use the same navigation guard pattern without overwriting one another.

## Error Handling

Use stable server error codes and short client messages for:

- unknown image ID;
- missing source TIFF;
- unsupported source TIFF metadata;
- source dimension mismatch;
- invalid or out-of-bounds crop;
- aspect-ratio mismatch;
- invalid saved crop JSON;
- missing or mismatched saved TIFF;
- crop rendering failure;
- temporary-file or replacement failure;
- partial batch completion.

Validation errors never replace existing subimages. The client keeps the current draft after a save failure so the user can retry.

## Testing

### Unit and Service Tests

- storage resolves `subimage/`, the source filename, and `crop.json` without exposing host paths to client DTOs;
- crop validation rejects non-integers, zero sizes, out-of-bounds rectangles, and ratio mismatches;
- source validation accepts the supported 16-bit grayscale TIFF and rejects incompatible metadata;
- cropped output preserves width, height, `ushort`, `grey16`, one channel, and exact raw pixel values;
- current-image save replaces TIFF and JSON and leaves no committed JSON when TIFF generation fails;
- create-missing preserves valid existing crops and creates only missing crops;
- batch preflight detects dimension differences before any write;
- replace-all rewrites every valid image;
- partial filesystem failures produce accurate completed and failed lists without corrupting the failed image's prior files;
- API routes validate payloads and return safe error messages.

### Client Tests

- Subimage mode hides unrelated polygon and Heat Map overlays;
- the contextual panel exposes the correct controls and disabled states;
- drawing is constrained to source aspect ratio in every drag direction;
- rendered-stage coordinates map correctly to integer source pixels;
- a locked crop moves without resizing and remains inside image bounds;
- pointer movement performs no server request;
- Save subimage updates the active image only;
- Create all and Replace all render batch summaries;
- saved per-image coordinates reload during ordered navigation;
- stale requests cannot overwrite the current image;
- dirty navigation confirmation covers image, root, layer, and unload transitions.

### Browser Verification

Use a real TIFF sequence to verify:

1. draw the initial crop;
2. create all missing subimages;
3. navigate in filename order;
4. move and save one image's crop;
5. confirm the TIFF and JSON changed only for that image;
6. reload the app and confirm all rectangles return to their saved positions;
7. replace all with a new template and verify every output;
8. inspect one saved TIFF's metadata and raw pixels against its source region.

## Success Criteria

- Every generated subimage uses the same source-aspect crop size unless all crops are explicitly replaced.
- Each image can have a distinct saved crop position.
- Moving a crop does not write until `Save subimage` is pressed.
- Existing valid crops survive create-missing.
- Source dimension differences stop create-missing before writes.
- Saved TIFFs retain exact 16-bit grayscale source pixels.
- Reopening the project restores each image's saved crop rectangle.
