const SCHEMA_VERSION = 1;
const MAX_CELL_SIZE = 4096;
const MAX_CELL_COUNT = 1_000_000;

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Heatmap ${label} must be a positive safe integer.`);
  }
}

function assertRelativeMetadata(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]+/).some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Heatmap ${label} must be a non-empty relative path.`);
  }
}

function assertIsoTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("Heatmap updatedAt must be an ISO timestamp.");
  }
}

function assertMaskSource(maskSource) {
  if (!maskSource || typeof maskSource !== "object") {
    throw new Error("Heatmap maskSource must include a relative file path.");
  }
  assertRelativeMetadata(maskSource.file, "maskSource.file");
}

function publicMaskSource(maskSource) {
  const source = { file: maskSource.file };
  if (maskSource.mtimeMs !== undefined) {
    source.mtimeMs = maskSource.mtimeMs;
  }
  if (maskSource.size !== undefined) {
    source.size = maskSource.size;
  }
  return source;
}

function publicCell(cell) {
  return {
    row: cell.row,
    column: cell.column,
    x: cell.x,
    y: cell.y,
    width: cell.width,
    height: cell.height,
    areaPx: cell.areaPx,
    maskPixelCount: cell.maskPixelCount,
    pixelDensity: cell.pixelDensity,
  };
}

function assertMask(mask) {
  if (!mask || !(mask.data instanceof Uint8Array)) {
    throw new Error("Heatmap mask must include Uint8Array data.");
  }
  assertPositiveSafeInteger(mask.width, "mask width");
  assertPositiveSafeInteger(mask.height, "mask height");
  if (mask.width * mask.height !== mask.data.length) {
    throw new Error("Heatmap mask data length must match width * height.");
  }
}

function assertCellBudget(columns, rows) {
  if (columns > Math.floor(MAX_CELL_COUNT / rows)) {
    throw new Error("Heatmap grid exceeds the 1,000,000 cell limit.");
  }
}

function assertGridCell(cell, index, grid) {
  if (!cell || typeof cell !== "object") {
    throw new Error(`Heatmap cell ${index} is malformed.`);
  }

  for (const field of ["row", "column", "x", "y", "width", "height", "areaPx", "maskPixelCount"]) {
    if (!Number.isSafeInteger(cell[field])) {
      throw new Error(`Heatmap cell ${index} has an invalid ${field}.`);
    }
  }

  if (
    cell.row < 0 ||
    cell.column < 0 ||
    cell.x < 0 ||
    cell.y < 0 ||
    cell.width <= 0 ||
    cell.height <= 0 ||
    cell.areaPx !== cell.width * cell.height ||
    cell.maskPixelCount < 0 ||
    cell.maskPixelCount > cell.areaPx ||
    typeof cell.pixelDensity !== "number" ||
    !Number.isFinite(cell.pixelDensity) ||
    cell.pixelDensity < 0 ||
    cell.pixelDensity > 1 ||
    cell.pixelDensity !== cell.maskPixelCount / cell.areaPx
  ) {
    throw new Error(`Heatmap cell ${index} has invalid dimensions or density.`);
  }

  const expectedRow = Math.floor(index / grid.columns);
  const expectedColumn = index % grid.columns;
  const expectedX = expectedColumn * grid.cellWidth;
  const expectedY = expectedRow * grid.cellHeight;
  const expectedWidth = Math.min(grid.cellWidth, grid.width - expectedX);
  const expectedHeight = Math.min(grid.cellHeight, grid.height - expectedY);

  if (
    cell.row !== expectedRow ||
    cell.column !== expectedColumn ||
    cell.x !== expectedX ||
    cell.y !== expectedY ||
    cell.width !== expectedWidth ||
    cell.height !== expectedHeight
  ) {
    throw new Error(`Heatmap cell ${index} has invalid coordinates.`);
  }
}

export function validateCellSize(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CELL_SIZE) {
    throw new Error("Heatmap cell size must be a positive integer no greater than 4096.");
  }
  return parsed;
}

export function buildMaskHeatmapGrid({ mask, cellSize }) {
  assertMask(mask);
  const size = validateCellSize(cellSize);
  const columns = Math.ceil(mask.width / size);
  const rows = Math.ceil(mask.height / size);
  assertCellBudget(columns, rows);
  const cells = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * size;
      const y = row * size;
      const width = Math.min(size, mask.width - x);
      const height = Math.min(size, mask.height - y);
      let maskPixelCount = 0;

      for (let cellY = y; cellY < y + height; cellY += 1) {
        for (let cellX = x; cellX < x + width; cellX += 1) {
          maskPixelCount += mask.data[cellY * mask.width + cellX] ? 1 : 0;
        }
      }

      const areaPx = width * height;
      cells.push({
        row,
        column,
        x,
        y,
        width,
        height,
        areaPx,
        maskPixelCount,
        pixelDensity: maskPixelCount / areaPx,
      });
    }
  }

  return {
    width: mask.width,
    height: mask.height,
    cellWidth: size,
    cellHeight: size,
    columns,
    rows,
    cells,
  };
}

export function createHeatmapPayload({ imageFolder, maskSource, mask, cellSize, updatedAt }) {
  assertRelativeMetadata(imageFolder, "imageFolder");
  assertMaskSource(maskSource);
  const grid = buildMaskHeatmapGrid({ mask, cellSize });
  const timestamp = updatedAt ?? new Date().toISOString();
  assertIsoTimestamp(timestamp);

  return {
    schemaVersion: SCHEMA_VERSION,
    imageFolder,
    maskSource: publicMaskSource(maskSource),
    ...grid,
    updatedAt: timestamp,
  };
}

export function validateHeatmapPayload(payload, { cellSize } = {}) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.schemaVersion !== SCHEMA_VERSION ||
    !("imageFolder" in payload) ||
    !("maskSource" in payload) ||
    !("updatedAt" in payload)
  ) {
    throw new Error("Invalid heatmap payload schema.");
  }
  assertRelativeMetadata(payload.imageFolder, "imageFolder");
  assertMaskSource(payload.maskSource);
  assertIsoTimestamp(payload.updatedAt);
  assertPositiveSafeInteger(payload.width, "width");
  assertPositiveSafeInteger(payload.height, "height");
  const expectedCellSize = validateCellSize(cellSize);
  assertPositiveSafeInteger(payload.cellWidth, "cell width");
  assertPositiveSafeInteger(payload.cellHeight, "cell height");
  assertPositiveSafeInteger(payload.columns, "columns");
  assertPositiveSafeInteger(payload.rows, "rows");
  assertCellBudget(payload.columns, payload.rows);

  if (
    payload.cellWidth !== expectedCellSize ||
    payload.cellHeight !== expectedCellSize ||
    payload.columns !== Math.ceil(payload.width / expectedCellSize) ||
    payload.rows !== Math.ceil(payload.height / expectedCellSize) ||
    !Array.isArray(payload.cells) ||
    payload.cells.length !== payload.columns * payload.rows
  ) {
    throw new Error("Invalid heatmap dimensions or cell size.");
  }

  payload.cells.forEach((cell, index) => assertGridCell(cell, index, payload));
  return {
    schemaVersion: payload.schemaVersion,
    imageFolder: payload.imageFolder,
    maskSource: publicMaskSource(payload.maskSource),
    width: payload.width,
    height: payload.height,
    cellWidth: payload.cellWidth,
    cellHeight: payload.cellHeight,
    columns: payload.columns,
    rows: payload.rows,
    cells: payload.cells.map(publicCell),
    updatedAt: payload.updatedAt,
  };
}
