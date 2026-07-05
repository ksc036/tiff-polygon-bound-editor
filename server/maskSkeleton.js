import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const DEFAULT_MAX_IMAGE_PIXELS = 536_870_912;

function resolveMaxImagePixels(maxImagePixels) {
  if (maxImagePixels === undefined) {
    return DEFAULT_MAX_IMAGE_PIXELS;
  }

  const parsed = Number.parseInt(maxImagePixels, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_IMAGE_PIXELS;
}

function sharpInputOptions(maxImagePixels) {
  return {
    limitInputPixels: resolveMaxImagePixels(maxImagePixels),
  };
}

function assertBinaryImage({ data, width, height }) {
  if (!(data instanceof Uint8Array) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new Error("Binary image must include Uint8Array data with safe width and height.");
  }

  if (width <= 0 || height <= 0) {
    throw new Error("Binary image width and height must be positive.");
  }

  if (data.length !== width * height) {
    throw new Error("Binary image data length must match width * height.");
  }
}

export async function readBinaryMask(maskPath, { maxImagePixels } = {}) {
  const { data, info } = await sharp(maskPath, sharpInputOptions(maxImagePixels))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;
  const binary = new Uint8Array(pixelCount);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * info.channels;
    const foreground =
      info.channels === 1 || info.channels === 2
        ? data[offset] !== 0
        : data[offset] !== 0 || data[offset + 1] !== 0 || data[offset + 2] !== 0;
    binary[pixelIndex] = foreground ? 1 : 0;
  }

  return {
    data: binary,
    width: info.width,
    height: info.height,
  };
}

function foregroundNeighborCount(data, width, x, y) {
  let count = 0;

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      count += data[(y + dy) * width + x + dx];
    }
  }

  return count;
}

function transitionCount(data, width, x, y) {
  const neighbors = [
    data[(y - 1) * width + x],
    data[(y - 1) * width + x + 1],
    data[y * width + x + 1],
    data[(y + 1) * width + x + 1],
    data[(y + 1) * width + x],
    data[(y + 1) * width + x - 1],
    data[y * width + x - 1],
    data[(y - 1) * width + x - 1],
  ];
  let transitions = 0;

  for (let index = 0; index < neighbors.length; index += 1) {
    if (neighbors[index] === 0 && neighbors[(index + 1) % neighbors.length] === 1) {
      transitions += 1;
    }
  }

  return transitions;
}

function shouldRemove(data, width, x, y, step) {
  const north = data[(y - 1) * width + x];
  const east = data[y * width + x + 1];
  const south = data[(y + 1) * width + x];
  const west = data[y * width + x - 1];
  const count = foregroundNeighborCount(data, width, x, y);

  if (count < 2 || count > 6 || transitionCount(data, width, x, y) !== 1) {
    return false;
  }

  if (step === 0) {
    return north * east * south === 0 && east * south * west === 0;
  }

  return north * east * west === 0 && north * south * west === 0;
}

function connectedComponents({ data, width, height }) {
  const visited = new Uint8Array(data.length);
  const components = [];

  for (let startIndex = 0; startIndex < data.length; startIndex += 1) {
    if (!data[startIndex] || visited[startIndex]) {
      continue;
    }

    const component = [];
    const queue = [startIndex];
    visited[startIndex] = 1;

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const index = queue[queueIndex];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }

          const neighborX = x + dx;
          const neighborY = y + dy;
          if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) {
            continue;
          }

          const neighborIndex = neighborY * width + neighborX;
          if (data[neighborIndex] && !visited[neighborIndex]) {
            visited[neighborIndex] = 1;
            queue.push(neighborIndex);
          }
        }
      }
    }

    components.push(component);
  }

  return components;
}

export function thinBinaryMask({ data, width, height }) {
  assertBinaryImage({ data, width, height });
  const original = Uint8Array.from(data, (value) => (value ? 1 : 0));
  const originalComponents = connectedComponents({ data: original, width, height });
  const paddedWidth = width + 2;
  const paddedHeight = height + 2;
  const skeleton = new Uint8Array(paddedWidth * paddedHeight);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      skeleton[(y + 1) * paddedWidth + x + 1] = original[y * width + x];
    }
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (let step = 0; step < 2; step += 1) {
      const removals = [];

      for (let y = 1; y < paddedHeight - 1; y += 1) {
        for (let x = 1; x < paddedWidth - 1; x += 1) {
          const index = y * paddedWidth + x;
          if (skeleton[index] === 1 && shouldRemove(skeleton, paddedWidth, x, y, step)) {
            removals.push(index);
          }
        }
      }

      if (removals.length > 0) {
        changed = true;
      }

      for (const index of removals) {
        skeleton[index] = 0;
      }
    }
  }

  const cropped = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      cropped[y * width + x] = skeleton[(y + 1) * paddedWidth + x + 1];
    }
  }

  for (const component of originalComponents) {
    if (component.every((index) => cropped[index] === 0)) {
      cropped[component[0]] = 1;
    }
  }

  return {
    data: cropped,
    width,
    height,
  };
}

export async function writeSkeletonPng(outputPath, skeleton) {
  assertBinaryImage(skeleton);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const pixels = Uint8Array.from(skeleton.data, (value) => (value ? 255 : 0));

  await sharp(pixels, {
    raw: {
      width: skeleton.width,
      height: skeleton.height,
      channels: 1,
    },
  })
    .png()
    .toFile(outputPath);
}
