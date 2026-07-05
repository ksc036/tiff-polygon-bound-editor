import sharp from "sharp";
import { assignOutwardRoiPixels, validateRoiBands } from "./analysisGeometry.js";
import { AnalysisError, selectMaskSource } from "./analysisService.js";
import { readBinaryMask } from "./maskSkeleton.js";

const DEFAULT_MAX_IMAGE_PIXELS = 536_870_912;
const ROI_COLORS = {
  near: [239, 68, 68, 78],
  mid: [245, 158, 11, 70],
  far: [59, 130, 246, 62],
};

function maxPixels(maxImagePixels) {
  const parsed = Number.parseInt(maxImagePixels, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_IMAGE_PIXELS;
}

function sharpInputOptions(maxImagePixels) {
  return {
    limitInputPixels: maxPixels(maxImagePixels),
  };
}

async function imageDimensions(imagePath, maxImagePixels) {
  const metadata = await sharp(imagePath, sharpInputOptions(maxImagePixels)).metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new AnalysisError("DIMENSION_MISMATCH", "Unable to resolve image dimensions.", { status: 422 });
  }

  return { width, height };
}

function overlayBounds(bounds, dimensions) {
  return {
    schemaVersion: bounds?.schemaVersion ?? 1,
    imageFolder: bounds?.imageFolder ?? null,
    imageFile: bounds?.imageFile ?? null,
    width: Number.isInteger(bounds?.width) ? bounds.width : dimensions.width,
    height: Number.isInteger(bounds?.height) ? bounds.height : dimensions.height,
    connectionMode: "input-order-cycle",
    groups: Array.isArray(bounds?.groups) ? bounds.groups : [],
  };
}

function assertOverlayDimensions(bounds, dimensions) {
  if (bounds.width !== dimensions.width || bounds.height !== dimensions.height) {
    throw new AnalysisError("DIMENSION_MISMATCH", "Bounds dimensions do not match image dimensions.", { status: 422 });
  }
}

async function pngFromGreyMask(mask) {
  const pixels = Uint8Array.from(mask.data, (value) => (value ? 255 : 0));

  return sharp(pixels, {
    raw: {
      width: mask.width,
      height: mask.height,
      channels: 1,
    },
  })
    .png()
    .toBuffer();
}

async function pngFromRgba({ data, width, height }) {
  return sharp(data, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

export async function createMaskPreview(storage, id, { maxImagePixels } = {}) {
  const image = storage.getImage(id);
  const paths = storage.imagePaths(id);
  const maskSource = await selectMaskSource(image, paths.maskDir);

  if (!maskSource) {
    throw new AnalysisError("MISSING_MASK", "Mask image is required before analysis.", { status: 409 });
  }

  let mask;
  try {
    mask = await readBinaryMask(maskSource.path, { maxImagePixels });
  } catch (error) {
    throw new AnalysisError("UNREADABLE_MASK", "Unable to read mask image.", { status: 422, cause: error });
  }

  return {
    buffer: await pngFromGreyMask(mask),
    width: mask.width,
    height: mask.height,
    maskFile: maskSource.file,
  };
}

export async function createRoiOverlay(storage, id, { bounds, roiBands, maxImagePixels } = {}) {
  const paths = storage.imagePaths(id);
  const dimensions = await imageDimensions(paths.imagePath, maxImagePixels);
  const nextBounds = overlayBounds(bounds ?? (await storage.loadBounds(id)), dimensions);
  assertOverlayDimensions(nextBounds, dimensions);

  let assignments;
  try {
    assignments = assignOutwardRoiPixels({
      width: nextBounds.width,
      height: nextBounds.height,
      groups: nextBounds.groups,
      roiBands: validateRoiBands(roiBands),
    });
  } catch (error) {
    throw new AnalysisError("CALCULATION_FAILED", "Unable to calculate ROI overlay.", { status: 422, cause: error });
  }

  const data = new Uint8Array(nextBounds.width * nextBounds.height * 4);
  for (const [key, assignment] of assignments) {
    const [x, y] = key.split(",").map(Number);
    const color = ROI_COLORS[assignment.bandId];
    if (!color) continue;

    const offset = (y * nextBounds.width + x) * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = color[3];
  }

  return {
    buffer: await pngFromRgba({ data, width: nextBounds.width, height: nextBounds.height }),
    width: nextBounds.width,
    height: nextBounds.height,
  };
}
