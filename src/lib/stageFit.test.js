import { describe, expect, test } from "vitest";
import { fitAspectToBox } from "./stageFit.js";

describe("fitAspectToBox", () => {
  test("uses all available width when width limits the image", () => {
    expect(fitAspectToBox({ boxWidth: 600, boxHeight: 800, aspectRatio: 4 / 3 })).toEqual({
      width: 600,
      height: 450,
    });
  });

  test("uses all available height when height limits the image", () => {
    expect(fitAspectToBox({ boxWidth: 1200, boxHeight: 600, aspectRatio: 4 / 3 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  test("returns null when dimensions are not measurable", () => {
    expect(fitAspectToBox({ boxWidth: 0, boxHeight: 600, aspectRatio: 4 / 3 })).toBeNull();
    expect(fitAspectToBox({ boxWidth: 600, boxHeight: 600, aspectRatio: 0 })).toBeNull();
  });
});
