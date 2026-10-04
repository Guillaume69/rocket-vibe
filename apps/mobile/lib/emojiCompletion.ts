/**
 * Emoji shortcode autocompletion in the composer.
 *
 * Typing `:te` should show `:test:`, `:tete:`... and let the user pick one.
 * Three PURE responsibilities, no React or network, hence testable under Node:
 *
 *   1. `detectEmojiToken`: find the `:xxx` token being typed just before the
 *      cursor (and reject `http://`, `12:34`, an already closed token).
 *   2. `completeEmoji`: rank the shortcodes (standard + custom) matching the
 *      query.
 *   3. `applyCompletion`: replace the token with the chosen insertion.
 *
 * The insertion itself (Unicode glyph for a standard one, `:name:` for a
 * custom one) and the preview are resolved in the UI (`ui/emojiCompletion.tsx`),
 * which has `unicodeOfShortcode` and `customEmojiUrl`. Here we only handle
 * names, the data both sides share.
 */

/**
 * Suggestions start at the FIRST letter after `:`, like Slack/Discord. `:a`
 * matches hundreds of emojis, but the ranking (exact, prefix, substring) puts
 * the right ones first and `SUGGESTION_LIMIT` bounds the strip. Below that (a
 * bare `:`), nothing: it would be the whole dictionary.
 */
export const MIN_QUERY = 1;
/** Cap on suggestions shown: the strip scrolls, no point ranking 2000. */
export const SUGGESTION_LIMIT = 30;

export type TypeEmoji = 'standard' | 'custom';
export type SuggestionEmoji = { code: string; type: TypeEmoji };

/** A shortcode is made only of these characters (`+1`, `-1`, `party_parrot`...). */
const VALID_CODE = /^[A-Za-z0-9_+-]*$/;
/**
 * A Unicode letter or digit, accents INCLUDED. The `:` opens a token only if
 * it starts a word; `é`, `à`... are letters just like `a`. Without `\p{L}`,
 * `résumé:tl` (no space) would wrongly open the strip.
 */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The `:xxx` token being typed just before the cursor, or `null`.
 *
 * The `:` must OPEN a word: start of the field, or preceded by a character
 * that is neither letter nor digit. Without this guard it would trigger in the
 * middle of `http://`, `12:34`, `key:value`. An already closed token
 * (`:smile:`) does not trigger: `lastIndexOf(':')` then lands on the closing
 * `:` and the query is empty.
 */
export function detectEmojiToken(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const c = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, c);
  const colon = before.lastIndexOf(':');
  if (colon === -1) return null;
  // `charAt` always returns a string ('' out of bounds): no index guard needed.
  if (colon > 0 && LETTER_OR_DIGIT.test(before.charAt(colon - 1))) return null;
  const query = before.slice(colon + 1);
  if (!VALID_CODE.test(query) || query.length < MIN_QUERY) return null;
  return { start: colon, query: query.toLowerCase() };
}

// The `Set` of standard codes is built ONCE: `codesEmojiStandard()` always
// returns the same array (frozen cache), so identity is enough to know it has
// not changed. Without this cache, every keystroke rebuilt a 6222-entry `Set`
// on the composer's hot path.
let refStandard: readonly string[] | null = null;
let setStandard: Set<string> | null = null;
function standardSet(codes: readonly string[]): Set<string> {
  if (codes !== refStandard) {
    refStandard = codes;
    setStandard = new Set(codes);
  }
  return setStandard as Set<string>;
}

/**
 * The shortcodes matching `query`, from most to least relevant.
 *
 * Order: exact match, then prefix, then substring; at equal quality a custom
 * one comes before a standard one (that is what the user is looking for
 * first), then the shortest code, then alphabetical.
 *
 * Case: the query is lowercased. Standard codes all are (generated table), but
 * a custom name comes from the server and may contain an uppercase letter, so
 * customs are compared lowercased while keeping the ORIGINAL code (the image
 * URL is built on the exact name).
 *
 * A custom one with the same name as a standard one is DROPPED (never added
 * twice): at render time the Unicode glyph wins over the custom image
 * (`ui/markdown.tsx`), so the suggestion must insert the glyph; it is treated
 * as standard.
 */
export function completeEmoji(
  query: string,
  codesStandard: readonly string[],
  customCodes: readonly string[],
  limit = SUGGESTION_LIMIT,
): SuggestionEmoji[] {
  const q = query.toLowerCase();
  if (q.length < MIN_QUERY) return [];

  const candidates: { s: SuggestionEmoji; rank: number }[] = [];
  const add = (code: string, type: TypeEmoji): void => {
    // Standard: already lowercase. Custom: lowercased for the comparison only.
    const haystack = type === 'custom' ? code.toLowerCase() : code;
    const i = haystack.indexOf(q);
    if (i === -1) return;
    const match = haystack === q ? 0 : i === 0 ? 1 : 2;
    // custom (0) before standard (1) at equal match.
    const rank = match * 2 + (type === 'custom' ? 0 : 1);
    candidates.push({ s: { code, type }, rank });
  };

  const standard = standardSet(codesStandard);
  for (const code of customCodes) {
    if (standard.has(code.toLowerCase())) continue; // the standard glyph wins at render time
    add(code, 'custom');
  }
  for (const code of codesStandard) add(code, 'standard');

  candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.s.code.length - b.s.code.length ||
      (a.s.code < b.s.code ? -1 : a.s.code > b.s.code ? 1 : 0),
  );
  return candidates.slice(0, limit).map((x) => x.s);
}

/**
 * Replaces the token `[start, cursor)` with `insertion`, cursor right after.
 *
 * A space follows the insertion so typing can continue, UNLESS the following
 * text already starts with a space (there would be two). The cursor lands
 * right after what was just written, never inside the rest of the text.
 */
export function applyCompletion(
  text: string,
  start: number,
  cursor: number,
  insertion: string,
): { text: string; cursor: number } {
  const c = Math.max(start, Math.min(cursor, text.length));
  const before = text.slice(0, start);
  const after = text.slice(c);
  const block = insertion + (/^\s/.test(after) ? '' : ' ');
  return { text: before + block + after, cursor: (before + block).length };
}
