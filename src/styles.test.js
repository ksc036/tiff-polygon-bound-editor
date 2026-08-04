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

  test("returns the side panel column to the image editor when groups are collapsed", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const collapsedShellRule = css.match(/\.app-shell\.side-panel-collapsed\s*\{[^}]+\}/)?.[0] ?? "";

    expect(collapsedShellRule).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  test("keeps ROI preview stroke widths in image coordinates", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const roiPreviewRule = css.match(/\.roi-preview-band\s*\{[^}]+\}/)?.[0] ?? "";

    expect(roiPreviewRule).not.toContain("vector-effect");
  });

  test("stacks comparison and opacity controls in the narrow side panel", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const actionsRule = css.match(/\.heatmap-display-actions\s*\{[^}]+\}/)?.[0] ?? "";

    expect(actionsRule).toContain("display: grid");
    expect(actionsRule).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  test("stacks the Heat Map without an internal cell-grid layer", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const originalOverlayRule = css.match(/\.raw-canvas\.heatmap-original-overlay\s*\{[^}]+\}/)?.[0] ?? "";
    const heatmapOverlayRule = css.match(/\.heatmap-overlay\s*\{[^}]+\}/)?.[0] ?? "";
    const tooltipRule = css.match(/\.heatmap-tooltip\s*\{[^}]+\}/)?.[0] ?? "";

    expect(heatmapOverlayRule).toContain("z-index: 1");
    expect(originalOverlayRule).toContain("z-index: 2");
    expect(tooltipRule).toContain("z-index: 5");
    expect(css).not.toContain(".heatmap-cell-grid");

    expect(css.indexOf(".heatmap-overlay {")).toBeLessThan(css.indexOf(".raw-canvas.heatmap-original-overlay {"));
    expect(css.indexOf(".raw-canvas.heatmap-original-overlay {")).toBeLessThan(css.indexOf(".heatmap-tooltip {"));
  });

  test("bounds the report, clips the plot, and permits header text to wrap", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const reportRule = css.match(/\.heatmap-report\s*\{[^}]+\}/)?.[0] ?? "";
    const plotRule = css.match(/\.heatmap-report-plot\s*\{[^}]+\}/)?.[0] ?? "";
    const headerRule = css.match(/\.heatmap-report-header\s*\{[^}]+\}/)?.[0] ?? "";

    expect(reportRule).toContain("max-width:");
    expect(reportRule).toContain("max-height:");
    expect(plotRule).toContain("overflow: hidden");
    expect(headerRule).toContain("white-space: normal");
    expect(headerRule).toContain("overflow-wrap: anywhere");
  });

  test("anchors all five report axis ticks to the four plot intervals", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const xAxisRule = css.match(/\.heatmap-x-axis\s*\{[^}]+\}/)?.[0] ?? "";
    const yAxisRule = css.match(/\.heatmap-y-axis\s*\{[^}]+\}/)?.[0] ?? "";
    const reportMainRule = css.match(/\.heatmap-report-main\s*\{[^}]+\}/)?.[0] ?? "";
    const xAxisMainRule = css.match(/\.heatmap-x-axis-main\s*\{[^}]+\}/)?.[0] ?? "";
    const xTickRule = css.match(/\.heatmap-x-axis \[data-testid="heatmap-x-tick"\]\s*\{[^}]+\}/)?.[0] ?? "";
    const yTickRule = css.match(/\.heatmap-y-axis \[data-testid="heatmap-y-tick"\]\s*\{[^}]+\}/)?.[0] ?? "";

    expect(xAxisRule).toContain("position: relative");
    expect(yAxisRule).toContain("position: relative");
    expect(reportMainRule).toContain("grid-template-columns: var(--report-y-band) minmax(0, 1fr)");
    expect(xAxisMainRule).toContain("grid-template-columns: var(--report-y-band) minmax(0, 1fr)");
    expect(xTickRule).toContain("position: absolute");
    expect(xTickRule).toContain("transform: translateX(-50%)");
    expect(yTickRule).toContain("position: absolute");
    expect(yTickRule).toContain("transform: translateY(-50%)");
  });

  test("reserves the mobile Heat Map stage for the report", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    expect(css).toContain(".stage-shell.heatmap-mode");
    expect(css).toContain(".stage-shell.heatmap-mode .analysis-resize-handle");
    expect(css).toContain(".stage-shell.heatmap-mode .analysis-panel");
  });

  test("keeps hidden raw canvases at zero opacity through the CSS cascade", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const hiddenLayerRule = css.match(/\.raw-canvas\.hidden-layer\s*\{[^}]+\}/)?.[0] ?? "";

    expect(hiddenLayerRule).toContain("opacity: 0");
  });

  test("keeps the subimage crop overlay above editor handles without taking drag input", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const overlayRule = css.match(/\.subimage-overlay\s*\{[^}]+\}/)?.[0] ?? "";
    const shadeRule = css.match(/\.subimage-overlay \[data-testid="subimage-outside-shade"\]\s*\{[^}]+\}/)?.[0] ?? "";
    const actionsRule = css.match(/\.subimage-actions\s*\{[^}]+\}/)?.[0] ?? "";

    expect(overlayRule).toContain("z-index: 4");
    expect(overlayRule).toContain("pointer-events: none");
    expect(shadeRule).toContain("fill: rgba(0, 0, 0, 0.62)");
    expect(actionsRule).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  test("keeps all nine toolbar actions on a compact single row", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const toolbarRule = css.match(/\.top-toolbar\s*\{[^}]+\}/)?.[0] ?? "";
    const exportButtonRule = css.match(/\.export-button\s*\{[^}]+\}/)?.[0] ?? "";
    const imageCounterRule = css.match(/\.image-counter\s*\{[^}]+\}/)?.[0] ?? "";
    const imageCounterTextRule = css.match(/\.image-counter span\s*\{[^}]+\}/)?.[0] ?? "";

    expect(toolbarRule).toContain(
      "grid-template-columns: auto minmax(180px, 1fr) auto auto minmax(96px, 0.72fr) auto auto auto auto",
    );
    expect(toolbarRule).not.toContain("nth-child");
    expect(exportButtonRule).toContain("min-width: 128px");
    expect(exportButtonRule).toContain("white-space: nowrap");
    expect(imageCounterRule).toContain("min-width: 0");
    expect(imageCounterTextRule).toContain("text-overflow: ellipsis");
  });

  test("lays out group identity with named roles instead of child-order selectors", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    const groupSelectRule = css.match(/\.group-select-button\s*\{[^}]+\}/)?.[0] ?? "";
    const groupNameRule = css.match(/\.group-name\s*\{[^}]+\}/)?.[0] ?? "";

    expect(css).not.toContain(".group-select-button span:nth-child");
    expect(groupSelectRule).toContain("grid-template-columns: 10px auto minmax(0, 1fr) auto");
    expect(groupNameRule).toContain("min-width: 0");
    expect(groupNameRule).toContain("text-overflow: ellipsis");
  });
});
