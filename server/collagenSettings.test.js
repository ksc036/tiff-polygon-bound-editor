import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { createCollagenSettingsStore } from "./collagenSettings.js";

const directories = [];
async function directory() {
  const result = await fs.mkdtemp(path.join(tmpdir(), "collagen-settings-"));
  directories.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("global collagen settings", () => {
  test("defaults High and persists a revisioned Low selection independently from root settings", async () => {
    const dataDir = await directory();
    await fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ rootPath: "original-root" }));
    const store = createCollagenSettingsStore({ dataDir });
    expect(await store.get()).toMatchObject({ modelId: "high-density", revision: 0 });
    const low = await store.set({ modelId: "low-density", revision: 0 });
    expect(low).toMatchObject({ modelId: "low-density", revision: 1, model: { k: 1.63 } });
    expect(await createCollagenSettingsStore({ dataDir }).get()).toEqual(low);
    expect(JSON.parse(await fs.readFile(path.join(dataDir, "collagen-density-settings.json"), "utf8")).schemaVersion).toBe(1);
    expect(JSON.parse(await fs.readFile(path.join(dataDir, "settings.json"), "utf8"))).toEqual({ rootPath: "original-root" });
    await fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ rootPath: "changed-root" }));
    expect((await store.get()).modelId).toBe("low-density");
  });
  test("rejects unknown IDs and malformed or stale revisions", async () => {
    const store = createCollagenSettingsStore();
    await expect(store.set({ modelId: "unknown", revision: 0 })).rejects.toMatchObject({ code: "INVALID_CALIBRATION", status: 400 });
    await expect(store.set({ modelId: "low-density", revision: 0, amplitude: -99 })).rejects.toMatchObject({ code: "INVALID_CALIBRATION", status: 400 });
    await expect(store.set(null)).rejects.toMatchObject({ code: "INVALID_CALIBRATION", status: 400 });
    for (const revision of [undefined, null, "0", -1, 0.5]) {
      await expect(store.set({ modelId: "low-density", revision })).rejects.toMatchObject({ status: 400 });
    }
    await store.set({ modelId: "low-density", revision: 0 });
    await expect(store.set({ modelId: "high-density", revision: 0 })).rejects.toMatchObject({ code: "CALIBRATION_CONFLICT", status: 409 });
    expect((await store.get()).modelId).toBe("low-density");
  });
  test("serializes simultaneous saves and leaves one confirmed winner", async () => {
    const store = createCollagenSettingsStore({ dataDir: await directory() });
    const saves = await Promise.allSettled([
      store.set({ modelId: "low-density", revision: 0 }),
      store.set({ modelId: "high-density", revision: 0 }),
    ]);
    expect(saves[0].status).toBe("fulfilled");
    expect(saves[1]).toMatchObject({ status: "rejected", reason: { code: "CALIBRATION_CONFLICT" } });
    expect((await store.get()).revision).toBe(1);
  });
  test("never falls back silently when saved settings are corrupt", async () => {
    const dataDir = await directory();
    const store = createCollagenSettingsStore({ dataDir });
    for (const payload of ["{", "null", '{"modelId":"unknown","revision":1}', '{"modelId":"low-density","revision":-1}']) {
      await fs.writeFile(path.join(dataDir, "collagen-density-settings.json"), payload);
      await expect(store.get()).rejects.toMatchObject({ code: "CALIBRATION_READ_FAILED", status: 500 });
      await expect(store.set({ modelId: "high-density", revision: 0 })).rejects.toMatchObject({ code: "CALIBRATION_READ_FAILED" });
    }
  });
  test("failed atomic replacement retains the last persisted value and removes temporary files", async () => {
    const dataDir = await directory();
    await createCollagenSettingsStore({ dataDir }).set({ modelId: "low-density", revision: 0 });
    const store = createCollagenSettingsStore({ dataDir, fileSystem: { ...fs, rename: async () => { throw new Error("private host path"); } } });
    await expect(store.set({ modelId: "high-density", revision: 1 })).rejects.toMatchObject({ code: "CALIBRATION_SAVE_FAILED", status: 500 });
    expect((await store.get()).modelId).toBe("low-density");
    expect(await fs.readdir(dataDir)).toEqual(["collagen-density-settings.json"]);
  });
  test("rejects invalid persisted model IDs even when every other field is valid", async () => {
    const dataDir = await directory();
    const store = createCollagenSettingsStore({ dataDir });
    for (const modelId of [undefined, null, { id: "low-density" }, [], "unknown"]) {
      await fs.writeFile(path.join(dataDir, "collagen-density-settings.json"), JSON.stringify({
        schemaVersion: 1, modelId, revision: 1, updatedAt: "2026-10-24T00:00:00Z",
      }));
      await expect(store.get()).rejects.toMatchObject({ code: "CALIBRATION_READ_FAILED" });
    }
  });
});
