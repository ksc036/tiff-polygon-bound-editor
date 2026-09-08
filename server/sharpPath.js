import path from "node:path";

export function sharpPath(filePath) {
  return process.platform === "win32" ? path.toNamespacedPath(filePath) : filePath;
}
