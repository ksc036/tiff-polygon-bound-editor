import { useCallback, useEffect, useRef, useState } from "react";
import { getCollagenDensityModel } from "../../shared/collagenDensity.js";

const ENDPOINT = "/api/settings/collagen-density";

async function readSnapshot(response) {
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error || "Unable to load collagen calibration.");
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  if (!Number.isInteger(payload?.revision) || payload.revision < 0 || !payload.modelId) {
    throw new Error("Invalid collagen calibration settings.");
  }
  return Object.freeze({ ...payload, model: getCollagenDensityModel(payload.modelId) });
}

export function useCollagenCalibration() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const confirmed = useRef(null);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const savePending = useRef(false);

  const accept = useCallback((next) => {
    if (mounted.current && (!confirmed.current || next.revision >= confirmed.current.revision)) {
      confirmed.current = next;
      setSnapshot(next);
    }
  }, []);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const next = await readSnapshot(await fetch(ENDPOINT, { cache: "no-store" }));
      accept(next);
      if (mounted.current && id === requestId.current) setError("");
      return next;
    } catch (failure) {
      if (mounted.current && id === requestId.current) setError(failure.message);
      throw failure;
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false);
    }
  }, [accept]);

  const setModel = useCallback(async (modelId) => {
    if (!confirmed.current || savePending.current || modelId === confirmed.current.modelId) return;
    savePending.current = true;
    const id = ++requestId.current;
    setSaving(true);
    setError("");
    try {
      const next = await readSnapshot(await fetch(ENDPOINT, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, revision: confirmed.current.revision }),
      }));
      accept(next);
    } catch (failure) {
      if (failure.status === 409) {
        try { await refresh(); } catch { /* Keep the save conflict visible. */ }
      }
      if (mounted.current) setError(failure.message);
    } finally {
      savePending.current = false;
      if (mounted.current) {
        setSaving(false);
        if (id === requestId.current) setLoading(false);
      }
    }
  }, [accept, refresh]);

  const preflight = useCallback(async () => {
    const expected = confirmed.current;
    if (!expected || savePending.current) throw new Error("Collagen calibration is not ready.");
    const next = await refresh();
    if (next.revision !== expected.revision || confirmed.current?.revision !== expected.revision) {
      throw new Error("Collagen calibration changed. Review the updated model and retry the download.");
    }
    return next;
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    const update = () => {
      if (document.visibilityState !== "hidden" && !savePending.current) void refresh().catch(() => {});
    };
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    const timer = setInterval(update, 15000);
    return () => {
      mounted.current = false;
      requestId.current += 1;
      clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);

  return { snapshot, loading, saving, error, setModel, refresh, preflight };
}
