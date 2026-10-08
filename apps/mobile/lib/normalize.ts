/**
 * Translates Rocket.Chat payloads into local rows.
 *
 * Pure module: no network, no database. The server's quirks are gathered
 * here so they do not spread anywhere else.
 */

import { starredIds } from './marks.ts';

/** The server sends either `{"$date": epochMs}` (EJSON) or an ISO string. */
export function toEpoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'object' && value !== null) {
    const raw = (value as { $date?: unknown }).$date;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const t = Date.parse(raw);
      return Number.isNaN(t) ? null : t;
    }
  }
  return null;
}

export type LocalMessage = {
  id: string;
  rid: string;
  text: string | null;
  ts: number;
  authorId: string;
  authorName: string | null;
  systemType: string | null;
  threadId: string | null;
  threadCount: number;
  threadLast: number | null;
  threadShown: boolean;
  editedAt: number | null;
  md: string | null;
  attachments: string | null;
  reactions: string | null;
  /** Link metadata parsed by the server (`urls`), serialized. */
  urls: string | null;
  /** `callId` of a call message (`t: 'videoconf'`), taken from its block. */
  callId: string | null;
  /**
   * `content` object of an encrypted message (`rc.v2.aes-sha2`), serialized.
   * KEPT, unlike the rest where the encrypted blob is dropped, so it can be
   * decrypted LATER, on unlock (E2EE, step 10). `null` outside an encrypted
   * message, or for legacy `rc.v1` encryption (in `msg`, unsupported). This is
   * not plaintext: nothing to display as is.
   */
  encryptedRaw: string | null;
  pinned: boolean;
  /** Uids that starred the message, serialized (`lib/marks.ts`). */
  starred: string | null;
  updatedAt: number;
  /**
   * The author is a bot account (RocketVibe only, RFC 0003). Not written by
   * the shared upsert: the native store sets the column itself.
   */
  authorBot?: boolean;
  /**
   * A workflow's form (RocketVibe only, RFC 0004), `Message.form` as JSON.
   * Like `authorBot`, set by the native store itself, never the shared upsert.
   */
  form?: string | null;
};

export type LocalRoom = {
  rid: string;
  type: string;
  name: string | null;
  displayName: string | null;
  encrypted: boolean;
  readOnly: boolean;
  /** A RocketVibe voice channel; Rocket.Chat rooms never are. */
  voice?: boolean;
  /** The other participant of a two-person DM, see `toRoom`. */
  dmOtherUid: string | null;
  /**
   * Their USERNAME. **Carried, not stored in `rooms`**: the store uses it to
   * record the other user in `users` (uid <-> username). Without that row the
   * `updateAvatar` event, which names the user ONLY by username, finds nothing
   * to update and the DM avatar stays frozen: the room list shows people none
   * of whose messages were ingested.
   */
  dmOtherUsername: string | null;
  lastMessage: string | null;
  /**
   * The `t` of the last message: what tells "room emptied" from "last message
   * with no text to show". See `db/schema.ts` and `lastMessagePreview`.
   */
  lastMessageType: string | null;
  lastMessageTs: number | null;
  /** `avatarETag`: version of the room photo, cache-buster for its URL. */
  avatarEtag: string | null;
  updatedAt: number;
};

export type LocalSubscription = {
  rid: string;
  /** Subscription `_id`, the only key the catch-up `remove[]` entries carry. */
  subId: string | null;
  unread: number;
  mentions: number;
  groupMentions: number;
  alert: boolean;
  open: boolean;
  favorite: boolean;
  lastSeen: number | null;
  /** `E2EKey`: the room AES key, RSA-encrypted for this member (keyID + base64). */
  e2eKey: string | null;
  /** `e2eKeyId`: UUID of the room key, when the server provides it separately. */
  e2eKeyId: string | null;
  /** My roles in the room, serialized; `null` if the document carries none. */
  roles: string | null;
  groupId: string | null;
  groupName: string | null;
  groupRank: number | null;
  updatedAt: number;
};

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const asInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const boolean = (v: unknown): boolean => v === true;
const jsonOrNull = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);

/** An encrypted message cannot be decrypted here: the blob is never exposed. */
export const ENCRYPTED_TYPE = 'e2e';

/** System type of a Rocket.Chat video conference message. */
export const CALL_TYPE = 'videoconf';

/**
 * The call message carries its `callId` in a `video_conf` block (`appId:
 * 'videoconf-core'`), NOT in its `_id`: the two differ (checked in the RC
 * source). The first block of that type is taken; the other `blocks` (generic
 * UI kit) are of no use and are not kept.
 */
function blockCallId(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b !== null && typeof b === 'object') {
      const block = b as { type?: unknown; callId?: unknown };
      if (block.type === 'video_conf') return asString(block.callId);
    }
  }
  return null;
}

export function toMessage(raw: Record<string, unknown>): LocalMessage | null {
  const id = asString(raw._id);
  const rid = asString(raw.rid);
  const ts = toEpoch(raw.ts);
  const author = raw.u as { _id?: unknown; username?: unknown } | undefined;
  const authorId = asString(author?._id);
  if (id === null || rid === null || ts === null || authorId === null) return null;

  const systemType = asString(raw.t);
  // The `msg` of an encrypted message holds opaque base64. Storing it would
  // invite displaying it by accident one day.
  const encrypted = systemType === ENCRYPTED_TYPE;

  return {
    id,
    rid,
    text: encrypted ? null : asString(raw.msg),
    ts,
    authorId,
    authorName: asString(author?.username),
    systemType,
    threadId: asString(raw.tmid),
    threadCount: asInt(raw.tcount),
    threadLast: toEpoch(raw.tlm),
    threadShown: boolean(raw.tshow),
    editedAt: toEpoch(raw.editedAt),
    md: encrypted ? null : jsonOrNull(raw.md),
    attachments: encrypted ? null : jsonOrNull(raw.attachments),
    reactions: jsonOrNull(raw.reactions),
    // Nothing to preview in an encrypted room; otherwise `urls` is kept raw,
    // parsed at render time (`lib/linkPreview.ts`).
    urls: encrypted ? null : jsonOrNull(raw.urls),
    callId: systemType === CALL_TYPE ? blockCallId(raw.blocks) : null,
    // The encrypted `content` is kept for deferred decryption; the opaque `msg`
    // never is (see `text`).
    encryptedRaw: encrypted ? jsonOrNull(raw.content) : null,
    pinned: boolean(raw.pinned),
    starred: starredIds(raw.starred),
    // `_updatedAt` is the server clock: it settles conflicts between the
    // WebSocket and a slower REST catch-up.
    updatedAt: toEpoch(raw._updatedAt) ?? ts,
  };
}

/**
 * The preview text of a `lastMessage`, for the room list.
 *
 * A message that is ONLY an attachment has `msg: ''` (probed on 8.5, stream
 * and `rooms.get` alike). Returning `null` there kept the preview of the
 * PREVIOUS message: the list showed an exchange that was no longer the last.
 * So it falls back on what the server can say about the file: its caption
 * (`description`), else its name (`title`).
 *
 * A `null` coming OUT of here means "this message has nothing to show", which
 * is NOT the same as "this room no longer has a last message": since
 * `last_message` is no longer COALESCEd, both clear the row. `lastMessageType`
 * tells them apart: set in the first case, null in the second. The concrete
 * case is the video call message (`t: 'videoconf'`, `msg: ''`, content in
 * `blocks`), which brought the room to the top of the list with an empty
 * preview.
 */
function lastMessagePreview(last: Record<string, unknown> | undefined): string | null {
  const text = asString(last?.msg);
  if (text !== null) return text;
  if (!Array.isArray(last?.attachments)) return null;
  for (const attachment of last.attachments) {
    if (attachment === null || typeof attachment !== 'object') continue;
    const j = attachment as { description?: unknown; title?: unknown };
    const label = asString(j.description) ?? asString(j.title);
    if (label !== null) return label;
  }
  return null;
}

/**
 * @param me username of the current account. A direct message has neither
 * `name` nor `fname` in `rooms.get`: its display name derives from
 * `usernames`, excluding oneself. Without `me` the DM would stay nameless.
 * @param myUid uid of the current account, to pick the OTHER participant of
 * a DM from `uids` (presence, 8.4). `uids` and `usernames` are NOT aligned
 * with each other (checked on 8.5): only filtering by uid is safe.
 */
export function toRoom(
  raw: Record<string, unknown>,
  me?: string | null,
  myUid?: string | null,
): LocalRoom | null {
  const rid = asString(raw._id);
  const type = asString(raw.t);
  if (rid === null || type === null) return null;

  const encrypted = boolean(raw.encrypted);
  const last = raw.lastMessage as Record<string, unknown> | undefined;

  // `me` is FROZEN when the translator is built (`session.username`): after a
  // rename from the web, or for a session with an empty username
  // (`lib/auth.ts`), it is no longer in `usernames`. Excluding oneself "by
  // difference" without checking then keeps the FIRST name that comes, mine
  // half the time. So oneself is excluded only when the exclusion is proven.
  const dmNames = Array.isArray(raw.usernames)
    ? raw.usernames.filter((u): u is string => typeof u === 'string' && u !== '')
    : [];
  const iAmIn = typeof me === 'string' && me !== '' && dmNames.includes(me);

  let displayName = asString(raw.fname) ?? asString(raw.name);
  if (displayName === null && type === 'd' && Array.isArray(raw.usernames)) {
    // Without a proven exclusion there is nothing better than the whole list:
    // one name too many beats a correspondent shown under my username.
    const others = iAmIn ? dmNames.filter((u) => u !== me) : dmNames;
    // A DM with oneself has `usernames: [me]`: `others` is empty, keep me.
    displayName = others.length > 0 ? others.join(', ') : (me ?? null);
  }

  let dmOtherUid: string | null = null;
  if (type === 'd' && typeof myUid === 'string' && Array.isArray(raw.uids)) {
    const uids = raw.uids.filter((u): u is string => typeof u === 'string' && u !== '');
    // Two people only: a group DM has no SINGLE presence to show.
    if (uids.length <= 2 && uids.includes(myUid)) {
      dmOtherUid = uids.find((u) => u !== myUid) ?? myUid;
    }
  }

  // The other user's USERNAME, matched in the same place and by the same rule
  // as their uid ("whichever of the two is not me"), and above all NOT by
  // index: the two arrays are not aligned. It is not derived from
  // `displayName`, which can be a real name (`fname`) when the server sets one.
  //
  // It goes to the database under the other user's uid (`UPSERT_IDENTITY`,
  // with no timestamp guard): a mistake pins MY username, and so my avatar, on
  // Bob until he posts. Better to say nothing: `UPSERT_ROOM` writes nothing on
  // a `null`, and the other user's first message will set it.
  let dmOtherUsername: string | null = null;
  if (dmOtherUid !== null && dmNames.length <= 2) {
    if (dmNames.length === 1) dmOtherUsername = dmNames[0]!;
    else if (iAmIn) dmOtherUsername = dmNames.find((u) => u !== me) ?? null;
  }

  return {
    rid,
    type,
    name: asString(raw.name),
    displayName,
    encrypted,
    readOnly: boolean(raw.ro),
    dmOtherUid,
    dmOtherUsername,
    // The preview of an encrypted room is ciphertext: never displayed. Its
    // preview is set locally after decryption (`UPDATE_ENCRYPTED_PREVIEW`),
    // hence the `null` here, which the UPSERT knows not to take as a clear.
    //
    // Elsewhere `null` DOES mean "no last message any more": when a room's last
    // message is deleted, the Room document loses its `lastMessage` entirely
    // (probed on 8.5, stream AND `rooms.get`). It is the only way to learn that
    // a room was emptied.
    lastMessage: encrypted ? null : lastMessagePreview(last),
    // Null for an encrypted room, like the preview: there the local database
    // picks the last message (`UPDATE_ENCRYPTED_PREVIEW`) and skips system
    // messages; keeping the server's `t` would describe one message by the
    // type of ANOTHER.
    lastMessageType: encrypted ? null : asString(last?.t),
    lastMessageTs: toEpoch(last?.ts) ?? toEpoch(raw.lm),
    // Absent while the room has no photo, and absent from partial documents:
    // `null` means "nothing to say", never "clear" (the COALESCE in
    // `UPSERT_ROOM` guarantees it).
    avatarEtag: asString(raw.avatarETag),
    updatedAt: toEpoch(raw._updatedAt) ?? 0,
  };
}

export function toSubscription(raw: Record<string, unknown>): LocalSubscription | null {
  const rid = asString(raw.rid);
  if (rid === null) return null;
  return {
    rid,
    subId: asString(raw._id),
    unread: asInt(raw.unread),
    mentions: asInt(raw.userMentions),
    groupMentions: asInt(raw.groupMentions),
    alert: boolean(raw.alert),
    open: boolean(raw.open),
    favorite: boolean(raw.f),
    lastSeen: toEpoch(raw.ls),
    e2eKey: asString(raw.E2EKey),
    e2eKeyId: asString(raw.e2eKeyId),
    roles: Array.isArray(raw.roles)
      ? JSON.stringify(raw.roles.filter((r): r is string => typeof r === 'string'))
      : null,
    groupId: null,
    groupName: null,
    groupRank: null,
    updatedAt: toEpoch(raw._updatedAt) ?? 0,
  };
}
