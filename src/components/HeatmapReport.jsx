import React from "react";
import HeatmapOverlay from "./HeatmapOverlay.jsx";

export default function HeatmapReport(props) {
  return (
    <figure className="heatmap-report" aria-label="heatmap report">
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
          comparison={props.comparison}
          pointer={props.pointer}
          collagenDensityColorMax={props.collagenDensityColorMax}
        />
        <canvas
          ref={props.originalCanvasRef}
          className="raw-canvas heatmap-original-overlay"
          aria-label="heatmap original image"
          style={{ opacity: props.originalOpacity }}
        />
      </div>
    </figure>
  );
}
