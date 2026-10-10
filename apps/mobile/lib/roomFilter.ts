/**
 * Filtering the room list by name: the desktop room switcher's rule
 * (`rv_core::rooms::switcher_matches`), ported. A name starting with the
 * query comes first, then one with a word starting with it, then one holding
 * it anywhere; case and accents aside; ties go to the latest activity. An
 * empty query keeps every room, latest activity first.
 */

/** The letter under an accent, as `rv-core/src/native/workflows.rs#fold`. */
const FOLDS: Record<string, string> = {
  à: 'a', â: 'a', ä: 'a', á: 'a', ã: 'a', å: 'a', æ: 'a',
  ç: 'c',
  é: 'e', è: 'e', ê: 'e', ë: 'e',
  î: 'i', ï: 'i', í: 'i', ì: 'i',
  ô: 'o', ö: 'o', ó: 'o', ò: 'o', õ: 'o', œ: 'o',
  ù: 'u', û: 'u', ü: 'u', ú: 'u',
  ÿ: 'y', ý: 'y',
  ñ: 'n',
};

function folded(text: string): string {
  return Array.from(text.toLowerCase(), (ch) => FOLDS[ch] ?? ch).join('');
}

const NOT_ALPHANUMERIC = /[^\p{L}\p{N}]+/u;

function rank(names: (string | null)[], needle: string): number | null {
  let best: number | null = null;
  for (const raw of names) {
    if (raw === null) continue;
    const name = folded(raw);
    const k = name.startsWith(needle)
      ? 0
      : name.split(NOT_ALPHANUMERIC).some((word) => word.startsWith(needle))
        ? 1
        : name.includes(needle)
          ? 2
          : null;
    if (k !== null && (best === null || k < best)) best = k;
  }
  return best;
}

/** `items` whose `names` (the shown name, the slug) match `query`, ranked. */
export function filterRooms<T>(items: T[], query: string, names: (item: T) => (string | null)[], activity: (item: T) => number): T[] {
  const needle = folded(query.trim());
  const ranked: { item: T; k: number; at: number }[] = [];
  for (const item of items) {
    const k = needle === '' ? 0 : rank(names(item), needle);
    if (k !== null) ranked.push({ item, k, at: activity(item) });
  }
  ranked.sort((a, b) => a.k - b.k || b.at - a.at);
  return ranked.map((r) => r.item);
}
