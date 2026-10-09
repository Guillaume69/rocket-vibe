# Room info and profiles

Three read-on-demand views and one editor: a room's information sheet, a person's profile (with Message and Call actions), and "my profile" to change my status, name, bio, email, username and photo. Room details and profiles are fetched from the server each time they open and never stored locally.

## Server contract

- `GET rooms.info {roomId}`: `fname`/`name`, `t`, `topic`, `announcement`, `description`, `usersCount`, `ro`, `encrypted`, `archived`, `default`.
- `GET users.info {username}` or `{userId}` (one or the other): `name`, `username`, `status`, `statusText`, `roles`, `utcOffset` (hours, may be fractional, 5.5 for India), `bio`, `avatarETag`.
- `GET me`: my own fields (`statusDefault`, `statusText`, `emails[0].address`, `bio`, `avatarETag`, `settings.preferences`).
- `POST users.setStatus {status, message}`: both fields are always sent, because the server clears whichever is omitted.
- `POST users.updateOwnBasicInfo {data}`: only the changed fields among `name`, `username`, `email`, `bio`. Changing `username` or `email` requires `currentPassword` (the SHA-256 of the password) and often triggers 2FA (`totp-required`), replayed with the code through the same mechanism as login ([login-and-servers.md](login-and-servers.md)). Re-sending an unchanged email would restart a verification, hence the diff.
- `POST users.setAvatar` (multipart field `image`), `POST users.resetAvatar`. Avatar versions and cache busting: [avatars.md](avatars.md).
- `POST rooms.favorite {roomId, favorite}` toggles the favourite flag.

## Mobile

- **Room info** `app/room-info.tsx`, a native `formSheet` opened by tapping the room name in the header (`ui/roomHeader.tsx`). For a DM the header goes straight to the other person's profile instead: the "info" of a one-to-one is the person. The skeleton (name, avatar, type, encrypted and read-only flags) comes from the local DB and shows immediately, offline included; member count, announcement, topic and description arrive from `rooms.info`. It also toggles the favourite (`rooms.favorite`), with an error line on failure. Encrypted rooms show the lock and a decrypted-or-not tile (see [e2ee.md](e2ee.md)).
- **Profile** `app/profile.tsx`, a `formSheet` sized `fitToContents`. Opened from a message's avatar or author name (`ui/messageRow.tsx`), an `@mention` (`ui/markdown.tsx`) or the DM header. Shows avatar, name, `@username`, presence, roles, the person's local time (`14:07 (UTC+2)`, computed from `utcOffset`) and bio (falling back to `statusText`). Actions: Message (`actions.openOrCreateDm`, `im.create`, idempotent) and Call when a conference provider exists ([calls.md](calls.md)). **Report this user** (not on my own profile, when the server takes reports) swaps in `ui/reportForm.tsx` for a reason and sends it through `provider.reports.user` (`moderation.reportUser` on Rocket.Chat), then toasts "Report sent" ([administration.md](administration.md)).
- **Preloading** (`lib/profilePreload.ts`): a `fitToContents` sheet measures itself on first render, so content arriving later made it jump. `openProfileCard` fetches `users.info` and settles the call probe **before** navigating; the screen reads the result with `readPreloadedProfile` and renders at its final height. It is a hand-off buffer, not a freshness cache: each opening refetches. The client and the navigator are module singletons (`setProfileClient`, `setProfileNavigator`) because mentions are rendered by plain functions with nothing at hand; `ui/openingIndicator.tsx` shows feedback if the fetch drags.
- **My profile** `app/my-profile.tsx`, a full page (it has a keyboard), reached from the profile card of the My account settings category. One Save button calls only the endpoints of what changed (`lib/myProfile.ts`: `diffInfos`, `requiresPassword`, `saveStatus`, `saveBasicInfo`): presence among online/away/busy/offline plus status text, name, bio, email, username, and a new photo picked with `ui/pickAvatar.ts` (`setAvatar`, `lib/upload.ts`). The current password field appears when email or username changes; a 2FA challenge is answered with `prepareTwoFactorCode`.

## Desktop

- **Room info** (`rv-gtk/src/details.rs::room_info`): an `adw::Dialog` from the room title (tooltip `info.room`). For a DM, `show_room_info` opens the partner's profile by id instead. Facts line: public/private, members, read-only, encrypted, archived, default; then topic, announcement and description as markdown sections, or "nothing to show". Parsed by `rv-core/src/info.rs::room_info`.
- **Profile** (`details.rs::profile`): by username or by id. Avatar, name, `@username`, presence (live presence from the session first, then `users.info`'s) with status text, role chips, local time (`info::local_time`), bio. Message and Call buttons for anyone but me (`ProfileActions`), and below them **Report this user** (Rocket.Chat always, RocketVibe when `reports_supported`), which closes the profile and asks the reason in `admin::report` ([administration.md](administration.md)). Opened from avatars and names (`RowEvent::Profile`), mentions, and DM headers.
- **Favourite**: toggled from the room list's context menu (`chat.rs`, `actions::favorite`), not from the info dialog.
- **My profile** (`rv-gtk/src/settings.rs`): the My account category shows a profile card, a status group (presence combo and a status text entry, saved on change through `Session` with both fields) and an "Edit profile" subpage: photo change (file dialog, `users.setAvatar`) or removal (`users.resetAvatar`), name, username, email, bio, with the current password and 2FA code rows revealed only when needed (`rv-core/src/account.rs`: `basic_info_changes`, `needs_password`; `two_factor_code`).
- **SwiftUI**: `RoomInfoView` and `ProfileView` in `macos/Sources/RocketVibe/Details.swift`; `MyProfileSection` in `SettingsView.swift` (My account category) edits photo, presence and the basic fields. `ProfileView` offers **Report this user** (not mine, when reports are supported): the profile closes and `ReportSheet` opens in its place, a modal overlay of the window (`modalOverlay`, `Modals.swift`) like the profile itself, which a click outside or Escape closes. A deleted RocketVibe account's profile reads "Deleted user" with no `@username`, presence or buttons.

## Web

Conversation avatars and author names open the same profile as the message menu (`src/render.ts`, `App.profile`). `panels.ts::profile` fetches the native user profile on every open, uses the GTK 420 by 520 dialog with a 96-pixel portrait, centered identity and live presence/status text, then bio and Message/Call/Report actions. BOT ownership is shown; own profiles hide the other-person actions. GTK's encryption identity control is excluded by the browser's agreed E2EE scope. Native profiles supply neither role chips nor a timezone. Bio is currently plain text; GTK's markdown formatting remains browser debt.

Live profile revisions reload the open card. A valid, complete live observation without a lease means Offline; expired or limited observations supply no presence. The browser renews its Online lease every 20 seconds while its authenticated socket remains open, respecting the server's chosen Away/Busy/Offline status. Shutdown serializes Offline after any in-flight publication. Profile responses/actions are fenced to the captured account, connection and room membership. Message/Call fetch the DM's personal read/access state before opening it, since creation returns a room without that personal state. Call uses the ordinary direct-call ringing path; Report replaces the card with the reason dialog. `tests/profiles.mjs` exercises these paths with two real fixture accounts, including expiry, signout, narrow layout and ringing/decline.

## Parity

Room info, profile with Message and Call, my profile with password and 2FA, live avatar changes: both apps ([parity](../parity.md) §8). Differences: mobile toggles the favourite from room info, desktop from the room list; desktop can remove the photo; mobile prefetches the profile so the sheet never jumps. Report this user is in all three apps. Neither app lists room members, edits room settings or manages roles.

## Sources

- apps/web/src/render.ts
- apps/web/src/app.ts
- apps/web/src/panels.ts
- apps/web/src/extra.css
- apps/web/tests/profiles.mjs
- apps/mobile/app/room-info.tsx
- apps/mobile/app/profile.tsx
- apps/mobile/app/my-profile.tsx
- apps/mobile/app/settings/index.tsx
- apps/mobile/ui/reportForm.tsx
- apps/mobile/lib/myProfile.ts
- apps/mobile/lib/profilePreload.ts
- apps/mobile/lib/upload.ts
- apps/mobile/ui/pickAvatar.ts
- apps/mobile/ui/roomHeader.tsx
- apps/mobile/ui/messageRow.tsx
- apps/mobile/ui/markdown.tsx
- apps/mobile/ui/openingIndicator.tsx
- apps/desktop/crates/rv-core/src/info.rs
- apps/desktop/crates/rv-core/src/account.rs
- apps/desktop/crates/rv-core/src/actions.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/details.rs
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/admin.rs
- apps/desktop/macos/Sources/RocketVibe/Details.swift
- apps/desktop/macos/Sources/RocketVibe/SettingsView.swift
- apps/desktop/macos/Sources/RocketVibe/Modals.swift
