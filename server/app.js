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

const CONNECTION_MODE = "input-order-cycle";

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function isUnknownImageError(error) {
  return /unknown image id/i.test(error.message);
}

function isInvalidStorageRootError(error) {
  return /storage root must be an absolute path|storage root does not exist|storage root has no image sequence folders/i.test(
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

function safeErrorResponse(error) {
  if (isUnknownImageError(error)) {
    return { status: 404, body: { error: "Image not found." } };
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
} = {}) {
  const app = express();
  const imageStorage = storage ?? createStorage({ initialRoot, selectRoot, dataDir });
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
    "/api/root",
    asyncRoute(async (request, response) => {
      imageStorage.setRoot(request.body?.rootPath);
      response.json(await rootPayload(imageStorage));
    }),
  );

  app.post(
    "/api/root/select",
    asyncRoute(async (_request, response) => {
      try {
        await imageStorage.selectRootWithFinder();
      } catch (error) {
        response.status(400).json({ error: "Root selection was cancelled or failed." });
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
      } catch {
        response.status(400).json({ error: "Heatmap folder selection was cancelled or failed." });
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
    app.get("/", (_request, response) => {
      response.sendFile(indexPath);
    });
  }

  app.use((error, _request, response, _next) => {
    const safeError = safeErrorResponse(error);
    response.status(safeError.status).json(safeError.body);
  });

  return app;
}
