import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import unzipper from "unzipper";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import { FOLDER_PICKER_CODES, FolderPickerError } from "./folderPicker.js";
import { createStorage } from "./storage.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "local-react-express-app-"));
  tempRoots.push(rootDir);
  return rootDir;
}

function uint16Tiff({ width, height, pixels }) {
  const entryCount = 9;
  const ifdOffset = 8;
  const dataOffset = ifdOffset + 2 + entryCount * 12 + 4;
  const buffer = Buffer.alloc(dataOffset + pixels.length * 2);
  let offset = 0;

  buffer.write("II", offset, "ascii");
  offset += 2;
  buffer.writeUInt16LE(42, offset);
  offset += 2;
  buffer.writeUInt32LE(ifdOffset, offset);
  offset = ifdOffset;
  buffer.writeUInt16LE(entryCount, offset);
  offset += 2;

  const writeEntry = (tag, type, count, value) => {
    buffer.writeUInt16LE(tag, offset);
    buffer.writeUInt16LE(type, offset + 2);
    buffer.writeUInt32LE(count, offset + 4);
    if (type === 3 && count === 1) {
      buffer.writeUInt16LE(value, offset + 8);
    } else {
      buffer.writeUInt32LE(value, offset + 8);
    }
    offset += 12;
  };

  writeEntry(256, 4, 1, width);
  writeEntry(257, 4, 1, height);
  writeEntry(258, 3, 1, 16);
  writeEntry(259, 3, 1, 1);
  writeEntry(262, 3, 1, 1);
  writeEntry(273, 4, 1, dataOffset);
  writeEntry(277, 3, 1, 1);
  writeEntry(278, 4, 1, height);
  writeEntry(279, 4, 1, pixels.length * 2);
  buffer.writeUInt32LE(0, offset);

  pixels.forEach((value, index) => buffer.writeUInt16LE(value, dataOffset + index * 2));

  return buffer;
}

async function writeImage(rootDir, folderName, imageName = "frame.tif", pixels = [100, 200, 300, 400]) {
  const imageDir = path.join(rootDir, folderName, "image");
  const maskDir = path.join(rootDir, folderName, "mask");
  await mkdir(imageDir, { recursive: true });
  await mkdir(maskDir, { recursive: true });
  await writeFile(path.join(imageDir, imageName), uint16Tiff({ width: 2, height: 2, pixels }));
}

async function writeSizedImage(rootDir, folderName, { width, height, imageName = "frame.tif" }) {
  const imageDir = path.join(rootDir, folderName, "image");
  const maskDir = path.join(rootDir, folderName, "mask");
  await mkdir(imageDir, { recursive: true });
  await mkdir(maskDir, { recursive: true });
  await writeFile(
    path.join(imageDir, imageName),
    uint16Tiff({ width, height, pixels: Array.from({ length: width * height }, (_value, index) => index) }),
  );
}

async function writeMask(rootDir, folderName, fileName = "frame001.png") {
  const maskDir = path.join(rootDir, folderName, "mask");
  await mkdir(maskDir, { recursive: true });
  await sharp(Buffer.from([0, 255, 0, 0]), { raw: { width: 2, height: 2, channels: 1 } })
    .png()
    .toFile(path.join(maskDir, fileName));
}

async function writeSkeleton(rootDir, folderName) {
  const skeletonDir = path.join(rootDir, folderName, "Skeletonize");
  await mkdir(skeletonDir, { recursive: true });
  await sharp(Buffer.from([0, 0, 255, 0]), { raw: { width: 2, height: 2, channels: 1 } })
    .png()
    .toFile(path.join(skeletonDir, `${folderName}.skeleton.png`));
}

async function writeBounds(rootDir, folderName, bounds) {
  const boundDir = path.join(rootDir, folderName, "bound");
  await mkdir(boundDir, { recursive: true });
  await writeFile(path.join(boundDir, `${folderName}.bounds.json`), `${JSON.stringify(bounds, null, 2)}\n`);
}

function validBounds(folderName, imageFile = "frame001.tif") {
  return {
    schemaVersion: 1,
    imageFolder: folderName,
    imageFile,
    width: 2,
    height: 2,
    groups: [
      {
        id: "cell",
        points: [
          { id: "p1", x: 0, y: 0 },
          { id: "p2", x: 1, y: 0 },
          { id: "p3", x: 1, y: 1 },
        ],
      },
    ],
  };
}

async function request(app, pathname, options = {}) {
  const server = app.listen(0);

  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
    const body = await response.arrayBuffer();

    return new Response(body.byteLength > 0 ? body : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

function jsonRequest(app, pathname, { method = "GET", body } = {}) {
  return request(app, pathname, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function npyFixture({ width, height, values }) {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${height}, ${width}), }`;
  const prefixLength = 10;
  const padding = (16 - ((prefixLength + header.length + 1) % 16)) % 16;
  const encodedHeader = Buffer.from(`${header}${" ".repeat(padding)}\n`, "ascii");
  const prefix = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  const length = Buffer.alloc(2);
  length.writeUInt16LE(encodedHeader.length);
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeFloatLE(value, index * 4));
  return Buffer.concat([prefix, length, encodedHeader, data]);
}

async function waitForInferenceJob(app, jobId) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const response = await request(app, `/api/inference/jobs/${jobId}`);
    if (response.status !== 200) throw new Error(`Inference job lookup failed with ${response.status}.`);
    const { job } = await response.json();
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Inference job did not finish.");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe("createApp", () => {
  test("streams a named ZIP for the active root", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif");
    await writeMask(imageRoot, "T01", "frame001.png");
    await writeBounds(imageRoot, "T01", validBounds("T01", "frame001.tif"));

    const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
      method: "POST",
      body: {
        calibration: { slope: 0.069676956982087, intercept: 0.067893820336777 },
        autoSavedImageId: "T01",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename=".+_export_\d{8}-\d{6}\.zip"; filename\*=UTF-8''.+_export_\d{8}-\d{6}\.zip$/,
    );
    const archive = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
    expect(archive.files.some((file) => file.path.endsWith("/statistics/T01_statistics.xlsx"))).toBe(true);
  });

  test("uses one root snapshot for validation, naming, and ZIP contents", async () => {
    const appRoot = await createTempRoot();
    const firstRoot = await createTempRoot();
    const secondRoot = await createTempRoot();
    await writeImage(firstRoot, "T01", "frame001.tif", [10, 20, 30, 40]);
    await writeImage(secondRoot, "T01", "frame001.tif", [900, 910, 920, 930]);
    const expectedTiff = await readFile(path.join(firstRoot, "T01", "image", "frame001.tif"));
    const storage = createStorage({ initialRoot: firstRoot });
    const getRoot = storage.getRoot;
    storage.getRoot = () => {
      const root = getRoot();
      storage.setRoot(secondRoot);
      return root;
    };

    const response = await jsonRequest(createApp({ rootDir: appRoot, storage }), "/api/export", {
      method: "POST",
      body: {
        calibration: { slope: 0.1, intercept: 0 },
        autoSavedImageId: "T01",
      },
    });

    expect(response.status).toBe(200);
    const archive = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
    const image = archive.files.find((file) => file.path.endsWith("/T01/image/frame001.tif"));
    expect(image).toBeDefined();
    expect(await image.buffer()).toEqual(expectedTiff);
  });

  test("streams exports for a Korean root with ASCII fallback and UTF-8 filename", async () => {
    const appRoot = await createTempRoot();
    const parent = await createTempRoot();
    const imageRoot = path.join(parent, "데이터");
    await mkdir(imageRoot);
    await writeImage(imageRoot, "T01", "frame001.tif");

    const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
      method: "POST",
      body: { calibration: { slope: 0.1, intercept: 0 } },
    });

    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition");
    expect(disposition).toMatch(/^attachment; filename="[ -~]+\.zip"; filename\*=UTF-8''/);
    expect(decodeURIComponent(disposition.match(/filename\*=UTF-8''(.+)$/)?.[1] ?? "")).toMatch(
      /^데이터_export_\d{8}-\d{6}\.zip$/,
    );
    const archive = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
    expect(archive.files.some((file) => file.path.endsWith("/T01/image/frame001.tif"))).toBe(true);
  });

  test.each([
    { slope: 0, intercept: 1 },
    { slope: null, intercept: 1 },
  ])("rejects invalid export calibration before streaming", async (calibration) => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif");
    const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
      method: "POST",
      body: { calibration },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ error: "Invalid export calibration." });
  });

  test("rejects export before streaming when no root is active", async () => {
    const appRoot = await createTempRoot();
    const response = await jsonRequest(createApp({ rootDir: appRoot }), "/api/export", {
      method: "POST",
      body: { calibration: { slope: 0.1, intercept: 0 } },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Storage root has not been set." });
  });

  test("rejects an export auto-save image id that is not an existing image", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif");
    const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
      method: "POST",
      body: {
        calibration: { slope: 0.1, intercept: 0 },
        autoSavedImageId: "",
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Export image id is invalid." });
  });

  test("serves health status", async () => {
    const rootDir = await createTempRoot();
    const response = await request(createApp({ rootDir }), "/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  test("serves built index for the root route when dist is present", async () => {
    const rootDir = await createTempRoot();
    await mkdir(path.join(rootDir, "dist"));
    await writeFile(path.join(rootDir, "dist", "index.html"), "<!doctype html><h1>Built app</h1>");

    const response = await request(createApp({ rootDir }), "/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("Built app");
  });

  test("starts a model job and exposes sending then complete inference rows", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif");
    await writeImage(imageRoot, "T02", "frame002.tif");
    const fetchImpl = vi.fn(async () => new Response(
      npyFixture({ width: 2, height: 2, values: [0, 0.5, 0.75, 1] }),
      { headers: { "content-type": "application/x-npy" } },
    ));
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot, fetchImpl });

    const start = await jsonRequest(app, "/api/inference/jobs", {
      method: "POST",
      body: { serverUrl: "http://model:8080" },
    });

    expect(start.status).toBe(202);
    const job = await waitForInferenceJob(app, (await start.json()).job.id);
    expect(job).toMatchObject({ status: "complete", total: 2, completed: 2, failed: 0 });
    const images = await request(app, "/api/inference/images");
    expect((await images.json()).images.every((image) => image.status === "complete")).toBe(true);
  });

  test("uses the requested review ROI without changing its saved threshold settings", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif");
    const storage = createStorage({ initialRoot: imageRoot });
    await storage.saveBounds("T01", {
      width: 2,
      height: 2,
      groups: [{ id: "roi", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 }, { x: 0, y: 2 }] }],
    });
    const app = createApp({
      rootDir: appRoot,
      storage,
      fetchImpl: vi.fn(async () => new Response(
        npyFixture({ width: 2, height: 2, values: [1, 0, 0, 0] }),
        { headers: { "content-type": "application/x-npy" } },
      )),
    });
    const start = await jsonRequest(app, "/api/inference/jobs", {
      method: "POST",
      body: { serverUrl: "http://model:8080" },
    });
    const job = await waitForInferenceJob(app, (await start.json()).job.id);
    expect(job.status).toBe("complete");
    const { images } = await (await request(app, "/api/inference/images")).json();

    const response = await request(app, `/api/inference/images/${images[0].id}/review?roiGroupId=roi`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settings: { roiGroupId: null },
      roi: { groupId: "roi", metrics: { areaFraction: 0.25 } },
    });
  });

  test("maps null and non-object inference request bodies to stable validation errors", async () => {
    const appRoot = await createTempRoot();
    const app = createApp({ rootDir: appRoot });

    const threshold = await jsonRequest(app, "/api/inference/images/missing/threshold", {
      method: "PUT",
      body: null,
    });
    const reference = await jsonRequest(app, "/api/inference/reference-thresholds", {
      method: "POST",
      body: 1,
    });

    expect(threshold.status).toBe(400);
    await expect(threshold.json()).resolves.toEqual({ error: "Inference threshold is invalid.", code: "INVALID_THRESHOLD" });
    expect(reference.status).toBe(400);
    await expect(reference.json()).resolves.toEqual({ error: "Reference image is invalid.", code: "INVALID_REFERENCE" });
  });

  test("keeps strict JSON parsing for existing editor routes", async () => {
    const appRoot = await createTempRoot();
    const response = await jsonRequest(createApp({ rootDir: appRoot }), "/api/root", {
      method: "POST",
      body: null,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON payload." });
  });

  test("serves the built SPA entry for /inferencePage", async () => {
    const appRoot = await createTempRoot();
    await mkdir(path.join(appRoot, "dist"));
    await writeFile(path.join(appRoot, "dist", "index.html"), "<!doctype html><h1>Built app</h1>");

    const response = await request(createApp({ rootDir: appRoot }), "/inferencePage");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Built app");
  });

  test("sets a typed root and lists scanned images", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T02", "frame002.tif");
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");

    const response = await jsonRequest(createApp({ rootDir: appRoot }), "/api/root", {
      method: "POST",
      body: { rootPath: imageRoot },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rootPath: imageRoot,
      images: [
        { id: "selected-stack-sequence_T01", imageFolder: "selected-stack-sequence_T01", imageFile: "frame001.tif" },
        { id: "selected-stack-sequence_T02", imageFolder: "selected-stack-sequence_T02", imageFile: "frame002.tif" },
      ],
    });
  });

  test("selects root with an injected picker", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");

    const selectedResponse = await jsonRequest(
      createApp({ rootDir: appRoot, selectRoot: async () => imageRoot }),
      "/api/root/select",
      { method: "POST" },
    );

    expect(selectedResponse.status).toBe(200);
    await expect(selectedResponse.json()).resolves.toMatchObject({
      rootPath: imageRoot,
      images: [{ id: "selected-stack-sequence_T01", imageFolder: "selected-stack-sequence_T01", imageFile: "frame001.tif" }],
    });
  });

  test.each([
    [FOLDER_PICKER_CODES.CANCELLED, 400, "Root selection was cancelled."],
    [
      FOLDER_PICKER_CODES.UNAVAILABLE,
      503,
      "Folder picker is unavailable. Enter an absolute path in Root path and press Set root.",
    ],
    [
      FOLDER_PICKER_CODES.FAILED,
      500,
      "Folder picker failed. Enter an absolute path in Root path and press Set root.",
    ],
  ])("maps root picker %s to a safe response", async (code, status, message) => {
    const secretPath = "/private/secret/image-root";
    const app = createApp({
      rootDir: await createTempRoot(),
      selectRoot: async () => {
        throw new FolderPickerError(code, `native failure at ${secretPath}`);
      },
    });

    const response = await jsonRequest(app, "/api/root/select", { method: "POST" });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({ error: message });
    expect(JSON.stringify(body)).not.toContain(secretPath);
  });

  test("reports an invalid selected image root separately from picker failures", async () => {
    const invalidRoot = await createTempRoot();
    const response = await jsonRequest(createApp({
      rootDir: await createTempRoot(),
      selectRoot: async () => invalidRoot,
    }), "/api/root/select", { method: "POST" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Selected folder is not a valid image root." });
  });

  test("POST /api/root invalid path error does not include the submitted absolute path", async () => {
    const appRoot = await createTempRoot();
    const missingRoot = path.join(await createTempRoot(), "missing-root");

    const response = await jsonRequest(createApp({ rootDir: appRoot }), "/api/root", {
      method: "POST",
      body: { rootPath: missingRoot },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Invalid storage root.");
    expect(JSON.stringify(body)).not.toContain(missingRoot);
  });

  test("selects a heatmap folder without changing the image root", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const batchRoot = await createTempRoot();
    await writeImage(imageRoot, "sample-a", "frame001.tif");
    const app = createApp({
      rootDir: appRoot,
      initialRoot: imageRoot,
      selectHeatmapRoot: async () => batchRoot,
    });

    const response = await jsonRequest(app, "/api/heatmaps/select-folder", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rootPath: batchRoot });
    await expect((await request(app, "/api/root")).json()).resolves.toMatchObject({ rootPath: imageRoot });
  });

  test.each([
    [FOLDER_PICKER_CODES.CANCELLED, 400, "Heatmap folder selection was cancelled."],
    [
      FOLDER_PICKER_CODES.UNAVAILABLE,
      503,
      "Heatmap folder picker is unavailable. Enter an absolute path in the Heatmap batch path field.",
    ],
    [
      FOLDER_PICKER_CODES.FAILED,
      500,
      "Heatmap folder picker failed. Enter an absolute path in the Heatmap batch path field.",
    ],
  ])("maps Heatmap picker %s to a safe response", async (code, status, message) => {
    const secretPath = "/private/secret/heatmap-root";
    const app = createApp({
      rootDir: await createTempRoot(),
      selectHeatmapRoot: async () => {
        throw new FolderPickerError(code, `native failure at ${secretPath}`);
      },
    });

    const response = await jsonRequest(app, "/api/heatmaps/select-folder", { method: "POST" });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({ error: message });
    expect(JSON.stringify(body)).not.toContain(secretPath);
  });

  test.each([
    [
      "/api/root/select",
      { selectRoot: async () => { throw new Error("unexpected native failure"); } },
      "Folder picker failed. Enter an absolute path in Root path and press Set root.",
    ],
    [
      "/api/heatmaps/select-folder",
      { selectHeatmapRoot: async () => { throw new Error("unexpected native failure"); } },
      "Heatmap folder picker failed. Enter an absolute path in the Heatmap batch path field.",
    ],
  ])("maps an unknown selection error from %s to a safe 500", async (endpoint, picker, message) => {
    const response = await jsonRequest(
      createApp({ rootDir: await createTempRoot(), ...picker }),
      endpoint,
      { method: "POST" },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: message });
  });

  test("generates requested preset sizes and returns a safe summary", async () => {
    const appRoot = await createTempRoot();
    const batchRoot = await createTempRoot();
    await writeImage(batchRoot, "sample-a", "frame001.tif");
    await writeMask(batchRoot, "sample-a", "frame001.png");

    const response = await jsonRequest(createApp({ rootDir: appRoot }), "/api/heatmaps/generate", {
      method: "POST",
      body: { rootPath: batchRoot, cellSizes: [5, 10, 20] },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ completed: 1, generatedFiles: 3 });
    expect(JSON.stringify(body)).not.toContain(batchRoot);
  });

  test("heatmap generation maps missing and invalid sizes to safe 400 errors", async () => {
    const appRoot = await createTempRoot();
    const batchRoot = await createTempRoot();
    const app = createApp({ rootDir: appRoot });

    for (const body of [{ rootPath: batchRoot }, { rootPath: batchRoot, cellSizes: [0] }]) {
      const response = await jsonRequest(app, "/api/heatmaps/generate", { method: "POST", body });

      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.error).toBe("Heatmap cell sizes must be valid positive integers.");
      expect(JSON.stringify(responseBody)).not.toContain(batchRoot);
    }
  });

  test("loads one saved image heatmap by cell size", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "sample-a", "frame001.tif");
    await writeMask(imageRoot, "sample-a", "frame001.png");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });
    await jsonRequest(app, "/api/heatmaps/generate", {
      method: "POST",
      body: { rootPath: imageRoot, cellSizes: [10] },
    });

    const response = await request(app, "/api/images/sample-a/heatmap?cellSize=10");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ heatmap: { cellWidth: 10 } });
  });

  test("heatmap loading rejects invalid request cell sizes with a safe 400 error", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "sample-a", "frame001.tif");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    for (const query of ["", "0", "2.5", "abc"]) {
      const suffix = query ? `?cellSize=${query}` : "";
      const response = await request(app, `/api/images/sample-a/heatmap${suffix}`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid heatmap cell size." });
    }
  });

  test("heatmap loading ignores file-time changes and maps missing or malformed data to safe statuses", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const folderName = "sample-a";
    await writeImage(imageRoot, folderName, "frame001.tif");
    await writeMask(imageRoot, folderName, "frame001.png");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const missingResponse = await request(app, `/api/images/${folderName}/heatmap?cellSize=10`);
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({ error: "Saved heatmap does not exist." });

    await jsonRequest(app, "/api/heatmaps/generate", {
      method: "POST",
      body: { rootPath: imageRoot, cellSizes: [10] },
    });
    await writeMask(imageRoot, folderName, "frame001.png");
    const copiedResponse = await request(app, `/api/images/${folderName}/heatmap?cellSize=10`);
    expect(copiedResponse.status).toBe(200);
    await expect(copiedResponse.json()).resolves.toMatchObject({ heatmap: { cellWidth: 10 } });

    const savedPath = path.join(imageRoot, folderName, "heatmap", "10x10", `${folderName}.heatmap.json`);
    await writeFile(savedPath, "{ malformed json");
    const malformedResponse = await request(app, `/api/images/${folderName}/heatmap?cellSize=10`);
    expect(malformedResponse.status).toBe(422);
    const malformedBody = await malformedResponse.json();
    expect(malformedBody).toEqual({ error: "Saved heatmap is invalid." });
    expect(JSON.stringify(malformedBody)).not.toContain(imageRoot);
  });

  test("returns saved bounds for reviewing an image", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    const bounds = {
      schemaVersion: 1,
      imageFolder: "selected-stack-sequence_T01",
      imageFile: "frame001.tif",
      width: 10,
      height: 20,
      connectionMode: "manual",
      groups: [{ id: "group-1", points: [{ x: 1, y: 2 }] }],
    };
    await mkdir(path.join(imageRoot, "selected-stack-sequence_T01", "bound"), { recursive: true });
    await writeFile(
      path.join(imageRoot, "selected-stack-sequence_T01", "bound", "selected-stack-sequence_T01.bounds.json"),
      JSON.stringify(bounds),
    );

    const response = await request(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/bounds",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bounds: {
        schemaVersion: 1,
        width: 10,
        height: 20,
        connectionMode: "manual",
        groups: [{ id: "group-1", points: [{ x: 1, y: 2 }] }],
      },
      hasBounds: true,
    });
  });

  test("saves bounds through PUT /api/images/:id/bounds", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    const body = {
      width: 12,
      height: 34,
      connectionMode: "input-order-cycle",
      groups: [{ id: "group-1", points: [{ id: "point-1", x: 3, y: 4 }] }],
    };

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/bounds",
      { method: "PUT", body },
    );

    expect(response.status).toBe(200);
    const { bounds } = await response.json();
    expect(bounds).toMatchObject({
      schemaVersion: 1,
      ...body,
    });
    expect(bounds).not.toHaveProperty("imageFolder");
    expect(bounds).not.toHaveProperty("imageFile");
    expect(Date.parse(bounds.updatedAt)).not.toBeNaN();
  });

  test("PUT bounds rejects invalid groups and points payload without writing malformed JSON", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    const malformedBounds = {
      connectionMode: "input-order-cycle",
      groups: [{ id: 123, points: [{ id: 456, x: Number.NaN, y: "2" }] }],
    };

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/bounds",
      { method: "PUT", body: malformedBounds },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid bounds payload." });
    await expect(
      readFile(path.join(imageRoot, "selected-stack-sequence_T01", "bound", "selected-stack-sequence_T01.bounds.json")),
    ).rejects.toThrow();
  });

  test("PUT bounds rejects invalid width and height without writing malformed JSON", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    const malformedBounds = {
      width: "not-a-number",
      height: { bad: true },
      connectionMode: "input-order-cycle",
      groups: [],
    };

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/bounds",
      { method: "PUT", body: malformedBounds },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid bounds payload." });
    await expect(
      readFile(path.join(imageRoot, "selected-stack-sequence_T01", "bound", "selected-stack-sequence_T01.bounds.json")),
    ).rejects.toThrow();
  });

  test("PUT bounds rejects missing group id without writing malformed JSON", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    const malformedBounds = {
      width: 10,
      height: 20,
      connectionMode: "input-order-cycle",
      groups: [{ name: "missing id", points: [] }],
    };

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/bounds",
      { method: "PUT", body: malformedBounds },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid bounds payload." });
    await expect(
      readFile(path.join(imageRoot, "selected-stack-sequence_T01", "bound", "selected-stack-sequence_T01.bounds.json")),
    ).rejects.toThrow();
  });

  test("PUT bounds rejects missing point id without writing malformed JSON", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    const malformedBounds = {
      width: 10,
      height: 20,
      connectionMode: "input-order-cycle",
      groups: [{ id: "group-1", points: [{ x: 1, y: 2 }] }],
    };

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/bounds",
      { method: "PUT", body: malformedBounds },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid bounds payload." });
    await expect(
      readFile(path.join(imageRoot, "selected-stack-sequence_T01", "bound", "selected-stack-sequence_T01.bounds.json")),
    ).rejects.toThrow();
  });

  test("PUT bounds rejects invalid connection mode without writing malformed JSON", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    const malformedBounds = {
      width: 10,
      height: 20,
      connectionMode: "nearest-neighbor-cycle",
      groups: [],
    };

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/bounds",
      { method: "PUT", body: malformedBounds },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid bounds payload." });
    await expect(
      readFile(path.join(imageRoot, "selected-stack-sequence_T01", "bound", "selected-stack-sequence_T01.bounds.json")),
    ).rejects.toThrow();
  });

  test("imports previous bounds through POST /api/images/:id/bounds/import-previous", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    await writeImage(imageRoot, "selected-stack-sequence_T02", "frame002.tif");
    const previousBounds = {
      schemaVersion: 1,
      imageFolder: "selected-stack-sequence_T01",
      imageFile: "frame001.tif",
      width: 10,
      height: 20,
      connectionMode: "manual",
      groups: [{ id: "previous-group", points: [{ x: 1, y: 2 }] }],
    };
    await mkdir(path.join(imageRoot, "selected-stack-sequence_T01", "bound"), { recursive: true });
    await writeFile(
      path.join(imageRoot, "selected-stack-sequence_T01", "bound", "selected-stack-sequence_T01.bounds.json"),
      JSON.stringify(previousBounds),
    );

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T02/bounds/import-previous",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bounds: {
        schemaVersion: 1,
        width: 10,
        height: 20,
        connectionMode: "manual",
        groups: [{ id: "previous-group", points: [{ x: 1, y: 2 }] }],
        sourceImageFolder: "selected-stack-sequence_T01",
      },
    });
  });

  test("importing corrupt previous bounds returns safe 422 without parser internals", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    await writeImage(imageRoot, "selected-stack-sequence_T02", "frame002.tif");
    await mkdir(path.join(imageRoot, "selected-stack-sequence_T01", "bound"), { recursive: true });
    await writeFile(
      path.join(imageRoot, "selected-stack-sequence_T01", "bound", "selected-stack-sequence_T01.bounds.json"),
      "{ invalid json",
    );

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T02/bounds/import-previous",
      { method: "POST" },
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({ error: "Saved bounds JSON is invalid." });
    expect(JSON.stringify(body)).not.toMatch(/unexpected|position|selected-stack|frame001|var\/folders/i);
  });

  test("returns raw16 TIFF bytes with width height and display range headers", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif", [100, 20, 300, 40]);

    const response = await request(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/raw16",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/octet-stream");
    expect(response.headers.get("x-image-width")).toBe("2");
    expect(response.headers.get("x-image-height")).toBe("2");
    expect(response.headers.get("x-display-min")).toBe("20");
    expect(response.headers.get("x-display-max")).toBe("300");
    expect(response.headers.get("x-pixel-format")).toBe("uint16le");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([...new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)]).toEqual([100, 20, 300, 40]);
  });

  test("GET /api/images/:id/mask-preview returns selected mask as PNG", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const folderName = "selected-stack-sequence_T01";
    await writeImage(imageRoot, folderName, "frame001.tif");
    await writeMask(imageRoot, folderName, "frame001.png");

    const response = await request(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      `/api/images/${folderName}/mask-preview`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-mask-file")).toBe("frame001.png");
    expect(response.headers.get("x-image-width")).toBe("2");
    expect(response.headers.get("x-image-height")).toBe("2");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("GET /api/images/:id/skeleton-preview returns the saved skeleton as a red transparent PNG", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const folderName = "selected-stack-sequence_T01";
    await writeImage(imageRoot, folderName, "frame001.tif");
    await writeMask(imageRoot, folderName, "frame001.png");
    await writeSkeleton(imageRoot, folderName);

    const response = await request(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      `/api/images/${folderName}/skeleton-preview`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-skeleton-file")).toBe(`${folderName}.skeleton.png`);
    expect(response.headers.get("x-image-width")).toBe("2");
    expect(response.headers.get("x-image-height")).toBe("2");

    const decoded = await sharp(Buffer.from(await response.arrayBuffer())).raw().ensureAlpha().toBuffer();
    expect([...decoded]).toEqual([
      0, 0, 0, 0,
      0, 0, 0, 0,
      255, 0, 0, 255,
      0, 0, 0, 0,
    ]);
  });

  test("POST /api/images/:id/roi-overlay renders current bounds and ROI bands as a PNG", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const folderName = "selected-stack-sequence_T01";
    const roiBands = [
      { id: "near", label: "Near", fromPx: 0, toPx: 1 },
      { id: "mid", label: "Mid", fromPx: 1, toPx: 2 },
      { id: "far", label: "Far", fromPx: 2, toPx: 3 },
    ];
    await writeImage(imageRoot, folderName, "frame001.tif");

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      `/api/images/${folderName}/roi-overlay`,
      {
        method: "POST",
        body: {
          bounds: validBounds(folderName),
          roiBands,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-image-width")).toBe("2");
    expect(response.headers.get("x-image-height")).toBe("2");
    const png = sharp(Buffer.from(await response.arrayBuffer()));
    const { data, info } = await png.raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 2, height: 2, channels: 4 });
    expect([...data].some((value) => value > 0)).toBe(true);
  });

  test("GET bounds with corrupt saved JSON returns safe 422 without parser internals", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    await mkdir(path.join(imageRoot, "selected-stack-sequence_T01", "bound"), { recursive: true });
    await writeFile(
      path.join(imageRoot, "selected-stack-sequence_T01", "bound", "selected-stack-sequence_T01.bounds.json"),
      "{ invalid json",
    );

    const response = await request(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/bounds",
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({ error: "Saved bounds JSON is invalid." });
    expect(JSON.stringify(body)).not.toMatch(/unexpected|position|selected-stack|frame001|var\/folders/i);
  });

  test("raw16 corrupt image returns clean 422 without Sharp internals", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const imageDir = path.join(imageRoot, "selected-stack-sequence_T01", "image");
    const maskDir = path.join(imageRoot, "selected-stack-sequence_T01", "mask");
    await mkdir(imageDir, { recursive: true });
    await mkdir(maskDir, { recursive: true });
    await writeFile(path.join(imageDir, "frame001.tif"), "not a tiff");

    const response = await request(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/images/selected-stack-sequence_T01/raw16",
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({ error: "Unable to read image data." });
    expect(JSON.stringify(body)).not.toMatch(/sharp|vips|libvips|frame001|selected-stack|tiff/i);
  });

  test("GET /api/images/:id/analysis returns saved analysis or null state", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "selected-stack-sequence_T01", "frame001.tif");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const missingResponse = await request(app, "/api/images/selected-stack-sequence_T01/analysis");

    expect(missingResponse.status).toBe(200);
    await expect(missingResponse.json()).resolves.toEqual({ analysis: null, hasAnalysis: false });

    const analysis = {
      schemaVersion: 5,
      imageFolder: "selected-stack-sequence_T01",
      imageFile: "frame001.tif",
      boundsFile: "selected-stack-sequence_T01.bounds.json",
      maskSource: { file: "frame001.png", format: "png", width: 2, height: 2, mtimeMs: 1 },
      skeletonFile: "selected-stack-sequence_T01.skeleton.png",
      roiBands: [
        { id: "near", label: "Near", fromPx: 0, toPx: 1 },
        { id: "mid", label: "Mid", fromPx: 1, toPx: 2 },
        { id: "far", label: "Far", fromPx: 2, toPx: 3 },
      ],
      groups: [],
      imageSummary: {},
      warnings: [],
      updatedAt: "2026-07-05T00:00:00.000Z",
    };
    await mkdir(path.join(imageRoot, "selected-stack-sequence_T01", "analysis"), { recursive: true });
    await writeFile(
      path.join(imageRoot, "selected-stack-sequence_T01", "analysis", "selected-stack-sequence_T01.analysis.json"),
      JSON.stringify(analysis),
    );

    const savedResponse = await request(app, "/api/images/selected-stack-sequence_T01/analysis");

    expect(savedResponse.status).toBe(200);
    await expect(savedResponse.json()).resolves.toEqual({
      analysis: {
        schemaVersion: 5,
        boundsFile: "selected-stack-sequence_T01.bounds.json",
        maskSource: { file: "frame001.png", format: "png", width: 2, height: 2, mtimeMs: 1 },
        skeletonFile: "selected-stack-sequence_T01.skeleton.png",
        roiBands: analysis.roiBands,
        groups: [],
        imageSummary: {},
        warnings: [],
        updatedAt: "2026-07-05T00:00:00.000Z",
      },
      hasAnalysis: true,
    });
  });

  test("POST /api/images/:id/analysis/recalculate recalculates and saves analysis", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const folderName = "selected-stack-sequence_T01";
    await writeImage(imageRoot, folderName, "frame001.tif");
    await writeBounds(imageRoot, folderName, validBounds(folderName));
    await writeMask(imageRoot, folderName, "frame001.png");

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      `/api/images/${folderName}/analysis/recalculate`,
      {
        method: "POST",
        body: {
          roiBands: [
            { id: "near", label: "Near", fromPx: 0, toPx: 1 },
            { id: "mid", label: "Mid", fromPx: 1, toPx: 2 },
            { id: "far", label: "Far", fromPx: 2, toPx: 3 },
          ],
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      hasAnalysis: true,
      analysis: {
        maskSource: { file: "frame001.png", format: "png", width: 2, height: 2, mtimeMs: expect.any(Number) },
        skeletonFile: `${folderName}.skeleton.png`,
        groups: [{ groupId: "cell", groupName: null, color: null }],
      },
    });
    await expect(
      readFile(path.join(imageRoot, folderName, "Skeletonize", `${folderName}.skeleton.png`)),
    ).resolves.toBeInstanceOf(Buffer);
    await expect(
      JSON.parse(await readFile(path.join(imageRoot, folderName, "analysis", `${folderName}.analysis.json`), "utf8")),
    ).toEqual(body.analysis);
  });

  test("analysis routes return safe status codes for unknown image and recalculation validation failures", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const folderName = "selected-stack-sequence_T01";
    await writeImage(imageRoot, folderName, "frame001.tif");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const unknownResponse = await request(app, "/api/images/missing_T01/analysis");
    expect(unknownResponse.status).toBe(404);
    await expect(unknownResponse.json()).resolves.toEqual({ error: "Image not found." });

    const missingBoundsResponse = await jsonRequest(app, `/api/images/${folderName}/analysis/recalculate`, {
      method: "POST",
      body: {},
    });
    expect(missingBoundsResponse.status).toBe(409);
    await expect(missingBoundsResponse.json()).resolves.toEqual({ error: "Saved bounds are required before analysis." });

    await writeBounds(imageRoot, folderName, validBounds(folderName));
    const missingMaskResponse = await jsonRequest(app, `/api/images/${folderName}/analysis/recalculate`, {
      method: "POST",
      body: {},
    });
    expect(missingMaskResponse.status).toBe(409);
    await expect(missingMaskResponse.json()).resolves.toEqual({ error: "Mask image is required before analysis." });

    await writeMask(imageRoot, folderName, "frame001.png");
    const invalidBandsResponse = await jsonRequest(app, `/api/images/${folderName}/analysis/recalculate`, {
      method: "POST",
      body: {
        roiBands: [
          { id: "near", label: "Near", fromPx: 0, toPx: 1 },
          { id: "mid", label: "Mid", fromPx: 2, toPx: 3 },
          { id: "far", label: "Far", fromPx: 3, toPx: 4 },
        ],
      },
    });
    expect(invalidBandsResponse.status).toBe(400);
    await expect(invalidBandsResponse.json()).resolves.toEqual({ error: "Invalid ROI bands." });
  });

  test("GET analysis strips stale internal saved fields and returns safe malformed-analysis errors", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const folderName = "selected-stack-sequence_T01";
    await writeImage(imageRoot, folderName, "frame001.tif");
    await mkdir(path.join(imageRoot, folderName, "analysis"), { recursive: true });
    await writeFile(
      path.join(imageRoot, folderName, "analysis", `${folderName}.analysis.json`),
      JSON.stringify({
        schemaVersion: 5,
        imageFolder: folderName,
        imageFile: "frame001.tif",
        boundsFile: `${folderName}.bounds.json`,
        maskSource: {
          file: "frame001.png",
          format: "png",
          width: 2,
          height: 2,
          mtimeMs: 12,
          path: path.join(imageRoot, folderName, "mask", "frame001.png"),
        },
        skeletonFile: `${folderName}.skeleton.png`,
        skeletonPath: path.join(imageRoot, folderName, "Skeletonize", `${folderName}.skeleton.png`),
        roiBands: [
          { id: "near", label: "Near", fromPx: 0, toPx: 1 },
          { id: "mid", label: "Mid", fromPx: 1, toPx: 2 },
          { id: "far", label: "Far", fromPx: 2, toPx: 3 },
        ],
        groups: [{ groupId: "cell", groupName: null, color: null, analysisMode: "outside", migrationVector: null, bands: {}, allBands: {} }],
        imageSummary: {},
        warnings: [],
        updatedAt: "2026-07-05T00:00:00.000Z",
        staleAbsolutePath: imageRoot,
      }),
    );
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const response = await request(app, `/api/images/${folderName}/analysis`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.analysis.maskSource).toEqual({ file: "frame001.png", format: "png", width: 2, height: 2, mtimeMs: 12 });
    expect(JSON.stringify(body)).not.toContain(imageRoot);

    await writeFile(
      path.join(imageRoot, folderName, "analysis", `${folderName}.analysis.json`),
	      JSON.stringify({ schemaVersion: 5, groups: "bad" }),
    );

    const malformedResponse = await request(app, `/api/images/${folderName}/analysis`);

    expect(malformedResponse.status).toBe(422);
    await expect(malformedResponse.json()).resolves.toEqual({ error: "Saved analysis JSON is invalid." });
  });

  test("loads missing subimage state and saves the active image crop", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif", [100, 200, 300, 400]);
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const missing = await jsonRequest(app, "/api/images/T01/subimage");
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({ hasSubimage: false, crop: null });

    const saved = await jsonRequest(app, "/api/images/T01/subimage", {
      method: "PUT",
      body: { crop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody).toMatchObject({ crop: { width: 2, height: 2 } });
    expect(savedBody.crop).not.toHaveProperty("imageFolder");
    expect(savedBody.crop).not.toHaveProperty("imageFile");
  });

  test("returns a safe coded response for invalid or missing subimage crops", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif", [100, 200, 300, 400]);
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const invalid = await jsonRequest(app, "/api/images/T01/subimage", {
      method: "PUT",
      body: { crop: { sourceWidth: 2, sourceHeight: 2, x: 2, y: 0, width: 2, height: 2 } },
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid subimage crop.", code: "INVALID_CROP" });

    const missing = await jsonRequest(app, "/api/images/T01/subimage", { method: "PUT", body: {} });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "Invalid subimage crop.", code: "INVALID_CROP" });
  });

  test("creates missing subimages in sorted folder order", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T03");
    await writeImage(imageRoot, "T01");
    await writeImage(imageRoot, "T02");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const response = await jsonRequest(app, "/api/subimages/create-missing", {
      method: "POST",
      body: { templateCrop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: "create-missing",
      status: "complete",
      code: null,
      created: ["T01", "T02", "T03"],
      preserved: [],
      replaced: [],
      failed: [],
    });
  });

  test("replaces all subimages in sorted folder order", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T03");
    await writeImage(imageRoot, "T01");
    await writeImage(imageRoot, "T02");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const response = await jsonRequest(app, "/api/subimages/replace-all", {
      method: "POST",
      body: { templateCrop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: "replace-all",
      status: "complete",
      code: null,
      created: [],
      preserved: [],
      replaced: ["T01", "T02", "T03"],
      failed: [],
    });
  });

  test("captures a dedicated mutation context for each Subimage write request", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01");
    const storage = createStorage({ initialRoot: imageRoot });
    const context = Object.freeze({
      getRoot: storage.getRoot,
      scanImages: storage.scanImages,
      getImage: storage.getImage,
      imagePaths: storage.imagePaths,
      loadSubimageCrop: storage.loadSubimageCrop,
      saveSubimageCrop: storage.saveSubimageCrop,
    });
    storage.createSubimageMutationContext = vi.fn(() => context);
    const app = createApp({ rootDir: appRoot, storage });

    const save = await jsonRequest(app, "/api/images/T01/subimage", {
      method: "PUT",
      body: { crop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
    });
    const batch = await jsonRequest(app, "/api/subimages/create-missing", {
      method: "POST",
      body: { templateCrop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
    });
    const replacement = await jsonRequest(app, "/api/subimages/replace-all", {
      method: "POST",
      body: { templateCrop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
    });

    expect(save.status).toBe(200);
    expect(batch.status).toBe(200);
    expect(replacement.status).toBe(200);
    expect(storage.createSubimageMutationContext).toHaveBeenCalledTimes(3);
  });

  test("returns safe preflight failures without local paths", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeSizedImage(imageRoot, "T01", { width: 2, height: 2 });
    await writeSizedImage(imageRoot, "T02", { width: 3, height: 3 });

    const response = await jsonRequest(
      createApp({ rootDir: appRoot, initialRoot: imageRoot }),
      "/api/subimages/create-missing",
      {
        method: "POST",
        body: { templateCrop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
      },
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({
      error: "Subimage batch preflight failed.",
      code: "BATCH_PREFLIGHT_FAILED",
      failures: [{ imageFolder: "T02", code: "DIMENSION_MISMATCH", message: "Source dimensions do not match the template." }],
    });
    expect(JSON.stringify(body)).not.toContain(imageRoot);
  });

  test("preserves root scan preflight failures with a null image folder", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });
    await rm(imageRoot, { recursive: true, force: true });

    const response = await jsonRequest(app, "/api/subimages/create-missing", {
      method: "POST",
      body: { templateCrop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "Subimage batch preflight failed.",
      code: "BATCH_PREFLIGHT_FAILED",
      failures: [{ imageFolder: null, code: "BATCH_SCAN_FAILED", message: "Unable to scan source images." }],
    });
  });

  test("returns a stable Subimage-only code for unknown image IDs", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const getUnknown = await jsonRequest(app, "/api/images/missing/subimage");
    expect(getUnknown.status).toBe(404);
    await expect(getUnknown.json()).resolves.toEqual({ error: "Image not found.", code: "IMAGE_NOT_FOUND" });

    const putUnknown = await jsonRequest(app, "/api/images/missing/subimage", {
      method: "PUT",
      body: { crop: { sourceWidth: 2, sourceHeight: 2, x: 0, y: 0, width: 2, height: 2 } },
    });
    expect(putUnknown.status).toBe(404);
    await expect(putUnknown.json()).resolves.toEqual({ error: "Image not found.", code: "IMAGE_NOT_FOUND" });

    const legacyUnknown = await jsonRequest(app, "/api/images/missing");
    expect(legacyUnknown.status).toBe(404);
    await expect(legacyUnknown.json()).resolves.toEqual({ error: "Image not found." });
  });

  test("preserves the existing malformed-JSON response for Subimage batches", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01");
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });

    const malformed = await request(app, "/api/subimages/replace-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "Invalid JSON payload." });
  });
});
