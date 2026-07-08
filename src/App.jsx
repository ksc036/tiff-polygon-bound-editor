import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addGroup,
  addPoint,
  clampBoundsToImage,
  clearGroupMigrationVector,
  createEmptyBounds,
  deleteGroup,
  deleteNearestPoint,
  deletePoint,
  moveNearestPoint,
  movePoint,
  movePointOrder,
  renameGroup,
  setGroupAnalysisMode,
  setGroupMigrationVector,
  setGroupRoiLimits,
} from "./lib/editorState.js";
import { findNearestSegment } from "./lib/geometry.js";
import { renderRaw16ToCanvas } from "./lib/raw16Renderer.js";
import { fitAspectToBox } from "./lib/stageFit.js";

const OPACITY_KEY = "raw16-editor-point-opacity";
const DEFAULT_OPACITY = 0.85;
const SEGMENT_INSERT_SCREEN_THRESHOLD = 8;
const SEGMENT_INSERT_IMAGE_THRESHOLD = 8;
const GROUP_COLORS = ["#e11d48", "#2563eb", "#16a34a", "#ca8a04", "#9333ea"];
const DEFAULT_ROI_LIMITS = { near: 20, mid: 50, far: 100 };
const ROI_BAND_IDS = ["near", "mid", "far"];
const ROI_BAND_LABELS = { near: "가까움", mid: "중간", far: "멀리" };
const ROI_BAND_COLORS = { near: "#ef4444", mid: "#f59e0b", far: "#3b82f6" };
const ROI_MIN_LIMIT = 1;
const ROI_LIMIT_STEP = 1;
const POINT_ORDER_COLLAPSED_STAGE_GAIN = 24;
const ROI_SETTINGS_COLLAPSED_STAGE_GAIN = 56;
const ANALYSIS_PANEL_HEIGHT_KEY = "raw16-editor-analysis-panel-height";
const DEFAULT_ANALYSIS_PANEL_HEIGHT = 210;
const MIN_ANALYSIS_PANEL_HEIGHT = 120;
const MAX_ANALYSIS_PANEL_HEIGHT = 520;
const ANALYSIS_MODE_LABELS = { outside: "Outside ROI", inside: "Inside area" };
const ANALYSIS_COLUMNS = [
  {
    key: "roiAreaPx",
    label: "Area",
    help: "ROI area in pixels for this boundary distance band.",
    format: formatInteger,
  },
  {
    key: "maskPixelCount",
    label: "Pixels",
    help: "Foreground mask pixels inside this ROI.",
    format: formatInteger,
  },
  {
    key: "density",
    label: "Density",
    help: "Mask pixels divided by ROI area.",
    format: formatMetric,
  },
  {
    key: "globalAlignment",
    label: "Alignment",
    help: "ROI-wide nematic order parameter from all fiber segment angles. Higher means angles concentrate around one axis.",
    format: formatMetric,
  },
  {
    key: "circularVariance",
    label: "Circ Var",
    help: "Circular variance, calculated as 1 minus Alignment. Lower means stronger alignment.",
    format: formatMetric,
  },
  {
    key: "radialNormalAlignment",
    label: "Radial",
    help: "Signed target-angle alignment with the outward boundary normal. 1 parallel, 0 random, -1 perpendicular.",
    format: formatMetric,
  },
  {
    key: "tangentialAlignment",
    label: "Tangent",
    help: "Signed target-angle alignment with the nearest boundary tangent. 1 parallel, 0 random, -1 perpendicular.",
    format: formatMetric,
  },
  {
    key: "migrationAlignment",
    label: "Migration",
    help: "Signed target-angle alignment with the group migration vector. 1 parallel, 0 random, -1 perpendicular.",
    format: formatMetric,
  },
];

export default function App() {
  const canvasRef = useRef(null);
  const stageFrameRef = useRef(null);
  const loadRequestRef = useRef(0);
  const pointerRef = useRef(null);
  const [rootPath, setRootPath] = useState("");
  const [images, setImages] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [bounds, setBounds] = useState(null);
  const [hasBounds, setHasBounds] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState(null);
  const [pointer, setPointer] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [displayMin, setDisplayMin] = useState(0);
  const [displayMax, setDisplayMax] = useState(65535);
  const [rawPixels, setRawPixels] = useState(null);
  const [dragPoint, setDragPoint] = useState(null);
  const [hoverPointId, setHoverPointId] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState("No analysis");
  const [analysisError, setAnalysisError] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [activeMetricHelp, setActiveMetricHelp] = useState(null);
  const [imageLayer, setImageLayer] = useState("original");
  const [showRoiOverlay, setShowRoiOverlay] = useState(true);
  const [pointOrderOpen, setPointOrderOpen] = useState(true);
  const [roiSettingsOpen, setRoiSettingsOpen] = useState(true);
  const [migrationDraft, setMigrationDraft] = useState(null);
  const [groupDrawVisibility, setGroupDrawVisibility] = useState({});
  const [groupStatsVisibility, setGroupStatsVisibility] = useState({});
  const [groupVectorVisibility, setGroupVectorVisibility] = useState({});
  const [stageDisplaySize, setStageDisplaySize] = useState(null);
  const [analysisPanelHeight, setAnalysisPanelHeight] = useState(() => {
    const storedValue = localStorage.getItem(ANALYSIS_PANEL_HEIGHT_KEY);
    if (storedValue === null) return DEFAULT_ANALYSIS_PANEL_HEIGHT;

    const stored = Number(storedValue);
    return Number.isFinite(stored)
      ? clamp(stored, MIN_ANALYSIS_PANEL_HEIGHT, MAX_ANALYSIS_PANEL_HEIGHT)
      : DEFAULT_ANALYSIS_PANEL_HEIGHT;
  });
  const [analysisResizeDrag, setAnalysisResizeDrag] = useState(null);
  const [pointOpacity, setPointOpacity] = useState(() => {
    const stored = Number(localStorage.getItem(OPACITY_KEY));
    return stored >= 0.1 && stored <= 1 ? stored : DEFAULT_OPACITY;
  });

  const activeImage = activeIndex >= 0 ? resolveImageDimensions(images[activeIndex], rawPixels, bounds) : null;
  const activeGroup = bounds?.groups.find((group) => group.id === activeGroupId) ?? null;
  const activeRoiLimits = groupRoiLimits(activeGroup);
  const activeGroupUsesOutsideRoi = (activeGroup?.analysisMode ?? "outside") === "outside";
  const hasActiveImageDimensions = hasImageDimensions(activeImage);
  const activeImageAspect = hasActiveImageDimensions ? activeImage.width / activeImage.height : 4 / 3;
  const collapsedPanelSpacePx =
    (pointOrderOpen ? 0 : POINT_ORDER_COLLAPSED_STAGE_GAIN) +
    (roiSettingsOpen ? 0 : ROI_SETTINGS_COLLAPSED_STAGE_GAIN);
  const analysisPanelStageAdjustPx = DEFAULT_ANALYSIS_PANEL_HEIGHT - analysisPanelHeight;

  const loadImage = useCallback(
    async (index, nextImages) => {
      const requestId = (loadRequestRef.current += 1);
      const isCurrentRequest = () => requestId === loadRequestRef.current;
      const image = nextImages[index];
      if (!image) {
        setActiveIndex(-1);
        setBounds(null);
        setActiveGroupId(null);
        setMigrationDraft(null);
        setGroupDrawVisibility({});
        setGroupStatsVisibility({});
        setGroupVectorVisibility({});
        clearAnalysisState();
        return;
      }

      setActiveIndex(index);
      clearPointer();
      setMigrationDraft(null);
      setGroupDrawVisibility({});
      setGroupStatsVisibility({});
      setGroupVectorVisibility({});
      setRawPixels(null);
      setStatus("Loading image");
      clearAnalysisState("Loading analysis");

      try {
        const boundsPayload = await readJsonResponse(await fetch(`/api/images/${image.id}/bounds`));
        if (!isCurrentRequest()) return;
        const nextBounds = normalizeAndClampBounds(boundsPayload.bounds, image);
        setBounds(nextBounds);
        setHasBounds(Boolean(boundsPayload.hasBounds));
        setActiveGroupId(nextBounds.groups[0]?.id ?? null);
        setDirty(false);
        setStatus(boundsPayload.hasBounds ? "Saved bound loaded" : "No saved bound");
      } catch (error) {
        if (!isCurrentRequest()) return;
        const emptyBounds = normalizeAndClampBounds(createEmptyBounds(image), image);
        setBounds(emptyBounds);
        setHasBounds(false);
        setActiveGroupId(null);
        setDirty(false);
        setStatus(`Bound load failed: ${error.message}`);
      }

      try {
        const analysisPayload = await readJsonResponse(await fetch(`/api/images/${image.id}/analysis`));
        if (!isCurrentRequest()) return;
        applyAnalysisPayload(analysisPayload, analysisPayload.hasAnalysis ? "Analysis loaded" : "No analysis");
      } catch (error) {
        if (!isCurrentRequest()) return;
        setAnalysis(null);
        setHasAnalysis(false);
        setAnalysisError(error.message);
        setAnalysisStatus(`Analysis load failed: ${error.message}`);
      }

      try {
        const rawResponse = await fetch(`/api/images/${image.id}/raw16`);
        if (!rawResponse.ok) {
          throw new Error("Unable to read image pixels.");
        }
        const buffer = await rawResponse.arrayBuffer();
        if (!isCurrentRequest()) return;
        const width = Number(rawResponse.headers.get("x-image-width")) || image.width;
        const height = Number(rawResponse.headers.get("x-image-height")) || image.height;
        const min = Number(rawResponse.headers.get("x-display-min"));
        const max = Number(rawResponse.headers.get("x-display-max"));
        const imageWithDimensions = { ...image, width, height };
        setDisplayMin(Number.isFinite(min) ? min : 0);
        setDisplayMax(Number.isFinite(max) ? max : 65535);
        setImages((currentImages) =>
          currentImages.map((candidate) =>
            candidate.id === image.id ? { ...candidate, width, height } : candidate,
          ),
        );
        setBounds((currentBounds) =>
          currentBounds ? normalizeAndClampBounds(currentBounds, imageWithDimensions) : currentBounds,
        );
        setRawPixels({ pixels: new Uint16Array(buffer), width, height });
      } catch {
        if (!isCurrentRequest()) return;
        setRawPixels(null);
      }
    },
    [],
  );

  useEffect(() => {
    let alive = true;

    async function loadRoot() {
      try {
        const payload = await readJsonResponse(await fetch("/api/root"));
        if (!alive) return;
        const nextImages = payload.images ?? [];
        setRootPath(payload.rootPath ?? "");
        setImages(nextImages);
        if (nextImages.length > 0) {
          await loadImage(0, nextImages);
        }
      } catch {
        if (alive) setStatus("Root unavailable");
      }
    }

    loadRoot();
    return () => {
      alive = false;
    };
  }, [loadImage]);

  useEffect(() => {
    localStorage.setItem(OPACITY_KEY, String(pointOpacity));
  }, [pointOpacity]);

  useEffect(() => {
    localStorage.setItem(ANALYSIS_PANEL_HEIGHT_KEY, String(analysisPanelHeight));
  }, [analysisPanelHeight]);

  useEffect(() => {
    if (!analysisResizeDrag) return undefined;

    function handleResizeMove(event) {
      const clientY = eventClientY(event);
      if (clientY === null) return;

      const nextHeight = analysisResizeDrag.startHeight + (analysisResizeDrag.startY - clientY);
      setAnalysisPanelHeight(
        clamp(Math.round(nextHeight), MIN_ANALYSIS_PANEL_HEIGHT, MAX_ANALYSIS_PANEL_HEIGHT),
      );
    }

    function handleResizeEnd() {
      setAnalysisResizeDrag(null);
    }

    window.addEventListener("pointermove", handleResizeMove);
    window.addEventListener("pointerup", handleResizeEnd);
    window.addEventListener("pointercancel", handleResizeEnd);

    return () => {
      window.removeEventListener("pointermove", handleResizeMove);
      window.removeEventListener("pointerup", handleResizeEnd);
      window.removeEventListener("pointercancel", handleResizeEnd);
    };
  }, [analysisResizeDrag]);

  useEffect(() => {
    const frame = stageFrameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") {
      setStageDisplaySize(null);
      return undefined;
    }

    function updateStageDisplaySize(contentRect) {
      const nextSize = fitAspectToBox({
        boxWidth: contentRect.width,
        boxHeight: contentRect.height,
        aspectRatio: activeImageAspect,
      });
      setStageDisplaySize((current) => (sameStageDisplaySize(current, nextSize) ? current : nextSize));
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === frame) ?? entries[0];
      if (entry?.contentRect) {
        updateStageDisplaySize(entry.contentRect);
      }
    });

    observer.observe(frame);
    updateStageDisplaySize(frame.getBoundingClientRect());

    return () => observer.disconnect();
  }, [activeImageAspect]);

  useEffect(() => {
    if (!canvasRef.current || !rawPixels) return;
    renderRaw16ToCanvas(canvasRef.current, {
      pixels: rawPixels.pixels,
      width: rawPixels.width,
      height: rawPixels.height,
      min: Number(displayMin),
      max: Number(displayMax),
    });
  }, [displayMax, displayMin, rawPixels]);

  const replaceRoot = async (endpoint, body) => {
    if (!confirmReplaceDirty()) return;

    try {
      const payload = await readJsonResponse(
        await fetch(endpoint, {
          method: "POST",
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
      const nextImages = payload.images ?? [];
      setRootPath(payload.rootPath ?? body?.rootPath ?? "");
      setImages(nextImages);
      setDirty(false);
      if (nextImages.length > 0) {
        await loadImage(0, nextImages);
      } else {
        loadRequestRef.current += 1;
        setActiveIndex(-1);
        setBounds(null);
        setActiveGroupId(null);
        setRawPixels(null);
        clearAnalysisState();
        setStatus("No images found");
      }
    } catch (error) {
      setStatus(`Root change failed: ${error.message}`);
    }
  };

  const confirmReplaceDirty = () => !dirty || window.confirm("Replace unsaved local edits?");

  const navigateTo = useCallback(
    async (nextIndex) => {
      if (nextIndex < 0 || nextIndex >= images.length || nextIndex === activeIndex) return;
      if (!confirmReplaceDirty()) return;
      await loadImage(nextIndex, images);
    },
    [activeIndex, dirty, images, loadImage],
  );

  useEffect(() => {
    function handleKeyDown(event) {
      if (isEditableTarget(event.target)) return;

      if (event.code === "ArrowLeft") {
        event.preventDefault();
        navigateTo(activeIndex - 1);
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        navigateTo(activeIndex + 1);
      } else if (event.code === "KeyP") {
        event.preventDefault();
        addPointAtPointer();
      } else if (event.code === "KeyD") {
        event.preventDefault();
        mutateBounds((current) => deleteNearestPoint(current, activeGroupId, pointerRef.current), "Point deleted");
      } else if (event.code === "KeyM") {
        event.preventDefault();
        mutateBounds((current) => moveNearestPoint(current, activeGroupId, pointerRef.current), "Point moved");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function mutateBounds(mutator, nextStatus) {
    setBounds((current) => {
      if (!current) return current;
      const nextBounds = mutator(current);
      if (nextBounds !== current) {
        setDirty(true);
        setStatus(nextStatus);
      }
      return nextBounds;
    });
  }

  function setCurrentPointer(nextPointer) {
    pointerRef.current = nextPointer;
    setPointer(nextPointer);
  }

  function clearPointer() {
    pointerRef.current = null;
    setPointer(null);
  }

  function clearAnalysisState(nextStatus = "No analysis") {
    setAnalysis(null);
    setHasAnalysis(false);
    setAnalysisStatus(nextStatus);
    setAnalysisError("");
    setAnalysisLoading(false);
  }

  function applyAnalysisPayload(payload, nextStatus) {
    const nextAnalysis = payload?.analysis ?? null;
    setAnalysis(nextAnalysis);
    setHasAnalysis(Boolean(payload?.hasAnalysis && nextAnalysis));
    setAnalysisStatus(nextAnalysis ? nextStatus : "No analysis");
    setAnalysisError("");
  }

  function addPointAtPointer(point = pointerRef.current) {
    if (!point) {
      setStatus("Pointer outside image");
      return;
    }

    mutateBounds((current) => {
      let nextBounds = current;
      let groupId = activeGroupId;

      if (!groupId) {
        nextBounds = addGroup(current);
        groupId = nextBounds.groups[nextBounds.groups.length - 1]?.id ?? null;
        setActiveGroupId(groupId);
      }

      const insertIndex = groupId ? findSegmentInsertIndex(nextBounds, groupId, point) : null;
      return groupId ? addPoint(nextBounds, groupId, point, { insertIndex }) : nextBounds;
    }, "Point added");
  }

  function findSegmentInsertIndex(currentBounds, groupId, point) {
    const group = currentBounds.groups.find((candidate) => candidate.id === groupId);
    if (!group || group.points.length < 2) {
      return null;
    }

    const nearestSegment = findNearestSegment(
      group.points,
      point,
      segmentInsertThresholdSquared(),
    );
    return nearestSegment?.insertIndex ?? null;
  }

  function segmentInsertThresholdSquared() {
    const rect = canvasRef.current?.getBoundingClientRect?.();
    if (!activeImage || !rect || rect.width <= 0 || rect.height <= 0) {
      return SEGMENT_INSERT_IMAGE_THRESHOLD * SEGMENT_INSERT_IMAGE_THRESHOLD;
    }

    const unitsPerScreenPixel = Math.max(activeImage.width / rect.width, activeImage.height / rect.height);
    const threshold = SEGMENT_INSERT_SCREEN_THRESHOLD * unitsPerScreenPixel;
    return threshold * threshold;
  }

  function handleStagePointerMove(event) {
    if (!hasActiveImageDimensions) return;
    const nextPointer = eventToImagePoint(event, activeImage, {
      allowOutside: Boolean(dragPoint),
      contentRect: imageContentRect(canvasRef.current, event.currentTarget),
    });
    if (!nextPointer) return;

    setCurrentPointer(nextPointer);
    if (dragPoint) {
      mutateBounds(
        (current) => movePoint(current, dragPoint.groupId, dragPoint.pointId, nextPointer),
        "Point moved",
      );
    }
  }

  function handleAddGroup() {
    mutateBounds((current) => {
      const nextBounds = addGroup(current);
      setActiveGroupId(nextBounds.groups[nextBounds.groups.length - 1].id);
      return nextBounds;
    }, "Group added");
  }

  function handleRenameGroup(name) {
    if (!activeGroupId) return;
    mutateBounds((current) => renameGroup(current, activeGroupId, name), "Group renamed");
  }

  function handleGroupAnalysisMode(analysisMode) {
    mutateBounds((current) => {
      let nextBounds = current;
      let groupId = activeGroupId;

      if (!groupId) {
        nextBounds = addGroup(current);
        groupId = nextBounds.groups[nextBounds.groups.length - 1]?.id ?? null;
        setActiveGroupId(groupId);
      }

      return groupId ? setGroupAnalysisMode(nextBounds, groupId, analysisMode) : nextBounds;
    }, "Group analysis mode changed");
  }

  function handleActiveGroupDrawVisibility(visible) {
    if (!activeGroupId) return;
    setGroupDrawVisibility((current) => ({ ...current, [activeGroupId]: visible }));
  }

  function handleActiveGroupStatsVisibility(visible) {
    if (!activeGroupId) return;
    setGroupStatsVisibility((current) => ({ ...current, [activeGroupId]: visible }));
  }

  function handleActiveGroupVectorVisibility(visible) {
    if (!activeGroupId) return;
    setGroupVectorVisibility((current) => ({ ...current, [activeGroupId]: visible }));
  }

  function handleAllGroupDisplayVisibility(visible) {
    if (!bounds?.groups.length) return;

    const nextVisibility = Object.fromEntries(bounds.groups.map((group) => [group.id, visible]));
    setGroupDrawVisibility(nextVisibility);
    setGroupStatsVisibility(nextVisibility);
  }

  function handleGroupDisplayVisibility(groupId, visible) {
    setGroupDrawVisibility((current) => ({ ...current, [groupId]: visible }));
    setGroupStatsVisibility((current) => ({ ...current, [groupId]: visible }));
  }

  function handleStartMigrationVector() {
    if (!activeGroupId) return;
    setMigrationDraft({ groupId: activeGroupId, start: null });
    setStatus("Click migration start");
  }

  function handleClearMigrationVector() {
    if (!activeGroupId) return;
    setMigrationDraft(null);
    mutateBounds((current) => clearGroupMigrationVector(current, activeGroupId), "Migration vector cleared");
  }

  function handleDeleteGroup() {
    if (!activeGroupId) return;
    setMigrationDraft(null);
    mutateBounds((current) => {
      const nextBounds = deleteGroup(current, activeGroupId);
      setActiveGroupId(nextBounds.groups[0]?.id ?? null);
      return nextBounds;
    }, "Group deleted");
  }

  function handleMovePointOrder(pointId, direction) {
    if (!activeGroupId) return;
    mutateBounds(
      (current) => movePointOrder(current, activeGroupId, pointId, direction),
      "Point order changed",
    );
  }

  function handleDeletePoint(pointId) {
    if (!activeGroupId) return;
    mutateBounds((current) => deletePoint(current, activeGroupId, pointId), "Point deleted");
    setHoverPointId(null);
  }

  function handleAnalysisResizeStart(event) {
    const clientY = eventClientY(event);
    if (clientY === null) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setAnalysisResizeDrag({
      startY: clientY,
      startHeight: analysisPanelHeight,
    });
  }

  function handleAnalysisResizeKeyDown(event) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setAnalysisPanelHeight((current) =>
        clamp(current + 20, MIN_ANALYSIS_PANEL_HEIGHT, MAX_ANALYSIS_PANEL_HEIGHT),
      );
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setAnalysisPanelHeight((current) =>
        clamp(current - 20, MIN_ANALYSIS_PANEL_HEIGHT, MAX_ANALYSIS_PANEL_HEIGHT),
      );
    }
  }

  function handleStageClick(event) {
    if (!hasActiveImageDimensions) return;
    const clickPoint = eventToImagePoint(event, activeImage, {
      contentRect: imageContentRect(canvasRef.current, event.currentTarget),
    });
    if (!clickPoint) return;

    setCurrentPointer(clickPoint);
    if (migrationDraft) {
      if (!migrationDraft.start) {
        setMigrationDraft({ ...migrationDraft, start: clickPoint });
        setStatus("Click migration end");
        return;
      }

      const targetGroupId = migrationDraft.groupId;
      mutateBounds(
        (current) =>
          setGroupMigrationVector(current, targetGroupId, {
            start: migrationDraft.start,
            end: clickPoint,
          }),
        "Migration vector set",
      );
      setMigrationDraft(null);
      return;
    }

    addPointAtPointer(clickPoint);
  }

  async function handleLoadSaved() {
    if (!activeImage || !confirmReplaceDirty()) return;
    await loadImage(activeIndex, images);
  }

  async function handleSave() {
    if (!activeImage || !bounds) return;
    const nextBounds = normalizeAndClampBounds(bounds, activeImage);

    try {
      const payload = await readJsonResponse(
        await fetch(`/api/images/${activeImage.id}/bounds`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(nextBounds),
        }),
      );
      setBounds(normalizeAndClampBounds(payload.bounds ?? nextBounds, activeImage));
      setHasBounds(true);
      setDirty(false);
      setStatus("Saved");
    } catch (error) {
      setStatus(`Save failed: ${error.message}`);
    }
  }

  async function handleImportPrevious() {
    if (!activeImage || !confirmReplaceDirty()) return;
    try {
      const payload = await readJsonResponse(
        await fetch(`/api/images/${activeImage.id}/bounds/import-previous`, {
          method: "POST",
        }),
      );
      const nextBounds = normalizeAndClampBounds(payload.bounds, activeImage);
      setBounds(nextBounds);
      setActiveGroupId(nextBounds.groups[0]?.id ?? null);
      setDirty(true);
      setStatus("Imported previous bound");
    } catch (error) {
      setStatus(`Import failed: ${error.message}`);
    }
  }

  async function handleRecalculateAnalysis() {
    if (!activeImage) return;
    setAnalysisLoading(true);
    setAnalysisStatus("Recalculating analysis");
    setAnalysisError("");

    try {
      const payload = await readJsonResponse(
        await fetch(`/api/images/${activeImage.id}/analysis/recalculate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            roiBands: deriveRoiBands(activeRoiLimits),
            roiBandsByGroup: roiBandsByGroup(bounds),
          }),
        }),
      );
      applyAnalysisPayload(payload, "Analysis recalculated");
    } catch (error) {
      setAnalysisError(error.message);
      setAnalysisStatus(`Analysis failed: ${error.message}`);
    } finally {
      setAnalysisLoading(false);
    }
  }

  function handleRoiLimitChange(bandId, value) {
    if (!activeGroupId) return;
    if (value === "") {
      mutateBounds(
        (current) => setGroupRoiLimits(current, activeGroupId, { ...groupRoiLimits(activeGroup), [bandId]: "" }),
        "ROI settings changed",
      );
      return;
    }

    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return;
    mutateBounds(
      (current) => setGroupRoiLimits(current, activeGroupId, { ...groupRoiLimits(activeGroup), [bandId]: nextValue }),
      "ROI settings changed",
    );
  }

  function handleRoiLimitCommit() {
    if (!activeGroupId) return;
    mutateBounds(
      (current) => setGroupRoiLimits(current, activeGroupId, normalizeRoiLimits(groupRoiLimits(activeGroup))),
      "ROI settings changed",
    );
  }

  function handleRoiLimitStep(bandId, delta) {
    if (!activeGroupId) return;
    const currentLimits = groupRoiLimits(activeGroup);
    mutateBounds(
      (current) =>
        setGroupRoiLimits(
          current,
          activeGroupId,
          normalizeRoiLimits({
            ...currentLimits,
            [bandId]: roiLimitNumber(currentLimits[bandId], DEFAULT_ROI_LIMITS[bandId]) + delta,
          }),
        ),
      "ROI settings changed",
    );
  }

  function handleRoiLimitKeyDown(event) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
      handleRoiLimitCommit();
    }
  }

  const polygons = useMemo(() => {
    if (!bounds) return [];
    return bounds.groups.map((group) => {
      const ordered = group.points;
      return {
        ...group,
        ordered,
        path: ordered.map((point) => `${point.x},${point.y}`).join(" "),
      };
    });
  }, [bounds]);
  const visiblePolygons = useMemo(
    () => polygons.filter((group) => groupVisible(groupDrawVisibility, group.id)),
    [groupDrawVisibility, polygons],
  );
  const visibleMigrationPolygons = useMemo(
    () =>
      visiblePolygons.filter(
        (group) => groupVisible(groupVectorVisibility, group.id) && validMigrationVector(group.migrationVector),
      ),
    [groupVectorVisibility, visiblePolygons],
  );
  const roiPreviewGroups = useMemo(
    () =>
      showRoiOverlay && activeImage && hasActiveImageDimensions
        ? buildRoiPreviewGroups(visiblePolygons, activeImage)
        : [],
    [activeImage?.height, activeImage?.width, hasActiveImageDimensions, showRoiOverlay, visiblePolygons],
  );
  const roiPreviewStatus = useMemo(() => {
    if (!showRoiOverlay) return "ROI preview hidden";
    if (!activeImage || !bounds || !hasActiveImageDimensions) return "ROI preview unavailable";
    if (!visiblePolygons.some((group) => group.points.length >= 3)) return "ROI preview needs polygon";
    return "ROI preview local";
  }, [activeImage, bounds, hasActiveImageDimensions, showRoiOverlay, visiblePolygons]);

  return (
    <main className="app-shell">
      <form
        className="top-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          replaceRoot("/api/root", { rootPath });
        }}
      >
        <button type="button" onClick={() => replaceRoot("/api/root/select")}>
          Find root
        </button>
        <label className="path-field" htmlFor="root-path">
          <span>Root path</span>
          <input
            id="root-path"
            name="rootPath"
            type="text"
            value={rootPath}
            placeholder="No root selected"
            onChange={(event) => setRootPath(event.target.value)}
          />
        </label>
        <button type="submit">Set root</button>
        <button
          type="button"
          aria-label="Previous image"
          disabled={activeIndex <= 0}
          onClick={() => navigateTo(activeIndex - 1)}
        >
          Prev
        </button>
        <div className="image-counter" aria-live="polite">
          <strong>{images.length ? `${activeIndex + 1} / ${images.length}` : "0 / 0"}</strong>
          <span>{activeImage?.folder ?? activeImage?.imageFolder ?? "No folder"}</span>
        </div>
        <button
          type="button"
          aria-label="Next image"
          disabled={activeIndex >= images.length - 1}
          onClick={() => navigateTo(activeIndex + 1)}
        >
          Next
        </button>
        <button type="button" disabled={!activeImage} onClick={handleLoadSaved}>
          Load saved bound
        </button>
        <button type="button" disabled={!activeImage || !bounds} onClick={handleSave}>
          Save
        </button>
        <button type="button" disabled={!activeImage} onClick={handleImportPrevious}>
          Import previous bound
        </button>
      </form>

      <aside className="side-panel" aria-label="Groups">
        <div className="panel-heading">
          <div className="panel-title-row">
            <h1>Groups</h1>
            <span className="status-chip">{activeGroup ? activeGroup.name : "No active group"}</span>
          </div>
          <div className="group-display-actions">
            <button
              type="button"
              aria-label="Show all group display"
              disabled={!bounds?.groups.length}
              onClick={() => handleAllGroupDisplayVisibility(true)}
            >
              All on
            </button>
            <button
              type="button"
              aria-label="Hide all group display"
              disabled={!bounds?.groups.length}
              onClick={() => handleAllGroupDisplayVisibility(false)}
            >
              All off
            </button>
          </div>
        </div>
        <div className="group-list">
          {bounds?.groups.map((group) => {
            const displayVisible = groupDisplayVisible(groupDrawVisibility, groupStatsVisibility, group.id);
            return (
              <div className={group.id === activeGroupId ? "group-row active" : "group-row"} key={group.id}>
                <button
                  type="button"
                  aria-label={group.name}
                  className="group-select-button"
                  onClick={() => {
                    setActiveGroupId(group.id);
                    setHoverPointId(null);
                    setMigrationDraft(null);
                  }}
                >
                  <span className="swatch" style={{ backgroundColor: group.color }} />
                  <span>{group.name}</span>
                  <small>{group.points.length} / {ANALYSIS_MODE_LABELS[group.analysisMode] ?? ANALYSIS_MODE_LABELS.outside}</small>
                  <span className={groupVisible(groupDrawVisibility, group.id) ? "group-state on" : "group-state off"}>
                    {groupVisible(groupDrawVisibility, group.id) ? "Draw on" : "Draw off"}
                  </span>
                  <span className={groupVisible(groupStatsVisibility, group.id) ? "group-state on" : "group-state off"}>
                    {groupVisible(groupStatsVisibility, group.id) ? "Stats on" : "Stats off"}
                  </span>
                </button>
                <button
                  type="button"
                  className={displayVisible ? "group-display-toggle active" : "group-display-toggle"}
                  aria-label={`${displayVisible ? "Hide" : "Show"} ${group.name} display`}
                  onClick={() => handleGroupDisplayVisibility(group.id, !displayVisible)}
                >
                  {displayVisible ? "Hide" : "Show"}
                </button>
              </div>
            );
          })}
        </div>
        <button type="button" onClick={handleAddGroup} disabled={!bounds}>
          Add group
        </button>
        <label className="field-stack" htmlFor="group-name">
          <span>Rename active group</span>
          <input
            id="group-name"
            type="text"
            disabled={!activeGroup}
            value={activeGroup?.name ?? ""}
            onChange={(event) => handleRenameGroup(event.target.value)}
          />
        </label>
        <div className="field-stack">
          <span>Analysis mode</span>
          <div className="segmented-control group-mode-control" aria-label="Analysis mode">
            <button
              type="button"
              disabled={!bounds}
              aria-pressed={(activeGroup?.analysisMode ?? "outside") === "outside"}
              onClick={() => handleGroupAnalysisMode("outside")}
            >
              Outside ROI
            </button>
            <button
              type="button"
              disabled={!bounds}
              aria-pressed={activeGroup?.analysisMode === "inside"}
              onClick={() => handleGroupAnalysisMode("inside")}
            >
              Inside area
            </button>
          </div>
        </div>
        <div className="field-stack">
          <span>Client display</span>
          <label className="toggle-field" htmlFor="draw-active-group">
            <input
              id="draw-active-group"
              type="checkbox"
              disabled={!activeGroup}
              checked={groupVisible(groupDrawVisibility, activeGroupId)}
              onChange={(event) => handleActiveGroupDrawVisibility(event.target.checked)}
            />
            Draw active group
          </label>
          <label className="toggle-field" htmlFor="show-active-group-stats">
            <input
              id="show-active-group-stats"
              type="checkbox"
              disabled={!activeGroup}
              checked={groupVisible(groupStatsVisibility, activeGroupId)}
              onChange={(event) => handleActiveGroupStatsVisibility(event.target.checked)}
            />
            Show active group stats
          </label>
          <label className="toggle-field" htmlFor="show-migration-vector">
            <input
              id="show-migration-vector"
              type="checkbox"
              disabled={!activeGroup?.migrationVector}
              checked={groupVisible(groupVectorVisibility, activeGroupId)}
              onChange={(event) => handleActiveGroupVectorVisibility(event.target.checked)}
            />
            Show migration vector
          </label>
        </div>
        <div className="field-stack">
          <span>Migration vector</span>
          <div className="button-row">
            <button type="button" onClick={handleStartMigrationVector} disabled={!activeGroup}>
              Set migration
            </button>
            <button type="button" onClick={handleClearMigrationVector} disabled={!activeGroup?.migrationVector}>
              Clear migration
            </button>
          </div>
          <small className="muted-line">{formatMigrationVector(activeGroup?.migrationVector)}</small>
        </div>
        <button type="button" className="danger" onClick={handleDeleteGroup} disabled={!activeGroup}>
          Delete active group
        </button>
      </aside>

      <section
        className="stage-shell"
        aria-label="Image editor"
        data-point-order-open={pointOrderOpen ? "true" : "false"}
        data-roi-settings-open={roiSettingsOpen ? "true" : "false"}
        data-analysis-resizing={analysisResizeDrag ? "true" : "false"}
        style={{
          "--stage-collapsed-space": `${collapsedPanelSpacePx}px`,
          "--analysis-panel-height": `${analysisPanelHeight}px`,
          "--analysis-panel-stage-adjust": `${analysisPanelStageAdjustPx}px`,
        }}
      >
        <div className="stage-tools">
          <div className="segmented-control layer-control" aria-label="Image layer">
            <button
              type="button"
              aria-pressed={imageLayer === "original"}
              onClick={() => setImageLayer("original")}
            >
              Original
            </button>
            <button
              type="button"
              aria-pressed={imageLayer === "mask"}
              onClick={() => setImageLayer("mask")}
              disabled={!activeImage}
            >
              Mask
            </button>
            <button
              type="button"
              aria-pressed={imageLayer === "fiber-qc"}
              onClick={() => setImageLayer("fiber-qc")}
              disabled={!activeImage}
            >
              Fiber QC
            </button>
          </div>
          <label htmlFor="point-opacity">
            Point opacity
            <input
              id="point-opacity"
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={pointOpacity}
              onChange={(event) => setPointOpacity(Number(event.target.value))}
            />
          </label>
          <label htmlFor="display-min">
            Display min
            <input
              id="display-min"
              type="number"
              value={displayMin}
              onChange={(event) => setDisplayMin(Number(event.target.value))}
            />
          </label>
          <label htmlFor="display-max">
            Display max
            <input
              id="display-max"
              type="number"
              value={displayMax}
              onChange={(event) => setDisplayMax(Number(event.target.value))}
            />
          </label>
          <label className="toggle-field" htmlFor="show-roi-overlay">
            <input
              id="show-roi-overlay"
              type="checkbox"
              checked={showRoiOverlay}
              onChange={(event) => setShowRoiOverlay(event.target.checked)}
            />
            Show ROI
          </label>
          <span className={dirty ? "dirty-indicator dirty" : "dirty-indicator"}>
            {dirty ? "Unsaved" : "Clean"}
          </span>
          <span className="status-chip">{hasBounds ? "Saved bound" : "No saved file"}</span>
          <span className="status-chip">{roiPreviewStatus}</span>
          <span className="status-line">{status}</span>
        </div>

        <div className="image-stage-frame" data-testid="image-stage-frame" ref={stageFrameRef}>
          <div
            className="image-stage"
            data-testid="image-stage"
            onPointerMove={handleStagePointerMove}
            onMouseMove={handleStagePointerMove}
            onPointerLeave={() => {
              clearPointer();
              setDragPoint(null);
            }}
            onPointerUp={() => setDragPoint(null)}
            onPointerCancel={() => setDragPoint(null)}
            onClick={handleStageClick}
            style={{
              aspectRatio: hasActiveImageDimensions ? `${activeImage.width} / ${activeImage.height}` : "4 / 3",
              "--image-aspect": String(activeImageAspect),
              ...(stageDisplaySize
                ? { width: `${stageDisplaySize.width}px`, height: `${stageDisplaySize.height}px` }
                : {}),
            }}
          >
            <canvas
              ref={canvasRef}
              className={imageLayer === "original" ? "raw-canvas" : "raw-canvas hidden-layer"}
              aria-label="raw16 image"
            />
            {activeImage && (imageLayer === "mask" || imageLayer === "fiber-qc") ? (
              <img
                className="layer-image mask-preview"
                alt="mask preview"
                src={`/api/images/${activeImage.id}/mask-preview`}
              />
            ) : null}
            {activeImage && imageLayer === "fiber-qc" ? (
              <img
                className="layer-image skeleton-preview"
                alt="skeleton preview"
                src={`/api/images/${activeImage.id}/skeleton-preview`}
              />
            ) : null}
            {activeImage && hasActiveImageDimensions && bounds ? (
              <svg
                className="overlay"
                viewBox={`0 0 ${activeImage.width} ${activeImage.height}`}
                role="img"
                aria-label="Bounds overlay"
              >
              {roiPreviewGroups.length || visibleMigrationPolygons.length ? (
                <defs>
                  {roiPreviewGroups.map((group) => (
                    <clipPath id={group.clipId} key={group.clipId} clipPathUnits="userSpaceOnUse">
                      <path d={group.outsidePath} clipRule="evenodd" />
                    </clipPath>
                  ))}
                  {visibleMigrationPolygons.map((group) => (
                    <marker
                      id={migrationMarkerId(group.id)}
                      key={`${group.id}-migration-marker`}
                      markerHeight="7"
                      markerUnits="strokeWidth"
                      markerWidth="8"
                      orient="auto"
                      refX="7"
                      refY="3.5"
                      viewBox="0 0 8 7"
                    >
                      <path d="M 0 0 L 8 3.5 L 0 7 Z" fill={group.color} />
                    </marker>
                  ))}
                </defs>
              ) : null}
              {roiPreviewGroups.flatMap((group) =>
                group.bands.map((band) => (
                  <polygon
                    key={band.key}
                    aria-label={`ROI preview ${band.bandId}`}
                    className={`roi-preview-band ${band.bandId}`}
                    points={band.path}
                    fill="none"
                    stroke={band.color}
                    strokeWidth={band.strokeWidth}
                    clipPath={`url(#${group.clipId})`}
                  />
                )),
              )}
              {visibleMigrationPolygons.map((group) => (
                <g key={`${group.id}-migration`} className="migration-vector">
                  <line
                    aria-label={`Migration vector ${group.name}`}
                    x1={group.migrationVector.start.x}
                    y1={group.migrationVector.start.y}
                    x2={group.migrationVector.end.x}
                    y2={group.migrationVector.end.y}
                    stroke={group.color}
                    strokeWidth="2.5"
                    markerEnd={`url(#${migrationMarkerId(group.id)})`}
                  />
                  <circle
                    aria-label={`Migration vector start ${group.name}`}
                    cx={group.migrationVector.start.x}
                    cy={group.migrationVector.start.y}
                    r="3"
                    fill={group.color}
                    stroke="#ffffff"
                    strokeWidth="1"
                  />
                </g>
              ))}
              {visiblePolygons.map((group) => (
                <g key={group.id} opacity={pointOpacity}>
                  {group.ordered.length >= 3 ? (
                    <polygon
                      points={group.path}
                      fill={group.color}
                      fillOpacity="0.12"
                      stroke={group.color}
                      strokeWidth="1.5"
                    />
                  ) : (
                    <polyline points={group.path} fill="none" stroke={group.color} strokeWidth="1.5" />
                  )}
                  {group.points.map((point) => (
                    <circle
                      key={point.id}
                      aria-label={`Vertex ${point.id}`}
                      className={hoverPointId === point.id ? "highlighted" : undefined}
                      data-highlighted={hoverPointId === point.id ? "true" : undefined}
                      cx={point.x}
                      cy={point.y}
                      r={hoverPointId === point.id ? "5" : "3"}
                      fill={group.color}
                      stroke="#ffffff"
                      strokeWidth={hoverPointId === point.id ? "2" : "1"}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        event.currentTarget.setPointerCapture?.(event.pointerId);
                        setActiveGroupId(group.id);
                        setDragPoint({ groupId: group.id, pointId: point.id });
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    />
                  ))}
                </g>
              ))}
              </svg>
            ) : null}
          </div>
        </div>

        <div
          className={pointOrderOpen ? "point-order-panel" : "point-order-panel is-collapsed"}
          aria-label="Point order"
        >
          <button
            type="button"
            className="point-order-heading panel-heading-toggle"
            aria-label="Toggle point order panel"
            aria-expanded={pointOrderOpen}
            aria-controls="point-order-list"
            onClick={() => setPointOrderOpen((current) => !current)}
          >
            <span className="panel-toggle-icon" aria-hidden="true">{pointOrderOpen ? "v" : ">"}</span>
            <span className="panel-heading-copy">
              <strong>{activeGroup?.name ?? "Point order"}</strong>
              <span>{activeGroup ? `${activeGroup.points.length} points` : "No active group"}</span>
            </span>
          </button>
          {pointOrderOpen ? <div className="point-order-list" id="point-order-list">
            {activeGroup?.points.length ? (
              activeGroup.points.map((point, index) => (
                <div
                  className={hoverPointId === point.id ? "point-order-item active" : "point-order-item"}
                  key={point.id}
                  onMouseEnter={() => setHoverPointId(point.id)}
                  onMouseLeave={() => setHoverPointId(null)}
                  onPointerEnter={() => setHoverPointId(point.id)}
                  onPointerLeave={() => setHoverPointId(null)}
                >
                  <button
                    type="button"
                    className="order-nudge"
                    aria-label={`Move ${point.id} left`}
                    disabled={index === 0}
                    onClick={() => handleMovePointOrder(point.id, "left")}
                  >
                    {"<"}
                  </button>
                  <button
                    type="button"
                    className="point-order-token"
                    aria-label={`Point ${index + 1} ${point.id}`}
                    onClick={() => setHoverPointId(point.id)}
                    onMouseMove={() => setHoverPointId(point.id)}
                    onPointerMove={() => setHoverPointId(point.id)}
                    onFocus={() => setHoverPointId(point.id)}
                  >
                    <span>{index + 1}</span>
                    <small>{point.id}</small>
                  </button>
                  {hoverPointId === point.id ? (
                    <button
                      type="button"
                      className="point-delete"
                      aria-label={`Delete ${point.id}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleDeletePoint(point.id)}
                    >
                      Delete
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="order-nudge"
                    aria-label={`Move ${point.id} right`}
                    disabled={index === activeGroup.points.length - 1}
                    onClick={() => handleMovePointOrder(point.id, "right")}
                  >
                    {">"}
                  </button>
                </div>
              ))
            ) : (
              <span className="point-order-empty">No points</span>
            )}
          </div> : null}
        </div>

        <button
          type="button"
          className="analysis-resize-handle"
          aria-label="Resize analysis panel"
          aria-valuemin={MIN_ANALYSIS_PANEL_HEIGHT}
          aria-valuemax={MAX_ANALYSIS_PANEL_HEIGHT}
          aria-valuenow={analysisPanelHeight}
          onKeyDown={handleAnalysisResizeKeyDown}
          onPointerDown={handleAnalysisResizeStart}
          title="Resize analysis panel"
        >
          <span aria-hidden="true" />
        </button>

        <div
          className={roiSettingsOpen ? "analysis-panel" : "analysis-panel roi-settings-collapsed"}
          aria-label="Analysis"
          style={{ height: `${analysisPanelHeight}px`, maxHeight: `${analysisPanelHeight}px` }}
        >
          <div className="analysis-toolbar">
            <strong>Analysis</strong>
            <span className="status-chip">{hasAnalysis ? "Saved analysis" : "No saved analysis"}</span>
            <span className="status-line">{analysisStatus}</span>
            <button type="button" disabled={!activeImage || analysisLoading} onClick={handleRecalculateAnalysis}>
              {analysisLoading ? "Working" : "Recalculate"}
            </button>
            <button
              type="button"
              className="compact-panel-toggle"
              aria-label="Toggle outside ROI settings"
              aria-expanded={roiSettingsOpen}
              aria-controls="roi-settings-body"
              onClick={() => setRoiSettingsOpen((current) => !current)}
            >
              <span className="panel-toggle-icon" aria-hidden="true">{roiSettingsOpen ? "v" : ">"}</span>
              <span>ROI settings</span>
            </button>
          </div>

          {roiSettingsOpen ? (
            <div className="roi-settings-body" id="roi-settings-body">
              {activeGroupUsesOutsideRoi ? (
                <div className="roi-limit-grid">
                  {ROI_BAND_IDS.map((bandId) => {
                    const label = ROI_BAND_LABELS[bandId];
                    return (
                      <div className="roi-limit-field" key={bandId}>
                        <label htmlFor={`roi-${bandId}-upper`}>
                          <span>{label} upper</span>
                        </label>
                        <div className="roi-stepper">
                          <button
                            type="button"
                            aria-label={`Decrease ${label} upper`}
                            onClick={() => handleRoiLimitStep(bandId, -ROI_LIMIT_STEP)}
                          >
                            -
                          </button>
                          <input
                            id={`roi-${bandId}-upper`}
                            type="number"
                            min={ROI_MIN_LIMIT}
                            step={ROI_LIMIT_STEP}
                            value={activeRoiLimits[bandId]}
                            onBlur={handleRoiLimitCommit}
                            onChange={(event) => handleRoiLimitChange(bandId, event.target.value)}
                            onKeyDown={handleRoiLimitKeyDown}
                          />
                          <button
                            type="button"
                            aria-label={`Increase ${label} upper`}
                            onClick={() => handleRoiLimitStep(bandId, ROI_LIMIT_STEP)}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {activeGroup && !activeGroupUsesOutsideRoi ? (
                <p className="analysis-empty">Inside groups do not use outside ROI settings.</p>
              ) : null}
            </div>
            ) : null}

          {analysisError ? <p className="analysis-error">{analysisError}</p> : null}
          {analysis ? (
            <>
              <div className="analysis-meta">
                <span>Mask</span>
                <strong>{analysis.maskSource?.file ?? "Unknown mask"}</strong>
                <span>Skeleton</span>
                <strong>{analysis.skeletonFile ?? "Not written"}</strong>
                <span>Updated</span>
                <strong>{formatDateTime(analysis.updatedAt)}</strong>
              </div>
              {analysis.warnings?.length ? (
                <div className="analysis-warning-list">
                  {analysis.warnings.map((warning) => (
                    <span className="warning-chip" key={warning}>
                      {warning}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="analysis-table-wrap">
                <table className="analysis-table">
	                  <thead>
		                    <tr>
		                      <th>Group</th>
		                      <th>Mode</th>
		                      <th>ROI</th>
		                      {ANALYSIS_COLUMNS.map((column) => (
	                        <MetricColumnHeader
	                          activeMetricHelp={activeMetricHelp}
	                          column={column}
	                          key={column.key}
	                          onHide={() => setActiveMetricHelp(null)}
	                          onShow={() => setActiveMetricHelp(column.key)}
	                        />
	                      ))}
	                    </tr>
	                  </thead>
	                  <tbody>
		                    {analysisRows(analysis)
                          .filter((row) => groupVisible(groupStatsVisibility, row.groupId))
                          .map((row) => (
		                      <tr key={row.id}>
		                        <td>{row.groupName}</td>
		                        <td>{row.modeLabel}</td>
		                        <td>{row.bandLabel}</td>
		                        {ANALYSIS_COLUMNS.map((column) => (
	                          <td key={column.key}>{column.format(row.metrics[column.key])}</td>
	                        ))}
	                      </tr>
	                    ))}
	                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="analysis-empty">No analysis loaded</p>
          )}
        </div>
      </section>
    </main>
  );
}

function MetricColumnHeader({ activeMetricHelp, column, onHide, onShow }) {
  const tooltipId = `metric-help-${column.key}`;
  const isActive = activeMetricHelp === column.key;

  return (
    <th className="metric-header">
      <button
        type="button"
        className="metric-help-trigger"
        aria-describedby={isActive ? tooltipId : undefined}
        onBlur={onHide}
        onFocus={onShow}
        onMouseEnter={onShow}
        onMouseLeave={onHide}
      >
        {column.label}
      </button>
      {isActive ? (
        <span className="metric-tooltip" id={tooltipId} role="tooltip">
          {column.help}
        </span>
      ) : null}
    </th>
  );
}

function buildRoiPreviewGroups(polygons, image) {
  return polygons
    .filter((group) => group.ordered.length >= 3 && (group.analysisMode ?? "outside") === "outside")
    .map((group, groupIndex) => {
      const clipId = `roi-preview-clip-${svgIdPart(group.id)}-${groupIndex}`;
      return {
        clipId,
        outsidePath: `M 0 0 H ${image.width} V ${image.height} H 0 Z ${polygonPath(group.ordered)} Z`,
        bands: deriveRoiBands(groupRoiLimits(group))
          .sort((left, right) => right.toPx - left.toPx)
          .map((band) => ({
            key: `${group.id}-${band.id}`,
            bandId: band.id,
            label: band.label,
            color: ROI_BAND_COLORS[band.id] ?? group.color,
            path: group.path,
            strokeWidth: Math.max(1, band.toPx * 2),
          })),
      };
    });
}

function polygonPath(points) {
  if (!points.length) return "";
  const [first, ...rest] = points;
  return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`;
}

function svgIdPart(value) {
  return String(value ?? "group").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function migrationMarkerId(groupId) {
  return `migration-arrow-${svgIdPart(groupId)}`;
}

async function readJsonResponse(response) {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}.`);
  }

  return payload;
}

function normalizeAndClampBounds(bounds, image) {
  const normalized = normalizeBoundsForImage(bounds, image);
  return hasImageDimensions(normalized)
    ? clampBoundsToImage(normalized, normalized.width, normalized.height)
    : normalized;
}

function deriveRoiBands(limits) {
  const { near, mid, far } = normalizeRoiLimits(limits);

  return [
    { id: "near", label: ROI_BAND_LABELS.near, fromPx: 0, toPx: near },
    { id: "mid", label: ROI_BAND_LABELS.mid, fromPx: near, toPx: mid },
    { id: "far", label: ROI_BAND_LABELS.far, fromPx: mid, toPx: far },
  ];
}

function normalizeRoiLimits(limits) {
  const near = roiLimitNumber(limits?.near, DEFAULT_ROI_LIMITS.near);
  const mid = Math.max(
    roiLimitNumber(limits?.mid, DEFAULT_ROI_LIMITS.mid),
    near + ROI_LIMIT_STEP,
  );
  const far = Math.max(
    roiLimitNumber(limits?.far, DEFAULT_ROI_LIMITS.far),
    mid + ROI_LIMIT_STEP,
  );

  return { near, mid, far };
}

function roiLimitNumber(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= ROI_MIN_LIMIT
    ? Math.round(numericValue)
    : fallback;
}

function roiLimitsFromBands(roiBands) {
  const nextLimits = { ...DEFAULT_ROI_LIMITS };
  for (const band of Array.isArray(roiBands) ? roiBands : []) {
    if (ROI_BAND_IDS.includes(band.id) && Number.isFinite(band.toPx)) {
      nextLimits[band.id] = band.toPx;
    }
  }
  return nextLimits;
}

function groupRoiLimits(group) {
  return {
    ...DEFAULT_ROI_LIMITS,
    ...(group?.roiLimits && typeof group.roiLimits === "object" ? group.roiLimits : {}),
  };
}

function roiBandsByGroup(bounds) {
  return Object.fromEntries(
    (bounds?.groups ?? [])
      .filter((group) => (group.analysisMode ?? "outside") === "outside")
      .map((group) => [group.id, deriveRoiBands(groupRoiLimits(group))]),
  );
}

function analysisRows(analysis) {
  const labels = new Map((analysis.roiBands ?? []).map((band) => [band.id, band.label ?? band.id]));
  return (analysis.groups ?? []).flatMap((group) => {
    if (group.analysisMode === "inside" && group.area) {
      return [
        {
          id: `${group.groupId}-inside`,
          groupId: group.groupId,
          groupName: group.groupName ?? group.groupId,
          modeLabel: "Inside",
          bandLabel: "영역",
          metrics: group.area,
        },
      ];
    }

    const bandRows = ROI_BAND_IDS.filter((bandId) => group.bands?.[bandId]).map((bandId) => ({
      id: `${group.groupId}-${bandId}`,
      groupId: group.groupId,
      groupName: group.groupName ?? group.groupId,
      modeLabel: "Outside",
      bandLabel: labels.get(bandId) ?? bandId,
      metrics: group.bands[bandId],
    }));

    if (!group.allBands) return bandRows;
    return [
      ...bandRows,
      {
        id: `${group.groupId}-all`,
        groupId: group.groupId,
        groupName: group.groupName ?? group.groupId,
        modeLabel: "Outside",
        bandLabel: "전체",
        metrics: group.allBands,
      },
    ];
  });
}

function groupVisible(visibilityByGroupId, groupId) {
  return !groupId || visibilityByGroupId[groupId] !== false;
}

function groupDisplayVisible(drawVisibilityByGroupId, statsVisibilityByGroupId, groupId) {
  return groupVisible(drawVisibilityByGroupId, groupId) && groupVisible(statsVisibilityByGroupId, groupId);
}

function formatMetric(value) {
  return Number.isFinite(value) ? value.toFixed(4) : "-";
}

function formatInteger(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : "-";
}

function formatMigrationVector(migrationVector) {
  if (!validMigrationVector(migrationVector)) {
    return "Not set";
  }

  const { start, end } = migrationVector;
  return `${Math.round(start.x)},${Math.round(start.y)} -> ${Math.round(end.x)},${Math.round(end.y)}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function normalizeBoundsForImage(bounds, image) {
  const source = bounds && typeof bounds === "object" ? bounds : {};
  const base = createEmptyBounds(image);
  const groups = Array.isArray(source.groups) ? source.groups : [];

  return {
    ...base,
    schemaVersion: 1,
    imageFolder: image.imageFolder ?? image.folder ?? base.imageFolder,
    imageFile: image.imageFile ?? image.file ?? base.imageFile,
    width: firstFinite(image.width, source.width, base.width),
    height: firstFinite(image.height, source.height, base.height),
    connectionMode: "input-order-cycle",
    groups: normalizeGroups(groups),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

function normalizeGroups(groups) {
  const usedGroupIds = new Set();

  return groups
    .filter((group) => group && typeof group === "object")
    .map((group, groupIndex) => {
      const id = uniqueId(group.id, "group-", usedGroupIds, groupIndex + 1);
      const points = Array.isArray(group.points) ? group.points : [];

      return {
        id,
        name: typeof group.name === "string" && group.name.trim() ? group.name : `Group ${groupIndex + 1}`,
        color:
          typeof group.color === "string" && group.color.trim()
            ? group.color
            : GROUP_COLORS[groupIndex % GROUP_COLORS.length],
        analysisMode: group.analysisMode === "inside" ? "inside" : "outside",
        migrationVector: normalizeMigrationVector(group.migrationVector),
        ...(group.analysisMode === "inside" ? {} : { roiLimits: normalizeOptionalRoiLimits(group.roiLimits) }),
        points: normalizePoints(points),
      };
    });
}

function normalizeOptionalRoiLimits(roiLimits) {
  if (!roiLimits || typeof roiLimits !== "object" || Array.isArray(roiLimits)) {
    return undefined;
  }

  return normalizeRoiLimits(roiLimits);
}

function normalizeMigrationVector(migrationVector) {
  if (!validMigrationVector(migrationVector)) {
    return null;
  }

  return {
    start: { x: migrationVector.start.x, y: migrationVector.start.y },
    end: { x: migrationVector.end.x, y: migrationVector.end.y },
  };
}

function validMigrationVector(migrationVector) {
  return (
    migrationVector &&
    typeof migrationVector === "object" &&
    Number.isFinite(migrationVector.start?.x) &&
    Number.isFinite(migrationVector.start?.y) &&
    Number.isFinite(migrationVector.end?.x) &&
    Number.isFinite(migrationVector.end?.y)
  );
}

function normalizePoints(points) {
  const usedPointIds = new Set();

  return points
    .filter((point) => point && typeof point === "object" && Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point, pointIndex) => ({
      id: uniqueId(point.id, "point-", usedPointIds, pointIndex + 1),
      x: point.x,
      y: point.y,
    }));
}

function uniqueId(candidate, prefix, usedIds, fallbackNumber) {
  if (typeof candidate === "string" && candidate.trim() && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return candidate;
  }

  let number = fallbackNumber;
  let id = `${prefix}${number}`;
  while (usedIds.has(id)) {
    number += 1;
    id = `${prefix}${number}`;
  }
  usedIds.add(id);
  return id;
}

function resolveImageDimensions(image, rawPixels, bounds) {
  if (!image) return null;

  return {
    ...image,
    width: firstFinite(image.width, rawPixels?.width, bounds?.width),
    height: firstFinite(image.height, rawPixels?.height, bounds?.height),
  };
}

function firstFinite(...values) {
  return values.find((value) => Number.isFinite(value)) ?? null;
}

function hasImageDimensions(image) {
  return Number.isFinite(image?.width) && Number.isFinite(image?.height);
}

function imageContentRect(contentElement, fallbackElement) {
  const contentRect = contentElement?.getBoundingClientRect?.();
  if (contentRect && contentRect.width > 0 && contentRect.height > 0) {
    return contentRect;
  }

  return fallbackElement.getBoundingClientRect();
}

function sameStageDisplaySize(current, next) {
  if (current === next) return true;
  if (!current || !next) return false;
  return current.width === next.width && current.height === next.height;
}

function eventClientY(event) {
  const clientY = Number(event.clientY);
  return Number.isFinite(clientY) ? clientY : null;
}

function eventToImagePoint(event, image, { allowOutside = false, contentRect = null } = {}) {
  if (!hasImageDimensions(image)) {
    return null;
  }

  const clientX = Number(event.clientX);
  const clientY = Number(event.clientY);

  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return null;
  }

  const rect = contentRect ?? event.currentTarget.getBoundingClientRect();
  const hasRect = rect.width > 0 && rect.height > 0;

  if (
    hasRect &&
    !allowOutside &&
    (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom)
  ) {
    return null;
  }

  const xRatio = hasRect ? (clientX - rect.left) / rect.width : clientX / image.width;
  const yRatio = hasRect ? (clientY - rect.top) / rect.height : clientY / image.height;

  return {
    x: Math.round(clamp(xRatio * image.width, 0, image.width - 1)),
    y: Math.round(clamp(yRatio * image.height, 0, image.height - 1)),
  };
}

function isEditableTarget(target) {
  const candidate =
    target instanceof Element && target !== window ? target : document.activeElement;
  if (!(candidate instanceof Element)) return false;
  const tagName = candidate.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    candidate.isContentEditable
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
