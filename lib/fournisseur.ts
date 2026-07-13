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

import type { Evenement, EtatDdp } from './ddp.ts';
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
 * L'écoute temps réel. Exactement la surface publique de `ClientDdp` (le pilote
 * `Reconnecteur` et `ui/synchro.tsx` en dépendent) : `ClientDdp` s'y conforme
 * sans emballage. Un driver Mattermost implémente la même interface au-dessus
 * d'un WebSocket JSON, en émettant des `Evenement` (enveloppe neutre
 * `{collection, cleEvenement, args}`) que son `Traducteur` sait décoder.
 */
export interface Listener {
  /** Champ public, pas un getter — comme `ClientDdp.etat`. */
  readonly etat: EtatDdp;
  connecter(authToken: string): Promise<void>;
  /** Enregistre une souscription désirée ; rend la fonction de relâche. Rejouée à chaque (re)connexion. */
  souscrire(nom: string, cleEvenement: string): () => void;
  /** Rend la fonction de désabonnement. */
  surEvenement(ecouteur: (evenement: Evenement) => void): () => void;
  surPerte(ecouteur: () => void): () => void;
  fermer(): void;
  verifierVie(): Promise<boolean>;
  reinitialiser(): void;
}

/**
 * Résultat de la traduction d'un `Evenement` brut. Reproduit exactement les
 * trois issues du switch RC historique : un changement à écrire, une anomalie
 * (stream inattendu — à COMPTER pour le débogage), ou un silence attendu
 * (`user-activity` de saisie, traité ailleurs — à NE PAS compter, sinon les
 * battements de frappe noient le compteur d'anomalies).
 */
export type Traduction =
  | { sorte: 'changement'; changement: ChangementSync }
  | { sorte: 'ignore' }
  | { sorte: 'silence' };

/**
 * La part spécifique au serveur de la synchro : décoder ses `Evenement` bruts et
 * ses documents REST en formes neutres. `MoteurSynchro` ne dépend que de cette
 * interface — il ne connaît plus aucun nom de stream ni aucune quirk de wire.
 * Un fournisseur en fournit une (RC : `TraducteurRC` ; Mattermost : la sienne).
 */
export interface Traducteur {
  /** Flux temps réel : un `Evenement` du `Listener` → un changement, une anomalie, ou un silence. */
  traduireEvenement(evenement: Evenement): Traduction;
  /** Lots REST (rattrapage, historique) : document brut → ligne locale, ou null si irrécupérable. */
  versMessage(brut: Record<string, unknown>): MessageLocal | null;
  versSalon(brut: Record<string, unknown>): SalonLocal | null;
  versAbonnement(brut: Record<string, unknown>): AbonnementLocal | null;
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
