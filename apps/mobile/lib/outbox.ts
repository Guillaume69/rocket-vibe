/**
 * File d'envoi (outbox) et UI optimiste.
 *
 * Le `_id` du message est généré CÔTÉ CLIENT, 24 hexadécimaux, AVANT tout
 * affichage : c'est la clé de tout. Le message apparaît immédiatement (ligne
 * `messages` avec `misAJourLe = 0`, que n'importe quelle version serveur
 * écrase), la file `sortie` persiste l'intention. Un rejeu après crash ne crée
 * jamais de doublon : le serveur le refuse en 400 sur un `_id` déjà accepté, et
 * `chat.getMessage` tranche entre « déjà livré » et « refusé ».
 *
 * Réseau injoignable (statut 0) : le message RESTE `en-attente`, le rejeu du
 * prochain démarrage ou retour de réseau l'emportera. Refus du serveur
 * (4xx/5xx) : `echec`, actionnable depuis l'UI.
 *
 * Salon chiffré : le texte est chiffré au moment de partir, jamais avant — la
 * file garde le clair, comme la base garde les messages déchiffrés. Sans clé
 * (verrouillé), la ligne attend le déverrouillage au lieu d'échouer.
 *
 * Pur : la base est derrière `DepotEnvoi`, le REST derrière `ClientRest` —
 * tout se teste sous Node.
 */

import type { EncryptedContent } from './e2e/crypto.ts';
import { mentionsE2E } from './e2e/mentions.ts';
import { ENCRYPTED_TYPE, type MessageLocal } from './normalize.ts';
import { RestError, type ClientRest } from './rest.ts';

export type OutboxRow = {
  id: string;
  rid: string;
  text: string;
  threadId: string | null;
  status: 'en-attente' | 'echec';
  attempts: number;
};

export interface OutboxStore {
  insertOutbox(id: string, rid: string, texte: string, filId: string | null): Promise<void>;
  listToSend(): Promise<OutboxRow[]>;
  markFailed(id: string, erreur: string): Promise<void>;
  deleteOutbox(id: string): Promise<void>;
  upsertMessage(m: MessageLocal): Promise<void>;
  /** N'efface le message que s'il est encore optimiste (jamais livré). */
  deleteOptimisticMessage(id: string): Promise<void>;
  roomEncrypted(rid: string): Promise<boolean>;
}

/** Le chiffrement E2EE d'une charge, ou `null` tant qu'il est impossible (verrouillé, clé absente). */
export interface OutboxEncryptor {
  encrypt(rid: string, charge: object): EncryptedContent | null;
}

/** 24 hexadécimaux depuis 12 octets — le format des `_id` Rocket.Chat. */
export function idFromBytes(octets: Uint8Array): string {
  return Array.from(octets.slice(0, 12), (o) => o.toString(16).padStart(2, '0')).join('');
}

type ReponseEnvoi = { message?: Record<string, unknown> };

/** Verdict de `messageLivre` quand la question n'a pas pu être posée. */
const INCONNU = Symbol('livraison indéterminée');

export class OutboxEngine {
  private readonly store: OutboxStore;
  private readonly client: ClientRest;
  private readonly me: { id: string; username: string };
  private readonly generateId: () => string;
  private readonly now: () => number;
  /** Réconciliation : le document renvoyé par le serveur repasse par la synchro. */
  private readonly ingest: (doc: Record<string, unknown>) => Promise<void>;
  private readonly encryptor: OutboxEncryptor | null;
  private inFlight = false;

  constructor(options: {
    store: OutboxStore;
    client: ClientRest;
    me: { id: string; username: string };
    generateId: () => string;
    ingest: (doc: Record<string, unknown>) => Promise<void>;
    encryptor?: OutboxEncryptor | null;
    now?: () => number;
  }) {
    this.store = options.store;
    this.client = options.client;
    this.me = options.me;
    this.generateId = options.generateId;
    this.ingest = options.ingest;
    this.encryptor = options.encryptor ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Affichage immédiat + persistance de l'intention, PUIS tentative d'envoi.
   * Rend l'`_id` généré. `filId` (le `tmid` Rocket.Chat) fait de ce message
   * une réponse de fil. `jointesLocales` (JSON `attachments`) n'existe que
   * pour l'AFFICHAGE optimiste — une citation, typiquement : le serveur
   * reconstruira les vraies pièces jointes depuis le texte, et sa version
   * (misAJourLe réel) écrase celle-ci. RIEN n'en part sur le réseau.
   */
  async send(
    rid: string,
    texte: string,
    filId: string | null = null,
    jointesLocales: string | null = null,
  ): Promise<string> {
    const id = this.generateId();
    const quand = this.now();
    await this.store.upsertMessage({
      id,
      rid,
      text: texte,
      ts: quand,
      authorId: this.me.id,
      authorName: this.me.username,
      systemType: (await this.store.roomEncrypted(rid)) ? ENCRYPTED_TYPE : null,
      threadId: filId,
      threadCount: 0,
      threadLast: null,
      threadShown: false,
      editedAt: null,
      md: null,
      attachments: jointesLocales,
      reactions: null,
      urls: null,
      callId: null,
      encryptedRaw: null,
      pinned: false,
      starred: null,
      // 0 : la version du serveur, quelle qu'elle soit, écrase l'optimiste —
      // et l'optimiste n'écrase jamais un état réel.
      updatedAt: 0,
    });
    await this.store.insertOutbox(id, rid, texte, filId);
    await this.process();
    return id;
  }

  private rerun = false;

  /**
   * Rejoue tout ce qui attend, dans l'ordre. Ré-entrant sans dégât : une
   * seule passe à la fois — et une passe demandée PENDANT qu'une autre court
   * est notée puis exécutée à la fin, sinon un message envoyé pendant le
   * flush resterait « ⏳ » jusqu'au prochain déclencheur.
   */
  async process(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.rerun = false;
        if (!(await this.runPass())) return;
      } while (this.rerun);
    } finally {
      this.inFlight = false;
    }
  }

  /** Rend `false` si le réseau est injoignable — inutile d'insister. */
  private async runPass(): Promise<boolean> {
    for (const ligne of await this.store.listToSend()) {
      const message = await this.messageBody(ligne);
      if (message === null) continue;
      try {
        const reponse = await this.client.post<ReponseEnvoi>('chat.sendMessage', {
          body: { message },
        });
        await this.store.deleteOutbox(ligne.id);
        if (reponse.message !== undefined) await this.ingest(reponse.message);
      } catch (e) {
        if (e instanceof RestError && e.status === 0) {
          // Injoignable : on n'y peut rien d'ici. La ligne reste telle
          // quelle, le prochain `traiter()` retentera.
          return false;
        }
        // Le rejeu d'un `_id` déjà accepté n'est PAS idempotent côté
        // serveur : Rocket.Chat 8.5 répond 400 (« Cannot read properties of
        // undefined (reading 'starred') », vérifié). Aucun doublon n'est
        // créé, mais la réponse ne distingue pas « déjà livré » de
        // « refusé » : on demande au serveur.
        const livre = await this.messageDelivered(ligne.id);
        if (livre === INCONNU) {
          // On n'a pas pu trancher. La ligne reste `en-attente` — donc
          // rejouable — et la passe s'arrête : les lignes suivantes
          // brûleraient le même quota pour le même verdict.
          return false;
        }
        if (livre !== null) {
          // Ingérer le document récupéré : c'est la vraie version (ts du
          // serveur), et son passage par le dépôt réconcilie la sortie.
          await this.ingest(livre);
          await this.store.deleteOutbox(ligne.id);
          continue;
        }
        // `derniere_erreur` est un DIAGNOSTIC (jamais affiché — l'UI montre
        // `ligneMessage.echecReessayer`) : pas une chaîne à traduire.
        const message = e instanceof Error ? e.message : 'Envoi refusé.';
        await this.store.markFailed(ligne.id, message);
      }
    }
    return true;
  }

  /** Le message tel qu'il part, ou `null` s'il doit attendre une clé de salon. */
  private async messageBody(ligne: OutboxRow): Promise<Record<string, unknown> | null> {
    const base = {
      _id: ligne.id,
      rid: ligne.rid,
      ...(ligne.threadId === null ? {} : { tmid: ligne.threadId }),
    };
    if (!(await this.store.roomEncrypted(ligne.rid))) return { ...base, msg: ligne.text };
    const content = this.encryptor?.encrypt(ligne.rid, { msg: ligne.text }) ?? null;
    if (content === null) return null;
    return { ...base, t: ENCRYPTED_TYPE, e2e: 'pending', content, e2eMentions: mentionsE2E(ligne.text) };
  }

  /** Abandon d'un échec définitif : la ligne de sortie ET l'optimiste s'en vont. */
  async discard(id: string): Promise<void> {
    await this.store.deleteOutbox(id);
    await this.store.deleteOptimisticMessage(id);
  }

  /**
   * TROIS verdicts, pas deux : le document si le serveur l'a, `null` s'il
   * répond que non, `'inconnu'` si on n'a PAS PU demander.
   *
   * La distinction n'est pas cosmétique. « Je n'ai pas pu vérifier » n'est pas
   * « le serveur dit que non » : tout confondre en `null` faisait marquer
   * `echec` — donc afficher « non envoyé » — sur un message que le serveur
   * avait peut-être accepté. L'utilisateur le retape : il en a deux.
   */
  private async messageDelivered(
    id: string,
  ): Promise<Record<string, unknown> | typeof INCONNU | null> {
    try {
      const reponse = await this.client.get<{ message?: Record<string, unknown> }>(
        'chat.getMessage',
        { params: { msgId: id } },
      );
      const doc = reponse.message;
      return doc !== undefined && doc._id === id ? doc : null;
    } catch (e) {
      // Statut 0 : personne n'a répondu. 429 : `chat.getMessage` subit la même
      // limite de 10/min que `chat.sendMessage` (CLAUDE.md), et une rafale
      // d'envois l'épuise — après les trois rejeux de `ClientRest`, toutes les
      // vérifications de la passe retombent en 429. Ni l'un ni l'autre n'est
      // un démenti du serveur.
      if (e instanceof RestError && (e.status === 0 || e.status === 429)) return INCONNU;
      // Le serveur a parlé (404, droit refusé, message absent) : on tranche.
      return null;
    }
  }
}
