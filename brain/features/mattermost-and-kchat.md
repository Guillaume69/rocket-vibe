# Mattermost and kChat servers

The three apps sign in to a Mattermost server, or to kChat (Infomaniak's
Mattermost), next to their Rocket.Chat and Vibez accounts: rooms, history,
threads, live messages, unread counts, who types (received only, as on
Rocket.Chat), presence, sending text and files, reactions, edits, deletions,
pins, stars (Mattermost's flagged posts), favourites and my own sidebar
categories as room-list sections, search in a room, room info and profiles,
custom emoji, kChat's kMeet calls (joined from their post, ringing in a direct room while the app
runs; starting one is not mapped) and live clearing of a read made in another kChat client. Push, quoting
a message and E2EE are not mapped (`docs/MATTERMOST.md` §8); the server's previews of linked posts show as
quotes ([Post rendering](#post-rendering)). A muted channel counts its
mentions only, a live reply moves its root's reply count, and stars changed in
another client show live, in both apps.
A DM shows its unread count, never mentions: Mattermost counts every DM message
in `mention_count`.

On mobile one driver serves both, behind the same `Provider` facade as
Rocket.Chat ([mobile-app](../architecture/mobile-app.md)); `MATTERMOST_CAPABILITIES`
turns off what the server lacks, so the screens hide it. On desktop the same
`Session` carries a Mattermost backend ([desktop-core](../architecture/desktop-core.md)),
so GTK and SwiftUI run unchanged past the sign-in screen.

## Post rendering

Posts read as the official apps show them (both apps, 2026-10-17; `docs/MATTERMOST.md` §4.6):

- **Integration cards** (`props.attachments`): `pretext` stays above the card instead of standing in for its text; title, text and field values are markdown, so kChat's Euria access requests show their emoji and links rather than `:file_folder:` and `[label](url)`. A `fallback` equal to the `pretext` is not repeated as the text. Drawing: [room-view](room-view.md).
- **Webhook authors.** `props.from_webhook == "true"`: the post shows under `props.override_username` with `props.override_icon_url` (absolute http(s) only, fetched without the bearer, which never leaves for another origin), the BOT badge, no profile, its own group. Without `from_webhook` the override is ignored, as Mattermost does. `props.from_bot` also gives the badge, and so does a bot account (`is_bot` on the user, kChat's Euria: mobile `MmUser.bot`, desktop `directory::User.bot`). Mobile `webhookAlias`, `httpUrl` (`translator.ts`, columns `author_alias`, `author_avatar`, `author_bot`); desktop `Translator::message` (`alias`, `alias_avatar`, `author_bot`). The room list preview names the alias on desktop (`last_message_author`).
- **Permalink previews** (`metadata.embeds[]` of `type: "permalink"`, `data.post`): the linked post becomes a quote attachment (`message_link` `/_redirect/pl/<id>`, absolute on mobile, relative on desktop; `author_name` from the directory, `ts`, `text`) flagged `permalink_preview` and drawn under the text, with the quoted post's files (`metadata.files`). Unknown quoted authors are loaded with the page: mobile `permalinkPosts` in `live.ts`, desktop `MmSync::ensure_authors` (`data.post.user_id`). The server sends them only with `ServiceSettings.SiteURL` set.
- **Reminders** (`type: "reminder"`, posted by the system bot when a "Remind me" set in a Mattermost or kChat client falls due): the server writes the sentence in English (`app.post_reminder_dm`), so the apps rebuild it from `props.username` and the post's link (the message's last URL, else `<server>/<props.team_name>/pl/<props.post_id>`) and show it in the app's language. Mobile stores the English sentence (`reminderMessage`, `lib/reminder.ts`) and `MessageContent` localizes it on Mattermost and kChat accounts (`localizedReminder`, key `messageRow.reminder`); desktop translates at ingestion (`translate::reminder`, key `mm.reminder`), so a language change applies to new posts only. The permalink embed shows the reminded post under it. These are the server's reminders, apart from the apps' own [reminders](reminders.md).
- **Mention names.** `@username` shows the person's name under the account's name format (`docs/MATTERMOST.md` §4.5), as the official apps do; the link still targets the username. Mobile: `MmDirectory.mentionNames` through `setDisplayNames` / `useMentionNames` into `mentionOf`, and `MmLive` asks unknown mentioned usernames (and `props.username`) once per session (`mentionedUsernames`, code spans and fences aside, `Directory.ensureUsernames`). Desktop: `Session::mention_name` (`Directory::name_of`) into `markdown::Context.names`; `MmSync::ensure_authors` asks the usernames a post mentions (`parse::mentioned`, `@all`, `@here`, `@channel` aside) and its `props.username` through `Directory::ensure_usernames` before the post is stored, `Directory::ensure_mentioned` keeping each name to one answered request a session: a name is marked asked only once the server answered (a batch, or a 4xx for that name alone), so a network failure, a 5xx or a 429 leaves it to the next post; the group DM title path (`ensure_usernames`) is not held back by it. Both apps mark only answered names. Rocket.Chat keeps `@username`.
- **Posts only I see** (`ephemeral_message`: a command's answer, kChat's "visible only to you" confirmation of a reminder with its Delete and View reminders buttons, an integration's `ephemeral_text`): never stored, shown as the private note above the composer ([slash-commands](slash-commands.md#the-private-answer)) with the text as markdown, the cards and their buttons. A reminder's confirmation (`props.type: "reminder"`, `target_time` in seconds, `username`) is reworded in the app's language, "You will be reminded about [this message](<link>) from @<username> <when>", the link the message's URL, else built from `team_name` and `post_id`. `<when>` comes from each app's own "Remind me" formatter, so the wording differs: Android `useReminderFormatter` ("Wed, Oct 14, 9:00 AM"), desktop `rv_core::reminders::when` ("tomorrow at 09:00"). Mobile `ephemeralNote` (`translator.ts`, key `room.reminderAck`, the post's people asked through `MmLive.ensureAuthors`); desktop `MmSync::ephemeral` and `Translator::ephemeral` (`reminder_set`, key `mm.reminder_set`) into `SessionEvent::Private {attachments, post_id}`.
- **Card buttons** (`attachments[].actions` of `type` `button` or absent, at most 10 with the menus; `style` `danger` red, `primary` / `good` / `success` green; the `cookie` an ephemeral post's button carries): drawn on every card of a Mattermost or kChat account, in the room and in a private note, and pressed through `POST /posts/<post>/actions/<action>` (`docs/MATTERMOST.md` §6.3), refused before any request when either id has a character outside `[A-Za-z0-9_-]`, since the ids are the integration's and `..` would climb out of the route (mobile `cardActionRoute`, desktop `press_action`). The button waits while the call runs; an http(s) `goto_location` opens, an `ephemeral_text` in the answer becomes a private note, a failure says "This action failed" (`card.actionFailed`, `mm.action_failed`). Mobile `MmActions.cardAction`, `ui/cardActions.ts` (`useCardAction`), `ui/integrationCard.tsx` (`Buttons`); desktop `MmSync::press_action` (an answered `update` is ingested, and a `system_ephemeral` post, which Mattermost broadcasts on `post_edited` after such an update, is never stored), `Session::press_card_action`, GTK `cards::attachment_card` (`PressAction`, `RowEvent::CardAction`, `ChatPage::press_card_action`), SwiftUI `IntegrationCard.press` and `RoomModel.pressCardAction` over rv-ffi `Chat::press_card_action`.
- **Card menus** (`type: "select"`; stored as `{type: "select", options: [{text, value}], source: "users" | "channels", default}`, other action types left out): the menu sits among the buttons and shows the choice made, else the label of its `default_option` when listed, else its `name` dimmed. Opening it lists the integration's options, filtered on the device as I type (case and accents ignored), or people (`POST /users/search`, the value the user id) or channels of the room's team (`POST /teams/<team>/channels/search`, the value the channel id) searched 250 ms after typing stops, a late answer dropped, a spinner while it runs and "The choices could not be loaded" on failure. A choice shows at once and presses with `selected_option` beside the `cookie`; a failure says "This action failed" and puts the previous label back. The choice lives on screen only: the integration keeps it by updating the post. Mobile `cardMenu`, `menuLabel`, `filterMenuOptions` (`lib/integrationCards.ts`), `Buttons` in `ui/integrationCard.tsx` opening the sheet `app/card-menu.tsx` through `ui/cardMenuStore.ts`, `MmActions.cardMenuOptions`, keys `card.menu*`; desktop `content::CardMenu` (`MenuSource`, `initial_label`), `MmSync::press_action(…, selected)`, `mattermost::actions::menu_options`, `Session::card_menu_options`, keys `card.menu_*`, GTK `cards::card_menu` (a `MenuButton` and popover, `matching`, `RowEvent::CardMenuOptions`), SwiftUI `CardMenuControl` (`RoomView.swift`, `CardMenus` in RocketVibeKit) over rv-ffi `Chat::card_menu_options`.

## Mobile

**Room search.** `providers/mattermost/search.ts` reads the current channel and, for a conversation, its complete member list and usernames. Search adds `in:<channel-name>`, `in:@<other-user>` for a DM, `in:@<all-member-usernames>` for a group, or `in:@<me>` for a self-DM before the result limit. Missing scope information fails explicitly rather than making a team-wide request. Results are still filtered by channel id. Public, private, direct, group and self-direct scopes are qualified against Mattermost 11.11.1 by `scripts/probe-mattermost-search.mjs`; kChat live scope qualification remains open. Desktop uses the same resolver in `rv-core/src/mattermost/actions.rs`, shared by GTK and SwiftUI.

### Server kinds

`ProviderKind` gains `mattermost` and `kchat` (`lib/provider.ts`); both build
`createMattermostProvider` (`providers/mattermost/index.ts`). The login screen's
kind picker offers them; in `auto`, `lib/serverKind.ts` takes a host under
`kchat.infomaniak.com` as kChat, then after the Vibez discovery fails,
`GET /api/v4/system/ping` answering `{status: "OK"}` as Mattermost, before the
Rocket.Chat probe. Other screens get a `RestClient` that answers 501
`not-supported` (`lib/sessionTransport.ts`), as for Vibez, so a leftover
Rocket.Chat call fails cleanly instead of hitting the wrong server.

### Sign-in

- Mattermost: `POST /users/login`, the token in the `Token` response header,
  MFA as a second step when the server answers
  `mfa.validate_token.authenticate.app_error` (`providers/mattermost/auth.ts`).
  The request leaves without `X-Requested-With`, so no `MMAUTHTOKEN` cookie is
  set: the server reads that cookie before the bearer, and a cookie-borne `POST`
  without CSRF token answers 401 like an expired session.
- kChat: an Infomaniak bearer token used as is on every kChat server of the
  account. "Sign in with Infomaniak" runs authorization code + PKCE with the
  client id and redirect of Infomaniak's own kChat app
  (`providers/mattermost/kchatOAuth.ts`) in the app's sign-in web view
  (`ui/signInWebView.tsx`, `app/login.tsx`), its button on the first screen as soon as kChat is chosen, the desktops' sign-in window: it
  shows Infomaniak's pages only (`isKchatSignInPage`), and catches the
  `com.infomaniak.chat` redirect before it loads, so no browser has to hand an
  app link back after Infomaniak's script-driven 2FA redirect. Its cookies are
  cleared after the exchange (`modules/web-cookies`). The scheme stays declared
  in `app.json` and swallowed by `app/+native-intent.tsx`. There is no
  token field any more, like the desktops. The servers come from
  `GET https://kchat.infomaniak.com/api/v4/users/me/servers`. Choosing kChat
  hides the address (`app/login.tsx` probes `KCHAT_DIRECTORY`); a team host typed
  in automatic mode picks its server, a single server is taken, several are
  offered.
- Resume is `GET /users/me`; a 401 there signs out (`sessionRejected`). Sign-out
  is `POST /users/logout` on Mattermost, nothing on kChat (the token is the
  account's).

Mobile session exit removes media bearers, username mappings and session-owned protected copies, with late download fencing (`lib/mediaAuth.ts`, `lib/authorizedMediaCache.ts`). Infomaniak's official mobile app calls `POST /users/logout` with a device id on all stored teams; that is not evidence that the account-wide OAuth token is revoked. Automatic token revocation remains unqualified. Personal tokens can be revoked in Infomaniak Manager. See `docs/MATTERMOST.md` section 3.4.

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
- Custom emoji: `Provider.listCustomEmojis` pages `GET /emoji` and gives each
  name its image `/api/v4/emoji/<id>/image`; `syncCustomEmojis` stores it in
  `custom_emojis.uri` (migration `0024_custom_emoji_uri`) and `ImageEmoji`
  fetches it with the bearer (`useAuthorizedUri`). See [emoji](emoji.md).
- kChat kMeet calls: `kmeetCall` (`providers/mattermost/translator.ts`) maps a
  `custom_call` post to a `videoconf` whose `callId` is the meeting URL, or to
  `videoconf-ended` with its length; `mountProviderCalls` binds a join that
  returns that URL as is (`lib/providerCalls.ts`). See [calls](calls.md).
- Stars: a star is my `flagged_post` preference, absent from the post. `MmLive.flagged`
  is loaded at each global catch-up (`/users/me/preferences/flagged_post`,
  `MmLive.resetFlags`), moved by `preferences_changed` / `preferences_deleted`,
  by `MmActions.star` and by the starred list, and read by `MmTranslator.toMessage`,
  so a re-read post keeps its star. A change emits `mm:starred`, translated to
  the `message-starred` sync change, which rewrites only a cached row
  (`Store.updateMessageStarred`). A post unflagged while the app was not running
  stays starred until it is read again.
- Live replies: `thread_updated` is quiet, so `MmLive.posted` reads a reply's root
  again (`GET /posts/<id>`, one read in flight per root) and emits `mm:thread`,
  translated to the `thread-counters` sync change: only the cached root's
  `thread_count` / `thread_last` move (`Store.updateThreadCounters`). A whole
  post would insert an old root the cache lacks, and the room pages back from
  its oldest row.
- kChat reads made elsewhere: `badge_updated` makes `MmLive.recount` read my
  memberships again and emit the rooms whose counts moved.
- People: `MmDirectory` names users under the account's name format (my
  `display_settings/name_format`, else `TeammateNameDisplay`, read by
  `MmCatchUp.nameFormat` and followed live by `MmLive.preferences`), resolves
  group DM members (`ensureUsernames`, one by one when a cut name refuses the
  batch, `nameOfCut`), looks me up, and keeps each person's custom status emoji
  (`props.customStatus`, object or JSON). It publishes `user id → name` and
  `→ emoji` (`Provider.displayNames`, `lib/displayNames.ts`): message authors
  (`ui/messageRow.tsx`) and DM rows (`app/index.tsx`) show them.
- Listing: `MmSidebar` (`providers/mattermost/sidebar.ts`, reached through
  `MmCategories.sidebar`) hides closed conversations and keeps the
  `limit_visible_dms_gms` most recent of the Direct Messages category; a
  conversation opened in the session stays. Conversations are written again at
  each catch-up, their names moving with people.
- Settings: `Provider.sidebarSettings` (`providers/mattermost/sidebarSettings.ts`)
  reads and writes the name format and the limit; My account shows them
  (`SidebarSettingsCard`, `ui/settingsSections.tsx`).
- kMeet: `Provider.calls` (`providers/mattermost/kmeet.ts`) starts, answers and
  declines conferences; a `custom_call` posted in a direct room rings
  (`Provider.callSignal`, the post ended stops it); see [calls](calls.md#ringing).
- Cards: integrations' `props.attachments` map to Rocket.Chat's attachment
  shape, and a text-less post previews its first card or file.
- Lists: `MmClient.pages` walks `page`/`per_page`; `/users/me/channels` is read
  once (`MmCatchUp.channels`), it ignores paging.
- A 401 revokes only with the server's own body (`MmError.rejectsToken`, set by
  `MmClient.failure`), except Mattermost's wrong-password id; `sessionRejected`
  (`lib/sessionTransport.ts`), `describeMmError` and logout read that flag.
- The global catch-up skips rooms a live event changed during its requests
  (`MmLive.mark`, `changedSince`), and a room written without its last post
  keeps its stored preview (`LocalRoom.keepPreview`, `UPSERT_ROOM`).
- The outbox confirms a refused send only with a post created since the row
  was queued (`OutboxRow.createdAt`).
- kMeet: only `https://kmeet.infomaniak.com` (`isKmeetUrl`), in the post and in
  the join binding. The kChat directory's servers must be https on
  `kchat.infomaniak.com` (`isKchatServer`). Leaving the Infomaniak sign-in page
  ends the wait (`app/login.tsx`, AppState).
- `ui/authorizedImage.ts`: bytes land in a `.part` file renamed once complete; a
  failure is retried after 30 s.
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
  `/channels/<id>/deleted_posts`. A full answer (1000 rows, the server's cap,
  in no order) cannot be vouched for: the room's cache goes, optimistic rows
  kept (`Store.clearRoomMessages`), and the newest page is read in its place.
- A muted membership (`notify_props.mark_unread: "mention"`) counts its
  mentions as its unread (`membershipCounts`), so it stays out of Unread.
- Search in a room adds `in:<channel name>` to the terms for a public or
  private channel (not probed on a bench); a conversation keeps the team-wide
  ask. The room filter on the answer stays.

### Sending

- `MmOutbox`: the client id leaves as `pending_post_id` and persisted `props.rocket_vibe_client_id` (not on kChat, `marked: false`: it refuses unknown `props` keys with 422), the real post (server
  id) replaces the optimistic row. A refusal is checked against the room's newest
  posts before marking the row failed, and so is a row about to be sent again
  when it may already have gone out (its answer lost in this session, or queued
  before a restart). Only an exact operation marker proves delivery. An unmarked text match or a full page that cannot cover the send's time remains failed and visible until explicit retry. `api.post.deduplicate_create_post.pending` (the first POST
  still being saved) is not a refusal: the row stays pending and a pass 3 s
  later looks for the post.
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
`id` (`MmClient` `plainErrors`, `RestClient::kchat`). The browser sign-in was
then run on the same account, 2FA included. A kChat
account has no push for a third-party app (Infomaniak's proxy routes to its own
app id). Room settings are not mapped. Who types is received, not sent, as on Rocket.Chat.

## Desktop

### Sign-in

`ServerKind` gains `Mattermost` and `Kchat` (`rv-core/src/native.rs`), offered by
the GTK drop-down (`rv-gtk/src/login.rs`) and the SwiftUI picker
(`macos/Sources/RocketVibe/LoginView.swift`, `ServerChoice` in `rv-ffi`). In
automatic mode a `*.kchat.infomaniak.com` host is kChat, then after the
Vibez discovery, `/api/v4/system/ping` identifies Mattermost before the
Rocket.Chat probe (`server::probe_as`, `session::login_as`).

- Mattermost: `mattermost::login`, the token from the `Token` header, no
  `X-Requested-With`. A missing MFA code comes back as a `totp` 2FA challenge, so
  both UIs ask it with the step they already have for Rocket.Chat.
- kChat: choosing it hides the address and user fields; the password field
  becomes the Infomaniak API token, and "Sign in with Infomaniak" runs the same
  PKCE flow as mobile (`mattermost::oauth`: `Pkce`, `authorize_url`,
  `code_from_redirect`, `exchange`). No desktop browser hands a custom-scheme
  redirect back, so Infomaniak's page opens in a sign-in window of the app that
  shows only `https://*.infomaniak.com`, grants no camera or microphone and
  cancels the navigation to `com.infomaniak.chat://`, which it hands back and
  closes: an `adw::Dialog` with an ephemeral WebKitGTK view on Linux
  (`rv-gtk/src/sign_in_window.rs`, closed by Escape or a backdrop click like any
  dialog), `rv_native::sign_in_window` (WebView2, WKWebView, the call window's
  code with a `SignIn` mode) on Windows and macOS, `SignInWindow.swift` with
  `KchatSignIn` from rv-ffi in SwiftUI. Closing it is a cancel. The bearer then
  takes the API token's path. Sign-in starts at
  `mattermost::KCHAT_DIRECTORY`: `mattermost::login_kchat` takes the account's
  only server, and with several answers `KCHAT_SEVERAL_SERVERS`; the UIs then
  list them (`mattermost::kchat_servers`, `Client.kchat_servers` in rv-ffi) in a
  picker and sign in on the one chosen. A team host typed in automatic mode signs
  in there directly.
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
  delegates its public methods to it. A full `since=` answer clears the room
  (`Writer::clear_room_messages`, optimistic rows kept) and reads the newest
  page; a live reply whose root is cached reads the root again (`posted`);
  `translate::counts` counts a muted membership's mentions only;
  `actions::search` adds `in:<name>` for a channel (`MmSync::channel_name`).
- Sidebar categories: `mattermost::categories::load` at each global catch-up and
  on `sidebar_category_*` (`MmSync::regroup` rewrites every membership);
  `categories::place` sets `favorite`, `group_id`, `group_name`, `group_rank` on
  the subscription, as on mobile. `Session::set_favorite` writes the
  `favorite_channel` preference (`mattermost::actions::favorite`) and moves the
  room at once (`MmSync::note_favorite`) until the server's event arrives.
- Custom emoji: `mattermost::actions::custom_emojis` in `once_per_session`
  fills the same code→path map as Rocket.Chat, paths `/api/v4/emoji/<id>/image`.
- kMeet calls: `translate::kmeet_call`, as on mobile; `Session::join_call` and
  `call_link` hand back the meeting URL (`kmeet_url`); a call posted in a direct
  room rings (`MmSync::call_signal`, `decline_conference`, [calls](calls.md#ringing)). GTK draws an ended call
  with `cards::voice_call` (no button), SwiftUI with `VoiceCallCard` (no voice
  model, so no button).
- `badge_updated`: `MmSync::recount`, as on mobile.
- People, listing, cards and kMeet as on mobile: `directory::NameFormat`,
  `Directory::ensure_usernames`, `name_of_cut`, `status_emoji`;
  `categories::Sidebar`; `MmSync::load_preferences`, `preferences_changed`;
  `translate::cards`, `preview_of`; `actions::start_conference`,
  `answer_conference`, `sidebar_settings`. `Session::person_label` gives GTK and
  rv-ffi (`MessageItem.author_label`) a person's name with their status emoji;
  `Session::status_emoji` marks DM rows. Settings: GTK's account page
  (`settings.rs` `sidebar_group`) and SwiftUI's (`SidebarSettingsSection`);
  neither offers Encryption to a Mattermost account.
- Lists: `mattermost::pages`; `MmSync::channels` reads `/users/me/channels`
  once. The catch-up skips rooms live events stamped during it (`Live::touch`,
  `changed_since`); `Room.keep_preview` keeps a stored preview.
- `rest::interpret_mattermost` does not count Mattermost's wrong-password 401 as
  understood, so it never signs out; `delay_after_429` reads Mattermost's reset
  as seconds. The outbox's `mine_on_server` needs a post created since the row
  (`OutboxEntry.created_at`).
- `translate::is_kmeet` gates kMeet posts and `Session::join_call`. The delayed
  reconnect is one of the session's tasks, aborted by `shutdown`.
- A message fetched alone (`fetch_message`) is indexed for paging, and a file
  replay on Mattermost reads the room's `since=` catch-up first (replies
  included).
- `mattermost::socket`: one actor for both dialects, Mattermost's
  `authentication_challenge` or kChat's Pusher (`mattermost::pusher`), a ping every
  30 s, `Lost` after 75 s of silence, the reconnection back-off of DDP.
- `Outbox` and `Uploads` branch on it: `pending_post_id`, persisted `props.rocket_vibe_client_id` for text sends (left out on kChat, `MmSync::kchat`), my newest posts read
  before a refusal and before replaying a row that may already have gone out
  (attempted in this session, or queued before the outbox started). An exact marker proves delivery; ambiguous legacy text matches or an insufficient lookup window stay failed until explicit retry;
  `api.post.deduplicate_create_post.pending` keeps the row pending for the next
  trigger; bytes to `POST /files`, then a post with `file_ids`, the file
  id persisted between the two.
- `MediaCache::for_mattermost` maps the Rocket.Chat avatar paths the screens
  build onto `/api/v4/users/<id>/image`; a room has no photo there.
- `mattermost::actions`: reactions, edit, delete, pin, star, read mark, DM,
  join, search, room info, profiles, my status, notification preference, people
  and channel search, permalinks (`/_redirect/pl/<post>`).

### Tests

Unit tests in `mattermost/*.rs` (all but `directory.rs`) and
`tests/mattermost.rs` against a fake server (paging, the channel list read
once, `badge_updated`, sidebar categories, custom emoji, the 401 rule, kMeet,
kept previews); `examples/mattermost-smoke.rs` drives a
real `Session` against the bench (`cargo run -p rv-core --example
mattermost-smoke`), and `scripts/smoke.sh` the GTK app. `mattermost::oauth`
tests the PKCE flow (RFC 7636 vector, state, token answer); `RV_SMOKE_INFOMANIAK=1`
opens Infomaniak's real page in the GTK sign-in window and forges a redirect for
another request, which must be caught, refused and close the window.

## Sources

- apps/mobile/providers/mattermost/translator.ts
- apps/mobile/providers/mattermost/live.ts
- apps/mobile/providers/mattermost/directory.ts
- apps/mobile/lib/reminder.ts
- apps/mobile/providers/mattermost/actions.ts
- apps/mobile/ui/cardActions.ts
- apps/mobile/ui/integrationCard.tsx
- apps/mobile/app/card-menu.tsx
- apps/mobile/ui/cardMenuStore.ts
- apps/mobile/ui/privateNotes.tsx
- apps/mobile/lib/displayNames.ts
- apps/desktop/crates/rv-core/src/mattermost/translate.rs
- apps/desktop/crates/rv-core/src/mattermost/directory.rs
- apps/desktop/crates/rv-core/src/mattermost/sync.rs
- apps/desktop/crates/rv-core/src/parse.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift

- apps/mobile/providers/mattermost/search.ts
- apps/mobile/providers/mattermost/search.test.ts
- scripts/probe-mattermost-search.mjs

- `docs/MATTERMOST.md`: the protocol both apps speak, with its provenance and how to validate it

- `apps/desktop/crates/rv-core/src/mattermost/`
- `apps/desktop/crates/rv-core/src/session.rs`, `sync.rs`, `outbox.rs`, `uploads.rs`, `media.rs`, `server.rs`, `native.rs`
- `apps/desktop/crates/rv-gtk/src/login.rs`, `apps/desktop/crates/rv-gtk/src/sign_in_window.rs`, `apps/desktop/crates/rv-ffi/src/model.rs`, `apps/desktop/crates/rv-ffi/src/lib.rs`
- `apps/desktop/crates/rv-native/src/windows_call.rs`, `apps/desktop/crates/rv-native/src/macos_call.rs`
- `apps/desktop/macos/Sources/RocketVibe/LoginView.swift`, `apps/desktop/macos/Sources/RocketVibe/SignInWindow.swift`, `apps/desktop/macos/Sources/RocketVibeKit/LoginModel.swift`
- `apps/desktop/crates/rv-core/examples/mattermost-smoke.rs`
- `apps/mobile/providers/mattermost/`
- `apps/mobile/lib/provider.ts`, `apps/mobile/providers/index.ts`
- `apps/mobile/lib/serverKind.ts`, `apps/mobile/lib/sessionTransport.ts`, `apps/mobile/lib/mediaAuth.ts`
- `apps/mobile/app/login.tsx`, `apps/mobile/app/+native-intent.tsx`, `apps/mobile/app.json`
- `apps/mobile/ui/sync.tsx`
