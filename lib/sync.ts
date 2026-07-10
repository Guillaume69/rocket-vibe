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

export interface Depot {
  upsertMessage(m: MessageLocal): Promise<void>;
  upsertSalon(s: SalonLocal): Promise<void>;
  upsertAbonnement(a: AbonnementLocal): Promise<void>;
  supprimerMessage(id: string): Promise<void>;
  /**
   * Regroupe des écritures en une transaction. Une page d'historique de 50
   * messages doit produire UN commit et UN événement de changement — pas 50
   * ré-exécutions de chaque requête vive de l'UI.
   */
  transaction(fn: () => Promise<void>): Promise<void>;
}

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

  constructor(depot: Depot, moi: string | null = null) {
    this.depot = depot;
    this.moi = moi;
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
    const abonnement = document === null ? null : versAbonnement(document);
    if (abonnement === null) {
      this.stats.ignores++;
      return;
    }
    await this.depot.upsertAbonnement(abonnement);
    this.stats.abonnements++;
  }

  private async appliquerSalon(evenement: Evenement): Promise<void> {
    const document = documentDeNotification(evenement);
    const salon = document === null ? null : versSalon(document, this.moi);
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
   */
  async ingererMessages(bruts: Record<string, unknown>[]): Promise<void> {
    await this.depot.transaction(async () => {
      for (const brut of bruts) await this.appliquerMessage(brut);
    });
  }

  async ingererSalons(bruts: Record<string, unknown>[]): Promise<void> {
    await this.depot.transaction(async () => {
      for (const brut of bruts) {
        const salon = versSalon(brut, this.moi);
        if (salon === null) {
          this.stats.ignores++;
          continue;
        }
        await this.depot.upsertSalon(salon);
        this.stats.salons++;
      }
    });
  }

  async ingererAbonnements(bruts: Record<string, unknown>[]): Promise<void> {
    await this.depot.transaction(async () => {
      for (const brut of bruts) {
        const abonnement = versAbonnement(brut);
        if (abonnement === null) {
          this.stats.ignores++;
          continue;
        }
        await this.depot.upsertAbonnement(abonnement);
        this.stats.abonnements++;
      }
    });
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
