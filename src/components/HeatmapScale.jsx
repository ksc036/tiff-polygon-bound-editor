import React from "react";
import {
  differenceGradientCss,
  heatmapDisplayRange,
  heatmapGradientCss,
  HEATMAP_NO_DATA_COLOR,
} from "../lib/heatmap.js";
import { COLLAGEN_DENSITY_MODEL, collagenDensityModelText } from "../../shared/collagenDensity.js";

export default function HeatmapScale({ metric, comparison, collagenDensityColorMax, model = COLLAGEN_DENSITY_MODEL }) {
  const isComparison = Boolean(comparison);
  const noComparisonData = isComparison && Array.isArray(comparison.values) && !comparison.values.some(Number.isFinite);
  const range = heatmapDisplayRange(metric, collagenDensityColorMax);
  const maxAbs = Number.isFinite(comparison?.maxAbs) ? comparison.maxAbs : 0;
  const labels = isComparison
    ? [`-${formatScale(maxAbs)}`, "0", `+${formatScale(maxAbs)}`]
    : [formatScale(range.min), formatScale((range.min + range.max) / 2), `${formatScale(range.max)}${range.unit ? ` ${range.unit}` : ""}`];
  return (
    <section className="heatmap-scale-panel" aria-label="Heatmap scale">
      {noComparisonData ? <p>No finite comparison data</p> : <>
        <div className="heatmap-scale-bar" style={{ background: isComparison ? differenceGradientCss() : heatmapGradientCss() }} />
        <div className="heatmap-scale-labels">{labels.map((label) => <span key={label}>{label}</span>)}</div>
      </>}
      <div className="heatmap-no-data-legend"><i style={{ background: HEATMAP_NO_DATA_COLOR }} />No data</div>
      {metric !== "pixel-density" ? <p className="heatmap-calibration-caption">{model ? collagenDensityModelText(model) : "Calibration unavailable"}</p> : null}
    </section>
  );
}

function formatScale(value) {
  return String(Number(value.toFixed(6)));
}
