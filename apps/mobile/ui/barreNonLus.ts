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

export type LigneBarre = { barre: true; id: string };

export const ID_BARRE_NON_LUS = 'barre-nouveaux';

/** Same divider and inverted layout, using the opening native sequence. */
export function insererBarreNonLusNative<M extends {id:string;auteurId:string;typeSysteme?:string|null}>(donneesDesc:M[],position:string|null|undefined,positions:ReadonlyMap<string,string>,moi:string):(M|LigneBarre)[] {
  if(position==null)return donneesDesc;
  const seen=BigInt(position);
  let first=-1;
  for(let i=0;i<donneesDesc.length;i++) {
    const row=donneesDesc[i],value=positions.get(row.id);
    if(value!==undefined && row.typeSysteme==null && row.auteurId!==moi && BigInt(value)>seen)first=i;
  }
  return first===-1?donneesDesc:[...donneesDesc.slice(0,first+1),{barre:true,id:ID_BARRE_NON_LUS},...donneesDesc.slice(first+1)];
}

/**
 * `donneesDesc` : les messages du salon, du plus récent au plus ancien.
 * `luJusquA` : l'instantané de `ls` pris au montage — `undefined` (pas encore
 * lu de la base) ou `null` (abonnement sans `ls`) rendent la liste TELLE
 * QUELLE, même référence : pas de barre sans borne de lecture.
 * `moiUid` : `undefined` quand `client.identifiants` est null ; le prédicat
 * « d'autrui » ne peut alors rien exclure et la barre peut se poser au-dessus
 * d'un de MES messages — comportement en place, consigné par les tests.
 */
export function insererBarreNonLus<M extends { id: string; horodatage: number; auteurId: string }>(
  donneesDesc: M[],
  luJusquA: number | null | undefined,
  moiUid: string | undefined,
): (M | LigneBarre)[] {
  if (typeof luJusquA !== 'number') return donneesDesc;
  let premierNonLu = -1;
  for (let i = 0; i < donneesDesc.length; i++) {
    const m = donneesDesc[i];
    if (m.horodatage > luJusquA && m.auteurId !== moiUid) premierNonLu = i;
  }
  if (premierNonLu === -1) return donneesDesc;
  return [
    ...donneesDesc.slice(0, premierNonLu + 1),
    { barre: true, id: ID_BARRE_NON_LUS },
    ...donneesDesc.slice(premierNonLu + 1),
  ];
}
