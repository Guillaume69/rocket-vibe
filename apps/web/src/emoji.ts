import table from "../../desktop/crates/rv-core/data/emojis.tsv?raw";
import aliasesData from "../../../crates/rv-protocol/data/emoji-aliases.json";
const aliases: Record<string, string> = aliasesData;
export const glyphs = new Map<string, string>(),
  codes = new Map<string, string>(),
  categories = new Map<string, string[]>();
for (const line of table.trim().split(/\r?\n/)) {
  const [code, points, category] = line.split("\t");
  if (!code || !points) continue;
  const glyph = String.fromCodePoint(
    ...points.split("-").map((point) => Number.parseInt(point, 16)),
  );
  glyphs.set(code, glyph);
  if (!codes.has(glyph)) codes.set(glyph, code);
  if (category !== "-") {
    const list = categories.get(category) || [];
    list.push(code);
    categories.set(category, list);
  }
}
export function canonical(value: string): string {
  const code =
    codes.get(value) ||
    (value.startsWith(":") && value.endsWith(":") ? value.slice(1, -1) : value);
  return aliases[code] || code;
}
export const emojiGlyph = (code: string): string =>
  glyphs.get(code) || glyphs.get(canonical(code)) || ":" + code + ":";
