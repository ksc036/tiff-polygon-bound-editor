import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { createApp } from "./app.js";

const execFileAsync = promisify(execFile);

export async function chooseFolderWithAppleScript() {
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose image sequence root folder")',
    ]);
    const selectedPath = stdout.trim();

    if (!selectedPath) {
      throw new Error("No folder selected.");
    }

    return selectedPath;
  } catch (error) {
    throw new Error("Root selection was cancelled or failed.", { cause: error });
  }
}

export function startServer({ rootDir = process.cwd(), port = process.env.PORT || 3000 } = {}) {
  const app = createApp({
    rootDir,
    dataDir: path.join(rootDir, "data"),
    initialRoot: process.env.BOUND_EDITOR_ROOT || null,
    selectRoot: chooseFolderWithAppleScript,
  });

  return app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
