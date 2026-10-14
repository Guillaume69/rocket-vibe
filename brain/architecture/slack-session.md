# Slack session provider, researched contract

Slack is a saved, read-only account kind on Android, GTK and SwiftUI, behind nine
activations of the login icon. Rooms, unread counts, history and threads go through the
local store like any other server; nothing is sent, and there are no live events yet
(a catch-up runs at start and on refresh). Android signs in from the developer helper's
encrypted handoff or a pasted token and cookie; the desktop opens Slack in a temporary
browser of its own. The transient read preview remains for Teams only on Android, and
for Slack and Teams in the desktop's experimental panel. See [experimental integrations](../features/experimental-integrations.md)
and [preview usage](../../docs/SLACK_PREVIEW.md).
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
X25519/HKDF-SHA256/AES-256-GCM rvslack1 envelope to the native panel's public key.
Import consumes that private key and the app rechecks the transferred team/user.
A five-minute transfer deadline and a one-hour local preview limit bound the session;
a known earlier cookie expiry shortens it. Readers refuse requests thirty seconds
before expiry.

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
workspace hosts (Slack's own hosts excluded). Each host's boot page, fetched with that
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

## Integration and parity

The proposed driver acts through Web API and listens through cookie-authenticated
RTM, with paced polling/reconciliation if delivery coverage is insufficient.
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

- apps/mobile/providers/slack/ (`auth.ts`, `client.ts`, `catchUp.ts`, `history.ts`, `translator.ts`, `index.ts`), apps/mobile/ui/slackSignIn.tsx
- apps/desktop/crates/rv-core/src/slack/ (`account.rs`, `api.rs`, `browser_login.rs`, `sync.rs`, `translate.rs`, `live.rs`)
- apps/desktop/crates/rv-ffi/src/slack.rs, apps/desktop/crates/rv-gtk/src/login.rs, apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/macos/Sources/RocketVibeKit/LoginModel.swift, apps/desktop/macos/Sources/RocketVibe/LoginView.swift

- `docs/protocol/SLACK_SESSION.md`, `docs/protocol/SLACK_SESSION_PROBES.md`, `docs/protocol/slack-session-evidence.json`
- `apps/mobile/lib/provider.ts`, `apps/mobile/providers/index.ts`
- `apps/desktop/crates/rv-core/src/native.rs`, `apps/desktop/crates/rv-core/src/session.rs`
- `apps/desktop/crates/rv-ffi/src/`, `apps/desktop/macos/Sources/RocketVibeKit/`

- scripts/slack-browser-signin.mjs
- scripts/slack/browser.mjs
- scripts/slack/session.mjs
- apps/mobile/providers/slack/handoff.ts
- apps/desktop/crates/rv-core/src/slack/handoff.rs
- docs/SLACK_PREVIEW.md
