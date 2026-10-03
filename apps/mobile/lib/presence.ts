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

import type { Evenement } from './ddp.ts';
import type { ClientRest } from './rest.ts';

export type StatutPresence = 'online' | 'away' | 'busy' | 'offline';

export const STREAM_NOTIFY_LOGGED = 'stream-notify-logged';
export const EVENEMENT_PRESENCE = 'user-status';

/** `STATUS_MAP` du serveur (relevé dans le bundle 8.5). */
const DEPUIS_NUMERO = new Map<number, StatutPresence>([
  [0, 'offline'],
  [1, 'online'],
  [2, 'away'],
  [3, 'busy'],
]);

const DEPUIS_TEXTE = new Set<string>(['online', 'away', 'busy', 'offline']);

type ReponsePresence = {
  users?: { _id?: unknown; status?: unknown }[];
  full?: boolean;
};

export class MoteurPresence {
  private statuts = new Map<string, StatutPresence>();
  private ecouteurs = new Set<() => void>();
  /** N° du dernier événement STREAM par uid — départage REST/stream. */
  private sequences = new Map<string, number>();
  private compteur = 0;
  private enVol = false;
  private repasser = false;
  /**
   * Incrémentée à chaque `invalider()`. Une photo partie sous une époque
   * révolue décrit le monde d'avant la coupure : on la jette entière.
   */
  private epoque = 0;

  /** `null` = inconnu — l'UI ne doit alors RIEN afficher (dégradation). */
  statutDe(uid: string): StatutPresence | null {
    return this.statuts.get(uid) ?? null;
  }

  surChangement(ecouteur: () => void): () => void {
    this.ecouteurs.add(ecouteur);
    return () => {
      this.ecouteurs.delete(ecouteur);
    };
  }

  private notifier(): void {
    for (const ecouteur of this.ecouteurs) ecouteur();
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
  invalider(): void {
    this.epoque++;
    const avaitQuelqueChose = this.statuts.size > 0;
    this.statuts.clear();
    this.sequences.clear();
    if (avaitQuelqueChose) this.notifier();
  }
  /** Provider photo already authenticated and fenced, with a receiver-relative expiry. */
  remplacer(photo:ReadonlyArray<{user:{id:string};status:StatutPresence}>|null):void {
    if(photo===null){this.invalider();return;}
    this.epoque++;
    const previous=this.statuts;
    const next=new Map<string,StatutPresence>(photo.map(p=>[p.user.id,p.status]));
    for(const uid of previous.keys())if(!next.has(uid))next.set(uid,'offline');
    if(next.size===previous.size && [...next].every(([id,status])=>previous.get(id)===status))return;
    this.statuts=next;this.sequences.clear();this.notifier();
  }

  /** Route un événement DDP. Tout ce qui n'est pas de la présence est ignoré. */
  appliquer(evenement: Evenement): void {
    if (
      evenement.collection !== STREAM_NOTIFY_LOGGED ||
      evenement.cleEvenement !== EVENEMENT_PRESENCE
    ) {
      return;
    }
    // `args = [[uid, username, n° statut, texte de statut, …]]`
    const premier = evenement.args[0];
    if (!Array.isArray(premier)) return;
    const uid = premier[0];
    const numero = premier[2];
    if (typeof uid !== 'string' || uid === '') return;
    const statut = typeof numero === 'number' ? DEPUIS_NUMERO.get(numero) : undefined;
    if (statut === undefined) return;
    this.statuts.set(uid, statut);
    this.sequences.set(uid, ++this.compteur);
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
  async charger(client: ClientRest): Promise<void> {
    if (this.enVol) {
      this.repasser = true;
      return;
    }
    this.enVol = true;
    try {
      do {
        this.repasser = false;
        await this.unePhoto(client);
      } while (this.repasser);
    } finally {
      this.enVol = false;
    }
  }

  private async unePhoto(client: ClientRest): Promise<void> {
    const seuil = this.compteur;
    const epoque = this.epoque;
    try {
      const reponse = await client.get<ReponsePresence>('users.presence', { params: {} });
      // Une invalidation a eu lieu pendant la requête : cette photo décrit le
      // monde d'avant la coupure. L'appliquer rallumerait exactement les
      // pastilles qu'on vient d'éteindre.
      if (this.epoque !== epoque) return;
      const photo = new Map<string, StatutPresence>();
      for (const u of reponse.users ?? []) {
        if (typeof u._id !== 'string' || u._id === '') continue;
        if (typeof u.status !== 'string' || !DEPUIS_TEXTE.has(u.status)) continue;
        photo.set(u._id, u.status as StatutPresence);
      }
      const intact = (uid: string) => (this.sequences.get(uid) ?? 0) <= seuil;
      for (const [uid, statut] of photo) {
        if (intact(uid)) this.statuts.set(uid, statut);
      }
      for (const uid of this.statuts.keys()) {
        if (!photo.has(uid) && intact(uid)) this.statuts.set(uid, 'offline');
      }
      this.notifier();
    } catch {
      // Hors ligne, endpoint restreint, broadcast coupé : tant pis.
    }
  }
}
