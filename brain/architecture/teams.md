# Teams browser-import read preview

Teams is a client-side experimental provider, separate from normal account factories,
Rocket.Chat sessions and the native RocketVibe protocol. Android, GTK and SwiftUI
expose a transient read preview under the shared nine-activation login unlock.
[Try the preview](../../docs/TEAMS_PREVIEW.md). Live sign-in and private service DTOs
remain unqualified because no work/school test account was available. A development
computer running the browser helper is required; packaged one-click native sign-in
and a phone-only flow remain missing. T0/T1 acceptance is still open.

## Browser acquisition

scripts/teams-browser-signin.mjs launches an owned temporary Edge/Chrome/Chromium
profile, never an existing profile. The human signs in through the official Teams
browser, which performs its normal grants and MFA. CDP observes successful v2 token
responses only for requests originating from teams.microsoft.com and the known
Spaces, aggregator and chat resource scopes. The helper embeds no borrowed OAuth
client ID, issues no grant or refresh call and never decodes API access tokens.

session.mjs validates the accompanying v2 ID token: RS256 signature through the fixed
Microsoft JWKS endpoint, tenant issuer, browser request client ID, tenant/object UUIDs,
version and times. The account/client binding must match across all three audiences;
a changed binding closes the collector. Unsupported grants or missing ID token fail.
Access expiry is bounded by receipt-time expires_in and the signed identity expiry.
Only audience tokens and tenant/object identity enter the handoff; refresh tokens do
not. These checks have synthetic signed-token tests, not live grant acceptance.

The local pairing page uses 127.0.0.1, a random port and capability path, exact Host
and Origin checks, size bounds, no-store responses and restrictive CSP. The helper
prints static status only and does not write captures or export credentials to files.
The browser itself can cache normal authentication in its temporary profile; shutdown
removes it, while a process/OS crash can leave cleanup debt. Browser close, Ctrl+C or
twenty minutes stops collection. --smoke checks browser transport without sign-in.

## Encrypted handoff

Native Pairing generates a private X25519 seed and copies only its public code. The
helper seals the transfer with a fresh sender X25519 key, HKDF-SHA256 and AES-256-GCM.
HKDF uses a zero salt and context plus recipient/sender public keys; GCM authenticates
the version context. The rvteams2 response carries sender public key, nonce and
ciphertext/tag. A shared synthetic vector checks Node, mobile and Rust agreement.
A copied public code plus response cannot decrypt the transfer.

The transfer expires after five minutes. Import validates account/token shapes and
bounded session lifetime, and consumes the native private key only after valid import.
Reset/close clears retained key buffers. Mobile reuses native OpenSSL through existing
crypto/buffer Metro aliases; no new native dependency or WebView is introduced. Rust
uses aws-lc-rs and Zeroizing. JavaScript cannot promise zeroization of all string copies.
The preview never stores sessions in SQLite, SecureStore or the desktop account vault.

## Mobile

providers/teams/protocol.ts validates identity, discovered routes, roster and history.
handoff.ts imports one account and three opaque audience tokens; reader.ts owns that
immutable partition and expiry. ui/teamsPreview.tsx uses native masked entries, clipboard,
conversation buttons and plain selectable text. ui/experimentalPreview.tsx switches
between Slack and Teams by mounting one panel; switching closes the previous reader.
Cancellation generations prevent a late completion from restoring discarded state.

POST authsvc/v1.0/authz uses the Spaces token. regionGtms.chatSvcAggAfd and
chatServiceAfd supply validated dynamic routes. The conservative global-cloud policy
accepts HTTPS teams.microsoft.com proxy prefixes /api/csa/<region> and
/api/chatsvc/<region> only, with no hard-coded region or credential fallback host.
Only a wholly validated discovery response replaces both routes. Direct hosts, other
aliases and sovereign clouds require qualification. Skype tokens are discarded.

The aggregator reads the account snapshot. The chat token reads a bounded page and
its opaque backwardLink after validating the same origin, discovered proxy and exact
conversation path. Segments are decoded once; encoded slashes do not become separators.
Redirects fail and cookies are omitted. Reads have a 15-second deadline and 2 MB limit.
401 is audience_rejected, 403 permission_denied and 429 preserves Retry-After without
retry. Session expiry fails before networking, with a thirty-second margin. Close
aborts requests and drops credentials; no completion can revive a closed reader.

## Desktop

rv-core/src/teams.rs supplies the same private adapter and expiry checks. reqwest
rejects redirects, bounds streamed bytes and cancels through a watch channel. Closing
or dropping the reader zeroizes retained token strings. teams_handoff.rs implements
one-use pairing/import. GTK teams_preview.rs renders a native preview under
experimental_preview.rs; unmap, switch, hide and reset close readers and rotate pairing.

rv-ffi/src/teams.rs exposes transient TeamsPreview and sanitized conversation/history
records. It exposes neither access tokens nor private keys. TeamsPreviewView.swift
uses these records in native SwiftUI controls, closes on disappearance and fences async
results. Both desktop UIs share the persisted experimental-providers unlock flag.
Disconnect closes the local preview without revoking the upstream browser session.

## Identity and projection

Identity is global cloud plus tenant UUID and signed object ID, never inferred from
an API JWT. Guest tenant partitions remain distinct. Message keys encode full account,
conversation, optional root and exact server ID as a JSON tuple. IDs/revisions stay
strings above JavaScript's safe integer range. Wire order is preserved; revisions
have no invented comparator and dates are not reconciliation cursors.

Explicit chatType determines chat kind; unknown kinds stay unsupported irrespective
of member count. Nested team channels remain channel records. Essential IDs/envelopes
and RFC3339 timestamps are checked. Text and RichText/Html remain distinct in raw DTOs;
preview projection strips HTML scripts/styles/tags into plain text without execution,
links or image loads. Unknown events have unsupported records, never fabricated normal
bodies. No complete membership, rich rendering, files or pagination qualification exists.

## Qualification and remaining work

All persistent-account, mutation, realtime, media, call and push capabilities are false.
No borrowed registration, archived credential or production Teams request was used.
A supported native sign-in broker, packaged browser acquisition, secure refresh/vault
lifecycle, account factories, database projection, Trouter/reconciliation and durable
writes remain future work. The original [handoff](../../docs/protocol/MICROSOFT_TEAMS.md)
acceptance ledger continues to apply. Fixture success does not establish production
identity support or complete DTO coverage.

## Validation

2026-10-10: mobile typecheck and touched-file ESLint pass; all 1,662 tests pass,
including synthetic browser signatures, loopback origin checks, cross-language public-key
handoff, corrupted/expired transfer rejection and reader expiry before any request.
The installed Edge dedicated-browser --smoke passes and removes its temporary profile.
Native build and rendered UI evidence are recorded in
[experimental integrations](../features/experimental-integrations.md).

## Sources

- scripts/teams-browser-signin.mjs
- scripts/teams/browser.mjs
- scripts/teams/server.mjs
- scripts/teams/session.mjs
- scripts/teams/session.test.mjs
- scripts/teams/server.test.mjs
- apps/mobile/providers/teams/protocol.ts
- apps/mobile/providers/teams/reader.ts
- apps/mobile/providers/teams/handoff.ts
- apps/mobile/providers/teams/handoff.test.ts
- apps/mobile/ui/teamsPreview.tsx
- apps/mobile/ui/experimentalPreview.tsx
- apps/desktop/crates/rv-core/src/teams.rs
- apps/desktop/crates/rv-core/src/teams_handoff.rs
- apps/desktop/crates/rv-ffi/src/teams.rs
- apps/desktop/crates/rv-gtk/src/teams_preview.rs
- apps/desktop/crates/rv-gtk/src/experimental_preview.rs
- apps/desktop/macos/Sources/RocketVibe/TeamsPreviewView.swift
- docs/protocol/fixtures/teams-read.json
- docs/protocol/fixtures/teams-handoff.json
- docs/protocol/MICROSOFT_TEAMS.md
