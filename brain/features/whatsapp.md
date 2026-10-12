# WhatsApp linked-device pilot

Experimental desktop work on `claude/whatsapp-feasibility` (continuing `codex/whatsapp-feasibility`): a user links an existing personal WhatsApp account by scanning a QR from the official phone app, then uses RocketVibe's native conversation interface. The implementation is a local third-party linked-device connector, not Meta's Business API. Real account qualification is pending.

## Desktop

GTK has a separate pilot window. Launch with `RV_WHATSAPP_PILOT=1`; when a sidecar is installed next to the executable, the ordinary sign-in page also offers Connect WhatsApp. The window reuses the existing `MessageList`, `Composer`, room tiles and theme. It shows transient QR codes, supported cached/live text, conversation selection, text sends and unlinking; contact and group names (resolved when shown, from the name table the helper refreshes as contacts sync), profile photos on the conversation tiles and beside messages, reactions as the timeline's chips, edited and deleted messages, and a message menu with quick reactions, copy, and on my own messages edit (15 minutes) and delete for everyone (48 hours, confirmation closes on a backdrop click).

`rv-core/src/whatsapp.rs` starts the Go helper through private pipes and maintains a bounded in-memory projection. The helper uses pinned whatsmeow, keeps SQLite in memory and writes authenticated encrypted snapshots. A separate OS-keychain entry wraps the snapshot; unavailable secure storage fails closed. No conversation or device key is routed through a RocketVibe server. A durable send intent precedes its network attempt, and ambiguous sends are never automatically replayed; the window gives a text back as a draft only when the send provably never left (refused by id, helper exited without a record, or a restarted helper's replay lacks it). Non-fatal errors (a refused send, a failed unlink) keep the connection; an ended session restarts the helper once the old one released its state lock.

This is not yet a normal `provider::Chat` account or a supervised rail account. Existing release packages do not bundle the helper. Linux synthetic IPC and rendering qualification is recorded in [the handoff](../../docs/WHATSAPP_HANDOFF.md); real WhatsApp and Windows packaging remain pending. SwiftUI has no WhatsApp window or FFI adapter.

A phone number and its LID make one conversation once WhatsApp maps them (`apps/desktop/whatsapp/store.go`, `normalize`). Media, calls, receipts, unread counters, quoted replies and complete history are not there yet. View-once and disappearing content are excluded from the text cache.

## Mobile

Missing. No WhatsApp provider, association UI or background connector is added. Android implementation requires a separate native embedding and background-notification design after the desktop increment.

## Web

`n/a`: the web app speaks to its serving RocketVibe origin only. The local desktop process does not create a browser API or server bridge.

## Sources

- apps/desktop/whatsapp/main.go
- apps/desktop/whatsapp/engine.go
- apps/desktop/whatsapp/store.go
- apps/desktop/whatsapp/identity.go
- apps/desktop/whatsapp/avatars.go
- apps/desktop/crates/rv-gtk/src/message_list.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/whatsapp/vault.go
- apps/desktop/whatsapp/go.mod
- apps/desktop/whatsapp/vault_test.go
- apps/desktop/whatsapp/README.md
- apps/desktop/scripts/build-whatsapp.sh
- apps/desktop/scripts/smoke-whatsapp.sh
- apps/desktop/crates/rv-core/tests/support/fake_whatsapp_sidecar.rs
- apps/desktop/crates/rv-core/src/whatsapp.rs
- apps/desktop/crates/rv-core/tests/whatsapp.rs
- apps/desktop/crates/rv-gtk/src/whatsapp_pilot.rs
- apps/desktop/crates/rv-gtk/src/login.rs
- apps/desktop/crates/rv-gtk/src/secrets.rs
- docs/WHATSAPP_HANDOFF.md

