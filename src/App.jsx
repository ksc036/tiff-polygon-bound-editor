import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addGroup,
  addPoint,
  clampBoundsToImage,
  createEmptyBounds,
  deleteGroup,
  deleteNearestPoint,
  moveNearestPoint,
  movePoint,
  movePointOrder,
  renameGroup,
} from "./lib/editorState.js";
import { findNearestSegment } from "./lib/geometry.js";
import { renderRaw16ToCanvas } from "./lib/raw16Renderer.js";

const OPACITY_KEY = "raw16-editor-point-opacity";
const DEFAULT_OPACITY = 0.85;
const SEGMENT_INSERT_SCREEN_THRESHOLD = 8;
const SEGMENT_INSERT_IMAGE_THRESHOLD = 8;
const GROUP_COLORS = ["#e11d48", "#2563eb", "#16a34a", "#ca8a04", "#9333ea"];

export default function App() {
  const canvasRef = useRef(null);
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
  const [pointOpacity, setPointOpacity] = useState(() => {
    const stored = Number(localStorage.getItem(OPACITY_KEY));
    return stored >= 0.1 && stored <= 1 ? stored : DEFAULT_OPACITY;
  });

  const activeImage = activeIndex >= 0 ? resolveImageDimensions(images[activeIndex], rawPixels, bounds) : null;
  const activeGroup = bounds?.groups.find((group) => group.id === activeGroupId) ?? null;
  const hasActiveImageDimensions = hasImageDimensions(activeImage);
  const activeImageAspect = hasActiveImageDimensions ? activeImage.width / activeImage.height : 4 / 3;

  const loadImage = useCallback(
    async (index, nextImages) => {
      const requestId = (loadRequestRef.current += 1);
      const isCurrentRequest = () => requestId === loadRequestRef.current;
      const image = nextImages[index];
      if (!image) {
        setActiveIndex(-1);
        setBounds(null);
        setActiveGroupId(null);
        return;
      }

      setActiveIndex(index);
      clearPointer();
      setRawPixels(null);
      setStatus("Loading image");

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

  function handleDeleteGroup() {
    if (!activeGroupId) return;
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

  function handleStageClick(event) {
    if (!hasActiveImageDimensions) return;
    const clickPoint = eventToImagePoint(event, activeImage, {
      contentRect: imageContentRect(canvasRef.current, event.currentTarget),
    });
    if (!clickPoint) return;

    setCurrentPointer(clickPoint);
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
          <h1>Groups</h1>
          <span className="status-chip">{activeGroup ? activeGroup.name : "No active group"}</span>
        </div>
        <div className="group-list">
          {bounds?.groups.map((group) => (
            <button
              type="button"
              aria-label={group.name}
              className={group.id === activeGroupId ? "group-row active" : "group-row"}
              key={group.id}
              onClick={() => {
                setActiveGroupId(group.id);
                setHoverPointId(null);
              }}
            >
              <span className="swatch" style={{ backgroundColor: group.color }} />
              <span>{group.name}</span>
              <small>{group.points.length}</small>
            </button>
          ))}
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
        <button type="button" className="danger" onClick={handleDeleteGroup} disabled={!activeGroup}>
          Delete active group
        </button>
      </aside>

      <section className="stage-shell" aria-label="Image editor">
        <div className="stage-tools">
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
          <span className={dirty ? "dirty-indicator dirty" : "dirty-indicator"}>
            {dirty ? "Unsaved" : "Clean"}
          </span>
          <span className="status-chip">{hasBounds ? "Saved bound" : "No saved file"}</span>
          <span className="status-line">{status}</span>
        </div>

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
          }}
        >
          <canvas ref={canvasRef} className="raw-canvas" aria-label="raw16 image" />
          {activeImage && hasActiveImageDimensions && bounds ? (
            <svg
              className="overlay"
              viewBox={`0 0 ${activeImage.width} ${activeImage.height}`}
              role="img"
              aria-label="Bounds overlay"
            >
              {polygons.map((group) => (
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

        <div className="point-order-panel" aria-label="Point order">
          <div className="point-order-heading">
            <strong>{activeGroup?.name ?? "Point order"}</strong>
            <span>{activeGroup ? `${activeGroup.points.length} points` : "No active group"}</span>
          </div>
          <div className="point-order-list">
            {activeGroup?.points.length ? (
              activeGroup.points.map((point, index) => (
                <div
                  className={hoverPointId === point.id ? "point-order-item active" : "point-order-item"}
                  key={point.id}
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
                    onMouseEnter={() => setHoverPointId(point.id)}
                    onMouseLeave={() => setHoverPointId(null)}
                    onMouseMove={() => setHoverPointId(point.id)}
                    onPointerEnter={() => setHoverPointId(point.id)}
                    onPointerMove={() => setHoverPointId(point.id)}
                    onFocus={() => setHoverPointId(point.id)}
                    onBlur={() => setHoverPointId(null)}
                  >
                    <span>{index + 1}</span>
                    <small>{point.id}</small>
                  </button>
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
          </div>
        </div>
      </section>
    </main>
  );
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
        points: normalizePoints(points),
      };
    });
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
