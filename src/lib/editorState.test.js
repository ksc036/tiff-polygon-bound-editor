import { describe, expect, test } from "vitest";

import {
  addGroup,
  addPoint,
  clampBoundsToImage,
  createEmptyBounds,
  deleteNearestPoint,
  movePointOrder,
  movePoint,
  moveNearestPoint,
  clearGroupMigrationVector,
  setGroupAnalysisMode,
  setGroupToFullImageInside,
  setGroupMigrationVector,
} from "./editorState.js";

describe("editor state", () => {
  test("does not reuse a reserved saved or discarded group ID", () => {
    const bounds = createEmptyBounds({ width: 100, height: 80 });
    const next = addGroup(bounds, ["group-1", "group-2", "imported-id"]);
    expect(next.groups[0].id).toBe("group-3");
  });

  test("chooses an unused color even when existing groups have imported IDs", () => {
    const bounds = {
      ...createEmptyBounds({ width: 100, height: 80 }),
      groups: [
        { id: "imported-a", color: "#E11D48", points: [] },
        { id: "imported-b", color: "#2563eb", points: [] },
      ],
    };
    const updated = addGroup(bounds);
    expect(updated.groups.at(-1).color).not.toBe("#e11d48");
    expect(updated.groups.at(-1).color).not.toBe("#2563eb");
    expect(updated.groups.slice(0, 2)).toEqual(bounds.groups);
  });

  test("uses distinct colors for the first ten groups", () => {
    let bounds = createEmptyBounds({ width: 100, height: 80 });
    for (let i = 0; i < 10; i += 1) bounds = addGroup(bounds);
    expect(new Set(bounds.groups.map((group) => group.color)).size).toBe(10);
  });

  test("reuses the least-used palette colors only after every color is assigned", () => {
    let bounds = createEmptyBounds({ width: 100, height: 80 });
    for (let i = 0; i < 21; i += 1) bounds = addGroup(bounds);
    const counts = Object.values(bounds.groups.reduce((acc, group) => {
      acc[group.color] = (acc[group.color] ?? 0) + 1;
      return acc;
    }, {}));
    expect(counts.length).toBeGreaterThanOrEqual(10);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  test("adds a point to the active group", () => {
    const bounds = addGroup(
      createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 100,
        height: 80,
      }),
    );

    const updated = addPoint(bounds, "group-1", { x: 12.5, y: 19.25 });

    expect(updated.groups[0].points).toEqual([
      { id: "point-1", x: 12.5, y: 19.25 },
    ]);
    expect(bounds.groups[0].points).toEqual([]);
  });

  test("does not add a point at an existing exact coordinate in the same group", () => {
    const bounds = addPoint(
      addGroup(
        createEmptyBounds({
          folder: "sample-folder",
          file: "image.png",
          width: 100,
          height: 80,
        }),
      ),
      "group-1",
      { x: 12.5, y: 19.25 },
    );

    const updated = addPoint(bounds, "group-1", { x: 12.5, y: 19.25 });

    expect(updated).toBe(bounds);
    expect(updated.groups[0].points).toEqual([
      { id: "point-1", x: 12.5, y: 19.25 },
    ]);
  });

  test("creates groups with explicit outside analysis mode and can switch modes", () => {
    const bounds = addGroup(
      createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 100,
        height: 80,
      }),
    );

    expect(bounds.groups[0].analysisMode).toBe("outside");

    const inside = setGroupAnalysisMode(bounds, "group-1", "inside");
    expect(inside.groups[0].analysisMode).toBe("inside");
    expect(bounds.groups[0].analysisMode).toBe("outside");

    const unchanged = setGroupAnalysisMode(bounds, "group-1", "invalid");
    expect(unchanged).toBe(bounds);
  });

  test("sets a group to full image inside bounds", () => {
    const bounds = addPoint(
      addGroup(
        createEmptyBounds({
          folder: "sample-folder",
          file: "image.png",
          width: 100,
          height: 80,
        }),
      ),
      "group-1",
      { x: 12.5, y: 19.25 },
    );

    const updated = setGroupToFullImageInside(bounds, "group-1", { width: 100, height: 80 });

    expect(updated.groups[0]).toMatchObject({
      analysisMode: "inside",
      points: [
        { id: "point-1", x: 0, y: 0 },
        { id: "point-2", x: 99, y: 0 },
        { id: "point-3", x: 99, y: 79 },
        { id: "point-4", x: 0, y: 79 },
      ],
    });
    expect(bounds.groups[0].points).toEqual([{ id: "point-1", x: 12.5, y: 19.25 }]);
  });

  test("sets clears and clamps group migration vectors", () => {
    const bounds = addGroup(
      createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 100,
        height: 80,
      }),
    );

    const withVector = setGroupMigrationVector(bounds, "group-1", {
      start: { x: -10, y: 20 },
      end: { x: 120, y: 90 },
    });

    expect(withVector.groups[0].migrationVector).toEqual({
      start: { x: -10, y: 20 },
      end: { x: 120, y: 90 },
    });
    expect(bounds.groups[0].migrationVector).toBeNull();

    const clamped = clampBoundsToImage(withVector, 100, 80);
    expect(clamped.groups[0].migrationVector).toEqual({
      start: { x: 0, y: 20 },
      end: { x: 99, y: 79 },
    });

    const cleared = clearGroupMigrationVector(clamped, "group-1");
    expect(cleared.groups[0].migrationVector).toBeNull();
  });

  test("inserts a point at an explicit ordered position", () => {
    const bounds = {
      ...createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 100,
        height: 80,
      }),
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          color: "#e11d48",
          points: [
            { id: "point-1", x: 0, y: 0 },
            { id: "point-2", x: 10, y: 0 },
          ],
        },
      ],
    };

    const updated = addPoint(bounds, "group-1", { x: 5, y: 0 }, { insertIndex: 1 });

    expect(updated.groups[0].points).toEqual([
      { id: "point-1", x: 0, y: 0 },
      { id: "point-3", x: 5, y: 0 },
      { id: "point-2", x: 10, y: 0 },
    ]);
  });

  test("moves point order left and right without changing coordinates", () => {
    const bounds = {
      ...createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 100,
        height: 80,
      }),
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          color: "#e11d48",
          points: [
            { id: "point-1", x: 0, y: 0 },
            { id: "point-2", x: 10, y: 0 },
            { id: "point-3", x: 10, y: 10 },
          ],
        },
      ],
    };

    const movedLeft = movePointOrder(bounds, "group-1", "point-3", "left");
    expect(movedLeft.groups[0].points.map((point) => point.id)).toEqual([
      "point-1",
      "point-3",
      "point-2",
    ]);

    const movedRight = movePointOrder(movedLeft, "group-1", "point-3", "right");
    expect(movedRight.groups[0].points).toEqual(bounds.groups[0].points);

    expect(movePointOrder(bounds, "group-1", "point-1", "left")).toBe(bounds);
    expect(movePointOrder(bounds, "group-1", "point-3", "right")).toBe(bounds);
  });

  test("deletes the nearest point from the active group", () => {
    const bounds = {
      ...createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 100,
        height: 80,
      }),
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          color: "#e11d48",
          points: [
            { id: "point-1", x: 2, y: 2 },
            { id: "point-2", x: 8, y: 2 },
          ],
        },
      ],
    };

    const updated = deleteNearestPoint(bounds, "group-1", { x: 7, y: 2 });

    expect(updated.groups[0].points).toEqual([{ id: "point-1", x: 2, y: 2 }]);
    expect(bounds.groups[0].points).toHaveLength(2);
  });

  test("moves the nearest point to the pointer", () => {
    const bounds = {
      ...createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 100,
        height: 80,
      }),
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          color: "#e11d48",
          points: [
            { id: "point-1", x: 2, y: 2 },
            { id: "point-2", x: 8, y: 2 },
          ],
        },
      ],
    };

    const updated = moveNearestPoint(bounds, "group-1", { x: 7.75, y: 3.5 });

    expect(updated.groups[0].points).toEqual([
      { id: "point-1", x: 2, y: 2 },
      { id: "point-2", x: 7.75, y: 3.5 },
    ]);
    expect(bounds.groups[0].points[1]).toEqual({ id: "point-2", x: 8, y: 2 });
  });

  test("moves a known point without switching targets during drag", () => {
    const bounds = {
      ...createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 100,
        height: 80,
      }),
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          color: "#e11d48",
          points: [
            { id: "point-1", x: 0, y: 0 },
            { id: "point-2", x: 10, y: 0 },
          ],
        },
      ],
    };

    const movedOnce = movePoint(bounds, "group-1", "point-1", { x: 9, y: 0 });
    const movedAgain = movePoint(movedOnce, "group-1", "point-1", { x: 11, y: 0 });

    expect(movedAgain.groups[0].points).toEqual([
      { id: "point-1", x: 11, y: 0 },
      { id: "point-2", x: 10, y: 0 },
    ]);
  });

  test("leaves state unchanged for missing move targets", () => {
    const bounds = {
      ...createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 100,
        height: 80,
      }),
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          color: "#e11d48",
          points: [{ id: "point-1", x: 2, y: 2 }],
        },
      ],
    };

    expect(moveNearestPoint(bounds, "group-1", null)).toBe(bounds);
    expect(movePoint(bounds, "missing", "point-1", { x: 5, y: 5 })).toBe(bounds);
    expect(movePoint(bounds, "group-1", "missing", { x: 5, y: 5 })).toBe(bounds);
    expect(movePoint(bounds, "group-1", "point-1", null)).toBe(bounds);
  });

  test("clamps imported points into image bounds", () => {
    const bounds = {
      ...createEmptyBounds({
        folder: "sample-folder",
        file: "image.png",
        width: 10,
        height: 5,
      }),
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          color: "#e11d48",
          points: [
            { id: "point-1", x: -3, y: 10 },
            { id: "point-2", x: 12.5, y: -1.25 },
          ],
        },
      ],
    };

    const updated = clampBoundsToImage(bounds, 10, 5);

    expect(updated.groups[0].points).toEqual([
      { id: "point-1", x: 0, y: 4 },
      { id: "point-2", x: 9, y: 0 },
    ]);
    expect(bounds.groups[0].points[0]).toEqual({ id: "point-1", x: -3, y: 10 });
  });
});
