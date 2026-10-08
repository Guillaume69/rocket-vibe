/**
 * Idempotent upserts. **The SQL lives here, and nowhere else**: the tests run
 * it as is on an in-memory `node:sqlite`, so they exercise the query the app
 * will send, not a paraphrase.
 *
 * Two invariants, both necessary:
 *
 * 1. `ON CONFLICT DO UPDATE`: replaying an event creates no duplicate.
 *    The WebSocket and REST write the same row, and a catch-up will
 *    redeliver already known messages.
 * 2. `WHERE excluded.updated_at >= <table>.updated_at`: an **older**
 *    event does not overwrite a more recent state. Without it, a REST catch-up
 *    started after a reconnection could revive the version of a message
 *    edited since, or show again unread counts already reset.
 */

import type { LocalSubscription, LocalMessage, LocalRoom } from '../lib/normalize.ts';

export const UPSERT_MESSAGE = `
INSERT INTO messages (
  id, rid, text, ts, author_id, author_name, system_type,
  thread_id, thread_count, thread_last, thread_shown, edited_at, md,
  attachments, reactions, urls, call_id, encrypted_raw, pinned, starred, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  -- Encrypted message: keep the already decrypted plaintext if the resync
  -- arrives without a key (excluded.text null). Ordinary message: unchanged.
  text = CASE
    WHEN excluded.system_type = 'e2e' THEN COALESCE(excluded.text, messages.text)
    ELSE excluded.text
  END,
  ts = excluded.ts,
  author_name = excluded.author_name,
  system_type = excluded.system_type,
  thread_id = excluded.thread_id,
  thread_count = excluded.thread_count,
  thread_last = excluded.thread_last,
  thread_shown = excluded.thread_shown,
  edited_at = excluded.edited_at,
  md = excluded.md,
  -- An encrypted file's attachments live in its content: like the text,
  -- they only exist decrypted, and a resync without a key must not erase
  -- them.
  attachments = CASE
    WHEN excluded.system_type = 'e2e' THEN COALESCE(excluded.attachments, messages.attachments)
    ELSE excluded.attachments
  END,
  reactions = excluded.reactions,
  urls = excluded.urls,
  call_id = excluded.call_id,
  -- text already decrypted locally (COALESCE above): a resync of the same
  -- encrypted message must not erase the plaintext again (encrypted_raw kept).
  encrypted_raw = COALESCE(excluded.encrypted_raw, messages.encrypted_raw),
  pinned = excluded.pinned,
  starred = excluded.starred,
  updated_at = excluded.updated_at
WHERE excluded.updated_at >= messages.updated_at
`;

/**
 * `COALESCE` on the fields the server sometimes OMITS: a `rooms-changed`
 * event can carry a partial document (without `usernames`). `null` there
 * means "absent from the payload", never "erase"; without the COALESCE, such
 * a more recent event would erase a DM's derived name, and the list would
 * fall back to the raw `rid`.
 *
 * **`last_message` is the exception, deliberately**: its absence is
 * INFORMATION, not a gap. Probed on 8.5, `rooms-changed` and `rooms.get`
 * always carry `lastMessage` as soon as the room has one: rename, topic,
 * announcement, description, read-only, avatar, DMs included. The field only
 * disappears when the room no longer has a visible last message, that is,
 * when the last one was just deleted. The original COALESCE therefore froze
 * an emptied room's preview FOR LIFE: the deleted message stayed displayed
 * there, and no catch-up could dislodge it.
 *
 * An ENCRYPTED room is the only case where the server has nothing to say
 * about it (it only holds ciphertext): its preview comes from
 * `UPDATE_ENCRYPTED_PREVIEW`, on the locally decrypted messages. Hence the
 * `CASE`, which leaves it alone.
 */
export const UPSERT_ROOM = `
INSERT INTO rooms (
  rid, type, name, display_name, encrypted, read_only, dm_other_uid,
  last_message, last_message_type, last_message_ts, avatar_etag,
  updated_at, voice
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(rid) DO UPDATE SET
  type = excluded.type,
  name = COALESCE(excluded.name, rooms.name),
  display_name = COALESCE(excluded.display_name, rooms.display_name),
  encrypted = excluded.encrypted,
  read_only = excluded.read_only,
  voice = excluded.voice,
  dm_other_uid = COALESCE(excluded.dm_other_uid, rooms.dm_other_uid),
  last_message = CASE
    WHEN excluded.encrypted = 1 THEN rooms.last_message
    ELSE excluded.last_message
  END,
  -- No CASE here: toRoom already returns null for an encrypted room, and it is
  -- the RIGHT value: an encrypted room's preview does not come from lastMessage.
  -- Keeping the old type would make the local preview be described by the
  -- type of a message the server could not read.
  last_message_type = excluded.last_message_type,
  -- The timestamp keeps its COALESCE: it drives the list's SORT, and the
  -- server does NOT move it back when emptying a room (the lm field survives
  -- the deletion of the last message, checked). Erasing it would therefore
  -- drop the room to the end of the list with no event to justify it.
  last_message_ts = COALESCE(excluded.last_message_ts, rooms.last_message_ts),
  -- COALESCE here too, for a SPECIFIC reason: an etag overwritten with null
  -- would make the avatar URL fall back to its query-less form, the one the
  -- image cache already holds with the OLD photo. The updateAvatar stream is
  -- often fresher than the Rooms document that follows.
  avatar_etag = COALESCE(excluded.avatar_etag, rooms.avatar_etag),
  updated_at = excluded.updated_at
WHERE excluded.updated_at >= rooms.updated_at
`;

export const UPSERT_SUBSCRIPTION = `
INSERT INTO subscriptions (
  rid, sub_id, unread, mentions, group_mentions, alert, open, favorite,
  last_seen, e2e_key, e2e_key_id, roles, group_id, group_name, group_rank, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(rid) DO UPDATE SET
  sub_id = COALESCE(excluded.sub_id, subscriptions.sub_id),
  unread = excluded.unread,
  mentions = excluded.mentions,
  group_mentions = excluded.group_mentions,
  alert = excluded.alert,
  open = excluded.open,
  favorite = excluded.favorite,
  last_seen = excluded.last_seen,
  -- COALESCE: a partial subscription event (without E2EKey) must not erase
  -- the already known key.
  e2e_key = COALESCE(excluded.e2e_key, subscriptions.e2e_key),
  e2e_key_id = COALESCE(excluded.e2e_key_id, subscriptions.e2e_key_id),
  -- Same rule: a removed role leaves roles: [] ($pull), never a missing
  -- field, so absence says nothing.
  roles = COALESCE(excluded.roles, subscriptions.roles),
  group_id = excluded.group_id,
  group_name = excluded.group_name,
  group_rank = excluded.group_rank,
  updated_at = excluded.updated_at
WHERE excluded.updated_at >= subscriptions.updated_at
`;

/** Catch-up cursor. Never goes back: a regressing cursor downloads again. */
export const UPSERT_CURSOR = `
INSERT INTO cursors (scope, stream, updated_since) VALUES (?, ?, ?)
ON CONFLICT(scope, stream) DO UPDATE SET updated_since = excluded.updated_since
WHERE excluded.updated_since > cursors.updated_since
`;

/**
 * An author's identity (`uid -> current username`), derived from EVERY
 * ingested message. Two safeguards in the `WHERE`:
 *  - `updated_at >=`: an OLDER message does not downgrade a more recently
 *    observed username ("most recent wins").
 *  - `username IS NOT`: we write ONLY if the username REALLY changes. Without
 *    it, each message with the same username would touch the row and rerun
 *    the table's live query, hence re-render every visible row. This way,
 *    the table only moves on a REAL rename.
 */
export const UPSERT_USER = `
INSERT INTO users (uid, username, updated_at) VALUES (?, ?, ?)
ON CONFLICT(uid) DO UPDATE SET
  username = excluded.username,
  updated_at = excluded.updated_at
WHERE excluded.updated_at >= users.updated_at
  AND excluded.username IS NOT users.username
`;

/**
 * Identity from an AUTHORITATIVE source (`me` at connection setup,
 * `users.info` when a profile opens): current username AND avatar version,
 * per uid.
 *
 * Three deliberate differences from `UPSERT_USER`:
 *  - `updated_at` is neither read nor written: these responses do not all
 *    carry an `_updatedAt`, and arbitrating on the LOCAL clock would mix two
 *    times. The insert sets 0, the smallest, so a later message keeps the
 *    upper hand on the username;
 *  - `COALESCE` on the etag: `users.info` OMITS it when the user has no
 *    photo, which must not erase the one we know (see UPSERT_ROOM);
 *  - the `WHERE` only lets a REAL change through: without it, each profile
 *    opening would touch the table and re-render every row subscribed to
 *    `users`.
 */
export const UPSERT_IDENTITY = `
INSERT INTO users (uid, username, avatar_etag, updated_at) VALUES (?, ?, ?, 0)
ON CONFLICT(uid) DO UPDATE SET
  username = excluded.username,
  avatar_etag = COALESCE(excluded.avatar_etag, users.avatar_etag)
WHERE excluded.username IS NOT users.username
   OR COALESCE(excluded.avatar_etag, users.avatar_etag) IS NOT users.avatar_etag
`;

/**
 * Avatar version pushed by the `updateAvatar` stream, which names its target
 * by USERNAME (never by uid) for a user, by `rid` for a room. A user still
 * unknown locally touches no row: their avatar is shown nowhere, and the
 * first profile opened will set it.
 *
 * The etag is passed TWICE: the `IS NOT` guard avoids a useless write, hence
 * a rerun of every live query sitting on the table.
 */
export const UPDATE_USER_AVATAR = `
UPDATE users SET avatar_etag = ? WHERE username = ? AND avatar_etag IS NOT ?
`;

export const UPDATE_ROOM_AVATAR = `
UPDATE rooms SET avatar_etag = ? WHERE rid = ? AND avatar_etag IS NOT ?
`;

/** Known room keys, for the E2EE decryption pass on unlock. */
export const LIST_ROOM_KEYS = `SELECT rid, e2e_key FROM subscriptions WHERE e2e_key IS NOT NULL`;
/** Encrypted messages still unreadable: ciphertext kept, plaintext not yet set. */
export const MESSAGES_TO_DECRYPT = `SELECT id, rid, encrypted_raw FROM messages WHERE encrypted_raw IS NOT NULL AND text IS NULL`;
/** Sets a message's plaintext once decrypted, and a file's attachments. */
export const UPDATE_MESSAGE_TEXT = `UPDATE messages SET text = ?, attachments = COALESCE(?, attachments) WHERE id = ?`;
/**
 * Sets pinning and stars after a successful gesture (see `lib/marks.ts`).
 * `updated_at` does not advance: the server's next version wins.
 */
export const UPDATE_MESSAGE_MARKS = `UPDATE messages SET pinned = ?, starred = ? WHERE id = ?`;
/** Re-masks every encrypted message on lock: the local plaintext disappears,
 *  attachments included (they carry each file's key), the ciphertext
 *  (`encrypted_raw`) stays to decrypt again at the next unlock.
 *
 *  `text IS NOT NULL` is not cosmetic, as everywhere else here: a replayed
 *  lock (`e2eRelocked`) on ALREADY masked messages would touch the whole
 *  table without changing anything, and wake every live query sitting on
 *  it, hence re-render the open room. */
export const HIDE_ENCRYPTED_MESSAGES = `UPDATE messages SET text = NULL, attachments = NULL WHERE encrypted_raw IS NOT NULL AND text IS NOT NULL`;
/**
 * List preview for UNLOCKED encrypted rooms: the last decrypted message.
 * Without decryption, `last_message` stays null (the ciphertext is never
 * stored), so the list shows the placeholder.
 *
 * Replayed on every message DELETION (see `Store.deleteMessage`): in an
 * encrypted room, the server cannot tell which message is the new last one,
 * only the local database knows. Without this replay, deleting the last
 * message of an encrypted room left its text as the preview.
 *
 * The final `IS NOT` is not cosmetic: without it, the UPDATE would touch the
 * table on every deletion even when changing nothing, and rerun every live
 * query sitting on `rooms`. The subquery is therefore repeated: once to
 * write, once to decide whether there is anything to write.
 *
 * **It must point to the same message as the STREAM**, otherwise the preview
 * announces something not found when opening the room. Three clauses, copied
 * from the query in `app/room/[rid].tsx`:
 *  - `thread_id IS NULL OR thread_shown = 1`: a thread reply lives in its thread,
 *    not in the room, except `tshow`;
 *  - `system_type IS NULL OR system_type = 'e2e'`: the stream renders a
 *    system message via `systemText()` ("alice joined the room"), never its
 *    raw `text`, which for a `t: 'uj'` is ONLY the username. Using it as the
 *    preview therefore showed just "alice". It is exactly the `isOrdinary`
 *    predicate of `ui/messageRow.tsx`.
 *    ⚠️ Above all NOT `system_type IS NULL` alone: in an encrypted room, ALL
 *    messages carry `t: 'e2e'` (`lib/normalize.ts`); that filter would empty
 *    the preview of every encrypted room, which is the only thing this query
 *    exists to compute;
 *  - `id DESC` as secondary key: the stream had to add it to break ties
 *    between two messages in the same millisecond. Without it, the preview
 *    and the room's first row may point to two different messages.
 */
export const UPDATE_ENCRYPTED_PREVIEW = `
UPDATE rooms SET last_message = (
  SELECT text FROM messages
  WHERE messages.rid = rooms.rid AND messages.text IS NOT NULL
    AND (messages.thread_id IS NULL OR messages.thread_shown = 1)
    AND (messages.system_type IS NULL OR messages.system_type = 'e2e')
  ORDER BY messages.ts DESC, messages.id DESC LIMIT 1
) WHERE encrypted = 1 AND last_message IS NOT (
  SELECT text FROM messages
  WHERE messages.rid = rooms.rid AND messages.text IS NOT NULL
    AND (messages.thread_id IS NULL OR messages.thread_shown = 1)
    AND (messages.system_type IS NULL OR messages.system_type = 'e2e')
  ORDER BY messages.ts DESC, messages.id DESC LIMIT 1
)`;
/** On lock: the preview becomes the placeholder again (last_message null).
 *  Same guard as above, for the room list this time. */
export const HIDE_ENCRYPTED_PREVIEW = `UPDATE rooms SET last_message = NULL WHERE encrypted = 1 AND last_message IS NOT NULL`;

export const DELETE_MESSAGE = `DELETE FROM messages WHERE id = ?`;

/** Leaving a room: the catch-up (updatedSince's `remove[]`) cleans up. */
export const DELETE_ROOM = `DELETE FROM rooms WHERE rid = ?`;
export const DELETE_SUBSCRIPTION = `DELETE FROM subscriptions WHERE rid = ?`;
/** Subscription `remove[]` entries carry ONLY the subscription's `_id`. */
export const RID_BY_SUB_ID = `SELECT rid FROM subscriptions WHERE sub_id = ?`;

/**
 * A draft's `rid`: the key is `rid` or `rid:tmid` (thread). A Rocket.Chat rid
 * never contains `:`, so the split is unambiguous. `instr` returns 0 when
 * there is no separator, hence the `CASE`.
 */
const DRAFT_RID = `substr(key, 1, CASE WHEN instr(key, ':') = 0 THEN length(key) ELSE instr(key, ':') - 1 END)`;

/**
 * Every `rid` the database knows, whichever table carries it: the SNAPSHOT
 * the reconciliation must take BEFORE its network request.
 *
 * Why this snapshot: `purgeMissingRooms` receives the live list of a
 * `subscriptions.get` that took ~200 ms, during which the DDP stream kept
 * writing. A DM opened by a colleague in that interval is in NEITHER list:
 * not among the live ones (it did not exist when the server answered), not
 * among the known ones (it did not exist when the database was read). Purging
 * `NOT IN (live)` erased it; purging `IN (known) AND NOT IN (live)` spares it.
 * The ORDER of the two reads carries the correctness, no delay does.
 *
 * The union covers ALL tables with a rid, not only the room's three: an
 * orphaned outbox row (left by a purge from before this fix) has no row
 * anywhere else, and so would never be picked up by a purge limited to known
 * rooms. `cursors` enters without its global cursors (`scope = '*'`), which
 * are not rids.
 */
export const LIST_KNOWN_RIDS = `
SELECT rid FROM rooms
UNION SELECT rid FROM subscriptions
UNION SELECT rid FROM messages
UNION SELECT rid FROM outbox
UNION SELECT rid FROM uploads
UNION SELECT scope FROM cursors WHERE scope <> '*'
UNION SELECT ${DRAFT_RID} FROM drafts
`;

/**
 * Anti-ghost reconciliation: erases everything whose `rid` was known at the
 * start and is NO LONGER in the server's live list. `json_each` unpacks a
 * JSON array of N rids passed as ONE parameter: the SQL stays static (tested
 * as is) whatever N. Parameter order: **known, then live**, everywhere.
 *
 * The caller GUARANTEES a non-empty live list: `NOT IN (nothing)` would erase
 * everything known.
 *
 * We purge the SEVEN tables tied to the room, not three. The other four
 * never went away: an invisible draft, a cursor outliving the messages it
 * describes (which `UPSERT_CURSOR` then forbids correcting, since it refuses
 * any regression), and above all an `outbox` or `uploads` row that no screen
 * can show anymore, so no "discard" button either, but that the replay
 * pushes again at EVERY connection setup, forever, delaying legitimate sends
 * behind it.
 */
export const PURGE_MISSING_ROOMS = `DELETE FROM rooms WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGE_MISSING_SUBSCRIPTIONS = `DELETE FROM subscriptions WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGE_MISSING_MESSAGES = `DELETE FROM messages WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGE_MISSING_OUTBOX = `DELETE FROM outbox WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGE_MISSING_UPLOADS = `DELETE FROM uploads WHERE rid IN (SELECT value FROM json_each(?)) AND rid NOT IN (SELECT value FROM json_each(?))`;
export const PURGE_MISSING_DRAFTS = `DELETE FROM drafts WHERE ${DRAFT_RID} IN (SELECT value FROM json_each(?)) AND ${DRAFT_RID} NOT IN (SELECT value FROM json_each(?))`;
/**
 * `scope <> '*'` is ESSENTIAL: the global cursors (`rooms`,
 * `subscriptions`) are not rids and must never go; losing them would restart a
 * full catch-up at every reconciliation.
 */
export const PURGE_MISSING_CURSORS = `DELETE FROM cursors WHERE scope <> '*' AND scope IN (SELECT value FROM json_each(?)) AND scope NOT IN (SELECT value FROM json_each(?))`;

/**
 * Leaving a room, immediately: what the purge would do later, but right away
 * and for a single rid. Without these, an `outbox` row left by a room that
 * was left costs two REST calls per connection setup (`chat.sendMessage` then
 * the `chat.getMessage` of `messageDelivered`) until the next reconciliation,
 * which only happens ONCE per session.
 */
export const DELETE_ROOM_OUTBOX = `DELETE FROM outbox WHERE rid = ?`;
export const DELETE_ROOM_UPLOADS = `DELETE FROM uploads WHERE rid = ?`;
export const DELETE_ROOM_DRAFTS = `DELETE FROM drafts WHERE ${DRAFT_RID} = ?`;
export const DELETE_ROOM_CURSORS = `DELETE FROM cursors WHERE scope = ?`;

/**
 * Retention: per room, keep only the N most RECENT messages.
 *
 * Without it, `messages` never stops growing for a live room, and it is not
 * just text: `md`, `attachments`, `reactions` and `urls` are JSON blobs
 * often heavier than the message itself. The user's only recourse on Android
 * is "clear data", which destroys everything, drafts and outbox included.
 *
 * Two exemptions, both necessary:
 *
 * - **optimistic ones** (`updated_at = 0`): they only exist locally, the
 *   server will not return them. They are outside the ranking, so they do
 *   not consume the quota either.
 * - **thread roots still referenced**: erasing the root would leave replies
 *   attached to a message that cannot be found, and the thread screen would
 *   no longer know what to show at the top.
 *
 * Cut by `ts` and not by `updated_at`: we want the MESSAGE's age,
 * not that of its last edit. `id` breaks ties so the cut is deterministic. No
 * need to re-anchor the catch-up cursor: we only cut from the bottom, and the
 * app knows how to download its pagination again.
 */
export const APPLY_RETENTION = `
DELETE FROM messages WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY rid ORDER BY ts DESC, id DESC) AS rang
    FROM messages WHERE updated_at <> 0
  ) WHERE rang > ?
) AND id NOT IN (SELECT thread_id FROM messages WHERE thread_id IS NOT NULL)
`;

export const READ_CURSOR = `
SELECT updated_since FROM cursors WHERE scope = ? AND stream = ?
`;

/**
 * Composer draft, per `rid` or `rid:tmid`. No freshness guard here, unlike
 * the upserts coming from the network: the only source is the user's typing,
 * debounced, and the latest always wins.
 */
export const UPSERT_DRAFT = `
INSERT INTO drafts (key, text, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
`;
export const DELETE_DRAFT = `DELETE FROM drafts WHERE key = ?`;
export const READ_DRAFT = `SELECT text FROM drafts WHERE key = ?`;

/**
 * One more use of a reaction emoji (`lib/emojiUsage.ts`): `[code, now]`. The
 * latest use never moves back (a clock set back must not demote it).
 */
export const RECORD_EMOJI_USE = `
INSERT INTO emoji_usage (code, count, last_used) VALUES (?, 1, ?)
ON CONFLICT(code) DO UPDATE SET
  count = emoji_usage.count + 1,
  last_used = MAX(emoji_usage.last_used, excluded.last_used)
`;
/**
 * Keeps the code just used (`[code, code, KEPT_CODES - 1]`) and the best
 * others, by the ranking of `topEmojis`, so the table stays small however
 * many emoji are tried once, and a new emoji always stays to grow past the
 * established ones: the lowest-ranked OTHER code makes room.
 */
export const PRUNE_EMOJI_USAGE = `
DELETE FROM emoji_usage WHERE code <> ? AND code NOT IN (
  SELECT code FROM emoji_usage WHERE code <> ? ORDER BY count DESC, last_used DESC, code LIMIT ?
)
`;
export const LIST_EMOJI_USAGE = `SELECT code, count, last_used AS lastUsed FROM emoji_usage`;

/**
 * The largest `_updatedAt` already ingested for a room: used to RE-ANCHOR the
 * catch-up cursor when `chat.syncMessages` fails on too large a backlog (the
 * 8.5 server does not bound the query, it times out), so as not to keep
 * asking for the same abyss forever. `MAX(NULL)` of an empty table returns
 * `NULL` -> `null` on the caller's side.
 */
export const LAST_MESSAGE_UPDATED_AT = `
SELECT MAX(updated_at) AS updated_at FROM messages WHERE rid = ?
`;

// ---------------------------------------------------------------------------
// Custom emojis. Reference table, replaced AS A WHOLE on catch-up (full
// `emoji-custom.list`): a `DELETE` then `INSERT`s, in one transaction, rather
// than an upsert that would leave emojis removed server-side lingering as
// clickable ghosts.
// ---------------------------------------------------------------------------

export const CLEAR_CUSTOM_EMOJIS = `DELETE FROM custom_emojis`;

export const INSERT_CUSTOM_EMOJI = `
INSERT INTO custom_emojis (name, extension, aliases, uri, updated_at) VALUES (?, ?, ?, ?, ?)
`;

export const LIST_CUSTOM_EMOJIS = `
SELECT name, extension, aliases, uri FROM custom_emojis
`;

export function customEmojiParams(e: {
  name: string;
  extension: string;
  aliases: string[];
  uri?: string;
  updatedAt: number;
}): SqlParam[] {
  return [e.name, e.extension, JSON.stringify(e.aliases), e.uri ?? null, e.updatedAt];
}

// ---------------------------------------------------------------------------
// Outbox. The `id` is the 24-hex `_id` generated CLIENT-SIDE: the server
// deduplicates on it, which is what makes replay after a crash safe.
// ---------------------------------------------------------------------------

export const INSERT_OUTBOX = `
INSERT INTO outbox (id, rid, text, thread_id, status, attempts, last_error, created_at)
VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?)
`;

/** Failures too: the replay when the network returns retries everything left. */
/** Is the room encrypted? Decides a message's send path. */
export const ROOM_ENCRYPTED = `SELECT encrypted FROM rooms WHERE rid = ?`;

export const LIST_OUTBOX_TO_SEND = `
SELECT id, rid, text, thread_id, status, attempts FROM outbox
WHERE status IN ('pending', 'failed') ORDER BY created_at
`;

export const MARK_OUTBOX_FAILED = `
UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ?
WHERE id = ?
`;

export const DELETE_OUTBOX = `DELETE FROM outbox WHERE id = ?`;

/**
 * Discarding a send: only a message STILL optimistic (`updated_at = 0`) is
 * erased; if a server version exists, the message was delivered and there is
 * nothing left to discard.
 */
export const DELETE_OPTIMISTIC_MESSAGE = `
DELETE FROM messages WHERE id = ? AND updated_at = 0
`;

// ---------------------------------------------------------------------------
// Upload queue (7.2), same rules as the text outbox.
// ---------------------------------------------------------------------------

export const INSERT_UPLOAD = `
INSERT INTO uploads (id, rid, uri, name, type, caption, status, last_error, file_id, created_at, tmid)
VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
`;

/**
 * **`pending` ONLY.** Failures used to be replayed here, and `process()` is
 * called at every connection setup: a video the server refuses (413, type not
 * whitelisted, quota) therefore pushed all its bytes again on every network
 * flap, a frequent case on Android, where `fileSize` is often null and lets
 * local validation through. A failure is now a terminus: only the "Retry"
 * gesture re-arms it (`REARM_UPLOAD`). A ceiling, not a delay.
 *
 * `sending` is excluded for another reason: the row is already taken by a pass
 * in flight, listing it again would upload it twice in parallel.
 */
export const LIST_UPLOADS_TO_SEND = `
SELECT id, rid, uri, name, type, caption, tmid, status, file_id FROM uploads
WHERE status = 'pending' ORDER BY created_at, id
`;

/**
 * Claiming. The `AND status = 'pending'` guard makes the operation atomic:
 * two concurrent passes cannot grab the same row, the second updates 0 rows
 * and moves on.
 */
export const MARK_UPLOAD_IN_FLIGHT = `
UPDATE uploads SET status = 'sending' WHERE id = ? AND status = 'pending'
`;

/**
 * Re-arming ONE row: the banner's "Retry" gesture. Clears the previous
 * failure's reason: keeping it would show a stale error during the new
 * attempt.
 */
export const REARM_UPLOAD = `
UPDATE uploads SET status = 'pending', last_error = NULL WHERE id = ?
`;

/**
 * Resume after a kill. A lingering `sending` is the orphan of a previous run,
 * killed mid-upload (Android kills a background app without warning).
 * Without this re-arming, the row would stay out of the listing forever: the
 * file would never go and nothing would say so.
 *
 * **The bound is not decorative.** "Orphan" is NOT inferred from the status
 * alone: `SyncProvider` rebuilds its file engine when the `session` object
 * changes (a mere rename is enough), without ever stopping the previous one,
 * and both write to the same SQLite connection, memoised by file name. A
 * blind re-arm would hand back to the replay a row whose bytes the old
 * engine is still pushing: two uploads, two confirms, two messages. So we
 * exclude what THIS runtime has in flight, the same discipline as workstream
 * 6's purge, bounded by a snapshot rather than a delay.
 */
export const REARM_IN_FLIGHT_UPLOADS = `
UPDATE uploads SET status = 'pending'
WHERE status = 'sending' AND id NOT IN (SELECT value FROM json_each(?))
`;

/** The bytes are on the server: `rooms.media` returned this `fileId`. */
export const RECORD_FILE_ID = `UPDATE uploads SET file_id = ? WHERE id = ?`;

/**
 * "Has this file ALREADY been posted?", asked of SQLite, never of the network.
 *
 * The case: `rooms.media` succeeded, `rooms.mediaConfirm` created the
 * message, but its response was lost. The message exists server-side and the
 * DDP stream delivered it like any other; confirming again would post a
 * DUPLICATE. The `fileId` shows up in the attachment's `title_link`
 * (`/file-upload/<fileId>/<name>`), hence in the `attachments` column.
 *
 * Local, hence immune to the 10 calls/min REST limit; querying it through
 * `chat.getMessage` would have consumed the quota at the worst moment, when
 * a whole queue is being replayed.
 */
export const MESSAGE_WITH_FILE = `
SELECT id FROM messages WHERE rid = ? AND attachments LIKE '%' || ? || '%' LIMIT 1
`;

export const MARK_UPLOAD_FAILED = `
UPDATE uploads SET status = 'failed', last_error = ? WHERE id = ?
`;

export const DELETE_UPLOAD = `DELETE FROM uploads WHERE id = ?`;

// ---------------------------------------------------------------------------
// Parameter builders. They live here, next to the SQL: a column order cannot
// drift from the value order without the tests seeing it, since the app and
// the tests call the same functions.
// ---------------------------------------------------------------------------

/** SQLite has no boolean: `false` must become `0`, never `'false'`. */
const b = (v: boolean): number => (v ? 1 : 0);

export type SqlParam = string | number | null;

export function userParams(u: {
  uid: string;
  username: string;
  updatedAt: number;
}): SqlParam[] {
  return [u.uid, u.username, u.updatedAt];
}

export function identityParams(i: {
  uid: string;
  username: string;
  avatarEtag: string | null;
}): SqlParam[] {
  return [i.uid, i.username, i.avatarEtag];
}

export function messageParams(m: LocalMessage): SqlParam[] {
  return [
    m.id,
    m.rid,
    m.text,
    m.ts,
    m.authorId,
    m.authorName,
    m.systemType,
    m.threadId,
    m.threadCount,
    m.threadLast,
    b(m.threadShown),
    m.editedAt,
    m.md,
    m.attachments,
    m.reactions,
    m.urls,
    m.callId,
    m.encryptedRaw,
    b(m.pinned),
    m.starred,
    m.updatedAt,
  ];
}

export function roomParams(s: LocalRoom): SqlParam[] {
  return [
    s.rid,
    s.type,
    s.name,
    s.displayName,
    b(s.encrypted),
    b(s.readOnly),
    s.dmOtherUid,
    s.lastMessage,
    s.lastMessageType,
    s.lastMessageTs,
    s.avatarEtag,
    s.updatedAt,
    b(s.voice ?? false),
  ];
}

export function subscriptionParams(a: LocalSubscription): SqlParam[] {
  return [
    a.rid,
    a.subId,
    a.unread,
    a.mentions,
    a.groupMentions,
    b(a.alert),
    b(a.open),
    b(a.favorite),
    a.lastSeen,
    a.e2eKey,
    a.e2eKeyId,
    a.roles,
    a.groupId,
    a.groupName,
    a.groupRank,
    a.updatedAt,
  ];
}
