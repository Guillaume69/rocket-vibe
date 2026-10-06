-- Voice channels: selecting the room joins its voice session. Never a direct room.
ALTER TABLE rooms ADD COLUMN voice BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rooms ADD CONSTRAINT rooms_voice_not_direct CHECK (NOT voice OR kind<>'direct');
DROP TRIGGER room_details_changed ON rooms;
CREATE TRIGGER room_details_changed BEFORE UPDATE OF name,kind,read_only,topic,description,announcement,voice ON rooms
    FOR EACH ROW EXECUTE FUNCTION rotate_room_details_version();
-- A replayed creation must ask for the same kind of room.
ALTER TABLE room_creation_requests ADD COLUMN voice BOOLEAN NOT NULL DEFAULT false;

-- One voice connection per account, as the SFU identity is the account id.
-- `joining` rows come from a join request and expire unless the worker sees the
-- participant on the SFU; `connected` rows mirror the SFU, refreshed every pass.
-- No crash recovery needed: the worker rebuilds them from the SFU.
CREATE UNLOGGED TABLE voice_sessions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    data_epoch TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('joining','connected')),
    muted BOOLEAN NOT NULL DEFAULT true,
    deafened BOOLEAN NOT NULL DEFAULT false,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX voice_sessions_room ON voice_sessions(room_id);

-- A direct call ringing the other member, then its outcome, kept with the
-- call_started row it revises.
CREATE TABLE voice_rings (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    data_epoch TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ringing' CHECK (state IN ('ringing','answered','declined','missed','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    answered_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX voice_rings_one_per_room ON voice_rings(room_id) WHERE state='ringing';
CREATE INDEX voice_rings_caller ON voice_rings(caller_id, resolved_at);
CREATE INDEX voice_rings_callee ON voice_rings(callee_id, resolved_at);
CREATE INDEX voice_rings_open ON voice_rings(state) WHERE state='ringing' OR (state='answered' AND ended_at IS NULL);

-- Ring and end-of-ring pushes, fenced like push_notifications. Ids only.
CREATE TABLE voice_pushes (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    ring_id TEXT NOT NULL REFERENCES voice_rings(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES push_devices(device_id) ON DELETE CASCADE,
    generation TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ring','end')),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','retired')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '35 seconds',
    lease_id TEXT,
    lease_expires_at TIMESTAMPTZ,
    UNIQUE(ring_id, device_id, kind)
);
CREATE INDEX voice_pushes_pending ON voice_pushes(available_at) WHERE state='pending';
