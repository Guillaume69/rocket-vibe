/**
 * Assembles a Rocket.Chat `Provider` for a session: gathers behind the
 * neutral facade the DDP (listener), the translator, the actions, and the
 * send/catch-up factories bound to the `RestClient`. `ui/sync.tsx`
 * orchestrates it without naming Rocket.Chat. The Mattermost driver will
 * provide a `createMattermostProvider` returning the same object.
 */

import type { Session } from '../../lib/auth.ts';
import { PRIVATE_MESSAGE_EVENT, privateMessage } from '../../lib/commands.ts';
import { describeProviderError } from '../../lib/providerError.ts';
import { ClientDdp } from '../../lib/ddp.ts';
import {toMessage,type LocalMessage} from '../../lib/normalize.ts';
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
import type { RestClient } from '../../lib/rest.ts';
import { STREAM_MESSAGES, STREAM_NOTIFY_ROOM, STREAM_NOTIFY_USER } from '../../lib/sync.ts';
import type { OutboxEncryptor, OutboxStore } from '../../lib/outbox.ts';
import type { UploadEncryption, UploadStore } from '../../lib/uploadQueue.ts';
import type { TransportUpload } from '../../lib/upload.ts';
import { ActionsRC } from './actions.ts';
import { fetchMessage, HISTORY_PAGE, historyRange, loadThread, loadHistory } from './history.ts';
import { AVATAR_EVENT, RcTranslator } from './translator.ts';

function urlWebSocket(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws')}/websocket`;
}

export function createRcProvider(
  session: Session,
  client: RestClient,
  generateId: () => string,
): Provider {
  const listener = new ClientDdp(urlWebSocket(session.baseUrl));
  const translator = new RcTranslator(session.username, session.userId);
  const actions = new ActionsRC(client);

  return {
    identity:{kind:'rocketchat',origin:session.baseUrl,accountId:session.userId,instanceId:null,generation:null},
    describeError:describeProviderError,
    capabilities: ROCKETCHAT_CAPABILITIES,
    readProfile:async target=>(await client.get<{user?:Record<string,unknown>}>('users.info',{params:target.uid?{userId:target.uid}:{username:target.username}})).user,
    searchMessages:async(rid,text)=>{
      const r=await client.get<{messages?:Record<string,unknown>[]}>('chat.search',{params:{roomId:rid,searchText:text,count:50}});
      return (r.messages??[]).map(toMessage).filter((m):m is LocalMessage=>m!==null);
    },
    listener,
    translator,
    actions,
    initialSubscriptions(): readonly (readonly [string, string])[] {
      return [
        [STREAM_NOTIFY_USER, `${session.userId}/subscriptions-changed`],
        [STREAM_NOTIFY_USER, `${session.userId}/rooms-changed`],
        // The response to a slash command (`lib/commands.ts`).
        [STREAM_NOTIFY_USER, `${session.userId}/${PRIVATE_MESSAGE_EVENT}`],
        [STREAM_NOTIFY_LOGGED, PRESENCE_EVENT],
        // Profile and room photos: the server broadcasts the new version (`etag`)
        // to EVERYONE connected. Without this subscription, a changed avatar stays
        // frozen until the next `me`/`users.info`; see `avatarUrl`.
        [STREAM_NOTIFY_LOGGED, AVATAR_EVENT],
      ];
    },
    privateNote(event) {
      const key = `${session.userId}/${PRIVATE_MESSAGE_EVENT}`;
      if (event.collection !== STREAM_NOTIFY_USER || event.eventKey !== key) return null;
      return privateMessage(event.args);
    },
    roomSubscriptions(rid: string): readonly (readonly [string, string])[] {
      // The "rid" / "rid/topic" format is Rocket.Chat's: built here, parsed by
      // `topicOf` in the translator, nowhere else.
      return [
        [STREAM_MESSAGES, rid],
        [STREAM_NOTIFY_ROOM, `${rid}/deleteMessage`],
        [STREAM_NOTIFY_ROOM, `${rid}/user-activity`],
      ];
    },
    loadHistory: (engine, rid, type, latest) =>
      loadHistory(client, engine, rid, type, latest),
    historyRange: (rid, type, latest, oldest) => historyRange(client, rid, type, latest, oldest),
    fetchMessage: (id) => fetchMessage(client, id),
    historyPage: HISTORY_PAGE,
    loadThread: (engine, threadId, isDiscarded) => loadThread(client, engine, threadId, isDiscarded),
    createOutbox(store: OutboxStore, ingest: Ingest, encryptor?: OutboxEncryptor): Outbox {
      return new OutboxEngine({
        store,
        client,
        me: { id: session.userId, username: session.username },
        generateId,
        ingest,
        encryptor,
      });
    },
    createUploadQueue(
      store: UploadStore,
      transport: TransportUpload,
      ingest: Ingest,
      hooks?: {
        deleteLocalFile?: (uri: string) => Promise<void>;
        refreshRoom?: (rid: string) => Promise<void>;
        encryption?: UploadEncryption;
      },
    ): FileOutbox {
      return new UploadEngine({
        store,
        client,
        transport,
        generateId,
        ingest,
        deleteLocalFile: hooks?.deleteLocalFile,
        refreshRoom: hooks?.refreshRoom,
        encryption: hooks?.encryption,
      });
    },
    catchUpGlobal: (engine, isDiscarded) => catchUpGlobal(client, engine, isDiscarded),
    catchUpRoom: (engine, rid, isDiscarded) =>
      catchUpRoom(client, engine, rid, isDiscarded),
    reconcile: (engine, isDiscarded) => reconcileRooms(client, engine, isDiscarded),
  };
}
