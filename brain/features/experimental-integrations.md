# Experimental integrations

Behind a device-local unlock, two providers from the protocol handoffs, each a full
experimental server kind with saved accounts on Android, GTK and SwiftUI: Slack and
Teams. Both began as transient read previews, now gone from every app.

## Slack account

Behind the unlock, Slack is also a server kind of the login screen. Signing in ends in a
saved account: rooms, unread counts, history and threads in the local store, mrkdwn and
mentions converted, names and avatars from Slack, kept live by the RTM socket (new
messages, edits, deletions, reactions, reads made elsewhere, typing). The composer sends
text and thread replies, also to the room when asked; the message menu edits, deletes
and reacts; opening a room marks it read. All three apps send typing. Slack's emoji
names and skin tones show as emoji, the workspace's custom emoji as images, and a
person's status emoji after their name. A huddle shows as the kChat-style call card: while it runs,
Join opens it in Slack's web app, as does the room header's call button, which
starts one already signed in with the session cookie (no second sign-in): on GTK Linux in
a temporary Chromium app window (WebKitGTK has no WebRTC), on GTK elsewhere and SwiftUI in
the app's call window (WebView2, WKWebView), on Android in the system browser (huddles have no native media); once over, its length. Received files show as attachments (images, video and audio play in the app, other files open or save) and files are sent from the composer; a room is searched, messages are pinned and saved (Slack's "saved for later" is the app's star) with both lists shown, and presence shows on people and can be set (Slack has online and away only; the status text is not offered, the account screens being unwired). Room info, settings, members, leave, favorites, quotes, scheduled messages and the account and profile screens stay hidden. A thread reply marks its room unread and notifies only when it names me; a conversation created or joined elsewhere appears live. Android hides reactions Slack does not know (`slackReactable`); GTK and SwiftUI hide Rocket.Chat's GIFs, stickers and encryption on Slack (`is_slack`). Android signs in with one button, in the app's sign-in web view (`packages/provider-slack/src/webSignIn.ts`), the way the desktops use their browser. GTK and SwiftUI hide the server
and password fields and offer "Sign in to Slack": the app opens a sign-in window of its own
(WebKitGTK, WebView2, WKWebView), the user signs in there (password, SSO, MFA are Slack's),
the window closes once Slack hands the session over, and a
workspace picker appears when the session holds several. Cancel stops the attempt and
closes the window. Hiding the experimental integrations removes the Slack kind. See
[Slack architecture](../architecture/slack-session.md#desktop-browser-sign-in).

## Unlock

Activate the RocketVibe icon on the login screen nine times, with no gap longer
than two seconds. Individual button activations count, including accessible
activations; GTK does not count a multi-click gesture's cumulative click count.
Before the ninth activation no experimental option appears. The device retains
the unlock across launches. Hide experimental integrations (a plain link under the
hero) removes the setting and cancels a Teams sign-in under way. This gate controls
discoverability, not account authorization. The same gate reveals three server kinds
of the login page: Slack, Teams, and WhatsApp where its engine is installed (Android's
module, the desktop helper). Hiding them again drops a selected gated kind back to Automatic; saved
accounts stay.

## Mobile

lib/experimentalUnlock.ts implements the sequence; ui/experimentalProviders.ts
persists only the enable flag in SecureStore. app/login.tsx attaches it to the
unicorn button, gates the Slack and Teams kinds and the WhatsApp entry on it, and shows the hide
link while unlocked. Slack's sign-in is one button: ui/signInWebView.tsx shows slack.com/signin and only
Slack's https pages, and stops on the desktop handoff (`/ssb/`) or the web client
(`isSlackWebDone`), presenting a desktop Chrome of the system web view's own version (`slackUserAgent`, from `WebCookies.userAgent`, since slack.com serves a phone the app's download page and warns an old version off), where a script reads the workspace hosts of `localConfig_v2` (never
its tokens). The session's HttpOnly `d` cookie is read from the web view's store by the
local module modules/web-cookies (Android `CookieManager`), which is then cleared;
packages/provider-slack/src/webSignIn.ts fetches each workspace's boot page with that cookie for its
`xoxc` token and proves it with `auth.test` (packages/provider-slack/src/auth.ts). Several workspaces
are offered as buttons; the session (token, team id, `d` cookie) is saved like any
account. packages/provider-slack/src/handoff.ts (the helper's pairing) is no longer reached. packages/provider-slack/src/client.ts sends form POSTs only to https://slack.com/api/,
with Bearer and the exact original cookie bytes; credentials=omit disables the native
shared cookie jar. IDs use workspace and user identity, and message timestamps remain
six-decimal strings; conversion to seconds occurs only for a displayed date.

## Desktop

crates/rv-slack (account, RTM, browser sign-in, translation) with rv-core/src/slack/
(sync into the store) is the full Slack backend for GTK and SwiftUI; its pairing
handoff, `Reader` and `login_paired` are no longer reached by either interface. Its REST
client (rv-provider's, `Api::Slack`) disables redirects except for public media, bounds
response bytes, sanitizes transport/API errors and preserves Retry-After. See
[Slack architecture](../architecture/slack-session.md).

GTK embeds experimental_preview.rs under the login hero: it owns the unlock flag
(<config>/rocket-vibe-rs/experimental-providers, shared by the desktop interfaces) and
its hide button. login.rs adds the gated kinds (`show_experimental_kinds`: WhatsApp
when the helper is installed, Slack, Teams) while the panel is visible and removes them
when it hides; the kinds are found by label, not position. SwiftUI's LoginView shows the
hide link and lists Slack and Teams only while unlocked. rv-core's Slack `Reader` and
the FFI's `SlackPreview`/`SlackPairing` objects remain unused by the interfaces.

## Limits

The desktops sign in to Slack in a window of the app, Android in its sign-in web view;
Teams signs in everywhere with a Microsoft device code. Installed Android and macOS
runtime qualification remains outstanding. Slack still lacks a pasted-session fallback,
native huddle media, killed-app push and the screens listed above. Teams lacks
saves, room settings beyond a channel's name, a preview image on files it sends, native call media (a channel
call's Join opens the call in Teams itself, anything else the conversation), a thread list and
push; its pinned list covers a room's latest 200 messages and its search cannot jump to the
exact message. See [Teams](../architecture/teams.md) and
[parity](../parity.md#19-experimental-integrations).

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

See [Slack usage](../../docs/SLACK_PREVIEW.md). This is a developer bridge; Android's
phone-only sign-in and production qualification remain missing. The user
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

## Teams account

Behind the unlock, Teams is a server kind of the login screen. "Sign in to Teams" asks
Microsoft for a device code; the app shows it with Microsoft's page (a button on
Android, a link on GTK and SwiftUI) and waits, Cancel stopping the wait. Once the code
is approved on Microsoft's page the account is saved like any other: chats and channels
in the room list with their unread state, history paged back, new messages, edits,
reactions and deletions live over Trouter, and text, edit, delete, the six classic
Teams reactions and mark read written back. See [Teams architecture](../architecture/teams.md).

## Sources

- packages/provider-teams/src/auth.ts
- crates/rv-teams/src/auth.rs

- apps/mobile/lib/experimentalUnlock.ts
- apps/mobile/ui/experimentalProviders.ts
- apps/mobile/app/login.tsx
- apps/mobile/ui/slackSignIn.tsx
- apps/mobile/ui/signInWebView.tsx
- packages/provider-slack/src/webSignIn.ts
- apps/mobile/modules/web-cookies/
- packages/provider-slack/src/auth.ts
- packages/provider-slack/src/emojis.ts
- packages/provider-slack/src/client.ts
- packages/provider-slack/src/client.test.ts
- crates/rv-slack/src/lib.rs
- crates/rv-slack/src/browser_login.rs
- apps/desktop/crates/rv-gtk/src/login.rs
- apps/desktop/crates/rv-gtk/src/experimental_preview.rs
- apps/desktop/crates/rv-gtk/src/chat.rs (`open_call`)
- apps/desktop/crates/rv-ffi/src/slack.rs
- apps/desktop/macos/Sources/RocketVibe/LoginView.swift
- docs/protocol/SLACK_SESSION.md
- docs/protocol/MICROSOFT_TEAMS.md

- scripts/slack-browser-signin.mjs
- scripts/slack/browser.mjs
- scripts/slack/session.mjs
- scripts/slack/server.mjs
- packages/provider-slack/src/handoff.ts
- packages/provider-slack/src/handoff.test.ts
- crates/rv-slack/src/handoff.rs
- docs/protocol/fixtures/slack-handoff.json
- docs/SLACK_PREVIEW.md
