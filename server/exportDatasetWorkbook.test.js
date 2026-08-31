import ExcelJS from "exceljs";
import { test, expect } from "vitest";
import { createDatasetExportWorkbook } from "./exportDatasetWorkbook.js";

const EXPORTED_AT = "2026-08-31T03:04:05.000Z";

function workbookInput(overrides = {}) {
  return {
    exportedAt: EXPORTED_AT,
    records: [
      {
        image: { id: "T01", imageFolder: "T01" },
        subimage: {
          status: "Included",
          crop: {
            sourceWidth: 40,
            sourceHeight: 40,
            x: 5,
            y: 6,
            width: 20,
            height: 20,
          },
          path: "T01/subimage/subimage_16bit.tif",
        },
        derivedEntries: [
          {
            status: "Included",
            artifact: "Absolute Subimage heatmap",
            currentImage: "T01",
            cellSize: 20,
            path: "T01/heatmap/20x20/subimage.png",
          },
          {
            status: "Not applicable",
            artifact: "Subimage comparison",
            currentImage: "T01",
            previousImage: null,
            cellSize: 20,
            reason: "First image has no previous image.",
          },
        ],
      },
      {
        image: { id: "T02", imageFolder: "T02" },
        subimage: {
          status: "Included",
          crop: {
            sourceWidth: 40,
            sourceHeight: 40,
            x: 7,
            y: 8,
            width: 18,
            height: 20,
          },
          path: "T02/subimage/subimage_16bit.tif",
        },
        derivedEntries: [
          {
            status: "Skipped",
            artifact: "Subimage comparison",
            image: "T02",
            previousImage: "T01",
            sourceCellSize: 20,
            reason: "Subimage dimensions do not match previous image.",
          },
        ],
      },
    ],
    scaleEntries: [
      {
        status: "Included",
        artifact: "Comparison scale",
        cellSize: 20,
        path: "scales/comparison_20x20.png",
      },
    ],
    ...overrides,
  };
}

async function loadWorkbook(input) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createDatasetExportWorkbook(input));
  return workbook;
}

function rowValues(row, columnCount) {
  return Array.from({ length: columnCount }, (_, index) => row.getCell(index + 1).value ?? null);
}

test("records crop dimensions and recoverable skips", async () => {
  const workbook = await loadWorkbook(workbookInput());

  expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Subimages", "Export Report"]);

  const subimages = workbook.getWorksheet("Subimages");
  expect(rowValues(subimages.getRow(1), 9)).toEqual([
    "Image",
    "Source Width",
    "Source Height",
    "Crop X",
    "Crop Y",
    "Crop Width",
    "Crop Height",
    "Status",
    "Path / Reason",
  ]);
  expect(rowValues(subimages.getRow(2), 9)).toEqual([
    "T01",
    40,
    40,
    5,
    6,
    20,
    20,
    "Included",
    "T01/subimage/subimage_16bit.tif",
  ]);

  const report = workbook.getWorksheet("Export Report");
  expect(rowValues(report.getRow(1), 8)).toEqual([
    "Timestamp",
    "Status",
    "Artifact",
    "Image",
    "Previous Image",
    "Cell Size",
    "Path",
    "Reason",
  ]);
  expect(report.getColumn(8).values).toContain("Subimage dimensions do not match previous image.");

  const firstComparison = rowValues(report.getRow(3), 8);
  expect(firstComparison).toEqual([
    new Date(EXPORTED_AT),
    "Not applicable",
    "Subimage comparison",
    "T01",
    null,
    20,
    null,
    "First image has no previous image.",
  ]);
  expect(["Warning", "Skipped"]).not.toContain(firstComparison[1]);

  expect(rowValues(report.getRow(4), 8)).toEqual([
    new Date(EXPORTED_AT),
    "Skipped",
    "Subimage comparison",
    "T02",
    "T01",
    20,
    null,
    "Subimage dimensions do not match previous image.",
  ]);
  expect(rowValues(report.getRow(5), 8)).toEqual([
    new Date(EXPORTED_AT),
    "Included",
    "Comparison scale",
    null,
    null,
    20,
    "scales/comparison_20x20.png",
    null,
  ]);
});

test("keeps sanitized names while excluding absolute host paths", async () => {
  const formulaObject = {
    formula: 'HYPERLINK("https://malicious.example", "open")',
    result: "open",
  };
  const input = workbookInput({
    records: [
      {
        image: { id: "ignored", imageFolder: "C:\\private\\dataset\\T:01" },
        subimage: {
          status: "Included",
          crop: {
            sourceWidth: "40",
            sourceHeight: 40,
            x: 5,
            y: 6,
            width: 20,
            height: 20,
          },
          path: "C:\\private\\dataset\\T01\\source-subimage.tif",
        },
        derivedEntries: [
          {
            status: "Included",
            artifact: formulaObject,
            currentImage: "/private/dataset/T:01",
            previousImage: "C:\\private\\dataset\\T:00",
            cellSize: "20",
            path: "/private/dataset/T01/full.png",
            reason: formulaObject,
          },
          {
            status: "Included",
            artifact: "Absolute full heatmap",
            currentImage: "=T:01",
            cellSize: 50,
            path: "T:01/heatmap/50x50/full.png",
            reason: "=kept as plain text",
          },
        ],
      },
    ],
    scaleEntries: [],
  });
  const workbook = await loadWorkbook(input);

  expect(rowValues(workbook.getWorksheet("Subimages").getRow(2), 9)).toEqual([
    "T:01",
    40,
    40,
    5,
    6,
    20,
    20,
    "Included",
    "source-subimage.tif",
  ]);

  const report = workbook.getWorksheet("Export Report");
  expect(rowValues(report.getRow(2), 8)).toEqual([
    new Date(EXPORTED_AT),
    "Included",
    null,
    "T:01",
    "T:00",
    20,
    "full.png",
    null,
  ]);
  expect(report.getCell("D3").type).toBe(ExcelJS.ValueType.String);
  expect(report.getCell("D3").value).toBe("=T:01");
  expect(report.getCell("G3").value).toBe("T:01/heatmap/50x50/full.png");
  expect(report.getCell("H3").type).toBe(ExcelJS.ValueType.String);
  expect(report.getCell("H3").value).toBe("=kept as plain text");

  const workbookText = workbook.worksheets.flatMap((sheet) =>
    sheet.getSheetValues().flat().filter((value) => typeof value === "string")
  ).join("\n");
  expect(workbookText).not.toContain("C:\\private");
  expect(workbookText).not.toContain("/private/dataset");
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => row.eachCell((cell) => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)));
  }
});

test("matches the existing workbook header and width conventions", async () => {
  const workbook = await loadWorkbook(workbookInput());

  expect(workbook.creator).toBe("TIFF Polygon Bound Editor");
  expect(workbook.created).toEqual(new Date(EXPORTED_AT));
  expect(workbook.modified).toEqual(new Date(EXPORTED_AT));

  for (const sheet of workbook.worksheets) {
    expect(sheet.views).toHaveLength(1);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBe(`A1:${sheet.getColumn(sheet.columnCount).letter}${sheet.rowCount}`);
    sheet.getRow(1).eachCell((cell) => {
      expect(cell.font).toMatchObject({ bold: true, color: { argb: "FFFFFFFF" } });
      expect(cell.fill).toMatchObject({
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1E293B" },
      });
      expect(cell.alignment).toMatchObject({ vertical: "middle", wrapText: true });
    });
    for (let column = 1; column <= sheet.columnCount; column += 1) {
      expect(sheet.getColumn(column).width).toBeGreaterThanOrEqual(12);
      expect(sheet.getColumn(column).width).toBeLessThanOrEqual(38);
    }
  }

  const report = workbook.getWorksheet("Export Report");
  expect(report.getColumn(1).width).toBe(24);
  expect(report.getColumn(8).width).toBe(38);
  for (let row = 2; row <= report.rowCount; row += 1) {
    expect(report.getCell(row, 1).numFmt).toBe("yyyy-mm-dd hh:mm:ss");
  }
});
