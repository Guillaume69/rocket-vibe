# Avatars

How user and room photos are fetched, how a gradient tile stands in when there is no photo, and how a changed or removed photo reaches the screen despite caches that never revalidate. The mechanism is the same in both apps: a version (`avatarETag`) appended to the URL as a query parameter, learnt from several sources.

## The server contract

- **URLs.** `/avatar/<username>`, `/avatar/uid/<uid>`, `/avatar/room/<rid>`. The target server sets `Accounts_AvatarBlockUnauthenticatedAccess`, so each read carries `rc_uid` and `rc_token` in the query, on our own origin only (same rule as files, see [media-playback.md](media-playback.md)).
- **No photo** answers a generated initials SVG, not a 404. Both apps treat that SVG as "no photo" and keep their own gradient tile.
- **No revalidation.** `/avatar/...` answers `Cache-Control: public, max-age=3600` and no HTTP `ETag` (probed on 8.5). An image cache keyed on the URI (Android's Fresco in particular) therefore keeps the first photo for that URI for ever. The URI must change when the photo changes: the client appends `?etag=<avatarETag>`, a parameter the server ignores.
- **Where the version comes from**, freshest first:
  - `stream-notify-logged` / `updateAvatar`: `args: [{username, etag}]` for a user (the username, never the uid) or `[{rid, etag}]` for a room. After `users.resetAvatar` the event comes **without** `etag`: the client must still change the URI, or it falls back to the old form the cache serves with the old photo. Mobile stores the marker `AVATAR_SANS_PHOTO` (`sans-photo`), desktop `media::NO_PHOTO` (`none`); the URL then serves the SVG and the tile comes back.
  - `me` (my own `avatarETag`), read at connection: the only way to learn a photo changed while the app was closed.
  - `users.info` (a profile opened) and the room document's `avatarETag`. The field is **absent** when there is no photo, and partial documents omit it too, so a missing value must never overwrite a known one.
- **Name changes are not broadcast** on 8.5 (no `Users:NameChanged`, no `rooms-changed`); only the photo and the username propagate live.

## Mobile

- **URL builder.** `urlAvatar` in `lib/upload.ts`: username first, else uid, else rid, plus `?etag=` when known, then `urlFichierProtege` for the token. Returns `null` when nothing designates a target, and the caller keeps its tile.
- **Tiles.** `TuileAvatar` in `ui/kit.tsx` draws a rounded gradient tile with an initial (or a child: a padlock, a "+"), its colour stable per key so a person keeps their hue everywhere; the photo is laid over it, and when the server returns the SVG, `<Image>` fails to decode it and `onError` uncovers the tile again. `AvatarSalon` (same file) picks the target: a DM shows the other participant by uid with that uid's etag, a channel or group shows the room photo with the room's etag. A locked encrypted room shows a grey tile with a closed padlock; once E2EE is unlocked it looks like any room. Its `avatarEtag` prop is mandatory to write (even as `undefined`): optional, it was silently forgotten once (`app/partager.tsx`), freezing a room photo.
- **Storage.** Room versions live in `salons.avatar_etag`; user versions in the `utilisateurs` (users) table (uid, current username, `avatar_etag`), fed by every ingested message, by `me` at catch-up (`lireMonIdentite` in `lib/monProfil.ts`, called from `lib/rattrapage.ts`), by `users.info` when a profile opens, and by the stream. Upserts use `COALESCE` so a null never erases a version (`UPSERT_IDENTITE`, `UPSERT_SALON` in `db/upserts.ts`). Because `updateAvatar` names users by username and can only update an existing row, ingesting a DM room also inserts the other participant into `utilisateurs` (`upsertSalon` in `db/depot.ts`); otherwise a never-opened DM's photo would never refresh. The other participant's username is matched by the "not me" rule, never by index, since `uids` and `usernames` are not aligned.
- **Stream.** `traduireAvatar` in `fournisseurs/rocketchat/traducteur.ts` turns `updateAvatar` into an `avatar` change; `majAvatarUtilisateur` and `majAvatarSalon` write it.
- **Reading.** `ui/identites.tsx` (`SuiviIdentites`) reads `utilisateurs` with one live query and pushes into two module-level stores in `ui/storeIdentites.ts`: usernames by uid, and photo versions by uid and by username (`useEtagsAvatars`), so a rename does not re-render photos and the reverse. Both stores are emptied at session end so a new account never inherits the previous one's versions.
- **My own photo.** `app/mon-profil.tsx`: `ui/choisirAvatar.ts` opens the system photo picker (no gallery permission needed), crops square and compresses; `definirAvatar` (`lib/upload.ts`) sends `users.setAvatar` as one multipart POST with the field **`image`** (not `file`), no two-step confirmation. Afterwards the screen re-reads `me` and stores the new version, so the list, messages and settings update without depending on the socket. There is no "remove photo" action on mobile.

## Desktop

- **URL builder.** `media::avatar_path` (`rv-core/src/media.rs`, with `AvatarTarget::User`, `Uid`, `Room`) percent-encodes like `encodeURIComponent` (a `+` in a username is literal in a path) and appends `?etag=`. `media::room_avatar_path` decides a room tile's photo: a DM shows the other participant by uid (with no version), a channel or group the room photo with the room's `avatar_etag`, and an encrypted room always keeps its grey padlock, locked or not.
- **Versions.** User versions live in memory only: `Session.avatars` (username to etag), filled by `updateAvatar` and by profiles read with `users.info`, read by `Session::user_avatar`. Room versions are stored (`rooms.avatar_etag`, written by `Store::set_room_avatar` on the stream, kept by `COALESCE` on upserts). Each change emits `SessionEvent::Avatar`; the GTK window then rebuilds the room list and rebinds the message rows (`ChatPage::on_avatar` in `rv-gtk/src/chat.rs`).
- **Fetching.** `MediaCache` in rv-core fetches with the token and is simply emptied past 400 entries. `rv-gtk/src/media.rs` keeps one decoded texture per path for the session, remembers "no usable image" (`Media::is_placeholder`: an SVG content type or a body starting with `<`), and shares one request among every widget waiting. `rows::with_photo` lays the texture over the tile (`widgets::set_photo`). The texture cache is cleared at session stop, so a fresh launch refetches everything.
- **My own photo.** `rv-gtk/src/settings.rs` shows my photo from `me`'s `avatarETag`, uploads a new one with `Session::set_avatar` (`users.setAvatar`, multipart field `image`) and removes it with `Session::reset_avatar` (`users.resetAvatar`).
- **SwiftUI.** `Avatar` in `macos/Sources/RocketVibe/Media.swift` lays the photo over a gradient tile of initials (the Android gradients) and keeps the tile when there is none; photos are fetched through `rv-ffi` by `RocketVibeKit/MediaStore.swift` and decoded off the main thread (`Pictures.swift`).

## Parity

[parity](../parity.md) §3 "Photo avatars over gradient tiles" holds on both. Gaps found in code: on desktop a DM's tile uses `/avatar/uid/<uid>` without a version, so a DM partner's new photo shows in the room list only once the texture cache is rebuilt (next session), while their message rows, keyed by username, update live; desktop keeps user versions in memory, so after a restart message rows use unversioned URLs until a stream event or profile read (harmless there because the cache starts empty). Mobile cannot remove a photo; desktop can.

## Sources

- apps/mobile/lib/upload.ts
- apps/mobile/lib/monProfil.ts
- apps/mobile/lib/rattrapage.ts
- apps/mobile/lib/normaliser.ts
- apps/mobile/ui/kit.tsx
- apps/mobile/ui/identites.tsx
- apps/mobile/ui/storeIdentites.ts
- apps/mobile/ui/choisirAvatar.ts
- apps/mobile/app/mon-profil.tsx
- apps/mobile/app/partager.tsx
- apps/mobile/db/schema.ts
- apps/mobile/db/upserts.ts
- apps/mobile/db/depot.ts
- apps/mobile/fournisseurs/rocketchat/traducteur.ts
- apps/desktop/crates/rv-core/src/media.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/info.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-gtk/src/media.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/macos/Sources/RocketVibe/Media.swift
- apps/desktop/macos/Sources/RocketVibe/Pictures.swift
- apps/desktop/macos/Sources/RocketVibeKit/MediaStore.swift
