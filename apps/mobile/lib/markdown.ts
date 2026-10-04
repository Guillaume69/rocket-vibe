/**
 * Choix de l'arbre markdown d'un message, et son aplatissement en texte brut.
 *
 * Le serveur pré-parse chaque message dans `msg.md` — c'est la source
 * préférée, garantie cohérente avec ce que les autres clients affichent.
 * **Mais `md` est absent des vieux messages** (antérieurs à son introduction)
 * et pourrait être corrompu en base : le repli sur `parse()` local n'est pas
 * une option, c'est le contrat de l'étape 4.3.
 *
 * Module pur, sans React : la logique de choix et l'aplatissement se testent
 * sous Node. Le rendu en <Text> imbriqués vit dans `ui/markdown.tsx`.
 */

import { parse, type Root } from '@rocket.chat/message-parser';

import { withoutQuoteLinks } from './quote.ts';
import { unicodeOfShortcode } from './emojis.ts';

export type { Root };

/**
 * Le caractère d'un nœud `EMOJI`, ou `null` si ce n'en est pas un.
 *
 * Le serveur livre soit `unicode` (l'auteur a tapé le glyphe), soit un
 * `shortCode` NON VALIDÉ — le parseur accepte `:n_importe_quoi:`. C'est donc
 * ici, et nulle part ailleurs, qu'on tranche « emoji ou pas » : le rendu s'en
 * sert pour refuser de grossir un `BIG_EMOJI` qui n'en est pas un.
 */
export function unicodeDEmoji(node: unknown): string | null {
  if (typeof node !== 'object' || node === null) return null;
  const n = node as { type?: unknown; unicode?: unknown; shortCode?: unknown };
  if (n.type !== 'EMOJI') return null;
  if (typeof n.unicode === 'string') return n.unicode;
  if (typeof n.shortCode === 'string') return unicodeOfShortcode(n.shortCode);
  return null;
}

/** Un nœud plausible : un objet avec un `type` chaîne. Le reste est du poison. */
function plausibleNode(n: unknown): boolean {
  return typeof n === 'object' && n !== null && typeof (n as { type?: unknown }).type === 'string';
}

export function messageTree(md: string | null, text: string | null): Root | null {
  // Le permalien d'une citation (`[ ](…?msg=…)`) est retiré du corps : la
  // citation se rend à part (pièce jointe `message_link`) — et pour un envoi
  // optimiste, l'aperçu local. Un message qui n'était QUE la citation rend null.
  const stripped = (tree: Root): Root | null => {
    const filter = withoutQuoteLinks(tree);
    return filter.length > 0 ? filter : null;
  };
  if (md !== null) {
    try {
      const tree = JSON.parse(md) as Root;
      // La forme des ÉLÉMENTS compte autant que celle du tableau : un
      // `[null]` ou un nœud sans `type` passerait jusqu'au rendu et
      // planterait l'écran entier — durablement, puisque le `md` est
      // persisté. On préfère re-parser le texte : le contenu survit.
      if (Array.isArray(tree) && tree.length > 0 && tree.every(plausibleNode)) {
        return stripped(tree);
      }
    } catch {
      // `md` illisible : on retombe sur le texte, comme s'il n'existait pas.
    }
  }
  if (text !== null && text.trim() !== '') {
    try {
      return stripped(parse(text));
    } catch {
      // Le parseur (grammaire PEG générée) peut lever sur une entrée qu'il ne
      // consomme pas : le texte brut vaut mieux qu'un écran mort.
      return [{ type: 'PARAGRAPH', value: [{ type: 'PLAIN_TEXT', value: text }] }];
    }
  }
  return null;
}

/**
 * Texte brut d'un nœud, récursivement. Sert d'ultime repli : un type de nœud
 * que le rendu ne connaît pas doit afficher son contenu, pas disparaître.
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
      // Code court inconnu (emoji personnalisé du serveur, coquille) : le
      // littéral se lit, un carré blanc non.
      if (glyph !== null) return glyph;
      if (typeof obj.shortCode === 'string') return `:${obj.shortCode}:`;
    }
    if (typeof obj.unicode === 'string') return obj.unicode;
    const byValue = 'value' in obj ? textOf(obj.value) : '';
    if (byValue !== '') return byValue;
    // TIMESTAMP (et consorts) : `value` est un objet opaque, mais le parseur
    // fournit `fallback`, un nœud Plain prévu exactement pour ce cas.
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

/** Un message sur une ligne, sans syntaxe : l'aperçu de la liste des salons. */
export function textPreview(text: string): string {
  const tree = messageTree(null, text);
  if (tree === null) return text;
  return tree.map(online).join(' ').replace(/\s+/g, ' ').trim();
}
