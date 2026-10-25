import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { writeDatasetZip } from "./exportService.js";

vi.mock("./exportService.js", async (original) => ({
  ...await original(),
  writeDatasetZip: vi.fn(async ({ output }) => output.end("zip-test")),
}));
const servers = [];
const dirs = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});
async function serve(options = {}) {
  const server = createApp(options).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  return async (url, body, method = "PUT") => fetch(`http://127.0.0.1:${server.address().port}${url}`, body === undefined ? {} : {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const endpoint = "/api/settings/collagen-density";

describe("calibration API", () => {
  test("loads, saves and rejects stale selections", async () => {
    const request = await serve();
    const initial = await request(endpoint);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ modelId: "high-density", revision: 0 });
    const changed = await request(endpoint, { modelId: "low-density", revision: 0 });
    expect(await changed.json()).toMatchObject({ modelId: "low-density", revision: 1, model: { k: 1.63 } });
    const stale = await request(endpoint, { modelId: "high-density", revision: 0 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "CALIBRATION_CONFLICT" });
    const invalid = await request(endpoint, { modelId: "x", revision: 1 });
    expect(invalid.status).toBe(400);
  });
  test("returns safe errors for corrupt persisted settings", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "calibration-api-"));
    dirs.push(dataDir);
    await writeFile(path.join(dataDir, "collagen-density-settings.json"), "not json");
    const request = await serve({ dataDir });
    const response = await request(endpoint);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("CALIBRATION_READ_FAILED");
    expect(body).not.toContain(dataDir);
    expect(await readFile(path.join(dataDir, "collagen-density-settings.json"), "utf8")).toBe("not json");
  });
  test("pins the confirmed model on export and rejects a stale revision before streaming", async () => {
    const storage = { getRoot: () => path.resolve("dataset"), scanImages: async () => [], loadBounds: async () => ({ groups: [] }) };
    const request = await serve({ storage });
    await request(endpoint, { modelId: "low-density", revision: 0 });
    const stale = await request("/api/export", { calibrationRevision: 0 }, "POST");
    expect(stale.status).toBe(409);
    expect(writeDatasetZip).not.toHaveBeenCalled();
    const good = await request("/api/export", { calibrationRevision: 1, estimatedCollagenColorMax: 3 }, "POST");
    expect(good.status).toBe(200);
    expect(writeDatasetZip).toHaveBeenCalledWith(expect.objectContaining({
      calibration: expect.objectContaining({ modelId: "low-density", revision: 1, model: expect.objectContaining({ k: 1.63 }) }),
      estimatedCollagenColorMax: 3,
    }));
    const oldCaller = await request("/api/export", {}, "POST");
    expect(oldCaller.status).toBe(200);
  });
  test("a concurrent model change affects the next export, not the one already started", async () => {
    const storage = { getRoot: () => path.resolve("dataset"), loadBounds: async () => ({ groups: [] }) };
    const request = await serve({ storage });
    let notifyStarted;
    let release;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    writeDatasetZip.mockImplementationOnce(async ({ calibration, output }) => {
      notifyStarted();
      await resume;
      output.end(JSON.stringify(calibration));
    });
    const pending = request("/api/export", { calibrationRevision: 0 }, "POST");
    await started;
    try {
      expect((await request(endpoint, { modelId: "low-density", revision: 0 })).status).toBe(200);
    } finally {
      release();
    }
    expect(await (await pending).json()).toMatchObject({ modelId: "high-density", revision: 0 });
    expect(await (await request(endpoint)).json()).toMatchObject({ modelId: "low-density", revision: 1 });
  });
});
