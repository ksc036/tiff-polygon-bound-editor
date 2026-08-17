/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import AppRouter from "./AppRouter.jsx";
import InferencePage from "./InferencePage.jsx";

const baseImages = [
  { id: "waiting-a", timestampFolder: "001", imageFile: "waiting.tif", status: "waiting" },
  { id: "complete-a", timestampFolder: "002", imageFile: "reference.tif", status: "complete" },
  { id: "sending-a", timestampFolder: "003", imageFile: "sending.tiff", status: "sending" },
  { id: "complete-b", timestampFolder: "004", imageFile: "override.tif", status: "complete" },
  { id: "failed-a", timestampFolder: "005", imageFile: "failed.tif", status: "failed", message: "Model unavailable" },
];

const reviews = {
  "complete-a": {
    id: "complete-a",
    timestampFolder: "002",
    imageFile: "reference.tif",
    width: 2,
    height: 2,
    threshold: 0.5,
    settings: { threshold: 0.5, roiGroupId: "roi-a" },
    wholeImage: { areaFraction: 0.25 },
    groups: [
      { id: "roi-a", name: "Tissue", color: "#e11d48" },
      { id: "roi-b", name: "Edge", color: "#2563eb" },
    ],
    roi: { groupId: "roi-a", metrics: { areaFraction: 0.5 } },
  },
  "complete-b": {
    id: "complete-b",
    timestampFolder: "004",
    imageFile: "override.tif",
    width: 3,
    height: 1,
    threshold: 0.61,
    settings: { threshold: 0.61, roiGroupId: null },
    wholeImage: { areaFraction: 2 / 3 },
    groups: [],
    roi: null,
  },
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => payload,
  };
}

function raw16Response(width, height) {
  const pixels = new Uint16Array(width * height).fill(1024);
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return {
          "x-image-width": String(width),
          "x-image-height": String(height),
          "x-display-min": "0",
          "x-display-max": "4095",
        }[name.toLowerCase()] ?? null;
      },
    },
    arrayBuffer: async () => pixels.buffer,
  };
}

function overlayResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "image/png" },
    blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function mockInferenceApi({
  images: initialImages = baseImages,
  imageListDeferredByCall = {},
  imageSnapshots = null,
  jobStatus = "complete",
  jobDeferred,
  overlayDeferredByUrl = {},
  reviewDeferredById = {},
  rootData = null,
  thresholdSave,
} = {}) {
  let images = clone(initialImages);
  let imageListCallCount = 0;
  let imageSnapshotIndex = 0;
  const currentReviews = clone(reviews);
  let rootPath = "/data/inference";

  const fetchMock = vi.fn(async (url, options = {}) => {
    const method = options.method ?? "GET";

    if (url === "/api/inference/images" && method === "GET") {
      imageListCallCount += 1;
      const responseRoot = rootPath;
      if (rootData?.[responseRoot]) {
        images = clone(rootData[responseRoot].images);
      } else if (imageSnapshots?.length) {
        images = clone(imageSnapshots[Math.min(imageSnapshotIndex, imageSnapshots.length - 1)]);
        imageSnapshotIndex += 1;
      }
      const responseImages = clone(images);
      if (imageListDeferredByCall[imageListCallCount]) {
        await imageListDeferredByCall[imageListCallCount].promise;
      }
      return jsonResponse({ rootPath: responseRoot, images: responseImages });
    }
    if (url === "/api/inference/root" && method === "POST") {
      rootPath = JSON.parse(options.body).rootPath;
      return jsonResponse({ rootPath, images: [] });
    }
    if (url === "/api/inference/root/select" && method === "POST") {
      rootPath = "/selected/inference";
      return jsonResponse({ rootPath, images: [] });
    }
    if (url === "/api/inference/jobs" && method === "POST") {
      images = images.map((image) => image.status === "waiting" ? { ...image, status: "sending" } : image);
      return jsonResponse({
        job: { id: "job-1", status: "running", total: images.length, completed: 0, failed: 0 },
      }, 202);
    }
    if (url === "/api/inference/jobs/job-1" && method === "GET") {
      if (jobDeferred) await jobDeferred.promise;
      images = images.map((image) => image.status === "sending" ? { ...image, status: "complete" } : image);
      return jsonResponse({
        job: { id: "job-1", status: jobStatus, total: images.length, completed: images.length, failed: 0 },
      });
    }
    if (url.startsWith("/api/inference/images/") && url.includes("/review") && method === "GET") {
      const id = url.split("/")[4];
      if (reviewDeferredById[id]) await reviewDeferredById[id].promise;
      const review = clone(rootData?.[rootPath]?.reviews?.[id] ?? currentReviews[id] ?? reviews["complete-a"]);
      const roiGroupId = new URLSearchParams(url.split("?")[1] ?? "").get("roiGroupId");
      if (roiGroupId === "roi-b") {
        review.roi = { groupId: "roi-b", metrics: { areaFraction: 0.75 } };
      }
      return jsonResponse(review);
    }
    if (url.startsWith("/api/inference/images/") && url.endsWith("/threshold") && method === "PUT") {
      const id = url.split("/")[4];
      const threshold = JSON.parse(options.body).threshold;
      if (thresholdSave) {
        const response = await thresholdSave.promise;
        if (response) return response;
      }
      currentReviews[id].threshold = threshold;
      currentReviews[id].settings.threshold = threshold;
      return jsonResponse(currentReviews[id].settings);
    }
    if (url.startsWith("/api/inference/images/") && url.includes("/overlay?") && method === "GET") {
      if (overlayDeferredByUrl[url]) await overlayDeferredByUrl[url].promise;
      return overlayResponse();
    }
    if (url.startsWith("/api/inference/images/") && url.endsWith("/raw16") && method === "GET") {
      const id = url.split("/")[4];
      return id === "complete-b" ? raw16Response(3, 1) : raw16Response(2, 2);
    }
    if (url.startsWith("/api/images/") && url.endsWith("/raw16") && method === "GET") {
      const folder = url.split("/")[3];
      return folder === "004" ? raw16Response(3, 1) : raw16Response(2, 2);
    }
    if (url === "/api/inference/reference-thresholds" && method === "POST") {
      return jsonResponse({ updated: 1, targetAreaFraction: 0.5, roiGroupId: "roi-a" });
    }
    if (url === "/api/inference/generate-masks" && method === "POST") {
      return jsonResponse({ completed: 2, failed: 0 });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

function requestBody(call) {
  return JSON.parse(call[1].body);
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mask-overlay"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("routes the inference deep link to the focused review page", async () => {
  mockInferenceApi();
  window.history.pushState({}, "", "/inferencePage");

  render(<AppRouter />);

  expect(await screen.findByRole("heading", { name: "Inference mask setting" })).toBeInTheDocument();
});

test("uses an independent inference layout with status list and review stage", async () => {
  mockInferenceApi();

  render(<InferencePage />);

  expect(await screen.findByLabelText("Inference image list")).toHaveClass("inference-image-list");
  expect(screen.getByLabelText("Probability review stage")).toHaveClass("inference-stage");
});

test("shows every source status and selects the first completed image for review", async () => {
  mockInferenceApi();

  render(<InferencePage />);

  expect(await screen.findByDisplayValue("0.500")).toBeInTheDocument();
  expect(screen.getByText("Whole image area fraction")).toBeInTheDocument();
  expect(await screen.findByText("25.00%")).toBeInTheDocument();
  expect(await screen.findByText("ROI area fraction")).toBeInTheDocument();
  expect(await screen.findByText("50.00%")).toBeInTheDocument();
  for (const status of ["Waiting", "Sending", "Complete", "Failed"]) {
    expect(screen.getAllByText(status).length).toBeGreaterThan(0);
  }
  expect(screen.getByText("Model unavailable")).toBeInTheDocument();

  const canvas = screen.getByLabelText("Original source image");
  await waitFor(() => expect(canvas).toHaveAttribute("width", "2"));
  expect(canvas).toHaveAttribute("height", "2");
  await waitFor(() => expect(screen.getByAltText("Binary mask overlay")).toHaveAttribute("src", "blob:mask-overlay"));
});

test("loads raw16 bytes by opaque image id when one timestamp has two TIFFs", async () => {
  const { fetchMock } = mockInferenceApi({
    images: [
      { id: "complete-a", timestampFolder: "same-timestamp", imageFile: "a.tif", status: "complete" },
      { id: "complete-b", timestampFolder: "same-timestamp", imageFile: "b.tif", status: "complete" },
    ],
  });
  render(<InferencePage />);
  const canvas = await screen.findByLabelText("Original source image");
  await waitFor(() => expect(canvas).toHaveAttribute("width", "2"));

  fireEvent.click(screen.getByRole("button", { name: "Next complete image" }));

  await waitFor(() => expect(canvas).toHaveAttribute("width", "3"));
  expect(fetchMock).toHaveBeenCalledWith("/api/inference/images/complete-b/raw16");
  expect(fetchMock).not.toHaveBeenCalledWith("/api/images/same-timestamp/raw16");
});

test("renders a waiting source TIFF immediately after selection", async () => {
  mockInferenceApi({
    images: [{ id: "waiting-a", timestampFolder: "001", imageFile: "waiting.tif", status: "waiting" }],
  });

  render(<InferencePage />);

  await waitFor(() => expect(screen.getByLabelText("Original source image")).toHaveAttribute("width", "2"));
});

test("keeps threshold and mask actions unavailable for a selected waiting source", async () => {
  mockInferenceApi({
    images: [{ id: "waiting-a", timestampFolder: "001", imageFile: "waiting.tif", status: "waiting" }],
  });

  render(<InferencePage />);

  await screen.findByLabelText("Original source image");
  expect(screen.getByLabelText("Threshold")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Set other thresholds from reference" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Generate masks" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Previous complete image" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next complete image" })).toBeDisabled();
  expect(screen.queryByLabelText("Saved ROI group")).not.toBeInTheDocument();
});

test("composites the source canvas and binary mask in one stable stage frame", async () => {
  mockInferenceApi();
  render(<InferencePage />);
  const stage = await screen.findByLabelText("Probability review stage");
  const frame = within(stage).getByLabelText("Composited source and binary mask");
  const canvas = within(frame).getByLabelText("Original source image");
  const overlay = await within(frame).findByAltText("Binary mask overlay");

  expect(stage).toHaveClass("inference-stage");
  expect(frame).toHaveClass("inference-stage-frame");
  expect(canvas).toHaveClass("inference-source-canvas");
  expect(overlay).toHaveClass("inference-mask-overlay");
  expect(overlay).toHaveAttribute("width", "2");
  expect(overlay).toHaveAttribute("height", "2");
});

test("sets a typed root, supports folder selection, and reloads inference rows", async () => {
  const { fetchMock } = mockInferenceApi();
  render(<InferencePage />);
  const rootInput = await screen.findByLabelText("Root path");

  fireEvent.change(rootInput, { target: { value: "/new/root" } });
  fireEvent.click(screen.getByRole("button", { name: "Set root" }));
  await waitFor(() => expect(rootInput).toHaveValue("/new/root"));
  fireEvent.click(screen.getByRole("button", { name: "Find root" }));
  await waitFor(() => expect(rootInput).toHaveValue("/selected/inference"));

  expect(fetchMock).toHaveBeenCalledWith("/api/inference/root", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ rootPath: "/new/root" }),
  }));
  expect(fetchMock).toHaveBeenCalledWith("/api/inference/root/select", expect.objectContaining({ method: "POST" }));
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/inference/images").length).toBeGreaterThanOrEqual(3);
});

test("starts inference with the configured server and polls the job to completion", async () => {
  const { fetchMock } = mockInferenceApi({
    images: [{ id: "waiting-a", timestampFolder: "001", imageFile: "waiting.tif", status: "waiting" }],
  });
  render(<InferencePage />);
  const serverInput = await screen.findByLabelText("Model server URL");

  fireEvent.change(serverInput, { target: { value: "http://model:8080" } });
  fireEvent.click(screen.getByRole("button", { name: "Run inference" }));

  await screen.findByText("Inference complete: 1 complete, 0 failed");
  expect(fetchMock).toHaveBeenCalledWith("/api/inference/jobs", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ serverUrl: "http://model:8080" }),
  }));
  expect(fetchMock).toHaveBeenCalledWith("/api/inference/jobs/job-1", expect.objectContaining({ method: "GET" }));
});

test("stops an old job poll continuation after switching roots", async () => {
  const oldJobList = deferred();
  const oldImages = [{ id: "waiting-a", timestampFolder: "001", imageFile: "old.tif", status: "waiting" }];
  const newImages = [{ id: "new-complete", timestampFolder: "101", imageFile: "new.tif", status: "complete" }];
  const { fetchMock } = mockInferenceApi({
    images: oldImages,
    jobStatus: "complete",
    imageListDeferredByCall: { 3: oldJobList },
    rootData: {
      "/data/inference": { images: oldImages, reviews: {} },
      "/new/root": { images: newImages, reviews: {} },
    },
  });
  render(<InferencePage />);
  expect(await screen.findByText("old.tif")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Run inference" }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(
    ([url]) => url === "/api/inference/images",
  )).toHaveLength(3));
  await waitFor(() => expect(screen.getByRole("button", { name: "Set root" })).toBeEnabled());

  const rootInput = screen.getByLabelText("Root path");
  fireEvent.change(rootInput, { target: { value: "/new/root" } });
  fireEvent.click(screen.getByRole("button", { name: "Set root" }));
  expect(await screen.findByText("new.tif")).toBeInTheDocument();

  await act(async () => {
    oldJobList.reject(new Error("Old job image list failed."));
    await oldJobList.promise.catch(() => {});
    await Promise.resolve();
  });

  expect(screen.getByLabelText("Root path")).toHaveValue("/new/root");
  expect(screen.getByText("new.tif")).toBeInTheDocument();
  expect(screen.queryByText(/Inference complete:/)).not.toBeInTheDocument();
  const pollCount = fetchMock.mock.calls.filter(
    ([url]) => url === "/api/inference/jobs/job-1",
  ).length;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(fetchMock.mock.calls.filter(
    ([url]) => url === "/api/inference/jobs/job-1",
  )).toHaveLength(pollCount);
});

test("resumes status polling when the initial image rows are already sending", async () => {
  const { fetchMock } = mockInferenceApi({
    imageSnapshots: [
      [{ id: "complete-a", timestampFolder: "002", imageFile: "reference.tif", status: "sending" }],
      [{ id: "complete-a", timestampFolder: "002", imageFile: "reference.tif", status: "complete" }],
    ],
  });
  render(<InferencePage />);

  expect(await screen.findByText("Sending")).toBeInTheDocument();
  await waitFor(() => expect(fetchMock.mock.calls.filter(
    ([url]) => url === "/api/inference/images",
  ).length).toBeGreaterThanOrEqual(2), { timeout: 1500 });

  expect(await screen.findByText("Complete")).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/inference/jobs")).toBe(false);
});

test("commits a threshold only for the active source without implicit propagation", async () => {
  const { fetchMock } = mockInferenceApi();
  render(<InferencePage />);
  const threshold = await screen.findByLabelText("Threshold");

  fireEvent.change(threshold, { target: { value: "0.723" } });
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/inference/reference-thresholds")).toBe(false);
  fireEvent.blur(threshold);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/inference/images/complete-a/threshold",
    expect.objectContaining({ method: "PUT" }),
  ));
  const thresholdCall = fetchMock.mock.calls.find(([url]) => url === "/api/inference/images/complete-a/threshold");
  expect(requestBody(thresholdCall)).toEqual({ threshold: 0.723 });
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/inference/reference-thresholds")).toBe(false);
});

test("normalizes off-grid threshold edits for overlay requests and persistence", async () => {
  const { fetchMock } = mockInferenceApi();
  render(<InferencePage />);
  const threshold = await screen.findByLabelText("Threshold");

  fireEvent.change(threshold, { target: { value: "0.7236" } });
  fireEvent.blur(threshold);

  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => url === "/api/inference/images/complete-a/overlay?threshold=0.724",
  )).toBe(true));
  const thresholdCall = fetchMock.mock.calls.find(([url]) => url === "/api/inference/images/complete-a/threshold");
  expect(requestBody(thresholdCall)).toEqual({ threshold: 0.724 });
  expect(await screen.findByDisplayValue("0.724")).toBeInTheDocument();
});

test("propagates from the active image and selected ROI only on the explicit action", async () => {
  const { fetchMock } = mockInferenceApi();
  render(<InferencePage />);
  await screen.findByDisplayValue("0.500");

  fireEvent.click(screen.getByRole("button", { name: "Set other thresholds from reference" }));

  await screen.findByText("Updated 1 other threshold");
  const propagationCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/inference/reference-thresholds");
  expect(propagationCalls).toHaveLength(1);
  expect(requestBody(propagationCalls[0])).toEqual({ referenceId: "complete-a", roiGroupId: "roi-a" });
});

test("waits for an edited reference threshold to persist before propagation", async () => {
  const thresholdSave = deferred();
  const { fetchMock } = mockInferenceApi({ thresholdSave });
  render(<InferencePage />);
  const threshold = await screen.findByLabelText("Threshold");
  await screen.findByText("25.00%");

  fireEvent.change(threshold, { target: { value: "0.723" } });
  fireEvent.blur(threshold);
  fireEvent.click(screen.getByRole("button", { name: "Set other thresholds from reference" }));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/inference/reference-thresholds")).toBe(false);

  thresholdSave.resolve();

  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => url === "/api/inference/reference-thresholds",
  )).toBe(true));
});

test("lets the user select a valid saved ROI without exposing editing controls", async () => {
  const { fetchMock } = mockInferenceApi();
  render(<InferencePage />);
  const roiSelect = await screen.findByLabelText("Saved ROI group");

  fireEvent.change(roiSelect, { target: { value: "roi-b" } });

  await screen.findByText("75.00%");
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/inference/images/complete-a/review?roiGroupId=roi-b")).toBe(true);
  expect(screen.queryByRole("button", { name: /add point/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /edit ROI/i })).not.toBeInTheDocument();
});

test("keeps the active image review when the previous request finishes later", async () => {
  const delayedReference = deferred();
  mockInferenceApi({ reviewDeferredById: { "complete-a": delayedReference } });
  render(<InferencePage />);
  const navigation = await screen.findByLabelText("Completed image navigation");

  fireEvent.click(within(navigation).getByRole("button", { name: "Next complete image" }));
  expect(await screen.findByDisplayValue("0.610")).toBeInTheDocument();
  expect(await screen.findByText("66.67%")).toBeInTheDocument();
  await act(async () => {
    delayedReference.resolve();
    await delayedReference.promise;
    await Promise.resolve();
  });

  expect(screen.getByDisplayValue("0.610")).toBeInTheDocument();
  expect(screen.getByText("66.67%")).toBeInTheDocument();
  expect(screen.queryByText("25.00%")).not.toBeInTheDocument();
});

test("navigates previous and next across completed images only and permits a manual override", async () => {
  const { fetchMock } = mockInferenceApi();
  render(<InferencePage />);
  await screen.findByText("reference.tif");
  const navigation = screen.getByLabelText("Completed image navigation");

  expect(within(navigation).getByRole("button", { name: "Previous complete image" })).toBeDisabled();
  fireEvent.click(within(navigation).getByRole("button", { name: "Next complete image" }));
  await screen.findByDisplayValue("0.610");
  expect(within(navigation).getByRole("button", { name: "Next complete image" })).toBeDisabled();

  const threshold = screen.getByLabelText("Threshold");
  fireEvent.change(threshold, { target: { value: "0.412" } });
  fireEvent.blur(threshold);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/inference/images/complete-b/threshold",
    expect.objectContaining({ method: "PUT" }),
  ));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/inference/images/complete-a/threshold")).toBe(false);
});

test("generates masks for completed images and reports the result", async () => {
  const { fetchMock } = mockInferenceApi();
  render(<InferencePage />);
  await screen.findByDisplayValue("0.500");

  fireEvent.click(screen.getByRole("button", { name: "Generate masks" }));

  expect(await screen.findByText("Generated 2 masks; 0 failed")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/inference/generate-masks", expect.objectContaining({ method: "POST" }));
});

test("waits for an edited active threshold to save before generating masks", async () => {
  const thresholdSave = deferred();
  const { fetchMock } = mockInferenceApi({ thresholdSave });
  render(<InferencePage />);
  const threshold = await screen.findByLabelText("Threshold");

  fireEvent.change(threshold, { target: { value: "0.723" } });
  fireEvent.blur(threshold);
  fireEvent.click(screen.getByRole("button", { name: "Generate masks" }));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/inference/generate-masks")).toBe(false);

  thresholdSave.resolve();

  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => url === "/api/inference/generate-masks",
  )).toBe(true));
});

test("aborts mask generation when the active threshold save fails", async () => {
  const thresholdSave = deferred();
  const { fetchMock } = mockInferenceApi({ thresholdSave });
  render(<InferencePage />);
  const threshold = await screen.findByLabelText("Threshold");

  fireEvent.change(threshold, { target: { value: "0.723" } });
  fireEvent.blur(threshold);
  fireEvent.click(screen.getByRole("button", { name: "Generate masks" }));
  thresholdSave.resolve(jsonResponse({ error: "Threshold storage failed." }, 500));

  expect(await screen.findByRole("alert")).toHaveTextContent("Threshold storage failed.");
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/inference/generate-masks")).toBe(false);
});

test("invalidates the mask overlay immediately when threshold or source identity changes", async () => {
  const thresholdOverlay = deferred();
  const nextImageOverlay = deferred();
  const { fetchMock } = mockInferenceApi({
    overlayDeferredByUrl: {
      "/api/inference/images/complete-a/overlay?threshold=0.723": thresholdOverlay,
      "/api/inference/images/complete-b/overlay?threshold=0.610": nextImageOverlay,
    },
  });
  render(<InferencePage />);
  const threshold = await screen.findByLabelText("Threshold");
  expect(await screen.findByAltText("Binary mask overlay")).toBeInTheDocument();

  fireEvent.change(threshold, { target: { value: "0.723" } });
  expect(screen.queryByAltText("Binary mask overlay")).not.toBeInTheDocument();
  thresholdOverlay.resolve();
  expect(await screen.findByAltText("Binary mask overlay")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Next complete image" }));
  expect(screen.queryByAltText("Binary mask overlay")).not.toBeInTheDocument();
  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => url === "/api/inference/images/complete-b/overlay?threshold=0.610",
  )).toBe(true));
  nextImageOverlay.resolve();
  expect(await screen.findByAltText("Binary mask overlay")).toBeInTheDocument();
});

test("switches completed sources among original overlay and mask-only views", async () => {
  mockInferenceApi({ images: [baseImages[1]] });

  render(<InferencePage />);

  await screen.findByAltText("Binary mask overlay");
  fireEvent.click(screen.getByRole("button", { name: "Original" }));
  expect(screen.queryByAltText("Binary mask overlay")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Mask" }));
  expect(screen.getByAltText("Binary mask")).toBeInTheDocument();
});

test("resets review and completed-job state when roots reuse the same image id", async () => {
  const sharedImage = [{ id: "complete-a", timestampFolder: "002", imageFile: "reference.tif", status: "complete" }];
  const secondReview = {
    ...reviews["complete-a"],
    threshold: 0.8,
    settings: { threshold: 0.8, roiGroupId: null },
    wholeImage: { areaFraction: 1 },
    groups: [],
    roi: null,
  };
  mockInferenceApi({
    images: sharedImage,
    rootData: {
      "/data/inference": { images: sharedImage, reviews: { "complete-a": reviews["complete-a"] } },
      "/new/root": { images: sharedImage, reviews: { "complete-a": secondReview } },
    },
  });
  render(<InferencePage />);
  await screen.findByDisplayValue("0.500");
  fireEvent.click(screen.getByRole("button", { name: "Run inference" }));
  expect(await screen.findByText(/Inference complete:/)).toBeInTheDocument();

  const rootInput = screen.getByLabelText("Root path");
  fireEvent.change(rootInput, { target: { value: "/new/root" } });
  fireEvent.click(screen.getByRole("button", { name: "Set root" }));

  expect(await screen.findByDisplayValue("0.800")).toBeInTheDocument();
  expect(screen.getByText("100.00%")).toBeInTheDocument();
  expect(screen.queryByText(/Inference complete:/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Saved ROI group")).not.toBeInTheDocument();
});

test("ignores an old-root image-list poll that resolves after a root switch", async () => {
  const oldRootPoll = deferred();
  const oldImages = [{ id: "old-sending", timestampFolder: "001", imageFile: "old.tif", status: "sending" }];
  const newImages = [{ id: "new-complete", timestampFolder: "101", imageFile: "new.tif", status: "complete" }];
  const { fetchMock } = mockInferenceApi({
    images: oldImages,
    imageListDeferredByCall: { 2: oldRootPoll },
    rootData: {
      "/data/inference": { images: oldImages, reviews: {} },
      "/new/root": { images: newImages, reviews: {} },
    },
  });
  render(<InferencePage />);
  expect(await screen.findByText("old.tif")).toBeInTheDocument();
  await waitFor(() => expect(fetchMock.mock.calls.filter(
    ([url]) => url === "/api/inference/images",
  )).toHaveLength(2), { timeout: 1500 });

  const rootInput = screen.getByLabelText("Root path");
  fireEvent.change(rootInput, { target: { value: "/new/root" } });
  fireEvent.click(screen.getByRole("button", { name: "Set root" }));

  expect(await screen.findByText("new.tif")).toBeInTheDocument();
  expect(screen.queryByText("old.tif")).not.toBeInTheDocument();

  await act(async () => {
    oldRootPoll.resolve();
    await oldRootPoll.promise;
    await Promise.resolve();
  });

  expect(screen.getByLabelText("Root path")).toHaveValue("/new/root");
  expect(screen.getByText("new.tif")).toBeInTheDocument();
  expect(screen.queryByText("old.tif")).not.toBeInTheDocument();
});

test("ignores an old-root image-list poll that rejects after a root switch", async () => {
  const oldRootPoll = deferred();
  const oldImages = [{ id: "old-sending", timestampFolder: "001", imageFile: "old.tif", status: "sending" }];
  const newImages = [{ id: "new-complete", timestampFolder: "101", imageFile: "new.tif", status: "complete" }];
  const { fetchMock } = mockInferenceApi({
    images: oldImages,
    imageListDeferredByCall: { 2: oldRootPoll },
    rootData: {
      "/data/inference": { images: oldImages, reviews: {} },
      "/new/root": { images: newImages, reviews: {} },
    },
  });
  render(<InferencePage />);
  expect(await screen.findByText("old.tif")).toBeInTheDocument();
  await waitFor(() => expect(fetchMock.mock.calls.filter(
    ([url]) => url === "/api/inference/images",
  )).toHaveLength(2), { timeout: 1500 });

  const rootInput = screen.getByLabelText("Root path");
  fireEvent.change(rootInput, { target: { value: "/new/root" } });
  fireEvent.click(screen.getByRole("button", { name: "Set root" }));
  expect(await screen.findByText("new.tif")).toBeInTheDocument();

  await act(async () => {
    oldRootPoll.reject(new Error("Old root image list failed."));
    await oldRootPoll.promise.catch(() => {});
    await Promise.resolve();
  });

  expect(screen.getByLabelText("Root path")).toHaveValue("/new/root");
  expect(screen.getByText("new.tif")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("disables root changes while an inference job is active", async () => {
  const jobDeferred = deferred();
  mockInferenceApi({ jobDeferred });
  render(<InferencePage />);
  await screen.findByDisplayValue("0.500");

  fireEvent.click(screen.getByRole("button", { name: "Run inference" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "Run inference" })).toBeDisabled());
  expect(screen.getByLabelText("Root path")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Set root" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Find root" })).toBeDisabled();
  jobDeferred.resolve();
});

test("revokes binary overlay object URLs when the selection changes and on cleanup", async () => {
  mockInferenceApi();
  const { unmount } = render(<InferencePage />);
  await screen.findByDisplayValue("0.500");
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());

  fireEvent.click(screen.getByRole("button", { name: "Next complete image" }));
  await screen.findByDisplayValue("0.610");
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mask-overlay"));
  const revokeCount = URL.revokeObjectURL.mock.calls.length;

  unmount();

  expect(URL.revokeObjectURL.mock.calls.length).toBeGreaterThan(revokeCount);
});
