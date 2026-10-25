/* @vitest-environment jsdom */
import { beforeEach, expect, test, vi } from "vitest";
import {
  GROUP_DISPLAY_STORAGE_KEY,
  excludedGroupsForExport,
  groupDisplayScope,
  imageGroupDisplay,
  readGroupDisplayPreferences,
  saveGroupDisplayPreferences,
} from "./groupDisplayPreferences.js";

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

test.each([null, "not json", "[]", "null", '"text"'])("ignores invalid saved preferences: %s", (value) => {
  if (value !== null) localStorage.setItem(GROUP_DISPLAY_STORAGE_KEY, value);
  expect(readGroupDisplayPreferences()).toEqual({});
});

test("retains boolean states only and rejects malformed image scopes", () => {
  const scope = groupDisplayScope("C:/root", "image-a");
  localStorage.setItem(GROUP_DISPLAY_STORAGE_KEY, JSON.stringify({
    [scope]: { draw: { one: false, two: "false", three: true }, stats: [], vector: null },
    invalid: { draw: { one: false } },
    '["root"]': { draw: { one: false } },
  }));
  expect(readGroupDisplayPreferences()).toEqual({
    [scope]: { draw: { one: false, three: true }, stats: {}, vector: {} },
  });
});

test("round trips per-image preferences without confusing path delimiters", () => {
  const preferences = {
    [groupDisplayScope("a/b", "c")]: { draw: { one: false }, stats: {}, vector: {} },
    [groupDisplayScope("a", "b/c")]: { draw: {}, stats: { two: false }, vector: {} },
  };
  expect(saveGroupDisplayPreferences(preferences)).toBe(true);
  const loaded = readGroupDisplayPreferences();
  expect(loaded).toEqual(preferences);
  expect(imageGroupDisplay(loaded, "a/b", "c").draw.one).toBe(false);
  expect(imageGroupDisplay(loaded, "unknown", "c").draw).toEqual({});
});

test("exports only disabled draw or stats groups, not hidden vectors or other roots", () => {
  const preferences = {
    [groupDisplayScope("root-a", "image-a")]: {
      draw: { one: false, two: true }, stats: { one: false, three: false }, vector: { four: false },
    },
    [groupDisplayScope("root-b", "image-a")]: { draw: { other: false }, stats: {}, vector: {} },
  };
  expect(excludedGroupsForExport(preferences, "root-a", [{ id: "image-a" }, { id: "image-b" }]))
    .toEqual({ "image-a": ["one", "three"] });
});

test("handles unavailable browser storage without crashing", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(readGroupDisplayPreferences()).toEqual({});
  expect(saveGroupDisplayPreferences({})).toBe(false);
});
