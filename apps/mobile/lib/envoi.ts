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
 * Salon chiffré : le texte est chiffré au moment de partir, jamais avant — la
 * file garde le clair, comme la base garde les messages déchiffrés. Sans clé
 * (verrouillé), la ligne attend le déverrouillage au lieu d'échouer.
 *
 * Pur : la base est derrière `DepotEnvoi`, le REST derrière `ClientRest` —
 * tout se teste sous Node.
 */

import type { ContenuChiffre } from './e2e/crypto.ts';
import { mentionsE2E } from './e2e/mentions.ts';
import { TYPE_CHIFFRE, type MessageLocal } from './normaliser.ts';
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
  salonChiffre(rid: string): Promise<boolean>;
}

/** Le chiffrement E2EE d'une charge, ou `null` tant qu'il est impossible (verrouillé, clé absente). */
export interface ChiffreurEnvoi {
  chiffrer(rid: string, charge: object): ContenuChiffre | null;
}

/** 24 hexadécimaux depuis 12 octets — le format des `_id` Rocket.Chat. */
export function idDepuisOctets(octets: Uint8Array): string {
  return Array.from(octets.slice(0, 12), (o) => o.toString(16).padStart(2, '0')).join('');
}

type ReponseEnvoi = { message?: Record<string, unknown> };

/** Verdict de `messageLivre` quand la question n'a pas pu être posée. */
const INCONNU = Symbol('livraison indéterminée');

export class MoteurEnvoi {
  private readonly depot: DepotEnvoi;
  private readonly client: ClientRest;
  private readonly moi: { id: string; username: string };
  private readonly genererId: () => string;
  private readonly maintenant: () => number;
  /** Réconciliation : le document renvoyé par le serveur repasse par la synchro. */
  private readonly ingerer: (doc: Record<string, unknown>) => Promise<void>;
  private readonly chiffreur: ChiffreurEnvoi | null;
  private enVol = false;

  constructor(options: {
    depot: DepotEnvoi;
    client: ClientRest;
    moi: { id: string; username: string };
    genererId: () => string;
    ingerer: (doc: Record<string, unknown>) => Promise<void>;
    chiffreur?: ChiffreurEnvoi | null;
    maintenant?: () => number;
  }) {
    this.depot = options.depot;
    this.client = options.client;
    this.moi = options.moi;
    this.genererId = options.genererId;
    this.ingerer = options.ingerer;
    this.chiffreur = options.chiffreur ?? null;
    this.maintenant = options.maintenant ?? (() => Date.now());
  }

  /**
   * Affichage immédiat + persistance de l'intention, PUIS tentative d'envoi.
   * Rend l'`_id` généré. `filId` (le `tmid` Rocket.Chat) fait de ce message
   * une réponse de fil. `jointesLocales` (JSON `attachments`) n'existe que
   * pour l'AFFICHAGE optimiste — une citation, typiquement : le serveur
   * reconstruira les vraies pièces jointes depuis le texte, et sa version
   * (misAJourLe réel) écrase celle-ci. RIEN n'en part sur le réseau.
   */
  async envoyer(
    rid: string,
    texte: string,
    filId: string | null = null,
    jointesLocales: string | null = null,
  ): Promise<string> {
    const id = this.genererId();
    const quand = this.maintenant();
    await this.depot.upsertMessage({
      id,
      rid,
      texte,
      horodatage: quand,
      auteurId: this.moi.id,
      auteurNom: this.moi.username,
      typeSysteme: (await this.depot.salonChiffre(rid)) ? TYPE_CHIFFRE : null,
      filId,
      filReponses: 0,
      filDernier: null,
      filAffiche: false,
      modifieLe: null,
      md: null,
      piecesJointes: jointesLocales,
      reactions: null,
      urls: null,
      appelId: null,
      chiffreBrut: null,
      epingle: false,
      etoiles: null,
      // 0 : la version du serveur, quelle qu'elle soit, écrase l'optimiste —
      // et l'optimiste n'écrase jamais un état réel.
      misAJourLe: 0,
    });
    await this.depot.insererSortie(id, rid, texte, filId);
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
      const message = await this.corpsDuMessage(ligne);
      if (message === null) continue;
      try {
        const reponse = await this.client.post<ReponseEnvoi>('chat.sendMessage', {
          corps: { message },
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
        if (livre === INCONNU) {
          // On n'a pas pu trancher. La ligne reste `en-attente` — donc
          // rejouable — et la passe s'arrête : les lignes suivantes
          // brûleraient le même quota pour le même verdict.
          return false;
        }
        if (livre !== null) {
          // Ingérer le document récupéré : c'est la vraie version (ts du
          // serveur), et son passage par le dépôt réconcilie la sortie.
          await this.ingerer(livre);
          await this.depot.supprimerSortie(ligne.id);
          continue;
        }
        // `derniere_erreur` est un DIAGNOSTIC (jamais affiché — l'UI montre
        // `ligneMessage.echecReessayer`) : pas une chaîne à traduire.
        const message = e instanceof Error ? e.message : 'Envoi refusé.';
        await this.depot.marquerEchec(ligne.id, message);
      }
    }
    return true;
  }

  /** Le message tel qu'il part, ou `null` s'il doit attendre une clé de salon. */
  private async corpsDuMessage(ligne: LigneSortie): Promise<Record<string, unknown> | null> {
    const base = {
      _id: ligne.id,
      rid: ligne.rid,
      ...(ligne.filId === null ? {} : { tmid: ligne.filId }),
    };
    if (!(await this.depot.salonChiffre(ligne.rid))) return { ...base, msg: ligne.texte };
    const content = this.chiffreur?.chiffrer(ligne.rid, { msg: ligne.texte }) ?? null;
    if (content === null) return null;
    return { ...base, t: TYPE_CHIFFRE, e2e: 'pending', content, e2eMentions: mentionsE2E(ligne.texte) };
  }

  /** Abandon d'un échec définitif : la ligne de sortie ET l'optimiste s'en vont. */
  async abandonner(id: string): Promise<void> {
    await this.depot.supprimerSortie(id);
    await this.depot.supprimerMessageOptimiste(id);
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
  private async messageLivre(
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
      if (e instanceof ErreurRest && (e.statut === 0 || e.statut === 429)) return INCONNU;
      // Le serveur a parlé (404, droit refusé, message absent) : on tranche.
      return null;
    }
  }
}
