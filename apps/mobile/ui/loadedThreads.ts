/**
 * Quels FILS ont déjà reçu leur chargement d'ouverture, et sous quelle
 * génération de connexion. Même raisonnement que [[salonsCharges]] — mais le
 * gaspillage qu'il évite est plus gros, pas plus petit.
 *
 * L'effet de chargement de `app/thread/[id].tsx` a `generation` dans ses deps et
 * n'avait aucune garde : chaque raccordement — donc chaque retour au premier
 * plan, chaque flap réseau — rejouait `chat.getMessage` PUIS la pagination
 * complète de `chat.getThreadMessages` par pages de 100. Sur un fil de 300
 * réponses, 4 appels REST par raccordement sur une route plafonnée à 10/min,
 * pour ré-ingérer exactement les mêmes documents.
 *
 * Un fil n'a pas d'équivalent du filet de `ui/hotRooms.ts` : ses réponses
 * arrivent par le stream du SALON, auquel l'écran s'abonne lui-même. Le critère
 * reste donc causal et non temporel — la connexion a-t-elle tenu depuis ? Une
 * coupure, même brève, rend la garde caduque, parce que le trou peut être de
 * n'importe quelle taille.
 *
 * Store module-level : rien ne doit re-rendre l'arbre quand cette table change.
 */

import { invalidateSessionToken, sessionToken } from './sessionToken.ts';

const payloads = new Map<string, number>();

/**
 * Après un chargement de fil ABOUTI — jamais sur un échec réseau, sinon un fil
 * ouvert hors ligne resterait vide jusqu'au raccordement SUIVANT.
 *
 * `jeton` : capturé au lancement du chargement, refusé s'il a changé depuis.
 * Voir [[jetonSession]].
 */
export function markThreadLoaded(threadId: string, generation: number, token: number): void {
  if (token !== sessionToken()) return;
  payloads.set(threadId, generation);
}

export function threadLoadedUnder(threadId: string, generation: number): boolean {
  return payloads.get(threadId) === generation;
}

/** Fin de session / changement de serveur : plus rien de ce cache ne vaut. */
export function forgetLoadedThreads(): void {
  payloads.clear();
  invalidateSessionToken();
}
