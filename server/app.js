import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { createStorage } from "./storage.js";
import { readGrey16RawFromImage } from "./imageProcessing.js";
import { AnalysisError, loadAnalysis, recalculateAnalysis } from "./analysisService.js";
import { HeatmapError, generateHeatmapBatch, loadImageHeatmap } from "./heatmapService.js";
import { validateCellSize } from "./maskHeatmap.js";
import { createMaskPreview, createRoiOverlay, createSkeletonPreview } from "./previewLayers.js";
import {
  ExportError,
  datasetExportFilename,
  validateExportCalibration,
  writeDatasetZip,
} from "./exportService.js";
import { FOLDER_PICKER_CODES, FolderPickerError } from "./folderPicker.js";
import {
  SubimageError,
  createMissingSubimages,
  loadSubimage,
  replaceAllSubimages,
  saveSubimage,
} from "./subimageService.js";
import { createInferenceService, InferenceError } from "./inferenceService.js";

const CONNECTION_MODE = "input-order-cycle";
const SUBIMAGE_ERROR_MESSAGES = {
  IMAGE_NOT_FOUND: "Image not found.",
  MISSING_SOURCE: "Source TIFF is missing.",
  UNSUPPORTED_SOURCE: "Source TIFF must be single-channel 16-bit grayscale.",
  DIMENSION_MISMATCH: "Source image dimensions do not match.",
  INVALID_CROP: "Invalid subimage crop.",
  ASPECT_RATIO_MISMATCH: "Subimage crop must match the source aspect ratio.",
  INVALID_SAVED_CROP: "Saved subimage metadata is invalid.",
  MISSING_SAVED_TIFF: "Saved subimage TIFF is missing.",
  CROP_RENDER_FAILED: "Unable to render subimage TIFF.",
  WRITE_FAILED: "Unable to save subimage.",
  BATCH_PREFLIGHT_FAILED: "Subimage batch preflight failed.",
  SOURCE_READ_FAILED: "Unable to read source TIFF.",
  CROP_SAVE_FAILED: "Unable to save subimage.",
  CROP_ROLLBACK_FAILED: "Unable to save subimage.",
};
const SUBIMAGE_BATCH_FAILURE_MESSAGES = {
  ...SUBIMAGE_ERROR_MESSAGES,
  BATCH_SCAN_FAILED: "Unable to scan source images.",
  DIMENSION_MISMATCH: "Source dimensions do not match the template.",
};
const INFERENCE_ERROR_MESSAGES = {
  ROOT_UNSET: "Storage root has not been set.",
  INVALID_ROOT: "Invalid inference root.",
  IMAGE_NOT_FOUND: "Inference image not found.",
  INVALID_SERVER_URL: "Model server URL is invalid.",
  INVALID_THRESHOLD: "Inference threshold is invalid.",
  INVALID_ROI: "ROI group is invalid.",
  INVALID_REFERENCE: "Reference image is invalid.",
  INVALID_TARGET_FRACTION: "Target area fraction is invalid.",
  MISSING_PROBABILITY_MAP: "Probability map does not exist.",
  INVALID_PROBABILITY_MAP: "Probability map is invalid.",
  INVALID_RESPONSE_TYPE: "Model response is invalid.",
  DIMENSION_MISMATCH: "Probability map dimensions do not match the source image.",
  INVALID_SETTINGS: "Saved threshold settings are invalid.",
  INVALID_SOURCE: "Unable to read source image dimensions.",
  SOURCE_READ_FAILED: "Unable to read source image.",
  MODEL_REQUEST_FAILED: "Model inference failed.",
  JOB_IN_PROGRESS: "Inference is already running.",
  JOB_NOT_FOUND: "Inference job not found.",
  MASK_WRITE_FAILED: "Unable to write mask image.",
};

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function isUnknownImageError(error) {
  return /unknown image id/i.test(error.message);
}

function isInvalidStorageRootError(error) {
  return /storage root must be an absolute path|storage root does not exist|storage root has no image(?: sequence)? folders/i.test(
    error.message,
  );
}

function isRootUnsetError(error) {
  return /storage root has not been set/i.test(error.message);
}

function isInvalidSavedBoundsJsonError(error) {
  return /invalid bounds json/i.test(error.message);
}

function isInvalidSavedAnalysisJsonError(error) {
  return /invalid analysis json/i.test(error.message);
}

function safeSubimageFailures(failures) {
  return failures.map(({ imageFolder, code }) => ({
    imageFolder,
    code,
    message: SUBIMAGE_BATCH_FAILURE_MESSAGES[code] ?? "Unable to process subimage.",
  }));
}

function subimageMutationContext(storage) {
  return storage.createSubimageMutationContext?.() ?? storage;
}

function safeErrorResponse(error) {
  if (isUnknownImageError(error)) {
    return { status: 404, body: { error: "Image not found." } };
  }

  if (error instanceof SubimageError) {
    return {
      status: error.status,
      body: {
        error: SUBIMAGE_ERROR_MESSAGES[error.code] ?? "Unable to process subimage.",
        code: error.code,
        ...(Array.isArray(error.details?.failures) ? { failures: safeSubimageFailures(error.details.failures) } : {}),
      },
    };
  }

  if (error instanceof InferenceError) {
    return {
      status: error.status,
      body: {
        error: INFERENCE_ERROR_MESSAGES[error.code] ?? "Unable to process inference data.",
        code: error.code,
      },
    };
  }

  if (error instanceof ExportError) {
    const messages = {
      ROOT_UNSET: "Storage root has not been set.",
      INVALID_CALIBRATION: "Invalid export calibration.",
      INVALID_IMAGE: "Export image id is invalid.",
      EXPORT_ABORTED: "Dataset export was cancelled.",
      EXPORT_FAILED: "Dataset export failed.",
    };

    return { status: error.status, body: { error: messages[error.code] ?? "Dataset export failed." } };
  }

  if (error instanceof AnalysisError) {
    const messages = {
      INVALID_ROI_BANDS: "Invalid ROI bands.",
      MISSING_BOUNDS: "Saved bounds are required before analysis.",
      MISSING_MASK: "Mask image is required before analysis.",
      MISSING_SKELETON: "Skeleton image is required before preview.",
      CORRUPT_BOUNDS: "Saved bounds JSON is invalid.",
      INVALID_BOUNDS: "Saved bounds are invalid.",
      INVALID_ANALYSIS: "Saved analysis JSON is invalid.",
      UNREADABLE_MASK: "Unable to read mask image.",
      UNREADABLE_SKELETON: "Unable to read skeleton image.",
      DIMENSION_MISMATCH: "Mask dimensions do not match saved bounds.",
      CALCULATION_FAILED: "Unable to calculate analysis metrics.",
    };

    return { status: error.status, body: { error: messages[error.code] ?? "Unable to calculate analysis metrics." } };
  }

  if (error instanceof HeatmapError) {
    const messages = {
      INVALID_ROOT: "Invalid heatmap batch root.",
      INVALID_CELL_SIZE: "Heatmap cell sizes must be valid positive integers.",
      MISSING_HEATMAP: "Saved heatmap does not exist.",
      STALE_HEATMAP: "Saved heatmap is stale.",
      INVALID_HEATMAP: "Saved heatmap is invalid.",
    };

    return { status: error.status, body: { error: messages[error.code] ?? "Unable to process heatmap data." } };
  }

  if (isInvalidSavedBoundsJsonError(error)) {
    return { status: 422, body: { error: "Saved bounds JSON is invalid." } };
  }

  if (isInvalidSavedAnalysisJsonError(error)) {
    return { status: 422, body: { error: "Saved analysis JSON is invalid." } };
  }

  if (isInvalidStorageRootError(error)) {
    return { status: 400, body: { error: "Invalid storage root." } };
  }

  if (isRootUnsetError(error)) {
    return { status: 400, body: { error: "Storage root has not been set." } };
  }

  if (error?.name === "SyntaxError") {
    return { status: 400, body: { error: "Invalid JSON payload." } };
  }

  return { status: 500, body: { error: "Server error." } };
}

function folderPickerResponse(error, { heatmap = false } = {}) {
  const messages = heatmap
    ? {
        [FOLDER_PICKER_CODES.CANCELLED]: "Heatmap folder selection was cancelled.",
        [FOLDER_PICKER_CODES.UNAVAILABLE]:
          "Heatmap folder picker is unavailable. Enter an absolute path in the Heatmap batch path field.",
        [FOLDER_PICKER_CODES.FAILED]:
          "Heatmap folder picker failed. Enter an absolute path in the Heatmap batch path field.",
      }
    : {
        [FOLDER_PICKER_CODES.CANCELLED]: "Root selection was cancelled.",
        [FOLDER_PICKER_CODES.UNAVAILABLE]:
          "Folder picker is unavailable. Enter an absolute path in Root path and press Set root.",
        [FOLDER_PICKER_CODES.FAILED]:
          "Folder picker failed. Enter an absolute path in Root path and press Set root.",
      };

  const code = error instanceof FolderPickerError
    ? error.code
    : FOLDER_PICKER_CODES.FAILED;
  const status = code === FOLDER_PICKER_CODES.CANCELLED
    ? 400
    : code === FOLDER_PICKER_CODES.UNAVAILABLE
      ? 503
      : 500;

  return { status, body: { error: messages[code] ?? messages[FOLDER_PICKER_CODES.FAILED] } };
}

function validOptionalString(value) {
  return value === undefined || typeof value === "string";
}

function exportContentDisposition(filename) {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\\r\n]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function validFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validOptionalDimension(value) {
  return value === undefined || value === null || validFiniteNumber(value);
}

function isValidBoundsPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  if (!validOptionalDimension(payload.width) || !validOptionalDimension(payload.height)) {
    return false;
  }

  if (payload.connectionMode !== undefined && payload.connectionMode !== CONNECTION_MODE) {
    return false;
  }

  if (!Array.isArray(payload.groups)) {
    return false;
  }

  return payload.groups.every((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      return false;
    }

    if (typeof group.id !== "string" || !validOptionalString(group.name) || !validOptionalString(group.color)) {
      return false;
    }

    if (!Array.isArray(group.points)) {
      return false;
    }

    return group.points.every((point) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) {
        return false;
      }

      return typeof point.id === "string" && validFiniteNumber(point.x) && validFiniteNumber(point.y);
    });
  });
}

async function rootPayload(storage) {
  const rootPath = storage.getRoot();
  const images = rootPath ? await storage.scanImages() : [];

  return { rootPath, images };
}

export function createApp({
  rootDir = process.cwd(),
  storage = null,
  initialRoot = null,
  selectRoot = null,
  selectHeatmapRoot = null,
  dataDir = null,
  maxImagePixels,
  fetchImpl = globalThis.fetch,
} = {}) {
  const app = express();
  const imageStorage = storage ?? createStorage({ initialRoot, selectRoot, dataDir });
  const inferenceService = createInferenceService({ storage: imageStorage, fetchImpl, maxImagePixels });
  const distDir = path.join(rootDir, "dist");
  const indexPath = path.join(distDir, "index.html");

  app.use(express.json({ limit: "10mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get(
    "/api/root",
    asyncRoute(async (_request, response) => {
      response.json(await rootPayload(imageStorage));
    }),
  );

  app.post(
    ["/api/root", "/api/inference/root"],
    asyncRoute(async (request, response) => {
      imageStorage.setRoot(request.body?.rootPath);
      response.json(await rootPayload(imageStorage));
    }),
  );

  app.post(
    ["/api/root/select", "/api/inference/root/select"],
    asyncRoute(async (_request, response) => {
      try {
        await imageStorage.selectRootWithFinder();
      } catch (error) {
        if (isInvalidStorageRootError(error)) {
          response.status(400).json({ error: "Selected folder is not a valid image root." });
          return;
        }

        const safeError = folderPickerResponse(error);
        response.status(safeError.status).json(safeError.body);
        return;
      }

      response.json(await rootPayload(imageStorage));
    }),
  );

  app.post(
    "/api/heatmaps/select-folder",
    asyncRoute(async (_request, response) => {
      try {
        response.json({ rootPath: await selectHeatmapRoot() });
      } catch (error) {
        const safeError = folderPickerResponse(error, { heatmap: true });
        response.status(safeError.status).json(safeError.body);
      }
    }),
  );

  app.post(
    "/api/heatmaps/generate",
    asyncRoute(async (request, response) => {
      response.json(
        await generateHeatmapBatch({
          rootPath: request.body?.rootPath,
          cellSizes: request.body?.cellSizes,
          maxImagePixels,
        }),
      );
    }),
  );

  app.get(
    "/api/images",
    asyncRoute(async (_request, response) => {
      if (!imageStorage.getRoot()) {
        response.status(400).json({ error: "Storage root has not been set." });
        return;
      }

      response.json({ images: await imageStorage.scanImages() });
    }),
  );

  app.get(
    "/api/inference/images",
    asyncRoute(async (_request, response) => {
      const images = await inferenceService.listImages();
      response.json({
        rootPath: imageStorage.getRoot(),
        images: images.map(({ id, timestampFolder, imageFile, status, message }) => ({
          id,
          timestampFolder,
          imageFile,
          status,
          ...(message ? { message } : {}),
        })),
      });
    }),
  );

  app.post(
    "/api/inference/jobs",
    asyncRoute(async (request, response) => {
      response.status(202).json({ job: inferenceService.startJob({ serverUrl: request.body?.serverUrl }) });
    }),
  );

  app.get(
    "/api/inference/jobs/:jobId",
    asyncRoute(async (request, response) => {
      response.json({ job: inferenceService.getJob(request.params.jobId) });
    }),
  );

  app.get(
    "/api/inference/images/:id/review",
    asyncRoute(async (request, response) => {
      const { map, polygon, ...review } = await inferenceService.loadReview(request.params.id, {
        roiGroupId: request.query.roiGroupId,
      });
      response.json(review);
    }),
  );

  app.put(
    "/api/inference/images/:id/threshold",
    asyncRoute(async (request, response) => {
      response.json(await inferenceService.saveThreshold(request.params.id, request.body));
    }),
  );

  app.get(
    "/api/inference/images/:id/overlay",
    asyncRoute(async (request, response) => {
      const overlay = await inferenceService.createOverlay(request.params.id, { threshold: Number(request.query.threshold) });
      response.type("image/png").set({ "Cache-Control": "no-store" }).send(overlay);
    }),
  );

  app.post(
    "/api/inference/reference-thresholds",
    asyncRoute(async (request, response) => {
      response.json(await inferenceService.applyReferenceThresholds(request.body));
    }),
  );

  app.post(
    "/api/inference/generate-masks",
    asyncRoute(async (_request, response) => {
      response.json(await inferenceService.generateMasks());
    }),
  );

  app.get("/api/images/:id", (request, response) => {
    try {
      response.json({ image: imageStorage.getImage(request.params.id) });
    } catch (error) {
      const safeError = safeErrorResponse(error);
      response.status(safeError.status).json(safeError.body);
    }
  });

  app.get(
    "/api/images/:id/raw16",
    asyncRoute(async (request, response) => {
      let imagePath;
      try {
        imagePath = imageStorage.imagePaths(request.params.id).imagePath;
      } catch (error) {
        const safeError = safeErrorResponse(error);
        response.status(safeError.status).json(safeError.body);
        return;
      }

      let raw;
      try {
        raw = await readGrey16RawFromImage(imagePath, { maxImagePixels });
      } catch {
        response.status(422).json({ error: "Unable to read image data." });
        return;
      }

      response
        .type("application/octet-stream")
        .set({
          "Cache-Control": "no-store",
          "X-Image-Width": String(raw.width),
          "X-Image-Height": String(raw.height),
          "X-Display-Min": String(raw.min),
          "X-Display-Max": String(raw.max),
          "X-Pixel-Format": "uint16le",
        })
        .send(raw.buffer);
    }),
  );

  app.get(
    "/api/images/:id/heatmap",
    asyncRoute(async (request, response) => {
      let cellSize;
      try {
        cellSize = validateCellSize(request.query.cellSize);
      } catch {
        response.status(400).json({ error: "Invalid heatmap cell size." });
        return;
      }

      response.json({ heatmap: await loadImageHeatmap(imageStorage, request.params.id, cellSize) });
    }),
  );

  app.get(
    "/api/images/:id/mask-preview",
    asyncRoute(async (request, response) => {
      const preview = await createMaskPreview(imageStorage, request.params.id, { maxImagePixels });

      response
        .type("image/png")
        .set({
          "Cache-Control": "no-store",
          "X-Image-Width": String(preview.width),
          "X-Image-Height": String(preview.height),
          "X-Mask-File": preview.maskFile,
        })
        .send(preview.buffer);
    }),
  );

  app.get(
    "/api/images/:id/skeleton-preview",
    asyncRoute(async (request, response) => {
      const preview = await createSkeletonPreview(imageStorage, request.params.id, { maxImagePixels });

      response
        .type("image/png")
        .set({
          "Cache-Control": "no-store",
          "X-Image-Width": String(preview.width),
          "X-Image-Height": String(preview.height),
          "X-Skeleton-File": preview.skeletonFile,
        })
        .send(preview.buffer);
    }),
  );

  app.post(
    "/api/images/:id/roi-overlay",
    asyncRoute(async (request, response) => {
      const overlay = await createRoiOverlay(imageStorage, request.params.id, {
        bounds: request.body?.bounds,
        roiBands: request.body?.roiBands,
        maxImagePixels,
      });

      response
        .type("image/png")
        .set({
          "Cache-Control": "no-store",
          "X-Image-Width": String(overlay.width),
          "X-Image-Height": String(overlay.height),
        })
        .send(overlay.buffer);
    }),
  );

  app.get(
    "/api/images/:id/bounds",
    asyncRoute(async (request, response) => {
      const { boundsPath } = imageStorage.imagePaths(request.params.id);
      const hasBounds = existsSync(boundsPath);
      const bounds = await imageStorage.loadBounds(request.params.id);

      response.json({ bounds, hasBounds });
    }),
  );

  app.put(
    "/api/images/:id/bounds",
    asyncRoute(async (request, response) => {
      if (!isValidBoundsPayload(request.body)) {
        response.status(400).json({ error: "Invalid bounds payload." });
        return;
      }

      const bounds = await imageStorage.saveBounds(request.params.id, request.body);

      response.json({ bounds });
    }),
  );

  app.post(
    "/api/images/:id/bounds/import-previous",
    asyncRoute(async (request, response) => {
      const bounds = await imageStorage.importPreviousBounds(request.params.id);

      response.json({ bounds });
    }),
  );

  app.get(
    "/api/images/:id/analysis",
    asyncRoute(async (request, response) => {
      response.json(await loadAnalysis(imageStorage, request.params.id));
    }),
  );

  app.post(
    "/api/images/:id/analysis/recalculate",
    asyncRoute(async (request, response) => {
      response.json(
        await recalculateAnalysis(imageStorage, request.params.id, {
          roiBands: request.body?.roiBands,
          roiBandsByGroup: request.body?.roiBandsByGroup,
          maxImagePixels,
        }),
      );
    }),
  );

  app.get(
    "/api/images/:id/subimage",
    asyncRoute(async (request, response) => {
      response.json(await loadSubimage(imageStorage, request.params.id, { maxImagePixels }));
    }),
  );

  app.put(
    "/api/images/:id/subimage",
    asyncRoute(async (request, response) => {
      const storageContext = subimageMutationContext(imageStorage);
      response.json(await saveSubimage(storageContext, request.params.id, request.body?.crop, { maxImagePixels }));
    }),
  );

  app.post(
    "/api/subimages/create-missing",
    asyncRoute(async (request, response) => {
      const storageContext = subimageMutationContext(imageStorage);
      response.json(await createMissingSubimages(storageContext, request.body?.templateCrop, { maxImagePixels }));
    }),
  );

  app.post(
    "/api/subimages/replace-all",
    asyncRoute(async (request, response) => {
      const storageContext = subimageMutationContext(imageStorage);
      response.json(await replaceAllSubimages(storageContext, request.body?.templateCrop, { maxImagePixels }));
    }),
  );

  app.post("/api/export", async (request, response, next) => {
    try {
      const calibration = validateExportCalibration(request.body?.calibration);
      let exportStorage;
      try {
        exportStorage = imageStorage.createSnapshot?.() ?? imageStorage;
      } catch {
        throw new ExportError("ROOT_UNSET", "Storage root has not been set.", 400);
      }
      const rootPath = exportStorage.getRoot();
      if (!rootPath) {
        throw new ExportError("ROOT_UNSET", "Storage root has not been set.", 400);
      }

      const requestedImageId = request.body?.autoSavedImageId;
      if (requestedImageId !== undefined && requestedImageId !== null && typeof requestedImageId !== "string") {
        throw new ExportError("INVALID_IMAGE", "Export image id is invalid.", 400);
      }
      const autoSavedImageId = requestedImageId ?? null;
      if (autoSavedImageId !== null) {
        try {
          exportStorage.getImage(autoSavedImageId);
        } catch {
          throw new ExportError("INVALID_IMAGE", "Export image id is invalid.", 400);
        }
      }

      const now = new Date();
      const filename = datasetExportFilename(rootPath, now);
      const abortController = new AbortController();
      request.once("aborted", () => abortController.abort());
      response.once("close", () => {
        if (!response.writableFinished) abortController.abort();
      });

      response.status(200);
      response.setHeader("Content-Type", "application/zip");
      response.setHeader("Content-Disposition", exportContentDisposition(filename));

      await writeDatasetZip({
        storage: exportStorage,
        output: response,
        calibration,
        autoSavedImageId,
        maxImagePixels,
        now: () => now,
        signal: abortController.signal,
      });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }

      next(error);
    }
  });

  if (existsSync(indexPath)) {
    app.use(express.static(distDir));
    app.get("*", (_request, response) => {
      response.sendFile(indexPath);
    });
  }

  app.use((error, _request, response, _next) => {
    const safeError = safeErrorResponse(error);
    response.status(safeError.status).json(safeError.body);
  });

  return app;
}
