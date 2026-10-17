# Slack session provider, researched contract

Slack is a saved account kind on Android, GTK and SwiftUI, behind nine activations of
the login icon. Rooms, unread counts, history and threads go through the local store
like any other server; the RTM socket keeps them live, and text, replies, edits,
deletions, reactions and reads are written back, and received files show as attachments.
Files are sent, rooms searched, messages pinned and saved, and presence followed and set (see "Files" and "Pins, saved messages, search and presence"). Room info and settings, members, leave, favorites, quotes, scheduled messages, profiles and the account screen are not wired and their capabilities stay off. Android signs in from the developer helper's
encrypted handoff or a pasted token and cookie; the desktop opens Slack in a temporary
browser of its own. The Slack read preview is gone from every app; only Teams keeps a
transient preview. See [experimental integrations](../features/experimental-integrations.md)
and [Slack usage](../../docs/SLACK_PREVIEW.md).
The design and protocol handoff are
in [SLACK_SESSION.md](../../docs/protocol/SLACK_SESSION.md), its repeatable
qualification cases in [SLACK_SESSION_PROBES.md](../../docs/protocol/SLACK_SESSION_PROBES.md),
and its measured/source/pending results in
[slack-session-evidence.json](../../docs/protocol/slack-session-evidence.json).

## Authentication and transport

The selected route is Session mode: the helper obtains the original secure HttpOnly
d cookie through loopback CDP in a fresh owned Chromium profile, reads validated
localConfig_v2 workspace tokens or one selected inline boot token, and validates
pairs with fixed-origin auth.test. It never attaches to an existing profile. The
local pairing page selects a validated workspace and exports only a provider-specific
X25519/HKDF-SHA256/AES-256-GCM rvslack1 envelope to the public key of Android's sign-in
pairing code (`providers/slack/handoff.ts`; no longer reached by Android, which signs in through its web view, see [experimental integrations](../features/experimental-integrations.md)). Import consumes that
private key and the app rechecks the transferred team/user. An envelope past its
five-minute transfer deadline, or whose stated expiry is not within the hour, is refused;
once signed in, the saved account no longer carries that expiry. The desktop keeps the
same code (`slack/handoff.rs`, `login_paired`) but neither interface reaches it.

A saved account (`genre` slack) keeps the `xoxc` token, the team id and the `d` cookie
in the keychain record, checked by `auth.test` at sign-in; it lives until Slack refuses
it, with no refresh. Only Slack's own session error codes count as a revoked session.

### Desktop browser sign-in

`slack/browser_login.rs` reuses the helper's acquisition inside the app, with no helper
and no pairing: it launches an installed Chromium-family browser (Chromium, Chrome,
Edge, Brave, searched at fixed paths then on `PATH`; none answers
`supported_browser_missing` before anything starts) on a fresh temporary profile whose
preferences exclude the `slack:` scheme, with CDP bound to a random loopback port and
checked to be that port's `/devtools/browser/` endpoint. A reader task routes CDP replies
and the two events it acts on. Every page is auto-attached (new ones start paused until
`Fetch.enable` covers them) and keeps one session. A `*/ssb/*` document request, Slack's
desktop handoff after sign-in, is fulfilled with a local "Signed in" page before it loads,
so neither `slack:` nor the web client ever runs (the approach of msga,
`punarinta/make-slack-great-again`). At that moment `Storage.getCookies` gives the single
secure HttpOnly unexpired `d` cookie, and the handoff URL and cookie domains name the
workspace hosts (Slack's own hosts excluded). The interception can miss: with Edge on Windows the real `/ssb/redirect` page loaded and waited for the desktop app, so the 800 ms poll (`inspect`) also treats a page sitting on a `/ssb/` URL as the handoff and derives from its host, once per new host. Each host's boot page, fetched with that
cookie and redirects followed by hand on Slack hosts only, carries the `xoxc` token
(Slack answers it with a 403, so the status is not read). If the web client loads instead,
an 800 ms poll still reads the `localConfig_v2` tokens or the boot token from it. Every
candidate passes `auth.test` with the cookie; a changed cookie drops what was found. The
browser is then closed and the profile removed; the user picks a workspace when there are
several (named by subdomain when found by host), and `take` revalidates it with the
expected team and user before the account is saved. Closing the window first answers
`browser_closed`; twenty minutes answer `timeout`. Credentials stay in zeroized memory
until then. GTK polls the attempt from the login page; SwiftUI drives it through the
`SlackBrowserLogin` UniFFI object.

The reference's desktop-app importer covers Linux only; Windows/macOS imports and
phone-only acquisition remain unqualified. Browser login runs in a real browser,
never a WebView. Normal auth cache in the temporary profile is removed on shutdown,
with crash cleanup still debt. Current helper acquisition has synthetic coverage and
an installed-browser transport smoke check, but no live-account acceptance yet.

Live read-only probes on 8 October 2026 confirmed boot derivation despite HTTP
403, successful paired `auth.test` and Web API reads, and session `rtm.connect`.
A cookie-bearing RTM upgrade received `hello` and four pongs in 45 seconds.
A fresh upgrade without `d` received an error code 401 and closed after about
five seconds; the token alone also failed `auth.test`. A later 150-second socket
received two messages, two typing frames, badge/activity updates and 14 pongs,
with channel and DM activity advancing. Basic live reception is therefore
measured. A user-coordinated capture also received reaction-add, edit, deletion
and channel-read events, confirming nested edit identity and deletion target.
HTTP mutations, reaction removal, thread/permission variants and reconnect
guarantees remain unqualified. The ledger records each capture and its limits.

## Live updates (RTM)

`rtm.connect` (`batch_presence_aware=1`, `presence_sub=true`) must answer the account's
team and user, and its URL must be `wss` on a Slack message server (`*.slack-msgs.com`
or `*.slack.com`, no port or userinfo): only then is it opened, with `Cookie: d=` on the
upgrade and no bearer. The socket counts as live only after `hello`; an `error` frame
before it fails the attempt. Slack's own `ping` goes out every 30 s; on Android two
unanswered pongs drop it, on desktop 75 s without any frame. `goodbye` or a drop
reconnects with the usual backoff and a catch-up.

Slack pushes no conversation or read document with a message, so the conversations and
their `client.counts` entries are kept in memory, seeded by the global catch-up, and the
unread state is derived: a message from someone else sets `has_unreads` and adds a
mention when it names me, `@channel`, `@here` or `@everyone`; mine leaves it. As Slack
counts it, a thread reply (not `thread_broadcast`) leaves the room's unread state alone and
only adds a mention, and a notification, when it names me. A root becomes the room's
preview, a reply does not. `message_changed` replaces the nested message at its own `ts`,
`message_deleted` removes `deleted_ts`, a reaction re-reads its one message (the frame
carries no body), from its thread when it is a reply; a pin is re-read the same way on
the desktop, Android taking the whole message the frame carries. `*_marked` overwrites the
counts and moves the room's never-backwards mark bound to the frame's `ts`, so a read made
elsewhere also bounds later marks here (`SlackSync::marked`, `SlackLive.marks`), and
`user_typing` feeds the typing indicator. A conversation that appears (`im_created`,
`channel_joined`, `group_joined`, `mpim_open`, plus `im_open` on the desktop and
`mpim_joined` on Android) or a message from a room off the list makes it listed live: the
desktop reruns `catch_up_global` (once per unlisted room), Android reads it with
`conversations.info` (a room it cannot read is not asked again). A failed `client.counts`
keeps the previous counts rather than clearing the badges. Mobile: `providers/slack/rtm.ts`, `live.ts`; desktop: `rv-core/src/slack/live.rs`
and `SlackSync::apply_event`. The desktop status button also runs a REST catch-up on
Slack, so an account whose socket cannot come up still refreshes. Presence is on in
both apps (see "Pins, saved messages, search and presence").

## Writes

Text leaves through each app's persisted outbox as `chat.postMessage`, `thread_ts` for
a reply and `reply_broadcast` when it is also sent to the room, the app's markdown turned
into mrkdwn (`markdownToMrkdwn`, `markdown_to_mrkdwn`: Slack's three entities `&`, `<`,
`>` escaped everywhere, code spans included and otherwise kept as typed, `<url|label>`, known `@usernames` as `<@id>`, `@all`/`@here` as broadcasts). Each row
carries a `client_msg_id` derived from its id the same way on both apps (pinned by a
shared fixture). Probed on 14 October 2026 with a session token and cookie: a
`chat.postMessage` carrying a chosen `client_msg_id` came back with that exact value,
both in the answer's `message` and on the message read back by `conversations.history`.
Whether Slack deduplicates on it is still unqualified, so it is only a lookup key: a lost answer (timeout, network, 5xx), or a row
that may have gone out before (sent in this session, queued before a restart), is looked
for in a window from 2 minutes before the row; found from me, it settles the row; absent
from a complete window, or the window cut by `has_more`, the row fails as "delivery
unknown" and is never replayed on its own. A same-text message without the marker
proves nothing. An `ok: false` envelope is a refusal; a rate limit or a refused session
leaves the row pending. On Android a 4xx answer that still carries Slack's envelope is
believed (`invalid_auth` signs out); HTML, proxies, TLS errors and 5xx never refuse the
session. Edit, delete, react and mark read call `chat.update`,
`chat.delete`, `reactions.add`/`reactions.remove` (`already_reacted`/`no_reaction`
settle) and `conversations.mark`, the last never backwards and up to the newest `ts`
known; the RTM echo rewrites the rows. The desktop account's method allowlist
(`rv-core/src/slack/api.rs`) admits exactly the read and write methods used.

## People, emoji and huddles

Names follow Slack: a profile's display name, else its full name, else the handle
(`toSlackUser`, `User::from_json`), with the profile's status emoji after it while
`status_expiration` has not passed (the given `status_emoji_display_info` glyph, else a
standard name; a custom status emoji is left out). The desktop stores me by handle at
sign-in and reads my profile like anyone else's (`Directory::ensure` treats a stored user
as known only once read). Slack names standard emoji after iamcal's emoji-datasource,
not the app's emoji-toolkit names, and writes a skin tone as a second code
(`:+1::skin-tone-3:`): `scripts/generate-slack-emojis.mjs` turns emoji-datasource 16.0.0
into one table per app (`rv-core/data/slack-emojis.tsv`,
`apps/mobile/lib/emojis.slack.generated.ts`). Message text gets the glyphs (outside
code); a reaction key is the app's own shortcode for the same glyph, so chips and the
picker work, and a reaction sent goes back to Slack's name (`slack/emojis.rs`,
`providers/slack/emojis.ts`). Custom emoji come from `emoji.list` once per session,
aliases of another custom emoji followed, images public on `emoji.slack-edge.com`.
Photos are the profile's `image_72`, public on Slack's CDN; a default photo redirects
through Gravatar, so the desktop fetches Slack's public media (photos, custom emoji) with
a client that follows up to five redirects, while the API and `files.slack.com` clients
follow none (`RestClient::file_request`). Slack names nobody up
front, so a person is read when first needed: Android reads me and the direct
conversations' partners at catch-up (`SlackCatchUp`, `lib/slackAvatars.ts`), the
desktop reads a person when their photo is first asked for (`MediaCache::fetch`,
`slack_uid` in `media.rs`), which covers me and a partner no loaded message named.

A `huddle_thread` message becomes the same call card as a kChat call
(`huddle_call` in `slack/translate.rs`, `huddleCall` in `providers/slack/translator.ts`):
while the room has neither `has_ended` nor `date_end`, a running call (`videoconf`) whose
call id is the room's page in Slack's web app with `?open=start_huddle`
(`https://app.slack.com/client/<team>/<channel>?open=start_huddle`, `huddle_url` /
`huddleUrl`), which starts or joins it in the browser; the `huddle_link` Slack gives
(`app.slack.com/huddle/...`) only offers to launch Slack's desktop app, so it is
ignored, and a stored one is rewritten on join (`huddle_page` / `huddlePage`). Once
over, an ended call (`videoconf-ended`) with the length from `date_start`/`date_end`. The end arrives as an edit of the same message. The room
header's call button and the card's Join both open that Slack page
(`Session::start_call` / `join_call`). On GTK Linux it opens already signed in
(`browser_login::open_signed_in`, `Session::open_huddle_window`, `ChatView::open_call`): an
app window of a Chromium-family browser on a temporary profile (created 0700) whose `d`
cookie is set as a session cookie over the debugging protocol (`Storage.setCookies`)
before the page loads. The browser picks its own debugging port on 127.0.0.1 and the app
reads it from the profile's `DevToolsActivePort` (no port chosen and freed for another
process to take); the process is killed with the app (`kill_on_drop`) and the profile
deleted when the window closes. If that fails, the ordinary call window opens. On GTK off
Linux, macOS and Android the huddle opens in the system browser (`cards::open_uri`,
`CallWindow.show`, `providers/slack/calls.ts` and the Slack branch of
`app/call/[callId].tsx`, which asks no camera permission). Huddle media has no session API: no native participation. Slackbot's
auto-replies (`slackbot_response`) keep the Slackbot name, by choice.

## Files

A message's `files` become attachments in the shape Rocket.Chat's files render
(`files` in `slack/translate.rs`, `slackFiles` in `providers/slack/translator.ts`): an
image shows its largest thumbnail (`thumb_720`, `thumb_480`, `thumb_360`, else the file)
with `original_w`/`original_h`, a video or audio file plays from `url_private`, and
every file opens or saves from `url_private_download`. Only `https://files.slack.com`
links are kept; `tombstone`, `hidden_by_limit` and `external` files are left out. A
room whose last message is only a file previews its first file's name. That host
answers the session's `d` cookie (probed in a signed-in browser on 15 October 2026:
cookie alone gives 200 for a file and a thumbnail); the apps send the cookie and the
bearer, to that host only: desktop `RestClient::file_request` (`file_host`), mobile a
media lease on `files.slack.com` carrying both headers (`setMediaLease` in
`lib/mediaAuth.ts`), dropped with the session. One lease per host: two signed-in
Slack workspaces share it, the last one opened wins.

Sending (probed 15 October 2026) takes three calls: `files.getUploadURLExternal
{filename, length}` answers an `upload_url` on `files.slack.com` and a `file_id`; the
bytes are POSTed there with no credential (raw or as a multipart `file` field, both
200, the stored size being the file's own); `files.completeUploadExternal {files:
[{id, title}], channel_id, initial_comment?, thread_ts?}` shares it. The shared
message carries `files[].id` and no `client_msg_id`, and appears a moment after the
answer. Probed the same day: completing the same file into the same conversation twice
is idempotent (one message, one share), `files.info` lists `shares.{public|private}.<channel>[{ts}]`
right after completion, and answers `file_deleted` for a file uploaded but never shared.
The apps still persist the file id before the share and look for it before completing
again, so a lost answer neither posts twice nor reports a delivered file as failed:
desktop `Uploads::post_slack` asks `already_posted`, which reads the room again
(`SlackSync::catch_up_room`) and matches `Store::file_posted` on
`/files-pri/<team>-<id>/` (the room only, a thread reply being stored in the same room),
with `SlackSync::upload_url` / `complete_upload` and `RestClient::upload_external`;
mobile `SlackUploadQueue` (`providers/slack/uploads.ts`) looks in the room's recent history
or the thread's replies (`posted`), the file's size read through the `fileSize` upload
hook.

## Pins, saved messages, search and presence

All probed on 15 October 2026 with a browser session token. **Pins**: `pins.add` /
`pins.remove {channel, timestamp}` (`already_pinned`, `no_pin` are the wanted state),
`pins.list {channel}` (items with the full `message`); a message's `pinned_to` lists
the rooms it is pinned in, which sets `pinned`; RTM `pin_added` / `pin_removed` update
the message (see "Live updates"). **Saved for later is the app's star** (`saved.list` pagination is unprobed): `saved.add` / `saved.delete
{item_type: message, item_id: <channel>, ts}`, `saved.list` answering references only
(`item_id`, `ts`, `state`), so a room's saved messages are read back one by one; messages
carry no saved flag, so the set of saved ids is kept (`SlackSync::saved`,
`providers/slack/saved.ts`) and stamps `starred`. The legacy `stars.*` still answer
but are not what Slack shows. **Search**: `search.messages {query: "<text>
in:<#C…>"}`, matches being message-shaped with `channel.id`, filtered to the room.
**Presence**: `presence_sub {ids}` on the RTM socket (DM partners and me) makes Slack
send `presence_change` (`user` or batched `users`), `manual_presence_change` for me;
`users.getPresence` reads mine (`active`, `away`, `manual_away`). Slack has only
`active` and `away`: online sets `users.setPresence auto`, busy and offline set
`away`. `Session::set_status` would also set the status text (`users.profile.set
{profile: {status_text}}`), but no app reaches it on Slack: the field sits in the
account screens (`me`, Android's profile capability), not wired for Slack on any of
the three. The desktop REST client only
calls the methods listed in `slack/api.rs` (`METHODS`), the mobile client those of its
method type.

## Integration and parity

The driver acts through Web API and listens through cookie-authenticated RTM.
It translates into the existing SQLite/native interfaces; Slack does not gain
Rocket.Chat wire routes or the native RocketVibe journal. Decimal Slack timestamps
stay exact for identity, ordering and paging, independently of display milliseconds.
Outbox ambiguity and one-shot file completion require explicit persisted states.

The handoff maps all P01-P23 provider families and records each method's evidence
and remaining probes. There is no demonstrated session path for killed-app Android
push, client E2EE, native huddles/LiveKit/Jitsi parity, in-app administration or
reporting; corresponding runtime capabilities stay false until separately supported.
Current platform debt is recorded in [parity](../parity.md#19-experimental-integrations).

## Sources

- apps/mobile/providers/slack/ (`handoff.ts`, `auth.ts`, `client.ts`, `catchUp.ts`, `history.ts`, `translator.ts`, `rtm.ts`, `live.ts`, `outbox.ts`, `actions.ts`, `emojis.ts`, `directory.ts`, `calls.ts`, `uploads.ts`, `search.ts`, `saved.ts`, `activity.ts`, `index.ts`), apps/mobile/ui/slackSignIn.tsx, apps/mobile/providers/slack/webSignIn.ts, apps/mobile/ui/signInWebView.tsx, apps/mobile/lib/mediaAuth.ts, apps/mobile/app/call/[callId].tsx, apps/mobile/lib/emojis.slack.generated.ts
- scripts/generate-slack-emojis.mjs, apps/desktop/crates/rv-core/data/slack-emojis.tsv, apps/desktop/crates/rv-core/src/slack/emojis.rs
- apps/desktop/crates/rv-core/src/slack/ (`account.rs`, `api.rs`, `browser_login.rs`, `directory.rs`, `sync.rs`, `translate.rs`, `live.rs`), apps/desktop/crates/rv-core/src/outbox.rs (`pass_slack`), apps/desktop/crates/rv-core/src/session.rs (`apply_slack`, `set_typing`, `start_call`, `open_huddle_window`), apps/desktop/crates/rv-core/src/rest.rs (`file_request`, `upload_external`), apps/desktop/crates/rv-core/src/uploads.rs (`post_slack`, `already_posted`), apps/desktop/crates/rv-core/src/media.rs, apps/desktop/crates/rv-gtk/src/chat.rs (`open_call`), apps/desktop/macos/Sources/RocketVibe/CallWindow.swift
- apps/desktop/crates/rv-ffi/src/slack.rs, apps/desktop/crates/rv-gtk/src/login.rs, apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/macos/Sources/RocketVibeKit/LoginModel.swift, apps/desktop/macos/Sources/RocketVibe/LoginView.swift

- `docs/protocol/SLACK_SESSION.md`, `docs/protocol/SLACK_SESSION_PROBES.md`, `docs/protocol/slack-session-evidence.json`
- `apps/mobile/lib/provider.ts`, `apps/mobile/providers/index.ts`
- `apps/desktop/crates/rv-core/src/native.rs`, `apps/desktop/crates/rv-core/src/session.rs`
- `apps/desktop/crates/rv-ffi/src/`, `apps/desktop/macos/Sources/RocketVibeKit/`

- scripts/slack-browser-signin.mjs, scripts/slack/browser.mjs, scripts/slack/session.mjs
- apps/desktop/crates/rv-core/src/slack/handoff.rs
- docs/SLACK_PREVIEW.md
