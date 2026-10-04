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

export type LigneJour = { jour: true; id: string; horodatage: number };

/** Jour calendaire LOCAL (fuseau de l'appareil), comparable et triable. */
export function cleJour(ms: number): number {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * `ordre` : comme `idsSuites` — l'écran salon projette en DESC
 * (`'recent-en-tete'`), l'écran fil en ASC (`'ancien-en-tete'`). Sans
 * frontière de jour, la MÊME référence est rendue : le useMemo de l'écran ne
 * re-rend pas pour rien.
 */
export function insererSeparateursJour<L extends { id: string }>(
  lignes: L[],
  ordre: 'recent-en-tete' | 'ancien-en-tete',
): (L | LigneJour)[] {
  const resultat: (L | LigneJour)[] = [];
  let precedent: { horodatage: number } | null = null;
  for (const ligne of lignes) {
    if (estMessage(ligne)) {
      if (precedent !== null && cleJour(ligne.horodatage) !== cleJour(precedent.horodatage)) {
        // Le séparateur titre le jour du message le plus RÉCENT de la
        // frontière : celui déjà poussé en DESC, celui qui arrive en ASC.
        const recent = ordre === 'recent-en-tete' ? precedent : ligne;
        resultat.push({
          jour: true,
          id: `jour-${cleJour(recent.horodatage)}`,
          horodatage: recent.horodatage,
        });
      }
      precedent = ligne;
    }
    resultat.push(ligne);
  }
  return resultat.length === lignes.length ? lignes : resultat;
}

/** Un message, par opposition aux lignes déjà insérées (barre de non-lus). */
function estMessage<L extends { id: string }>(l: L): l is L & { horodatage: number } {
  return typeof (l as { horodatage?: unknown }).horodatage === 'number';
}
