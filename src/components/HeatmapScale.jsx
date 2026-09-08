import React from "react";
import {
  differenceGradientCss,
  heatmapDisplayRange,
  heatmapGradientCss,
} from "../lib/heatmap.js";

export default function HeatmapScale({ metric, comparison, collagenDensityColorMax }) {
  const isComparison = Boolean(comparison);
  const range = heatmapDisplayRange(metric, collagenDensityColorMax);
  const maxAbs = Number.isFinite(comparison?.maxAbs) ? comparison.maxAbs : 0;
  const labels = isComparison
    ? [`-${formatScale(maxAbs)}`, "0", `+${formatScale(maxAbs)}`]
    : [formatScale(range.min), formatScale((range.min + range.max) / 2), `${formatScale(range.max)}${range.unit ? ` ${range.unit}` : ""}`];
  return (
    <section className="heatmap-scale-panel" aria-label="Heatmap scale">
      <div className="heatmap-scale-bar" style={{ background: isComparison ? differenceGradientCss() : heatmapGradientCss() }} />
      <div className="heatmap-scale-labels">{labels.map((label) => <span key={label}>{label}</span>)}</div>
    </section>
  );
}

function formatScale(value) {
  return String(Number(value.toFixed(6)));
}
