const INNER_COLOR = "#ffea00";

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

export function createRoiMarkerSvg(canvasWidth, canvasHeight, crop) {
  const width = positiveInteger(canvasWidth, "ROI marker width");
  const height = positiveInteger(canvasHeight, "ROI marker height");
  const x = crop?.x;
  const y = crop?.y;
  const cropWidth = crop?.width;
  const cropHeight = crop?.height;
  if (![x, y, cropWidth, cropHeight].every(Number.isSafeInteger) ||
      x < 0 || y < 0 || cropWidth <= 0 || cropHeight <= 0 ||
      x + cropWidth > width || y + cropHeight > height ||
      (crop.sourceWidth !== undefined && crop.sourceWidth !== width) ||
      (crop.sourceHeight !== undefined && crop.sourceHeight !== height)) {
    throw new TypeError("ROI marker crop must fit the rendered image.");
  }

  const markup = cropWidth === 1 || cropHeight === 1
    ? `<rect x="${x}" y="${y}" width="${cropWidth}" height="${cropHeight}" fill="${INNER_COLOR}"/>`
    : (() => {
        const strokeWidth = Math.min(5, cropWidth - 1, cropHeight - 1);
        const inset = strokeWidth / 2;
        const left = x + inset;
        const top = y + inset;
        const right = x + cropWidth - inset;
        const bottom = y + cropHeight - inset;
        const path = `M ${left} ${top} H ${right} V ${bottom} H ${left} Z`;
        return `<path d="${path}" fill="none" stroke="${INNER_COLOR}" stroke-width="${strokeWidth}" stroke-dasharray="15 10" shape-rendering="crispEdges"/>`;
      })();

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${markup}
</svg>`);
}
