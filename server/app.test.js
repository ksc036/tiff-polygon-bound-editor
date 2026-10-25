import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
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

async function request(app, pathname, options = {}, listenPort = 0) {
  const server = app.listen(listenPort, "127.0.0.1");
  let listening = false;

  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    listening = true;
    const { port } = server.address();
    return await new Promise((resolve, reject) => {
      const clientRequest = httpRequest({
        host: "127.0.0.1",
        port,
        path: pathname,
        method: options.method ?? "GET",
        headers: Object.fromEntries(new Headers(options.headers).entries()),
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : [value]) {
              if (item !== undefined) headers.append(name, item);
            }
          }
          resolve(new Response(body.length > 0 ? body : null, {
            status: response.statusCode,
            statusText: response.statusMessage,
            headers,
          }));
        });
      });
      clientRequest.on("error", reject);
      if (options.body !== undefined && options.body !== null) clientRequest.write(options.body);
      clientRequest.end();
    });
  } finally {
    if (listening) {
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
  test("request helper rejects instead of reaching an IPv4 port occupant", async ({ skip }) => {
    let occupantRequests = 0;
    const occupant = createServer((_request, response) => {
      occupantRequests += 1;
      response.statusCode = 418;
      response.end("occupant");
    });
    let occupantListening = false;

    try {
      await new Promise((resolve, reject) => {
        occupant.once("error", reject);
        occupant.listen(6000, "127.0.0.1", resolve);
      });
      occupantListening = true;

      const rootDir = await createTempRoot();
      await expect(request(createApp({ rootDir }), "/api/health", {}, 6000)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      expect(occupantRequests).toBe(0);
    } catch (error) {
      if (!occupantListening && error?.code === "EADDRINUSE") {
        skip("Port 6000 is already in use on this host.");
      }
      throw error;
    } finally {
      if (occupantListening) {
        await new Promise((resolve, reject) => {
          occupant.close((error) => error ? reject(error) : resolve());
        });
      }
    }
  });

  test("request helper supports a Fetch-forbidden server port", async ({ skip }) => {
    const rootDir = await createTempRoot();
    let response;

    try {
      response = await request(createApp({ rootDir }), "/api/health", {}, 6000);
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        skip("Port 6000 is already in use on this host.");
      }
      throw error;
    }

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

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

  test.each([null, [], "groups", 1, { T01: null }, { T01: "cell" }, { T01: [1] }, { T01: [""] }, { "": [] }])(
    "rejects malformed export group exclusions %j before streaming",
    async (excludedGroupIdsByImage) => {
      const appRoot = await createTempRoot();
      const imageRoot = await createTempRoot();
      await writeImage(imageRoot, "T01");
      const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
        method: "POST",
        body: { rootPath: imageRoot, excludedGroupIdsByImage },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/group.*exclusions/i) });
    },
  );

  test.each([undefined, null, 123, "different-root"])(
    "rejects export exclusions with a nonmatching root %j before streaming",
    async (rootPath) => {
      const appRoot = await createTempRoot();
      const imageRoot = await createTempRoot();
      await writeImage(imageRoot, "T01");
      const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
        method: "POST",
        body: { rootPath, excludedGroupIdsByImage: {} },
      });
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/root/i) });
    },
  );

  test("passes per-image export exclusions to the ZIP using the captured root", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    const nextRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif");
    await writeImage(nextRoot, "T02", "other.tif");
    const bounds = validBounds("T01");
    bounds.groups[0].analysisMode = "inside";
    await writeBounds(imageRoot, "T01", bounds);
    const storage = createStorage({ initialRoot: imageRoot });
    const createSnapshot = storage.createSnapshot;
    storage.createSnapshot = () => {
      const snapshot = createSnapshot();
      storage.setRoot(nextRoot);
      return snapshot;
    };
    const response = await jsonRequest(createApp({ rootDir: appRoot, storage }), "/api/export", {
      method: "POST",
      body: { rootPath: imageRoot, excludedGroupIdsByImage: { T01: ["cell"] } },
    });
    expect(response.status).toBe(200);
    const archive = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
    expect(archive.files.some((file) => file.path.endsWith("/image/frame001.tif"))).toBe(true);
    expect(archive.files.some((file) => file.path.endsWith("_ROI_overview.png"))).toBe(false);
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
  ])("ignores legacy export calibration fields and uses the fixed model", async (calibration) => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif");
    const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
      method: "POST",
      body: { calibration },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
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

  test("accepts an estimated collagen maximum of 10", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "frame001.tif");

    const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
      method: "POST",
      body: { estimatedCollagenColorMax: 10 },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
  });

  test.each([0, 0.09, 10.1, "4", null])(
    "rejects invalid estimated collagen color maximum %j before streaming",
    async (estimatedCollagenColorMax) => {
      const appRoot = await createTempRoot();
      const imageRoot = await createTempRoot();
      await writeImage(imageRoot, "T01", "frame001.tif");

      const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
        method: "POST",
        body: { estimatedCollagenColorMax },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Estimated collagen color max must be between 0.1 and 10 mg/ml.",
      });
    },
  );

  test.each([[], [0], [1.5], [4097], ["30"], null, [1, 2, 3, 4]].map((value) => [value]))(
    "rejects invalid export heatmap sizes %j before streaming",
    async (heatmapCellSizes) => {
      const appRoot = await createTempRoot();
      const imageRoot = await createTempRoot();
      await writeImage(imageRoot, "T01");
      const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
        method: "POST", body: { heatmapCellSizes },
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Choose one to three heatmap cell sizes, each an integer from 1 to 4096 px.",
      });
    },
  );

  test("forwards custom heatmap sizes to ZIP scales and deduplicates equal sizes", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01");
    const response = await jsonRequest(createApp({ rootDir: appRoot, initialRoot: imageRoot }), "/api/export", {
      method: "POST", body: { heatmapCellSizes: [30, 60, 30] },
    });
    expect(response.status).toBe(200);
    const archive = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
    const scales = archive.files.filter((file) => file.path.includes("/scales/comparison_")).map((file) => path.basename(file.path));
    expect(scales).toEqual(["comparison_30x30.png", "comparison_60x60.png"]);
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

  test.each([
    ["/api/root", false],
    ["/api/inference/root", false],
    ["/api/root/select", true],
    ["/api/inference/root/select", true],
  ])("rejects %s root changes while inference is running", async (endpoint, usesPicker) => {
    const appRoot = await createTempRoot();
    const firstRoot = await createTempRoot();
    const secondRoot = await createTempRoot();
    await writeImage(firstRoot, "T01", "frame001.tif");
    await writeImage(secondRoot, "T01", "frame001.tif");
    let releaseRequest;
    const requestGate = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await requestGate;
      return new Response(
        npyFixture({ width: 2, height: 2, values: [0, 0.5, 0.75, 1] }),
        { headers: { "content-type": "application/x-npy" } },
      );
    });
    const app = createApp({
      rootDir: appRoot,
      initialRoot: firstRoot,
      fetchImpl,
      ...(usesPicker ? { selectRoot: async () => secondRoot } : {}),
    });
    const start = await jsonRequest(app, "/api/inference/jobs", {
      method: "POST",
      body: { serverUrl: "http://model:8080" },
    });
    const jobId = (await start.json()).job.id;
    for (let attempts = 0; attempts < 100 && fetchImpl.mock.calls.length === 0; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const rootChange = await jsonRequest(app, endpoint, {
      method: "POST",
      ...(usesPicker ? {} : { body: { rootPath: secondRoot } }),
    });

    expect(rootChange.status).toBe(409);
    await expect(rootChange.json()).resolves.toEqual({
      error: "Inference is already running.",
      code: "JOB_IN_PROGRESS",
    });
    await expect((await request(app, "/api/inference/images")).json()).resolves.toMatchObject({ rootPath: firstRoot });

    releaseRequest();
    await waitForInferenceJob(app, jobId);
  });

  test("returns raw16 bytes for the exact opaque inference image id", async () => {
    const appRoot = await createTempRoot();
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "T01", "a.tif", [10, 20, 30, 40]);
    await writeImage(imageRoot, "T01", "b.tif", [500, 600, 700, 800]);
    const app = createApp({ rootDir: appRoot, initialRoot: imageRoot });
    const listResponse = await request(app, "/api/inference/images");
    const { images } = await listResponse.json();
    const selected = images.find((image) => image.imageFile === "b.tif");

    const response = await request(app, `/api/inference/images/${selected.id}/raw16`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/octet-stream");
    expect(response.headers.get("x-image-width")).toBe("2");
    expect(response.headers.get("x-image-height")).toBe("2");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([...new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)]).toEqual([500, 600, 700, 800]);
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
    await writeFile(path.join(imageRoot, "selected-stack-sequence_T01", "image", "frame001.tif"), "unreadable TIFF");
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
    const { bounds, synchronized, failed } = await response.json();
    expect(synchronized).toEqual([]);
    expect(failed).toEqual([]);
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

  test("apply-all saves linked source groups and appends copies with fresh local IDs", async () => {
    const imageRoot = await createTempRoot();
    for (const id of ["source", "target", "empty"]) await writeImage(imageRoot, id);
    const storage = createStorage({ initialRoot: imageRoot });
    const sourcePath = storage.imagePaths("source").boundsPath;
    await writeBounds(imageRoot, "source", { groups: [{ id: "saved-source", points: [] }] });
    const existing = {
      id: "cell", name: "Existing", color: "#123456", analysisMode: "inside",
      roiLimits: { nearPx: 1, midPx: 2, farPx: 3 }, custom: { keep: true },
      points: [{ id: "p1", x: 0.25, y: 0.75, custom: "keep" }],
    };
    await writeBounds(imageRoot, "target", { width: 2, height: 2, groups: [existing] });
    const bounds = validBounds("source");
    Object.assign(bounds.groups[0], {
      name: "Unsaved", color: "#abcdef", analysisMode: "outside",
      roiLimits: { nearPx: 2, midPx: 4, farPx: 6 },
      migrationVector: { start: { x: 0.125, y: 0.25 }, end: { x: 1.5, y: 1.75 } },
    });
    bounds.groups[0].points[0].x = -0.125;
    bounds.groups.push({ id: "whole", name: "Whole image", analysisMode: "inside", points: [] });
    const response = await jsonRequest(createApp({ rootDir: imageRoot, storage }),
      "/api/images/source/bounds/apply-all", { method: "POST", body: { bounds } });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ bounds: expect.any(Object), added: ["empty", "target"], updated: [], failed: [] });
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual(result.bounds);
    expect(result.bounds.groups).toHaveLength(2);
    expect(new Set(result.bounds.groups.map(({ sharedBoundaryId }) => sharedBoundaryId)).size).toBe(2);
    for (const group of result.bounds.groups) expect(group.sharedBoundaryId).toEqual(expect.any(String));
    const allIds = ["cell", "p1", "p2", "p3", "whole"];
    for (const id of ["target", "empty"]) {
      const saved = await storage.loadBounds(id);
      const offset = id === "target" ? 1 : 0;
      expect(saved).toMatchObject({ width: 2, height: 2, connectionMode: "input-order-cycle" });
      expect(saved.groups).toHaveLength(offset + 2);
      if (offset) expect(saved.groups[0]).toEqual(existing);
      saved.groups.slice(offset).forEach((group, index) => {
        const source = result.bounds.groups[index];
        expect({ ...group, id: source.id, points: group.points.map((point, pointIndex) => ({
          ...point, id: source.points[pointIndex].id,
        })) }).toEqual(source);
        allIds.push(group.id, ...group.points.map((point) => point.id));
      });
    }
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  test("apply-all reports mismatched, unreadable and corrupt targets without changing their bounds", async () => {
    const imageRoot = await createTempRoot();
    for (const id of ["source", "good", "corrupt", "invalid", "unreadable"]) await writeImage(imageRoot, id);
    await writeSizedImage(imageRoot, "mismatch", { width: 3, height: 2 });
    const storage = createStorage({ initialRoot: imageRoot });
    for (const id of ["mismatch", "unreadable", "corrupt", "invalid"]) {
      await writeBounds(imageRoot, id, validBounds(id));
    }
    await writeFile(storage.imagePaths("corrupt").boundsPath, "{broken bounds json");
    await writeFile(storage.imagePaths("invalid").boundsPath, '{"groups":null}');
    await writeFile(storage.imagePaths("unreadable").imagePath, "not a TIFF");
    const before = new Map();
    for (const id of ["mismatch", "unreadable", "corrupt", "invalid"]) {
      before.set(id, await readFile(storage.imagePaths(id).boundsPath, "utf8"));
    }
    const response = await jsonRequest(createApp({ rootDir: imageRoot, storage }),
      "/api/images/source/bounds/apply-all", { method: "POST", body: { bounds: validBounds("source") } });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.added).toEqual(["good"]);
    expect(result.failed).toEqual([
      { imageId: "corrupt", message: expect.stringMatching(/bounds.*json.*invalid/i) },
      { imageId: "invalid", message: expect.stringMatching(/bounds.*invalid/i) },
      { imageId: "mismatch", message: expect.stringMatching(/dimensions.*match/i) },
      { imageId: "unreadable", message: expect.stringMatching(/read.*image/i) },
    ]);
    expect(JSON.stringify(result)).not.toContain(imageRoot);
    for (const [id, contents] of before) {
      expect(await readFile(storage.imagePaths(id).boundsPath, "utf8")).toBe(contents);
    }
    expect(await storage.loadBounds("source")).toEqual(result.bounds);
    expect(result.bounds.groups[0].sharedBoundaryId).toEqual(expect.any(String));
  });

  test("apply-all rejects a request from a browser still viewing a different root", async () => {
    const oldRoot = await createTempRoot();
    const newRoot = await createTempRoot();
    for (const root of [oldRoot, newRoot]) {
      await writeImage(root, "source");
      await writeImage(root, "target");
    }
    const storage = createStorage({ initialRoot: newRoot });
    const response = await jsonRequest(createApp({ rootDir: newRoot, storage }),
      "/api/images/source/bounds/apply-all", { method: "POST", body: { bounds: validBounds("source"), rootPath: oldRoot } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The selected root has changed. Reload the image list before applying boundaries." });
    await expect(readFile(storage.imagePaths("target").boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    undefined, null, [], {}, { groups: null }, { groups: [null] },
    { groups: [{ points: [] }] }, { groups: [{ id: "g", points: [{ x: 1, y: 2 }] }] },
    { groups: [{ id: "g", points: [{ id: "p", x: "1", y: 2 }] }] },
    { groups: [{ id: "g", points: [{ id: "p", x: null, y: 2 }] }] },
    { groups: [{ id: "g", name: 3, points: [] }] },
    { groups: [], width: "2" }, { groups: [], width: -1 }, { groups: [], height: 1.5 },
    { groups: [], connectionMode: "manual" },
  ])("apply-all rejects malformed bounds %# without any writes", async (bounds) => {
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "source");
    await writeImage(imageRoot, "target");
    const storage = createStorage({ initialRoot: imageRoot });
    const response = await jsonRequest(createApp({ rootDir: imageRoot, storage }),
      "/api/images/source/bounds/apply-all", { method: "POST", body: { bounds } });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid bounds payload." });
    for (const id of ["source", "target"]) {
      await expect(readFile(storage.imagePaths(id).boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("apply-all rejects source dimensions inconsistent with the in-memory bounds", async () => {
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "source");
    await writeImage(imageRoot, "target");
    const storage = createStorage({ initialRoot: imageRoot });
    const response = await jsonRequest(createApp({ rootDir: imageRoot, storage }),
      "/api/images/source/bounds/apply-all", {
        method: "POST", body: { bounds: { ...validBounds("source"), width: 3 } },
      });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Source image dimensions do not match the bounds." });
    await expect(readFile(storage.imagePaths("target").boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("apply-all scans fresh images and stays on its starting root during a root switch", async () => {
    const firstRoot = await createTempRoot();
    const secondRoot = await createTempRoot();
    await writeImage(firstRoot, "source");
    await writeImage(secondRoot, "source");
    await writeImage(secondRoot, "target");
    const storage = createStorage({ initialRoot: firstRoot });
    await writeImage(firstRoot, "target");
    const createContext = storage.createBoundaryMutationContext?.bind(storage);
    storage.createBoundaryMutationContext = () => {
      const context = createContext();
      storage.setRoot(secondRoot);
      return context;
    };
    const response = await jsonRequest(createApp({ rootDir: firstRoot, storage }),
      "/api/images/source/bounds/apply-all", { method: "POST", body: { bounds: validBounds("source") } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ bounds: expect.any(Object), added: ["target"], updated: [], failed: [] });
    expect(storage.getRoot()).toBe(secondRoot);
    expect((await createStorage({ initialRoot: firstRoot }).loadBounds("target")).groups).toHaveLength(1);
    await expect(readFile(storage.imagePaths("target").boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("apply-all allows omitted dimensions, leaves empty targets untouched, and validates source IDs", async () => {
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "source");
    await writeImage(imageRoot, "target");
    const storage = createStorage({ initialRoot: imageRoot });
    const app = createApp({ rootDir: imageRoot, storage });
    const emptyResponse = await jsonRequest(app, "/api/images/source/bounds/apply-all", {
      method: "POST", body: { bounds: { groups: [] } },
    });
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toMatchObject({ bounds: { groups: [] }, added: [], updated: [], failed: [] });
    await expect(readFile(storage.imagePaths("target").boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
    const missingResponse = await jsonRequest(app, "/api/images/missing/bounds/apply-all", {
      method: "POST", body: { bounds: validBounds("source") },
    });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: "Image not found." });
    const response = await jsonRequest(app, "/api/images/source/bounds/apply-all", {
      method: "POST", body: { bounds: { groups: validBounds("source").groups } },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ bounds: expect.any(Object), added: ["target"], updated: [], failed: [] });
    expect(await storage.loadBounds("target")).toMatchObject({ width: 2, height: 2 });
  });

  test("overlapping apply-all requests retain distinct additions and recover corrupt saved source bounds", async () => {
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "source");
    await writeImage(imageRoot, "target");
    const storage = createStorage({ initialRoot: imageRoot });
    await writeBounds(imageRoot, "source", {});
    const sourcePath = storage.imagePaths("source").boundsPath;
    await writeFile(sourcePath, "{corrupt source must not be read");
    const legacyGroup = { points: [{ x: 0.5, y: 0.75 }], custom: "preserve legacy" };
    await writeBounds(imageRoot, "target", { groups: [legacyGroup] });
    const app = createApp({ rootDir: imageRoot, storage });
    const responses = await Promise.all(["first", "second"].map((name) => jsonRequest(app,
      "/api/images/source/bounds/apply-all", { method: "POST", body: {
        bounds: { ...validBounds("source"), groups: [{ ...validBounds("source").groups[0], id: name, name }] },
      } })));

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ bounds: expect.any(Object), added: ["target"], updated: [], failed: [] });
    }
    const { groups } = await storage.loadBounds("target");
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual(legacyGroup);
    expect(groups.slice(1).map(({ name }) => name).sort()).toEqual(["first", "second"]);
    const ids = groups.slice(1).flatMap((group) => [group.id, ...group.points.map(({ id }) => id)]);
    expect(new Set(ids).size).toBe(8);
    const savedSource = JSON.parse(await readFile(sourcePath, "utf8"));
    expect(savedSource.groups).toHaveLength(1);
    expect(groups.some((group) => group.sharedBoundaryId === savedSource.groups[0].sharedBoundaryId)).toBe(true);
  });

  test("apply-all rejects unreadable sources before writing any target", async () => {
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "source");
    await writeImage(imageRoot, "target");
    const storage = createStorage({ initialRoot: imageRoot });
    await writeFile(storage.imagePaths("source").imagePath, "not a TIFF");
    const response = await jsonRequest(createApp({ rootDir: imageRoot, storage }),
      "/api/images/source/bounds/apply-all", { method: "POST", body: { bounds: validBounds("source") } });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Unable to read image dimensions." });
    await expect(readFile(storage.imagePaths("target").boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.skipIf(process.platform !== "win32")("apply-all reads TIFF metadata and writes bounds under long Windows paths", async () => {
    const rootDir = await createTempRoot();
    const imageRoot = path.join(rootDir, "nested-".repeat(12), "long-".repeat(18), "dataset");
    await writeImage(imageRoot, "source");
    await writeImage(imageRoot, "target");
    const storage = createStorage({ initialRoot: imageRoot });
    expect(storage.imagePaths("target").imagePath.length).toBeGreaterThan(260);
    const response = await jsonRequest(createApp({ rootDir, storage }),
      "/api/images/source/bounds/apply-all", { method: "POST", body: { bounds: validBounds("source") } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ bounds: expect.any(Object), added: ["target"], updated: [], failed: [] });
    expect((await storage.loadBounds("target")).groups).toHaveLength(1);
  });

  test("reapplying linked groups updates geometry without duplicating or replacing target settings", async () => {
    const imageRoot = await createTempRoot();
    for (const id of ["source", "target"]) await writeImage(imageRoot, id);
    const storage = createStorage({ initialRoot: imageRoot });
    const app = createApp({ rootDir: imageRoot, storage });
    const original = validBounds("source");
    original.groups[0].sharedBoundaryId = "client-cannot-assign-link";
    const first = await jsonRequest(app, "/api/images/source/bounds/apply-all", { method: "POST", body: { bounds: original } });
    const initial = await first.json();
    expect(initial.bounds?.groups[0].sharedBoundaryId).toEqual(expect.any(String));
    expect(initial.bounds.groups[0].sharedBoundaryId).not.toBe("client-cannot-assign-link");
    const target = await storage.loadBounds("target");
    Object.assign(target.groups[0], { name: "Local name", color: "#123456", analysisMode: "inside", enabled: false });
    await storage.saveBounds("target", target);
    const retry = structuredClone(original);
    delete retry.groups[0].sharedBoundaryId;
    retry.groups[0].points[0].x = 0.75;
    const response = await jsonRequest(app, "/api/images/source/bounds/apply-all", { method: "POST", body: { bounds: retry } });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ added: [], updated: ["target"], failed: [] });
    expect(result.bounds.groups[0].sharedBoundaryId).toBe(initial.bounds.groups[0].sharedBoundaryId);
    const saved = await storage.loadBounds("target");
    expect(saved.groups).toHaveLength(1);
    expect(saved.groups[0]).toEqual({
      ...target.groups[0], points: target.groups[0].points.map((point, index) => index === 0 ? { ...point, x: 0.75 } : point),
    });
  });

  test("saving from a linked copy synchronizes only geometry and keeps deletions local", async () => {
    const imageRoot = await createTempRoot();
    for (const id of ["source", "copy", "independent"]) await writeImage(imageRoot, id);
    const storage = createStorage({ initialRoot: imageRoot });
    const app = createApp({ rootDir: imageRoot, storage });
    const source = validBounds("source");
    Object.assign(source.groups[0], {
      sharedBoundaryId: "shared-1", name: "Source local", color: "#123456", enabled: false,
      analysisMode: "inside", roiLimits: { nearPx: 2, midPx: 4, farPx: 6 },
      migrationVector: { start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }, custom: { keep: true },
    });
    const independent = { id: "other", name: "Source local", points: [{ id: "new-point", x: 0, y: 0 }] };
    source.groups.push(independent);
    const copy = validBounds("copy");
    Object.assign(copy.groups[0], { id: "copy-local", sharedBoundaryId: "shared-1", name: "Copy local" });
    await storage.saveBounds("source", source);
    await storage.saveBounds("copy", copy);
    await storage.saveBounds("independent", { groups: [independent] });
    const independentBefore = await readFile(storage.imagePaths("independent").boundsPath, "utf8");
    await writeFile(storage.imagePaths("source").imagePath, "unreadable metadata must not block save");
    delete copy.groups[0].sharedBoundaryId;
    copy.groups[0].name = "Changed only here";
    copy.groups[0].points = [{ id: "new-point", x: 0.5, y: -0.25 }, { id: "another", x: 1.5, y: 1.75 }];
    const response = await jsonRequest(app, "/api/images/copy/bounds", { method: "PUT", body: { ...copy, rootPath: imageRoot } });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ synchronized: ["source"], failed: [] });
    expect(result.bounds.groups[0]).toMatchObject({ id: "copy-local", sharedBoundaryId: "shared-1", name: "Changed only here" });
    let saved = await storage.loadBounds("source");
    expect(saved.groups).toEqual([
      { ...source.groups[0], points: [{ id: "p1", x: 0.5, y: -0.25 }, { id: "p2", x: 1.5, y: 1.75 }] }, independent,
    ]);
    copy.groups[0].points.push({ id: "third", x: 1, y: 0 }, { id: "new-point", x: 0, y: 1 });
    const added = await jsonRequest(app, "/api/images/copy/bounds", { method: "PUT", body: copy });
    expect(added.status).toBe(200);
    saved = await storage.loadBounds("source");
    expect(saved.groups[0].points.map(({ x, y }) => [x, y])).toEqual([[0.5, -0.25], [1.5, 1.75], [1, 0], [0, 1]]);
    const ids = saved.groups.flatMap((group) => [group.id, ...group.points.map(({ id }) => id)]);
    expect(new Set(ids).size).toBe(ids.length);
    const sourceBeforeDelete = await readFile(storage.imagePaths("source").boundsPath, "utf8");
    const deleted = await jsonRequest(app, "/api/images/copy/bounds", { method: "PUT", body: { groups: [] } });
    expect(await deleted.json()).toMatchObject({ bounds: { groups: [] }, synchronized: [], failed: [] });
    expect(await readFile(storage.imagePaths("source").boundsPath, "utf8")).toBe(sourceBeforeDelete);
    expect(await readFile(storage.imagePaths("independent").boundsPath, "utf8")).toBe(independentBefore);
  });

  test("PUT uses stored links rather than client-supplied replacements or forged links", async () => {
    const imageRoot = await createTempRoot();
    for (const id of ["source", "target"]) await writeImage(imageRoot, id);
    const storage = createStorage({ initialRoot: imageRoot });
    const source = { groups: [
      { id: "linked", sharedBoundaryId: "real-link", points: [] },
      { id: "local", points: [] },
    ] };
    await storage.saveBounds("source", source);
    await storage.saveBounds("target", { groups: [
      { id: "target-linked", sharedBoundaryId: "real-link", points: [] },
      { id: "unrelated", sharedBoundaryId: "forged-link", points: [] },
    ] });
    source.groups[0].sharedBoundaryId = "replacement-link";
    source.groups[1].sharedBoundaryId = "forged-link";
    for (const group of source.groups) group.points = [{ id: "p", x: 1, y: 2 }];
    const response = await jsonRequest(createApp({ rootDir: imageRoot, storage }), "/api/images/source/bounds", { method: "PUT", body: source });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.bounds.groups[0].sharedBoundaryId).toBe("real-link");
    expect(result.bounds.groups[1]).not.toHaveProperty("sharedBoundaryId");
    const target = await storage.loadBounds("target");
    expect(target.groups[0].points).toEqual([{ id: expect.any(String), x: 1, y: 2 }]);
    expect(target.groups[1].points).toEqual([]);
  });

  test("PUT reports corrupt linked targets without modifying them or independent images", async () => {
    const imageRoot = await createTempRoot();
    for (const id of ["source", "good", "corrupt", "invalid", "bad-link", "empty"]) await writeImage(imageRoot, id);
    const storage = createStorage({ initialRoot: imageRoot });
    const linked = { groups: [{ id: "local", sharedBoundaryId: "shared-1", points: [] }] };
    for (const id of ["source", "good", "corrupt", "invalid", "bad-link"]) await storage.saveBounds(id, linked);
    const corrupt = new Map([
      ["corrupt", "{broken"], ["invalid", '{"groups":[{"points":null}]}'],
      ["bad-link", '{"groups":[{"sharedBoundaryId":42,"points":[]}]}'],
    ]);
    for (const [id, data] of corrupt) await writeFile(storage.imagePaths(id).boundsPath, data);
    linked.groups[0].points = [{ id: "p", x: 0.5, y: 1.5 }];
    const response = await jsonRequest(createApp({ rootDir: imageRoot, storage }), "/api/images/source/bounds", { method: "PUT", body: linked });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ synchronized: ["good"], failed: [
      { imageId: "bad-link", message: expect.stringMatching(/bounds.*invalid/i) },
      { imageId: "corrupt", message: expect.stringMatching(/bounds.*json.*invalid/i) },
      { imageId: "invalid", message: expect.stringMatching(/bounds.*invalid/i) },
    ] });
    expect(await storage.loadBounds("source")).toEqual(result.bounds);
    for (const [id, data] of corrupt) expect(await readFile(storage.imagePaths(id).boundsPath, "utf8")).toBe(data);
    await expect(readFile(storage.imagePaths("empty").boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await storage.loadBounds("good")).groups[0].points).toMatchObject([{ x: 0.5, y: 1.5 }]);
  });

  test.each([null, 7, {}, [], "", "   "])("bounds routes reject invalid sharedBoundaryId %j before writes", async (sharedBoundaryId) => {
    const imageRoot = await createTempRoot();
    await writeImage(imageRoot, "source");
    const storage = createStorage({ initialRoot: imageRoot });
    const app = createApp({ rootDir: imageRoot, storage });
    const bounds = { groups: [{ id: "local", sharedBoundaryId, points: [] }] };
    for (const [suffix, method, body] of [["", "PUT", bounds], ["/apply-all", "POST", { bounds }]]) {
      const response = await jsonRequest(app, `/api/images/source/bounds${suffix}`, { method, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid bounds payload." });
    }
    await expect(readFile(storage.imagePaths("source").boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("PUT rejects stale rootPath without writing and captures its root before awaiting", async () => {
    const firstRoot = await createTempRoot();
    const secondRoot = await createTempRoot();
    for (const root of [firstRoot, secondRoot]) {
      for (const id of ["source", "target"]) await writeImage(root, id);
    }
    const storage = createStorage({ initialRoot: firstRoot });
    const linked = { groups: [{ id: "local", sharedBoundaryId: "shared-1", points: [] }] };
    await storage.saveBounds("source", linked);
    await storage.saveBounds("target", linked);
    const app = createApp({ rootDir: firstRoot, storage });
    const rejected = await jsonRequest(app, "/api/images/source/bounds", { method: "PUT", body: { ...linked, rootPath: secondRoot } });
    expect(rejected.status).toBe(409);
    expect((await storage.loadBounds("source")).groups[0].points).toEqual([]);
    const createContext = storage.createBoundaryMutationContext.bind(storage);
    storage.createBoundaryMutationContext = () => {
      const context = createContext();
      storage.setRoot(secondRoot);
      return context;
    };
    linked.groups[0].points = [{ id: "p", x: 1, y: 2 }];
    const response = await jsonRequest(app, "/api/images/source/bounds", { method: "PUT", body: { ...linked, rootPath: firstRoot } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ synchronized: ["target"], failed: [] });
    expect((await createStorage({ initialRoot: firstRoot }).loadBounds("target")).groups[0].points).toMatchObject([{ x: 1, y: 2 }]);
    for (const id of ["source", "target"]) await expect(readFile(storage.imagePaths(id).boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
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
