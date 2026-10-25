import React from "react";
import { COLLAGEN_DENSITY_MODELS, collagenDensityModelText } from "../../shared/collagenDensity.js";

export default function CollagenCalibrationControl({ calibration, disabled = false }) {
  const { snapshot, loading, saving, error, setModel, refresh } = calibration;
  return (
    <section className="collagen-calibration-control" aria-label="Global collagen calibration" aria-busy={loading || saving}>
      <label>
        <span>Collagen calibration</span>
        <select aria-label="Collagen calibration" value={snapshot?.modelId ?? ""}
          disabled={disabled || loading || saving || !snapshot}
          onChange={(event) => void setModel(event.target.value)}>
          {!snapshot ? <option value="">{loading ? "Loading calibration..." : "Calibration unavailable"}</option> : null}
          {COLLAGEN_DENSITY_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>
      {snapshot ? <p>{collagenDensityModelText(snapshot.model)} <span>(mg/mL)</span></p> : null}
      {saving ? <span role="status">Saving calibration...</span> : null}
      {error ? <div className="calibration-error" role="alert">{error} <button type="button" onClick={() => void refresh().catch(() => {})} disabled={saving}>Retry</button></div> : null}
    </section>
  );
}
