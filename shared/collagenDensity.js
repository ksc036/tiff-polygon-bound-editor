export const COLLAGEN_DENSITY_MODELS = Object.freeze([
  Object.freeze({ id: "high-density", label: "High density", version: 1,
    amplitude: -0.2431, plateau: 0.2631, k: 0.2662 }),
  Object.freeze({ id: "low-density", label: "Low density", version: 1,
    amplitude: -0.1070, plateau: 0.1087, k: 1.630 }),
]);
export const COLLAGEN_DENSITY_MODEL = COLLAGEN_DENSITY_MODELS[0];
export const COLLAGEN_DENSITY_DISPLAY_MAX = 8;
export const COLLAGEN_DENSITY_COLOR_MAX_MIN = 0.1;
export const COLLAGEN_DENSITY_COLOR_MAX_MAX = 10;

export function isCollagenDensityColorMax(value) {
  return Number.isFinite(value) &&
    value >= COLLAGEN_DENSITY_COLOR_MAX_MIN &&
    value <= COLLAGEN_DENSITY_COLOR_MAX_MAX;
}

export function getCollagenDensityModel(modelOrId = COLLAGEN_DENSITY_MODEL) {
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId?.id;
  const model = COLLAGEN_DENSITY_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error("Unknown collagen density model.");
  return model;
}

export function pixelDensityFromCollagenDensity(collagenDensity, model = COLLAGEN_DENSITY_MODEL) {
  if (!Number.isFinite(collagenDensity) || collagenDensity < 0) return null;

  const { amplitude, plateau, k } = getCollagenDensityModel(model);
  return amplitude * Math.exp(-k * collagenDensity) + plateau;
}

export function collagenDensityResult(pixelDensity, model = COLLAGEN_DENSITY_MODEL, {
  empty = false, colorMax = COLLAGEN_DENSITY_DISPLAY_MAX,
} = {}) {
  const { amplitude, plateau, k } = getCollagenDensityModel(model);
  if (empty || !Number.isFinite(pixelDensity) || pixelDensity < 0 || pixelDensity > 1) {
    return { value: null, status: "no-data" };
  }
  const y0 = Number((amplitude + plateau).toPrecision(12));
  if (pixelDensity <= Math.max(y0, amplitude + plateau)) return { value: 0, status: "below-baseline" };
  if (pixelDensity >= plateau) return { value: null, status: "model-range-exceeded" };
  const value = -Math.log((pixelDensity - plateau) / amplitude) / k;
  const resolvedMaximum = isCollagenDensityColorMax(colorMax) ? colorMax : COLLAGEN_DENSITY_DISPLAY_MAX;
  return { value, status: pixelDensity > pixelDensityFromCollagenDensity(resolvedMaximum, model) ? "color-max-exceeded" : "ok" };
}

export function estimateCollagenDensity(pixelDensity, maximumDensity = COLLAGEN_DENSITY_DISPLAY_MAX, model = COLLAGEN_DENSITY_MODEL) {
  return collagenDensityResult(pixelDensity, model, { colorMax: maximumDensity }).value;
}

export function collagenDensityResultFromMetrics(metrics, model = COLLAGEN_DENSITY_MODEL, { colorMax } = {}) {
  const area = metrics?.areaPx ?? metrics?.roiAreaPx;
  // Analysis `empty` means no fibers, not no sampled area. A measured AF of zero is valid.
  const empty = !metrics || (area != null
    ? !Number.isFinite(area) || area <= 0
    : metrics.empty === true);
  return collagenDensityResult(metrics?.areaFraction ?? metrics?.density, model, { empty, colorMax });
}

export function collagenDensityModelText(model = COLLAGEN_DENSITY_MODEL) {
  const { amplitude, plateau, k } = getCollagenDensityModel(model);
  return `Area Fraction = ${plateau} - ${-amplitude} * exp(-${k} * Collagen Density)`;
}

export function collagenDensityInverseText(model = COLLAGEN_DENSITY_MODEL) {
  const { amplitude, plateau, k } = getCollagenDensityModel(model);
  return `Collagen Density = -ln((${plateau} - Area Fraction) / ${-amplitude}) / ${k}; AF <= ${Number((plateau + amplitude).toPrecision(12))}: 0; AF >= ${plateau}: model-range-exceeded`;
}

export function calibrationMetadata({ model = COLLAGEN_DENSITY_MODEL, revision = 0, colorMax = null, exportedAt = new Date().toISOString() } = {}) {
  const selected = getCollagenDensityModel(model);
  return {
    modelId: selected.id, modelLabel: selected.label, modelVersion: selected.version,
    revision, coefficients: { amplitude: selected.amplitude, plateau: selected.plateau, k: selected.k },
    formula: collagenDensityModelText(selected), inverseFormula: collagenDensityInverseText(selected),
    units: { areaFraction: "fraction", concentration: "mg/mL" }, policyVersion: 1,
    colorMax, exportedAt,
    policy: { finiteValues: "uncapped", baseline: "zero", plateau: "model-range-exceeded", invalidOrEmpty: "no-data", colorMax: "display-only" },
  };
}
