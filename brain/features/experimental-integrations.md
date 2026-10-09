# Experimental integrations

Slack is the first implementation increment from the provider handoffs. Teams is
queued, with its document integrated and no Teams code started. The first Slack
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
authorization. The same gate will eventually reveal Teams when its increment exists.

## Mobile

lib/experimentalUnlock.ts implements the sequence; ui/experimentalProviders.ts
persists only the enable flag in SecureStore. app/login.tsx attaches it to the
unicorn button. ui/slackPreview.tsx shows the paired masked xoxc token and original
d cookie value, validates the workspace/user with auth.test, then lists joined
conversations through users.conversations. Selecting a conversation reads a
page of conversations.history. Load more carries the server cursor unchanged;
repeated cursors fail explicitly. Refresh rereads the first page.

providers/slack/client.ts sends form POSTs only to https://slack.com/api/, with
Bearer and the exact original cookie bytes. Credentials are in memory only;
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

GTK embeds slack_preview.rs under the login hero, with masked native entries,
conversation buttons and selectable message text. SwiftUI uses
SlackPreviewView.swift over the transient SlackPreview UniFFI object. The
unlock flag lives at <config>/rocket-vibe-rs/experimental-providers, shared by
the desktop interfaces. Removing a preview never revokes the upstream browser
session. Outstanding Swift authentication is fenced after cancellation; the
bounded Rust request may finish before its result is closed and discarded.

## Limits and next increments

Only manually supplied session credentials are supported. This code has fixture
coverage and does not replace the protocol's live qualification plan. No account
credentials were used during implementation. Installed Android and macOS runtime
qualification remains outstanding. Message bodies display as plain text with
Slack formatting syntax; author IDs remain IDs, non-text content has a placeholder.
Thread replies, files, real-time RTM, credential acquisition, secure persistent
accounts, local/offline projection and writes remain missing. A has_more history
response without a cursor fails as pagination_unsupported instead of silently
claiming a complete page sequence. No automated quota retry or background polling.

Next: own browser acquisition and vault lifecycle (S-A), then neutral projection
(S-B), cookie RTM plus reconnect repair (S-C), then durable writes (S-D). Finish
and qualify the Slack increments before beginning Teams implementation.

## Sources

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
