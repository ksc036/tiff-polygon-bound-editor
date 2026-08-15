import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import {
  closestThreshold,
  createProbabilityOverlayPng,
  parseProbabilityNpy,
  probabilityMetrics,
  writeThresholdMaskPng,
} from "./probabilityMap.js";

const tempRoots = [];

function npyFixture({ width, height, values, version = [1, 0], descr = "<f4", fortranOrder = false }) {
  const shape = `(${height}, ${width})`;
  const header = `{'descr': '${descr}', 'fortran_order': ${fortranOrder ? "True" : "False"}, 'shape': ${shape}, }`;
  const alignment = version[0] === 1 ? 16 : 64;
  const headerLengthBytes = version[0] === 1 ? 2 : 4;
  const prefixLength = 6 + 2 + headerLengthBytes;
  const padding = (alignment - ((prefixLength + header.length + 1) % alignment)) % alignment;
  const encodedHeader = Buffer.from(`${header}${" ".repeat(padding)}\n`, "ascii");
  const prefix = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, version[0], version[1]]);
  const length = Buffer.alloc(headerLengthBytes);
  if (version[0] === 1) length.writeUInt16LE(encodedHeader.length);
  else length.writeUInt32LE(encodedHeader.length);
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeFloatLE(value, index * 4));
  return Buffer.concat([prefix, length, encodedHeader, data]);
}

function fixtureMap() {
  return {
    width: 3,
    height: 2,
    data: new Float32Array([0, 0.5, 1, 0.25, 0.25, 1]),
  };
}

function square(x, y, width, height) {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height + 1 },
    { x, y: y + height + 1 },
  ];
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseProbabilityNpy", () => {
  test("parses a C-order float32 NPY map and preserves normalized values", () => {
    const parsed = parseProbabilityNpy(
      npyFixture({ width: 3, height: 2, values: [0, 0.5, 1, 0.25, 0.75, 1] }),
    );
    expect(parsed).toMatchObject({ width: 3, height: 2 });
    expect([...parsed.data]).toEqual([0, 0.5, 1, 0.25, 0.75, 1]);
  });

  test("parses the NumPy v2 header-length variant", () => {
    const parsed = parseProbabilityNpy(npyFixture({ width: 1, height: 1, values: [0.75], version: [2, 0] }));
    expect([...parsed.data]).toEqual([0.75]);
  });

  test.each([
    ["non-float32", { descr: "<f8" }],
    ["Fortran-order", { fortranOrder: true }],
    ["non-finite", { values: [Number.NaN] }],
    ["out-of-range", { values: [1.01] }],
  ])("rejects %s probability maps", (_label, overrides) => {
    expect(() => parseProbabilityNpy(npyFixture({ width: 1, height: 1, values: [0.5], ...overrides }))).toThrow(
      "INVALID_PROBABILITY_MAP",
    );
  });
});

describe("probability map computations", () => {
  test("counts only probabilities at or above the threshold in a polygon", () => {
    const metrics = probabilityMetrics({ probabilityMap: fixtureMap(), threshold: 0.5, polygon: square(1, 0, 2, 1) });
    expect(metrics).toEqual({ pixelCount: 3, areaPx: 4, areaFraction: 0.75 });
  });

  test("chooses the lower 0.001-grid threshold when errors are tied", () => {
    expect(closestThreshold({ probabilityMap: fixtureMap(), targetFraction: 0.5 })).toMatchObject({ threshold: 0.5 });
  });
});

describe("probability PNG output", () => {
  test("writes a 255/0 PNG mask without changing dimensions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "probability-map-"));
    tempRoots.push(root);
    const outputPath = path.join(root, "mask.png");
    await writeThresholdMaskPng(outputPath, { probabilityMap: fixtureMap(), threshold: 0.5 });
    const { data, info } = await sharp(outputPath).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 3, height: 2, channels: 1 });
    expect([...data]).toEqual([0, 255, 255, 0, 0, 255]);
  });

  test("renders threshold foreground as red with transparent background", async () => {
    const png = await createProbabilityOverlayPng({ probabilityMap: fixtureMap(), threshold: 0.5 });
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 3, height: 2, channels: 4 });
    expect([...data]).toEqual([
      0, 0, 0, 0,
      255, 0, 0, 255,
      255, 0, 0, 255,
      0, 0, 0, 0,
      0, 0, 0, 0,
      255, 0, 0, 255,
    ]);
  });
});
