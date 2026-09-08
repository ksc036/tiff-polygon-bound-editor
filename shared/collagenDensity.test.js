import { describe, expect, test } from "vitest";
import {
  COLLAGEN_DENSITY_COLOR_MAX_MIN,
  COLLAGEN_DENSITY_MODEL,
  collagenDensityModelText,
  estimateCollagenDensity,
  isCollagenDensityColorMax,
  pixelDensityFromCollagenDensity,
} from "./collagenDensity.js";

describe("collagen density model", () => {
  test("matches the provided area-fraction concentration curve", () => {
    expect(pixelDensityFromCollagenDensity(0)).toBeCloseTo(0.0569, 10);
    expect(pixelDensityFromCollagenDensity(1)).toBeCloseTo(0.08729294514093588, 10);
    expect(pixelDensityFromCollagenDensity(2)).toBeCloseTo(0.11523437458564056, 10);
    expect(pixelDensityFromCollagenDensity(3)).toBeCloseTo(0.14092202926316838, 10);
  });

  test("reports the provided curve in exported model metadata", () => {
    expect(collagenDensityModelText()).toBe(
      "Pixel Density = -0.3768 * exp(-0.0841 * Collagen Density) + 0.4337",
    );
  });

  test("inverts the fixed one-phase association curve", () => {
    expect(estimateCollagenDensity(0.08729294514093588)).toBeCloseTo(1, 10);
    expect(estimateCollagenDensity(0.11523437458564056)).toBeCloseTo(2, 10);
    expect(estimateCollagenDensity(0.0569)).toBeCloseTo(0, 10);
  });

  test("saturates pixel densities outside the displayed model range", () => {
    const { plateau, y0 } = COLLAGEN_DENSITY_MODEL;
    expect(estimateCollagenDensity(plateau)).toBe(8);
    expect(estimateCollagenDensity(plateau + 0.01)).toBe(8);
    expect(estimateCollagenDensity(y0 - 0.01)).toBe(0);
  });

  test("uses a requested calculation maximum while keeping 8 as the default", () => {
    const pixelDensityAtTen = pixelDensityFromCollagenDensity(10);

    expect(estimateCollagenDensity(pixelDensityAtTen)).toBe(8);
    expect(estimateCollagenDensity(pixelDensityAtTen, 10)).toBeCloseTo(10, 10);
    expect(estimateCollagenDensity(0.8, 10)).toBe(10);
  });

  test("accepts only supported color-scale maxima", () => {
    expect(COLLAGEN_DENSITY_COLOR_MAX_MIN).toBe(0.1);
    expect(isCollagenDensityColorMax(0.1)).toBe(true);
    expect(isCollagenDensityColorMax(4)).toBe(true);
    expect(isCollagenDensityColorMax(8)).toBe(true);
    expect(isCollagenDensityColorMax(10)).toBe(true);
    expect(isCollagenDensityColorMax(0)).toBe(false);
    expect(isCollagenDensityColorMax(10.1)).toBe(false);
    expect(isCollagenDensityColorMax("4")).toBe(false);
  });
});
