import { expect, test } from "vitest";
import { createRoiMarkerSvg } from "./exportRoiMarker.js";

test("draws the ROI marker as a fixed one-pixel yellow outline", () => {
  const marker = createRoiMarkerSvg(1008, 1008, {
    sourceWidth: 1008,
    sourceHeight: 1008,
    x: 200,
    y: 200,
    width: 500,
    height: 500,
  }).toString("utf8");

  expect(marker).toContain('stroke="#ffea00" stroke-width="1"');
  expect(marker).not.toContain('stroke="#000000"');
  expect(marker.match(/<path /g)).toHaveLength(1);
});
