import ExcelJS from "exceljs";
import { expect, test } from "vitest";
import { createImageWorkbook, workbookFailureText } from "./exportWorkbook.js";

function workbookInput(overrides = {}) {
  return {
    image: { id: "T01", imageFolder: "T01", imageFile: "T01.tif" },
    dimensions: { width: 100, height: 80 },
    sourceFiles: {
      image: { file: "T01.tif", mtimeMs: 1_721_000_000_000 },
      mask: { file: "T01.png", mtimeMs: 1_721_000_000_100 },
      bounds: { file: "T01.bounds.json", mtimeMs: 1_721_000_000_200 },
      analysis: { file: "T01.analysis.json", mtimeMs: 1_721_000_000_300 },
    },
    bounds: {
      groups: [{ id: "cell", name: "Cell", color: "#22c55e", analysisMode: "outside" }],
    },
    analysis: {
      roiBands: [{ id: "near", label: "Near", fromPx: 0, toPx: 20 }],
      groups: [{
        groupId: "cell",
        groupName: "Cell",
        analysisMode: "outside",
        bands: {
          near: {
            roiAreaPx: 200,
            maskPixelCount: 50,
            density: 0.25,
            globalAlignment: 0.8,
            radialNormalAlignment: 0.4,
            tangentialAlignment: -0.4,
            migrationAlignment: 0.6,
            empty: false,
          },
        },
      }],
    },
    calibration: { slope: 0.1, intercept: 0 },
    autoSavedBounds: true,
    roiEntry: { status: "Included", path: "roi/T01_ROI_overview.png" },
    heatmapEntries: [{
      cellWidth: 20,
      cellHeight: 20,
      columns: 5,
      rows: 4,
      metric: "Pixel Density",
      currentImage: "T01",
      previousImage: null,
      colorMin: 0,
      colorMax: 1,
      unit: "ratio",
      status: "Included",
      path: "heatmap/20x20/T01_cell_20px_pixel_density.png",
      reason: "",
    }],
    reportEntries: [{ status: "Warning", artifact: "Analysis", message: "Bounds were auto-saved before export." }],
    exportedAt: new Date("2026-07-27T01:02:03Z"),
    ...overrides,
  };
}

test("writes five linked sheets with numeric ROI values and group colors", async () => {
  const buffer = await createImageWorkbook(workbookInput());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
    "ROI Statistics",
    "Image Summary",
    "Metric Definitions",
    "Heatmap Index",
    "Export Report",
  ]);

  const roi = workbook.getWorksheet("ROI Statistics");
  expect(roi.getRow(1).values.slice(1)).toEqual([
    "ROI ID", "Group ID", "Group Name", "Group Color", "Analysis Mode", "ROI Label", "From px",
    "To px", "Area px", "Mask Pixels", "Pixel Density", "Estimated Collagen Density (mg/ml)",
    "ROI Alignment", "Radial Alignment", "Circumferential Alignment", "Migration Axis Alignment", "Empty", "ROI Image",
  ]);
  expect(roi.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  expect(roi.autoFilter).toBe("A1:R2");
  expect(roi.getCell("A2").value).toBe("G01-N");
  expect(roi.getCell("I2").value).toBe(200);
  expect(roi.getCell("J2").value).toBe(50);
  expect(roi.getCell("K2").value).toBe(0.25);
  expect(roi.getCell("K2").numFmt).toBe("0.0000");
  expect(roi.getCell("A2").fill.fgColor.argb).toBe("FF22C55E");
  expect(roi.getCell("R2").value).toEqual({
    text: "Open ROI overview",
    hyperlink: "../roi/T01_ROI_overview.png",
  });

  const heatmaps = workbook.getWorksheet("Heatmap Index");
  expect(heatmaps.getCell("L2").value).toEqual({
    text: "Open PNG",
    hyperlink: "../heatmap/20x20/T01_cell_20px_pixel_density.png",
  });
});

test("keeps unavailable measurements blank and reports safe artifact details", async () => {
  const input = workbookInput({
    analysis: {
      groups: [{ groupId: "cell", analysisMode: "inside", area: { roiAreaPx: 20, maskPixelCount: 0, empty: true } }],
    },
    roiEntry: { status: "Skipped", reason: "Invalid bounds." },
    heatmapEntries: [{ status: "Skipped", metric: "Pixel Density", reason: "Saved heatmap is stale." }],
    reportEntries: [{ status: "Included", artifact: "Mask", message: "Selected mask included." }],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createImageWorkbook(input));

  const roi = workbook.getWorksheet("ROI Statistics");
  expect(roi.getCell("G2").value).toBeNull();
  expect(roi.getCell("K2").value).toBeNull();
  expect(roi.getCell("L2").value).toBeNull();
  expect(roi.getCell("M2").value).toBeNull();
  expect(roi.getCell("Q2").value).toBe(true);
  expect(roi.getCell("R2").value).toBe("Skipped: Invalid bounds.");
  expect(workbook.getWorksheet("Heatmap Index").getCell("L2").value).toBe("Skipped: Saved heatmap is stale.");
  expect(workbook.getWorksheet("Export Report").getColumn(2).values).toContain("Included");
});

test("returns safe recovery text without leaking error details", () => {
  const text = workbookFailureText({
    imageFolder: "/private/export-root/T01",
    error: new Error("/private/path/token"),
  }).toString("utf8");

  expect(text).toContain("T01");
  expect(text).toContain("workbook generation failed");
  expect(text).toContain("Review the export report");
  expect(text).not.toContain("/private/export-root");
  expect(text).not.toContain("/private/path/token");
  expect(workbookFailureText({ imageFolder: "../", error: null }).toString("utf8")).toContain("Image folder: unknown");
});

test("keeps missing timestamps blank and refuses artifact links outside their directory", async () => {
  const input = workbookInput({
    sourceFiles: { image: { file: "/private/root/T01.tif", mtimeMs: null } },
    roiEntry: { status: "Included", path: "roi/../private.png" },
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createImageWorkbook(input));

  const summary = workbook.getWorksheet("Image Summary");
  expect(summary.getCell("B3").value).toBe("T01.tif");
  expect(summary.getCell("B11").value).toBeNull();
  expect(workbook.getWorksheet("ROI Statistics").getCell("R2").value).toBe("Skipped: Artifact unavailable.");
});

test("writes loaded workbook text as primitive strings instead of Excel formulas or objects", async () => {
  const formulaObject = { formula: "HYPERLINK(\"https://malicious.example\", \"open\")", result: "open" };
  const input = workbookInput({
    image: { id: "=T01", imageFolder: "@folder", imageFile: formulaObject },
    sourceFiles: {
      image: { file: formulaObject, mtimeMs: 1_721_000_000_000 },
      mask: { file: "+mask.png", mtimeMs: null },
      bounds: { file: "-bounds.json", mtimeMs: null },
      analysis: { file: formulaObject, mtimeMs: null },
    },
    bounds: { groups: [{ id: "cell", name: "=not-a-formula", color: formulaObject }] },
    analysis: {
      roiBands: [{ id: "near", label: formulaObject, fromPx: 0, toPx: 20 }],
      groups: [{
        groupId: "cell",
        groupName: formulaObject,
        analysisMode: "outside",
        bands: { near: { roiAreaPx: 2, maskPixelCount: 1, density: 0.5 } },
      }],
    },
    heatmapEntries: [{
      status: "Included",
      metric: formulaObject,
      currentImage: formulaObject,
      previousImage: "=previous",
      unit: formulaObject,
      path: "heatmap/20x20/current.png",
      reason: formulaObject,
    }],
    reportEntries: [{ status: "Warning", artifact: formulaObject, message: formulaObject }],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createImageWorkbook(input));

  const roi = workbook.getWorksheet("ROI Statistics");
  expect(roi.getCell("C2").type).toBe(ExcelJS.ValueType.String);
  expect(roi.getCell("C2").value).toBe("=not-a-formula");
  expect(roi.getCell("D2").value).toBe("#94A3B8");
  expect(roi.getCell("F2").value).toBe("near");

  const summary = workbook.getWorksheet("Image Summary");
  expect(summary.getCell("B2").value).toBe("@folder");
  expect(summary.getCell("B3").value).toBeNull();
  expect(summary.getCell("B4").type).toBe(ExcelJS.ValueType.String);
  expect(summary.getCell("B4").value).toBe("+mask.png");
  expect(summary.getCell("B5").value).toBe("-bounds.json");
  expect(summary.getCell("B6").value).toBeNull();

  const heatmaps = workbook.getWorksheet("Heatmap Index");
  expect(heatmaps.getCell("B2").value).toBeNull();
  expect(heatmaps.getCell("C2").value).toBeNull();
  expect(heatmaps.getCell("D2").value).toBe("=previous");
  expect(heatmaps.getCell("K2").value).toBeNull();
  expect(heatmaps.getCell("M2").value).toBeNull();

  const report = workbook.getWorksheet("Export Report");
  expect(report.getCell("C2").value).toBeNull();
  expect(report.getCell("D2").value).toBeNull();
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => row.eachCell((cell) => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)));
  }
});
