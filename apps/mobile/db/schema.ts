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

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Rocket.Chat room type: c=channel, p=private group, d=direct, l=livechat. */
export type RoomType = 'c' | 'p' | 'd' | 'l';

export const rooms = sqliteTable(
  'salons',
  {
    rid: text('rid').primaryKey(),
    type: text('type').$type<RoomType>().notNull(),
    /** `name` is the slug; `fname` the display name (may contain spaces). */
    name: text('nom'),
    displayName: text('nom_affiche'),
    /** End-to-end encrypted room: we do not write there, we do not show the preview. */
    encrypted: integer('chiffre', { mode: 'boolean' }).notNull().default(false),
    readOnly: integer('lecture_seule', { mode: 'boolean' }).notNull().default(false),
    /**
     * The OTHER participant of a two-person DM (from the Rooms document's
     * `uids`), for presence (8.4). An 8.5 DM rid is a RANDOM ObjectId, no
     * longer the concatenation of both uids; it cannot be derived.
     */
    dmOtherUid: text('dm_autre_uid'),
    /** Preview of the last message. `null` if the room is encrypted. */
    lastMessage: text('dernier_message'),
    /**
     * The last message's `t`, when it has one. Separates the TWO meanings of
     * `dernier_message IS NULL`: "this room no longer has a last message" (column
     * null as well) and "the last message has nothing to show", the exact shape
     * of a video call, whose content lives in `blocks`. Without it, a video call
     * lifted the room to the top of the list with an EMPTY preview line. Always
     * null for an encrypted room: its preview is computed locally
     * (`UPDATE_ENCRYPTED_PREVIEW`), not from `lastMessage`.
     */
    lastMessageType: text('dernier_message_type'),
    lastMessageTs: integer('horodatage_dernier_message'),
    /**
     * `avatarETag`: version of the room's photo. Without it, `/avatar/room/<rid>`
     * is a FROZEN URI that Android's image cache serves forever: the photo
     * changed server-side never appears. Injected as a query, it moves the URI
     * on every change (see `lib/upload.ts#urlAvatar`).
     */
    avatarEtag: text('avatar_etag'),
    updatedAt: integer('mis_a_jour_le').notNull().default(0),
  },
  (t) => [index('idx_salons_activite').on(t.lastMessageTs)],
);

/**
 * **Per-user** state of a room: unread, favourite, last read.
 * Distinct from the room itself, which all members share.
 */
export const subscriptions = sqliteTable('abonnements', {
  rid: text('rid').primaryKey(),
  /**
   * Server-side `_id` of the subscription. The catch-up's `remove[]` entries
   * carry ONLY it (projection `{_id, _deletedAt}`, checked on 8.5): without
   * this column, a room left elsewhere would stay listed forever.
   */
  subId: text('sub_id'),
  unread: integer('non_lus').notNull().default(0),
  mentions: integer('mentions').notNull().default(0),
  groupMentions: integer('mentions_groupe').notNull().default(0),
  alert: integer('alerte', { mode: 'boolean' }).notNull().default(false),
  open: integer('ouvert', { mode: 'boolean' }).notNull().default(true),
  favorite: integer('favori', { mode: 'boolean' }).notNull().default(false),
  /** `ls`: last read date, for the "new messages" bar. */
  lastSeen: integer('lu_jusqu_a'),
  /** `E2EKey`: the room's AES key RSA-encrypted for this member (E2EE, step 10). */
  e2eKey: text('e2e_key'),
  /** `e2eKeyId`: UUID of the room key, if the server provides it separately. */
  e2eKeyId: text('e2e_key_id'),
  /** `roles`: my roles IN this room (`owner`, `moderator`...), serialised; `null` if none. */
  roles: text('roles'),
  updatedAt: integer('mis_a_jour_le').notNull().default(0),
});

export const messages = sqliteTable(
  'messages',
  {
    /** Rocket.Chat `_id`. Generated client-side on send: it is the deduplication key. */
    id: text('id').primaryKey(),
    rid: text('rid').notNull(),
    /** `null` for an undecryptable encrypted message, or a system message. */
    text: text('texte'),
    ts: integer('horodatage').notNull(),
    authorId: text('auteur_id').notNull(),
    authorName: text('auteur_nom'),
    /** `t`: system message type (`uj`, `ul`, `rm`, `e2e`...). `null` = ordinary message. */
    systemType: text('type_systeme'),
    /** `tmid`: id of the root message, if this message is a thread reply. */
    threadId: text('fil_id'),
    /** `tcount`: number of replies, on the root message. */
    threadCount: integer('fil_reponses').notNull().default(0),
    /** `tlm`: timestamp of the last reply, carried by the root message. */
    threadLast: integer('fil_dernier'),
    /** `tshow`: thread reply to show ALSO in the room's main stream. */
    threadShown: integer('fil_affiche', { mode: 'boolean' }).notNull().default(false),
    editedAt: integer('modifie_le'),
    /** Markdown AST pre-parsed by the server (`md`), serialised. Absent from old messages. */
    md: text('md'),
    attachments: text('pieces_jointes'),
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
    callId: text('appel_id'),
    /**
     * `content` object of an encrypted message (`rc.v2.aes-sha2`), serialised,
     * kept for deferred decryption on E2EE unlock. `text` stays null while the
     * room is not unlocked. See `lib/e2e`.
     */
    encryptedRaw: text('chiffre_brut'),
    /** `pinned`. */
    pinned: integer('epingle', { mode: 'boolean' }).notNull().default(false),
    /** `starred` reduced to uids, serialised; `null` if nobody. See `lib/marks.ts`. */
    starred: text('etoiles'),
    updatedAt: integer('mis_a_jour_le').notNull().default(0),
  },
  // The index covers the room screen's query: `WHERE rid = ? ORDER BY horodatage DESC`.
  (t) => [index('idx_messages_salon_date').on(t.rid, t.ts), index('idx_messages_fil').on(t.threadId)],
);

/**
 * Status of an optimistic send. There is no "sent" state: on success (or as
 * soon as a server-origin copy arrives), the row is DELETED.
 */
export type OutboxStatus = 'en-attente' | 'echec';

/**
 * Persistent outbox. The message is shown immediately, then reconciled when
 * the server sends it back: the `_id` is generated client-side, and the
 * server never accepts two of them, so a resubmission after a crash creates
 * no duplicate. CAUTION: the replay answers 400, not an idempotent success
 * (see lib/outbox.ts).
 */
export const outbox = sqliteTable(
  'sortie',
  {
    id: text('id').primaryKey(),
    rid: text('rid').notNull(),
    text: text('texte').notNull(),
    threadId: text('fil_id'),
    status: text('statut').$type<OutboxStatus>().notNull().default('en-attente'),
    attempts: integer('tentatives').notNull().default(0),
    lastError: text('derniere_erreur'),
    createdAt: integer('cree_le').notNull(),
  },
  (t) => [index('idx_sortie_statut').on(t.status)],
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
 * `ClientRest` side, a network flap is enough) made everything start over at
 * the next connection setup: the bytes went out again, a second message was
 * posted, and the first file stayed orphaned on the server. Recorded as soon
 * as `rooms.media` returns, `file_id` skips the first step and lets us ask
 * SQLite, not the network, whether the message is already there.
 *
 * The three statuses:
 * - `en-attente`: the only one the automatic replay picks up;
 * - `envoi`: taken by a pass of THIS process. Excluded from listing, so
 *   never uploaded twice in parallel; re-armed at the first `process()` of
 *   the next process, otherwise a kill mid-upload would have frozen it
 *   there forever;
 * - `echec`: the server refused. NO LONGER replayed automatically: a refused
 *   video (413, type, quota) pushed all its bytes again on every return to
 *   the foreground. Only the "Retry" gesture re-arms it.
 */
export const uploads = sqliteTable(
  'televersements',
  {
    id: text('id').primaryKey(),
    rid: text('rid').notNull(),
    uri: text('uri').notNull(),
    name: text('nom').notNull(),
    type: text('type').notNull(),
    caption: text('legende'),
    status: text('statut')
      .$type<'en-attente' | 'envoi' | 'echec'>()
      .notNull()
      .default('en-attente'),
    lastError: text('derniere_erreur'),
    /** Returned by `rooms.media`. Non-null = the bytes are already on the server. */
    fileId: text('file_id'),
    createdAt: integer('cree_le').notNull(),
  },
  (t) => [index('idx_televersements_statut').on(t.status)],
);

/**
 * Composer drafts (8.7), per room (`rid`) or per thread (`rid:tmid`).
 * In SQLite rather than MMKV (a recorded deviation from the plan): the draft
 * is debounced, async latency is irrelevant, and one more NATIVE dependency,
 * hence a rebuild, is not justified against ROADMAP §4.2 when the database
 * already covers all local state.
 */
export const drafts = sqliteTable('brouillons', {
  /** `rid`, or `rid:tmid` for a reply in a thread. */
  key: text('cle').primaryKey(),
  text: text('texte').notNull(),
  updatedAt: integer('mis_a_jour_le').notNull(),
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
export const emojisCustom = sqliteTable('emojis_custom', {
  name: text('nom').primaryKey(),
  extension: text('extension').notNull(),
  /** JSON `string[]`. An alias serves the same image as its canonical name. */
  aliases: text('aliases').notNull().default('[]'),
  updatedAt: integer('mis_a_jour_le').notNull().default(0),
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
export const users = sqliteTable('utilisateurs', {
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
  /** `_updatedAt` of the message that set this username: "most recent wins" referee. */
  updatedAt: integer('mis_a_jour_le').notNull().default(0),
});

/**
 * Catch-up cursors, per room and per stream. `chat.syncMessages` handles one
 * room at a time and REST is rate-limited: only open or recently active
 * rooms are resynced (step 5.2).
 */
export const cursors = sqliteTable(
  'etat_synchro',
  {
    /** `rid`, or `*` for global cursors (`subscriptions.get?updatedSince`). */
    scope: text('portee').notNull(),
    stream: text('flux').notNull(),
    updatedSince: integer('mis_a_jour_depuis').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.stream] })],
);
