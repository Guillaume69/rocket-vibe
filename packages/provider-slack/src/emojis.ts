/**
 * Slack's standard emoji names, which are not the app's: `female-office-worker`,
 * with a skin tone written as a second code, `:+1::skin-tone-3:`. Text turns
 * into the glyphs; a reaction goes by the app's own shortcode for the same
 * glyph, and back to Slack's name when sent. A name Slack does not list (a
 * custom emoji) goes through unchanged. The desktop does the same
 * (`crates/rv-slack/src/emojis.rs`) from the same generated table.
 */

import { shortcodeOfUnicode, unicodeOfShortcode } from '@rocket-vibe/provider-api/emojis';
import { SLACK_EMOJIS } from './emojis.generated.ts';

const TONE = '::skin-tone-';

type Table = {
  byName: Map<string, { base: string; tones: string[] | null }>;
  byGlyph: Map<string, { name: string; tone: number | null }>;
};

let table: Table | null = null;

const glyph = (points: string): string => String.fromCodePoint(...points.split('-').map((p) => parseInt(p, 16)));
const bare = (g: string): string => g.replace(/️/g, '');

function slack(): Table {
  if (table !== null) return table;
  const byName: Table['byName'] = new Map(), byGlyph: Table['byGlyph'] = new Map();
  for (const line of SLACK_EMOJIS.split('\n')) {
    const [name, points, toned] = line.split('\t');
    if (name === undefined || points === undefined || toned === undefined) continue;
    const base = glyph(points);
    const tones = toned === '-' ? null : toned.split(',').map(glyph);
    if (!byGlyph.has(bare(base))) byGlyph.set(bare(base), { name, tone: null });
    tones?.forEach((g, i) => {
      if (!byGlyph.has(bare(g))) byGlyph.set(bare(g), { name, tone: i + 2 });
    });
    byName.set(name, { base, tones });
  }
  table = { byName, byGlyph };
  return table;
}

/** A Slack emoji (`name`, or `name::skin-tone-N` as reactions write it) to its glyph. */
export function glyphOf(code: string): string | null {
  const trimmed = code.replace(/^:+|:+$/g, '');
  const at = trimmed.indexOf(TONE);
  const name = at < 0 ? trimmed : trimmed.slice(0, at);
  const tone = at < 0 ? null : Number(trimmed.slice(at + TONE.length));
  const entry = slack().byName.get(name);
  if (entry === undefined) return null;
  return tone !== null && tone >= 2 && tone <= 6 && entry.tones !== null ? entry.tones[tone - 2]! : entry.base;
}

/** `:name:` and `:name::skin-tone-N:` into their glyphs; any other `:word:` stays. */
export function replaceSlackEmojis(text: string): string {
  return text.replace(/:([a-z0-9_+'-]+):(?::skin-tone-([2-6]):)?/gi, (match, name: string, tone?: string) =>
    glyphOf(tone === undefined ? name : `${name}${TONE}${tone}`) ?? match);
}

/** A Slack reaction name as the app's reaction code: its own shortcode for the same glyph, else the name. */
export function reactionCode(name: string): string {
  const g = glyphOf(name);
  return (g === null ? null : shortcodeOfUnicode(g)) ?? name;
}

/** Whether Slack has a name for the code's emoji: a reaction with no name is refused. */
export function slackReactable(code: string): boolean {
  const trimmed = code.replace(/^:+|:+$/g, '');
  if (slack().byName.has(trimmed)) return true;
  const g = unicodeOfShortcode(trimmed);
  return g !== null && slack().byGlyph.has(bare(g));
}

/** The app's reaction code as Slack's name (`name` or `name::skin-tone-N`), else the code itself. */
export function slackName(code: string): string {
  const trimmed = code.replace(/^:+|:+$/g, '');
  if (slack().byName.has(trimmed)) return trimmed;
  const g = unicodeOfShortcode(trimmed);
  const found = g === null ? undefined : slack().byGlyph.get(bare(g));
  if (found === undefined) return trimmed;
  return found.tone === null ? found.name : `${found.name}${TONE}${found.tone}`;
}
