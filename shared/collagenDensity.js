export const COLLAGEN_DENSITY_MODEL = Object.freeze({
  y0: -0.005983,
  plateau: 0.4394,
  k: 0.3587,
  halfLife: 1.932,
  tau: 2.788,
});
export const COLLAGEN_DENSITY_DISPLAY_MAX = 8;

export function pixelDensityFromCollagenDensity(collagenDensity) {
  if (!Number.isFinite(collagenDensity) || collagenDensity < 0) return null;

  const { y0, plateau, k } = COLLAGEN_DENSITY_MODEL;
  return plateau + (y0 - plateau) * Math.exp(-k * collagenDensity);
}

export function estimateCollagenDensity(pixelDensity) {
  if (!Number.isFinite(pixelDensity)) return null;

  const { y0, plateau, k } = COLLAGEN_DENSITY_MODEL;
  const maximumPixelDensity = pixelDensityFromCollagenDensity(COLLAGEN_DENSITY_DISPLAY_MAX);
  if (pixelDensity <= y0) return 0;
  if (pixelDensity >= maximumPixelDensity) return COLLAGEN_DENSITY_DISPLAY_MAX;

  const ratio = (pixelDensity - plateau) / (y0 - plateau);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return null;

  const density = -Math.log(ratio) / k;
  return Number.isFinite(density) && density >= 0 ? density : null;
}

export function collagenDensityModelText() {
  const { y0, plateau, k } = COLLAGEN_DENSITY_MODEL;
  return `Pixel Density = ${plateau} + (${y0} - ${plateau}) * exp(-${k} * Collagen Density)`;
}

export function collagenDensityInverseText() {
  const { y0, plateau, k } = COLLAGEN_DENSITY_MODEL;
  return `Collagen Density = -ln((Pixel Density - ${plateau}) / (${y0} - ${plateau})) / ${k}, clamped to 0-${COLLAGEN_DENSITY_DISPLAY_MAX} mg/ml`;
}
