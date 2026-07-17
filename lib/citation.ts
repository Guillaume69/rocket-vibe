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
 */
export function permalienMessage(options: {
  baseUrl: string;
  /** Type Rocket.Chat du salon : `c`, `p` ou `d`. */
  type: string;
  /** `name` du salon — null pour un DM. */
  nom: string | null;
  rid: string;
  msgId: string;
}): string {
  const base = options.baseUrl.replace(/\/+$/, '');
  const chemin =
    options.type === 'c'
      ? `channel/${encodeURIComponent(options.nom ?? options.rid)}`
      : options.type === 'p'
        ? `group/${encodeURIComponent(options.nom ?? options.rid)}`
        : `direct/${encodeURIComponent(options.rid)}`;
  return `${base}/${chemin}?msg=${encodeURIComponent(options.msgId)}`;
}

/** Le texte à envoyer : le permalien invisible devant, la réponse derrière. */
export function citer(permalien: string, texte: string): string {
  return texte === '' ? `[ ](${permalien})` : `[ ](${permalien}) ${texte}`;
}

/** Un lien `[ ](…?msg=…)` en TÊTE de texte — répété pour les chaînes de citations. */
const PREFIXE_CITATION = /^\s*\[ ?\]\(https?:\/\/[^)\s]+[?&]msg=[^)\s]*\)\s*/;

/**
 * Retire le(s) permalien(s) de citation en tête d'un texte BRUT — pour
 * l'extrait affiché (bandeau de réponse, bloc de citation) : le message cité
 * peut lui-même être une réponse, on ne veut montrer que ses mots.
 */
export function sansPrefixeCitation(texte: string): string {
  let restant = texte;
  for (;;) {
    const suivant = restant.replace(PREFIXE_CITATION, '');
    if (suivant === restant) return restant;
    restant = suivant;
  }
}

/**
 * Le critère serveur (`isQuoteAttachment`) : une pièce jointe qui porte
 * `message_link` est une citation. Tout le reste (image, audio, fichier) n'en
 * est pas.
 */
export function estJointeCitation(jointe: unknown): boolean {
  return (
    typeof jointe === 'object' &&
    jointe !== null &&
    typeof (jointe as { message_link?: unknown }).message_link === 'string'
  );
}

/** Profondeur de rendu des citations imbriquées — celle que produit le serveur
 *  avec `Message_QuoteChainLimit` par défaut (2), et qu'affiche l'app officielle. */
export const PROFONDEUR_MAX_CITATION = 2;

/**
 * La pièce jointe de citation LOCALE (JSON `attachments` sérialisé), pour
 * l'affichage optimiste — même forme que `createQuoteAttachment` côté serveur
 * (8.5.1), même taille de chaîne : les pièces du message cité sont reprises
 * telles quelles (ses images s'affichent dans le bloc), ses propres citations
 * gardées mais purgées de LEURS citations — le niveau 3, que le serveur retire
 * aussi (`recursiveRemoveAttachments`, limite 2).
 */
export function jointeCitationLocale(options: {
  permalien: string;
  auteur: string | null;
  texte: string | null;
  /** `piecesJointes` (JSON) du message cité, tel que stocké. */
  piecesJointes: string | null;
}): string {
  let imbriquees: unknown[] = [];
  try {
    const brut = JSON.parse(options.piecesJointes ?? '[]') as unknown;
    if (Array.isArray(brut)) imbriquees = brut;
  } catch {
    // Illisible : citation sans pièces, le texte reste.
  }
  const nettoyees = imbriquees.map((jointe) => {
    if (!estJointeCitation(jointe)) return jointe;
    const { attachments, ...reste } = jointe as Record<string, unknown>;
    const fichiers = Array.isArray(attachments)
      ? attachments.filter((a) => !estJointeCitation(a))
      : [];
    return fichiers.length > 0 ? { ...reste, attachments: fichiers } : reste;
  });
  return JSON.stringify([
    {
      message_link: options.permalien,
      ...(options.auteur === null ? {} : { author_name: options.auteur }),
      text: options.texte ?? '',
      attachments: nettoyees,
    },
  ]);
}

/**
 * L'URL (relative) de la première image du message cité — la vignette du
 * bandeau « Réponse à … ». Les citations imbriquées sont ignorées : on montre
 * ce que la personne citée a POSTÉ, pas ce qu'elle citait.
 */
export function premiereImageDesJointes(piecesJointes: string | null): string | null {
  try {
    const brut = JSON.parse(piecesJointes ?? '[]') as unknown;
    if (!Array.isArray(brut)) return null;
    for (const jointe of brut) {
      if (estJointeCitation(jointe)) continue;
      const image = (jointe as { image_url?: unknown } | null)?.image_url;
      if (typeof image === 'string') return image;
    }
  } catch {
    // Illisible : pas de vignette.
  }
  return null;
}

type NoeudInline = { type?: unknown; value?: unknown };

/** Aplatissement local minimal (éviter d'importer markdown.ts : il nous importe). */
function plat(noeud: unknown): string {
  if (typeof noeud === 'string') return noeud;
  if (Array.isArray(noeud)) return noeud.map(plat).join('');
  if (typeof noeud === 'object' && noeud !== null && 'value' in noeud) {
    return plat((noeud as NoeudInline).value);
  }
  return '';
}

/** Un nœud LINK dont le label est vide/blanc et la cible porte `msg=` : le
 *  permalien d'une citation — il ne rend qu'un espace souligné, du bruit. */
function estLienDeCitation(noeud: unknown): boolean {
  if (typeof noeud !== 'object' || noeud === null) return false;
  const n = noeud as { type?: unknown; value?: { src?: unknown; label?: unknown } };
  if (n.type !== 'LINK') return false;
  const src = plat(n.value?.src);
  if (!/[?&]msg=/.test(src)) return false;
  return plat(n.value?.label).trim() === '';
}

/**
 * Retire les permaliens de citation d'un arbre markdown avant rendu — la
 * citation est affichée à part (pièce jointe `message_link`), le lien dans le
 * corps ne serait qu'un espace souligné suivi d'un blanc. Rend l'arbre
 * INCHANGÉ (même référence) quand il n'y a rien à retirer — le cas de presque
 * tous les messages, aucun coût.
 */
export function sansLiensDeCitation(arbre: Root): Root {
  if (!arbre.some((bloc) => estParagrapheAvecCitation(bloc))) return arbre;

  // `Root` est un tuple-union (`[BigEmoji] | …`) : on construit sur le type
  // d'ÉLÉMENT. Un arbre `[BigEmoji]` n'a jamais de citation — jamais mappé ici.
  const blocs: Root[number][] = [];
  for (const bloc of arbre) {
    if (!estParagrapheAvecCitation(bloc)) {
      blocs.push(bloc);
      continue;
    }
    const paragraphe = bloc as Paragraph;
    const restants = paragraphe.value.filter((n) => !estLienDeCitation(n));
    // L'espace qui suivait le permalien appartient à la syntaxe, pas au message.
    const premier = restants[0] as NoeudInline | undefined;
    if (premier !== undefined && premier.type === 'PLAIN_TEXT' && typeof premier.value === 'string') {
      const ajuste = premier.value.replace(/^\s+/, '');
      if (ajuste === '') restants.shift();
      else restants[0] = { ...premier, value: ajuste } as Paragraph['value'][number];
    }
    // Un message qui n'était QUE le permalien : le paragraphe disparaît.
    if (restants.length > 0) blocs.push({ ...paragraphe, value: restants });
  }
  return blocs as Root;
}

function estParagrapheAvecCitation(bloc: unknown): boolean {
  if (typeof bloc !== 'object' || bloc === null) return false;
  const b = bloc as { type?: unknown; value?: unknown };
  return b.type === 'PARAGRAPH' && Array.isArray(b.value) && b.value.some(estLienDeCitation);
}
