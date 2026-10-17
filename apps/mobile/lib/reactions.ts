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

/** Someone who reacted: their username and the name the row stored beside it, if any. */
export type Reactor = { username: string; name: string | null };

/** One emoji of a message and who reacted with it, for the "who reacted" sheet. */
export type ReactionPeople = { code: string; people: Reactor[] };

/**
 * Who reacted with each emoji, from the same column as `reactionList` and in
 * the same order, me FIRST in each list. `names`, when the row carries it, is
 * parallel to `usernames`: Rocket.Chat sends it when it shows real names, the
 * WhatsApp projection always. Same tolerance as `reactionList`.
 */
export function reactionPeople(raw: string | null, me: string | null): ReactionPeople[] {
  if (raw === null) return [];
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return [];
  const out: ReactionPeople[] = [];
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    const entry = value as { usernames?: unknown; names?: unknown } | null;
    const usernames: unknown[] = Array.isArray(entry?.usernames) ? entry.usernames : [];
    const names: unknown[] = Array.isArray(entry?.names) ? entry.names : [];
    const people: Reactor[] = [];
    usernames.forEach((username, i) => {
      if (typeof username !== 'string') return;
      const name = names[i];
      people.push({ username, name: typeof name === 'string' && name !== '' ? name : null });
    });
    if (people.length === 0) continue;
    out.push({
      code: key.replace(/^:/, '').replace(/:$/, ''),
      people: [...people.filter((p) => p.username === me), ...people.filter((p) => p.username !== me)],
    });
  }
  return out;
}
