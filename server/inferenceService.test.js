import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createInferenceService, InferenceError, scanInferenceImages } from "./inferenceService.js";
import { createStorage } from "./storage.js";

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "inference-service-"));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeTiff(filePath, { width = 2, height = 2 } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await sharp(Buffer.alloc(width * height), { raw: { width, height, channels: 1 } })
    .tiff({ compression: "none" })
    .toFile(filePath);
}

function npyFixture({ width, height, values, descr = "<f4", fortranOrder = false }) {
  const header = `{'descr': '${descr}', 'fortran_order': ${fortranOrder ? "True" : "False"}, 'shape': (${height}, ${width}), }`;
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

async function setupService({ fetchImpl = vi.fn(), timestamps = ["T01", "T02"] } = {}) {
  const rootDir = await createTempRoot();
  for (const timestamp of timestamps) {
    await writeTiff(path.join(rootDir, timestamp, "image", "frame.tif"));
  }
  const storage = createStorage({ initialRoot: rootDir });
  const service = createInferenceService({ storage, fetchImpl });
  return { rootDir, storage, service };
}

async function waitForJob(service, id) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const job = service.getJob(id);
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Inference job did not finish.");
}

function imageByTimestamp(images, timestampFolder) {
  const image = images.find((candidate) => candidate.timestampFolder === timestampFolder);
  if (!image) throw new Error(`Missing ${timestampFolder}.`);
  return image;
}

async function writeProbabilityMap(image, values, { width = 2, height = 2 } = {}) {
  await mkdir(image.probabilityMapsDir, { recursive: true });
  await writeFile(image.mapPath, npyFixture({ width, height, values }));
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe("scanInferenceImages", () => {
  test("discovers every sorted TIFF with opaque ids and stem-derived output paths", async () => {
    const rootDir = await createTempRoot();
    await writeTiff(path.join(rootDir, "T10", "image", "z.tiff"));
    await writeTiff(path.join(rootDir, "T02", "image", "b.tif"));
    await writeTiff(path.join(rootDir, "T02", "image", "a.tif"));
    await writeFile(path.join(rootDir, "T02", "image", "ignored.png"), "not a TIFF");

    const images = await scanInferenceImages(rootDir);

    expect(images.map(({ timestampFolder, imageFile }) => [timestampFolder, imageFile])).toEqual([
      ["T02", "a.tif"],
      ["T02", "b.tif"],
      ["T10", "z.tiff"],
    ]);
    expect(images.map((image) => Buffer.from(image.id, "base64url").toString("utf8").startsWith("["))).toEqual([true, true, true]);
    expect(images[0]).toMatchObject({
      probabilityMapsDir: path.join(rootDir, "T02", "probability-maps"),
      mapPath: path.join(rootDir, "T02", "probability-maps", "a.probability.npy"),
      settingsPath: path.join(rootDir, "T02", "probability-maps", "a.mask-setting.json"),
      maskPath: path.join(rootDir, "T02", "mask", "a.png"),
    });
  });
});

describe("createInferenceService", () => {
  test("runs model requests serially and saves validated maps under probability-maps", async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const { service } = await setupService({
      fetchImpl: vi.fn(async () => {
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeRequests -= 1;
        return new Response(npyFixture({ width: 2, height: 2, values: [0, 0.5, 0.75, 1] }));
      }),
    });

    const job = service.startJob({ serverUrl: "http://model:8080" });
    await expect(waitForJob(service, job.id)).resolves.toMatchObject({ status: "complete", completed: 2, failed: 0 });
    const images = await service.listImages();

    expect(maximumActiveRequests).toBe(1);
    expect(images.map((image) => image.status)).toEqual(["complete", "complete"]);
    await expect(Promise.all(images.map((image) => access(image.mapPath)))).resolves.toHaveLength(2);
  });

  test("continues a job after an HTTP failure without saving the failed source", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(npyFixture({ width: 2, height: 2, values: [0, 0, 1, 1] })));
    const { service } = await setupService({ fetchImpl });

    const job = service.startJob({ serverUrl: "http://model:8080" });
    await expect(waitForJob(service, job.id)).resolves.toMatchObject({ status: "partial", completed: 1, failed: 1 });
    const images = await service.listImages();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(images.map((image) => image.status)).toEqual(["failed", "complete"]);
    expect(images[0].message).toBe("Model inference failed.");
    await expect(access(images[0].mapPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects dimension-mismatched model maps and keeps a prior validated map", async () => {
    const { service } = await setupService({
      timestamps: ["T01"],
      fetchImpl: vi.fn(async () => new Response(npyFixture({ width: 3, height: 2, values: [0, 0, 0, 1, 1, 1] }))),
    });
    const [image] = await service.listImages();
    const priorMap = npyFixture({ width: 2, height: 2, values: [0, 0.25, 0.5, 1] });
    await writeProbabilityMap(image, [0, 0.25, 0.5, 1]);

    const job = service.startJob({ serverUrl: "http://model:8080" });
    await expect(waitForJob(service, job.id)).resolves.toMatchObject({ status: "partial", failed: 1 });

    await expect(readFile(image.mapPath)).resolves.toEqual(priorMap);
    expect((await service.listImages())[0]).toMatchObject({ status: "failed", message: "Model probability map dimensions do not match the source image." });
  });

  test("derives complete status from valid persisted maps after a service restart", async () => {
    const { storage, service } = await setupService({
      fetchImpl: vi.fn(async () => new Response(npyFixture({ width: 2, height: 2, values: [0, 0, 1, 1] }))),
    });
    const job = service.startJob({ serverUrl: "http://model:8080" });
    await waitForJob(service, job.id);

    const restartedService = createInferenceService({ storage, fetchImpl: vi.fn() });
    expect((await restartedService.listImages()).map((image) => image.status)).toEqual(["complete", "complete"]);
  });

  test("saves only a local threshold edit after explicit reference propagation", async () => {
    const { service } = await setupService();
    const images = await service.listImages();
    await Promise.all(images.map((image) => writeProbabilityMap(image, [0, 0.5, 0.75, 1])));
    const reference = imageByTimestamp(images, "T01");
    const target = imageByTimestamp(images, "T02");

    await service.saveThreshold(reference.id, { threshold: 0.5 });
    await service.saveThreshold(target.id, { threshold: 0.723 });
    await service.applyReferenceThresholds({ referenceId: reference.id });
    await service.saveThreshold(target.id, { threshold: 0.811 });

    await expect(service.loadReview(target.id)).resolves.toMatchObject({ threshold: 0.811 });
    await expect(service.loadReview(reference.id)).resolves.toMatchObject({ threshold: 0.5 });
  });

  test("uses a matching valid ROI and falls back to whole-image matching for invalid destination bounds", async () => {
    const { storage, service } = await setupService();
    const images = await service.listImages();
    const reference = imageByTimestamp(images, "T01");
    const target = imageByTimestamp(images, "T02");
    await writeProbabilityMap(reference, [1, 0, 0, 0]);
    await writeProbabilityMap(target, [1, 0, 1, 0]);
    await storage.saveBounds("T01", {
      width: 2,
      height: 2,
      groups: [{ id: "roi", name: "ROI", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }],
    });
    await storage.saveBounds("T02", {
      width: 3,
      height: 2,
      groups: [{ id: "roi", name: "ROI", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }],
    });
    await service.saveThreshold(reference.id, { threshold: 0.5, roiGroupId: "roi" });

    await service.applyReferenceThresholds({ referenceId: reference.id, roiGroupId: "roi" });

    const referenceReview = await service.loadReview(reference.id);
    const targetSettings = JSON.parse(await readFile(target.settingsPath, "utf8"));
    expect(referenceReview.roi).toMatchObject({ groupId: "roi", metrics: { areaFraction: 0.25 } });
    expect(targetSettings).toMatchObject({ referenceId: reference.id, targetAreaFraction: 0.25, roiGroupId: null });
    expect(targetSettings.threshold).toBe(0.001);
  });

  test("returns default review settings, optional ROI metrics, and a threshold overlay", async () => {
    const { storage, service } = await setupService({ timestamps: ["T01"] });
    const [image] = await service.listImages();
    await writeProbabilityMap(image, [0, 0.5, 0.75, 1]);
    await storage.saveBounds("T01", {
      width: 2,
      height: 2,
      groups: [{ id: "roi", name: "ROI", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }],
    });

    const review = await service.loadReview(image.id);
    const overlay = await service.createOverlay(image.id, { threshold: 0.75 });

    expect(review).toMatchObject({
      threshold: 0.5,
      width: 2,
      height: 2,
      wholeImage: { areaFraction: 0.75 },
      groups: [{ id: "roi", name: "ROI" }],
    });
    expect(review.roi).toBeNull();
    const metadata = await sharp(overlay).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 2, height: 2 });
    await expect(access(image.settingsPath)).resolves.toBeUndefined();
  });

  test("writes one threshold mask for every complete source without changing probability maps", async () => {
    const { service } = await setupService();
    const images = await service.listImages();
    await Promise.all(images.map((image) => writeProbabilityMap(image, [0, 0.5, 0.75, 1])));
    const before = await Promise.all(images.map((image) => readFile(image.mapPath)));
    await service.saveThreshold(images[0].id, { threshold: 0.75 });

    await expect(service.generateMasks()).resolves.toEqual({ completed: 2, failed: 0 });
    const after = await Promise.all(images.map((image) => readFile(image.mapPath)));
    const firstMask = await sharp(images[0].maskPath).greyscale().raw().toBuffer({ resolveWithObject: true });

    expect(after).toEqual(before);
    expect([...firstMask.data]).toEqual([0, 0, 255, 255]);
    await expect(access(images[1].maskPath)).resolves.toBeUndefined();
  });

  test("rejects malformed threshold requests with a safe service error", async () => {
    const { service } = await setupService({ timestamps: ["T01"] });
    const [image] = await service.listImages();

    await expect(service.saveThreshold(image.id, { threshold: 2 })).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_THRESHOLD", message: "Threshold must be between 0 and 1." }),
    );
    expect(InferenceError).toBeTypeOf("function");
  });
});
