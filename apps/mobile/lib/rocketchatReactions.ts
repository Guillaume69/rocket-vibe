/**
 * What a reaction is sent as on Rocket.Chat. `chat.react` accepts only the
 * codes of its own emoji list (8.5.1: 4,278 codes, aliases included, in
 * `scripts/rocketchat-emojis.json`) or a custom emoji's name, and that list is
 * older than our table (emoji-toolkit). So a standard code is sent as itself
 * when accepted, else as an accepted code of the same glyph (our `alien_monster`
 * is its `space_invader`); a glyph with no accepted code cannot be a reaction
 * there and is hidden from the reaction picker and the quick row. The
 * composer's picker is unaffected (text takes any glyph), and so is RocketVibe.
 *
 * Pure module: tested under Node (`lib/rocketchatReactions.test.ts`).
 */

import { ROCKETCHAT_REACTIONS } from './emojis.rocketchat.generated.ts';
import { unicodeOfShortcode } from './emojis.ts';

let table: Record<string, string> | null = null;

/**
 * The code `chat.react` takes for this one, or `null` when Rocket.Chat has no
 * code for that glyph. A code outside our table (a custom emoji) passes as
 * it is: the server judges its own emoji.
 */
export function rocketChatReaction(code: string): string | null {
  if (unicodeOfShortcode(code) === null) return code;
  table ??= JSON.parse(ROCKETCHAT_REACTIONS) as Record<string, string>;
  if (!Object.hasOwn(table, code)) return code;
  return table[code] || null;
}
