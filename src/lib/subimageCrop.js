function validImageSize(imageSize) {
  return (
    imageSize != null &&
    Number.isInteger(imageSize.width) &&
    imageSize.width > 0 &&
    Number.isInteger(imageSize.height) &&
    imageSize.height > 0
  );
}

function validPoint(point) {
  return point != null && Number.isInteger(point.x) && Number.isInteger(point.y);
}

function validDelta(delta) {
  return delta != null && Number.isFinite(delta.x) && Number.isFinite(delta.y);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function validCrop(crop) {
  return (
    crop != null &&
    Number.isInteger(crop.sourceWidth) &&
    crop.sourceWidth > 0 &&
    Number.isInteger(crop.sourceHeight) &&
    crop.sourceHeight > 0 &&
    Number.isInteger(crop.x) &&
    Number.isInteger(crop.y) &&
    Number.isInteger(crop.width) &&
    crop.width > 0 &&
    Number.isInteger(crop.height) &&
    crop.height > 0
  );
}

export function createAspectLockedCrop(start, current, imageSize) {
  if (!validImageSize(imageSize) || !validPoint(start) || !validPoint(current)) return null;

  const directionX = current.x >= start.x ? 1 : -1;
  const directionY = current.y >= start.y ? 1 : -1;
  const spanWidth = Math.abs(current.x - start.x) + 1;
  const spanHeight = Math.abs(current.y - start.y) + 1;
  const scale = Math.min(spanWidth / imageSize.width, spanHeight / imageSize.height);
  if (!(scale > 0)) return null;

  let width = Math.max(1, Math.floor(imageSize.width * scale));
  let height = Math.max(1, Math.round((width * imageSize.height) / imageSize.width));
  while (height > spanHeight && width > 1) {
    width -= 1;
    height = Math.max(1, Math.round((width * imageSize.height) / imageSize.width));
  }
  if (width > spanWidth || height > spanHeight) return null;

  const x = directionX > 0 ? start.x : start.x - width + 1;
  const y = directionY > 0 ? start.y : start.y - height + 1;
  return {
    sourceWidth: imageSize.width,
    sourceHeight: imageSize.height,
    x: clamp(x, 0, imageSize.width - width),
    y: clamp(y, 0, imageSize.height - height),
    width,
    height,
  };
}

export function moveCropBy(crop, delta, imageSize) {
  if (!validCrop(crop) || !validDelta(delta) || !validImageSize(imageSize)) return crop;

  const nextX = clamp(Math.round(crop.x + delta.x), 0, crop.sourceWidth - crop.width);
  const nextY = clamp(Math.round(crop.y + delta.y), 0, crop.sourceHeight - crop.height);
  if (nextX === crop.x && nextY === crop.y) return crop;
  return { ...crop, x: nextX, y: nextY };
}

export function cropContainsPoint(crop, point) {
  return (
    validCrop(crop) &&
    validPoint(point) &&
    point.x >= crop.x &&
    point.x < crop.x + crop.width &&
    point.y >= crop.y &&
    point.y < crop.y + crop.height
  );
}

export function cropFitsImage(crop, imageSize) {
  return (
    validCrop(crop) &&
    validImageSize(imageSize) &&
    crop.sourceWidth === imageSize.width &&
    crop.sourceHeight === imageSize.height &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.x + crop.width <= imageSize.width &&
    crop.y + crop.height <= imageSize.height
  );
}

export function sameCrop(left, right) {
  return (
    validCrop(left) &&
    validCrop(right) &&
    left.sourceWidth === right.sourceWidth &&
    left.sourceHeight === right.sourceHeight &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
