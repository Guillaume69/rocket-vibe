CREATE TABLE instance (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    instance_id TEXT NOT NULL,
    data_epoch TEXT NOT NULL,
    position BIGINT NOT NULL DEFAULT 0 CHECK (position >= 0)
);

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    admin BOOLEAN NOT NULL DEFAULT false,
    disabled BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'direct')),
    direct_pair TEXT UNIQUE,
    revision BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE members (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX members_user ON members(user_id, room_id);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    author_id TEXT NOT NULL REFERENCES users(id),
    operation_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    position BIGINT NOT NULL DEFAULT 0,
    revision BIGINT NOT NULL DEFAULT 0,
    UNIQUE (author_id, operation_id)
);
CREATE INDEX messages_history ON messages(room_id, position DESC);

CREATE TABLE journal (
    position BIGINT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    -- NULL means all current members; personal events name their recipient.
    recipient_id TEXT REFERENCES users(id),
    change JSONB NOT NULL
);

CREATE TABLE sync_cursors (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    data_epoch TEXT NOT NULL,
    position BIGINT NOT NULL,
    UNIQUE (user_id, data_epoch, position)
);

CREATE TABLE socket_tickets (
    token_hash TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);
