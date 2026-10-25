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
  test("defaults to the approved High density correlation curve", () => {
    expect(pixelDensityFromCollagenDensity(0)).toBeCloseTo(0.02, 10);
    expect(pixelDensityFromCollagenDensity(1)).toBeCloseTo(0.07681590864870272, 10);
    expect(pixelDensityFromCollagenDensity(2)).toBeCloseTo(0.12035313578536214, 10);
    expect(pixelDensityFromCollagenDensity(3)).toBeCloseTo(0.15371509710624914, 10);
    expect(pixelDensityFromCollagenDensity(8)).toBeCloseTo(0.23419909581456913, 10);
    expect(pixelDensityFromCollagenDensity(10)).toBeCloseTo(0.24612956213312234, 10);
  });

  test("reports the provided curve in exported model metadata", () => {
    expect(collagenDensityModelText()).toBe(
      "Area Fraction = 0.2631 - 0.2431 * exp(-0.2662 * Collagen Density)",
    );
  });

  test("inverts the fixed one-phase association curve", () => {
    expect(estimateCollagenDensity(0.07681590864870272)).toBeCloseTo(1, 10);
    expect(estimateCollagenDensity(0.12035313578536214)).toBeCloseTo(2, 10);
    expect(estimateCollagenDensity(0.02)).toBeCloseTo(0, 10);
  });

  test("does not invent finite concentrations outside the model range", () => {
    const { plateau } = COLLAGEN_DENSITY_MODEL;
    const y0 = pixelDensityFromCollagenDensity(0);
    expect(estimateCollagenDensity(plateau)).toBeNull();
    expect(estimateCollagenDensity(plateau + 0.01)).toBeNull();
    expect(estimateCollagenDensity(y0)).toBe(0);
    expect(estimateCollagenDensity(y0 - 0.01)).toBe(0);
  });

  test("preserves actual finite concentrations independently of the color maximum", () => {
    const pixelDensityAtTen = pixelDensityFromCollagenDensity(10);

    expect(estimateCollagenDensity(pixelDensityAtTen)).toBeCloseTo(10, 10);
    expect(estimateCollagenDensity(pixelDensityAtTen, 10)).toBeCloseTo(10, 10);
    expect(estimateCollagenDensity(0.8, 10)).toBeNull();
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
