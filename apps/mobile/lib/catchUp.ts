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
 *    Il est appelé en mode CURSEUR, plafonné — voir `PAGE` / `PAGES_MAX`.
 *
 * Les curseurs sont les plus grands `_updatedAt` INGÉRÉS — jamais l'horloge
 * locale, qui peut mentir — et ne régressent jamais (garanti par le SQL).
 */

import { readMyIdentity } from './myProfile.ts';
import { RestError, type ClientRest } from './rest.ts';
import type { SyncEngine } from './sync.ts';

type ReponseDelta = {
  update?: Record<string, unknown>[];
  remove?: { _id?: string }[];
};

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

export async function catchUpGlobal(
  client: ClientRest,
  moteur: SyncEngine,
  estAbandonne: () => boolean = () => false,
): Promise<void> {
  const depot = moteur.syncStore;
  const [depuisSalons, depuisAbonnements] = await Promise.all([
    depot.readCursor('*', 'salons'),
    depot.readCursor('*', 'abonnements'),
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
    readMyIdentity(client).catch(() => null),
  ]);

  // Une réponse qui atterrit après la déconnexion n'écrit pas dans la base
  // d'une session terminée.
  if (estAbandonne()) return;

  if (moi !== null) await depot.saveIdentity(moi);

  const recentSalons = await moteur.ingestRooms(salons.update ?? []);
  for (const retire of salons.remove ?? []) {
    if (typeof retire._id === 'string') await depot.deleteRoom(retire._id);
  }
  if (recentSalons !== null) await depot.writeCursor('*', 'salons', recentSalons);

  const recentAbonnements = await moteur.ingestSubscriptions(abonnements.update ?? []);
  for (const retire of abonnements.remove ?? []) {
    // Projection serveur `{_id, _deletedAt}` : le `_id` de l'ABONNEMENT est la
    // seule clé (vérifié contre le source 8.5). D'où la colonne `sub_id`.
    if (typeof retire._id === 'string') await depot.deleteBySubId(retire._id);
  }
  if (recentAbonnements !== null) {
    await depot.writeCursor('*', 'abonnements', recentAbonnements);
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
 *
 * L'INSTANTANÉ des rids connus se relève AVANT la requête, et c'est tout le
 * correctif : pendant les ~200 ms de l'aller-retour, le stream DDP continue
 * d'écrire. Un DM ouvert par un collègue à cet instant n'est pas dans la
 * réponse du serveur — elle a été calculée avant qu'il existe — et purger sur
 * la seule liste vivante effaçait ses trois lignes. Le salon ne revenait qu'au
 * prochain rattrapage global, et la notification push renvoyait entre-temps
 * sur un salon absent. Borner la purge à ce qui était connu AVANT l'appel
 * l'épargne : il n'y figure pas non plus. C'est l'ordre des deux lectures qui
 * porte la justesse — aucun délai, aucune hypothèse sur la latence.
 */
export async function reconcileRooms(
  client: ClientRest,
  moteur: SyncEngine,
  estAbandonne: () => boolean = () => false,
): Promise<void> {
  const connus = await moteur.syncStore.listKnownRids();
  const reponse = await client.get<ReponseAbonnements>('subscriptions.get');
  if (estAbandonne()) return;

  const vivants: string[] = [];
  for (const abonnement of reponse.update ?? []) {
    if (typeof abonnement.rid === 'string') vivants.push(abonnement.rid);
  }
  if (vivants.length === 0) return;

  await moteur.syncStore.purgeMissingRooms(vivants, connus);
}

type ResultatSync = {
  updated?: Record<string, unknown>[];
  deleted?: { _id?: string; _deletedAt?: unknown }[];
  /** Présent SEULEMENT en mode curseur — c'est notre test de support. */
  cursor?: { next?: string | null; previous?: string | null } | null;
};

type ReponseSyncMessages = { result?: ResultatSync };

/**
 * Pourquoi la pagination par curseur, et pas une fenêtre de temps.
 *
 * `chat.syncMessages?lastUpdate=` n'a AUCUNE borne : `count` y est ignoré, le
 * serveur renvoie tout ce qui a changé depuis la date. Mesuré contre un canal
 * de 3 000 messages : **1,85 Mo et 3 000 documents** en une réponse.
 *
 * Et aucune borne TEMPORELLE côté client n'y peut rien, parce que le serveur
 * réécrit `_updatedAt` en masse : `BaseRaw.updateMany()` l'estampille
 * automatiquement, et un simple changement de PSEUDO déclenche
 * `Messages.updateAllUsernamesByUserId` — un `updateMany` sur `{'u._id': uid}`,
 * donc TOUS les messages de cette personne, TOUS salons confondus, datés de
 * « maintenant ». Une fenêtre de 24 h les contient tous. C'est l'origine du
 * « chargement trop long » de `#general` après une édition de profil.
 *
 * Depuis la 7.5, la route accepte `type` + `next`/`previous` + `count` et rend
 * un curseur keyset. Mesuré sur 8.5 (même canal de 3 000 messages) :
 *
 * | requête                             | octets    | documents |
 * |-------------------------------------|-----------|-----------|
 * | `lastUpdate=<vieux>`                | 1 848 832 |      3000 |
 * | `lastUpdate=<vieux>&count=50`       | 1 848 832 |      3000 |
 * | `type=UPDATED&next=<ms>&count=50`   |    30 743 |        50 |
 *
 * La pagination est monotone, et exhaustive tant qu'un groupe d'ex æquo tient
 * dans une page : mesuré 60 pages, 3 000/3 000, aucun message sauté malgré 510
 * groupes d'`_updatedAt` identiques (jusqu'à 11 messages sur la même
 * milliseconde). On peut donc PLAFONNER un passage et reprendre au suivant : le
 * curseur du serveur reprend exactement où on s'est arrêté.
 *
 * **La limite, structurelle :** le serveur avance en `$gt` STRICT sur
 * `_updatedAt`. Un groupe d'ex æquo plus grand qu'une page est donc tronqué, et
 * son reste sauté définitivement — `$gte` n'est pas offert, aucune stratégie
 * client ne le rattrape. C'est exactement le cas d'un `updateMany`, qui
 * estampille tout d'une SEULE milliseconde : mesuré sur le renommage du compte
 * auteur de ces 3 000 messages, l'ouverture suivante coûte **une page de 31 Ko**
 * là où `lastUpdate` en redemandait 594 Ko et montait vers 1,85 Mo.
 *
 * Et ce qui est sauté ne s'affiche pas : le delta d'un renommage est
 * `u.username`, or l'app résout le pseudo par UID depuis la table
 * `utilisateurs` (`ui/identities.tsx`, `ui/messageRow.tsx`) —
 * `messages.auteur_nom` n'est qu'un repli figé. Le nouveau pseudo s'affiche donc
 * sur TOUS les messages, rattrapés ou non. Seule exception, cosmétique : le
 * serveur réécrit aussi le TEXTE des messages qui MENTIONNENT l'ancien pseudo
 * (`updateUsernameAndMessageOfMentionByIdAndOldUsername`) ; au-delà d'une page,
 * ces mentions restent affichées sous l'ancien nom jusqu'à ce que l'ouverture ou
 * la pagination recharge ces messages.
 */
const PAGE = 50;

/**
 * Pages au plus par passage et par sens (mises à jour / suppressions). Deux
 * pages = 100 messages, la borne demandée. Ce qui dépasse est repris au
 * passage suivant, curseur en main.
 */
const PAGES_MAX = 2;

/** Curseur des suppressions : timeline `_deletedAt`, distincte d'`_updatedAt`. */
const FLUX_SUPPRIMES = 'messages-supprimes';

/**
 * Fenêtre du REPLI temporel, pour un serveur antérieur au mode curseur (< 7.5).
 * Voir `rattraperParDate` : c'est le moins mauvais qu'on puisse faire quand le
 * serveur refuse de borner lui-même.
 */
const FENETRE_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Une page en mode curseur. Rend `null` quand le serveur ne connaît pas ce mode
 * — soit il refuse les paramètres (400), soit il répond sans `cursor`.
 */
async function pageCurseur(
  client: ClientRest,
  rid: string,
  type: 'UPDATED' | 'DELETED',
  next: number,
): Promise<{ result: ResultatSync; next: number | null } | null> {
  let reponse: ReponseSyncMessages;
  try {
    reponse = await client.get<ReponseSyncMessages>('chat.syncMessages', {
      // `lastUpdate` est EXCLU délibérément : présent, il GAGNE sur `type`/`next`
      // et la réponse retombe en mode non borné (vérifié sur 8.5). Le curseur est
      // un epoch ms en clair, donc forgeable depuis celui qu'on a déjà — aucun
      // appel d'amorçage nécessaire.
      params: { roomId: rid, type, next: String(next), count: PAGE },
    });
  } catch (e) {
    // SEUL un 400 signe des paramètres que le serveur ne comprend pas. Un
    // timeout, un 429 ou une coupure doivent remonter : basculer en mode non
    // borné sur un réseau qui flanche serait exactement le contraire du but.
    if (e instanceof RestError && e.status === 400) return null;
    throw e;
  }
  const resultat = reponse.result;
  if (resultat === undefined || resultat.cursor === undefined || resultat.cursor === null) {
    return null;
  }
  const brut = Number(resultat.cursor.next);
  return {
    result: resultat,
    next: typeof resultat.cursor.next === 'string' && Number.isFinite(brut) ? brut : null,
  };
}

/**
 * La boucle de pagination, commune aux deux timelines (`UPDATED` / `DELETED`).
 * Elle a coûté un correctif écrit DEUX fois (ffe1f7c, même hunk dans les deux
 * copies) : elle n'existe plus qu'ici. `appliquer` ingère une page et rend le
 * plus grand horodatage traité — ce qui fait avancer le curseur quand le
 * serveur n'a plus de `next` à offrir.
 *
 * Rend `false` si le serveur refuse le mode curseur dès la PREMIÈRE page
 * (mode inconnu, l'appelant se replie) ; `true` sinon.
 */
async function paginerCurseur(
  client: ClientRest,
  depot: SyncEngine['syncStore'],
  rid: string,
  type: 'UPDATED' | 'DELETED',
  flux: string,
  depuis: number,
  estAbandonne: () => boolean,
  appliquer: (resultat: ResultatSync) => Promise<number | null>,
): Promise<boolean> {
  let curseur = depuis;
  for (let page = 0; page < PAGES_MAX; page++) {
    const reponse = await pageCurseur(client, rid, type, curseur);
    // Refus dès la PREMIÈRE page = serveur sans mode curseur → repli. Plus loin,
    // le mode est déjà prouvé : on garde ce qui a été ingéré, sans se replier.
    if (reponse === null) return page !== 0;
    // Une réponse qui atterrit après la déconnexion n'écrit pas dans la base
    // d'une session terminée.
    if (estAbandonne()) return true;

    const recent = await appliquer(reponse.result);

    // On avance sur le curseur du SERVEUR, pas sur le plus grand horodatage
    // ingéré : lui seul reprend la pagination exactement où elle s'est arrêtée,
    // groupes d'ex æquo compris. `ecrireCurseur` interdit déjà toute régression.
    const suivant = reponse.next;
    if (suivant === null || suivant <= curseur) {
      // DERNIÈRE page — et c'est le cas NOMINAL, pas un cas limite : mesuré sur
      // 8.5, le serveur rend `cursor.next = null` dès qu'il ne reste rien après,
      // page PLEINE comprise (50 documents rendus, `next` nul). Un rattrapage
      // qui tient en une page n'a donc jamais de curseur serveur à recopier.
      //
      // Sortir sans rien écrire, comme on le faisait, figeait le curseur À VIE :
      // chaque ouverture du salon redemandait la même tranche, la ré-ingérait, et
      // la tranche GROSSISSAIT à chaque message posté depuis. D'où la comète qui
      // tournait plusieurs secondes à chaque entrée dans un salon, même en
      // sortant et rentrant aussitôt.
      //
      // On avance donc sur le plus grand horodatage INGÉRÉ. Sûr ici, et
      // seulement ici : le serveur vient d'affirmer qu'il n'y a plus rien
      // au-delà, donc aucun ex æquo ne peut rester en attente derrière ce point.
      if (recent !== null && recent > curseur) {
        await depot.writeCursor(rid, flux, recent);
      }
      return true;
    }
    curseur = suivant;
    await depot.writeCursor(rid, flux, curseur);
  }
  // Jamais en silence : une troncature muette se lirait comme « tout est à jour ».
  console.warn(
    `rattraperSalon(${rid}): plafond de ${PAGES_MAX} pages atteint (${type}), reprise au prochain passage`,
  );
  return true;
}

/** Rend `false` si le serveur ne sait pas paginer — l'appelant se replie. */
function rattraperMisAJour(
  client: ClientRest,
  moteur: SyncEngine,
  rid: string,
  depuis: number,
  estAbandonne: () => boolean,
): Promise<boolean> {
  return paginerCurseur(
    client,
    moteur.syncStore,
    rid,
    'UPDATED',
    'messages',
    depuis,
    estAbandonne,
    (resultat) => moteur.ingestMessages(resultat.updated ?? []),
  );
}

async function rattraperSupprimes(
  client: ClientRest,
  moteur: SyncEngine,
  rid: string,
  curseurMessages: number,
  estAbandonne: () => boolean,
): Promise<void> {
  const depot = moteur.syncStore;
  const depuis = await depot.readCursor(rid, FLUX_SUPPRIMES);
  if (depuis === null) {
    // Premier passage : on ne rapatrie pas l'historique des suppressions depuis
    // l'origine. L'ouverture a chargé l'état COURANT des 50 derniers ; on cale
    // donc la timeline des suppressions sur ce qu'on connaît déjà du salon.
    await depot.writeCursor(rid, FLUX_SUPPRIMES, curseurMessages);
    return;
  }
  await paginerCurseur(
    client,
    depot,
    rid,
    'DELETED',
    FLUX_SUPPRIMES,
    depuis,
    estAbandonne,
    async (resultat) => {
      // Le plus grand `_deletedAt` de la page — l'équivalent, sur cette
      // timeline, du `_updatedAt` que rend `ingererMessages` : c'est lui qui
      // clôt la dernière page, sans quoi les MÊMES suppressions se
      // re-joueraient à chaque ouverture, à vie.
      let recent: number | null = null;
      for (const efface of resultat.deleted ?? []) {
        if (typeof efface._id === 'string') await depot.deleteMessage(efface._id);
        const date =
          typeof efface._deletedAt === 'string' ? Date.parse(efface._deletedAt) : Number.NaN;
        if (Number.isFinite(date) && (recent === null || date > recent)) recent = date;
      }
      return recent;
    },
  );
}

/**
 * REPLI pour un serveur sans mode curseur (< 7.5) : l'appel non borné, la
 * fenêtre rabotée à 24 h, et le ré-ancrage sur échec.
 *
 * Le ré-ancrage existe parce que la requête non bornée TIMEOUTE sur un gros
 * backlog : le curseur ne s'avançant qu'APRÈS ingestion, il resterait coincé et
 * la requête re-échouerait à chaque raccordement — barre de synchro « à
 * l'infini ». On le ré-ancre donc sur le message local le plus récent (jamais à
 * rebours) : la prochaine tentative ne vise plus qu'une petite fenêtre. Ré-ancrer
 * sur ce qu'on A DÉJÀ ne saute aucun message jamais vu ; on y perd les
 * éditions/suppressions ANCIENNES de l'intervalle, que l'ouverture et la
 * pagination re-téléchargent à jour.
 */
async function rattraperParDate(
  client: ClientRest,
  moteur: SyncEngine,
  rid: string,
  depuis: number,
  estAbandonne: () => boolean,
  maintenant: () => number,
): Promise<void> {
  const depot = moteur.syncStore;
  // Jamais à rebours du curseur : on ne redemande pas ce qu'on a déjà ingéré.
  const borne = Math.max(depuis, maintenant() - FENETRE_MAX_MS);

  let reponse: ReponseSyncMessages;
  try {
    reponse = await client.get<ReponseSyncMessages>('chat.syncMessages', {
      params: { roomId: rid, lastUpdate: iso(borne) },
    });
  } catch (e) {
    if (!estAbandonne()) {
      const recentLocal = await depot.lastMessageUpdatedAt(rid);
      if (recentLocal !== null) await depot.writeCursor(rid, 'messages', recentLocal);
    }
    throw e;
  }
  if (estAbandonne()) return;

  const recent = await moteur.ingestMessages(reponse.result?.updated ?? []);
  for (const efface of reponse.result?.deleted ?? []) {
    if (typeof efface._id === 'string') await depot.deleteMessage(efface._id);
  }
  if (recent !== null) await depot.writeCursor(rid, 'messages', recent);
}

/**
 * Rattrape UN salon. Sans curseur (jamais ouvert, ou premier passage),
 * ne fait rien : l'historique d'ouverture de l'écran couvre ce cas, et
 * repartir de l'origine re-téléchargerait tout.
 *
 * `maintenant` ne sert qu'au repli temporel (serveur < 7.5).
 *
 * Passer par `rattraperSalon` — jamais d'appel direct : c'est le sérialiseur
 * ci-dessous qui garantit qu'une seule pagination court à la fois par salon.
 */
async function rattraperSalonBrut(
  client: ClientRest,
  moteur: SyncEngine,
  rid: string,
  estAbandonne: () => boolean,
  maintenant: () => number,
): Promise<void> {
  const depuis = await moteur.syncStore.readCursor(rid, 'messages');
  if (depuis === null) return;

  // En SÉRIE, délibérément. Les deux flux sont indépendants et les paralléliser
  // gagnerait ~0,6 s sur la première ouverture d'un gros salon — mais rendrait
  // l'ordre des requêtes non déterministe, ce que les tests d'ici lisent pour
  // vérifier la pagination. Depuis que la réouverture d'un salon resté écouté ne
  // rattrape plus du tout (`ui/hotRooms.ts`), ce chemin ne sert qu'à la
  // PREMIÈRE ouverture, où l'historique se charge de toute façon en parallèle.
  if (!(await rattraperMisAJour(client, moteur, rid, depuis, estAbandonne))) {
    await rattraperParDate(client, moteur, rid, depuis, estAbandonne, maintenant);
    return;
  }
  if (estAbandonne()) return;
  await rattraperSupprimes(client, moteur, rid, depuis, estAbandonne);
}

/**
 * Une passe de rattrapage sur un salon : celle qui court, ou celle déjà
 * programmée derrière elle.
 */
type Passe = {
  /**
   * La session propriétaire. Une passe d'un client rangé (déconnexion,
   * changement de serveur) ne se rejoint pas : elle écrit avec un jeton mort.
   */
  client: ClientRest;
  /**
   * Les `estAbandonne` de TOUS les demandeurs de cette passe. Elle n'abandonne
   * que si CHACUN a lâché — le premier arrivé peut disparaître (effet rejoué,
   * écran démonté) pendant qu'un autre attend toujours cette lecture.
   */
  abandons: (() => boolean)[];
  /** Faux tant que la passe attend celle qui la précède. */
  started: boolean;
  end: Promise<void>;
};

/** Une entrée par salon : la passe la plus récemment PROGRAMMÉE. */
const passes = new Map<string, Passe>();

/**
 * Rattrape UN salon, une pagination à la fois.
 *
 * Deux chemins mènent ici à chaque raccordement, et ils se marchaient dessus :
 * `ui/sync.tsx` (le salon déclaré actif) et `app/salon/[rid].tsx` (son effet
 * d'ouverture, réveillé par le bump de `generation` que ce même raccordement
 * vient de poser). Deux paginations partaient donc sur le MÊME curseur, pour
 * redemander la même tranche — jusqu'à 8 `chat.syncMessages` là où 4 suffisent,
 * sur une route plafonnée à 10 appels/min. Rien ne se corrompait (le curseur ne
 * régresse pas, les upserts sont idempotents) : tout était fait en double.
 *
 * La règle appliquée ici tient en deux phrases, et elle arbitre deux exigences
 * contraires :
 *
 * 1. **Jamais deux paginations concurrentes** sur un même salon. Une demande
 *    arrivée avant que la passe en cours n'ait lu son curseur se FOND dedans :
 *    cette passe couvrira tout ce qu'elle voulait voir.
 * 2. **Jamais une demande avalée.** Une demande arrivée APRÈS le départ de la
 *    passe obtient la sienne, chaînée derrière. C'est ce qui rend sa promesse à
 *    `lib/connectionSetup.ts` : la seconde lecture d'un raccordement, celle qui
 *    part une fois les souscriptions ARMÉES, est justement celle qui garantit
 *    qu'aucun document n'est tombé entre les deux transports. La refuser sous
 *    prétexte qu'une pagination court déjà — le cas NOMINAL, puisque la
 *    première lecture part sans attendre la socket — laissait un trou que plus
 *    rien ne redemandait, le curseur ayant avancé.
 *
 * Une passe chaînée ne coûte pas une seconde pagination : elle part du curseur
 * que la précédente vient d'avancer, donc d'une réponse quasi vide (~92 octets
 * mesurés). C'est un booléen d'ordonnancement, jamais un délai : la justesse ne
 * dépend ni de la latence ni de l'état du réseau.
 */
export function catchUpRoom(
  client: ClientRest,
  moteur: SyncEngine,
  rid: string,
  estAbandonne: () => boolean = () => false,
  maintenant: () => number = () => Date.now(),
): Promise<void> {
  const programmee = passes.get(rid);
  const memeSession = programmee !== undefined && programmee.client === client;
  // (1) Elle n'a pas encore lu son curseur : ce demandeur-ci se fond dedans.
  if (memeSession && !programmee.started) {
    programmee.abandons.push(estAbandonne);
    return programmee.end;
  }
  // (2) Sinon une passe neuve — derrière celle qui court, jamais à côté.
  const precedente = memeSession ? programmee.end : null;
  const passe: Passe = {
    client,
    abandons: [estAbandonne],
    started: false,
    end: Promise.resolve(),
  };
  passe.end = (async () => {
    // L'échec de la précédente n'annule pas la demande de celle-ci : ses
    // demandeurs attendent une lecture, pas le sort de la lecture d'autrui.
    if (precedente !== null) await precedente.catch(() => {});
    passe.started = true;
    await rattraperSalonBrut(
      client,
      moteur,
      rid,
      () => passe.abandons.every((abandonne) => abandonne()),
      maintenant,
    );
  })().finally(() => {
    // Seulement si personne n'a pris la place derrière : sinon on effacerait
    // l'entrée d'une passe encore à venir, qui deviendrait invisible aux
    // demandes suivantes — et deux paginations repartiraient de front.
    if (passes.get(rid) === passe) passes.delete(rid);
  });
  passes.set(rid, passe);
  return passe.end;
}
