# Slack session provider, researched contract

Slack has a first transient read-only preview on Android, GTK and SwiftUI, hidden
behind nine activations of the login icon. It validates manually supplied session
credentials and pages conversations/history; persistent accounts and the full
provider remain missing. See [experimental integrations](../features/experimental-integrations.md).
The ordinary selectors support Rocket.Chat, RocketVibe, Mattermost and kChat.
The design and protocol handoff are
in [SLACK_SESSION.md](../../docs/protocol/SLACK_SESSION.md), its repeatable
qualification cases in [SLACK_SESSION_PROBES.md](../../docs/protocol/SLACK_SESSION_PROBES.md),
and its measured/source/pending results in
[slack-session-evidence.json](../../docs/protocol/slack-session-evidence.json).

## Authentication and transport

The selected route is Session mode: obtain the user's Slack `d` cookie,
derive a workspace `xoxc` token from authenticated boot data, validate the
team/account and keep both in OS secure storage. The primary proposed desktop
login drives an owned throwaway Chromium profile. The reference's desktop-app
importer covers Linux only; Windows/macOS imports and mobile acquisition are
unqualified. An existing Firefox session supplied the investigation's credentials,
which does not deliver a Chromium login helper.

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
Current platform debt is recorded in [parity](../parity.md#17-experimental-integrations).

## Sources

- apps/mobile/providers/slack/client.ts
- apps/desktop/crates/rv-core/src/slack.rs
- apps/desktop/crates/rv-ffi/src/slack.rs

- `docs/protocol/SLACK_SESSION.md`, `docs/protocol/SLACK_SESSION_PROBES.md`, `docs/protocol/slack-session-evidence.json`
- `apps/mobile/lib/provider.ts`, `apps/mobile/providers/index.ts`
- `apps/desktop/crates/rv-core/src/native.rs`, `apps/desktop/crates/rv-core/src/session.rs`
- `apps/desktop/crates/rv-ffi/src/`, `apps/desktop/macos/Sources/RocketVibeKit/`
