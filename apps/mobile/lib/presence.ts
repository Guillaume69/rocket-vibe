/**
 * Présence (8.4) — état VOLATIL, en mémoire, jamais persisté : une présence
 * périmée affichée depuis un cache est pire que pas de présence du tout.
 *
 * Alimentation : `users.presence` (photo complète) à chaque raccordement,
 * puis le stream. **Écarts au plan consignés** : pas de curseur `?from=` —
 * il s'ancrerait sur l'horloge locale (voir `charger`) ; et le plan
 * nommait `stream-user-presence`, mais son abonnement 8.5 passe par un
 * protocole propriétaire (`{added: [uid]}` sur une publication « main » par
 * connexion, sondé dans le bundle serveur) — incompatible avec la mécanique
 * de souscription rejouable de notre client DDP minimal. Le serveur diffuse
 * la MÊME présence sur `stream-notify-logged` / `user-status` (vérifié par
 * sonde : `args = [[uid, username, n° statut, texte]]`), qui s'abonne comme
 * n'importe quel stream.
 *
 * Dégradation gracieuse (le critère 8.4 l'exige) : au-delà d'environ 200
 * connexions, `Presence_broadcast_disabled` s'active seul et le serveur se
 * TAIT. Rien ici n'en dépend : les statuts inconnus restent inconnus,
 * l'UI n'affiche alors simplement rien.
 */

import type { DdpEvent } from './ddp.ts';
import type { ClientRest } from './rest.ts';

export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

export const STREAM_NOTIFY_LOGGED = 'stream-notify-logged';
export const PRESENCE_EVENT = 'user-status';

/** `STATUS_MAP` du serveur (relevé dans le bundle 8.5). */
const SINCE_NUMBER = new Map<number, PresenceStatus>([
  [0, 'offline'],
  [1, 'online'],
  [2, 'away'],
  [3, 'busy'],
]);

const SINCE_TEXT = new Set<string>(['online', 'away', 'busy', 'offline']);

type PresenceResponse = {
  users?: { _id?: unknown; status?: unknown }[];
  full?: boolean;
};

export class PresenceEngine {
  private statuses = new Map<string, PresenceStatus>();
  private listeners = new Set<() => void>();
  /** N° du dernier événement STREAM par uid — départage REST/stream. */
  private sequences = new Map<string, number>();
  private counter = 0;
  private inFlight = false;
  private rerun = false;
  /**
   * Incrémentée à chaque `invalider()`. Une photo partie sous une époque
   * révolue décrit le monde d'avant la coupure : on la jette entière.
   */
  private epoch = 0;

  /** `null` = inconnu — l'UI ne doit alors RIEN afficher (dégradation). */
  statusOf(uid: string): PresenceStatus | null {
    return this.statuses.get(uid) ?? null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifier(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Le transport est mort (ou l'app part en arrière-plan) : tout ce qu'on
   * sait est daté et plus rien ne le corrigera. On oublie, et `statutDe`
   * rend de nouveau `null` — l'UI n'affiche alors RIEN, la dégradation que
   * l'en-tête de ce module spécifie. Sans cela, la liste des DM continue
   * d'afficher les pastilles vertes de l'entrée dans le tunnel.
   *
   * `compteur` n'est PAS remis à zéro : il départage les événements du stream
   * et les photos REST, et le rembobiner ferait passer un événement frais
   * pour antérieur au seuil d'une photo en vol, qui l'écraserait.
   */
  invalidate(): void {
    this.epoch++;
    const hadSomething = this.statuses.size > 0;
    this.statuses.clear();
    this.sequences.clear();
    if (hadSomething) this.notifier();
  }

  /** Route un événement DDP. Tout ce qui n'est pas de la présence est ignoré. */
  apply(event: DdpEvent): void {
    if (
      event.collection !== STREAM_NOTIFY_LOGGED ||
      event.eventKey !== PRESENCE_EVENT
    ) {
      return;
    }
    // `args = [[uid, username, n° statut, texte de statut, …]]`
    const first = event.args[0];
    if (!Array.isArray(first)) return;
    const uid = first[0];
    const numero = first[2];
    if (typeof uid !== 'string' || uid === '') return;
    const status = typeof numero === 'number' ? SINCE_NUMBER.get(numero) : undefined;
    if (status === undefined) return;
    this.statuses.set(uid, status);
    this.sequences.set(uid, ++this.counter);
    this.notifier();
  }

  /**
   * Photo complète à chaque raccordement — PAS de curseur `from` : il
   * s'ancrerait sur l'horloge locale (interdit par la règle des curseurs du
   * projet — une horloge en avance rend les deltas silencieusement vides, et
   * la réponse ne porte aucun `_updatedAt` pour l'ancrer côté serveur). Le
   * coût est borné : la photo n'inclut que les non-offline, et au-delà
   * d'~200 connexions le serveur coupe de toute façon la diffusion.
   *
   * Deux gardes :
   * - un uid touché par le STREAM pendant la requête garde la version du
   *   stream (la photo date d'avant — elle régresserait un statut frais) ;
   * - un uid CONNU absent de la photo passe `offline` (la photo n'inclut que
   *   les non-offline ; le laisser en l'état figerait un « en ligne » périmé,
   *   l'oublier ferait disparaître la pastille d'un `offline` déjà su).
   *
   * Un échec est silencieux : la présence est un ornement, jamais une
   * dépendance. Sérialisé : un appel pendant un appel est rejoué à la fin.
   */
  async load(client: ClientRest): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.rerun = false;
        await this.snapshot(client);
      } while (this.rerun);
    } finally {
      this.inFlight = false;
    }
  }

  private async snapshot(client: ClientRest): Promise<void> {
    const threshold = this.counter;
    const epoch = this.epoch;
    try {
      const response = await client.get<PresenceResponse>('users.presence', { params: {} });
      // Une invalidation a eu lieu pendant la requête : cette photo décrit le
      // monde d'avant la coupure. L'appliquer rallumerait exactement les
      // pastilles qu'on vient d'éteindre.
      if (this.epoch !== epoch) return;
      const photo = new Map<string, PresenceStatus>();
      for (const u of response.users ?? []) {
        if (typeof u._id !== 'string' || u._id === '') continue;
        if (typeof u.status !== 'string' || !SINCE_TEXT.has(u.status)) continue;
        photo.set(u._id, u.status as PresenceStatus);
      }
      const intact = (uid: string) => (this.sequences.get(uid) ?? 0) <= threshold;
      for (const [uid, status] of photo) {
        if (intact(uid)) this.statuses.set(uid, status);
      }
      for (const uid of this.statuses.keys()) {
        if (!photo.has(uid) && intact(uid)) this.statuses.set(uid, 'offline');
      }
      this.notifier();
    } catch {
      // Hors ligne, endpoint restreint, broadcast coupé : tant pis.
    }
  }
}
