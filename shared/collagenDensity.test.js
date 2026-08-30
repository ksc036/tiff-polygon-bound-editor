import { describe, expect, test } from "vitest";
import {
  COLLAGEN_DENSITY_MODEL,
  estimateCollagenDensity,
  pixelDensityFromCollagenDensity,
} from "./collagenDensity.js";

describe("collagen density model", () => {
  test("inverts the fixed one-phase association curve", () => {
    const { y0 } = COLLAGEN_DENSITY_MODEL;
    const pixelDensityAtFour = pixelDensityFromCollagenDensity(4);

    expect(estimateCollagenDensity(pixelDensityAtFour)).toBeCloseTo(4, 10);
    expect(estimateCollagenDensity(y0)).toBeCloseTo(0, 10);
  });

  test("saturates pixel densities outside the displayed model range", () => {
    const { plateau, y0 } = COLLAGEN_DENSITY_MODEL;
    expect(estimateCollagenDensity(plateau)).toBe(8);
    expect(estimateCollagenDensity(plateau + 0.01)).toBe(8);
    expect(estimateCollagenDensity(y0 - 0.01)).toBe(0);
  });
});
