import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderRaw16ToCanvas } from "./lib/raw16Renderer.js";

const DEFAULT_SERVER_URL = "http://localhost:8000";
const TERMINAL_JOB_STATES = new Set(["complete", "partial", "failed"]);

async function readJsonResponse(response, fallbackMessage) {
  if (!response.ok) {
    let message = fallbackMessage;
    try {
      const payload = await response.json();
      if (typeof payload?.error === "string") message = payload.error;
    } catch {
      // Keep the user-facing fallback for non-JSON failures.
    }
    throw new Error(message);
  }
  return response.json();
}

function statusLabel(status) {
  return typeof status === "string" && status.length > 0
    ? `${status[0].toUpperCase()}${status.slice(1).toLowerCase()}`
    : "Waiting";
}

function fractionLabel(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "Unavailable";
}

function validThreshold(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function reviewUrl(imageId, roiGroupId) {
  const base = `/api/inference/images/${encodeURIComponent(imageId)}/review`;
  return roiGroupId === undefined ? base : `${base}?roiGroupId=${encodeURIComponent(roiGroupId)}`;
}

export default function InferencePage() {
  const [rootPath, setRootPath] = useState("");
  const [images, setImages] = useState([]);
  const [activeImageId, setActiveImageId] = useState(null);
  const [review, setReview] = useState(null);
  const [selectedRoiByImage, setSelectedRoiByImage] = useState({});
  const [thresholdDraft, setThresholdDraft] = useState("0.500");
  const [rawImage, setRawImage] = useState(null);
  const [overlayUrl, setOverlayUrl] = useState(null);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [job, setJob] = useState(null);
  const [jobMessage, setJobMessage] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [error, setError] = useState("");
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [propagating, setPropagating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const canvasRef = useRef(null);
  const pollTimerRef = useRef(null);
  const mountedRef = useRef(true);
  const thresholdSaveRef = useRef(null);
  const activeImageIdRef = useRef(activeImageId);
  const reviewRequestIdRef = useRef(0);
  activeImageIdRef.current = activeImageId;

  const completeImages = useMemo(
    () => images.filter((image) => image.status === "complete"),
    [images],
  );
  const activeCompleteImage = useMemo(
    () => completeImages.find((image) => image.id === activeImageId) ?? null,
    [activeImageId, completeImages],
  );
  const activeCompleteIndex = activeCompleteImage
    ? completeImages.findIndex((image) => image.id === activeCompleteImage.id)
    : -1;
  const selectedRoiGroupId = activeCompleteImage
    ? selectedRoiByImage[activeCompleteImage.id]
    : undefined;

  const loadImages = useCallback(async () => {
    const payload = await readJsonResponse(
      await fetch("/api/inference/images"),
      "Unable to load inference images.",
    );
    if (!mountedRef.current) return payload;
    const nextImages = Array.isArray(payload.images) ? payload.images : [];
    setRootPath(typeof payload.rootPath === "string" ? payload.rootPath : "");
    setImages(nextImages);
    setActiveImageId((currentId) => {
      if (nextImages.some((image) => image.id === currentId && image.status === "complete")) {
        return currentId;
      }
      return nextImages.find((image) => image.status === "complete")?.id ?? null;
    });
    return payload;
  }, []);

  const loadReview = useCallback(async (imageId, roiGroupId) => {
    const requestId = reviewRequestIdRef.current + 1;
    reviewRequestIdRef.current = requestId;
    const payload = await readJsonResponse(
      await fetch(reviewUrl(imageId, roiGroupId)),
      "Unable to load inference review.",
    );
    if (!mountedRef.current || activeImageIdRef.current !== imageId || reviewRequestIdRef.current !== requestId) {
      return payload;
    }
    setReview(payload);
    setThresholdDraft(Number(payload.threshold).toFixed(3));
    setSelectedRoiByImage((current) => {
      if (Object.prototype.hasOwnProperty.call(current, imageId)) return current;
      const groups = Array.isArray(payload.groups) ? payload.groups : [];
      const savedGroupId = payload.settings?.roiGroupId;
      const selected = groups.some((group) => group.id === savedGroupId) ? savedGroupId : "";
      return { ...current, [imageId]: selected };
    });
    return payload;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadImages().catch((loadError) => {
      if (mountedRef.current) setError(loadError.message);
    });
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [loadImages]);

  useEffect(() => {
    if (!images.some((image) => image.status === "sending") || job?.status === "running") {
      return undefined;
    }

    const timer = setTimeout(() => {
      loadImages().catch((loadError) => {
        if (mountedRef.current) setError(loadError.message);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [images, job?.status, loadImages]);

  useEffect(() => {
    if (!activeCompleteImage) {
      setReview(null);
      setRawImage(null);
      return undefined;
    }

    let alive = true;
    const image = activeCompleteImage;
    setReview(null);
    setRawImage(null);
    setError("");

    loadReview(image.id, selectedRoiGroupId).catch((loadError) => {
      if (alive) setError(loadError.message);
    });

    fetch(`/api/inference/images/${encodeURIComponent(image.id)}/raw16`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to read image pixels.");
        const buffer = await response.arrayBuffer();
        if (!alive) return;
        const width = Number(response.headers.get("x-image-width"));
        const height = Number(response.headers.get("x-image-height"));
        const min = Number(response.headers.get("x-display-min"));
        const max = Number(response.headers.get("x-display-max"));
        setRawImage({
          pixels: new Uint16Array(buffer),
          width: Number.isInteger(width) && width > 0 ? width : 0,
          height: Number.isInteger(height) && height > 0 ? height : 0,
          min: Number.isFinite(min) ? min : 0,
          max: Number.isFinite(max) ? max : 65535,
        });
      })
      .catch((loadError) => {
        if (alive) setError(loadError.message);
      });

    return () => {
      alive = false;
    };
  }, [activeCompleteImage, loadReview, selectedRoiGroupId]);

  useEffect(() => {
    if (!rawImage) return;
    renderRaw16ToCanvas(canvasRef.current, rawImage);
  }, [rawImage]);

  useEffect(() => {
    const threshold = Number(thresholdDraft);
    if (!activeCompleteImage || !validThreshold(threshold)) {
      setOverlayUrl(null);
      return undefined;
    }

    let alive = true;
    let objectUrl = null;
    fetch(`/api/inference/images/${encodeURIComponent(activeCompleteImage.id)}/overlay?threshold=${threshold.toFixed(3)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load the binary mask overlay.");
        const blob = await response.blob();
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setOverlayUrl(objectUrl);
      })
      .catch((loadError) => {
        if (alive) setError(loadError.message);
      });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeCompleteImage, thresholdDraft]);

  async function applyRoot(endpoint, body) {
    setLoadingRoot(true);
    setError("");
    try {
      await readJsonResponse(await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), "Unable to set inference root.");
      await loadImages();
    } catch (rootError) {
      setError(rootError.message);
    } finally {
      setLoadingRoot(false);
    }
  }

  const pollJob = useCallback(async (jobId) => {
    try {
      const payload = await readJsonResponse(
        await fetch(`/api/inference/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }),
        "Unable to poll inference job.",
      );
      if (!mountedRef.current) return;
      setJob(payload.job);
      await loadImages();
      if (TERMINAL_JOB_STATES.has(payload.job.status)) {
        setJobMessage(`Inference ${payload.job.status}: ${payload.job.completed} complete, ${payload.job.failed} failed`);
        return;
      }
      pollTimerRef.current = setTimeout(() => pollJob(jobId), 250);
    } catch (pollError) {
      if (mountedRef.current) setError(pollError.message);
    }
  }, [loadImages]);

  async function handleStartInference() {
    setError("");
    setJobMessage("");
    try {
      const payload = await readJsonResponse(await fetch("/api/inference/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverUrl }),
      }), "Unable to start inference.");
      setJob(payload.job);
      await loadImages();
      await pollJob(payload.job.id);
    } catch (startError) {
      setError(startError.message);
    }
  }

  function persistThreshold({ showMessage = true } = {}) {
    if (!activeCompleteImage) return Promise.resolve(false);
    const threshold = Number(thresholdDraft);
    if (!validThreshold(threshold)) {
      setThresholdDraft(Number(review?.threshold ?? 0.5).toFixed(3));
      setError("Threshold must be between 0 and 1.");
      return Promise.resolve(false);
    }
    if (thresholdSaveRef.current) return thresholdSaveRef.current;
    if (threshold === Number(review?.threshold)) {
      setThresholdDraft(threshold.toFixed(3));
      return Promise.resolve(true);
    }

    const imageId = activeCompleteImage.id;
    const roiGroupId = selectedRoiGroupId;

    setSavingThreshold(true);
    setError("");
    const savePromise = (async () => {
      try {
        await readJsonResponse(await fetch(
          `/api/inference/images/${encodeURIComponent(imageId)}/threshold`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threshold }),
          },
        ), "Unable to save threshold.");
        await loadReview(imageId, roiGroupId);
        if (showMessage) setActionMessage("Threshold saved for this image");
        return true;
      } catch (saveError) {
        setError(saveError.message);
        return false;
      } finally {
        thresholdSaveRef.current = null;
        setSavingThreshold(false);
      }
    })();
    thresholdSaveRef.current = savePromise;
    return savePromise;
  }

  function commitThreshold() {
    void persistThreshold();
  }

  async function handleSetOtherThresholds() {
    if (!activeCompleteImage || propagating) return;
    setPropagating(true);
    setError("");
    setActionMessage("");
    try {
      if (!await persistThreshold({ showMessage: false })) return;
      const payload = await readJsonResponse(await fetch("/api/inference/reference-thresholds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          referenceId: activeCompleteImage.id,
          roiGroupId: selectedRoiGroupId || null,
        }),
      }), "Unable to propagate reference threshold.");
      setActionMessage(`Updated ${payload.updated} other threshold${payload.updated === 1 ? "" : "s"}`);
      await loadImages();
    } catch (propagationError) {
      setError(propagationError.message);
    } finally {
      setPropagating(false);
    }
  }

  async function handleGenerateMasks() {
    if (!completeImages.length || generating) return;
    setGenerating(true);
    setError("");
    setActionMessage("");
    try {
      const payload = await readJsonResponse(await fetch("/api/inference/generate-masks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }), "Unable to generate masks.");
      setActionMessage(`Generated ${payload.completed} masks; ${payload.failed} failed`);
    } catch (generationError) {
      setError(generationError.message);
    } finally {
      setGenerating(false);
    }
  }

  function navigateComplete(offset) {
    const nextImage = completeImages[activeCompleteIndex + offset];
    if (!nextImage) return;
    setActionMessage("");
    setActiveImageId(nextImage.id);
  }

  return (
    <div className="inference-page">
      <header className="inference-toolbar">
        <h1>Inference mask setting</h1>
        <label>
          Root path
          <input value={rootPath} onChange={(event) => setRootPath(event.target.value)} />
        </label>
        <button type="button" onClick={() => applyRoot("/api/inference/root", { rootPath })} disabled={loadingRoot || !rootPath.trim()}>
          Set root
        </button>
        <button type="button" onClick={() => applyRoot("/api/inference/root/select")} disabled={loadingRoot}>
          Find root
        </button>
        <label>
          Model server URL
          <input type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={handleStartInference}
          disabled={!rootPath || !serverUrl || job?.status === "running"}
        >
          Run inference
        </button>
        {jobMessage ? <p role="status">{jobMessage}</p> : null}
      </header>

      <aside className="inference-status-panel">
        <h2>Source images</h2>
        <ul className="inference-image-list" aria-label="Inference image list">
          {images.map((image) => (
            <li key={image.id}>
              <button
                type="button"
                aria-current={image.id === activeImageId ? "true" : undefined}
                disabled={image.status !== "complete"}
                onClick={() => setActiveImageId(image.id)}
              >
                <span>{image.timestampFolder}</span>
                <strong>{image.imageFile}</strong>
                <span>{statusLabel(image.status)}</span>
              </button>
              {image.message ? <p>{image.message}</p> : null}
            </li>
          ))}
        </ul>
      </aside>

      <main className="inference-review">
        <section className="inference-stage" aria-label="Probability review stage">
          <div className="inference-stage-frame" aria-label="Composited source and binary mask">
            <canvas ref={canvasRef} className="inference-source-canvas" aria-label="Original source image" />
            {overlayUrl ? (
              <img
                className="inference-mask-overlay"
                src={overlayUrl}
                alt="Binary mask overlay"
                width={rawImage?.width ?? review?.width}
                height={rawImage?.height ?? review?.height}
              />
            ) : null}
          </div>
          {!activeCompleteImage ? <p>No completed image is available for review.</p> : null}
        </section>
      </main>

      <aside className="inference-controls">
        <h2>
          {activeCompleteImage
            ? `${activeCompleteImage.timestampFolder} / ${activeCompleteImage.imageFile}`
            : "Review"}
        </h2>
        <label>
          Threshold
          <input
            type="number"
            min="0"
            max="1"
            step="0.001"
            value={thresholdDraft}
            disabled={!activeCompleteImage || savingThreshold}
            onChange={(event) => setThresholdDraft(event.target.value)}
            onBlur={commitThreshold}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>

        <dl>
          <div>
            <dt>Whole image area fraction</dt>
            <dd>{fractionLabel(review?.wholeImage?.areaFraction)}</dd>
          </div>
          {review?.roi ? (
            <div>
              <dt>ROI area fraction</dt>
              <dd>{fractionLabel(review.roi.metrics?.areaFraction)}</dd>
            </div>
          ) : null}
        </dl>

        {review?.groups?.length ? (
          <label>
            Saved ROI group
            <select
              value={selectedRoiGroupId ?? ""}
              onChange={(event) => setSelectedRoiByImage((current) => ({
                ...current,
                [activeCompleteImage.id]: event.target.value,
              }))}
            >
              <option value="">Whole image (no ROI)</option>
              {review.groups.map((group) => (
                <option value={group.id} key={group.id}>{group.name || group.id}</option>
              ))}
            </select>
          </label>
        ) : null}

        <button
          type="button"
          onClick={handleSetOtherThresholds}
          disabled={!activeCompleteImage || propagating}
        >
          Set other thresholds from reference
        </button>
        {actionMessage ? <p role="status">{actionMessage}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </aside>

      <footer className="inference-footer">
        <nav aria-label="Completed image navigation">
          <button
            type="button"
            aria-label="Previous complete image"
            onClick={() => navigateComplete(-1)}
            disabled={activeCompleteIndex <= 0}
          >
            Previous
          </button>
          <span>{activeCompleteIndex >= 0 ? `${activeCompleteIndex + 1} / ${completeImages.length}` : `0 / ${completeImages.length}`}</span>
          <button
            type="button"
            aria-label="Next complete image"
            onClick={() => navigateComplete(1)}
            disabled={activeCompleteIndex < 0 || activeCompleteIndex >= completeImages.length - 1}
          >
            Next
          </button>
        </nav>
        <button type="button" onClick={handleGenerateMasks} disabled={!completeImages.length || generating}>
          Generate masks
        </button>
      </footer>
    </div>
  );
}
