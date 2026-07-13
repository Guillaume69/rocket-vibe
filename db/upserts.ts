/**
 * Upserts idempotents. **Le SQL vit ici, et nulle part ailleurs** : les tests
 * l'exécutent tel quel sur un `node:sqlite` en mémoire, donc ils éprouvent la
 * requête que l'application enverra, pas une paraphrase.
 *
 * Deux invariants, tous deux nécessaires :
 *
 * 1. `ON CONFLICT DO UPDATE` — rejouer un événement ne crée pas de doublon.
 *    Le WebSocket et le REST écrivent la même ligne, et un rattrapage
 *    re-livrera des messages déjà connus.
 * 2. `WHERE excluded.mis_a_jour_le >= <table>.mis_a_jour_le` — un événement
 *    **plus ancien** n'écrase pas un état plus récent. Sans cela, un rattrapage
 *    REST lancé après une reconnexion pourrait ressusciter la version d'un
 *    message éditée depuis, ou réafficher des non-lus déjà remis à zéro.
 */

import type { AbonnementLocal, MessageLocal, SalonLocal } from '../lib/normaliser.ts';

export const UPSERT_MESSAGE = `
INSERT INTO messages (
  id, rid, texte, horodatage, auteur_id, auteur_nom, type_systeme,
  fil_id, fil_reponses, fil_dernier, fil_affiche, modifie_le, md,
  pieces_jointes, reactions, urls, appel_id, chiffre_brut, mis_a_jour_le
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  -- Message chiffré : garder le clair déjà déchiffré si la resynchro arrive
  -- sans clé (excluded.texte null). Message ordinaire : comportement inchangé.
  texte = CASE
    WHEN excluded.type_systeme = 'e2e' THEN COALESCE(excluded.texte, messages.texte)
    ELSE excluded.texte
  END,
  horodatage = excluded.horodatage,
  auteur_nom = excluded.auteur_nom,
  type_systeme = excluded.type_systeme,
  fil_id = excluded.fil_id,
  fil_reponses = excluded.fil_reponses,
  fil_dernier = excluded.fil_dernier,
  fil_affiche = excluded.fil_affiche,
  modifie_le = excluded.modifie_le,
  md = excluded.md,
  pieces_jointes = excluded.pieces_jointes,
  reactions = excluded.reactions,
  urls = excluded.urls,
  appel_id = excluded.appel_id,
  -- texte déjà déchiffré localement (COALESCE ci-dessus) : une resynchro du
  -- même message chiffré ne doit pas ré-effacer le clair (chiffre_brut gardé).
  chiffre_brut = COALESCE(excluded.chiffre_brut, messages.chiffre_brut),
  mis_a_jour_le = excluded.mis_a_jour_le
WHERE excluded.mis_a_jour_le >= messages.mis_a_jour_le
`;

/**
 * `COALESCE` sur les champs que le serveur OMET parfois : un événement
 * `rooms-changed` peut porter un document partiel (sans `usernames`, sans
 * `lastMessage`). `null` y signifie « absent de la charge », jamais « efface » —
 * sans le COALESCE, un tel événement plus récent effacerait le nom dérivé d'un
 * DM ou l'aperçu, et la liste retomberait sur le `rid` brut.
 */
export const UPSERT_SALON = `
INSERT INTO salons (
  rid, type, nom, nom_affiche, chiffre, lecture_seule, dm_autre_uid,
  dernier_message, horodatage_dernier_message, mis_a_jour_le
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(rid) DO UPDATE SET
  type = excluded.type,
  nom = COALESCE(excluded.nom, salons.nom),
  nom_affiche = COALESCE(excluded.nom_affiche, salons.nom_affiche),
  chiffre = excluded.chiffre,
  lecture_seule = excluded.lecture_seule,
  dm_autre_uid = COALESCE(excluded.dm_autre_uid, salons.dm_autre_uid),
  dernier_message = COALESCE(excluded.dernier_message, salons.dernier_message),
  horodatage_dernier_message = COALESCE(excluded.horodatage_dernier_message, salons.horodatage_dernier_message),
  mis_a_jour_le = excluded.mis_a_jour_le
WHERE excluded.mis_a_jour_le >= salons.mis_a_jour_le
`;

export const UPSERT_ABONNEMENT = `
INSERT INTO abonnements (
  rid, sub_id, non_lus, mentions, mentions_groupe, alerte, ouvert, favori,
  lu_jusqu_a, e2e_key, e2e_key_id, mis_a_jour_le
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(rid) DO UPDATE SET
  sub_id = COALESCE(excluded.sub_id, abonnements.sub_id),
  non_lus = excluded.non_lus,
  mentions = excluded.mentions,
  mentions_groupe = excluded.mentions_groupe,
  alerte = excluded.alerte,
  ouvert = excluded.ouvert,
  favori = excluded.favori,
  lu_jusqu_a = excluded.lu_jusqu_a,
  -- COALESCE : un événement d'abonnement partiel (sans E2EKey) ne doit pas
  -- effacer la clé déjà connue.
  e2e_key = COALESCE(excluded.e2e_key, abonnements.e2e_key),
  e2e_key_id = COALESCE(excluded.e2e_key_id, abonnements.e2e_key_id),
  mis_a_jour_le = excluded.mis_a_jour_le
WHERE excluded.mis_a_jour_le >= abonnements.mis_a_jour_le
`;

/** Curseur de rattrapage. Ne recule jamais : un curseur qui régresse re-télécharge. */
export const UPSERT_CURSEUR = `
INSERT INTO etat_synchro (portee, flux, mis_a_jour_depuis) VALUES (?, ?, ?)
ON CONFLICT(portee, flux) DO UPDATE SET mis_a_jour_depuis = excluded.mis_a_jour_depuis
WHERE excluded.mis_a_jour_depuis > etat_synchro.mis_a_jour_depuis
`;

/**
 * Identité d'un auteur (`uid → pseudo courant`), dérivée de CHAQUE message
 * ingéré. Deux garde-fous dans le `WHERE` :
 *  - `mis_a_jour_le >=` : un message plus ANCIEN ne rétrograde pas un pseudo
 *    plus récemment observé (« le plus récent gagne »).
 *  - `username IS NOT` : on n'écrit QUE si le pseudo change VRAIMENT. Sans ça,
 *    chaque message au même pseudo toucherait la ligne et ferait rejouer la
 *    `useLiveQuery` de la table — donc re-rendre toutes les lignes visibles. Là,
 *    la table ne bouge qu'à un VRAI renommage.
 */
export const UPSERT_UTILISATEUR = `
INSERT INTO utilisateurs (uid, username, mis_a_jour_le) VALUES (?, ?, ?)
ON CONFLICT(uid) DO UPDATE SET
  username = excluded.username,
  mis_a_jour_le = excluded.mis_a_jour_le
WHERE excluded.mis_a_jour_le >= utilisateurs.mis_a_jour_le
  AND excluded.username IS NOT utilisateurs.username
`;

/** Clés de salon connues, pour la passe de déchiffrement E2EE au déverrouillage. */
export const LISTER_CLES_SALON = `SELECT rid, e2e_key FROM abonnements WHERE e2e_key IS NOT NULL`;
/** Messages chiffrés encore illisibles : ciphertext gardé, clair pas encore posé. */
export const MESSAGES_A_DECHIFFRER = `SELECT id, rid, chiffre_brut FROM messages WHERE chiffre_brut IS NOT NULL AND texte IS NULL`;
/** Pose le clair d'un message une fois déchiffré. */
export const MAJ_TEXTE_MESSAGE = `UPDATE messages SET texte = ? WHERE id = ?`;
/** Re-masque tout message chiffré au verrouillage : le clair local disparaît,
 *  le ciphertext (`chiffre_brut`) reste pour re-déchiffrer au prochain déverrou. */
export const MASQUER_MESSAGES_CHIFFRES = `UPDATE messages SET texte = NULL WHERE chiffre_brut IS NOT NULL`;
/**
 * Aperçu de la liste pour les salons chiffrés DÉVERROUILLÉS : le dernier
 * message déchiffré. Sans déchiffrement, `dernier_message` reste null (le
 * ciphertext n'est jamais stocké) → la liste montre le placeholder.
 */
export const MAJ_APERCU_CHIFFRE = `
UPDATE salons SET dernier_message = (
  SELECT texte FROM messages
  WHERE messages.rid = salons.rid AND messages.texte IS NOT NULL
  ORDER BY messages.horodatage DESC LIMIT 1
) WHERE chiffre = 1`;
/** Au verrouillage : l'aperçu redevient le placeholder (dernier_message null). */
export const MASQUER_APERCU_CHIFFRE = `UPDATE salons SET dernier_message = NULL WHERE chiffre = 1`;

export const SUPPRIMER_MESSAGE = `DELETE FROM messages WHERE id = ?`;

/** Départ d'un salon : le rattrapage (`remove[]` d'updatedSince) fait le ménage. */
export const SUPPRIMER_SALON = `DELETE FROM salons WHERE rid = ?`;
export const SUPPRIMER_ABONNEMENT = `DELETE FROM abonnements WHERE rid = ?`;
/** Les `remove[]` d'abonnements ne portent QUE le `_id` de l'abonnement. */
export const RID_PAR_SUB_ID = `SELECT rid FROM abonnements WHERE sub_id = ?`;

/**
 * Réconciliation anti-fantômes : efface tout ce dont le `rid` n'est PLUS dans
 * la liste vivante du serveur. `json_each` déballe un tableau JSON de N rids
 * passé en UN seul paramètre — le SQL reste statique (testé tel quel) quel que
 * soit N. L'appelant GARANTIT une liste non vide : `NOT IN (rien)` viderait
 * tout. On purge les trois tables liées au salon pour ne pas laisser de
 * messages orphelins invisibles.
 */
export const PURGER_SALONS_ABSENTS = `DELETE FROM salons WHERE rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGER_ABONNEMENTS_ABSENTS = `DELETE FROM abonnements WHERE rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGER_MESSAGES_ABSENTS = `DELETE FROM messages WHERE rid NOT IN (SELECT value FROM json_each(?))`;

export const LIRE_CURSEUR = `
SELECT mis_a_jour_depuis FROM etat_synchro WHERE portee = ? AND flux = ?
`;

/**
 * Le plus grand `_updatedAt` déjà ingéré pour un salon — sert à RÉ-ANCRER le
 * curseur de rattrapage quand `chat.syncMessages` échoue sur un backlog trop
 * gros (le serveur 8.5 ne borne pas la requête, elle timeoute), pour ne pas
 * re-demander éternellement le même gouffre. `MAX(NULL)` d'une table vide rend
 * `NULL` → `null` côté appelant.
 */
export const DERNIER_MESSAGE_MIS_A_JOUR = `
SELECT MAX(mis_a_jour_le) AS mis_a_jour_le FROM messages WHERE rid = ?
`;

// ---------------------------------------------------------------------------
// Emojis personnalisés. Table de référence, remplacée EN BLOC au rattrapage
// (`emoji-custom.list` complet) : un `DELETE` puis des `INSERT`, dans une même
// transaction, plutôt qu'un upsert qui laisserait traîner les emojis retirés
// côté serveur en fantômes cliquables.
// ---------------------------------------------------------------------------

export const VIDER_EMOJIS_CUSTOM = `DELETE FROM emojis_custom`;

export const INSERER_EMOJI_CUSTOM = `
INSERT INTO emojis_custom (nom, extension, aliases, mis_a_jour_le) VALUES (?, ?, ?, ?)
`;

export const LISTER_EMOJIS_CUSTOM = `
SELECT nom, extension, aliases FROM emojis_custom
`;

export function paramsEmojiCustom(e: {
  nom: string;
  extension: string;
  aliases: string[];
  misAJourLe: number;
}): Parametre[] {
  return [e.nom, e.extension, JSON.stringify(e.aliases), e.misAJourLe];
}

// ---------------------------------------------------------------------------
// File d'envoi (outbox). L'`id` est le `_id` 24-hex généré CÔTÉ CLIENT : le
// serveur déduplique dessus, c'est ce qui rend le rejeu après crash sûr.
// ---------------------------------------------------------------------------

export const INSERER_SORTIE = `
INSERT INTO sortie (id, rid, texte, fil_id, statut, tentatives, derniere_erreur, cree_le)
VALUES (?, ?, ?, ?, 'en-attente', 0, NULL, ?)
`;

/** Les échecs aussi : le rejeu au retour du réseau retente tout ce qui reste. */
export const LISTER_SORTIE_A_ENVOYER = `
SELECT id, rid, texte, fil_id, statut, tentatives FROM sortie
WHERE statut IN ('en-attente', 'echec') ORDER BY cree_le
`;

export const MARQUER_SORTIE_ECHEC = `
UPDATE sortie SET statut = 'echec', tentatives = tentatives + 1, derniere_erreur = ?
WHERE id = ?
`;

export const SUPPRIMER_SORTIE = `DELETE FROM sortie WHERE id = ?`;

/**
 * Abandon d'un envoi : seul un message ENCORE optimiste (`mis_a_jour_le = 0`)
 * s'efface — si une version serveur existe, le message a été livré et n'a
 * plus rien d'abandonnable.
 */
export const SUPPRIMER_MESSAGE_OPTIMISTE = `
DELETE FROM messages WHERE id = ? AND mis_a_jour_le = 0
`;

// ---------------------------------------------------------------------------
// File de téléversements (7.2) — mêmes règles que la sortie texte.
// ---------------------------------------------------------------------------

export const INSERER_TELEVERSEMENT = `
INSERT INTO televersements (id, rid, uri, nom, type, legende, statut, derniere_erreur, cree_le)
VALUES (?, ?, ?, ?, ?, ?, 'en-attente', NULL, ?)
`;

export const LISTER_TELEVERSEMENTS_A_ENVOYER = `
SELECT id, rid, uri, nom, type, legende, statut FROM televersements
WHERE statut IN ('en-attente', 'echec') ORDER BY cree_le
`;

export const MARQUER_TELEVERSEMENT_ECHEC = `
UPDATE televersements SET statut = 'echec', derniere_erreur = ? WHERE id = ?
`;

export const SUPPRIMER_TELEVERSEMENT = `DELETE FROM televersements WHERE id = ?`;

// ---------------------------------------------------------------------------
// Constructeurs de paramètres. Ils vivent ici, collés au SQL : un ordre de
// colonnes ne peut pas diverger de l'ordre des valeurs sans que les tests le
// voient, puisque l'application et les tests appellent les mêmes fonctions.
// ---------------------------------------------------------------------------

/** SQLite n'a pas de booléen : `false` doit devenir `0`, jamais `'false'`. */
const b = (v: boolean): number => (v ? 1 : 0);

export type Parametre = string | number | null;

export function paramsUtilisateur(u: {
  uid: string;
  username: string;
  misAJourLe: number;
}): Parametre[] {
  return [u.uid, u.username, u.misAJourLe];
}

export function paramsMessage(m: MessageLocal): Parametre[] {
  return [
    m.id,
    m.rid,
    m.texte,
    m.horodatage,
    m.auteurId,
    m.auteurNom,
    m.typeSysteme,
    m.filId,
    m.filReponses,
    m.filDernier,
    b(m.filAffiche),
    m.modifieLe,
    m.md,
    m.piecesJointes,
    m.reactions,
    m.urls,
    m.appelId,
    m.chiffreBrut,
    m.misAJourLe,
  ];
}

export function paramsSalon(s: SalonLocal): Parametre[] {
  return [
    s.rid,
    s.type,
    s.nom,
    s.nomAffiche,
    b(s.chiffre),
    b(s.lectureSeule),
    s.dmAutreUid,
    s.dernierMessage,
    s.horodatageDernierMessage,
    s.misAJourLe,
  ];
}

export function paramsAbonnement(a: AbonnementLocal): Parametre[] {
  return [
    a.rid,
    a.subId,
    a.nonLus,
    a.mentions,
    a.mentionsGroupe,
    b(a.alerte),
    b(a.ouvert),
    b(a.favori),
    a.luJusquA,
    a.e2eKey,
    a.e2eKeyId,
    a.misAJourLe,
  ];
}
