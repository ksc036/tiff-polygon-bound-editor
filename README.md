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

You can also choose a root from the app with `Find root`.

## Test And Build

```sh
npm test
npm run build
```

## Bound JSON

Saved bounds use `input-order-cycle`: points connect in the saved array order,
and the final point is connected back to the first point.
