/**
 * Mattermost's reaction names against the codes the apps show: a skin tone is
 * `<name>_<tone>_skin_tone` there (`-1_medium_light_skin_tone`) and
 * `<name>_tone<1-5>` here. Mirrors `reaction_code` / `reaction_name` in
 * `apps/desktop/crates/rv-core/src/mattermost/translate.rs`.
 */

import { shortcodeOfUnicode, unicodeOfShortcode } from '../../lib/emojis.ts';

const TONES = ['light', 'medium_light', 'medium', 'medium_dark', 'dark'] as const;

/** A reaction's Mattermost name as the code the apps show. */
export function reactionCode(name: string): string {
  const rest = name.endsWith('_skin_tone') ? name.slice(0, -'_skin_tone'.length) : null;
  if (rest === null) return name;
  const tone = [...TONES.keys()].reverse().find((i) => rest.endsWith(`_${TONES[i]}`));
  if (tone === undefined) return name;
  const base = rest.slice(0, rest.length - TONES[tone].length - 1);
  if (base === '') return name;
  const code = `${base}_tone${tone + 1}`;
  if (unicodeOfShortcode(code) !== null) return code;
  const glyph = unicodeOfShortcode(base);
  if (glyph === null) return name;
  return shortcodeOfUnicode(glyph.replace(/️/g, '') + String.fromCodePoint(0x1f3fb + tone)) ?? name;
}

/** The Mattermost name a reaction code is sent as. */
export function reactionName(code: string): string {
  const bare = code.replace(/^:|:$/g, '');
  const toned = /^(.+)_tone([1-5])$/.exec(bare);
  return toned ? `${toned[1]}_${TONES[Number(toned[2]) - 1]}_skin_tone` : bare;
}
