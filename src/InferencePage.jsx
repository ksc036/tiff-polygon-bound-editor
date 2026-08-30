import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  addGroup,
  addPoint,
  clampBoundsToImage,
  createEmptyBounds,
  deleteGroup,
  deleteNearestPoint,
  deletePoint,
  moveNearestPoint,
  movePoint,
  movePointOrder,
  renameGroup,
} from "./lib/editorState.js";
import { findNearestSegment } from "./lib/geometry.js";
import { downloadAllInferenceOutputs } from "./lib/inferenceDownloads.js";
import { THRESHOLD_GRID, histogramAreaPath } from "./lib/inferenceHistogram.js";
import { renderRaw16ToCanvas } from "./lib/raw16Renderer.js";

const DEFAULT_SERVER_URL = "http://localhost:8000";
const TERMINAL_JOB_STATES = new Set(["complete", "partial", "failed"]);
const CELL_BOUNDARY_POINT_OPACITY_KEY = "inference-cell-boundary-point-opacity";
const SEGMENT_INSERT_SCREEN_THRESHOLD = 8;
const SEGMENT_INSERT_IMAGE_THRESHOLD = 8;
const DEFAULT_POINT_OPACITY = 0.85;

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

async function loadRaw16Image(imageId) {
  const response = await fetch(`/api/inference/images/${encodeURIComponent(imageId)}/raw16`);
  if (!response.ok) throw new Error("Unable to read image pixels.");
  const buffer = await response.arrayBuffer();
  const width = Number(response.headers.get("x-image-width"));
  const height = Number(response.headers.get("x-image-height"));
  const min = Number(response.headers.get("x-display-min"));
  const max = Number(response.headers.get("x-display-max"));
  return {
    pixels: new Uint16Array(buffer),
    width: Number.isInteger(width) && width > 0 ? width : 0,
    height: Number.isInteger(height) && height > 0 ? height : 0,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 65535,
  };
}

function rectangleFromPoints(start, end) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function cellBoundaryVisible(group) {
  return group.visible !== false;
}

function polygonsFromCellBoundaries(bounds) {
  return (bounds?.groups ?? []).filter((group) => group.points.length >= 3).map((group) => group.points);
}

function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const intersects = current.y > point.y !== previous.y > point.y &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function probabilityHistogram(probabilityMap, rectangle = null, excludedPolygons = []) {
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
      if (excludedPolygons.some((polygon) => pointInPolygon({ x, y }, polygon))) continue;
      const value = data[y * width + x];
      if (!Number.isFinite(value) || value < 0 || value > 1) return null;
      bins[Math.min(1000, Math.floor(value * 1000 + 1e-9))] += 1;
      areaPx += 1;
    }
  }
  return { bins, areaPx };
}

function histogramMetrics(histogram, threshold) {
  if (!histogram || !Number.isFinite(threshold) || histogram.areaPx <= 0) return null;
  const startBin = Math.max(0, Math.min(1000, Math.ceil(threshold * 1000 - 1e-9)));
  let pixelCount = 0;
  for (let index = startBin; index < histogram.bins.length; index += 1) {
    pixelCount += histogram.bins[index];
  }
  return { pixelCount, areaPx: histogram.areaPx, areaFraction: pixelCount / histogram.areaPx };
}

function ProbabilityHistogram({ label, histogram, threshold, disabled, onThresholdChange, onThresholdCommit }) {
  const clipId = `inference-histogram-selection-${useId().replaceAll(":", "")}`;
  const bins = Array.isArray(histogram?.bins) ? histogram.bins : [];
  if (bins.length !== 1001) return null;
  const normalizedThreshold = normalizeThreshold(threshold) ?? 0.5;
  const thresholdX = normalizedThreshold * 100;
  const areaPath = histogramAreaPath(histogram);

  return (
    <section className="inference-histogram">
      <div className="inference-histogram-heading">
        <h3>{label}</h3>
        <span>{histogram.areaPx.toLocaleString()} px</span>
      </div>
      <div className="inference-histogram-chart">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label} probability histogram`}>
          <defs>
            <clipPath id={clipId}>
              <rect x={thresholdX} y="0" width={100 - thresholdX} height="40" />
            </clipPath>
          </defs>
          <path className="inference-histogram-area" d={areaPath} />
          <path className="inference-histogram-selected-area" d={areaPath} clipPath={`url(#${clipId})`} />
          <line x1={thresholdX} x2={thresholdX} y1="0" y2="40" />
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
  const [roiDirty, setRoiDirty] = useState(false);
  const [savingRoi, setSavingRoi] = useState(false);
  const [cellBounds, setCellBounds] = useState(null);
  const [activeCellBoundaryId, setActiveCellBoundaryId] = useState(null);
  const [stageTool, setStageTool] = useState("roi");
  const [showCellBoundaries, setShowCellBoundaries] = useState(true);
  const [cellBoundaryPointOpacity, setCellBoundaryPointOpacity] = useState(() => {
    const stored = Number(localStorage.getItem(CELL_BOUNDARY_POINT_OPACITY_KEY));
    return stored >= 0.1 && stored <= 1 ? stored : DEFAULT_POINT_OPACITY;
  });
  const [dragCellPoint, setDragCellPoint] = useState(null);
  const [hoverCellPointId, setHoverCellPointId] = useState(null);
  const [savingCellBoundaries, setSavingCellBoundaries] = useState(false);
  const [cellBoundaryDirty, setCellBoundaryDirty] = useState(false);
  const [overlayRevision, setOverlayRevision] = useState(0);
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
  const [downloadingOutputs, setDownloadingOutputs] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(null);
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
  const cellPointerRef = useRef(null);
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
  const cellBoundaryPolygons = useMemo(
    () => polygonsFromCellBoundaries(cellBounds),
    [cellBounds],
  );
  const clientHistograms = useMemo(() => ({
    wholeImage: probabilityHistogram(review?.probabilityMap, null, cellBoundaryPolygons),
    roi: inferenceRoi ? probabilityHistogram(review?.probabilityMap, inferenceRoi, cellBoundaryPolygons) : null,
  }), [cellBoundaryPolygons, inferenceRoi, review?.probabilityMap]);
  const clientAreaMetrics = useMemo(() => ({
    wholeImage: histogramMetrics(clientHistograms.wholeImage, activeThreshold),
    roi: histogramMetrics(clientHistograms.roi, activeThreshold),
  }), [activeThreshold, clientHistograms]);
  const overlayUrl = reviewReady && overlay &&
    overlay.rootPath === activeRootPath &&
    overlay.imageId === activeCompleteImage?.id &&
    overlay.threshold === activeThreshold
    ? overlay.url
    : null;
  const inferenceRunning = job?.status === "running";
  const visibleInferenceRoi = draftInferenceRoi ?? inferenceRoi;
  const activeCellBoundary = cellBounds?.groups.find((group) => group.id === activeCellBoundaryId) ?? null;
  const visibleCellBoundaries = showCellBoundaries
    ? (cellBounds?.groups ?? []).filter(cellBoundaryVisible)
    : [];

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
    setRoiDirty(false);
    setCellBounds(null);
    setActiveCellBoundaryId(null);
    setCellBoundaryDirty(false);
    setDragCellPoint(null);
    setHoverCellPointId(null);
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
    if (!activeRootPath) return undefined;
    let alive = true;
    fetch("/api/inference/roi")
      .then((response) => readJsonResponse(response, "Unable to load saved ROI."))
      .then((payload) => {
        if (!alive) return;
        setInferenceRoi(payload?.roi ?? null);
        setRoiDirty(false);
      })
      .catch((loadError) => {
        if (alive) setError(loadError.message);
      });
    return () => { alive = false; };
  }, [activeRootPath]);

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

    loadRaw16Image(image.id)
      .then((loadedImage) => {
        if (!alive) return;
        setRawImage({
          imageId: image.id,
          rootPath: sourceRootPath,
          ...loadedImage,
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
    if (!activeImage) {
      setCellBounds(null);
      setActiveCellBoundaryId(null);
      setCellBoundaryDirty(false);
      return undefined;
    }

    let alive = true;
    setCellBounds(null);
    setActiveCellBoundaryId(null);
    setCellBoundaryDirty(false);
    setDragCellPoint(null);
    setHoverCellPointId(null);
    fetch(`/api/inference/images/${encodeURIComponent(activeImage.id)}/cell-boundaries`)
      .then((response) => readJsonResponse(response, "Unable to load cell boundaries."))
      .then((payload) => {
        if (!alive || !payload?.bounds) return;
        const bounds = payload.bounds;
        setCellBounds(clampBoundsToImage(bounds, bounds.width, bounds.height));
        setActiveCellBoundaryId(bounds.groups?.[0]?.id ?? null);
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
        setOverlay({ ...source, url: objectUrl, blob });
      })
      .catch((loadError) => {
        if (alive) setError(loadError.message);
      });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeCompleteImage, activeRootPath, overlayRevision, reviewReady, thresholdDraft]);

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
      if (cellBoundaryDirty && !await saveCellBoundaries()) return;
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
      if (cellBoundaryDirty && !await saveCellBoundaries()) return;
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

  async function handleDownloadInferenceZip() {
    if (completeImages.length === 0 || !inferenceRoi || cellBoundaryDirty || downloadingOutputs) return;
    setDownloadingOutputs(true);
    setDownloadProgress(null);
    setError("");
    setActionMessage("");
    try {
      if (activeCompleteImage && reviewReady && !await persistThreshold({ showMessage: false })) return;
      await downloadAllInferenceOutputs({
        images: completeImages,
        onProgress: setDownloadProgress,
        loadImageOutputs: async (image) => {
          const [imageReview, imageRaw] = await Promise.all([
            readJsonResponse(await fetch(reviewUrl(image.id, inferenceRoi)), "Unable to load inference review."),
            loadRaw16Image(image.id),
          ]);
          const threshold = normalizeThreshold(Number(imageReview.threshold));
          if (threshold === null) throw new Error(`Invalid threshold for ${image.imageFile}.`);
          const excludedPolygons = polygonsFromCellBoundaries(imageReview.cellBoundaries);
          const histograms = {
            wholeImage: probabilityHistogram(imageReview.probabilityMap, null, excludedPolygons),
            roi: probabilityHistogram(imageReview.probabilityMap, inferenceRoi, excludedPolygons),
          };
          if (!histograms.wholeImage || !histograms.roi) {
            throw new Error(`Unable to calculate histograms for ${image.imageFile}.`);
          }
          const overlayResponse = await fetch(
            `/api/inference/images/${encodeURIComponent(image.id)}/overlay?threshold=${threshold.toFixed(3)}`,
          );
          if (!overlayResponse.ok) throw new Error(`Unable to load the binary mask overlay for ${image.imageFile}.`);
          const sourceCanvas = document.createElement("canvas");
          renderRaw16ToCanvas(sourceCanvas, imageRaw);
          return {
            sourceCanvas,
            overlayBlob: await overlayResponse.blob(),
            roi: inferenceRoi,
            histograms,
            metrics: {
              wholeImage: histogramMetrics(histograms.wholeImage, threshold),
              roi: histogramMetrics(histograms.roi, threshold),
            },
            threshold,
            imageFile: image.imageFile,
          };
        },
      });
      setActionMessage("Inference ZIP downloaded");
    } catch (downloadError) {
      setError(downloadError.message);
    } finally {
      setDownloadingOutputs(false);
      setDownloadProgress(null);
    }
  }

  function navigateComplete(offset) {
    const nextImage = completeImages[activeCompleteIndex + offset];
    if (!nextImage) return;
    setActionMessage("");
    setOverlay(null);
    setActiveImageId(nextImage.id);
  }

  useEffect(() => {
    localStorage.setItem(CELL_BOUNDARY_POINT_OPACITY_KEY, String(cellBoundaryPointOpacity));
  }, [cellBoundaryPointOpacity]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) {
        return;
      }
      if (event.code === "KeyP") {
        event.preventDefault();
        addCellBoundaryPoint();
      } else if (event.code === "KeyD") {
        event.preventDefault();
        mutateCellBounds((current) => deleteNearestPoint(current, activeCellBoundaryId, cellPointerRef.current));
      } else if (event.code === "KeyM") {
        event.preventDefault();
        mutateCellBounds((current) => moveNearestPoint(current, activeCellBoundaryId, cellPointerRef.current));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function mutateCellBounds(mutator) {
    setCellBounds((current) => {
      if (!current) return current;
      const next = mutator(current);
      if (next !== current) setCellBoundaryDirty(true);
      return next;
    });
  }

  function addCellBoundary() {
    mutateCellBounds((current) => {
      const next = addGroup(current);
      const group = next.groups[next.groups.length - 1];
      setActiveCellBoundaryId(group.id);
      return renameGroup(next, group.id, `Boundary ${next.groups.length}`);
    });
    setStageTool("boundary");
  }

  function deleteCellBoundary() {
    if (!activeCellBoundaryId) return;
    mutateCellBounds((current) => {
      const next = deleteGroup(current, activeCellBoundaryId);
      setActiveCellBoundaryId(next.groups[0]?.id ?? null);
      return next;
    });
    setHoverCellPointId(null);
  }

  function addCellBoundaryPoint(point = cellPointerRef.current) {
    if (!point || !cellBounds) return;
    mutateCellBounds((current) => {
      let next = current;
      let groupId = activeCellBoundaryId;
      if (!groupId) {
        next = addGroup(current);
        const group = next.groups[next.groups.length - 1];
        groupId = group.id;
        next = renameGroup(next, groupId, `Boundary ${next.groups.length}`);
        setActiveCellBoundaryId(groupId);
      }
      const group = next.groups.find((candidate) => candidate.id === groupId);
      const insertIndex = group?.points.length >= 2
        ? findNearestSegment(group.points, point, cellSegmentInsertThresholdSquared())?.insertIndex ?? null
        : null;
      return addPoint(next, groupId, point, { insertIndex });
    });
  }

  function cellSegmentInsertThresholdSquared() {
    const rect = canvasRef.current?.getBoundingClientRect?.();
    if (!rawImage || !rect?.width || !rect?.height) {
      return SEGMENT_INSERT_IMAGE_THRESHOLD ** 2;
    }
    const unitsPerScreenPixel = Math.max(rawImage.width / rect.width, rawImage.height / rect.height);
    return (SEGMENT_INSERT_SCREEN_THRESHOLD * unitsPerScreenPixel) ** 2;
  }

  async function saveCellBoundaries() {
    if (!activeImage || !cellBounds || savingCellBoundaries) return false;
    setSavingCellBoundaries(true);
    setError("");
    try {
      const payload = await readJsonResponse(await fetch(
        `/api/inference/images/${encodeURIComponent(activeImage.id)}/cell-boundaries`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cellBounds),
        },
      ), "Unable to save cell boundaries.");
      setCellBounds(payload.bounds);
      setCellBoundaryDirty(false);
      setOverlay(null);
      setOverlayRevision((current) => current + 1);
      if (activeCompleteImage?.id === activeImage.id) await loadReview(activeImage.id, inferenceRoi);
      setActionMessage("Cell boundaries saved for this image");
      return true;
    } catch (saveError) {
      setError(saveError.message);
      return false;
    } finally {
      setSavingCellBoundaries(false);
    }
  }

  async function saveRoi() {
    if (savingRoi || !roiDirty) return;
    setSavingRoi(true);
    setError("");
    try {
      const payload = await readJsonResponse(await fetch("/api/inference/roi", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roi: inferenceRoi }),
      }), "Unable to save ROI.");
      setInferenceRoi(payload.roi ?? null);
      setRoiDirty(false);
      setActionMessage(payload.roi ? "ROI saved" : "Saved ROI cleared");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSavingRoi(false);
    }
  }

  function stagePixelPoint(event) {
    if (!rawImageMatchesActive || !rawImage?.width || !rawImage?.height) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    const scale = Math.min(bounds.width / rawImage.width, bounds.height / rawImage.height);
    const renderedWidth = rawImage.width * scale;
    const renderedHeight = rawImage.height * scale;
    const left = bounds.left + (bounds.width - renderedWidth) / 2;
    const top = bounds.top + (bounds.height - renderedHeight) / 2;
    if (
      event.clientX < left || event.clientX > left + renderedWidth ||
      event.clientY < top || event.clientY > top + renderedHeight
    ) {
      return null;
    }
    return {
      x: Math.max(0, Math.min(rawImage.width, Math.round(((event.clientX - left) / renderedWidth) * rawImage.width))),
      y: Math.max(0, Math.min(rawImage.height, Math.round(((event.clientY - top) / renderedHeight) * rawImage.height))),
    };
  }

  function handleRoiPointerDown(event) {
    if (stageView === "mask" && stageTool !== "boundary") return;
    const point = stagePixelPoint(event);
    if (!point) return;
    cellPointerRef.current = point;
    if (stageTool === "boundary") return;
    roiDragStartRef.current = point;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraftInferenceRoi({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function handleRoiPointerMove(event) {
    const point = stagePixelPoint(event);
    if (point) cellPointerRef.current = point;
    if (dragCellPoint && point) {
      mutateCellBounds((current) => movePoint(current, dragCellPoint.groupId, dragCellPoint.pointId, point));
      return;
    }
    if (stageTool === "boundary") return;
    const start = roiDragStartRef.current;
    if (!start) return;
    if (!point) return;
    setDraftInferenceRoi(rectangleFromPoints(start, point) ?? { x: start.x, y: start.y, width: 0, height: 0 });
  }

  function commitRoiPointer(event) {
    if (dragCellPoint) {
      setDragCellPoint(null);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      return;
    }
    if (stageTool === "boundary") return;
    const start = roiDragStartRef.current;
    if (!start) return;
    roiDragStartRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const point = stagePixelPoint(event);
    const nextRoi = point ? rectangleFromPoints(start, point) : null;
    setDraftInferenceRoi(null);
    if (nextRoi) {
      setInferenceRoi(nextRoi);
      setRoiDirty(true);
    }
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
          <div className="inference-stage-tools" role="group" aria-label="Stage tool">
            <button type="button" aria-pressed={stageTool === "roi"} onClick={() => setStageTool("roi")}>ROI</button>
            <button type="button" aria-pressed={stageTool === "boundary"} onClick={() => setStageTool("boundary")}>Cell boundary</button>
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
              <svg
                className="inference-roi-overlay"
                viewBox={`0 0 ${rawImage.width} ${rawImage.height}`}
                preserveAspectRatio="xMidYMid meet"
              >
                <rect
                  className="inference-roi-rectangle"
                  aria-label="Common inference ROI"
                  x={visibleInferenceRoi.x}
                  y={visibleInferenceRoi.y}
                  width={visibleInferenceRoi.width}
                  height={visibleInferenceRoi.height}
                />
              </svg>
            ) : null}
            {rawImageMatchesActive && visibleCellBoundaries.length ? (
              <svg
                className="inference-cell-boundary-overlay"
                viewBox={`0 0 ${rawImage.width} ${rawImage.height}`}
                role="img"
                aria-label="Cell boundary overlay"
              >
                {visibleCellBoundaries.map((boundary) => {
                  const pointString = boundary.points.map((point) => `${point.x},${point.y}`).join(" ");
                  return (
                    <g key={boundary.id} opacity={cellBoundaryPointOpacity}>
                      {boundary.points.length >= 3 ? (
                        <polygon points={pointString} fill={boundary.color} fillOpacity="0.12" stroke={boundary.color} strokeWidth="1.5" />
                      ) : (
                        <polyline points={pointString} fill="none" stroke={boundary.color} strokeWidth="1.5" />
                      )}
                      {boundary.points.map((point) => (
                        <circle
                          key={point.id}
                          aria-label={`Cell boundary vertex ${point.id}`}
                          className={hoverCellPointId === point.id ? "highlighted" : undefined}
                          cx={point.x}
                          cy={point.y}
                          r={hoverCellPointId === point.id ? "5" : "3"}
                          fill={boundary.color}
                          stroke="#ffffff"
                          strokeWidth={hoverCellPointId === point.id ? "2" : "1"}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            event.currentTarget.setPointerCapture?.(event.pointerId);
                            setActiveCellBoundaryId(boundary.id);
                            setStageTool("boundary");
                            setDragCellPoint({ groupId: boundary.id, pointId: point.id });
                          }}
                        />
                      ))}
                    </g>
                  );
                })}
              </svg>
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
            <dd>{fractionLabel(clientAreaMetrics.wholeImage?.areaFraction ?? review?.wholeImage?.areaFraction)}</dd>
          </div>
          {review?.roi ? (
            <div>
              <dt>ROI area fraction</dt>
              <dd>{fractionLabel(clientAreaMetrics.roi?.areaFraction ?? review.roi.metrics?.areaFraction)}</dd>
            </div>
          ) : null}
        </dl>

        <div className="inference-roi-status">
          <span>{inferenceRoi ? "Common rectangle ROI" : "Whole image"}</span>
          {inferenceRoi ? (
            <button type="button" onClick={() => { setInferenceRoi(null); setRoiDirty(true); }}>
              Clear ROI
            </button>
          ) : null}
          <button type="button" onClick={saveRoi} disabled={!roiDirty || savingRoi}>
            {savingRoi ? "Saving ROI" : inferenceRoi ? "Save ROI" : "Clear saved ROI"}
          </button>
        </div>

        <section className="inference-cell-boundaries" aria-label="Cell boundaries">
          <div className="inference-cell-boundary-heading">
            <h3>Cell boundaries</h3>
            <label>
              <input type="checkbox" checked={showCellBoundaries} onChange={(event) => setShowCellBoundaries(event.target.checked)} />
              Show all
            </label>
          </div>
          <div className="inference-cell-boundary-actions">
            <button type="button" onClick={addCellBoundary} disabled={!cellBounds}>Add boundary</button>
            <button type="button" onClick={saveCellBoundaries} disabled={!cellBounds || !cellBoundaryDirty || savingCellBoundaries}>
              {savingCellBoundaries ? "Saving" : "Save cell boundaries"}
            </button>
          </div>
          <div className="inference-cell-boundary-list">
            {cellBounds?.groups.map((boundary) => (
              <div className={boundary.id === activeCellBoundaryId ? "inference-cell-boundary-row active" : "inference-cell-boundary-row"} key={boundary.id}>
                <button type="button" onClick={() => { setActiveCellBoundaryId(boundary.id); setStageTool("boundary"); }}>
                  <span className="inference-cell-boundary-color" style={{ background: boundary.color }} />
                  {boundary.name}
                </button>
                <label title="Show this boundary">
                  <input
                    type="checkbox"
                    checked={cellBoundaryVisible(boundary)}
                    onChange={(event) => mutateCellBounds((current) => ({
                      ...current,
                      groups: current.groups.map((group) => group.id === boundary.id ? { ...group, visible: event.target.checked } : group),
                    }))}
                  />
                </label>
              </div>
            ))}
          </div>
          <label>
            Point opacity
            <input type="range" min="0.1" max="1" step="0.05" value={cellBoundaryPointOpacity} onChange={(event) => setCellBoundaryPointOpacity(Number(event.target.value))} />
          </label>
          {activeCellBoundary ? (
            <div className="inference-cell-point-order" aria-label="Cell boundary point order">
              <strong>{activeCellBoundary.name} point order</strong>
              {activeCellBoundary.points.map((point, index) => (
                <div
                  className={hoverCellPointId === point.id ? "inference-cell-point-row active" : "inference-cell-point-row"}
                  key={point.id}
                  onMouseEnter={() => setHoverCellPointId(point.id)}
                  onMouseLeave={() => setHoverCellPointId(null)}
                >
                  <button type="button" aria-label={`Move ${point.id} left`} disabled={index === 0} onClick={() => mutateCellBounds((current) => movePointOrder(current, activeCellBoundary.id, point.id, "left"))}>{"<"}</button>
                  <span>{index + 1}</span>
                  <button type="button" className="inference-cell-point-delete" aria-label={`Delete ${point.id}`} onClick={() => mutateCellBounds((current) => deletePoint(current, activeCellBoundary.id, point.id))}>Delete</button>
                  <button type="button" aria-label={`Move ${point.id} right`} disabled={index === activeCellBoundary.points.length - 1} onClick={() => mutateCellBounds((current) => movePointOrder(current, activeCellBoundary.id, point.id, "right"))}>{">"}</button>
                </div>
              ))}
              <button type="button" className="danger" onClick={deleteCellBoundary}>Delete boundary</button>
            </div>
          ) : null}
        </section>

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
        <div className="inference-footer-actions">
          <button type="button" onClick={handleGenerateMasks} disabled={!reviewReady || generating}>
            Generate masks
          </button>
          <button
            type="button"
            onClick={handleDownloadInferenceZip}
            aria-busy={downloadingOutputs}
            title={!inferenceRoi ? "Set an ROI before downloading" : cellBoundaryDirty ? "Save cell boundaries before downloading" : completeImages.length === 0 ? "No completed images to download" : undefined}
            disabled={completeImages.length === 0 || !inferenceRoi || cellBoundaryDirty || downloadingOutputs}
          >
            {downloadingOutputs && downloadProgress
              ? `Preparing ${downloadProgress.current} / ${downloadProgress.total}...`
              : downloadingOutputs ? "Preparing ZIP..." : "Download all inference ZIP"}
          </button>
        </div>
      </footer>
    </div>
  );
}
