-- Explicit proof belongs to one existing device family, never a new bearer.
ALTER TABLE session_devices ADD COLUMN reauthentication_version text NOT NULL DEFAULT gen_random_uuid()::text;
-- Unknown provenance on migrated families requires a new full proof.
ALTER TABLE session_devices ADD COLUMN login_factor_id text;
CREATE TABLE reauthentication_challenges (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id text NOT NULL REFERENCES session_devices(id) ON DELETE CASCADE,
    operation_id text NOT NULL,
    instance_id text NOT NULL,
    data_epoch text NOT NULL,
    activation_version text NOT NULL,
    factor_version text NOT NULL,
    requested_version text NOT NULL,
    committed_version text,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    authenticated_at timestamptz,
    factor_completed boolean NOT NULL DEFAULT false,
    receipt_expires_at timestamptz,
    UNIQUE(device_id, operation_id),
    CHECK ((authenticated_at IS NULL) = (receipt_expires_at IS NULL)),
    CHECK ((authenticated_at IS NULL) = (committed_version IS NULL)),
    CHECK (NOT factor_completed OR authenticated_at IS NOT NULL)
);
CREATE INDEX reauthentication_challenges_user ON reauthentication_challenges(user_id);
CREATE INDEX reauthentication_challenges_expiry ON reauthentication_challenges(expires_at);
CREATE TABLE reauthentication_grants (
    device_id text PRIMARY KEY REFERENCES session_devices(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    instance_id text NOT NULL,
    data_epoch text NOT NULL,
    activation_version text NOT NULL,
    factor_version text NOT NULL,
    proof_version text NOT NULL,
    authenticated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    factor_completed boolean NOT NULL,
    factor_id text,
    CHECK (factor_completed = (factor_id IS NOT NULL))
);
CREATE INDEX reauthentication_grants_expiry ON reauthentication_grants(expires_at);
