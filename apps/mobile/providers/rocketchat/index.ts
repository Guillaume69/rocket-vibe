/**
 * Assemble un `Fournisseur` Rocket.Chat pour une session : réunit derrière la
 * façade neutre le DDP (listener), le traducteur, les actions, et les fabriques
 * d'envoi/rattrapage liées au `ClientRest`. `ui/sync.tsx` l'orchestre sans
 * nommer Rocket.Chat. Le driver Mattermost fournira `creerFournisseurMattermost`
 * rendant le même objet.
 */

import type { Session } from '../../lib/auth.ts';
import { PRIVATE_MESSAGE_EVENT, privateMessage } from '../../lib/commands.ts';
import { ClientDdp } from '../../lib/ddp.ts';
import { OutboxEngine } from '../../lib/outbox.ts';
import { UploadEngine } from '../../lib/uploadQueue.ts';
import {
  ROCKETCHAT_CAPABILITIES,
  type Provider,
  type Ingest,
  type Outbox,
  type FileOutbox,
} from '../../lib/provider.ts';
import { PRESENCE_EVENT, STREAM_NOTIFY_LOGGED } from '../../lib/presence.ts';
import { catchUpGlobal, catchUpRoom, reconcileRooms } from '../../lib/catchUp.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { STREAM_MESSAGES, STREAM_NOTIFY_ROOM, STREAM_NOTIFY_USER } from '../../lib/sync.ts';
import type { OutboxEncryptor, OutboxStore } from '../../lib/outbox.ts';
import type { UploadEncryption, UploadStore } from '../../lib/uploadQueue.ts';
import type { TransportUpload } from '../../lib/upload.ts';
import { ActionsRC } from './actions.ts';
import { loadThread, loadHistory } from './history.ts';
import { AVATAR_EVENT, RcTranslator } from './translator.ts';

function urlWebSocket(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws')}/websocket`;
}

export function createRcProvider(
  session: Session,
  client: ClientRest,
  genererId: () => string,
): Provider {
  const listener = new ClientDdp(urlWebSocket(session.baseUrl));
  const traducteur = new RcTranslator(session.username, session.userId);
  const actions = new ActionsRC(client);

  return {
    capabilities: ROCKETCHAT_CAPABILITIES,
    listener,
    translator: traducteur,
    actions,
    initialSubscriptions(): readonly (readonly [string, string])[] {
      return [
        [STREAM_NOTIFY_USER, `${session.userId}/subscriptions-changed`],
        [STREAM_NOTIFY_USER, `${session.userId}/rooms-changed`],
        // La réponse d'une commande slash (`lib/commands.ts`).
        [STREAM_NOTIFY_USER, `${session.userId}/${PRIVATE_MESSAGE_EVENT}`],
        [STREAM_NOTIFY_LOGGED, PRESENCE_EVENT],
        // Photos de profil et de salon : le serveur diffuse la nouvelle version
        // (`etag`) à TOUS les connectés. Sans cet abonnement, un avatar changé
        // reste figé jusqu'au prochain `me`/`users.info` — voir `urlAvatar`.
        [STREAM_NOTIFY_LOGGED, AVATAR_EVENT],
      ];
    },
    privateNote(evenement) {
      const cle = `${session.userId}/${PRIVATE_MESSAGE_EVENT}`;
      if (evenement.collection !== STREAM_NOTIFY_USER || evenement.eventKey !== cle) return null;
      return privateMessage(evenement.args);
    },
    roomSubscriptions(rid: string): readonly (readonly [string, string])[] {
      // Le format « rid » / « rid/sujet » est CELUI de Rocket.Chat : fabriqué
      // ici, parsé par `sujetDe` dans le traducteur — nulle part ailleurs.
      return [
        [STREAM_MESSAGES, rid],
        [STREAM_NOTIFY_ROOM, `${rid}/deleteMessage`],
        [STREAM_NOTIFY_ROOM, `${rid}/user-activity`],
      ];
    },
    loadHistory: (moteur, rid, type, latest) =>
      loadHistory(client, moteur, rid, type, latest),
    loadThread: (moteur, filId, estAbandonne) => loadThread(client, moteur, filId, estAbandonne),
    createOutbox(depot: OutboxStore, ingerer: Ingest, chiffreur?: OutboxEncryptor): Outbox {
      return new OutboxEngine({
        store: depot,
        client,
        me: { id: session.userId, username: session.username },
        generateId: genererId,
        ingest: ingerer,
        encryptor: chiffreur,
      });
    },
    createUploadQueue(
      depot: UploadStore,
      transport: TransportUpload,
      ingerer: Ingest,
      crochets?: {
        deleteLocalFile?: (uri: string) => Promise<void>;
        refreshRoom?: (rid: string) => Promise<void>;
        encryption?: UploadEncryption;
      },
    ): FileOutbox {
      return new UploadEngine({
        store: depot,
        client,
        transport,
        generateId: genererId,
        ingest: ingerer,
        deleteLocalFile: crochets?.deleteLocalFile,
        refreshRoom: crochets?.refreshRoom,
        encryption: crochets?.encryption,
      });
    },
    catchUpGlobal: (moteur, estAbandonne) => catchUpGlobal(client, moteur, estAbandonne),
    catchUpRoom: (moteur, rid, estAbandonne) =>
      catchUpRoom(client, moteur, rid, estAbandonne),
    reconcile: (moteur, estAbandonne) => reconcileRooms(client, moteur, estAbandonne),
  };
}
