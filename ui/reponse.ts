/**
 * Cible de réponse (citation) — canal entre la feuille d'actions et le composer.
 *
 * Même famille que `sourcePieceJointe`, mais en ÉTAT OBSERVABLE plutôt qu'en
 * promesse : la feuille arme la cible puis se ferme ; le composer, monté bien
 * avant, l'affiche dans son bandeau tant qu'elle vit — annulée (✕, back), ou
 * soldée par l'envoi. Clé = `rid` pour le salon, `rid:filId` pour un fil : les
 * deux composers peuvent coexister (le fil est empilé sur le salon) sans se
 * voler la cible. Mémoire seule, volontairement : contrairement au brouillon,
 * une citation en suspens ne survit pas au redémarrage.
 */

import { useSyncExternalStore } from 'react';

export type CibleReponse = {
  /** `_id` du message cité. */
  id: string;
  /** Username de l'auteur cité — l'instantané suffit pour un bandeau. */
  auteur: string | null;
  /** Extrait du texte cité, déjà purgé de son propre permalien de citation. */
  apercu: string | null;
  /** Permalien `?msg=` — deviendra le préfixe `[ ](…)` à l'envoi. */
  permalien: string;
  /** Pièce jointe de citation prête pour l'affichage optimiste
   *  (`jointeCitationLocale`) — pièces du cité incluses, chaîne taillée à 2. */
  jointeLocale: string;
  /** URL (relative) de la première image du cité — vignette du bandeau. */
  imageApercu: string | null;
};

const cibles = new Map<string, CibleReponse>();
const abonnes = new Set<() => void>();

function notifier(): void {
  for (const abonne of abonnes) abonne();
}

export function demanderReponse(cle: string, cible: CibleReponse): void {
  cibles.set(cle, cible);
  notifier();
}

export function annulerReponse(cle: string): void {
  if (cibles.delete(cle)) notifier();
}

function souscrire(relire: () => void): () => void {
  abonnes.add(relire);
  return () => {
    abonnes.delete(relire);
  };
}

/** La cible armée pour cette clé, `null` sinon. Se met à jour toute seule. */
export function useReponse(cle: string): CibleReponse | null {
  return useSyncExternalStore(souscrire, () => cibles.get(cle) ?? null);
}
