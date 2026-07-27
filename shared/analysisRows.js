const ROI_SUFFIXES = Object.freeze({
  near: "N",
  mid: "M",
  far: "F",
  all: "A",
  inside: "I",
});

const OUTSIDE_BAND_IDS = Object.freeze(["near", "mid", "far"]);

export function groupDisplayId(groupIndex) {
  if (!Number.isSafeInteger(groupIndex) || groupIndex < 0) {
    throw new TypeError("Group index must be a non-negative integer.");
  }
  return `G${String(groupIndex + 1).padStart(2, "0")}`;
}

export function roiDisplayId({ groupIndex, analysisMode, bandId }) {
  const normalizedBand = analysisMode === "inside" ? "inside" : bandId;
  const suffix = ROI_SUFFIXES[normalizedBand];
  if (!suffix) {
    throw new TypeError(`Unknown ROI band: ${normalizedBand}`);
  }
  return `${groupDisplayId(groupIndex)}-${suffix}`;
}

function rowMetadata({ analysisGroup, savedGroup, groupIndex, bandId, bandLabel, fromPx, toPx, metrics }) {
  const analysisMode = analysisGroup.analysisMode === "inside" ? "inside" : "outside";
  const groupId = groupDisplayId(groupIndex);
  const roiId = roiDisplayId({ groupIndex, analysisMode, bandId });

  return {
    id: roiId,
    roiId,
    sourceGroupId: savedGroup.id,
    groupId,
    groupName: savedGroup.name ?? analysisGroup.groupName ?? savedGroup.id,
    groupColor: savedGroup.color ?? "#94a3b8",
    analysisMode,
    modeLabel: analysisMode === "inside" ? "Inside" : "Outside",
    bandId,
    bandLabel,
    fromPx,
    toPx,
    metrics,
  };
}

export function buildAnalysisRows(analysis, bounds) {
  const savedGroups = Array.isArray(bounds?.groups) ? bounds.groups : [];
  const analysisGroups = Array.isArray(analysis?.groups) ? analysis.groups : [];
  const analysisBands = Array.isArray(analysis?.roiBands) ? analysis.roiBands : [];
  const savedGroupById = new Map(savedGroups.map((group, index) => [group.id, { group, index }]));

  return analysisGroups.flatMap((analysisGroup) => {
    const savedMatch = savedGroupById.get(analysisGroup?.groupId);
    if (!savedMatch) return [];

    const { group: savedGroup, index: groupIndex } = savedMatch;
    const analysisMode = analysisGroup.analysisMode === "inside" ? "inside" : "outside";

    if (analysisMode === "inside") {
      if (!analysisGroup.area) return [];
      return [
        rowMetadata({
          analysisGroup,
          savedGroup,
          groupIndex,
          bandId: "inside",
          bandLabel: "영역",
          fromPx: null,
          toPx: null,
          metrics: analysisGroup.area,
        }),
      ];
    }

    // Recalculation saves the effective group-specific limits with the group.
    // Older analysis files only have the top-level bands, which remain the fallback.
    const groupBands = Array.isArray(analysisGroup.roiBands) && analysisGroup.roiBands.length > 0
      ? analysisGroup.roiBands
      : analysisBands;
    const bandById = new Map(groupBands.map((band) => [band.id, band]));
    const firstBand = groupBands[0];
    const lastBand = groupBands[groupBands.length - 1];

    const rows = OUTSIDE_BAND_IDS.flatMap((bandId) => {
      const metrics = analysisGroup.bands?.[bandId];
      if (!metrics) return [];
      const band = bandById.get(bandId);
      return [
        rowMetadata({
          analysisGroup,
          savedGroup,
          groupIndex,
          bandId,
          bandLabel: band?.label ?? bandId,
          fromPx: band?.fromPx ?? null,
          toPx: band?.toPx ?? null,
          metrics,
        }),
      ];
    });

    if (analysisGroup.allBands) {
      rows.push(
        rowMetadata({
          analysisGroup,
          savedGroup,
          groupIndex,
          bandId: "all",
          bandLabel: "전체",
          fromPx: firstBand?.fromPx ?? null,
          toPx: lastBand?.toPx ?? null,
          metrics: analysisGroup.allBands,
        }),
      );
    }

    return rows;
  });
}
