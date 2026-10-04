/**
 * File d'écritures d'UNE connexion SQLite.
 *
 * Les transactions de `withTransactionAsync` sont par CONNEXION et non
 * réentrantes : toute écriture hors file émise pendant un `BEGIN` ouvert serait
 * absorbée dedans — et silencieusement annulée si le lot échoue. La file
 * appartient donc à la CONNEXION, pas à un dépôt : tous les dépôts bâtis sur la
 * même connexion (`creerDepot`, `creerDepotEnvoi`, `creerDepotTeleversements`,
 * `creerDepotBrouillons`) doivent recevoir la MÊME instance. C'est pourquoi elle
 * est créée par `ouvrirBase` (db/client.ts) et non par l'appelant : deux
 * `creerFileEcritures()` sur une seule connexion ne sérialisent rien.
 *
 * Deux lots concurrents entrelacés mouraient sur « cannot rollback - no
 * transaction is active » — constaté sur l'AVD (historique d'écran +
 * rattrapage du raccordement).
 *
 * Module à part plutôt que dans `db/store.ts` : `db/client.ts` en a besoin, et
 * lui faire importer le dépôt inverserait les couches (le dépôt se construit
 * SUR une connexion).
 */

export type FileEcritures = <T>(job: () => Promise<T>) => Promise<T>;

export function creerFileEcritures(): FileEcritures {
  let queue: Promise<unknown> = Promise.resolve();
  return (job) => {
    // `tour` porte le rejet au demandeur ; la file, elle, l'avale pour ne
    // jamais se bloquer sur un échec passé.
    const tour = queue.then(job);
    queue = tour.then(
      () => {},
      () => {},
    );
    return tour;
  };
}
