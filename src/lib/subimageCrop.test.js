import { describe, expect, test } from "vitest";
import {
  createAspectLockedCrop,
  cropContainsPoint,
  cropFitsImage,
  moveCropBy,
  sameCrop,
} from "./subimageCrop.js";

describe("subimage crop geometry", () => {
  test.each([
    [{ x: 20, y: 20 }, { x: 59, y: 49 }, { x: 20, y: 20, width: 40, height: 30 }],
    [{ x: 59, y: 49 }, { x: 20, y: 20 }, { x: 20, y: 20, width: 40, height: 30 }],
    [{ x: 59, y: 20 }, { x: 20, y: 49 }, { x: 20, y: 20, width: 40, height: 30 }],
    [{ x: 20, y: 49 }, { x: 59, y: 20 }, { x: 20, y: 20, width: 40, height: 30 }],
  ])("locks a 4:3 selection in every drag quadrant", (start, current, expected) => {
    expect(createAspectLockedCrop(start, current, { width: 100, height: 75 })).toEqual({
      sourceWidth: 100,
      sourceHeight: 75,
      ...expected,
    });
  });

  test("uses the largest source-aspect rectangle inside the pointer extent", () => {
    expect(createAspectLockedCrop({ x: 0, y: 0 }, { x: 79, y: 39 }, { width: 100, height: 75 })).toEqual({
      sourceWidth: 100,
      sourceHeight: 75,
      x: 0,
      y: 0,
      width: 53,
      height: 40,
    });
  });

  test("rounds non-square source dimensions while staying inside the pointer span", () => {
    expect(createAspectLockedCrop({ x: 0, y: 0 }, { x: 6, y: 4 }, { width: 7, height: 5 })).toEqual({
      sourceWidth: 7,
      sourceHeight: 5,
      x: 0,
      y: 0,
      width: 7,
      height: 5,
    });
    expect(createAspectLockedCrop({ x: 0, y: 0 }, { x: 4, y: 3 }, { width: 7, height: 5 })).toEqual({
      sourceWidth: 7,
      sourceHeight: 5,
      x: 0,
      y: 0,
      width: 5,
      height: 4,
    });
  });

  test("returns null for invalid image sizes and points", () => {
    expect(createAspectLockedCrop({ x: 0, y: 0 }, { x: 2, y: 2 }, { width: 0, height: 10 })).toBeNull();
    expect(createAspectLockedCrop({ x: 0.5, y: 0 }, { x: 2, y: 2 }, { width: 10, height: 10 })).toBeNull();
  });

  test("moves a locked crop without resizing and clamps it inside the image", () => {
    const crop = { sourceWidth: 100, sourceHeight: 75, x: 20, y: 10, width: 40, height: 30 };
    expect(moveCropBy(crop, { x: 80, y: -40 }, { width: 100, height: 75 })).toEqual({
      ...crop,
      x: 60,
      y: 0,
    });
  });

  test("rounds movement deltas and preserves identity when movement changes nothing", () => {
    const crop = { sourceWidth: 100, sourceHeight: 75, x: 20, y: 10, width: 40, height: 30 };
    expect(moveCropBy(crop, { x: 0.4, y: -0.4 }, { width: 100, height: 75 })).toBe(crop);
    expect(moveCropBy(crop, { x: 0.6, y: 0.6 }, { width: 100, height: 75 })).toEqual({ ...crop, x: 21, y: 11 });
  });

  test("uses half-open crop bounds and ignores server metadata in dirty equality", () => {
    const crop = { sourceWidth: 100, sourceHeight: 75, x: 20, y: 10, width: 40, height: 30 };
    expect(cropContainsPoint(crop, { x: 20, y: 10 })).toBe(true);
    expect(cropContainsPoint(crop, { x: 60, y: 40 })).toBe(false);
    expect(cropFitsImage(crop, { width: 100, height: 75 })).toBe(true);
    expect(sameCrop(crop, { ...crop, updatedAt: "2026-08-04T00:00:00.000Z" })).toBe(true);
    expect(sameCrop(crop, { ...crop, x: 21 })).toBe(false);
  });

  test("rejects crops outside image bounds", () => {
    const crop = { sourceWidth: 100, sourceHeight: 75, x: 70, y: 10, width: 40, height: 30 };
    expect(cropFitsImage(crop, { width: 100, height: 75 })).toBe(false);
    expect(cropFitsImage({ ...crop, x: 60 }, { width: 100, height: 75 })).toBe(true);
  });
});
