/**
 * Contrat d'un fournisseur de chat. Rocket.Chat en est la seule
 * implémentation ; kChat (Mattermost) est la seconde visée. Tout ce qui, dans
 * l'app, nomme un endpoint `/api/v1/*` ou un stream `stream-*` doit à terme
 * passer par ici — le reste (`db/`, `Depot`, rendu, `Reconnecteur`) est déjà neutre.
 *
 * Choix porteur : le cœur de synchro ne parle pas le format wire d'un serveur.
 * Chaque fournisseur TRADUIT son flux temps réel brut en `ChangementSync`
 * neutre ; `MoteurSynchro` applique bêtement. Ainsi les données Mattermost ne
 * sont jamais coulées dans la forme Rocket.Chat.
 */

import type { DdpEvent, DdpState } from './ddp.ts';
import type { OutboxEncryptor, OutboxStore } from './outbox.ts';
import type { UploadEncryption, UploadStore } from './uploadQueue.ts';
import type { LocalSubscription, MessageLocal, LocalRoom } from './normalize.ts';
import type { SyncEngine } from './sync.ts';
import type { FileToSend, TransportUpload } from './upload.ts';

/**
 * Un changement de synchro déjà normalisé, prêt à écrire dans le `Depot`. Le
 * traducteur d'un fournisseur en émet ; `MoteurSynchro.appliquer` les route
 * vers les upserts/suppressions. Les cas de suppression reprennent les trois
 * formes que le serveur RC distingue (message, salon, ou juste un `subId`).
 */
export type SyncChange =
  | { type: 'message'; doc: MessageLocal }
  | { type: 'room'; doc: LocalRoom }
  | { type: 'subscription'; doc: LocalSubscription }
  | { type: 'message-deleted'; id: string }
  | { type: 'room-deleted'; rid: string }
  | { type: 'subscription-deleted-by-sub'; subId: string }
  /**
   * Nouvelle version de la photo d'un utilisateur (par pseudo) OU d'un salon
   * (par rid) — l'une des deux clés, jamais les deux. `etag` est le
   * cache-buster de l'URL d'avatar ; il vaut `AVATAR_SANS_PHOTO` quand la
   * photo a été RETIRÉE, ce qui doit changer l'URI tout autant qu'un ajout.
   */
  | { type: 'avatar'; username: string | null; rid: string | null; etag: string };

/**
 * Le type de serveur d'une session. Persisté avec elle : il décide quel driver
 * instancier au démarrage. Un seul membre aujourd'hui ; `mattermost` s'ajoute
 * avec son driver (kChat).
 */
export type ProviderKind = 'rocketchat';

const GENRES: readonly ProviderKind[] = ['rocketchat'];

/**
 * Ramène une valeur stockée à un `Genre` connu. Les sessions d'avant l'ajout du
 * champ n'en ont pas : elles retombent sur `rocketchat` (le seul serveur
 * possible à l'époque). Migration sans écriture — la valeur se corrige à la
 * lecture. Défaut `rocketchat` pour toute valeur inconnue.
 */
export function normalizeProviderKind(valeur: unknown): ProviderKind {
  return typeof valeur === 'string' && (GENRES as readonly string[]).includes(valeur)
    ? (valeur as ProviderKind)
    : 'rocketchat';
}

/**
 * Ce que chaque fournisseur sait faire. Les écrans lisent ces drapeaux pour
 * masquer ce qui n'existe pas plutôt que de raboter au plus petit dénominateur ;
 * une action non supportée jette. `modeleFil` : Rocket.Chat imbrique par `tmid`,
 * Mattermost aplatit par `root_id` — les deux se ramènent à « id du post parent ».
 */
export type Capabilities = {
  typing: boolean;
  presence: boolean;
  push: boolean;
  e2ee: boolean;
  emojisCustom: boolean;
  videoCall: boolean;
  search: boolean;
  threadTemplate: 'tmid' | 'root_id';
};

/**
 * L'écoute temps réel. Exactement la surface publique de `ClientDdp` (le pilote
 * `Reconnecteur` et `ui/sync.tsx` en dépendent) : `ClientDdp` s'y conforme
 * sans emballage. Un driver Mattermost implémenterait la même interface au-dessus
 * d'un WebSocket JSON, en émettant des `Evenement` (enveloppe neutre
 * `{collection, cleEvenement, args}`) que son `Traducteur` sait décoder.
 */
export interface Listener {
  /** Champ public, pas un getter — comme `ClientDdp.etat`. */
  readonly state: DdpState;
  connect(authToken: string): Promise<void>;
  /** Enregistre une souscription désirée ; rend la fonction de relâche. Rejouée à chaque (re)connexion. */
  subscribe(nom: string, cleEvenement: string): () => void;
  /** Rend la fonction de désabonnement. */
  onEvent(ecouteur: (evenement: DdpEvent) => void): () => void;
  onLoss(ecouteur: () => void): () => void;
  close(): void;
  checkAlive(): Promise<boolean>;
  /**
   * Résolue quand le serveur a armé les souscriptions désirées — le signal
   * exact du moment où le stream commence à couvrir. Le raccordement s'en sert
   * pour ordonner sa lecture REST sans jamais parier sur un délai.
   */
  armedSubscriptions(): Promise<void>;
  reset(): void;
}

/**
 * Résultat de la traduction d'un `Evenement` brut. Reproduit exactement les
 * trois issues du switch RC historique : un changement à écrire, une anomalie
 * (stream inattendu — à COMPTER pour le débogage), ou un silence attendu
 * (`user-activity` de saisie, traité ailleurs — à NE PAS compter, sinon les
 * battements de frappe noient le compteur d'anomalies).
 */
export type Translation =
  | { kind: 'change'; change: SyncChange }
  | { kind: 'ignore' }
  | { kind: 'silence' };

/**
 * La part spécifique au serveur de la synchro : décoder ses `Evenement` bruts et
 * ses documents REST en formes neutres. `MoteurSynchro` ne dépend que de cette
 * interface — il ne connaît plus aucun nom de stream ni aucune quirk de wire.
 * Un fournisseur en fournit une (RC : `TraducteurRC` ; Mattermost : la sienne).
 */
export interface Translator {
  /** Flux temps réel : un `Evenement` du `Listener` → un changement, une anomalie, ou un silence. */
  translateEvent(evenement: DdpEvent): Translation;
  /** Lots REST (rattrapage, historique) : document brut → ligne locale, ou null si irrécupérable. */
  toMessage(brut: Record<string, unknown>): MessageLocal | null;
  toRoom(brut: Record<string, unknown>): LocalRoom | null;
  toSubscription(brut: Record<string, unknown>): LocalSubscription | null;
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
export interface ProviderActions {
  react(rid: string, mid: string, emoji: string, mettre: boolean): Promise<void>;
  /** `chiffreur` : le message est chiffré, sa nouvelle version aussi. */
  edit(rid: string, mid: string, texte: string, chiffreur?: OutboxEncryptor): Promise<void>;
  delete(rid: string, mid: string): Promise<void>;
  pin(rid: string, mid: string): Promise<void>;
  unpin(rid: string, mid: string): Promise<void>;
  star(rid: string, mid: string, mettre: boolean): Promise<void>;
  /** Les messages épinglés d'un salon, les plus récents d'abord. Une requête par appel. */
  listPinned(rid: string): Promise<MessageLocal[]>;
  /** Mes messages favoris dans un salon, les plus récents d'abord. */
  listStarred(rid: string): Promise<MessageLocal[]>;
  markRead(rid: string): Promise<void>;
  /**
   * Ouvre (ou crée — idempotent côté serveur) le DM avec `username`. Rend le
   * `rid` et le document salon brut, à ingérer pour naviguer sans attendre le
   * stream. Était écrit deux fois (fiche profil, recherche), avec deux
   * validations différentes de la réponse.
   */
  openOrCreateDm(username: string): Promise<{ rid: string; rawRoom: Record<string, unknown> }>;
}

/** Capacités de Rocket.Chat. E2EE dégradé (lecture seule), push par gateway hors périmètre. */
export const ROCKETCHAT_CAPABILITIES: Capabilities = {
  typing: true,
  presence: true,
  push: true,
  e2ee: true,
  emojisCustom: true,
  videoCall: true,
  search: true,
  threadTemplate: 'tmid',
};

/** Réinjecte dans la synchro un document renvoyé par un envoi (écho optimiste). */
export type Ingest = (doc: Record<string, unknown>) => Promise<void>;

/** File d'envoi de texte persistée (outbox), rejouée à la reconnexion. */
export interface Outbox {
  /** Rend l'`_id` client du message posé. `filId` = post parent (fil), ou null.
   *  `jointesLocales` : pièces jointes (JSON) pour le seul affichage optimiste
   *  (aperçu d'une citation) — jamais envoyées, écrasées par l'écho serveur. */
  send(
    rid: string,
    texte: string,
    filId?: string | null,
    jointesLocales?: string | null,
  ): Promise<string>;
  process(): Promise<void>;
  discard(id: string): Promise<void>;
}

/** File d'envoi de fichiers persistée. `progression` : 0..1 par id, pour l'UI. */
export interface FileOutbox {
  readonly progress: Map<string, number>;
  /** S'abonner aux changements de `progression` — rend le désabonnement. */
  subscribe(auditeur: () => void): () => void;
  /** Rejette (`ErreurValidation`) une pièce que le serveur refuserait — sans rien envoyer. */
  validate(fichier: { type: string; size: number | null }, rid?: string): Promise<void>;
  send(
    rid: string,
    fichier: FileToSend & { size: number | null },
    legende?: string,
  ): Promise<void>;
  process(): Promise<void>;
  /**
   * Le geste explicite « Réessayer ». Indispensable depuis que le rejeu
   * automatique ignore les lignes en échec : un simple `traiter()` ne les
   * verrait plus.
   */
  retry(id: string): Promise<void>;
  /** `uri` permet d'effacer aussi le fichier temporaire. */
  discard(id: string, uri?: string): Promise<void>;
}

/**
 * Un fournisseur de chat assemblé pour une session : tout le spécifique-serveur
 * du chemin de synchro et d'action, derrière une seule façade. `ui/sync.tsx`
 * l'orchestre sans nommer Rocket.Chat ; le driver Mattermost fournira le même
 * objet. Les ornements encore RC-only (présence, emojis custom, push, E2EE)
 * restent hors de cette façade en 4a, gardés par `capacites`, à absorber ensuite.
 */
export interface Provider {
  readonly capabilities: Capabilities;
  /** Transport temps réel (RC : DDP ; MM : WebSocket JSON). */
  readonly listener: Listener;
  /** Décodeur d'`Evenement`/documents bruts vers formes neutres. */
  readonly translator: Translator;
  /** Actions unitaires sur les messages. */
  readonly actions: ProviderActions;
  /** Souscriptions désirées `[nom, cle]`, déclarées avant la 1re connexion (rejouées à chaque reconnexion). */
  initialSubscriptions(): readonly (readonly [nom: string, cle: string])[];
  /**
   * Souscriptions PAR SALON — celles que l'écran salon (et un fil) arme à
   * l'ouverture, symétriques de `souscriptionsInitiales`. Le format des clés
   * (`rid`, `rid/sujet`…) appartient au fournisseur : les écrans bouclent sur
   * le résultat sans le connaître. Refcountées par le `Listener` : plusieurs
   * écrans sur le même salon ne coûtent qu'un `sub`.
   */
  roomSubscriptions(rid: string): readonly (readonly [nom: string, cle: string])[];
  /**
   * Ce qu'un événement du transport me dit à moi seul dans un salon (la
   * réponse d'une commande slash), ou `null` s'il ne s'agit pas de cela.
   */
  privateNote(evenement: DdpEvent): { rid: string; text: string } | null;
  /**
   * Une page d'historique du salon (les plus récents d'abord), ingérée dans le
   * moteur. `type` : le type du salon tel que stocké (`salons.type`) ; `latest` :
   * borne keyset ISO — absente, la page part du présent. Rend le plus ancien
   * horodatage de la page : le critère de recul de la pagination de l'écran.
   */
  loadHistory(
    moteur: SyncEngine,
    rid: string,
    type: string,
    latest?: string,
  ): Promise<{ oldest: number | null }>;
  /**
   * Le fil `filId` en entier (racine comprise), ingéré dans le moteur.
   * Rejouable — mêmes upserts idempotents que le reste de la synchro.
   */
  loadThread(moteur: SyncEngine, filId: string, estAbandonne: () => boolean): Promise<void>;
  createOutbox(depot: OutboxStore, ingerer: Ingest, chiffreur?: OutboxEncryptor): Outbox;
  createUploadQueue(
    depot: UploadStore,
    transport: TransportUpload,
    ingerer: Ingest,
    /**
     * Deux crochets qui ne peuvent pas vivre dans `lib/` : le premier touche
     * `expo-file-system`, le second le rattrapage REST. Optionnels — sans eux
     * le moteur reste correct, seulement moins bon (cache qui enfle, doublon
     * possible sur un `mediaConfirm` perdu).
     */
    crochets?: {
      deleteLocalFile?: (uri: string) => Promise<void>;
      refreshRoom?: (rid: string) => Promise<void>;
      /** Envoi dans un salon chiffré : sans lui, un fichier y attend indéfiniment. */
      encryption?: UploadEncryption;
    },
  ): FileOutbox;
  /** Rattrapage REST global (salons + abonnements delta). */
  catchUpGlobal(moteur: SyncEngine, estAbandonne: () => boolean): Promise<void>;
  /** Rattrapage d'UN salon (l'ouvert). Rate-limité, non borné côté RC : voir `ui/sync.tsx`. */
  catchUpRoom(moteur: SyncEngine, rid: string, estAbandonne: () => boolean): Promise<void>;
  /** Réconciliation anti-fantômes (une fois par session). */
  reconcile(moteur: SyncEngine, estAbandonne: () => boolean): Promise<void>;
}
