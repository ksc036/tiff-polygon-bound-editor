/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  schemaVersion: 1,
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
      bands: {
        near: {
          roiAreaPx: 25,
          skeletonPixelCount: 5,
          skeletonLengthPx: 6,
          density: 0.24,
          coverage: 0.2,
          globalAlignment: 0.8,
          radialNormalAlignment: 0.7,
          tangentialAlignment: 0.3,
          empty: false,
        },
      },
      allBands: {
        roiAreaPx: 25,
        skeletonPixelCount: 5,
        skeletonLengthPx: 6,
        density: 0.24,
        coverage: 0.2,
        globalAlignment: 0.8,
        radialNormalAlignment: 0.7,
        tangentialAlignment: 0.3,
        empty: false,
      },
    },
  ],
  imageSummary: {
    roiAreaPx: 25,
    skeletonPixelCount: 5,
    skeletonLengthPx: 6,
    density: 0.24,
    coverage: 0.2,
    globalAlignment: 0.8,
    radialNormalAlignment: 0.7,
    tangentialAlignment: 0.3,
  },
  warnings: [],
  updatedAt: "2026-07-05T00:00:00.000Z",
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

function mockApi({
  boundsQueue = [savedBounds],
  rootImages = images,
  saveResponse = null,
  analysisResponse = { analysis: null, hasAnalysis: false },
  recalculateAnalysis = savedAnalysis,
} = {}) {
  const calls = [];
  const fetchMock = vi.fn((input, options = {}) => {
    const url = String(input);
    const method = options.method ?? "GET";
    calls.push({ url, method, options });

    if (url === "/api/root" && method === "GET") {
      return jsonResponse({ rootPath: "/data/root", images: rootImages });
    }
    if (url === "/api/root" && method === "POST") {
      return jsonResponse({ rootPath: "/typed/root", images: rootImages });
    }
    if (url === "/api/root/select" && method === "POST") {
      return jsonResponse({ rootPath: "/selected/root", images: rootImages });
    }
    if (url === "/api/images/scan-a" && method === "GET") {
      return jsonResponse({ image: images[0] });
    }
    if (url === "/api/images/scan-b" && method === "GET") {
      return jsonResponse({ image: images[1] });
    }
    if (url === "/api/images/scan-a/raw16" && method === "GET") {
      return raw16Response(100, 80);
    }
    if (url === "/api/images/scan-a/roi-overlay" && method === "POST") {
      return pngResponse();
    }
    if (url === "/api/images/scan-b/raw16" && method === "GET") {
      return raw16Response(120, 90);
    }
    if (url === "/api/images/scan-b/roi-overlay" && method === "POST") {
      return pngResponse();
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
  return { fetchMock, calls };
}

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:roi-overlay"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("renders root selection controls first", () => {
    mockApi({ rootImages: [] });
    render(<App />);
    expect(screen.getByRole("button", { name: /find root/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/root path/i)).toBeInTheDocument();
  });

  test("loads saved bounds when opening an image", async () => {
    mockApi();

    render(<App />);

    expect(await screen.findByRole("button", { name: "Saved Tissue" })).toBeInTheDocument();
    expect(screen.getByText(/saved bound loaded/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Vertex point-1")).toHaveAttribute("cx", "10");
  });

  test("loads saved analysis after opening an image", async () => {
    mockApi({ analysisResponse: { analysis: savedAnalysis, hasAnalysis: true } });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/analysis loaded/i)).toBeInTheDocument());
    expect(screen.getByText("plate-a.png")).toBeInTheDocument();
    expect(screen.getAllByText("0.2400").length).toBeGreaterThan(0);
  });

  test("recalculates analysis with edited contiguous ROI bands", async () => {
    const { fetchMock } = mockApi({ analysisResponse: { analysis: null, hasAnalysis: false } });

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.change(screen.getByLabelText(/가까움 upper/i), { target: { value: "18" } });
    fireEvent.click(screen.getByRole("button", { name: /recalculate/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/images/scan-a/analysis/recalculate",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/images/scan-a/analysis/recalculate");
    expect(JSON.parse(call[1].body).roiBands).toEqual([
      { id: "near", label: "가까움", fromPx: 0, toPx: 18 },
      { id: "mid", label: "중간", fromPx: 18, toPx: 50 },
      { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
    ]);
    expect(await screen.findByText(/analysis recalculated/i)).toBeInTheDocument();
  });

  test("switches the image stage between original and mask preview", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    expect(screen.getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Mask" }));

    expect(screen.getByRole("button", { name: "Mask" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByAltText("mask preview")).toHaveAttribute("src", "/api/images/scan-a/mask-preview");
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

    fireEvent.change(screen.getByLabelText(/가까움 upper/i), { target: { value: "18" } });

    await waitFor(() => expect(screen.getByLabelText("ROI preview near")).toHaveAttribute("stroke-width", "36"));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/roi-overlay"))).toBe(false);
  });

  test("allows ROI limit inputs to be cleared before typing replacement values", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    const nearInput = screen.getByLabelText(/가까움 upper/i);
    fireEvent.change(nearInput, { target: { value: "" } });

    expect(nearInput.value).toBe("");

    fireEvent.change(nearInput, { target: { value: "30" } });

    expect(nearInput.value).toBe("30");
    expect(screen.getByLabelText("ROI preview near")).toHaveAttribute("stroke-width", "60");
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

  test("reloads saved bounds with Load saved bound", async () => {
    mockApi({ boundsQueue: [savedBounds, reloadedBounds] });

    render(<App />);
    expect(await screen.findByRole("button", { name: "Saved Tissue" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load saved bound/i }));

    expect(await screen.findByRole("button", { name: "Reloaded Bound" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Saved Tissue" })).not.toBeInTheDocument();
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

  test("clicking an existing vertex does not add a point", async () => {
    mockApi();

    render(<App />);
    await screen.findByRole("button", { name: "Saved Tissue" });

    fireEvent.mouseMove(screen.getByTestId("image-stage"), { clientX: 55, clientY: 24 });
    fireEvent.click(screen.getByLabelText("Vertex point-1"));

    expect(screen.queryByLabelText("Vertex point-4")).not.toBeInTheDocument();
  });
});
