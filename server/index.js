import { pathToFileURL } from "node:url";
import path from "node:path";
import { createApp } from "./app.js";
import { chooseFolder } from "./folderPicker.js";

export function startServer({ rootDir = process.cwd(), port = process.env.PORT || 3000 } = {}) {
  const app = createApp({
    rootDir,
    dataDir: path.join(rootDir, "data"),
    initialRoot: process.env.BOUND_EDITOR_ROOT || null,
    selectRoot: () => chooseFolder({ prompt: "Choose image sequence root folder" }),
    selectHeatmapRoot: () => chooseFolder({ prompt: "Choose heatmap batch folder" }),
  });

  return app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
