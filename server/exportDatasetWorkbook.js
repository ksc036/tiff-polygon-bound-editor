import ExcelJS from "exceljs";

const HEADER_FILL = "FF1E293B";
const HEADER_FONT = "FFFFFFFF";

const SUBIMAGE_COLUMNS = [
  ["Image", 18],
  ["Source Width", 16],
  ["Source Height", 16],
  ["Crop X", 12],
  ["Crop Y", 12],
  ["Crop Width", 14],
  ["Crop Height", 14],
  ["Status", 16],
  ["Path / Reason", 38],
];

const REPORT_COLUMNS = [
  ["Timestamp", 24],
  ["Status", 16],
  ["Artifact", 28],
  ["Image", 18],
  ["Previous Image", 18],
  ["Cell Size", 14],
  ["Path", 38],
  ["Reason", 38],
];

export async function createDatasetExportWorkbook({ records = [], scaleEntries = [], exportedAt } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TIFF Polygon Bound Editor";
  workbook.created = dateValue(exportedAt) ?? new Date();
  workbook.modified = workbook.created;

  const safeRecords = Array.isArray(records) ? records : [];
  addSubimagesSheet(workbook, safeRecords);
  addExportReportSheet(
    workbook,
    safeRecords.flatMap((record) => Array.isArray(record?.derivedEntries) ? record.derivedEntries : []),
    Array.isArray(scaleEntries) ? scaleEntries : [],
    exportedAt,
  );

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function addSubimagesSheet(workbook, records) {
  const sheet = workbook.addWorksheet("Subimages");
  configureSheet(sheet, SUBIMAGE_COLUMNS);

  for (const record of records) {
    const subimage = record?.subimage ?? {};
    const crop = subimage.crop ?? {};
    const status = safeStatus(subimage.status);
    sheet.addRow([
      safeFileName(record?.image?.imageFolder ?? record?.image?.id),
      finiteNumber(crop.sourceWidth),
      finiteNumber(crop.sourceHeight),
      finiteNumber(crop.x),
      finiteNumber(crop.y),
      finiteNumber(crop.width),
      finiteNumber(crop.height),
      status,
      status === "Included" ? safePublicPath(subimage.path) : safeReportText(subimage.reason),
    ]);
  }

  applyAutoFilter(sheet, "I");
}

function addExportReportSheet(workbook, derivedEntries, scaleEntries, exportedAt) {
  const sheet = workbook.addWorksheet("Export Report");
  configureSheet(sheet, REPORT_COLUMNS);

  for (const entry of [...derivedEntries, ...scaleEntries]) {
    sheet.addRow([
      dateValue(exportedAt),
      safeStatus(entry?.status),
      safeReportText(entry?.artifact ?? entry?.kind),
      safeFileName(entry?.image ?? entry?.currentImage),
      safeFileName(entry?.previousImage),
      finiteNumber(entry?.cellSize ?? entry?.sourceCellSize),
      safePublicPath(entry?.path),
      safeReportText(entry?.reason ?? entry?.message),
    ]);
  }

  formatDates(sheet, 1);
  applyAutoFilter(sheet, "H");
}

function configureSheet(sheet, columns) {
  sheet.addRow(columns.map(([header]) => header));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  columns.forEach(([, width], index) => {
    sheet.getColumn(index + 1).width = Math.min(38, Math.max(12, width));
  });
}

function formatDates(sheet, column) {
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const cell = sheet.getCell(row, column);
    if (cell.value instanceof Date) cell.numFmt = "yyyy-mm-dd hh:mm:ss";
  }
}

function applyAutoFilter(sheet, lastColumn) {
  sheet.autoFilter = { from: "A1", to: `${lastColumn}${Math.max(2, sheet.rowCount)}` };
}

function finiteNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateValue(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function safePublicPath(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\\", "/");
  if (absolutePathLike(normalized)) return safeFileName(normalized);
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return safeFileName(normalized);
  }
  return normalized;
}

function safeFileName(value) {
  if (typeof value !== "string") return null;
  const name = value.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  return name && name !== "." && name !== ".." ? name : null;
}

function safeStatus(value) {
  return ["Included", "Skipped", "Warning", "Not applicable"].includes(value) ? value : "Warning";
}

function safeReportText(value) {
  if (typeof value !== "string") return null;
  return containsHostPath(value) ? null : value;
}

function absolutePathLike(value) {
  return value.startsWith("/") || value.startsWith("//") || /^[a-z]:\//i.test(value);
}

function containsHostPath(value) {
  const normalized = value.replaceAll("\\", "/");
  return /(^|[\s('"`])(?:[a-z]:\/|\/\/|\/[^\s/]+\/)/i.test(normalized);
}
