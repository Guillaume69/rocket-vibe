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
 * Pourquoi une génération plutôt qu'un « il y a moins de N secondes » : en
 * sortant du salon on se DÉSABONNE de ses streams (`app/salon/[rid].tsx`), donc
 * le cache local d'un salon fermé n'est plus couvert par le temps réel. Ce qui
 * décide de sa validité n'est pas un délai, c'est un fait : la connexion a-t-elle
 * tenu depuis ? `generation` est incrémentée à CHAQUE raccordement
 * (`ui/synchro.tsx`), donc :
 *
 *  - sortir et rentrer sans incident → même génération → aucune requête, le
 *    cache s'affiche tout de suite ;
 *  - après une coupure, même brève → génération différente → historique
 *    rechargé, parce que le trou peut être de n'importe quelle taille.
 *
 * Dans les deux cas `rattraperSalon` part quand même : c'est lui, curseur en
 * main, qui rattrape ce qui a bougé pendant qu'on n'était pas dans le salon —
 * et il ne coûte que ~92 octets quand il n'y a rien.
 *
 * Store module-level, comme `ui/sondeUpload` : rien ne doit re-rendre l'arbre
 * de navigation quand cette table change.
 */

const charges = new Map<string, number>();

/** Après un historique d'ouverture ABOUTI — jamais sur un échec réseau. */
export function marquerSalonCharge(rid: string, generation: number): void {
  charges.set(rid, generation);
}

export function salonChargeSous(rid: string, generation: number): boolean {
  return charges.get(rid) === generation;
}

/** Fin de session / changement de serveur : plus rien de ce cache ne vaut. */
export function oublierSalonsCharges(): void {
  charges.clear();
}
