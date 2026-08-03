# TIFF Polygon Bound Editor

A local React and Express app for drawing ordered polygon boundaries on TIFF image
sequences. Bounds are saved as JSON under each `*_Txx/bound/` folder.

## Expected Folder Shape

```text
root/
  sample_T01/
    image/
      frame001.tif
  sample_T02/
    image/
      frame002.tif
```

## Run

```sh
npm install
BOUND_EDITOR_ROOT=/absolute/path/to/root npm run server
```

Then open `http://localhost:3000`.

You can choose an image root from the app with `Find root`, or enter an absolute
path in `Root path` and press `Set root`. The Heatmap batch panel also accepts an
absolute path directly.

Native folder selection uses:

- macOS: AppleScript through `osascript`;
- Windows: PowerShell `System.Windows.Forms.FolderBrowserDialog`;
- Linux: `zenity`, with `kdialog` as a fallback.

On Linux without `zenity`/`kdialog`, or on a headless server, enter an absolute
path directly or start the server with `BOUND_EDITOR_ROOT=/absolute/path/to/root`.
The selected folder is always on the machine running the Express server.

## Test And Build

```sh
npm test
npm run build
```

## Bound JSON

Saved bounds use `input-order-cycle`: points connect in the saved array order,
and the final point is connected back to the first point.
