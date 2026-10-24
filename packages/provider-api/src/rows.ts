export type LocalMessage = {
  id: string;
  rid: string;
  text: string | null;
  ts: number;
  authorId: string;
  authorName: string | null;
  /**
   * `u.name`, the author's real name: not stored on the message, it feeds
   * `users.name` (shown when the server's `UI_Use_Real_Name` is on).
   */
  authorRealName?: string | null;
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
  /**
   * A thread root's followers (`replies`), serialized uids (`lib/marks.ts`).
   * Rocket.Chat only; absent means none, like on the other servers.
   */
  threadFollowers?: string | null;
  /**
   * A `discussion-created` message: the discussion's room (`drid`), its
   * message count (`dcount`) and last message time (`dlm`). Rocket.Chat only.
   */
  discussionId?: string | null;
  discussionCount?: number;
  discussionLast?: number | null;
  updatedAt: number;
  /** The author is a bot account (Vibez), a Rocket.Chat integration or a Mattermost webhook or bot. */
  authorBot?: boolean;
  /** An integration's chosen author name (Rocket.Chat `alias`, Mattermost webhook), shown instead of the poster's. */
  authorAlias?: string | null;
  /** Its chosen picture, an absolute http(s) URL. */
  authorAvatar?: string | null;
  /**
   * A workflow's form (Vibez only, RFC 0004), `Message.form` as JSON.
   * Set by the native store itself, never the shared upsert.
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
  /** A Vibez voice channel; Rocket.Chat rooms never are. */
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
  /** The last message is not known (Mattermost: no preview fetched): the stored one stays. */
  keepPreview?: boolean;
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
  /** Rocket.Chat two-person DM: the other person's real name (`fname`), for `users.name`. */
  dmName?: string | null;
  /**
   * The room's own push choice (`mobilePushNotifications` set for this room),
   * `null` when it follows the account. Rocket.Chat only.
   */
  pushPreference?: RoomNotificationLevel | null;
  updatedAt: number;
};

/** A room's own notification choice; `default` follows the account's. */
export type RoomNotificationLevel = 'all' | 'mentions' | 'nothing';
