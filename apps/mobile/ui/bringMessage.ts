/**
 * Amène un message dans la fenêtre locale d'un salon avant d'y sauter.
 *
 * La liste du salon projette SQLite par `ORDER BY horodatage DESC LIMIT n` :
 * pour montrer un message, il suffit que la base le contienne ET que `n`
 * dépasse son rang. Absent de la base, on remonte l'historique page par page
 * depuis le plus vieux message local — jamais une page isolée autour de lui,
 * qui laisserait un trou invisible entre elle et le reste de la liste. Borné :
 * chaque page est une requête REST, et la route est limitée à 10 par minute.
 */

import { pageMovedBack } from './roomPagination.ts';

export const MAX_JUMP_PAGES = 4;

export async function bringMessage(options: {
  ts: number;
  /** Nombre de messages du flux principal PLUS RÉCENTS que la cible, ou `null` si elle n'est pas en base. */
  rank: () => Promise<number | null>;
  /** Horodatage du plus vieux message local du salon, `null` si aucun. */
  older: () => Promise<number | null>;
  /** Charge la page d'historique antérieure à `latest` (ms). */
  loadPage: (latest: number) => Promise<{ oldest: number | null }>;
  pagesMax?: number;
}): Promise<number | null> {
  const pagesMax = options.pagesMax ?? MAX_JUMP_PAGES;
  let rank = await options.rank();
  for (let page = 0; rank === null && page < pagesMax; page++) {
    const bound = await options.older();
    // Déjà remonté au-delà de la cible sans la trouver : elle n'est pas dans
    // le flux principal (réponse de fil, message supprimé). Charger plus n'y
    // changerait rien.
    if (bound === null || bound < options.ts) return null;
    const { oldest } = await options.loadPage(bound);
    rank = await options.rank();
    if (rank === null && !pageMovedBack(oldest, bound)) return null;
  }
  return rank;
}
