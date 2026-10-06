-- History backup (E2EE_HISTORY_BACKUP.md): the history key package sealed under
-- the history code, and periods of history records under keys derived from it.
-- Signed opaque bytes only: no code, key or document.
CREATE TABLE e2ee_history_keys (
    user_id TEXT PRIMARY KEY REFERENCES e2ee_identities(user_id),
    revision BIGINT NOT NULL CHECK(revision>0),
    generation TEXT NOT NULL,
    publication BYTEA NOT NULL CHECK(octet_length(publication)<=16384),
    receipt JSONB NOT NULL
);
CREATE TABLE e2ee_history_key_operations (
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id,device_id,operation_id)
);
CREATE INDEX e2ee_history_key_operations_quota ON e2ee_history_key_operations(user_id,created_at);
CREATE TABLE e2ee_history_key_cancellations (
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(user_id,device_id,operation_id)
);
CREATE INDEX e2ee_history_key_cancellations_quota ON e2ee_history_key_cancellations(user_id,device_id,created_at);
-- Every accepted generation; the 4 most recent are kept with their periods.
CREATE TABLE e2ee_history_key_generations (
    user_id TEXT NOT NULL REFERENCES users(id),
    generation TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK(revision>0),
    PRIMARY KEY(user_id,generation)
);
CREATE TABLE e2ee_history_backup_periods (
    user_id TEXT NOT NULL,
    period TEXT NOT NULL,
    generation TEXT NOT NULL,
    device_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    count BIGINT NOT NULL CHECK(count>0),
    last_position BIGINT NOT NULL CHECK(last_position>0),
    chain BYTEA NOT NULL CHECK(octet_length(chain)=32),
    checkpoint BYTEA NOT NULL CHECK(octet_length(checkpoint)<=8192),
    bytes BIGINT NOT NULL DEFAULT 0 CHECK(bytes>=0),
    PRIMARY KEY(user_id,period),
    FOREIGN KEY(user_id,generation) REFERENCES e2ee_history_key_generations(user_id,generation) ON DELETE CASCADE
);
CREATE INDEX e2ee_history_backup_periods_generation ON e2ee_history_backup_periods(user_id,generation,period);
CREATE TABLE e2ee_history_backup_records (
    user_id TEXT NOT NULL,
    period TEXT NOT NULL,
    rank BIGINT NOT NULL CHECK(rank>0),
    digest TEXT NOT NULL,
    record BYTEA NOT NULL CHECK(octet_length(record)>0 AND octet_length(record)<=393216),
    PRIMARY KEY(user_id,period,rank),
    FOREIGN KEY(user_id,period) REFERENCES e2ee_history_backup_periods(user_id,period) ON DELETE CASCADE
);
