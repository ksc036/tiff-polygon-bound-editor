import ExcelJS from "exceljs";
import { buildAnalysisRows } from "../shared/analysisRows.js";

const HEADER_FILL = "FF1E293B";
const HEADER_FONT = "FFFFFFFF";
const DEFAULT_GROUP_COLOR = "#94a3b8";

const ROI_COLUMNS = [
  ["ROI ID", "roiId", 14],
  ["Group ID", "groupId", 14],
  ["Group Name", "groupName", 22],
  ["Group Color", "groupColor", 14],
  ["Analysis Mode", "modeLabel", 16],
  ["ROI Label", "bandLabel", 14],
  ["From px", "fromPx", 18],
  ["To px", "toPx", 16],
  ["Area px", "roiAreaPx", 16],
  ["Mask Pixels", "maskPixelCount", 14],
  ["Pixel Density", "density", 15],
  ["Estimated Collagen Density (mg/ml)", "estimatedCollagenDensity", 38],
  ["ROI Alignment", "globalAlignment", 16],
  ["Radial Alignment", "radialNormalAlignment", 18],
  ["Circumferential Alignment", "tangentialAlignment", 25],
  ["Migration Axis Alignment", "migrationAlignment", 24],
  ["Empty", "empty", 12],
  ["ROI Image", "roiOverview", 20],
];

const METRIC_DEFINITIONS = [
  ["Pixel Density", "mask pixels / ROI area pixels", "0 to 1", "ratio"],
  ["Estimated Collagen Density", "(Pixel Density - b) / a", "calibration-derived", "mg/ml"],
  ["ROI Alignment", "nematic order of all fiber segment angles in the ROI", "0 random to 1 aligned", "unitless"],
  ["Radial Alignment", "mean cos(2(theta - boundary-normal angle))", "-1 circumferential to 1 radial", "unitless"],
  ["Circumferential Alignment", "negative radial alignment", "-1 radial to 1 circumferential", "unitless"],
  ["Migration Axis Alignment", "mean cos(2(theta - migration-axis angle))", "-1 perpendicular to 1 parallel", "unitless"],
];

export async function createImageWorkbook(input) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TIFF Polygon Bound Editor";
  workbook.created = dateValue(input?.exportedAt) ?? new Date();
  workbook.modified = workbook.created;

  addRoiStatisticsSheet(workbook, input ?? {});
  addImageSummarySheet(workbook, input ?? {});
  addMetricDefinitionsSheet(workbook);
  addHeatmapIndexSheet(workbook, input ?? {});
  addExportReportSheet(workbook, input ?? {});

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function workbookFailureText({ imageFolder, error }) {
  const category = safeErrorCategory(error);
  return Buffer.from(
    `Image folder: ${safeImageFolder(imageFolder)}\nStatus: ${category}\nRecovery: Review the export report and retry the export.\n`,
    "utf8",
  );
}

function addRoiStatisticsSheet(workbook, input) {
  const sheet = workbook.addWorksheet("ROI Statistics");
  const roiEntry = input.roiEntry ?? {};
  const calibration = input.calibration ?? {};
  const rows = buildAnalysisRows(input.analysis, input.bounds);
  configureSheet(sheet, ROI_COLUMNS.map(([header]) => header), ROI_COLUMNS.map(([, , width]) => width));

  for (const row of rows) {
    const metrics = row.metrics ?? {};
    const groupColor = normalizeColor(row.groupColor);
    const values = [
      row.roiId,
      row.groupId,
      safeText(row.groupName),
      groupColor,
      safeText(row.modeLabel),
      safeText(row.bandLabel) ?? safeText(row.bandId),
      numberOrBlank(row.fromPx),
      numberOrBlank(row.toPx),
      numberOrBlank(metrics.roiAreaPx),
      numberOrBlank(metrics.maskPixelCount),
      numberOrBlank(metrics.density),
      estimatedCollagenDensity(metrics.density, calibration),
      numberOrBlank(metrics.globalAlignment),
      numberOrBlank(metrics.radialNormalAlignment),
      numberOrBlank(metrics.tangentialAlignment),
      numberOrBlank(metrics.migrationAlignment),
      typeof metrics.empty === "boolean" ? metrics.empty : null,
      artifactValue({ entry: roiEntry, label: "Open ROI overview", directory: "roi" }),
    ];
    const excelRow = sheet.addRow(values);
    formatRoiRow(excelRow, groupColor);
  }

  applyAutoFilter(sheet, "R");
}

function addImageSummarySheet(workbook, input) {
  const sheet = workbook.addWorksheet("Image Summary");
  configureSheet(sheet, ["Field", "Value"], [28, 38]);
  const image = input.image ?? {};
  const dimensions = input.dimensions ?? {};
  const sourceFiles = input.sourceFiles ?? {};
  const rows = buildAnalysisRows(input.analysis, input.bounds);
  const sourceRows = [
    ["Image folder", safeFileName(image.imageFolder ?? image.id)],
    ["Image file", safeFileName(sourceFiles.image?.file ?? image.imageFile)],
    ["Mask file", safeFileName(sourceFiles.mask?.file)],
    ["Bounds file", safeFileName(sourceFiles.bounds?.file)],
    ["Analysis file", safeFileName(sourceFiles.analysis?.file)],
    ["Image width (px)", numberOrBlank(dimensions.width)],
    ["Image height (px)", numberOrBlank(dimensions.height)],
    ["ROI count", rows.length],
    ["Saved group count", Array.isArray(input.bounds?.groups) ? input.bounds.groups.length : 0],
    ["Image modified", dateValue(sourceFiles.image?.mtimeMs)],
    ["Mask modified", dateValue(sourceFiles.mask?.mtimeMs)],
    ["Bounds modified", dateValue(sourceFiles.bounds?.mtimeMs)],
    ["Analysis modified", dateValue(sourceFiles.analysis?.mtimeMs)],
    ["Calibration slope (a)", numberOrBlank(input.calibration?.slope)],
    ["Calibration intercept (b)", numberOrBlank(input.calibration?.intercept)],
    ["Bounds auto-saved before export", Boolean(input.autoSavedBounds)],
    ["Exported at", dateValue(input.exportedAt)],
  ];
  sourceRows.forEach((row) => sheet.addRow(row));
  formatDates(sheet, 2);
  applyAutoFilter(sheet, "B");
}

function addMetricDefinitionsSheet(workbook) {
  const sheet = workbook.addWorksheet("Metric Definitions");
  configureSheet(sheet, ["Metric", "Formula", "Range", "Unit"], [32, 38, 30, 14]);
  METRIC_DEFINITIONS.forEach((definition) => sheet.addRow(definition));
  applyAutoFilter(sheet, "D");
}

function addHeatmapIndexSheet(workbook, input) {
  const sheet = workbook.addWorksheet("Heatmap Index");
  configureSheet(
    sheet,
    ["Status", "Metric", "Current Image", "Previous Image", "Cell Width (px)", "Cell Height (px)", "Columns", "Rows", "Color Min", "Color Max", "Unit", "Artifact", "Reason"],
    [12, 30, 18, 18, 16, 17, 12, 12, 14, 14, 12, 16, 38],
  );

  for (const entry of input.heatmapEntries ?? []) {
    sheet.addRow([
      safeStatus(entry.status),
      safeText(entry.metric),
      safeFileName(entry.currentImage),
      safeFileName(entry.previousImage),
      numberOrBlank(entry.cellWidth),
      numberOrBlank(entry.cellHeight),
      numberOrBlank(entry.columns),
      numberOrBlank(entry.rows),
      numberOrBlank(entry.colorMin),
      numberOrBlank(entry.colorMax),
      safeText(entry.unit),
      artifactValue({ entry, label: "Open PNG", directory: "heatmap" }),
      safeText(entry.reason),
    ]);
  }
  applyAutoFilter(sheet, "M");
}

function addExportReportSheet(workbook, input) {
  const sheet = workbook.addWorksheet("Export Report");
  configureSheet(
    sheet,
    ["Timestamp", "Status", "Artifact", "Message", "Calibration Slope (a)", "Calibration Intercept (b)"],
    [24, 12, 18, 38, 24, 28],
  );

  const entries = input.reportEntries ?? [];
  for (const entry of entries) {
    sheet.addRow([
      dateValue(input.exportedAt),
      safeStatus(entry.status),
      safeText(entry.artifact),
      safeText(entry.message ?? entry.reason),
      numberOrBlank(input.calibration?.slope),
      numberOrBlank(input.calibration?.intercept),
    ]);
  }
  if (entries.length === 0) {
    sheet.addRow([
      dateValue(input.exportedAt),
      "Included",
      "Workbook",
      "Workbook generated.",
      numberOrBlank(input.calibration?.slope),
      numberOrBlank(input.calibration?.intercept),
    ]);
  }
  formatDates(sheet, 1);
  applyAutoFilter(sheet, "F");
}

function configureSheet(sheet, headers, widths) {
  sheet.addRow(headers);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = Math.min(38, Math.max(12, width));
  });
}

function formatRoiRow(row, color) {
  for (const column of [7, 8]) row.getCell(column).numFmt = "0.00";
  for (const column of [9, 10]) row.getCell(column).numFmt = "0";
  for (const column of [11, 12, 13, 14, 15, 16]) row.getCell(column).numFmt = "0.0000";
  for (const column of [1, 2, 4]) {
    const cell = row.getCell(column);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colorToArgb(color) } };
    cell.font = { color: { argb: contrastFontColor(color) } };
  }
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

function artifactValue({ entry, label, directory }) {
  const relativePath = artifactRelativePath(entry?.path, directory);
  if (entry?.status === "Included" && relativePath) return { text: label, hyperlink: relativePath };
  return `Skipped: ${safeText(entry?.reason) || "Artifact unavailable."}`;
}

function estimatedCollagenDensity(density, calibration) {
  const normalizedDensity = finiteNumber(density);
  const slope = finiteNumber(calibration?.slope);
  const intercept = finiteNumber(calibration?.intercept);
  if (normalizedDensity == null || slope == null || slope === 0 || intercept == null) return null;
  return (normalizedDensity - intercept) / slope;
}

function numberOrBlank(value) {
  return finiteNumber(value);
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

function artifactRelativePath(value, directory) {
  if (typeof value !== "string") return null;
  const path = value.replaceAll("\\", "/");
  const segments = path.split("/");
  if (segments[0] !== directory || segments.length < 2 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return `../${segments.join("/")}`;
}

function normalizeColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : DEFAULT_GROUP_COLOR.toUpperCase();
}

function colorToArgb(color) {
  return `FF${color.slice(1)}`;
}

function contrastFontColor(color) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return red * 299 + green * 587 + blue * 114 > 150_000 ? "FF111827" : "FFFFFFFF";
}

function safeFileName(value) {
  if (typeof value !== "string") return null;
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
}

function safeImageFolder(value) {
  const name = safeFileName(value);
  return name && name !== "." && name !== ".." ? name : "unknown";
}

function safeStatus(value) {
  return ["Included", "Skipped", "Warning"].includes(value) ? value : "Warning";
}

function safeText(value) {
  return typeof value === "string" ? value : null;
}

function safeErrorCategory(error) {
  const categories = {
    INVALID_EXPORT_INPUT: "invalid export input",
    MISSING_EXPORT_DATA: "missing export data",
  };
  return categories[error?.code] ?? "workbook generation failed";
}
