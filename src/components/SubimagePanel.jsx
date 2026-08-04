export default function SubimagePanel({
  activeImageName,
  templateOwnerName,
  isTemplateOwner,
  hasSubimage,
  crop,
  dirty,
  mode,
  busy,
  error,
  result,
  canCreateMissing,
  canSave,
  canReplace,
  onSetCrop,
  onCreateMissing,
  onSave,
  onStartReplace,
  onApplyReplace,
  onCancelReplace,
}) {
  const actionsLocked = busy !== null || mode !== "idle";
  const state = busyLabel(busy) || modeLabel(mode);

  return (
    <section className="subimage-controls" aria-labelledby="subimage-heading">
      <header className="subimage-heading">
        <h2 id="subimage-heading">Subimage</h2>
        <div className="subimage-identity">
          <strong>{activeImageName}</strong>
          {!isTemplateOwner ? <span>{`Template: ${templateOwnerName}`}</span> : null}
          <span>{hasSubimage ? "Saved" : "Missing"}</span>
          {dirty ? <span className="subimage-dirty">Unsaved changes</span> : null}
        </div>
        {state ? <span className="subimage-state" role="status">{state}</span> : null}
      </header>

      <dl className="subimage-fields" aria-label="Subimage crop">
        <div>
          <dt>Position</dt>
          <dd>{`x ${value(crop?.x)}`}</dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd>{`y ${value(crop?.y)}`}</dd>
        </div>
        <div className="subimage-size-field">
          <dt>Size</dt>
          <dd>{`${value(crop?.width)} x ${value(crop?.height)} px`}</dd>
        </div>
      </dl>

      <div className="subimage-actions">
        {mode === "confirm-replacement" ? (
          <>
            <button type="button" disabled={busy !== null || !canReplace} onClick={onApplyReplace}>
              Apply replacement
            </button>
            <button type="button" disabled={busy !== null} onClick={onCancelReplace}>
              Cancel replacement
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={actionsLocked} onClick={onSetCrop}>Set crop</button>
            <button type="button" disabled={actionsLocked || !canCreateMissing} onClick={onCreateMissing}>
              Create all subimages
            </button>
            <button type="button" disabled={actionsLocked || !canSave} onClick={onSave}>Save subimage</button>
            <button
              type="button"
              className="danger"
              disabled={actionsLocked || !canReplace}
              onClick={onStartReplace}
            >
              Replace all subimages
            </button>
          </>
        )}
      </div>

      {error ? <p className="subimage-error" role="alert">{error}</p> : null}
      {result ? <BatchResult result={result} /> : null}
    </section>
  );
}

function BatchResult({ result }) {
  const entries = [
    ...batchEntries("Created", result.created),
    ...batchEntries("Preserved", result.preserved),
    ...batchEntries("Replaced", result.replaced),
    ...batchEntries("Failed", result.failed, (failure) => `${failure.imageFolder} - ${failure.message}`),
  ];

  return (
    <div className="subimage-batch-result" aria-label="Subimage batch result" aria-live="polite">
      {entries.map((entry, index) => <span data-testid="subimage-batch-item" key={`${entry}-${index}`}>{entry}</span>)}
    </div>
  );
}

function batchEntries(label, entries, formatEntry = (entry) => entry) {
  return entries?.length ? [`${label} (${entries.length}): ${entries.map(formatEntry).join(", ")}`] : [];
}

function value(number) {
  return Number.isFinite(number) ? number : "-";
}

function modeLabel(mode) {
  if (mode === "select-initial") return "Select the initial crop";
  if (mode === "select-replacement") return "Select a replacement crop";
  if (mode === "confirm-replacement") return "Review replacement crop";
  return "";
}

function busyLabel(busy) {
  if (busy === "loading") return "Loading subimage";
  if (busy === "saving") return "Saving subimage";
  if (busy === "create-missing") return "Creating subimages";
  if (busy === "replace-all") return "Replacing all subimages";
  return "";
}
