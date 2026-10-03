-- No durable journal entries or crash recovery for presence/typing observations.
CREATE UNLOGGED TABLE presence_leases (
    device_id TEXT PRIMARY KEY REFERENCES session_devices(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    data_epoch TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('online','away','busy')),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX presence_leases_live ON presence_leases(expires_at,user_id);
CREATE UNLOGGED TABLE typing_leases (
    device_id TEXT NOT NULL REFERENCES session_devices(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    root_key TEXT NOT NULL DEFAULT '',
    membership_version TEXT NOT NULL,
    data_epoch TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(device_id,room_id,root_key)
);
CREATE INDEX typing_leases_live ON typing_leases(room_id,expires_at);
CREATE UNLOGGED TABLE live_windows (
    device_id TEXT PRIMARY KEY REFERENCES session_devices(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
