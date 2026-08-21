import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderRaw16ToCanvas } from "./lib/raw16Renderer.js";

const DEFAULT_SERVER_URL = "http://localhost:8000";
const TERMINAL_JOB_STATES = new Set(["complete", "partial", "failed"]);
const THRESHOLD_GRID = 1000;

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

function normalizeThreshold(value) {
  return validThreshold(value) ? Math.round(value * THRESHOLD_GRID) / THRESHOLD_GRID : null;
}

function reviewUrl(imageId, roi) {
  const base = `/api/inference/images/${encodeURIComponent(imageId)}/review`;
  return roi ? `${base}?roi=${encodeURIComponent(JSON.stringify(roi))}` : base;
}

function rectangleFromPoints(start, end) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function probabilityHistogram(probabilityMap, rectangle = null) {
  const { width, height, data } = probabilityMap ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      !Array.isArray(data) || data.length !== width * height) {
    return null;
  }
  const bins = new Array(1001).fill(0);
  let areaPx = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rectangle && (x < rectangle.x || x >= rectangle.x + rectangle.width ||
          y < rectangle.y || y >= rectangle.y + rectangle.height)) continue;
      const value = data[y * width + x];
      if (!Number.isFinite(value) || value < 0 || value > 1) return null;
      bins[Math.min(1000, Math.floor(value * 1000 + 1e-9))] += 1;
      areaPx += 1;
    }
  }
  return { bins, areaPx };
}

function ProbabilityHistogram({ label, histogram, threshold, disabled, onThresholdChange, onThresholdCommit }) {
  const bins = Array.isArray(histogram?.bins) ? histogram.bins : [];
  if (bins.length !== 1001) return null;
  const maximum = Math.max(...bins, 1);
  const normalizedThreshold = normalizeThreshold(threshold) ?? 0.5;
  const binWidth = 100 / bins.length;

  return (
    <section className="inference-histogram">
      <div className="inference-histogram-heading">
        <h3>{label}</h3>
        <span>{histogram.areaPx.toLocaleString()} px</span>
      </div>
      <div className="inference-histogram-chart">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label} probability histogram`}>
          {bins.map((count, index) => {
            const height = (count / maximum) * 38;
            return <rect key={index} x={index * binWidth} y={40 - height} width={Math.max(binWidth * 0.82, 0.02)} height={height} />;
          })}
          <line x1={normalizedThreshold * 100} x2={normalizedThreshold * 100} y1="0" y2="40" />
        </svg>
        <input
          className="inference-histogram-slider"
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={normalizedThreshold}
          disabled={disabled}
          aria-label={`${label} probability threshold`}
          onChange={(event) => onThresholdChange(Number(event.target.value))}
          onPointerUp={(event) => onThresholdCommit(Number(event.currentTarget.value))}
          onBlur={(event) => onThresholdCommit(Number(event.currentTarget.value))}
        />
      </div>
      <div className="inference-histogram-axis" aria-hidden="true"><span>0.00</span><span>0.50</span><span>1.00</span></div>
    </section>
  );
}

export default function InferencePage() {
  const [rootPath, setRootPath] = useState("");
  const [activeRootPath, setActiveRootPath] = useState("");
  const [images, setImages] = useState([]);
  const [activeImageId, setActiveImageId] = useState(null);
  const [stageView, setStageView] = useState("overlay");
  const [review, setReview] = useState(null);
  const [inferenceRoi, setInferenceRoi] = useState(null);
  const [draftInferenceRoi, setDraftInferenceRoi] = useState(null);
  const [thresholdDraft, setThresholdDraft] = useState("0.500");
  const [rawImage, setRawImage] = useState(null);
  const [overlay, setOverlay] = useState(null);
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
  const activeRootPathRef = useRef(null);
  const imageListRequestIdRef = useRef(0);
  const reviewRequestIdRef = useRef(0);
  const rootChangePendingRef = useRef(false);
  const rootGenerationRef = useRef(0);
  const roiDragStartRef = useRef(null);
  activeImageIdRef.current = activeImageId;

  const completeImages = useMemo(
    () => images.filter((image) => image.status === "complete"),
    [images],
  );
  const activeImage = useMemo(
    () => images.find((image) => image.id === activeImageId) ?? null,
    [activeImageId, images],
  );
  const activeCompleteImage = useMemo(
    () => activeImage?.status === "complete" ? activeImage : null,
    [activeImage],
  );
  const activeCompleteIndex = activeCompleteImage
    ? completeImages.findIndex((image) => image.id === activeCompleteImage.id)
    : -1;
  const reviewReady = Boolean(activeCompleteImage && review?.id === activeCompleteImage.id);
  const rawImageMatchesActive = Boolean(
    rawImage && rawImage.imageId === activeImage?.id && rawImage.rootPath === activeRootPath,
  );
  const activeThreshold = normalizeThreshold(Number(thresholdDraft));
  const clientHistograms = useMemo(() => ({
    wholeImage: probabilityHistogram(review?.probabilityMap),
    roi: inferenceRoi ? probabilityHistogram(review?.probabilityMap, inferenceRoi) : null,
  }), [inferenceRoi, review?.probabilityMap]);
  const overlayUrl = reviewReady && overlay &&
    overlay.rootPath === activeRootPath &&
    overlay.imageId === activeCompleteImage?.id &&
    overlay.threshold === activeThreshold
    ? overlay.url
    : null;
  const inferenceRunning = job?.status === "running";
  const visibleInferenceRoi = draftInferenceRoi ?? inferenceRoi;

  const confirmActiveRoot = useCallback((nextRoot) => {
    const previousRoot = activeRootPathRef.current;
    const rootChanged = previousRoot !== null && previousRoot !== nextRoot;
    if (previousRoot !== nextRoot) {
      rootGenerationRef.current += 1;
      imageListRequestIdRef.current += 1;
    }
    activeRootPathRef.current = nextRoot;
    setActiveRootPath(nextRoot);
    if (!rootChanged) return false;

    reviewRequestIdRef.current += 1;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    setImages([]);
    setActiveImageId(null);
    setReview(null);
    setInferenceRoi(null);
    setDraftInferenceRoi(null);
    setThresholdDraft("0.500");
    setRawImage(null);
    setOverlay(null);
    setJob(null);
    setJobMessage("");
    setActionMessage("");
    return true;
  }, []);

  const loadImages = useCallback(async () => {
    const requestId = imageListRequestIdRef.current + 1;
    imageListRequestIdRef.current = requestId;
    const requestGeneration = rootGenerationRef.current;
    const requestRoot = activeRootPathRef.current;
    const requestIsCurrent = () => mountedRef.current && !rootChangePendingRef.current &&
      imageListRequestIdRef.current === requestId && rootGenerationRef.current === requestGeneration &&
      activeRootPathRef.current === requestRoot;
    let payload;
    try {
      payload = await readJsonResponse(
        await fetch("/api/inference/images"),
        "Unable to load inference images.",
      );
    } catch (loadError) {
      if (!requestIsCurrent()) return null;
      throw loadError;
    }
    if (!requestIsCurrent()) {
      return payload;
    }
    const nextImages = Array.isArray(payload.images) ? payload.images : [];
    const nextRoot = typeof payload.rootPath === "string" ? payload.rootPath : "";
    if (requestRoot !== null && nextRoot !== requestRoot) return payload;
    confirmActiveRoot(nextRoot);
    setRootPath(nextRoot);
    setImages(nextImages);
    setActiveImageId((currentId) => {
      if (nextImages.some((image) => image.id === currentId)) {
        return currentId;
      }
      return nextImages.find((image) => image.status === "complete")?.id ?? nextImages[0]?.id ?? null;
    });
    return payload;
  }, [confirmActiveRoot]);

  const loadReview = useCallback(async (imageId, roi) => {
    const requestId = reviewRequestIdRef.current + 1;
    reviewRequestIdRef.current = requestId;
    const payload = await readJsonResponse(
      await fetch(reviewUrl(imageId, roi)),
      "Unable to load inference review.",
    );
    if (!mountedRef.current || activeImageIdRef.current !== imageId || reviewRequestIdRef.current !== requestId) {
      return payload;
    }
    setReview(payload);
    setThresholdDraft((normalizeThreshold(Number(payload.threshold)) ?? 0.5).toFixed(3));
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
    if (!activeImage) {
      setRawImage(null);
      return undefined;
    }

    let alive = true;
    const image = activeImage;
    const sourceRootPath = activeRootPath;
    setRawImage(null);
    setError("");

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
          imageId: image.id,
          rootPath: sourceRootPath,
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
  }, [activeImage, activeRootPath]);

  useEffect(() => {
    if (!activeCompleteImage) {
      setReview(null);
      return undefined;
    }

    let alive = true;
    setReview(null);
    setError("");

    loadReview(activeCompleteImage.id, inferenceRoi).catch((loadError) => {
      if (alive) setError(loadError.message);
    });

    return () => {
      alive = false;
    };
  }, [activeCompleteImage, inferenceRoi, loadReview]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!rawImageMatchesActive) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }
    renderRaw16ToCanvas(canvasRef.current, rawImage);
  }, [rawImage, rawImageMatchesActive, stageView]);

  useEffect(() => {
    const threshold = normalizeThreshold(Number(thresholdDraft));
    setOverlay(null);
    if (!reviewReady || threshold === null) {
      return undefined;
    }

    let alive = true;
    let objectUrl = null;
    const source = { rootPath: activeRootPath, imageId: activeCompleteImage.id, threshold };
    fetch(`/api/inference/images/${encodeURIComponent(activeCompleteImage.id)}/overlay?threshold=${threshold.toFixed(3)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load the binary mask overlay.");
        const blob = await response.blob();
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setOverlay({ ...source, url: objectUrl });
      })
      .catch((loadError) => {
        if (alive) setError(loadError.message);
      });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeCompleteImage, activeRootPath, reviewReady, thresholdDraft]);

  async function applyRoot(endpoint, body) {
    rootChangePendingRef.current = true;
    rootGenerationRef.current += 1;
    imageListRequestIdRef.current += 1;
    setLoadingRoot(true);
    setError("");
    try {
      const payload = await readJsonResponse(await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), "Unable to set inference root.");
      if (typeof payload.rootPath === "string") {
        confirmActiveRoot(payload.rootPath);
        setRootPath(payload.rootPath);
      }
      rootChangePendingRef.current = false;
      await loadImages();
    } catch (rootError) {
      rootChangePendingRef.current = false;
      setError(rootError.message);
    } finally {
      rootChangePendingRef.current = false;
      setLoadingRoot(false);
    }
  }

  const pollJob = useCallback(async (jobId, existingContext = null) => {
    const pollContext = existingContext ?? {
      rootGeneration: rootGenerationRef.current,
      rootPath: activeRootPathRef.current,
    };
    const pollIsCurrent = () => mountedRef.current
      && !rootChangePendingRef.current
      && rootGenerationRef.current === pollContext.rootGeneration
      && activeRootPathRef.current === pollContext.rootPath;
    if (!pollIsCurrent()) return;

    try {
      const payload = await readJsonResponse(
        await fetch(`/api/inference/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }),
        "Unable to poll inference job.",
      );
      if (!pollIsCurrent()) return;
      setJob(payload.job);
      await loadImages();
      if (!pollIsCurrent()) return;
      if (TERMINAL_JOB_STATES.has(payload.job.status)) {
        setJobMessage(`Inference ${payload.job.status}: ${payload.job.completed} complete, ${payload.job.failed} failed`);
        return;
      }
      pollTimerRef.current = setTimeout(() => pollJob(jobId, pollContext), 250);
    } catch (pollError) {
      if (pollIsCurrent()) setError(pollError.message);
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

  function persistThreshold({ showMessage = true, thresholdValue } = {}) {
    if (!activeCompleteImage || !reviewReady) return Promise.resolve(false);
    const threshold = normalizeThreshold(thresholdValue ?? Number(thresholdDraft));
    if (threshold === null) {
      setThresholdDraft((normalizeThreshold(Number(review?.threshold)) ?? 0.5).toFixed(3));
      setError("Threshold must be between 0 and 1.");
      return Promise.resolve(false);
    }
    if (thresholdSaveRef.current) return thresholdSaveRef.current;
    if (threshold === normalizeThreshold(Number(review?.threshold))) {
      setThresholdDraft(threshold.toFixed(3));
      return Promise.resolve(true);
    }

    const imageId = activeCompleteImage.id;
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
        await loadReview(imageId, inferenceRoi);
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

  function handleHistogramThresholdChange(value) {
    const threshold = normalizeThreshold(value);
    if (threshold === null) return;
    setOverlay(null);
    setThresholdDraft(threshold.toFixed(3));
  }

  function commitHistogramThreshold(value) {
    void persistThreshold({ thresholdValue: value });
  }

  async function handleSetOtherThresholds() {
    if (!activeCompleteImage || !reviewReady || propagating) return;
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
          roi: inferenceRoi,
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
    if (!activeCompleteImage || !reviewReady || generating) return;
    setGenerating(true);
    setError("");
    setActionMessage("");
    try {
      if (!await persistThreshold({ showMessage: false })) return;
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
    setOverlay(null);
    setActiveImageId(nextImage.id);
  }

  function stagePixelPoint(event) {
    if (!rawImageMatchesActive || !rawImage?.width || !rawImage?.height) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    return {
      x: Math.max(0, Math.min(rawImage.width, Math.round(((event.clientX - bounds.left) / bounds.width) * rawImage.width))),
      y: Math.max(0, Math.min(rawImage.height, Math.round(((event.clientY - bounds.top) / bounds.height) * rawImage.height))),
    };
  }

  function handleRoiPointerDown(event) {
    if (stageView === "mask") return;
    const point = stagePixelPoint(event);
    if (!point) return;
    roiDragStartRef.current = point;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraftInferenceRoi({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function handleRoiPointerMove(event) {
    const start = roiDragStartRef.current;
    if (!start) return;
    const point = stagePixelPoint(event);
    if (!point) return;
    setDraftInferenceRoi(rectangleFromPoints(start, point) ?? { x: start.x, y: start.y, width: 0, height: 0 });
  }

  function commitRoiPointer(event) {
    const start = roiDragStartRef.current;
    if (!start) return;
    roiDragStartRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const point = stagePixelPoint(event);
    const nextRoi = point ? rectangleFromPoints(start, point) : null;
    setDraftInferenceRoi(null);
    if (nextRoi) setInferenceRoi(nextRoi);
  }

  return (
    <div className="inference-page">
      <header className="inference-toolbar">
        <h1>Inference mask setting</h1>
        <label>
          Root path
          <input value={rootPath} disabled={inferenceRunning} onChange={(event) => setRootPath(event.target.value)} />
        </label>
        <button type="button" onClick={() => applyRoot("/api/inference/root", { rootPath })} disabled={loadingRoot || inferenceRunning || !rootPath.trim()}>
          Set root
        </button>
        <button type="button" onClick={() => applyRoot("/api/inference/root/select")} disabled={loadingRoot || inferenceRunning}>
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
                onClick={() => {
                  setOverlay(null);
                  setActiveImageId(image.id);
                }}
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
          <div className="inference-stage-modes" role="group" aria-label="Stage view">
            {[["original", "Original"], ["overlay", "Overlay"], ["mask", "Mask"]].map(([value, label]) => (
              <button type="button" key={value} aria-pressed={stageView === value} onClick={() => setStageView(value)}>{label}</button>
            ))}
          </div>
          <div
            className="inference-stage-frame"
            aria-label="Composited source and binary mask"
            onPointerDown={handleRoiPointerDown}
            onPointerMove={handleRoiPointerMove}
            onPointerUp={commitRoiPointer}
            onPointerCancel={commitRoiPointer}
          >
            <canvas ref={canvasRef} hidden={stageView === "mask"} className="inference-source-canvas" aria-label="Original source image" />
            {stageView !== "original" && overlayUrl ? (
              <img
                className="inference-mask-overlay"
                src={overlayUrl}
                alt={stageView === "mask" ? "Binary mask" : "Binary mask overlay"}
                width={rawImage?.width ?? review?.width}
                height={rawImage?.height ?? review?.height}
              />
            ) : null}
            {visibleInferenceRoi && rawImageMatchesActive ? (
              <div
                className="inference-roi-rectangle"
                aria-label="Common inference ROI"
                style={{
                  left: `${(visibleInferenceRoi.x / rawImage.width) * 100}%`,
                  top: `${(visibleInferenceRoi.y / rawImage.height) * 100}%`,
                  width: `${(visibleInferenceRoi.width / rawImage.width) * 100}%`,
                  height: `${(visibleInferenceRoi.height / rawImage.height) * 100}%`,
                }}
              />
            ) : null}
          </div>
          {stageView !== "original" && !activeCompleteImage ? <p>Probability map is unavailable for this image.</p> : null}
          {stageView !== "original" && activeCompleteImage && !reviewReady ? <p>Loading probability map review.</p> : null}
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
            disabled={!reviewReady || savingThreshold}
            onChange={(event) => {
              setOverlay(null);
              setThresholdDraft(event.target.value);
            }}
            onBlur={commitThreshold}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>

        <div className="inference-histograms">
          <ProbabilityHistogram
            label="Whole image"
            histogram={clientHistograms.wholeImage}
            threshold={activeThreshold}
            disabled={!reviewReady || savingThreshold}
            onThresholdChange={handleHistogramThresholdChange}
            onThresholdCommit={commitHistogramThreshold}
          />
          {review?.roi ? (
            <ProbabilityHistogram
              label="ROI"
              histogram={clientHistograms.roi}
              threshold={activeThreshold}
              disabled={!reviewReady || savingThreshold}
              onThresholdChange={handleHistogramThresholdChange}
              onThresholdCommit={commitHistogramThreshold}
            />
          ) : null}
        </div>

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

        <div className="inference-roi-status">
          <span>{inferenceRoi ? "Common rectangle ROI" : "Whole image"}</span>
          {inferenceRoi ? (
            <button type="button" onClick={() => setInferenceRoi(null)}>
              Clear ROI
            </button>
          ) : null}
        </div>

        <button
          type="button"
          onClick={handleSetOtherThresholds}
          disabled={!reviewReady || propagating}
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
        <button type="button" onClick={handleGenerateMasks} disabled={!reviewReady || generating}>
          Generate masks
        </button>
      </footer>
    </div>
  );
}
