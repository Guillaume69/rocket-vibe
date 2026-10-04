/**
 * Séparateurs de jour dans les listes de messages : sans eux, « 12:00 » puis
 * « 12:30 » se lisent comme une demi-heure d'écart alors qu'un jour entier a pu
 * passer — l'heure seule ne porte pas la date. Projection PURE, testable sous
 * Node ; le rendu (trait + libellé « Aujourd'hui » / « Hier » / date) vit dans
 * `ui/kit.tsx`, le libellé dans `formateurJour` (ui/messages.ts).
 *
 * Un séparateur s'insère ENTRE deux messages chargés de jours locaux
 * différents, titré du jour du plus récent — jamais au-dessus du plus ancien
 * chargé : la page d'historique pas encore chargée peut continuer le même
 * jour, un séparateur là mentirait une fois la page arrivée. Les lignes
 * non-message déjà insérées (barre « nouveaux messages ») restent en place ;
 * à une frontière commune, le séparateur se pose AU-DESSUS de la barre — le
 * jour est plus structurel que l'état de lecture.
 */

export type DayRow = { day: true; id: string; ts: number };

/** Jour calendaire LOCAL (fuseau de l'appareil), comparable et triable. */
export function dayKey(ms: number): number {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * `ordre` : comme `idsSuites` — l'écran salon projette en DESC
 * (`'recent-en-tete'`), l'écran fil en ASC (`'ancien-en-tete'`). Sans
 * frontière de jour, la MÊME référence est rendue : le useMemo de l'écran ne
 * re-rend pas pour rien.
 */
export function insertDaySeparators<L extends { id: string }>(
  rows: L[],
  order: 'newest-first' | 'oldest-first',
): (L | DayRow)[] {
  const result: (L | DayRow)[] = [];
  let prev: { ts: number } | null = null;
  for (const row of rows) {
    if (isMessage(row)) {
      if (prev !== null && dayKey(row.ts) !== dayKey(prev.ts)) {
        // Le séparateur titre le jour du message le plus RÉCENT de la
        // frontière : celui déjà poussé en DESC, celui qui arrive en ASC.
        const recent = order === 'newest-first' ? prev : row;
        result.push({
          day: true,
          id: `jour-${dayKey(recent.ts)}`,
          ts: recent.ts,
        });
      }
      prev = row;
    }
    result.push(row);
  }
  return result.length === rows.length ? rows : result;
}

/** Un message, par opposition aux lignes déjà insérées (barre de non-lus). */
function isMessage<L extends { id: string }>(l: L): l is L & { ts: number } {
  return typeof (l as { ts?: unknown }).ts === 'number';
}
