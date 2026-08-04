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

## Requirements

- Git
- Node.js 20.9 or newer, including npm

## One-Command Start

After cloning the repository and entering its directory, run:

```sh
npm start
```

This one command:

1. installs the exact dependencies from `package-lock.json` with `npm ci`;
2. builds the React client into `dist/`;
3. starts the Express server.

Then open [http://localhost:3000](http://localhost:3000). Press `Ctrl+C` in the
terminal to stop the server.

For macOS, Linux, Git Bash, Windows Command Prompt, or PowerShell 7+, cloning
and starting can also be written as one line:

```sh
git clone https://github.com/ksc036/tiff-polygon-bound-editor.git && cd tiff-polygon-bound-editor && npm start
```

## Later Runs

If dependencies and `dist/` are already current, start only the server:

```sh
npm run server
```

Use `npm start` again after pulling code changes because it reinstalls locked
dependencies and rebuilds the client before starting.

## Optional Initial Root

The image root can be chosen after startup with `Find root` or `Set root`. On
macOS and Linux, it can instead be supplied when starting:

```sh
BOUND_EDITOR_ROOT=/absolute/path/to/root npm start
```

On Windows PowerShell:

```powershell
$env:BOUND_EDITOR_ROOT = "C:\path\to\root"
npm start
```

The Heatmap batch panel also accepts an absolute path directly.

Native folder selection uses:

- macOS: AppleScript through `osascript`;
- Windows: PowerShell with the modern Windows Common Item Dialog (`IFileOpenDialog`);
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
