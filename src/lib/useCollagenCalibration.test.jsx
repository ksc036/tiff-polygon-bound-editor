/* @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { getCollagenDensityModel } from "../../shared/collagenDensity.js";
import { useCollagenCalibration } from "./useCollagenCalibration.js";

const snapshot = (modelId = "high-density", revision = 0) => ({ modelId, revision, model: getCollagenDensityModel(modelId), updatedAt: null });
const response = (payload, ok = true) => ({ ok, json: async () => payload });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("does not calculate with a fallback while settings are unknown", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "Unavailable" }, false)));
  const { result } = renderHook(() => useCollagenCalibration());
  expect(result.current.snapshot).toBeNull();
  await waitFor(() => expect(result.current.error).toBe("Unavailable"));
  expect(result.current.snapshot).toBeNull();
});

test("keeps the last confirmed selection on save failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(snapshot())).mockResolvedValueOnce(response({ error: "Cannot save" }, false)));
  const { result } = renderHook(() => useCollagenCalibration());
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  await act(async () => result.current.setModel("low-density"));
  expect(result.current.snapshot.modelId).toBe("high-density");
  expect(result.current.error).toBe("Cannot save");
});

test("ignores a slow old refresh after a newer save and pins only matching revisions", async () => {
  let finishRefresh;
  const fetchMock = vi.fn().mockResolvedValueOnce(response(snapshot()))
    .mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }))
    .mockResolvedValueOnce(response(snapshot("low-density", 1)))
    .mockResolvedValueOnce(response(snapshot("high-density", 2)));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCollagenCalibration());
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  let pending;
  act(() => { pending = result.current.refresh(); });
  await act(async () => result.current.setModel("low-density"));
  await act(async () => { finishRefresh(response(snapshot())); await pending; });
  expect(result.current.snapshot.modelId).toBe("low-density");
  await act(async () => { await expect(result.current.preflight()).rejects.toThrow(/changed.*retry/i); });
  expect(result.current.snapshot.revision).toBe(2);
});

test("ignores a delayed save response after a newer global revision was confirmed", async () => {
  let finishRefresh;
  let finishSave;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(snapshot()))
    .mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; })));
  const { result } = renderHook(() => useCollagenCalibration());
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  let pendingRefresh;
  let pendingSave;
  act(() => { pendingRefresh = result.current.refresh(); });
  act(() => { pendingSave = result.current.setModel("low-density"); });
  await act(async () => { finishRefresh(response(snapshot("high-density", 2))); await pendingRefresh; });
  await act(async () => { finishSave(response(snapshot("low-density", 1))); await pendingSave; });
  expect(result.current.snapshot).toMatchObject({ modelId: "high-density", revision: 2 });
  expect(result.current.saving).toBe(false);
});
