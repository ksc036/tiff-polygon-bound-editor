/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import HeatmapOverlay from "./HeatmapOverlay.jsx";

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

describe("HeatmapOverlay", () => {
  afterEach(cleanup);

  test("renders saved cells and reports current, previous, and delta values at the pointer", () => {
    const { container } = render(
      <HeatmapOverlay
        heatmap={heatmap}
        metric="pixel-density"
        calibration={{ slope: 0.1, intercept: 0.01 }}
        comparison={{
          previousValues: [0.02, 0.1],
          currentValues: [0.04, 0.2],
          values: [0.02, 0.1],
          maxAbs: 0.1,
        }}
        opacity={0.62}
        pointer={{ x: 1, y: 1 }}
      />,
    );

    expect(screen.getByLabelText("heatmap overlay")).toHaveAttribute("viewBox", "0 0 10 5");
    expect(container.querySelectorAll("rect")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("Mask pixels 1 / 25");
    expect(screen.getByRole("status")).toHaveTextContent("Pixel Density 0.0400");
    expect(screen.getByRole("status")).toHaveTextContent("Estimated Collagen Density 0.3000 mg/ml");
    expect(screen.getByRole("status")).toHaveTextContent("Previous 0.0200, Current 0.0400, Change 0.0200");
  });

  test("shows unavailable estimated density when calibration is invalid", () => {
    render(
      <HeatmapOverlay
        heatmap={heatmap}
        metric="pixel-density"
        calibration={{ slope: "", intercept: 0.01 }}
        comparison={null}
        opacity={0.62}
        pointer={{ x: 1, y: 1 }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Estimated Collagen Density Unavailable");
  });
});
