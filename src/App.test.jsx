/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "./App.jsx";

const images = [
  {
    id: "scan-a",
    folder: "plate-a",
    imageFolder: "plate-a",
    file: "a.tif",
    imageFile: "a.tif",
    width: 100,
    height: 80,
  },
  {
    id: "scan-b",
    folder: "plate-b",
    imageFolder: "plate-b",
    file: "b.tif",
    imageFile: "b.tif",
    width: 120,
    height: 90,
  },
];

const imagesWithoutDimensions = images.map(({ height, width, ...image }) => image);

const subimageImages = images.map((image) => ({ ...image, width: 100, height: 80 }));

const savedSubimage = {
  schemaVersion: 1,
  imageFolder: "plate-a",
  imageFile: "a.tif",
  sourceWidth: 100,
  sourceHeight: 80,
  x: 10,
  y: 8,
  width: 50,
  height: 40,
  aspectRatio: 1.25,
  updatedAt: "2026-08-04T00:00:00.000Z",
};

const savedSubimageB = {
  ...savedSubimage,
  imageFolder: "plate-b",
  imageFile: "b.tif",
  x: 30,
  y: 20,
};

function heatmapFixture(imageFolder, cellSize, pixelDensity = 0.04, width = 100, height = 80) {
  return {
    schemaVersion: 1,
    imageFolder,
    imageFile: `${imageFolder}.tif`,
    width,
    height,
    cellWidth: cellSize,
    cellHeight: cellSize,
    rows: 1,
    columns: 1,
    cells: [
      {
        row: 0,
        column: 0,
        x: 0,
        y: 0,
        width,
        height,
        areaPx: width * height,
        maskPixelCount: Math.round(pixelDensity * width * height),
        pixelDensity,
      },
    ],
  };
}

function gridHeatmapFixture(imageFolder, cellSize, pixelDensity = 0.04, width = 100, height = 80) {
  const columns = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const cells = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * cellSize;
      const y = row * cellSize;
      const cellWidth = Math.min(cellSize, width - x);
      const cellHeight = Math.min(cellSize, height - y);
      cells.push({
        row,
        column,
        x,
        y,
        width: cellWidth,
        height: cellHeight,
        areaPx: cellWidth * cellHeight,
        maskPixelCount: Math.round(pixelDensity * cellWidth * cellHeight),
        pixelDensity,
      });
    }
  }

  return {
    ...heatmapFixture(imageFolder, cellSize, pixelDensity, width, height),
    columns,
    rows,
    cells,
  };
}

const heatmapA5 = heatmapFixture("plate-a", 5, 0.04);
const heatmapB5 = heatmapFixture("plate-b", 5, 0.08, 120, 90);

const emptyBounds = {
  schemaVersion: 1,
  imageFolder: "plate-a",
  imageFile: "a.tif",
  width: null,
  height: null,
  connectionMode: "input-order-cycle",
  groups: [],
};

const savedBounds = {
  schemaVersion: 1,
  imageFolder: "plate-a",
  imageFile: "a.tif",
  width: 100,
  height: 80,
  connectionMode: "input-order-cycle",
  groups: [
    {
      id: "group-saved",
      name: "Saved Tissue",
      color: "#e11d48",
      points: [
        { id: "point-1", x: 10, y: 12 },
        { id: "point-2", x: 40, y: 14 },
        { id: "point-3", x: 20, y: 36 },
      ],
    },
  ],
  updatedAt: "2026-07-03T00:00:00.000Z",
};

const boundsWithInsideGroup = {
  ...savedBounds,
  groups: [
    savedBounds.groups[0],
    {
      id: "group-inside",
      name: "Inside Patch",
      color: "#2563eb",
      analysisMode: "inside",
      points: [
        { id: "inside-1", x: 60, y: 12 },
        { id: "inside-2", x: 80, y: 12 },
        { id: "inside-3", x: 70, y: 32 },
      ],
    },
  ],
};

const boundsWithMigration = {
  ...savedBounds,
  groups: [
    {
      ...savedBounds.groups[0],
      migrationVector: {
        start: { x: 10, y: 12 },
        end: { x: 40, y: 12 },
      },
    },
  ],
};

const reloadedBounds = {
  ...savedBounds,
  groups: [
    {
      ...savedBounds.groups[0],
      id: "group-reloaded",
      name: "Reloaded Bound",
      points: [{ id: "point-4", x: 8, y: 9 }],
    },
  ],
};

const legacyBounds = {
  schemaVersion: 1,
  imageFolder: "plate-a",
  imageFile: "a.tif",
  width: 100,
  height: 80,
  connectionMode: "manual",
  groups: [
    {
      name: "Legacy Bound",
      color: "#e11d48",
      points: [
        { x: 7, y: 8 },
        { id: "kept-point", x: 12, y: 14 },
      ],
    },
  ],
};

const savedAnalysis = {
  schemaVersion: 5,
  imageFolder: "plate-a",
  imageFile: "a.tif",
  boundsFile: "plate-a.bounds.json",
  maskSource: { file: "plate-a.png", format: "png", width: 100, height: 80, mtimeMs: 1000 },
  skeletonFile: "plate-a.skeleton.png",
  roiBands: [
    { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
    { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
    { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
  ],
  groups: [
    {
      groupId: "group-saved",
      groupName: "Saved Tissue",
      color: "#e11d48",
      analysisMode: "outside",
      bands: {
        near: {
          roiAreaPx: 25,
          maskPixelCount: 5,
          density: 0.2,
          globalAlignment: 0.8,
          circularVariance: 0.2,
          radialNormalAlignment: 0.7,
          tangentialAlignment: 0.3,
          migrationAlignment: 0.6,
          empty: false,
        },
      },
      allBands: {
        roiAreaPx: 25,
        maskPixelCount: 5,
        density: 0.2,
        globalAlignment: 0.8,
        circularVariance: 0.2,
        radialNormalAlignment: 0.7,
        tangentialAlignment: 0.3,
        migrationAlignment: 0.6,
        empty: false,
      },
    },
  ],
  imageSummary: {
    roiAreaPx: 25,
    maskPixelCount: 5,
    density: 0.2,
    globalAlignment: 0.8,
    circularVariance: 0.2,
    radialNormalAlignment: 0.7,
    tangentialAlignment: 0.3,
    migrationAlignment: 0.6,
  },
  warnings: [],
  updatedAt: "2026-07-05T00:00:00.000Z",
};

const insideAnalysis = {
  ...savedAnalysis,
  groups: [
    {
      groupId: "group-saved",
      groupName: "Saved Tissue",
      color: "#e11d48",
      analysisMode: "inside",
      area: {
        bandId: "inside",
        roiAreaPx: 40,
        maskPixelCount: 10,
        density: 0.25,
        globalAlignment: 0.9,
        circularVariance: 0.1,
        radialNormalAlignment: null,
        tangentialAlignment: null,
        migrationAlignment: null,
        empty: false,
      },
    },
  ],
};

const twoGroupAnalysis = {
  ...savedAnalysis,
  groups: [
    savedAnalysis.groups[0],
    {
      groupId: "group-inside",
      groupName: "Inside Patch",
      color: "#2563eb",
      analysisMode: "inside",
      area: {
        bandId: "inside",
        roiAreaPx: 40,
        maskPixelCount: 10,
        density: 0.25,
        globalAlignment: 0.9,
        circularVariance: 0.1,
        radialNormalAlignment: null,
        tangentialAlignment: null,
        migrationAlignment: null,
        empty: false,
      },
    },
  ],
};

function jsonResponse(body, init = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    }),
  );
}

function raw16Response(width = 100, height = 80) {
  return Promise.resolve(
    new Response(new ArrayBuffer(width * height * 2), {
      status: 200,
      headers: {
        "x-image-width": String(width),
        "x-image-height": String(height),
        "x-display-min": "0",
        "x-display-max": "65535",
        "x-pixel-format": "uint16le",
      },
    }),
  );
}

function pngResponse() {
  return Promise.resolve(
    new Response(new Blob(["png"], { type: "image/png" }), {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
  );
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function mockApi({
  boundsQueue = [savedBounds],
  rootImages = images,
  rootPath = "/data/root",
  appliedRootPath = "/typed/root",
  appliedRootImages = rootImages,
  saveResponse = null,
  exportResponse = null,
  delayedExport = false,
  analysisResponse = { analysis: null, hasAnalysis: false },
  recalculateAnalysis = savedAnalysis,
  heatmapResponse,
  selectHeatmapFolderResponse,
  generateHeatmapsResponse,
  rawDimensionsById = {},
  subimageResponse,
  saveSubimageResponse,
  createSubimagesResponse,
  replaceSubimagesResponse,
} = {}) {
  const calls = [];
  const exportDeferred = delayedExport ? deferred() : null;
  const fetchMock = vi.fn((input, options = {}) => {
    const url = String(input);
    const method = options.method ?? "GET";
    calls.push({ url, method, options });

    if (url === "/api/root" && method === "GET") {
      return jsonResponse({ rootPath, images: rootImages });
    }
    if (url === "/api/root" && method === "POST") {
      return jsonResponse({ rootPath: appliedRootPath, images: appliedRootImages });
    }
    if (url === "/api/root/select" && method === "POST") {
      return jsonResponse({ rootPath: "/selected/root", images: rootImages });
    }
    if (url === "/api/heatmaps/select-folder" && method === "POST") {
      if (selectHeatmapFolderResponse) return selectHeatmapFolderResponse();
      return jsonResponse({ rootPath: "/selected/heatmap-root" });
    }
    if (url === "/api/heatmaps/generate" && method === "POST") {
      if (generateHeatmapsResponse) return generateHeatmapsResponse(options);
      return jsonResponse({
        discovered: 2,
        completed: 2,
        skipped: 0,
        failed: 0,
        generatedFiles: 6,
        failures: [],
      });
    }
    if (url === "/api/subimages/create-missing" && method === "POST") {
      if (createSubimagesResponse) return createSubimagesResponse(options);
      return jsonResponse({
        operation: "create-missing",
        discovered: rootImages.length,
        completed: rootImages.length,
        created: rootImages.map((image) => image.imageFolder),
        preserved: [],
        replaced: [],
        failed: [],
      });
    }
    if (url === "/api/subimages/replace-all" && method === "POST") {
      if (replaceSubimagesResponse) return replaceSubimagesResponse(options);
      return jsonResponse({
        operation: "replace-all",
        discovered: rootImages.length,
        completed: rootImages.length,
        created: [],
        preserved: [],
        replaced: rootImages.map((image) => image.imageFolder),
        failed: [],
      });
    }
    if (url === "/api/export" && method === "POST") {
      if (exportResponse) return exportResponse;
      if (exportDeferred) return exportDeferred.promise;
      return Promise.resolve(
        new Response(new Blob(["zip"], { type: "application/zip" }), {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="dataset_export.zip"',
          },
        }),
      );
    }
    const heatmapMatch = url.match(/^\/api\/images\/(scan-a|scan-b|scan-c)\/heatmap\?cellSize=(\d+)$/);
    if (heatmapMatch && method === "GET") {
      if (heatmapResponse) return heatmapResponse(url, Number(heatmapMatch[2]));
      const imageId = heatmapMatch[1];
      const cellSize = Number(heatmapMatch[2]);
      const fixture = imageId === "scan-a" ? heatmapA5 : heatmapB5;
      return jsonResponse({ heatmap: { ...fixture, cellWidth: cellSize, cellHeight: cellSize } });
    }
    if (url === "/api/images/scan-a" && method === "GET") {
      return jsonResponse({ image: images[0] });
    }
    if (url === "/api/images/scan-b" && method === "GET") {
      return jsonResponse({ image: images[1] });
    }
    if (url === "/api/images/scan-c" && method === "GET") {
      return jsonResponse({ image: rootImages.find((image) => image.id === "scan-c") });
    }
    if (url === "/api/images/scan-a/raw16" && method === "GET") {
      return raw16Response(...(rawDimensionsById["scan-a"] ?? [100, 80]));
    }
    if (url === "/api/images/scan-a/roi-overlay" && method === "POST") {
      return pngResponse();
    }
    if (url === "/api/images/scan-b/raw16" && method === "GET") {
      return raw16Response(...(rawDimensionsById["scan-b"] ?? [120, 90]));
    }
    if (url === "/api/images/scan-b/roi-overlay" && method === "POST") {
      return pngResponse();
    }
    if (url === "/api/images/scan-c/raw16" && method === "GET") {
      return raw16Response(...(rawDimensionsById["scan-c"] ?? [100, 80]));
    }
    if (url === "/api/images/scan-c/roi-overlay" && method === "POST") {
      return pngResponse();
    }
    const subimageMatch = url.match(/^\/api\/images\/([^/]+)\/subimage$/);
    if (subimageMatch && method === "GET") {
      if (subimageResponse) return subimageResponse(subimageMatch[1], options);
      return jsonResponse({ hasSubimage: false, crop: null });
    }
    if (subimageMatch && method === "PUT") {
      if (saveSubimageResponse) return saveSubimageResponse(subimageMatch[1], options);
      return jsonResponse({ crop: JSON.parse(options.body).crop });
    }
    if (url === "/api/images/scan-a/bounds" && method === "GET") {
      return jsonResponse({ bounds: boundsQueue.shift() ?? savedBounds, hasBounds: true });
    }
    if (url === "/api/images/scan-a/analysis" && method === "GET") {
      return jsonResponse(analysisResponse);
    }
    if (url === "/api/images/scan-a/analysis/recalculate" && method === "POST") {
      return jsonResponse({ analysis: recalculateAnalysis, hasAnalysis: true });
    }
    if (url === "/api/images/scan-b/bounds" && method === "GET") {
      return jsonResponse({
        bounds: {
          ...savedBounds,
          imageFolder: "plate-b",
          imageFile: "b.tif",
          width: 120,
          height: 90,
          groups: [],
        },
        hasBounds: false,
      });
    }
    if (url === "/api/images/scan-b/analysis" && method === "GET") {
      return jsonResponse({ analysis: null, hasAnalysis: false });
    }
    if (url === "/api/images/scan-c/bounds" && method === "GET") {
      return jsonResponse({
        bounds: {
          ...savedBounds,
          imageFolder: "plate-c",
          imageFile: "c.tif",
          width: 100,
          height: 80,
          groups: [],
        },
        hasBounds: false,
      });
    }
    if (url === "/api/images/scan-c/analysis" && method === "GET") {
      return jsonResponse({ analysis: null, hasAnalysis: false });
    }
    if (url === "/api/images/scan-a/bounds" && method === "PUT") {
      if (saveResponse) {
        return saveResponse(options);
      }
      return jsonResponse({ bounds: JSON.parse(options.body) });
    }
    if (url === "/api/images/scan-a/bounds/import-previous" && method === "POST") {
      return jsonResponse({ bounds: reloadedBounds });
    }

    return Promise.reject(new Error(`Unexpected fetch ${method} ${url}`));
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    calls,
    releaseExport: (response) => exportDeferred?.resolve(response),
  };
}

function mockSubimageApi(options = {}) {
  return mockApi({
    rootImages: subimageImages,
    rawDimensionsById: { "scan-a": [100, 80], "scan-b": [100, 80] },
    subimageResponse: (imageId) => jsonResponse(
      imageId === "scan-a"
        ? { hasSubimage: true, crop: savedSubimage }
        : { hasSubimage: true, crop: savedSubimageB },
    ),
    ...options,
  });
}

function renderedRect(width = 1000, height = 800) {
  return {
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    x: 0,
    y: 0,
    toJSON: () => {},
  };
}

async function enterSubimage() {
  await screen.findByRole("button", { name: "Saved Tissue" });
  fireEvent.click(screen.getByRole("button", { name: "Subimage" }));
  await screen.findByRole("heading", { name: "Subimage" });
}

function mockSubimageCanvasRect() {
  const canvas = screen.getByLabelText("raw16 image");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(renderedRect());
  return screen.getByTestId("image-stage");
}

function drawSubimageCrop(stage, {
  start = { clientX: 100, clientY: 80 },
  end = { clientX: 590, clientY: 470 },
} = {}) {
  fireSubimagePointer(stage, "pointerdown", { ...start, button: 0, pointerId: 1 });
  fireSubimagePointer(stage, "pointermove", { ...end, pointerId: 1 });
  fireSubimagePointer(stage, "pointerup", { ...end, pointerId: 1 });
}

function moveSubimageCrop(stage) {
  fireSubimagePointer(stage, "pointerdown", {
    clientX: 400,
    clientY: 300,
    button: 0,
    pointerId: 2,
  });
  fireSubimagePointer(stage, "pointermove", {
    clientX: 1000,
    clientY: 0,
    pointerId: 2,
  });
  fireSubimagePointer(stage, "pointerup", {
    clientX: 1000,
    clientY: 0,
    pointerId: 2,
  });
}

function fireSubimagePointer(target, type, { pointerId, ...init }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "mouse" },
  });
  fireEvent(target, event);
}

async function renderDirtySubimage(options = {}) {
  const api = mockSubimageApi(options);
  render(<App />);
  await enterSubimage();
  const stage = mockSubimageCanvasRect();
  moveSubimageCrop(stage);
  await screen.findByText("x 50");
  return { ...api, stage };
}

describe("App", () => {
  let canvasContexts;

  beforeEach(() => {
    canvasContexts = new WeakMap();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function getContext() {
      if (!canvasContexts.has(this)) {
        canvasContexts.set(this, {
          clearRect: vi.fn(),
          fillRect: vi.fn(),
          fillStyle: "",
          globalAlpha: 1,
          imageSmoothingEnabled: true,
        });
      }
      return canvasContexts.get(this);
    });
    localStorage.clear();
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:roi-overlay"),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("renders root selection controls first", () => {
    mockApi({ rootImages: [] });
    render(<App />);
    expect(screen.getByRole("button", { name: /find root/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set root/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/root path/i)).toBeInTheDocument();
  });

  test("sets a typed root again after an existing root is loaded", async () => {
    const { fetchMock } = mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const rootPathInput = screen.getByLabelText(/root path/i);
    fireEvent.change(rootPathInput, { target: { value: "/new/root" } });
    fireEvent.click(screen.getByRole("button", { name: /set root/i }));

    await waitFor(() => expect(rootPathInput).toHaveValue("/typed/root"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/root",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ rootPath: "/new/root" }),
      }),
    );
  });

  test("keeps ZIP export disabled until a typed root is successfully applied", async () => {
    mockApi({ rootImages: [], rootPath: "" });
    render(<App />);

    const download = await screen.findByRole("button", { name: "Download as ZIP" });
    const rootPathInput = screen.getByLabelText(/root path/i);
    expect(download).toBeDisabled();

    fireEvent.change(rootPathInput, { target: { value: "/not-yet-applied" } });
    expect(download).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /set root/i }));

    await waitFor(() => expect(rootPathInput).toHaveValue("/typed/root"));
    expect(download).toBeEnabled();
  });

  test("loads saved bounds when opening an image", async () => {
    mockApi();

    render(<App />);

    expect(await screen.findByRole("button", { name: "Saved Tissue" })).toBeInTheDocument();
    expect(screen.getByText(/saved bound loaded/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Vertex point-1")).toHaveAttribute("cx", "10");
  });

  test("replaces Load saved bound and downloads the named ZIP", async () => {
    const { fetchMock } = mockApi({
      exportResponse: Promise.resolve(
        new Response(new Blob(["zip"], { type: "application/zip" }), {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="study_export_20260727-090000.zip"',
          },
        }),
      ),
    });
    let downloadedFilename = "";
    const click = vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function recordDownload() {
      downloadedFilename = this.download;
    });
    URL.createObjectURL.mockReturnValueOnce("blob:export");

    render(<App />);

    expect(await screen.findByRole("button", { name: "Download as ZIP" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Load saved bound" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download as ZIP" }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(downloadedFilename).toBe("study_export_20260727-090000.zip");
    expect(screen.getByRole("status")).toHaveTextContent("ZIP downloaded");
    const exportCall = fetchMock.mock.calls.find(([url]) => url === "/api/export");
    expect(JSON.parse(exportCall[1].body)).toEqual({
      calibration: {
        slope: 0.069676956982087,
        intercept: 0.067893820336777,
      },
      autoSavedImageId: null,
    });
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export"));
  });

  test("uses an RFC 5987 ZIP filename when the export response provides one", async () => {
    mockApi({
      exportResponse: Promise.resolve(
        new Response(new Blob(["zip"], { type: "application/zip" }), {
          status: 200,
          headers: {
            "content-disposition": "attachment; filename*=UTF-8''study%20export.zip",
          },
        }),
      ),
    });
    let downloadedFilename = "";
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function recordDownload() {
      downloadedFilename = this.download;
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Download as ZIP" }));

    await waitFor(() => expect(downloadedFilename).toBe("study export.zip"));
  });

  test("falls back to a safe ZIP filename for traversal content disposition", async () => {
    mockApi({
      exportResponse: Promise.resolve(
        new Response(new Blob(["zip"], { type: "application/zip" }), {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="../outside.zip"',
          },
        }),
      ),
    });
    let downloadedFilename = "";
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function recordDownload() {
      downloadedFilename = this.download;
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Download as ZIP" }));

    await waitFor(() => expect(downloadedFilename).toBe("dataset_export.zip"));
  });

  test("falls back to a safe ZIP filename for malformed extended content disposition", async () => {
    mockApi({
      exportResponse: Promise.resolve(
        new Response(new Blob(["zip"], { type: "application/zip" }), {
          status: 200,
          headers: {
            "content-disposition": "attachment; filename*=UTF-8''broken%ZZ.zip",
          },
        }),
      ),
    });
    let downloadedFilename = "";
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function recordDownload() {
      downloadedFilename = this.download;
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Download as ZIP" }));

    await waitFor(() => expect(downloadedFilename).toBe("dataset_export.zip"));
  });

  test("saves dirty bounds before exporting and blocks duplicate ZIP requests", async () => {
    const { fetchMock, releaseExport } = mockApi({ delayedExport: true });
    render(<App />);

    await screen.findByRole("button", { name: "Saved Tissue" });
    fireEvent.click(screen.getByRole("button", { name: "Inside area" }));
    const button = screen.getByRole("button", { name: "Download as ZIP" });

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveTextContent("Preparing ZIP..."));
    expect(button).toBeDisabled();
    const saveIndex = fetchMock.mock.calls.findIndex(
      ([url, options]) => url === "/api/images/scan-a/bounds" && options?.method === "PUT",
    );
    const exportIndex = fetchMock.mock.calls.findIndex(([url]) => url === "/api/export");
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThan(saveIndex);
    expect(JSON.parse(fetchMock.mock.calls[exportIndex][1].body).autoSavedImageId).toBe("scan-a");

    fireEvent.click(button);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/export")).toHaveLength(1);
    releaseExport(
      new Response(new Blob(["zip"], { type: "application/zip" }), {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="study_export.zip"',
        },
      }),
    );
  });

  test("locks root and image controls while ZIP export is active", async () => {
    const { releaseExport } = mockApi({ delayedExport: true });
    render(<App />);

    const download = await screen.findByRole("button", { name: "Download as ZIP" });
    fireEvent.click(download);

    await waitFor(() => expect(download).toHaveTextContent("Preparing ZIP..."));
    expect(screen.getByRole("button", { name: "Find root" })).toBeDisabled();
    expect(screen.getByLabelText(/root path/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set root" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next image" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import previous bound" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Preparing ZIP...");

    releaseExport(
      new Response(new Blob(["zip"], { type: "application/zip" }), {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="dataset_export.zip"' },
      }),
    );
    await waitFor(() => expect(download).toHaveTextContent("Download as ZIP"));
    expect(screen.getByRole("button", { name: "Find root" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next image" })).toBeEnabled();
  });

  test("keeps later local geometry edits dirty when an export auto-save resolves", async () => {
    const pendingSave = deferred();
    let savedSnapshot = null;
    const { fetchMock, releaseExport } = mockApi({
      delayedExport: true,
      saveResponse: (options) => {
        savedSnapshot = JSON.parse(options.body);
        return pendingSave.promise;
      },
    });
    render(<App />);

    await screen.findByRole("button", { name: "Saved Tissue" });
    fireEvent.click(screen.getByRole("button", { name: "Inside area" }));
    fireEvent.click(screen.getByRole("button", { name: "Download as ZIP" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/images/scan-a/bounds",
        expect.objectContaining({ method: "PUT" }),
      ),
    );

    fireEvent.click(screen.getByTestId("image-stage"), { clientX: 55, clientY: 24 });
    expect(await screen.findByLabelText("Vertex point-4")).toHaveAttribute("cx", "55");

    pendingSave.resolve(await jsonResponse({ bounds: savedSnapshot }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/export", expect.any(Object)));

    expect(screen.getByLabelText("Vertex point-4")).toHaveAttribute("cx", "55");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    releaseExport(
      new Response(new Blob(["zip"], { type: "application/zip" }), {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="dataset_export.zip"' },
      }),
    );
  });

  test("announces ZIP export progress through a live status", async () => {
    const { releaseExport } = mockApi({ delayedExport: true });
    render(<App />);

    const button = await screen.findByRole("button", { name: "Download as ZIP" });
    fireEvent.click(button);

    expect(await screen.findByRole("status")).toHaveTextContent("Preparing ZIP...");
    releaseExport(
      new Response(new Blob(["zip"], { type: "application/zip" }), {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="dataset_export.zip"' },
      }),
    );
  });

  test("restores the ZIP button with safe feedback after an export error", async () => {
    mockApi({
      exportResponse: Promise.resolve(new Response("not a ZIP", { status: 500 })),
    });
    render(<App />);

    const button = await screen.findByRole("button", { name: "Download as ZIP" });
    fireEvent.click(button);

    expect(await screen.findByRole("status")).toHaveTextContent("Export failed.");
    expect(button).toBeEnabled();
  });

  test("defaults loaded groups to outside mode and saves selected inside mode", async () => {
    const { fetchMock } = mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    expect(screen.getByRole("button", { name: "Outside ROI" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Inside area" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/images/scan-a/bounds",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const saveCall = fetchMock.mock.calls.find(([url, options]) => url === "/api/images/scan-a/bounds" && options?.method === "PUT");
    expect(JSON.parse(saveCall[1].body).groups[0].analysisMode).toBe("inside");
  });

  test("sets the active group to full image inside analysis", async () => {
    const { fetchMock } = mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.click(screen.getByRole("button", { name: "Full image inside" }));

    expect(screen.getByRole("button", { name: "Inside area" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Saved Tissue")).toHaveTextContent("4 / Inside area");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/images/scan-a/bounds",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const saveCall = fetchMock.mock.calls.find(([url, options]) => url === "/api/images/scan-a/bounds" && options?.method === "PUT");
    expect(JSON.parse(saveCall[1].body).groups[0]).toMatchObject({
      name: "Saved Tissue",
      analysisMode: "inside",
      points: [
        { id: "point-1", x: 0, y: 0 },
        { id: "point-2", x: 99, y: 0 },
        { id: "point-3", x: 99, y: 79 },
        { id: "point-4", x: 0, y: 79 },
      ],
    });
  });

  test("creates a group when choosing an analysis mode before any group exists", async () => {
    const { fetchMock } = mockApi({ boundsQueue: [emptyBounds] });

    render(<App />);
    await waitFor(() => expect(screen.getAllByText(/no active group/i).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Inside area" }));

    expect(await screen.findByRole("button", { name: "Group 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inside area" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/images/scan-a/bounds",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const saveCall = fetchMock.mock.calls.find(([url, options]) => url === "/api/images/scan-a/bounds" && options?.method === "PUT");
    expect(JSON.parse(saveCall[1].body).groups[0]).toMatchObject({
      name: "Group 1",
      analysisMode: "inside",
    });
  });

  test("sets a group migration vector from two stage clicks and saves it", async () => {
    const { fetchMock } = mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const stage = screen.getByTestId("image-stage");
    const canvas = screen.getByLabelText("raw16 image");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 80,
      width: 100,
      height: 80,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 80,
      width: 100,
      height: 80,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.click(screen.getByRole("button", { name: /set migration/i }));
    fireEvent.click(stage, { clientX: 10, clientY: 12 });
    fireEvent.click(stage, { clientX: 40, clientY: 12 });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/images/scan-a/bounds",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const saveCall = fetchMock.mock.calls.find(([url, options]) => url === "/api/images/scan-a/bounds" && options?.method === "PUT");
    expect(JSON.parse(saveCall[1].body).groups[0].migrationVector).toEqual({
      start: { x: 10, y: 12 },
      end: { x: 40, y: 12 },
    });
  });

  test("loads saved analysis after opening an image", async () => {
    mockApi({ analysisResponse: { analysis: savedAnalysis, hasAnalysis: true } });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/analysis loaded/i)).toBeInTheDocument());
    expect(screen.getByText("plate-a.png")).toBeInTheDocument();
    expect(screen.getAllByText("0.2000").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Mode" })).toBeInTheDocument();
    expect(screen.getAllByText("Outside").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Pixels" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Length" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Coverage" })).not.toBeInTheDocument();
  });

  test("shows matching saved-color group and ROI identities across the editor and statistics", async () => {
    const mixedBounds = {
      ...savedBounds,
      groups: [
        { ...savedBounds.groups[0], id: "outer", name: "Cell edge", color: "#22c55e", analysisMode: "outside" },
        {
          id: "whole",
          name: "Whole image",
          color: "#ef4444",
          analysisMode: "inside",
          points: [
            { id: "q1", x: 0, y: 0 },
            { id: "q2", x: 99, y: 0 },
            { id: "q3", x: 99, y: 79 },
            { id: "q4", x: 0, y: 79 },
          ],
        },
      ],
    };
    const mixedAnalysis = {
      ...savedAnalysis,
      groups: [
        { ...savedAnalysis.groups[0], groupId: "outer", groupName: "Cell edge" },
        {
          groupId: "whole",
          groupName: "Whole image",
          analysisMode: "inside",
          area: {
            roiAreaPx: 8_000,
            maskPixelCount: 2_000,
            density: 0.25,
            globalAlignment: 0.7,
            radialNormalAlignment: null,
            tangentialAlignment: null,
            migrationAlignment: null,
            empty: false,
          },
        },
      ],
    };
    mockApi({
      boundsQueue: [mixedBounds],
      analysisResponse: { analysis: mixedAnalysis, hasAnalysis: true },
    });
    render(<App />);

    expect(await screen.findByText("G01")).toHaveAttribute("data-group-color", "#22c55e");
    expect(screen.getByText("G02")).toHaveAttribute("data-group-color", "#ef4444");
    expect(screen.getByRole("cell", { name: "G01-N" })).toHaveAttribute("data-group-color", "#22c55e");
    expect(screen.getByRole("cell", { name: "G01-A" })).toHaveAttribute("data-group-color", "#22c55e");
    expect(screen.getByRole("cell", { name: "G02-I" })).toHaveAttribute("data-group-color", "#ef4444");
  });

  test("labels visible outside ROI bands without rendering the all-band union twice", async () => {
    const outsideBounds = {
      ...savedBounds,
      groups: [{ ...savedBounds.groups[0], id: "outer", color: "#22c55e", analysisMode: "outside" }],
    };
    const outsideAnalysis = {
      ...savedAnalysis,
      groups: [{ ...savedAnalysis.groups[0], groupId: "outer" }],
    };
    mockApi({
      boundsQueue: [outsideBounds],
      analysisResponse: { analysis: outsideAnalysis, hasAnalysis: true },
    });
    render(<App />);

    expect(await screen.findByLabelText("ROI ID G01-N")).toBeVisible();
    expect(screen.getByLabelText("ROI ID G01-M")).toBeVisible();
    expect(screen.getByLabelText("ROI ID G01-F")).toBeVisible();
    expect(screen.queryByLabelText("ROI ID G01-A")).not.toBeInTheDocument();
  });

  test("keeps outside ROI labels in-bounds and exterior when the polygon touches an image edge", async () => {
    const points = [
      { id: "p1", x: 0, y: 15 },
      { id: "p2", x: 25, y: 15 },
      { id: "p3", x: 25, y: 55 },
      { id: "p4", x: 0, y: 55 },
    ];
    mockApi({
      boundsQueue: [{
        ...savedBounds,
        groups: [{ ...savedBounds.groups[0], points, roiLimits: { near: 10, mid: 20, far: 30 } }],
      }],
    });
    render(<App />);

    for (const roiId of ["G01-N", "G01-M", "G01-F"]) {
      const label = await screen.findByLabelText(`ROI ID ${roiId}`);
      const point = svgPoint(label);
      expect(point.x).toBeGreaterThanOrEqual(4);
      expect(point.x).toBeLessThanOrEqual(95);
      expect(point.y).toBeGreaterThanOrEqual(4);
      expect(point.y).toBeLessThanOrEqual(75);
      expect(pointInPolygon(point, points)).toBe(false);
    }
  });

  test("keeps concave outside ROI labels exterior instead of placing them in the concavity", async () => {
    const points = [
      { id: "p1", x: 10, y: 10 },
      { id: "p2", x: 70, y: 10 },
      { id: "p3", x: 70, y: 70 },
      { id: "p4", x: 45, y: 70 },
      { id: "p5", x: 45, y: 30 },
      { id: "p6", x: 30, y: 30 },
      { id: "p7", x: 30, y: 70 },
      { id: "p8", x: 10, y: 70 },
    ];
    mockApi({
      boundsQueue: [{
        ...savedBounds,
        groups: [{ ...savedBounds.groups[0], points, roiLimits: { near: 8, mid: 16, far: 24 } }],
      }],
    });
    render(<App />);

    for (const roiId of ["G01-N", "G01-M", "G01-F"]) {
      const point = svgPoint(await screen.findByLabelText(`ROI ID ${roiId}`));
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(4);
      expect(point.x).toBeLessThanOrEqual(95);
      expect(point.y).toBeGreaterThanOrEqual(4);
      expect(point.y).toBeLessThanOrEqual(75);
      expect(pointInPolygon(point, points)).toBe(false);
    }
  });

  test("hides ROI labels in Heat Map mode", async () => {
    mockApi({ analysisResponse: { analysis: savedAnalysis, hasAnalysis: true } });
    render(<App />);

    expect(await screen.findByLabelText("ROI ID G01-N")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Heat Map" }));
    expect(screen.queryByLabelText("ROI ID G01-N")).not.toBeInTheDocument();
  });

  test("removes ROI labels immediately when Draw active group is turned off", async () => {
    mockApi({ analysisResponse: { analysis: savedAnalysis, hasAnalysis: true } });
    render(<App />);

    expect(await screen.findByLabelText("ROI ID G01-N")).toBeVisible();
    fireEvent.click(screen.getByLabelText("Draw active group"));
    expect(screen.queryByLabelText("ROI ID G01-N")).not.toBeInTheDocument();
  });

  test("hides active group drawing and stats with client-side toggles only", async () => {
    mockApi({ analysisResponse: { analysis: savedAnalysis, hasAnalysis: true } });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/analysis loaded/i)).toBeInTheDocument());
    expect(screen.getByLabelText("Vertex point-1")).toBeInTheDocument();
    expect(screen.getAllByText("Saved Tissue").length).toBeGreaterThan(1);
    expect(screen.getByLabelText("Saved Tissue")).toHaveTextContent(/Draw on/);
    expect(screen.getByLabelText("Saved Tissue")).toHaveTextContent(/Stats on/);

    fireEvent.click(screen.getByLabelText("Draw active group"));
    expect(screen.queryByLabelText("Vertex point-1")).not.toBeInTheDocument();
    expect(screen.getAllByText("Saved Tissue").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Saved Tissue")).toHaveTextContent(/Draw off/);

    fireEvent.click(screen.getByLabelText("Show active group stats"));
    expect(screen.queryByText("0.8000")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Saved Tissue")).toHaveTextContent(/Stats off/);
    expect(screen.getByText(/analysis loaded/i)).toBeInTheDocument();
  });

  test("toggles all group display and one group display directly from the group list", async () => {
    mockApi({
      boundsQueue: [boundsWithInsideGroup],
      analysisResponse: { analysis: twoGroupAnalysis, hasAnalysis: true },
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/analysis loaded/i)).toBeInTheDocument());
    expect(screen.getByLabelText("Vertex point-1")).toBeInTheDocument();
    expect(screen.getByLabelText("Vertex inside-1")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByText("Saved Tissue").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("table")).getAllByText("Inside Patch").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Hide all group display" }));

    expect(screen.queryByLabelText("Vertex point-1")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Vertex inside-1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Saved Tissue")).toHaveTextContent(/Draw off/);
    expect(screen.getByLabelText("Inside Patch")).toHaveTextContent(/Stats off/);
    expect(within(screen.getByRole("table")).queryAllByText("Saved Tissue")).toHaveLength(0);
    expect(within(screen.getByRole("table")).queryAllByText("Inside Patch")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Show Inside Patch display" }));

    expect(screen.queryByLabelText("Vertex point-1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Vertex inside-1")).toBeInTheDocument();
    expect(screen.getByLabelText("Saved Tissue")).toHaveTextContent(/Draw off/);
    expect(screen.getByLabelText("Inside Patch")).toHaveTextContent(/Draw on/);
    expect(within(screen.getByRole("table")).queryAllByText("Saved Tissue")).toHaveLength(0);
    expect(within(screen.getByRole("table")).getAllByText("Inside Patch").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Show all group display" }));

    expect(screen.getByLabelText("Vertex point-1")).toBeInTheDocument();
    expect(screen.getByLabelText("Vertex inside-1")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByText("Saved Tissue").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("table")).getAllByText("Inside Patch").length).toBeGreaterThan(0);
  });

  test("renders migration vector as an arrow and hides it independently", async () => {
    mockApi({ boundsQueue: [boundsWithMigration] });

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const vectorLine = screen.getByLabelText("Migration vector Saved Tissue");
    expect(vectorLine).toHaveAttribute("marker-end", expect.stringContaining("url("));
    expect(screen.getByLabelText("Migration vector start Saved Tissue")).toBeInTheDocument();
    expect(screen.queryByLabelText("Migration vector end Saved Tissue")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show migration vector"));

    expect(screen.queryByLabelText("Migration vector Saved Tissue")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Vertex point-1")).toBeInTheDocument();
  });

  test("renders inside analysis as a single area row with no radial or tangent values", async () => {
    mockApi({ analysisResponse: { analysis: insideAnalysis, hasAnalysis: true } });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/analysis loaded/i)).toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: "Mode" })).toBeInTheDocument();
    expect(screen.getByText("Inside")).toBeInTheDocument();
    expect(screen.getByText("영역")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("0.2500")).toBeInTheDocument();
    expect(screen.getByText("0.9000")).toBeInTheDocument();
    const row = screen.getByText("영역").closest("tr");
    expect(row).toHaveTextContent(/-\s*-/);
  });

  test("shows metric meaning when hovering an analysis header", async () => {
    mockApi({ analysisResponse: { analysis: savedAnalysis, hasAnalysis: true } });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/analysis loaded/i)).toBeInTheDocument());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ROI Alignment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pixel Density" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Radial Alignment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Circumferential Alignment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Migration Axis Alignment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Circ Var" })).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Pixel Density" }));

    expect(screen.getByRole("tooltip")).toHaveTextContent(/mask pixels divided by roi area/i);

    fireEvent.mouseLeave(screen.getByRole("button", { name: "Pixel Density" }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: "ROI Alignment" }));

    expect(screen.getByRole("tooltip")).toHaveTextContent(/roi-wide nematic order parameter/i);
  });

  test("derives estimated collagen density from editable pixel density calibration", async () => {
    mockApi({ analysisResponse: { analysis: savedAnalysis, hasAnalysis: true } });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/analysis loaded/i)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Estimated Collagen Density" })).toBeInTheDocument();
    expect(screen.getByLabelText("Density calibration a")).toHaveValue(0.069676956982087);
    expect(screen.getByLabelText("Density calibration b")).toHaveValue(0.067893820336777);
    expect(within(screen.getByRole("table")).getAllByText("1.8960 mg/ml").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Density calibration a"), { target: { value: "0.1" } });
    fireEvent.change(screen.getByLabelText("Density calibration b"), { target: { value: "0.05" } });

    expect(within(screen.getByRole("table")).getAllByText("1.5000 mg/ml").length).toBeGreaterThan(0);
  });

  test("calculates analysis after automatically saving edited bounds", async () => {
    const { fetchMock } = mockApi({ analysisResponse: { analysis: null, hasAnalysis: false } });

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.change(screen.getByLabelText("가까움 upper"), { target: { value: "18" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/images/scan-a/analysis/recalculate",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const saveIndex = fetchMock.mock.calls.findIndex(
      ([url, options]) => url === "/api/images/scan-a/bounds" && options?.method === "PUT",
    );
    const analysisIndex = fetchMock.mock.calls.findIndex(
      ([url, options]) => url === "/api/images/scan-a/analysis/recalculate" && options?.method === "POST",
    );
    expect(saveIndex).toBeGreaterThan(-1);
    expect(analysisIndex).toBeGreaterThan(saveIndex);

    const saveCall = fetchMock.mock.calls[saveIndex];
    expect(JSON.parse(saveCall[1].body).groups[0].roiLimits).toEqual({ near: 18, mid: 50, far: 100 });

    const call = fetchMock.mock.calls.find(([url]) => url === "/api/images/scan-a/analysis/recalculate");
    expect(JSON.parse(call[1].body).roiBands).toEqual([
      { id: "near", label: "가까움", fromPx: 0, toPx: 18 },
      { id: "mid", label: "중간", fromPx: 18, toPx: 50 },
      { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
    ]);
    expect(JSON.parse(call[1].body).roiBandsByGroup).toEqual({
      "group-saved": [
        { id: "near", label: "가까움", fromPx: 0, toPx: 18 },
        { id: "mid", label: "중간", fromPx: 18, toPx: 50 },
        { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
      ],
    });
    expect(await screen.findByText(/analysis calculated/i)).toBeInTheDocument();
  });

  test("removes manual analysis loading and collapses point order and ROI settings from panel headers", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    expect(screen.queryByRole("button", { name: /load analysis/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calculate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recalculate" })).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /hide point order/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show point order/i })).not.toBeInTheDocument();
    const pointOrderToggle = screen.getByRole("button", { name: "Toggle point order panel" });

    expect(screen.getByRole("button", { name: "Point 1 point-1" })).toBeInTheDocument();
    expect(pointOrderToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(pointOrderToggle);
    expect(screen.queryByRole("button", { name: "Point 1 point-1" })).not.toBeInTheDocument();
    expect(pointOrderToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(pointOrderToggle);
    expect(screen.getByRole("button", { name: "Point 1 point-1" })).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /hide roi settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show roi settings/i })).not.toBeInTheDocument();
    const roiSettingsToggle = screen.getByRole("button", { name: "Toggle outside ROI settings" });

    expect(screen.getByLabelText("가까움 upper")).toBeInTheDocument();
    expect(roiSettingsToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(roiSettingsToggle);
    expect(screen.queryByLabelText("가까움 upper")).not.toBeInTheDocument();
    expect(roiSettingsToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(roiSettingsToggle);
    expect(screen.getByLabelText("가까움 upper")).toBeInTheDocument();
  });

  test("collapsing bottom panels gives the image stage more vertical budget", async () => {
    mockApi();

    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const stageShell = container.querySelector(".stage-shell");
    expect(stageShell).toHaveAttribute("data-point-order-open", "true");
    expect(stageShell).toHaveAttribute("data-roi-settings-open", "true");
    expect(stageShell.style.getPropertyValue("--stage-collapsed-space")).toBe("0px");

    fireEvent.click(screen.getByRole("button", { name: "Toggle point order panel" }));

    expect(stageShell).toHaveAttribute("data-point-order-open", "false");
    expect(container.querySelector(".point-order-panel")).toHaveClass("is-collapsed");
    expect(stageShell.style.getPropertyValue("--stage-collapsed-space")).toBe("24px");

    fireEvent.click(screen.getByRole("button", { name: "Toggle outside ROI settings" }));

    expect(stageShell).toHaveAttribute("data-roi-settings-open", "false");
    expect(container.querySelector(".analysis-panel")).toHaveClass("roi-settings-collapsed");
    expect(stageShell.style.getPropertyValue("--stage-collapsed-space")).toBe("80px");
  });

  test("collapses and restores the groups side panel from the editor toolbar", async () => {
    mockApi();

    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const appShell = container.querySelector(".app-shell");
    const groupsPanel = container.querySelector("#groups-panel");
    const toggle = screen.getByRole("button", { name: "Toggle groups panel" });

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(groupsPanel).not.toHaveAttribute("hidden");
    expect(appShell).not.toHaveClass("side-panel-collapsed");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(groupsPanel).toHaveAttribute("hidden");
    expect(appShell).toHaveClass("side-panel-collapsed");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(groupsPanel).not.toHaveAttribute("hidden");
    expect(appShell).not.toHaveClass("side-panel-collapsed");
  });

  test("resizes the analysis panel by dragging the lower splitter", async () => {
    mockApi();

    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const stageShell = container.querySelector(".stage-shell");
    const analysisPanel = screen.getByLabelText("Analysis");
    const resizeHandle = screen.getByRole("button", { name: "Resize analysis panel" });

    expect(stageShell.style.getPropertyValue("--analysis-panel-height")).toBe("210px");
    expect(stageShell.style.getPropertyValue("--analysis-panel-stage-adjust")).toBe("0px");
    expect(analysisPanel).toHaveStyle({ height: "210px" });

    fireEvent(resizeHandle, new MouseEvent("pointerdown", { bubbles: true, clientY: 500 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientY: 420 }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    expect(stageShell.style.getPropertyValue("--analysis-panel-height")).toBe("290px");
    expect(stageShell.style.getPropertyValue("--analysis-panel-stage-adjust")).toBe("-80px");
    expect(analysisPanel).toHaveStyle({ height: "290px" });
    expect(localStorage.getItem("raw16-editor-analysis-panel-height")).toBe("290");
  });

  test("lets the analysis splitter move all the way down", async () => {
    mockApi();

    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const stageShell = container.querySelector(".stage-shell");
    const analysisPanel = screen.getByLabelText("Analysis");
    const resizeHandle = screen.getByRole("button", { name: "Resize analysis panel" });

    fireEvent(resizeHandle, new MouseEvent("pointerdown", { bubbles: true, clientY: 500 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientY: 800 }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    expect(stageShell.style.getPropertyValue("--analysis-panel-height")).toBe("0px");
    expect(analysisPanel).toHaveStyle({ height: "0px" });
    expect(resizeHandle).toHaveAttribute("aria-valuemin", "0");
  });

  test("sizes the image stage from the available frame instead of a fixed viewport estimate", async () => {
    let resizeCallback = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback) {
          resizeCallback = callback;
        }

        observe() {}

        disconnect() {}
      },
    );
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const frame = screen.getByTestId("image-stage-frame");
    const stage = screen.getByTestId("image-stage");

    act(() => {
      resizeCallback([{ target: frame, contentRect: { width: 1000, height: 500 } }]);
    });

    expect(stage).toHaveStyle({ width: "625px", height: "500px" });
  });

  test("deletes a point from the point order panel after hovering it", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const pointToken = screen.getByRole("button", { name: "Point 1 point-1" });
    expect(screen.queryByRole("button", { name: "Delete point-1" })).not.toBeInTheDocument();

    fireEvent.mouseEnter(pointToken);
    fireEvent.click(screen.getByRole("button", { name: "Delete point-1" }));

    expect(screen.queryByLabelText("Vertex point-1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Point 1 point-1" })).not.toBeInTheDocument();
    expect(screen.getByText("2 points")).toBeInTheDocument();
  });

  test("keeps ROI limits per outside group and hides them for inside groups", async () => {
    const { fetchMock } = mockApi({ boundsQueue: [boundsWithInsideGroup] });

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.change(screen.getByLabelText("가까움 upper"), { target: { value: "18" } });
    fireEvent.blur(screen.getByLabelText("가까움 upper"));

    fireEvent.click(screen.getByRole("button", { name: "Inside Patch" }));
    expect(screen.queryByLabelText("가까움 upper")).not.toBeInTheDocument();
    expect(screen.getByText(/inside groups do not use outside roi settings/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Saved Tissue" }));
    expect(screen.getByLabelText("가까움 upper")).toHaveValue(18);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/images/scan-a/bounds",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const saveCall = fetchMock.mock.calls.find(([url, options]) => url === "/api/images/scan-a/bounds" && options?.method === "PUT");
    expect(JSON.parse(saveCall[1].body).groups[0].roiLimits).toEqual({ near: 18, mid: 50, far: 100 });
    expect(JSON.parse(saveCall[1].body).groups[1].roiLimits).toBeUndefined();
  });

  test("switches the image stage between original and mask preview", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    expect(screen.getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Mask" }));

    expect(screen.getByRole("button", { name: "Mask" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByAltText("mask preview")).toHaveAttribute("src", "/api/images/scan-a/mask-preview");
    expect(screen.getByLabelText("raw16 image")).toHaveClass("hidden-layer");
    expect(screen.getByLabelText("raw16 image")).not.toHaveAttribute("style");
  });

  test("shows mask and skeleton together in the fiber QC layer", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.click(screen.getByRole("button", { name: "Fiber QC" }));

    expect(screen.getByRole("button", { name: "Fiber QC" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByAltText("mask preview")).toHaveAttribute("src", "/api/images/scan-a/mask-preview");
    expect(screen.getByAltText("skeleton preview")).toHaveAttribute(
      "src",
      "/api/images/scan-a/skeleton-preview",
    );
    expect(screen.getByLabelText("raw16 image")).toHaveClass("hidden-layer");
    expect(screen.getByLabelText("raw16 image")).not.toHaveAttribute("style");
  });

  test("opens the Heat Map layer with fixed cell-size presets", async () => {
    mockApi();
    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    const heatmapControls = screen.getByLabelText("Heatmap controls");
    expect(screen.getByLabelText("Groups")).toContainElement(heatmapControls);
    expect(container.querySelector(".stage-tools")).not.toContainElement(heatmapControls);
    expect(screen.getByRole("button", { name: /Small 20x20/ })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByLabelText("heatmap overlay")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Large 100x100/ }));
    expect(localStorage.getItem("raw16-editor-heatmap-selected-preset")).toBe("large");
  });

  test("keeps selected cell size when moving to the next image", async () => {
    const { fetchMock } = mockApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    fireEvent.click(screen.getByRole("button", { name: /Large 100x100/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-b/heatmap?cellSize=100"),
    );
  });

  test("hides the current report while navigation waits for the next image heatmap", async () => {
    const nextHeatmapRequest = deferred();
    const { fetchMock } = mockApi({
      heatmapResponse: (url, cellSize) =>
        url.includes("scan-b")
          ? nextHeatmapRequest.promise
          : jsonResponse({ heatmap: heatmapFixture("plate-a", cellSize) }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    expect(await screen.findByText("Current: plate-a")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-b/heatmap?cellSize=20"),
    );
    expect(screen.queryByLabelText("heatmap report")).not.toBeInTheDocument();

    await act(async () => {
      nextHeatmapRequest.resolve(await jsonResponse({
        heatmap: heatmapFixture("plate-b", 20, 0.08, 120, 90),
      }));
    });
    expect(await screen.findByText("Current: plate-b")).toBeInTheDocument();
  });

  test("reloads and hides a heatmap when a new root reuses the image identity", async () => {
    const replacementHeatmapRequest = deferred();
    let heatmapRequestCount = 0;
    const replacementImage = {
      ...images[0],
      folder: "replacement-plate",
      imageFolder: "replacement-plate",
    };
    const { fetchMock } = mockApi({
      appliedRootPath: "/replacement/root",
      appliedRootImages: [replacementImage],
      heatmapResponse: (_url, cellSize) => {
        heatmapRequestCount += 1;
        return heatmapRequestCount === 1
          ? jsonResponse({ heatmap: heatmapFixture("plate-a", cellSize) })
          : replacementHeatmapRequest.promise;
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    expect(await screen.findByText("Current: plate-a")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/root path/i), { target: { value: "/replacement/root" } });
    fireEvent.click(screen.getByRole("button", { name: /set root/i }));

    await waitFor(() => expect(screen.getByLabelText(/root path/i)).toHaveValue("/replacement/root"));
    await waitFor(() => expect(heatmapRequestCount).toBe(2));
    expect(screen.queryByLabelText("heatmap report")).not.toBeInTheDocument();

    await act(async () => {
      replacementHeatmapRequest.resolve(await jsonResponse({
        heatmap: heatmapFixture("replacement-plate", 20),
      }));
    });
    expect(await screen.findByText("Current: replacement-plate")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-a/heatmap?cellSize=20");
  });

  test("ignores stale editable heatmap presets and keeps fixed viewer sizes", async () => {
    const { fetchMock } = mockApi();
    localStorage.setItem(
      "raw16-editor-heatmap-presets",
      JSON.stringify({ small: 5, medium: 10, large: 20 }),
    );
    render(<App />);

    await screen.findByRole("button", { name: "Saved Tissue" });
    fireEvent.click(screen.getByRole("button", { name: "Heat Map" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-a/heatmap?cellSize=20"),
    );
    expect(screen.queryByLabelText("small heatmap cell size")).not.toBeInTheDocument();
    expect(screen.getByText("20 x 20")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-b/heatmap?cellSize=20"),
    );
    expect(localStorage.getItem("raw16-editor-heatmap-presets")).toBeNull();
  });

  test("ignores a stale heatmap response after changing cell size", async () => {
    const smallRequest = deferred();
    const largeRequest = deferred();
    const { fetchMock } = mockApi({
      heatmapResponse: (_url, cellSize) =>
        cellSize === 20 ? smallRequest.promise : largeRequest.promise,
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-a/heatmap?cellSize=20"),
    );
    fireEvent.click(screen.getByRole("button", { name: /Large 100x100/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-a/heatmap?cellSize=100"),
    );

    await act(async () => {
      largeRequest.resolve(await jsonResponse({ heatmap: heatmapFixture("plate-a", 100, 0.8) }));
    });
    const overlay = await screen.findByLabelText("heatmap overlay");
    const currentFill = canvasContexts.get(overlay).fillStyle;

    await act(async () => {
      smallRequest.resolve(await jsonResponse({ heatmap: heatmapA5 }));
    });
    expect(canvasContexts.get(screen.getByLabelText("heatmap overlay")).fillStyle).toBe(currentFill);
  });

  test("rejects a current heatmap above the client cell budget", async () => {
    mockApi({
      heatmapResponse: (_url, cellSize) =>
        jsonResponse({
          heatmap: {
            ...heatmapFixture("plate-a", cellSize),
            columns: 1_000_001,
            rows: 1,
          },
        }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));

    expect(await screen.findByText("Heatmap unavailable: Heatmap grid exceeds the 1,000,000 cell limit.")).toBeInTheDocument();
    expect(screen.queryByLabelText("heatmap overlay")).not.toBeInTheDocument();
  });

  test("integrates the loaded heatmap report with presets, plot pointer mapping, and opacity", async () => {
    mockApi({
      heatmapResponse: (_url, cellSize) =>
        jsonResponse({ heatmap: gridHeatmapFixture("plate-a", cellSize) }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));

    const report = await screen.findByLabelText("heatmap report");
    const plot = within(report).getByLabelText("heatmap report plot");
    const rawCanvas = within(plot).getByLabelText("heatmap original image");

    expect(screen.getByLabelText("Image editor")).toHaveClass("heatmap-mode");
    expect(report).toHaveTextContent("Current: plate-a");
    expect(report).toHaveTextContent("Cell 20x20 px | Grid 5x4");
    expect(screen.queryByLabelText("heatmap color legend")).not.toBeInTheDocument();
    expect(rawCanvas).toHaveStyle({ opacity: "0.5" });
    expect(rawCanvas).toHaveAttribute("width", "100");
    expect(screen.queryByLabelText("Bounds overlay")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^ROI preview /)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Medium 50x50/ }));
    expect(await screen.findByText("Pixel Density | Cell 50x50 px | Grid 2x2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Small 20x20/ }));
    await screen.findByText("Pixel Density | Cell 20x20 px | Grid 5x4");

    const currentPlot = screen.getByLabelText("heatmap report plot");
    const currentHeader = screen.getByLabelText("heatmap report").querySelector(".heatmap-report-header");
    const currentRawCanvas = within(currentPlot).getByLabelText("heatmap original image");
    vi.spyOn(currentRawCanvas, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 200,
      right: 600,
      bottom: 600,
      width: 500,
      height: 400,
      x: 100,
      y: 200,
      toJSON: () => {},
    });

    fireEvent.mouseMove(currentHeader, { clientX: 120, clientY: 120 });
    expect(within(currentPlot).queryByRole("status")).not.toBeInTheDocument();

    fireEvent.mouseMove(currentPlot, { clientX: 325, clientY: 325 });
    expect(await within(currentPlot).findByRole("status")).toHaveTextContent("Row 2, Column 3");

    fireEvent.change(screen.getByLabelText("Original opacity"), { target: { value: "0.35" } });
    expect(currentRawCanvas).toHaveStyle({ opacity: "0.35" });

    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    expect(screen.getByLabelText("Image editor")).not.toHaveClass("heatmap-mode");
  });

  test("clears the heatmap tooltip when the pointer moves from the plot to the report header", async () => {
    mockApi({
      heatmapResponse: (_url, cellSize) =>
        jsonResponse({ heatmap: gridHeatmapFixture("plate-a", cellSize) }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));

    const report = await screen.findByLabelText("heatmap report");
    const plot = within(report).getByLabelText("heatmap report plot");
    const header = report.querySelector(".heatmap-report-header");
    const rawCanvas = within(plot).getByLabelText("heatmap original image");
    vi.spyOn(rawCanvas, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 200,
      right: 600,
      bottom: 600,
      width: 500,
      height: 400,
      x: 100,
      y: 200,
      toJSON: () => {},
    });

    fireEvent.mouseMove(plot, { clientX: 325, clientY: 325 });
    expect(await within(plot).findByRole("status")).toHaveTextContent("Row 2, Column 3");

    fireEvent.mouseMove(header, { clientX: 120, clientY: 120 });
    expect(within(plot).queryByRole("status")).not.toBeInTheDocument();
  });

  test("shows current and estimated metrics using the report scale and current calibration", async () => {
    mockApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    fireEvent.click(screen.getByRole("button", { name: "Estimated Collagen Density" }));

    const report = await screen.findByLabelText("heatmap report");
    expect(report).toHaveTextContent("Color range: 0 to 3 mg/ml");
    expect(within(report).getByLabelText("Estimated Collagen Density (mg/ml)")).toBeInTheDocument();
  });

  test("restores persisted heatmap metric after remount", async () => {
    mockApi();
    const first = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    fireEvent.click(screen.getByRole("button", { name: "Estimated Collagen Density" }));
    first.unmount();

    mockApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));

    expect(screen.getByRole("button", { name: "Estimated Collagen Density" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("controls only the original TIFF opacity while Heat Map is active", async () => {
    mockApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    const rawCanvas = await screen.findByLabelText("heatmap original image");
    const heatmapCanvas = await screen.findByLabelText("heatmap overlay");
    const opacitySlider = screen.getByLabelText("Original opacity");
    expect(opacitySlider).toHaveAttribute("min", "0");
    expect(opacitySlider).toHaveAttribute("max", "1");
    expect(opacitySlider).toHaveValue("0.5");
    expect(rawCanvas).toHaveClass("heatmap-original-overlay");
    expect(rawCanvas).toHaveStyle({ opacity: "0.5" });
    fireEvent.change(opacitySlider, { target: { value: "1" } });
    expect(rawCanvas).toHaveStyle({ opacity: "1" });
    fireEvent.change(opacitySlider, { target: { value: "0" } });
    expect(rawCanvas).toHaveStyle({ opacity: "0" });
    expect(heatmapCanvas).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    const originalCanvas = screen.getByLabelText("raw16 image");
    expect(originalCanvas).not.toHaveClass("heatmap-original-overlay");
    expect(originalCanvas.style.opacity).toBe("");
  });

  test("hides bounds controls in Heat Map and restores them in Original", async () => {
    mockApi();
    render(<App />);

    expect(await screen.findByLabelText("Bounds overlay")).toBeInTheDocument();
    expect(screen.getByLabelText("Point opacity")).toBeInTheDocument();
    expect(screen.getByLabelText("Show ROI")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Heat Map" }));

    expect(screen.queryByLabelText("Bounds overlay")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Point opacity")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Show ROI")).not.toBeInTheDocument();
    expect(screen.queryByText("ROI preview local")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Original" }));

    expect(screen.getByLabelText("Bounds overlay")).toBeInTheDocument();
    expect(screen.getByLabelText("Point opacity")).toBeInTheDocument();
    expect(screen.getByLabelText("Show ROI")).toBeInTheDocument();
    expect(screen.getByText("ROI preview local")).toBeInTheDocument();
  });

  test("blocks bounds mutations while Heat Map is active", async () => {
    mockApi();
    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const vertexCount = screen.getAllByLabelText(/^Vertex /).length;
    const stage = screen.getByTestId("image-stage");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 80,
      width: 100,
      height: 80,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.pointerDown(screen.getByLabelText("Vertex point-1"));
    fireEvent.click(screen.getByRole("button", { name: "Heat Map" }));
    fireEvent.pointerMove(stage, { clientX: 30, clientY: 30 });
    fireEvent.click(stage, { clientX: 30, clientY: 30 });
    fireEvent.keyDown(window, { code: "KeyP" });
    fireEvent.keyDown(window, { code: "KeyD" });
    fireEvent.keyDown(window, { code: "KeyM" });

    expect(screen.getByText("Clean")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Original" }));

    expect(screen.getAllByLabelText(/^Vertex /)).toHaveLength(vertexCount);
    expect(screen.getByLabelText("Vertex point-1")).toHaveAttribute("cx", "10");
    expect(screen.getByLabelText("Vertex point-1")).toHaveAttribute("cy", "12");
  });

  test("omits point order, ROI settings, and bounds mutation controls in Heat Map", async () => {
    mockApi();
    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.click(screen.getByRole("button", { name: "Heat Map" }));

    expect(screen.getByLabelText("Groups")).toBeInTheDocument();
    expect(screen.getByLabelText("Heatmap controls")).toBeInTheDocument();
    expect(screen.getByLabelText("Heatmap batch")).toBeInTheDocument();
    expect(screen.queryByLabelText("Point order")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Toggle outside ROI settings" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("가까움 upper")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add group" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rename active group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Full image inside" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Analysis mode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Draw active group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set migration" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete active group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load saved bound" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import previous bound" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download as ZIP" })).toBeEnabled();
  });

  test("hides group selection and display controls in Heat Map while preserving group state", async () => {
    mockApi({
      boundsQueue: [boundsWithInsideGroup],
      analysisResponse: { analysis: twoGroupAnalysis, hasAnalysis: true },
    });
    render(<App />);

    await screen.findByRole("button", { name: "Saved Tissue" });
    fireEvent.click(screen.getByRole("button", { name: "Inside Patch" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide Inside Patch display" }));

    expect(screen.getByLabelText("Rename active group")).toHaveValue("Inside Patch");
    expect(screen.queryByLabelText("Vertex inside-1")).not.toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryAllByText("Inside Patch")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Heat Map" }));

    expect(screen.getByLabelText("Heatmap controls")).toBeInTheDocument();
    expect(screen.getByLabelText("Heatmap batch")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all group display" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide all group display" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Saved Tissue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inside Patch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /(?:Show|Hide) .* display/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Original" }));

    expect(screen.getByLabelText("Rename active group")).toHaveValue("Inside Patch");
    expect(screen.getByRole("button", { name: "Inside Patch" }).closest(".group-row")).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Show Inside Patch display" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Vertex inside-1")).not.toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryAllByText("Inside Patch")).toHaveLength(0);
  });

  test("restores persisted Heat Map original opacity after remount", async () => {
    mockApi();
    const first = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    fireEvent.change(screen.getByLabelText("Original opacity"), { target: { value: "0.35" } });
    first.unmount();

    mockApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    expect(screen.getByLabelText("Original opacity")).toHaveValue("0.35");
  });

  test("removes the duplicate heatmap legend from the sidebar controls", async () => {
    mockApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    await screen.findByLabelText("heatmap report");
    expect(within(screen.getByLabelText("Heatmap controls")).queryByLabelText("heatmap color legend")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("heatmap color legend")).not.toBeInTheDocument();
  });

  test("offers previous comparison only after the first image", async () => {
    const compatibleImages = [images[0], { ...images[1], width: 100, height: 80 }];
    const { fetchMock } = mockApi({
      rootImages: compatibleImages,
      rawDimensionsById: { "scan-b": [100, 80] },
      heatmapResponse: (url, cellSize) =>
        jsonResponse({
          heatmap: heatmapFixture(url.includes("scan-a") ? "plate-a" : "plate-b", cellSize),
        }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    expect(screen.queryByRole("button", { name: "Compare Previous" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    fireEvent.click(await screen.findByRole("button", { name: "Compare Previous" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/images/scan-a/heatmap?cellSize=20"),
    );
    expect(await screen.findByText(/Compared with plate-a/)).toBeInTheDocument();
  });

  test("keeps current heatmap when the previous heatmap request fails", async () => {
    mockApi({
      heatmapResponse: (url, cellSize) =>
        url.includes("scan-a")
          ? jsonResponse({ error: "Saved heatmap is stale." }, { status: 409 })
          : jsonResponse({ heatmap: heatmapFixture("plate-b", cellSize, 0.08, 120, 90) }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Next image" }));
    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    expect(await screen.findByLabelText("heatmap overlay")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compare Previous" }));

    expect(await screen.findByText(/Previous heatmap unavailable: Saved heatmap is stale/)).toHaveTextContent(
      "Showing current heatmap.",
    );
    expect(screen.getByLabelText("heatmap overlay")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare Previous" })).toHaveAttribute("aria-pressed", "true");
  });

  test("retries comparison on the next compatible image after a previous heatmap failure", async () => {
    const compatibleImages = [
      images[0],
      { ...images[1], width: 100, height: 80 },
      {
        id: "scan-c",
        folder: "plate-c",
        imageFolder: "plate-c",
        file: "c.tif",
        imageFile: "c.tif",
        width: 100,
        height: 80,
      },
    ];
    mockApi({
      rootImages: compatibleImages,
      rawDimensionsById: { "scan-b": [100, 80], "scan-c": [100, 80] },
      heatmapResponse: (url, cellSize) => {
        if (url.includes("scan-a")) {
          return jsonResponse({ error: "Saved heatmap is stale." }, { status: 409 });
        }
        const imageFolder = url.includes("scan-b") ? "plate-b" : "plate-c";
        return jsonResponse({ heatmap: heatmapFixture(imageFolder, cellSize, 0.08) });
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Next image" }));
    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    fireEvent.click(await screen.findByRole("button", { name: "Compare Previous" }));

    expect(await screen.findByText(/Previous heatmap unavailable: Saved heatmap is stale/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare Previous" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));

    expect(await screen.findByText("Compared with plate-b")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare Previous" })).toHaveAttribute("aria-pressed", "true");
  });

  test("keeps current heatmap and reports incompatible previous dimensions", async () => {
    mockApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Next image" }));
    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    expect(await screen.findByLabelText("heatmap overlay")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compare Previous" }));

    expect(await screen.findByText(/Previous heatmap unavailable: Heatmaps have incompatible dimensions/)).toHaveTextContent(
      "Showing current heatmap.",
    );
    expect(screen.getByLabelText("heatmap overlay")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare Previous" })).toHaveAttribute("aria-pressed", "true");
  });

  test("rejects a current heatmap whose dimensions do not match the displayed image", async () => {
    mockApi({
      heatmapResponse: (_url, cellSize) =>
        jsonResponse({ heatmap: heatmapFixture("plate-a", cellSize, 0.04, 99, 80) }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));

    expect(await screen.findByText("Heatmap dimensions 99x80 do not match image 100x80.")).toBeInTheDocument();
    expect(screen.queryByLabelText("heatmap overlay")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("heatmap report")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("raw16 image")).not.toBeInTheDocument();
  });

  test("adds the previous image and delta scale to the comparison report", async () => {
    const compatibleImages = [images[0], { ...images[1], width: 100, height: 80 }];
    mockApi({
      rootImages: compatibleImages,
      rawDimensionsById: { "scan-b": [100, 80] },
      heatmapResponse: (url, cellSize) =>
        jsonResponse({
          heatmap: heatmapFixture(
            url.includes("scan-a") ? "plate-a" : "plate-b",
            cellSize,
            url.includes("scan-a") ? 0.04 : 0.08,
          ),
        }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Next image" }));
    fireEvent.click(await screen.findByRole("button", { name: "Heat Map" }));
    fireEvent.click(await screen.findByRole("button", { name: "Compare Previous" }));
    const report = await screen.findByLabelText("heatmap report");
    expect(report).toHaveTextContent("Current: plate-b");
    expect(report).toHaveTextContent("Previous: plate-a");
    expect(report).toHaveTextContent("Color range: -0.04 to +0.04");
    expect(within(report).getByLabelText("Delta Pixel Density")).toHaveClass("difference");
  });

  test("selects a separate batch folder and generates the fixed preset sizes", async () => {
    const { fetchMock } = mockApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose heatmap folder" }));
    expect(await screen.findByLabelText("Heatmap batch path")).toHaveValue("/selected/heatmap-root");
    expect(screen.getByText("20 x 20")).toBeInTheDocument();
    expect(screen.getByText("50 x 50")).toBeInTheDocument();
    expect(screen.getByText("100 x 100")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate Heatmaps" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, options]) => url === "/api/heatmaps/generate" && options?.method === "POST",
      );
      expect(JSON.parse(call[1].body)).toEqual({
        rootPath: "/selected/heatmap-root",
        cellSizes: [20, 50, 100],
      });
    });
    expect(screen.getByText(/2 discovered/)).toHaveTextContent("6 files");
  });

  test("generates Heatmaps from a manually entered absolute path", async () => {
    const { fetchMock } = mockApi();
    render(<App />);

    const pathInput = await screen.findByLabelText("Heatmap batch path");
    fireEvent.change(pathInput, { target: { value: "/manual/heatmap-root" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate Heatmaps" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, options]) => url === "/api/heatmaps/generate" && options?.method === "POST",
      );
      expect(JSON.parse(call[1].body)).toEqual({
        rootPath: "/manual/heatmap-root",
        cellSizes: [20, 50, 100],
      });
    });
  });

  test("keeps a manually edited Heatmap path when an older picker request resolves", async () => {
    const pendingSelection = deferred();
    mockApi({ selectHeatmapFolderResponse: () => pendingSelection.promise });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose heatmap folder" }));
    const pathInput = screen.getByLabelText("Heatmap batch path");
    fireEvent.change(pathInput, { target: { value: "/manual/newer-root" } });

    await act(async () => {
      pendingSelection.resolve(await jsonResponse({ rootPath: "/picker/stale-root" }));
    });

    expect(pathInput).toHaveValue("/manual/newer-root");
  });

  test("ignores a pending folder response after generation starts and disables folder selection", async () => {
    const pendingSelection = deferred();
    const pendingGeneration = deferred();
    let selectionCount = 0;
    mockApi({
      selectHeatmapFolderResponse: () => {
        selectionCount += 1;
        return selectionCount === 1
          ? jsonResponse({ rootPath: "/selected/heatmap-root" })
          : pendingSelection.promise;
      },
      generateHeatmapsResponse: () => pendingGeneration.promise,
    });
    render(<App />);

    const chooseButton = await screen.findByRole("button", { name: "Choose heatmap folder" });
    fireEvent.click(chooseButton);
    const pathInput = await screen.findByLabelText("Heatmap batch path");
    await waitFor(() => expect(pathInput).toHaveValue("/selected/heatmap-root"));
    fireEvent.click(chooseButton);
    fireEvent.click(screen.getByRole("button", { name: "Generate Heatmaps" }));

    expect(chooseButton).toBeDisabled();
    await act(async () => {
      pendingSelection.resolve(await jsonResponse({ rootPath: "/stale/heatmap-root" }));
    });
    expect(pathInput).toHaveValue("/selected/heatmap-root");

    await act(async () => {
      pendingGeneration.resolve(await jsonResponse({
        discovered: 1,
        completed: 1,
        skipped: 0,
        failed: 0,
        generatedFiles: 3,
        failures: [],
      }));
    });
    expect(chooseButton).toBeEnabled();
  });

  test("submits only one generation request for same-tick repeated clicks", async () => {
    const pendingGeneration = deferred();
    const { fetchMock } = mockApi({
      generateHeatmapsResponse: () => pendingGeneration.promise,
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose heatmap folder" }));
    const pathInput = await screen.findByLabelText("Heatmap batch path");
    await waitFor(() => expect(pathInput).toHaveValue("/selected/heatmap-root"));
    const generateButton = screen.getByRole("button", { name: "Generate Heatmaps" });
    const chooseButton = screen.getByRole("button", { name: "Choose heatmap folder" });
    act(() => {
      generateButton.click();
      generateButton.click();
    });
    await waitFor(() => {
      const generationCalls = fetchMock.mock.calls.filter(
        ([url, options]) => url === "/api/heatmaps/generate" && options?.method === "POST",
      );
      expect(generationCalls).toHaveLength(1);
    });
    expect(chooseButton).toBeDisabled();

    await act(async () => {
      pendingGeneration.resolve(await jsonResponse({
        discovered: 1,
        completed: 1,
        skipped: 0,
        failed: 0,
        generatedFiles: 3,
        failures: [],
      }));
    });
    expect(screen.getByText(/1 discovered/)).toHaveTextContent("1 completed");
    expect(chooseButton).toBeEnabled();
  });

  test("renders ROI preview locally without requesting a server overlay", async () => {
    const { fetchMock } = mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    await waitFor(() => expect(screen.getByLabelText("ROI preview near")).toBeInTheDocument());
    expect(screen.getByLabelText("ROI preview near")).toHaveAttribute("stroke", "#ef4444");
    expect(screen.getByLabelText("ROI preview mid")).toHaveAttribute("stroke", "#f59e0b");
    expect(screen.getByLabelText("ROI preview far")).toHaveAttribute("stroke", "#3b82f6");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/roi-overlay"))).toBe(false);
    expect(screen.getByText(/ROI preview local/i)).toBeInTheDocument();
  });

  test("changing ROI limits updates local ROI preview without server overlay recalculation", async () => {
    const { fetchMock } = mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.change(screen.getByLabelText("가까움 upper"), { target: { value: "18" } });

    await waitFor(() => expect(screen.getByLabelText("ROI preview near")).toHaveAttribute("stroke-width", "36"));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/roi-overlay"))).toBe(false);
  });

  test("allows ROI limit inputs to be cleared before typing replacement values", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const nearInput = screen.getByLabelText("가까움 upper");
    fireEvent.change(nearInput, { target: { value: "" } });

    expect(nearInput.value).toBe("");

    fireEvent.change(nearInput, { target: { value: "30" } });

    expect(nearInput.value).toBe("30");
    expect(screen.getByLabelText("ROI preview near")).toHaveAttribute("stroke-width", "60");
  });

  test("normalizes typed ROI limits only after editing is committed", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const nearInput = screen.getByLabelText("가까움 upper");
    const midInput = screen.getByLabelText("중간 upper");
    const farInput = screen.getByLabelText("멀리 upper");

    fireEvent.change(nearInput, { target: { value: "80" } });

    expect(nearInput.value).toBe("80");
    expect(midInput.value).toBe("50");
    expect(farInput.value).toBe("100");

    fireEvent.blur(nearInput);

    expect(nearInput.value).toBe("80");
    expect(midInput.value).toBe("81");
    expect(farInput.value).toBe("100");
  });

  test("step buttons normalize ROI boundaries immediately while adjusting", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const nearInput = screen.getByLabelText("가까움 upper");
    const midInput = screen.getByLabelText("중간 upper");
    const farInput = screen.getByLabelText("멀리 upper");

    fireEvent.change(nearInput, { target: { value: "49" } });
    fireEvent.blur(nearInput);

    expect(nearInput.value).toBe("49");
    expect(midInput.value).toBe("50");
    expect(farInput.value).toBe("100");

    fireEvent.click(screen.getByRole("button", { name: "Increase 가까움 upper" }));

    expect(nearInput.value).toBe("50");
    expect(midInput.value).toBe("51");
    expect(farInput.value).toBe("100");
  });

  test("shows and hides local ROI preview from current bounds and ROI bands", async () => {
    const { fetchMock } = mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    expect(await screen.findByLabelText("ROI preview near")).toHaveAttribute("points", "10,12 40,14 20,36");
    expect(screen.getByLabelText("ROI preview mid")).toHaveAttribute("stroke-width", "100");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/roi-overlay"))).toBe(false);

    fireEvent.click(screen.getByLabelText(/show roi/i));

    expect(screen.queryByLabelText("ROI preview near")).not.toBeInTheDocument();
  });

  test("draws polygon connections in the stored point order", async () => {
    mockApi();

    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    expect(container.querySelector("polygon")).toHaveAttribute(
      "points",
      "10,12 40,14 20,36",
    );
  });

  test("shows active group point order and highlights hovered points", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    expect(screen.getByLabelText("Point order")).toBeInTheDocument();
    const pointOne = screen.getByRole("button", { name: "Point 1 point-1" });

    fireEvent.mouseEnter(pointOne);

    expect(screen.getByLabelText("Vertex point-1")).toHaveAttribute(
      "data-highlighted",
      "true",
    );
  });

  test("moves point order from the lower order controls", async () => {
    mockApi();

    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.click(screen.getByRole("button", { name: "Move point-3 left" }));

    await waitFor(() =>
      expect(container.querySelector("polygon")).toHaveAttribute(
        "points",
        "10,12 20,36 40,14",
      ),
    );
  });

  test("inserts a point between ordered segment endpoints when clicking near a line", async () => {
    mockApi();

    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.click(screen.getByTestId("image-stage"), { clientX: 25, clientY: 13 });

    expect(await screen.findByLabelText("Vertex point-4")).toHaveAttribute("cx", "25");
    expect(screen.getByRole("button", { name: "Point 2 point-4" })).toBeInTheDocument();
    expect(container.querySelector("polygon")).toHaveAttribute(
      "points",
      "10,12 25,13 40,14 20,36",
    );
  });

  test("uses KeyboardEvent.code for KeyP KeyD and KeyM shortcuts", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const stage = screen.getByTestId("image-stage");
    fireEvent.mouseMove(stage, { clientX: 55, clientY: 24 });
    fireEvent.keyDown(window, { key: "ㅔ", code: "KeyP" });
    expect(await screen.findByLabelText("Vertex point-4")).toHaveAttribute("cx", "55");

    fireEvent.mouseMove(stage, { clientX: 58, clientY: 30 });
    fireEvent.keyDown(window, { key: "ㅡ", code: "KeyM" });
    await waitFor(() => expect(screen.getByLabelText("Vertex point-4")).toHaveAttribute("cx", "58"));

    fireEvent.keyDown(window, { key: "ㅇ", code: "KeyD" });
    await waitFor(() => expect(screen.queryByLabelText("Vertex point-4")).not.toBeInTheDocument());
  });

  test("keeps p shortcut on the last valid mouse position when a bad pointer event fires", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const stage = screen.getByTestId("image-stage");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 300,
      bottom: 210,
      width: 200,
      height: 160,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    fireEvent.mouseMove(stage, { clientX: 150, clientY: 90 });
    fireEvent.pointerMove(stage);
    fireEvent.keyDown(window, { key: "ㅔ", code: "KeyP" });

    expect(await screen.findByLabelText("Vertex point-4")).toHaveAttribute("cx", "25");
    expect(screen.getByLabelText("Vertex point-4")).toHaveAttribute("cy", "20");
  });

  test("uses raw image dimensions for p shortcut when scanned images omit dimensions", async () => {
    mockApi({ rootImages: imagesWithoutDimensions, boundsQueue: [emptyBounds] });

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("raw16 image")).toHaveAttribute("width", "100"));

    const stage = screen.getByTestId("image-stage");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 300,
      bottom: 210,
      width: 200,
      height: 160,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    fireEvent.mouseMove(stage, { clientX: 150, clientY: 90 });
    fireEvent.keyDown(window, { key: "ㅔ", code: "KeyP" });

    expect(await screen.findByLabelText("Vertex point-1")).toHaveAttribute("cx", "25");
    expect(screen.getByLabelText("Vertex point-1")).toHaveAttribute("cy", "20");
  });

  test("sets stage sizing from loaded image dimensions", async () => {
    mockApi({ rootImages: imagesWithoutDimensions, boundsQueue: [emptyBounds] });

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("raw16 image")).toHaveAttribute("width", "100"));

    const stage = screen.getByTestId("image-stage");
    expect(stage).toHaveStyle({ aspectRatio: "100 / 80" });
    expect(stage.style.getPropertyValue("--image-aspect")).toBe("1.25");
  });

  test("maps p shortcut against the rendered image content rect", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const stage = screen.getByTestId("image-stage");
    const canvas = screen.getByLabelText("raw16 image");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 320,
      bottom: 230,
      width: 220,
      height: 180,
      x: 100,
      y: 50,
      toJSON: () => {},
    });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 110,
      top: 60,
      right: 310,
      bottom: 220,
      width: 200,
      height: 160,
      x: 110,
      y: 60,
      toJSON: () => {},
    });

    fireEvent.mouseMove(stage, { clientX: 160, clientY: 100 });
    fireEvent.keyDown(window, { key: "ㅔ", code: "KeyP" });

    expect(await screen.findByLabelText("Vertex point-4")).toHaveAttribute("cx", "25");
    expect(screen.getByLabelText("Vertex point-4")).toHaveAttribute("cy", "20");
  });

  test("ignores point shortcuts while text input is focused", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.mouseMove(screen.getByTestId("image-stage"), { clientX: 55, clientY: 24 });
    const rootPathInput = screen.getByLabelText(/root path/i);
    rootPathInput.focus();
    fireEvent.keyDown(window, { key: "ㅔ", code: "KeyP" });

    expect(screen.queryByLabelText("Vertex point-4")).not.toBeInTheDocument();
  });

  test("navigates previous and next images in scanned order", async () => {
    mockApi();

    render(<App />);
    expect(await screen.findByText(/plate-a/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /next image/i }));
    expect(await screen.findByText(/plate-b/i)).toBeInTheDocument();
    expect(screen.getByText(/2 \/ 2/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(await screen.findByText(/plate-a/i)).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 2/i)).toBeInTheDocument();
  });

  test("marks imported previous bounds dirty but does not auto-save", async () => {
    const { fetchMock } = mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.click(screen.getByRole("button", { name: /import previous bound/i }));

    expect(await screen.findByRole("button", { name: "Reloaded Bound" })).toBeInTheDocument();
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/images/scan-a/bounds",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  test("normalizes legacy bounds before saving", async () => {
    const { fetchMock } = mockApi({ boundsQueue: [legacyBounds] });

    render(<App />);
    expect(await screen.findByRole("button", { name: "Legacy Bound" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/images/scan-a/bounds",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const saveCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/images/scan-a/bounds" && options?.method === "PUT",
    );
    const savedPayload = JSON.parse(saveCall[1].body);
    expect(savedPayload.connectionMode).toBe("input-order-cycle");
    expect(savedPayload.groups[0].id).toBe("group-1");
    expect(savedPayload.groups[0].points[0].id).toBe("point-1");
    expect(savedPayload.groups[0].points[1].id).toBe("kept-point");
  });

  test("confirms before replacing dirty edits with a new root", async () => {
    const { fetchMock } = mockApi();
    confirm.mockReturnValue(false);

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.mouseMove(screen.getByTestId("image-stage"), { clientX: 55, clientY: 24 });
    fireEvent.keyDown(window, { key: "ㅔ", code: "KeyP" });
    expect(await screen.findByText(/unsaved/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /find root/i }));

    expect(confirm).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/root/select", expect.objectContaining({ method: "POST" }));
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
  });

  test("failed save keeps local edits dirty", async () => {
    mockApi({
      saveResponse: () => jsonResponse({ error: "Invalid bounds payload." }, { status: 400 }),
    });

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.mouseMove(screen.getByTestId("image-stage"), { clientX: 55, clientY: 24 });
    fireEvent.keyDown(window, { key: "ㅔ", code: "KeyP" });
    expect(await screen.findByText(/unsaved/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText(/save failed/i)).toBeInTheDocument());
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
  });

  test("shows only the original crop presentation and Subimage controls in Subimage mode", async () => {
    mockSubimageApi();
    render(<App />);
    await enterSubimage();

    expect(await screen.findByLabelText("Subimage crop overlay")).toBeInTheDocument();
    expect(screen.getByLabelText("raw16 image")).not.toHaveClass("hidden-layer");
    expect(screen.queryByLabelText("Bounds overlay")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Point order")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Analysis")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Heatmap controls")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Heatmap batch")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Point opacity")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Show ROI")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import previous bound" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set migration" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save subimage" })).toBeInTheDocument();
  });

  test("blocks polygon clicks and p d m shortcuts in Subimage mode", async () => {
    mockSubimageApi();
    render(<App />);
    await enterSubimage();

    const stage = mockSubimageCanvasRect();
    fireEvent.mouseMove(stage, { clientX: 550, clientY: 240 });
    fireEvent.click(stage, { clientX: 550, clientY: 240 });
    fireEvent.keyDown(window, { code: "KeyP" });
    fireEvent.keyDown(window, { code: "KeyD" });
    fireEvent.keyDown(window, { code: "KeyM" });

    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    expect(screen.getAllByLabelText(/^Vertex /)).toHaveLength(3);
    expect(screen.getByLabelText("Vertex point-1")).toHaveAttribute("cx", "10");
    expect(screen.getByText("Clean")).toBeInTheDocument();
  });

  test("draws a source-aspect initial crop without writing and enables create-missing", async () => {
    const { fetchMock } = mockSubimageApi({
      subimageResponse: () => jsonResponse({ hasSubimage: false, crop: null }),
    });
    render(<App />);
    await enterSubimage();

    fireEvent.click(screen.getByRole("button", { name: "Set crop" }));
    const stage = mockSubimageCanvasRect();
    drawSubimageCrop(stage);

    expect(await screen.findByText("50 x 40 px")).toBeInTheDocument();
    expect(screen.getByText("x 10")).toBeInTheDocument();
    expect(screen.getByText("y 8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create all subimages" })).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/subimage"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  test("moves a locked crop without resizing or writing until Save subimage", async () => {
    const { fetchMock } = mockSubimageApi();
    render(<App />);
    await enterSubimage();

    const stage = mockSubimageCanvasRect();
    moveSubimageCrop(stage);

    expect(await screen.findByText("x 50")).toBeInTheDocument();
    expect(screen.getByText("y 0")).toBeInTheDocument();
    expect(screen.getByText("50 x 40 px")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/images/scan-a/subimage",
      expect.objectContaining({ method: "PUT" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save subimage" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/images/scan-a/subimage",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ crop: { ...savedSubimage, x: 50, y: 0 } }),
      }),
    ));
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  test("creates missing crops from the first image template, reports results, and reloads the active crop", async () => {
    let activeLoads = 0;
    const { fetchMock } = mockSubimageApi({
      subimageResponse: (imageId) => {
        if (imageId !== "scan-a") return jsonResponse({ hasSubimage: false, crop: null });
        activeLoads += 1;
        return jsonResponse(activeLoads === 1
          ? { hasSubimage: false, crop: null }
          : { hasSubimage: true, crop: { ...savedSubimage, x: 11, y: 9 } });
      },
      createSubimagesResponse: () => jsonResponse({
        operation: "create-missing",
        discovered: 3,
        completed: 2,
        created: ["plate-a"],
        preserved: ["plate-b"],
        replaced: [],
        failed: [{ imageFolder: "plate-c", code: "WRITE_FAILED", message: "Unable to save subimage." }],
      }),
    });
    render(<App />);
    await enterSubimage();
    fireEvent.click(screen.getByRole("button", { name: "Set crop" }));
    drawSubimageCrop(mockSubimageCanvasRect());

    fireEvent.click(screen.getByRole("button", { name: "Create all subimages" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/subimages/create-missing",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    ));
    const createCall = fetchMock.mock.calls.find(([url, options]) =>
      url === "/api/subimages/create-missing" && options?.method === "POST");
    expect(JSON.parse(createCall[1].body)).toEqual({
      templateCrop: expect.objectContaining({ x: 10, y: 8, width: 50, height: 40 }),
    });
    expect(await screen.findByText("Created (1): plate-a")).toBeInTheDocument();
    expect(screen.getByText("Preserved (1): plate-b")).toBeInTheDocument();
    expect(screen.getByText("Failed (1): plate-c - Unable to save subimage.")).toBeInTheDocument();
    expect(await screen.findByText("x 11")).toBeInTheDocument();
    expect(screen.getByText("y 9")).toBeInTheDocument();
    expect(activeLoads).toBe(2);
  });

  test("reloads after a partial batch but preserves the active draft when that image failed", async () => {
    let activeLoads = 0;
    mockSubimageApi({
      subimageResponse: (imageId) => {
        if (imageId !== "scan-a") return jsonResponse({ hasSubimage: false, crop: null });
        activeLoads += 1;
        return jsonResponse(activeLoads === 1
          ? { hasSubimage: false, crop: null }
          : { hasSubimage: true, crop: { ...savedSubimage, x: 33, y: 24 } });
      },
      createSubimagesResponse: () => jsonResponse({
        operation: "create-missing",
        discovered: 2,
        completed: 1,
        created: ["plate-b"],
        preserved: [],
        replaced: [],
        failed: [{ imageFolder: "plate-a", code: "WRITE_FAILED", message: "Unable to save subimage." }],
      }),
    });
    render(<App />);
    await enterSubimage();
    fireEvent.click(screen.getByRole("button", { name: "Set crop" }));
    drawSubimageCrop(mockSubimageCanvasRect());

    fireEvent.click(screen.getByRole("button", { name: "Create all subimages" }));

    expect(await screen.findByText("Failed (1): plate-a - Unable to save subimage.")).toBeInTheDocument();
    expect(await screen.findByText("x 10")).toBeInTheDocument();
    expect(screen.getByText("y 8")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(activeLoads).toBe(2);
  });

  test("loads distinct saved crops in order and reserves create-missing for the first image", async () => {
    mockSubimageApi();
    render(<App />);
    await enterSubimage();
    expect(await screen.findByText("x 10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));

    expect(await screen.findByText("x 30")).toBeInTheDocument();
    expect(screen.getByText("y 20")).toBeInTheDocument();
    expect(screen.getByText("Template: plate-a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create all subimages" })).toBeDisabled();
  });

  test("reviews a replacement candidate and restores the saved crop when replacement is cancelled", async () => {
    confirm.mockReturnValue(false);
    const { fetchMock } = mockSubimageApi();
    render(<App />);
    await enterSubimage();
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    await screen.findByText("x 30");

    fireEvent.click(screen.getByRole("button", { name: "Replace all subimages" }));
    drawSubimageCrop(mockSubimageCanvasRect(), {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 390, clientY: 310 },
    });
    expect(await screen.findByText("40 x 32 px")).toBeInTheDocument();
    expect(screen.getByText("Review replacement crop")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply replacement" }));
    expect(confirm).toHaveBeenCalledWith("Replace all saved subimages with this crop?");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/subimages/replace-all",
      expect.objectContaining({ method: "POST" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel replacement" }));
    expect(await screen.findByText("x 30")).toBeInTheDocument();
    expect(screen.getByText("y 20")).toBeInTheDocument();
    expect(screen.getByText("50 x 40 px")).toBeInTheDocument();
  });

  test("confirms replacement, reloads the server-normalized active crop, and locks its new size", async () => {
    let scanBLoads = 0;
    const replacementCrop = { ...savedSubimageB, x: 5, y: 4, width: 40, height: 32 };
    const { fetchMock } = mockSubimageApi({
      subimageResponse: (imageId) => {
        if (imageId === "scan-a") return jsonResponse({ hasSubimage: true, crop: savedSubimage });
        scanBLoads += 1;
        return jsonResponse({ hasSubimage: true, crop: scanBLoads === 1 ? savedSubimageB : replacementCrop });
      },
    });
    render(<App />);
    await enterSubimage();
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    await screen.findByText("x 30");

    fireEvent.click(screen.getByRole("button", { name: "Replace all subimages" }));
    const stage = mockSubimageCanvasRect();
    drawSubimageCrop(stage, {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 390, clientY: 310 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply replacement" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/subimages/replace-all",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    ));
    const replaceCall = fetchMock.mock.calls.find(([url, options]) =>
      url === "/api/subimages/replace-all" && options?.method === "POST");
    expect(JSON.parse(replaceCall[1].body)).toEqual({
      templateCrop: expect.objectContaining({ x: 0, y: 0, width: 40, height: 32 }),
    });
    expect(await screen.findByText("x 5")).toBeInTheDocument();
    expect(screen.getByText("y 4")).toBeInTheDocument();
    expect(screen.getByText("40 x 32 px")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();

    fireSubimagePointer(stage, "pointerdown", {
      clientX: 100,
      clientY: 100,
      button: 0,
      pointerId: 3,
    });
    fireSubimagePointer(stage, "pointermove", { clientX: 1000, clientY: 0, pointerId: 3 });
    fireSubimagePointer(stage, "pointerup", { clientX: 1000, clientY: 0, pointerId: 3 });
    expect(screen.getByText("40 x 32 px")).toBeInTheDocument();
    expect(screen.getByText("x 60")).toBeInTheDocument();
  });

  test("ignores a stale Subimage GET after navigating to another image", async () => {
    const firstLoad = deferred();
    let scanALoads = 0;
    mockSubimageApi({
      subimageResponse: (imageId) => {
        if (imageId === "scan-b") return jsonResponse({ hasSubimage: true, crop: savedSubimageB });
        scanALoads += 1;
        return scanALoads === 1
          ? firstLoad.promise
          : jsonResponse({ hasSubimage: true, crop: savedSubimage });
      },
    });
    render(<App />);
    await enterSubimage();

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(await screen.findByText("x 30")).toBeInTheDocument();

    firstLoad.resolve(await jsonResponse({ hasSubimage: true, crop: savedSubimage }));
    await act(async () => firstLoad.promise);
    expect(screen.getByText("x 30")).toBeInTheDocument();
    expect(screen.queryByText("x 10")).not.toBeInTheDocument();
  });

  test("clears Subimage state on root replacement and ignores the old root response", async () => {
    const oldRootLoad = deferred();
    const nextImage = {
      ...subimageImages[0],
      id: "scan-c",
      folder: "plate-c",
      imageFolder: "plate-c",
      file: "c.tif",
      imageFile: "c.tif",
    };
    const nextCrop = {
      ...savedSubimage,
      imageFolder: "plate-c",
      imageFile: "c.tif",
      x: 40,
      y: 24,
    };
    mockSubimageApi({
      appliedRootPath: "/next/root",
      appliedRootImages: [nextImage],
      subimageResponse: (imageId) => imageId === "scan-a"
        ? oldRootLoad.promise
        : jsonResponse({ hasSubimage: true, crop: nextCrop }),
    });
    render(<App />);
    await enterSubimage();

    fireEvent.change(screen.getByLabelText("Root path"), { target: { value: "/next/root" } });
    fireEvent.click(screen.getByRole("button", { name: "Set root" }));
    expect(await screen.findByText("x 40")).toBeInTheDocument();

    oldRootLoad.resolve(await jsonResponse({ hasSubimage: true, crop: savedSubimage }));
    await act(async () => oldRootLoad.promise);
    expect(screen.getByText("x 40")).toBeInTheDocument();
    expect(screen.queryByText("x 10")).not.toBeInTheDocument();
  });

  test("confirms dirty Subimage drafts for previous and next buttons", async () => {
    await renderDirtySubimage();
    confirm.mockReturnValueOnce(false).mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByText("x 50")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(await screen.findByText("2 / 2")).toBeInTheDocument();

    const stage = mockSubimageCanvasRect();
    moveSubimageCrop(stage);
    await screen.findByText("x 50");
    confirm.mockReturnValueOnce(false).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
  });

  test("confirms dirty Subimage drafts for ArrowLeft and ArrowRight navigation", async () => {
    await renderDirtySubimage();
    confirm.mockReturnValueOnce(false).mockReturnValue(true);

    fireEvent.keyDown(window, { code: "ArrowRight" });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    fireEvent.keyDown(window, { code: "ArrowRight" });
    expect(await screen.findByText("2 / 2")).toBeInTheDocument();

    moveSubimageCrop(mockSubimageCanvasRect());
    await screen.findByText("x 50");
    confirm.mockReturnValueOnce(false).mockReturnValue(true);
    fireEvent.keyDown(window, { code: "ArrowLeft" });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    fireEvent.keyDown(window, { code: "ArrowLeft" });
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
  });

  test.each([
    ["Set root", "/api/root"],
    ["Find root", "/api/root/select"],
  ])("confirms a dirty Subimage draft before %s", async (buttonName, endpoint) => {
    const { fetchMock } = await renderDirtySubimage();
    confirm.mockReturnValueOnce(false).mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    expect(fetchMock).not.toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: "POST" }));
    expect(screen.getByText("x 50")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: "POST" })));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved subimage changes?");
  });

  test("confirms before leaving Subimage and restores the saved draft on approval", async () => {
    await renderDirtySubimage();
    confirm.mockReturnValueOnce(false).mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    expect(screen.getByRole("button", { name: "Subimage" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("x 50")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    expect(screen.getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Subimage" }));
    expect(await screen.findByText("x 10")).toBeInTheDocument();
  });

  test("registers the legacy and modern beforeunload signals only for a dirty Subimage draft", async () => {
    await renderDirtySubimage();
    const event = new Event("beforeunload", { cancelable: true });
    let returnValue = null;
    Object.defineProperty(event, "returnValue", {
      configurable: true,
      get: () => returnValue,
      set: (value) => {
        returnValue = value;
      },
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(returnValue).toBe("");
  });

  test("saving a Subimage crop does not clear independently dirty bounds", async () => {
    const { fetchMock } = mockSubimageApi();
    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.mouseMove(screen.getByTestId("image-stage"), { clientX: 55, clientY: 24 });
    fireEvent.keyDown(window, { code: "KeyP" });
    expect(await screen.findByText("Unsaved")).toBeInTheDocument();

    await enterSubimage();
    moveSubimageCrop(mockSubimageCanvasRect());
    fireEvent.click(await screen.findByRole("button", { name: "Save subimage" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/images/scan-a/subimage",
      expect.objectContaining({ method: "PUT" }),
    ));
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/images/scan-a/bounds",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  test("clicking an existing vertex does not add a point", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.mouseMove(screen.getByTestId("image-stage"), { clientX: 55, clientY: 24 });
    fireEvent.click(screen.getByLabelText("Vertex point-1"));

    expect(screen.queryByLabelText("Vertex point-4")).not.toBeInTheDocument();
  });
});

function svgPoint(element) {
  return {
    x: Number(element.getAttribute("x")),
    y: Number(element.getAttribute("y")),
  };
}

function pointInPolygon(point, polygon) {
  let inside = false;

  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;

    if (intersects) inside = !inside;
  }

  return inside;
}
