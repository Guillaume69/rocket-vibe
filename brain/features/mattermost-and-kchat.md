# Mattermost and kChat servers

The three apps sign in to a Mattermost server, or to kChat (Infomaniak's
Mattermost), next to their Rocket.Chat and RocketVibe accounts: rooms, history,
threads, live messages, unread counts, who types (received only, as on
Rocket.Chat), presence, sending text and files, reactions, edits, deletions,
pins, stars (Mattermost's flagged posts), favourites and my own sidebar
categories as room-list sections, search in a room, room info and profiles.
Push, custom emoji, calls, quotes and E2EE are not mapped.
A DM shows its unread count, never mentions: Mattermost counts every DM message
in `mention_count`.

On mobile one driver serves both, behind the same `Provider` facade as
Rocket.Chat ([mobile-app](../architecture/mobile-app.md)); `MATTERMOST_CAPABILITIES`
turns off what the server lacks, so the screens hide it. On desktop the same
`Session` carries a Mattermost backend ([desktop-core](../architecture/desktop-core.md)),
so GTK and SwiftUI run unchanged past the sign-in screen.

## Mobile

### Server kinds

`ProviderKind` gains `mattermost` and `kchat` (`lib/provider.ts`); both build
`createMattermostProvider` (`providers/mattermost/index.ts`). The login screen's
kind picker offers them; in `auto`, `lib/serverKind.ts` takes a host under
`kchat.infomaniak.com` as kChat, then after the RocketVibe discovery fails,
`GET /api/v4/system/ping` answering `{status: "OK"}` as Mattermost, before the
Rocket.Chat probe. Other screens get a `RestClient` that answers 501
`not-supported` (`lib/sessionTransport.ts`), as for RocketVibe, so a leftover
Rocket.Chat call fails cleanly instead of hitting the wrong server.

### Sign-in

- Mattermost: `POST /users/login`, the token in the `Token` response header,
  MFA as a second step when the server answers
  `mfa.validate_token.authenticate.app_error` (`providers/mattermost/auth.ts`).
  The request leaves without `X-Requested-With`, so no `MMAUTHTOKEN` cookie is
  set: the server reads that cookie before the bearer, and a cookie-borne `POST`
  without CSRF token answers 401 like an expired session.
- kChat: an Infomaniak bearer token used as is on every kChat server of the
  account. "Sign in with Infomaniak" runs authorization code + PKCE in the system
  browser with the client id and redirect of Infomaniak's own kChat app
  (`providers/mattermost/kchatOAuth.ts`); the redirect scheme
  `com.infomaniak.chat` is declared in `app.json` and swallowed by
  `app/+native-intent.tsx` so the login screen's `Linking` listener reads it.
  Or paste a personal API token. The servers come from
  `GET https://kchat.infomaniak.com/api/v4/users/me/servers`. Choosing kChat
  hides the address (`app/login.tsx` probes `KCHAT_DIRECTORY`); a team host typed
  in automatic mode picks its server, a single server is taken, several are
  offered.
- Resume is `GET /users/me`; a 401 there signs out (`sessionRejected`). Sign-out
  is `POST /users/logout` on Mattermost, nothing on kChat (the token is the
  account's).

### Real time

- Mattermost: `MmSocket` on `/api/v4/websocket` (`providers/mattermost/socket.ts`),
  token in an `authentication_challenge` action, liveness by the `ping` action
  every 30 s and on demand. The server pushes every event of the account, so
  per-room subscriptions only record interest.
- kChat: `KchatPusher` (`providers/mattermost/pusher.ts`) speaks the Pusher
  protocol on `wss://<WebsocketURL>/app/kchat-key`, each channel authorized by
  `POST <server>/broadcasting/auth`: `private-team.<team>`,
  `presence-user.<numeric id>`, `presence-teamUser.<id>`.
- `typing` and `status_change` come out in Rocket.Chat's shapes
  (`stream-notify-room/<rid>/user-activity`, `stream-notify-logged/user-status`),
  so the existing `TypingEngine` and `PresenceEngine` read them; presence is
  read once per connection by `Provider.loadPresence` (`POST /users/status/ids`
  for the users the directory knows).
- Sidebar categories: `MmCategories` (`providers/mattermost/categories.ts`) reads
  each team's categories at every global catch-up and on any
  `sidebar_category_*` event (which carry none, `MmLive.regroup` then rewrites
  every membership). `MmTranslator.toSubscription` takes the room's placement:
  `favorite`, and for a category of my own `groupId`, `groupName`, plus
  `groupRank`, its position in my sidebar order (team index × 1000 + position).
  Favouriting a room is the `favorite_channel` preference
  (`MmActions.roomFavorite`). See [room-list](room-list.md).
- Both hand each event to `MmLive.expand` (`providers/mattermost/live.ts`), which
  does the asynchronous part (unknown users, an unknown channel, the post behind a
  reaction) and turns one event into `mm:*` envelopes: a new post becomes the
  message, the room's preview and the membership with its counters. Mattermost
  sends no membership on a new post: unread root posts and mentions are derived
  from the channel totals and the cached membership, reset on
  `multiple_channels_viewed`.

### Translation and loading

- `MmTranslator` (`providers/mattermost/translator.ts`) writes the neutral rows,
  with the serialized sub-fields in the shapes the renderer already reads:
  reactions as `{":code:": {usernames}}`, files as attachments on
  `/api/v4/files/<id>`, OpenGraph embeds as `urls`, system posts mapped onto
  `uj`, `ul`, `au`, `ru`, `r` and the topic/description types. Users are named by
  id on the wire; `MmDirectory` resolves them before translation.
- History pages by post id (`before=`), never by time; `MmHistory` turns the
  screen's ISO bound back into the id seen at that instant, or walks back from the
  newest page. `collapsedThreads=true` keeps replies in their thread.
- Global catch-up reads `/users/me/channels` and `/users/me/channel_members`
  (across teams) and fetches the newest root post of the 40 most recently changed
  rooms for the list preview; an unchanged room is not rewritten. A room's
  catch-up reads `?since=` (edits and `delete_at` deletions); kChat adds
  `/channels/<id>/deleted_posts`.

### Sending

- `MmOutbox`: the client id leaves as `pending_post_id`, the real post (server
  id) replaces the optimistic row. A refusal is checked against the room's newest
  posts before marking the row failed.
- `MmUploadQueue`: bytes to `POST /files?channel_id=`, the file id recorded, then
  a post with `file_ids`, over the same `uploads` table and lifecycle as
  Rocket.Chat's.

### Media

Mattermost and kChat refuse a token in the URL, and the app keeps no cookie
session (see Sign-in). `lib/mediaAuth.ts` holds the session's bearer per origin
(`lib/origin.ts#originOf`, since React Native's `URL.origin` is empty). React
Native's `<Image>` drops `source.headers` on Android under the New Architecture
(the request reaches the server with no token), so images go through
`ui/authorizedImage.ts#useAuthorizedUri`: the bytes are downloaded once by
`expo-file-system` with the header, and the image shows the local copy (avatars,
attachments, the viewer, the reply banner). Downloads and the audio and video
players pass the header directly. Avatars are `/api/v4/users/<id>/image` (by id
only); `rememberUserId` maps the usernames screens hold to ids.

### Tests

`providers/mattermost/*.test.ts`: translator, live expansion, socket (fake
WebSocket), Pusher, outbox, catch-up, history, login with MFA, kChat OAuth (RFC
7636 vector), the client's 429 and 401. The bench is `docker/compose.mattermost.yml`
and `scripts/seed-mattermost.mjs` ([docs/DEV.md](../../docs/DEV.md)).

### Limits

kChat runs on a real account with an API token (2026-10-08), which found two
things the open-source clients did not say: `pending_post_id` must be
`<my id>:<digits>` (any other answers 422) and errors are `{message}` without
`id` (`MmClient` `plainErrors`, `RestClient::kchat`). The OAuth sign-in follows
Infomaniak's open-source clients and has not been run yet. A kChat
account has no push for a third-party app (Infomaniak's proxy routes to its own
app id). Room settings are not mapped. Who types is received, not sent, as on Rocket.Chat.

## Desktop

### Sign-in

`ServerKind` gains `Mattermost` and `Kchat` (`rv-core/src/native.rs`), offered by
the GTK drop-down (`rv-gtk/src/login.rs`) and the SwiftUI picker
(`macos/Sources/RocketVibe/LoginView.swift`, `ServerChoice` in `rv-ffi`). In
automatic mode a `*.kchat.infomaniak.com` host is kChat, then after the
RocketVibe discovery, `/api/v4/system/ping` identifies Mattermost before the
Rocket.Chat probe (`server::probe_as`, `session::login_as`).

- Mattermost: `mattermost::login`, the token from the `Token` header, no
  `X-Requested-With`. A missing MFA code comes back as a `totp` 2FA challenge, so
  both UIs ask it with the step they already have for Rocket.Chat.
- kChat: choosing it hides the address and user fields; the password field
  becomes the Infomaniak API token. Sign-in starts at
  `mattermost::KCHAT_DIRECTORY`: `mattermost::login_kchat` takes the account's
  only server, and with several answers `KCHAT_SEVERAL_SERVERS`; the UIs then
  list them (`mattermost::kchat_servers`, `Client.kchat_servers` in rv-ffi) in a
  picker and sign in on the one chosen. A team host typed in automatic mode signs
  in there directly. No OAuth: the redirect is a custom scheme a desktop would
  have to register.
- The account persists with `genre` `mattermost` or `kchat`
  (`SessionInfo.mattermost`, `native.rs#from_secret`); the server rail's unread dot
  reads channels and memberships (`mattermost::unread`).

### Backend

`Session::start` builds `RestClient::mattermost` (bearer, `/api/v4/`, the
Mattermost error envelope), `SyncEngine::for_mattermost` and the `mattermost::socket`
actor instead of DDP (`Transport::Live`). Each piece takes its behaviour from
there, so the UIs read the same store:

- `mattermost::sync::MmSync`: the same catch-up, history and live rules as the
  mobile driver (derived unread, previews of the 40 most recent rooms, paging by
  post id through an instant-to-id index, `since=` room catch-up, kChat's
  `deleted_posts`), stars from the `flagged_post` preferences. `SyncEngine`
  delegates its public methods to it.
- Sidebar categories: `mattermost::categories::load` at each global catch-up and
  on `sidebar_category_*` (`MmSync::regroup` rewrites every membership);
  `categories::place` sets `favorite`, `group_id`, `group_name`, `group_rank` on
  the subscription, as on mobile. `Session::set_favorite` writes the
  `favorite_channel` preference (`mattermost::actions::favorite`) and moves the
  room at once (`MmSync::note_favorite`) until the server's event arrives.
- `mattermost::socket`: one actor for both dialects, Mattermost's
  `authentication_challenge` or kChat's Pusher (`mattermost::pusher`), a ping every
  30 s, `Lost` after 75 s of silence, the reconnection back-off of DDP.
- `Outbox` and `Uploads` branch on it: `pending_post_id`, my newest posts read
  before a refusal; bytes to `POST /files`, then a post with `file_ids`, the file
  id persisted between the two.
- `MediaCache::for_mattermost` maps the Rocket.Chat avatar paths the screens
  build onto `/api/v4/users/<id>/image`; a room has no photo there.
- `mattermost::actions`: reactions, edit, delete, pin, star, read mark, DM,
  join, search, room info, profiles, my status, notification preference, people
  and channel search, permalinks (`/_redirect/pl/<post>`).

### Tests

Unit tests in each `mattermost/*.rs`; `examples/mattermost-smoke.rs` drives a
real `Session` against the bench (`cargo run -p rv-core --example
mattermost-smoke`), and `scripts/smoke.sh` the GTK app.

## Sources

- `docs/MATTERMOST.md`: the protocol both apps speak, with its provenance and how to validate it

- `apps/desktop/crates/rv-core/src/mattermost/`
- `apps/desktop/crates/rv-core/src/session.rs`, `sync.rs`, `outbox.rs`, `uploads.rs`, `media.rs`, `server.rs`, `native.rs`, `account_unread.rs`
- `apps/desktop/crates/rv-gtk/src/login.rs`, `apps/desktop/crates/rv-ffi/src/model.rs`
- `apps/desktop/macos/Sources/RocketVibe/LoginView.swift`, `apps/desktop/macos/Sources/RocketVibeKit/LoginModel.swift`
- `apps/desktop/crates/rv-core/examples/mattermost-smoke.rs`
- `apps/mobile/providers/mattermost/`
- `apps/mobile/lib/provider.ts`, `apps/mobile/providers/index.ts`
- `apps/mobile/lib/serverKind.ts`, `apps/mobile/lib/sessionTransport.ts`, `apps/mobile/lib/mediaAuth.ts`
- `apps/mobile/app/login.tsx`, `apps/mobile/app/+native-intent.tsx`, `apps/mobile/app.json`
- `apps/mobile/ui/sync.tsx`
