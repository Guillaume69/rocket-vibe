# WhatsApp linked-device pilot

Experimental desktop work on `codex/whatsapp-feasibility`: a user links an existing personal WhatsApp account by scanning a QR from the official phone app, then uses RocketVibe's native conversation interface. The implementation is a local third-party linked-device connector, not Meta's Business API. Real account qualification is pending.

## Desktop

GTK has a separate pilot window. Launch with `RV_WHATSAPP_PILOT=1`; when a sidecar is installed next to the executable, the ordinary sign-in page also offers Connect WhatsApp. The window reuses the existing `MessageList`, `Composer`, room tiles and theme. It shows transient QR codes, supported cached/live text, conversation selection, text sends and unlinking.

`rv-core/src/whatsapp.rs` starts the Go helper through private pipes and maintains a bounded in-memory projection. The helper uses pinned whatsmeow, keeps SQLite in memory and writes authenticated encrypted snapshots. A separate OS-keychain entry wraps the snapshot; unavailable secure storage fails closed. No conversation or device key is routed through a RocketVibe server. A durable send intent precedes its network attempt, and ambiguous sends are never automatically replayed.

This is not yet a normal `provider::Chat` account or a supervised rail account. Existing release packages do not bundle the helper. Linux synthetic IPC and rendering qualification is recorded in [the handoff](../../docs/WHATSAPP_HANDOFF.md); real WhatsApp and Windows packaging remain pending. SwiftUI has no WhatsApp window or FFI adapter.

Media, calls, receipts, reactions, edits/deletion reconciliation, unread counters, PN/LID alias normalization and complete history are outside the qualified increment. View-once and disappearing content are excluded from the text cache.

## Mobile

Missing. No WhatsApp provider, association UI or background connector is added. Android implementation requires a separate native embedding and background-notification design after the desktop increment.

## Web

Missing and outside the current browser client's provider scope. The local desktop process does not create a browser API or server bridge.

## Sources

- apps/desktop/whatsapp/main.go
- apps/desktop/whatsapp/vault.go
- apps/desktop/whatsapp/go.mod
- apps/desktop/whatsapp/vault_test.go
- apps/desktop/whatsapp/README.md
- apps/desktop/scripts/build-whatsapp.sh
- apps/desktop/crates/rv-core/src/whatsapp.rs
- apps/desktop/crates/rv-core/tests/whatsapp.rs
- apps/desktop/crates/rv-gtk/src/whatsapp_pilot.rs
- apps/desktop/crates/rv-gtk/src/login.rs
- apps/desktop/crates/rv-gtk/src/secrets.rs
- docs/WHATSAPP_HANDOFF.md

