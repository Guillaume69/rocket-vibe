/**
 * Choice of a message's markdown tree, and its flattening to plain text.
 *
 * The server pre-parses every message into `msg.md`: the preferred source,
 * guaranteed consistent with what other clients show. **But `md` is missing
 * from old messages** (older than its introduction) and could be corrupted in
 * the database: falling back to a local `parse()` is not optional, it is the
 * contract of step 4.3.
 *
 * Pure module, no React: the choice logic and the flattening are testable under
 * Node. The nested <Text> rendering lives in `ui/markdown.tsx`.
 */

import { parse, type Root } from '@rocket.chat/message-parser';

import { withoutQuoteLinks } from './quote.ts';
import { unicodeOfShortcode } from './emojis.ts';

export type { Root };

/**
 * The character of an `EMOJI` node, or `null` if it is not one.
 *
 * The server delivers either `unicode` (the author typed the glyph) or an
 * UNVALIDATED `shortCode`: the parser accepts `:anything:`. So this is where,
 * and nowhere else, "emoji or not" is decided: rendering uses it to refuse to
 * enlarge a `BIG_EMOJI` that is not one.
 */
export function unicodeDEmoji(node: unknown): string | null {
  if (typeof node !== 'object' || node === null) return null;
  const n = node as { type?: unknown; unicode?: unknown; shortCode?: unknown };
  if (n.type !== 'EMOJI') return null;
  if (typeof n.unicode === 'string') return n.unicode;
  if (typeof n.shortCode === 'string') return unicodeOfShortcode(n.shortCode);
  return null;
}

/** A plausible node: an object with a string `type`. Anything else is poison. */
function plausibleNode(n: unknown): boolean {
  return typeof n === 'object' && n !== null && typeof (n as { type?: unknown }).type === 'string';
}

export function messageTree(md: string | null, text: string | null): Root | null {
  // A quote's permalink (`[ ](…?msg=…)`) is stripped from the body: the quote
  // renders separately (`message_link` attachment), and for an optimistic send,
  // as the local preview. A message that was ONLY the quote returns null.
  const stripped = (tree: Root): Root | null => {
    const filter = withoutQuoteLinks(tree);
    return filter.length > 0 ? filter : null;
  };
  if (md !== null) {
    try {
      const tree = JSON.parse(md) as Root;
      // The shape of the ELEMENTS matters as much as the array's: a `[null]`
      // or a node without `type` would reach rendering and crash the whole
      // screen, durably, since `md` is persisted. Re-parsing the text is
      // better: the content survives.
      if (Array.isArray(tree) && tree.length > 0 && tree.every(plausibleNode)) {
        return stripped(tree);
      }
    } catch {
      // Unreadable `md`: fall back to the text, as if it did not exist.
    }
  }
  if (text !== null && text.trim() !== '') {
    try {
      return stripped(parse(text));
    } catch {
      // The parser (generated PEG grammar) may throw on input it does not
      // consume: raw text beats a dead screen.
      return [{ type: 'PARAGRAPH', value: [{ type: 'PLAIN_TEXT', value: text }] }];
    }
  }
  return null;
}

/**
 * Plain text of a node, recursively. The last-resort fallback: a node type the
 * renderer does not know must show its content, not disappear.
 */
export function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node !== null) {
    const obj = node as {
      type?: unknown;
      value?: unknown;
      shortCode?: unknown;
      unicode?: unknown;
      fallback?: unknown;
    };
    if (obj.type === 'EMOJI') {
      const glyph = unicodeDEmoji(obj);
      // Unknown short code (server custom emoji, typo): the literal is
      // readable, a white square is not.
      if (glyph !== null) return glyph;
      if (typeof obj.shortCode === 'string') return `:${obj.shortCode}:`;
    }
    if (typeof obj.unicode === 'string') return obj.unicode;
    const byValue = 'value' in obj ? textOf(obj.value) : '';
    if (byValue !== '') return byValue;
    // TIMESTAMP (and the like): `value` is an opaque object, but the parser
    // provides `fallback`, a Plain node meant for exactly this case.
    if ('fallback' in obj) return textOf(obj.fallback);
  }
  return '';
}

function online(node: unknown): string {
  if (Array.isArray(node)) return node.map(online).join('');
  if (typeof node !== 'object' || node === null) return textOf(node);
  const n = node as { type?: unknown; value?: unknown };
  const value = n.value as { src?: unknown; label?: unknown } | undefined;
  switch (n.type) {
    case 'LINK': {
      const label = online(value?.label ?? []).trim();
      return label !== '' ? label : textOf(value?.src);
    }
    case 'MENTION_USER':
      return `@${textOf(n.value)}`;
    case 'MENTION_CHANNEL':
      return `#${textOf(n.value)}`;
    case 'CODE':
    case 'QUOTE':
      return Array.isArray(n.value) ? n.value.map(online).join(' ') : textOf(n.value);
    case 'UNORDERED_LIST':
    case 'ORDERED_LIST':
    case 'TASKS':
      return Array.isArray(n.value)
        ? n.value.map((item) => `• ${online((item as { value?: unknown }).value)}`).join(' ')
        : '';
    case 'BIG_EMOJI':
      return Array.isArray(n.value) ? n.value.map(textOf).join(' ') : textOf(n.value);
    case 'LINE_BREAK':
      return ' ';
    case 'EMOJI':
    case 'PLAIN_TEXT':
      return textOf(node);
    default:
      return 'value' in n ? online(n.value) : textOf(node);
  }
}

/** A message on one line, without syntax: the room list preview. */
export function textPreview(text: string): string {
  const tree = messageTree(null, text);
  if (tree === null) return text;
  return tree.map(online).join(' ').replace(/\s+/g, ' ').trim();
}
