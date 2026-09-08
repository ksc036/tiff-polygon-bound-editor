import fs from "node:fs/promises";
import sharp from "sharp";
import { sharpPath } from "./sharpPath.js";

export const DEFAULT_MAX_IMAGE_PIXELS = 536_870_912;

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function resolveMaxImagePixels(maxImagePixels = process.env.MAX_IMAGE_PIXELS) {
  return positiveInteger(maxImagePixels, DEFAULT_MAX_IMAGE_PIXELS);
}

function sharpInputOptions(maxImagePixels) {
  return {
    limitInputPixels: resolveMaxImagePixels(maxImagePixels),
  };
}

function findDisplayRange(pixels) {
  let min = 65535;
  let max = 0;

  for (const value of pixels) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }

  return { min, max };
}

function readTiffUInt16(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function readTiffUInt32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

async function readFileRange(fileHandle, offset, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fileHandle.read(buffer, 0, length, offset);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

function parseImageJDisplayRange(description) {
  if (!description) {
    return null;
  }

  const minMatch = description.match(/(?:^|\n)\s*min\s*=\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/);
  const maxMatch = description.match(/(?:^|\n)\s*max\s*=\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/);
  const min = Number(minMatch?.[1]);
  const max = Number(maxMatch?.[1]);

  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }

  return { min, max };
}

async function readImageDescriptionFromClassicTiff(fileHandle, firstIfdOffset, littleEndian) {
  if (!Number.isSafeInteger(firstIfdOffset) || firstIfdOffset < 8) {
    return null;
  }

  const countBuffer = await readFileRange(fileHandle, firstIfdOffset, 2);
  if (countBuffer.length < 2) {
    return null;
  }

  const entryCount = readTiffUInt16(countBuffer, 0, littleEndian);
  if (entryCount <= 0 || entryCount > 4096) {
    return null;
  }

  const entries = await readFileRange(fileHandle, firstIfdOffset + 2, entryCount * 12);
  for (let entryOffset = 0; entryOffset + 12 <= entries.length; entryOffset += 12) {
    const tag = readTiffUInt16(entries, entryOffset, littleEndian);
    const type = readTiffUInt16(entries, entryOffset + 2, littleEndian);
    const count = readTiffUInt32(entries, entryOffset + 4, littleEndian);

    if (tag !== 270 || type !== 2 || count <= 0 || count > 1_048_576) {
      continue;
    }

    const value =
      count <= 4
        ? entries.subarray(entryOffset + 8, entryOffset + 8 + count)
        : await readFileRange(fileHandle, readTiffUInt32(entries, entryOffset + 8, littleEndian), count);
    return value.toString("utf8").replace(/\0+$/, "");
  }

  return null;
}

async function readImageJDisplayRangeFromTiff(inputPath) {
  const fileHandle = await fs.open(inputPath, "r");

  try {
    const header = await readFileRange(fileHandle, 0, 8);
    if (header.length < 8) {
      return null;
    }

    const byteOrder = header.toString("ascii", 0, 2);
    const littleEndian = byteOrder === "II";
    if (!littleEndian && byteOrder !== "MM") {
      return null;
    }

    const magic = readTiffUInt16(header, 2, littleEndian);
    if (magic !== 42) {
      return null;
    }

    const description = await readImageDescriptionFromClassicTiff(
      fileHandle,
      readTiffUInt32(header, 4, littleEndian),
      littleEndian,
    );
    return parseImageJDisplayRange(description);
  } finally {
    await fileHandle.close();
  }
}

export async function readGrey16RawFromImage(inputPath, { maxImagePixels } = {}) {
  const image = sharp(sharpPath(inputPath), sharpInputOptions(maxImagePixels));
  const metadata = await image.metadata();
  const { data, info } = await sharp(sharpPath(inputPath), sharpInputOptions(maxImagePixels))
    .toColourspace("grey16")
    .raw({ depth: "ushort" })
    .toBuffer({ resolveWithObject: true });
  const pixels = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const imageJRange = metadata.format === "tiff" ? await readImageJDisplayRangeFromTiff(inputPath) : null;
  const { min, max } = imageJRange ?? findDisplayRange(pixels);

  return {
    buffer: data,
    width: metadata.width ?? info.width,
    height: metadata.height ?? info.height,
    min,
    max,
  };
}
