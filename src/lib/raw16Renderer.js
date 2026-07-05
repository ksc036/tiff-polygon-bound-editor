export function renderRaw16ToCanvas(canvas, { pixels, width, height, min, max }) {
  if (!canvas || !pixels || !width || !height) {
    return false;
  }

  canvas.width = width;
  canvas.height = height;

  return renderWith2d(canvas, { pixels, width, height, min, max });
}

function renderWith2d(canvas, { pixels, width, height, min, max }) {
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) {
    return false;
  }

  let context;
  try {
    context = canvas.getContext("2d");
  } catch {
    return false;
  }

  if (!context || typeof context.createImageData !== "function") {
    return false;
  }

  const imageData = context.createImageData(width, height);
  const range = max > min ? max - min : 1;

  for (let index = 0; index < width * height; index += 1) {
    const normalized = Math.min(Math.max((pixels[index] - min) / range, 0), 1);
    const value = Math.round(normalized * 255);
    const offset = index * 4;
    imageData.data[offset] = value;
    imageData.data[offset + 1] = value;
    imageData.data[offset + 2] = value;
    imageData.data[offset + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
  return true;
}
