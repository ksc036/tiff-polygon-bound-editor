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
  const displayRange = heatmapDisplayRange(props.metric);
  const metricUnit = displayRange.unit || (props.metric === "pixel-density" ? "ratio" : "mg/ml");
  const range = props.comparison
    ? { min: -props.comparison.maxAbs, max: props.comparison.maxAbs, unit: metricUnit }
    : { ...displayRange, unit: metricUnit };
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
        <div className="heatmap-report-main">
          <div className="heatmap-y-axis" aria-label="Grid Y axis">
            <span className="heatmap-axis-title">Grid Y</span>
            <div className="heatmap-y-axis-ticks">
              {yTicks.map((value, index) => (
                <span
                  key={`${value}-${index}`}
                  data-testid="heatmap-y-tick"
                  style={{ top: tickPosition(index, yTicks.length) }}
                >
                  {value}
                </span>
              ))}
            </div>
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
          </div>
        </div>
        <div className="heatmap-color-scale">
          <span className="heatmap-scale-title">Scale</span>
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
        <div className="heatmap-x-axis-main">
          <span className="heatmap-axis-title">Grid X</span>
          <div className="heatmap-x-axis-ticks">
            {xTicks.map((value, index) => (
              <span
                key={`${value}-${index}`}
                data-testid="heatmap-x-tick"
                style={{ left: tickPosition(index, xTicks.length) }}
              >
                {value}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

function tickPosition(index, count) {
  return `${(index / (count - 1)) * 100}%`;
}
