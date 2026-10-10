# Experimental integrations

Slack is the first implementation increment from the provider handoffs. After
that preview was pushed, Teams gained an isolated read foundation, then a development
browser-import preview on all three native apps. Live Teams sign-in remains unqualified
and requires the separate developer helper. The first Slack
increment is a transient read-only preview on the login screen. It is independent
of the normal persistent account, store, outbox and sync lifecycle. It does not
advertise a complete provider or enable any of the existing chat action menus.

## Unlock

Activate the RocketVibe icon on the login screen nine times, with no gap longer
than two seconds. Individual button activations count, including accessible
activations; GTK does not count a multi-click gesture's cumulative click count.
Before the ninth activation no experimental option appears. The device retains
the unlock across launches. Hide experimental integrations disconnects the
preview and removes the setting. This gate controls discoverability, not account
authorization. The same gate reveals a Slack/Teams selector. Switching providers disposes the previous
preview and its credentials.

## Mobile

lib/experimentalUnlock.ts implements the sequence; ui/experimentalProviders.ts
persists only the enable flag in SecureStore. app/login.tsx attaches it to the
unicorn button. ui/slackPreview.tsx shows the paired masked xoxc token and original
d cookie value, validates the workspace/user with auth.test, then lists joined
conversations through users.conversations. Selecting a conversation reads a
page of conversations.history. Load more carries the server cursor unchanged;
repeated cursors fail explicitly. Refresh rereads the first page.

providers/slack/client.ts sends form POSTs only to https://slack.com/api/, with
Bearer and the exact original cookie bytes. credentials=omit disables the native
shared cookie jar; the explicit d header remains the sole session cookie.
Credentials are in memory only;
disconnect, hide or leaving the screen closes the reader, aborts its outstanding
reads and drops fields and results. A generation fence discards late completions.
No credentials enter SQLite or known-server/session storage. IDs use workspace
and user identity, and message timestamps remain six-decimal strings; conversion
to seconds occurs only for a displayed date.

## Desktop

rv-core/src/slack.rs implements the same read contract for GTK and SwiftUI.
It disables redirects, bounds response bytes, sanitizes transport/API errors,
preserves Retry-After and pins each reader to the authenticated workspace/user.
Close cancels pending requests and zeroizes retained credential strings.

GTK embeds experimental_preview.rs under the login hero, selecting slack_preview.rs
or teams_preview.rs, with masked native entries,
conversation buttons and selectable message text. SwiftUI uses
SlackPreviewView.swift over the transient SlackPreview UniFFI object. The
unlock flag lives at <config>/rocket-vibe-rs/experimental-providers, shared by
the desktop interfaces. Removing a preview never revokes the upstream browser
session. Outstanding Swift authentication is fenced after cancellation; the
bounded Rust request may finish before its result is closed and discarded.

## Limits and next increments

Slack supports manually supplied paired session credentials. Teams uses the encrypted
public-key handoff from a separate development browser helper. This code has fixture
coverage and does not replace the protocol's live qualification plan. No account
credentials were used during implementation. Installed Android and macOS runtime
qualification remains outstanding. Message bodies display as plain text with
Slack formatting syntax; author IDs remain IDs, non-text content has a placeholder.
Thread replies, files, real-time RTM, credential acquisition, secure persistent
accounts, local/offline projection and writes remain missing. A has_more history
response without a cursor fails as pagination_unsupported instead of silently
claiming a complete page sequence. No automated quota retry or background polling.

Next: own browser acquisition and vault lifecycle (S-A), then neutral projection
(S-B), cookie RTM plus reconnect repair (S-C), then durable writes (S-D). Teams
now has its next transient browser-import increment, following the first Slack
preview, under the shared unlock. See [Teams architecture](../architecture/teams.md)
for the code and authentication boundary.

## Validation

2026-10-09: mobile TypeScript and touched-file lint pass, all 1,638 mobile tests
pass, and the ten Slack/unlock tests pass again after disabling the native cookie
jar. The Android export bundles successfully. The Fedora build.sh gate passes
formatting, clippy, 572 desktop tests and the workspace binary build. Generated
Slack bindings and RocketVibeCore/RocketVibeKit compile in the Swift container;
both changed SwiftUI screens pass the frontend syntax check. This does not
qualify AppKit linking or installed macOS behavior.

The actual GTK login launches under Xvfb with RV_SMOKE_SLACK_UNLOCK=1: eight
icon activations leave the preview hidden, the ninth shows it, and the device
setting is written. A rendered screenshot confirms the masked credential form.
The smoke sequence waits until login is visible, since GTK is_visible also
checks ancestors. Real Slack credentials and installed Android/macOS remain
unqualified.

The pushed Slack increment also passes both [web CI](https://github.com/Guillaume69/rocket-vibe/actions/runs/37960337293)
and [macOS CI](https://github.com/Guillaume69/rocket-vibe/actions/runs/37960337204).
The latter compiles, packages and launches the actual SwiftUI app. Manual
nine-activation interaction and real Slack sessions on macOS remain unqualified.

## Teams browser-import preview

The development helper opens a fresh official Teams browser with an owned temporary
profile and observes the browser's normal grants, without embedding an OAuth client ID
or refreshing tokens. Signed ID tokens bind tenant/object identity to the observed
browser client; API access tokens remain opaque. The three audience tokens are sent in
an encrypted, five-minute handoff to the native panel's one-use public pairing code.
No private key, raw token or refresh token enters the clipboard or persistent account
storage. Normal temporary browser auth cache is removed when the helper shuts down.

Android ui/teamsPreview.tsx, GTK teams_preview.rs and SwiftUI TeamsPreviewView.swift
provide the pairing/import controls, conversation list, unsupported-kind markers and
paged plain-text history. There is no WebView, remote HTML rendering, writing, polling,
refresh or normal provider factory. Close/hide/switch clears retained state; expiry
refuses a request before networking. See [usage](../../docs/TEAMS_PREVIEW.md) and
[architecture](../architecture/teams.md) for security and acquisition boundaries.

A development computer and Node command are required. Packaged one-click sign-in,
phone-only acquisition, live organizational account acceptance, secure persistent
accounts, refresh, projection/sync, writes, media, calls and push remain missing.
No work/school test account was available; synthetic success cannot qualify real Teams.

### Validation of the Teams increment

2026-10-10: TypeScript and touched-file ESLint pass, all 1,662 mobile/helper tests pass.
The dedicated installed Edge --smoke passes with profile cleanup, without authentication.
The Android export bundles successfully. GTK and Swift build/render qualification
is tracked separately from account acceptance.

## Sources

- apps/mobile/providers/teams/protocol.ts
- apps/mobile/providers/teams/reader.ts
- apps/mobile/providers/teams/protocol.test.ts
- apps/desktop/crates/rv-core/src/teams.rs
- docs/protocol/fixtures/teams-read.json

- apps/mobile/lib/experimentalUnlock.ts
- apps/mobile/ui/experimentalProviders.ts
- apps/mobile/app/login.tsx
- apps/mobile/ui/slackPreview.tsx
- apps/mobile/providers/slack/client.ts
- apps/mobile/providers/slack/client.test.ts
- apps/desktop/crates/rv-core/src/slack.rs
- apps/desktop/crates/rv-gtk/src/login.rs
- apps/desktop/crates/rv-gtk/src/slack_preview.rs
- apps/desktop/crates/rv-ffi/src/slack.rs
- apps/desktop/macos/Sources/RocketVibe/LoginView.swift
- apps/desktop/macos/Sources/RocketVibe/SlackPreviewView.swift
- docs/protocol/SLACK_SESSION.md
- docs/protocol/MICROSOFT_TEAMS.md
