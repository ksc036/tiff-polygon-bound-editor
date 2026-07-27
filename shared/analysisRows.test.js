import { describe, expect, test } from "vitest";
import { buildAnalysisRows, groupDisplayId, roiDisplayId } from "./analysisRows.js";

describe("ROI export identities", () => {
  test("uses stable zero-padded group order and mode suffixes", () => {
    expect(groupDisplayId(0)).toBe("G01");
    expect(groupDisplayId(11)).toBe("G12");
    expect(roiDisplayId({ groupIndex: 0, analysisMode: "outside", bandId: "near" })).toBe("G01-N");
    expect(roiDisplayId({ groupIndex: 0, analysisMode: "outside", bandId: "all" })).toBe("G01-A");
    expect(roiDisplayId({ groupIndex: 1, analysisMode: "inside", bandId: "inside" })).toBe("G02-I");
  });

  test("joins analysis groups to saved names, colors, and distance bands", () => {
    const bounds = {
      groups: [
        { id: "outer", name: "Cell edge", color: "#22c55e" },
        { id: "whole", name: "Whole image", color: "#ef4444", analysisMode: "inside" },
      ],
    };
    const analysis = {
      roiBands: [
        { id: "near", label: "가까움", fromPx: 0, toPx: 20 },
        { id: "mid", label: "중간", fromPx: 20, toPx: 50 },
        { id: "far", label: "멀리", fromPx: 50, toPx: 100 },
      ],
      groups: [
        {
          groupId: "outer",
          groupName: "stale name",
          analysisMode: "outside",
          bands: { near: { roiAreaPx: 10 }, mid: { roiAreaPx: 20 }, far: { roiAreaPx: 30 } },
          allBands: { roiAreaPx: 60 },
        },
        { groupId: "whole", analysisMode: "inside", area: { roiAreaPx: 100 } },
      ],
    };

    expect(buildAnalysisRows(analysis, bounds)).toEqual([
      expect.objectContaining({
        roiId: "G01-N",
        sourceGroupId: "outer",
        groupId: "G01",
        groupName: "Cell edge",
        groupColor: "#22c55e",
        bandId: "near",
        fromPx: 0,
        toPx: 20,
      }),
      expect.objectContaining({ roiId: "G01-M", bandId: "mid" }),
      expect.objectContaining({ roiId: "G01-F", bandId: "far" }),
      expect.objectContaining({ roiId: "G01-A", bandId: "all", fromPx: 0, toPx: 100 }),
      expect.objectContaining({
        roiId: "G02-I",
        groupId: "G02",
        groupName: "Whole image",
        groupColor: "#ef4444",
        bandId: "inside",
      }),
    ]);
  });

  test("falls back to the analysis name and neutral color while skipping unmatched groups", () => {
    const bounds = { groups: [{ id: "saved", name: undefined, color: undefined }] };
    const analysis = {
      roiBands: [{ id: "near", label: "Near", fromPx: 0, toPx: 4 }],
      groups: [
        {
          groupId: "saved",
          groupName: "Analysis name",
          analysisMode: "outside",
          bands: { near: { roiAreaPx: 1 } },
        },
        { groupId: "missing", analysisMode: "inside", area: { roiAreaPx: 2 } },
      ],
    };

    expect(buildAnalysisRows(analysis, bounds)).toEqual([
      expect.objectContaining({
        id: "G01-N",
        roiId: "G01-N",
        groupName: "Analysis name",
        groupColor: "#94a3b8",
        modeLabel: "Outside",
        bandLabel: "Near",
        fromPx: 0,
        toPx: 4,
      }),
    ]);
  });
});
