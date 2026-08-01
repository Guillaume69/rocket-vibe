/**
 * Regroupement visuel des messages consécutifs d'un même auteur : la ligne qui
 * CONTINUE celle du dessus n'affiche ni avatar ni en-tête — juste son corps,
 * aligné sur la gouttière (ce que font les clients Rocket.Chat et Discord).
 * Projection PURE, extraite des écrans pour être testable sous Node ; c'est
 * `LigneMessage` (prop `suite`) qui traduit le marquage en rendu compact.
 *
 * Une ligne est une « suite » quand AUCUNE rupture ne la sépare du message
 * d'au-dessus :
 *   - auteur différent ;
 *   - plus de `FENETRE_GROUPE_MS` d'écart — sans borne de temps, une réponse
 *     des heures plus tard collerait au message d'hier sans repère ;
 *   - l'un des deux est un message SYSTÈME (« a rejoint », appel vidéo…) —
 *     sauf `e2e`, qui se rend comme un message ordinaire (déchiffré, ou son
 *     substitut « message chiffré ») et se groupe donc normalement ;
 *   - une ligne intercalée — barre « nouveaux messages », séparateur de jour :
 *     le premier non-lu comme le premier message du jour gardent leur en-tête,
 *     rien ne coupe un groupe en deux moitiés anonymes. (Le séparateur attrape
 *     aussi le cas que la fenêtre laisse passer : 23 h 58 puis 0 h 02.)
 */

/** 5 min — la valeur par défaut de `Message_GroupingPeriod` côté Rocket.Chat. */
export const FENETRE_GROUPE_MS = 5 * 60_000;

type Groupable = {
  id: string;
  auteurId: string;
  horodatage: number;
  typeSysteme: string | null;
};

/**
 * Les ids des lignes qui continuent le message d'au-dessus. `ordre` dit comment
 * lire le tableau : l'écran salon projette en DESC (`'recent-en-tete'`, liste
 * inversée), l'écran fil en ASC (`'ancien-en-tete'`) — se tromper d'ordre
 * grouperait les messages sous leur SUIVANT, pas leur précédent.
 */
export function idsSuites(
  lignes: readonly (Groupable | { id: string })[],
  ordre: 'recent-en-tete' | 'ancien-en-tete',
): Set<string> {
  const suites = new Set<string>();
  for (let i = 0; i < lignes.length; i++) {
    const courant = lignes[i];
    const precedent = lignes[ordre === 'recent-en-tete' ? i + 1 : i - 1];
    if (precedent === undefined) continue;
    if (!estMessage(courant) || !estMessage(precedent)) continue;
    if (!seGroupe(courant) || !seGroupe(precedent)) continue;
    if (courant.auteurId !== precedent.auteurId) continue;
    if (courant.horodatage - precedent.horodatage > FENETRE_GROUPE_MS) continue;
    suites.add(courant.id);
  }
  return suites;
}

function seGroupe(m: Groupable): boolean {
  return m.typeSysteme === null || m.typeSysteme === 'e2e';
}

/** Un message, par opposition aux lignes insérées (barre de non-lus, séparateur de jour). */
function estMessage(l: Groupable | { id: string }): l is Groupable {
  return typeof (l as Groupable).auteurId === 'string';
}
