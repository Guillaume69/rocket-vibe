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
    modifieLe: integer('modifie_le'),
    /** AST markdown pré-parsé par le serveur (`md`), sérialisé. Absent des vieux messages. */
    md: text('md'),
    piecesJointes: text('pieces_jointes'),
    reactions: text('reactions'),
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
