import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DEFAULT_CONNECTION_MODE = "input-order-cycle";
const SETTINGS_FILE_NAME = "settings.json";

function isTiffFile(fileName) {
  return /\.tiff?$/i.test(fileName);
}

function compareImageRecords(left, right) {
  return left.imageFolder.localeCompare(right.imageFolder, undefined, { numeric: true, sensitivity: "base" });
}

function scanRoot(rootDir) {
  if (!rootDir || !path.isAbsolute(rootDir)) {
    throw new Error("Storage root must be an absolute path.");
  }

  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    throw new Error(`Storage root does not exist: ${rootDir}`);
  }

  const images = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const folderPath = path.join(rootDir, entry.name);
      const imageDir = path.join(folderPath, "image");
      const maskDir = path.join(folderPath, "mask");

      if (!existsSync(imageDir) || !statSync(imageDir).isDirectory() || !existsSync(maskDir) || !statSync(maskDir).isDirectory()) {
        return [];
      }

      const imageFile = readdirSync(imageDir)
        .filter(isTiffFile)
        .sort((left, right) => left.localeCompare(right))[0];

      if (!imageFile) {
        return [];
      }

      return [
        {
          id: entry.name,
          imageFolder: entry.name,
          imageFile,
          folderPath,
          imageDir,
          imagePath: path.join(imageDir, imageFile),
        },
      ];
    })
    .sort(compareImageRecords);

  if (images.length === 0) {
    throw new Error(`Storage root has no image folders: ${rootDir}`);
  }

  return images;
}

function publicImage(image) {
  const { folderPath, imageDir, imagePath, ...visibleImage } = image;
  return { ...visibleImage };
}

function emptyBoundsPayload(image) {
  return {
    schemaVersion: 1,
    imageFolder: image.imageFolder,
    imageFile: image.imageFile,
    width: null,
    height: null,
    connectionMode: DEFAULT_CONNECTION_MODE,
    groups: [],
  };
}

function settingsPath(dataDir) {
  return dataDir ? path.join(dataDir, SETTINGS_FILE_NAME) : null;
}

function readPersistedRoot(dataDir) {
  const filePath = settingsPath(dataDir);
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    const settings = JSON.parse(readFileSync(filePath, "utf8"));
    return typeof settings.rootPath === "string" ? settings.rootPath : null;
  } catch {
    return null;
  }
}

function writePersistedRoot(dataDir, rootPath) {
  const filePath = settingsPath(dataDir);
  if (!filePath) {
    return;
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ rootPath }, null, 2)}\n`);
}

export function createStorage({ initialRoot = null, selectRoot = null, dataDir = null } = {}) {
  let rootDir = null;
  let images = [];

  function setRoot(nextRoot) {
    const scannedImages = scanRoot(nextRoot);
    rootDir = nextRoot;
    images = scannedImages;
    writePersistedRoot(dataDir, rootDir);
    return rootDir;
  }

  function ensureRoot() {
    if (!rootDir) {
      throw new Error("Storage root has not been set.");
    }
  }

  function getImage(imageOrId) {
    return publicImage(resolveImage(imageOrId));
  }

  function resolveImage(imageOrId) {
    ensureRoot();
    const id = typeof imageOrId === "string" ? imageOrId : imageOrId?.id;
    const image = images.find((candidate) => candidate.id === id);

    if (!image) {
      throw new Error(`Unknown image id: ${id}`);
    }

    return image;
  }

  function imagePaths(imageOrId) {
    const image = resolveImage(imageOrId);
    const boundDir = path.join(image.folderPath, "bound");
    const maskDir = path.join(image.folderPath, "mask");
    const skeletonDir = path.join(image.folderPath, "Skeletonize");
    const analysisDir = path.join(image.folderPath, "analysis");

    return {
      folderPath: image.folderPath,
      imageDir: image.imageDir,
      imagePath: image.imagePath,
      boundDir,
      boundsPath: path.join(boundDir, `${image.imageFolder}.bounds.json`),
      maskDir,
      skeletonDir,
      analysisDir,
      skeletonPath: path.join(skeletonDir, `${image.imageFolder}.skeleton.png`),
      analysisPath: path.join(analysisDir, `${image.imageFolder}.analysis.json`),
    };
  }

  async function scanImages() {
    ensureRoot();
    images = scanRoot(rootDir);
    return images.map(publicImage);
  }

  async function loadBounds(id) {
    const image = resolveImage(id);
    const { boundsPath } = imagePaths(image);

    try {
      return JSON.parse(await readFile(boundsPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return emptyBoundsPayload(image);
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Invalid bounds JSON for ${image.imageFolder}: ${error.message}`, { cause: error });
      }

      throw error;
    }
  }

  async function saveBounds(id, bounds) {
    const image = resolveImage(id);
    const { boundDir, boundsPath } = imagePaths(image);
    const payload = {
      schemaVersion: 1,
      imageFolder: image.imageFolder,
      imageFile: image.imageFile,
      width: bounds?.width ?? null,
      height: bounds?.height ?? null,
      connectionMode: DEFAULT_CONNECTION_MODE,
      groups: bounds?.groups ?? [],
      updatedAt: new Date().toISOString(),
    };
    const tempPath = path.join(boundDir, `${image.imageFolder}.bounds.json.tmp-${randomUUID()}`);

    await mkdir(boundDir, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(tempPath, boundsPath);

    return payload;
  }

  async function loadAnalysis(id) {
    const { analysisPath } = imagePaths(id);

    try {
      return JSON.parse(await readFile(analysisPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Invalid analysis JSON for ${resolveImage(id).imageFolder}: ${error.message}`, { cause: error });
      }

      throw error;
    }
  }

  async function saveAnalysis(id, analysis) {
    const image = resolveImage(id);
    const { analysisDir, analysisPath } = imagePaths(image);
    const payload = {
      ...analysis,
      schemaVersion: analysis?.schemaVersion ?? 1,
      imageFolder: image.imageFolder,
      imageFile: image.imageFile,
      updatedAt: new Date().toISOString(),
    };
    const tempPath = path.join(analysisDir, `${image.imageFolder}.analysis.json.tmp-${randomUUID()}`);

    await mkdir(analysisDir, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(tempPath, analysisPath);

    return payload;
  }

  async function importPreviousBounds(id) {
    const image = resolveImage(id);
    const imageIndex = images.findIndex((candidate) => candidate.id === image.id);

    if (imageIndex <= 0) {
      throw new Error(`No previous image exists for ${image.id}.`);
    }

    const previousImage = images[imageIndex - 1];
    const { boundsPath } = imagePaths(previousImage);

    if (!existsSync(boundsPath)) {
      throw new Error(`No previous bounds exist for ${previousImage.imageFolder}.`);
    }

    const previousBounds = await loadBounds(previousImage);

    return {
      ...previousBounds,
      imageFolder: image.imageFolder,
      imageFile: image.imageFile,
      sourceImageFolder: previousImage.imageFolder,
    };
  }

  async function selectRootWithFinder() {
    if (!selectRoot) {
      throw new Error("Root selection is unsupported in this environment.");
    }

    return setRoot(await selectRoot());
  }

  const startupRoot = initialRoot ?? readPersistedRoot(dataDir);
  if (startupRoot) {
    try {
      setRoot(startupRoot);
    } catch {
      rootDir = null;
      images = [];
    }
  }

  return {
    getRoot: () => rootDir,
    setRoot,
    selectRootWithFinder,
    scanImages,
    getImage,
    loadBounds,
    saveBounds,
    loadAnalysis,
    saveAnalysis,
    importPreviousBounds,
    imagePaths,
  };
}
