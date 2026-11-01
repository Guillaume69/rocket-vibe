# Rocket.Chat import

A Vibez instance can take over a Rocket.Chat server's history: `vibez import rocketchat` reads the Rocket.Chat MongoDB (a live one, or a `mongodump` restored elsewhere) and writes its people, rooms, messages, files, custom emoji and avatars into the instance. It is an operator command, run beside or before `serve`; the client apps need nothing to show what it brings (see [Mobile](#mobile) and [Desktop](#desktop)).

## Server

**Running it.** `vibez import rocketchat --mongo <url> [--db rocketchat] [--uploads-dir <dir>] [--dry-run]` (`apps/server/src/main.rs`, `ImportSource::Rocketchat`), with the usual `DATABASE_URL` and `--objects-dir` (files, avatars and emoji need it). `--mongo` also reads `VIBEZ_IMPORT_MONGO_URL`; a replica-set member reached directly needs `?directConnection=true`. It prints a JSON report: `imported` (made on this pass), `already` (done by an earlier pass), `skipped` (left out, by reason), `renamed` (usernames Vibez does not allow and what they became), and with `--dry-run` only `found` (what the Rocket.Chat database holds) and `already`. A dry run writes nothing but, like every subcommand, migrates the Vibez database first ([server](../architecture/server.md)). Progress goes to stderr, one line per room.

**Passes and resuming.** Every Rocket.Chat document becomes the same Vibez one on every pass: people, rooms, emoji and avatars through `rc_import_ids (kind, rc_id) → vibez_id`, messages through a stable id, `rc-<Rocket.Chat id>` (`text::message_id`). A second pass skips what exists, so a stopped import resumes and a large server comes over in several passes; only what is new is written. Messages go oldest first per room, 200 to a transaction (`messages::batch`), their positions reserved as one block of the instance counter, so positions follow Rocket.Chat's order. Each room is published once at its end (one `RoomUpsert` in the journal, snapshot heads of its members dropped), so connected clients list it and read its history like any room's; messages are not journaled one by one. Order: people, custom emoji, people's avatars, then each room (members, messages, read positions), then rooms' avatars (`rocketchat_import/mod.rs`).

**People** (`rocketchat_import/users.rs`):
- username: Vibez allows `[A-Za-z0-9_-]`, so other characters become `_` (`rocket.cat` → `rocket_cat`, `text::username`), a `deleted-` prefix gets `rc_` in front, and a name another account holds gets `_rc`, `_rc2`, ...; `@mentions` in messages are renamed along (`text::renamed_mentions`);
- **an account of the same name made on Vibez before the import keeps its password and gets the Rocket.Chat history**: the Rocket.Chat user is mapped onto it (`users_joined_to_existing_accounts`);
- password: Rocket.Chat's `services.password.bcrypt` kept as `rc-bcrypt:<hash>` (see below); none (LDAP, OAuth, bots) gives an account that signs in only after an invitation or a recovery code;
- display name, admin role (`roles` has `admin`), deactivation (`active: false`), bot (`type: bot`), creation date, `bio`, `statusText`, the first verified address (an address another account holds is left out), the Rocket.Chat RSA key pair (`e2e`) into `rc_import_e2ee_keys`;
- an author the Rocket.Chat database no longer has becomes a tombstone account (`deleted-<hash>`, deleted and disabled) shown under the name the message carried.

**Passwords** (`auth.rs`, `password_matches`): Rocket.Chat stores bcrypt of the hex SHA-256 of the password (Meteor's scheme). Sign-in and reauthentication accept an `rc-bcrypt:` hash; a successful sign-in replaces it with Argon2 in the same transaction, which rotates the account's activation version like any password change. Verified on the bench: a wrong password 401, the right one signs in, the hash is Argon2 afterwards and signs in again.

**Rooms** (`rocketchat_import/rooms.rs`): `c` a public room, `p` a private one, a discussion (`prid`) a room of its own kind under its title (the parent link is not kept), a team's rooms ordinary rooms. A `d` room with two people is a direct room (`direct_pair` of the two ids); if those two already have one on Vibez, the history joins it. A group DM (more than two) and a self DM become private rooms named after their people, Vibez's direct rooms holding exactly two. Name, `ro` (read-only), topic, description, announcement, creation date. Livechat and other types are left out. Members come from the subscriptions (a direct room also from `uids`): owner and moderator roles, `f` (favorite), and the read position from `ls` (everything up to that time read; no `ls`, nothing read). Read positions and favorites are set only for people the pass adds, so a later pass never undoes what they read on Vibez.

**Messages** (`rocketchat_import/messages.rs`):
- hidden ones (`_hidden`, Rocket.Chat's edit history) and system messages (`t` set, other than `e2e`: joins, topic changes, pins, call cards) are left out and counted by type;
- text: `msg`, with Rocket.Chat's quote links (`[ ](permalink)`) taken out, mentions renamed, other attachments' title and text appended, at most 32 KiB;
- edits (`editedAt`), pins, threads (`tmid`, root first since the order is by time; `tshow` sets "also sent to the room"; a reply whose root did not come over stays in the room as a plain message), followers (a root's `replies` are its followers, into `thread_follows`), stars (`starred`);
- quotes: a quoted message that came over is a real quote reference (its excerpt then shows); otherwise the quote is written as a Markdown blockquote with its author in the text;
- reactions: Rocket.Chat's `:code:` through the shared emoji table, or the name of an imported custom emoji; any other is left out;
- mentions: direct and `@all` recorded as a send records them; `@here` is not, since it names whoever is online when sent;
- no link preview, push or workflow runs for imported messages.

**Files**: a message's `files` (or `file`), Rocket.Chat's derived thumbnails left out, read from GridFS (bucket `rocketchat_uploads`, file id = the upload's `_id`) or a FileSystem store (`<FileUpload_FileSystemPath or --uploads-dir>/<_id>`, not tried on a real FileSystem server), the store chosen by the upload document's `store`. Each becomes an object and a completed upload row of the message (`state 'completed'`, fingerprint `rocketchat-import`), so it downloads like any file. Over 100 MiB (Vibez's upload limit), missing, or on S3, Google Cloud or WebDAV: left out and counted.

**Custom emoji and avatars** (`rocketchat_import/assets.rs`): emoji through the catalogue's own command (`custom_emojis::put`: re-encoded, at most 512, name and aliases as Vibez shortcodes), read from the `custom_emoji` GridFS bucket by `<name>.<extension>` or the FileSystem emoji path. An alias that is a standard emoji's code is dropped and at most 8 kept; an emoji named like a standard one is not created (reactions with it get the standard glyph); a name Vibez already has maps onto that emoji. Avatars of people (`userId`) and rooms (`rid`) from `rocketchat_avatars` are re-encoded like Vibez's own (`profiles::decode_avatar`: PNG or JPEG in, PNG out, at most 512 pixels) and set where none is.

**Encrypted rooms**: Rocket.Chat's E2EE messages cannot be read on the server and use a different scheme from Vibez's MLS, so they come over **as they are**, for a later decryption without a reimport (user decision 2026-11-02, [decisions](../decisions.md)). The message shows a fixed placeholder text, in English and French (`messages::ENCRYPTED_PLACEHOLDER`), and its whole Rocket.Chat document (`content` with `algorithm`, `kid`, `iv`, `ciphertext`; `e2eMentions`, file references) goes into `rc_import_encrypted_messages`; its files, still encrypted, become objects listed in `rc_import_encrypted_files` (kept by the object collector, never shown as files); `rc_import_e2ee_keys` keeps each room's key id (`room`), each member's copy of the room key wrapped with their public key (`member`, the subscription's `E2EKey`) and each person's key pair (`user`, the private key still wrapped by their E2E password). The formats are those the apps read on Rocket.Chat ([E2EE](e2ee.md), [architecture](../architecture/e2ee.md)).

**Run on the bench** (2026-11-02, the local Rocket.Chat 8.5.1 of `docker/`, 812 messages): 4 people, 16 rooms (9 rooms, 4 direct, 3 group or self DMs), 33 memberships, 789 messages, 6 encrypted archived with 2 encrypted files, 24 files, 14 reactions, 17 thread replies, 3 custom emoji, 2 avatars, in about 6 s; 17 system messages left out; a second pass wrote nothing. Checked through the API: sign-in with the Rocket.Chat password, history in order, quotes with their excerpt, thread counts, reactions, pins, edits, an image downloading byte for byte.

**Not imported**: system messages, discussions' link to their parent message, threads' per-person read state, starred state in the room list, OAuth or LDAP identities, two-factor settings, Rocket.Chat's permissions and room settings beyond read-only, integrations, livechat, files on cloud storage, link previews.

**Tests**: the pure mapping (`rocketchat_import/text.rs`) and the password check (`auth.rs`) are unit-tested; the passes against MongoDB are not run by the gate (it has no MongoDB): the bench run above is their check.

## Mobile

Nothing to do: imported rooms and messages are ordinary Vibez rooms and messages, delivered by the same sync. An encrypted Rocket.Chat message shows its placeholder text.

## Desktop

Nothing to do, as on mobile; the web client and the SwiftUI app likewise.

## Sources

- `apps/server/src/rocketchat_import/mod.rs`
- `apps/server/src/rocketchat_import/source.rs`
- `apps/server/src/rocketchat_import/text.rs`
- `apps/server/src/rocketchat_import/users.rs`
- `apps/server/src/rocketchat_import/rooms.rs`
- `apps/server/src/rocketchat_import/messages.rs`
- `apps/server/src/rocketchat_import/assets.rs`
- `apps/server/src/auth.rs`
- `apps/server/src/objects.rs`
- `apps/server/src/main.rs`
- `apps/server/migrations/0065_rocketchat_import.sql`
