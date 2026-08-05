# Subimage Direct Editing and Windows Picker Focus Design

## Goal

Extend the existing fixed-aspect Subimage workflow so a user can refine the first crop by moving or resizing it before batch creation, and can use `Set crop` on every image after the common size is locked. Also make the modern Windows `Find root` picker reliably appear above the browser and record the regression-prevention rule in the project knowledge base.

## Scope

This change will:

- keep the source-image aspect ratio during every resize;
- show four fixed-screen-size corner handles on an editable initial crop;
- move an initial crop by dragging inside it;
- resize an initial crop by dragging a corner handle around the opposite fixed corner;
- allow resizing only before `Create all subimages` establishes the common size;
- enable `Set crop` on every image once a common size exists;
- use `Set crop` on locked images to place and drag the same-size crop without resizing;
- preserve explicit-save behavior and perform no server write during pointer interaction;
- strengthen the Windows `IFileOpenDialog` foreground/topmost handshake;
- update the existing Windows picker compound note with the newly identified false-success condition.

This change will not:

- permit different saved crop dimensions per image;
- add keyboard resizing or numeric crop inputs;
- resize mask or skeleton artifacts;
- replace the modern Windows picker with `FolderBrowserDialog`;
- change macOS or Linux picker behavior.

## Crop State Contract

The existing saved crop, visible draft, retained template, and size-lock state remain separate.

- Before batch creation, the first image owns an unlocked template draft. It may be redrawn, moved, or resized.
- `Create all subimages` sends the visible first-image draft. Any created or preserved crop establishes the common size lock.
- A loaded saved owner crop also establishes the lock.
- Once locked, every image, including the first, uses the common template width and height.
- A locked image may change only `x` and `y`; `sourceWidth`, `sourceHeight`, `width`, and `height` must continue to match the retained template.
- A failed save keeps the draft visible and dirty.
- Existing partial-batch recovery continues to rehydrate a failed owner's draft from the retained template.

No storage or server schema changes are required.

## Direct Crop Editing

### Pointer Priority

When Subimage mode is idle and a draft exists, pointer down is interpreted in this order:

1. an enabled corner resize handle;
2. the crop interior for movement;
3. no crop edit.

Resize handles are enabled only when the first image is active and the common size is not locked. Movement is enabled for any visible draft.

### Moving

Dragging inside the crop keeps its width and height unchanged and clamps its position to the source image. This uses the existing source-coordinate content rectangle so fitting or resizing the displayed image does not change the selected source pixels.

### Resizing

Four handles identify `north-west`, `north-east`, `south-east`, and `south-west`. A resize interaction stores:

```text
kind: resize
corner: dragged corner
anchor: opposite corner in source pixels
startCrop: crop at pointer down
```

The opposite corner remains fixed. The dragged pointer determines the largest source-aspect rectangle that fits between the anchor, pointer direction, and source-image edges. The dragged corner cannot cross the anchor; it stops at the smallest valid aspect-preserving size. A minimum 16 CSS-pixel display footprint is converted to source pixels for the current content rectangle so a crop cannot become too small to manipulate.

All output coordinates and dimensions are integer source pixels and satisfy the existing crop validation rules.

### Handle Presentation

The overlay adds four square handles centered on the crop corners. They remain a fixed CSS size while the image scales, use the existing green crop accent with a contrasting fill, and remain visually above the crop outline. The overlay itself remains `pointer-events: none`; the stage performs screen-distance handle hit testing before crop-interior hit testing.

## Set Crop on Every Image

`Set crop` capability has two phases:

- **Unlocked first image:** enters the existing aspect-locked rectangle drawing flow and may replace the current draft with a new size and position.
- **Locked common size, any image:** enters `place-locked` mode. Pointer down centers a crop with the retained template dimensions at the pointer, clamped inside the image. Continuing to drag moves that fixed-size crop with the pointer. Pointer up returns to idle with an unsaved draft.

If no retained template size exists, later images cannot use `Set crop` because there is no common size to preserve. The panel keeps native disabled behavior and communicates the existing template owner.

Direct movement, resize, redraw, and locked placement never call `fetch`. The existing `Save subimage`, `Create all subimages`, and confirmed replacement actions remain the only write paths.

## Windows Find Root Focus

### Root Cause

The current Windows guard finds the visible common dialog and calls `SetWindowPos(HWND_TOPMOST, ... SWP_NOACTIVATE ...)`, followed by best-effort `SetForegroundWindow`. It marks promotion complete as soon as `SetWindowPos` succeeds, even when foreground activation was denied. In focus arrangements where the browser is also above normal windows, the picker can therefore remain behind it.

### Corrected Guard

The modern `IFileOpenDialog` and hidden owner form remain in place. While `IFileOpenDialog.Show` runs, the WinForms timer will:

1. find the user-visible owned dialog HWND;
2. call `SetWindowPos` with `HWND_TOPMOST`, `SWP_NOMOVE`, `SWP_NOSIZE`, and `SWP_SHOWWINDOW`, without `SWP_NOACTIVATE`;
3. call `SetForegroundWindow` as an additional best-effort request;
4. verify that the dialog has `WS_EX_TOPMOST` and is the current foreground window;
5. stop only after verification succeeds.

Retries are bounded to 40 attempts at 50ms intervals. This provides a two-second startup window without stealing focus indefinitely if Windows policy denies activation. The dialog remains usable even if promotion cannot be verified, and all native resources are disposed when `Show` returns.

The browser, server, and PowerShell process boundary means the test suite can verify script structure and completion rules but cannot fully emulate Windows desktop focus. Final verification therefore includes a real Windows check after the pushed build is started.

## Error and Transition Handling

- Pointer editing is unavailable while a Subimage request is busy.
- Starting a write cancels any active move, resize, or placement gesture.
- Navigation and root changes continue to use the existing dirty-draft confirmation.
- Cancelling replacement restores the saved crop and does not interfere with initial direct editing.
- Picker activation failure does not turn a valid folder selection into an API failure.

## Testing

### Geometry

- resize each of four corners with the opposite corner fixed;
- preserve source aspect ratio and integer bounds;
- clamp at every image edge;
- enforce the display-derived minimum size;
- center and clamp a locked-size crop at a pointer;
- keep movement dimensions unchanged.

### Components and App

- render four fixed-size handles only for the unlocked first-image draft;
- give handle hit testing priority over movement;
- move and resize the initial draft without network writes;
- redraw after resize before Create All;
- enable `Set crop` for every image after lock;
- place and drag a same-size crop on later images;
- keep resize disabled after lock;
- save only the active image after locked placement;
- retain dirty navigation and busy guards.

### Windows Picker

- omit `SWP_NOACTIVATE` when promoting the visible picker;
- inspect foreground and `WS_EX_TOPMOST` state before declaring success;
- retry a bounded number of times rather than stopping on `SetWindowPos` alone;
- retain modern `IFileOpenDialog`, UTF-8 paths, cancellation handling, and owner cleanup;
- verify the picker appears above the browser on a real Windows machine.

## Compound Requirement

After implementation and review, update `docs/solutions/integration-issues/windows-folder-picker-dialog-z-order.md` to record:

- a successful Z-order API return is not proof that the dialog became foreground;
- `SWP_NOACTIVATE` conflicts with a user-initiated modal picker that must receive focus;
- success conditions for native focus work must verify observable window state;
- retries must be bounded so a guard does not continuously steal focus.

Run `ce-compound mode:headless` with this regression context if available. If it is unavailable, the updated durable solution document is the required fallback.
