/**
 * Local schema. **SQLite is the source of truth**, the UI is only a
 * projection of it: the WebSocket and REST upsert into it, never the reverse.
 *
 * One database per server **and per account** (`db/fileName.ts`): the file
 * name derives from the host and the user, so nothing multi-server here.
 *
 * Rocket.Chat dates arrive as EJSON (`{"$date": epochMs}`) or ISO. We store
 * them as **integer milliseconds**: comparable, indexable, with no time zone
 * ambiguity.
 */

import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Rocket.Chat room type: c=channel, p=private group, d=direct, l=livechat. */
export type RoomType = 'c' | 'p' | 'd' | 'l';

export const rooms = sqliteTable(
  'rooms',
  {
    rid: text('rid').primaryKey(),
    type: text('type').$type<RoomType>().notNull(),
    /** `name` is the slug; `fname` the display name (may contain spaces). */
    name: text('name'),
    displayName: text('display_name'),
    /** End-to-end encrypted room: we do not write there, we do not show the preview. */
    encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
    readOnly: integer('read_only', { mode: 'boolean' }).notNull().default(false),
    /** A voice channel (RocketVibe server): opening it joins its voice session. */
    voice: integer('voice', { mode: 'boolean' }).notNull().default(false),
    /**
     * The OTHER participant of a two-person DM (from the Rooms document's
     * `uids`), for presence (8.4). An 8.5 DM rid is a RANDOM ObjectId, no
     * longer the concatenation of both uids; it cannot be derived.
     */
    dmOtherUid: text('dm_other_uid'),
    /** Preview of the last message. `null` if the room is encrypted. */
    lastMessage: text('last_message'),
    /**
     * The last message's `t`, when it has one. Separates the TWO meanings of
     * `last_message IS NULL`: "this room no longer has a last message" (column
     * null as well) and "the last message has nothing to show", the exact shape
     * of a video call, whose content lives in `blocks`. Without it, a video call
     * lifted the room to the top of the list with an EMPTY preview line. Always
     * null for an encrypted room: its preview is computed locally
     * (`UPDATE_ENCRYPTED_PREVIEW`), not from `lastMessage`.
     */
    lastMessageType: text('last_message_type'),
    lastMessageTs: integer('last_message_ts'),
    /**
     * `avatarETag`: version of the room's photo. Without it, `/avatar/room/<rid>`
     * is a FROZEN URI that Android's image cache serves forever: the photo
     * changed server-side never appears. Injected as a query, it moves the URI
     * on every change (see `lib/upload.ts#avatarUrl`).
     */
    avatarEtag: text('avatar_etag'),
    updatedAt: integer('updated_at').notNull().default(0),
  },
  (t) => [index('idx_rooms_activity').on(t.lastMessageTs)],
);

/**
 * **Per-user** state of a room: unread, favourite, last read.
 * Distinct from the room itself, which all members share.
 */
export const subscriptions = sqliteTable('subscriptions', {
  rid: text('rid').primaryKey(),
  /**
   * Server-side `_id` of the subscription. The catch-up's `remove[]` entries
   * carry ONLY it (projection `{_id, _deletedAt}`, checked on 8.5): without
   * this column, a room left elsewhere would stay listed forever.
   */
  subId: text('sub_id'),
  unread: integer('unread').notNull().default(0),
  mentions: integer('mentions').notNull().default(0),
  groupMentions: integer('group_mentions').notNull().default(0),
  alert: integer('alert', { mode: 'boolean' }).notNull().default(false),
  open: integer('open', { mode: 'boolean' }).notNull().default(true),
  favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
  /** `ls`: last read date, for the "new messages" bar. */
  lastSeen: integer('last_seen'),
  /** `E2EKey`: the room's AES key RSA-encrypted for this member (E2EE, step 10). */
  e2eKey: text('e2e_key'),
  /** `e2eKeyId`: UUID of the room key, if the server provides it separately. */
  e2eKeyId: text('e2e_key_id'),
  /** `roles`: my roles IN this room (`owner`, `moderator`...), serialised; `null` if none. */
  roles: text('roles'),
  /** A sidebar category of my own (Mattermost): the room is listed under it. */
  groupId: text('group_id'),
  groupName: text('group_name'),
  /** Where the room's section sits in my sidebar order; `null` keeps the default order. */
  groupRank: integer('group_rank'),
  /** The room's own push choice (`all`, `mentions`, `nothing`); `null` follows the account. */
  pushPreference: text('push_preference'),
  updatedAt: integer('updated_at').notNull().default(0),
});

export const messages = sqliteTable(
  'messages',
  {
    /** Rocket.Chat `_id`. Generated client-side on send: it is the deduplication key. */
    id: text('id').primaryKey(),
    rid: text('rid').notNull(),
    /** `null` for an undecryptable encrypted message, or a system message. */
    text: text('text'),
    ts: integer('ts').notNull(),
    authorId: text('author_id').notNull(),
    authorName: text('author_name'),
    /** `t`: system message type (`uj`, `ul`, `rm`, `e2e`...). `null` = ordinary message. */
    systemType: text('system_type'),
    /** `tmid`: id of the root message, if this message is a thread reply. */
    threadId: text('thread_id'),
    /** `tcount`: number of replies, on the root message. */
    threadCount: integer('thread_count').notNull().default(0),
    /** `tlm`: timestamp of the last reply, carried by the root message. */
    threadLast: integer('thread_last'),
    /** `tshow`: thread reply to show ALSO in the room's main stream. */
    threadShown: integer('thread_shown', { mode: 'boolean' }).notNull().default(false),
    editedAt: integer('edited_at'),
    /** Markdown AST pre-parsed by the server (`md`), serialised. Absent from old messages. */
    md: text('md'),
    attachments: text('attachments'),
    reactions: text('reactions'),
    /**
     * `urls`: link metadata parsed by the SERVER (OpenGraph/oEmbed), serialised.
     * Source of the preview cards (`lib/linkPreview.ts`). Often arrives AFTER the
     * message: the server parses asynchronously then pushes the enriched version
     * again with a more recent `_updatedAt`, which the upsert accepts.
     */
    urls: text('urls'),
    /**
     * `callId` of a video conference message (`t: 'videoconf'`), read from the
     * `video_conf` block. We keep ONLY it among the `blocks`: it is the only
     * field we replay ("Join" button), and it is NOT the message's `_id`.
     * `null` everywhere else.
     */
    callId: text('call_id'),
    /**
     * `content` object of an encrypted message (`rc.v2.aes-sha2`), serialised,
     * kept for deferred decryption on E2EE unlock. `text` stays null while the
     * room is not unlocked. See `lib/e2e`.
     */
    encryptedRaw: text('encrypted_raw'),
    /** `pinned`. */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** `starred` reduced to uids, serialised; `null` if nobody. See `lib/marks.ts`. */
    starred: text('starred'),
    /** A thread root's followers (`replies`), serialised uids; `null` if none. See `lib/marks.ts`. */
    threadFollowers: text('thread_followers'),
    /** `drid`, `dcount`, `dlm` of a `discussion-created` message: the discussion it opens. */
    discussionId: text('discussion_id'),
    discussionCount: integer('discussion_count').notNull().default(0),
    discussionLast: integer('discussion_last'),
    updatedAt: integer('updated_at').notNull().default(0),
    /**
     * The author is a bot account (RocketVibe, RFC 0003): the row shows a
     * "BOT" badge after the name. Written by the native store only, after its
     * upsert (`providers/rocketvibe/store.ts`); always false on Rocket.Chat.
     */
    authorBot: integer('author_bot', { mode: 'boolean' }).notNull().default(false),
    /**
     * The form a workflow posted with this message (RocketVibe, RFC 0004):
     * `Message.form` (`WorkflowForm`) as JSON, `null` without one. Written by
     * the native store only, after its upsert, like `author_bot`; drawn as a
     * card by `ui/messageRow.tsx` and answered in `app/answer-form.tsx`.
     */
    form: text('form'),
  },
  // The index covers the room screen's query: `WHERE rid = ? ORDER BY ts DESC`.
  (t) => [index('idx_messages_room_ts').on(t.rid, t.ts), index('idx_messages_thread').on(t.threadId)],
);

/**
 * Status of an optimistic send. There is no "sent" state: on success (or as
 * soon as a server-origin copy arrives), the row is DELETED.
 */
export type OutboxStatus = 'pending' | 'failed';

/**
 * Persistent outbox. The message is shown immediately, then reconciled when
 * the server sends it back: the `_id` is generated client-side, and the
 * server never accepts two of them, so a resubmission after a crash creates
 * no duplicate. CAUTION: the replay answers 400, not an idempotent success
 * (see lib/outbox.ts).
 */
export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    rid: text('rid').notNull(),
    text: text('text').notNull(),
    threadId: text('thread_id'),
    /** A thread reply also shown in the room (`tshow`). */
    shown: integer('shown', { mode: 'boolean' }).notNull().default(false),
    status: text('status').$type<OutboxStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_outbox_status').on(t.status)],
);

/**
 * Upload queue (7.2), the counterpart of `outbox` for files. The `uri`
 * points to a LOCAL file (picker cache): it survives the app being killed,
 * so the replay at startup can resume an interrupted send.
 *
 * **`file_id` is the deduplication key.** The upload happens in TWO steps
 * (`rooms.media` then `rooms.mediaConfirm`; `rooms.upload` was removed in
 * 8.0) and it is the SECOND that posts the message. With no state between
 * the two, a lost `mediaConfirm` response (15 s maximum timeout on the
 * `RestClient` side, a network flap is enough) made everything start over at
 * the next connection setup: the bytes went out again, a second message was
 * posted, and the first file stayed orphaned on the server. Recorded as soon
 * as `rooms.media` returns, `file_id` skips the first step and lets us ask
 * SQLite, not the network, whether the message is already there.
 *
 * The three statuses:
 * - `pending`: the only one the automatic replay picks up;
 * - `sending`: taken by a pass of THIS process. Excluded from listing, so
 *   never uploaded twice in parallel; re-armed at the first `process()` of
 *   the next process, otherwise a kill mid-upload would have frozen it
 *   there forever;
 * - `failed`: the server refused. NO LONGER replayed automatically: a refused
 *   video (413, type, quota) pushed all its bytes again on every return to
 *   the foreground. Only the "Retry" gesture re-arms it.
 */
export const uploads = sqliteTable(
  'uploads',
  {
    id: text('id').primaryKey(),
    rid: text('rid').notNull(),
    uri: text('uri').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    caption: text('caption'),
    /** The thread the file answers (`rooms.mediaConfirm` `tmid`); null in the room. */
    tmid: text('tmid'),
    status: text('status')
      .$type<'pending' | 'sending' | 'failed'>()
      .notNull()
      .default('pending'),
    lastError: text('last_error'),
    /** Returned by `rooms.media`. Non-null = the bytes are already on the server. */
    fileId: text('file_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_uploads_status').on(t.status)],
);

/**
 * Composer drafts (8.7), per room (`rid`) or per thread (`rid:tmid`).
 * In SQLite rather than MMKV (a recorded deviation from the plan): the draft
 * is debounced, async latency is irrelevant, and one more NATIVE dependency,
 * hence a rebuild, is not justified against ROADMAP §4.2 when the database
 * already covers all local state.
 */
export const drafts = sqliteTable('drafts', {
  /** `rid`, or `rid:tmid` for a reply in a thread. */
  key: text('key').primaryKey(),
  text: text('text').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * The emoji I react with, counted on the device for the quick reactions of
 * the message sheet (`lib/emojiUsage.ts`). DEVICE data, not server data: no
 * catch-up can rebuild it, so neither the purges nor `NativeStore.prepare()`
 * (which empties the server projection on a data-epoch change) touch it.
 * Codes are shortcodes without colons; at most `KEPT_CODES` rows.
 */
export const emojiUsage = sqliteTable('emoji_usage', {
  code: text('code').primaryKey(),
  count: integer('count').notNull(),
  /** Milliseconds. */
  lastUsed: integer('last_used').notNull(),
});

/**
 * The server's custom emojis (`emoji-custom.list`). A REFERENCE table, not a
 * stream: `msg.md` only delivers the shortcode (`:party_parrot:`), this table
 * gives the FILE name to show. Persisted for offline-first (step 8): at
 * startup without network, customs still show; loaded into an in-memory Map
 * (`lib/customEmojis.ts`) for synchronous rendering.
 *
 * Since the database is per (server, account), the table is already
 * server-scoped: no `etag` to keep, everything is replaced on catch-up.
 * `name` is the canonical name; `aliases` as JSON, each alias being a
 * shortcode in its own right (`:parrot:` = `:party_parrot:`), the in-memory
 * index unfolds them.
 */
export const customEmojis = sqliteTable('custom_emojis', {
  name: text('name').primaryKey(),
  extension: text('extension').notNull(),
  /** JSON `string[]`. An alias serves the same image as its canonical name. */
  aliases: text('aliases').notNull().default('[]'),
  /** The image's own address when the server does not serve it by name (Mattermost: by id). */
  uri: text('uri'),
  updatedAt: integer('updated_at').notNull().default(0),
});

/**
 * Author identities: `uid -> CURRENT username`. The Rocket.Chat username is
 * MUTABLE, the uid is not: the uid is therefore the real identity,
 * `messages.authorName` being only a snapshot frozen at ingestion (offline
 * fallback / first render). This table, fed by EVERY ingested message (the
 * username of the MOST RECENT message per uid wins), gives the username to
 * SHOW, up to date even for messages posted BEFORE a rename, which are not
 * downloaded again.
 */
export const users = sqliteTable('users', {
  uid: text('uid').primaryKey(),
  username: text('username'),
  /**
   * `avatarETag`: version of the profile photo, as the server names it. Same
   * role as on `rooms`: it is what changes the avatar URI when the photo
   * changes, otherwise the image cache freezes it for life. Fed by the
   * `updateAvatar` stream, by `me` at connection setup and by `users.info`
   * when a profile opens.
   */
  avatarEtag: text('avatar_etag'),
  /**
   * The person's real name (Rocket.Chat `name`), shown instead of the
   * username when the server's `UI_Use_Real_Name` is on (`ui/realNames.ts`).
   * Fed by messages (`u.name`), `users.info` and a DM's subscription (`fname`);
   * an absent name never erases a known one.
   */
  name: text('name'),
  /** `_updatedAt` of the message that set this username: "most recent wins" referee. */
  updatedAt: integer('updated_at').notNull().default(0),
});

/**
 * Catch-up cursors, per room and per stream. `chat.syncMessages` handles one
 * room at a time and REST is rate-limited: only open or recently active
 * rooms are resynced (step 5.2).
 */
export const cursors = sqliteTable(
  'cursors',
  {
    /** `rid`, or `*` for global cursors (`subscriptions.get?updatedSince`). */
    scope: text('scope').notNull(),
    stream: text('stream').notNull(),
    updatedSince: integer('updated_since').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.stream] })],
);

/** Native cursors and sequence numbers are opaque / decimal strings, never JS numbers. */
export const nativeSyncState = sqliteTable('native_sync_state', {
  singleton: integer('singleton').primaryKey(),
  instanceId: text('instance_id').notNull(),
  dataEpoch: text('data_epoch').notNull(),
  cursor: text('cursor').notNull(),
});

export const nativePositions = sqliteTable('native_positions', {
  id: text('id').primaryKey(),
  rid: text('rid').notNull(),
  position: text('position').notNull(),
  revision: text('revision').notNull(),
  replyTo: text('reply_to'),
}, (t) => [index('idx_native_positions_room').on(t.rid)]);

/** Personal state has its own revision and is never overwritten by public upserts. */
export const nativeStarStates = sqliteTable('native_star_states', {
  id: text('id').primaryKey(),
  rid: text('rid').notNull(),
  revision: text('revision').notNull(),
  present: integer('present',{mode:'boolean'}).notNull(),
}, (t) => [index('idx_native_star_room').on(t.rid)]);

export const nativeRoomCreations = sqliteTable('native_room_creations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  privateRoom: integer('private', {mode:'boolean'}).notNull(),
  /** A voice channel is another form: replaying it must not create a text room. */
  voice: integer('voice', {mode:'boolean'}).notNull().default(false),
}, (t) => [uniqueIndex('idx_native_room_creation_form').on(t.name,t.privateRoom,t.voice)]);

/** An unresolved action keeps its original revision across receipt/journal races. */
export const nativeMessageCommands = sqliteTable('native_commands', {
  id: text('id').primaryKey(),
  rid: text('rid').notNull(),
  messageId: text('message_id').notNull(),
  kind: text('kind').notNull(),
  expectedRevision: text('expected_revision').notNull(),
  text: text('text').notNull(),
  quotes: text('quotes'),
  state: text('state').notNull().default('pending'),
  error: text('error'),
}, (t) => [uniqueIndex('idx_native_command_message').on(t.messageId)]);

/** One unresolved room form keeps its original nonce and version until acknowledged. */
export const nativeRoomOperations = sqliteTable('native_room_operations', {
  id: text('id').primaryKey(),
  rid: text('rid').notNull(),
  payload: text('payload').notNull(),
  state: text('state').notNull().default('pending'),
  error: text('error'),
}, (t) => [uniqueIndex('idx_native_room_operation_room').on(t.rid)]);

/** One immutable attempt per profile field family, with no saved password. */
export const nativeProfileOperations = sqliteTable('native_profile_operations', {
  id: text('id').primaryKey(),
  slot: text('slot').notNull(),
  payload: text('payload').notNull(),
  state: text('state').notNull().default('pending'),
  error: text('error'),
}, (t) => [uniqueIndex('idx_native_profile_operation_slot').on(t.slot)]);

/** Immutable bytes, original membership and both operation IDs survive restart. */
export const nativeUploadIntents = sqliteTable('native_upload_intents', {
  id: text('id').primaryKey(),
  rid: text('rid').notNull(),
  payload: text('payload').notNull(),
  phase: text('phase').notNull().default('pending'),
});

/** Room version is persisted even before its effective actor rights are read. */
export const nativeRoomAccess = sqliteTable('native_room_access', {
  rid: text('rid').primaryKey(),
  revision: text('revision').notNull(),
  readOnly: integer('read_only',{mode:'boolean'}),
  canSend: integer('can_send',{mode:'boolean'}),
  role: text('role'),
});

/** Personal read/favorite revision is independent from metadata and actor rights. */
export const nativeReadStates = sqliteTable('native_read_states', {
  rid: text('rid').primaryKey(),
  payload: text('payload').notNull(),
});

/** Observed confirmed positions coalesce without using the newest cached message. */
export const nativeReadIntents = sqliteTable('native_read_intents', {
  rid: text('rid').primaryKey(),
  membership: text('membership').notNull(),
  rootPosition: text('root_position').notNull(),
});

export const nativeThreadStates = sqliteTable('native_thread_states', {
  root: text('root').primaryKey(),rid:text('rid').notNull(),payload:text('payload').notNull(),
});
export const nativeThreadReadIntents = sqliteTable('native_thread_read_intents', {
  root:text('root').primaryKey(),rid:text('rid').notNull(),membership:text('membership').notNull(),position:text('position').notNull(),
});

/** A receipt is a version floor, never a historical favorite value to project. */
export const nativeFavoriteIntents = sqliteTable('native_favorite_intents', {
  rid: text('rid').primaryKey(),
  id: text('id').notNull(),
  membership: text('membership').notNull(),
  payload: text('payload').notNull(),
  phase: text('phase').notNull().default('pending'),
  receiptRevision: text('receipt_revision'),
  error: text('error'),
}, (t) => [uniqueIndex('idx_native_favorite_operation').on(t.id)]);

/** Typed reply references are independent from the reader's current source view. */
export const nativeQuoteReferences = sqliteTable('native_quote_references', {
  messageId: text('message_id').notNull(),
  rid: text('rid').notNull(),
  ordinal: integer('ordinal').notNull(),
  sourceId: text('source_id').notNull(),
  sourceRoom: text('source_room').notNull(),
  observedRevision: text('observed_revision').notNull(),
}, (t) => [primaryKey({columns:[t.messageId,t.ordinal]}),index('idx_native_quote_origins').on(t.sourceRoom,t.sourceId)]);

/** Unavailable views keep their exact read watermark, with no author or source text. */
export const nativeQuoteSources = sqliteTable('native_quote_sources', {
  id: text('id').primaryKey(),
  rid: text('rid').notNull(),
  membership: text('membership'),
  viewPosition: text('view_position').notNull(),
  payload: text('payload'),
}, (t) => [index('idx_native_quote_source_rooms').on(t.rid)]);

/** Durable native send body; separate from Rocket.Chat's existing outbox. */
export const nativeOutboxQuotes = sqliteTable('native_outbox_quotes', {
  id: text('id').primaryKey(),
  rid: text('rid').notNull(),
  payload: text('payload').notNull(),
});

/** A newer live revision hides obsolete names until its full catalogue arrives. */
export const nativeEmojiCatalog = sqliteTable('native_emoji_catalog', {
  singleton: integer('singleton').primaryKey(),
  revision: text('revision').notNull(),
  payload: text('payload'),
});
