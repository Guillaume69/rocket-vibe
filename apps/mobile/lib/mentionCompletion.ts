/**
 * `@xxx` mention autocompletion in the composer.
 *
 * Same architecture as `lib/emojiCompletion.ts`: PURE functions, no React or
 * network, testable under Node. Token detection and ranking live here; the
 * candidate source (the room's recent authors, read from the local database)
 * and the display live in `ui/mentionCompletion.tsx`.
 *
 * The insertion is plain text `@username `: the server re-parses mentions on
 * send (`md` field), there is nothing else to carry. Replacing the token
 * reuses `applyCompletion` from `lib/emojiCompletion.ts`: same mechanics, same
 * edges (trailing space, cursor repositioned).
 *
 * Local candidates only, NO REST `spotlight` on each keystroke: one almost
 * always mentions someone from the conversation, and REST is rate-limited
 * (CLAUDE.md). If widening is ever needed, it will be a second, debounced
 * stage, the way `app/search.tsx` does it.
 */

/**
 * Suggestions start at a bare `@`: unlike emojis, the dictionary is the
 * handful of room authors, not 6000 codes, and showing the list on a bare `@`
 * is the expected Slack/Discord behaviour.
 */
export const MIN_MENTION_QUERY = 0;
/** The strip scrolls horizontally; beyond this, the ranking has already decided. */
export const MENTION_SUGGESTION_LIMIT = 12;

/**
 * A mention candidate: the exact `username` (what gets inserted and what
 * serves for the avatar), and its server `_id` when known (`null` for the
 * special mentions `all` / `here`).
 */
export type MentionCandidate = { username: string; uid: string | null };

/**
 * Rocket.Chat special mentions. Suggested after people at equal match
 * quality: `@a` must first show the room's Alices, with `@all` right behind.
 */
export const SPECIAL_MENTIONS: readonly string[] = ['all', 'here'];

/**
 * Character set of a Rocket.Chat username (default server setting
 * `UTF8_User_Names_Validation = [0-9a-zA-Z-_.]`). A character outside this set
 * closes the token: typing `@alice bonjour` must not keep the strip open on
 * the query `alice bonjour`.
 */
const VALID_USERNAME = /^[A-Za-z0-9._-]*$/;
/**
 * A Unicode letter or digit, accents included. The `@` opens a token only if
 * it starts a word: in the middle of `name@domain` (an email address), it does
 * not trigger.
 */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The `@xxx` token being typed just before the cursor, or `null`.
 *
 * Same guards as `detectEmojiToken`: the `@` must open a word (start of the
 * field, or preceded by a character that is neither letter nor digit), and the
 * query must stay within a username's character set.
 */
export function detectMentionToken(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const c = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, c);
  const atSign = before.lastIndexOf('@');
  if (atSign === -1) return null;
  // `charAt` returns '' out of bounds: no index guard needed.
  if (atSign > 0 && LETTER_OR_DIGIT.test(before.charAt(atSign - 1))) return null;
  const query = before.slice(atSign + 1);
  if (!VALID_USERNAME.test(query) || query.length < MIN_MENTION_QUERY) return null;
  return { start: atSign, query: query.toLowerCase() };
}

/**
 * The candidates matching `query`, from most to least relevant.
 *
 * Order: exact match, then prefix, then substring; at equal quality a person
 * comes before a special mention, then the candidates' ARRIVAL order breaks
 * ties: the caller supplies them from most recently active to oldest, and that
 * recency is a better signal than the alphabet.
 *
 * Empty query (bare `@`): all candidates in arrival order, then the special
 * mentions.
 */
export function completeMention(
  query: string,
  candidates: readonly MentionCandidate[],
  limit = MENTION_SUGGESTION_LIMIT,
): MentionCandidate[] {
  const q = query.toLowerCase();

  const kept: { c: MentionCandidate; rank: number; order: number }[] = [];
  const seen = new Set<string>();
  const add = (c: MentionCandidate, special: boolean): void => {
    const name = c.username.toLowerCase();
    if (seen.has(name)) return;
    const i = q === '' ? 0 : name.indexOf(q);
    if (i === -1) return;
    const match = q === '' ? 2 : name === q ? 0 : i === 0 ? 1 : 2;
    seen.add(name);
    kept.push({ c, rank: match * 2 + (special ? 1 : 0), order: kept.length });
  };

  for (const c of candidates) add(c, false);
  for (const name of SPECIAL_MENTIONS) add({ username: name, uid: null }, true);

  // A STABLE sort is required (arrival order breaks ties): guaranteed by
  // ECMAScript since ES2019, but `order` makes it explicit and engine-independent.
  kept.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return kept.slice(0, limit).map((x) => x.c);
}
