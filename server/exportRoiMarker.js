const OUTER_COLOR = "#000000";
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

  const innerWidth = Math.max(1, Math.min(10, Math.round(Math.min(width, height) / 160)));
  const outerWidth = innerWidth + Math.max(2, Math.round(innerWidth * 0.75));
  const markup = cropWidth === 1 || cropHeight === 1
    ? `<rect x="${x}" y="${y}" width="${cropWidth}" height="${cropHeight}" fill="${INNER_COLOR}"/>`
    : (() => {
        const left = x + 0.5;
        const top = y + 0.5;
        const right = x + cropWidth - 0.5;
        const bottom = y + cropHeight - 0.5;
        const path = `M ${left} ${top} H ${right} V ${bottom} H ${left} Z`;
        return [
          `<path d="${path}" fill="none" stroke="${OUTER_COLOR}" stroke-width="${outerWidth}" shape-rendering="crispEdges"/>`,
          `<path d="${path}" fill="none" stroke="${INNER_COLOR}" stroke-width="${innerWidth}" shape-rendering="crispEdges"/>`,
        ].join("\n  ");
      })();

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${markup}
</svg>`);
}
