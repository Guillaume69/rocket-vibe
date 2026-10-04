/**
 * A message's reactions, projected for rendering.
 *
 * The `messages.reactions` column holds the server's JSON as is:
 * `{":+1:": {"usernames": ["alice","bob"], "names": [...]}}`. The keys are
 * shortcodes BETWEEN colons, and membership is judged by USERNAME (not uid:
 * the server only stores usernames). This column was written from day one
 * (`lib/normalize.ts`) but read nowhere: the user reacted, the sheet closed,
 * nothing changed on screen. The projection lives here, pure and testable;
 * the chips are rendered in `ui/messageRow.tsx`.
 */

export type DisplayedReaction = {
  /** Shortcode WITHOUT the colons (`+1`, `party_parrot`). */
  code: string;
  /** Number of people who added this reaction. */
  total: number;
  /** My username is in it: the outline is emphasized, and a tap REMOVES. */
  byMe: boolean;
};

/**
 * `raw` = the `reactions` column (serialized JSON, or null). `me` = my
 * username, or null if unknown (search results): `byMe` then stays false and
 * the chips show unmarked. Tolerant like everything coming from others: an
 * unreadable JSON or an unexpected shape returns `[]`, never an exception.
 * The server's order is preserved.
 */
export function reactionList(raw: string | null, me: string | null): DisplayedReaction[] {
  if (raw === null) return [];
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return [];
  const out: DisplayedReaction[] = [];
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    const rawUsernames = (value as { usernames?: unknown } | null)?.usernames;
    const usernames = Array.isArray(rawUsernames)
      ? rawUsernames.filter((u): u is string => typeof u === 'string')
      : [];
    if (usernames.length === 0) continue;
    out.push({
      code: key.replace(/^:/, '').replace(/:$/, ''),
      total: usernames.length,
      byMe: me !== null && usernames.includes(me),
    });
  }
  return out;
}
