import { buildAnalysisRows } from "../shared/analysisRows.js";
import { HEATMAP_NO_DATA_COLOR, heatmapDisplayRange } from "../src/lib/heatmap.js";
import {
  calibrationMetadata,
  collagenDensityResult,
  collagenDensityResultFromMetrics,
  getCollagenDensityModel,
} from "../shared/collagenDensity.js";

export const EXPORT_NO_DATA_COLOR = HEATMAP_NO_DATA_COLOR;

export function exportCalibrationSnapshot(calibration) {
  const model = getCollagenDensityModel(calibration?.model ?? calibration?.modelId ?? calibration);
  return Object.freeze({ model, modelId: model.id, revision: calibration?.revision ?? 0,
    updatedAt: calibration?.updatedAt ?? null });
}

export function exportRoiCalibration(record, model, colorMax) {
  const excluded = new Set(record.excludedGroupIds ?? []);
  return buildAnalysisRows(record.analysis, record.bounds)
    .filter((row) => !excluded.has(row.sourceGroupId))
    .map((row) => {
      const metrics = row.metrics ?? {};
      return {
        roiId: row.roiId, groupId: row.sourceGroupId, bandId: row.bandId,
        areaFraction: Number.isFinite(metrics.density) ? metrics.density : null,
        roiAreaPx: metrics.roiAreaPx ?? null, maskPixelCount: metrics.maskPixelCount ?? null,
        ...collagenDensityResultFromMetrics(metrics, model, { colorMax }),
      };
    });
}

export function exportGridCalibration(source, model, colorMax) {
  const exceptionalCellIndices = { "color-max-exceeded": [], "model-range-exceeded": [], "no-data": [] };
  source.cells.forEach((cell, index) => {
    const result = collagenDensityResult(cell?.pixelDensity, model, {
      empty: cell?.empty === true || cell?.areaPx === 0,
      colorMax,
    });
    exceptionalCellIndices[result.status]?.push(index);
  });
  return { gridAlignment: source.gridAlignment ?? "top-left", cellWidth: source.cellWidth, cellHeight: source.cellHeight,
    columns: source.columns, rows: source.rows, width: source.width, height: source.height,
    indexOrder: "row-major", exceptionalCellIndices };
}

export function exportDatasetCalibration({ calibration, colorMax, exportedAt, records }) {
  const snapshot = exportCalibrationSnapshot(calibration);
  return {
    ...calibrationMetadata({ model: snapshot.model, revision: snapshot.revision, colorMax, exportedAt }),
    noDataColor: EXPORT_NO_DATA_COLOR,
    heatmapComparison: {
      modelRangeExceeded: "substitute-color-max",
      substitutionValue: heatmapDisplayRange("estimated-collagen-density", colorMax).max,
      finiteValues: "uncapped",
      invalidOrEmpty: "no-data",
    },
    images: records.map((record) => ({
      imageId: record.image.id, image: record.imageFolder,
      crop: record.subimage?.status === "Included" ? record.subimage.crop : null,
      rois: exportRoiCalibration(record, snapshot.model, colorMax),
      grids: record.calibrationGrids ?? [],
    })),
  };
}
