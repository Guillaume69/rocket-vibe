CREATE TABLE meetings (
    id text PRIMARY KEY,
    room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_by text NOT NULL REFERENCES users(id),
    data_epoch text NOT NULL,
    configuration_id text NOT NULL,
    conference text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    ended boolean NOT NULL DEFAULT false
);
CREATE INDEX meetings_room_active ON meetings(room_id, expires_at) WHERE NOT ended;
CREATE TABLE meeting_operations (
    user_id text NOT NULL REFERENCES users(id),
    operation_id text NOT NULL,
    room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    membership_version text NOT NULL,
    data_epoch text NOT NULL,
    configuration_id text NOT NULL,
    meeting_id text NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id, operation_id)
);
-- Durable receipts are retained with the meeting; old retries never create
-- another conference. Bound new operations per account/day, not by eviction.
CREATE INDEX meeting_operations_account_date ON meeting_operations(user_id, created_at);
