function leadingSize(length, cellSize, alignment) {
  return alignment === "center" && length >= cellSize
    ? Math.floor((length % cellSize) / 2)
    : 0;
}

export function heatmapAxisCellCount(length, cellSize, alignment) {
  const leading = leadingSize(length, cellSize, alignment);
  return (leading > 0 ? 1 : 0) + Math.ceil((length - leading) / cellSize);
}

export function heatmapAxisCellBounds(index, length, cellSize, alignment) {
  const leading = leadingSize(length, cellSize, alignment);
  if (leading > 0 && index === 0) return { start: 0, size: leading };
  const start = leading + (index - (leading > 0 ? 1 : 0)) * cellSize;
  return { start, size: Math.min(cellSize, length - start) };
}

export function heatmapAxisCellIndex(position, length, cellSize, alignment) {
  if (!Number.isFinite(position) || position < 0 || position >= length || !(cellSize > 0)) return -1;
  const leading = leadingSize(length, cellSize, alignment);
  if (position < leading) return 0;
  return (leading > 0 ? 1 : 0) + Math.floor((position - leading) / cellSize);
}
