/**
 * Rattrapage après une coupure ou un passage en arrière-plan.
 *
 * Deux étages, aux coûts très différents :
 *
 * 1. **Global** — `rooms.get?updatedSince=` + `subscriptions.get?updatedSince=`
 *    couvrent tous les salons et compteurs en DEUX requêtes, avec leurs
 *    `remove[]` pour les départs. Sans curseur (premier passage), l'appel se
 *    fait sans `updatedSince` : c'est le chargement complet.
 * 2. **Par salon** — `chat.syncMessages` traite UN salon à la fois et le REST
 *    est rate-limité : on ne l'appelle QUE pour le salon actif (l'écran
 *    ouvert). Les autres se rattrapent à leur ouverture, par l'historique.
 *
 * Les curseurs sont les plus grands `_updatedAt` INGÉRÉS — jamais l'horloge
 * locale, qui peut mentir — et ne régressent jamais (garanti par le SQL).
 */

import type { ClientRest } from './rest.ts';
import type { MoteurSynchro } from './sync.ts';

type ReponseDelta = {
  update?: Record<string, unknown>[];
  remove?: { _id?: string }[];
};

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

export async function rattraperGlobal(
  client: ClientRest,
  moteur: MoteurSynchro,
  estAbandonne: () => boolean = () => false,
): Promise<void> {
  const depot = moteur.depotSynchro;
  const [depuisSalons, depuisAbonnements] = await Promise.all([
    depot.lireCurseur('*', 'salons'),
    depot.lireCurseur('*', 'abonnements'),
  ]);

  const [salons, abonnements] = await Promise.all([
    client.get<ReponseDelta>('rooms.get', {
      params: { updatedSince: depuisSalons === null ? undefined : iso(depuisSalons) },
    }),
    client.get<ReponseDelta>('subscriptions.get', {
      params: { updatedSince: depuisAbonnements === null ? undefined : iso(depuisAbonnements) },
    }),
  ]);

  // Une réponse qui atterrit après la déconnexion n'écrit pas dans la base
  // d'une session terminée.
  if (estAbandonne()) return;

  const recentSalons = await moteur.ingererSalons(salons.update ?? []);
  for (const retire of salons.remove ?? []) {
    if (typeof retire._id === 'string') await depot.supprimerSalon(retire._id);
  }
  if (recentSalons !== null) await depot.ecrireCurseur('*', 'salons', recentSalons);

  const recentAbonnements = await moteur.ingererAbonnements(abonnements.update ?? []);
  for (const retire of abonnements.remove ?? []) {
    // Projection serveur `{_id, _deletedAt}` : le `_id` de l'ABONNEMENT est la
    // seule clé (vérifié contre le source 8.5). D'où la colonne `sub_id`.
    if (typeof retire._id === 'string') await depot.supprimerParSubId(retire._id);
  }
  if (recentAbonnements !== null) {
    await depot.ecrireCurseur('*', 'abonnements', recentAbonnements);
  }
}

type ReponseSyncMessages = {
  result?: {
    updated?: Record<string, unknown>[];
    deleted?: { _id?: string }[];
  };
};

/**
 * Rattrape UN salon. Sans curseur (jamais ouvert, ou premier passage),
 * ne fait rien : l'historique d'ouverture de l'écran couvre ce cas, et
 * `syncMessages` sans borne re-téléchargerait tout.
 */
export async function rattraperSalon(
  client: ClientRest,
  moteur: MoteurSynchro,
  rid: string,
  estAbandonne: () => boolean = () => false,
): Promise<void> {
  const depot = moteur.depotSynchro;
  const depuis = await depot.lireCurseur(rid, 'messages');
  if (depuis === null) return;

  const reponse = await client.get<ReponseSyncMessages>('chat.syncMessages', {
    params: { roomId: rid, lastUpdate: iso(depuis) },
  });
  if (estAbandonne()) return;

  const recent = await moteur.ingererMessages(reponse.result?.updated ?? []);
  for (const efface of reponse.result?.deleted ?? []) {
    if (typeof efface._id === 'string') await depot.supprimerMessage(efface._id);
  }
  if (recent !== null) await depot.ecrireCurseur(rid, 'messages', recent);
}
