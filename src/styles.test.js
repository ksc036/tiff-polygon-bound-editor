import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("application layout CSS", () => {
  test("keeps the app shell fixed to the viewport so bottom panel resizing reclaims image space", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const appShellRule = css.match(/\.app-shell\s*\{[^}]+\}/)?.[0] ?? "";
    const sidePanelRule = css.match(/\.side-panel\s*\{[^}]+\}/)?.[0] ?? "";

    expect(appShellRule).toContain("height: 100dvh");
    expect(appShellRule).toContain("overflow: hidden");
    expect(sidePanelRule).toContain("overflow: auto");
  });

  test("keeps ROI preview stroke widths in image coordinates", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const roiPreviewRule = css.match(/\.roi-preview-band\s*\{[^}]+\}/)?.[0] ?? "";

    expect(roiPreviewRule).not.toContain("vector-effect");
  });
});
