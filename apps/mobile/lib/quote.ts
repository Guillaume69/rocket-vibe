/**
 * Citation d'un message (« reply-quote ») — le mécanisme NATIF de Rocket.Chat.
 *
 * Un message qui commence par `[ ](https://serveur/chemin?msg=<id>)` est reconnu
 * par le serveur (hook BeforeSaveJumpToMessage) : il attache le message cité en
 * pièce jointe (`message_link`, `author_name`, `text`) et marque l'URL
 * `ignoreParse` (pas d'aperçu OpenGraph). Rien à inventer côté client : nos
 * citations s'affichent donc aussi dans l'app officielle, et réciproquement.
 *
 * Module pur, sans React ni réseau — tout se teste sous Node.
 */

import type { Paragraph, Root } from '@rocket.chat/message-parser';

/**
 * Permalien d'un message, au format canonique des clients officiels :
 * `/channel/<nom>` (public), `/group/<nom>` (privé), `/direct/<rid>` (DM).
 * Le serveur ne regarde que « commence par Site_Url et porte `?msg= »`, mais le
 * chemin canonique garde le lien navigable dans les autres clients.
 *
 * D'où `siteUrl` : bâti sur la seule `baseUrl`, le lien n'était pas reconnu dès
 * qu'elle différait du réglage serveur (alias de proxy, IP, port — cas du banc
 * émulateur, `10.0.2.2:3300` vs `localhost:3300`). Pire qu'une citation
 * absente : l'affichage optimiste la MONTRAIT, puis l'écho serveur écrasait
 * `piecesJointes` et le rendu retirait le lien brut du corps — le message final
 * ne portait plus aucune trace de ce à quoi il répondait.
 */
export function messagePermalink(options: {
  baseUrl: string;
  /** `Site_Url` de la session — null (réglage ou session d'avant) : repli `baseUrl`. */
  siteUrl: string | null;
  /** Type Rocket.Chat du salon : `c`, `p` ou `d`. */
  type: string;
  /** `name` du salon — null pour un DM. */
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

/** Le texte à envoyer : le permalien invisible devant, la réponse derrière. */
export function quote(permalink: string, text: string): string {
  return text === '' ? `[ ](${permalink})` : `[ ](${permalink}) ${text}`;
}

/** Un lien `[ ](…?msg=…)` en TÊTE de texte — répété pour les chaînes de citations. */
const QUOTE_PREFIX = /^\s*\[ ?\]\(https?:\/\/[^)\s]+[?&]msg=[^)\s]*\)\s*/;

/**
 * Retire le(s) permalien(s) de citation en tête d'un texte BRUT — pour
 * l'extrait affiché (bandeau de réponse, bloc de citation) : le message cité
 * peut lui-même être une réponse, on ne veut montrer que ses mots.
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
 * Le critère serveur (`isQuoteAttachment`) : une pièce jointe qui porte
 * `message_link` est une citation. Tout le reste (image, audio, fichier) n'en
 * est pas.
 */
export function isQuoteAttachment(attachment: unknown): boolean {
  return (
    typeof attachment === 'object' &&
    attachment !== null &&
    typeof (attachment as { message_link?: unknown }).message_link === 'string'
  );
}

/** Profondeur de rendu des citations imbriquées — celle que produit le serveur
 *  avec `Message_QuoteChainLimit` par défaut (2), et qu'affiche l'app officielle. */
export const MAX_QUOTE_DEPTH = 2;

/**
 * La pièce jointe de citation LOCALE (JSON `attachments` sérialisé), pour
 * l'affichage optimiste — même forme que `createQuoteAttachment` côté serveur
 * (8.5.1), même taille de chaîne : les pièces du message cité sont reprises
 * telles quelles (ses images s'affichent dans le bloc), ses propres citations
 * gardées mais purgées de LEURS citations — le niveau 3, que le serveur retire
 * aussi (`recursiveRemoveAttachments`, limite 2).
 */
export function localQuoteAttachment(options: {
  permalink: string;
  author: string | null;
  text: string | null;
  /** `piecesJointes` (JSON) du message cité, tel que stocké. */
  attachments: string | null;
}): string {
  let nested: unknown[] = [];
  try {
    const raw = JSON.parse(options.attachments ?? '[]') as unknown;
    if (Array.isArray(raw)) nested = raw;
  } catch {
    // Illisible : citation sans pièces, le texte reste.
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
 * L'URL (relative) de la première image du message cité — la vignette du
 * bandeau « Réponse à … ». Les citations imbriquées sont ignorées : on montre
 * ce que la personne citée a POSTÉ, pas ce qu'elle citait.
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
    // Illisible : pas de vignette.
  }
  return null;
}

type InlineNode = { type?: unknown; value?: unknown };

/** Aplatissement local minimal (éviter d'importer markdown.ts : il nous importe). */
function flatText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flatText).join('');
  if (typeof node === 'object' && node !== null && 'value' in node) {
    return flatText((node as InlineNode).value);
  }
  return '';
}

/** Un nœud LINK dont le label est vide/blanc et la cible porte `msg=` : le
 *  permalien d'une citation — il ne rend qu'un espace souligné, du bruit. */
function isQuoteLink(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as { type?: unknown; value?: { src?: unknown; label?: unknown } };
  if (n.type !== 'LINK') return false;
  const src = flatText(n.value?.src);
  if (!/[?&]msg=/.test(src)) return false;
  return flatText(n.value?.label).trim() === '';
}

/**
 * Retire les permaliens de citation d'un arbre markdown avant rendu — la
 * citation est affichée à part (pièce jointe `message_link`), le lien dans le
 * corps ne serait qu'un espace souligné suivi d'un blanc. Rend l'arbre
 * INCHANGÉ (même référence) quand il n'y a rien à retirer — le cas de presque
 * tous les messages, aucun coût.
 */
export function withoutQuoteLinks(tree: Root): Root {
  if (!tree.some((block) => isParagraphWithQuote(block))) return tree;

  // `Root` est un tuple-union (`[BigEmoji] | …`) : on construit sur le type
  // d'ÉLÉMENT. Un arbre `[BigEmoji]` n'a jamais de citation — jamais mappé ici.
  const blocks: Root[number][] = [];
  for (const block of tree) {
    if (!isParagraphWithQuote(block)) {
      blocks.push(block);
      continue;
    }
    const paragraph = block as Paragraph;
    const remaining = paragraph.value.filter((n) => !isQuoteLink(n));
    // L'espace qui suivait le permalien appartient à la syntaxe, pas au message.
    const first = remaining[0] as InlineNode | undefined;
    if (first !== undefined && first.type === 'PLAIN_TEXT' && typeof first.value === 'string') {
      const adjusted = first.value.replace(/^\s+/, '');
      if (adjusted === '') remaining.shift();
      else remaining[0] = { ...first, value: adjusted } as Paragraph['value'][number];
    }
    // Un message qui n'était QUE le permalien : le paragraphe disparaît.
    if (remaining.length > 0) blocks.push({ ...paragraph, value: remaining });
  }
  return blocks as Root;
}

function isParagraphWithQuote(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as { type?: unknown; value?: unknown };
  return b.type === 'PARAGRAPH' && Array.isArray(b.value) && b.value.some(isQuoteLink);
}
