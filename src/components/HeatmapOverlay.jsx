import React, { useLayoutEffect, useRef } from "react";
import {
  differenceColor,
  estimateHeatmapCollagenDensity,
  heatmapCellAtPoint,
  heatmapDisplayRange,
  heatmapMetricValue,
  infernoColor,
} from "../lib/heatmap.js";

export default function HeatmapOverlay({ heatmap, metric, comparison, pointer }) {
  const canvasRef = useRef(null);
  const hovered = heatmapCellAtPoint(heatmap, pointer);
  const hoveredIndex = hovered ? hovered.row * heatmap.columns + hovered.column : -1;
  const range = heatmapDisplayRange(metric);
  const hoveredEstimated = hovered
    ? estimateHeatmapCollagenDensity(hovered.pixelDensity)
    : null;
  const pointerX = pointer ? (pointer.x / heatmap.width) * 100 : 0;
  const pointerY = pointer ? (pointer.y / heatmap.height) * 100 : 0;

  useLayoutEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;

    context.imageSmoothingEnabled = false;
    context.globalAlpha = 1;
    context.clearRect(0, 0, heatmap.width, heatmap.height);
    heatmap.cells.forEach((cell, index) => {
      context.fillStyle = comparison
        ? differenceColor(comparison.values[index], comparison.maxAbs)
        : infernoColor(heatmapMetricValue(cell, metric), range.min, range.max);
      context.fillRect(cell.x, cell.y, cell.width, cell.height);
    });
  }, [comparison, heatmap, metric, range.max, range.min]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="heatmap-overlay"
        aria-label="heatmap overlay"
        width={heatmap.width}
        height={heatmap.height}
      />
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
