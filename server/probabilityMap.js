import sharp from "sharp";
import { pointInPolygon } from "./analysisGeometry.js";

const NPY_MAGIC = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
const HISTOGRAM_SIZE = 1001;

export class ProbabilityMapError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProbabilityMapError";
    this.code = code;
  }
}

export function parseProbabilityNpy(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10 || !buffer.subarray(0, 6).equals(NPY_MAGIC)) {
    throw invalidMap("Expected a NumPy .npy buffer.");
  }

  const major = buffer[6];
  const minor = buffer[7];
  const lengthBytes = major === 1 ? 2 : major === 2 ? 4 : 0;
  if (lengthBytes === 0 || minor !== 0) {
    throw invalidMap("Unsupported NumPy .npy version.");
  }

  const headerLengthOffset = 8;
  const dataOffset = headerLengthOffset + lengthBytes;
  if (buffer.length < dataOffset) {
    throw invalidMap("NumPy .npy header is undersized.");
  }

  const headerLength = lengthBytes === 2 ? buffer.readUInt16LE(headerLengthOffset) : buffer.readUInt32LE(headerLengthOffset);
  const headerEnd = dataOffset + headerLength;
  if (headerEnd > buffer.length) {
    throw invalidMap("NumPy .npy header is undersized.");
  }

  const headerText = buffer.toString("ascii", dataOffset, headerEnd);
  const header = parseHeader(headerText);
  if (header.descr !== "<f4" || header.fortran_order !== false || header.shape.length !== 2) {
    throw invalidMap("Expected C-order float32 [height, width] NPY data.");
  }

  const [height, width] = header.shape;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw invalidMap("Probability map dimensions must be positive safe integers.");
  }
  const valueCount = width * height;
  if (!Number.isSafeInteger(valueCount) || headerEnd + valueCount * 4 !== buffer.length) {
    throw invalidMap("Probability map data length does not match its dimensions.");
  }

  const view = new Float32Array(buffer.buffer, buffer.byteOffset + headerEnd, valueCount);
  validateProbabilityValues(view);
  return { width, height, data: Float32Array.from(view) };
}

export function probabilityMetrics({ probabilityMap, threshold, polygon }) {
  assertProbabilityMap(probabilityMap);
  assertThreshold(threshold);
  const { width, height, data } = probabilityMap;
  let areaPx = 0;
  let pixelCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (polygon && !pointInPolygon({ x, y }, polygon)) continue;
      areaPx += 1;
      if (data[y * width + x] >= threshold) pixelCount += 1;
    }
  }

  return { pixelCount, areaPx, areaFraction: areaPx === 0 ? 0 : pixelCount / areaPx };
}

export function closestThreshold({ probabilityMap, targetFraction, polygon }) {
  assertProbabilityMap(probabilityMap);
  if (typeof targetFraction !== "number" || !Number.isFinite(targetFraction) || targetFraction < 0 || targetFraction > 1) {
    throw new ProbabilityMapError("INVALID_TARGET_FRACTION", "Target fraction must be between 0 and 1.");
  }

  const histogram = new Uint32Array(HISTOGRAM_SIZE);
  let areaPx = 0;
  for (let y = 0; y < probabilityMap.height; y += 1) {
    for (let x = 0; x < probabilityMap.width; x += 1) {
      if (polygon && !pointInPolygon({ x, y }, polygon)) continue;
      const bin = Math.floor(probabilityMap.data[y * probabilityMap.width + x] * 1000 + 1e-9);
      histogram[bin] += 1;
      areaPx += 1;
    }
  }

  if (areaPx === 0) return { threshold: 1, areaFraction: 0 };
  let countAtOrAbove = 0;
  let bestThreshold = 0;
  let bestFraction = 0;
  let bestError = Number.POSITIVE_INFINITY;
  for (let bin = HISTOGRAM_SIZE - 1; bin >= 0; bin -= 1) {
    countAtOrAbove += histogram[bin];
    const areaFraction = countAtOrAbove / areaPx;
    const error = Math.abs(areaFraction - targetFraction);
    const threshold = bin / 1000;
    if (error < bestError - 1e-12 || (Math.abs(error - bestError) <= 1e-12 && threshold < bestThreshold)) {
      bestError = error;
      bestThreshold = threshold;
      bestFraction = areaFraction;
    }
  }
  return { threshold: bestThreshold, areaFraction: bestFraction };
}

export async function createProbabilityOverlayPng({ probabilityMap, threshold }) {
  assertProbabilityMap(probabilityMap);
  assertThreshold(threshold);
  const rgba = Buffer.alloc(probabilityMap.width * probabilityMap.height * 4);
  for (let index = 0; index < probabilityMap.data.length; index += 1) {
    if (probabilityMap.data[index] < threshold) continue;
    const offset = index * 4;
    rgba[offset] = 255;
    rgba[offset + 3] = 255;
  }
  return sharp(rgba, { raw: { width: probabilityMap.width, height: probabilityMap.height, channels: 4 } }).png().toBuffer();
}

export async function writeThresholdMaskPng(outputPath, { probabilityMap, threshold }) {
  assertProbabilityMap(probabilityMap);
  assertThreshold(threshold);
  const mask = Buffer.alloc(probabilityMap.width * probabilityMap.height);
  for (let index = 0; index < probabilityMap.data.length; index += 1) {
    mask[index] = probabilityMap.data[index] >= threshold ? 255 : 0;
  }
  await sharp(mask, { raw: { width: probabilityMap.width, height: probabilityMap.height, channels: 1 } })
    .greyscale()
    .png()
    .toFile(outputPath);
}

function parseHeader(text) {
  const descr = text.match(/'descr'\s*:\s*'([^']+)'/)?.[1];
  const fortran = text.match(/'fortran_order'\s*:\s*(True|False)/)?.[1];
  const shapeText = text.match(/'shape'\s*:\s*\(([^)]*)\)/)?.[1];
  const shape = shapeText
    ? shapeText.split(",").map((value) => Number(value.trim())).filter((value) => value !== 0 || shapeText.includes("0"))
    : [];
  if (!descr || !fortran || !shapeText || shape.some((value) => !Number.isInteger(value))) {
    throw invalidMap("Invalid NumPy .npy header.");
  }
  return { descr, fortran_order: fortran === "True", shape };
}

function assertProbabilityMap(probabilityMap) {
  if (!probabilityMap || !Number.isSafeInteger(probabilityMap.width) || !Number.isSafeInteger(probabilityMap.height) ||
      probabilityMap.width <= 0 || probabilityMap.height <= 0 || !(probabilityMap.data instanceof Float32Array) ||
      probabilityMap.data.length !== probabilityMap.width * probabilityMap.height) {
    throw new ProbabilityMapError("INVALID_PROBABILITY_MAP", "Probability map dimensions and data must match.");
  }
  validateProbabilityValues(probabilityMap.data);
}

function validateProbabilityValues(data) {
  for (const value of data) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw invalidMap("Probability values must be finite and between 0 and 1.");
  }
}

function assertThreshold(threshold) {
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new ProbabilityMapError("INVALID_THRESHOLD", "Threshold must be between 0 and 1.");
  }
}

function invalidMap(message) {
  return new ProbabilityMapError("INVALID_PROBABILITY_MAP", message);
}
