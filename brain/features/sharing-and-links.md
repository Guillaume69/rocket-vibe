# Sharing and links

How content and links cross the app's boundary: `rocketvibe://salon/<rid>?host=<server>` deep links that open a room (from notifications, or from outside), the system share sheet sending files and text into a room, and links in messages leaving for the browser under a guard that never lets session credentials out.

## The `rocketvibe://` link

Scheme `rocketvibe`, registered by `app.json` (`"scheme": "rocketvibe"`) on mobile and by each desktop package. Form: `rocketvibe://salon/<rid>?host=<server URL>`; the desktop parser also accepts `room` as the host part. The `host` names which server the room belongs to, because several sessions can coexist and every server the device is signed in to pushes to it. Without it, a rid from another server landed on a room screen with no row for it and spun forever.

The link is produced by the Android push service for every conversation notification ([notifications.md](notifications.md)); on iOS the tap goes through expo-notifications with `rid` and `host` from `ejson`, then the same route.

## Mobile

### Deep links

- **Routing.** expo-router maps `rocketvibe://salon/<rid>` to `app/salon/[rid].tsx` and merges the query into the route params, so `host` arrives through `useLocalSearchParams` (a behaviour read in expo-router's code, see the project facts). `app/+native-intent.tsx` (`redirectSystemPath`) passes every path through except the iOS share extension's `rocketvibe://dataUrl=<key>` callback, which is not a route and would show "page not found".
- **Cold start and running.** The Android notification intent uses only `FLAG_ACTIVITY_NEW_TASK`; `MainActivity` is `singleTask`, so a running app receives it through `onNewIntent` and a dead one starts fresh, both carrying the URL.
- **No session**: the room screen redirects to `/connexion`.
- **Other server.** The screen compares origins (`origineDe`/`memeOrigine`, `lib/origine.ts`), never the raw string, since any app can send that intent. A non-web `host` is ignored. A different origin renders `AutreServeur`: an explicit button naming the target server, which calls `changerDeServeur(host)` and, on success, `replace`s the route without `host` so it cannot replay later. The switch is never automatic: it moves the resume pointer, closes the socket and opens another database ([login-and-servers.md](login-and-servers.md)).

### Incoming shares

- **Library.** `expo-share-intent` declares the Android `SEND`/`SEND_MULTIPLE` intent filters (`text/*`, `*/*`) and the iOS share extension (text, one web URL or page, up to 10 images, movies or files), configured in `app.json`. The native module copies `content://` URIs to readable paths.
- **Routing.** `GardePartage` (`app/_layout.tsx`) pushes `/partager` once per incoming share (rising-edge guard), re-armed when the screen calls `resetShareIntent`.
- **Screen** `app/partager.tsx`, a modal: preview of the shared files or text, a caption prefilled with the shared text or URL, and a pick among existing local conversations (channels, groups, DMs; no destination invented). Images are compressed when useful (`compresserImageSiUtile`) while the preview keeps the original URI, to avoid thumbnails reloading. Sending reuses the room's engines: `fichiers.envoyer` for attachments (caption on the file), `envoi.envoyer` for text alone; validation errors (size, encrypted room without file support) come from `phraseValidation`. Then it replaces itself with the target room.
- **No replay.** When Android recreates `MainActivity` (process killed, or relaunched from recents) it hands back the intent that created the task, and expo-share-intent would reopen the share screen on every launch. `plugins/with-partage-entrant.js` patches `onCreate`: a restored activity (`savedInstanceState`) or one launched from history whose intent is a `SEND` gets the launcher's `MAIN` intent instead, before `super.onCreate`.

### Outgoing links

- **One exit.** `ui/lienExterne.ts::ouvrirLienExterne` is the only caller of `Linking.openURL` (markdown links, link cards, embed cards). It refuses silently unless `lib/lienExterne.ts::peutSortirDuProcessus` holds: the URL is `http(s)://` (no `javascript:`, `intent:`, `file:`, `content:`) **and** carries no `rc_uid=`/`rc_token=`. Protected file URLs embed those credentials in the query (`urlFichierProtege`, `lib/upload.ts`) and a `rc_token` is worth the whole account; such URLs are for in-process use only (images, players, downloads). The file branch of a message downloads and shares a local file instead of opening a URL; the guard makes a regression fail closed.
- `@user` mentions stay inside the app (they open the profile sheet); `#channel` mentions are styled but not tappable.

## Desktop

- **Registration.** Linux: `data/com.rocketvibe.app.desktop` declares `MimeType=x-scheme-handler/rocketvibe` with `Exec=rocket-vibe-gtk %u`, and the AppImage install script writes the entry. Windows: the Inno Setup script (`data/windows/rocket-vibe.iss`) registers `HKCU\Software\Classes\rocketvibe` with `"%1"`. macOS: `data/macos/Info.plist` declares the URL scheme.
- **Delivery.** The GTK app runs with `HANDLES_OPEN`; `connect_open` passes each URI to `Window::open_link` (`rv-gtk/src/main.rs`). On Windows a second launch hands its arguments to the first through a named mutex and a window message (`rv_native::claim_instance`); `rv_native::forwarded` turns a `rocketvibe:` argument into `AppEvent::Open`, which `background.rs` feeds to `app.open`. The SwiftUI app handles `onOpenURL` (`RocketVibeApp.swift`).
- **Resolution** (`rv-core/src/links.rs`): `parse` extracts the rid and the lowercased host name; `fits` compares it with a session's base URL **by host name only** (a link without host fits any). `open_link` opens the room if the current account fits; otherwise it **switches automatically** to the signed-in account whose server fits, and `follow_link` opens the room once that server's rooms are loaded.
- **Shares.** Desktop has no share target; the equivalent is dropping or pasting files and text into a room: drop targets in `chat.rs`, clipboard files or a pasted picture (saved as a temporary PNG) in the composer (`composer.rs`, `attach.rs`), staged before sending ([uploads.md](uploads.md)).
- **Outgoing links.** Markdown links are kept only for `http://`, `https://` and `mailto:` (`rv-core/src/markdown.rs`), and opened with `gtk::UriLauncher` (`cards::open_uri`). Call windows send off-origin navigation to the browser ([calls.md](calls.md)).

## Parity

PARITY §13: room links open the room on both (desktop registered as URL handler); share sheet on mobile versus drop and paste on desktop. Differences: mobile asks before switching server, desktop switches by itself; mobile compares full origins (scheme, host, port), desktop compares host names.

## Sources

- apps/mobile/app.json
- apps/mobile/app/+native-intent.tsx
- apps/mobile/app/_layout.tsx
- apps/mobile/app/partager.tsx
- apps/mobile/app/salon/[rid].tsx
- apps/mobile/plugins/with-partage-entrant.js
- apps/mobile/plugins/with-fcm-deeplink.js
- apps/mobile/lib/origine.ts
- apps/mobile/lib/lienExterne.ts
- apps/mobile/lib/upload.ts
- apps/mobile/ui/lienExterne.ts
- apps/mobile/ui/markdown.tsx
- apps/mobile/ui/notifications.tsx
- apps/mobile/ui/preparerPieceJointe.ts
- apps/mobile/ui/validationFichiers.ts
- apps/desktop/crates/rv-core/src/links.rs
- apps/desktop/crates/rv-core/src/markdown.rs
- apps/desktop/crates/rv-gtk/src/main.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/background.rs
- apps/desktop/crates/rv-gtk/src/attach.rs
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/crates/rv-native/src/lib.rs
- apps/desktop/crates/rv-native/src/windows_shell.rs
- apps/desktop/data/com.rocketvibe.app.desktop
- apps/desktop/data/windows/rocket-vibe.iss
- apps/desktop/data/macos/Info.plist
- apps/desktop/scripts/install.sh
- apps/desktop/macos/Sources/RocketVibe/RocketVibeApp.swift
- apps/desktop/docs/PARITY.md
