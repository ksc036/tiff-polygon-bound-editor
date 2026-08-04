export function fitAspectToBox({ boxWidth, boxHeight, aspectRatio }) {
  if (!isPositiveFinite(boxWidth) || !isPositiveFinite(boxHeight) || !isPositiveFinite(aspectRatio)) {
    return null;
  }

  const boxAspect = boxWidth / boxHeight;
  if (boxAspect > aspectRatio) {
    return {
      width: Math.round(boxHeight * aspectRatio),
      height: Math.round(boxHeight),
    };
  }

  return {
    width: Math.round(boxWidth),
    height: Math.round(boxWidth / aspectRatio),
  };
}

export function heatmapReportAspect({ columns, rows, imageAspect }) {
  if (!isPositiveFinite(columns) || !isPositiveFinite(rows) || !isPositiveFinite(imageAspect)) {
    return null;
  }

  const headerHeight = 160;
  const leftAxisWidth = 70;
  const rightScaleWidth = 190;
  const bottomAxisHeight = 72;
  const plotHeight = Math.min(rows * 12, 1200);
  const plotWidth = plotHeight * imageAspect;

  return (leftAxisWidth + plotWidth + rightScaleWidth) / (headerHeight + plotHeight + bottomAxisHeight);
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}
