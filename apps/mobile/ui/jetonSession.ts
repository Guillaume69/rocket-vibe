/**
 * Le jeton de la session UI courante — ce qui permet à un cache module-level
 * de refuser une écriture arrivée trop tard.
 *
 * Le problème, précis : les caches d'écran (`ui/salonsCharges.ts`,
 * `ui/filsCharges.ts`, `ui/salonChaud.ts`) vivent au niveau du MODULE, donc
 * survivent au démontage de l'arbre. `ui/synchro.tsx` les purge dans son
 * cleanup — mais ce cleanup court AVANT celui des écrans qu'il portait. Un
 * écran salon démonté juste après appelle donc `garderAuChaud(...)` avec des
 * relâcheurs qui pointent sur un client DDP déjà `reinitialiser()`, et
 * REPEUPLE le cache qu'on venait de vider.
 *
 * L'entrée fantôme ne s'efface plus jamais, et elle MENT : la garde compare
 * une égalité de générations, or le compteur repart de 0 à la session
 * suivante. Dès que la nouvelle session atteint la valeur mémorisée,
 * `salonCouvert` répond « rien à rattraper » pour un salon que cette socket-là
 * n'a jamais écouté — éditions et suppressions manquées ne sont alors jamais
 * rapatriées.
 *
 * Un jeton règle ça sans délai ni ordonnancement : l'écran capture le jeton au
 * moment où il prend ses souscriptions, et le rend en les confiant. Si le
 * jeton a changé entre-temps, la session à laquelle ces références
 * appartenaient est morte — on relâche au lieu de mémoriser. Fait causal,
 * jamais chronologique, comme `generation` elle-même.
 */

let jeton = 0;

/** À capturer au MONTAGE, à rendre au démontage — jamais relu entre les deux. */
export function jetonSession(): number {
  return jeton;
}

/**
 * Fin de session / changement de serveur. Appelée par les purges de caches
 * elles-mêmes : ce qui vide un cache de session invalide forcément le jeton,
 * et l'oubli d'un des deux gestes ferait retomber le défaut.
 */
export function invaliderJetonSession(): void {
  jeton += 1;
}
