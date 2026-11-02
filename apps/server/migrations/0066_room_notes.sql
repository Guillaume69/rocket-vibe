CREATE TABLE room_notes (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
