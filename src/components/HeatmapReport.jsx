import React from "react";
import {
  formatHeatmapFigureNumber,
  heatmapAxisTickValues,
  heatmapFigureText,
  heatmapScaleTickValues,
} from "../../shared/heatmapFigure.js";
import { heatmapDisplayRange } from "../lib/heatmap.js";
import HeatmapOverlay from "./HeatmapOverlay.jsx";

export default function HeatmapReport(props) {
  const range = props.comparison
    ? { min: -props.comparison.maxAbs, max: props.comparison.maxAbs, unit: heatmapDisplayRange(props.metric).unit }
    : heatmapDisplayRange(props.metric);
  const text = heatmapFigureText({
    currentImage: props.currentImageName,
    previousImage: props.comparison ? props.previousImageName : null,
    metric: props.metric,
    metricLabel: props.metric === "pixel-density" ? "Pixel Density" : "Estimated Collagen Density",
    metricUnit: range.unit,
    cellWidth: props.heatmap.cellWidth,
    cellHeight: props.heatmap.cellHeight,
    columns: props.heatmap.columns,
    rows: props.heatmap.rows,
    min: range.min,
    max: range.max,
    comparison: Boolean(props.comparison),
    calibration: props.calibration,
  });
  const xTicks = heatmapAxisTickValues(props.heatmap.columns);
  const yTicks = heatmapAxisTickValues(props.heatmap.rows);
  const scaleTicks = heatmapScaleTickValues(range.min, range.max);

  return (
    <figure className="heatmap-report" aria-label="heatmap report">
      <figcaption className="heatmap-report-header">
        {text.titleLines.map((line) => <strong key={line}>{line}</strong>)}
        <span>{text.detailLine}</span>
        <span>{text.calibrationLine}</span>
        <span>{text.rangeLine}</span>
      </figcaption>
      <div className="heatmap-report-body">
        <div className="heatmap-y-axis" aria-label="Grid Y axis">
          <span className="heatmap-axis-title">Grid Y</span>
          {yTicks.map((value, index) => (
            <span key={`${value}-${index}`} data-testid="heatmap-y-tick">{value}</span>
          ))}
        </div>
        <div
          className="heatmap-report-plot"
          aria-label="heatmap report plot"
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: `${props.heatmap.width} / ${props.heatmap.height}`,
          }}
        >
          <HeatmapOverlay
            heatmap={props.heatmap}
            metric={props.metric}
            calibration={props.calibration}
            comparison={props.comparison}
            pointer={props.pointer}
          />
          <canvas
            ref={props.originalCanvasRef}
            className="raw-canvas heatmap-original-overlay"
            aria-label="heatmap original image"
            style={{ opacity: props.originalOpacity }}
          />
          <svg
            className="heatmap-cell-grid"
            aria-label="heatmap cell grid"
            viewBox="0 0 100 100"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          >
            {gridLines(props.heatmap).map((line) => (
              <line key={line.key} {...line.attributes} />
            ))}
          </svg>
        </div>
        <div className="heatmap-color-scale">
          <div
            className={props.comparison ? "heatmap-scale difference" : "heatmap-scale absolute"}
            aria-label={text.colorBarLabel}
          />
          <div className="heatmap-scale-ticks">
            {scaleTicks.map((value, index) => (
              <span key={`${value}-${index}`} data-testid="heatmap-scale-tick">
                {formatHeatmapFigureNumber(value)}
              </span>
            ))}
          </div>
          <span className="heatmap-scale-label">{text.colorBarLabel}</span>
        </div>
      </div>
      <div className="heatmap-x-axis" aria-label="Grid X axis">
        <span className="heatmap-axis-title">Grid X</span>
        {xTicks.map((value, index) => (
          <span key={`${value}-${index}`} data-testid="heatmap-x-tick">{value}</span>
        ))}
      </div>
    </figure>
  );
}

export function gridLines(heatmap) {
  const verticalPositions = uniqueSortedPositions(
    heatmap.cells.map((cell) => cell.x),
    heatmap.width,
  );
  const horizontalPositions = uniqueSortedPositions(
    heatmap.cells.map((cell) => cell.y),
    heatmap.height,
  );

  return [
    ...verticalPositions.map((position) => ({
      key: `vertical-${position}`,
      attributes: {
        x1: percentage(position, heatmap.width),
        x2: percentage(position, heatmap.width),
        y1: "0%",
        y2: "100%",
      },
    })),
    ...horizontalPositions.map((position) => ({
      key: `horizontal-${position}`,
      attributes: {
        x1: "0%",
        x2: "100%",
        y1: percentage(position, heatmap.height),
        y2: percentage(position, heatmap.height),
      },
    })),
  ];
}

function uniqueSortedPositions(positions, edge) {
  return [...new Set([...positions, edge])].sort((left, right) => left - right);
}

function percentage(position, total) {
  return `${(position / total) * 100}%`;
}
