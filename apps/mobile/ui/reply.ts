/**
 * Cible de réponse (citation) — canal entre la feuille d'actions et le composer.
 *
 * Même famille que `sourcePieceJointe`, mais en ÉTAT OBSERVABLE plutôt qu'en
 * promesse : la feuille arme la cible puis se ferme ; le composer, monté bien
 * avant, l'affiche dans son bandeau tant qu'elle vit — annulée (✕, back), ou
 * soldée par l'envoi. Clé = `rid` pour le salon, `rid:filId` pour un fil : les
 * deux composers peuvent coexister (le fil est empilé sur le salon) sans se
 * voler la cible. Mémoire seule, volontairement : contrairement au brouillon,
 * une citation en suspens ne survit ni au redémarrage ni à la FIN DE SESSION.
 *
 * Le « ni à la fin de session » a longtemps été une intention, pas un fait :
 * une déconnexion ne démonte que l'arbre React, elle n'efface pas un store de
 * module. Le permalien retenu embarque la `baseUrl` (`lib/quote.ts`), donc
 * le premier message tapé après reconnexion partait préfixé du permalien de la
 * session précédente — l'ancien serveur cité dans un message posté sur le
 * nouveau. D'où `oublierReponses`, appelé au démontage de `SynchroProvider`.
 */

import { useSyncExternalStore } from 'react';

export type ReplyTarget = {
  /** `_id` du message cité. */
  id: string;
  /** Username de l'auteur cité — l'instantané suffit pour un bandeau. */
  author: string | null;
  /** Extrait du texte cité, déjà purgé de son propre permalien de citation. */
  preview: string | null;
  /** Permalien `?msg=` — deviendra le préfixe `[ ](…)` à l'envoi. */
  permalink: string;
  /** Pièce jointe de citation prête pour l'affichage optimiste
   *  (`jointeCitationLocale`) — pièces du cité incluses, chaîne taillée à 2. */
  localAttachment: string;
  /** URL (relative) de la première image du cité — vignette du bandeau. */
  previewImage: string | null;
};

const targets = new Map<string, ReplyTarget>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

export function requestReply(key: string, target: ReplyTarget): void {
  targets.set(key, target);
  notify();
}

export function cancelReply(key: string): void {
  if (targets.delete(key)) notify();
}

/** Fin de session / changement de serveur : aucune citation ne traverse. */
export function forgetReplies(): void {
  if (targets.size === 0) return;
  targets.clear();
  notify();
}

function subscribe(reread: () => void): () => void {
  subscribers.add(reread);
  return () => {
    subscribers.delete(reread);
  };
}

/** La cible armée pour cette clé, `null` sinon. Se met à jour toute seule. */
export function useReply(key: string): ReplyTarget | null {
  return useSyncExternalStore(subscribe, () => targets.get(key) ?? null);
}
