/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import HeatmapReport from "./HeatmapReport.jsx";

const heatmap = {
  width: 10,
  height: 5,
  cellWidth: 5,
  cellHeight: 5,
  rows: 1,
  columns: 2,
  cells: [
    { row: 0, column: 0, x: 0, y: 0, width: 5, height: 5, areaPx: 25, maskPixelCount: 1, pixelDensity: 0.04 },
    { row: 0, column: 1, x: 5, y: 0, width: 5, height: 5, areaPx: 25, maskPixelCount: 5, pixelDensity: 0.2 },
  ],
};

describe("HeatmapReport", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      globalAlpha: 1,
      imageSmoothingEnabled: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("renders only the bordered heatmap box and its tooltip", () => {
    render(
      <HeatmapReport
        heatmap={heatmap}
        metric="pixel-density"
        calibration={{ slope: 0.1, intercept: 0.01 }}
        comparison={null}
        pointer={{ x: 1, y: 1 }}
        currentImageName="scan-a"
        previousImageName={null}
        originalCanvasRef={{ current: null }}
        originalOpacity={0.5}
      />,
    );

    const report = screen.getByLabelText("heatmap report");
    expect(screen.getByLabelText("heatmap report plot")).toBeInTheDocument();
    expect(screen.queryByLabelText("Grid X axis")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Grid Y axis")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("heatmap-x-tick")).toHaveLength(0);
    expect(screen.queryAllByTestId("heatmap-y-tick")).toHaveLength(0);
    expect(screen.queryAllByTestId("heatmap-scale-tick")).toHaveLength(0);
    expect(report.querySelector(".heatmap-report-header")).not.toBeInTheDocument();
    expect(report.querySelector(".heatmap-report-scale-footer")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("heatmap cell grid")).not.toBeInTheDocument();
    expect(screen.getByLabelText("heatmap original image")).toHaveStyle({ opacity: "0.5" });
    expect(screen.getByRole("status")).toHaveTextContent("Row 1, Column 1");
  });

  test("uses the heatmap dimensions for the box aspect ratio", () => {
    renderAbsoluteReport();

    const plot = screen.getByLabelText("heatmap report plot");
    expect(plot).toHaveStyle({ aspectRatio: "10 / 5" });
    expect(plot.parentElement).toHaveClass("heatmap-report");
  });

  test("does not render a pixel-density scale", () => {
    renderAbsoluteReport();

    expect(screen.queryByLabelText("Pixel Density (ratio)")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("heatmap-scale-tick")).toHaveLength(0);
  });

  test("does not render a scale for comparisons", () => {
    render(
      <HeatmapReport
        heatmap={heatmap}
        metric="pixel-density"
        calibration={{ slope: 0.1, intercept: 0.01 }}
        comparison={{
          previousValues: [0.02, 0.1],
          currentValues: [0.04, 0.2],
          values: [0.02, 0.1],
          maxAbs: 0.1,
        }}
        pointer={null}
        currentImageName="scan-a"
        previousImageName="scan-previous"
        originalCanvasRef={{ current: null }}
        originalOpacity={0.5}
      />,
    );

    expect(screen.queryByLabelText("Delta Pixel Density")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("heatmap-scale-tick")).toHaveLength(0);
    expect(screen.getByLabelText("heatmap overlay")).toBeInTheDocument();
  });
});

function renderAbsoluteReport() {
  render(
    <HeatmapReport
      heatmap={heatmap}
      metric="pixel-density"
      calibration={{ slope: 0.1, intercept: 0.01 }}
      comparison={null}
      pointer={null}
      currentImageName="scan-a"
      previousImageName={null}
      originalCanvasRef={{ current: null }}
      originalOpacity={0.5}
    />,
  );
}
