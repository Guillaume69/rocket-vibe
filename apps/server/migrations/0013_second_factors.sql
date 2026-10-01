-- Changing a factor fences delayed mutations, recovery codes and login proofs.
ALTER TABLE users ADD COLUMN factor_version text NOT NULL DEFAULT gen_random_uuid()::text;
DROP TRIGGER user_activation_changed ON users;
CREATE TRIGGER user_activation_changed BEFORE UPDATE OF disabled,admin,create_public_room,create_private_room,password_hash,factor_version ON users
    FOR EACH ROW EXECUTE FUNCTION rotate_user_activation_version();

CREATE TABLE user_factors (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version text NOT NULL,
    totp_cipher bytea NOT NULL,
    last_totp_counter bigint NOT NULL CHECK (last_totp_counter >= 0),
    enabled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE factor_setups (
    id text PRIMARY KEY,
    user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    operation_id text NOT NULL,
    data_epoch text NOT NULL,
    activation_version text NOT NULL,
    secret_cipher bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    accepted_operation text,
    receipt_cipher bytea,
    CHECK ((accepted_operation IS NULL) = (receipt_cipher IS NULL))
);
CREATE TABLE factor_backup_codes (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id text NOT NULL REFERENCES user_factors(user_id) ON DELETE CASCADE,
    consumed_at timestamptz
);
CREATE INDEX factor_backup_codes_user ON factor_backup_codes(user_id);
CREATE TABLE auth_challenges (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    data_epoch text NOT NULL,
    activation_version text NOT NULL,
    factor_version text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    accepted_operation text,
    session_hash text,
    device_id text REFERENCES session_devices(id) ON DELETE SET NULL,
    receipt_expires_at timestamptz,
    CHECK ((accepted_operation IS NULL) = (session_hash IS NULL)),
    CHECK ((accepted_operation IS NULL) = (receipt_expires_at IS NULL))
);
CREATE INDEX auth_challenges_user ON auth_challenges(user_id);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
