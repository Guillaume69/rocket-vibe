-- Invitations are issued by the operator CLI. Only a digest is retained.
CREATE TABLE account_invitations (
    id text PRIMARY KEY,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    data_epoch text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_by text REFERENCES users(id) ON DELETE SET NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK (consumed_by IS NULL OR consumed_at IS NOT NULL)
);
CREATE INDEX account_invitations_expiry ON account_invitations(expires_at);
