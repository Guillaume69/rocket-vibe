/**
 * Quels salons ont déjà reçu leur historique d'ouverture, et SOUS QUELLE
 * génération de connexion.
 *
 * Le problème : l'écran salon est DÉMONTÉ quand on en sort (pile de
 * navigation). Son `useRef` de garde part avec lui, donc rentrer deux secondes
 * plus tard refaisait un `*.history?count=50` entier — ~31 Ko, plus la
 * ré-ingestion des 50 mêmes messages (150 statements SQLite), plus la barre de
 * synchro allumée le temps du fetch. Du travail intégralement redondant.
 *
 * Pourquoi une génération plutôt qu'un « il y a moins de N secondes » : ce qui
 * décide de la validité d'un cache n'est pas un délai, c'est un fait — la
 * connexion a-t-elle tenu depuis ? `generation` est incrémentée à CHAQUE
 * raccordement (`ui/sync.tsx`), donc :
 *
 *  - sortir et rentrer sans incident → même génération → aucune requête, le
 *    cache s'affiche tout de suite ;
 *  - après une coupure, même brève → génération différente → historique
 *    rechargé, parce que le trou peut être de n'importe quelle taille.
 *
 * Le rattrapage, lui, ne part QUE si le salon n'est pas resté écouté entre-temps
 * (voir [[salonChaud]]) : sur un gros salon, cette lecture met plusieurs
 * secondes à répondre « rien de neuf ».
 *
 * Store module-level, comme `ui/uploadProbe` : rien ne doit re-rendre l'arbre
 * de navigation quand cette table change.
 */

import { invalidateSessionToken, sessionToken } from './sessionToken.ts';

const payloads = new Map<string, number>();

/**
 * Après un historique d'ouverture ABOUTI — jamais sur un échec réseau.
 *
 * `jeton` est celui capturé au LANCEMENT du chargement : une réponse qui
 * atterrit après la fin de session ne doit pas repeupler un cache qu'on vient
 * de vider (voir [[jetonSession]]). Sans lui, la marque survivait à la session,
 * et la suivante sautait l'historique d'ouverture du salon dès que son compteur
 * de génération — reparti de 0 — atteignait la valeur mémorisée.
 */
export function markRoomLoaded(rid: string, generation: number, token: number): void {
  if (token !== sessionToken()) return;
  payloads.set(rid, generation);
}

export function roomLoadedUnder(rid: string, generation: number): boolean {
  return payloads.get(rid) === generation;
}

/** Fin de session / changement de serveur : plus rien de ce cache ne vaut. */
export function forgetLoadedRooms(): void {
  payloads.clear();
  invalidateSessionToken();
}
