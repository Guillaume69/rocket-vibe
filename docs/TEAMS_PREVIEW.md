# Experimental Teams preview

This is a development preview for Android, GTK and SwiftUI. It imports a short-lived
session from a fresh official Teams browser window, then offers a native conversation
list and paged plain-text history. Live sign-in and private Teams DTOs remain
unqualified: no work/school test account was available. Persistent accounts, refresh,
sync, sending, files, calls and push are not implemented.

## Try the preview

1. On the app's login screen, activate the RocketVibe icon nine times, with no gap
   longer than two seconds. Select Teams in the experimental provider selector.
2. Copy the public pairing code from the Teams panel. The private key stays in the
   app; disconnecting, switching providers or leaving the panel invalidates it.
3. On a development computer with Node 24 and Edge, Chrome or Chromium installed,
   run the following command from the repository root:

~~~sh
node scripts/teams-browser-signin.mjs
~~~

4. The helper opens a fresh Teams browser window and a local pairing page. Sign in
   normally in the Teams window, including MFA. The helper does not choose an OAuth
   application ID or make its own grants. It observes the official browser's
   responses for the three required service audiences. Opening a chat may be
   necessary to request all three.
5. When the local page reports three audiences ready, paste the public pairing
   code there and copy its encrypted response. Paste that response into the same
   native Teams panel and import it within five minutes.
6. Browse supported conversations and history. Disconnect when finished. Stop the
   helper with Ctrl+C; closing its Teams browser or its twenty-minute timeout also
   stops collection and removes the temporary browser profile.

Android can receive an encrypted response prepared on the development computer.
A phone-only browser flow and a packaged one-click desktop sign-in are still missing.
The helper is a developer command, not bundled into the installed apps. It never
attaches to an existing browser profile or asks for raw tokens or cookies. It sends
neither credentials nor the pairing exchange through a RocketVibe server.

## Session handling

The helper launches an owned, temporary profile. Like any browser, that profile can
contain normal authentication cache while running. Shutdown removes it; interrupted
processes or OS crashes can leave a temporary profile requiring cleanup. The helper
itself does not print credentials, save response captures or export refresh tokens.
Access tokens stay in memory, including during the encrypted transfer. The local
page is bound to 127.0.0.1 and a random capability path, with exact Host and Origin
checks, no-store responses and a restrictive content policy.

The copied pairing code is a public X25519 key. An ephemeral sender key, HKDF-SHA256
and AES-256-GCM seal the response. Copying the public code and encrypted response
alone cannot decrypt it. Successful import consumes the native private key. Reset,
hide, provider switch and panel disposal close readers and clear retained state.
Rust zeroizes retained token and key buffers; JavaScript cannot guarantee physical
zeroization of every string copy. Expired sessions fail before a request is sent;
re-pair instead of trying a refresh. Disconnecting does not revoke Microsoft's
upstream account session.

Identity comes from a signed Microsoft v2 ID token, validated against Microsoft's
fixed JWKS endpoint, tenant issuer, the browser request's client ID and expiry. API
access tokens are opaque. The collector rejects a different account or client ID
within the same capture and retains no refresh token. A missing supported ID token
fails explicitly; success with a real Teams browser remains an acceptance task.

## Errors and remaining qualification

The helper reports static codes instead of raw network errors or token responses.
If an audience never becomes ready, or identity_result_missing, invalid_identity or
account_changed appears, restart pairing and the fresh browser. Browser grant shapes
outside the narrow v2 route/scope policy are unsupported, not guessed. The native
reader also rejects service discovery outside the observed teams.microsoft.com
proxy prefixes and refuses cross-origin or cross-conversation paging links. There
is no fallback credential trial against another service host.

Unknown conversation and message types remain unsupported. HTML is reduced to
plain text, with no execution or remote image load. There is no claim of complete
membership, historical reconciliation or production account support. Before moving
past this preview, qualify organizational account sign-in, MFA, tenant and guest
separation, service discovery, roster and history, cancellation, expiry and failure
responses on each app using sanitized evidence only.

## Local checks

~~~sh
# From apps/mobile:
npx tsc --noEmit
npm test
npx expo export --platform android --output-dir .cache/teams-preview-android

# From the repository root; no sign-in performed:
node scripts/teams-browser-signin.mjs --smoke

# From apps/desktop, inside the standard Fedora build workflow:
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 scripts/build.sh
~~~

On a constrained worktree drive, set RV_CARGO_TARGET_DIR to an absolute host
cache directory before invoking build.sh. Its optional nested mount changes only
the artifact location, retaining formatting, clippy, tests and build gates.

The smoke command checks a dedicated browser's debugging transport and profile
cleanup only. Synthetic signature, encrypted transfer, origin isolation, paging and
expiry tests cannot qualify a real Microsoft account. See the
[architecture](../brain/architecture/teams.md), [protocol handoff](protocol/MICROSOFT_TEAMS.md)
and [experimental integrations](../brain/features/experimental-integrations.md).

## Sources

- scripts/teams-browser-signin.mjs
- scripts/teams/browser.mjs
- scripts/teams/session.mjs
- scripts/teams/server.mjs
- apps/mobile/providers/teams/handoff.ts
- apps/desktop/crates/rv-core/src/teams_handoff.rs
- [Microsoft ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
- [Chrome dedicated debugging profiles](https://developer.chrome.com/blog/remote-debugging-port)
- [CDP network response API](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
