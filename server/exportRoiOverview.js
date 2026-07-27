import sharp from "sharp";
import { groupDisplayId, roiDisplayId } from "../shared/analysisRows.js";
import { assignOutwardRoiPixels } from "./analysisGeometry.js";
import { runSharpWithSignal } from "./sharpRender.js";

const DEFAULT_ROI_LIMITS = Object.freeze({ near: 20, mid: 50, far: 100 });
const ROI_BANDS = Object.freeze([
  { id: "near", label: "Near", color: "#ef4444" },
  { id: "mid", label: "Mid", color: "#f59e0b" },
  { id: "far", label: "Far", color: "#3b82f6" },
]);
const LEGEND_WIDTH = 360;
const IMAGE_MARGIN = 32;
const IMAGE_TOP = 52;
const OUTSIDE_BAND_COLORS = Object.freeze({
  near: [239, 68, 68],
  mid: [245, 158, 11],
  far: [59, 130, 246],
});

export const OUTSIDE_OVERLAY_ALPHA = 96;

export function buildRoiOverviewSvg({ width, height, normalizedImageDataUrl, outsideOverlayDataUrl = null, bounds }) {
  validateRoiBounds(bounds, width, height);
  if (typeof normalizedImageDataUrl !== "string" || normalizedImageDataUrl.length === 0) {
    throw new TypeError("A normalized image data URL is required.");
  }

  const labelPadding = Math.max(IMAGE_MARGIN, maximumOutsideDistance(bounds.groups) + 24);
  const imageX = labelPadding;
  const imageY = Math.max(IMAGE_TOP, labelPadding);
  const legendX = imageX + width + labelPadding;
  const normalizedGroups = bounds.groups.map((group, index) =>
    normalizeGroup(group, index, { imageWidth: width, imageHeight: height, imageX, imageY }),
  );
  const legendHeight = legendHeightFor(normalizedGroups);
  const svgWidth = legendX + LEGEND_WIDTH + IMAGE_MARGIN;
  const svgHeight = Math.max(imageY + height + labelPadding, imageY + legendHeight);

  const groupLayers = normalizedGroups.map((group) => renderGroupLayer({ group, imageX, imageY })).join("\n");
  const legend = renderLegend({ groups: normalizedGroups, x: legendX, y: IMAGE_TOP });
  const outsideOverlay = outsideOverlayDataUrl
    ? `<image data-role="outside-overlay" data-alpha="${OUTSIDE_OVERLAY_ALPHA}" x="${imageX}" y="${imageY}" width="${width}" height="${height}" href="${escapeXml(outsideOverlayDataUrl)}" preserveAspectRatio="none"/>`
    : "";
  const outsideAssignmentRuns = outsideOverlayDataUrl
    ? ""
    : renderOutsideAssignmentRuns({ width, height, bounds, imageX, imageY });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <style>
    text { font-family: Arial, sans-serif; fill: #111827; }
    .report-title { font-size: 18px; font-weight: 700; }
    .report-subtitle { font-size: 13px; fill: #475569; }
    .group-title { font-size: 14px; font-weight: 700; }
    .legend-row { font-size: 13px; }
    .roi-label { font-size: 13px; font-weight: 700; paint-order: stroke; stroke: #ffffff; stroke-width: 3px; stroke-linejoin: round; }
  </style>
  <text class="report-title" x="${imageX}" y="28">ROI overview</text>
  <image x="${imageX}" y="${imageY}" width="${width}" height="${height}" href="${escapeXml(normalizedImageDataUrl)}" preserveAspectRatio="none"/>
  ${outsideOverlay}
  ${outsideAssignmentRuns}
  <rect x="${imageX}" y="${imageY}" width="${width}" height="${height}" fill="none" stroke="#334155" stroke-width="1"/>
  ${groupLayers}
  ${legend}
</svg>`;
}

export async function renderRoiOverview({ imagePath, bounds, maxImagePixels, signal }) {
  const pixelLimit = inputPixelLimitFor(maxImagePixels);
  const source = sharp(imagePath, { limitInputPixels: pixelLimit });
  try {
    const metadata = await runSharpWithSignal(source, () => source.metadata(), signal);
    const { width, height } = imageDimensions(metadata);
    assertMaximumImagePixels(width, height, maxImagePixels);
    validateRoiBounds(bounds, width, height);

    const normalizedPipeline = source.clone().greyscale().normalize().png();
    const normalized = await runSharpWithSignal(
      normalizedPipeline,
      () => normalizedPipeline.toBuffer(),
      signal,
    );
    const outsideOverlay = await buildOutsideRoiOverlay({ width, height, bounds, signal });
    const svg = buildRoiOverviewSvg({
      width,
      height,
      normalizedImageDataUrl: `data:image/png;base64,${normalized.toString("base64")}`,
      outsideOverlayDataUrl: `data:image/png;base64,${outsideOverlay.toString("base64")}`,
      bounds,
    });

    const outputPipeline = sharp(Buffer.from(svg))
      .png({ compressionLevel: 9, adaptiveFiltering: true });
    return await runSharpWithSignal(outputPipeline, () => outputPipeline.toBuffer(), signal);
  } finally {
    source.destroy();
  }
}

export async function buildOutsideRoiOverlay({ width, height, bounds, signal }) {
  validateRoiBounds(bounds, width, height);
  const groups = outsideGroupsForAssignment(bounds);
  const assignments = assignOutwardRoiPixels({ width, height, groups });
  const data = new Uint8Array(width * height * 4);

  for (const [key, assignment] of assignments) {
    const color = OUTSIDE_BAND_COLORS[assignment.bandId];
    if (!color) continue;

    const [x, y] = key.split(",").map(Number);
    const offset = (y * width + x) * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = OUTSIDE_OVERLAY_ALPHA;
  }

  const pipeline = sharp(data, { raw: { width, height, channels: 4 } }).png();
  return runSharpWithSignal(pipeline, () => pipeline.toBuffer(), signal);
}

function renderOutsideAssignmentRuns({ width, height, bounds, imageX, imageY }) {
  const assignments = assignOutwardRoiPixels({ width, height, groups: outsideGroupsForAssignment(bounds) });
  const runsByOwner = new Map();

  function appendRun(assignment, startX, endX, y) {
    if (!assignment || startX === endX) return;
    const color = OUTSIDE_BAND_COLORS[assignment.bandId];
    if (!color) return;

    const key = `${assignment.groupId}\u0000${assignment.bandId}`;
    const owner = runsByOwner.get(key) ?? { groupId: assignment.groupId, bandId: assignment.bandId, color, runs: [] };
    owner.runs.push(
      `<rect data-role="outside-assignment-run" data-group-id="${escapeXml(assignment.groupId)}" data-band-id="${assignment.bandId}" x="${imageX + startX}" y="${imageY + y}" width="${endX - startX}" height="1"/>`,
    );
    runsByOwner.set(key, owner);
  }

  for (let y = 0; y < height; y += 1) {
    let startX = 0;
    let activeAssignment = assignments.get(`0,${y}`) ?? null;

    for (let x = 1; x <= width; x += 1) {
      const nextAssignment = x < width ? assignments.get(`${x},${y}`) ?? null : null;
      const sameOwner =
        activeAssignment?.groupId === nextAssignment?.groupId && activeAssignment?.bandId === nextAssignment?.bandId;
      if (sameOwner) continue;

      appendRun(activeAssignment, startX, x, y);
      startX = x;
      activeAssignment = nextAssignment;
    }
  }

  const opacity = OUTSIDE_OVERLAY_ALPHA / 255;
  const owners = [...runsByOwner.values()]
    .map(
      (owner) => `<g data-role="outside-assignment-owner" data-group-id="${escapeXml(owner.groupId)}" data-band-id="${owner.bandId}" fill="rgb(${owner.color.join(",")})">${owner.runs.join("")}</g>`,
    )
    .join("");
  return `<g data-role="outside-assignment-runs" fill-opacity="${opacity}">${owners}</g>`;
}

function outsideGroupsForAssignment(bounds) {
  return bounds.groups
    .filter((group) => group.analysisMode !== "inside")
    .map((group) => ({ ...group, roiBands: deriveRoiBands(group.roiLimits) }));
}

function renderGroupLayer({ group, imageX, imageY }) {
  const translatedPath = polygonPath(group.points, imageX, imageY);
  const centroid = polygonCentroid(group.points);
  const translatedCentroid = { x: centroid.x + imageX, y: centroid.y + imageY };

  if (group.analysisMode === "inside") {
    const labelId = roiDisplayId({ groupIndex: group.index, analysisMode: "inside", bandId: "inside" });
    return `<g data-role="inside-roi" data-group-id="${escapeXml(group.id)}">
      <path d="${translatedPath}" fill="${escapeXml(group.color)}" fill-opacity="0.24" stroke="${escapeXml(group.color)}" stroke-width="2"/>
      <text class="roi-label" x="${translatedCentroid.x}" y="${translatedCentroid.y}" text-anchor="middle" dominant-baseline="middle" fill="${escapeXml(group.color)}">${labelId}</text>
    </g>`;
  }

  const bandLabels = group.bands
    .map((band) => renderOutsideBandLabel({ band, group, centroid: translatedCentroid }))
    .join("");

  return `<g data-role="outside-roi" data-group-id="${escapeXml(group.id)}">
    <path d="${translatedPath}" fill="none" stroke="${escapeXml(group.color)}" stroke-width="2"/>
    ${bandLabels}
  </g>`;
}

function renderOutsideBandLabel({ band, group, centroid }) {
  const firstPoint = group.points[0];
  const firstPointInCanvas = { x: firstPoint.x + group.imageX, y: firstPoint.y + group.imageY };
  const direction = normalizedVector({
    x: firstPointInCanvas.x - centroid.x,
    y: firstPointInCanvas.y - centroid.y,
  }) ?? { x: 1, y: 0 };
  const distance = (band.fromPx + band.toPx) / 2;
  const labelPoint = {
    x: firstPointInCanvas.x + direction.x * distance,
    y: firstPointInCanvas.y + direction.y * distance,
  };
  const labelId = roiDisplayId({ groupIndex: group.index, analysisMode: "outside", bandId: band.id });

  return `<text class="roi-label" data-roi-id="${labelId}" x="${labelPoint.x}" y="${labelPoint.y}" text-anchor="middle" dominant-baseline="middle" fill="${band.color}">${labelId}</text>`;
}

function renderLegend({ groups, x, y }) {
  let cursorY = y;
  const parts = [`<g data-role="roi-legend" transform="translate(${x} ${y})"><text class="report-title" x="0" y="0">ROI legend</text><text class="report-subtitle" x="0" y="22">Authoritative ROI definitions</text>`];
  cursorY = 52;

  for (const group of groups) {
    const groupId = groupDisplayId(group.index);
    const name = group.name || group.id || groupId;
    parts.push(`<g data-role="legend-group" transform="translate(0 ${cursorY})">
      <rect x="0" y="-13" width="14" height="14" fill="${escapeXml(group.color)}" data-role="group-color-swatch"/>
      <text class="group-title" x="22" y="0">${groupId} | ${escapeXml(name)}</text>
      <text class="report-subtitle" x="0" y="21">Mode: ${group.modeLabel}</text>`);

    let rowY = 43;
    if (group.analysisMode === "inside") {
      const roiId = roiDisplayId({ groupIndex: group.index, analysisMode: "inside", bandId: "inside" });
      parts.push(`<text class="legend-row" x="0" y="${rowY}">${roiId} | Inside polygon</text>`);
      rowY += 24;
    } else {
      for (const band of group.bands) {
        const roiId = roiDisplayId({ groupIndex: group.index, analysisMode: "outside", bandId: band.id });
        parts.push(`<text class="legend-row" x="0" y="${rowY}">${roiId} | ${band.label}: ${formatDistance(band.fromPx)}-${formatDistance(band.toPx)} px</text>`);
        rowY += 22;
      }
      const allId = roiDisplayId({ groupIndex: group.index, analysisMode: "outside", bandId: "all" });
      const far = group.bands[group.bands.length - 1].toPx;
      parts.push(`<text class="legend-row" x="0" y="${rowY}">${allId} | 0-${formatDistance(far)} px union</text>`);
      rowY += 24;
    }

    parts.push("</g>");
    cursorY += rowY + 18;
  }

  parts.push("</g>");
  return parts.join("");
}

function legendHeightFor(groups) {
  return 52 + groups.reduce((total, group) => total + (group.analysisMode === "inside" ? 85 : 149), 0);
}

function maximumOutsideDistance(groups) {
  return groups.reduce((maximum, group) => {
    if (group.analysisMode === "inside") return maximum;
    const bands = deriveRoiBands(group.roiLimits);
    return Math.max(maximum, bands[bands.length - 1].toPx);
  }, 0);
}

function normalizeGroup(group, index, imageFrame) {
  const analysisMode = group.analysisMode === "inside" ? "inside" : "outside";
  return {
    id: group.id,
    index,
    name: group.name,
    color: typeof group.color === "string" && group.color.length > 0 ? group.color : "#64748b",
    analysisMode,
    modeLabel: analysisMode === "inside" ? "Inside" : "Outside",
    points: group.points,
    bands: analysisMode === "outside" ? deriveRoiBands(group.roiLimits) : [],
    ...imageFrame,
  };
}

function deriveRoiBands(roiLimits) {
  const near = roiLimitNumber(roiLimits?.near, DEFAULT_ROI_LIMITS.near);
  const mid = Math.max(roiLimitNumber(roiLimits?.mid, DEFAULT_ROI_LIMITS.mid), near + 1);
  const far = Math.max(roiLimitNumber(roiLimits?.far, DEFAULT_ROI_LIMITS.far), mid + 1);
  const limits = { near, mid, far };
  let fromPx = 0;

  return ROI_BANDS.map((band) => {
    const toPx = limits[band.id];
    const result = { ...band, fromPx, toPx };
    fromPx = toPx;
    return result;
  });
}

function roiLimitNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 ? Math.round(numeric) : fallback;
}

function validateRoiBounds(bounds, width, height) {
  const dimensions = imageDimensions({ width, height });
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds) || !Array.isArray(bounds.groups)) {
    throw new TypeError("Saved bounds must include polygon groups.");
  }
  if (bounds.width !== dimensions.width || bounds.height !== dimensions.height) {
    throw new RangeError("Saved bounds dimensions do not match the source image.");
  }

  for (const group of bounds.groups) {
    if (!group || typeof group !== "object" || Array.isArray(group) || !Array.isArray(group.points) || group.points.length < 3) {
      throw new TypeError("Each saved group must include at least three polygon points.");
    }
    for (const point of group.points) {
      if (
        !point ||
        typeof point !== "object" ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.x > dimensions.width - 1 ||
        point.y < 0 ||
        point.y > dimensions.height - 1
      ) {
        throw new RangeError("Saved polygon points must be finite and inside the source image bounds.");
      }
    }
  }
}

function imageDimensions(metadata) {
  const width = metadata?.width;
  const height = metadata?.height;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError("Source image dimensions must be positive integers.");
  }
  return { width, height };
}

function inputPixelLimitFor(maxImagePixels) {
  return Number.isSafeInteger(maxImagePixels) && maxImagePixels > 0 ? maxImagePixels : true;
}

function assertMaximumImagePixels(width, height, maxImagePixels) {
  if (Number.isSafeInteger(maxImagePixels) && maxImagePixels > 0 && width * height > maxImagePixels) {
    throw new RangeError("Source image exceeds the configured maximum pixel count.");
  }
}

function polygonPath(points, xOffset, yOffset) {
  const [first, ...rest] = points;
  return `M ${first.x + xOffset} ${first.y + yOffset} ${rest.map((point) => `L ${point.x + xOffset} ${point.y + yOffset}`).join(" ")} Z`;
}

function polygonCentroid(points) {
  let crossSum = 0;
  let xSum = 0;
  let ySum = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    crossSum += cross;
    xSum += (current.x + next.x) * cross;
    ySum += (current.y + next.y) * cross;
  }

  if (Math.abs(crossSum) > Number.EPSILON) {
    return { x: xSum / (3 * crossSum), y: ySum / (3 * crossSum) };
  }

  const totals = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  return { x: totals.x / points.length, y: totals.y / points.length };
}

function normalizedVector(vector) {
  const length = Math.hypot(vector.x, vector.y);
  return length > Number.EPSILON ? { x: vector.x / length, y: vector.y / length } : null;
}

function formatDistance(value) {
  return String(Number(Number(value).toFixed(6)));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
