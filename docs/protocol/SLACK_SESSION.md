# Slack session provider protocol and implementation handoff

Date: 8 October 2026. Status: researched design, **no Slack provider implemented**.
Scope: Session mode, using a user's `d` cookie and a workspace `xoxc-` token.
Destination: the existing Android, GTK and SwiftUI interfaces, with as much
Rocket.Chat / RocketVibe feature parity as Slack permits.

Start with this document, then run [the qualification probes](SLACK_SESSION_PROBES.md).
The [evidence ledger](slack-session-evidence.json) records what was actually
checked. The native server's [P01-P23 matrix](PARITY.md#full-backlog) supplies the
feature inventory; this is a separate provider contract, not an extension to
the RocketVibe server API.

## 1. Evidence and the RTM decision

Evidence labels throughout this document:

- **L**: live result obtained in this investigation, with authentication context recorded.
- **R**: behaviour present in the pinned reference's source, not reproduced here.
- **D**: Slack's published API contract. It does not guarantee session-token access.
- **P**: RocketVibe implementation proposal, awaiting the named qualification.
- **U**: unresolved session behaviour; do not advertise its capability yet.

The reference is [punarinta/make-slack-great-again](https://github.com/punarinta/make-slack-great-again)
at commit **`a71c460c2df0db097b9748c80a7a1b75200dfba9`**, inspected on this date.
RocketVibe's inspected base is **`55115b26495f6ff097ec5f6239528f519ba6a37b`**.
The user identified a signed-in Firefox session and selected its workspace.
Narrow read-only probes used that session, without recording credentials,
workspace identifiers or message/profile values. Acquisition through a product
Chromium helper, desktop import, mutations and deliberate event coverage remain U.

**R:** `rtm_presence.cpp` calls `rtm.connect` with session credentials, then puts
`Cookie: d=<value>` on the WebSocket upgrade. Its handler consumes `hello`,
`pong` and `error`, and discards application events. The accompanying header
describes an `invalid_auth` error and socket closure when that cookie is missing.
The reference's read backend still polls the open conversation every five seconds
and counts every ten seconds. Its socket therefore coexists with polling;
the README's description of message polling is consistent with delivery in code.
The documentation's broader assertion that session mode has no live channel
misses the presence socket. [Reference RTM source](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/rtm_presence.cpp#L111),
[header](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/rtm_presence.h),
[setup guide](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/docs/SETUP_SLACK.md).

**D:** Slack still describes `rtm.connect`, including a socket URL valid for
30 seconds, and explicitly excludes new Slack apps from RTM. Its published
contract does not establish support for `xoxc` plus `d`.
[Slack RTM method](https://docs.slack.dev/reference/methods/rtm.connect/).

**L:** `auth.test` and `rtm.connect` accepted the derived token plus cookie in
the selected workspace. The cookie-bearing socket received `hello` and four
pongs over 45 seconds. A fresh socket URL opened without the cookie produced
an `error` frame with numeric code 401, no hello/pong, and closed after about
5.2 seconds. Token-only `auth.test` returned `invalid_auth`. This independently
confirms the credential pairing and upgrade-cookie requirement on this session.
That first passive interval contained no application message events. A second
150-second cookie-bearing capture received **two `message` frames, two
`user_typing` frames, one `badge_counts_updated`, one `activity` and 14 pongs**.
Before/after `client.counts` snapshots showed one changed channel and one changed
DM. The user also reported incoming channel and private messages. No content or
channel IDs were retained, so the ledger reports frame counts and activity changes
without asserting individual frame-to-room correlation. Basic live message and
typing reception are measured. In a subsequent capture, user-generated activity
also produced `reaction_added`, `message_changed`, `message_deleted` and
`channel_marked`. The edited payload supplied nested `message.ts` and `edited`;
the deletion's `deleted_ts` differed from its outer `ts`. Reaction removal,
thread variants and reconnect/offline recovery remain U. The probe client sent
only reads and liveness pings; the user generated the test actions in Slack.
That capture also received file lifecycle/share events, channel updates, a
`huddle_thread` message and `sh_room_join`. This measures event reception;
file-transfer requests, media playback and native huddle participation are untested.

**P:** use Web API for actions and the measured cookie-authenticated RTM route
as the primary listener. S04-S05 must still qualify its full event/recovery
coverage. Keep bounded reconciliation and a degraded polling mode. Do not
implement Socket Mode, app registration or OAuth as the
authentication route for this provider. A usable session socket is credible
source evidence, not proof that every required event is delivered.

**L:** unauthenticated empty-form POSTs to `https://slack.com/api/auth.test` and
`https://slack.com/api/rtm.connect` returned HTTP 200 and
`{"ok":false,"error":"not_authed"}` on 8 October 2026 at approximately
20:48 UTC. This establishes an error envelope and endpoint reachability only.
It says nothing about session acceptance. See the ledger for timings and headers.

## 2. Session identity, storage and lifecycle

`d` is an HttpOnly browser session cookie whose value begins with `xoxd-`.
`xoxc-` is the web client's workspace API token. Derivation here means obtaining
the token from Slack's authenticated boot data, not computing it cryptographically.
The reference can reuse one cookie for several workspace tokens; validate each
workspace independently. Do not assume that a cookie covers every account in
an Enterprise Grid installation. **R/U**, probes S01-S02/S12.

Proposed private credential record, in the platform credential vault:

```text
SlackCredentialV1 {
  version: 1,
  credential_group_id: locally generated identifier,
  workspace_id: team_id returned by auth.test,
  enterprise_id: optional,
  user_id: user_id returned by auth.test,
  workspace_origin: validated HTTPS workspace URL,
  cookie_d: original cookie bytes,
  api_token: validated xoxc token,
  acquired_by: browser | desktop_import | manual,
  validated_at: local date
}
```

This is P, not a current DTO. Use `(slack, team_id, user_id)` as the durable
account identity; URLs and workspace names can change. Preserve any Enterprise
identity separately. Cache / outbox / drafts must remain isolated by this key.
Keep the exact cookie value, including percent encoding. Reject CR/LF and cookie
delimiters rather than accepting an arbitrary Cookie header. Never decode and
encode it again, store it in SQLite, or expose it to the UI / FFI logs.

Use existing SecureStore on Android and the desktop OS credential backends.
If the vault is locked, return a recoverable locked state; do not silently fall
back to plaintext. A shared cookie record has explicit account references:
removing one workspace drops that reference; removing the last one deletes it.
Deletion also cancels pending credential-bearing work, closes sockets and clears
the account's protected cache. Replacing credentials is atomic and advances a
local credential generation so old requests cannot repopulate a removed account.

```text
acquire -> discover candidate workspaces -> derive token -> auth.test
        -> select validated workspaces -> vault commit -> connect -> reconcile
existing credentials -> auth.test -> connect
token invalid, cookie possibly valid -> one bounded re-derivation -> auth.test
session rejected -> reconnect login prompt, account data kept according to policy
local remove -> close / cancel / erase local credentials and protected cache
```

There is no documented OAuth refresh-token exchange for this route. The
reference does not rotate session tokens. Do not describe them as immortal:
logout, account restrictions or Slack changes can invalidate access. Separate
removing RocketVibe's local connection from revoking a Slack session elsewhere;
the latter can affect the browser / other workspaces and needs a distinct action.

## 3. Acquiring credentials

### 3.1 Throwaway Chromium profile, primary desktop route

**R:** `browser_login.cpp` launches a detected Chromium-family executable with
a fresh user-data directory and a DevTools connection. It reads
`Storage.getCookies`, finds `d`, and reads `localConfig_v2` from localStorage
on the Slack web client. `session.cpp` validates a token from that configuration
or derives one from a workspace boot page.
[Browser source](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/browser_login.cpp#L260),
[session source](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/session.cpp).

Independent implementation steps (**P**, S01):

1. Discover Chrome / Chromium / Edge / Brave / Vivaldi through platform APIs.
   Create a fresh private directory; do not use the person's normal browser profile.
2. Launch an interactive sign-in at Slack, retaining the child-process handle.
   Use a DevTools pipe if available, otherwise an ephemeral loopback-only port.
   User-entered SSO, MFA and device approval stay in the browser.
3. Read cookies via privileged CDP, not `document.cookie`. Restrict acceptance
   to exact `slack.com` or dot-boundary subdomains; `evilslack.com` is not Slack.
   Collect candidate workspace hosts from targets and validated configuration.
4. On a Slack-owned web-client target only, use CDP `Runtime.evaluate` with
   `window.localStorage.getItem('localConfig_v2')`, returned by value. Parse
   `teams` records for workspace ID, name, URL, token and icon. This storage key
   is an internal format, not a permanent Slack contract. Validate all tokens.
5. If configuration is unavailable, the handoff URL / observed workspace host
   can supply a candidate for boot-page derivation. If no host can be resolved,
   ask for the workspace address in the native login screen.
6. Validate selected workspace identities, commit secrets to the vault, then
   close the owned browser process, close CDP and delete that exact temporary
   profile after process exit. Cancellation, crashes and timeouts also clean up
   only profiles RocketVibe created; a startup sweep handles abandoned directories.

Handle Slack's `slack://` desktop handoff within that temporary profile so it
does not divert sign-in. The reference has profile-specific handling. Its
`--remote-allow-origins=*` flag is a source detail, not a requirement to expose
DevTools beyond loopback. Never log CDP messages containing cookies, storage
or boot data. Browser login is a temporary helper; the product UI remains native.

### 3.2 Import from the Slack desktop app

**R:** the reference importer is Linux-only. `local_import_none.cpp` reports
`unsupported_platform` elsewhere. Its Linux implementation checks native,
Flatpak and Snap Slack configuration directories, `Network/Cookies` then
`Cookies`, and workspace hosts under `Local Storage/leveldb`.
[Linux importer](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/local_import_linux.cpp),
[unsupported-platform implementation](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/local_import_none.cpp).

Its older Chromium `v10` / `v11` format uses AES-128-CBC, a 16-space IV,
PBKDF2-HMAC-SHA1 with salt `saltysalt`, one iteration and a 16-byte key.
`v10` uses `peanuts`; `v11` obtains its password from Secret Service. Newer
cookie metadata can prepend a host SHA-256 binding. These are Linux format
observations, not Windows or macOS decryption instructions.

**P:** add Linux import as an optional shortcut with read-only snapshot handling
for SQLite / WAL consistency and bounded keyring access. Parse LevelDB with a
format-aware reader; a byte scan can suggest hosts but cannot authorize a team.
Return `not_installed`, `locked`, `decrypt_failed`, `no_cookie` or
`unsupported_platform` and offer browser sign-in. Do not modify Slack's profile.
**U:** Windows DPAPI / newer encryption and macOS Keychain import need separate
OS/version probes. Do not transplant Linux crypto or promise desktop import
there. Browser sign-in remains the primary route on all desktop OSes. S11.

### 3.3 Android acquisition

**P/U:** mobile consumes the same session protocol, but the desktop CDP flow
does not establish a mobile login route. Custom Tabs do not expose their cookies
to RocketVibe. An embedded WebView conflicts with the native-component rule.
An initial mobile path can accept a workspace and manually supplied session
credential in a native private form, or a separately designed authenticated
desktop-to-phone transfer. No transfer exists today; it must protect secrets,
bind the recipient and expire. Qualification S01 records this platform debt.
Mobile cannot claim seamless sign-in until that route is implemented and tested.

## 4. Token derivation and HTTP contract

**R/L:** GET the normalized `https://<workspace>.slack.com/` with
`Cookie: d=<original value>`, following the workspace boot redirects. The
reference looks for a JSON `api_token` beginning `xoxc-`, then any matching run
in the boot page, and validates it with `auth.test`. This investigation obtained
a keyed token from the selected workspace's HTTP 403 boot page and validated
it successfully. `https://app.slack.com/client` returned HTTP 200 without a
keyed token in its page. Keep the workspace-root fallback.

**P:** allow only validated Slack HTTPS hosts, bound redirect count, response
size and timeout, and re-evaluate credential eligibility on every hop. Never
forward `d` to an SSO provider or unrelated host. Parse an identified boot JSON
token first; a broad token search is a compatibility fallback that must be
confirmed by `auth.test` and the expected team/user. Do not execute downloaded
HTML, accept an arbitrary URL, or log the body. A login page / absent token
means reauthenticate. HTML failure does not itself revoke unrelated accounts.

Baseline session Web API request (**R**, S02):

```http
POST /api/auth.test HTTP/1.1
Host: slack.com
Authorization: Bearer <workspace xoxc token>
Cookie: d=<original xoxd cookie value>
Content-Type: application/x-www-form-urlencoded; charset=utf-8

```

The reference defaults to `https://slack.com/api/` and can use a per-workspace
base. Start with the default, pin the workspace with `auth.test`, and qualify
alternative bases only if required. The response must have `ok: true`, the
expected `team_id` and `user_id`; `url` identifies the workspace origin.
Store neither a workspace display name nor a URL as the account identity.
`team.info` supplies optional metadata / icon. L, S02. In controls, the token
without its cookie returned `invalid_auth`, and the cookie without the token
returned `not_authed`, both at HTTP 200.

The reference sends all methods as form-encoded POSTs with both headers.
Arrays / structured arguments are serialized JSON strings inside the form.
Use one authenticated transport for HTTP; this does not automatically attach
the cookie to a WebSocket or to raw file transfer.
[HTTP source](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/web_api.cpp#L89).

### Errors and quotas

| Result | Proposed provider behaviour |
|---|---|
| HTTP 200, `ok:false` | Decode `error`; never treat HTTP success as operation success. L/R/D |
| `not_authed`, `invalid_auth`, `token_expired`, `token_revoked`, `account_inactive` | Validate account context, attempt bounded re-derivation when appropriate, then request session sign-in. `invalid_auth` can also mean network policy. R/D/P |
| `missing_scope`, `not_allowed_token_type`, `unknown_method`, `method_deprecated`, `no_permission` | Method / account / room restriction; disable the affected action, not all credentials. R/D/P |
| `org_login_required`, migration / restricted workspace | Surface workspace-specific state; keep other workspaces independent. D/P |
| HTTP 429 or `ratelimited` | Preserve `Retry-After`; postpone that method/workspace lane and add jitter. R/D/P |
| HTML, proxy 401/403, bad JSON, TLS / timeout / 5xx | Transport problem, not proof of revoked Slack credentials. Bounded retry for reads. P |
| Ambiguous mutation response | Reconcile the original intent; do not blindly replay a send, file completion or slash command. P |

Expose the existing neutral `ProviderError` fields (`code`, `status`,
`requestId`, `retryAfter`, `rejectsSession`, `twoFactorChallenge`). Slack browser
MFA is completed before credentials exist; do not feed it into RC TOTP handlers.
Retain an optional Slack request ID for diagnostics without bodies or credentials.

**D:** Slack throttling is method/workspace scoped and signals delay through
HTTP 429. Published app-token history / replies limits vary with app distribution;
they are not a measured session quota. The reference's five-second polling is
not an entitlement to that rate. **P:** one paced queue per workspace/method,
foreground work before background scans, no parallel roster flood, honor observed
limits and adapt fallback polling. Probe without deliberately flooding Slack. S10.
[Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/),
[distribution-limit clarification](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/).

## 5. RTM session socket

Connection sequence (**R/D/L**, accepted in the selected session by S03):

```http
POST /api/rtm.connect HTTP/1.1
Host: slack.com
Authorization: Bearer <workspace xoxc token>
Cookie: d=<original value>
Content-Type: application/x-www-form-urlencoded; charset=utf-8

batch_presence_aware=1&presence_sub=true
```

Validate `ok`, `team.id`, `self.id` and the returned `url`. Open that WSS URL
immediately with **`Cookie: d=<original value>` on the HTTP upgrade**. The
reference does not add Bearer on that upgrade. Qualify the returned Slack
message-server hostname, including the observed `*.slack-msgs.com` family if
used; do not accept arbitrary hosts or follow off-domain redirects with `d`.
Keep the URL private even though the reference says the cookie authenticates it.

Wait for the JSON `hello` before reporting authenticated listening. An HTTP
101 or transport-open callback alone is insufficient. An `error` frame may
arrive after an apparently successful upgrade. For S03's cookie-free control,
request a fresh RTM URL rather than reusing the successful connection's URL.

| Frame | Required handling / status |
|---|---|
| `hello` | Arm the listener and release startup reconciliation barrier. R/D/P |
| `{"type":"ping","id":N}` sent; `pong` received | App-level liveness; match outstanding IDs, independent of WS control frames. R/D/P |
| `error` | Decode code/message; revalidate auth on rejection, no reconnect storm. R/P |
| `goodbye`, transport close, sleep gap | Close old generation, establish a fresh link, catch up touched state. D/P |
| `reconnect_url` | Private candidate for reconnect; validate host, never a durable replay cursor. D/P, session shape U |
| `presence_sub` sent with bounded `ids` | Subscribe to visible DM/member presence after hello; qualify batch event shape. D/P/U |
| `{"type":"typing","channel":"C...","id":N}` sent | Proposed outgoing typing; qualify delivery to a second client and any thread fields. D/P/U |
| `user_typing` received | Ephemeral indicator with local expiry, no durable message. D/P/U |
| `tickle` sent | Reference resets activity/auto-away this way. Internal R/U; only genuine foreground input by default. |

Proposed liveness policy: ping every 30 seconds; two unanswered probes make a
socket unhealthy. Use monotonic time; detect resume after sleep immediately.
One connect attempt at a time; a method quota and `Retry-After` override the
2-to-60-second exponential reconnect delay. Do not imply that creating a socket
forces the user active indefinitely. Presence and connectivity are distinct.
Holding a listening socket for deliveries while away must be tested separately
from the reference's policy of dropping its presence socket after idle time.

RTM JSON frames are direct events. Socket Mode's envelopes / `envelope_id` ACKs
are not this protocol. Do not wrap RTM as DDP on the wire. A native WebSocket
transport must be able to send Cookie headers: browser JavaScript WebSocket
cannot set them. Rust can build a handshake request; Android needs a qualified
native header-capable transport. Check actual React Native support before
choosing a bridge. Keep credentials inside the transport on all three apps.
[Slack legacy RTM](https://docs.slack.dev/legacy/legacy-rtm-api/),
[presence subscriptions](https://docs.slack.dev/reference/events/presence_sub/),
[typing](https://docs.slack.dev/reference/events/user_typing/).

### Live event mapping, basic reception measured, full coverage pending S04-S05

| RTM event / subtype | Local projection or follow-up |
|---|---|
| `message`, ordinary / bot / file share | Upsert by channel + exact message `ts`, resolve author/bot, render attachments and blocks. |
| `message_changed` | L shape: outer `channel,event_ts,hidden,message,previous_message,subtype,ts,type`; nested `message.ts` and `edited`. Replace nested message at its own ts; version separately. |
| `message_deleted` | L shape: outer `channel,deleted_ts,event_ts,hidden,previous_message,subtype,ts,type`; deleted_ts differed from outer ts. Tombstone deleted_ts. |
| `message_replied` | Refresh root metadata and loaded replies; do not count the root as another reply. |
| `thread_broadcast` | Same reply identity in thread and channel presentation, no duplicated message row. |
| `reaction_added` / `reaction_removed` | L added shape: `event_ts,item,item_user,reaction,ts,type,user`; item has `channel,ts,type`. Removed still U. Settle own optimistic intent exactly once. |
| `channel_marked` / `group_marked` / `im_marked` / `mpim_marked` | L channel shape: channel/ts/event_ts plus unread, mention, num_mentions, display variants and vip_count; other room variants U. Personal read state, not thread read state. |
| join / leave / create / archive / delete / rename / member / history-change events | Refresh affected roster/info or purge inaccessible room; unknown channel requires an authorized lookup. |
| `user_change`, profile / emoji / user-group / preference / star / pin events | Invalidate only corresponding caches; qualify exact payloads before relying on them. |
| `presence_change`, `dnd_updated_user` | Separate presence/DND state; support `user` and batch `users` shapes. |
| `file_public`, `file_shared`, `file_created`, `file_change`, `file_thumbnail_generated` | L received. Descriptor invalidation by file_id; file_shared carries channel_id, thumbnail event carries client_file_id/file_id and URL fields. Do not treat file_public as permission to fetch every URL without authorization. |
| `channel_updated` | L received fields channel/channels/updates/event_ts/type. Refresh info/roster; nested patch semantics still U. |
| `message/huddle_thread`, `sh_room_join` | L received huddle activity. Message carries room/permalink/metadata/no_notifications; join carries room/huddle/user/ts. Native call signaling/media remains U. |
| unknown event | Count type-only diagnostics; bounded dirty-state reconciliation for recognized resource IDs. No raw logging. |

The reference's Socket Mode event handler provides mapping examples, but its
RTM presence handler does not call that handler. Reusing its event assumptions
does not prove RTM coverage. [Reference event handler](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/slack_realtime.cpp#L238).

**L:** the captured direct `message` frames contained `type`, `channel`, `ts`,
`event_ts`, `team`, `source_team`, `user_team`, `user`, `client_msg_id`, `text`,
`blocks` and `suppress_notification`. `user_typing` contained `type`, `channel`,
`user`, `id`. `badge_counts_updated` carried `activity_v2`; an `activity` frame
had subtype `activity_updated` and fields `entry`, `key`, `event_ts`. These extra
activity events can invalidate badge state; freeze their nested adapters only
after further probes. A `suppress_notification` flag must survive projection
and participate in notification decisions.

## 6. IDs, history, rendering and recovery

### Identity and precision

**P:** preserve every Slack `ts`, `thread_ts`, `event_ts`, `deleted_ts` and
`last_read` as an exact decimal string, for example `1791486000.000001`.
Never use a floating-point timestamp or an ISO/millisecond conversion as a
request cursor or unique key. Define message ID as `channel_id + ':' + ts`
inside the account partition. Parent IDs use the same construction. Use integer
microseconds or a decimal comparator for ordering; milliseconds are display only.

Current mobile `LocalMessage.ts` and history interfaces use milliseconds.
Add a provider-owned exact-key table / column and an exact cursor path before
enabling Slack pagination. Two messages inside one millisecond must stay ordered
and both reachable; deriving a Slack `latest` from milliseconds loses precision.
Do not label Slack order as native RocketVibe `sequence`. Store version separately
from creation order and keep provider-owned tombstones against stale HTTP pages.

### Bootstrap and read methods

Core methods are D/R where listed. The live ledger records acceptance for the
specific requests executed; other variants and permissions remain U:

| Purpose | Method and important form fields | Projection / limits |
|---|---|---|
| Identity / metadata | `auth.test`; `team.info` | Pin team and user before data admission. |
| User directory | `users.list(limit,cursor)`; `users.info(user)`; `bots.info(bot)` | Paginate, on-demand lookup for unknown users/bots; use stable IDs. |
| Joined rooms and public discovery | `conversations.list(types,exclude_archived,limit,cursor)`; candidate `users.conversations` | Distinguish directory from joined roster; all pages before authoritative removal. |
| Session roster fallback, internal | `client.userBoot(min_channel_updated=0)` plus `im.list(get_latest=true,get_read_state=true,limit,cursor)` | Reference fallback; channels and DMs need both families. MPIM/Slack Connect completeness needs S06/S12. |
| Room info / membership | `conversations.info(channel)`; `conversations.members(channel,limit,cursor)` | Membership and policy, never infer privacy from ID prefix alone. |
| Root/history page | `conversations.history(channel,limit,latest,oldest,inclusive,cursor)` | Newest-first history; preserve response cursor, `has_more` and exact bounds. |
| Thread page | `conversations.replies(channel,ts,limit,cursor,oldest,latest,inclusive)` | Root appears with replies; deduplicate it and normalize parent links. |
| Single-message lookup | `conversations.history(channel,latest=<ts>,inclusive=true,limit=1)`, then exact-match; thread fallback | No generic RC `chat.getMessage`; wrong `ts` is not success. |
| Session activity, internal | `client.counts` | `channels`, `ims`, `mpims`; latest/read/mention indicators, not exact total unread count. |
| Followed threads, internal | `subscriptions.thread.getView(limit=3,priority_mode=all,current_ts?)` | L read: `threads[{root_msg,latest_replies}]`, `has_more`, `max_ts`, `new_threads_count`, `total_unread_replies`; root message carries channel/ts. Reference continues using previous max_ts as current_ts; pagination still U. |
| Custom emoji / mention groups | `emoji.list`; `usergroups.list(include_users=true)` | Resolve aliases with cycle/depth bounds and stable group IDs. |
| Pins / saved state | `pins.list(channel)`; `saved.list` internal; `stars.list` legacy | Qualify Saved versus star semantics; channel favorite is not a saved message. |
| Search | `search.messages(query,count,page,sort,sort_dir)` | Escape `in:` filtering, preserve actual channel/ts, temporary results. |
| Profile / preferences | `users.profile.get(user)`; `users.prefs.get`, `team.prefs.get` internal | Separate private own preferences from directory data. |
| File descriptor | `files.info(file)` | Refresh protected URLs / share state; no URL as file identity. |

**L:** paired credentials were accepted by `team.info`, `conversations.list`,
`client.userBoot`, `client.counts`, `emoji.list`, `users.profile.get`, `users.list`,
`users.prefs.get`, `usergroups.list`, `stars.list`, `saved.list`,
`subscriptions.thread.getView`, `commands.list`, `conversations.info`,
`conversations.members`, `conversations.history`, `pins.list`, `search.messages`
and `conversations.replies`, and `im.list`. The first roster/users/DM pages had continuation.
Replies returned three nonempty message objects including `client_msg_id`,
`thread_ts`, `last_read` and thread metadata. This does not prove accepted or
idempotent outgoing `client_msg_id`. A follow-up replies page confirmed root
identity and six-digit decimal timestamps on three returned messages. Initial
room history samples were empty. Targeting the freshest activity returned three
channel messages and two DM messages with exact decimal `ts`; an exclusive
`latest` request returned three strictly older channel messages. The channel
page supplied continuation, while the DM page had `is_limited:true`. These are
bounded transport observations, not installed renderer qualification or complete
history access. The sampled search was accepted but returned no matches;
that validates the request/envelope, not search-result projection.

**L:** `client.counts` channel/DM entries included `id`, `latest`, `last_read`,
`has_unreads`, `mention_count`, `history_invalid`, `updated`; `threads` included
`has_unreads` and `mention_count`. `commands.list.commands` was an object keyed
by command, not an array. `saved.list` returned `saved_items` and `counts`.
Keep internal-method adapters separate and validate shapes rather than assuming
the public method conventions apply.

`client.userBoot`, `client.counts`, `im.list`, `saved.*`, `subscriptions.thread.*`
and prefs routes are version-sensitive session compatibility adapters. A method
name in the reference is not a frozen response schema. Qualify them individually
and provide a useful degradation if unavailable. The reference's `client.counts`
mapper uses mention counts, DM counts and a boolean unread indicator; do not
display that boolean as an exact numeric unread total.
[Reference reads](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/slack_backend.cpp#L776),
[counts mapping](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/slack_json.cpp#L772),
[history](https://docs.slack.dev/reference/methods/conversations.history/),
[replies](https://docs.slack.dev/reference/methods/conversations.replies/).

### Recovery guarantees

There is no established Slack equivalent of the native provider's durable
`/sync/changes` journal and cursor. RTM event timestamps do not provide replay.
Opening RTM does not prove recovery of edits/deletions during disconnection.

**P:** arm RTM after `hello`, buffer incoming events, obtain bounded bootstrap
reads, then drain with version-aware writes. Old-generation reads cannot overwrite
new socket edits, resurrect tombstones or recreate a room after lost membership.
Paginated history is not a snapshot; record the request generation and protect
socket-touched IDs during overlap. For edits without a comparable revision,
refetch touched IDs after bootstrap rather than inventing an ordering guarantee.

On reconnect, refresh roster/counts, the open room, open thread and dirty rooms
first. Scan cached ranges to repair missed edits and deletions. Newer-than-latest
history misses changes to older messages. Only infer a deleted cached ID from
absence when its complete authorized interval has been read and proved complete;
never from a truncated/failed page, retention-limited history or lost membership.
If completeness cannot be proven, mark coverage partial and refresh on demand.
**L:** one nonempty DM history response had `is_limited:true`. Respect that
coverage restriction independently of `has_more:false`; it cannot prove that
every older cached ID omitted by the response was deleted. The reason for the
restriction was not separately measured.
No all-room history loop on each reconnect, no claimed complete archival sync.

Fallback polling is P, informed by R cadences: visible open room ~5 seconds,
counts ~10 seconds, open/followed threads ~20 seconds, hidden open room ~60 seconds,
one background conversation ~2 minutes, always paced and quota-adjusted. With
qualified message RTM, reduce these to repair checks. Keep server-confirmed badge
snapshots separate from optimistic unread estimates. S05/S06/S10 establish bounds.

### Rendering

Normalize Slack `text`, `mrkdwn`, `rich_text` blocks, attachments, bot authors,
files, unfurls and system subtypes into native existing renderers. Keep bounded
provider content and derive render trees; never request an HTML/WebView UI.
Decode Slack `<@U...>`, `<#C...|label>`, `<!here>`, `<!channel>`, `<!everyone>`,
subteam references and `<url|label>` structurally. Preserve display labels,
escape literal angle brackets, honor unsafe-link guards and resolve IDs locally.
Outgoing mentions use Slack IDs, not Rocket.Chat usernames. Unknown blocks get
an accessible text fallback; interactive buttons stay disabled until the action
contract is qualified. Do not execute arbitrary `blocks.actions` payloads.

Reactions retain server `count` independently of the possibly truncated users
array. Custom emoji aliases can chain; invalidate catalog on qualified events.
Quote parity is a Slack permalink with optional bounded native excerpt, clearly
different from a server-validated RocketVibe quote reference. `chat.getPermalink`
is the D candidate; channel + exact ts still backs internal navigation. Decode
Slack links using account/team identity and preserve message/thread precision.
[Slack message object/events](https://docs.slack.dev/reference/events/message/).

## 7. Actions and persistent intents

Fields below are D/R candidates; xoxc permissions and lost-response behaviour
need S07-S09. Each intent is account- and credential-generation-bound, persisted
before HTTP, and checked against current membership/policy before new submission.
Expose unsupported actions through capability gating, never an RC fallback.

| Action | Wire method / fields | Settlement |
|---|---|---|
| Send root / reply | `chat.postMessage(channel,text,thread_ts?,reply_broadcast?)` | Confirm returned channel/ts/message; own RTM echo merges same row. |
| Edit | `chat.update(channel,ts,text)` | Own message and workspace policy; replace content only after valid response or confirmed read. |
| Delete | `chat.delete(channel,ts)` | Tombstone only target; `message_not_found` alone does not prove previous delivery/deletion. |
| React | `reactions.add/remove(channel,timestamp,name)` | Desired-state intent; `already_reacted` / `no_reaction` can settle corresponding state after qualified semantics. |
| Pin | `pins.add/remove(channel,timestamp)` | Shared room pin, constrained by effective authority. |
| Save message, internal | `saved.add/delete(item_type=message,item_id=<channel>,ts)` | Personal Saved state; qualify listing/removal, legacy stars only if equivalent. |
| Favorite conversation | `stars.add/remove(channel)` | Distinct from saved message; verify with `stars.list`. |
| Mark room read | `conversations.mark(channel,ts)` | Coalesced observed exact ts, never mark beyond displayed content. |
| Mark thread read, internal | `subscriptions.thread.mark(channel,thread_ts,ts)` | Separate read cursor; fallback local-only state must be labelled as debt. |
| Open DM | `conversations.open(users=<uid(s)>)` | Use returned conversation ID; qualify repeated calls / group DMs. |
| Create / join / leave | `conversations.create(name,is_private)`; `conversations.join(channel)`; `conversations.leave(channel)` / `conversations.close(channel)` for DM | Lost create response needs lookup; never assume client operation idempotency. |
| Room topic / purpose / name / invite / kick | `conversations.setTopic/setPurpose/rename/invite/kick` with documented fields | Probe policies; Slack room roles do not equal RC owner/moderator/member. |
| Profile / avatar / presence / DND | `users.profile.set(profile=<JSON>)`; `users.setPhoto` multipart; `users.setPresence(presence=auto|away)`; `dnd.setSnooze(num_minutes)` / `dnd.endSnooze` | Split supported fields from email/password/account-security settings. |
| Slash command, internal | `chat.command(channel,command,text)`; `commands.list` | One explicit execution, private reply handling; no automatic ambiguous retry. |

### Lost send response

The reference reconciles matching author/text in recent history. That can confuse
two identical messages; RocketVibe must not adopt it as a proof of exactly-once
delivery. **P/U:** qualify whether `client_msg_id` is accepted, echoed and deduped
for this session route, or whether a suitably scoped metadata marker is available.
Persist any chosen marker and exact target before submission. Marker presence
does not itself promise deduplication. If no reliable correlation exists, leave
the intent **delivery unknown** after ambiguous failure, read history/RTM, and
let the user explicitly resend with the duplication risk visible. A negative
bounded read cannot prove an in-flight write will never commit. S07.

Drafts are local per account/room/thread. Offline text sends can queue, but
membership changes stop new submission and expired credentials require login.
Reactions/pins/read/favorite intents coalesce desired state; edits retain their
base version and avoid silently overwriting an edit from another client.
[Reference actions](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/slack/slack_actions.cpp#L412),
[Slack send method](https://docs.slack.dev/reference/methods/chat.postMessage/).

### Files, images, video and voice notes

Use the current external-upload sequence, not deprecated `files.upload`:

1. `files.getUploadURLExternal(filename,length)` with token + cookie -> `file_id`,
   `upload_url`. Persist the ID and state before transferring bytes.
2. POST raw bytes (or the documented multipart representation) to the returned
   HTTPS upload URL. The reference sends no token/cookie to this presigned URL.
   Validate its origin separately and never attach credentials indiscriminately.
3. `files.completeUploadExternal(files=[{"id":"F...","title":"..."}],
   channel_id=<channel>,initial_comment?,thread_ts?)` with token + cookie.
   Persist **completion submitted** before the request; it is a one-shot boundary.
4. Locate the resulting share message via qualified RTM / `files.info` / room or
   thread history using the persisted file ID(s), then settle the outbox row.

**D:** completion is callable once; without completion Slack discards the upload.
**R:** the reference avoids re-submitting completion and looks up the share in
history. **P:** after a lost response, keep completion unknown and reconcile the
same IDs; never allocate another file automatically. The response contains file
objects, not necessarily a message timestamp. Stream from disk with progress,
size limits, cancellable transfer and explicit orphan cleanup semantics. Partial
multi-file batches cannot silently mark all selected files delivered. S09.
[Upload reservation](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/),
[completion](https://docs.slack.dev/reference/methods/files.completeUploadExternal/).

Private downloads use Slack file descriptors and a qualified token/cookie policy
for each protected origin, including redirects. Public avatars / emoji / link
images get no session headers. Cache by account/file ID/version and revoke access
on logout or membership loss. Support HTTP ranges only where measured. Voice
notes can initially be audio-file attachments; that does not establish Slack's
specialized native voice-clip metadata or transcription parity. S09.

## 8. Provider parity target and explicit limits

This table maps every existing P01-P23 family. `candidate` means a method/source
exists, not that the RocketVibe feature is delivered. All Slack cells for Android,
GTK and SwiftUI are currently **missing**; the researched provider row is in
`brain/parity.md`. Each shipped increment must update those platform cells and
retain provider-specific limitations below. Runtime flags stay false until tested.

| Family | Slack target / likely mechanism | Evidence and remaining debt |
|---|---|---|
| P01 Login / sessions / devices | Browser session acquisition, derive/validate; local account removal | R candidate; S01/S02/S11. No native password/TOTP form, OAuth renewal or proven Slack session-device management. |
| P02 2FA / recovery / verified email | Delegate login MFA, SSO and recovery to Slack browser | P mapped login flow after qualification; no RocketVibe account-security management on Slack. |
| P03 Multiple servers/accounts | Multiple workspace tokens and separate stores, shared cookie references | R/P candidate; S12, mobile account model and team-pinned links need extension. |
| P04 Channels / private groups / DMs / members | Conversations methods, session roster fallback, group DMs, discovery/join | D/R candidate; S06/S12; create/settings/roles policy must be measured. |
| P05 Favorites / unread / mentions | Conversation stars, read marks, counts; ID-based mentions | R candidate; S06/S08; counts can be approximate, Saved is separate. |
| P06 History / live / offline | Exact-ts paging, RTM events, bounded repair and local cache | L messages/typing/edit/delete/reaction-add/read events, precise channel/DM history, older channel page and replies; event variants, complete paging and recovery still open; limited DM history observed, no proven durable replay. |
| P07 Markdown / emoji / quotes | Slack mrkdwn / rich_text adapter, custom emoji, permalink excerpt | D/R/P candidate; S06/S09; no authenticated native quote-reference contract. |
| P08 Send / drafts | Local drafts/outbox, chat.postMessage and reconciled own echo | D/R candidate; S07, ambiguous delivery must remain explicit. |
| P09 Edit / delete | chat.update/delete, changed/deleted event mapping | L received edit/delete shapes; HTTP mutations remain D/R candidate, S05/S07; restrictions and stale-read arbitration untested. |
| P10 Reactions / pins / stars | reactions.*, pins.*, saved.* and conversation stars | L reaction-added event and pins/Saved reads; HTTP mutations/removal remain D/R candidate, S07/S08; own-event races untested. |
| P11 Threads | replies, thread_ts, broadcast, session thread read/view | D/R candidate; S04/S08; follow/list commands and root/reply deletion recovery unresolved. |
| P12 Presence / typing / @here | Cookie RTM, presence subscriptions, typing, foreground activity | L incoming typing, hello/pong; R/D candidate for other presence/outgoing typing; S04, idle policy and peer verification. |
| P13 Search | search.messages, room filter, native temporary rendering | D/R candidate; S06; plan/retention/policy restrictions. |
| P14 Files / images / video / audio | External upload + protected media and native readers | L file-share/lifecycle event shapes, D/R transfer candidate; S09; voice-clip metadata, transfer/range/codec/limits unresolved. |
| P15 Links / integration cards | Slack unfurls and bounded blocks rendered natively | D/R/P candidate; S09; app interactions internal/unqualified, no HTML renderer. |
| P16 Profiles / preferences / avatars | Profile reads/set/photo, own session prefs, local app settings | D/R candidate; S08; field policy, avatar removal and account credentials unresolved. |
| P17 Notifications / push | OS notification for qualified RTM DM/mention while running | P candidate; S04/S13. Killed-app Android FCM/APNs route unavailable in this design; push=false. |
| P18 Rocket.Chat E2EE | No compatible Slack room encryption/key exchange | Unsupported; e2ee=false. Slack EKM is not client E2EE. |
| P19 RocketVibe E2EE / archive / control / storage keys | No compatible native MLS protocol in Slack | Unsupported; do not advertise encrypted Slack messaging or portable native history. |
| P20 Calls / Jitsi / LiveKit voice | Native Slack huddles protocol not established; reference displays a huddle pill opening a URL | L huddle_thread/sh_room_join events, R external handoff, U native media; videoCall=false, voice=false. |
| P21 Sharing / links / notification navigation | Native share/drop, Slack permalink and exact team/channel/ts navigation | P candidate; S09/S12/S13; account selection and cold launch. |
| P22 Languages / accessibility / ergonomics / updates | Existing native interfaces and app translations | P reuse; installed checks on Android, GTK and SwiftUI; no provider-specific UI kit. |
| P23 Administration / reports / moderation | No measured equivalent client administration API | U/unavailable initially; administration=false, reports=false; private ordinary session is not admin scope. |

The reference advertises `huddles` but its sidebar click opens `huddleJoinUrl`
through `openUrl`; that source flag is not proof of native audio/video transport.
[Huddle link action](https://github.com/punarinta/make-slack-great-again/blob/a71c460c2df0db097b9748c80a7a1b75200dfba9/src/app/screens/shell/sidebar.cpp#L491).

Bots can be rendered as authors using `bots.info` / message `bot_id`; creating
and managing RocketVibe bot accounts/API keys has no corresponding session
contract here. Slash commands have a source candidate but can cause external
side effects, so qualification must use a designated harmless command. Reminders,
scheduled messages and canvases visible in the reference are optional later
Slack-specific work, not prerequisites for the shared parity inventory.

## 9. Where to implement in this repository

Current code supports only `rocketchat` and `rocketvibe`. The provider comments
mention future Mattermost, but there is no delivered Mattermost driver in the
inspected selectors. Do not mistake those comments for an implementation.

| Layer | Existing source seam | Required Slack increment (P) |
|---|---|---|
| Mobile account/session | `apps/mobile/lib/provider.ts`, `lib/auth.ts`, `lib/providerError.ts` | Add explicit `slack` kind, team identity and vault credential reference. Unknown persisted kinds must not fall back to RC. |
| Mobile construction | `apps/mobile/providers/index.ts`, `ui/sync.tsx` | Separate Slack HTTP/listener/client construction; current `RestClient` parameter is RC-shaped. |
| Mobile driver | `apps/mobile/providers/rocketchat/`, `providers/rocketvibe/` as patterns | New `providers/slack/`: auth, transport, listener, translation, history, actions, outbox, files, reads. No Slack fields added to RC wire requests. |
| Shared mobile projection | `apps/mobile/lib/normalize.ts`, `lib/provider.ts`, `db/schema.ts` | Exact-ts IDs/cursors/order/version and tombstones; normalized native presentation, `threadTemplate: 'tmid'` only as local adapter output. |
| Mobile secondary features | `lib/providerProfiles.ts`, `lib/providerEmojis.ts`, `lib/providerCalls.ts`, `ui/sync.tsx` | Route reads/typing/presence/media through provider; existing RC guards alone will hide Slack until adapted. |
| Desktop identity / dispatch | `apps/desktop/crates/rv-core/src/native.rs` (`ServerKind`), `session.rs`, `account.rs` | Explicit Slack kind and SlackSession; dispatch before RC/native login/probe; do not put Slack in the native RocketVibe protocol. |
| Desktop transport / state | `rv-core/src/store.rs`, `outbox.rs`, `native/` as separate-driver pattern | New `rv-core/src/slack/` with typed methods, Cookie upgrade, exact-key SQLite state and durable intents. |
| Desktop interfaces | `apps/desktop/crates/rv-ffi/src/`, `apps/desktop/crates/rv-gtk/src/`, `apps/desktop/macos/Sources/RocketVibeKit/` | Expose neutral identity, capabilities, login progress and errors; reuse native room/composer/menu/media views. GTK and SwiftUI share Rust protocol logic. |
| Native acquisition | Existing desktop OS helpers; mobile Expo module/config-plugin conventions | Desktop browser/import helper, mobile header-capable socket and acquisition path if required. Rebuild mobile dev-client for native additions. |
| Documentation | `brain/architecture/slack-session.md`, `brain/parity.md`, this contract | Move observed method/event status with code; each visible app change updates its English Unreleased changelog. |

`Listener` currently emits a neutral `{collection,eventKey,args}` envelope named
`DdpEvent`. Slack can adapt raw RTM events into it or the shared interface can
be renamed in a separate refactor; the wire remains RTM. Implement
`armedSubscriptions()` as the actual post-hello readiness barrier, not a timer.
Room subscriptions represent local interests/optional presence subscriptions,
not DDP `sub` frames. Attach buffered event ingestion before resolving readiness.

Capabilities: editing/deletion/files/threads/reactions/marks/profile/roomInfo/
roomFavorites/roomReads/customEmojis/search are candidates. Typing/presence need
socket qualification. RoomSettings/roomRoleList/leaveRoom and quotes require
per-feature semantic checks. `push`, `e2ee`, `videoCall`, `voice`, `administration`
and `reports` remain false. Optional combined flags such as `marks` cannot claim
pins and personal saves if one half is absent; split or gate granular actions.
Server permissions remain authoritative even after a capability is enabled.

## Current implementation increment (2026-10-09)

The first transient read-only preview is implemented for Android, GTK and SwiftUI.
The login icon unlocks experimental integrations after nine activations. Manual
paired credentials validate auth.test and page users.conversations/history;
message identity keeps exact timestamps. Browser acquisition, persisted accounts,
RTM, neutral local projection, writes and complete feature parity remain pending.
See [implementation and limits](../../brain/features/experimental-integrations.md).
The baseline statements elsewhere describe the researched checkout, not today's
selectors, which also contain Mattermost/kChat. Teams implementation remains queued.

## 10. Implementation batches and acceptance

| Batch | Deliverable | Evidence required before advertising it |
|---|---|---|
| S-A Auth/identity | Browser helper, Linux optional import, vault, kind dispatch, workspace selection, Android acquisition route | S01/S02/S11/S12; cancel/cleanup and expired-session tests on installed clients. |
| S-B Read/translate | Roster, users, precise history/thread keys, native rendering, local cache | S06/S08; paginated >1-page data, same-millisecond messages, unknown bots, private/Connect rooms, no RC transport calls. |
| S-C Listen/recover | Cookie RTM, hello/ping, messages/edits/deletes/reactions/typing/presence, degraded mode | S03-S05/S10; second actor, offline old edits/deletes, socket/read overlap and suspend/resume. |
| S-D Write | Text/thread outbox, edit/delete, reactions, marks, read/favorite state, room actions | S07/S08; crash/lost-response intents and repeated identical text, effective permissions. |
| S-E Media/profile/search | Files and native readers, quotes/links/cards, emoji, search, profiles, slash commands | S06/S08/S09; protected download redirects, one-shot completion, partial batches, unsupported block fallback. |
| S-F Platform qualification | OS notifications and links, three-app parity row updates, explicit unsupported features | S12/S13; installed Android/GTK/SwiftUI, account isolation and killed Android documented missing. |

Qualification that requires a Slack account can run separately from fixture
tests, but absence of it cannot turn U into delivered/verified status. Keep
fixtures synthetic or scrubbed: stable pseudonymous IDs, no real text, emails,
cookies, API tokens, signed upload URLs, WSS URLs or raw boot/CDP bodies.

Meaningful automated cases: invalid envelope without logout; Cookie present on
upgrade but absent on external transfer; expired RTM URL / error after 101;
microsecond pagination; edited/deleted nested IDs; own echo dedup; batch reactions
with count greater than users length; stale HTTP after RTM deletion; room removal
during bootstrap; unknown delivery after timeout; completion lost response;
emoji alias cycle; account/credential-generation cancellation; off-domain redirect.
Use fake HTTP/WSS servers for those invariants, then the real S probes for Slack
behaviour. Mobile checks run from `apps/mobile`; desktop builds run through the
Fedora container scripts. Documentation alone needs no app build/version bump.

## Sources

Local sources, relative to the repository root:

- `apps/mobile/lib/provider.ts`, `apps/mobile/lib/auth.ts`, `apps/mobile/lib/normalize.ts`, `apps/mobile/lib/providerError.ts`
- `apps/mobile/providers/index.ts`, `apps/mobile/providers/rocketchat/index.ts`, `apps/mobile/providers/rocketvibe/index.ts`
- `apps/mobile/lib/providerProfiles.ts`, `apps/mobile/lib/providerEmojis.ts`, `apps/mobile/lib/providerCalls.ts`, `apps/mobile/ui/sync.tsx`, `apps/mobile/db/schema.ts`
- `apps/desktop/crates/rv-core/src/native.rs`, `apps/desktop/crates/rv-core/src/session.rs`, `apps/desktop/crates/rv-core/src/account.rs`, `apps/desktop/crates/rv-core/src/store.rs`, `apps/desktop/crates/rv-core/src/outbox.rs`
- `apps/desktop/crates/rv-ffi/src/`, `apps/desktop/crates/rv-gtk/src/`, `apps/desktop/macos/Sources/RocketVibeKit/`
- `docs/protocol/PARITY.md`, `brain/parity.md`, `CLAUDE.md`

External sources are linked beside their claims and pinned for the reference
code. The reference is GPL-3.0-or-later; this handoff describes protocol behaviour,
not a proposal to vendor its implementation. Implement in this project's own
code and review compatibility before any future source reuse. Slack session-only
methods are internal contracts and can change independently of the public API.
