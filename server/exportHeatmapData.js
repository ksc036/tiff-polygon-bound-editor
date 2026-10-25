import { createWriteStream } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { calibrationMetadata, collagenDensityResult } from "../shared/collagenDensity.js";
import { HEATMAP_NO_DATA_COLOR, heatmapDisplayValue, infernoColor } from "../src/lib/heatmap.js";
import { exportCalibrationSnapshot } from "./exportCalibration.js";

export const HEATMAP_DATA_README = `Heatmap numerical data

heatmap_data/<width>x<height>.json contains ALL images for one selected grid size.
For example, select 32x32.json to browse the images array for every 32 px heatmap.
File names follow the grid sizes selected at export; they are not fixed presets.
No duplicate per-image data.json or cells.csv is included. Existing PNGs and reports are unchanged.

Each JSON records the shared grid size, coordinate system, calibration/formula/revision/Max and display scale.
Each images entry has id, imageFolder, imageFile, status, original width/height, grid geometry and cells.
status=included means cells are available. status=unavailable has an empty cells array and a reason;
do not render an unavailable image as a zero-density image. Image order matches the exported image list.

Coordinates are zero-based original-image pixels: x increases right, y increases down.
Cells are in row-major order. Use each cell's x, y, width and height, not a uniformly resized matrix:
center-aligned grids can have smaller cells on all four edges. Older top-left grids remain top-left.
areaPx is width * height. pixelDensity is maskPixelCount / areaPx, in [0, 1].

Concentration values are in mg/mL:
  estimatedCollagenDensity: inverse-model result without the display color limit; null when not estimable.
  heatmapValue: value used for heatmaps and comparisons; model-range-exceeded uses the selected color Max.
  displayValue: heatmapValue clipped to [0, color Max], used for the absolute heatmap color.
  displayColor: exact #RRGGBB color used for that cell in the exported absolute heatmap PNG.
  concentrationStatus: ok, below-baseline, color-max-exceeded, model-range-exceeded or no-data.
Zero Area Fraction with a valid sampled area is zero concentration, not no-data.
JSON null means unavailable, never zero. No-data cells use display.noDataColor.
To draw a heatmap, create an image-sized canvas and fill each cell's x/y/width/height with displayColor.

The top-level calibration records the selected model, coefficients, formula, revision and color Max.
calibration_metadata.json at the ZIP root also records this export's settings and subimage crop rectangles.
For a subimage, crop the full-image grid at that rectangle; do not recompute partial-cell Area Fraction.
For compatible full-image comparisons, subtract previous heatmapValue from current heatmapValue before
applying the comparison color scale. Do not subtract displayValue (already color-clipped).
For subimage comparisons, align the saved crop rectangles in crop-local coordinates.
Missing or invalid source grids stay in the images list as unavailable; see also export_report.xlsx.
Source images, masks and saved heatmap JSON files are not modified by this export.
`;

export async function createHeatmapDataExport({ cellSizes, calibration, colorMax, exportedAt, signal }) {
  signal?.throwIfAborted();
  const snapshot = exportCalibrationSnapshot(calibration);
  const metadata = {
    formatVersion: 1,
    coordinateSystem: "zero-based top-left; x right, y down",
    indexOrder: "row-major",
    calibration: calibrationMetadata({ model: snapshot.model, revision: snapshot.revision, colorMax, exportedAt }),
    display: { metric: "estimated-collagen-density", min: 0, max: colorMax,
      unit: "mg/mL", palette: "inferno", noDataColor: HEATMAP_NO_DATA_COLOR },
  };
  const directory = await mkdtemp(path.join(tmpdir(), "heatmap-data-export-"));
  const grids = new Map();
  const dispose = () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  try {
    for (const cellSize of cellSizes) {
      signal?.throwIfAborted();
      const name = `${cellSize}x${cellSize}.json`;
      const filePath = path.join(directory, name);
      const header = { ...metadata, cellWidth: cellSize, cellHeight: cellSize };
      await writeFile(filePath, `${JSON.stringify(header, null, 2).slice(0, -1)},\n"images":[\n`, { signal });
      grids.set(cellSize, { name, path: filePath, images: new Set() });
    }
  } catch (error) {
    await dispose();
    throw error;
  }

  async function* serializeImage({ image, source, reason, separator }) {
    signal?.throwIfAborted();
    const { cells = [], ...grid } = source ?? {};
    const header = { ...grid, id: image.id, imageFolder: image.imageFolder ?? image.id,
      imageFile: image.imageFile, status: source ? "included" : "unavailable",
      ...(source ? {} : { reason, width: image.width ?? null, height: image.height ?? null }) };
    yield `${separator}${JSON.stringify(header).slice(0, -1)},"cells":[\n`;
    // Spool bounded chunks so image grids can be released after their PNG is rendered.
    for (let offset = 0; offset < cells.length; offset += 256) {
      signal?.throwIfAborted();
      const lines = [];
      for (let index = offset; index < Math.min(offset + 256, cells.length); index += 1) {
        const cell = cells[index];
        const result = collagenDensityResult(cell.pixelDensity, snapshot.model, {
          empty: cell.empty === true || cell.areaPx === 0, colorMax,
        });
        const value = heatmapDisplayValue(cell, "estimated-collagen-density", colorMax, snapshot.model);
        const row = { ...cell, estimatedCollagenDensity: result.value, heatmapValue: value,
          displayValue: value === null ? null : Math.max(0, Math.min(colorMax, value)),
          displayColor: infernoColor(value, 0, colorMax), concentrationStatus: result.status };
        lines.push(`${index === 0 ? "" : ",\n"}${JSON.stringify(row)}`);
      }
      yield lines.join("");
      await new Promise((resolve) => setImmediate(resolve));
    }
    signal?.throwIfAborted();
    yield "\n]}\n";
  }

  return {
    hasImage: (cellSize, imageId) => grids.get(cellSize).images.has(imageId),
    async appendImage({ cellSize, image, source, reason }) {
      signal?.throwIfAborted();
      const grid = grids.get(cellSize);
      await pipeline(Readable.from(serializeImage({ image, source, reason, separator: grid.images.size ? ",\n" : "" })),
        createWriteStream(grid.path, { flags: "a" }), { signal });
      grid.images.add(image.id);
    },
    async finalize() {
      signal?.throwIfAborted();
      for (const grid of grids.values()) await appendFile(grid.path, "\n]}\n", { signal });
      return [...grids.values()].map(({ name, path: filePath }) => ({ name, path: filePath }));
    },
    dispose,
  };
}
