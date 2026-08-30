import JSZip from "jszip";
import {
  HISTOGRAM_DISPLAY_BIN_COUNT,
  HISTOGRAM_MAX_HEIGHT,
  histogramDisplayBins,
  histogramDisplayHeight,
} from "./inferenceHistogram.js";

const HISTOGRAM_WIDTH = 960;
const HISTOGRAM_HEIGHT = 760;
const COLORS = {
  background: "#10171d",
  chart: "#121b22",
  border: "#52616d",
  text: "#f5f9fc",
  muted: "#9faeba",
  unselected: "#788692",
  selected: "#e7474f",
  threshold: "#ff6b72",
};

function outputBaseName(imageFile) {
  const withoutExtension = String(imageFile ?? "image").replace(/\.tiff?$/i, "");
  return withoutExtension.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "") || "image";
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable.");
  return { canvas, context };
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Unable to encode a PNG download."));
    }, "image/png");
  });
}

function blobBytes(blob) {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read a generated PNG."));
    reader.readAsArrayBuffer(blob);
  });
}

function compositeCanvas(sourceCanvas, overlayBitmap, rectangle = null) {
  const region = rectangle ?? { x: 0, y: 0, width: sourceCanvas.width, height: sourceCanvas.height };
  const { canvas, context } = createCanvas(region.width, region.height);
  if (rectangle) {
    context.drawImage(sourceCanvas, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
    context.drawImage(overlayBitmap, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  } else {
    context.drawImage(sourceCanvas, 0, 0, region.width, region.height);
    context.drawImage(overlayBitmap, 0, 0, region.width, region.height);
  }
  return canvas;
}

function drawAlignedText(context, text, x, y, align = "left") {
  context.textAlign = align;
  context.fillText(text, x, y);
}

function drawHistogram(context, { histogram, label, threshold, top }) {
  const left = 36;
  const width = HISTOGRAM_WIDTH - left * 2;
  const chartTop = top + 34;
  const chartHeight = 190;
  const displayBins = histogramDisplayBins(histogram);
  if (!displayBins) throw new Error(`Unable to render the ${label} histogram.`);

  context.font = "600 24px system-ui, sans-serif";
  context.fillStyle = COLORS.text;
  drawAlignedText(context, label, left, top + 22);
  context.font = "18px system-ui, sans-serif";
  context.fillStyle = COLORS.muted;
  drawAlignedText(context, `${histogram.areaPx.toLocaleString()} px`, left + width, top + 22, "right");

  context.fillStyle = COLORS.chart;
  context.fillRect(left, chartTop, width, chartHeight);
  const binWidth = width / HISTOGRAM_DISPLAY_BIN_COUNT;
  const thresholdX = left + threshold * width;
  displayBins.forEach((count, index) => {
    const height = (histogramDisplayHeight(count, histogram.areaPx) / HISTOGRAM_MAX_HEIGHT) * (chartHeight - 8);
    const x = left + index * binWidth;
    const y = chartTop + chartHeight - height;
    context.fillStyle = COLORS.unselected;
    context.fillRect(x, y, binWidth + 0.4, height);
    const selectedLeft = Math.max(x, thresholdX);
    const selectedRight = Math.min(x + binWidth + 0.4, left + width);
    if (selectedRight > selectedLeft) {
      context.fillStyle = COLORS.selected;
      context.fillRect(selectedLeft, y, selectedRight - selectedLeft, height);
    }
  });
  context.strokeStyle = COLORS.threshold;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(thresholdX, chartTop);
  context.lineTo(thresholdX, chartTop + chartHeight);
  context.stroke();
  context.strokeStyle = COLORS.border;
  context.lineWidth = 2;
  context.strokeRect(left, chartTop, width, chartHeight);

  context.font = "16px system-ui, sans-serif";
  context.fillStyle = COLORS.muted;
  drawAlignedText(context, "0.00", left, chartTop + chartHeight + 25);
  drawAlignedText(context, "0.50", left + width / 2, chartTop + chartHeight + 25, "center");
  drawAlignedText(context, "1.00", left + width, chartTop + chartHeight + 25, "right");
  return chartTop + chartHeight + 42;
}

function percentLabel(value) {
  return `${((Number.isFinite(value) ? value : 0) * 100).toFixed(2)}%`;
}

function histogramCanvas({ imageFile, histograms, metrics, threshold }) {
  const { canvas, context } = createCanvas(HISTOGRAM_WIDTH, HISTOGRAM_HEIGHT);
  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = COLORS.text;
  context.font = "600 28px system-ui, sans-serif";
  drawAlignedText(context, outputBaseName(imageFile), 36, 42);
  context.fillStyle = COLORS.muted;
  context.font = "20px system-ui, sans-serif";
  drawAlignedText(context, `Threshold ${threshold.toFixed(3)}`, 36, 75);

  let nextTop = drawHistogram(context, { histogram: histograms.wholeImage, label: "Whole image", threshold, top: 102 });
  nextTop = drawHistogram(context, { histogram: histograms.roi, label: "ROI", threshold, top: nextTop + 18 });
  context.font = "22px system-ui, sans-serif";
  context.fillStyle = COLORS.text;
  drawAlignedText(context, "Whole image area fraction", 36, nextTop + 24);
  drawAlignedText(context, percentLabel(metrics.wholeImage?.areaFraction), HISTOGRAM_WIDTH - 36, nextTop + 24, "right");
  drawAlignedText(context, "ROI area fraction", 36, nextTop + 62);
  drawAlignedText(context, percentLabel(metrics.roi?.areaFraction), HISTOGRAM_WIDTH - 36, nextTop + 62, "right");
  return canvas;
}

export async function createInferenceOutputFiles({
  sourceCanvas,
  overlayBlob,
  roi,
  histograms,
  metrics,
  threshold,
  imageFile,
}) {
  if (!sourceCanvas?.width || !sourceCanvas?.height || !overlayBlob || !roi || !histograms?.wholeImage || !histograms?.roi) {
    throw new Error("Inference download inputs are not ready.");
  }
  const overlayBitmap = await createImageBitmap(overlayBlob);
  try {
    const wholeCanvas = compositeCanvas(sourceCanvas, overlayBitmap);
    const roiCanvas = compositeCanvas(sourceCanvas, overlayBitmap, roi);
    const chartsCanvas = histogramCanvas({ imageFile, histograms, metrics, threshold });
    const [wholeBlob, roiBlob, chartsBlob] = await Promise.all([
      canvasBlob(wholeCanvas),
      canvasBlob(roiCanvas),
      canvasBlob(chartsCanvas),
    ]);
    const [wholeBytes, roiBytes, chartsBytes] = await Promise.all([
      blobBytes(wholeBlob),
      blobBytes(roiBlob),
      blobBytes(chartsBlob),
    ]);
    const baseName = outputBaseName(imageFile);
    return {
      baseName,
      files: [
        { name: `${baseName}_whole_mask_overlay.png`, bytes: wholeBytes },
        { name: `${baseName}_roi_mask_overlay.png`, bytes: roiBytes },
        { name: `${baseName}_histograms.png`, bytes: chartsBytes },
      ],
    };
  } finally {
    overlayBitmap.close?.();
  }
}

async function zipDownloadBlob(zip) {
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  return new Blob([bytes], { type: "application/zip" });
}

export async function createInferenceOutputZip(options) {
  const { baseName, files } = await createInferenceOutputFiles(options);
  const zip = new JSZip();
  files.forEach((file) => zip.file(file.name, file.bytes));
  return {
    blob: await zipDownloadBlob(zip),
    filename: `${baseName}_inference_outputs.zip`,
  };
}

export async function createAllInferenceOutputsZip({ images, loadImageOutputs, onProgress }) {
  if (!Array.isArray(images) || images.length === 0 || typeof loadImageOutputs !== "function") {
    throw new Error("Completed inference images are not ready for download.");
  }
  const zip = new JSZip();
  const usedFolders = new Set();
  for (let index = 0; index < images.length; index += 1) {
    onProgress?.({ current: index + 1, total: images.length });
    const output = await createInferenceOutputFiles(await loadImageOutputs(images[index]));
    let folderName = output.baseName;
    let suffix = 2;
    while (usedFolders.has(folderName)) {
      folderName = `${output.baseName}_${suffix}`;
      suffix += 1;
    }
    usedFolders.add(folderName);
    output.files.forEach((file) => zip.file(`${folderName}/${file.name}`, file.bytes));
  }
  return {
    blob: await zipDownloadBlob(zip),
    filename: "inference_outputs.zip",
  };
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}

export async function downloadInferenceOutputs(options) {
  const { blob, filename } = await createInferenceOutputZip(options);
  return triggerBlobDownload(blob, filename);
}

export async function downloadAllInferenceOutputs(options) {
  const { blob, filename } = await createAllInferenceOutputsZip(options);
  return triggerBlobDownload(blob, filename);
}
