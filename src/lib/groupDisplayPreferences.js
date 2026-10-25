export const GROUP_DISPLAY_STORAGE_KEY = "raw16-editor-group-display-v1";
const DISPLAY_TYPES = ["draw", "stats", "vector"];
const EMPTY_DISPLAY = Object.freeze({ draw: {}, stats: {}, vector: {} });

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function groupDisplayScope(rootPath, imageId) {
  return JSON.stringify([rootPath, imageId]);
}

export function readGroupDisplayPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(GROUP_DISPLAY_STORAGE_KEY));
    if (!isRecord(saved)) return {};
    return Object.fromEntries(Object.entries(saved).flatMap(([scope, display]) => {
      let identity;
      try { identity = JSON.parse(scope); } catch { return []; }
      if (!Array.isArray(identity) || identity.length !== 2 ||
          !identity.every((part) => typeof part === "string" && part) || !isRecord(display)) return [];
      return [[scope, Object.fromEntries(DISPLAY_TYPES.map((type) => [type,
        Object.fromEntries(Object.entries(isRecord(display[type]) ? display[type] : {})
          .filter(([id, visible]) => id && typeof visible === "boolean")),
      ]))]];
    }));
  } catch {
    return {};
  }
}

export function saveGroupDisplayPreferences(preferences) {
  try {
    localStorage.setItem(GROUP_DISPLAY_STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function imageGroupDisplay(preferences, rootPath, imageId) {
  return preferences[groupDisplayScope(rootPath, imageId)] ?? EMPTY_DISPLAY;
}

export function excludedGroupsForExport(preferences, rootPath, images) {
  return Object.fromEntries(images.flatMap(({ id }) => {
    const { draw, stats } = imageGroupDisplay(preferences, rootPath, id);
    const excluded = [...new Set([...Object.keys(draw), ...Object.keys(stats)])]
      .filter((groupId) => draw[groupId] === false || stats[groupId] === false);
    return excluded.length ? [[id, excluded]] : [];
  }));
}
