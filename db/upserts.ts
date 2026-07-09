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
  fil_id, fil_reponses, modifie_le, md, pieces_jointes, reactions, mis_a_jour_le
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  texte = excluded.texte,
  auteur_nom = excluded.auteur_nom,
  type_systeme = excluded.type_systeme,
  fil_id = excluded.fil_id,
  fil_reponses = excluded.fil_reponses,
  modifie_le = excluded.modifie_le,
  md = excluded.md,
  pieces_jointes = excluded.pieces_jointes,
  reactions = excluded.reactions,
  mis_a_jour_le = excluded.mis_a_jour_le
WHERE excluded.mis_a_jour_le >= messages.mis_a_jour_le
`;

export const UPSERT_SALON = `
INSERT INTO salons (
  rid, type, nom, nom_affiche, chiffre, lecture_seule,
  dernier_message, horodatage_dernier_message, mis_a_jour_le
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(rid) DO UPDATE SET
  type = excluded.type,
  nom = excluded.nom,
  nom_affiche = excluded.nom_affiche,
  chiffre = excluded.chiffre,
  lecture_seule = excluded.lecture_seule,
  dernier_message = excluded.dernier_message,
  horodatage_dernier_message = excluded.horodatage_dernier_message,
  mis_a_jour_le = excluded.mis_a_jour_le
WHERE excluded.mis_a_jour_le >= salons.mis_a_jour_le
`;

export const UPSERT_ABONNEMENT = `
INSERT INTO abonnements (
  rid, non_lus, mentions, mentions_groupe, alerte, ouvert, favori, lu_jusqu_a, mis_a_jour_le
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(rid) DO UPDATE SET
  non_lus = excluded.non_lus,
  mentions = excluded.mentions,
  mentions_groupe = excluded.mentions_groupe,
  alerte = excluded.alerte,
  ouvert = excluded.ouvert,
  favori = excluded.favori,
  lu_jusqu_a = excluded.lu_jusqu_a,
  mis_a_jour_le = excluded.mis_a_jour_le
WHERE excluded.mis_a_jour_le >= abonnements.mis_a_jour_le
`;

/** Curseur de rattrapage. Ne recule jamais : un curseur qui régresse re-télécharge. */
export const UPSERT_CURSEUR = `
INSERT INTO etat_synchro (portee, flux, mis_a_jour_depuis) VALUES (?, ?, ?)
ON CONFLICT(portee, flux) DO UPDATE SET mis_a_jour_depuis = excluded.mis_a_jour_depuis
WHERE excluded.mis_a_jour_depuis > etat_synchro.mis_a_jour_depuis
`;

export const SUPPRIMER_MESSAGE = `DELETE FROM messages WHERE id = ?`;

// ---------------------------------------------------------------------------
// Constructeurs de paramètres. Ils vivent ici, collés au SQL : un ordre de
// colonnes ne peut pas diverger de l'ordre des valeurs sans que les tests le
// voient, puisque l'application et les tests appellent les mêmes fonctions.
// ---------------------------------------------------------------------------

/** SQLite n'a pas de booléen : `false` doit devenir `0`, jamais `'false'`. */
const b = (v: boolean): number => (v ? 1 : 0);

export type Parametre = string | number | null;

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
    m.modifieLe,
    m.md,
    m.piecesJointes,
    m.reactions,
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
    s.dernierMessage,
    s.horodatageDernierMessage,
    s.misAJourLe,
  ];
}

export function paramsAbonnement(a: AbonnementLocal): Parametre[] {
  return [
    a.rid,
    a.nonLus,
    a.mentions,
    a.mentionsGroupe,
    b(a.alerte),
    b(a.ouvert),
    b(a.favori),
    a.luJusquA,
    a.misAJourLe,
  ];
}
