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
 * `rooms-changed` peut porter un document partiel (sans `usernames`). `null` y
 * signifie « absent de la charge », jamais « efface » — sans le COALESCE, un
 * tel événement plus récent effacerait le nom dérivé d'un DM, et la liste
 * retomberait sur le `rid` brut.
 *
 * **`dernier_message` fait exception, et c'est délibéré** : son absence est une
 * INFORMATION, pas un trou. Sondé sur 8.5, `rooms-changed` et `rooms.get`
 * portent toujours `lastMessage` dès que le salon en a un — renommage, topic,
 * annonce, description, lecture seule, avatar, DM compris. Le champ ne
 * disparaît que lorsque le salon n'a plus de dernier message visible, c'est-à-
 * dire quand on vient de supprimer le dernier. Le COALESCE d'origine figeait
 * donc à VIE l'aperçu d'un salon vidé : le message supprimé y restait affiché,
 * et aucun rattrapage ne pouvait le déloger.
 *
 * Un salon CHIFFRÉ est le seul cas où le serveur n'a rien à en dire (il ne
 * détient que du ciphertext) : son aperçu vient de `MAJ_APERCU_CHIFFRE`, sur
 * les messages déchiffrés localement. D'où le `CASE`, qui n'y touche pas.
 */
export const UPSERT_SALON = `
INSERT INTO salons (
  rid, type, nom, nom_affiche, chiffre, lecture_seule, dm_autre_uid,
  dernier_message, dernier_message_type, horodatage_dernier_message, avatar_etag,
  mis_a_jour_le
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(rid) DO UPDATE SET
  type = excluded.type,
  nom = COALESCE(excluded.nom, salons.nom),
  nom_affiche = COALESCE(excluded.nom_affiche, salons.nom_affiche),
  chiffre = excluded.chiffre,
  lecture_seule = excluded.lecture_seule,
  dm_autre_uid = COALESCE(excluded.dm_autre_uid, salons.dm_autre_uid),
  dernier_message = CASE
    WHEN excluded.chiffre = 1 THEN salons.dernier_message
    ELSE excluded.dernier_message
  END,
  -- Pas de CASE ici : versSalon rend déjà null pour un salon chiffré, et c'est
  -- la valeur JUSTE — l'aperçu d'un salon chiffré ne vient pas de lastMessage.
  -- Garder l'ancien type y ferait décrire l'aperçu local par le type d'un
  -- message que le serveur, lui, n'a pas su lire.
  dernier_message_type = excluded.dernier_message_type,
  -- L'horodatage, lui, garde son COALESCE : il pilote le TRI de la liste, et
  -- le serveur ne le recule PAS en vidant un salon (le champ lm survit à la
  -- suppression du dernier message, vérifié). L'effacer ferait donc sauter le
  -- salon en fin de liste sans qu'aucun événement ne le justifie.
  horodatage_dernier_message = COALESCE(excluded.horodatage_dernier_message, salons.horodatage_dernier_message),
  -- COALESCE aussi ici, et pour une raison PARTICULIÈRE : un etag écrasé par
  -- null ferait retomber l'URL d'avatar sur sa forme sans query — celle que le
  -- cache image tient déjà avec l'ANCIENNE photo. Le stream updateAvatar est
  -- souvent plus frais que le document Rooms qui suit.
  avatar_etag = COALESCE(excluded.avatar_etag, salons.avatar_etag),
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

/**
 * Identité venue d'une source AUTORITAIRE (`me` au raccordement, `users.info` à
 * l'ouverture d'une fiche) : pseudo courant ET version d'avatar, par uid.
 *
 * Trois écarts assumés avec `UPSERT_UTILISATEUR` :
 *  - `mis_a_jour_le` n'est ni lu ni écrit : ces réponses ne portent pas toutes
 *    un `_updatedAt`, et arbitrer sur l'horloge LOCALE mêlerait deux temps.
 *    L'insertion pose 0 — le plus petit — pour qu'un message ultérieur garde la
 *    main sur le pseudo ;
 *  - `COALESCE` sur l'etag : `users.info` l'OMET quand l'utilisateur n'a pas de
 *    photo, ce qui ne doit pas effacer celui qu'on connaît (voir UPSERT_SALON) ;
 *  - le `WHERE` ne laisse passer qu'un VRAI changement : sans lui, chaque
 *    ouverture de fiche toucherait la table et re-rendrait toutes les lignes
 *    abonnées à `utilisateurs`.
 */
export const UPSERT_IDENTITE = `
INSERT INTO utilisateurs (uid, username, avatar_etag, mis_a_jour_le) VALUES (?, ?, ?, 0)
ON CONFLICT(uid) DO UPDATE SET
  username = excluded.username,
  avatar_etag = COALESCE(excluded.avatar_etag, utilisateurs.avatar_etag)
WHERE excluded.username IS NOT utilisateurs.username
   OR COALESCE(excluded.avatar_etag, utilisateurs.avatar_etag) IS NOT utilisateurs.avatar_etag
`;

/**
 * Version d'avatar poussée par le stream `updateAvatar`, qui désigne sa cible
 * par le PSEUDO (jamais par l'uid) pour un utilisateur, par le `rid` pour un
 * salon. Un utilisateur encore inconnu localement ne touche aucune ligne : son
 * avatar n'est affiché nulle part, et la première fiche ouverte le posera.
 *
 * L'etag est passé DEUX fois : la garde `IS NOT` évite une écriture inutile,
 * donc un rejeu de toutes les requêtes vives assises sur la table.
 */
export const MAJ_AVATAR_UTILISATEUR = `
UPDATE utilisateurs SET avatar_etag = ? WHERE username = ? AND avatar_etag IS NOT ?
`;

export const MAJ_AVATAR_SALON = `
UPDATE salons SET avatar_etag = ? WHERE rid = ? AND avatar_etag IS NOT ?
`;

/** Clés de salon connues, pour la passe de déchiffrement E2EE au déverrouillage. */
export const LISTER_CLES_SALON = `SELECT rid, e2e_key FROM abonnements WHERE e2e_key IS NOT NULL`;
/** Messages chiffrés encore illisibles : ciphertext gardé, clair pas encore posé. */
export const MESSAGES_A_DECHIFFRER = `SELECT id, rid, chiffre_brut FROM messages WHERE chiffre_brut IS NOT NULL AND texte IS NULL`;
/** Pose le clair d'un message une fois déchiffré. */
export const MAJ_TEXTE_MESSAGE = `UPDATE messages SET texte = ? WHERE id = ?`;
/** Re-masque tout message chiffré au verrouillage : le clair local disparaît,
 *  le ciphertext (`chiffre_brut`) reste pour re-déchiffrer au prochain déverrou.
 *
 *  `texte IS NOT NULL` n'est pas cosmétique, comme partout ailleurs ici : un
 *  verrouillage rejoué (`reverrouillageE2E`) sur des messages DÉJÀ masqués
 *  toucherait toute la table sans rien changer, et réveillerait chaque
 *  `useLiveQuery` assise dessus — donc re-rendrait le salon ouvert. */
export const MASQUER_MESSAGES_CHIFFRES = `UPDATE messages SET texte = NULL WHERE chiffre_brut IS NOT NULL AND texte IS NOT NULL`;
/**
 * Aperçu de la liste pour les salons chiffrés DÉVERROUILLÉS : le dernier
 * message déchiffré. Sans déchiffrement, `dernier_message` reste null (le
 * ciphertext n'est jamais stocké) → la liste montre le placeholder.
 *
 * Rejoué à chaque SUPPRESSION de message (voir `Depot.supprimerMessage`) : dans
 * un salon chiffré, le serveur ne peut pas dire quel est le nouveau dernier
 * message, seule la base locale le sait. Sans ce rejeu, effacer le dernier
 * message d'un salon chiffré y laissait son texte en aperçu.
 *
 * Le `IS NOT` final n'est pas cosmétique : sans lui, l'UPDATE toucherait la
 * table à chaque suppression même sans rien changer, et ferait rejouer toutes
 * les requêtes vives assises sur `salons`. La sous-requête est donc répétée —
 * une fois pour écrire, une fois pour décider s'il y a lieu d'écrire.
 *
 * **Elle doit désigner le même message que le FLUX**, sinon l'aperçu annonce
 * quelque chose qu'on ne trouve pas en ouvrant le salon. Trois clauses, copiées
 * de la requête d'`app/salon/[rid].tsx` :
 *  - `fil_id IS NULL OR fil_affiche = 1` : une réponse de fil vit dans son fil,
 *    pas dans le salon — sauf `tshow` ;
 *  - `type_systeme IS NULL OR type_systeme = 'e2e'` : le flux rend un message
 *    système via `texteSysteme()` (« alice a rejoint le salon »), jamais son
 *    `texte` brut — qui pour un `t: 'uj'` n'est QUE le pseudo. Le prendre en
 *    aperçu affichait donc « alice » tout court. C'est exactement le prédicat
 *    `estOrdinaire` de `ui/ligneMessage.tsx`.
 *    ⚠️ Surtout PAS `type_systeme IS NULL` seul : dans un salon chiffré, TOUS
 *    les messages portent `t: 'e2e'` (`lib/normaliser.ts`) — ce filtre-là
 *    viderait l'aperçu de tous les salons chiffrés, c'est-à-dire la seule
 *    chose que cette requête existe pour calculer ;
 *  - `id DESC` en clé secondaire : le flux a dû l'ajouter pour départager deux
 *    messages à la même milliseconde. Sans elle, l'aperçu et la première ligne
 *    du salon peuvent désigner deux messages différents.
 */
export const MAJ_APERCU_CHIFFRE = `
UPDATE salons SET dernier_message = (
  SELECT texte FROM messages
  WHERE messages.rid = salons.rid AND messages.texte IS NOT NULL
    AND (messages.fil_id IS NULL OR messages.fil_affiche = 1)
    AND (messages.type_systeme IS NULL OR messages.type_systeme = 'e2e')
  ORDER BY messages.horodatage DESC, messages.id DESC LIMIT 1
) WHERE chiffre = 1 AND dernier_message IS NOT (
  SELECT texte FROM messages
  WHERE messages.rid = salons.rid AND messages.texte IS NOT NULL
    AND (messages.fil_id IS NULL OR messages.fil_affiche = 1)
    AND (messages.type_systeme IS NULL OR messages.type_systeme = 'e2e')
  ORDER BY messages.horodatage DESC, messages.id DESC LIMIT 1
)`;
/** Au verrouillage : l'aperçu redevient le placeholder (dernier_message null).
 *  Même garde que ci-dessus, pour la liste des salons cette fois. */
export const MASQUER_APERCU_CHIFFRE = `UPDATE salons SET dernier_message = NULL WHERE chiffre = 1 AND dernier_message IS NOT NULL`;

export const SUPPRIMER_MESSAGE = `DELETE FROM messages WHERE id = ?`;

/** Départ d'un salon : le rattrapage (`remove[]` d'updatedSince) fait le ménage. */
export const SUPPRIMER_SALON = `DELETE FROM salons WHERE rid = ?`;
export const SUPPRIMER_ABONNEMENT = `DELETE FROM abonnements WHERE rid = ?`;
/** Les `remove[]` d'abonnements ne portent QUE le `_id` de l'abonnement. */
export const RID_PAR_SUB_ID = `SELECT rid FROM abonnements WHERE sub_id = ?`;

/**
 * Le `rid` d'un brouillon : la clé est `rid` ou `rid:tmid` (fil). Un rid
 * Rocket.Chat ne contient jamais de `:`, la coupe est donc sans ambiguïté.
 * `instr` rend 0 quand il n'y a pas de séparateur — d'où le `CASE`.
 */
const RID_DU_BROUILLON = `substr(cle, 1, CASE WHEN instr(cle, ':') = 0 THEN length(cle) ELSE instr(cle, ':') - 1 END)`;

/**
 * Tous les `rid` que la base connaît, quelle que soit la table qui les porte —
 * l'INSTANTANÉ que la réconciliation doit prendre AVANT sa requête réseau.
 *
 * Pourquoi cet instantané : `purgerSalonsAbsents` reçoit la liste vivante d'un
 * `subscriptions.get` qui a duré ~200 ms, pendant lesquelles le stream DDP a
 * continué d'écrire. Un DM ouvert par un collègue dans cet intervalle n'est
 * dans AUCUNE des deux listes — pas dans les vivants (il n'existait pas quand
 * le serveur a répondu), pas dans les connus (il n'existait pas quand on a
 * relevé la base). Purger `NOT IN (vivants)` l'effaçait ; purger
 * `IN (connus) AND NOT IN (vivants)` l'épargne. C'est l'ORDRE des deux
 * lectures qui porte la justesse, aucun délai.
 *
 * L'union couvre TOUTES les tables à rid, pas seulement les trois du salon :
 * une file d'envoi orpheline (laissée par une purge d'avant ce correctif) n'a
 * plus de ligne nulle part ailleurs, et ne serait donc jamais reprise par une
 * purge bornée aux salons connus. `etat_synchro` y entre sans ses curseurs
 * globaux (`portee = '*'`), qui ne sont pas des rids.
 */
export const LISTER_RIDS_CONNUS = `
SELECT rid FROM salons
UNION SELECT rid FROM abonnements
UNION SELECT rid FROM messages
UNION SELECT rid FROM sortie
UNION SELECT rid FROM televersements
UNION SELECT portee FROM etat_synchro WHERE portee <> '*'
UNION SELECT ${RID_DU_BROUILLON} FROM brouillons
`;

/**
 * Réconciliation anti-fantômes : efface tout ce dont le `rid` était connu au
 * départ et n'est PLUS dans la liste vivante du serveur. `json_each` déballe un
 * tableau JSON de N rids passé en UN seul paramètre — le SQL reste statique
 * (testé tel quel) quel que soit N. Ordre des paramètres : **connus, puis
 * vivants**, partout.
 *
 * L'appelant GARANTIT une liste vivante non vide : `NOT IN (rien)` effacerait
 * tout ce qui est connu.
 *
 * On purge les SEPT tables liées au salon, pas trois. Les quatre autres ne
 * disparaissaient jamais : un brouillon invisible, un curseur qui survit aux
 * messages qu'il décrit (et qu'`UPSERT_CURSEUR` interdit ensuite de corriger,
 * puisqu'il refuse toute régression), et surtout une ligne de `sortie` ou de
 * `televersements` qu'aucun écran ne peut plus afficher — donc plus aucun
 * bouton « abandonner » — mais que le rejeu repousse à CHAQUE raccordement,
 * pour toujours, en retardant les envois légitimes derrière elle.
 */
export const PURGER_SALONS_ABSENTS = `DELETE FROM salons WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGER_ABONNEMENTS_ABSENTS = `DELETE FROM abonnements WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGER_MESSAGES_ABSENTS = `DELETE FROM messages WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGER_SORTIE_ABSENTE = `DELETE FROM sortie WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGER_TELEVERSEMENTS_ABSENTS = `DELETE FROM televersements WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGER_BROUILLONS_ABSENTS = `DELETE FROM brouillons WHERE ${RID_DU_BROUILLON} IN (SELECT value FROM json_each(?)) AND ${RID_DU_BROUILLON} NOT IN (SELECT value FROM json_each(?))`;
/**
 * `portee <> '*'` est INDISPENSABLE : les curseurs globaux (`salons`,
 * `abonnements`) ne sont pas des rids et ne doivent jamais tomber — les perdre
 * relancerait un rattrapage complet à chaque réconciliation.
 */
export const PURGER_CURSEURS_ABSENTS = `DELETE FROM etat_synchro WHERE portee <> '*' AND portee IN (SELECT value FROM json_each(?)) AND portee NOT IN (SELECT value FROM json_each(?))`;

/**
 * Départ d'un salon, immédiat : ce que la purge ferait plus tard, mais tout de
 * suite et pour un seul rid. Sans elles, une ligne de `sortie` laissée par un
 * salon quitté coûte deux appels REST par raccordement (`chat.sendMessage`
 * puis le `chat.getMessage` de `messageLivre`) jusqu'à la prochaine
 * réconciliation — qui n'a lieu qu'UNE fois par session.
 */
export const SUPPRIMER_SORTIE_SALON = `DELETE FROM sortie WHERE rid = ?`;
export const SUPPRIMER_TELEVERSEMENTS_SALON = `DELETE FROM televersements WHERE rid = ?`;
export const SUPPRIMER_BROUILLONS_SALON = `DELETE FROM brouillons WHERE ${RID_DU_BROUILLON} = ?`;
export const SUPPRIMER_CURSEURS_SALON = `DELETE FROM etat_synchro WHERE portee = ?`;

/**
 * Rétention : par salon, ne garder que les N messages les plus RÉCENTS.
 *
 * Sans elle, `messages` ne cesse jamais de croître pour un salon vivant — et
 * ce n'est pas que du texte : `md`, `pieces_jointes`, `reactions` et `urls`
 * sont des blobs JSON souvent plus lourds que le message lui-même. Le seul
 * recours de l'utilisateur sur Android est « vider les données », qui détruit
 * tout, brouillons et file d'envoi compris.
 *
 * Deux exemptions, toutes deux nécessaires :
 *
 * - **les optimistes** (`mis_a_jour_le = 0`) : ils n'existent que localement,
 *   le serveur ne les rendra pas. Ils sont hors du classement, donc ils ne
 *   consomment pas non plus le quota.
 * - **les racines de fil encore référencées** : effacer la racine laisserait
 *   des réponses rattachées à un message introuvable, et l'écran fil ne
 *   saurait plus quoi afficher en tête.
 *
 * Couper par `horodatage` et non par `mis_a_jour_le` : c'est l'ancienneté du
 * MESSAGE qu'on veut, pas celle de sa dernière édition. `id` départage les
 * ex æquo pour que la coupe soit déterministe. Inutile de ré-ancrer le curseur
 * de rattrapage : on ne coupe que par le bas, et l'app sait re-télécharger sa
 * pagination.
 */
export const APPLIQUER_RETENTION = `
DELETE FROM messages WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY rid ORDER BY horodatage DESC, id DESC) AS rang
    FROM messages WHERE mis_a_jour_le <> 0
  ) WHERE rang > ?
) AND id NOT IN (SELECT fil_id FROM messages WHERE fil_id IS NOT NULL)
`;

export const LIRE_CURSEUR = `
SELECT mis_a_jour_depuis FROM etat_synchro WHERE portee = ? AND flux = ?
`;

/**
 * Brouillon de composer, par `rid` ou `rid:tmid`. Pas de garde de fraîcheur ici,
 * contrairement aux upserts venus du réseau : la seule source est la frappe de
 * l'utilisateur, débouncée, et la dernière l'emporte toujours.
 */
export const UPSERT_BROUILLON = `
INSERT INTO brouillons (cle, texte, mis_a_jour_le) VALUES (?, ?, ?)
ON CONFLICT(cle) DO UPDATE SET texte = excluded.texte, mis_a_jour_le = excluded.mis_a_jour_le
`;
export const SUPPRIMER_BROUILLON = `DELETE FROM brouillons WHERE cle = ?`;
export const LIRE_BROUILLON = `SELECT texte FROM brouillons WHERE cle = ?`;

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
INSERT INTO televersements (id, rid, uri, nom, type, legende, statut, derniere_erreur, file_id, cree_le)
VALUES (?, ?, ?, ?, ?, ?, 'en-attente', NULL, NULL, ?)
`;

/**
 * **`en-attente` SEUL.** L'échec était rejoué ici, et `traiter()` est appelé à
 * chaque raccordement : une vidéo que le serveur refuse (413, type hors liste
 * blanche, quota) repoussait donc tous ses octets à chaque flap réseau — cas
 * fréquent sur Android, où `fileSize` est souvent nul et laisse passer la
 * validation locale. Un échec est désormais un terminus : seul le geste
 * « Réessayer » le ré-arme (`REARMER_TELEVERSEMENT`). Un plafond, pas un délai.
 *
 * `envoi` est exclu pour une autre raison : la ligne est déjà prise en charge
 * par une passe en vol, la relister la téléverserait deux fois en parallèle.
 */
export const LISTER_TELEVERSEMENTS_A_ENVOYER = `
SELECT id, rid, uri, nom, type, legende, statut, file_id FROM televersements
WHERE statut = 'en-attente' ORDER BY cree_le, id
`;

/**
 * Prise en charge. La garde `AND statut = 'en-attente'` rend l'opération
 * atomique : deux passes concurrentes ne peuvent pas saisir la même ligne,
 * la seconde met à jour 0 ligne et passe son chemin.
 */
export const MARQUER_TELEVERSEMENT_EN_VOL = `
UPDATE televersements SET statut = 'envoi' WHERE id = ? AND statut = 'en-attente'
`;

/**
 * Ré-armement d'UNE ligne — le geste « Réessayer » du bandeau. Efface le motif
 * de l'échec précédent : le garder afficherait une erreur périmée pendant la
 * nouvelle tentative.
 */
export const REARMER_TELEVERSEMENT = `
UPDATE televersements SET statut = 'en-attente', derniere_erreur = NULL WHERE id = ?
`;

/**
 * Reprise après kill. Un `envoi` qui traîne est l'orphelin d'une exécution
 * précédente, tuée en plein téléversement — Android tue une app en
 * arrière-plan sans prévenir. Sans ce ré-armement, la ligne resterait hors du
 * listage pour toujours : le fichier ne partirait jamais et rien ne le dirait.
 *
 * **La borne n'est pas décorative.** « Orphelin » ne se déduit PAS du seul
 * statut : `SynchroProvider` reconstruit son moteur de fichiers quand l'objet
 * `session` change (un simple renommage suffit), sans jamais arrêter le
 * précédent — et les deux écrivent dans la même connexion SQLite, mémoïsée par
 * nom de fichier. Un ré-armement aveugle rendrait au rejeu une ligne dont
 * l'ancien moteur pousse encore les octets : deux uploads, deux confirms, deux
 * messages. On exclut donc ce que CE runtime a en vol — même discipline que la
 * purge du chantier 6, bornée par un instantané plutôt que par un délai.
 */
export const REARMER_TELEVERSEMENTS_EN_VOL = `
UPDATE televersements SET statut = 'en-attente'
WHERE statut = 'envoi' AND id NOT IN (SELECT value FROM json_each(?))
`;

/** Les octets sont chez le serveur : `rooms.media` a rendu ce `fileId`. */
export const NOTER_FILE_ID = `UPDATE televersements SET file_id = ? WHERE id = ?`;

/**
 * « Ce fichier a-t-il DÉJÀ été posté ? » — posé à SQLite, jamais au réseau.
 *
 * Le cas : `rooms.media` a réussi, `rooms.mediaConfirm` a créé le message,
 * mais sa réponse s'est perdue. Le message existe côté serveur et le stream
 * DDP l'a livré comme n'importe quel autre ; re-confirmer posterait un
 * DOUBLON. Le `fileId` se retrouve dans le `title_link` de la pièce jointe
 * (`/file-upload/<fileId>/<nom>`), donc dans la colonne `pieces_jointes`.
 *
 * Local, donc insensible à la limite REST de 10 appels/min — l'interroger par
 * `chat.getMessage` aurait consommé le quota au pire moment, celui où l'on
 * rejoue une file entière.
 */
export const MESSAGE_AVEC_FICHIER = `
SELECT id FROM messages WHERE rid = ? AND pieces_jointes LIKE '%' || ? || '%' LIMIT 1
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

export function paramsIdentite(i: {
  uid: string;
  username: string;
  avatarEtag: string | null;
}): Parametre[] {
  return [i.uid, i.username, i.avatarEtag];
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
    s.dernierMessageType,
    s.horodatageDernierMessage,
    s.avatarEtag,
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
