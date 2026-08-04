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

  test("renders axes outside the heatmap without drawing a grid over the image", () => {
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

    expect(screen.getByText("Current: scan-a")).toBeInTheDocument();
    expect(screen.getByText("Pixel Density | Cell 5x5 px | Grid 2x1")).toBeInTheDocument();
    expect(screen.getByText("Grid X")).toBeInTheDocument();
    expect(screen.getByText("Grid Y")).toBeInTheDocument();
    expect(screen.getAllByTestId("heatmap-x-tick")).toHaveLength(5);
    expect(screen.getAllByTestId("heatmap-y-tick")).toHaveLength(5);
    expect(screen.getAllByTestId("heatmap-scale-tick")).toHaveLength(5);
    expect(screen.queryByLabelText("heatmap cell grid")).not.toBeInTheDocument();
    expect(screen.getByLabelText("heatmap original image")).toHaveStyle({ opacity: "0.5" });
    expect(screen.getByRole("status")).toHaveTextContent("Row 1, Column 1");
  });

  test("positions five axis ticks at the four plot intervals", () => {
    renderAbsoluteReport();

    const plot = screen.getByLabelText("heatmap report plot");
    const yAxis = screen.getByLabelText("Grid Y axis");
    const xTick = screen.getAllByTestId("heatmap-x-tick")[0];
    expect(plot.parentElement).toBe(yAxis.parentElement);
    expect(plot.parentElement).toHaveClass("heatmap-report-main");
    expect(xTick.closest(".heatmap-x-axis-main")).toBeInTheDocument();
    expect(screen.getAllByTestId("heatmap-x-tick").map((tick) => tick.style.left)).toEqual([
      "0%",
      "25%",
      "50%",
      "75%",
      "100%",
    ]);
    expect(screen.getAllByTestId("heatmap-y-tick").map((tick) => tick.style.top)).toEqual([
      "0%",
      "25%",
      "50%",
      "75%",
      "100%",
    ]);
  });

  test("matches the export pixel-density unit and visible scale wording", () => {
    renderAbsoluteReport();

    expect(screen.getByText("Color range: 0 to 1 ratio")).toBeInTheDocument();
    expect(screen.getByText("Scale")).toBeInTheDocument();
    expect(screen.getByLabelText("Pixel Density (ratio)")).toHaveClass("absolute");
  });

  test("renders a signed difference scale and both image labels for comparisons", () => {
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

    expect(screen.getByText("Current: scan-a")).toBeInTheDocument();
    expect(screen.getByText("Previous: scan-previous")).toBeInTheDocument();
    expect(screen.getByText("Color range: -0.1 to +0.1 ratio")).toBeInTheDocument();
    expect(screen.getByText("Scale")).toBeInTheDocument();
    expect(screen.getByLabelText("Delta Pixel Density")).toHaveClass("difference");
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
