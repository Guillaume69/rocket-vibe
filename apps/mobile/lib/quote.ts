/**
 * Message quoting ("reply-quote"), Rocket.Chat's NATIVE mechanism.
 *
 * A message starting with `[ ](https://server/path?msg=<id>)` is recognized by
 * the server (BeforeSaveJumpToMessage hook): it attaches the quoted message as
 * an attachment (`message_link`, `author_name`, `text`) and marks the URL
 * `ignoreParse` (no OpenGraph preview). Nothing to invent client-side: our
 * quotes therefore also show in the official app, and vice versa.
 *
 * Pure module, no React or network: everything is testable under Node.
 */

import type { Paragraph, Root } from '@rocket.chat/message-parser';

/**
 * Permalink of a message, in the official clients' canonical format:
 * `/channel/<name>` (public), `/group/<name>` (private), `/direct/<rid>` (DM).
 * The server only checks "starts with Site_Url and carries `?msg=`", but the
 * canonical path keeps the link navigable in other clients.
 *
 * Hence `siteUrl`: built on `baseUrl` alone, the link was not recognized as
 * soon as it differed from the server setting (proxy alias, IP, port: the
 * emulator bench case, `10.0.2.2:3300` vs `localhost:3300`). Worse than a
 * missing quote: the optimistic display SHOWED it, then the server echo
 * overwrote `attachments` and rendering stripped the raw link from the body, so
 * the final message carried no trace of what it replied to.
 */
export function messagePermalink(options: {
  baseUrl: string;
  /** The session's `Site_Url`; null (setting or older session): falls back to `baseUrl`. */
  siteUrl: string | null;
  /** Rocket.Chat room type: `c`, `p` or `d`. */
  type: string;
  /** The room's `name`; null for a DM. */
  name: string | null;
  rid: string;
  msgId: string;
}): string {
  const base = (options.siteUrl ?? options.baseUrl).replace(/\/+$/, '');
  const path =
    options.type === 'c'
      ? `channel/${encodeURIComponent(options.name ?? options.rid)}`
      : options.type === 'p'
        ? `group/${encodeURIComponent(options.name ?? options.rid)}`
        : `direct/${encodeURIComponent(options.rid)}`;
  return `${base}/${path}?msg=${encodeURIComponent(options.msgId)}`;
}

/** The text to send: the invisible permalink first, the reply after. */
export function quote(permalink: string, text: string): string {
  return text === '' ? `[ ](${permalink})` : `[ ](${permalink}) ${text}`;
}

/** A `[ ](…?msg=…)` link at the START of the text, repeated for quote chains. */
const QUOTE_PREFIX = /^\s*\[ ?\]\(https?:\/\/[^)\s]+[?&]msg=[^)\s]*\)\s*/;

/**
 * Strips the leading quote permalink(s) from a RAW text, for the displayed
 * excerpt (reply banner, quote block): the quoted message may itself be a
 * reply, we only want to show its words.
 */
export function stripQuotePrefix(text: string): string {
  let rest = text;
  for (;;) {
    const next = rest.replace(QUOTE_PREFIX, '');
    if (next === rest) return rest;
    rest = next;
  }
}

/**
 * The server criterion (`isQuoteAttachment`): an attachment carrying
 * `message_link` is a quote. Everything else (image, audio, file) is not.
 */
export function isQuoteAttachment(attachment: unknown): boolean {
  return (
    typeof attachment === 'object' &&
    attachment !== null &&
    typeof (attachment as { message_link?: unknown }).message_link === 'string'
  );
}

/** Rendering depth of nested quotes: what the server produces with the default
 *  `Message_QuoteChainLimit` (2), and what the official app shows. */
export const MAX_QUOTE_DEPTH = 2;

/**
 * The LOCAL quote attachment (serialized `attachments` JSON), for the
 * optimistic display: same shape as the server's `createQuoteAttachment`
 * (8.5.1), same chain length. The quoted message's attachments are kept as is
 * (its images show in the block), its own quotes kept but purged of THEIR
 * quotes: level 3, which the server also strips (`recursiveRemoveAttachments`,
 * limit 2).
 */
export function localQuoteAttachment(options: {
  permalink: string;
  author: string | null;
  text: string | null;
  /** The quoted message's `attachments` (JSON), as stored. */
  attachments: string | null;
}): string {
  let nested: unknown[] = [];
  try {
    const raw = JSON.parse(options.attachments ?? '[]') as unknown;
    if (Array.isArray(raw)) nested = raw;
  } catch {
    // Unreadable: quote without attachments, the text stays.
  }
  const cleaned = nested.map((attachment) => {
    if (!isQuoteAttachment(attachment)) return attachment;
    const { attachments, ...rest } = attachment as Record<string, unknown>;
    const files = Array.isArray(attachments)
      ? attachments.filter((a) => !isQuoteAttachment(a))
      : [];
    return files.length > 0 ? { ...rest, attachments: files } : rest;
  });
  return JSON.stringify([
    {
      message_link: options.permalink,
      ...(options.author === null ? {} : { author_name: options.author }),
      text: options.text ?? '',
      attachments: cleaned,
    },
  ]);
}

/**
 * The (relative) URL of the quoted message's first image: the thumbnail of the
 * "Reply to …" banner. Nested quotes are ignored: we show what the quoted
 * person POSTED, not what they quoted.
 */
export function firstAttachmentImage(attachments: string | null): string | null {
  try {
    const raw = JSON.parse(attachments ?? '[]') as unknown;
    if (!Array.isArray(raw)) return null;
    for (const attachment of raw) {
      if (isQuoteAttachment(attachment)) continue;
      const image = (attachment as { image_url?: unknown } | null)?.image_url;
      if (typeof image === 'string') return image;
    }
  } catch {
    // Unreadable: no thumbnail.
  }
  return null;
}

type InlineNode = { type?: unknown; value?: unknown };

/** Minimal local flattening (avoids importing markdown.ts: it imports us). */
function flatText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flatText).join('');
  if (typeof node === 'object' && node !== null && 'value' in node) {
    return flatText((node as InlineNode).value);
  }
  return '';
}

/** A LINK node with an empty/blank label and a target carrying `msg=`: a
 *  quote permalink. It only renders an underlined space, noise. */
function isQuoteLink(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as { type?: unknown; value?: { src?: unknown; label?: unknown } };
  if (n.type !== 'LINK') return false;
  const src = flatText(n.value?.src);
  if (!/[?&]msg=/.test(src)) return false;
  return flatText(n.value?.label).trim() === '';
}

/**
 * Strips quote permalinks from a markdown tree before rendering: the quote is
 * shown separately (`message_link` attachment), the link in the body would
 * only be an underlined space followed by a blank. Returns the tree UNCHANGED
 * (same reference) when there is nothing to strip: the case of almost every
 * message, at no cost.
 */
export function withoutQuoteLinks(tree: Root): Root {
  if (!tree.some((block) => isParagraphWithQuote(block))) return tree;

  // `Root` is a tuple union (`[BigEmoji] | …`): build on the ELEMENT type. A
  // `[BigEmoji]` tree never has a quote, never mapped here.
  const blocks: Root[number][] = [];
  for (const block of tree) {
    if (!isParagraphWithQuote(block)) {
      blocks.push(block);
      continue;
    }
    const paragraph = block as Paragraph;
    const remaining = paragraph.value.filter((n) => !isQuoteLink(n));
    // The space after the permalink belongs to the syntax, not the message.
    const first = remaining[0] as InlineNode | undefined;
    if (first !== undefined && first.type === 'PLAIN_TEXT' && typeof first.value === 'string') {
      const adjusted = first.value.replace(/^\s+/, '');
      if (adjusted === '') remaining.shift();
      else remaining[0] = { ...first, value: adjusted } as Paragraph['value'][number];
    }
    // A message that was ONLY the permalink: the paragraph disappears.
    if (remaining.length > 0) blocks.push({ ...paragraph, value: remaining });
  }
  return blocks as Root;
}

function isParagraphWithQuote(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as { type?: unknown; value?: unknown };
  return b.type === 'PARAGRAPH' && Array.isArray(b.value) && b.value.some(isQuoteLink);
}
