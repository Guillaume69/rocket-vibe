/**
 * Moteur de synchronisation. Le WebSocket et le REST **écrivent tous deux dans
 * SQLite** ; l'UI observe la base. Rien ne remonte de l'UI vers le réseau ici.
 *
 * Pur : la base est derrière l'interface `Depot`, donc ce module se teste sans
 * `expo-sqlite`.
 */

import type { DdpEvent } from './ddp.ts';
import type { SyncChange, Translator } from './provider.ts';
import type { LocalSubscription, MessageLocal, LocalRoom } from './normalize.ts';

/**
 * Ce que la synchro attend du moteur E2EE, structurellement (pas d'import de
 * `lib/e2e`, donc pas de cycle) : `MoteurE2E` s'y conforme. Déchiffrement
 * SYNCHRONE — forge l'est — branchable au fil de l'ingestion.
 */
export interface E2EDecryptor {
  decryptContent(
    rid: string,
    content: { algorithm: string; ciphertext: string; kid?: string; iv?: string },
  ): { text: string; attachments: string | null } | null;
  saveRoomKey(rid: string, e2eKey: string | null): void;
}

export interface Store {
  upsertMessage(m: MessageLocal): Promise<void>;
  upsertRoom(s: LocalRoom): Promise<void>;
  upsertSubscription(a: LocalSubscription): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  deleteRoom(rid: string): Promise<void>;
  deleteSubscription(rid: string): Promise<void>;
  /**
   * Départ d'un salon signalé par le rattrapage : les `remove[]` d'abonnements
   * ne portent que le `_id` de l'abonnement. Efface l'abonnement ET le salon.
   */
  deleteBySubId(subId: string): Promise<void>;
  /**
   * Tous les `rid` que la base connaît, toutes tables confondues. À relever
   * AVANT la requête réseau de la réconciliation : c'est cet instantané qui
   * borne la purge, et donc qui épargne un salon né pendant le vol.
   */
  listKnownRids(): Promise<string[]>;
  /**
   * Réconciliation anti-fantômes : efface tout ce dont le `rid` figurait dans
   * l'instantané `ridsConnus` et ne figure PAS dans la liste vivante. Nettoie
   * les salons supprimés côté serveur dont l'événement 'removed' a été raté —
   * salon, abonnement, messages, mais aussi files d'envoi, brouillons et
   * curseurs. Ne fait RIEN sur une liste vide (garde-fou anti-purge-totale).
   */
  purgeMissingRooms(aliveRids: string[], knownRids: string[]): Promise<void>;
  /**
   * Rétention : ne garder que les `nbMax` messages les plus récents de CHAQUE
   * salon, en épargnant les optimistes et les racines de fil référencées.
   */
  applyRetention(nbMax: number): Promise<void>;
  /** Curseurs de rattrapage. `lireCurseur` rend null si jamais écrit. */
  readCursor(scope: string, stream: string): Promise<number | null>;
  /** N'avance jamais à rebours (garanti par le SQL). */
  writeCursor(scope: string, stream: string, updatedSince: number): Promise<void>;
  /**
   * Le plus grand `_updatedAt` déjà ingéré pour un salon (null si aucun message
   * local). Sert à ré-ancrer le curseur quand `chat.syncMessages` échoue sur un
   * backlog trop gros — voir `rattraperSalon`.
   */
  lastMessageUpdatedAt(rid: string): Promise<number | null>;
  /** Clés de salon connues (E2EKey des abonnements) — pour la passe E2EE. */
  listRoomKeys(): Promise<{ rid: string; e2eKey: string }[]>;
  /** Messages chiffrés encore illisibles (`chiffre_brut` présent, `texte` null). */
  messagesToDecrypt(): Promise<{ id: string; rid: string; encryptedRaw: string }[]>;
  /** Pose le clair d'un message (et ses pièces jointes) après déchiffrement au déverrouillage. */
  updateMessageText(id: string, text: string, attachments: string | null): Promise<void>;
  /** Épinglage et étoiles posés localement après un geste réussi (`lib/marks.ts`). */
  updateMessageMarks(id: string, pinned: boolean, starred: string | null): Promise<void>;
  /**
   * Pose la version d'avatar (`avatarETag`) d'un utilisateur, désigné par son
   * PSEUDO — c'est la seule clé que porte le stream. Sans effet sur un pseudo
   * inconnu localement.
   */
  updateUserAvatar(username: string, etag: string): Promise<void>;
  /** Idem pour un salon, désigné par son `rid`. */
  updateRoomAvatar(rid: string, etag: string): Promise<void>;
  /**
   * Identité autoritaire (`me`, `users.info`) : pseudo courant et version
   * d'avatar d'un uid. C'est le seul chemin qui puisse CRÉER la ligne d'un
   * utilisateur qui n'a encore posté aucun message — mon propre compte, le
   * plus souvent.
   */
  saveIdentity(identity: {
    uid: string;
    username: string;
    avatarEtag: string | null;
  }): Promise<void>;
  /** Re-masque le clair de tous les messages chiffrés (au verrouillage). */
  hideEncryptedMessages(): Promise<void>;
  /** Rafraîchit l'aperçu de liste des salons chiffrés (dernier message déchiffré). */
  updateEncryptedPreview(): Promise<void>;
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
  transaction(fn: (tx: StoreWrites) => Promise<void>): Promise<void>;
}

/** Le sous-ensemble d'écritures utilisable à l'intérieur d'une transaction. */
export type StoreWrites = Pick<
  Store,
  | 'upsertMessage'
  | 'upsertRoom'
  | 'upsertSubscription'
  | 'deleteMessage'
  | 'deleteRoom'
  | 'deleteSubscription'
  | 'deleteBySubId'
  | 'writeCursor'
>;

export const STREAM_MESSAGES = 'stream-room-messages';
export const STREAM_NOTIFY_USER = 'stream-notify-user';
export const STREAM_NOTIFY_ROOM = 'stream-notify-room';

/** Compteurs exposés à l'écran debug : ce qui a été vu, ce qui a été ignoré. */
export type Stats = {
  messages: number;
  rooms: number;
  subscriptions: number;
  deletions: number;
  ignores: number;
};

export class SyncEngine {
  readonly stats: Stats = {
    messages: 0,
    rooms: 0,
    subscriptions: 0,
    deletions: 0,
    ignores: 0,
  };

  // Champs ordinaires, pas des « parameter properties » : ces dernières ne
  // sont pas une syntaxe effaçable, et empêcheraient de charger le module sous
  // Node — donc de le tester.
  private readonly store: Store;
  /** Décode les `Evenement` et documents bruts du serveur : toute la quirk RC est là. */
  private readonly translator: Translator;
  /** Déchiffreur E2EE, ou `null` : un message chiffré reste alors au placeholder. */
  private decryptor: E2EDecryptor | null;

  constructor(store: Store, translator: Translator, decryptor: E2EDecryptor | null = null) {
    this.store = store;
    this.translator = translator;
    this.decryptor = decryptor;
  }

  /**
   * Passe de déchiffrement au déverrouillage E2EE : charge toutes les clés de
   * salon connues dans le déchiffreur, puis déchiffre les messages restés
   * illisibles (ingérés verrouillés). Rend le nombre de messages éclaircis.
   * Idempotent : un message déjà en clair n'est plus dans `messagesADechiffrer`.
   */
  async e2eUnlocked(): Promise<number> {
    if (this.decryptor === null) return 0;
    for (const { rid, e2eKey } of await this.store.listRoomKeys()) {
      this.decryptor.saveRoomKey(rid, e2eKey);
    }
    let n = 0;
    for (const m of await this.store.messagesToDecrypt()) {
      let content: { algorithm: string; ciphertext: string; kid?: string; iv?: string };
      try {
        content = JSON.parse(m.encryptedRaw);
      } catch {
        continue;
      }
      const plain = this.decryptor.decryptContent(m.rid, content);
      if (plain !== null) {
        await this.store.updateMessageText(m.id, plain.text, plain.attachments);
        n++;
      }
    }
    // Rafraîchit l'aperçu de liste TOUJOURS : à la reprise (clé déjà en
    // Keystore), les messages sont déjà en clair → `n` vaut 0, mais l'aperçu
    // reste à poser depuis ces messages déchiffrés lors d'une session passée.
    await this.store.updateEncryptedPreview();
    return n;
  }

  /** Verrouillage : efface le clair local des messages chiffrés (placeholder à nouveau). */
  async e2eRelocked(): Promise<void> {
    await this.store.hideEncryptedMessages();
  }

  /**
   * Déchiffre sur place le `texte` d'un message chiffré, si on a la clé. Sans
   * clé (verrouillé, salon pas encore déverrouillé) : `texte` reste null, le
   * `chiffreBrut` conservé permettra une passe au déverrouillage.
   */
  private decrypt(message: MessageLocal): void {
    if (message.encryptedRaw === null || this.decryptor === null) return;
    let content: { algorithm: string; ciphertext: string; kid?: string; iv?: string };
    try {
      content = JSON.parse(message.encryptedRaw);
    } catch {
      return;
    }
    const plain = this.decryptor.decryptContent(message.rid, content);
    if (plain === null) return;
    message.text = plain.text;
    if (plain.attachments !== null) message.attachments = plain.attachments;
  }

  /**
   * Applique un événement temps réel. Le traducteur du fournisseur le décode ;
   * le moteur n'écrit plus que des formes neutres. Une anomalie (stream
   * inattendu) est **comptée, jamais planquée** ; un `silence` attendu
   * (`user-activity`) ne compte pas.
   */
  async apply(event: DdpEvent): Promise<void> {
    const translation = this.translator.translateEvent(event);
    if (translation.kind === 'silence') return;
    if (translation.kind === 'ignore') {
      this.stats.ignores++;
      return;
    }
    await this.applyChange(translation.change);
  }

  /** Écrit un changement déjà normalisé dans le dépôt. Le seul chemin d'écriture. */
  private async applyChange(change: SyncChange): Promise<void> {
    switch (change.type) {
      case 'message':
        this.decrypt(change.doc);
        await this.store.upsertMessage(change.doc);
        this.stats.messages++;
        // Un message chiffré déchiffré en direct rafraîchit l'aperçu de liste.
        if (change.doc.encryptedRaw !== null && change.doc.text !== null) {
          await this.store.updateEncryptedPreview();
        }
        return;
      case 'room':
        await this.store.upsertRoom(change.doc);
        this.stats.rooms++;
        return;
      case 'subscription':
        this.decryptor?.saveRoomKey(change.doc.rid, change.doc.e2eKey);
        await this.store.upsertSubscription(change.doc);
        this.stats.subscriptions++;
        return;
      case 'message-deleted':
        await this.store.deleteMessage(change.id);
        this.stats.deletions++;
        return;
      case 'room-deleted':
        await this.store.deleteRoom(change.rid);
        this.stats.deletions++;
        return;
      case 'subscription-deleted-by-sub':
        await this.store.deleteBySubId(change.subId);
        this.stats.deletions++;
        return;
      case 'avatar':
        // Ni compté ni ignoré : ce n'est pas un document, juste la version
        // d'une photo. Une cible sans pseudo NI rid n'existe pas côté serveur.
        if (change.username !== null) {
          await this.store.updateUserAvatar(change.username, change.etag);
        }
        if (change.rid !== null) {
          await this.store.updateRoomAvatar(change.rid, change.etag);
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
  async ingestMessages(rawItems: Record<string, unknown>[]): Promise<number | null> {
    let latest: number | null = null;
    await this.store.transaction(async (tx) => {
      for (const raw of rawItems) {
        const message = this.translator.toMessage(raw);
        if (message === null) {
          this.stats.ignores++;
          continue;
        }
        this.decrypt(message);
        await tx.upsertMessage(message);
        this.stats.messages++;
        if (latest === null || message.updatedAt > latest) {
          latest = message.updatedAt;
        }
      }
    });
    return latest;
  }

  async ingestRooms(rawItems: Record<string, unknown>[]): Promise<number | null> {
    let latest: number | null = null;
    await this.store.transaction(async (tx) => {
      for (const raw of rawItems) {
        const room = this.translator.toRoom(raw);
        if (room === null) {
          this.stats.ignores++;
          continue;
        }
        await tx.upsertRoom(room);
        this.stats.rooms++;
        if (latest === null || room.updatedAt > latest) {
          latest = room.updatedAt;
        }
      }
    });
    return latest;
  }

  async ingestSubscriptions(rawItems: Record<string, unknown>[]): Promise<number | null> {
    let latest: number | null = null;
    await this.store.transaction(async (tx) => {
      for (const raw of rawItems) {
        const subscription = this.translator.toSubscription(raw);
        if (subscription === null) {
          this.stats.ignores++;
          continue;
        }
        this.decryptor?.saveRoomKey(subscription.rid, subscription.e2eKey);
        await tx.upsertSubscription(subscription);
        this.stats.subscriptions++;
        if (latest === null || subscription.updatedAt > latest) {
          latest = subscription.updatedAt;
        }
      }
    });
    return latest;
  }

  /** Accès au dépôt pour le rattrapage (curseurs, suppressions). */
  get syncStore(): Store {
    return this.store;
  }
}
