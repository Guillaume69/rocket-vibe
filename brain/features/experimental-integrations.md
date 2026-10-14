# Experimental integrations

Slack is the first implementation increment from the provider handoffs. After
that preview was pushed, Teams gained an isolated read foundation, then a development
browser-import preview on all three native apps. Live Teams sign-in remains unqualified
and requires the separate developer helper. Slack now also has an encrypted browser-import
flow through a developer helper, and has since become a saved account (below); its
transient preview is gone from every app. The Teams preview that remains is transient
and read-only on the login screen, independent of the normal persistent account,
store, outbox and sync lifecycle.

## Slack account

Behind the unlock, Slack is also a server kind of the login screen. Signing in ends in a
saved account: rooms, unread counts, history and threads in the local store, mrkdwn and
mentions converted, names and avatars from Slack, kept live by the RTM socket (new
messages, edits, deletions, reactions, reads made elsewhere, typing). The composer sends
text and thread replies, also to the room when asked; the message menu edits, deletes
and reacts; opening a room marks it read. All three apps send typing. Slack's emoji
names and skin tones show as emoji, the workspace's custom emoji as images, and a
person's status emoji after their name. A huddle shows as the kChat-style call card: while it runs,
Join opens it in Slack in the browser, as does the room header's call button, which
starts one (huddles cannot be joined in the app); once over, its length. Files, search, pins, saves, room settings and presence stay hidden. Android (`ui/slackSignIn.tsx`) takes the
helper's encrypted handoff or a pasted token and cookie. GTK and SwiftUI hide the server
and password fields and offer "Sign in to Slack": the app opens a temporary browser,
the user signs in there (password, SSO, MFA are Slack's), the app closes it, and a
workspace picker appears when the session holds several. Cancel stops the attempt and
closes the browser. Hiding the experimental integrations removes the Slack kind. See
[Slack architecture](../architecture/slack-session.md#desktop-browser-sign-in).

## Unlock

Activate the RocketVibe icon on the login screen nine times, with no gap longer
than two seconds. Individual button activations count, including accessible
activations; GTK does not count a multi-click gesture's cumulative click count.
Before the ninth activation no experimental option appears. The device retains
the unlock across launches. Hide experimental integrations disconnects the
preview and removes the setting. This gate controls discoverability, not account
authorization. The same gate reveals the Teams preview and two server kinds of the
login page: Slack, and WhatsApp where its engine is installed (Android's module, the
desktop helper). Hiding them again drops a selected gated kind back to Automatic; saved
accounts stay.

## Mobile

lib/experimentalUnlock.ts implements the sequence; ui/experimentalProviders.ts
persists only the enable flag in SecureStore. app/login.tsx attaches it to the
unicorn button and gates the Slack kind and the WhatsApp entry on it. The Slack preview
(removed when Slack became an account, its pairing now in ui/slackSignIn.tsx) showed a
masked public pairing code and encrypted browser response, opened the one-use providers/slack/handoff.ts envelope, validates
the workspace/user with auth.test against the transferred identity, then lists joined
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

rv-core/src/slack/ (`Reader`) implements the same read contract for GTK and SwiftUI.
It disables redirects, bounds response bytes, sanitizes transport/API errors,
preserves Retry-After and pins each reader to the authenticated workspace/user.
Close cancels pending requests and zeroizes retained credential strings.

GTK embeds experimental_preview.rs under the login hero: it owns the unlock flag
(<config>/rocket-vibe-rs/experimental-providers, shared by the desktop interfaces) and
shows teams_preview.rs. login.rs adds the gated kinds (`show_experimental_kinds`: WhatsApp
when the helper is installed, Slack) while the panel is visible and removes them when it
hides; the kinds are found by label, not position. SwiftUI's ExperimentalPreviewView
shows TeamsPreviewView, and LoginView lists Slack only while unlocked. The desktop Slack
preview views are removed; rv-core's `Reader` and the FFI's `SlackPreview`/`SlackPairing`
objects remain unused by the interfaces. Removing a preview never revokes the upstream
browser session.

## Limits and next increments

Slack and Teams use provider-separated encrypted public-key handoffs from separate
development browser helpers. Raw paired credentials are no longer requested by the Slack UI. This code has fixture
coverage and does not replace the protocol's live qualification plan. No account
credentials were used during implementation. Installed Android and macOS runtime
qualification remains outstanding. Message bodies display as plain text with
Slack formatting syntax; author IDs remain IDs, non-text content has a placeholder.
Thread replies, files, real-time RTM, packaged acquisition, phone-only sign-in, secure
persistent accounts, local/offline projection and writes remain missing. A has_more history
response without a cursor fails as pagination_unsupported instead of silently
claiming a complete page sequence. No automated quota retry or background polling.

Next: qualify browser acquisition and implement the vault lifecycle (S-A), then neutral projection
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

## Slack browser-import increment

scripts/slack-browser-signin.mjs opens a fresh helper-owned Chromium profile and a
loopback pairing page. Only Slack web-client targets are inspected. The evaluated
context checks its current Slack origin/path before reading localConfig_v2; privileged
CDP reads the original secure HttpOnly d cookie for that target. One selected inline
boot token can supply a fallback. Validated workspace records are selected on the
local page; each pair passes fixed-origin auth.test before export, and the native
reader rechecks the exact transferred workspace/user. Navigation, cookie changes,
cancellation and failed revalidation cannot advertise an old transferable session.

Slack's own browser handles password/SSO/MFA. X25519/HKDF-SHA256/AES-256-GCM seal a
provider-specific rvslack1 envelope with a five-minute transfer deadline. Successful
import consumes the native private key. The local session limit is one hour from
acquisition, shortened by a known cookie expiry; native reads stop thirty seconds
before it. This limit is not the upstream token lifetime and no refresh is attempted.
No raw credentials enter the clipboard, pairing page, logs, SQLite or durable account
storage. Normal browser auth cache can exist in its temporary profile during use;
shutdown removes that exact profile, while crashes can leave cleanup debt. Rust
zeroizes retained secrets, while JS strings do not guarantee physical zeroization.

See [Slack preview usage](../../docs/SLACK_PREVIEW.md). This is a developer bridge;
packaged/phone-only sign-in and production qualification remain missing. The user
has a workspace available for manual acceptance, but no live sign-in was performed
while implementing the helper. Synthetic success is not account qualification.

### Validation of the Slack browser increment

2026-10-10: TypeScript and touched-file ESLint pass, all 1,679 mobile/helper tests
pass, and Android export bundles successfully. The installed Edge --smoke checks
owned browser transport and temporary-profile cleanup without performing sign-in.
The shared encrypted fixture is opened by native Rust and mobile crypto, including
original cookie bytes; wrong recipients, altered envelopes, invalid plaintext,
identity mismatch, expiry and cancellation are covered by synthetic tests.

The Fedora build.sh gate passes formatting, warnings-denied clippy, all 589 desktop
tests and the workspace binary build.
The [macOS CI](https://github.com/Guillaume69/rocket-vibe/actions/runs/38081199626)
passes actual SwiftUI compilation, Swift tests, offline self-check, packaging,
notarization and app launch. [Web CI](https://github.com/Guillaume69/rocket-vibe/actions/runs/38081199622)
also passes its server build and browser compatibility checks. Live Slack browser
sign-in, MFA and workspace acceptance still require the user's manual test;
installed Android behavior and manual macOS interaction remain unqualified.

GTK launches under Xvfb with isolated temporary configuration and no network. Eight
activations keep experiments hidden; the ninth reveals Slack. The smoke verifies
masked, non-editable public pairing, wrong-provider response rejection without a
reader, and a disconnect/reset that clears the response and rotates the key. A
rendered screenshot confirms the native provider selector and pairing/import controls.

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

The final Fedora build.sh gate passes formatting, warnings-denied clippy, all 584
desktop tests and the workspace binary build. Refreshing the core/async artifacts
clears the observed native-room test crash without application-code changes. An optional
RV_BUILD_TARGET_DIR lets the standard gates use an external host artifact cache.

GTK launches under Xvfb with isolated temporary configuration and no network. The
smoke checks hidden state through eight icon activations, visibility/persistence on
the ninth, and selection of the Teams panel. A rendered screenshot shows its masked
public pairing code, encrypted-response entry and native provider selector.

Fresh Teams UniFFI bindings and RocketVibeCore/RocketVibeKit compile in the Swift
container; changed SwiftUI screens pass the frontend syntax check. The actual
[macOS CI](https://github.com/Guillaume69/rocket-vibe/actions/runs/38071096653)
passes build, Swift tests, packaging, signing/notarization and launch checks; [web CI](https://github.com/Guillaume69/rocket-vibe/actions/runs/38071096651)
also passes. These runs compile the Teams UI but do not qualify manual Teams interaction
on macOS, installed Android behavior, real account sign-in or private service DTOs.
## Sources

- apps/mobile/providers/teams/protocol.ts
- apps/mobile/providers/teams/reader.ts
- apps/mobile/providers/teams/protocol.test.ts
- apps/desktop/crates/rv-core/src/teams.rs
- docs/protocol/fixtures/teams-read.json

- apps/mobile/lib/experimentalUnlock.ts
- apps/mobile/ui/experimentalProviders.ts
- apps/mobile/app/login.tsx
- apps/mobile/ui/slackSignIn.tsx
- apps/mobile/providers/slack/client.ts
- apps/mobile/providers/slack/client.test.ts
- apps/desktop/crates/rv-core/src/slack/mod.rs
- apps/desktop/crates/rv-core/src/slack/browser_login.rs
- apps/desktop/crates/rv-gtk/src/login.rs
- apps/desktop/crates/rv-ffi/src/slack.rs
- apps/desktop/macos/Sources/RocketVibe/LoginView.swift
- docs/protocol/SLACK_SESSION.md
- docs/protocol/MICROSOFT_TEAMS.md

- scripts/slack-browser-signin.mjs
- scripts/slack/browser.mjs
- scripts/slack/session.mjs
- scripts/slack/server.mjs
- apps/mobile/providers/slack/handoff.ts
- apps/mobile/providers/slack/handoff.test.ts
- apps/desktop/crates/rv-core/src/slack_handoff.rs
- docs/protocol/fixtures/slack-handoff.json
- docs/SLACK_PREVIEW.md
