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

  test("uses a horizontal panel scale for the heatmap legend", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const legendRule = css.match(/\.heatmap-legend\s*\{[^}]+\}/)?.[0] ?? "";

    expect(legendRule).not.toContain("position: absolute");
    expect(legendRule).toContain("grid-template-columns");
  });

  test("stacks comparison and opacity controls in the narrow side panel", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const actionsRule = css.match(/\.heatmap-display-actions\s*\{[^}]+\}/)?.[0] ?? "";

    expect(actionsRule).toContain("display: grid");
    expect(actionsRule).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  test("reserves layout space below the comparison legend for its zero label", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const differenceLegendRule = css.match(/\.heatmap-legend\.difference\s*\{[^}]+\}/)?.[0] ?? "";
    const scaleRule = css.match(/\.heatmap-legend-scale\s*\{[^}]+\}/)?.[0] ?? "";

    expect(differenceLegendRule).toContain("padding-bottom: 14px");
    expect(scaleRule).toContain("height: 12px");
  });

  test("stacks the Heat Map original TIFF above the opaque heatmap overlay", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const originalOverlayRule = css.match(/\.raw-canvas\.heatmap-original-overlay\s*\{[^}]+\}/)?.[0] ?? "";
    const heatmapOverlayRule = css.match(/\.heatmap-overlay\s*\{[^}]+\}/)?.[0] ?? "";

    expect(originalOverlayRule).toContain("z-index: 2");
    expect(originalOverlayRule).toContain("pointer-events: none");
    expect(heatmapOverlayRule).toContain("z-index: 1");
  });

  test("keeps hidden raw canvases at zero opacity through the CSS cascade", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const hiddenLayerRule = css.match(/\.raw-canvas\.hidden-layer\s*\{[^}]+\}/)?.[0] ?? "";

    expect(hiddenLayerRule).toContain("opacity: 0");
  });
});
