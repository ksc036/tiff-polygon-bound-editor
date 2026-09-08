/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, expect, test } from "vitest";
import { differenceGradientCss, heatmapGradientCss } from "../lib/heatmap.js";
import HeatmapScale from "./HeatmapScale.jsx";

afterEach(cleanup);

test("exports the canonical absolute heatmap gradient", () => {
  expect(heatmapGradientCss()).toBe(
    "linear-gradient(to right, #000004 0%, #57106e 25%, #bc3754 50%, #f98e09 75%, #fcffa4 100%)",
  );
});

test("exports the canonical comparison heatmap gradient", () => {
  expect(differenceGradientCss()).toBe(
    "linear-gradient(to right, #2563eb 0%, #f8fafc 50%, #dc2626 100%)",
  );
});

test("keeps both metrics and renders a detached estimated-density scale", () => {
  render(<HeatmapScale metric="estimated-collagen-density" comparison={null} collagenDensityColorMax={4} />);
  expect(screen.getByLabelText("Heatmap scale")).toHaveTextContent("0");
  expect(screen.getByLabelText("Heatmap scale")).toHaveTextContent("4 mg/ml");
});

test("renders a symmetric comparison scale", () => {
  render(<HeatmapScale metric="pixel-density" comparison={{ maxAbs: 0.125 }} />);
  expect(screen.getByLabelText("Heatmap scale")).toHaveTextContent("-0.125");
  expect(screen.getByLabelText("Heatmap scale")).toHaveTextContent("+0.125");
});
