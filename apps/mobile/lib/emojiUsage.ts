/**
 * The emoji I react with most, per account, for the quick reactions of the
 * message sheet (`app/message-actions.tsx`). Counted on the device only (the
 * `emoji_usage` table of the account's database, `db/store.ts`), never sent to
 * the server. Same rules as the desktop's `rv-core/src/emoji_usage.rs`: every
 * reaction I ADD counts one use, a removal counts nothing; ranking by uses,
 * then most recent, then the default row fills what is left.
 *
 * Codes are shortcodes WITHOUT colons (`+1`, `rocket`, `party_parrot`), as the
 * sheet sends them; a custom emoji counts under its name like any other code.
 *
 * Pure module, no React: tested under Node (`lib/emojiUsage.test.ts`).
 */

import { unicodeOfShortcode } from './emojis.ts';

/** How many quick reactions the sheet shows before its "+". */
export const QUICK_COUNT = 5;

/**
 * The row before any use, and what fills it afterwards. Rocket.Chat
 * shortnames: `chat.react` refuses raw unicode.
 */
export const DEFAULT_REACTIONS: readonly string[] = ['+1', 'heart', 'joy', 'tada', 'open_mouth', 'pray'];

/** Distinct codes kept; beyond, the least used are forgotten (`db/upserts.ts`). */
export const KEPT_CODES = 64;

/** One row of `emoji_usage`. `lastUsed` in milliseconds. */
export type EmojiUse = { code: string; count: number; lastUsed: number };

/** A shortcode is made only of these characters (`+1`, `-1`, `party_parrot`...). */
const VALID_CODE = /^[A-Za-z0-9_+-]{1,100}$/;

/**
 * `:+1:` and `+1` are the same code. `null` for anything that is not a
 * shortcode (a glyph, an empty string, a code with spaces): never counted.
 */
export function normalizeEmojiCode(input: string): string | null {
  const trimmed = input.trim();
  const code = trimmed.startsWith(':') && trimmed.endsWith(':') && trimmed.length > 1
    ? trimmed.slice(1, -1)
    : trimmed;
  return VALID_CODE.test(code) ? code : null;
}

/**
 * What makes two codes the same emoji: the glyph for a standard one, so the
 * aliases of the table (`+1` and `thumbsup`, the native provider's canonical
 * names, the picker's names) count and show as ONE; the name for a custom one.
 */
export function emojiIdentity(code: string): string {
  return unicodeOfShortcode(code) ?? code;
}

/**
 * The `n` codes to offer first: most used, then most recent, then the
 * default row (skipping what is already there). Aliases of one emoji are
 * merged (uses summed, latest use kept) and shown under their most used code.
 * `allowed` drops what the current room cannot take (a custom emoji in a
 * private conversation, or one the server no longer has); the defaults are
 * standard emoji and always allowed.
 */
export function topEmojis(
  rows: readonly EmojiUse[],
  n: number,
  allowed: (code: string) => boolean = () => true,
): string[] {
  const groups = new Map<string, { code: string; best: number; bestLast: number; count: number; lastUsed: number }>();
  for (const row of rows) {
    const code = normalizeEmojiCode(row.code);
    if (code === null || !Number.isFinite(row.count) || row.count <= 0 || !allowed(code)) continue;
    const lastUsed = Number.isFinite(row.lastUsed) ? row.lastUsed : 0;
    const key = emojiIdentity(code);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { code, best: row.count, bestLast: lastUsed, count: row.count, lastUsed });
      continue;
    }
    group.count += row.count;
    group.lastUsed = Math.max(group.lastUsed, lastUsed);
    if (row.count > group.best || (row.count === group.best && lastUsed > group.bestLast)) {
      group.code = code;
      group.best = row.count;
      group.bestLast = lastUsed;
    }
  }
  const ranked = [...groups.entries()].sort(
    ([, a], [, b]) =>
      b.count - a.count || b.lastUsed - a.lastUsed || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  const out = ranked.slice(0, Math.max(0, n)).map(([, g]) => g.code);
  const shown = new Set(out.map(emojiIdentity));
  for (const code of DEFAULT_REACTIONS) {
    if (out.length >= n) break;
    const key = emojiIdentity(code);
    if (shown.has(key)) continue;
    shown.add(key);
    out.push(code);
  }
  return out;
}
