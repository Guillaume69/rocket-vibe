/**
 * Moteur de synchronisation. Le WebSocket et le REST **écrivent tous deux dans
 * SQLite** ; l'UI observe la base. Rien ne remonte de l'UI vers le réseau ici.
 *
 * Pur : la base est derrière l'interface `Depot`, donc ce module se teste sans
 * `expo-sqlite`.
 */

import type { Evenement } from './ddp.ts';
import type { ChangementSync, Traducteur } from './provider.ts';
import type { AbonnementLocal, MessageLocal, SalonLocal } from './normalize.ts';

/**
 * Ce que la synchro attend du moteur E2EE, structurellement (pas d'import de
 * `lib/e2e`, donc pas de cycle) : `MoteurE2E` s'y conforme. Déchiffrement
 * SYNCHRONE — forge l'est — branchable au fil de l'ingestion.
 */
export interface DechiffreurE2E {
  dechiffrerContenu(
    rid: string,
    content: { algorithm: string; ciphertext: string; kid?: string; iv?: string },
  ): { texte: string; piecesJointes: string | null } | null;
  enregistrerCleSalon(rid: string, e2eKey: string | null): void;
}

export interface Depot {
  upsertMessage(m: MessageLocal): Promise<void>;
  upsertSalon(s: SalonLocal): Promise<void>;
  upsertAbonnement(a: AbonnementLocal): Promise<void>;
  supprimerMessage(id: string): Promise<void>;
  supprimerSalon(rid: string): Promise<void>;
  supprimerAbonnement(rid: string): Promise<void>;
  /**
   * Départ d'un salon signalé par le rattrapage : les `remove[]` d'abonnements
   * ne portent que le `_id` de l'abonnement. Efface l'abonnement ET le salon.
   */
  supprimerParSubId(subId: string): Promise<void>;
  /**
   * Tous les `rid` que la base connaît, toutes tables confondues. À relever
   * AVANT la requête réseau de la réconciliation : c'est cet instantané qui
   * borne la purge, et donc qui épargne un salon né pendant le vol.
   */
  listerRidsConnus(): Promise<string[]>;
  /**
   * Réconciliation anti-fantômes : efface tout ce dont le `rid` figurait dans
   * l'instantané `ridsConnus` et ne figure PAS dans la liste vivante. Nettoie
   * les salons supprimés côté serveur dont l'événement 'removed' a été raté —
   * salon, abonnement, messages, mais aussi files d'envoi, brouillons et
   * curseurs. Ne fait RIEN sur une liste vide (garde-fou anti-purge-totale).
   */
  purgerSalonsAbsents(ridsVivants: string[], ridsConnus: string[]): Promise<void>;
  /**
   * Rétention : ne garder que les `nbMax` messages les plus récents de CHAQUE
   * salon, en épargnant les optimistes et les racines de fil référencées.
   */
  appliquerRetention(nbMax: number): Promise<void>;
  /** Curseurs de rattrapage. `lireCurseur` rend null si jamais écrit. */
  lireCurseur(portee: string, flux: string): Promise<number | null>;
  /** N'avance jamais à rebours (garanti par le SQL). */
  ecrireCurseur(portee: string, flux: string, misAJourDepuis: number): Promise<void>;
  /**
   * Le plus grand `_updatedAt` déjà ingéré pour un salon (null si aucun message
   * local). Sert à ré-ancrer le curseur quand `chat.syncMessages` échoue sur un
   * backlog trop gros — voir `rattraperSalon`.
   */
  dernierMessageMisAJour(rid: string): Promise<number | null>;
  /** Clés de salon connues (E2EKey des abonnements) — pour la passe E2EE. */
  listerClesSalon(): Promise<{ rid: string; e2eKey: string }[]>;
  /** Messages chiffrés encore illisibles (`chiffre_brut` présent, `texte` null). */
  messagesADechiffrer(): Promise<{ id: string; rid: string; chiffreBrut: string }[]>;
  /** Pose le clair d'un message (et ses pièces jointes) après déchiffrement au déverrouillage. */
  majTexteMessage(id: string, texte: string, piecesJointes: string | null): Promise<void>;
  /** Épinglage et étoiles posés localement après un geste réussi (`lib/marks.ts`). */
  majMarquesMessage(id: string, epingle: boolean, etoiles: string | null): Promise<void>;
  /**
   * Pose la version d'avatar (`avatarETag`) d'un utilisateur, désigné par son
   * PSEUDO — c'est la seule clé que porte le stream. Sans effet sur un pseudo
   * inconnu localement.
   */
  majAvatarUtilisateur(username: string, etag: string): Promise<void>;
  /** Idem pour un salon, désigné par son `rid`. */
  majAvatarSalon(rid: string, etag: string): Promise<void>;
  /**
   * Identité autoritaire (`me`, `users.info`) : pseudo courant et version
   * d'avatar d'un uid. C'est le seul chemin qui puisse CRÉER la ligne d'un
   * utilisateur qui n'a encore posté aucun message — mon propre compte, le
   * plus souvent.
   */
  enregistrerIdentite(identite: {
    uid: string;
    username: string;
    avatarEtag: string | null;
  }): Promise<void>;
  /** Re-masque le clair de tous les messages chiffrés (au verrouillage). */
  masquerMessagesChiffres(): Promise<void>;
  /** Rafraîchit l'aperçu de liste des salons chiffrés (dernier message déchiffré). */
  majApercuChiffre(): Promise<void>;
  /**
   * Regroupe des écritures en une transaction. Une page d'historique de 50
   * messages doit produire UN commit et UN événement de changement — pas 50
   * ré-exécutions de chaque requête vive de l'UI.
   *
   * `fn` reçoit l'écrivain À UTILISER pour ses écritures : sur SQLite, les
   * méthodes du dépôt lui-même passent par une file qui attend la fin de la
   * transaction ouverte — les appeler depuis `fn` s'interbloquerait. La
   * signature rend l'erreur impossible à écrire.
   */
  transaction(fn: (tx: EcrituresDepot) => Promise<void>): Promise<void>;
}

/** Le sous-ensemble d'écritures utilisable à l'intérieur d'une transaction. */
export type EcrituresDepot = Pick<
  Depot,
  | 'upsertMessage'
  | 'upsertSalon'
  | 'upsertAbonnement'
  | 'supprimerMessage'
  | 'supprimerSalon'
  | 'supprimerAbonnement'
  | 'supprimerParSubId'
  | 'ecrireCurseur'
>;

export const STREAM_MESSAGES = 'stream-room-messages';
export const STREAM_NOTIFY_USER = 'stream-notify-user';
export const STREAM_NOTIFY_ROOM = 'stream-notify-room';

/** Compteurs exposés à l'écran debug : ce qui a été vu, ce qui a été ignoré. */
export type Statistiques = {
  messages: number;
  salons: number;
  abonnements: number;
  suppressions: number;
  ignores: number;
};

export class MoteurSynchro {
  readonly stats: Statistiques = {
    messages: 0,
    salons: 0,
    abonnements: 0,
    suppressions: 0,
    ignores: 0,
  };

  // Champs ordinaires, pas des « parameter properties » : ces dernières ne
  // sont pas une syntaxe effaçable, et empêcheraient de charger le module sous
  // Node — donc de le tester.
  private readonly depot: Depot;
  /** Décode les `Evenement` et documents bruts du serveur : toute la quirk RC est là. */
  private readonly traducteur: Traducteur;
  /** Déchiffreur E2EE, ou `null` : un message chiffré reste alors au placeholder. */
  private dechiffreur: DechiffreurE2E | null;

  constructor(depot: Depot, traducteur: Traducteur, dechiffreur: DechiffreurE2E | null = null) {
    this.depot = depot;
    this.traducteur = traducteur;
    this.dechiffreur = dechiffreur;
  }

  /**
   * Passe de déchiffrement au déverrouillage E2EE : charge toutes les clés de
   * salon connues dans le déchiffreur, puis déchiffre les messages restés
   * illisibles (ingérés verrouillés). Rend le nombre de messages éclaircis.
   * Idempotent : un message déjà en clair n'est plus dans `messagesADechiffrer`.
   */
  async deverrouillageE2E(): Promise<number> {
    if (this.dechiffreur === null) return 0;
    for (const { rid, e2eKey } of await this.depot.listerClesSalon()) {
      this.dechiffreur.enregistrerCleSalon(rid, e2eKey);
    }
    let n = 0;
    for (const m of await this.depot.messagesADechiffrer()) {
      let content: { algorithm: string; ciphertext: string; kid?: string; iv?: string };
      try {
        content = JSON.parse(m.chiffreBrut);
      } catch {
        continue;
      }
      const clair = this.dechiffreur.dechiffrerContenu(m.rid, content);
      if (clair !== null) {
        await this.depot.majTexteMessage(m.id, clair.texte, clair.piecesJointes);
        n++;
      }
    }
    // Rafraîchit l'aperçu de liste TOUJOURS : à la reprise (clé déjà en
    // Keystore), les messages sont déjà en clair → `n` vaut 0, mais l'aperçu
    // reste à poser depuis ces messages déchiffrés lors d'une session passée.
    await this.depot.majApercuChiffre();
    return n;
  }

  /** Verrouillage : efface le clair local des messages chiffrés (placeholder à nouveau). */
  async reverrouillageE2E(): Promise<void> {
    await this.depot.masquerMessagesChiffres();
  }

  /**
   * Déchiffre sur place le `texte` d'un message chiffré, si on a la clé. Sans
   * clé (verrouillé, salon pas encore déverrouillé) : `texte` reste null, le
   * `chiffreBrut` conservé permettra une passe au déverrouillage.
   */
  private dechiffrer(message: MessageLocal): void {
    if (message.chiffreBrut === null || this.dechiffreur === null) return;
    let content: { algorithm: string; ciphertext: string; kid?: string; iv?: string };
    try {
      content = JSON.parse(message.chiffreBrut);
    } catch {
      return;
    }
    const clair = this.dechiffreur.dechiffrerContenu(message.rid, content);
    if (clair === null) return;
    message.texte = clair.texte;
    if (clair.piecesJointes !== null) message.piecesJointes = clair.piecesJointes;
  }

  /**
   * Applique un événement temps réel. Le traducteur du fournisseur le décode ;
   * le moteur n'écrit plus que des formes neutres. Une anomalie (stream
   * inattendu) est **comptée, jamais planquée** ; un `silence` attendu
   * (`user-activity`) ne compte pas.
   */
  async appliquer(evenement: Evenement): Promise<void> {
    const traduction = this.traducteur.traduireEvenement(evenement);
    if (traduction.sorte === 'silence') return;
    if (traduction.sorte === 'ignore') {
      this.stats.ignores++;
      return;
    }
    await this.appliquerChangement(traduction.changement);
  }

  /** Écrit un changement déjà normalisé dans le dépôt. Le seul chemin d'écriture. */
  private async appliquerChangement(changement: ChangementSync): Promise<void> {
    switch (changement.type) {
      case 'message':
        this.dechiffrer(changement.doc);
        await this.depot.upsertMessage(changement.doc);
        this.stats.messages++;
        // Un message chiffré déchiffré en direct rafraîchit l'aperçu de liste.
        if (changement.doc.chiffreBrut !== null && changement.doc.texte !== null) {
          await this.depot.majApercuChiffre();
        }
        return;
      case 'salon':
        await this.depot.upsertSalon(changement.doc);
        this.stats.salons++;
        return;
      case 'abonnement':
        this.dechiffreur?.enregistrerCleSalon(changement.doc.rid, changement.doc.e2eKey);
        await this.depot.upsertAbonnement(changement.doc);
        this.stats.abonnements++;
        return;
      case 'suppr-message':
        await this.depot.supprimerMessage(changement.id);
        this.stats.suppressions++;
        return;
      case 'suppr-salon':
        await this.depot.supprimerSalon(changement.rid);
        this.stats.suppressions++;
        return;
      case 'suppr-abonnement-par-sub':
        await this.depot.supprimerParSubId(changement.subId);
        this.stats.suppressions++;
        return;
      case 'avatar':
        // Ni compté ni ignoré : ce n'est pas un document, juste la version
        // d'une photo. Une cible sans pseudo NI rid n'existe pas côté serveur.
        if (changement.username !== null) {
          await this.depot.majAvatarUtilisateur(changement.username, changement.etag);
        }
        if (changement.rid !== null) {
          await this.depot.majAvatarSalon(changement.rid, changement.etag);
        }
        return;
    }
  }

  /**
   * Ingestion d'un lot REST : mêmes upserts, mêmes garanties d'idempotence,
   * mais en une seule transaction — voir `Depot.transaction`.
   *
   * Rend le plus grand `_updatedAt` ingéré (ou null) : c'est la matière des
   * curseurs de rattrapage — un curseur bâti sur l'horloge locale mentirait.
   */
  async ingererMessages(bruts: Record<string, unknown>[]): Promise<number | null> {
    let plusRecent: number | null = null;
    await this.depot.transaction(async (tx) => {
      for (const brut of bruts) {
        const message = this.traducteur.versMessage(brut);
        if (message === null) {
          this.stats.ignores++;
          continue;
        }
        this.dechiffrer(message);
        await tx.upsertMessage(message);
        this.stats.messages++;
        if (plusRecent === null || message.misAJourLe > plusRecent) {
          plusRecent = message.misAJourLe;
        }
      }
    });
    return plusRecent;
  }

  async ingererSalons(bruts: Record<string, unknown>[]): Promise<number | null> {
    let plusRecent: number | null = null;
    await this.depot.transaction(async (tx) => {
      for (const brut of bruts) {
        const salon = this.traducteur.versSalon(brut);
        if (salon === null) {
          this.stats.ignores++;
          continue;
        }
        await tx.upsertSalon(salon);
        this.stats.salons++;
        if (plusRecent === null || salon.misAJourLe > plusRecent) {
          plusRecent = salon.misAJourLe;
        }
      }
    });
    return plusRecent;
  }

  async ingererAbonnements(bruts: Record<string, unknown>[]): Promise<number | null> {
    let plusRecent: number | null = null;
    await this.depot.transaction(async (tx) => {
      for (const brut of bruts) {
        const abonnement = this.traducteur.versAbonnement(brut);
        if (abonnement === null) {
          this.stats.ignores++;
          continue;
        }
        this.dechiffreur?.enregistrerCleSalon(abonnement.rid, abonnement.e2eKey);
        await tx.upsertAbonnement(abonnement);
        this.stats.abonnements++;
        if (plusRecent === null || abonnement.misAJourLe > plusRecent) {
          plusRecent = abonnement.misAJourLe;
        }
      }
    });
    return plusRecent;
  }

  /** Accès au dépôt pour le rattrapage (curseurs, suppressions). */
  get depotSynchro(): Depot {
    return this.depot;
  }
}
