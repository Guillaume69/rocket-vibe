# Mattermost and kChat: the protocol the apps speak

What a client of a Mattermost server (or of kChat, Infomaniak's Mattermost) must
do, as the three apps do it. Enough to write another implementation, or to check
ours against a server, without reading either.

Provenance of each fact:

- **[probed]**: observed on the bench, `mattermost-preview` 11.11.1
  (`docker/compose.mattermost.yml`, seeded by `scripts/seed-mattermost.mjs`, see
  [DEV.md](DEV.md#mattermost-development-server)).
- **[kChat]**: observed on a real kChat account (server 10.5.0, 2026-10-08),
  with an Infomaniak API token.
- **[kChat src]**: read in Infomaniak's open-source clients
  (`Infomaniak/mobile-kchat`, `webapp-kChat`) and not yet run: today only the
  OAuth sign-in.
- **[doc]**: Mattermost's public API reference, not contradicted by the bench.

Implementations: mobile `apps/mobile/providers/mattermost/`, desktop
`apps/desktop/crates/rv-core/src/mattermost/`. Behaviour is described per app in
[brain/features/mattermost-and-kchat.md](../brain/features/mattermost-and-kchat.md).

## 1. Detection

| Check | Means |
|---|---|
| Host is `kchat.infomaniak.com` or ends with `.kchat.infomaniak.com` | kChat; no probe needed |
| `GET /api/v4/system/ping` (anonymous) answers 2xx with `{"status":"OK"}` | Mattermost. Version in the `X-Version-Id` header, first three dot fields |
| Anything else (404, HTML, timeout) | Not Mattermost |

In automatic mode the apps try, in order: kChat host, RocketVibe discovery
(`/.well-known/rocketvibe`), the Mattermost ping, then Rocket.Chat
(`/api/info`). A forced server type probes only that type. Probe timeout: 10 s.

## 2. REST conventions

- Base: `<server>/api/v4`. JSON bodies, `Accept: application/json`.
- **Authentication: `Authorization: Bearer <token>` only.** [probed]
  - A token in the URL (`?access_token=`) answers **401**.
  - The `MMAUTHTOKEN` cookie **wins over the bearer**: with both, a `POST`
    without `X-CSRF-Token` answers 401 `api.context.session_expired.app_error`
    and the server clears the cookie, indistinguishable from a real expiry. A
    client must therefore never let that cookie be set (see 3.1).
- **Error envelope:** `{"id": "<translation key>", "message": "...", "status_code": n, "request_id": "..."}`.
  A status is believed only when the body has `id` and `status_code`; a proxy's
  401 or HTML page is a network failure, never a session expiry.
- **kChat's errors are different** [kChat]: validation errors are
  `{"id", "message", "errors": {field: [...]}, "request_id"}` (Laravel style,
  messages in French), and a revoked or wrong token answers
  **`401 {"message": "Unauthorized"}`**, a 404 `{"message": "The route ... could
  not be found."}`, neither with `id`. On a kChat account a JSON body with a
  `message` is enough to believe the status, or a revoked token would never sign
  the account out.
- **401 with the envelope on an authenticated call = the session is over**,
  with one exception: **a wrong current password answers 401 with the full
  envelope**, `api.user.check_user_password.invalid.app_error` (e.g.
  `PUT /users/me/patch` changing the email or username) [probed]. It judges the
  password typed, not the token, and must not sign out. The same envelope rule
  applies to kChat's `/broadcasting/auth` and to the resume at startup: a 401
  whose body is not the server's own never ends a session.
  Anonymous calls (login) and "quiet" checks (resume, token test, another
  account's unread badge) judge their 401 themselves and never sign out.
- **429:** wait `X-Ratelimit-Reset` **seconds** (1 s when absent), capped at
  30 s, 3 attempts. Rocket.Chat's header with the same name is an instant in
  epoch milliseconds: a client speaking both tells them apart by size.
- Lists are bare JSON arrays, paged by `page` (from 0) and `per_page` (max 200);
  stop on a short page. **Except `GET /users/me/channels`**, which ignores both
  and answers the whole list on every page [probed] [kChat]: read it once, or a
  page walk never ends past 200 channels. `/users/me/channel_members` and
  `/emoji` do page.

## 3. Sign-in

### 3.1 Mattermost: password

`POST /api/v4/users/login`, body `{"login_id": "<user or email>", "password": "..."}`,
plus `"token": "<6 digits>"` for MFA.

- Send it **without `X-Requested-With: XMLHttpRequest`**: with that header the
  server sets `MMAUTHTOKEN` [probed], which then shadows the bearer (section 2).
- The session token is in the **`Token` response header**; the body is the user
  (`id`, `username`, ...).
- MFA: an error with id **`mfa.validate_token.authenticate.app_error`** means a
  code is required. Ask it, replay with `token`.

### 3.2 Mattermost: personal access token

Any bearer the server accepts. Validate with `GET /api/v4/users/me` (quiet), which
also names the account.

### 3.3 kChat

No Mattermost login. An **Infomaniak bearer** is sent as is to every kChat team
server of the account:

- **OAuth (mobile only)** [kChat src]: authorization code + PKCE (S256) against
  `https://login.infomaniak.com`, with the client id and redirect of Infomaniak's
  own app: `client_id=20af5539-a4fb-421c-b45a-f43af3d90c14`,
  `redirect_uri=com.infomaniak.chat://oauth2redirect`, no scope, plus
  `hide_create_account=` and `prompt=login`. Exchange at `POST /token`
  (`grant_type=authorization_code`, `code`, `code_verifier`, `client_id`,
  `redirect_uri`). The access token does not expire and no refresh token comes
  back. Check `state` on the redirect. The redirect scheme is the official kChat
  app's: with that app installed, Android may hand the redirect to it. The login
  screen stops waiting as soon as the user is back without it, and the API
  token remains the way in. Logout does not revoke this token (no revocation
  route probed): known limit.
- **Personal API token** [kChat]: created at manager.infomaniak.com (API
  tokens), works as is on the team server.
- **Team servers** [kChat]: `GET https://kchat.infomaniak.com/api/v4/users/me/servers`
  with that bearer lists the account's teams, Mattermost team documents plus
  `url` (`https://<team>.kchat.infomaniak.com`), `account_id`, `product_id`,
  `pack_name`. One server is taken, several are offered. Choosing kChat asks
  no address in any app: sign-in starts at the directory, and a team host typed
  in automatic mode (or a known server) signs in there directly. That answer
  decides where the account-wide token goes, so the apps keep only `https`
  addresses on `kchat.infomaniak.com` or its subdomains.

### 3.4 Session

Stored per server: base URL, token, user id, username, kind (`mattermost` or
`kchat`). Resume is `GET /users/me` (quiet; a 401 there signs out). Sign-out is
best effort `POST /users/logout` on Mattermost and nothing on kChat (the token is
the Infomaniak account's).

## 4. Reading

### 4.1 Rooms and memberships

- `GET /users/me/channels` (one answer, see 2) and `GET /users/me/channel_members`
  (paged). Both cover **every team and the DMs** in one list each [probed]. Drop channels with
  `delete_at > 0` and channels without my membership.
- Channel `type`: `O` public, `P` private, `D` direct, `G` group DM.
  - A `D` channel's `name` is `<userIdA>__<userIdB>`: the other one is the peer
    (both mine for a note to self).
  - A `G` channel's `display_name` lists the members' usernames, mine included;
    the apps drop mine.
- Neither carries the last message: fetch the newest root post (4.3,
  `per_page=1`) of the rooms that changed. The apps do it for the 40 most
  recently active, 4 at a time. A room written without its last post (past
  those 40, or rewritten by a channel event) keeps its stored preview
  (`keepPreview` / `keep_preview`); only its time moves.
- Changed since the last pass: `max(update_at, last_root_post_at || last_post_at)`
  above a stored cursor. An unchanged room is not rewritten.
- The pass is a snapshot: a `posted` or a read that arrives during its requests
  is newer, and memberships' `last_update_at` does not move on either, so no
  update-time guard can tell. The live side stamps each room an event changes;
  the catch-up leaves alone the rooms stamped after it began.

### 4.2 Unread counts (derived, nothing is pushed)

The server sends **no membership update when a post arrives** [probed]. The
client keeps channels and memberships in memory and computes:

```
unread   = channel.total_msg_count_root - member.msg_count_root   (root posts, as shown)
           fallback when either is absent: total_msg_count - msg_count
mentions = member.mention_count, except 0 for a D channel
```

A DM's `mention_count` counts **every** message of it [probed]; shown as
mentions it reads `@13` where the room has 13 unread.

Live updates to that state (section 5):

| Event | Effect |
|---|---|
| `posted` | `total_msg_count` +1. If root: `total_msg_count_root` +1, `last_root_post_at`, new preview. If mine: membership set to read. Else, if `mentions` holds my id: `mention_count` +1 |
| `channel_viewed`, `multiple_channels_viewed` (`data.channel_times` keys) | membership counts = channel totals, `mention_count` 0 |
| `post_unread` | membership takes `msg_count`, `msg_count_root`, `mention_count`, `last_viewed_at` from the event |

Marking read: `POST /channels/members/me/view {"channel_id": rid}`. The server
answers the reading device with `multiple_channels_viewed`, not
`channel_viewed` [probed]. **kChat sends neither** [kChat]: a read emits only
`badge_updated` (`{badge}`, no room). On it the apps read
`GET /users/me/channel_members` again and rewrite the rooms whose `msg_count`,
`msg_count_root`, `mention_count`, `mention_count_root` or `last_viewed_at`
moved, so a read made elsewhere clears the counter live.

### 4.3 History

- `GET /channels/<id>/posts?per_page=50&collapsedThreads=true[&before=<postId>]`
  answers `{order: [ids newest first], posts: {id: post}}`.
  `collapsedThreads=true` returns root posts only; replies live in the thread.
- **Paging is by post id, never by time** [probed]. The screens page by instant,
  so the apps index the post ids seen by `create_at` and turn the instant back
  into an id. On a miss (after a restart) they walk back from the newest page,
  20 pages at most.
- A range `[oldest, latest]`, not stored, is read the same way and cut at
  `oldest`.
- One post: `GET /posts/<id>` (404 or 403: gone).
- A thread: `GET /posts/<rootId>/thread`, root included.

### 4.4 Room catch-up (after a gap)

`GET /channels/<id>/posts?since=<ms>` returns everything **changed** since then:
new posts, edits, and deletions as posts with `delete_at > 0` [probed]. **On
kChat `since=` leaves deleted posts out** [kChat]: they come only from the route
below. It is
fast server-side, unlike Rocket.Chat's `chat.syncMessages`. The cursor is the
newest `update_at` stored for the room; a room never loaded is skipped. Its
answer is capped at 1000 posts, in no promised order (read in the 11.11
server); after a gap with more changes than that in one room, the apps ingest
what came and miss the rest (known limit, see `apps/mobile/WORKSTREAMS.md`). kChat
lists deletions at `GET /channels/<id>/deleted_posts?since=<ms>`, a JSON array
of post ids [kChat].

Ghost rooms: once per session, rooms missing from a non-empty
`/users/me/channels` are purged.

### 4.5 Users

Posts, reactions and DM names carry **user ids only**. Resolve them before
showing a row: `POST /users/ids` with up to 100 ids (`[{id, username,
first_name, last_name, nickname, last_picture_update}]`). Display name is
`nickname`, else `first_name last_name`. By name: `GET /users/username/<u>`.

### 4.6 Post to message

| Post field | Use |
|---|---|
| `id`, `channel_id`, `user_id`, `create_at` | identity, room, author, time (ms) |
| `message` | Markdown text |
| `root_id` | thread parent; empty for a root |
| `reply_count`, `last_reply_at` | thread chip on a root |
| `edit_at`, `update_at` | edited marker; the version that arbitrates writes |
| `delete_at > 0` | deleted |
| `is_pinned` | pin |
| `props.override_username` | author shown by an integration |
| `metadata.files[]` | `{id, name, mime_type, size, width, height, has_preview_image}` |
| `metadata.reactions[]` | `{user_id, emoji_name}` |
| `metadata.embeds[]` with `type: "opengraph"` | link card: `url`, `data.title`, `description`, `site_name`, `images[0]` |
| `type` | system posts, see below |

System types mapped: `system_join_channel`/`_team` (joined),
`system_leave_channel`/`_team` (left), `system_add_to_channel`/`_team`
(`props.addedUsername`), `system_remove_from_channel`/`_team`
(`props.removedUsername`), `system_header_change` (`props.new_header`, the
topic), `system_purpose_change` (`props.new_purpose`, the description),
`system_displayname_change` (`props.new_displayname`). Other types show as text.

### 4.7 Stars (flagged posts)

A star is a **preference**, not a post field: category `flagged_post`, name the
post id.

- List: `GET /users/me/preferences/flagged_post`.
- Per room: `GET /users/me/posts/flagged?channel_id=<id>&per_page=100`.
- Star: `PUT /users/me/preferences` `[{user_id, category: "flagged_post", name: postId, value: "true"}]`.
- Unstar: `POST /users/me/preferences/delete` with the same body.
- Live: `preferences_changed` / `preferences_deleted`, `data.preferences` a
  JSON-encoded array.

### 4.8 Sidebar categories and favourites [probed]

My sidebar (Mattermost 5.32+, kChat alike) is a list of categories per team:
`GET /users/me/teams`, then for each team
`GET /users/me/teams/<team>/channels/categories` →
`{categories: [{id, type, display_name, channel_ids, sorting, collapsed, muted}], order: [category ids]}`.

- `type`: `favorites`, `channels`, `direct_messages`, or `custom` (a category of
  my own, named by `display_name`). A channel sits in exactly one category of
  its team.
- A DM or group DM belongs to no team and appears in every team's categories:
  the first team that lists it places it.
- The apps list Unread first (their own section), then one section per
  category in `order`, favourites mapped to the Favourites section, `channels`
  and `direct_messages` to the usual ones. Within a section the order stays
  latest activity first: `sorting` is not followed. `collapsed` and `muted` are
  not read: folding stays local.
- Favourite a room: `PUT /users/me/preferences`
  `[{user_id, category: "favorite_channel", name: channelId, value: "true"}]`;
  `"false"` takes it out. The server moves the room into the Favorites category
  and back into `channels` / `direct_messages` (not into the custom category it
  came from) [probed on 11.11].
- Live: `sidebar_category_created`, `_updated`, `_deleted`, `_order_updated`
  carry no categories (`data: {}` on 11.11): read them again and rewrite every
  membership. A favourite also sends `preferences_changed` (`favorite_channel`).
- A server without the route answers 404: the rooms keep the default sections.

## 5. Real time

### 5.1 Mattermost WebSocket [probed]

- `ws(s)://<server>/api/v4/websocket`. The server pushes **every event of the
  account**; there is nothing to subscribe per room.
- Authenticate with an action:
  `{"seq": 1, "action": "authentication_challenge", "data": {"token": "<token>"}}`,
  answered `{"status": "OK", "seq_reply": 1}`.
- Every action is answered `{status, seq_reply}`; an unknown action answers
  `status: "FAIL"` with its `seq_reply`, so a waiting call is rejected rather
  than left to time out.
- Liveness: the `ping` action every 30 s, answered with `data.text: "pong"`. The
  desktop declares the socket dead after 75 s without a frame. Reconnect with
  exponential back-off (1 s to 30 s, jitter), then run the catch-ups (4.1, 4.4).
- Event frames: `{"event": name, "data": {...}, "broadcast": {"channel_id", "user_id", ...}, "seq": n}`.
  **Nested documents (`post`, `reaction`, `channel`) are JSON strings**; decode
  them.
- Typing out: action `user_typing` `{channel_id, parent_id}` (no app sends it
  yet; Rocket.Chat typing is receive-only too).

### 5.2 kChat Pusher [kChat]

kChat replaced the WebSocket with the **Pusher protocol**:

1. `GET /api/v4/config/client?format=old`: `WebsocketURL` gives the host
   (default `websocket.kchat.infomaniak.com`). `GET /api/v4/users/me` gives
   `team_id`, the numeric Infomaniak `user_id` and the Mattermost `id`.
2. Connect `wss://<host>/app/kchat-key?protocol=7&client=js&version=8.3.0&flash=false`,
   wait `pusher:connection_established`, read `data.socket_id` (`data` is
   JSON-encoded).
3. For each channel `private-team.<team_id>`, `presence-user.<user_id>`,
   `presence-teamUser.<id>`: `POST <team server>/broadcasting/auth`, form
   `channel_name=<channel>&socket_id=<id>`, bearer; send
   `{"event": "pusher:subscribe", "data": {"channel", "auth", "channel_data"}}`;
   wait `pusher_internal:subscription_succeeded` on that channel.
4. Answer `pusher:ping` with `pusher:pong`; send `pusher:ping` on the server's
   `activity_timeout` (30 s on kChat; 120 s is Pusher's default when absent).
   `pusher:error` fails the handshake.
5. Events have **Mattermost names** and `data` is the Mattermost event's `data`,
   **without the `broadcast` envelope**, nested documents as **objects**, all of
   them on the `presence-teamUser.<id>` channel. A `posted` adds
   `channel_display_name`, `channel_name`, `channel_type`, `sender_name`,
   `set_online` and `team_id`. Ignore `pusher*` and `client-*` events;
   `badge_updated` is kChat's only sign of a read made elsewhere (4.2).
6. **Ids are UUIDs** (posts UUIDv7), not Mattermost's 26-character ids; a DM's
   `name` is still `<idA>__<idB>`.

### 5.3 Events used

| Event | Handling |
|---|---|
| `posted` | `data.post`; `data.mentions` (JSON-encoded user ids on Mattermost, array on kChat). Resolve the author, load an unknown channel (`GET /channels/<id>` and `/channels/<id>/members/me`), apply 4.2, store. A post by someone else not seen before is a notification candidate |
| `post_edited` | `data.post`, store over the old one |
| `post_deleted` | `data.post.id`, remove |
| `reaction_added`, `reaction_removed` | `data.reaction.post_id`: refetch the post (`GET /posts/<id>`) |
| `channel_viewed`, `multiple_channels_viewed`, `post_unread` | 4.2 |
| `channel_created`, `channel_updated`, `channel_converted`, `channel_restored`, `direct_added`, `group_added`, `user_added` (mine) | load the channel and my membership, write both |
| `channel_deleted`, `user_removed` (me) | drop the room |
| `channel_member_updated` (mine) | new membership |
| `typing` | `data.user_id`, room in `broadcast.channel_id`: who types, expires after 15 s |
| `status_change` | `data.user_id`, `data.status`: `online`, `away`, `dnd` (busy), `offline` |
| `user_updated` | `data.user`; a new `last_picture_update` versions the photo |
| `preferences_changed`, `preferences_deleted` | stars (4.7) |
| `sidebar_category_created`, `sidebar_category_updated`, `sidebar_category_deleted`, `sidebar_category_order_updated` | categories (4.8) |
| `badge_updated` (kChat) | read my memberships again (4.2) |
| `hello`, `thread_*`, `config_changed`, `license_changed`, `plugin_statuses_changed` | ignored |

Presence snapshot at each connection: `POST /users/status/ids` with known user
ids, `[{user_id, status}]`.

## 6. Writing

### 6.1 Text: the outbox

- **A client cannot choose the post id**: `POST /posts` with `id` answers 400
  `app.post.save.existing.app_error` [probed].
- Send `POST /posts` `{"channel_id", "message", "root_id": "<parent or empty>", "pending_post_id": "<my user id>:<digits>"}`.
  The server **echoes `pending_post_id` and deduplicates on it**: replaying the
  same value returns the post already created [probed] [kChat].
- **The format matters on kChat** [kChat]: anything but `<my own user id>:<digits>`
  (the web client's format) answers **422** "Le format du champ pending post id
  est invalide", another user's id included; any number of digits is accepted.
  Upstream accepts any string. The apps send `<my id>:<the client id's hex read
  as a decimal number>`, so a replay of the same row sends the same value.
- That memory is a **short-lived cache, not stored**: a replay much later may
  create a duplicate, and a stored post does not keep `pending_post_id`
  [probed]. Before declaring a refusal, the apps read the room's 30 newest
  posts for one of mine with the same text and thread **created since the row
  was queued** (two minutes of clock skew allowed): an older identical message
  is not this one.
- On success the optimistic row (client id) is replaced by the server's post
  (server id).

### 6.2 Files

1. `POST /files?channel_id=<id>`, multipart, field `files` (`file` is accepted
   too [probed]); `channel_id` may also be a text field. The answer is
   `{file_infos: [{id, ...}]}`.
2. Persist that file id **before** the next step, so a replay never uploads the
   bytes twice.
3. `POST /posts` with `file_ids: [id]`, the caption as `message`, `root_id`, and
   `pending_post_id` built from the upload row id as in 6.1.
4. Before replaying step 3 for a known file id, look for a stored message that
   already carries it (attachment link `/api/v4/files/<id>`), refreshing the room
   once when none is found.

The size limit (`MaxFileSize`) is not in the anonymous client config; the server
refuses an oversize file with 413.

### 6.3 Actions

| Action | Request |
|---|---|
| React | `POST /reactions {user_id, post_id, emoji_name}` (shortcode without colons) |
| Unreact | `DELETE /users/<me>/posts/<postId>/reactions/<emoji_name>` |
| Edit | `PUT /posts/<id>/patch {message}`, answers the post |
| Delete | `DELETE /posts/<id>` |
| Pin / unpin | `POST /posts/<id>/pin` / `/unpin`; list `GET /channels/<id>/pinned` |
| Favourite a room | `PUT /users/me/preferences [{user_id, category: "favorite_channel", name: channelId, value: "true" \| "false"}]` (4.8) |
| Open a DM | `POST /channels/direct [myId, otherId]` (idempotent) |
| Join a channel | `POST /channels/<id>/members {user_id}` |
| Search a room | `POST /teams/<team>/posts/search {terms, is_or_search: false, page: 0, per_page: 60}`, keep the room's posts. A DM has no team: use any team of mine (`GET /users/me/teams`) |
| Room info | `GET /channels/<id>` (`header` = topic, `purpose` = description) and `/channels/<id>/stats` (`member_count`) |
| Profile | `GET /users/<id>` or `/users/username/<u>`, `GET /users/<id>/status`; custom status in `props.customStatus` (JSON-encoded, `text`) |
| My status | `PUT /users/me/status {user_id, status}` (busy is `dnd`); custom text `PUT`/`DELETE /users/me/status/custom` |
| Notification preference | read `notify_props.desktop` from `/users/me`, write it back whole with `PUT /users/me/patch {notify_props}` (a patch replaces the map) |
| People search | `POST /users/search {term, limit}`; channels `POST /teams/<team>/channels/search {term}` |
| Permalink | `<server>/_redirect/pl/<postId>` (the server finds the team) |

### 6.4 Custom emoji [probed]

- List: `GET /emoji?page=<n>&per_page=200` → `[{id, name, creator_id, ...}]`
  (6 on the kChat account, `EnableCustomEmoji` true on both). No aliases.
- Image: `GET /api/v4/emoji/<id>/image`, **by id only**, bearer required. The
  apps keep `name → image URL` (mobile persists it in `custom_emojis.uri`).
- A message carries them as `:name:` in its text, names may hold `-`
  (`:alb-youpi:`); a reaction's `emoji_name` is the bare name. Resolution
  order as on Rocket.Chat: Unicode glyph, then custom image, then `:name:`.

### 6.5 kMeet calls [kChat]

kChat calls are kMeet (Infomaniak's Jitsi) meetings, announced by a post of
type `custom_call`, e.g. "bob started a call", whose `props` are
`{url, conference_id, status, start_at, end_at}` (`status: "ended"` seen;
`FeatureFlagIkCallDialing` true on the server).

- Running (no `end_at`, `status` not `ended`, `missed`, `declined` or
  `cancelled`): the apps show a call card whose Join opens `props.url` in the
  locked call view. **Any room member can post a `custom_call` with any
  `props.url`**, and that view grants camera and microphone to its origin, so
  only `https://kmeet.infomaniak.com` is accepted, in the post and again at
  join (a `rocketvibe://call/<url>` link included).
- Over: a `videoconf-ended` row, "📞 Call · <end_at − start_at>".
- Starting a call is not mapped: its route was not probed (it would ring the
  room's members).

## 7. Media [probed]

- File: `GET /api/v4/files/<id>`; image preview `GET /api/v4/files/<id>/preview`.
- Photo: **by user id only**, `GET /api/v4/users/<id>/image` (append
  `?_=<last_picture_update>` to version it). `/users/username/<u>/image` is 404.
  Channels have no photo.
- Every media request needs the bearer header, sent **only to the server's own
  origin**: file links come from message fields, so from anyone.
- Mobile: React Native's `<Image>` drops `source.headers` on Android under the
  New Architecture, so images are downloaded with the header and shown from a
  local copy (`ui/authorizedImage.ts`).
- Desktop: the screens build Rocket.Chat avatar paths; `MediaCache` rewrites them
  to the user-id route.

## 8. Not mapped

Push (a third-party app gets none on kChat: Infomaniak's proxy routes to its own
app id), starting a kMeet call, quotes, room settings and roles, end-to-end
encryption, sending who types, muted channels (`notify_props.mark_unread`:
they count as unread), the live update of a thread's reply count
(`thread_updated`), and, on mobile, stars changed elsewhere
(`preferences_changed`; the desktop follows them).

## 9. Validating an implementation

- **Bench:** `docker compose -f docker/compose.mattermost.yml up -d`, then
  `node scripts/seed-mattermost.mjs`: users `rvadmin`, `bob`, `carol`, team
  `rv`, channels `dev` and `secret`, a DM, 12 posts and a 3-reply thread.
- **Desktop end to end:** `cargo run -p rv-core --example mattermost-smoke [url]`
  in the build container drives a real session through probe, login, live
  post with a mention notification, send without duplicate, reaction, edit, pin,
  star, thread, search, upload and download, avatar, DM and the unread badge.
  It prints `ALL OK`.
- **GTK:** `apps/desktop/scripts/smoke.sh http://localhost:8065 rvadmin <password> Dev out.png`.
- **Unit tests:** mobile `node --test providers/mattermost/*.test.ts` (fake server
  in `testing.ts`), desktop `cargo test -p rv-core mattermost`.
- **kChat end to end:** `RV_KCHAT_TOKEN=<Infomaniak API token> cargo run -p rv-core
  --example kchat-smoke [server]` on a real account, writing only to the DM with
  oneself: token sign-in, room list, the Pusher channels, a post made elsewhere
  arriving live, a send accepted once, reaction, edit, upload, then it deletes
  what it posted. It prints `ALL OK`.
- **Still unrun:** the mobile "Sign in with Infomaniak" (OAuth).
