import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, test } from "vitest";
import * as boundaryService from "./boundaryBatchService.js";
import { createStorage } from "./storage.js";

const roots = [];

async function dataset() {
  const root = await mkdtemp(path.join(tmpdir(), "linked-boundaries-"));
  roots.push(root);
  for (const id of ["source", "target", "third"]) {
    const imageDir = path.join(root, id, "image");
    await mkdir(imageDir, { recursive: true });
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).tiff().toFile(path.join(imageDir, "frame.tif"));
  }
  return createStorage({ initialRoot: root });
}

function bounds(id, x, sharedBoundaryId) {
  return { width: 2, height: 2, groups: [{
    id, ...(sharedBoundaryId ? { sharedBoundaryId } : {}), points: [{ id: `${id}-point`, x, y: 0 }],
  }] };
}

function deferred() {
  let resolve;
  const promise = new Promise((release) => { resolve = release; });
  return { promise, resolve };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("concurrent apply calls for the same source group share one persisted link", async () => {
  const storage = await dataset();
  const [first, second] = await Promise.all([
    boundaryService.applyBoundsToAll(storage, "source", bounds("local", 0)),
    boundaryService.applyBoundsToAll(storage, "source", bounds("local", 1)),
  ]);
  expect(first).toMatchObject({ added: ["target", "third"], updated: [], failed: [] });
  expect(second).toMatchObject({ added: [], updated: ["target", "third"], failed: [] });
  expect(second.bounds.groups[0].sharedBoundaryId).toBe(first.bounds.groups[0].sharedBoundaryId);
  for (const id of ["source", "target", "third"]) {
    const saved = await storage.loadBounds(id);
    expect(saved.groups).toHaveLength(1);
    expect(saved.groups[0].points).toMatchObject([{ x: 1, y: 0 }]);
  }
});

test.each(["save", "apply"])("whole linked operations serialize against a concurrent %s across storage instances", async (operation) => {
  expect(boundaryService.saveBoundsAndSynchronize).toBeTypeOf("function");
  const storage = await dataset();
  for (const id of ["source", "target", "third"]) await storage.saveBounds(id, bounds(id, 0, "shared"));
  const rootAlias = process.platform === "win32" ? path.toNamespacedPath(storage.getRoot()) : storage.getRoot();
  const secondStorage = createStorage({ initialRoot: rootAlias });
  const started = deferred();
  const gate = deferred();
  const createContext = storage.createBoundaryMutationContext.bind(storage);
  storage.createBoundaryMutationContext = () => {
    const context = createContext();
    return { ...context, saveBounds: async (...args) => {
      const saved = await context.saveBounds(...args);
      started.resolve();
      await gate.promise;
      return saved;
    } };
  };
  const first = boundaryService.saveBoundsAndSynchronize(storage, "source", bounds("source", 1, "shared"));
  await started.promise;
  let secondFinished = false;
  const second = (operation === "apply"
    ? boundaryService.applyBoundsToAll(secondStorage, "target", bounds("target", 2, "shared"))
    : boundaryService.saveBoundsAndSynchronize(secondStorage, "target", bounds("target", 2, "shared")))
    .finally(() => { secondFinished = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondFinished).toBe(false);
    expect((await storage.loadBounds("target")).groups[0].points[0].x).toBe(0);
  } finally {
    gate.resolve();
    await Promise.all([first, second]);
  }
  for (const id of ["source", "target", "third"]) {
    expect((await storage.loadBounds(id)).groups[0].points).toMatchObject([{ x: 2, y: 0 }]);
  }
});

test("a source write failure leaves all targets untouched and releases the operation queue", async () => {
  const storage = await dataset();
  const { boundDir, boundsPath } = storage.imagePaths("source");
  await mkdir(boundDir);
  await mkdir(boundsPath);
  await expect(boundaryService.applyBoundsToAll(storage, "source", bounds("local", 0))).rejects.toThrow();
  for (const id of ["target", "third"]) {
    await expect(readFile(storage.imagePaths(id).boundsPath)).rejects.toMatchObject({ code: "ENOENT" });
  }
  await rm(boundsPath, { recursive: true });
  const result = await boundaryService.applyBoundsToAll(storage, "source", bounds("local", 1));
  expect(result).toMatchObject({ added: ["target", "third"], failed: [] });
});

test("apply retries append missing links but preserve legacy lookalikes and existing linked identities", async () => {
  const storage = await dataset();
  await storage.saveBounds("source", { width: 2, height: 2, groups: [
    ...bounds("one", 0, "link-one").groups, ...bounds("two", 1, "link-two").groups,
  ] });
  await storage.saveBounds("target", { groups: [
    ...bounds("target-local", 0, "link-one").groups, ...bounds("legacy-lookalike", 1).groups,
  ] });
  const { bounds: saved, ...result } = await boundaryService.applyBoundsToAll(storage, "source", await storage.loadBounds("source"));
  expect(result).toEqual({ added: ["target", "third"], updated: ["target"], failed: [] });
  const target = await storage.loadBounds("target");
  expect(target.groups).toHaveLength(3);
  expect(target.groups[0]).toEqual(bounds("target-local", 0, "link-one").groups[0]);
  expect(target.groups[1]).toEqual(bounds("legacy-lookalike", 1).groups[0]);
  expect(target.groups[2].sharedBoundaryId).toBe(saved.groups[1].sharedBoundaryId);
});

test.each([
  { width: "invalid", groups: [] },
  { connectionMode: "invalid", groups: [] },
  { groups: [{ id: 7, points: [] }] },
  { groups: [{ name: {}, points: [] }] },
  { groups: [{ color: [], points: [] }] },
  { groups: [{ points: [{ id: {}, x: 1, y: 2 }] }] },
])("linked operations preserve malformed target fields %# and report the failure", async (invalid) => {
  const storage = await dataset();
  await storage.saveBounds("source", bounds("source", 0, "shared"));
  await storage.saveBounds("target", bounds("target", 0, "shared"));
  const targetPath = storage.imagePaths("target").boundsPath;
  const before = JSON.stringify(invalid);
  await writeFile(targetPath, before);
  for (const operation of [boundaryService.saveBoundsAndSynchronize, boundaryService.applyBoundsToAll]) {
    const result = await operation(storage, "source", bounds("source", 1, "shared"));
    expect(result.failed).toEqual([{ imageId: "target", message: expect.stringMatching(/bounds.*invalid/i) }]);
    expect(await readFile(targetPath, "utf8")).toBe(before);
  }
});
