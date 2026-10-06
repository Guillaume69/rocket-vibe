-- Opaque encrypted root packet and signed public proof. No recovery code/key.
CREATE TABLE e2ee_root_backups (
    user_id TEXT PRIMARY KEY REFERENCES e2ee_identities(user_id),
    revision BIGINT NOT NULL CHECK(revision>0),
    publication BYTEA NOT NULL CHECK(octet_length(publication)<=32768),
    receipt JSONB NOT NULL
);
CREATE TABLE e2ee_root_backup_operations (
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,device_id,operation_id)
);
CREATE INDEX e2ee_root_backup_operations_quota ON e2ee_root_backup_operations(user_id,device_id,created_at);
