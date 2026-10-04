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

import { pageARecule } from './roomPagination.ts';

export const PAGES_MAX_SAUT = 4;

export async function amenerMessage(options: {
  horodatage: number;
  /** Nombre de messages du flux principal PLUS RÉCENTS que la cible, ou `null` si elle n'est pas en base. */
  rang: () => Promise<number | null>;
  /** Horodatage du plus vieux message local du salon, `null` si aucun. */
  plusVieux: () => Promise<number | null>;
  /** Charge la page d'historique antérieure à `latest` (ms). */
  chargerPage: (latest: number) => Promise<{ plusAncien: number | null }>;
  pagesMax?: number;
}): Promise<number | null> {
  const pagesMax = options.pagesMax ?? PAGES_MAX_SAUT;
  let rang = await options.rang();
  for (let page = 0; rang === null && page < pagesMax; page++) {
    const borne = await options.plusVieux();
    // Déjà remonté au-delà de la cible sans la trouver : elle n'est pas dans
    // le flux principal (réponse de fil, message supprimé). Charger plus n'y
    // changerait rien.
    if (borne === null || borne < options.horodatage) return null;
    const { plusAncien } = await options.chargerPage(borne);
    rang = await options.rang();
    if (rang === null && !pageARecule(plusAncien, borne)) return null;
  }
  return rang;
}
