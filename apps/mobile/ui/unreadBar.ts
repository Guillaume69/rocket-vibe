/**
 * La barre « nouveaux messages » de l'écran salon — la projection PURE,
 * extraite du composant pour être testable sous Node (`app/` n'a aucun test).
 *
 * Trois conventions se croisent ici, et c'est leur simultanéité qui rendait la
 * logique fragile tant qu'elle vivait dans un `useMemo` d'écran :
 *   1. les données sont DESC (le plus récent en tête) : le plus ANCIEN
 *      message non lu est donc la DERNIÈRE occurrence qui satisfait le
 *      prédicat, pas la première ;
 *   2. la liste est INVERSÉE à l'affichage : l'élément d'index i+1 se rend
 *      AU-DESSUS de l'élément i — insérer « après » place la barre au-dessus ;
 *   3. mes propres messages ne comptent pas : poster dans un salon en retard
 *      de lecture ne doit pas poser la barre sous mon message.
 * Une « optimisation » en `break` à la première occurrence poserait la barre
 * sous le message le plus récent — sans qu'aucun symptôme immédiat le dise.
 */

export type BarRow = { bar: true; id: string };

export const UNREAD_BAR_ID = 'barre-nouveaux';

/**
 * `donneesDesc` : les messages du salon, du plus récent au plus ancien.
 * `luJusquA` : l'instantané de `ls` pris au montage — `undefined` (pas encore
 * lu de la base) ou `null` (abonnement sans `ls`) rendent la liste TELLE
 * QUELLE, même référence : pas de barre sans borne de lecture.
 * `moiUid` : `undefined` quand `client.identifiants` est null ; le prédicat
 * « d'autrui » ne peut alors rien exclure et la barre peut se poser au-dessus
 * d'un de MES messages — comportement en place, consigné par les tests.
 */
export function insertUnreadBar<M extends { id: string; ts: number; authorId: string }>(
  dataDesc: M[],
  lastSeen: number | null | undefined,
  myUid: string | undefined,
): (M | BarRow)[] {
  if (typeof lastSeen !== 'number') return dataDesc;
  let firstUnread = -1;
  for (let i = 0; i < dataDesc.length; i++) {
    const m = dataDesc[i];
    if (m.ts > lastSeen && m.authorId !== myUid) firstUnread = i;
  }
  if (firstUnread === -1) return dataDesc;
  return [
    ...dataDesc.slice(0, firstUnread + 1),
    { bar: true, id: UNREAD_BAR_ID },
    ...dataDesc.slice(firstUnread + 1),
  ];
}
