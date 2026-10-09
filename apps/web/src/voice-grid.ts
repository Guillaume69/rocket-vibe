// The GTK TileGrid arrangement, with the last row centered and 16:9 tiles.
export function tileLayout(
  count: number,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number }[] {
  let columns = 1,
    w = 0,
    h = 0;
  const gap = 12;
  for (let candidate = 1; candidate <= Math.max(1, count); candidate++) {
    const rows = Math.ceil(Math.max(1, count) / candidate),
      cellW = Math.trunc((width - gap * (candidate - 1)) / candidate),
      cellH = Math.trunc((height - gap * (rows - 1)) / rows);
    const chosen = Math.max(0, Math.min(cellW, Math.trunc((cellH * 16) / 9)));
    if (chosen > w) {
      columns = candidate;
      w = chosen;
      h = Math.trunc((w * 9) / 16);
    }
  }
  const rows = Math.ceil(count / columns),
    top = Math.max(0, Math.trunc((height - (rows * (h + gap) - gap)) / 2));
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns),
      column = index % columns,
      inRow = row === rows - 1 ? count - row * columns : columns,
      left = Math.trunc((width - (inRow * (w + gap) - gap)) / 2);
    return {
      left: left + column * (w + gap),
      top: top + row * (h + gap),
      width: w,
      height: h,
    };
  });
}
