/**
 * Les prédicats d'épuisement de la pagination d'historique — extraits de
 * `chargerPlus` (écran salon) pour être testables sous Node.
 *
 * Ils encodent deux leçons payées en 429 :
 *
 *   - `inclusive: true` renvoie la borne ET tous ses jumeaux de la même
 *     milliseconde (rafale de bot, import). « La page contient plus d'un
 *     message » ne prouve donc PAS qu'elle a reculé : un groupe d'ex æquo en
 *     queue d'historique gardait `n > 1` pour toujours, `passeEpuise` jamais
 *     armé, et la ré-ingestion re-déclenchait `onEndReached` (FlashList v2 le
 *     réarme à CHAQUE changement de data) — boucle auto-entretenue jusqu'au
 *     429. Le seul critère fiable : un message STRICTEMENT plus ancien que la
 *     borne (`pageARecule`).
 *
 *   - Et comme filet indépendant du contenu des réponses : si le
 *     message-borne n'a pas changé après deux pages consécutives, la
 *     pagination n'avance plus, quoi qu'en disent les réponses
 *     (`avancerBorne` + `borneImmobile`).
 */

/** Le message-borne courant et le nombre de pages demandées SUR cette borne. */
export type PaginationBound = { id: string; pages: number };

/** Pages tolérées sur une borne immobile avant de déclarer le passé épuisé. */
export const MAX_PAGES_AT_BOUND = 2;

/** À chaque demande de page : même borne → on compte ; borne neuve → repart à 1. */
export function advanceBound(
  previous: PaginationBound | null,
  oldestId: string,
): PaginationBound {
  return previous !== null && previous.id === oldestId
    ? { id: oldestId, pages: previous.pages + 1 }
    : { id: oldestId, pages: 1 };
}

/** Vrai quand la borne a déjà consommé ses pages : le passé est déclaré épuisé. */
export function boundIsStuck(bound: PaginationBound): boolean {
  return bound.pages > MAX_PAGES_AT_BOUND;
}

/**
 * Vrai si la page a VRAIMENT reculé dans le passé : elle contient un message
 * strictement plus ancien que la borne demandée. `plusAncienDeLaPage` est
 * `null` pour une page vide.
 */
export function pageMovedBack(
  pageOldest: number | null,
  horodatageBorne: number,
): boolean {
  return pageOldest !== null && pageOldest < horodatageBorne;
}
