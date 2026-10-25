import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { COLLAGEN_DENSITY_MODEL, COLLAGEN_DENSITY_MODELS, getCollagenDensityModel } from "../shared/collagenDensity.js";

export class CollagenSettingsError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "CollagenSettingsError";
    this.code = code;
    this.status = status;
  }
}

export function assertCalibrationRevision(revision, currentRevision) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new CollagenSettingsError("INVALID_CALIBRATION", "A valid calibration revision is required.", 400);
  }
  if (revision !== currentRevision) {
    throw new CollagenSettingsError("CALIBRATION_CONFLICT", "Collagen calibration changed. Refresh and try again.", 409);
  }
}

function snapshot({ modelId, revision, updatedAt }) {
  return Object.freeze({ modelId, revision, updatedAt, model: getCollagenDensityModel(modelId), models: COLLAGEN_DENSITY_MODELS });
}

export function createCollagenSettingsStore({ dataDir = null, fileSystem = fs } = {}) {
  const settingsPath = dataDir ? path.join(dataDir, "collagen-density-settings.json") : null;
  let memory = { modelId: COLLAGEN_DENSITY_MODEL.id, revision: 0, updatedAt: null };
  let pending = Promise.resolve();

  async function get() {
    if (!settingsPath) return snapshot(memory);
    let contents;
    try {
      contents = await fileSystem.readFile(settingsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return snapshot(memory);
      throw new CollagenSettingsError("CALIBRATION_READ_FAILED", "Unable to read collagen calibration settings.");
    }
    try {
      const stored = JSON.parse(contents);
      if (!stored || stored.schemaVersion !== 1 || typeof stored.modelId !== "string" ||
          !Number.isSafeInteger(stored.revision) || stored.revision < 0 ||
          typeof stored.updatedAt !== "string" || !Number.isFinite(Date.parse(stored.updatedAt))) {
        throw new Error("Invalid saved calibration.");
      }
      return snapshot(stored);
    } catch {
      throw new CollagenSettingsError("CALIBRATION_READ_FAILED", "Saved collagen calibration settings are invalid.");
    }
  }

  async function save(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "modelId" && key !== "revision")) {
      throw new CollagenSettingsError("INVALID_CALIBRATION", "Only modelId and revision can be saved.", 400);
    }
    const { modelId, revision } = input;
    try {
      if (typeof modelId !== "string") throw new Error("Invalid model.");
      getCollagenDensityModel(modelId);
    } catch {
      throw new CollagenSettingsError("INVALID_CALIBRATION", "Choose a valid collagen calibration model.", 400);
    }
    const current = await get();
    assertCalibrationRevision(revision, current.revision);
    if (modelId === current.modelId) return current;
    const next = { schemaVersion: 1, modelId, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    if (settingsPath) {
      const temporary = `${settingsPath}.${randomUUID()}.tmp`;
      try {
        await fileSystem.mkdir(dataDir, { recursive: true });
        await fileSystem.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await fileSystem.rename(temporary, settingsPath);
      } catch {
        throw new CollagenSettingsError("CALIBRATION_SAVE_FAILED", "Unable to save collagen calibration settings.");
      } finally {
        await fileSystem.rm(temporary, { force: true }).catch(() => {});
      }
    }
    memory = next;
    return snapshot(next);
  }

  return {
    get,
    set(input) {
      // One write at a time makes revision checking and replacement one operation.
      const operation = pending.then(() => save(input));
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
