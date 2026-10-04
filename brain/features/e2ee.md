# Encrypted rooms

Encrypted (E2EE) rooms are readable and writable in both apps once the user unlocks them with their E2E password; until then they degrade cleanly: a lock on the tile, no ciphertext anywhere, a read-only room and a generic notification. The mechanism (formats, keys, crypto libraries) is in [../architecture/e2ee.md](../architecture/e2ee.md).

## What the user sees

- **Room list.** Encrypted rooms carry a lock (🔒). Their preview is the last message decrypted when unlocked, otherwise a fixed "Encrypted messages" label; the base64 blob of `lastMessage` is never rendered.
- **Room, locked.** Each `t: 'e2e'` message shows a placeholder ("🔒 Message chiffré, non pris en charge" on mobile, "message.encrypted" on desktop). The composer is replaced by an unlock affordance, since the server would refuse clear text in that room (`error-not-allowed`).
- **Unlock.** A password prompt asks for the E2E password (distinct from the login password). A wrong password says so; a missing key ("no E2E keys on this account") or a network error get their own message. On success the prompt closes and the messages already loaded turn readable in place, without reloading the room.
- **Once per device.** The unlocked private key is kept (Keystore on mobile, system keychain on desktop), so later launches open unlocked without asking. Settings shows the state and offers "Lock" (forget the key on this device) or "Unlock".
- **Unlocked.** Reading, sending, editing, replying in threads, and sending or opening files all work as in a clear room. Mentions still notify, because the apps declare them in `e2eMentions`.
- **Notifications.** Never ciphertext: a generic "Encrypted message" body, and no inline reply from the notification on mobile (the server would refuse a clear reply).
- **Not supported anywhere:** creating an encrypted room or toggling encryption on a room; setting up or resetting a key pair. Users without keys must create them from the web or the official app.

Why it was built at all: the target server (`chat.barrut.me`) has `E2E_Enable = true` with a single encrypted room out of 25. ROADMAP §6.6 planned degradation only and listed full support as an optional plan B; both apps went on to implement plan B. See [../decisions.md](../decisions.md).

## Mobile

- **Unlock sheet**: `app/deverrouiller-e2e.tsx`, a native `formSheet`. It is opened from the locked composer (`ComposerVerrouille` in `ui/composer.tsx`, label `salon.chiffreVerrouille`) or from the Settings encryption section (`SectionE2E` in `app/parametres.tsx`). It calls `synchro.deverrouillerE2E`, which unlocks the engine, decrypts the messages already in SQLite, refreshes the list previews and restarts the text outbox and upload queue. The password field sets `autoComplete="password"` and `importantForAutofill` so password managers fill it.
- **Errors**: `ErreurE2E` (failed GCM authentication) shows `e2e.erreurMotDePasse`; anything else `e2e.erreurGenerique`.
- **Resume**: at session start `ui/synchro.tsx` calls `e2e.reprendre()` off the critical path; a JWK kept for this (server, account) unlocks silently.
- **Placeholders**: `ui/ligneMessage.tsx` shows `ligneMessage.chiffre` for an undecrypted message and `ligneMessage.fichierIllisible` for a file whose decryption fails. `app/index.tsx` shows `accueil.messagesChiffres` while no message of the room has been decrypted.
- **Encrypted media**: the server only holds ciphertext, so an image, audio or video is downloaded and decrypted into the cache before display (`fichierDechiffre`, `ui/fichierJoint.ts`). Beyond 25 MB (`APERCU_CHIFFRE_MAX`) or for other file types the attachment stays a card, decrypted when shared or saved.
- **Sending files**: the plain file is read, encrypted (`ui/chiffrementFichier.ts`), written to a temp file in the cache, uploaded, then deleted. Without `E2E_Enable_Encrypt_Files` the picker refuses with `commun.fichiersChiffresDesactives` (`ui/validationFichiers.ts`).
- **Waiting while locked**: text and files typed or queued in an encrypted room before unlock wait in their queues (`AttenteCle`) and leave on unlock; they never go out in clear.
- **Lock**: Settings "Lock" erases the key from memory and Keystore and re-masks the clear text kept in SQLite.
- Room info (`app/salon-info.tsx`) lists "encrypted" among the room's facts and shows the lock.

## Desktop

GTK (`rv-gtk`) and the SwiftUI app share `rv-core`'s engine.

- **GTK**: a banner (`e2e_banner`) in an encrypted locked room opens `unlock::ask` (`rv-gtk/src/unlock.rs`), an `adw::Dialog` that stays up until the password works. While locked the composer is hidden and the label reads `e2e.read_only` (`chat.rs`). Settings has an E2EE row that locks or opens the dialog (`settings.rs`). Messages decrypt as they are read (`Session::open_row`), so lock and unlock repaint without touching the DB; `chat.on_e2e()` reloads the view on `SessionEvent::E2e`.
- **Room previews** decrypt the last message from `rooms.lastMessage.content` (`last_encrypted`) when unlocked, else show `rooms.encrypted` (`rows.rs`).
- **Key kept** in the account's keychain item and resumed at session start (`secrets.rs`, `window.rs`).
- **SwiftUI**: `RoomView.swift` shows the locked state with an unlock button and `UnlockSheet`; `SettingsView.swift` has the status and a Lock button; `AppModel.e2eUnlocked` tracks state from `Event::E2e`.

## Parity

Same feature set on both sides (PARITY §11): unlock, decrypt messages and previews, lock, AES-128 and AES-256 room keys, encrypted send/edit/thread replies, encrypted files in both directions, key kept across launches. Difference in mechanism: mobile writes the decrypted text into SQLite and wipes it on lock, desktop decrypts on every read. Neither app creates encrypted rooms.

## Sources

- apps/mobile/app/deverrouiller-e2e.tsx
- apps/mobile/app/parametres.tsx
- apps/mobile/app/index.tsx
- apps/mobile/app/salon-info.tsx
- apps/mobile/ui/composer.tsx
- apps/mobile/ui/ligneMessage.tsx
- apps/mobile/ui/fichierJoint.ts
- apps/mobile/ui/chiffrementFichier.ts
- apps/mobile/ui/validationFichiers.ts
- apps/mobile/ui/synchro.tsx
- apps/mobile/ui/e2e.ts
- apps/mobile/ui/messages.ts
- apps/mobile/lib/e2e/moteur.ts
- apps/mobile/lib/envoiFichiers.ts
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/unlock.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-gtk/src/secrets.rs
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibe/SettingsView.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/desktop/docs/PARITY.md
- ROADMAP.md
