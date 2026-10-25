import ExcelJS from "exceljs";
import sharp from "sharp";
import { expect, test } from "vitest";
import { getCollagenDensityModel, pixelDensityFromCollagenDensity } from "../shared/collagenDensity.js";
import { heatmapCalibrationText, heatmapFigureText } from "../shared/heatmapFigure.js";
import { createImageWorkbook } from "./exportWorkbook.js";
import { aggregateRoiMetrics } from "./analysisGeometry.js";
import { exportDatasetCalibration, exportRoiCalibration } from "./exportCalibration.js";
import { concentrationResult } from "../src/lib/collagenPresentation.js";
import { createDatasetExportWorkbook } from "./exportDatasetWorkbook.js";
import { planHeatmapFigures, planSavedHeatmapFigures, hydrateHeatmapFigure, buildHeatmapFigureSvg } from "./exportHeatmaps.js";
import { hydrateEstimatedHeatmapAsset, planEstimatedHeatmapAssets, renderEstimatedHeatmapAsset, renderHeatmapScaleAsset } from "./exportHeatmapAssets.js";

const low = getCollagenDensityModel("low-density");
const high = getCollagenDensityModel("high-density");

test.each([high, low])("keeps zero-fiber measurements distinct from zero valid area with $id", async (model) => {
  for (const area of [9, 0]) {
    const assignments = new Map(Array.from({ length: area }, (_, index) => [String(index), { groupId: "g", bandId: "near" }]));
    const metrics = aggregateRoiMetrics({ assignments, maskSamples: [], skeletonSamples: [] }).overall;
    expect(metrics).toMatchObject({ roiAreaPx: area, maskPixelCount: 0, empty: true });
    const expected = area > 0 ? { value: 0, status: "below-baseline" } : { value: null, status: "no-data" };
    expect(concentrationResult(metrics, model)).toEqual(expected);
    const record = { bounds: { groups: [{ id: "g", analysisMode: "inside" }] },
      analysis: { groups: [{ groupId: "g", analysisMode: "inside", area: metrics }] } };
    expect(exportRoiCalibration(record, model, 8)[0]).toMatchObject(expected);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await createImageWorkbook({ ...record, calibration: { model, revision: 0 } }));
    const sheet = workbook.getWorksheet("ROI Statistics");
    const headers = sheet.getRow(1).values;
    expect(sheet.getRow(2).getCell(headers.indexOf("Estimated Collagen Density (mg/ml)")).value).toBe(expected.value);
    expect(sheet.getRow(2).getCell(headers.indexOf("Concentration Status")).value).toBe(expected.status);
  }
});

function source(values) {
  return { width: values.length * 20, height: 20, cellWidth: 20, cellHeight: 20,
    columns: values.length, rows: 1,
    cells: values.map((pixelDensity, column) => ({ pixelDensity, column, row: 0,
      x: column * 20, y: 0, width: 20, height: 20 })) };
}

test("figure captions use the selected model and omit calibration for pixel density", () => {
  expect(heatmapCalibrationText(low)).toContain("0.1087 - 0.107");
  expect(heatmapCalibrationText(high)).toContain("0.2631 - 0.2431");
  expect(heatmapFigureText({ metric: "pixel-density", calibration: low }).calibrationLine).toBe("");
});

test("legacy report canvas includes the no-data legend without clipping", () => {
  const svg = buildHeatmapFigureSvg({ kind: "absolute", metric: "estimated-collagen-density",
    metricLabel: "Estimated Collagen Density", unit: "mg/ml", currentImage: "T01", columns: 1,
    rows: 1, cellWidth: 20, cellHeight: 20, colorRange: { min: 0, max: 3 }, values: [null], calibration: low });
  const height = Number(svg.match(/<svg[^>]*height="([^"]+)"/)[1]);
  const legendY = Number(svg.match(/<text[^>]*y="([^"]+)"[^>]*>No data<\/text>/)[1]);
  expect(legendY + 4).toBeLessThan(height);
});

test("legacy figures preserve finite estimates and substitute Max for out-of-model comparisons", () => {
  const previous = source([pixelDensityFromCollagenDensity(4, low), 0.2, null]);
  const current = source([pixelDensityFromCollagenDensity(6, low), 0.2, null]);
  const plan = planHeatmapFigures({
    images: [{ id: "T01" }, { id: "T02" }], calibration: low, estimatedCollagenColorMax: 3,
    sources: new Map([["T01:20", { status: "Included", heatmap: previous }],
      ["T02:20", { status: "Included", heatmap: current }]]),
  });
  const absolute = plan.figures.find((figure) => figure.currentImage === "T02" && figure.kind === "absolute" && figure.metric === "estimated-collagen-density");
  const comparison = plan.figures.find((figure) => figure.kind === "comparison" && figure.metric === "estimated-collagen-density");
  expect(absolute.values[0]).toBeCloseTo(6, 8);
  expect(absolute.values.slice(1)).toEqual([3, null]);
  expect(comparison.values[0]).toBeCloseTo(2, 8);
  expect(comparison.values.slice(1)).toEqual([0, null]);
  expect(buildHeatmapFigureSvg(absolute)).toContain("0.1087 - 0.107");
  expect(buildHeatmapFigureSvg(absolute)).toContain("No data");
});

test("clean heatmaps distinguish real zero, saturation and missing data with selected model", async () => {
  const map = source([0, 0.2, null]);
  const asset = await hydrateEstimatedHeatmapAsset({ kind: "absolute-full", currentImageId: "T01",
    sourceCellSize: 20, width: 60, height: 20, calibration: low, estimatedCollagenMax: 3,
    colorRange: { min: 0, max: 3 } }, { storage: {}, loadHeatmap: async () => map });
  expect(asset.values).toEqual([0, 3, null]);
  const decoded = await sharp(await renderEstimatedHeatmapAsset(asset)).raw().toBuffer({ resolveWithObject: true });
  const color = (x) => [...decoded.data.subarray(x * 3, x * 3 + 3)];
  expect(color(0)).not.toEqual(color(20));
  expect(color(40)).toEqual([128, 133, 139]);
});

test("all-null comparisons are distinguishable from genuine zero differences in detached scales", async () => {
  async function plan(pixelDensity) {
    return planEstimatedHeatmapAssets({ images: [{ id: "T01" }, { id: "T02" }], calibration: low,
      sourceDimensionsByImage: new Map([["T01", { width: 20, height: 20 }], ["T02", { width: 20, height: 20 }]]),
      loadHeatmap: async () => source([pixelDensity]),
    });
  }
  const missing = await plan(null);
  const zero = await plan(0.05);
  const saturated = await plan(0.2);
  expect(missing.comparisonHasFiniteValues.get(20)).toBe(false);
  expect(zero.comparisonHasFiniteValues.get(20)).toBe(true);
  expect(saturated.comparisonHasFiniteValues.get(20)).toBe(true);
  expect(missing.descriptors.find((descriptor) => descriptor.kind === "comparison-full").hasFiniteValues).toBe(false);
  const png = await renderHeatmapScaleAsset({ kind: "comparison", maxAbs: 0, hasFiniteValues: false, calibration: low });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const offset = (60 * info.width + 100) * info.channels;
  expect([...data.subarray(offset, offset + 3)]).toEqual([128, 133, 139]);
});

test.each([3, 8, 10])("ZIP full and cropped comparisons use Max %s for model overflow", async (maximum) => {
  const maps = { T01: source([0, 0.2, null]), T02: source([0.2, 0, null]) };
  const images = [{ id: "T01" }, { id: "T02" }];
  const loadHeatmap = async (_storage, id) => maps[id];
  const crop = { sourceWidth: 60, sourceHeight: 20, x: 0, y: 0, width: 40, height: 20 };
  const plan = await planEstimatedHeatmapAssets({ images, calibration: low, cellSizes: [20],
    sourceDimensionsByImage: new Map(images.map(({ id }) => [id, { width: 60, height: 20 }])),
    cropsByImage: new Map(images.map(({ id }) => [id, crop])),
    estimatedCollagenColorMax: maximum, loadHeatmap });

  expect(plan.ranges.get(20)).toBe(maximum);
  for (const kind of ["comparison-full", "comparison-subimage"]) {
    const descriptor = plan.descriptors.find((entry) => entry.kind === kind);
    const asset = await hydrateEstimatedHeatmapAsset(descriptor, { loadHeatmap });
    expect(asset.values).toEqual(kind === "comparison-full" ? [maximum, -maximum, null] : [maximum, -maximum]);
    const decoded = await sharp(await renderEstimatedHeatmapAsset(asset)).raw().toBuffer({ resolveWithObject: true });
    expect([...decoded.data.subarray(0, 3)]).toEqual([220, 38, 38]);
    expect([...decoded.data.subarray(60, 63)]).toEqual([37, 99, 235]);
    if (kind === "comparison-full") expect([...decoded.data.subarray(120, 123)]).toEqual([128, 133, 139]);
  }

  const legacy = await planSavedHeatmapFigures({ images, cellSizes: [20], calibration: low,
    estimatedCollagenColorMax: maximum, loadHeatmap });
  const descriptor = legacy.figures.find((entry) => entry.kind === "comparison" && entry.metric === "estimated-collagen-density");
  expect(descriptor.colorRange).toEqual({ min: -maximum, max: maximum });
  const figure = await hydrateHeatmapFigure(descriptor, { loadHeatmap });
  expect(figure.values).toEqual([maximum, -maximum, null]);
});

test("export metadata distinguishes substituted heatmap comparisons from raw concentration estimates", () => {
  const metadata = exportDatasetCalibration({ calibration: low, colorMax: 3, records: [] });
  expect(metadata.heatmapComparison).toEqual({ modelRangeExceeded: "substitute-color-max",
    substitutionValue: 3, finiteValues: "uncapped", invalidOrEmpty: "no-data" });
});

test("legacy all-null comparison report labels its scale as no data instead of zero", () => {
  const svg = buildHeatmapFigureSvg({ kind: "comparison", metric: "estimated-collagen-density",
    metricLabel: "Estimated Collagen Density", unit: "mg/ml", currentImage: "T02", previousImage: "T01",
    columns: 1, rows: 1, cellWidth: 20, cellHeight: 20, colorRange: { min: 0, max: 0 }, values: [null], calibration: low });
  expect(svg).toContain("Color range: No data");
  expect(svg).not.toContain("Color range: 0 to 0");
});

test("workbooks preserve uncapped values, statuses and the pinned model revision", async () => {
  const calibration = { model: low, modelId: low.id, revision: 7 };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createImageWorkbook({ calibration, estimatedCollagenColorMax: 3,
    bounds: { groups: [{ id: "g", analysisMode: "inside" }] },
    analysis: { groups: [{ groupId: "g", analysisMode: "inside", area: {
      roiAreaPx: 100, density: pixelDensityFromCollagenDensity(6, low), empty: false,
    } }] },
  }));
  const roi = workbook.getWorksheet("ROI Statistics");
  const headers = roi.getRow(1).values;
  expect(roi.getRow(2).getCell(headers.indexOf("Estimated Collagen Density (mg/ml)")).value).toBeCloseTo(6, 8);
  expect(roi.getRow(2).getCell(headers.indexOf("Concentration Status")).value).toBe("color-max-exceeded");
  const summary = new Map();
  workbook.getWorksheet("Image Summary").eachRow((row) => summary.set(row.getCell(1).value, row.getCell(2).value));
  expect(summary.get("Model ID")).toBe("low-density");
  expect(summary.get("Calibration revision")).toBe(7);
  expect(summary.get("Model plateau")).toBe(0.1087);
  expect(workbook.getWorksheet("Metric Definitions").getCell("B3").value).toContain("0.1087");
  const dataset = new ExcelJS.Workbook();
  await dataset.xlsx.load(await createDatasetExportWorkbook({ calibration, estimatedCollagenColorMax: 3 }));
  expect(dataset.getWorksheet("Calibration")).toBeDefined();
});
