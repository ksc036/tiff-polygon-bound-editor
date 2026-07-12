import React from "react";
import {
  differenceColor,
  estimateHeatmapCollagenDensity,
  heatmapCellAtPoint,
  heatmapDisplayRange,
  heatmapMetricValue,
  infernoColor,
} from "../lib/heatmap.js";

export default function HeatmapOverlay({ heatmap, metric, calibration, comparison, opacity, pointer }) {
  const hovered = heatmapCellAtPoint(heatmap, pointer);
  const hoveredIndex = hovered ? hovered.row * heatmap.columns + hovered.column : -1;
  const range = heatmapDisplayRange(metric);
  const hoveredEstimated = hovered
    ? estimateHeatmapCollagenDensity(hovered.pixelDensity, calibration)
    : null;
  const pointerX = pointer ? (pointer.x / heatmap.width) * 100 : 0;
  const pointerY = pointer ? (pointer.y / heatmap.height) * 100 : 0;

  return (
    <>
      <svg
        className="heatmap-overlay"
        aria-label="heatmap overlay"
        viewBox={`0 0 ${heatmap.width} ${heatmap.height}`}
      >
        {heatmap.cells.map((cell, index) => (
          <rect
            key={`${cell.row}-${cell.column}`}
            x={cell.x}
            y={cell.y}
            width={cell.width}
            height={cell.height}
            fill={
              comparison
                ? differenceColor(comparison.values[index], comparison.maxAbs)
                : infernoColor(heatmapMetricValue(cell, metric, calibration), range.min, range.max)
            }
            fillOpacity={opacity}
          />
        ))}
      </svg>
      {hovered ? (
        <div
          className={`heatmap-tooltip${pointerX > 50 ? " align-right" : ""}${
            pointerY < 35 ? " align-below" : ""
          }`}
          role="status"
          style={{
            ...(pointerX > 50 ? { right: `${100 - pointerX}%` } : { left: `${pointerX}%` }),
            top: `${pointerY}%`,
          }}
        >
          <strong>{`Row ${hovered.row + 1}, Column ${hovered.column + 1}`}</strong>
          <span>{`Mask pixels ${hovered.maskPixelCount} / ${hovered.areaPx}`}</span>
          <span>{`Pixel Density ${formatValue(hovered.pixelDensity)}`}</span>
          <span>
            {`Estimated Collagen Density ${
              Number.isFinite(hoveredEstimated) ? `${formatValue(hoveredEstimated)} mg/ml` : "Unavailable"
            }`}
          </span>
          {comparison ? (
            <span>
              {`Previous ${formatValue(comparison.previousValues[hoveredIndex])}, Current ${formatValue(
                comparison.currentValues[hoveredIndex],
              )}, Change ${formatValue(comparison.values[hoveredIndex])}`}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function formatValue(value) {
  return Number.isFinite(value) ? value.toFixed(4) : "Unavailable";
}
