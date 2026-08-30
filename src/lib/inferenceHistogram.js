export const THRESHOLD_GRID = 1000;
export const HISTOGRAM_DISPLAY_BIN_COUNT = 100;
export const HISTOGRAM_BASELINE = 40;
export const HISTOGRAM_MAX_HEIGHT = 38;
export const HISTOGRAM_LOG_DENSITY_GAIN = 10000;

export function histogramDisplayBins(histogram) {
  if (!Array.isArray(histogram?.bins) || histogram.bins.length !== THRESHOLD_GRID + 1 || histogram.areaPx <= 0) {
    return null;
  }
  const displayBins = new Array(HISTOGRAM_DISPLAY_BIN_COUNT).fill(0);
  histogram.bins.forEach((count, index) => {
    const displayIndex = Math.min(
      HISTOGRAM_DISPLAY_BIN_COUNT - 1,
      Math.floor((index * HISTOGRAM_DISPLAY_BIN_COUNT) / THRESHOLD_GRID),
    );
    displayBins[displayIndex] += count;
  });
  return displayBins;
}

export function histogramDisplayHeight(count, areaPx) {
  if (!Number.isFinite(count) || !Number.isFinite(areaPx) || areaPx <= 0) return 0;
  return (Math.log1p((count / areaPx) * HISTOGRAM_LOG_DENSITY_GAIN) /
    Math.log1p(HISTOGRAM_LOG_DENSITY_GAIN)) * HISTOGRAM_MAX_HEIGHT;
}

export function histogramAreaPath(histogram) {
  const displayBins = histogramDisplayBins(histogram);
  if (!displayBins) return "";
  const binWidth = 100 / HISTOGRAM_DISPLAY_BIN_COUNT;
  let path = `M 0 ${HISTOGRAM_BASELINE}`;
  displayBins.forEach((count, index) => {
    const y = HISTOGRAM_BASELINE - histogramDisplayHeight(count, histogram.areaPx);
    path += ` L ${index * binWidth} ${y} L ${(index + 1) * binWidth} ${y}`;
  });
  return `${path} L 100 ${HISTOGRAM_BASELINE} Z`;
}
