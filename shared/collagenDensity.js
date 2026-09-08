export const COLLAGEN_DENSITY_MODEL = Object.freeze({
  y0: 0.0569,
  amplitude: -0.3768,
  plateau: 0.4337,
  k: 0.0841,
  halfLife: 8.242,
  tau: 11.89,
});
export const COLLAGEN_DENSITY_DISPLAY_MAX = 8;
export const COLLAGEN_DENSITY_COLOR_MAX_MIN = 0.1;
export const COLLAGEN_DENSITY_COLOR_MAX_MAX = 10;

export function isCollagenDensityColorMax(value) {
  return Number.isFinite(value) &&
    value >= COLLAGEN_DENSITY_COLOR_MAX_MIN &&
    value <= COLLAGEN_DENSITY_COLOR_MAX_MAX;
}

export function pixelDensityFromCollagenDensity(collagenDensity) {
  if (!Number.isFinite(collagenDensity) || collagenDensity < 0) return null;

  const { amplitude, plateau, k } = COLLAGEN_DENSITY_MODEL;
  return amplitude * Math.exp(-k * collagenDensity) + plateau;
}

export function estimateCollagenDensity(pixelDensity, maximumDensity = COLLAGEN_DENSITY_DISPLAY_MAX) {
  if (!Number.isFinite(pixelDensity)) return null;

  const { y0, amplitude, plateau, k } = COLLAGEN_DENSITY_MODEL;
  const resolvedMaximum = isCollagenDensityColorMax(maximumDensity)
    ? maximumDensity
    : COLLAGEN_DENSITY_DISPLAY_MAX;
  const maximumPixelDensity = pixelDensityFromCollagenDensity(resolvedMaximum);
  if (pixelDensity <= y0) return 0;
  if (pixelDensity >= maximumPixelDensity) return resolvedMaximum;

  const ratio = (pixelDensity - plateau) / amplitude;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return null;

  const density = -Math.log(ratio) / k;
  return Number.isFinite(density) && density >= 0 ? density : null;
}

export function collagenDensityModelText() {
  const { amplitude, plateau, k } = COLLAGEN_DENSITY_MODEL;
  return `Pixel Density = ${amplitude} * exp(-${k} * Collagen Density) + ${plateau}`;
}

export function collagenDensityInverseText() {
  const { amplitude, plateau, k } = COLLAGEN_DENSITY_MODEL;
  return `Collagen Density = -ln((Pixel Density - ${plateau}) / ${amplitude}) / ${k}, clamped to 0-${COLLAGEN_DENSITY_DISPLAY_MAX} mg/ml`;
}
