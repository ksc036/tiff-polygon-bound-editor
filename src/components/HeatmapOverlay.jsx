import React, { useLayoutEffect, useRef } from "react";
import {
  differenceColor,
  heatmapCellAtPoint,
  heatmapDisplayRange,
  heatmapDisplayValue,
  infernoColor,
} from "../lib/heatmap.js";
import { COLLAGEN_DENSITY_MODEL } from "../../shared/collagenDensity.js";
import { concentrationLabel, concentrationResult } from "../lib/collagenPresentation.js";

export default function HeatmapOverlay({
  heatmap,
  metric,
  comparison,
  pointer,
  collagenDensityColorMax,
  model = COLLAGEN_DENSITY_MODEL,
}) {
  const canvasRef = useRef(null);
  const hovered = heatmapCellAtPoint(heatmap, pointer);
  const hoveredIndex = hovered ? hovered.row * heatmap.columns + hovered.column : -1;
  const range = heatmapDisplayRange(metric, collagenDensityColorMax);
  const collagenDensityMax = heatmapDisplayRange(
    "estimated-collagen-density",
    collagenDensityColorMax,
  ).max;
  const hoveredEstimated = concentrationResult(hovered && { density: hovered.pixelDensity, areaPx: hovered.areaPx, empty: hovered.empty }, model, collagenDensityMax);
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
        : infernoColor(heatmapDisplayValue(cell, metric, collagenDensityMax, model), range.min, range.max);
      context.fillRect(cell.x, cell.y, cell.width, cell.height);
    });
  }, [collagenDensityMax, comparison, heatmap, metric, range.max, range.min, model]);

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
              concentrationLabel(hoveredEstimated)
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
  return Number.isFinite(value) ? value.toFixed(4) : "No data";
}
