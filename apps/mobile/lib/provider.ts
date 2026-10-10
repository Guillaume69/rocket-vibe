/**
 * Contract of a chat provider. Rocket.Chat is its first implementation,
 * RocketVibe the second. Everything in the app that names a `/api/v1/*`
 * endpoint or a `stream-*` stream must eventually go through here; the rest
 * (`db/`, `Store`, rendering, `Reconnector`) is already neutral.
 *
 * Load-bearing choice: the sync core does not speak a server's wire format.
 * Each provider translates its feed into a neutral local projection.
 * Rocket.Chat uses `SyncChange`; RocketVibe applies its journal and cursor
 * atomically. No Rocket.Chat document is ever requested from the native server.
 */

import type { DdpEvent, DdpState } from './ddp.ts';
import type { OutboxEncryptor, OutboxStore } from './outbox.ts';
import type { UploadEncryption, UploadStore } from './uploadQueue.ts';
import type { LocalSubscription, LocalMessage, LocalRoom, RoomNotificationLevel } from './normalize.ts';
import type { SyncEngine } from './sync.ts';
import type { FileToSend, TransportUpload } from './upload.ts';

/**
 * An already normalised sync change, ready to write into the `Store`. A
 * provider's translator emits them; `SyncEngine.apply` routes them to the
 * upserts/deletes. The delete cases follow the three shapes the RC server
 * distinguishes (message, room, or just a `subId`).
 */
export type SyncChange =
  | { type: 'message'; doc: LocalMessage }
  | { type: 'room'; doc: LocalRoom }
  | { type: 'subscription'; doc: LocalSubscription }
  | { type: 'message-deleted'; id: string }
  | { type: 'room-deleted'; rid: string }
  | { type: 'subscription-deleted-by-sub'; subId: string }
  /** A message's `starred` column alone (a star set elsewhere); a message not cached stays absent. */
  | { type: 'message-starred'; id: string; starred: string | null }
  /**
   * New version of the photo of a user (by username) OR of a room (by rid):
   * one of the two keys, never both. `etag` is the avatar URL cache-buster; it
   * is `AVATAR_NO_PHOTO` when the photo was REMOVED, which must change the URI
   * just as much as an addition.
   */
  | { type: 'avatar'; username: string | null; rid: string | null; etag: string };

/**
 * A session's server type. Persisted with it: it decides which driver to
 * instantiate at startup. Older sessions stay Rocket.Chat.
 */
export type ProviderKind = 'rocketchat' | 'rocketvibe' | 'mattermost' | 'kchat';

export type ProviderIdentity = {
  kind: ProviderKind;
  origin: string;
  accountId: string;
  instanceId: string | null;
  generation: string | null;
};

/** Neutral diagnostic. A 2FA challenge or a proxy response does not revoke the session. */
export type ProviderError = {
  code: string;
  status: number;
  requestId: string | null;
  retryAfter: number | null;
  rejectsSession: boolean;
  twoFactorChallenge: boolean;
};

const KINDS: readonly ProviderKind[] = ['rocketchat', 'rocketvibe', 'mattermost', 'kchat'];

/**
 * Brings a stored value back to a known `ProviderKind`. Sessions from before
 * the field was added have none: they fall back on `rocketchat` (the only
 * possible server at the time). Migration without a write: the value is fixed
 * on read. Defaults to `rocketchat` for any unknown value.
 */
export function normalizeProviderKind(value: unknown): ProviderKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
    ? (value as ProviderKind)
    : 'rocketchat';
}

/**
 * What each provider can do. Screens read these flags to hide what does not
 * exist rather than trimming down to the lowest common denominator; an
 * unsupported action throws. `threadTemplate`: Rocket.Chat nests by `tmid`,
 * Mattermost flattens by `root_id`; both reduce to "id of the parent post".
 */
export type Capabilities = {
  editing?: boolean;
  deletion?: boolean;
  files?: boolean;
  threads?: boolean;
  reactions?: boolean;
  marks?: boolean;
  profile?: boolean;
  roomInfo?: boolean;
  roomSettings?: boolean;
  roomRoleList?: boolean;
  leaveRoom?: boolean;
  roomFavorites?: boolean;
  roomReads?: boolean;
  quotes?: boolean;
  /** A thread reply can also be posted to the room (Rocket.Chat `tshow`). */
  alsoInRoom?: boolean;
  /** Voice sessions in every room, voice channels and ringing DMs (RocketVibe). */
  voice?: boolean;
  /** Server administration from the app (`Provider.admin`), for an administrator. */
  administration?: boolean;
  /** Members can report a message or an account (`Provider.reports`). */
  reports?: boolean;
  typing: boolean;
  presence: boolean;
  push: boolean;
  e2ee: boolean;
  customEmojis: boolean;
  videoCall: boolean;
  search: boolean;
  threadTemplate: 'tmid' | 'root_id';
};

/**
 * Real-time listening. Exactly the public surface of `ClientDdp` (the
 * `Reconnector` driver and `ui/sync.tsx` depend on it): `ClientDdp` conforms
 * without wrapping. A Mattermost driver would implement the same interface on
 * top of a JSON WebSocket, emitting `DdpEvent`s (neutral envelope
 * `{collection, eventKey, args}`) that its `Translator` can decode.
 */
export interface Listener {
  /** Public field, not a getter, like `ClientDdp.state`. */
  readonly state: DdpState;
  connect(authToken: string): Promise<void>;
  /** Registers a desired subscription; returns the release function. Replayed on every (re)connection. */
  subscribe(name: string, eventKey: string): () => void;
  /** Returns the unsubscribe function. */
  onEvent(listener: (event: DdpEvent) => void): () => void;
  onLoss(listener: () => void): () => void;
  close(): void;
  checkAlive(): Promise<boolean>;
  /**
   * Resolved when the server has armed the desired subscriptions: the exact
   * signal of when the stream starts covering. Connection setup uses it to
   * order its REST read without ever betting on a delay.
   */
  armedSubscriptions(): Promise<void>;
  reset(): void;
}

/**
 * Result of translating a raw `DdpEvent`. Reproduces exactly the three
 * outcomes of the historical RC switch: a change to write, an anomaly
 * (unexpected stream, to COUNT for debugging), or an expected silence
 * (typing `user-activity`, handled elsewhere, NOT to count, or the keystroke
 * beats drown the anomaly counter).
 */
export type Translation =
  | { kind: 'change'; change: SyncChange }
  | { kind: 'ignore' }
  | { kind: 'silence' };

/**
 * The server-specific part of sync: decoding its raw `DdpEvent`s and its REST
 * documents into neutral shapes. `SyncEngine` depends only on this interface:
 * it no longer knows any stream name or wire quirk. Each provider supplies one
 * (RC: `RcTranslator`; Mattermost: its own).
 */
export interface Translator {
  /** Real-time feed: a `Listener` `DdpEvent` → a change, an anomaly, or a silence. */
  translateEvent(event: DdpEvent): Translation;
  /** REST batches (catch-up, history): raw document → local row, or null if unrecoverable. */
  toMessage(raw: Record<string, unknown>): LocalMessage | null;
  toRoom(raw: Record<string, unknown>): LocalRoom | null;
  toSubscription(raw: Record<string, unknown>): LocalSubscription | null;
}

/**
 * Single actions on messages (the central write path). Sending text and files
 * goes through the outbox engines (`OutboxEngine`, `UploadEngine`), built by
 * the provider, not through these methods.
 *
 * Secondary reads (profile, search, room info, spotlight) will be added here
 * when their screens are routed; they carry DTOs we don't define in advance.
 */
/** How people are named, and how many direct conversations the list keeps. */
export type SidebarSettings = {
  nameFormat: 'username' | 'nickname_full_name' | 'full_name';
  /** The server imposes its format: the choice is shown, not offered. */
  nameLocked: boolean;
  dmLimit: number;
};

export interface ProviderActions {
  /** Decimal positions stay strings; a timer captures this opening membership. */
  roomReadState?(rid:string):Promise<RoomReadState|null>;
  roomFavorite?: RoomFavorite;
  roomInfo(rid: string): Promise<RoomInformation>;
  roomManagement?: RoomManagement;
  react(rid: string, mid: string, emoji: string, put: boolean): Promise<void>;
  /** `encryptor`: the message is encrypted, so is its new version. */
  edit(rid: string, mid: string, text: string, encryptor?: OutboxEncryptor, revision?: string): Promise<void>;
  delete(rid: string, mid: string, revision?: string): Promise<void>;
  pin(rid: string, mid: string): Promise<void>;
  unpin(rid: string, mid: string): Promise<void>;
  star(rid: string, mid: string, put: boolean): Promise<void>;
  /** A room's pinned messages, newest first. One request per call. */
  listPinned(rid: string): Promise<LocalMessage[]>;
  /** My starred messages in a room, newest first. */
  listStarred(rid: string): Promise<LocalMessage[]>;
  /**
   * A page of the room's thread roots, latest reply first, from `offset`;
   * `following`: only the threads I follow. `total` counts the whole list.
   * Absent where the server has no such list (screens hide the entry).
   */
  listThreads?(rid: string, following: boolean, offset: number): Promise<ThreadPage>;
  /** Follows or unfollows the thread of `root` (idempotent server-side). */
  followThread?(rid: string, root: string, put: boolean): Promise<void>;
  /**
   * A page of a channel's or group's members from `offset`, owners and
   * moderators first, `filter` searched by the server. Absent where the
   * server has no such list (a DM has none).
   */
  listMembers?(rid: string, filter: string, offset: number): Promise<MemberPage>;
  /** Gives or takes a member's room role; `type` is the room's (`c` or `p`). */
  setMemberRole?(rid: string, type: string, userId: string, role: 'moderator' | 'owner', put: boolean): Promise<void>;
  /** Removes a member from the room. */
  removeMember?(rid: string, type: string, userId: string): Promise<void>;
  /** Writes the given texts of the room (only those present). */
  saveRoomSettings?(rid: string, fields: Partial<RoomTexts>): Promise<void>;
  markRead(rid: string, observation?:ReadObservation): Promise<void>;
  /**
   * Makes the room unread again from its last message; the subscription the
   * server rebroadcasts carries the badge. Absent where the server cannot.
   */
  markUnread?(rid: string): Promise<void>;
  /** "Mark as read" from the list: the room AND its threads, which a plain read leaves in alert. */
  markAllRead?(rid: string): Promise<void>;
  /**
   * The room's own notification choice, `default` to follow the account again.
   * Rocket.Chat writes it for desktop and push alike: one choice per room.
   */
  roomNotifications?(rid: string, level: RoomNotificationLevel | 'default'): Promise<void>;
  /**
   * Opens (or creates, idempotent server-side) the DM with `username`. Returns
   * the `rid` and the raw room document, to ingest so we can navigate without
   * waiting for the stream. Was written twice (profile card, search), with two
   * different validations of the response.
   */
  openOrCreateDm(username: string,uid?:string): Promise<{ rid: string; rawRoom: Record<string, unknown> }>;
}

/** A room member as `ProviderActions.listMembers` reads it; `roles` in the room (`owner`, `moderator`, `leader`). */
export type RoomMember = { id: string; username: string; name: string | null; status: string | null; avatarEtag: string | null; roles: string[] };
/** One page of `ProviderActions.listMembers`, owners and moderators first. */
export type MemberPage = { members: RoomMember[]; total: number };

/** A room's texts as `ProviderActions.saveRoomSettings` writes them. */
export type RoomTexts = { topic: string; description: string; announcement: string };

/** One page of `ProviderActions.listThreads`. */
export type ThreadPage = { threads: LocalMessage[]; total: number };

export type ReadObservation={messageId:string;adhesion:string};
export type RoomReadState={adhesion:string;rootPosition:string;replyPosition:string;unreadRoots:string;unreadReplies:string;mentions:string;groupMentions:string};
export type RoomFavoriteState={adhesion:string;revision:string;present:boolean;intention:{key:string;present:boolean;failed:boolean;error:string|null}|null};
export interface RoomFavorite {
  read?: (rid:string)=>Promise<RoomFavoriteState|null>;
  edit:(rid:string,present:boolean,state?:Pick<RoomFavoriteState,'adhesion'|'revision'>)=>Promise<void>;
  resume?:(rid:string,key:string)=>Promise<void>;
  clear?:(rid:string,key:string)=>Promise<boolean>;
}

/** Data of the existing info sheet, independent of the server protocol. */
export type RoomInformation = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  topic: string | null;
  announcement: string | null;
  members: number | null;
  readOnly: boolean;
  management?: RoomSettings;
};

export type RoomRole = 'owner'|'moderator'|'member';
/** `voice`: whether it is a voice channel, present only where an owner may change it (a
 * room that is not direct, on a server announcing voice); absent leaves the flag as it is. */
export type RoomFields = {name:string;isPrivate:boolean;topic:string;description:string;announcement:string;readOnly:boolean;voice?:boolean};
export type RoomSettings = RoomFields & {revision:string;canEdit:boolean;canChangeRoles:boolean;canLeave:boolean;role:RoomRole};
/** `bot`: a bot account (RocketVibe, RFC 0003); absent on Rocket.Chat. */
export type ProviderRoomMember = {id:string;username:string;name:string|null;role:RoomRole;deactivated:boolean;bot?:boolean};
export type ProviderRoomMemberPage = {revision:string;members:ProviderRoomMember[];continuation:string|null};
export type RoomIntent = {key:string;type:'settings'|'role'|'leave';settings:RoomFields|null;target:string|null;role:RoomRole|null;failed:boolean;error:string|null};
export type RoomManagement = {
  members(rid:string,continuation:string|null,revision:string):Promise<ProviderRoomMemberPage>;
  edit(rid:string,revision:string,fields:RoomFields):Promise<void>;
  changeRole(rid:string,revision:string,target:string,role:RoomRole):Promise<void>;
  leave(rid:string,revision:string):Promise<void>;
  intention(rid:string):Promise<RoomIntent|null>;
  resume(rid:string):Promise<void>;
  clear(rid:string,key:string):Promise<boolean>;
};

/** Rocket.Chat capabilities. E2EE degraded (read-only), gateway push out of scope. */
export const ROCKETCHAT_CAPABILITIES: Capabilities = {
  editing: true,
  deletion: true,
  typing: true,
  presence: true,
  push: true,
  e2ee: true,
  customEmojis: true,
  videoCall: true,
  search: true,
  administration: true,
  reports: true,
  alsoInRoom: true,
  threadTemplate: 'tmid',
};

/** Feeds back into sync a document returned by a send (optimistic echo). */
export type Ingest = (doc: Record<string, unknown>) => Promise<void>;

/** Persisted text send queue (outbox), replayed on reconnection. */
export interface Outbox {
  retry?(id: string): Promise<void>;
  /** Returns the client `_id` of the posted message. `threadId` = parent post (thread), or null.
   *  `localAttachments`: attachments (JSON) for the optimistic display only
   *  (quote preview), never sent, overwritten by the server echo. */
  send(
    rid: string,
    text: string,
    threadId?: string | null,
    localAttachments?: string | null,
    quotes?: readonly import('../providers/rocketvibe/quotes.ts').NativeQuoteSelection[],
    /** A thread reply also posted to the room (`Capabilities.alsoInRoom`). */
    alsoInRoom?: boolean,
  ): Promise<string>;
  process(): Promise<void>;
  discard(id: string): Promise<void>;
}

/** Persisted file send queue. `progress`: 0..1 per id, for the UI. */
export interface FileOutbox {
  close?():void;
  readonly progress: Map<string, number>;
  /** Subscribe to `progress` changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Rejects (`ValidationError`) a file the server would refuse, without sending anything. */
  validate(file: { type: string; size: number | null }, rid?: string): Promise<void>;
  send(
    rid: string,
    file: FileToSend & { size: number | null },
    caption?: string,
    /** The thread the file answers; null or absent in the room itself. */
    thread?: string | null,
  ): Promise<void>;
  process(): Promise<void>;
  /**
   * The explicit "Retry" action. Required since the automatic replay skips
   * failed rows: a plain `process()` would no longer see them.
   */
  retry(id: string): Promise<void>;
  /** `uri` also allows erasing the temporary file. */
  discard(id: string, uri?: string): Promise<void>;
}

/**
 * A chat provider assembled for a session: everything server-specific in the
 * sync and action path, behind a single facade. `ui/sync.tsx` orchestrates it
 * without naming Rocket.Chat; the Mattermost driver will supply the same
 * object. The still RC-only extras (presence, custom emojis, push, E2EE) stay
 * outside this facade in 4a, guarded by `capabilities`, to absorb later.
 */
export interface Provider {
  readonly identity: ProviderIdentity;
  describeError(error: unknown, authenticated: boolean): ProviderError;
  readonly messageOrder?: 'sequence';
  readonly native?: { chat: import('../providers/rocketvibe/chat.ts').NativeChat; store: import('../providers/rocketvibe/store.ts').NativeStore };
  readonly capabilities: Capabilities;
  /** Temporary results, normalised for the existing renderer. */
  searchMessages?(rid:string,text:string):Promise<LocalMessage[]>;
  /** Everyone's presence at once, when the protocol reads it its own way (`capabilities.presence`). */
  loadPresence?(): Promise<ReadonlyArray<{ user: { id: string }; status: import('./presence.ts').PresenceStatus }>>;
  /** Presentation data of the existing info sheet, supplied by each protocol. */
  /** The account's own conversation list settings, kept on the server (Mattermost). */
  sidebarSettings?: {
    read(): Promise<SidebarSettings>;
    write(change: Partial<Pick<SidebarSettings, 'nameFormat' | 'dmLimit'>>): Promise<void>;
  };
  /** Conferences of the server's own (kChat's kMeet), in place of Rocket.Chat's `video-conference.*`. */
  calls?: import('./call.ts').NativeCalls;
  /** People's names by user id when the server sets them apart from usernames (`lib/displayNames.ts`). */
  displayNames?: import('./displayNames.ts').DisplayNameSource;
  /** The server's custom emoji, when it does not speak Rocket.Chat's `emoji-custom.list`. */
  listCustomEmojis?(): Promise<import('./customEmojis.ts').CustomEmoji[]>;
  readProfile?(target:import('./profilePreload.ts').ProfileParams):Promise<Record<string,unknown>|undefined>;
  /** Server administration (`lib/admin.ts`), when `capabilities.administration`. */
  readonly admin?: import('./admin.ts').ProviderAdmin;
  /** Reporting a message or an account, when `capabilities.reports`. */
  readonly reports?: import('./admin.ts').ProviderReports;
  /** Real-time transport (RC: DDP; MM: JSON WebSocket). */
  readonly listener: Listener;
  /** Decoder from raw `DdpEvent`s/documents to neutral shapes. */
  readonly translator: Translator;
  /** Single actions on messages. */
  readonly actions: ProviderActions;
  /** Desired subscriptions `[name, key]`, declared before the 1st connection (replayed on every reconnection). */
  initialSubscriptions(): readonly (readonly [name: string, key: string])[];
  /**
   * PER-ROOM subscriptions: the ones the room screen (and a thread) arms on
   * open, the counterpart of `initialSubscriptions`. The key format (`rid`,
   * `rid/topic`...) belongs to the provider: screens loop over the result
   * without knowing it. Refcounted by the `Listener`: several screens on the
   * same room cost a single `sub`.
   */
  roomSubscriptions(rid: string): readonly (readonly [name: string, key: string])[];
  /**
   * What a transport event tells me alone in a room (a slash command's reply),
   * or `null` if it is not that.
   */
  privateNote(event: DdpEvent): { rid: string; text: string } | null;
  /**
   * A page of the room's history (newest first), ingested into the engine.
   * `type`: the room type as stored (`rooms.type`); `latest`: ISO keyset
   * bound; absent, the page starts from now. Returns the page's oldest
   * timestamp: the screen's pagination step-back criterion.
   */
  loadHistory(
    engine: SyncEngine,
    rid: string,
    type: string,
    latest?: string,
  ): Promise<{ oldest: number | null; movedBack?: boolean }>;
  /**
   * The history between two instants (epoch ms), bounds included, NOT
   * ingested; `null` = unbounded. The server answers the NEWEST
   * `historyPage` documents of the range, whatever `oldest` is.
   */
  historyRange(
    rid: string,
    type: string,
    latest: number | null,
    oldest: number | null,
  ): Promise<Record<string, unknown>[]>;
  /** The server's copy of one message, not ingested; `null` when it answers without it. */
  fetchMessage(id: string): Promise<Record<string, unknown> | null>;
  /** Documents per page of `loadHistory` and `historyRange`. */
  readonly historyPage: number;
  /**
   * The whole `threadId` thread (root included), ingested into the engine.
   * Replayable: the same idempotent upserts as the rest of sync.
   */
  loadThread(engine: SyncEngine, threadId: string, isDiscarded: () => boolean): Promise<void>;
  createOutbox(store: OutboxStore, ingest: Ingest, encryptor?: OutboxEncryptor): Outbox;
  createUploadQueue(
    store: UploadStore,
    transport: TransportUpload,
    ingest: Ingest,
    /**
     * Two hooks that cannot live in `lib/`: the first touches
     * `expo-file-system`, the second the REST catch-up. Optional: without them
     * the engine stays correct, only worse (growing cache, possible duplicate
     * on a lost `mediaConfirm`).
     */
    hooks?: {
      nativeFiles?:import('../providers/rocketvibe/uploads.ts').NativeFileIO;
      deleteLocalFile?: (uri: string) => Promise<void>;
      refreshRoom?: (rid: string) => Promise<void>;
      /** Sending into an encrypted room: without it, a file waits there forever. */
      encryption?: UploadEncryption;
    },
  ): FileOutbox;
  /** Global REST catch-up (rooms + subscriptions delta). */
  catchUpGlobal(engine: SyncEngine, isDiscarded: () => boolean): Promise<void>;
  /** Catch-up of ONE room (the open one). Rate-limited, unbounded on the RC side: see `ui/sync.tsx`. */
  catchUpRoom(engine: SyncEngine, rid: string, isDiscarded: () => boolean): Promise<void>;
  /** Anti-ghost reconciliation (once per session). */
  reconcile(engine: SyncEngine, isDiscarded: () => boolean): Promise<void>;
}
