/**
 * The voice screen's people as tiles sharing all its room: the whole area cut
 * into rows and columns, the column count whose cells hold the largest picture
 * between 2:3 and 16:9 (a phone held upright stacks two people and sets four
 * two by two, a tablet sets two side by side). The desktop keeps 16:9 tiles
 * on its wide windows (apps/desktop/crates/rv-gtk/src/tile_grid.rs). Node-pure.
 */
export const TILE_GAP = 10;

export type TileLayout = { columns: number; rows: number; width: number; height: number };

/** Columns and rows, then a tile's width and height, for `count` tiles filling `width` by `height`. */
export function arrangeTiles(count: number, width: number, height: number): TileLayout {
  const n = Math.max(1, count);
  let best: TileLayout & { area: number } = { columns: 1, rows: n, width: 0, height: 0, area: -1 };
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    const w = Math.floor((width - TILE_GAP * (columns - 1)) / columns);
    const h = Math.floor((height - TILE_GAP * (rows - 1)) / rows);
    if (w <= 0 || h <= 0) continue;
    const area = Math.min(w, (h * 16) / 9) * Math.min(h, w * 1.5);
    if (area > best.area) best = { columns, rows, width: w, height: h, area };
  }
  return { columns: best.columns, rows: best.rows, width: best.width, height: best.height };
}
