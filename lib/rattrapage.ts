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

import { lireMonIdentite } from './monProfil.ts';
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

  const [salons, abonnements, moi] = await Promise.all([
    client.get<ReponseDelta>('rooms.get', {
      params: { updatedSince: depuisSalons === null ? undefined : iso(depuisSalons) },
    }),
    client.get<ReponseDelta>('subscriptions.get', {
      params: { updatedSince: depuisAbonnements === null ? undefined : iso(depuisAbonnements) },
    }),
    // MA fiche : `me` porte `avatarETag`, seul moyen de rattraper une photo
    // changée pendant que l'app était fermée (aucun stream n'a pu l'annoncer).
    // En parallèle des deux deltas, donc sans allonger le rattrapage, et
    // best-effort : mon avatar ne vaut pas d'échouer une resynchronisation.
    lireMonIdentite(client).catch(() => null),
  ]);

  // Une réponse qui atterrit après la déconnexion n'écrit pas dans la base
  // d'une session terminée.
  if (estAbandonne()) return;

  if (moi !== null) await depot.enregistrerIdentite(moi);

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

type ReponseAbonnements = {
  update?: { rid?: unknown }[];
};

/**
 * Réconciliation anti-fantômes. La synchro par curseur ne repasse jamais sur
 * un salon déjà connu : un salon supprimé côté serveur dont l'événement
 * 'removed' a été raté (hors ligne, ou avant le correctif temps réel) resterait
 * en FANTÔME à vie. Ici on récupère la liste COMPLÈTE des abonnements — sans
 * `updatedSince`, donc l'état COURANT, la source de vérité de « ce que je dois
 * voir » — et on purge tout salon local absent.
 *
 * `subscriptions.get` renvoie l'ensemble en une réponse (pas de pagination :
 * c'est la même donnée que la charge d'abonnements du login). Garde-fou : une
 * réponse VIDE ne purge rien — un compte actif a toujours des abonnements, une
 * liste vide trahit une réponse anormale (proxy, erreur muette), pas « plus
 * aucun salon ».
 */
export async function reconcilierSalons(
  client: ClientRest,
  moteur: MoteurSynchro,
  estAbandonne: () => boolean = () => false,
): Promise<void> {
  const reponse = await client.get<ReponseAbonnements>('subscriptions.get');
  if (estAbandonne()) return;

  const vivants: string[] = [];
  for (const abonnement of reponse.update ?? []) {
    if (typeof abonnement.rid === 'string') vivants.push(abonnement.rid);
  }
  if (vivants.length === 0) return;

  await moteur.depotSynchro.purgerSalonsAbsents(vivants);
}

type ReponseSyncMessages = {
  result?: {
    updated?: Record<string, unknown>[];
    deleted?: { _id?: string }[];
  };
};

/**
 * Fenêtre maximale demandée à `chat.syncMessages`.
 *
 * Le serveur 8.5 IGNORE `count` : il renvoie TOUT ce qui a changé depuis
 * `lastUpdate`, sans aucune borne. Mesuré contre un canal de 3 000 messages :
 * **1,85 Mo et 3 000 documents** en une réponse, là où l'historique
 * d'ouverture en demande 50 pour 31 Ko. Sur le `#general` d'un serveur vivant,
 * un curseur vieux de quelques jours fait donc télécharger, parser ET ingérer
 * des mégaoctets à chaque ouverture — l'ingestion SQLite étant le plus lourd
 * sur un téléphone. C'est ce que l'utilisateur voit comme « chargement trop
 * long » : la barre de synchro reste allumée tout du long.
 *
 * On borne donc la fenêtre côté client, puisque le serveur ne le fait pas.
 *
 * Ce qu'on y perd : les éditions et suppressions PLUS ANCIENNES que la
 * fenêtre. Ce qu'on garde : l'ouverture recharge l'état courant des 50
 * derniers messages, et la pagination fait de même en remontant. C'est
 * exactement le compromis déjà assumé par le ré-ancrage après timeout — mais
 * payé d'avance, au lieu de l'être après 15 s et plusieurs mégaoctets perdus.
 */
const FENETRE_MAX_MS = 24 * 60 * 60 * 1000;

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
  maintenant: () => number = () => Date.now(),
): Promise<void> {
  const depot = moteur.depotSynchro;
  const depuis = await depot.lireCurseur(rid, 'messages');
  if (depuis === null) return;

  // Jamais à rebours du curseur : on ne redemande pas ce qu'on a déjà ingéré.
  const borne = Math.max(depuis, maintenant() - FENETRE_MAX_MS);

  let reponse: ReponseSyncMessages;
  try {
    reponse = await client.get<ReponseSyncMessages>('chat.syncMessages', {
      params: { roomId: rid, lastUpdate: iso(borne) },
    });
  } catch (e) {
    // `chat.syncMessages` n'est PAS borné (le serveur 8.5 ignore `count`,
    // vérifié) : sur un curseur trop en retard, il doit renvoyer tout le backlog
    // et TIMEOUTE. Le curseur ne s'avançant qu'APRÈS ingestion, il resterait
    // coincé et la requête re-échouerait à CHAQUE raccordement → boucle sans fin
    // (barre de synchro « à l'infini » sur un gros salon). On RÉ-ANCRE donc le
    // curseur sur le message local le plus récent (jamais à rebours) : la
    // prochaine tentative ne vise plus qu'une petite fenêtre. Ré-ancrer sur ce
    // qu'on A DÉJÀ ne saute aucun message jamais vu ; seul le compromis assumé
    // demeure — les éditions/suppressions de messages ANCIENS de l'intervalle,
    // que l'ouverture et la pagination re-téléchargent à jour. On relaie ensuite
    // l'échec (l'appelant le loggue).
    if (!estAbandonne()) {
      const recentLocal = await depot.dernierMessageMisAJour(rid);
      if (recentLocal !== null) await depot.ecrireCurseur(rid, 'messages', recentLocal);
    }
    throw e;
  }
  if (estAbandonne()) return;

  const recent = await moteur.ingererMessages(reponse.result?.updated ?? []);
  for (const efface of reponse.result?.deleted ?? []) {
    if (typeof efface._id === 'string') await depot.supprimerMessage(efface._id);
  }
  if (recent !== null) await depot.ecrireCurseur(rid, 'messages', recent);
}
