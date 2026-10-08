# Slack session qualification probes

Companion to [the protocol handoff](SLACK_SESSION.md). Date: 8 October 2026.
Results belong in [the evidence ledger](slack-session-evidence.json); a procedure
below is not a claim that its expected result occurred. A successful method on
one account/workspace does not establish general session support.

## Bench and reporting

Use an explicitly selected Slack workspace/account. For reads, report only
HTTP status, `ok`, error code, delay, counts, structural field names and
booleans validating identity/precision. Keep team/user/channel IDs pseudonymous
in fixtures. Use a designated test channel and two consenting test actors for
mutations, notification and event-generation checks. Never send messages into
ordinary workspace rooms just to prove the protocol.

The investigation used the user's identified Firefox web session for narrow
cookie/boot acquisition and read-only API probes. That proves existing-session
access, not the throwaway Chromium implementation or desktop-app importer.
The probe client submitted no messages, read marks, reactions, favorites, profile
changes, slash commands, uploads, invitations or administrative actions. The user
generated messages/edits/reactions/deletions in Slack during a later capture.
RTM connections
can change Slack's notion of connected presence even when no data is mutated.

Do not persist cookies/tokens/boot HTML, signed URLs, RTM URLs, message text,
profile values, emoji names or raw CDP traces in this repository. Never dump
headers or exceptions that include request objects. Read private credentials
directly from the selected vault/profile into memory, not command arguments.
Scrub on ingestion, rather than collecting a raw trace and hoping to redact it
later. After the bench, close sockets and remove private temporary material.

Use this result shape for each case:

```json
{
  "probe": "S03",
  "utc": "2026-10-08T00:00:00Z",
  "authentication": "session",
  "status": "pending",
  "observations": {"http_status": null, "hello": false},
  "limits": ["example only; not a measured result"]
}
```

## S00: unauthenticated envelope

Send one empty-form POST each to `/api/auth.test` and `/api/rtm.connect`, with no
Authorization/Cookie headers. Check HTTP independently from JSON `ok`.
Measured: both returned HTTP 200 and `ok:false,error:not_authed`.
This baseline does not test any workspace session.

## S01: acquisition, derivation and cleanup

1. Create an owned throwaway Chromium profile and loopback-only CDP connection.
2. Complete normal Slack login interactively, including any MFA/SSO policy.
3. Read `Storage.getCookies` and Slack `localConfig_v2` as described in the
   main contract. Keep the `d` value byte-for-byte, including `%` encoding.
4. Derive `xoxc` from the selected workspace's boot data. Follow Slack-only
   redirects; record status and token-found boolean without the boot body.
5. Validate with S02, select workspaces, commit vault record, terminate the
   owned browser, then delete only the created profile.
6. Repeat cancellation during SSO, browser exit, network failure, locked vault
   and process crash. Verify a startup sweep cleans the owned leftovers.

Observed in the Firefox route: the app root supplied no keyed token; the selected
workspace boot page supplied one despite HTTP 403. Chromium CDP, profile cleanup
and Android acquisition remain untested. Do not generalize the Firefox result
into a working product login screen.

## S02: credential pairing and identity

Use form POST, Bearer `xoxc` and Cookie `d` together for `auth.test`, then
`team.info`. Require the selected workspace and user to match. Test token-only
and cookie-only `auth.test` as controls. Do not try other people's tokens or
cookies. Record only success/error and identity-match booleans.

Measured: the paired credentials worked and the token-only request returned
`invalid_auth`; the cookie-only control returned `not_authed`. Expiry, deliberate logout,
multi-account mixing and enterprise restrictions require an isolated session;
never revoke the user's ordinary Firefox session for this bench.

## S03: RTM handshake and liveness

1. Call `rtm.connect` with the paired credentials and
   `batch_presence_aware=1&presence_sub=true`.
2. Verify returned self/team identities and a qualified WSS host; connect within
   the documented 30-second URL lifetime with `Cookie: d=...` on upgrade.
3. Wait for `hello`, send application JSON pings with unique IDs and verify
   `pong.reply_to`. Collect type counts and structural shapes only.
4. Close the socket. Obtain a fresh URL, respecting method quota, and repeat
   without the upgrade cookie. Record error and closure, never the URL.
5. Separately test expired URL, wrong cookie, lost network, suspend and proxy
   rejection. Distinguish auth rejection from a transport-open event.

Measured: paired session `rtm.connect` matched identity; a cookie-bearing socket
received `hello` and four pongs in 45 seconds. A fresh no-cookie socket received
error code 401, no hello/pong and closed after about 5.2 seconds. A later
150-second authenticated capture received two messages, two typing frames,
badge/activity updates and 14 pongs. Room activity moved in one channel and one
DM during it. Individual frame-to-room correlation was not retained. Deliberate outage and
URL-expiry controls remain pending.

## S04: event coverage, with a second actor

Keep one session RTM connection in the implementation-under-test. The second
actor uses an official client to perform each operation in the test channel.
Repeat in a DM, private channel, MPIM and Slack Connect room if available.
For every action record frame type/subtype, stable pseudonymous target, identity
consistency and latency. Confirm the action with an authorized REST read.

| Second-actor action | Required observation |
|---|---|
| Send root, bot/file message, thread reply, broadcast reply | Live event targets exact channel/ts; thread root/parent/broadcast presentation correct. |
| Edit a recent and an old loaded message | `message_changed` nested identity and correct latest content. |
| Delete root/reply, including unloaded reply | `deleted_ts` target, tombstone and root counter settlement. |
| Add/remove reaction, own echo via official client | Correct user/emoji/item; server count independent of users array. |
| Mark read / favorite / save / pin elsewhere | Personal/shared distinction and supported state events. |
| Join/leave/archive/rename/topic/membership change | Roster updates or authorized refresh; no stale accessible room. |
| Type in room and thread | `user_typing`; test expiry and thread scope. |
| Change presence/status/avatar/emoji catalog | Appropriate event/cache invalidation; privacy and DND preserved. |

Passive listening in a quiet workspace is not this test. The longer capture
did observe messages and typing as incoming workspace activity, with no synthetic
sends from the probe. A later user-coordinated capture also received
`reaction_added`, `message_changed`, `message_deleted` and `channel_marked`.
Edits carried nested message identity; deletion target differed from outer event
ts. The same capture received file public/shared/created/change/thumbnail events,
channel updates, a huddle_thread message and sh_room_join. Event reception does
not verify transfer or native call participation. Reaction removal,
root/reply/broadcast variants, policy and presence events,
all HTTP writes and cross-actor permission checks remain pending.

## S05: reconnect, history gaps and concurrent reads

Disconnect only the probe client. While offline, the second actor sends a root
and reply, edits an old cached message, deletes a cached root/reply and removes
the first actor from one test room. Reconnect with a fresh RTM URL; arm live
events before reconciliation. Confirm that newer-than-last-ts reads alone miss
old edits/deletes, and demonstrate bounded full-interval repair.

Delay a history response while live edit/delete/membership events arrive.
Verify it cannot resurrect the old state or repopulate a removed room. Inject
duplicate/out-of-order fixtures and a logout/credential replacement mid-request.
Document repair coverage and remaining retention/permission gaps. No complete
durable replay is established by this investigation.

## S06: room inventory, reads, precision and quotas

Read `conversations.list` across all supported types with cursor pagination;
compare membership with `client.userBoot` plus `im.list`. Keep directory and
joined roster separate. Inspect `client.counts` shapes and compare badges with
the official UI; check approximate versus exact totals. Read users, members,
emoji, history, profiles and in-room search with bounded limits.

Fetch at least two history pages in a test room and preserve six fractional
digits in `ts`. Fixture-test two messages inside the same millisecond, identical
ts values in different channels, exclusive bounds, empty pages with continuation,
and paginated fetch-message lookup. Compare server `has_more` and cursor rather
than assuming the requested page size was honored. Verify private/archived and
retention-limited room handling.

The ledger records actual read-method acceptance and page metadata for this
workspace. Initial room history samples were empty; freshest activity produced
three channel and two DM messages with six fractional digits, and a second
channel page was strictly older than the exclusive boundary. The DM response
was `is_limited:true`; the reason was not measured. Search returned no matches.
Nonempty replies verified root identity and exact timestamps. Do not count an
empty-array precision assertion as a pass. Full-room enumeration,
installed history/search-result rendering, microsecond boundary
cases and all conversation types remain qualification work.

## S07: mutations, rights and delivery uncertainty

In the test channel, exercise `chat.postMessage`, `chat.update`, `chat.delete`,
reactions, pins, stars/favorites and conversation create/join/leave. Use an
ordinary member and restricted policy; verify capability does not grant authority.
Record request field names and scrubbed successful/error response shapes.

Drop the post response after server commit and crash before local confirmation.
Test repeated identical text from the same author. Qualify `client_msg_id`
acceptance, response/history/event echo and duplicate submission independently;
if trying metadata, qualify its permissions and payload restrictions. Never
declare author+text a unique receipt. Repeat edit from a second client and a
lost delete response. Unknown delivery must not cause an automatic duplicate.

The probe client made no HTTP mutation. User-generated edit/delete/reaction
events were observed in RTM; that does not verify our mutation requests or
lost-response settlement. All idempotency guarantees remain proposed invariants.

## S08: threads, reads, Saved and preferences

Read `conversations.replies` and `subscriptions.thread.getView` with
`limit=3&priority_mode=all`. For the latter inspect `threads`, `root_msg`,
`has_more`, `max_ts`, and actual channel/read fields. Its reference pagination
uses `current_ts=<previous max_ts>`, not a generic next_cursor; qualify before
freezing the adapter. Read `saved.list`, `stars.list`, profiles/prefs.

With a test actor/room, separately mark room and thread read; follow/unfollow a
thread; save/unsave a message; favorite/unfavorite a channel; pin/unpin; change
one reversible own profile field and restore it. Verify official-client state
and events. A Saved item does not prove conversation favorite support.
The ledger's read acceptance does not verify these mutations.

## S09: media, blocks, links and protected transfer

Upload tiny synthetic image/audio/text/video files into the designated test
room/thread. Freeze the get-upload-url, raw-byte and completion shapes without
signed URLs. Interrupt each phase, especially after completion commit; find the
share by persisted file ID. Test a partial batch and cancel/orphan handling.
Download via qualified private URLs, including redirects and Range, without
sending credentials to external thumbnail/unfurl hosts. Compare playback on
all platforms and voice-file versus native Slack voice-clip metadata.

Read synthetic mrkdwn/rich_text/attachments/cards/custom-emoji fixtures and
authorized permalink resolution; test mentions, escaping, alias cycles,
unknown blocks and unsafe links. Interactive cards and slash commands require
their own harmless fixture/command. No upload/download or card action was run
by the probe client. User-generated file-share and lifecycle events were
observed in RTM, but reservation/transfer/completion/download remain untested.

## S10: rate limits and degraded mode

Record observed `Retry-After` and method scope during normal bounded requests.
Do not flood Slack to discover a maximum quota. Fake 429/5xx/HTML/401 responses
for queue and logout tests. Verify foreground requests continue when another
method is postponed. If RTM is denied, demonstrate paced open-room/count/thread
polling with explicit live/degraded status and reduced background work.
No session quota ceiling has been measured.

## S11: desktop importer and operating systems

Linux: probe native/Flatpak/Snap layouts, encrypted cookie versions, locked
Secret Service and SQLite/WAL consistency using an owned test Slack profile.
Windows/macOS: identify their actual formats and OS-authorized decryption path;
report unsupported rather than applying Linux crypto. Test no installed Slack,
locked credential backend and browser fallback. No desktop-app import was run.

## S12: identity, multiple workspaces and links

Use two selected workspace accounts, including Grid/Slack Connect if available.
Verify `auth.test` pinning, per-account stores/drafts/outbox/cache, cookie sharing
and reference deletion. Removing one workspace must not disable another.
Test Slack URL/rocketvibe URL parsing and exact message/thread navigation,
workspace rename, offline cold launch, wrong-account link and credential swap.
Only one workspace was validated in this investigation.

## S13: notifications and platform parity

Check live DM/mention notification, DND/mute policy, click and reply with an
installed GTK and SwiftUI client and foreground/background Android. Deduplicate
own events and bootstrap history; never notify old messages merely loaded.
Android killed-app delivery has no demonstrated Slack session push route;
record it missing, not passed because a foreground RTM socket works. Slack
huddles, E2EE, administration and reports stay unsupported/unqualified as in
the main matrix. No installed-client notification flow was tested here.

## Sources

- `docs/protocol/SLACK_SESSION.md`, `docs/protocol/slack-session-evidence.json`
- `apps/mobile/lib/provider.ts`, `apps/mobile/lib/normalize.ts`, `apps/desktop/crates/rv-core/src/native.rs`
- Pinned external sources linked in the main protocol document.
