import { describe, expect, test } from "vitest";
import {
  COLLAGEN_DENSITY_MODELS, COLLAGEN_DENSITY_MODEL,
  getCollagenDensityModel, collagenDensityResult, calibrationMetadata,
  collagenDensityModelText, collagenDensityInverseText, estimateCollagenDensity,
  isCollagenDensityColorMax, pixelDensityFromCollagenDensity,
} from "./collagenDensity.js";

describe("collagen density calibration", () => {
  test("defines exactly the approved High and Low curves, with High as default", () => {
    expect(COLLAGEN_DENSITY_MODELS).toHaveLength(2);
    expect(COLLAGEN_DENSITY_MODEL).toMatchObject({ id: "high-density", amplitude: -0.2431, plateau: 0.2631, k: 0.2662 });
    expect(getCollagenDensityModel("low-density")).toMatchObject({ amplitude: -0.1070, plateau: 0.1087, k: 1.630 });
    expect(() => getCollagenDensityModel("unknown")).toThrow();
    expect(Object.isFrozen(COLLAGEN_DENSITY_MODELS)).toBe(true);
  });
  test.each(["high-density", "low-density"])("round-trips %s without clipping finite estimates to Max", (id) => {
    const model = getCollagenDensityModel(id);
    for (const x of [0, 0.5, 1, 2, 3, 8, 10, 12]) {
      const af = pixelDensityFromCollagenDensity(x, model);
      expect(estimateCollagenDensity(af, 3, model)).toBeCloseTo(x, 5);
    }
    const result = collagenDensityResult(pixelDensityFromCollagenDensity(12, model), model, { colorMax: 3 });
    expect(result.value).toBeCloseTo(12, 5);
    expect(result.status).toBe("color-max-exceeded");
  });
  test.each(["high-density", "low-density"])("distinguishes baseline, saturation, and no data for %s", (id) => {
    const model = getCollagenDensityModel(id);
    expect(collagenDensityResult(0, model)).toEqual({ value: 0, status: "below-baseline" });
    expect(collagenDensityResult(pixelDensityFromCollagenDensity(0, model), model).value).toBe(0);
    expect(collagenDensityResult(model.plateau, model)).toEqual({ value: null, status: "model-range-exceeded" });
    expect(collagenDensityResult(1, model).status).toBe("model-range-exceeded");
    for (const af of [null, undefined, NaN, Infinity, -0.01, 1.01]) {
      expect(collagenDensityResult(af, model)).toEqual({ value: null, status: "no-data" });
    }
    expect(collagenDensityResult(0, model, { empty: true }).status).toBe("no-data");
  });
  test("uses the selected curve in forward values, formulas and metadata", () => {
    const model = getCollagenDensityModel("low-density");
    expect(pixelDensityFromCollagenDensity(8)).toBeCloseTo(0.23419909581456913, 12);
    expect(pixelDensityFromCollagenDensity(0, model)).toBeCloseTo(0.0017, 12);
    expect(collagenDensityModelText(model)).toContain("0.1087");
    expect(collagenDensityInverseText(model)).toContain("1.63");
    expect(collagenDensityInverseText(model)).not.toContain("clamped");
    expect(calibrationMetadata({ model, revision: 5, colorMax: 3, exportedAt: "2026-10-24T00:00:00Z" })).toMatchObject({
      modelId: "low-density", revision: 5, colorMax: 3, coefficients: { amplitude: -0.107, plateau: 0.1087, k: 1.63 },
    });
  });
  test("retains supported manual color maxima", () => {
    for (const max of [0.1, 3, 8, 10]) expect(isCollagenDensityColorMax(max)).toBe(true);
    for (const max of [0, 10.1, "3", NaN]) expect(isCollagenDensityColorMax(max)).toBe(false);
  });
  test("does not misclassify exact coefficient baselines or color limits due to rounding", () => {
    expect(collagenDensityResult(0.02, "high-density")).toEqual({ value: 0, status: "below-baseline" });
    expect(collagenDensityResult(0.0017, "low-density")).toEqual({ value: 0, status: "below-baseline" });
    for (const model of COLLAGEN_DENSITY_MODELS) {
      for (const colorMax of [3, 8, 10]) {
        expect(collagenDensityResult(pixelDensityFromCollagenDensity(colorMax, model), model, { colorMax }).status).toBe("ok");
      }
    }
  });
});
