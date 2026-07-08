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

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}
