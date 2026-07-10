/**
 * File d'envoi (outbox) et UI optimiste.
 *
 * Le `_id` du message est généré CÔTÉ CLIENT, 24 hexadécimaux, AVANT tout
 * affichage : c'est la clé de tout. Le message apparaît immédiatement (ligne
 * `messages` avec `misAJourLe = 0`, que n'importe quelle version serveur
 * écrase), la file `sortie` persiste l'intention, et le serveur DÉDUPLIQUE
 * sur `_id` — un rejeu après crash ne crée jamais de doublon.
 *
 * Réseau injoignable (statut 0) : le message RESTE `en-attente`, le rejeu du
 * prochain démarrage ou retour de réseau l'emportera. Refus du serveur
 * (4xx/5xx) : `echec`, actionnable depuis l'UI.
 *
 * Pur : la base est derrière `DepotEnvoi`, le REST derrière `ClientRest` —
 * tout se teste sous Node.
 */

import type { MessageLocal } from './normaliser.ts';
import { ErreurRest, type ClientRest } from './rest.ts';

export type LigneSortie = {
  id: string;
  rid: string;
  texte: string;
  filId: string | null;
  statut: 'en-attente' | 'echec';
  tentatives: number;
};

export interface DepotEnvoi {
  insererSortie(id: string, rid: string, texte: string, filId: string | null): Promise<void>;
  listerAEnvoyer(): Promise<LigneSortie[]>;
  marquerEchec(id: string, erreur: string): Promise<void>;
  supprimerSortie(id: string): Promise<void>;
  upsertMessage(m: MessageLocal): Promise<void>;
  /** N'efface le message que s'il est encore optimiste (jamais livré). */
  supprimerMessageOptimiste(id: string): Promise<void>;
}

/** 24 hexadécimaux depuis 12 octets — le format des `_id` Rocket.Chat. */
export function idDepuisOctets(octets: Uint8Array): string {
  return Array.from(octets.slice(0, 12), (o) => o.toString(16).padStart(2, '0')).join('');
}

type ReponseEnvoi = { message?: Record<string, unknown> };

export class MoteurEnvoi {
  private readonly depot: DepotEnvoi;
  private readonly client: ClientRest;
  private readonly moi: { id: string; username: string };
  private readonly genererId: () => string;
  private readonly maintenant: () => number;
  /** Réconciliation : le document renvoyé par le serveur repasse par la synchro. */
  private readonly ingerer: (doc: Record<string, unknown>) => Promise<void>;
  private enVol = false;

  constructor(options: {
    depot: DepotEnvoi;
    client: ClientRest;
    moi: { id: string; username: string };
    genererId: () => string;
    ingerer: (doc: Record<string, unknown>) => Promise<void>;
    maintenant?: () => number;
  }) {
    this.depot = options.depot;
    this.client = options.client;
    this.moi = options.moi;
    this.genererId = options.genererId;
    this.ingerer = options.ingerer;
    this.maintenant = options.maintenant ?? (() => Date.now());
  }

  /**
   * Affichage immédiat + persistance de l'intention, PUIS tentative d'envoi.
   * Rend l'`_id` généré.
   */
  async envoyer(rid: string, texte: string): Promise<string> {
    const id = this.genererId();
    const quand = this.maintenant();
    await this.depot.upsertMessage({
      id,
      rid,
      texte,
      horodatage: quand,
      auteurId: this.moi.id,
      auteurNom: this.moi.username,
      typeSysteme: null,
      filId: null,
      filReponses: 0,
      modifieLe: null,
      md: null,
      piecesJointes: null,
      reactions: null,
      // 0 : la version du serveur, quelle qu'elle soit, écrase l'optimiste —
      // et l'optimiste n'écrase jamais un état réel.
      misAJourLe: 0,
    });
    await this.depot.insererSortie(id, rid, texte, null);
    await this.traiter();
    return id;
  }

  private repasser = false;

  /**
   * Rejoue tout ce qui attend, dans l'ordre. Ré-entrant sans dégât : une
   * seule passe à la fois — et une passe demandée PENDANT qu'une autre court
   * est notée puis exécutée à la fin, sinon un message envoyé pendant le
   * flush resterait « ⏳ » jusqu'au prochain déclencheur.
   */
  async traiter(): Promise<void> {
    if (this.enVol) {
      this.repasser = true;
      return;
    }
    this.enVol = true;
    try {
      do {
        this.repasser = false;
        if (!(await this.unePasse())) return;
      } while (this.repasser);
    } finally {
      this.enVol = false;
    }
  }

  /** Rend `false` si le réseau est injoignable — inutile d'insister. */
  private async unePasse(): Promise<boolean> {
    for (const ligne of await this.depot.listerAEnvoyer()) {
      try {
        const reponse = await this.client.post<ReponseEnvoi>('chat.sendMessage', {
          corps: { message: { _id: ligne.id, rid: ligne.rid, msg: ligne.texte } },
        });
        await this.depot.supprimerSortie(ligne.id);
        if (reponse.message !== undefined) await this.ingerer(reponse.message);
      } catch (e) {
        if (e instanceof ErreurRest && e.statut === 0) {
          // Injoignable : on n'y peut rien d'ici. La ligne reste telle
          // quelle, le prochain `traiter()` retentera.
          return false;
        }
        // Le rejeu d'un `_id` déjà accepté n'est PAS idempotent côté
        // serveur : Rocket.Chat 8.5 répond 400 (« Cannot read properties of
        // undefined (reading 'starred') », vérifié). Aucun doublon n'est
        // créé, mais la réponse ne distingue pas « déjà livré » de
        // « refusé » : on demande au serveur.
        const livre = await this.messageLivre(ligne.id);
        if (livre !== null) {
          // Ingérer le document récupéré : c'est la vraie version (ts du
          // serveur), et son passage par le dépôt réconcilie la sortie.
          await this.ingerer(livre);
          await this.depot.supprimerSortie(ligne.id);
          continue;
        }
        const message = e instanceof Error ? e.message : 'Envoi refusé.';
        await this.depot.marquerEchec(ligne.id, message);
      }
    }
    return true;
  }

  /** Abandon d'un échec définitif : la ligne de sortie ET l'optimiste s'en vont. */
  async abandonner(id: string): Promise<void> {
    await this.depot.supprimerSortie(id);
    await this.depot.supprimerMessageOptimiste(id);
  }

  private async messageLivre(id: string): Promise<Record<string, unknown> | null> {
    try {
      const reponse = await this.client.get<{ message?: Record<string, unknown> }>(
        'chat.getMessage',
        { params: { msgId: id } },
      );
      const doc = reponse.message;
      return doc !== undefined && doc._id === id ? doc : null;
    } catch {
      // Dans le doute (réseau, droit), on ne conclut pas « livré ».
      return null;
    }
  }
}
