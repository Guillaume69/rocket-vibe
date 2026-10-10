/**
 * The room switcher's ranking (`rv_core::rooms::switcher_matches`, also
 * `apps/mobile/lib/roomFilter.ts`): a name starting with the query comes
 * first, then one with a word starting with it, then one holding it anywhere;
 * case and accents aside; ties go to the latest activity. An empty query keeps
 * every room, latest activity first.
 */

/** The letter under an accent, as `rv-core/src/native/workflows.rs#fold`. */
const FOLDS: Record<string, string> = {
  à: "a",
  â: "a",
  ä: "a",
  á: "a",
  ã: "a",
  å: "a",
  æ: "a",
  ç: "c",
  é: "e",
  è: "e",
  ê: "e",
  ë: "e",
  î: "i",
  ï: "i",
  í: "i",
  ì: "i",
  ô: "o",
  ö: "o",
  ó: "o",
  ò: "o",
  õ: "o",
  œ: "o",
  ù: "u",
  û: "u",
  ü: "u",
  ú: "u",
  ÿ: "y",
  ý: "y",
  ñ: "n",
};

function folded(text: string): string {
  return Array.from(text.toLowerCase(), (ch) => FOLDS[ch] ?? ch).join("");
}

function rank(name: string, needle: string): number | null {
  const folded_ = folded(name);
  if (folded_.startsWith(needle)) return 0;
  if (folded_.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle)))
    return 1;
  return folded_.includes(needle) ? 2 : null;
}

/** `items` whose name matches `query`, ranked. */
export function matchRooms<T>(
  items: T[],
  query: string,
  name: (item: T) => string,
  activity: (item: T) => number,
): T[] {
  const needle = folded(query.trim());
  const ranked: { item: T; k: number; at: number }[] = [];
  for (const item of items) {
    const k = needle === "" ? 0 : rank(name(item), needle);
    if (k !== null) ranked.push({ item, k, at: activity(item) });
  }
  ranked.sort((a, b) => a.k - b.k || b.at - a.at);
  return ranked.map((entry) => entry.item);
}
