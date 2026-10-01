-- Password changes fence pre-existing authority/delivery proofs too.
DROP TRIGGER user_activation_changed ON users;
CREATE TRIGGER user_activation_changed BEFORE UPDATE OF disabled,admin,create_public_room,create_private_room,password_hash ON users
    FOR EACH ROW EXECUTE FUNCTION rotate_user_activation_version();

CREATE TABLE account_recovery_codes (
    id text PRIMARY KEY,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    data_epoch text NOT NULL,
    activation_version text NOT NULL,
    consumed_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK ((consumed_at IS NULL) = (consumed_version IS NULL))
);
CREATE INDEX account_recovery_codes_user ON account_recovery_codes(user_id);
CREATE INDEX account_recovery_codes_expiry ON account_recovery_codes(expires_at);
