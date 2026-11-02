-- Rocket.Chat import (`vibez import rocketchat`): what each Rocket.Chat
-- document became, so a second pass skips it and a stopped one resumes.
CREATE TABLE rc_import_ids (
    kind TEXT NOT NULL CHECK (kind IN ('user','room','emoji','avatar','room_avatar')),
    rc_id TEXT NOT NULL,
    vibez_id TEXT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (kind, rc_id)
);

-- A Rocket.Chat end-to-end encrypted message, kept exactly as the server held
-- it (algorithm, key id, iv, ciphertext, encrypted file references) under the
-- placeholder message shown meanwhile: a later decryption reads it here.
CREATE TABLE rc_import_encrypted_messages (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    payload JSONB NOT NULL
);

-- The keys those messages need: a person's RSA key pair (the private half
-- still wrapped by their E2E password), a room's key id, and each member's
-- copy of the room key wrapped with their public key.
CREATE TABLE rc_import_e2ee_keys (
    kind TEXT NOT NULL CHECK (kind IN ('user','room','member')),
    room_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL,
    PRIMARY KEY (kind, room_id, user_id)
);

-- Encrypted files stay opaque objects, out of every message's file list.
CREATE TABLE rc_import_encrypted_files (
    object_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES rc_import_encrypted_messages(message_id) ON DELETE CASCADE,
    rc_file_id TEXT NOT NULL
);
