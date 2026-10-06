-- Only the initiating device may recover the encrypted five-minute receipt.
-- Keep metadata for a day; an old request is fenced by its expected version
-- even after metadata pruning. No plaintext backup code is stored here.
CREATE TABLE factor_backup_regenerations (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Revocation removes the ability to recover a receipt, but preserves the
    -- quota history until its bounded cleanup (switching devices cannot reset it).
    device_id text REFERENCES session_devices(id) ON DELETE SET NULL,
    operation_id text NOT NULL,
    requested_version text NOT NULL,
    committed_version text NOT NULL,
    data_epoch text NOT NULL,
    activation_version text NOT NULL,
    receipt_cipher bytea,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    UNIQUE(device_id, operation_id)
);
CREATE INDEX factor_backup_regenerations_user ON factor_backup_regenerations(user_id, created_at);
CREATE INDEX factor_backup_regenerations_expiry ON factor_backup_regenerations(expires_at);
