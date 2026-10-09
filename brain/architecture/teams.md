# Teams read foundation

Teams is a client-side provider under development. The native applications do
not expose Teams sign-in or accounts yet. The private service read code is a
candidate adapter from the handoff, qualified only with synthetic fixtures.
Graph DTOs, normal Rocket.Chat sessions and the RocketVibe server protocol are
not involved. See [protocol handoff](../../docs/protocol/MICROSOFT_TEAMS.md) and
[experimental integrations](../features/experimental-integrations.md).

## Mobile

providers/teams/protocol.ts validates identity, discovered routes, account
snapshot and history DTOs. reader.ts accepts one immutable account plus three
opaque audience tokens from a future qualified sign-in broker. It never decodes
API access tokens or chooses an OAuth client ID. This seam is not exposed as a
manual credential form or a persistent account factory.

POST authsvc/v1.0/authz uses the Spaces token. Its regionGtms fields
chatSvcAggAfd and chatServiceAfd supply the aggregator and chat routes. The
initial conservative global-cloud policy accepts only HTTPS teams.microsoft.com
proxy prefixes /api/csa/<region> and /api/chatsvc/<region>. Regional values are
not hard-coded. Direct service hosts, alternate alias names, sovereign clouds
and the other discovery services require separate qualification. Credentials
are never tried against a fallback host. Only a completely validated discovery
response replaces both routes. A later discovery supersedes an earlier request.
Skype tokens and unused authz fields are discarded.

The aggregator token reads the account snapshot. The chat token reads a bounded
message page and the exact opaque backwardLink after validating the same origin
and conversation path, including its discovered proxy prefix. Path components
are compared after one decoding pass without treating encoded slashes as path
separators. Redirects fail and the shared browser cookie jar is disabled. Reads
have a 15-second deadline, a 2 MB accepted-response limit and sanitized errors.
401 is audience_rejected; 403 is permission_denied. Neither erases credentials.
429 retains Retry-After without automatic retry. Close aborts outstanding requests
and drops tokens; a late completion cannot revive a closed reader. JavaScript
strings cannot promise physical memory zeroization.

## Desktop

rv-core/src/teams.rs supplies the same candidate adapter for future GTK and
SwiftUI integration. reqwest disables redirects, bounds streamed response bytes
and cancels outstanding work through a watch channel. Closing or dropping the
reader zeroizes retained audience token strings. There is no Teams UniFFI object,
GTK panel or SwiftUI view yet, so the parity row remains missing on all three.

## Identity and projection

Identity is global cloud plus validated tenant UUID and a stable account ID from
a supported sign-in result/profile. A caller must supply that result through the
future broker; the read seam alone does not qualify authentication. Guest tenant
partitions remain distinct. Message keys encode the complete account key,
conversation, optional root and exact server ID as a JSON tuple, with no delimiter
collisions. IDs and revisions must be strings, including values above JavaScript's
safe integer range. Revisions are retained without an invented comparator;
server wire order remains intact. Neither receive time nor a message date becomes
a reconciliation cursor.

Chats use explicit chatType; unrecognized kinds stay unsupported regardless of
member count. Nested team channels are channel records. Missing essential IDs or
malformed envelopes fail explicitly. History validates creation timestamps and
preserves their source strings. Text and RichText/Html stay separate; HTML is raw
adapter data, never rendered as executable content. Unknown event/message types
become unsupported records with no fabricated ordinary message body. No rich
text renderer, reactions, file projection or complete pagination claim exists.

## Next increment and qualification

T0/T1 remain open: no project registration was supplied, no borrowed Microsoft
application ID is embedded, and browser-session acquisition is not implemented.
Resolve the native sign-in/broker route before wiring this seam to the shared
nine-activation unlock or storing accounts. Secure refresh rotation, database
projection, Trouter/reconciliation, durable operations and feature parity follow.
All persistent-account, mutation, realtime, file, call and push capabilities are
explicitly false. No writes are defined by these readers.

The shared teams-read.json fixture is synthetic. TypeScript tests and Rust tests
check route roles, hostile origins, context-preserving paging, exact IDs, tenant
partitions, unknown types, audience headers, error sanitization and cancellation.
Mocked success does not establish accepted identity, production DTO completeness
or a usable integration. Live tenant success/failure captures remain outstanding.

## Validation

2026-10-09: the ten Teams TypeScript tests, mobile tsc --noEmit and touched-file
ESLint pass. The final Fedora scripts/build.sh gate passes formatting, clippy
with warnings denied, all 580 desktop tests (including eight Teams tests) and
the workspace binary build. All Teams protocol qualification uses synthetic
fixtures or loopback HTTP, with no real Teams credential or production call.

## Sources

- apps/mobile/providers/teams/protocol.ts
- apps/mobile/providers/teams/reader.ts
- apps/mobile/providers/teams/protocol.test.ts
- apps/desktop/crates/rv-core/src/teams.rs
- docs/protocol/fixtures/teams-read.json
- docs/protocol/MICROSOFT_TEAMS.md
