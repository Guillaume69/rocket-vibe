/**
 * Moteur de synchronisation. Le WebSocket et le REST **écrivent tous deux dans
 * SQLite** ; l'UI observe la base. Rien ne remonte de l'UI vers le réseau ici.
 *
 * Pur : la base est derrière l'interface `Depot`, donc ce module se teste sans
 * `expo-sqlite`.
 */

import type { Evenement } from './ddp.ts';
import {
  versAbonnement,
  versMessage,
  versSalon,
  type AbonnementLocal,
  type MessageLocal,
  type SalonLocal,
} from './normaliser.ts';

/**
 * Ce que la synchro attend du moteur E2EE, structurellement (pas d'import de
 * `lib/e2e`, donc pas de cycle) : `MoteurE2E` s'y conforme. Déchiffrement
 * SYNCHRONE — forge l'est — branchable au fil de l'ingestion.
 */
export interface DechiffreurE2E {
  dechiffrerContenu(
    rid: string,
    content: { algorithm: string; kid: string; iv: string; ciphertext: string },
  ): string | null;
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
   * Réconciliation anti-fantômes : efface tout salon (et son abonnement, ses
   * messages) dont le `rid` n'est PAS dans la liste vivante. Nettoie les
   * salons supprimés côté serveur dont l'événement 'removed' a été raté. Ne
   * fait RIEN sur une liste vide (garde-fou anti-purge-totale).
   */
  purgerSalonsAbsents(ridsVivants: string[]): Promise<void>;
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
  /** Pose le clair d'un message après déchiffrement au déverrouillage. */
  majTexteMessage(id: string, texte: string): Promise<void>;
  /** Re-masque le clair de tous les messages chiffrés (au verrouillage). */
  masquerMessagesChiffres(): Promise<void>;
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
  /** Nom d'utilisateur du compte courant — sert à nommer les messages directs. */
  private readonly moi: string | null;
  /** Uid du compte courant — extrait l'autre participant d'un DM (présence). */
  private readonly moiUid: string | null;
  /** Déchiffreur E2EE, ou `null` : un message chiffré reste alors au placeholder. */
  private dechiffreur: DechiffreurE2E | null;

  constructor(
    depot: Depot,
    moi: string | null = null,
    moiUid: string | null = null,
    dechiffreur: DechiffreurE2E | null = null,
  ) {
    this.depot = depot;
    this.moi = moi;
    this.moiUid = moiUid;
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
      let content: { algorithm: string; kid: string; iv: string; ciphertext: string };
      try {
        content = JSON.parse(m.chiffreBrut);
      } catch {
        continue;
      }
      const clair = this.dechiffreur.dechiffrerContenu(m.rid, content);
      if (clair !== null) {
        await this.depot.majTexteMessage(m.id, clair);
        n++;
      }
    }
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
    let content: { algorithm: string; kid: string; iv: string; ciphertext: string };
    try {
      content = JSON.parse(message.chiffreBrut);
    } catch {
      return;
    }
    const clair = this.dechiffreur.dechiffrerContenu(message.rid, content);
    if (clair !== null) message.texte = clair;
  }

  /**
   * Applique un événement DDP. Les charges utiles inconnues sont **ignorées en
   * silence, mais comptées** : un stream qu'on n'attendait pas ne doit ni
   * planter, ni disparaître sans trace.
   */
  async appliquer(evenement: Evenement): Promise<void> {
    switch (evenement.collection) {
      case STREAM_MESSAGES: {
        // Ici, et ici seulement, `args[0]` est directement le document.
        const document = objetOuNull(evenement.args[0]);
        if (document === null) {
          this.stats.ignores++;
          return;
        }
        await this.appliquerMessage(document);
        return;
      }

      case STREAM_NOTIFY_USER: {
        // La clé vaut `<uid>/<sujet>`. Le sujet seul nous intéresse.
        // Attention : ce stream envoie `args: ['updated', {…}]` — le premier
        // argument est une ACTION, pas le document. Le rejeter ici ferait
        // silencieusement disparaître tous les changements d'abonnement.
        const sujet = sujetDe(evenement.cleEvenement);
        if (sujet === 'subscriptions-changed') return this.appliquerAbonnement(evenement);
        if (sujet === 'rooms-changed') return this.appliquerSalon(evenement);
        this.stats.ignores++;
        return;
      }

      case STREAM_NOTIFY_ROOM: {
        const sujet = sujetDe(evenement.cleEvenement);
        // `user-activity` est ATTENDU (l'écran salon s'y abonne pour la
        // saisie, 8.6) mais traité ailleurs : le compter en « ignoré »
        // noierait le compteur d'anomalies sous des battements de frappe.
        if (sujet === 'user-activity') return;
        if (sujet !== 'deleteMessage') {
          this.stats.ignores++;
          return;
        }
        const document = objetOuNull(evenement.args[0]);
        const id = typeof document?._id === 'string' ? document._id : null;
        if (id === null) {
          this.stats.ignores++;
          return;
        }
        await this.depot.supprimerMessage(id);
        this.stats.suppressions++;
        return;
      }

      default:
        this.stats.ignores++;
    }
  }

  private async appliquerMessage(brut: Record<string, unknown>): Promise<void> {
    const message = versMessage(brut);
    if (message === null) {
      this.stats.ignores++;
      return;
    }
    this.dechiffrer(message);
    await this.depot.upsertMessage(message);
    this.stats.messages++;
  }

  /**
   * `subscriptions-changed` et `rooms-changed` livrent `[action, document]` :
   * le premier argument est `'inserted' | 'updated' | 'removed'`. Notre routage
   * l'a déjà consommé comme charge — on relit donc `args` au complet.
   */
  private async appliquerAbonnement(evenement: Evenement): Promise<void> {
    const document = documentDeNotification(evenement);
    if (document === null) {
      this.stats.ignores++;
      return;
    }
    // 'removed' : le compte a quitté le salon, ou le salon a été supprimé. RC
    // n'envoie alors que le `_id` de l'ABONNEMENT — de quoi le retrouver, pas
    // de quoi le reconstruire. On supprime par subId (efface aussi le salon),
    // comme le rattrapage sur ses `remove[]`. SANS ce cas, un salon supprimé
    // resterait en FANTÔME : l'upsert plus bas le maintiendrait en vie.
    if (actionDeNotification(evenement) === 'removed') {
      const subId = typeof document._id === 'string' ? document._id : null;
      if (subId === null) {
        this.stats.ignores++;
        return;
      }
      await this.depot.supprimerParSubId(subId);
      this.stats.suppressions++;
      return;
    }
    const abonnement = versAbonnement(document);
    if (abonnement === null) {
      this.stats.ignores++;
      return;
    }
    this.dechiffreur?.enregistrerCleSalon(abonnement.rid, abonnement.e2eKey);
    await this.depot.upsertAbonnement(abonnement);
    this.stats.abonnements++;
  }

  private async appliquerSalon(evenement: Evenement): Promise<void> {
    const document = documentDeNotification(evenement);
    if (document === null) {
      this.stats.ignores++;
      return;
    }
    // 'removed' : le salon a disparu côté serveur. Le document ne porte que son
    // `_id` (= le rid). On supprime, sinon l'upsert le ressusciterait.
    if (actionDeNotification(evenement) === 'removed') {
      const rid = typeof document._id === 'string' ? document._id : null;
      if (rid === null) {
        this.stats.ignores++;
        return;
      }
      await this.depot.supprimerSalon(rid);
      this.stats.suppressions++;
      return;
    }
    const salon = versSalon(document, this.moi, this.moiUid);
    if (salon === null) {
      this.stats.ignores++;
      return;
    }
    await this.depot.upsertSalon(salon);
    this.stats.salons++;
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
        const message = versMessage(brut);
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
        const salon = versSalon(brut, this.moi, this.moiUid);
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
        const abonnement = versAbonnement(brut);
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

function objetOuNull(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** `<uid>/subscriptions-changed` -> `subscriptions-changed`. */
function sujetDe(cleEvenement: string): string {
  return cleEvenement.split('/').slice(1).join('/');
}

/**
 * `stream-notify-user` envoie `args: ['updated', {…}]` — vérifié contre un
 * serveur 8.5. Le document est donc le **second** argument quand le premier est
 * une action. Certaines versions envoient directement le document : on accepte
 * les deux formes plutôt que de parier.
 */
function documentDeNotification(evenement: Evenement): Record<string, unknown> | null {
  if (typeof evenement.args[0] === 'string') return objetOuNull(evenement.args[1]);
  return objetOuNull(evenement.args[0]);
}

/**
 * L'ACTION d'une notification `[action, document]` (`'inserted' | 'updated' |
 * 'removed'`), ou null quand le serveur envoie directement le document (forme
 * acceptée par `documentDeNotification`). Seul `'removed'` change le traitement.
 */
function actionDeNotification(evenement: Evenement): string | null {
  return typeof evenement.args[0] === 'string' ? evenement.args[0] : null;
}
