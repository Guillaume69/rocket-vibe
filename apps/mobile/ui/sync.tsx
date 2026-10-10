/**
 * Plugs the sync engine into the current session.
 *
 * As soon as the account's database is migrated, the state becomes "ready":
 * the UI projects SQLite immediately, even offline. The network setup (DDP
 * then the initial REST load) then runs fire-and-forget: if it fails, the
 * list shows the cache, and step 5.1 will bring reconnection. The final
 * `.catch` therefore covers ONLY the database setup: only an unusable local
 * database justifies an error screen.
 *
 * The database belongs to the (server, account) pair: rooms, previews and
 * unread counts are account data, not server data.
 *
 * Setup order: the REST read that GUARANTEES is the one that follows arming
 * the subscriptions, so nothing can be lost between the two transports, and
 * if both overlap, the upserts are idempotent and arbitrated by `_updatedAt`.
 * A read still goes out BEFORE, without waiting for the socket: otherwise the
 * user would pay the DDP negotiation timeout on every return from the
 * background. See `lib/connectionSetup.ts`.
 */

import * as Crypto from 'expo-crypto';
import {NativeError} from '../providers/rocketvibe/transport.ts';
import {mountProviderProfiles} from '../lib/providerProfiles.ts';
import {VoiceNative} from '../modules/voice/index.ts';
import {mountProviderCalls} from '../lib/providerCalls.ts';
import {mountProviderEmojis} from '../lib/providerEmojis.ts';
import { clearRealNames, refreshRealNames, restoreRealNames } from './realNames.ts';
import {mountDisplayNames,setDisplayNames} from '../lib/displayNames.ts';
import {mountNativePreviews} from '../lib/nativePreviews.ts';
import { createContext, useContext, useEffect, useState } from 'react';
import { afterSystemPicker } from './roomCover.ts';
import { AppState, Platform } from 'react-native';
import {registerNativePush} from '../providers/rocketvibe/push.ts';

import type { LocalDatabase } from '../db/client.ts';
import { openDatabase } from '../db/client.ts';
import { ActivityEngine } from '../lib/activity.ts';
import {
  MESSAGES_KEPT_PER_ROOM,
  createStore,
  createDraftStore,
  createEmojiStore,
  createEmojiUsageStore,
  createLocalSearch,
  createOutboxStore,
  createUploadStore,
  type DraftStore,
} from '../db/store.ts';
import { migrateDatabase } from '../db/migrate.ts';
import { E2EEngine } from '../lib/e2e/engine.ts';
import {
  restoreCustomEmojis,
  syncCustomEmojis,
  clearCustomEmojis,
} from '../lib/customEmojis.ts';
import { idFromBytes } from '../lib/outbox.ts';
import type {
  ProviderActions,
  Capabilities,
  Provider,
  Listener,
  Outbox,
  FileOutbox,
} from '../lib/provider.ts';
import { PresenceEngine } from '../lib/presence.ts';
import { getFcmToken, onTokenRotation } from '../lib/push.ts';
import { setUpConnection } from '../lib/connectionSetup.ts';
import { registerToken } from '../lib/pushToken.ts';
import { Reconnector } from '../lib/reconnect.ts';
import { SyncEngine } from '../lib/sync.ts';
import { createProvider } from '../providers/index.ts';
import {
  clearE2EPrivateKey,
  saveE2EPrivateKey,
  readE2EPrivateKey,
  purgeLegacyE2EKey,
  rememberPushToken,
  prepareNativeSession,
  rememberNativePushDevice,
} from '../lib/sessionStore.ts';
import { forgetCallAvailability } from '../lib/call.ts';
import { forgetProfileCards } from '../lib/profilePreload.ts';
import { forgetNotificationState } from './notificationState.ts';
import { translateCurrent } from './i18n.ts';
import { forgetReplies } from './reply.ts';
import { forgetIdentities } from './identityStore.ts';
import { setPrivateNote } from './privateNotes.tsx';
import { useSession } from './session.tsx';
import { armUploadProbe } from './uploadProbe.ts';
import { forgetLoadedThreads } from './loadedThreads.ts';
import { releaseHotRooms } from './hotRooms.ts';
import { forgetLoadedRooms } from './loadedRooms.ts';
import { createOpenRoomsStack } from './openRooms.ts';
import { encryptLocalFile, hashedName } from './fileEncryption.ts';
import { deleteIfTemporary } from './temporaryFiles.ts';
import { transportExpo } from './transportUpload.ts';
import { NativeStore } from '../providers/rocketvibe/store.ts';
import {createNativeFilesIO,mountNativeFiles} from './nativeFiles.ts';
import { notify } from './toast.tsx';
import { mountEmojiUsage } from './emojiUsage.ts';
import { mountLocalSearch } from './localSearch.ts';

export type SyncState =
  | { phase: 'idle' }
  | { phase: 'preparing' }
  | {
      phase: 'ready';
      base: LocalDatabase;
      /** Composer drafts, in the write queue like everything else. */
      drafts: DraftStore;
      engine: SyncEngine;
      outbox: Outbox;
      files: FileOutbox;
      ddp: Listener;
      /**
       * The full facade of the current server. Screens load history, a thread,
       * and arm a room's subscriptions through it, never by naming a Rocket.Chat
       * endpoint or stream directly. `actions`/`capabilities`/`ddp` alongside are
       * just shortcuts into it.
       */
      provider: Provider;
      /** Single-message actions, routed to the right server. */
      actions: ProviderActions;
      /** What the current server can do: screens hide the rest. */
      capabilities: Capabilities;
      /**
       * The room screen registers itself on open and gives the registration back
       * on close: the `chat.syncMessages` catch-up (one room at a time,
       * rate-limited) targets ONLY the topmost room.
       *
       * A STACK, not a variable: navigation can stack two room screens
       * (`ui/notifications.tsx` does a `push` from anywhere, `app/profile.tsx` a
       * `replace`). With a single variable, going back set `null` while a room was
       * still shown, and no connection setup caught anything up anymore.
       */
      declareOpenRoom: (rid: string) => () => void;
      /** Volatile presence (8.4), read through the `usePresence` hook. */
      presence: PresenceEngine;
      /**
       * Background network activity, read through `useActivity`. Counts in-flight
       * fetches per scope (`'global'`, a `rid`) for the header indicator.
       */
      activity: ActivityEngine;
      /** E2EE engine, observed through `subscribe`/`isUnlocked` (read side). */
      e2e: E2EEngine;
      /**
       * Unlocks encrypted rooms (E2E password), then decrypts the messages
       * already stored. Throws `E2EError` if the password is wrong.
       */
      unlockE2E: (password: string) => Promise<void>;
      /** Relocks: forgets the key and re-masks the local plaintext. */
      lockE2E: () => Promise<void>;
      /** Reads the server's custom emoji again now (after the administration changed them). */
      refreshCustomEmojis: () => Promise<void>;
      /**
       * Incremented on each successful connection setup. A screen whose initial
       * load failed (opened offline) puts it in its effect's deps: the network
       * coming back restarts it.
       */
      generation: number;
    }
  | { phase: 'error'; message: string };

const Context = createContext<SyncState | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { state,adoptRenewedSession } = useSession();
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' });

  useEffect(() => {
    if (state.phase !== 'connected') {
      // The emoji index of the server left behind must not serve the next one.
      clearCustomEmojis();
      clearRealNames();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The external account closed: clear its projection before another account can render it.
      setSync({ phase: 'idle' });
      return;
    }
    const { session, client } = state;
    if (session.kind === 'rocketvibe') {
      clearCustomEmojis();
      clearRealNames();
      forgetIdentities();
      forgetLoadedThreads();
      releaseHotRooms();
      forgetLoadedRooms();
      forgetReplies();
      setSync({phase:'preparing'});
      let alive = true;
      let stop: (() => void) | undefined;
      let runner: import('../providers/rocketvibe/chat.ts').NativeChat | undefined;
      let unmountUsage = (): void => {};
      const appState = AppState.addEventListener('change',state => {
        if (state === 'active') {runner?.resume();return;}
        // The composer's system picker is an activity of its own: suspending
        // then closed the room's private view and lost the pick. Suspend only
        // if the app is still away once the picker has returned (its result
        // can arrive just before the app is active again).
        afterSystemPicker(() => setTimeout(() => { if (AppState.currentState !== 'active') runner?.suspend(); }, 1000));
      });
      void (async () => {
        const {base,raw,writeQueue} = openDatabase(session.baseUrl,session.userId);
        await migrateDatabase(session.baseUrl,session.userId);
        if (!alive) return;
        const store = new NativeStore(raw,writeQueue,session);
        await store.prepare();
        if (!alive) return;
        unmountUsage = mountEmojiUsage(createEmojiUsageStore(raw,writeQueue));
        const unmountEmoji = unmountUsage, unmountSearch = mountLocalSearch(createLocalSearch(raw));
        unmountUsage = () => { unmountEmoji(); unmountSearch(); };
        const provider = createProvider(session,client,() => idFromBytes(Crypto.getRandomBytes(12)),store,{
          pushAndroid:Platform.OS==='android',
          voice:VoiceNative!==null,
          credentials:async(previous)=>{
            const fresh=await prepareNativeSession(previous);
            if(!alive)throw new NativeError(0,'session_closed');
            if(fresh.authToken!==previous.authToken && !adoptRenewedSession(previous,fresh))throw new NativeError(0,'session_closed');
            return fresh;
          },
        });
        const chat = provider.native!.chat;
        const nativeFiles=await createNativeFilesIO(provider);
        if(!alive){chat.stop();return;}
        const unprofile=mountProviderProfiles(client,provider);
        const uncalls=mountProviderCalls(client,provider);
        const unemojis=mountProviderEmojis(client,provider);
        const unpreviews=mountNativePreviews(client,provider);
        const unfiles=mountNativeFiles(client,provider);
        const files=provider.createUploadQueue(createUploadStore(raw,writeQueue),transportExpo,async()=>{},{nativeFiles});
        runner = chat;
        const engine = new SyncEngine(createStore(raw,writeQueue),provider.translator);
        const outbox = provider.createOutbox(createOutboxStore(raw,writeQueue),async () => {});
        // Passive legacy read models; native networking stays in the provider.
        const e2e = new E2EEngine({client,uid:session.userId,storage:{read:async () => null,save:async () => {},clear:async () => {}}});
        const activity = new ActivityEngine();
        const presence = new PresenceEngine();
        const unlive=chat.live.subscribe(()=>presence.replace(chat.live.state?.presence??null));
        const openRooms = createOpenRoomsStack();
        let online = false;
        let pushCommands:Promise<void>=Promise.resolve();
        const registerPush=(token:string)=>{
          pushCommands=pushCommands.catch(()=>{}).then(async()=>{
            if(!alive || !chat.status.online || !provider.capabilities.push)return;
            const fresh=await prepareNativeSession(session);
            if(!alive)return;
            await registerNativePush(fresh,token,rememberNativePushDevice);
            await rememberPushToken(token);
          }).catch(()=>{});
        };
        const unpush=Platform.OS==='android'?onTokenRotation(registerPush):()=>{};
        let lastError: string | null = null;
        const unlisten = chat.subscribe(() => {
          if (!alive) return;
          if (chat.status.online && !online){
            setSync(s => s.phase === 'ready' ? {...s,capabilities:provider.capabilities,generation:s.generation+1} : s);
            if(provider.capabilities.push)void getFcmToken().then(result=>{if(alive && result.ok)registerPush(result.token);}).catch(()=>{});
          }
          online = chat.status.online;
          if (chat.status.error && chat.status.error !== lastError) {
            notify(translateCurrent(chat.status.error === 'server_identity_changed' ? 'native.identityChanged' : 'native.error'));
          }
          lastError = chat.status.error;
        });
        stop = () => { unlisten();unpush();unlive();unprofile();uncalls();unemojis();unpreviews();unfiles();files.close?.();presence.invalidate();chat.stop(); };
        setSync({
          phase:'ready',base,drafts:store.drafts(),engine,outbox,
          files,
          ddp:provider.listener,provider,actions:provider.actions,capabilities:provider.capabilities,
          declareOpenRoom:openRooms.declare,presence,activity,e2e,
          unlockE2E:async () => { throw new Error('Unsupported native feature'); },lockE2E:async () => {},generation:0,
          refreshCustomEmojis:()=>chat.refreshEmojis(),
        });
        if (AppState.currentState === 'active') chat.start(); else chat.suspend();
      })().catch(() => { if (alive) setSync({phase:'error',message:translateCurrent('native.error')}); });
      // The same purge as a Rocket.Chat session's end: without it, the next
      // account inherited this one's identities, profile cards, call verdicts,
      // badge and loaded-room marks.
      return () => { alive = false; appState.remove(); stop?.(); unmountUsage(); forgetSessionStores(); };
    }
    let discarded = false;
    const isDiscarded = () => discarded;
    const provider = createProvider(session, client, () =>
      idFromBytes(Crypto.getRandomBytes(12)),
    );
    const unprofile=mountProviderProfiles(client,provider);
    const uncalls=mountProviderCalls(client,provider);
    const unnames=mountDisplayNames(provider.displayNames);
    const ddp = provider.listener;
    let reconnector: Reconnector | null = null;
    let onAbort: (() => void) | null = null;
    let unmountUsage = (): void => {};

    // Any upload (attachment AND profile photo, same transport) can drop the
    // DDP socket without the WebSocket ever calling its `onclose`: sockets in
    // CLOSE-WAIT on the OS side, client still "authenticated", not a single
    // message received afterwards. The `lib/ddp.ts` watchdog ends up seeing it,
    // but it needs a missed server ping (45 s). The end of an upload is an EXACT
    // signal: probe right away. Healthy socket, it costs a ping/pong; dead
    // socket, the probe cleans up, `onLoss` fires and the reconnector reconnects.
    armUploadProbe(() => {
      void ddp.checkAlive().catch(() => {});
    });

    // FCM token rotation. The registration below happens only ONCE per session;
    // if FCM rotates the token while we run, the server keeps pushing to the old
    // one, so into the void, with no error anywhere, until the next cold start.
    // `push.token` is idempotent, and the new token is kept in the Keystore like
    // the registered one: it is the one logout will have to unregister.
    const stopTokenListener = onTokenRotation((token) => {
      if (discarded || !provider.capabilities.push) return;
      void rememberPushToken(token).catch(() => {});
      void registerToken(client, token, 'gcm').catch(() => {});
    });

    (async () => {
      setSync({ phase: 'preparing' });
      // The write queue comes WITH the connection: it serializes the
      // transactions of one SQLite, so it must be unique per SQLite. This
      // effect replays on a mere rename (new `session` object for the same
      // account); creating it here made a second one, and the two engines
      // interleaved (see db/writeQueue.ts).
      const { base, raw, writeQueue } = openDatabase(session.baseUrl, session.userId);
      await migrateDatabase(session.baseUrl, session.userId);
      if (discarded) return;
      // Device data of this account (quick reactions), taken back at session end.
      unmountUsage = mountEmojiUsage(createEmojiUsageStore(raw, writeQueue));
      const unmountEmoji = unmountUsage, unmountSearch = mountLocalSearch(createLocalSearch(raw));
      unmountUsage = () => { unmountEmoji(); unmountSearch(); };
      // E2EE engine (read side): decrypts during ingestion as soon as a room key
      // is available. The private key is stored in the Keystore per
      // (SERVER, ACCOUNT), like the SQLite database just above, and for the same
      // reason: it is account data. Keyed by server alone, it was reimported for
      // the NEXT account, which then believed itself unlocked without being able
      // to read anything.
      const e2e = new E2EEngine({
        client,
        uid: session.userId, // PBKDF2 salt of legacy (v1) private keys
        storage: {
          read: () => readE2EPrivateKey(session.baseUrl, session.userId),
          save: (jwk) => saveE2EPrivateKey(session.baseUrl, session.userId, jwk),
          clear: () => clearE2EPrivateKey(session.baseUrl, session.userId),
        },
      });
      // The old-format entry will never be read again, but it holds a DECRYPTED
      // RSA JWK, and the Keystore does not enumerate its keys: if we do not erase
      // it here, nothing will ever find it again. Fire-and-forget: a Keystore that
      // refuses a deletion must not hold up startup.
      void purgeLegacyE2EKey(session.baseUrl).catch(() => {});
      const engine = new SyncEngine(
        createStore(raw, writeQueue),
        provider.translator,
        e2e,
      );
      const outboxStore = createOutboxStore(raw, writeQueue);
      const files = provider.createUploadQueue(
        createUploadStore(raw, writeQueue),
        transportExpo,
        async (doc) => {
          await engine.ingestMessages([doc]);
        },
        {
          // A settled row takes its cache file with it; the "is it really ours?"
          // guard lives in `ui/temporaryFiles.ts`.
          deleteLocalFile: deleteIfTemporary,
          // Paid ONLY when an already persisted `file_id` requires knowing
          // whether the message exists and the local database does not know:
          // the restart after a kill, with no room screen mounted, so no
          // `stream-room-messages` to have delivered it. Without this targeted
          // catch-up, we would re-confirm, and the server then posts a DUPLICATE
          // (probed on 8.5: it answers 200 returning the first message).
          // `isDiscarded`, not `() => false`: a catch-up pass gives up only if
          // ALL its requesters have let go (`lib/catchUp.ts`). With an
          // always-false predicate, this one could NEVER stop: it kept paginating
          // `chat.syncMessages` with a dead token after logout, on a route capped
          // at 10 calls/min, and wrote into the database of the account left
          // behind. It also contaminated every request merged into it.
          refreshRoom: (rid) => provider.catchUpRoom(engine, rid, isDiscarded),
          encryption: {
            roomEncrypted: (rid) => outboxStore.roomEncrypted(rid),
            encrypt: (rid, payload) => e2e.encrypt(rid, payload),
            encryptFile: encryptLocalFile,
            hashedName,
          },
        },
      );
      const outbox = provider.createOutbox(
        outboxStore,
        async (doc) => {
          await engine.ingestMessages([doc]);
        },
        e2e,
      );
      const emojiStore = createEmojiStore(raw, writeQueue);
      // The mounted room screens: the top is the one the user is looking at,
      // the only one the catch-up targets. See `ui/openRooms.ts`.
      const openRooms = createOpenRoomsStack();
      let registeredPushToken = false;
      let syncedEmojis = false;
      let syncedRealNames = false;
      let reconciledRooms = false;
      let retentionApplied = false;
      const presence = new PresenceEngine();
      const activity = new ActivityEngine();
      // Custom emojis: the in-memory index from SQLite BEFORE "ready", so the
      // first render already resolves `:party_parrot:` (offline included). The
      // network refresh comes with the connection setup. A read failure must not
      // hold up the screen: customs would degrade to `:name:`.
      await restoreCustomEmojis(session.baseUrl, emojiStore, isDiscarded).catch(() => {});
      if (discarded) return;
      // Real names or usernames: the server's last answer, before the first render.
      if (client.kind === 'rocketchat') restoreRealNames(session.baseUrl);
      else clearRealNames();

      // Silent E2EE resume: if the private key is already in the Keystore
      // (unlocked in a past session), reimport without a password. A failure
      // (missing/damaged key) simply leaves it locked.
      // Forces a re-render of the tree after an E2EE transition: `E2EEngine`
      // already notifies its subscribers (`useE2EUnlocked`), but refreshing the
      // context value guarantees the list (padlock, preview) reflects the state,
      // without depending on the timing of an external subscription.
      //
      // A new object IDENTITY is enough: `useContext` compares with `Object.is`.
      // Above all, do NOT bump `generation`: that counter answers "did the
      // connection hold?" and serves as the validity criterion for the room
      // caches (`ui/loadedRooms.ts`, `ui/hotRooms.ts`) and as a dependency of the
      // opening effects. Bumping it here threw those caches away with no
      // connection lost: at startup on an account whose key is in the Keystore,
      // `e2e.resume()` alone relaunched a full `channels.history` PLUS a
      // `chat.syncMessages`, 3 to 4 s on a big room to report zero documents.
      const refreshE2E = (): void =>
        setSync((s) => (s.phase === 'ready' ? { ...s } : s));
      const unlockE2E = async (password: string): Promise<void> => {
        await e2e.unlock(password); // throws E2EError if wrong
        await engine.e2eUnlocked(); // reveals the messages already stored
        refreshE2E();
        outbox.process().catch(() => {}); // what was waiting for a room key
        files.process().catch(() => {});
      };
      const lockE2E = async (): Promise<void> => {
        await e2e.lock();
        await engine.e2eRelocked(); // re-masks the local plaintext
        refreshE2E();
      };

      // "ready" as soon as the database is available: the UI shows the local
      // cache without waiting for the network.
      setSync({
        phase: 'ready',
        base,
        drafts: createDraftStore(raw, writeQueue),
        engine,
        outbox,
        files,
        ddp,
        provider,
        actions: provider.actions,
        capabilities: provider.capabilities,
        declareOpenRoom: openRooms.declare,
        presence,
        activity,
        e2e,
        unlockE2E,
        lockE2E,
        refreshCustomEmojis: () => syncCustomEmojis(client, emojiStore, isDiscarded, provider.listCustomEmojis),
        generation: 0,
      });

      // After "ready": E2EE resume off the critical path. If a key was in the
      // Keystore, decrypt the messages already loaded; the UI (live query)
      // refreshes by itself.
      (provider.capabilities.e2ee ? e2e.resume() : Promise.resolve(false))
        .then(async (ok) => {
          if (!ok) {
            // Locked, and yet the database may hold E2E plaintext: what an
            // unlocked session wrote there. It really happens since the private
            // key is keyed by ACCOUNT: the old-format entry is no longer read, so
            // the resume fails once, and the app then showed plaintext while
            // claiming to be locked. `encryptedRaw` is kept: masking is exactly
            // what the "Lock" button does, so it is reversible.
            await engine.e2eRelocked();
            if (!discarded) refreshE2E();
            return;
          }
          await engine.e2eUnlocked();
          if (!discarded) refreshE2E();
          outbox.process().catch(() => {});
          files.process().catch(() => {});
        })
        .catch(() => {});

      ddp.onEvent((event) => {
        if (discarded) return;
        presence.apply(event);
        const note = provider.privateNote(event);
        if (note !== null) setPrivateNote(note.rid, note.text);
        engine.apply(event).catch(() => {
          // A failing write must not kill the listener; the step 5.2 REST
          // catch-up will bring the document through again.
        });
      });
      // Declared BEFORE any connection: `subscribe` records the intent,
      // and each `connect` (first time as well as reconnection) replays it all.
      // The provider knows which streams it cares about.
      for (const [name, key] of provider.initialSubscriptions()) ddp.subscribe(name, key);

      // The FIRST connection setup goes through the same reconnector as
      // reconnections (backoff 1 s → 30 s with jitter): offline at launch, it
      // retries on its own. On each new socket: login, resubscription of all
      // streams, reload, and flush of the send queue.
      // The bulk in two delta requests (`updatedSince`), then the room the
      // user is looking at, a single `chat.syncMessages`. Wrapped in
      // `activity`: the header (list / room) lights its sync bar for the
      // duration of the fetch (`track` rejects like the original, the
      // reconnector's backoff keeps control).
      const catchUpAll = async (): Promise<void> => {
        await activity.track('global', provider.catchUpGlobal(engine, isDiscarded));
        const activeRoom = openRooms.top();
        if (activeRoom === undefined) return;
        // Catching up ONE room is FIRE-AND-FORGET: neither awaited nor fatal.
        // Each page is capped at 50 documents (`lib/catchUp.ts`), so nothing can
        // time out there on a big backlog anymore; but awaiting it would still
        // block `connect` for work the DDP stream and the opening history already
        // cover.
        //
        // NO stacking guard HERE, and that is deliberate: it lived here and
        // SWALLOWED the second read of the connection setup, precisely the one
        // that, going out once the subscriptions are armed, guarantees nothing
        // fell between the two transports (lib/connectionSetup.ts). Since the
        // nominal case is the first read still running, the guarantee was never
        // delivered. Serialization moved down into `lib/catchUp.ts`, the only
        // point where ALL paths meet (this one and the screen's opening effect):
        // one pagination at a time per room, and no request lost.
        void activity
          .track(activeRoom, provider.catchUpRoom(engine, activeRoom, isDiscarded))
          .catch((e: unknown) => console.warn('catchUpRoom: failure ignored', e));
      };

      // What follows the catch-up without depending on the stream. Run once per
      // connection setup, even if the socket failed: this work is REST.
      const afterCatchUp = (): void => {
        // What was waiting for the network goes now. No await: a send
        // failure must not count as a connection failure.
        outbox.process().catch(() => {});
        files.process().catch(() => {});
        // Presence: full snapshot on each connection setup, then the stream.
        // Decoration: a failure never counts as a setup failure.
        if (provider.loadPresence) void provider.loadPresence().then((photo) => presence.replace(photo)).catch(() => {});
        else if (provider.capabilities.presence) void presence.load(client);
        // Custom emoji list: refreshed ONCE per session (like the push
        // token), not on every network flap: it is a full download and a
        // rewrite of the whole table. The SQLite version already served the
        // first render; new emojis appear on the next render.
        // `isDiscarded` keeps a late fetch from re-arming the index of a
        // server we left. Failure → not armed, retried on the next flap.
        // `UI_Use_Real_Name`, once per session like the emoji list.
        if (!syncedRealNames && client.kind === 'rocketchat') {
          syncedRealNames = true;
          refreshRealNames(client, isDiscarded).catch(() => {
            syncedRealNames = false;
          });
        }
        if (!syncedEmojis && provider.capabilities.customEmojis) {
          syncedEmojis = true;
          syncCustomEmojis(client, emojiStore, isDiscarded, provider.listCustomEmojis).catch(() => {
            syncedEmojis = false;
          });
        }
        // Push token lifecycle (6.1): registered on the session's first
        // connection setup. Idempotent on the server; a failure is retried
        // on the next setup.
        if (!registeredPushToken && provider.capabilities.push) {
          registeredPushToken = true;
          getFcmToken()
            .then((r) => {
              // `getFcmToken` NEVER rejects: its failure is a RESULT
              // (`ok:false`, lib/push.ts). Listening only for rejection thus left
              // the flag armed after a Play Services failure: no notification for
              // the WHOLE session, while the comment above promises a retry on
              // the next connection setup.
              // A permission refusal, however, does not re-arm: that would replay
              // the system prompt on every network flap.
              if (!r.ok) {
                if (r.reason === 'failed') registeredPushToken = false;
                return undefined;
              }
              // Kept in the Keystore AT REGISTRATION: logout is what will need
              // it, and it must not ask FCM again: `getFcmToken` requests the
              // system permission along the way, and returns nothing on a device
              // without Play Services.
              void rememberPushToken(r.token).catch(() => {});
              return registerToken(client, r.token, 'gcm');
            })
            .catch(() => {
              registeredPushToken = false;
            });
        }
        // Ghost reconciliation (once per session, like emojis): purges
        // rooms deleted server-side whose 'removed' event was missed. Full
        // `subscriptions.get`, so not redone on every network flap.
        // Failure → not armed, retried next time.
        if (!reconciledRooms) {
          reconciledRooms = true;
          provider.reconcile(engine, isDiscarded).catch(() => {
            reconciledRooms = false;
          });
        }
        // Retention (once per session, as above): beyond 500 messages per
        // room, trim from the bottom. Without it `messages` never stops
        // growing for a live room, and the JSON blobs (`md`,
        // `attachments`, `reactions`, `urls`) weigh the most. Nothing is
        // lost: the app never reads beyond its pagination and can download
        // again. Purely local, hence AFTER the catch-up: trimming before
        // would have re-downloaded right away. A failure need not re-arm
        // anything: the space will be reclaimed at the next launch.
        if (!retentionApplied) {
          retentionApplied = true;
          engine.syncStore.applyRetention(MESSAGES_KEPT_PER_ROOM).catch(() => {});
        }
        // Wakes the screens whose initial load failed offline.
        setSync((s) => (s.phase === 'ready' ? { ...s, generation: s.generation + 1 } : s));
      };

      reconnector = new Reconnector({
        connect: async () => {
          if (discarded) return;
          await setUpConnection({
            // "Authenticated" means the desired subscriptions were replayed:
            // the stream already covers, the read that follows will guarantee
            // on its own.
            streamAlreadyActive: () => ddp.state === 'authenticated',
            // Reconnect ONLY if the socket dropped: after a failure of the
            // REST catch-up alone, DDP is still authenticated and `connect`
            // would throw "already connected"; the retry would then never
            // replay the catch-up.
            openStream: () =>
              ddp.state === 'closed' ? ddp.connect(session.authToken) : Promise.resolve(),
            streamArmed: () => ddp.armedSubscriptions(),
            catchUp: catchUpAll,
            then: afterCatchUp,
            isDiscarded,
          });
        },
      });
      ddp.onLoss(() => {
        // Presence only lives through the stream: without a socket, what we
        // know freezes at the moment of the drop. Forget it rather than show
        // green dots from the tunnel entrance (`lib/presence.ts`).
        presence.invalidate();
        reconnector?.trigger();
      });
      reconnector.trigger();

      // Socket lifecycle (6.2). In the BACKGROUND: clean, deliberate close.
      // The OS would kill it anyway (Doze), push takes over, and "deliberate"
      // keeps the reconnector from reconnecting into the void while in the
      // background. The desired subscriptions survive. On RETURN: the liveness
      // probe covers a socket left "open" but dead (frozen without going through
      // background), and `trigger` redoes everything: reconnection, re-login,
      // resubscriptions, catch-up.
      //
      // `close()` is NOT ENOUGH to keep that promise: it tells the reconnector
      // nothing. An already armed backoff timer still fired, and the failure of
      // an in-flight attempt restarted the loop: sockets reopened in the
      // background, each paid with a rate-limited REST `catchUpAll()`, and
      // killed by Doze, which retriggered `onLoss`. Hence the suspension,
      // reversible, BEFORE the close: otherwise a loss seen in between would
      // re-arm the reconnector we just calmed down.
      const appStateSub = AppState.addEventListener('change', (appState) => {
        if (discarded) return;
        if (appState === 'background') {
          reconnector?.suspend();
          ddp.close();
          // What we think we know of presence dates from the moment before:
          // no stream will correct it while in the background.
          presence.invalidate();
          return;
        }
        if (appState !== 'active') return;
        reconnector?.resume();
        if (ddp.state !== 'closed') ddp.checkAlive().catch(() => {});
        reconnector?.trigger();
      });
      onAbort = () => {
        appStateSub.remove();
        // E2E plaintext does not survive the end of the session. `e2eUnlocked`
        // writes the decrypted text into the `text` column (lib/sync.ts), and
        // the project already acknowledges that this plaintext must be able to
        // disappear: that is the "Lock" button. It was inconsistent for the
        // strongest gesture, logout, to protect less than the weakest.
        //
        // Here rather than in `logOut()`: the engine and its write queue live
        // in this scope. The SQLite connection, however, stays open for the
        // process lifetime (db/client.ts), so this write runs under no one's
        // feet: the queue serializes it behind in-flight transactions.
        // Fire-and-forget: a cleanup cannot wait, and the masking replays
        // anyway at the next startup while locked.
        void engine.e2eRelocked().catch(() => {});
      };
    })().catch((e: unknown) => {
      // Here even the local database is unusable: error screen.
      if (!discarded) {
        setSync({
          phase: 'error',
          message: e instanceof Error ? e.message : translateCurrent('sync.databaseUnavailable'),
        });
      }
    });

    return () => {
      discarded = true;
      // Order matters: stop the reconnector BEFORE closing, otherwise the
      // close could still schedule an attempt.
      reconnector?.stop();
      onAbort?.();
      armUploadProbe(null); // no more probing a stowed client
      stopTokenListener(); // nor re-registering with a server left behind
      forgetSessionStores();
      unmountUsage();
      unprofile();
      uncalls();
      unnames();
      // Rocket.Chat's real names are fed by `ui/identities.tsx`, not by a provider source.
      if (client.kind === 'rocketchat') setDisplayNames(new Map());
      ddp.close();
      ddp.reset();
    };
  }, [state,adoptRenewedSession]);

  return <Context.Provider value={sync}>{children}</Context.Provider>;
}

/**
 * The rule "every module store is purged at session end", for every provider.
 * The "this already had its opening load" caches are keyed by generation,
 * whose counter restarts from zero in the next session: without a purge, a
 * room from ANOTHER server could pass as already loaded. Each of these purges
 * also invalidates the session token, which forbids still-mounted screens from
 * repopulating them while unmounting: their cleanup runs AFTER this one (see
 * `ui/sessionToken.ts`). The rooms kept listened to after leaving them are
 * released: their subscriptions are worthless on a socket being closed. The
 * rest let account data leak from the account left to the next: the permalink
 * of a pending quote (which carries the OLD baseUrl), the usernames and photo
 * versions (a stale etag makes Android's cache serve the old image again), the
 * call availability verdict, the list of encrypted rooms and the icon badge,
 * and the raw profile records.
 */
function forgetSessionStores(): void {
  forgetLoadedRooms();
  forgetLoadedThreads();
  releaseHotRooms();
  forgetReplies();
  forgetIdentities();
  clearRealNames();
  forgetCallAvailability();
  forgetNotificationState();
  forgetProfileCards();
}

export function useSync(): SyncState {
  const context = useContext(Context);
  if (context === null) {
    throw new Error('useSync called outside <SyncProvider>.');
  }
  return context;
}
