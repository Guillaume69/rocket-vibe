/**
 * Schéma local. **SQLite est la source de vérité**, l'UI n'en est qu'une
 * projection : le WebSocket et le REST y font des upserts, jamais l'inverse.
 *
 * Une base par serveur **et par compte** (`db/nomFichier.ts`) : le nom de
 * fichier dérive du host et de l'utilisateur, donc rien de multi-serveur ici.
 *
 * Les dates Rocket.Chat arrivent en EJSON (`{"$date": epochMs}`) ou en ISO.
 * On les stocke en **millisecondes entières** : comparables, indexables, sans
 * ambiguïté de fuseau.
 */

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Type de salon Rocket.Chat : c=canal, p=groupe privé, d=direct, l=livechat. */
export type TypeSalon = 'c' | 'p' | 'd' | 'l';

export const salons = sqliteTable(
  'salons',
  {
    rid: text('rid').primaryKey(),
    type: text('type').$type<TypeSalon>().notNull(),
    /** `name` est le slug ; `fname` le nom affiché (peut contenir des espaces). */
    nom: text('nom'),
    nomAffiche: text('nom_affiche'),
    /** Salon chiffré de bout en bout : on n'y écrit pas, on n'affiche pas l'aperçu. */
    chiffre: integer('chiffre', { mode: 'boolean' }).notNull().default(false),
    lectureSeule: integer('lecture_seule', { mode: 'boolean' }).notNull().default(false),
    /**
     * L'AUTRE participant d'un DM à deux (depuis `uids` du document Rooms),
     * pour la présence (8.4). Le rid d'un DM 8.5 est un ObjectId ALÉATOIRE —
     * plus la concaténation des deux uids, il ne se dérive pas.
     */
    dmAutreUid: text('dm_autre_uid'),
    /** Aperçu du dernier message. `null` si le salon est chiffré. */
    dernierMessage: text('dernier_message'),
    horodatageDernierMessage: integer('horodatage_dernier_message'),
    misAJourLe: integer('mis_a_jour_le').notNull().default(0),
  },
  (t) => [index('idx_salons_activite').on(t.horodatageDernierMessage)],
);

/**
 * État **par utilisateur** d'un salon : non-lus, favori, dernière lecture.
 * Distinct du salon lui-même, que tous les membres partagent.
 */
export const abonnements = sqliteTable('abonnements', {
  rid: text('rid').primaryKey(),
  /**
   * `_id` de l'abonnement côté serveur. Les `remove[]` du rattrapage ne
   * portent QUE lui (projection `{_id, _deletedAt}`, vérifié sur 8.5) : sans
   * cette colonne, un salon quitté ailleurs resterait listé pour toujours.
   */
  subId: text('sub_id'),
  nonLus: integer('non_lus').notNull().default(0),
  mentions: integer('mentions').notNull().default(0),
  mentionsGroupe: integer('mentions_groupe').notNull().default(0),
  alerte: integer('alerte', { mode: 'boolean' }).notNull().default(false),
  ouvert: integer('ouvert', { mode: 'boolean' }).notNull().default(true),
  favori: integer('favori', { mode: 'boolean' }).notNull().default(false),
  /** `ls` : date de dernière lecture, pour la barre « nouveaux messages ». */
  luJusquA: integer('lu_jusqu_a'),
  misAJourLe: integer('mis_a_jour_le').notNull().default(0),
});

export const messages = sqliteTable(
  'messages',
  {
    /** `_id` Rocket.Chat. Généré côté client à l'envoi : c'est la clé de déduplication. */
    id: text('id').primaryKey(),
    rid: text('rid').notNull(),
    /** `null` pour un message chiffré non déchiffrable, ou un message système. */
    texte: text('texte'),
    horodatage: integer('horodatage').notNull(),
    auteurId: text('auteur_id').notNull(),
    auteurNom: text('auteur_nom'),
    /** `t` : type de message système (`uj`, `ul`, `rm`, `e2e`…). `null` = message ordinaire. */
    typeSysteme: text('type_systeme'),
    /** `tmid` : identifiant du message racine, si ce message est une réponse de fil. */
    filId: text('fil_id'),
    /** `tcount` : nombre de réponses, sur le message racine. */
    filReponses: integer('fil_reponses').notNull().default(0),
    /** `tlm` : horodatage de la dernière réponse, porté par le message racine. */
    filDernier: integer('fil_dernier'),
    /** `tshow` : réponse de fil à montrer AUSSI dans le flux principal du salon. */
    filAffiche: integer('fil_affiche', { mode: 'boolean' }).notNull().default(false),
    modifieLe: integer('modifie_le'),
    /** AST markdown pré-parsé par le serveur (`md`), sérialisé. Absent des vieux messages. */
    md: text('md'),
    piecesJointes: text('pieces_jointes'),
    reactions: text('reactions'),
    /**
     * `urls` : métadonnées de lien parsées par le SERVEUR (OpenGraph/oEmbed),
     * sérialisées. Source des cartes d'aperçu (`lib/apercuLien.ts`). Arrive
     * souvent APRÈS le message : le serveur parse en asynchrone puis re-pousse
     * la version enrichie avec un `_updatedAt` plus récent, que l'upsert accepte.
     */
    urls: text('urls'),
    /**
     * `callId` d'un message de visioconférence (`t: 'videoconf'`), lu dans le
     * bloc `video_conf`. On ne garde QUE lui parmi les `blocks` : c'est le seul
     * champ qu'on rejoue (bouton « Rejoindre »), et il n'est PAS le `_id` du
     * message. `null` partout ailleurs.
     */
    appelId: text('appel_id'),
    misAJourLe: integer('mis_a_jour_le').notNull().default(0),
  },
  // L'index couvre la requête de l'écran salon : `WHERE rid = ? ORDER BY horodatage DESC`.
  (t) => [index('idx_messages_salon_date').on(t.rid, t.horodatage), index('idx_messages_fil').on(t.filId)],
);

/**
 * Statut d'un envoi optimiste. Il n'y a pas d'état « envoyé » : au succès (ou
 * dès qu'une copie d'origine serveur arrive), la ligne est SUPPRIMÉE.
 */
export type StatutSortie = 'en-attente' | 'echec';

/**
 * File d'envoi persistante. Le message est affiché immédiatement, puis
 * réconcilié quand le serveur le renvoie — le `_id` est généré côté client,
 * et le serveur n'en accepte jamais deux : une réémission après un crash ne
 * crée pas de doublon. ATTENTION : le rejeu répond 400, pas un succès
 * idempotent (voir lib/envoi.ts).
 */
export const sortie = sqliteTable(
  'sortie',
  {
    id: text('id').primaryKey(),
    rid: text('rid').notNull(),
    texte: text('texte').notNull(),
    filId: text('fil_id'),
    statut: text('statut').$type<StatutSortie>().notNull().default('en-attente'),
    tentatives: integer('tentatives').notNull().default(0),
    derniereErreur: text('derniere_erreur'),
    creeLe: integer('cree_le').notNull(),
  },
  (t) => [index('idx_sortie_statut').on(t.statut)],
);

/**
 * File de téléversements (7.2) — le pendant de `sortie` pour les fichiers.
 * L'`uri` pointe un fichier LOCAL (cache du picker) : il survit au kill de
 * l'app, donc le rejeu au démarrage peut reprendre un envoi interrompu.
 * Pas de `_id` client ici : la déduplication viendra du serveur au confirm ;
 * le statut `envoi` évite de relancer un upload déjà parti dans cette vie.
 */
export const televersements = sqliteTable(
  'televersements',
  {
    id: text('id').primaryKey(),
    rid: text('rid').notNull(),
    uri: text('uri').notNull(),
    nom: text('nom').notNull(),
    type: text('type').notNull(),
    legende: text('legende'),
    statut: text('statut').$type<'en-attente' | 'echec'>().notNull().default('en-attente'),
    derniereErreur: text('derniere_erreur'),
    creeLe: integer('cree_le').notNull(),
  },
  (t) => [index('idx_televersements_statut').on(t.statut)],
);

/**
 * Brouillons de composer (8.7), par salon (`rid`) ou par fil (`rid:tmid`).
 * En SQLite plutôt qu'en MMKV (écart au plan consigné) : le brouillon est
 * débouncé, la latence asynchrone est sans objet, et une dépendance NATIVE
 * de plus — donc un rebuild — ne se justifie pas contre ROADMAP §4.2 quand
 * la base couvre déjà tout l'état local.
 */
export const brouillons = sqliteTable('brouillons', {
  /** `rid`, ou `rid:tmid` pour la réponse dans un fil. */
  cle: text('cle').primaryKey(),
  texte: text('texte').notNull(),
  misAJourLe: integer('mis_a_jour_le').notNull(),
});

/**
 * Emojis personnalisés du serveur (`emoji-custom.list`). Table de RÉFÉRENCE,
 * pas de flux : `msg.md` ne livre que le code court (`:party_parrot:`), c'est
 * elle qui donne le nom de FICHIER à afficher. Persistée pour l'offline-first
 * (étape 8) — au démarrage sans réseau, les customs s'affichent quand même ;
 * chargée en Map mémoire (`lib/emojisCustom.ts`) pour un rendu synchrone.
 *
 * La base étant par (serveur, compte), la table est déjà scopée serveur : pas
 * d'`etag` à garder, on remplace tout au rattrapage. `nom` est le nom
 * canonique ; `aliases` en JSON — chaque alias est un code court à part
 * entière (`:parrot:` = `:party_parrot:`), l'index mémoire les déplie.
 */
export const emojisCustom = sqliteTable('emojis_custom', {
  nom: text('nom').primaryKey(),
  extension: text('extension').notNull(),
  /** JSON `string[]`. Un alias sert la même image que son nom canonique. */
  aliases: text('aliases').notNull().default('[]'),
  misAJourLe: integer('mis_a_jour_le').notNull().default(0),
});

/**
 * Identités des auteurs : `uid → pseudo COURANT`. Le pseudo Rocket.Chat est
 * MUABLE, l'uid non — c'est donc l'uid la vraie identité, `messages.auteur_nom`
 * n'étant qu'un instantané figé à l'ingestion (repli hors-ligne / premier
 * rendu). Cette table, alimentée par CHAQUE message ingéré (le pseudo du message
 * le PLUS RÉCENT par uid fait foi), donne le pseudo à AFFICHER — à jour même
 * pour les messages postés AVANT un renommage, qu'on ne re-télécharge pas.
 */
export const utilisateurs = sqliteTable('utilisateurs', {
  uid: text('uid').primaryKey(),
  username: text('username'),
  /** `_updatedAt` du message qui a fixé ce pseudo : arbitre « le plus récent gagne ». */
  misAJourLe: integer('mis_a_jour_le').notNull().default(0),
});

/**
 * Curseurs de rattrapage, par salon et par flux. `chat.syncMessages` traite un
 * salon à la fois et le REST est rate-limité : on ne re-synchronise que les
 * salons ouverts ou récemment actifs (étape 5.2).
 */
export const etatSynchro = sqliteTable(
  'etat_synchro',
  {
    /** `rid`, ou `*` pour les curseurs globaux (`subscriptions.get?updatedSince`). */
    portee: text('portee').notNull(),
    flux: text('flux').notNull(),
    misAJourDepuis: integer('mis_a_jour_depuis').notNull(),
  },
  (t) => [primaryKey({ columns: [t.portee, t.flux] })],
);
