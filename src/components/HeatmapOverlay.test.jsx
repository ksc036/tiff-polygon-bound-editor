/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { estimateHeatmapCollagenDensity, infernoColor } from "../lib/heatmap.js";
import HeatmapOverlay from "./HeatmapOverlay.jsx";
import { pixelDensityFromCollagenDensity } from "../../shared/collagenDensity.js";

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
  let context;

  beforeEach(() => {
    context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      globalAlpha: 0.25,
      imageSmoothingEnabled: true,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("draws saved cells on canvas and reports current, previous, and delta values at the pointer", () => {
    render(
      <HeatmapOverlay
        heatmap={heatmap}
        metric="pixel-density"
        comparison={{
          previousValues: [0.02, 0.1],
          currentValues: [0.04, 0.2],
          values: [0.02, 0.1],
          maxAbs: 0.1,
        }}
        pointer={{ x: 1, y: 1 }}
      />,
    );

    expect(screen.getByLabelText("heatmap overlay")).toHaveAttribute("width", "10");
    expect(screen.getByLabelText("heatmap overlay")).toHaveAttribute("height", "5");
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(context.globalAlpha).toBe(1);
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(context.fillRect).toHaveBeenNthCalledWith(1, 0, 0, 5, 5);
    expect(context.fillRect).toHaveBeenNthCalledWith(2, 5, 0, 5, 5);
    expect(screen.getByRole("status")).toHaveTextContent("Mask pixels 1 / 25");
    expect(screen.getByRole("status")).toHaveTextContent("Pixel Density 0.0400");
    expect(screen.getByRole("status")).toHaveTextContent("Estimated Collagen Density 0.323 mg/mL");
    expect(screen.getByRole("status")).toHaveTextContent("Previous 0.0200, Current 0.0400, Change 0.0200");
  });

  test("does not redraw static cells for pointer-only updates", () => {
    const props = {
      heatmap,
      metric: "pixel-density",
      comparison: null,
    };
    const { rerender } = render(<HeatmapOverlay {...props} pointer={{ x: 1, y: 1 }} />);

    expect(context.fillRect).toHaveBeenCalledTimes(2);
    context.fillRect.mockClear();
    context.clearRect.mockClear();
    rerender(<HeatmapOverlay {...props} pointer={{ x: 6, y: 1 }} />);

    expect(context.clearRect).not.toHaveBeenCalled();
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Mask pixels 5 / 25");
  });

  test("draws centered edge widths and heights without shifting pointer statistics", () => {
    const starts = [0, 1, 5, 9];
    const sizes = [1, 4, 4, 1];
    const centered = { width: 10, height: 10, cellWidth: 4, cellHeight: 4,
      gridAlignment: "center", columns: 4, rows: 4,
      cells: starts.flatMap((y, row) => starts.map((x, column) => ({ row, column, x, y,
        width: sizes[column], height: sizes[row], areaPx: sizes[column] * sizes[row],
        maskPixelCount: 0, pixelDensity: 0,
      }))) };
    render(<HeatmapOverlay heatmap={centered} metric="pixel-density" pointer={{ x: 1, y: 1 }} />);
    expect(context.fillRect).toHaveBeenCalledTimes(16);
    expect(context.fillRect).toHaveBeenNthCalledWith(1, 0, 0, 1, 1);
    expect(context.fillRect).toHaveBeenNthCalledWith(6, 1, 1, 4, 4);
    expect(context.fillRect).toHaveBeenNthCalledWith(16, 9, 9, 1, 1);
    expect(screen.getByRole("status")).toHaveTextContent("Row 2, Column 2");
    expect(screen.getByRole("status")).toHaveTextContent("Mask pixels 0 / 16");
  });

  test("draws estimated collagen density cells with the fixed model", () => {
    const colors = [];
    context.fillRect.mockImplementation(() => colors.push(context.fillStyle));
    render(
      <HeatmapOverlay
        heatmap={heatmap}
        metric="estimated-collagen-density"
        comparison={null}
        pointer={null}
        collagenDensityColorMax={4}
      />,
    );

    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 10, 5);
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(colors[1]).toBe(infernoColor(estimateHeatmapCollagenDensity(0.2), 0, 4));
  });

  test("shows fixed-model estimated density at the pointer", () => {
    render(
      <HeatmapOverlay
        heatmap={heatmap}
        metric="pixel-density"
        comparison={null}
        pointer={{ x: 1, y: 1 }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Estimated Collagen Density 0.323 mg/mL");
  });

  test("uses the selected maximum for estimated-density colors and the pointer value", () => {
    const customHeatmap = {
      ...heatmap,
      cells: [{ ...heatmap.cells[0], pixelDensity: 0.5 }],
      width: 5,
      columns: 1,
    };
    const colors = [];
    context.fillRect.mockImplementation(() => colors.push(context.fillStyle));

    render(
      <HeatmapOverlay
        heatmap={customHeatmap}
        metric="estimated-collagen-density"
        comparison={null}
        pointer={{ x: 1, y: 1 }}
        collagenDensityColorMax={10}
      />,
    );

    expect(colors).toEqual([infernoColor(10, 0, 10)]);
    expect(screen.getByRole("status")).toHaveTextContent("Estimated Collagen Density Model range exceeded");
  });

  test("keeps the selected density maximum in the pointer while viewing pixel density", () => {
    const customHeatmap = {
      ...heatmap,
      cells: [{ ...heatmap.cells[0], pixelDensity: 0.5 }],
      width: 5,
      columns: 1,
    };

    render(
      <HeatmapOverlay
        heatmap={customHeatmap}
        metric="pixel-density"
        comparison={null}
        pointer={{ x: 1, y: 1 }}
        collagenDensityColorMax={10}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Estimated Collagen Density Model range exceeded");
  });

  test("changes selected-model colors while preserving uncapped finite tooltip values", () => {
    const customHeatmap = { ...heatmap, cells: [{ ...heatmap.cells[0], pixelDensity: 0.1 }], width: 5, columns: 1 };
    const colors = [];
    context.fillRect.mockImplementation(() => colors.push(context.fillStyle));
    const props = { heatmap: customHeatmap, metric: "collagen-density", pointer: { x: 1, y: 1 }, collagenDensityColorMax: 3 };
    const { rerender } = render(<HeatmapOverlay {...props} model="high-density" />);
    expect(screen.getByRole("status")).toHaveTextContent("1.499 mg/mL");
    rerender(<HeatmapOverlay {...props} model="low-density" />);
    expect(screen.getByRole("status")).toHaveTextContent("1.540 mg/mL");
    expect(colors[0]).not.toBe(colors[1]);
    rerender(<HeatmapOverlay {...props} model="high-density" heatmap={{ ...customHeatmap, cells: [{ ...customHeatmap.cells[0], pixelDensity: pixelDensityFromCollagenDensity(12) }] }} />);
    expect(colors.at(-1)).toBe(infernoColor(3, 0, 3));
    expect(screen.getByRole("status")).toHaveTextContent("12.000 mg/mL (color Max exceeded)");
  });

  test("renders unknown calibration and empty cells as neutral no data", () => {
    const props = { heatmap, metric: "collagen-density", pointer: { x: 1, y: 1 } };
    const { rerender } = render(<HeatmapOverlay {...props} model={null} />);
    expect(context.fillStyle).toBe("#80858b");
    expect(screen.getByRole("status")).toHaveTextContent("Calibration unavailable");
    rerender(<HeatmapOverlay {...props} heatmap={{ ...heatmap, cells: heatmap.cells.map((cell) => ({ ...cell, areaPx: 0 })) }} />);
    expect(context.fillStyle).toBe("#80858b");
    expect(screen.getByRole("status")).toHaveTextContent("No data");
  });
});
