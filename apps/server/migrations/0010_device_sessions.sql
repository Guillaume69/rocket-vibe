CREATE TABLE session_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    label TEXT NOT NULL DEFAULT 'RocketVibe',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX session_devices_user ON session_devices(user_id);
ALTER TABLE sessions ADD COLUMN device_id TEXT;
UPDATE sessions SET device_id=gen_random_uuid()::text;
INSERT INTO session_devices(id,user_id) SELECT device_id,user_id FROM sessions;
ALTER TABLE sessions ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_device_fk
    FOREIGN KEY(device_id) REFERENCES session_devices(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX sessions_device ON sessions(device_id);

-- Receipt contains fingerprints only. A lost response can repeat exactly the
-- previously saved intent, or authenticate directly with its saved next token.
CREATE TABLE session_rotations (
    old_hash TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES session_devices(id) ON DELETE CASCADE,
    next_hash TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX session_rotations_device ON session_rotations(device_id,created_at);
CREATE INDEX session_rotations_expiry ON session_rotations(expires_at);
