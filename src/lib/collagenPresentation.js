import { collagenDensityResultFromMetrics } from "../../shared/collagenDensity.js";

export function concentrationResult(metrics, model, colorMax = null) {
  if (!model) return { value: null, status: "calibration-unavailable" };
  const result = collagenDensityResultFromMetrics(metrics, model, { colorMax });
  return colorMax === null && result.status === "color-max-exceeded" ? { ...result, status: "ok" } : result;
}

export function concentrationLabel(result) {
  if (result.status === "calibration-unavailable") return "Calibration unavailable";
  if (result.status === "model-range-exceeded") return "Model range exceeded";
  if (!Number.isFinite(result.value)) return "No data";
  const suffix = result.status === "color-max-exceeded" ? " (color Max exceeded)" : "";
  return `${result.value.toFixed(3)} mg/mL${suffix}`;
}
