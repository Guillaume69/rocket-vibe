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

import { unicodeDeCodeCourt } from './emojis.ts';

export type { Root };

/**
 * Le caractère d'un nœud `EMOJI`, ou `null` si ce n'en est pas un.
 *
 * Le serveur livre soit `unicode` (l'auteur a tapé le glyphe), soit un
 * `shortCode` NON VALIDÉ — le parseur accepte `:n_importe_quoi:`. C'est donc
 * ici, et nulle part ailleurs, qu'on tranche « emoji ou pas » : le rendu s'en
 * sert pour refuser de grossir un `BIG_EMOJI` qui n'en est pas un.
 */
export function unicodeDEmoji(noeud: unknown): string | null {
  if (typeof noeud !== 'object' || noeud === null) return null;
  const n = noeud as { type?: unknown; unicode?: unknown; shortCode?: unknown };
  if (n.type !== 'EMOJI') return null;
  if (typeof n.unicode === 'string') return n.unicode;
  if (typeof n.shortCode === 'string') return unicodeDeCodeCourt(n.shortCode);
  return null;
}

/** Un nœud plausible : un objet avec un `type` chaîne. Le reste est du poison. */
function noeudPlausible(n: unknown): boolean {
  return typeof n === 'object' && n !== null && typeof (n as { type?: unknown }).type === 'string';
}

export function arbreDuMessage(md: string | null, texte: string | null): Root | null {
  if (md !== null) {
    try {
      const arbre = JSON.parse(md) as Root;
      // La forme des ÉLÉMENTS compte autant que celle du tableau : un
      // `[null]` ou un nœud sans `type` passerait jusqu'au rendu et
      // planterait l'écran entier — durablement, puisque le `md` est
      // persisté. On préfère re-parser le texte : le contenu survit.
      if (Array.isArray(arbre) && arbre.length > 0 && arbre.every(noeudPlausible)) return arbre;
    } catch {
      // `md` illisible : on retombe sur le texte, comme s'il n'existait pas.
    }
  }
  if (texte !== null && texte.trim() !== '') {
    try {
      return parse(texte);
    } catch {
      // Le parseur (grammaire PEG générée) peut lever sur une entrée qu'il ne
      // consomme pas : le texte brut vaut mieux qu'un écran mort.
      return [{ type: 'PARAGRAPH', value: [{ type: 'PLAIN_TEXT', value: texte }] }];
    }
  }
  return null;
}

/**
 * Texte brut d'un nœud, récursivement. Sert d'ultime repli : un type de nœud
 * que le rendu ne connaît pas doit afficher son contenu, pas disparaître.
 */
export function texteDe(noeud: unknown): string {
  if (typeof noeud === 'string') return noeud;
  if (Array.isArray(noeud)) return noeud.map(texteDe).join('');
  if (typeof noeud === 'object' && noeud !== null) {
    const objet = noeud as {
      type?: unknown;
      value?: unknown;
      shortCode?: unknown;
      unicode?: unknown;
      fallback?: unknown;
    };
    if (objet.type === 'EMOJI') {
      const glyphe = unicodeDEmoji(objet);
      // Code court inconnu (emoji personnalisé du serveur, coquille) : le
      // littéral se lit, un carré blanc non.
      if (glyphe !== null) return glyphe;
      if (typeof objet.shortCode === 'string') return `:${objet.shortCode}:`;
    }
    if (typeof objet.unicode === 'string') return objet.unicode;
    const parValue = 'value' in objet ? texteDe(objet.value) : '';
    if (parValue !== '') return parValue;
    // TIMESTAMP (et consorts) : `value` est un objet opaque, mais le parseur
    // fournit `fallback`, un nœud Plain prévu exactement pour ce cas.
    if ('fallback' in objet) return texteDe(objet.fallback);
  }
  return '';
}
