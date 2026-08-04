/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import HeatmapReport, { gridLines } from "./HeatmapReport.jsx";

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

  test("renders the absolute heatmap figure with axes, grid, TIFF overlay, and hover status", () => {
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
    expect(screen.getByLabelText("heatmap cell grid")).toBeInTheDocument();
    expect(screen.getByLabelText("heatmap original image")).toHaveStyle({ opacity: "0.5" });
    expect(screen.getByRole("status")).toHaveTextContent("Row 1, Column 1");
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
    expect(screen.getByText("Color range: -0.1 to +0.1")).toBeInTheDocument();
    expect(screen.getByLabelText("Delta Pixel Density")).toHaveClass("difference");
  });
});

test("gridLines uses image-space positions and includes partial-cell image edges", () => {
  const lines = gridLines({
    width: 10,
    height: 5,
    cells: [
      { x: 0, y: 0, width: 4, height: 5 },
      { x: 4, y: 0, width: 6, height: 5 },
    ],
  });

  expect(lines).toEqual([
    { key: "vertical-0", attributes: { x1: "0%", x2: "0%", y1: "0%", y2: "100%" } },
    { key: "vertical-4", attributes: { x1: "40%", x2: "40%", y1: "0%", y2: "100%" } },
    { key: "vertical-10", attributes: { x1: "100%", x2: "100%", y1: "0%", y2: "100%" } },
    { key: "horizontal-0", attributes: { x1: "0%", x2: "100%", y1: "0%", y2: "0%" } },
    { key: "horizontal-5", attributes: { x1: "0%", x2: "100%", y1: "100%", y2: "100%" } },
  ]);
});
