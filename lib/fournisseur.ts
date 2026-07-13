/**
 * Contrat d'un fournisseur de chat. Rocket.Chat en est la première
 * implémentation ; kChat (Mattermost) la seconde. Tout ce qui, dans l'app,
 * nomme un endpoint `/api/v1/*` ou un stream `stream-*` doit à terme passer par
 * ici — le reste (`db/`, `Depot`, rendu, `Reconnecteur`) est déjà neutre.
 *
 * Choix porteur : le cœur de synchro ne parle pas le format wire d'un serveur.
 * Chaque fournisseur TRADUIT son flux temps réel brut en `ChangementSync`
 * neutre ; `MoteurSynchro` applique bêtement. Ainsi les données Mattermost ne
 * sont jamais coulées dans la forme Rocket.Chat.
 */

import type { EtatDdp } from './ddp.ts';
import type { AbonnementLocal, MessageLocal, SalonLocal } from './normaliser.ts';

/**
 * Un changement de synchro déjà normalisé, prêt à écrire dans le `Depot`. Le
 * traducteur d'un fournisseur en émet ; `MoteurSynchro.appliquer` les route
 * vers les upserts/suppressions. Les cas de suppression reprennent les trois
 * formes que le serveur RC distingue (message, salon, ou juste un `subId`).
 */
export type ChangementSync =
  | { type: 'message'; doc: MessageLocal }
  | { type: 'salon'; doc: SalonLocal }
  | { type: 'abonnement'; doc: AbonnementLocal }
  | { type: 'suppr-message'; id: string }
  | { type: 'suppr-salon'; rid: string }
  | { type: 'suppr-abonnement-par-sub'; subId: string };

/**
 * Ce que chaque fournisseur sait faire. Les écrans lisent ces drapeaux pour
 * masquer ce qui n'existe pas plutôt que de raboter au plus petit dénominateur ;
 * une action non supportée jette. `modeleFil` : Rocket.Chat imbrique par `tmid`,
 * Mattermost aplatit par `root_id` — les deux se ramènent à « id du post parent ».
 */
export type Capacites = {
  typing: boolean;
  presence: boolean;
  push: boolean;
  e2ee: boolean;
  emojisCustom: boolean;
  appelVideo: boolean;
  recherche: boolean;
  modeleFil: 'tmid' | 'root_id';
};

/**
 * L'écoute temps réel. Même surface que `ClientDdp` (le pilote `Reconnecteur` et
 * `ui/synchro.tsx` dépendent de cette forme), à une différence près : `surChangement`
 * émet du `ChangementSync` neutre, pas l'`Evenement` brut du transport. Un driver
 * Mattermost implémente la même interface au-dessus d'un WebSocket JSON.
 */
export interface Listener {
  /** Champ public, pas un getter — comme `ClientDdp.etat`. */
  readonly etat: EtatDdp;
  connecter(authToken: string): Promise<void>;
  /** Enregistre une souscription désirée ; rend la fonction de relâche. Rejouée à chaque (re)connexion. */
  souscrire(nom: string, cleEvenement: string): () => void;
  /** Rend la fonction de désabonnement. */
  surChangement(ecouteur: (changement: ChangementSync) => void): () => void;
  surPerte(ecouteur: () => void): () => void;
  fermer(): void;
  verifierVie(): Promise<boolean>;
  reinitialiser(): void;
}

/**
 * Actions unitaires sur les messages (chemin d'écriture central). L'envoi de
 * texte et de fichiers passe par les moteurs à outbox (`MoteurEnvoi`,
 * `MoteurTeleversement`), fabriqués par le fournisseur, pas par ces méthodes.
 *
 * Les lectures secondaires (profil, recherche, info salon, spotlight) seront
 * ajoutées ici quand leurs écrans seront routés — elles portent des DTO qu'on
 * ne définit pas à l'avance.
 */
export interface ActionsFournisseur {
  reagir(rid: string, mid: string, emoji: string, mettre: boolean): Promise<void>;
  modifier(rid: string, mid: string, texte: string): Promise<void>;
  supprimer(rid: string, mid: string): Promise<void>;
  epingler(rid: string, mid: string): Promise<void>;
  marquerLu(rid: string): Promise<void>;
}

/** Capacités de Rocket.Chat. E2EE dégradé (lecture seule), push par gateway hors périmètre. */
export const CAPACITES_ROCKETCHAT: Capacites = {
  typing: true,
  presence: true,
  push: true,
  e2ee: true,
  emojisCustom: true,
  appelVideo: true,
  recherche: true,
  modeleFil: 'tmid',
};
